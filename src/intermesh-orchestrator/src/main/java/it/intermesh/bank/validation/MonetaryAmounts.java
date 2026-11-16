package it.intermesh.bank.validation;

import jakarta.ws.rs.BadRequestException;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Map;

public final class MonetaryAmounts {
    private static final BigDecimal MAXIMUM = new BigDecimal("9999999999999.99");

    private MonetaryAmounts() {}

    public static BigDecimal require(BigDecimal amount, boolean allowZero) {
        if (amount == null || amount.signum() < 0 || (!allowZero && amount.signum() == 0)
                || amount.compareTo(MAXIMUM) > 0 || amount.stripTrailingZeros().scale() > 2) {
            throw invalidRequest();
        }
        return amount.setScale(2, RoundingMode.UNNECESSARY);
    }

    public static BadRequestException invalidRequest() {
        return new BadRequestException(Response.status(Response.Status.BAD_REQUEST)
                .type(MediaType.APPLICATION_JSON)
                .entity(Map.of("error", "Invalid monetary request")).build());
    }
}
