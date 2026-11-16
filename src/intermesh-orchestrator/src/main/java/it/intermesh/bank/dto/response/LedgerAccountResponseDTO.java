package it.intermesh.bank.dto.response;

import io.quarkus.runtime.annotations.RegisterForReflection;

@RegisterForReflection
public class LedgerAccountResponseDTO {
    private String account_id;
    private String user_id;
    private String iban;
    private String holder_name;
    private double balance;
    private double frozen_balance;

    public LedgerAccountResponseDTO() {}

    public String getAccount_id() { return account_id; }
    public void setAccount_id(String account_id) { this.account_id = account_id; }

    public String getUser_id() { return user_id; }
    public void setUser_id(String user_id) { this.user_id = user_id; }

    public String getIban() { return iban; } 
    public void setIban(String iban) { this.iban = iban; }

    public String getHolder_name() { return holder_name; }
    public void setHolder_name(String holder_name) { this.holder_name = holder_name; }

    public double getBalance() { return balance; }
    public void setBalance(double balance) { this.balance = balance; }

    public double getFrozen_balance() { return frozen_balance; }
    public void setFrozen_balance(double frozen_balance) { this.frozen_balance = frozen_balance; }
}