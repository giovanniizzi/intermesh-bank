// Package testutil provides an opt-in, disposable PostgreSQL fixture for tests.
package testutil

import (
	"database/sql"
	"fmt"
	"github.com/lib/pq"
	"os"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

var schemaSerial atomic.Uint64

// Opt in only to a disposable local Unix-socket cluster. Never use DATABASE_URL.
func Postgres(t *testing.T) *sql.DB {
	t.Helper()
	socket := os.Getenv("INTERMESH_TEST_POSTGRES_SOCKET_DIR")
	if socket == "" {
		t.Skip("set INTERMESH_TEST_POSTGRES_SOCKET_DIR to a disposable local PostgreSQL socket directory")
	}
	if !regexp.MustCompile(`^/private/tmp/intermesh-fin02-[A-Za-z0-9./_-]+$`).MatchString(socket) || strings.Contains(socket, "..") {
		t.Fatal("test database must use a disposable /private/tmp/intermesh-fin02-* Unix socket")
	}
	dsn := fmt.Sprintf("host=%s port=55432 user=fin02_test dbname=postgres sslmode=disable connect_timeout=3", socket)
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Close() })
	schema := fmt.Sprintf("fin02_%d_%d", time.Now().UnixNano(), schemaSerial.Add(1))
	if _, err := admin.Exec("CREATE SCHEMA " + pq.QuoteIdentifier(schema)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec("DROP SCHEMA " + pq.QuoteIdentifier(schema) + " CASCADE"); err != nil {
			t.Error(err)
		}
	})
	db, err := sql.Open("postgres", dsn+" search_path="+schema+" lock_timeout=5000 statement_timeout=10000")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	db.SetMaxOpenConns(8)
	// Column definitions mirror sql/001.sql and sql/002.sql; no project fixtures.
	if _, err := db.Exec(`CREATE TABLE intermesh_accounts (
		account_id VARCHAR(50) PRIMARY KEY, user_id VARCHAR(50) NOT NULL,
		iban VARCHAR(34) NOT NULL UNIQUE, holder_name VARCHAR(100) NOT NULL,
		balance NUMERIC(15,2) NOT NULL DEFAULT 0.00,
		frozen_balance NUMERIC(15,2) NOT NULL DEFAULT 0.00);
		CREATE TABLE intermesh_transactions (
		transaction_id VARCHAR(50) PRIMARY KEY,
		source_account_id VARCHAR(50) REFERENCES intermesh_accounts(account_id),
		target_iban VARCHAR(34) NOT NULL, amount NUMERIC(15,2) NOT NULL,
		status VARCHAR(20) NOT NULL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`); err != nil {
		t.Fatal(err)
	}
	return db
}
