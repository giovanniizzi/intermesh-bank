package it.intermesh.bank.orchestrator;

import it.intermesh.bank.dto.request.TransferRequestDTO;
import it.intermesh.bank.dto.response.LedgerTransferResponseDTO;
import it.intermesh.bank.dto.response.TransactionHistoryDTO;
import it.intermesh.bank.dto.response.TransferResponseDTO;
import it.intermesh.bank.dto.request.LedgerTransactionRequestDTO;
import it.intermesh.bank.dto.request.FraudAnalysisRequestDTO;
import it.intermesh.bank.restclient.LedgerClient;
import it.intermesh.bank.restclient.FraudClient;
import jakarta.inject.Inject;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
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

    @POST
    @Path("/transfers")
    public Response processTransfer(TransferRequestDTO transferRequestDTO) {
        LOG.info(String.format("[TransferOrchestrator] Wire transfer processing requested: €%.2f from %s to %s", 
                transferRequestDTO.getAmount(), transferRequestDTO.getSource_account(), transferRequestDTO.getTarget_account()));

        LedgerTransactionRequestDTO ledgerTxRequest = new LedgerTransactionRequestDTO(
            transferRequestDTO.getSource_account(), 
            transferRequestDTO.getAmount()
        );

        try (Response ledgerResp = ledgerClient.freezeFunds(ledgerTxRequest)) {
            if (ledgerResp.getStatus() != Response.Status.OK.getStatusCode()) {
                return Response.status(Response.Status.BAD_REQUEST)
                        .entity(Map.of("status", "REJECTED", "reason", "Insufficient liquidity or invalid account ID.")).build();
            }
        } catch (Exception e) {
            LOG.error("[TransferOrchestrator] Core Ledger connection failed during Phase 1.");
            return Response.status(Response.Status.GATEWAY_TIMEOUT)
                    .entity(Map.of("status", "FAILED", "reason", "Ledger infrastructure down.")).build();
        }
        LOG.info("[TransferOrchestrator] Phase 1 Completed: Funds isolated.");

        FraudAnalysisRequestDTO fraudRequest = new FraudAnalysisRequestDTO(
            transferRequestDTO.getSource_account(),
            transferRequestDTO.getTarget_account(),
            transferRequestDTO.getAmount()
        );

        try (Response fraudResp = fraudClient.analyzeTransaction(fraudRequest)) {
            if (fraudResp.getStatus() != Response.Status.OK.getStatusCode()) {
                triggerRollback(ledgerTxRequest, "Fraud analyzer flagged a high risk score.");
                return buildTimeoutResponse();
            }
        } catch (Exception e) {
            // Triggered if the Istio Sidecar forces a timeout boundary restriction
            LOG.warn("[TransferOrchestrator] Phase 2 Link Interrupted by Mesh. Activating compensating transaction block...");
            triggerRollback(ledgerTxRequest, "Network boundary timeout during security scanning.");
            return buildTimeoutResponse();
        }
        LOG.info("[TransferOrchestrator] Phase 2 Completed: Risk scoring clear.");

        LedgerTransferResponseDTO commitResp;
       
        try {
                commitResp = ledgerClient.commitTransaction(ledgerTxRequest);
            } catch (Exception e) {
                LOG.error("[TransferOrchestrator] Core Ledger connection failed during Phase 3 commit step.", e);
                triggerRollback(ledgerTxRequest, "Ledger infrastructure failure during commit phase.");
                return Response.status(Response.Status.GATEWAY_TIMEOUT)
                        .entity(Map.of("status", "FAILED", "reason", "Ledger infrastructure down during commit. Funds rolled back.")).build();
            }

        LOG.info("[TransferOrchestrator] Outbound transaction completed successfully.");
        TransferResponseDTO responseBody = new TransferResponseDTO(commitResp);

        return Response.ok(responseBody).build();
    }

    private void triggerRollback(LedgerTransactionRequestDTO request, String reason) {
        try {
            ledgerClient.unfreezeFunds(request);
            LOG.info("[TransferOrchestrator] Compensating Step Done: Funds unlocked. Reason: " + reason);
        } catch (Exception e) {
            LOG.error("[TransferOrchestrator] CRITICAL EXCEPTION: Compensating transaction failed to execute!", e);
        }
    }

    private Response buildTimeoutResponse() {
        return Response.status(Response.Status.GATEWAY_TIMEOUT).entity(Map.of(
            "status", "FAILED", 
            "reason", "Transaction verification timeout bounds breached. Funds rolled back safely."
        )).build();
    }


}