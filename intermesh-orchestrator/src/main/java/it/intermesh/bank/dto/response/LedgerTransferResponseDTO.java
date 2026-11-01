package it.intermesh.bank.dto.response;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import io.quarkus.runtime.annotations.RegisterForReflection;

@RegisterForReflection
public class LedgerTransferResponseDTO {
    private String status;
    private String transaction_id;

    @JsonCreator
    public LedgerTransferResponseDTO(@JsonProperty("status") JsonNode status,
            @JsonProperty("transaction_id") JsonNode transactionId) {
        if (status == null || !status.isTextual() || transactionId == null || !transactionId.isTextual()) {
            throw new IllegalArgumentException("Invalid commit acknowledgment");
        }
        this.status = status.textValue();
        this.transaction_id = transactionId.textValue();
    }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public String getTransaction_id() { return transaction_id; }
    public void setTransaction_id(String transaction_id) { this.transaction_id = transaction_id; }
}
