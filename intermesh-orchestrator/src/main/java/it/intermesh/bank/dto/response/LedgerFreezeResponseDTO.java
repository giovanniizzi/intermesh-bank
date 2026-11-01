package it.intermesh.bank.dto.response;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;
import io.quarkus.runtime.annotations.RegisterForReflection;

@RegisterForReflection
public final class LedgerFreezeResponseDTO {
    private final String status;
    private final String transaction_id;

    @JsonCreator
    public LedgerFreezeResponseDTO(@JsonProperty("status") JsonNode status,
            @JsonProperty("transaction_id") JsonNode transactionId) {
        if (status == null || !status.isTextual() || transactionId == null || !transactionId.isTextual()) {
            throw new IllegalArgumentException("Invalid freeze acknowledgment");
        }
        this.status = status.textValue();
        this.transaction_id = transactionId.textValue();
    }

    public String getStatus() { return status; }
    public String getTransaction_id() { return transaction_id; }
}
