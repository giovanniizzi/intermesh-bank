package it.intermesh.bank.dto.request;

import io.quarkus.runtime.annotations.RegisterForReflection;
import java.math.BigDecimal;

@RegisterForReflection
public class LedgerAccountCreationRequestDTO {
    private String user_id;
    private String holder_name;
    private BigDecimal initial_deposit;

    public LedgerAccountCreationRequestDTO() {}

    public LedgerAccountCreationRequestDTO(String userId, String holderName, BigDecimal initialDeposit) {
        this.user_id = userId;
        this.holder_name = holderName;
        this.initial_deposit = initialDeposit;
    }

    public String getUser_id() { return user_id; }
    public void setUser_id(String user_id) { this.user_id = user_id; }

    public String getHolder_name() { return holder_name; }
    public void setHolder_name(String holder_name) { this.holder_name = holder_name; }

    public BigDecimal getInitial_deposit() { return initial_deposit; }
    public void setInitial_deposit(BigDecimal initial_deposit) { this.initial_deposit = initial_deposit; }
}
