package it.intermesh.bank.orchestrator;

import it.intermesh.bank.dto.request.TransferRequestDTO;
import it.intermesh.bank.dto.response.LedgerTransferResponseDTO;
import it.intermesh.bank.dto.response.LedgerAdmissionResponseDTO;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.DeserializationFeature;
import it.intermesh.bank.dto.response.LedgerAccountResponseDTO;
import it.intermesh.bank.dto.response.TransferResponseDTO;
import it.intermesh.bank.dto.request.LedgerTransactionRequestDTO;
import it.intermesh.bank.dto.request.LedgerFinalizationRequestDTO;
import it.intermesh.bank.dto.request.FraudAnalysisRequestDTO;
import it.intermesh.bank.restclient.LedgerClient;
import it.intermesh.bank.restclient.FraudClient;
import it.intermesh.bank.security.BankingSessionGuard;
import it.intermesh.bank.security.BankingIdentity;
import it.intermesh.bank.validation.MonetaryAmounts;
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

import java.math.BigDecimal;
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

    @Inject
    ObjectMapper json;

    @Inject
    io.vertx.ext.web.RoutingContext routingContext;

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

        String requestId = transferRequestDTO.getTransfer_request_id();
        if (!LedgerAdmissionResponseDTO.validRequestId(requestId)) {
            return Response.status(Response.Status.BAD_REQUEST)
                    .entity(Map.of("error", "A UUID transfer_request_id is required")).build();
        }
        if (sourceAccount.codePointCount(0, sourceAccount.length()) > 50
                || sourceAccount.codePoints().anyMatch(c -> Character.isWhitespace(c)
                    || Character.isSpaceChar(c) || Character.isISOControl(c))) {
            return Response.status(Response.Status.BAD_REQUEST).entity(Map.of("error", "Invalid source account")).build();
        }

        String targetAccount = transferRequestDTO.getTarget_account();
        if (targetAccount == null || targetAccount.isBlank()
                || targetAccount.codePointCount(0, targetAccount.length()) > 34
                || targetAccount.codePoints().anyMatch(Character::isISOControl)) {
            return Response.status(Response.Status.BAD_REQUEST)
                    .entity(Map.of("error", "Invalid destination account")).build();
        }

        BigDecimal amount = MonetaryAmounts.require(transferRequestDTO.getAmount(), false);

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
            requestId, sourceAccount, targetAccount, amount,
            transferRequestDTO.isAllowDuplicatePendingTransfer()
        );

        final String frozenTransactionId;
        try (Response ledgerResp = admit(ledgerTxRequest, identity)) {
            int status = ledgerResp.getStatus();
            if (status != 200 && status != 409 && status != 422) {
                return ledgerFailure(ledgerResp, false);
            }
            LedgerAdmissionResponseDTO acknowledgment;
            try {
                acknowledgment = readAdmission(ledgerResp);
                acknowledgment.validate(requestId, false, status, transferRequestDTO.isAllowDuplicatePendingTransfer());
            } catch (Exception e) {
                // Intent conflicts have an error envelope rather than a persisted admission.
                if (status == 409) return ledgerFailure(ledgerResp, false);
                return invalidFreezeAcknowledgment();
            }
            if (!acknowledgment.isNew()) {
                return Response.status(status).header("Cache-Control", "no-store").entity(acknowledgment).build();
            }
            frozenTransactionId = acknowledgment.transactionId();
        } catch (Exception e) {
            LOG.error("[TransferOrchestrator] Ledger freeze outcome was not confirmed.");
            return Response.status(Response.Status.GATEWAY_TIMEOUT)
                    .entity(Map.of("status", "FAILED", "reason", "Ledger freeze was not acknowledged; financial outcome was not confirmed.")).build();
        }
        LedgerFinalizationRequestDTO finalization = new LedgerFinalizationRequestDTO(
                frozenTransactionId, sourceAccount, amount);
        LOG.info("[TransferOrchestrator] Phase 1 Completed: Funds isolated.");

        FraudAnalysisRequestDTO fraudRequest = new FraudAnalysisRequestDTO(
            transferRequestDTO.getSource_account(),
            transferRequestDTO.getTarget_account(),
            amount.doubleValue()
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
                    triggerRollback(finalization));
        }
        LOG.info("[TransferOrchestrator] Phase 2 Completed: Risk scoring clear.");

        LedgerTransferResponseDTO commitResp = null;
        String commitFailure = "Ledger commit outcome was not confirmed.";
        try (Response response = ledgerClient.commitTransaction(finalization)) {
            if (response.getStatus() == Response.Status.OK.getStatusCode()) {
                commitFailure = "Ledger commit acknowledgment was invalid; financial outcome was not confirmed.";
                try {
                    commitResp = json.readerFor(LedgerTransferResponseDTO.class)
                            .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                            .readValue(response.readEntity(String.class));
                    if (commitResp != null && "COMMITTED".equals(commitResp.getStatus())
                            && frozenTransactionId.equals(commitResp.getTransaction_id())) {
                        commitFailure = null;
                    }
                } catch (Exception e) {
                    // The request may have committed even when its acknowledgment is unusable.
                }
            }
        } catch (WebApplicationException e) {
            try (Response rejected = e.getResponse()) {
                // Close any response carried by the REST client's error mapper.
            } catch (Exception ignored) {
                // Response cleanup cannot establish the financial outcome.
            }
            commitFailure = "Ledger commit outcome was not confirmed.";
        } catch (Exception e) {
            commitFailure = "Ledger commit outcome was not confirmed.";
        }
        if (commitFailure != null) {
            LOG.error("[TransferOrchestrator] Ledger commit was not confirmed; requesting transaction-specific compensation.");
            return buildCompensationResponse(commitFailure, triggerRollback(finalization));
        }

        LOG.info("[TransferOrchestrator] Outbound transaction completed successfully.");
        TransferResponseDTO responseBody = new TransferResponseDTO(commitResp);

        return Response.ok(responseBody).build();
    }

    @GET
    @Path("/transfer-requests/{transfer_request_id}")
    @Authenticated
    public Response recoverTransfer(@PathParam("transfer_request_id") String requestId) {
        routingContext.response().putHeader("Cache-Control", "no-store");
        BankingIdentity identity = sessionGuard.requireIdentity();
        if (!LedgerAdmissionResponseDTO.validRequestId(requestId)) {
            return Response.status(400).header("Cache-Control", "no-store")
                    .entity(Map.of("error", "A UUID transfer_request_id is required")).build();
        }
        try {
            Response response;
            try {
                response = ledgerClient.getTransferRequest(requestId, identity.issuer(), identity.subject(), identity.ownerKey());
            } catch (WebApplicationException e) {
                response = e.getResponse();
            }
            try (Response ledgerResponse = response) {
                if (ledgerResponse == null) throw new ProcessingException("Missing Ledger response");
                if (ledgerResponse.getStatus() != 200) return ledgerFailure(ledgerResponse, true);
                LedgerAdmissionResponseDTO result = readAdmission(ledgerResponse);
                result.validate(requestId, true, 200, false);
                return Response.ok(result).header("Cache-Control", "no-store").build();
            }
        } catch (Exception e) {
            return Response.status(502).header("Cache-Control", "no-store")
                    .entity(Map.of("status", "UNKNOWN", "reason", "Transfer recovery unavailable; financial outcome was not confirmed.")).build();
        }
    }

    private Response admit(LedgerTransactionRequestDTO request, BankingIdentity identity) {
        try {
            return ledgerClient.freezeFunds(request, identity.issuer(), identity.subject(), identity.ownerKey());
        } catch (WebApplicationException e) {
            return e.getResponse();
        }
    }

    private LedgerAdmissionResponseDTO readAdmission(Response response) throws java.io.IOException {
        // Buffer once so an error envelope can be checked without reading a closed stream.
        response.bufferEntity();
        return json.readerFor(LedgerAdmissionResponseDTO.class)
                .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                .with(com.fasterxml.jackson.core.JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
                .readValue(response.readEntity(String.class));
    }

    private Response ledgerFailure(Response response, boolean recovery) {
        try {
            var error = json.reader().with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .with(com.fasterxml.jackson.core.JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
                    .readTree(response.readEntity(String.class));
            String code = error.path("code").asText("");
            String message = switch (code) {
                case "REQUEST_INTENT_CONFLICT" -> response.getStatus() == 409 && !recovery
                        ? "Transfer request intent does not match." : null;
                case "TRANSFER_REQUEST_NOT_FOUND" -> response.getStatus() == 404
                        ? "Request not found or inaccessible; an in-flight admission may still complete." : null;
                case "COMMIT_OUTCOME_UNKNOWN" -> response.getStatus() == 503
                        ? "Admission outcome is unknown; recover using the original transfer_request_id." : null;
                case "TRANSFER_PERSISTENCE_UNAVAILABLE" -> response.getStatus() == 503
                        ? "Transfer persistence is unavailable; financial outcome was not confirmed." : null;
                default -> null;
            };
            if (message != null) return Response.status(response.getStatus()).header("Cache-Control", "no-store")
                    .entity(Map.of("code", code, "error", message)).build();
        } catch (Exception ignored) {
            // An unusable acknowledgment cannot establish the admission outcome.
        }
        return Response.status(502).header("Cache-Control", "no-store")
                .entity(Map.of("status", "UNKNOWN", "reason", "Ledger admission or recovery was not acknowledged; financial outcome was not confirmed.")).build();
    }

    private Response invalidFreezeAcknowledgment() {
        return Response.status(Response.Status.BAD_GATEWAY)
                .entity(Map.of("status", "FAILED", "reason",
                        "Ledger freeze acknowledgment was invalid; financial outcome was not confirmed.")).build();
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

    private CompensationOutcome triggerRollback(LedgerFinalizationRequestDTO request) {
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
