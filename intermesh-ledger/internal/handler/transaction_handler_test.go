package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestMalformedFinalizationRejectedBeforeSQL(t *testing.T) {
	for _, endpoint := range []string{"commit", "unfreeze"} {
		for _, body := range []string{
			`{}`, `null`, `[]`, `true`, `{`, ``,
			`{"account_id":"SOURCE","amount":12.30}`,
			`{"transaction_id":null,"account_id":"SOURCE","amount":12.30}`,
			`{"transaction_id":123,"account_id":"SOURCE","amount":12.30}`,
			`{"transaction_id":" ","account_id":"SOURCE","amount":12.30}`,
			`{"transaction_id":"TX WITH SPACE","account_id":"SOURCE","amount":12.30}`,
			`{"transaction_id":"TX\u0000ID","account_id":"SOURCE","amount":12.30}`,
			`{"transaction_id":"` + strings.Repeat("x", 51) + `","account_id":"SOURCE","amount":12.30}`,
			`{"transaction_id":"TX","account_id":null,"amount":12.30}`,
			`{"transaction_id":"TX","account_id":123,"amount":12.30}`,
			`{"transaction_id":"TX","account_id":" ","amount":12.30}`,
			`{"transaction_id":"TX","account_id":"SOURCE","amount":12.30,"target_account":"IGNORED"}`,
			`{"transaction_id":"TX","account_id":"SOURCE","amount":12.30} {}`,
			`{"transaction_id":"TX","account_id":"SOURCE","amount":12.30}` + strings.Repeat(" ", 64<<10),
		} {
			t.Run(fmt.Sprintf("%s/%d", endpoint, len(body)), func(t *testing.T) {
				state, db, handler := testLedger(t)
				defer db.Close()
				response := serveWrite(handler, endpoint, body)
				if response.Code != 400 || state.calls != 0 || strings.TrimSpace(response.Body.String()) != `{"error":"Invalid transaction reference"}` {
					t.Fatalf("expected sanitized rejection without SQL: %d %s calls=%d", response.Code, response.Body.String(), state.calls)
				}
			})
		}
	}
}

func TestFinalizationMonetaryValidationBeforeSQL(t *testing.T) {
	for _, endpoint := range []string{"commit", "unfreeze"} {
		for _, amount := range append(append([]string{}, invalidAmounts...), "0", "0.00", strings.Repeat("1", 257)) {
			state, db, handler := testLedger(t)
			body := `{"transaction_id":"TX","account_id":"SOURCE","amount":` + amount + `}`
			response := serveWrite(handler, endpoint, body)
			db.Close()
			if response.Code != http.StatusBadRequest || state.calls != 0 {
				t.Fatalf("invalid amount reached SQL: %q status=%d calls=%d", amount, response.Code, state.calls)
			}
		}
	}
}

func decodeAcknowledgment(t *testing.T, body []byte) string {
	t.Helper()
	var ack struct {
		Status string `json:"status"`
		ID     string `json:"transaction_id"`
	}
	if err := json.Unmarshal(body, &ack); err != nil || ack.ID == "" {
		t.Fatalf("invalid acknowledgment: %s (%v)", body, err)
	}
	return ack.ID
}
