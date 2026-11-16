package it.intermesh.bank.dto.request;

import io.quarkus.runtime.annotations.RegisterForReflection;

@RegisterForReflection
public class FraudAnalysisRequestDTO {
    private String source_account;
    private String target_account;
    private double amount;

    public FraudAnalysisRequestDTO() {}

    public FraudAnalysisRequestDTO(String sourceAccount, String targetAccount, double amount) {
        this.source_account = sourceAccount;
        this.target_account = targetAccount;
        this.amount = amount;
    }

    public String getSource_account() { return source_account; }
    public void setSource_account(String source_account) { this.source_account = source_account; }

    public String getTarget_account() { return target_account; }
    public void setTarget_account(String target_account) { this.target_account = target_account; }

    public double getAmount() { return amount; }
    public void setAmount(double amount) { this.amount = amount; }
}