package it.intermesh.bank.dto.request;

import com.fasterxml.jackson.annotation.JsonSetter;
import com.fasterxml.jackson.databind.JsonNode;
import io.quarkus.runtime.annotations.RegisterForReflection;
import java.math.BigDecimal;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;
import it.intermesh.bank.validation.StrictDecimalDeserializer;

@RegisterForReflection
public class TransferRequestDTO {
    private String transfer_request_id;
    private boolean allowDuplicatePendingTransfer;
    private String source_account;
    private String target_account;
    @JsonDeserialize(using = StrictDecimalDeserializer.class)
    private BigDecimal amount;

    public TransferRequestDTO() {}

    public String getSource_account() { return source_account; }
    public void setSource_account(JsonNode value) { this.source_account = text(value); }

    public String getTarget_account() { return target_account; }
    public void setTarget_account(JsonNode value) { this.target_account = text(value); }

    public String getTransfer_request_id() { return transfer_request_id; }
    public void setTransfer_request_id(JsonNode value) { this.transfer_request_id = text(value); }

    public boolean isAllowDuplicatePendingTransfer() { return allowDuplicatePendingTransfer; }
    @JsonSetter("allowDuplicatePendingTransfer")
    public void setAllowDuplicatePendingTransfer(JsonNode value) {
        if (value == null || !value.isBoolean()) throw new IllegalArgumentException("Invalid approval flag");
        this.allowDuplicatePendingTransfer = value.booleanValue();
    }

    private static String text(JsonNode value) {
        if (value == null || !value.isTextual()) throw new IllegalArgumentException("Expected a string");
        return value.textValue();
    }

    public BigDecimal getAmount() { return amount; }
    public void setAmount(BigDecimal amount) { this.amount = amount; }
}
