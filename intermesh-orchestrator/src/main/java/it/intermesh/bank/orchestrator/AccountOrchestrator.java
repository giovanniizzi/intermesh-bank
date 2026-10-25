package it.intermesh.bank.orchestrator;

import it.intermesh.bank.dto.request.AccountCreationRequestDTO;
import it.intermesh.bank.dto.request.LedgerAccountCreationRequestDTO;
import it.intermesh.bank.dto.response.AccountCreationResponseDTO;
import it.intermesh.bank.dto.response.LedgerAccountResponseDTO;
import it.intermesh.bank.dto.response.TransactionHistoryDTO;
import it.intermesh.bank.restclient.LedgerClient;
import io.vertx.ext.web.RoutingContext;
import io.vertx.ext.web.Session;
import jakarta.inject.Inject;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.Context;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.util.List;
import java.util.Map;
import org.eclipse.microprofile.rest.client.inject.RestClient;
import org.jboss.logging.Logger;

@Path("/api/v1")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
public class AccountOrchestrator {

    private static final Logger LOG = Logger.getLogger(AccountOrchestrator.class);

    @Inject
    @RestClient
    LedgerClient ledgerClient;

    @Inject
    RoutingContext routingContext;

    @GET
    @Path("/accounts/{userID}")
    @Produces(MediaType.APPLICATION_JSON)
    public Response getUserAccounts(@PathParam("userID") String userID, @Context RoutingContext rc) {
        
        /* 
        // Identity Extraction dagli header propagati dalla Service Mesh
        String authenticatedUser = rc.request().getHeader("x-intermesh-user");
        LOG.info(String.format("[AccountOrchestrator] GET Profile lookup for userID: %s (Authenticated: %s)", userID, authenticatedUser));

        if (authenticatedUser == null || !userID.equalsIgnoreCase(authenticatedUser)) {
            return Response.status(Response.Status.FORBIDDEN)
                .entity("{\"error\":\"Access Denied: Identity token mismatch constraints\"}").build();
        }
        */

        // Find all user accounts from Ledger
        List<LedgerAccountResponseDTO> accounts = ledgerClient.getUserAccounts(userID);
        
        if (accounts == null || accounts.isEmpty()) {
            return Response.status(Response.Status.NOT_FOUND)
                .entity("{\"error\":\"No active asset provisioned for the requested user profile\"}").build();
        }

        LedgerAccountResponseDTO account = accounts.get(0);
        
        // Session Persistence (Vert.x Context)
        Session session = routingContext.session();
        if (session != null) {
            session.put("account_id", account.getAccount_id());
            session.put("iban", account.getIban());
            session.put("balance", account.getBalance());
        }

        return Response.ok(account).build();
    }

    @POST
    @Path("/accounts")
    public Response onboardCustomer(AccountCreationRequestDTO accountCreationRequestDTO, @Context RoutingContext rc) {
        
        String keycloakUserId = rc.request().getHeader("x-intermesh-user");
        
        if (keycloakUserId == null || keycloakUserId.isEmpty()) {
            keycloakUserId = "usr_test_123"; 
            LOG.warn("[AccountOrchestrator] Using dev fallback User ID: " + keycloakUserId);
        }

        LOG.info(String.format("[AccountOrchestrator] Onboarding request from User ID [%s]", keycloakUserId));

        LedgerAccountCreationRequestDTO ledgerRequest = new LedgerAccountCreationRequestDTO(
            keycloakUserId,
            accountCreationRequestDTO.getHolder_name(),      
            accountCreationRequestDTO.getInitial_deposit()   
        );

        LedgerAccountResponseDTO ledgerResponse;
        try {
            ledgerResponse = ledgerClient.createAccount(ledgerRequest);
        } catch (Exception e) {
            LOG.error("[AccountOrchestrator] Provisioning downstream network link failed.", e);
            return Response.status(Response.Status.GATEWAY_TIMEOUT)
                    .entity(Map.of("status", "FAILED", "reason", "Core network timeout.")).build();
        }

        Session session = routingContext.session();
        String tokenString = "";
        if (session != null) {
            session.put("ACCOUNT_ID", ledgerResponse.getAccount_id());
            session.put("IBAN", ledgerResponse.getIban());
            session.put("USER_ID", keycloakUserId);

            tokenString = session.id();
            LOG.info(String.format("[AccountOrchestrator] Session created with ID: %s for User ID: %s", tokenString, keycloakUserId));  
        }

        AccountCreationResponseDTO responseBody = new AccountCreationResponseDTO(
            "ACCOUNT_PROVISIONED_SUCCESSFULLY",
            tokenString,
            ledgerResponse
        );

        return Response.status(Response.Status.CREATED).entity(responseBody).build();
    }

    @GET
    @Path("/account/{id}/transactions")
    @Produces(MediaType.APPLICATION_JSON)
    public Response getAccountHistory(@PathParam("id") String accountId) {
        LOG.info("[TransferOrchestrator] Intercepted historical ledger lookup request for account: " + accountId);
        
        try {
            // Fetch the raw history layout directly from the Go Core Ledger
            List<TransactionHistoryDTO> history = ledgerClient.getTransactionHistory(accountId);
            
            // Return a clean corporate response stream
            return Response.ok(history).build();
        } catch (Exception e) {
            LOG.error("[TransferOrchestrator] Failed to fetch transaction history from Core Ledger", e);
            return Response.status(Response.Status.BAD_GATEWAY)
                    .entity(Map.of("status", "FAILED", "reason", "Core Ledger synchronization fault during lookup."))
                    .build();
        }
    }

    

}