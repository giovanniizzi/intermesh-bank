package config

import (
	"log"
	"os"
	"strings"
)

// Config holds all the centralized environment configurations for the Ledger microservice
type Config struct {
	DatabaseURL string
	Port        string
}

// LoadConfig reads environment variables and exits if DATABASE_URL is missing.
func LoadConfig() *Config {
	dbURL := os.Getenv("DATABASE_URL")
	if strings.TrimSpace(dbURL) == "" {
		log.Fatal("configuration error: DATABASE_URL is required")
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
