package it.intermesh.bank.dto.response;

import io.quarkus.runtime.annotations.RegisterForReflection;

@RegisterForReflection
public class TransactionHistoryDTO {
    private String transaction_id;
    private String target_iban;
    private double amount;
    private String status;
    private String timestamp;

    // Costruttori, Getter e Setter con i nomi con l'underscore per combaciare con il JSON di Go
    public String getTransaction_id() { return transaction_id; }
    public void setTransaction_id(String transaction_id) { this.transaction_id = transaction_id; }
    
    public String getTarget_iban() { return target_iban; }
    public void setTarget_iban(String target_iban) { this.target_iban = target_iban; }

    public double getAmount() { return amount; }
    public void setAmount(double amount) { this.amount = amount; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public String getTimestamp() { return timestamp; }
    public void setTimestamp(String timestamp) { this.timestamp = timestamp; }
}