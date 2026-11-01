package handler

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"intermesh-ledger/internal/repository"
	"intermesh-ledger/internal/testutil"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPostgresHTTPTransactionLifecycle(t *testing.T) {
	db := testutil.Postgres(t)
	execHTTPTestSQL(t, db, `INSERT INTO intermesh_accounts (account_id,user_id,iban,holder_name,balance)
		VALUES ('SOURCE','synthetic-user','TEST-IBAN','Synthetic Test',100.00),
		('OTHER','synthetic-other','OTHER-IBAN','Synthetic Other',100.00)`)
	handler := NewLedgerHandler(repository.NewAccountRepository(db))
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/ledger/freeze", handler.HandleFreeze)
	mux.HandleFunc("POST /v1/ledger/commit", handler.HandleCommit)
	mux.HandleFunc("POST /v1/ledger/unfreeze", handler.HandleUnfreeze)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	post := func(endpoint, body string, status int) []byte {
		t.Helper()
		response, err := server.Client().Post(server.URL+"/v1/ledger/"+endpoint, "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		content, err := io.ReadAll(response.Body)
		if err != nil || response.StatusCode != status {
			t.Fatalf("%s: status=%d body=%s err=%v", endpoint, response.StatusCode, content, err)
		}
		return content
	}
	freeze := func(amount string) string {
		t.Helper()
		return decodeAcknowledgment(t, post("freeze", `{"account_id":"SOURCE","target_account":"TEST-RECIPIENT-IBAN","amount":`+amount+`}`, 200))
	}
	ref := func(id, account, amount string) string {
		return fmt.Sprintf(`{"transaction_id":%q,"account_id":%q,"amount":%s}`, id, account, amount)
	}
	a, b := freeze("12.30"), freeze("0.01")
	if a == b {
		t.Fatal("freeze IDs must be distinct")
	}
	assertHTTPDBState(t, db, "87.69", "12.31", map[string]string{a: "PENDING", b: "PENDING"})
	for _, endpoint := range []string{"commit", "unfreeze"} {
		for _, tc := range []struct {
			body   string
			status int
		}{
			{`{"account_id":"SOURCE","amount":12.30}`, 400},
			{ref("UNKNOWN", "SOURCE", "12.30"), 404},
			{ref(a, "OTHER", "12.30"), 404},
			{ref(a, "MISSING", "12.30"), 404},
			{ref(a, "SOURCE", "12.31"), 409},
		} {
			post(endpoint, tc.body, tc.status)
			assertHTTPDBState(t, db, "87.69", "12.31", map[string]string{a: "PENDING", b: "PENDING"})
		}
	}
	body := post("commit", ref(a, "SOURCE", "12.3000"), 200)
	var ack map[string]string
	if err := json.Unmarshal(body, &ack); err != nil || len(ack) != 2 || ack["status"] != "COMMITTED" || ack["transaction_id"] != a {
		t.Fatalf("commit acknowledgment: %s %v", body, err)
	}
	assertHTTPDBState(t, db, "87.69", "0.01", map[string]string{a: "APPROVED", b: "PENDING"})
	post("unfreeze", ref(b, "SOURCE", "0.01"), 200)
	for _, endpoint := range []string{"commit", "unfreeze"} {
		post(endpoint, ref(a, "SOURCE", "12.30"), 409)
		post(endpoint, ref(b, "SOURCE", "0.01"), 409)
		assertHTTPDBState(t, db, "87.70", "0.00", map[string]string{a: "APPROVED", b: "FAILED"})
	}
	// Incompatible frozen assets must return a conflict without changing status.
	c := freeze("1.00")
	execHTTPTestSQL(t, db, `UPDATE intermesh_accounts SET frozen_balance=0 WHERE account_id='SOURCE'`)
	for _, endpoint := range []string{"commit", "unfreeze"} {
		post(endpoint, ref(c, "SOURCE", "1.00"), 409)
		assertHTTPDBState(t, db, "86.70", "0.00", map[string]string{c: "PENDING"})
	}
	// A real SQL failure after the balance update must roll back and stay sanitized.
	execHTTPTestSQL(t, db, `UPDATE intermesh_accounts SET frozen_balance=1 WHERE account_id='SOURCE';
		CREATE FUNCTION fail_status() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic private detail'; END $$;
		CREATE TRIGGER fail_status BEFORE UPDATE ON intermesh_transactions FOR EACH ROW EXECUTE FUNCTION fail_status()`)
	for _, endpoint := range []string{"commit", "unfreeze"} {
		content := post(endpoint, ref(c, "SOURCE", "1.00"), 500)
		if strings.Contains(string(content), "synthetic") {
			t.Fatal("database details leaked")
		}
		assertHTTPDBState(t, db, "86.70", "1.00", map[string]string{c: "PENDING"})
	}
}

func execHTTPTestSQL(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}

func assertHTTPDBState(t *testing.T, db *sql.DB, balance, frozen string, statuses map[string]string) {
	t.Helper()
	var b, f string
	if err := db.QueryRow(`SELECT balance::text,frozen_balance::text FROM intermesh_accounts WHERE account_id='SOURCE'`).Scan(&b, &f); err != nil {
		t.Fatal(err)
	}
	if b != balance || f != frozen {
		t.Fatalf("balance=%s frozen=%s, want %s/%s", b, f, balance, frozen)
	}
	for id, want := range statuses {
		var status, destination string
		if err := db.QueryRow(`SELECT status,target_iban FROM intermesh_transactions WHERE transaction_id=$1`, id).Scan(&status, &destination); err != nil {
			t.Fatal(err)
		}
		if status != want || destination != "TEST-RECIPIENT-IBAN" {
			t.Fatalf("transaction %s: status=%s destination=%s", id, status, destination)
		}
	}
}
