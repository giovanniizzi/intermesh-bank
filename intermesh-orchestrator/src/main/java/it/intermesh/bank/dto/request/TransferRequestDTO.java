package it.intermesh.bank.dto.request;

import io.quarkus.runtime.annotations.RegisterForReflection;

@RegisterForReflection
public class TransferRequestDTO {
    private String source_account;
    private String target_account;
    private double amount;

    public TransferRequestDTO() {}

    public String getSource_account() { return source_account; }
    public void setSource_account(String source_account) { this.source_account = source_account; }

    public String getTarget_account() { return target_account; }
    public void setTarget_account(String target_account) { this.target_account = target_account; }

    public double getAmount() { return amount; }
    public void setAmount(double amount) { this.amount = amount; }
}