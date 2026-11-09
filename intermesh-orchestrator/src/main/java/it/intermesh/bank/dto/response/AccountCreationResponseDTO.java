package it.intermesh.bank.dto.response;

import io.quarkus.runtime.annotations.RegisterForReflection;

@RegisterForReflection
public class AccountCreationResponseDTO {
    private String status;
    private String session_token;
    private LedgerAccountResponseDTO account_details;

    public AccountCreationResponseDTO() {}

    public AccountCreationResponseDTO(String status, String sessionToken, LedgerAccountResponseDTO accountDetails) {
        this.status = status;
        this.session_token = sessionToken;
        this.account_details = accountDetails;
    }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public String getSession_token() { return session_token; }
    public void setSession_token(String session_token) { this.session_token = session_token; }

    public LedgerAccountResponseDTO getAccount_details() { return account_details; }
    public void setAccount_details(LedgerAccountResponseDTO account_details) { this.account_details = account_details; }
}