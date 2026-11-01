package it.intermesh.bank.dto.request;

import io.quarkus.runtime.annotations.RegisterForReflection;
import java.math.BigDecimal;

@RegisterForReflection
public class LedgerTransactionRequestDTO {
    private String account_id;
    private BigDecimal amount;
    private String target_account;

    public LedgerTransactionRequestDTO() {}

    public LedgerTransactionRequestDTO(String accountId, String targetAccount, BigDecimal amount) {
        this.account_id = accountId;
        this.target_account = targetAccount;
        this.amount = amount;
    }

    public String getAccount_id() { return account_id; }
    public void setAccount_id(String account_id) { this.account_id = account_id; }

    public String getTarget_account() { return target_account; }
    public void setTarget_account(String targetAccount) { this.target_account = targetAccount; }

    public BigDecimal getAmount() { return amount; }
    public void setAmount(BigDecimal amount) { this.amount = amount; }
}
