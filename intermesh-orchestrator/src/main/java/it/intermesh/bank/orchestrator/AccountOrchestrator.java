package it.intermesh.bank.orchestrator;

import it.intermesh.bank.dto.request.AccountCreationRequestDTO;
import it.intermesh.bank.dto.request.LedgerAccountCreationRequestDTO;
import it.intermesh.bank.dto.response.AccountCreationResponseDTO;
import it.intermesh.bank.dto.response.LedgerAccountResponseDTO;
import it.intermesh.bank.dto.response.TransactionHistoryDTO;
import it.intermesh.bank.restclient.LedgerClient;
import it.intermesh.bank.security.BankingIdentity;
import it.intermesh.bank.security.BankingSessionGuard;
import it.intermesh.bank.validation.MonetaryAmounts;
import io.quarkus.security.Authenticated;
import io.vertx.ext.web.RoutingContext;
import jakarta.inject.Inject;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.ProcessingException;
import jakarta.ws.rs.WebApplicationException;
import jakarta.ws.rs.core.Context;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.util.List;
import java.math.BigDecimal;
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
    BankingSessionGuard sessionGuard;

    @GET
    @Path("/accounts/{userID}")
    @Produces(MediaType.APPLICATION_JSON)
    @Authenticated
    public Response getUserAccounts(@PathParam("userID") String userID, @Context RoutingContext rc) {
        BankingIdentity identity = sessionGuard.requireIdentity();
        if (!identity.ownerKey().equals(userID)) {
            return Response.status(Response.Status.FORBIDDEN)
                .entity(Map.of("error", "Access denied")).build();
        }

        // Find all user accounts from Ledger
        List<LedgerAccountResponseDTO> accounts = ledgerClient.getUserAccounts(identity.ownerKey());
        
        if (accounts == null || accounts.isEmpty()) {
            return Response.status(Response.Status.NOT_FOUND)
                .entity("{\"error\":\"No active asset provisioned for the requested user profile\"}").build();
        }

        LedgerAccountResponseDTO account = accounts.get(0);
        
        // Session Persistence (Vert.x Context)
        sessionGuard.withSession(session -> {
            session.put("account_id", account.getAccount_id());
            session.put("iban", account.getIban());
            session.put("balance", account.getBalance());
            return null;
        });

        return Response.ok(account).build();
    }

    @POST
    @Path("/accounts")
    @Authenticated
    public Response onboardCustomer(AccountCreationRequestDTO accountCreationRequestDTO, @Context RoutingContext rc) {
        String keycloakUserId = sessionGuard.requireIdentity().ownerKey();
        BigDecimal initialDeposit = MonetaryAmounts.require(
                accountCreationRequestDTO == null ? null : accountCreationRequestDTO.getInitial_deposit(), true);

        LOG.info(String.format("[AccountOrchestrator] Onboarding request from User ID [%s]", keycloakUserId));

        LedgerAccountCreationRequestDTO ledgerRequest = new LedgerAccountCreationRequestDTO(
            keycloakUserId,
            accountCreationRequestDTO.getHolder_name(),      
            initialDeposit
        );

        LedgerAccountResponseDTO ledgerResponse;
        try {
            ledgerResponse = ledgerClient.createAccount(ledgerRequest);
        } catch (Exception e) {
            LOG.error("[AccountOrchestrator] Provisioning downstream network link failed.", e);
            return Response.status(Response.Status.GATEWAY_TIMEOUT)
                    .entity(Map.of("status", "FAILED", "reason", "Core network timeout.")).build();
        }

        String tokenString = sessionGuard.withSession(session -> {
            session.put("ACCOUNT_ID", ledgerResponse.getAccount_id());
            session.put("IBAN", ledgerResponse.getIban());
            session.put("USER_ID", keycloakUserId);
            return session.id();
        });

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
    @Authenticated
    public Response getAccountHistory(@PathParam("id") String accountId) {
        BankingIdentity identity = sessionGuard.requireIdentity();

        try {
            LedgerAccountResponseDTO account = ledgerClient.getAccountBalance(accountId);
            if (account == null || !accountId.equals(account.getAccount_id())
                    || account.getUser_id() == null || account.getUser_id().isBlank()) {
                throw new ProcessingException("Invalid Ledger account response");
            }
            if (!identity.ownerKey().equals(account.getUser_id())) {
                return Response.status(Response.Status.FORBIDDEN)
                        .entity(Map.of("error", "Access denied")).build();
            }

            List<TransactionHistoryDTO> history = ledgerClient.getTransactionHistory(accountId);
            return Response.ok(history).build();
        } catch (WebApplicationException e) {
            int status = e.getResponse().getStatus();
            if (status == Response.Status.NOT_FOUND.getStatusCode()) {
                return Response.status(Response.Status.NOT_FOUND)
                        .entity(Map.of("error", "Account not found")).build();
            }
            return Response.status(status)
                    .entity(Map.of("status", "FAILED", "reason", "Core Ledger request failed."))
                    .build();
        } catch (Exception e) {
            LOG.error("[AccountOrchestrator] Core Ledger transaction history request failed.");
            return Response.status(Response.Status.BAD_GATEWAY)
                    .entity(Map.of("status", "FAILED", "reason", "Core Ledger synchronization fault during lookup."))
                    .build();
        }
    }

    

}
