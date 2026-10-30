package it.intermesh.bank.validation;

import static org.junit.jupiter.api.Assertions.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import it.intermesh.bank.dto.request.AccountCreationRequestDTO;
import it.intermesh.bank.dto.request.LedgerAccountCreationRequestDTO;
import it.intermesh.bank.dto.request.LedgerTransactionRequestDTO;
import it.intermesh.bank.dto.request.TransferRequestDTO;
import jakarta.ws.rs.BadRequestException;
import jakarta.ws.rs.core.MediaType;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;

public class MonetaryAmountsTest {
    public record AmountCase(String token, String canonical) {}

    public static final List<AmountCase> VALID = List.of(
            new AmountCase("1", "1.00"), new AmountCase("12.3", "12.30"),
            new AmountCase("12.30", "12.30"), new AmountCase("12.3000", "12.30"),
            new AmountCase("0.01", "0.01"), new AmountCase("9999999999999.99", "9999999999999.99"),
            new AmountCase("1e0", "1.00"), new AmountCase("123e-1", "12.30"), new AmountCase("100e-4", "0.01"));

    public static final List<String> INVALID = List.of(
            "-1", "-0.01", "null", "\"12.30\"", "\"NaN\"", "\"Infinity\"", "true", "false", "[]", "{}",
            "12.345", "1.00000000000000001", "9999999999999.9901", "10000000000000", "1e-3", "1e13",
            "NaN", "Infinity", "-Infinity", "1e999999999999999999999", "1e-999999999999999999999",
            "0e1025", "1e1025", "1e-1025", "01", ".1", "1.", "1e", "");

    private final ObjectMapper mapper = new ObjectMapper();

    @SuppressWarnings("unchecked")
    private Object read(String body, Class<?> type) throws IOException {
        MonetaryRequestReader reader = new MonetaryRequestReader();
        reader.mapper = mapper;
        return reader.readFrom((Class<Object>) type, type, new java.lang.annotation.Annotation[0],
                MediaType.APPLICATION_JSON_TYPE, null,
                new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    void exactAmountsAndOutboundNumbers() throws Exception {
        for (AmountCase tc : VALID) {
            TransferRequestDTO request = (TransferRequestDTO) read("{\"amount\":" + tc.token() + "}", TransferRequestDTO.class);
            BigDecimal amount = MonetaryAmounts.require(request.getAmount(), false);
            assertEquals(new BigDecimal(tc.canonical()), amount);
            var ledger = mapper.readTree(mapper.writeValueAsBytes(new LedgerTransactionRequestDTO("ACC-TEST", amount)));
            assertTrue(ledger.path("amount").isNumber());
            assertEquals(0, amount.compareTo(ledger.path("amount").decimalValue()));
            var account = mapper.readTree(mapper.writeValueAsBytes(new LedgerAccountCreationRequestDTO("test-user", "Test", amount)));
            assertTrue(account.path("initial_deposit").isNumber());
            assertEquals(0, amount.compareTo(account.path("initial_deposit").decimalValue()));
        }
    }

    @Test
    void invalidAmountsAreRejectedWithoutCoercion() {
        for (String token : INVALID) {
            for (boolean deposit : List.of(true, false)) {
                assertThrows(BadRequestException.class, () -> {
                    if (deposit) {
                        AccountCreationRequestDTO dto = (AccountCreationRequestDTO) read(
                                "{\"initial_deposit\":" + token + "}", AccountCreationRequestDTO.class);
                        MonetaryAmounts.require(dto.getInitial_deposit(), true);
                    } else {
                        TransferRequestDTO dto = (TransferRequestDTO) read("{\"amount\":" + token + "}", TransferRequestDTO.class);
                        MonetaryAmounts.require(dto.getAmount(), false);
                    }
                }, "must reject token: " + token);
            }
        }
    }

    @Test
    void zeroMustBeExplicitAndIsOnlyAnOpeningDeposit() throws Exception {
        var missing = (AccountCreationRequestDTO) read("{}", AccountCreationRequestDTO.class);
        assertThrows(BadRequestException.class, () -> MonetaryAmounts.require(missing.getInitial_deposit(), true));
        for (String token : List.of("0", "0.00", "-0.00", "0e2")) {
            var deposit = (AccountCreationRequestDTO) read("{\"initial_deposit\":" + token + "}", AccountCreationRequestDTO.class);
            assertEquals(new BigDecimal("0.00"), MonetaryAmounts.require(deposit.getInitial_deposit(), true));
            assertThrows(BadRequestException.class, () -> MonetaryAmounts.require(deposit.getInitial_deposit(), false));
        }
    }

    @Test
    void malformedTrailingAndOversizedInputIsRejected() {
        for (String body : List.of("", "{", "[]", "true", "{\"amount\":1} garbage", "{\"amount\":1} {}",
                "{\"amount\":" + "1".repeat(257) + "}", "{\"amount\":1}" + " ".repeat(64 << 10))) {
            assertThrows(BadRequestException.class, () -> read(body, TransferRequestDTO.class));
        }
    }
}
