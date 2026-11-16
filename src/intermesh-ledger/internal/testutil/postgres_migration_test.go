package testutil_test

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"intermesh-ledger/internal/dto"
	"intermesh-ledger/internal/repository"
	"intermesh-ledger/internal/testutil"
	"reflect"
	"strings"
	"testing"

	"github.com/lib/pq"
)

func execSQL(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}

func requireSQLState(t *testing.T, err error, want string) {
	t.Helper()
	var pgErr *pq.Error
	if !errors.As(err, &pgErr) || string(pgErr.Code) != want {
		t.Fatalf("expected PostgreSQL SQLSTATE %s, got %v", want, err)
	}
}

func seedSource(t *testing.T, db *sql.DB) {
	t.Helper()
	execSQL(t, db, `INSERT INTO intermesh_accounts
		(account_id,user_id,iban,holder_name,balance)
		VALUES ('SOURCE','synthetic-user','TEST-SOURCE','Synthetic User',100.00)`)
}

func uuid(n int) string          { return fmt.Sprintf("00000000-0000-4000-8000-%012x", n) }
func transactionID(n int) string { return "TX-IM-" + uuid(n) }

type requestRow struct {
	id, issuer, subject, source, destination, amount, permission, status, code any
}

func request(n int) requestRow {
	return requestRow{uuid(n), "https://issuer.example.invalid/realms/demo", "synthetic-subject",
		"SOURCE", "TEST-DESTINATION", "12.30", false, "ADMITTED", nil}
}

func insertRequest(db *sql.DB, r requestRow) error {
	_, err := db.Exec(`INSERT INTO intermesh_transfer_requests
		(transfer_request_id,issuer,subject,source_account_id,target_iban,amount,
		allow_duplicate_pending_transfer,admission_status,rejection_code)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		r.id, r.issuer, r.subject, r.source, r.destination, r.amount, r.permission, r.status, r.code)
	return err
}

type transactionRow struct {
	id, source, destination, amount, status, request, approved, parent any
}

func transaction(n int) transactionRow {
	return transactionRow{transactionID(n), "SOURCE", "TEST-DESTINATION", "12.30", "PENDING", uuid(n), false, nil}
}

func insertTransaction(db *sql.DB, r transactionRow) error {
	_, err := db.Exec(`INSERT INTO intermesh_transactions
		(transaction_id,source_account_id,target_iban,amount,status,
		transfer_request_id,duplicate_pending_approved,ordinary_transaction_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		r.id, r.source, r.destination, r.amount, r.status, r.request, r.approved, r.parent)
	return err
}

func rowsAsJSON(t *testing.T, db *sql.DB, query string) []string {
	t.Helper()
	rows, err := db.Query(query)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var result []string
	for rows.Next() {
		var row string
		if err := rows.Scan(&row); err != nil {
			t.Fatal(err)
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}

func legacySnapshot(t *testing.T, db *sql.DB) []string {
	t.Helper()
	accounts := rowsAsJSON(t, db, `SELECT row_to_json(a)::text FROM
		(SELECT account_id,user_id,iban,holder_name,balance,frozen_balance
		 FROM intermesh_accounts ORDER BY account_id) a`)
	transactions := rowsAsJSON(t, db, `SELECT row_to_json(t)::text FROM
		(SELECT transaction_id,source_account_id,target_iban,amount,status,timestamp
		 FROM intermesh_transactions ORDER BY transaction_id) t`)
	sequence := rowsAsJSON(t, db, `SELECT row_to_json(s)::text FROM
		(SELECT last_value,is_called FROM intermesh_account_seq) s`)
	return append(append(accounts, transactions...), sequence...)
}

func TestPostgresTransferRequestMigrationPreservesLegacy(t *testing.T) {
	db := testutil.PostgresBeforeTransferRequests(t)
	seedSource(t, db)
	execSQL(t, db, `UPDATE intermesh_accounts SET balance=87.69,frozen_balance=12.31;
		INSERT INTO intermesh_transactions
		(transaction_id,source_account_id,target_iban,amount,status,timestamp) VALUES
		('TX-IM-old-a','SOURCE','TEST-A',12.30,'PENDING','2020-01-02 03:04:05'),
		('TX-IM-old-b','SOURCE','TEST-B',0.01,'PENDING','2020-01-02 03:04:06'),
		('TX-IM-old-c','SOURCE','TEST-C',5.00,'APPROVED','2020-01-02 03:04:07'),
		('TX-IM-old-d','SOURCE','TEST-D',2.00,'FAILED',NULL)`)
	before := legacySnapshot(t, db)
	testutil.ApplyTransferRequestsMigration(t, db)
	if after := legacySnapshot(t, db); !reflect.DeepEqual(before, after) {
		t.Fatalf("migration changed legacy data: before=%v after=%v", before, after)
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM intermesh_transactions WHERE
		transfer_request_id IS NULL AND ordinary_transaction_id IS NULL
		AND NOT duplicate_pending_approved`).Scan(&count); err != nil || count != 4 {
		t.Fatalf("legacy defaults: count=%d err=%v", count, err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM intermesh_transfer_requests`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("migration fabricated request identities: count=%d err=%v", count, err)
	}
	execSQL(t, db, `INSERT INTO intermesh_transactions
		(transaction_id,source_account_id,target_iban,amount,status) VALUES
		('TX-IM-legacy-e','SOURCE','TEST-E',1.00,'PENDING'),
		('TX-IM-legacy-f','SOURCE','TEST-F',2.00,'FAILED')`)
	if err := db.QueryRow(`SELECT count(*) FROM intermesh_transactions WHERE
		transfer_request_id IS NULL AND ordinary_transaction_id IS NULL
		AND NOT duplicate_pending_approved`).Scan(&count); err != nil || count != 6 {
		t.Fatalf("multiple legacy rows: count=%d err=%v", count, err)
	}
	_, err := db.Exec(`INSERT INTO intermesh_transactions
		(transaction_id,source_account_id,target_iban,amount,status)
		VALUES ('TX-IM-old-a','SOURCE','TEST',1.00,'PENDING')`)
	requireSQLState(t, err, "23505")
	_, err = db.Exec(`DELETE FROM intermesh_accounts WHERE account_id='SOURCE'`)
	requireSQLState(t, err, "23503")
	_, err = db.Exec(`INSERT INTO intermesh_accounts (account_id,user_id,iban,holder_name)
		VALUES ('OTHER','other','TEST-SOURCE','Synthetic Other')`)
	requireSQLState(t, err, "23505")
}

func TestPostgresTransferRequestRegistryValidRows(t *testing.T) {
	db := testutil.Postgres(t)
	seedSource(t, db)
	for i, amount := range []string{"1", "12.3", "0.01", "9999999999999.99"} {
		r := request(i + 1)
		r.amount = amount
		if err := insertRequest(db, r); err != nil {
			t.Fatal(err)
		}
		var got string
		var timestampPresent bool
		if err := db.QueryRow(`SELECT amount::text,created_at IS NOT NULL
			FROM intermesh_transfer_requests WHERE transfer_request_id=$1`, r.id).Scan(&got, &timestampPresent); err != nil {
			t.Fatal(err)
		}
		want := []string{"1.00", "12.30", "0.01", "9999999999999.99"}[i]
		if got != want || !timestampPresent {
			t.Fatalf("amount/timestamp: got=%s present=%t", got, timestampPresent)
		}
	}
	for i, code := range []string{"DUPLICATE_APPROVAL_REQUIRED", "DUPLICATE_APPROVAL_NOT_ELIGIBLE",
		"DUPLICATE_EXCEPTION_USED", "ACTIVE_CYCLE_BLOCKED", "ACTIVE_CYCLE_CONFLICT", "INSUFFICIENT_FUNDS"} {
		r := request(i + 10)
		r.status, r.code = "REJECTED", code
		r.permission = i%2 == 0
		if err := insertRequest(db, r); err != nil {
			t.Fatal(err)
		}
	}
	r := request(100)
	r.issuer, r.subject = strings.Repeat("i", 2047)+" ", strings.Repeat("s", 254)+" "
	if err := insertRequest(db, r); err != nil {
		t.Fatal(err)
	}
	var issuer, subject string
	if err := db.QueryRow(`SELECT issuer,subject FROM intermesh_transfer_requests
		WHERE transfer_request_id=$1`, r.id).Scan(&issuer, &subject); err != nil || issuer != r.issuer || subject != r.subject {
		t.Fatalf("identity values were changed: %v", err)
	}
	requireSQLState(t, insertRequest(db, r), "23505")
}

func TestPostgresTransferRequestRegistryRejectsInvalidRows(t *testing.T) {
	db := testutil.Postgres(t)
	seedSource(t, db)
	cases := []struct {
		name string
		edit func(*requestRow)
		code string
	}{
		{"missing UUID", func(r *requestRow) { r.id = nil }, "23502"},
		{"malformed UUID", func(r *requestRow) { r.id = "invalid" }, "22P02"},
		{"missing issuer", func(r *requestRow) { r.issuer = nil }, "23502"},
		{"empty issuer", func(r *requestRow) { r.issuer = "" }, "23514"},
		{"blank issuer", func(r *requestRow) { r.issuer = " \t\r\n" }, "23514"},
		{"long issuer", func(r *requestRow) { r.issuer = strings.Repeat("i", 2049) }, "23514"},
		{"issuer padding cannot truncate", func(r *requestRow) { r.issuer = strings.Repeat("i", 2048) + " " }, "23514"},
		{"missing subject", func(r *requestRow) { r.subject = nil }, "23502"},
		{"empty subject", func(r *requestRow) { r.subject = "" }, "23514"},
		{"blank subject", func(r *requestRow) { r.subject = " \t\r\n" }, "23514"},
		{"long subject", func(r *requestRow) { r.subject = strings.Repeat("s", 256) }, "23514"},
		{"subject padding cannot truncate", func(r *requestRow) { r.subject = strings.Repeat("s", 255) + " " }, "23514"},
		{"missing source", func(r *requestRow) { r.source = nil }, "23502"},
		{"unknown source", func(r *requestRow) { r.source = "MISSING" }, "23503"},
		{"missing destination", func(r *requestRow) { r.destination = nil }, "23502"},
		{"empty destination", func(r *requestRow) { r.destination = "" }, "23514"},
		{"blank destination", func(r *requestRow) { r.destination = " \t\n" }, "23514"},
		{"long destination", func(r *requestRow) { r.destination = strings.Repeat("x", 35) }, "22001"},
		{"missing amount", func(r *requestRow) { r.amount = nil }, "23502"},
		{"zero amount", func(r *requestRow) { r.amount = "0.00" }, "23514"},
		{"negative amount", func(r *requestRow) { r.amount = "-0.01" }, "23514"},
		{"excessive amount", func(r *requestRow) { r.amount = "10000000000000.00" }, "22003"},
		{"NaN amount", func(r *requestRow) { r.amount = "NaN" }, "23514"},
		{"missing approval", func(r *requestRow) { r.permission = nil }, "23502"},
		{"missing admission", func(r *requestRow) { r.status = nil }, "23502"},
		{"unknown admission", func(r *requestRow) { r.status = "OTHER" }, "23514"},
		{"admitted with rejection", func(r *requestRow) { r.code = "INSUFFICIENT_FUNDS" }, "23514"},
		{"rejected without code", func(r *requestRow) { r.status = "REJECTED" }, "23514"},
		{"rejected with empty code", func(r *requestRow) { r.status, r.code = "REJECTED", "" }, "23514"},
		{"rejected with unknown code", func(r *requestRow) { r.status, r.code = "REJECTED", "OTHER" }, "23514"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := request(1)
			tc.edit(&r)
			requireSQLState(t, insertRequest(db, r), tc.code)
		})
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM intermesh_transfer_requests`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("invalid registry rows persisted: count=%d err=%v", count, err)
	}
}

func TestPostgresTransferRequestTransactionConstraints(t *testing.T) {
	db := testutil.Postgres(t)
	seedSource(t, db)
	for i := 1; i <= 2; i++ {
		if err := insertRequest(db, request(i)); err != nil {
			t.Fatal(err)
		}
	}
	if err := insertTransaction(db, transaction(1)); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		edit func(*transactionRow)
		code string
	}{
		{"request used twice", func(r *transactionRow) { r.request = uuid(1) }, "23505"},
		{"unknown request", func(r *transactionRow) { r.request = uuid(999) }, "23503"},
		{"orphan parent", func(r *transactionRow) { r.approved, r.parent = true, transactionID(999) }, "23503"},
		{"self parent", func(r *transactionRow) { r.approved, r.parent = true, r.id }, "23514"},
		{"parent without approval", func(r *transactionRow) { r.parent = transactionID(1) }, "23514"},
		{"approval without parent", func(r *transactionRow) { r.approved = true }, "23514"},
		{"duplicate without request", func(r *transactionRow) { r.approved, r.parent, r.request = true, transactionID(1), nil }, "23514"},
		{"null approval marker", func(r *transactionRow) { r.approved = nil }, "23502"},
		{"registered without source", func(r *transactionRow) { r.source = nil }, "23514"},
		{"registered unknown source", func(r *transactionRow) { r.source = "MISSING" }, "23503"},
		{"registered zero amount", func(r *transactionRow) { r.amount = "0.00" }, "23514"},
		{"registered negative amount", func(r *transactionRow) { r.amount = "-0.01" }, "23514"},
		{"registered NaN amount", func(r *transactionRow) { r.amount = "NaN" }, "23514"},
		{"registered unknown status", func(r *transactionRow) { r.status = "OTHER" }, "23514"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := transaction(2)
			tc.edit(&r)
			requireSQLState(t, insertTransaction(db, r), tc.code)
		})
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM intermesh_transactions`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("invalid transactions persisted: count=%d err=%v", count, err)
	}
	var definition string
	if err := db.QueryRow(`SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema()
		AND indexname='ix_intermesh_pending_transfer'`).Scan(&definition); err != nil {
		t.Fatal(err)
	}
	for _, part := range []string{"source_account_id, target_iban, amount", "WHERE", "PENDING"} {
		if !strings.Contains(definition, part) {
			t.Fatalf("incorrect pending lookup index: %s", definition)
		}
	}
}

func TestPostgresTransferRequestOneChildAcrossStatuses(t *testing.T) {
	for _, status := range []string{"PENDING", "APPROVED", "FAILED"} {
		t.Run(status, func(t *testing.T) {
			db := testutil.Postgres(t)
			seedSource(t, db)
			for i := 1; i <= 3; i++ {
				r := request(i)
				r.permission = i > 1
				if err := insertRequest(db, r); err != nil {
					t.Fatal(err)
				}
			}
			if err := insertTransaction(db, transaction(1)); err != nil {
				t.Fatal(err)
			}
			child := transaction(2)
			child.approved, child.parent = true, transactionID(1)
			if err := insertTransaction(db, child); err != nil {
				t.Fatal(err)
			}
			execSQL(t, db, `UPDATE intermesh_transactions SET status=$2 WHERE transaction_id=$1`, child.id, status)
			second := transaction(3)
			second.approved, second.parent = true, transactionID(1)
			requireSQLState(t, insertTransaction(db, second), "23505")
			_, err := db.Exec(`DELETE FROM intermesh_transactions WHERE transaction_id=$1`, transactionID(1))
			requireSQLState(t, err, "23503")
		})
	}
}

func TestPostgresTransferRequestFinalizationCompatibility(t *testing.T) {
	for _, restore := range []bool{false, true} {
		t.Run(fmt.Sprintf("restore=%t", restore), func(t *testing.T) {
			db := testutil.Postgres(t)
			seedSource(t, db)
			execSQL(t, db, `UPDATE intermesh_accounts SET balance=75.40,frozen_balance=24.60`)
			for i := 1; i <= 2; i++ {
				r := request(i)
				r.permission = i == 2
				if err := insertRequest(db, r); err != nil {
					t.Fatal(err)
				}
				tx := transaction(i)
				if i == 2 {
					tx.approved, tx.parent = true, transactionID(1)
				}
				if err := insertTransaction(db, tx); err != nil {
					t.Fatal(err)
				}
			}
			var amount dto.Amount
			if err := json.Unmarshal([]byte("12.3000"), &amount); err != nil {
				t.Fatal(err)
			}
			repo := repository.NewAccountRepository(db)
			for i := 1; i <= 2; i++ {
				ref := dto.TransactionReference{TransactionID: transactionID(i), AccountID: "SOURCE", Amount: amount}
				if restore {
					if err := repo.RollbackReferencedTransaction(ref); err != nil {
						t.Fatal(err)
					}
				} else if id, err := repo.CommitReferencedTransaction(ref); err != nil || id != ref.TransactionID {
					t.Fatalf("commit: id=%s err=%v", id, err)
				}
			}
			var balance, frozen, status, parent, requestID string
			var approved bool
			if err := db.QueryRow(`SELECT balance::text,frozen_balance::text FROM intermesh_accounts
				WHERE account_id='SOURCE'`).Scan(&balance, &frozen); err != nil {
				t.Fatal(err)
			}
			wantBalance, wantStatus := "75.40", "APPROVED"
			if restore {
				wantBalance, wantStatus = "100.00", "FAILED"
			}
			if balance != wantBalance || frozen != "0.00" {
				t.Fatalf("incorrect exact balances: %s/%s", balance, frozen)
			}
			if err := db.QueryRow(`SELECT status,ordinary_transaction_id,transfer_request_id::text,
				duplicate_pending_approved FROM intermesh_transactions WHERE transaction_id=$1`, transactionID(2)).
				Scan(&status, &parent, &requestID, &approved); err != nil {
				t.Fatal(err)
			}
			if status != wantStatus || parent != transactionID(1) || requestID != uuid(2) || !approved {
				t.Fatal("finalization changed the duplicate association or request identity")
			}
		})
	}
}
