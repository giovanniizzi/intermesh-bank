package it.intermesh.bank.dto.request;

import io.quarkus.runtime.annotations.RegisterForReflection;
import java.math.BigDecimal;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;
import it.intermesh.bank.validation.StrictDecimalDeserializer;

@RegisterForReflection
public class AccountCreationRequestDTO {
    private String holder_name;
    @JsonDeserialize(using = StrictDecimalDeserializer.class)
    private BigDecimal initial_deposit;

    public AccountCreationRequestDTO() {}

    public AccountCreationRequestDTO(String holderName, BigDecimal initialDeposit) {
        this.holder_name = holderName;
        this.initial_deposit = initialDeposit;
    }

    public String getHolder_name() { return holder_name; }
    public void setHolder_name(String holder_name) { this.holder_name = holder_name; }

    public BigDecimal getInitial_deposit() { return initial_deposit; }
    public void setInitial_deposit(BigDecimal initial_deposit) { this.initial_deposit = initial_deposit; }
}
