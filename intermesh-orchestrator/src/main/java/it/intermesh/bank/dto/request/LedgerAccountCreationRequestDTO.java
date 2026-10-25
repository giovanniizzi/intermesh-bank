package it.intermesh.bank.dto.request;

import io.quarkus.runtime.annotations.RegisterForReflection;

@RegisterForReflection
public class LedgerAccountCreationRequestDTO {
    private String user_id;
    private String holder_name;
    private double initial_deposit;

    public LedgerAccountCreationRequestDTO() {}

    public LedgerAccountCreationRequestDTO(String userId, String holderName, double initialDeposit) {
        this.user_id = userId;
        this.holder_name = holderName;
        this.initial_deposit = initialDeposit;
    }

    public String getUser_id() { return user_id; }
    public void setUser_id(String user_id) { this.user_id = user_id; }

    public String getHolder_name() { return holder_name; }
    public void setHolder_name(String holder_name) { this.holder_name = holder_name; }

    public double getInitial_deposit() { return initial_deposit; }
    public void setInitial_deposit(double initial_deposit) { this.initial_deposit = initial_deposit; }
}