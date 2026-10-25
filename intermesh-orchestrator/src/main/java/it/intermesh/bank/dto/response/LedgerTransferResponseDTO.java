package it.intermesh.bank.dto.response;

import io.quarkus.runtime.annotations.RegisterForReflection;

@RegisterForReflection
public class LedgerTransferResponseDTO {
    private String status;
    private String transaction_id;

    public LedgerTransferResponseDTO() {}

    public LedgerTransferResponseDTO(String status, String transactionId) {
        this.status = status;
        this.transaction_id = transactionId;
    }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public String getTransaction_id() { return transaction_id; }
    public void setTransaction_id(String transaction_id) { this.transaction_id = transaction_id; }
}
