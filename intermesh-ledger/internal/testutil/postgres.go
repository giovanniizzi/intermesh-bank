// Package testutil provides an opt-in, disposable PostgreSQL fixture for tests.
package testutil

import (
	"database/sql"
	"fmt"
	"github.com/lib/pq"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

var schemaSerial atomic.Uint64

// Opt in only to a disposable local Unix-socket cluster. Never use DATABASE_URL.
func Postgres(t *testing.T) *sql.DB {
	t.Helper()
	db := PostgresBeforeTransferRequests(t)
	ApplyTransferRequestsMigration(t, db)
	return db
}

// PostgresBeforeTransferRequests loads only the bootstrap schema, without demo data.
func PostgresBeforeTransferRequests(t *testing.T) *sql.DB {
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
	accounts, _, found := strings.Cut(readSQL(t, "001.sql"), "INSERT INTO intermesh_accounts")
	if !found {
		t.Fatal("bootstrap account schema/demo-data boundary not found")
	}
	// search_path contains only this disposable schema, never public.
	if _, err := db.Exec(accounts); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(readSQL(t, "002.sql")); err != nil {
		t.Fatal(err)
	}
	return db
}

func ApplyTransferRequestsMigration(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(readSQL(t, "003-transfer-requests.sql")); err != nil {
		t.Fatal(err)
	}
}

func readSQL(t *testing.T, name string) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate SQL test fixtures")
	}
	content, err := os.ReadFile(filepath.Join(filepath.Dir(file), "../../../sql", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}
