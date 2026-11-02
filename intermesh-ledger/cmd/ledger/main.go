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
	mux := handler.NewRouter(repo)

	log.Printf("InterMesh Core Ledger successfully initialized on port %s...\n", cfg.Port)
	log.Fatal(http.ListenAndServe(":"+cfg.Port, mux))
}
