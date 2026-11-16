package handler

import (
	"intermesh-ledger/internal/repository"
	"net/http"
)

// NewRouter is the Ledger HTTP route setup used by the application and tests.
func NewRouter(repo *repository.AccountRepository) *http.ServeMux {
	ledger := NewLedgerHandler(repo)
	mux := http.NewServeMux()
	NewTransferHandler(repo).RegisterRoutes(mux)
	mux.HandleFunc("POST /v1/ledger/accounts", ledger.HandleCreateAccount)
	mux.HandleFunc("POST /v1/ledger/commit", ledger.HandleCommit)
	mux.HandleFunc("POST /v1/ledger/unfreeze", ledger.HandleUnfreeze)
	mux.HandleFunc("GET /v1/ledger/account/{id}/balance", ledger.HandleBalance)
	mux.HandleFunc("GET /v1/ledger/account/{id}/transactions", ledger.HandleHistory)
	mux.HandleFunc("GET /v1/ledger/accounts/{userID}", ledger.HandleUserAccounts)
	return mux
}
