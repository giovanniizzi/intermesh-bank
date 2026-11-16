package it.intermesh.bank.security;

public record BankingIdentity(String issuer, String subject, String ownerKey) {
}
