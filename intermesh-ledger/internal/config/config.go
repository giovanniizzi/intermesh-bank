package config

import (
	"os"
)

// Config holds all the centralized environment configurations for the Ledger microservice
type Config struct {
	DatabaseURL string
	Port        string
}

// LoadConfig reads the environment variables or injects secure fallback defaults
func LoadConfig() *Config {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		// Secure default fallback for local development environments
		dbURL = "postgres://postgres:password@localhost:5432/intermesh?sslmode=disable"
	}

	port := os.Getenv("PORT")
	if port == "" {
		// Standard internal ledger communication port
		port = "8080"
	}

	return &Config{
		DatabaseURL: dbURL,
		Port:        port,
	}
}
