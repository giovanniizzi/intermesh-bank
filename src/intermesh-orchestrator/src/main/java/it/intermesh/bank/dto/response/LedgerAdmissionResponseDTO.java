package it.intermesh.bank.dto.response;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;
import com.fasterxml.jackson.databind.JsonNode;
import io.quarkus.runtime.annotations.RegisterForReflection;
import java.util.Set;
import java.util.regex.Pattern;

/** Strict, correlated admission/recovery acknowledgment from Ledger. */
@RegisterForReflection
public final class LedgerAdmissionResponseDTO {
    private static final Pattern UUID = Pattern.compile(
            "(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    private static final Set<String> REJECTIONS = Set.of("DUPLICATE_APPROVAL_REQUIRED",
            "DUPLICATE_APPROVAL_NOT_ELIGIBLE", "DUPLICATE_EXCEPTION_USED", "ACTIVE_CYCLE_BLOCKED",
            "ACTIVE_CYCLE_CONFLICT", "INSUFFICIENT_FUNDS");
    private final JsonNode value;

    @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
    public LedgerAdmissionResponseDTO(JsonNode value) {
        if (value == null || !value.isObject()) throw invalid();
        Set<String> fields = Set.of("status", "transfer_request_id", "admission_status", "rejection_code",
                "transaction_id", "transaction_state", "new_transaction_created", "duplicate_pending_approved", "matching_pending_count");
        value.fieldNames().forEachRemaining(key -> { if (!fields.contains(key)) throw invalid(); });
        this.value = value.deepCopy();
        text("status");
        if (!validRequestId(text("transfer_request_id"))) throw invalid();
        text("admission_status");
        bool("new_transaction_created");
        bool("duplicate_pending_approved");
        JsonNode count = value.path("matching_pending_count");
        if (!count.isIntegralNumber() || !count.canConvertToInt() || count.intValue() < 0) throw invalid();
        if ("ADMITTED".equals(text("admission_status"))) {
            String id = text("transaction_id");
            if (id.isBlank() || id.codePointCount(0, id.length()) > 50
                    || id.codePoints().anyMatch(c -> Character.isWhitespace(c)
                        || Character.isSpaceChar(c) || Character.isISOControl(c))
                    || !Set.of("PENDING", "APPROVED", "FAILED").contains(text("transaction_state"))
                    || value.hasNonNull("rejection_code")) throw invalid();
        } else if ("REJECTED".equals(text("admission_status"))) {
            if (!REJECTIONS.contains(text("rejection_code")) || !value.has("transaction_id")
                    || !value.get("transaction_id").isNull() || !value.has("transaction_state")
                    || !value.get("transaction_state").isNull() || isNew() || bool("duplicate_pending_approved")) throw invalid();
        } else throw invalid();
    }

    public void validate(String requestId, boolean recovery, int httpStatus, boolean approval) {
        if (!requestId.equalsIgnoreCase(text("transfer_request_id"))) throw invalid();
        String status = text("status");
        boolean admitted = "ADMITTED".equals(text("admission_status"));
        if (recovery) {
            if (httpStatus != 200 || !"RECOVERED".equals(status) || isNew()) throw invalid();
        } else if (admitted) {
            if (httpStatus != 200 || !status.equals(isNew() ? "FROZEN" : "REPLAYED")
                    || bool("duplicate_pending_approved") != approval
                    || (isNew() && !"PENDING".equals(text("transaction_state")))) throw invalid();
        } else {
            int expected = "INSUFFICIENT_FUNDS".equals(text("rejection_code")) ? 422 : 409;
            if (httpStatus != expected || !"REJECTED".equals(status)) throw invalid();
        }
    }

    public static boolean validRequestId(String value) { return value != null && UUID.matcher(value).matches(); }
    public boolean isNew() { return bool("new_transaction_created"); }
    public String transactionId() { return text("transaction_id"); }
    @JsonValue public JsonNode toJson() { return value.deepCopy(); }

    private String text(String key) {
        if (!value.path(key).isTextual()) throw invalid();
        return value.path(key).textValue();
    }
    private boolean bool(String key) {
        if (!value.path(key).isBoolean()) throw invalid();
        return value.path(key).booleanValue();
    }
    private static IllegalArgumentException invalid() { return new IllegalArgumentException("Invalid Ledger admission acknowledgment"); }
}
