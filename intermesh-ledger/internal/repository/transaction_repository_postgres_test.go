package repository

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"intermesh-ledger/internal/dto"
	"intermesh-ledger/internal/testutil"
	"regexp"
	"strings"
	"sync"
	"testing"
)

func postgresRepository(t *testing.T) (*AccountRepository, *sql.DB) {
	db := testutil.Postgres(t)
	return NewAccountRepository(db), db
}

func execTestSQL(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}

func exactAmount(t *testing.T, value string) dto.Amount {
	t.Helper()
	var amount dto.Amount
	if err := json.Unmarshal([]byte(value), &amount); err != nil {
		t.Fatal(err)
	}
	return amount
}

func seedAccount(t *testing.T, db *sql.DB, id, balance string) {
	t.Helper()
	execTestSQL(t, db, `INSERT INTO intermesh_accounts (account_id,user_id,iban,holder_name,balance)
		VALUES ($1,'synthetic-user',$1,'Synthetic Test',$2)`, id, balance)
}

func freezeReference(t *testing.T, repo *AccountRepository, account, amount string) dto.TransactionReference {
	t.Helper()
	value := exactAmount(t, amount)
	id, err := repo.FreezeFunds(dto.LedgerPayloadDTO{AccountID: account, TargetAccount: "TEST-DESTINATION", Amount: value})
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^TX-IM-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`).MatchString(id) || len(id) != 42 {
		t.Fatalf("expected a full prefixed UUID, got %q", id)
	}
	return dto.TransactionReference{TransactionID: id, AccountID: account, Amount: value}
}

func assertBalances(t *testing.T, db *sql.DB, account, balance, frozen string) {
	t.Helper()
	var gotBalance, gotFrozen string
	if err := db.QueryRow(`SELECT balance::text,frozen_balance::text FROM intermesh_accounts WHERE account_id=$1`, account).Scan(&gotBalance, &gotFrozen); err != nil {
		t.Fatal(err)
	}
	if gotBalance != balance || gotFrozen != frozen {
		t.Fatalf("balances: got %s/%s, want %s/%s", gotBalance, gotFrozen, balance, frozen)
	}
}

func assertStatus(t *testing.T, db *sql.DB, ref dto.TransactionReference, want string) {
	t.Helper()
	var status string
	if err := db.QueryRow(`SELECT status FROM intermesh_transactions WHERE transaction_id=$1`, ref.TransactionID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != want {
		t.Fatalf("status: got %s, want %s", status, want)
	}
}

func TestPostgresIndependentTransactions(t *testing.T) {
	repo, db := postgresRepository(t)
	seedAccount(t, db, "SOURCE", "100.00")
	a := freezeReference(t, repo, "SOURCE", "12.30")
	b := freezeReference(t, repo, "SOURCE", "0.01")
	if a.TransactionID == b.TransactionID {
		t.Fatal("freeze IDs must be unique")
	}
	assertBalances(t, db, "SOURCE", "87.69", "12.31")
	id, err := repo.CommitReferencedTransaction(a)
	if err != nil || id != a.TransactionID {
		t.Fatalf("commit: %q %v", id, err)
	}
	assertBalances(t, db, "SOURCE", "87.69", "0.01")
	assertStatus(t, db, a, "APPROVED")
	assertStatus(t, db, b, "PENDING")
	if err := repo.RollbackReferencedTransaction(b); err != nil {
		t.Fatal(err)
	}
	assertBalances(t, db, "SOURCE", "87.70", "0.00")
	assertStatus(t, db, a, "APPROVED")
	assertStatus(t, db, b, "FAILED")
}

func TestPostgresInvalidReferences(t *testing.T) {
	repo, db := postgresRepository(t)
	seedAccount(t, db, "SOURCE", "100.00")
	seedAccount(t, db, "OTHER", "100.00")
	valid := freezeReference(t, repo, "SOURCE", "12.30")
	cases := []struct {
		name string
		edit func(*dto.TransactionReference)
		want error
	}{
		{"missing ID", func(r *dto.TransactionReference) { r.TransactionID = "" }, ErrInvalidTransactionReference},
		{"blank ID", func(r *dto.TransactionReference) { r.TransactionID = " " }, ErrInvalidTransactionReference},
		{"oversized ID", func(r *dto.TransactionReference) { r.TransactionID = strings.Repeat("x", 51) }, ErrInvalidTransactionReference},
		{"unknown ID", func(r *dto.TransactionReference) { r.TransactionID = "UNKNOWN" }, ErrTransactionNotFound},
		{"wrong account", func(r *dto.TransactionReference) { r.AccountID = "OTHER" }, ErrTransactionNotFound},
		{"unknown account", func(r *dto.TransactionReference) { r.AccountID = "MISSING" }, ErrTransactionNotFound},
		{"missing account", func(r *dto.TransactionReference) { r.AccountID = "" }, ErrInvalidTransactionReference},
		{"amount mismatch", func(r *dto.TransactionReference) { r.Amount = exactAmount(t, "12.31") }, ErrTransactionConflict},
		{"zero", func(r *dto.TransactionReference) { r.Amount = exactAmount(t, "0") }, ErrInvalidTransactionReference},
		{"missing amount", func(r *dto.TransactionReference) { r.Amount = dto.Amount{} }, ErrInvalidTransactionReference},
	}
	for _, tc := range cases {
		for _, restore := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/restore=%t", tc.name, restore), func(t *testing.T) {
				ref := valid
				tc.edit(&ref)
				if err := repo.finalizeTransaction(ref, restore); !errors.Is(err, tc.want) {
					t.Fatalf("got %v, want %v", err, tc.want)
				}
				assertBalances(t, db, "SOURCE", "87.70", "12.30")
				assertBalances(t, db, "OTHER", "100.00", "0.00")
				assertStatus(t, db, valid, "PENDING")
			})
		}
	}
}

func TestPostgresTerminalConflicts(t *testing.T) {
	for _, firstRestore := range []bool{false, true} {
		t.Run(fmt.Sprint(firstRestore), func(t *testing.T) {
			repo, db := postgresRepository(t)
			seedAccount(t, db, "SOURCE", "100.00")
			ref := freezeReference(t, repo, "SOURCE", "12.30")
			if err := repo.finalizeTransaction(ref, firstRestore); err != nil {
				t.Fatal(err)
			}
			for _, restore := range []bool{false, true} {
				if err := repo.finalizeTransaction(ref, restore); !errors.Is(err, ErrTransactionConflict) {
					t.Fatalf("terminal operation must conflict: %v", err)
				}
			}
			if firstRestore {
				assertBalances(t, db, "SOURCE", "100.00", "0.00")
				assertStatus(t, db, ref, "FAILED")
			} else {
				assertBalances(t, db, "SOURCE", "87.70", "0.00")
				assertStatus(t, db, ref, "APPROVED")
			}
		})
	}
}

func TestPostgresAtomicFailures(t *testing.T) {
	for _, restore := range []bool{false, true} {
		for _, failure := range []string{"status error", "status zero rows", "balance zero rows"} {
			t.Run(fmt.Sprintf("%t/%s", restore, failure), func(t *testing.T) {
				repo, db := postgresRepository(t)
				seedAccount(t, db, "SOURCE", "100.00")
				ref := freezeReference(t, repo, "SOURCE", "12.30")
				table, body := "intermesh_transactions", "RETURN NULL;"
				if failure == "status error" {
					body = "RAISE EXCEPTION 'synthetic status failure';"
				} else if failure == "balance zero rows" {
					table = "intermesh_accounts"
				}
				execTestSQL(t, db, `CREATE FUNCTION fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN `+body+` END $$;
					CREATE TRIGGER fail_write BEFORE UPDATE ON `+table+` FOR EACH ROW EXECUTE FUNCTION fail_write()`)
				want := ErrTransactionInfrastructure
				if failure == "balance zero rows" {
					want = ErrTransactionConflict
				}
				if err := repo.finalizeTransaction(ref, restore); !errors.Is(err, want) {
					t.Fatalf("expected persistence failure: %v", err)
				}
				assertBalances(t, db, "SOURCE", "87.70", "12.30")
				assertStatus(t, db, ref, "PENDING")
			})
		}
	}
}

func TestPostgresFreezeInsertionFailure(t *testing.T) {
	for _, body := range []string{"RAISE EXCEPTION 'synthetic insert failure';", "RETURN NULL;"} {
		t.Run(body, func(t *testing.T) {
			repo, db := postgresRepository(t)
			seedAccount(t, db, "SOURCE", "100.00")
			execTestSQL(t, db, `CREATE FUNCTION fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN `+body+` END $$;
				CREATE TRIGGER fail_insert BEFORE INSERT ON intermesh_transactions FOR EACH ROW EXECUTE FUNCTION fail_insert()`)
			id, err := repo.FreezeFunds(dto.LedgerPayloadDTO{AccountID: "SOURCE", TargetAccount: "TEST", Amount: exactAmount(t, "12.30")})
			if !errors.Is(err, ErrTransactionInfrastructure) || id != "" {
				t.Fatalf("failed insert must not acknowledge freeze: %q %v", id, err)
			}
			assertBalances(t, db, "SOURCE", "100.00", "0.00")
			var count int
			if err := db.QueryRow(`SELECT count(*) FROM intermesh_transactions`).Scan(&count); err != nil || count != 0 {
				t.Fatalf("failed freeze inserted a transaction: %d %v", count, err)
			}
		})
	}
}

func TestPostgresExactAmounts(t *testing.T) {
	for _, value := range []string{"0.01", "12.30", "9999999999999.99"} {
		for _, restore := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/%t", value, restore), func(t *testing.T) {
				repo, db := postgresRepository(t)
				seedAccount(t, db, "SOURCE", value)
				ref := freezeReference(t, repo, "SOURCE", value)
				assertBalances(t, db, "SOURCE", "0.00", value)
				if err := repo.finalizeTransaction(ref, restore); err != nil {
					t.Fatal(err)
				}
				if restore {
					assertBalances(t, db, "SOURCE", value, "0.00")
				} else {
					assertBalances(t, db, "SOURCE", "0.00", "0.00")
				}
			})
		}
	}
}

func TestPostgresConcurrentFinalization(t *testing.T) {
	for _, operations := range [][2]bool{{false, true}, {false, false}, {true, true}} {
		for iteration := 0; iteration < 8; iteration++ {
			t.Run(fmt.Sprintf("%v/%d", operations, iteration), func(t *testing.T) {
				repo, db := postgresRepository(t)
				seedAccount(t, db, "SOURCE", "100.00")
				ref := freezeReference(t, repo, "SOURCE", "12.30")
				start := make(chan struct{})
				var wg sync.WaitGroup
				var outcomes [2]error
				for i := range outcomes {
					wg.Add(1)
					go func(i int) {
						defer wg.Done()
						<-start
						outcomes[i] = repo.finalizeTransaction(ref, operations[i])
					}(i)
				}
				close(start)
				wg.Wait()
				winner := -1
				if outcomes[0] == nil && errors.Is(outcomes[1], ErrTransactionConflict) {
					winner = 0
				}
				if outcomes[1] == nil && errors.Is(outcomes[0], ErrTransactionConflict) {
					winner = 1
				}
				if winner < 0 {
					t.Fatalf("exactly one finalization must win: %v", outcomes)
				}
				if operations[winner] {
					assertBalances(t, db, "SOURCE", "100.00", "0.00")
					assertStatus(t, db, ref, "FAILED")
				} else {
					assertBalances(t, db, "SOURCE", "87.70", "0.00")
					assertStatus(t, db, ref, "APPROVED")
				}
			})
		}
	}
}

func TestPostgresConcurrentIndependentTransactions(t *testing.T) {
	repo, db := postgresRepository(t)
	seedAccount(t, db, "SOURCE", "100.00")
	a := freezeReference(t, repo, "SOURCE", "12.30")
	b := freezeReference(t, repo, "SOURCE", "0.01")
	start := make(chan struct{})
	results := make(chan error, 2)
	go func() { <-start; _, err := repo.CommitReferencedTransaction(a); results <- err }()
	go func() { <-start; results <- repo.RollbackReferencedTransaction(b) }()
	close(start)
	for i := 0; i < 2; i++ {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	assertBalances(t, db, "SOURCE", "87.70", "0.00")
	assertStatus(t, db, a, "APPROVED")
	assertStatus(t, db, b, "FAILED")
}

func TestPostgresInsufficientFrozenBalance(t *testing.T) {
	for _, restore := range []bool{false, true} {
		t.Run(fmt.Sprint(restore), func(t *testing.T) {
			repo, db := postgresRepository(t)
			seedAccount(t, db, "SOURCE", "100.00")
			ref := freezeReference(t, repo, "SOURCE", "12.30")
			execTestSQL(t, db, `UPDATE intermesh_accounts SET frozen_balance=0 WHERE account_id='SOURCE'`)
			if err := repo.finalizeTransaction(ref, restore); !errors.Is(err, ErrTransactionConflict) {
				t.Fatal(err)
			}
			assertBalances(t, db, "SOURCE", "87.70", "0.00")
			assertStatus(t, db, ref, "PENDING")
		})
	}
}

func TestPostgresLegacyTransactionID(t *testing.T) {
	repo, db := postgresRepository(t)
	seedAccount(t, db, "SOURCE", "100.00")
	execTestSQL(t, db, `UPDATE intermesh_accounts SET balance=87.70,frozen_balance=12.30 WHERE account_id='SOURCE';
		INSERT INTO intermesh_transactions (transaction_id,source_account_id,target_iban,amount,status)
		VALUES ('TX-IM-12345678','SOURCE','TEST',12.30,'PENDING')`)
	ref := dto.TransactionReference{TransactionID: "TX-IM-12345678", AccountID: "SOURCE", Amount: exactAmount(t, "12.3000")}
	if _, err := repo.CommitReferencedTransaction(ref); err != nil {
		t.Fatal(err)
	}
	assertBalances(t, db, "SOURCE", "87.70", "0.00")
	assertStatus(t, db, ref, "APPROVED")
}
