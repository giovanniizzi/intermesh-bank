package config

import (
	"database/sql"
	"log"

	_ "github.com/lib/pq"
)

// InitDB establishes a verified connection pool with the PostgreSQL backend
func InitDB(connStr string) *sql.DB {
	db, err := sql.Open("postgres", connStr)
	if err != nil {
		log.Fatalf("Critical: Database link bootstrap failed: %v\n", err)
	}

	if err = db.Ping(); err != nil {
		log.Fatalf("Critical: Database is unreachable: %v\n", err)
	}

	return db
}
