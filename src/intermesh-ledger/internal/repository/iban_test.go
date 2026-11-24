package repository

import (
	"intermesh-ledger/internal/dto"
	"intermesh-ledger/internal/iban"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func ibanSQL(t *testing.T, name string) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	content, err := os.ReadFile(filepath.Join(filepath.Dir(file), "../../../../applications/prerequisites/dependencies/postgresql", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}

func correctedIBAN(t *testing.T, country string, serial int64) string {
	t.Helper()
	value, err := iban.Demo(country, serial)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func seedIBANAccounts(t *testing.T, repo *AccountRepository) {
	t.Helper()
	_, inserts, found := strings.Cut(ibanSQL(t, "001.sql"), "INSERT INTO intermesh_accounts")
	if !found {
		t.Fatal("seed boundary missing")
	}
	inserts = "INSERT INTO intermesh_accounts" + inserts
	execTestSQL(t, repo.db, inserts)
}

func TestDemoIBANSeeds(t *testing.T) {
	rows := regexp.MustCompile(`VALUES \('([^']+)', '([^']+)', '([^']+)', '([^']+)', ([0-9.]+), ([0-9.]+)\)`).FindAllStringSubmatch(ibanSQL(t, "001.sql"), -1)
	want := [][]string{
		{"ACC-1001", "mario.rossi", "IT29B0306905000000100001001", "Mario Rossi", "10000.00", "0.00"},
		{"ACC-2002", "john.doe", "DE72030690500100002002", "John Doe", "500.00", "0.00"},
		{"ACC-3003", "giovanni.izzi", "IT40K0306905000000100003003", "Giovanni Luca Izzi", "100.00", "0.00"},
	}
	if len(rows) != len(want) {
		t.Fatal("unexpected seed accounts")
	}
	for i, row := range rows {
		if !reflect.DeepEqual(row[1:], want[i]) || !iban.ValidDemo(row[3]) {
			t.Fatalf("seed identity, balance or IBAN mismatch for %s", row[1])
		}
	}
}

func TestPostgresAccountCreationIBAN(t *testing.T) {
	repo, db := postgresRepository(t)
	seedIBANAccounts(t, repo)
	account, err := repo.CreateAccount(dto.AccountCreationPayloadDTO{UserID: "synthetic-owner", HolderName: "Synthetic Owner", InitialDeposit: exactAmount(t, "0")})
	if err != nil ||
		account.AccountID != "ACC-4000" || account.IBAN != correctedIBAN(t, "IT", 4000) || account.Balance != 0 {
		t.Fatalf("unexpected account creation: %v", err)
	}
	stored, err := repo.GetBalance(account.AccountID)
	if err != nil || stored != account {
		t.Fatal("stored and returned accounts differ")
	}
	var wg sync.WaitGroup
	created := make(chan dto.AccountDTO, 20)
	errors := make(chan error, 20)
	for range 20 {
		wg.Go(func() {
			value, err := repo.CreateAccount(dto.AccountCreationPayloadDTO{UserID: "synthetic-owner", HolderName: "Synthetic Owner", InitialDeposit: exactAmount(t, "12.30")})
			if err != nil {
				errors <- err
				return
			}
			created <- value
		})
	}
	wg.Wait()
	close(created)
	close(errors)
	for err := range errors {
		t.Fatal(err)
	}
	seen := map[string]bool{account.IBAN: true}
	for value := range created {
		if !iban.ValidDemo(value.IBAN) || seen[value.IBAN] || value.UserID != "synthetic-owner" || value.Balance != 12.30 {
			t.Fatal("concurrent creation changed identity, amount or IBAN uniqueness")
		}
		seen[value.IBAN] = true
	}
	if len(seen) != 21 {
		t.Fatal("missing created accounts")
	}
	// Reject exhausted identifiers instead of truncating or wrapping account digits.
	execTestSQL(t, db, `SELECT setval('intermesh_account_seq',999900000000,false)`)
	if _, err := repo.CreateAccount(dto.AccountCreationPayloadDTO{UserID: "synthetic-owner", InitialDeposit: exactAmount(t, "0")}); err == nil {
		t.Fatal("out-of-range generation succeeded")
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM intermesh_accounts").Scan(&count); err != nil || count != 24 {
		t.Fatal("failed generation inserted an account")
	}
}

func TestPostgresDemoInitialization(t *testing.T) {
	repo, db := postgresRepository(t)
	seedIBANAccounts(t, repo)
	var accounts, transactions, requests int
	if err := db.QueryRow(`SELECT
		(SELECT count(*) FROM intermesh_accounts),
		(SELECT count(*) FROM intermesh_transactions),
		(SELECT count(*) FROM intermesh_transfer_requests)`).Scan(&accounts, &transactions, &requests); err != nil {
		t.Fatal(err)
	}
	if accounts != 3 || transactions != 0 || requests != 0 {
		t.Fatal("expected three seeded accounts and empty transaction and request tables")
	}
	for _, seed := range []struct {
		id, owner, country string
		serial             int64
		balance            float64
	}{
		{"ACC-1001", "mario.rossi", "IT", 1001, 10000},
		{"ACC-2002", "john.doe", "DE", 2002, 500},
		{"ACC-3003", "giovanni.izzi", "IT", 3003, 100},
	} {
		account, err := repo.GetBalance(seed.id)
		if err != nil || account.AccountID != seed.id || account.UserID != seed.owner ||
			account.IBAN != correctedIBAN(t, seed.country, seed.serial) ||
			account.Balance != seed.balance || account.FrozenBalance != 0 {
			t.Fatalf("unexpected seed account: %s (%v)", seed.id, err)
		}
		history, err := repo.GetHistory(seed.id)
		if err != nil || history == nil || len(history) != 0 {
			t.Fatalf("expected empty history for %s (%v)", seed.id, err)
		}
	}
	var next int64
	var called bool
	if err := db.QueryRow(`SELECT last_value, is_called FROM intermesh_account_seq`).Scan(&next, &called); err != nil {
		t.Fatal(err)
	}
	if next != 4000 || called {
		t.Fatal("expected the next generated account to use sequence value 4000")
	}
}
