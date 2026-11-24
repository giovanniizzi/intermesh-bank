package repository_test

import (
	"encoding/json"
	"intermesh-ledger/internal/dto"
	"intermesh-ledger/internal/handler"
	"intermesh-ledger/internal/iban"
	"intermesh-ledger/internal/repository"
	"intermesh-ledger/internal/testutil"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPostgresCreatedIBANHTTPContract(t *testing.T) {
	db := testutil.Postgres(t)
	repo := repository.NewAccountRepository(db)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /accounts", handler.NewLedgerHandler(repo).HandleCreateAccount)
	mux.HandleFunc("GET /balance/{id}", handler.NewLedgerHandler(repo).HandleBalance)
	created := httptest.NewRecorder()
	mux.ServeHTTP(created, httptest.NewRequest(http.MethodPost, "/accounts",
		strings.NewReader(`{"user_id":"synthetic-owner","holder_name":"Synthetic Owner","initial_deposit":12.30}`)))
	var account dto.AccountDTO
	if created.Code != http.StatusCreated || json.Unmarshal(created.Body.Bytes(), &account) != nil ||
		!iban.ValidDemo(account.IBAN) || account.AccountID != "ACC-4000" || account.UserID != "synthetic-owner" || account.Balance != 12.30 {
		t.Fatalf("unexpected account response: HTTP %d", created.Code)
	}
	read := httptest.NewRecorder()
	mux.ServeHTTP(read, httptest.NewRequest(http.MethodGet, "/balance/"+account.AccountID, nil))
	var fetched dto.AccountDTO
	if read.Code != http.StatusOK || json.Unmarshal(read.Body.Bytes(), &fetched) != nil || fetched != account {
		t.Fatal("persisted and returned account contracts differ")
	}
}
