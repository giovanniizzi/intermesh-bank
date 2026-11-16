package it.intermesh.bank.dto.request;

import io.quarkus.runtime.annotations.RegisterForReflection;
import java.math.BigDecimal;

@RegisterForReflection
public record LedgerFinalizationRequestDTO(String transaction_id, String account_id, BigDecimal amount) {
}
