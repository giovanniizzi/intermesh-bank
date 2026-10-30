package it.intermesh.bank.orchestrator;

import it.intermesh.bank.dto.request.TransferRequestDTO;
import it.intermesh.bank.dto.response.LedgerTransferResponseDTO;
import it.intermesh.bank.dto.response.LedgerAccountResponseDTO;
import it.intermesh.bank.dto.response.TransactionHistoryDTO;
import it.intermesh.bank.dto.response.TransferResponseDTO;
import it.intermesh.bank.dto.request.LedgerTransactionRequestDTO;
import it.intermesh.bank.dto.request.FraudAnalysisRequestDTO;
import it.intermesh.bank.restclient.LedgerClient;
import it.intermesh.bank.restclient.FraudClient;
import it.intermesh.bank.security.BankingSessionGuard;
import it.intermesh.bank.security.BankingIdentity;
import io.quarkus.security.Authenticated;
import jakarta.inject.Inject;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.ProcessingException;
import jakarta.ws.rs.WebApplicationException;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

import java.util.List;
import java.util.Map;
import org.eclipse.microprofile.rest.client.inject.RestClient;
import org.jboss.logging.Logger;

@Path("/api/v1")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
public class TransferOrchestrator {

    private static final Logger LOG = Logger.getLogger(TransferOrchestrator.class);

    @Inject
    @RestClient
    LedgerClient ledgerClient;

    @Inject
    @RestClient
    FraudClient fraudClient;

    @Inject
    BankingSessionGuard sessionGuard;

    @POST
    @Path("/transfers")
    @Authenticated
    public Response processTransfer(TransferRequestDTO transferRequestDTO) {
        BankingIdentity identity = sessionGuard.requireIdentity();
        String sourceAccount = transferRequestDTO == null ? null : transferRequestDTO.getSource_account();
        if (sourceAccount == null || sourceAccount.isBlank()) {
            return Response.status(Response.Status.BAD_REQUEST)
                    .entity(Map.of("error", "Source account is required")).build();
        }

        try {
            LedgerAccountResponseDTO account = ledgerClient.getAccountBalance(sourceAccount);
            if (account == null || !sourceAccount.equals(account.getAccount_id())
                    || account.getUser_id() == null || account.getUser_id().isBlank()) {
                throw new ProcessingException("Invalid Ledger account response");
            }
            if (!identity.ownerKey().equals(account.getUser_id())) {
                return Response.status(Response.Status.FORBIDDEN)
                        .entity(Map.of("error", "Access denied")).build();
            }
        } catch (WebApplicationException e) {
            int status = e.getResponse().getStatus();
            if (status == Response.Status.NOT_FOUND.getStatusCode()) {
                return Response.status(Response.Status.NOT_FOUND)
                        .entity(Map.of("error", "Account not found")).build();
            }
            return Response.status(status)
                    .entity(Map.of("status", "FAILED", "reason", "Core Ledger request failed.")).build();
        } catch (Exception e) {
            LOG.error("[TransferOrchestrator] Core Ledger source account lookup failed.");
            return Response.status(Response.Status.BAD_GATEWAY)
                    .entity(Map.of("status", "FAILED", "reason", "Core Ledger source account lookup failed.")).build();
        }

        LOG.info("[TransferOrchestrator] Transfer processing requested.");

        LedgerTransactionRequestDTO ledgerTxRequest = new LedgerTransactionRequestDTO(
            transferRequestDTO.getSource_account(), 
            transferRequestDTO.getAmount()
        );

        try (Response ledgerResp = ledgerClient.freezeFunds(ledgerTxRequest)) {
            if (ledgerResp.getStatus() != Response.Status.OK.getStatusCode()) {
                return Response.status(Response.Status.BAD_REQUEST)
                        .entity(Map.of("status", "REJECTED", "reason", "Ledger freeze was not acknowledged; financial outcome was not confirmed.")).build();
            }
        } catch (Exception e) {
            LOG.error("[TransferOrchestrator] Ledger freeze outcome was not confirmed.");
            return Response.status(Response.Status.GATEWAY_TIMEOUT)
                    .entity(Map.of("status", "FAILED", "reason", "Ledger freeze was not acknowledged; financial outcome was not confirmed.")).build();
        }
        LOG.info("[TransferOrchestrator] Phase 1 Completed: Funds isolated.");

        FraudAnalysisRequestDTO fraudRequest = new FraudAnalysisRequestDTO(
            transferRequestDTO.getSource_account(),
            transferRequestDTO.getTarget_account(),
            transferRequestDTO.getAmount()
        );

        boolean verificationAcknowledged;
        try (Response fraudResp = fraudClient.analyzeTransaction(fraudRequest)) {
            verificationAcknowledged = fraudResp.getStatus() == Response.Status.OK.getStatusCode();
        } catch (Exception e) {
            verificationAcknowledged = false;
        }
        if (!verificationAcknowledged) {
            LOG.warn("[TransferOrchestrator] Transaction verification did not complete; requesting compensation.");
            return buildCompensationResponse("Transaction verification did not complete.",
                    triggerRollback(ledgerTxRequest));
        }
        LOG.info("[TransferOrchestrator] Phase 2 Completed: Risk scoring clear.");

        LedgerTransferResponseDTO commitResp;
       
        try {
                commitResp = ledgerClient.commitTransaction(ledgerTxRequest);
            } catch (Exception e) {
                LOG.error("[TransferOrchestrator] Ledger commit outcome was not confirmed; requesting compensation.");
                return buildCompensationResponse("Ledger commit outcome was not confirmed.",
                        triggerRollback(ledgerTxRequest));
            }

        LOG.info("[TransferOrchestrator] Outbound transaction completed successfully.");
        TransferResponseDTO responseBody = new TransferResponseDTO(commitResp);

        return Response.ok(responseBody).build();
    }

    private enum CompensationOutcome {
        ACKNOWLEDGED("Unfreeze request acknowledged by Ledger; restoration was not independently verified."),
        FAILED("Unfreeze request failed; restoration was not confirmed."),
        UNKNOWN("Unfreeze outcome is unknown; restoration was not confirmed.");

        private final String message;

        CompensationOutcome(String message) {
            this.message = message;
        }
    }

    private CompensationOutcome triggerRollback(LedgerTransactionRequestDTO request) {
        CompensationOutcome outcome;
        try {
            Response response;
            try {
                response = ledgerClient.unfreezeFunds(request);
            } catch (WebApplicationException e) {
                response = e.getResponse();
            }
            try (Response unfreezeResponse = response) {
                if (unfreezeResponse == null) {
                    outcome = CompensationOutcome.UNKNOWN;
                } else {
                    int status = unfreezeResponse.getStatus();
                    if (status == Response.Status.OK.getStatusCode()) {
                        outcome = CompensationOutcome.ACKNOWLEDGED;
                    } else if (status >= 400 && status != 408 && status != 504) {
                        outcome = CompensationOutcome.FAILED;
                    } else {
                        outcome = CompensationOutcome.UNKNOWN;
                    }
                }
            }
        } catch (Exception e) {
            outcome = CompensationOutcome.UNKNOWN;
        }
        LOG.infof("[TransferOrchestrator] Compensation outcome: %s. %s", outcome, outcome.message);
        return outcome;
    }

    private Response buildCompensationResponse(String failure, CompensationOutcome outcome) {
        return Response.status(Response.Status.GATEWAY_TIMEOUT).entity(Map.of(
            "status", "FAILED",
            "reason", failure + " " + outcome.message
        )).build();
    }


}
