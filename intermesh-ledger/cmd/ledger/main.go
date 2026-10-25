package main

import (
	"intermesh-ledger/internal/config"
	"intermesh-ledger/internal/handler"
	"intermesh-ledger/internal/repository"
	"log"
	"net/http"
)

func main() {
	// 1. Centralized config bootstrap
	cfg := config.LoadConfig()

	// 2. Bootstrap database architecture layer using the configuration state
	db := config.InitDB(cfg.DatabaseURL)
	defer db.Close()

	// 3. Dependency Injection: Repository -> Handler
	repo := repository.NewAccountRepository(db)
	ledgerHandler := handler.NewLedgerHandler(repo)

	mux := http.NewServeMux()

	// 4. Enterprise routing layout matching exact operational endpoints
	mux.HandleFunc("POST /v1/ledger/accounts", ledgerHandler.HandleCreateAccount)
	mux.HandleFunc("POST /v1/ledger/freeze", ledgerHandler.HandleFreeze)
	mux.HandleFunc("POST /v1/ledger/commit", ledgerHandler.HandleCommit)
	mux.HandleFunc("POST /v1/ledger/unfreeze", ledgerHandler.HandleUnfreeze)
	mux.HandleFunc("GET /v1/ledger/account/{id}/balance", ledgerHandler.HandleBalance)
	mux.HandleFunc("GET /v1/ledger/account/{id}/transactions", ledgerHandler.HandleHistory)
	mux.HandleFunc("GET /v1/ledger/accounts/{userID}", ledgerHandler.HandleUserAccounts)

	log.Printf("InterMesh Core Ledger successfully initialized on port %s...\n", cfg.Port)
	log.Fatal(http.ListenAndServe(":"+cfg.Port, mux))
}
