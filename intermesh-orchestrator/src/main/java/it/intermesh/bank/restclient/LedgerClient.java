package it.intermesh.bank.restclient;

import it.intermesh.bank.dto.request.LedgerTransactionRequestDTO;
import it.intermesh.bank.dto.request.LedgerFinalizationRequestDTO;
import it.intermesh.bank.dto.request.LedgerAccountCreationRequestDTO;
import it.intermesh.bank.dto.response.LedgerAccountResponseDTO;
import it.intermesh.bank.dto.response.LedgerTransferResponseDTO;
import it.intermesh.bank.dto.response.TransactionHistoryDTO;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.HeaderParam;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.core.Response;

import java.util.List;

import org.eclipse.microprofile.rest.client.inject.RegisterRestClient;

import io.quarkus.runtime.annotations.RegisterForReflection;

@Path("/v1/ledger")
@RegisterRestClient(configKey = "ledger-service")
@RegisterForReflection
public interface LedgerClient {

    @POST
    @Path("/freeze")
    Response freezeFunds(LedgerTransactionRequestDTO request,
            @HeaderParam("X-Intermesh-Issuer") String issuer,
            @HeaderParam("X-Intermesh-Subject") String subject,
            @HeaderParam("X-Intermesh-Owner-Key") String ownerKey);

    @GET
    @Path("/transfer-requests/{transfer_request_id}")
    Response getTransferRequest(@PathParam("transfer_request_id") String requestId,
            @HeaderParam("X-Intermesh-Issuer") String issuer,
            @HeaderParam("X-Intermesh-Subject") String subject,
            @HeaderParam("X-Intermesh-Owner-Key") String ownerKey);

    @POST
    @Path("/unfreeze")
    Response unfreezeFunds(LedgerFinalizationRequestDTO request);

    @POST
    @Path("/commit")
    Response commitTransaction(LedgerFinalizationRequestDTO request);

    @POST
    @Path("/accounts")
    LedgerAccountResponseDTO createAccount(LedgerAccountCreationRequestDTO request);

    @GET
    @Path("/account/{id}/balance")
    LedgerAccountResponseDTO getAccountBalance(@PathParam("id") String accountId);

    @GET
    @Path("/account/{id}/transactions")
    List<TransactionHistoryDTO> getTransactionHistory(@PathParam("id") String accountId);

    @GET
    @Path("/accounts/{userID}")
    List<LedgerAccountResponseDTO> getUserAccounts(@PathParam("userID") String userID);
}