package handler

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"intermesh-ledger/internal/repository"
	"intermesh-ledger/internal/testutil"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func postgresTransferMux(t *testing.T) (*sql.DB, *http.ServeMux) {
	t.Helper()
	db := testutil.Postgres(t)
	execHTTPTestSQL(t, db, `INSERT INTO intermesh_accounts (account_id,user_id,iban,holder_name,balance)
		VALUES ('SOURCE','synthetic-user','TEST-SOURCE','Synthetic User',100.00)`)
	repo := repository.NewAccountRepository(db)
	mux := NewRouter(repo)
	return db, mux
}

func transferHTTPBody(t *testing.T, w *httptest.ResponseRecorder, status int) transferResponse {
	t.Helper()
	var result transferResponse
	if w.Code != status {
		t.Fatalf("expected %d: got %d %s", status, w.Code, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func transferHTTPSnapshot(t *testing.T, db *sql.DB) []string {
	t.Helper()
	var result []string
	for _, table := range []string{"intermesh_accounts", "intermesh_transfer_requests", "intermesh_transactions"} {
		rows, err := db.Query("SELECT row_to_json(t)::text FROM " + table + " t ORDER BY 1")
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var row string
			if err := rows.Scan(&row); err != nil {
				rows.Close()
				t.Fatal(err)
			}
			result = append(result, row)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	return result
}

func assertTransferHTTPSnapshot(t *testing.T, db *sql.DB, before []string) {
	t.Helper()
	if after := transferHTTPSnapshot(t, db); !reflect.DeepEqual(before, after) {
		t.Fatalf("read/replay changed persistence: before=%v after=%v", before, after)
	}
}

func TestPostgresTransferHTTPAdmissionRecoveryAndFinalization(t *testing.T) {
	db, mux := postgresTransferMux(t)
	body := transferTestBody(transferTestID, "12.30", "false")
	created := transferHTTPBody(t, performTransferRequest(t, mux, transferTestRequest("POST", "/v1/ledger/freeze", body)), 200)
	if created.Status != "FROZEN" || !created.NewTransactionCreated || created.TransactionID == nil || created.AdmissionStatus != "ADMITTED" {
		t.Fatalf("invalid creation acknowledgment: %+v", created)
	}
	before := transferHTTPSnapshot(t, db)
	replay := transferHTTPBody(t, performTransferRequest(t, mux, transferTestRequest("POST", "/v1/ledger/freeze", body)), 200)
	if replay.Status != "REPLAYED" || replay.NewTransactionCreated || replay.TransactionID == nil || *replay.TransactionID != *created.TransactionID {
		t.Fatalf("replay incorrectly reported new work: %+v", replay)
	}
	assertTransferHTTPSnapshot(t, db, before)
	path := "/v1/ledger/transfer-requests/" + transferTestID
	recovered := transferHTTPBody(t, performTransferRequest(t, mux, transferTestRequest("GET", path, "")), 200)
	if recovered.Status != "RECOVERED" || recovered.NewTransactionCreated || recovered.TransactionState == nil || *recovered.TransactionState != "PENDING" {
		t.Fatalf("invalid pending recovery: %+v", recovered)
	}
	assertTransferHTTPSnapshot(t, db, before)

	rejectedID := "00000000-0000-4000-8000-000000000002"
	rejectedBody := transferTestBody(rejectedID, "12.30", "false")
	rejected := transferHTTPBody(t, performTransferRequest(t, mux, transferTestRequest("POST", "/v1/ledger/freeze", rejectedBody)), 409)
	if rejected.RejectionCode != "DUPLICATE_APPROVAL_REQUIRED" || rejected.TransactionID != nil || rejected.TransactionState != nil {
		t.Fatalf("invalid rejection: %+v", rejected)
	}
	before = transferHTTPSnapshot(t, db)
	rejectedRecovery := transferHTTPBody(t, performTransferRequest(t, mux, transferTestRequest("GET", "/v1/ledger/transfer-requests/"+rejectedID, "")), 200)
	if rejectedRecovery.AdmissionStatus != "REJECTED" || rejectedRecovery.RejectionCode != rejected.RejectionCode || rejectedRecovery.TransactionID != nil {
		t.Fatalf("invalid rejected recovery: %+v", rejectedRecovery)
	}
	assertTransferHTTPSnapshot(t, db, before)

	ref := fmt.Sprintf(`{"transaction_id":%q,"account_id":"SOURCE","amount":12.3000}`, *created.TransactionID)
	commit := httptest.NewRecorder()
	mux.ServeHTTP(commit, transferTestRequest("POST", "/v1/ledger/commit", ref))
	if commit.Code != 200 {
		t.Fatalf("FIN-02 commit changed: %d %s", commit.Code, commit.Body.String())
	}
	assertHTTPDBState(t, db, "87.70", "0.00", map[string]string{*created.TransactionID: "APPROVED"})
	before = transferHTTPSnapshot(t, db)
	approved := transferHTTPBody(t, performTransferRequest(t, mux, transferTestRequest("GET", path, "")), 200)
	if approved.TransactionState == nil || *approved.TransactionState != "APPROVED" || approved.NewTransactionCreated {
		t.Fatalf("invalid approved recovery: %+v", approved)
	}
	transferHTTPBody(t, performTransferRequest(t, mux, transferTestRequest("POST", "/v1/ledger/freeze", rejectedBody)), 409)
	assertTransferHTTPSnapshot(t, db, before)

	secondID := "00000000-0000-4000-8000-000000000003"
	second := transferHTTPBody(t, performTransferRequest(t, mux, transferTestRequest("POST", "/v1/ledger/freeze",
		transferTestBody(secondID, "12.30", "false"))), 200)
	ref = fmt.Sprintf(`{"transaction_id":%q,"account_id":"SOURCE","amount":12.30}`, *second.TransactionID)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, transferTestRequest("POST", "/v1/ledger/unfreeze", ref))
	if w.Code != 200 {
		t.Fatalf("FIN-02 unfreeze changed: %d %s", w.Code, w.Body.String())
	}
	failed := transferHTTPBody(t, performTransferRequest(t, mux, transferTestRequest("GET", "/v1/ledger/transfer-requests/"+secondID, "")), 200)
	if failed.TransactionState == nil || *failed.TransactionState != "FAILED" {
		t.Fatalf("invalid failed recovery: %+v", failed)
	}
	assertHTTPDBState(t, db, "87.70", "0.00", map[string]string{*created.TransactionID: "APPROVED", *second.TransactionID: "FAILED"})
}

func TestPostgresTransferHTTPPrivacyAndNoLegacyFallback(t *testing.T) {
	db, mux := postgresTransferMux(t)
	body := transferTestBody(transferTestID, "12.30", "false")
	transferHTTPBody(t, performTransferRequest(t, mux, transferTestRequest("POST", "/v1/ledger/freeze", body)), 200)
	before := transferHTTPSnapshot(t, db)
	path := "/v1/ledger/transfer-requests/" + transferTestID
	missing := performTransferRequest(t, mux, transferTestRequest("GET", "/v1/ledger/transfer-requests/00000000-0000-4000-8000-000000000099", ""))
	if missing.Code != 404 || !strings.Contains(missing.Body.String(), "in-flight admission may still complete") {
		t.Fatalf("misleading absence response: %d %s", missing.Code, missing.Body.String())
	}
	for _, header := range []string{"X-Intermesh-Issuer", "X-Intermesh-Subject", "X-Intermesh-Owner-Key"} {
		for _, method := range []string{"GET", "POST"} {
			route := path
			if method == "POST" {
				route = "/v1/ledger/freeze"
			}
			r := transferTestRequest(method, route, body)
			r.Header.Set(header, "other-identity")
			w := performTransferRequest(t, mux, r)
			if w.Code != 404 || w.Body.String() != missing.Body.String() {
				t.Fatalf("identity mismatch disclosed request details: %d %s", w.Code, w.Body.String())
			}
		}
	}
	w := performTransferRequest(t, mux, transferTestRequest("POST", "/v1/ledger/freeze",
		transferTestBody(transferTestID, "12.31", "false")))
	if w.Code != 409 || !strings.Contains(w.Body.String(), "REQUEST_INTENT_CONFLICT") {
		t.Fatalf("UUID intent mismatch: %d %s", w.Code, w.Body.String())
	}
	legacyBody := `{"account_id":"SOURCE","target_account":"TEST-RECIPIENT-IBAN","amount":12.30}`
	w = performTransferRequest(t, mux, transferTestRequest("POST", "/v1/ledger/freeze", legacyBody))
	if w.Code != 400 {
		t.Fatalf("strict route accepted legacy freeze: %d", w.Code)
	}
	for _, route := range []string{"/v1/ledger/freeze/legacy", "/v1/ledger/freeze-v2"} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, transferTestRequest("POST", route, legacyBody))
		if w.Code != 404 {
			t.Fatal("unexpected alternative freeze route")
		}
	}
	assertTransferHTTPSnapshot(t, db, before)
	execHTTPTestSQL(t, db, `UPDATE intermesh_accounts SET user_id='new-owner' WHERE account_id='SOURCE'`)
	before = transferHTTPSnapshot(t, db)
	w = performTransferRequest(t, mux, transferTestRequest("GET", path, ""))
	if w.Code != 404 || w.Body.String() != missing.Body.String() {
		t.Fatal("former owner recovered the request")
	}
	assertTransferHTTPSnapshot(t, db, before)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	w = performTransferRequest(t, mux, transferTestRequest("GET", path, ""))
	if w.Code != 503 || !strings.Contains(w.Body.String(), "TRANSFER_PERSISTENCE_UNAVAILABLE") {
		t.Fatalf("database failure became absence: %d %s", w.Code, w.Body.String())
	}
}
