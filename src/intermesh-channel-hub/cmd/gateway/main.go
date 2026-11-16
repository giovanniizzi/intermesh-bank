package main

import (
	"intermesh-channel-hub/internal/config"
	"intermesh-channel-hub/internal/handler"
	"intermesh-channel-hub/internal/security"
	"log"
	"net/http"
)

func main() {
	// Centralized config bootstrap
	cfg := config.LoadConfig()

	// Instantiate structured handlers passing the immutable configuration state
	proxyHandler := handler.NewProxyHandler(cfg.OrchestratorURL)

	authFunc := security.KeycloakAuth()

	mux := http.NewServeMux()

	// Secure routing definitions
	mux.Handle("POST /api/v1/accounts", authFunc(http.HandlerFunc(proxyHandler.HandleAccountOnboarding)))
	mux.Handle("POST /api/v1/transfers", authFunc(http.HandlerFunc(proxyHandler.HandleTransfer)))

	mux.Handle("GET /api/v1/account/{id}/transactions", authFunc(http.HandlerFunc(proxyHandler.HandleLedgerHistory)))
	mux.Handle("GET /api/v1/accounts/{userID}", authFunc(http.HandlerFunc(proxyHandler.HandleUserAccounts)))

	log.Printf("InterMesh Channel Hub natively running on enterprise port %s...\n", cfg.Port)
	log.Fatal(http.ListenAndServe(":"+cfg.Port, mux))
}
