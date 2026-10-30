package it.intermesh.bank.dto.request;

import io.quarkus.runtime.annotations.RegisterForReflection;
import java.math.BigDecimal;

@RegisterForReflection
public class LedgerTransactionRequestDTO {
    private String account_id;
    private BigDecimal amount;

    public LedgerTransactionRequestDTO() {}

    public LedgerTransactionRequestDTO(String accountId, BigDecimal amount) {
        this.account_id = accountId;
        this.amount = amount;
    }

    public String getAccount_id() { return account_id; }
    public void setAccount_id(String account_id) { this.account_id = account_id; }

    public BigDecimal getAmount() { return amount; }
    public void setAmount(BigDecimal amount) { this.amount = amount; }
}
