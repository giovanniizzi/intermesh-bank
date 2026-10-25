package it.intermesh.bank.dto.request;

import io.quarkus.runtime.annotations.RegisterForReflection;

@RegisterForReflection
public class LedgerTransactionRequestDTO {
    private String account_id;
    private double amount;

    public LedgerTransactionRequestDTO() {}

    public LedgerTransactionRequestDTO(String accountId, double amount) {
        this.account_id = accountId;
        this.amount = amount;
    }

    public String getAccount_id() { return account_id; }
    public void setAccount_id(String account_id) { this.account_id = account_id; }

    public double getAmount() { return amount; }
    public void setAmount(double amount) { this.amount = amount; }
}