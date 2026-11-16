package it.intermesh.bank.restclient;

import it.intermesh.bank.dto.request.FraudAnalysisRequestDTO;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.core.Response;
import org.eclipse.microprofile.rest.client.inject.RegisterRestClient;
import io.quarkus.runtime.annotations.RegisterForReflection;

@Path("/v2/fraud")
@RegisterRestClient(configKey = "fraud-service")
@RegisterForReflection
public interface FraudClient {

    @POST
    @Path("/analyze")
    Response analyzeTransaction(FraudAnalysisRequestDTO request);
}