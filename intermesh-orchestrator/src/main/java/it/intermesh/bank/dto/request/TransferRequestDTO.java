package it.intermesh.bank.dto.request;

import io.quarkus.runtime.annotations.RegisterForReflection;
import java.math.BigDecimal;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;
import it.intermesh.bank.validation.StrictDecimalDeserializer;

@RegisterForReflection
public class TransferRequestDTO {
    private String source_account;
    private String target_account;
    @JsonDeserialize(using = StrictDecimalDeserializer.class)
    private BigDecimal amount;

    public TransferRequestDTO() {}

    public String getSource_account() { return source_account; }
    public void setSource_account(String source_account) { this.source_account = source_account; }

    public String getTarget_account() { return target_account; }
    public void setTarget_account(String target_account) { this.target_account = target_account; }

    public BigDecimal getAmount() { return amount; }
    public void setAmount(BigDecimal amount) { this.amount = amount; }
}
