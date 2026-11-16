package config

import (
	"os"
)

// Config holds all the centralized environment configurations for the API Gateway
type Config struct {
	OrchestratorURL string
	Port            string
}

// LoadConfig reads the environment variables or injects secure fallback defaults
func LoadConfig() *Config {
	orchestratorURL := os.Getenv("ORCHESTRATOR_SERVICE_URL")
	if orchestratorURL == "" {
		// Default internal service mesh cluster routing pointing to the backend namespace
		orchestratorURL = "http://intermesh-orchestrator.intermesh-backend.svc.cluster.local"
	}

	port := os.Getenv("PORT")
	if port == "" {
		// Standard perimeter ingress corporate port
		port = "8080"
	}

	return &Config{
		OrchestratorURL: orchestratorURL,
		Port:            port,
	}
}
