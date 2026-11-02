package repository

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"intermesh-ledger/internal/dto"
	"io"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/lib/pq"
)

func admissionIdentity() dto.VerifiedTransferIdentity {
	return dto.VerifiedTransferIdentity{Issuer: "https://issuer.example.invalid/realms/demo",
		Subject: "synthetic-subject", OwnerKey: "synthetic-user"}
}

func admissionIntent(t *testing.T, n int) dto.TransferIntent {
	t.Helper()
	return dto.TransferIntent{RequestID: dto.TransferRequestID(fmt.Sprintf("00000000-0000-4000-8000-%012x", n)),
		SourceAccountID: "SOURCE", Destination: "TEST-DESTINATION", Amount: exactAmount(t, "12.30")}
}

func admit(t *testing.T, repo *AccountRepository, intent dto.TransferIntent) dto.TransferAdmissionResult {
	t.Helper()
	result, err := repo.AdmitTransfer(context.Background(), admissionIdentity(), intent)
	if err != nil || result.Decision != dto.AdmissionAdmitted || !result.NewTransactionCreated || result.TransactionState != "PENDING" {
		t.Fatalf("expected new admission: result=%+v err=%v", result, err)
	}
	if len(result.TransactionID) != 42 || !strings.HasPrefix(result.TransactionID, "TX-IM-") {
		t.Fatalf("invalid financial transaction ID: %s", result.TransactionID)
	}
	return result
}

func rejectAdmission(t *testing.T, repo *AccountRepository, intent dto.TransferIntent,
	code dto.TransferRejectionCode, pending int) dto.TransferAdmissionResult {
	t.Helper()
	result, err := repo.AdmitTransfer(context.Background(), admissionIdentity(), intent)
	var rejected *AdmissionRejectedError
	if !errors.As(err, &rejected) || rejected.Code != code || result.Decision != dto.AdmissionRejected ||
		result.RejectionCode != code || result.NewTransactionCreated || result.TransactionID != "" ||
		result.TransactionState != "" || result.DuplicatePendingApproved || result.MatchingPendingCount != pending {
		t.Fatalf("expected %s: result=%+v err=%v", code, result, err)
	}
	var stored string
	if err := repo.db.QueryRow(`SELECT rejection_code FROM intermesh_transfer_requests
		WHERE transfer_request_id=$1`, string(intent.RequestID)).Scan(&stored); err != nil || stored != string(code) {
		t.Fatalf("rejection not persisted: code=%s err=%v", stored, err)
	}
	return result
}

func admissionSnapshot(t *testing.T, db *sql.DB) []string {
	t.Helper()
	var snapshot []string
	for _, query := range []string{
		`SELECT row_to_json(a)::text FROM (SELECT * FROM intermesh_accounts ORDER BY account_id) a`,
		`SELECT row_to_json(r)::text FROM (SELECT * FROM intermesh_transfer_requests ORDER BY transfer_request_id) r`,
		`SELECT row_to_json(t)::text FROM (SELECT * FROM intermesh_transactions ORDER BY transaction_id) t`,
	} {
		rows, err := db.Query(query)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var row string
			if err := rows.Scan(&row); err != nil {
				rows.Close()
				t.Fatal(err)
			}
			snapshot = append(snapshot, row)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	return snapshot
}

func assertAdmissionUnchanged(t *testing.T, db *sql.DB, before []string) {
	t.Helper()
	if after := admissionSnapshot(t, db); !reflect.DeepEqual(before, after) {
		t.Fatalf("unexpected persistence change: before=%v after=%v", before, after)
	}
}

func finalizeAdmission(t *testing.T, repo *AccountRepository, result dto.TransferAdmissionResult, restore bool) {
	t.Helper()
	ref := dto.TransactionReference{TransactionID: result.TransactionID, AccountID: "SOURCE", Amount: exactAmount(t, "12.30")}
	if restore {
		if err := repo.RollbackReferencedTransaction(ref); err != nil {
			t.Fatal(err)
		}
	} else if id, err := repo.CommitReferencedTransaction(ref); err != nil || id != ref.TransactionID {
		t.Fatalf("commit: id=%s err=%v", id, err)
	}
}

func TestAdmissionValidationBeforeSQL(t *testing.T) {
	valid := admissionIntent(t, 1)
	for _, tc := range []struct {
		name string
		edit func(*dto.TransferIntent)
	}{
		{"missing UUID", func(i *dto.TransferIntent) { i.RequestID = "" }},
		{"invalid UUID", func(i *dto.TransferIntent) { i.RequestID = "not-a-uuid" }},
		{"missing source", func(i *dto.TransferIntent) { i.SourceAccountID = "" }},
		{"long source", func(i *dto.TransferIntent) { i.SourceAccountID = strings.Repeat("s", 51) }},
		{"blank destination", func(i *dto.TransferIntent) { i.Destination = " \t" }},
		{"long destination", func(i *dto.TransferIntent) { i.Destination = strings.Repeat("d", 35) }},
		{"invalid UTF8", func(i *dto.TransferIntent) { i.Destination = string([]byte{0xff}) }},
		{"control destination", func(i *dto.TransferIntent) { i.Destination = "DEST\x00" }},
		{"missing amount", func(i *dto.TransferIntent) { i.Amount = dto.Amount{} }},
		{"zero amount", func(i *dto.TransferIntent) { i.Amount = exactAmount(t, "0") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			intent := valid
			tc.edit(&intent)
			result, err := NewAccountRepository(nil).AdmitTransfer(context.Background(), admissionIdentity(), intent)
			if !errors.Is(err, ErrInvalidTransferInput) || result != (dto.TransferAdmissionResult{}) {
				t.Fatalf("must reject before SQL: %+v %v", result, err)
			}
		})
	}
	for _, identity := range []dto.VerifiedTransferIdentity{
		{}, {Issuer: " ", Subject: "subject", OwnerKey: "owner"},
		{Issuer: "issuer", Subject: "\u2003", OwnerKey: "owner"},
		{Issuer: strings.Repeat("i", 2049), Subject: "subject", OwnerKey: "owner"},
		{Issuer: "issuer", Subject: strings.Repeat("s", 256), OwnerKey: "owner"},
		{Issuer: "issuer", Subject: "subject", OwnerKey: ""},
		{Issuer: "issuer", Subject: "subject", OwnerKey: strings.Repeat("o", 51)},
	} {
		if result, err := NewAccountRepository(nil).AdmitTransfer(context.Background(), identity, valid); !errors.Is(err, ErrTransferUnauthorized) || result != (dto.TransferAdmissionResult{}) {
			t.Fatalf("invalid identity must reject before SQL: %+v %v", result, err)
		}
	}
}

func TestPostgresAdmissionCycleLifecycle(t *testing.T) {
	for _, first := range []string{"duplicate-commit", "duplicate-rollback", "ordinary-commit", "ordinary-rollback"} {
		t.Run(first, func(t *testing.T) {
			repo, db := postgresRepository(t)
			seedAccount(t, db, "SOURCE", "100.00")
			ordinary := admit(t, repo, admissionIntent(t, 1))
			if ordinary.MatchingPendingCount != 1 || ordinary.DuplicatePendingApproved {
				t.Fatalf("incorrect ordinary result: %+v", ordinary)
			}
			rejectAdmission(t, repo, admissionIntent(t, 2), dto.DuplicateApprovalRequired, 1)
			approvedIntent := admissionIntent(t, 3)
			approvedIntent.AllowDuplicatePendingTransfer = true
			duplicate := admit(t, repo, approvedIntent)
			if !duplicate.DuplicatePendingApproved || duplicate.MatchingPendingCount != 2 {
				t.Fatalf("incorrect duplicate result: %+v", duplicate)
			}
			var parent string
			if err := db.QueryRow(`SELECT ordinary_transaction_id FROM intermesh_transactions
				WHERE transaction_id=$1`, duplicate.TransactionID).Scan(&parent); err != nil || parent != ordinary.TransactionID {
				t.Fatalf("incorrect parent: %s %v", parent, err)
			}
			assertBalances(t, db, "SOURCE", "75.40", "24.60")
			third := admissionIntent(t, 4)
			third.AllowDuplicatePendingTransfer = true
			rejectAdmission(t, repo, third, dto.DuplicateExceptionUsed, 2)
			rejectAdmission(t, repo, admissionIntent(t, 5), dto.DuplicateExceptionUsed, 2)
			if strings.HasPrefix(first, "duplicate") {
				finalizeAdmission(t, repo, duplicate, strings.HasSuffix(first, "rollback"))
				retry := admissionIntent(t, 6)
				retry.AllowDuplicatePendingTransfer = true
				rejectAdmission(t, repo, retry, dto.DuplicateExceptionUsed, 1)
				finalizeAdmission(t, repo, ordinary, true)
			} else {
				finalizeAdmission(t, repo, ordinary, strings.HasSuffix(first, "rollback"))
				rejectAdmission(t, repo, admissionIntent(t, 6), dto.ActiveCycleBlocked, 1)
				noEligible := admissionIntent(t, 7)
				noEligible.AllowDuplicatePendingTransfer = true
				rejectAdmission(t, repo, noEligible, dto.ActiveCycleBlocked, 1)
				finalizeAdmission(t, repo, duplicate, true)
			}
			before := admissionSnapshot(t, db)
			replayed, err := repo.AdmitTransfer(context.Background(), admissionIdentity(), approvedIntent)
			if err != nil || replayed.NewTransactionCreated || !replayed.DuplicatePendingApproved ||
				replayed.TransactionID != duplicate.TransactionID || replayed.TransactionState == "PENDING" || replayed.MatchingPendingCount != 0 {
				t.Fatalf("terminal duplicate replay: %+v %v", replayed, err)
			}
			assertAdmissionUnchanged(t, db, before)
			noEligible := admissionIntent(t, 8)
			noEligible.AllowDuplicatePendingTransfer = true
			rejectAdmission(t, repo, noEligible, dto.DuplicateApprovalNotEligible, 0)
			next := admit(t, repo, admissionIntent(t, 9))
			if next.DuplicatePendingApproved || next.TransactionID == ordinary.TransactionID {
				t.Fatal("new cycle must use a new ordinary transaction")
			}
			nextApproved := admissionIntent(t, 10)
			nextApproved.AllowDuplicatePendingTransfer = true
			nextChild := admit(t, repo, nextApproved)
			if err := db.QueryRow(`SELECT ordinary_transaction_id FROM intermesh_transactions
				WHERE transaction_id=$1`, nextChild.TransactionID).Scan(&parent); err != nil || parent != next.TransactionID {
				t.Fatalf("new cycle must have its own exception: parent=%s err=%v", parent, err)
			}
		})
	}
}

func TestPostgresAdmissionReplays(t *testing.T) {
	repo, db := postgresRepository(t)
	seedAccount(t, db, "SOURCE", "100.00")
	intent := admissionIntent(t, 0xabcdef)
	intent.RequestID = dto.TransferRequestID(strings.ToUpper(string(intent.RequestID)))
	original := admit(t, repo, intent)
	for _, state := range []string{"PENDING", "APPROVED"} {
		if state == "APPROVED" {
			finalizeAdmission(t, repo, original, false)
		}
		before := admissionSnapshot(t, db)
		intent.Amount = exactAmount(t, "12.3000")
		result, err := repo.AdmitTransfer(context.Background(), admissionIdentity(), intent)
		if err != nil || result.NewTransactionCreated || result.TransactionID != original.TransactionID ||
			result.TransactionState != state || result.RequestID != original.RequestID {
			t.Fatalf("incorrect replay: %+v %v", result, err)
		}
		assertAdmissionUnchanged(t, db, before)
	}
	other := admissionIntent(t, 2)
	originalRejection := rejectAdmission(t, repo, dto.TransferIntent{
		RequestID: other.RequestID, SourceAccountID: other.SourceAccountID,
		Destination: other.Destination, Amount: other.Amount, AllowDuplicatePendingTransfer: true,
	}, dto.DuplicateApprovalNotEligible, 0)
	admit(t, repo, admissionIntent(t, 3))
	other.AllowDuplicatePendingTransfer = true
	before := admissionSnapshot(t, db)
	replayed := rejectAdmission(t, repo, other, originalRejection.RejectionCode, 1)
	if replayed.NewTransactionCreated {
		t.Fatal("rejection replay created a transaction")
	}
	assertAdmissionUnchanged(t, db, before)
}

func TestPostgresAdmissionRejectionSurvivesCycleClosure(t *testing.T) {
	repo, db := postgresRepository(t)
	seedAccount(t, db, "SOURCE", "100.00")
	ordinary := admit(t, repo, admissionIntent(t, 1))
	rejected := admissionIntent(t, 2)
	rejectAdmission(t, repo, rejected, dto.DuplicateApprovalRequired, 1)
	finalizeAdmission(t, repo, ordinary, true)
	before := admissionSnapshot(t, db)
	rejectAdmission(t, repo, rejected, dto.DuplicateApprovalRequired, 0)
	assertAdmissionUnchanged(t, db, before)
	admit(t, repo, admissionIntent(t, 3))
}

func TestPostgresAdmissionIdentityAndIntentIsolation(t *testing.T) {
	repo, db := postgresRepository(t)
	seedAccount(t, db, "SOURCE", "100.00")
	seedAccount(t, db, "OTHER", "100.00")
	intent := admissionIntent(t, 1)
	admit(t, repo, intent)
	for _, tc := range []struct {
		name string
		edit func(*dto.TransferIntent, *dto.VerifiedTransferIdentity)
		want error
	}{
		{"changed source", func(i *dto.TransferIntent, _ *dto.VerifiedTransferIdentity) { i.SourceAccountID = "OTHER" }, ErrTransferIntentConflict},
		{"changed destination", func(i *dto.TransferIntent, _ *dto.VerifiedTransferIdentity) { i.Destination = "OTHER-DESTINATION" }, ErrTransferIntentConflict},
		{"changed amount", func(i *dto.TransferIntent, _ *dto.VerifiedTransferIdentity) { i.Amount = exactAmount(t, "12.31") }, ErrTransferIntentConflict},
		{"changed permission", func(i *dto.TransferIntent, _ *dto.VerifiedTransferIdentity) { i.AllowDuplicatePendingTransfer = true }, ErrTransferIntentConflict},
		{"other subject", func(_ *dto.TransferIntent, i *dto.VerifiedTransferIdentity) { i.Subject = "other-subject" }, ErrTransferUnauthorized},
		{"other issuer", func(_ *dto.TransferIntent, i *dto.VerifiedTransferIdentity) {
			i.Issuer = "https://other.example.invalid"
		}, ErrTransferUnauthorized},
		{"wrong owner", func(_ *dto.TransferIntent, i *dto.VerifiedTransferIdentity) { i.OwnerKey = "other-owner" }, ErrTransferUnauthorized},
		{"missing account", func(i *dto.TransferIntent, _ *dto.VerifiedTransferIdentity) { i.SourceAccountID = "MISSING" }, ErrTransferAccountNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			copy, identity := intent, admissionIdentity()
			tc.edit(&copy, &identity)
			before := admissionSnapshot(t, db)
			result, err := repo.AdmitTransfer(context.Background(), identity, copy)
			if !errors.Is(err, tc.want) || result != (dto.TransferAdmissionResult{}) {
				t.Fatalf("expected sanitized rejection: result=%+v err=%v", result, err)
			}
			assertAdmissionUnchanged(t, db, before)
		})
	}
	// Current ownership is checked again, even for an otherwise exact replay.
	execTestSQL(t, db, `UPDATE intermesh_accounts SET user_id='new-owner' WHERE account_id='SOURCE'`)
	before := admissionSnapshot(t, db)
	if result, err := repo.AdmitTransfer(context.Background(), admissionIdentity(), intent); !errors.Is(err, ErrTransferUnauthorized) || result != (dto.TransferAdmissionResult{}) {
		t.Fatalf("old owner replay: %+v %v", result, err)
	}
	assertAdmissionUnchanged(t, db, before)
}

func TestPostgresAdmissionExactAmountsAndLiquidity(t *testing.T) {
	for _, value := range []string{"0.01", "12.30", "9999999999999.99"} {
		t.Run(value, func(t *testing.T) {
			repo, db := postgresRepository(t)
			seedAccount(t, db, "SOURCE", value)
			intent := admissionIntent(t, 1)
			intent.Amount = exactAmount(t, value)
			result := admit(t, repo, intent)
			assertBalances(t, db, "SOURCE", "0.00", value)
			before := admissionSnapshot(t, db)
			if replay, err := repo.AdmitTransfer(context.Background(), admissionIdentity(), intent); err != nil || replay.NewTransactionCreated || replay.TransactionID != result.TransactionID {
				t.Fatalf("replay must precede liquidity checks: %+v %v", replay, err)
			}
			assertAdmissionUnchanged(t, db, before)
			newIntent := admissionIntent(t, 2)
			newIntent.Destination = "ANOTHER-DESTINATION"
			newIntent.Amount = exactAmount(t, "0.01")
			rejectAdmission(t, repo, newIntent, dto.InsufficientFunds, 0)
			assertBalances(t, db, "SOURCE", "0.00", value)
		})
	}
}

func TestPostgresAdmissionDistinctIntents(t *testing.T) {
	repo, db := postgresRepository(t)
	seedAccount(t, db, "SOURCE", "100.00")
	seedAccount(t, db, "OTHER", "100.00")
	original := admissionIntent(t, 1)
	admit(t, repo, original)
	for n, edit := range []func(*dto.TransferIntent){
		func(i *dto.TransferIntent) { i.Destination = "test-destination" },
		func(i *dto.TransferIntent) { i.Destination = "TEST-DESTINATION " },
		func(i *dto.TransferIntent) { i.Amount = exactAmount(t, "12.31") },
		func(i *dto.TransferIntent) { i.SourceAccountID = "OTHER" },
	} {
		intent := admissionIntent(t, n+2)
		edit(&intent)
		result := admit(t, repo, intent)
		if result.DuplicatePendingApproved || result.MatchingPendingCount != 1 {
			t.Fatalf("distinct intent joined another cycle: %+v", result)
		}
	}
	assertBalances(t, db, "SOURCE", "50.79", "49.21")
	assertBalances(t, db, "OTHER", "87.70", "12.30")
	before := admissionSnapshot(t, db)
	if replay, err := repo.AdmitTransfer(context.Background(), admissionIdentity(), original); err != nil || replay.MatchingPendingCount != 1 || replay.NewTransactionCreated {
		t.Fatalf("pending count must be scoped to the exact intent: %+v %v", replay, err)
	}
	assertAdmissionUnchanged(t, db, before)
}

func TestPostgresAdmissionLegacyCycles(t *testing.T) {
	for _, roots := range []int{1, 2, 3} {
		t.Run(fmt.Sprint(roots), func(t *testing.T) {
			repo, db := postgresRepository(t)
			seedAccount(t, db, "SOURCE", "100.00")
			for i := 0; i < roots; i++ {
				freezeReference(t, repo, "SOURCE", "12.30")
			}
			intent := admissionIntent(t, 1)
			intent.AllowDuplicatePendingTransfer = true
			if roots == 1 {
				if result := admit(t, repo, intent); !result.DuplicatePendingApproved {
					t.Fatal("legacy ordinary must retain the approved child association")
				}
			} else {
				rejectAdmission(t, repo, intent, dto.ActiveCycleConflict, roots)
				rejectAdmission(t, repo, admissionIntent(t, 2), dto.ActiveCycleConflict, roots)
			}
		})
	}
}

func TestPostgresAdmissionConcurrentRequests(t *testing.T) {
	for _, mode := range []string{"ordinary", "approved", "same UUID", "cross-account UUID", "cross-subject UUID"} {
		t.Run(mode, func(t *testing.T) {
			repo, db := postgresRepository(t)
			seedAccount(t, db, "SOURCE", "100.00")
			intents := []dto.TransferIntent{admissionIntent(t, 2), admissionIntent(t, 3)}
			identities := []dto.VerifiedTransferIdentity{admissionIdentity(), admissionIdentity()}
			if mode == "approved" {
				admit(t, repo, admissionIntent(t, 1))
				intents[0].AllowDuplicatePendingTransfer, intents[1].AllowDuplicatePendingTransfer = true, true
			}
			if strings.Contains(mode, "UUID") {
				intents[1].RequestID = intents[0].RequestID
			}
			if mode == "cross-account UUID" {
				seedAccount(t, db, "OTHER", "100.00")
				intents[1].SourceAccountID = "OTHER"
			}
			if mode == "cross-subject UUID" {
				identities[1].Subject = "another-subject"
			}
			start := make(chan struct{})
			var ready, done sync.WaitGroup
			ready.Add(2)
			done.Add(2)
			results := make([]dto.TransferAdmissionResult, 2)
			errs := make([]error, 2)
			for i := 0; i < 2; i++ {
				go func(i int) {
					defer done.Done()
					independent := NewAccountRepository(db)
					ready.Done()
					<-start
					results[i], errs[i] = independent.AdmitTransfer(context.Background(), identities[i], intents[i])
				}(i)
			}
			ready.Wait()
			close(start)
			done.Wait()
			created := 0
			for i := range results {
				if results[i].NewTransactionCreated {
					created++
				}
			}
			if created != 1 {
				t.Fatalf("exactly one new transaction: results=%+v errors=%v", results, errs)
			}
			for _, err := range errs {
				if err == nil {
					continue
				}
				var rejected *AdmissionRejectedError
				switch mode {
				case "ordinary":
					if !errors.As(err, &rejected) || rejected.Code != dto.DuplicateApprovalRequired {
						t.Fatal(err)
					}
				case "approved":
					if !errors.As(err, &rejected) || rejected.Code != dto.DuplicateExceptionUsed {
						t.Fatal(err)
					}
				case "cross-account UUID":
					if !errors.Is(err, ErrTransferIntentConflict) {
						t.Fatal(err)
					}
				case "cross-subject UUID":
					if !errors.Is(err, ErrTransferUnauthorized) {
						t.Fatal(err)
					}
				default:
					t.Fatal(err)
				}
			}
			if mode == "same UUID" && results[0].TransactionID != results[1].TransactionID {
				t.Fatal("same UUID returned different transaction identities")
			}
			var count int
			if err := db.QueryRow(`SELECT count(*) FROM intermesh_transactions`).Scan(&count); err != nil {
				t.Fatal(err)
			}
			want := 1
			if mode == "approved" {
				want = 2
			}
			if count != want {
				t.Fatalf("transaction count=%d want=%d", count, want)
			}
		})
	}
}

func TestPostgresAdmissionAtomicFailures(t *testing.T) {
	for _, tc := range []struct{ name, timing, event, table, body string }{
		{"registration error", "BEFORE", "INSERT", "intermesh_transfer_requests", "RAISE EXCEPTION 'synthetic private payload';"},
		{"registration zero rows", "BEFORE", "INSERT", "intermesh_transfer_requests", "RETURN NULL;"},
		{"balance error after registration", "BEFORE", "UPDATE", "intermesh_accounts", "RAISE EXCEPTION 'synthetic private payload';"},
		{"balance zero rows", "BEFORE", "UPDATE", "intermesh_accounts", "RETURN NULL;"},
		{"insert error after balance", "BEFORE", "INSERT", "intermesh_transactions", "RAISE EXCEPTION 'synthetic private payload';"},
		{"insert zero rows after balance", "BEFORE", "INSERT", "intermesh_transactions", "RETURN NULL;"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo, db := postgresRepository(t)
			seedAccount(t, db, "SOURCE", "100.00")
			execTestSQL(t, db, `CREATE FUNCTION fail_admission() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN `+tc.body+` END $$;
				CREATE TRIGGER fail_admission `+tc.timing+` `+tc.event+` ON `+tc.table+` FOR EACH ROW EXECUTE FUNCTION fail_admission()`)
			before := admissionSnapshot(t, db)
			result, err := repo.AdmitTransfer(context.Background(), admissionIdentity(), admissionIntent(t, 1))
			if !errors.Is(err, ErrTransferInfrastructure) || errors.Is(err, ErrTransferCommitUnknown) ||
				result != (dto.TransferAdmissionResult{}) || strings.Contains(err.Error(), "synthetic private") {
				t.Fatalf("incorrect infrastructure result: %+v %v", result, err)
			}
			assertAdmissionUnchanged(t, db, before)
		})
	}
}

func TestPostgresAdmissionCommitFailureRollsBack(t *testing.T) {
	for _, rejected := range []bool{false, true} {
		t.Run(fmt.Sprintf("domain-rejection=%t", rejected), func(t *testing.T) {
			repo, db := postgresRepository(t)
			seedAccount(t, db, "SOURCE", "100.00")
			if rejected {
				admit(t, repo, admissionIntent(t, 1))
			}
			execTestSQL(t, db, `CREATE FUNCTION reject_admission_commit() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='synthetic private commit payload'; END $$;
				CREATE CONSTRAINT TRIGGER reject_admission_commit AFTER INSERT ON intermesh_transfer_requests
				DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_admission_commit()`)
			before := admissionSnapshot(t, db)
			result, err := repo.AdmitTransfer(context.Background(), admissionIdentity(), admissionIntent(t, 2))
			if !errors.Is(err, ErrTransferInfrastructure) || errors.Is(err, ErrTransferCommitUnknown) ||
				result != (dto.TransferAdmissionResult{}) || strings.Contains(err.Error(), "private") {
				t.Fatalf("commit failure returned an unpersisted decision: %+v %v", result, err)
			}
			assertAdmissionUnchanged(t, db, before)
		})
	}
}

func TestPostgresAdmissionRejectsInconsistentRegistry(t *testing.T) {
	for _, admitted := range []bool{true, false} {
		t.Run(fmt.Sprint(admitted), func(t *testing.T) {
			repo, db := postgresRepository(t)
			seedAccount(t, db, "SOURCE", "100.00")
			intent := admissionIntent(t, 1)
			if admitted {
				execTestSQL(t, db, `INSERT INTO intermesh_transfer_requests
					(transfer_request_id,issuer,subject,source_account_id,target_iban,amount,
					allow_duplicate_pending_transfer,admission_status) VALUES ($1,$2,$3,'SOURCE',$4,12.30,false,'ADMITTED')`,
					string(intent.RequestID), admissionIdentity().Issuer, admissionIdentity().Subject, intent.Destination)
			} else {
				rejectAdmission(t, repo, dto.TransferIntent{RequestID: intent.RequestID, SourceAccountID: "SOURCE",
					Destination: intent.Destination, Amount: intent.Amount, AllowDuplicatePendingTransfer: true},
					dto.DuplicateApprovalNotEligible, 0)
				intent.AllowDuplicatePendingTransfer = true
				execTestSQL(t, db, `INSERT INTO intermesh_transactions
					(transaction_id,source_account_id,target_iban,amount,status,transfer_request_id)
					VALUES ('TX-IM-inconsistent','SOURCE',$1,12.30,'PENDING',$2)`, intent.Destination, string(intent.RequestID))
			}
			before := admissionSnapshot(t, db)
			result, err := repo.AdmitTransfer(context.Background(), admissionIdentity(), intent)
			if !errors.Is(err, ErrTransferInfrastructure) || result != (dto.TransferAdmissionResult{}) {
				t.Fatalf("inconsistent registry must fail closed: %+v %v", result, err)
			}
			assertAdmissionUnchanged(t, db, before)
		})
	}
}

// The underlying PostgreSQL COMMIT succeeds, but its acknowledgment is lost.
type lostAdmissionCommitConnector struct{ driver.Connector }
type lostAdmissionCommitConn struct{ driver.Conn }
type lostAdmissionCommitTx struct{ driver.Tx }

func (c lostAdmissionCommitConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := c.Connector.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return lostAdmissionCommitConn{conn}, nil
}

func (c lostAdmissionCommitConn) BeginTx(ctx context.Context, options driver.TxOptions) (driver.Tx, error) {
	tx, err := c.Conn.(driver.ConnBeginTx).BeginTx(ctx, options)
	if err != nil {
		return nil, err
	}
	return lostAdmissionCommitTx{tx}, nil
}

func (tx lostAdmissionCommitTx) Commit() error {
	if err := tx.Tx.Commit(); err != nil {
		return err
	}
	return io.ErrUnexpectedEOF
}

func TestPostgresAdmissionLostCommitAcknowledgment(t *testing.T) {
	repo, db := postgresRepository(t)
	seedAccount(t, db, "SOURCE", "100.00")
	var schema string
	if err := db.QueryRow(`SELECT current_schema()`).Scan(&schema); err != nil {
		t.Fatal(err)
	}
	connector, err := pq.NewConnector(fmt.Sprintf("host=%s port=55432 user=fin02_test dbname=postgres sslmode=disable search_path=%s",
		os.Getenv("INTERMESH_TEST_POSTGRES_SOCKET_DIR"), schema))
	if err != nil {
		t.Fatal(err)
	}
	lostDB := sql.OpenDB(lostAdmissionCommitConnector{connector})
	t.Cleanup(func() { lostDB.Close() })
	intent := admissionIntent(t, 1)
	result, err := NewAccountRepository(lostDB).AdmitTransfer(context.Background(), admissionIdentity(), intent)
	if !errors.Is(err, ErrTransferCommitUnknown) || !errors.Is(err, ErrTransferInfrastructure) || result != (dto.TransferAdmissionResult{}) {
		t.Fatalf("lost acknowledgment must not return a successful result: %+v %v", result, err)
	}
	assertBalances(t, db, "SOURCE", "87.70", "12.30")
	before := admissionSnapshot(t, db)
	replay, err := repo.AdmitTransfer(context.Background(), admissionIdentity(), intent)
	if err != nil || replay.NewTransactionCreated || replay.TransactionState != "PENDING" || replay.TransactionID == "" {
		t.Fatalf("replay must resolve the already committed request: %+v %v", replay, err)
	}
	assertAdmissionUnchanged(t, db, before)
}

func TestAdmissionCommitErrorClassification(t *testing.T) {
	for _, tc := range []struct {
		cause   error
		unknown bool
	}{
		{io.ErrUnexpectedEOF, true},
		{context.DeadlineExceeded, true},
		{&pq.Error{Code: "40003", Message: "private synthetic payload"}, true},
		{&pq.Error{Code: "23514", Message: "private synthetic payload"}, false},
		{&pq.Error{Code: "40001", Message: "private synthetic payload"}, false},
	} {
		err := transferCommitError(tc.cause)
		if !errors.Is(err, ErrTransferInfrastructure) || errors.Is(err, ErrTransferCommitUnknown) != tc.unknown ||
			!errors.Is(err, tc.cause) || strings.Contains(err.Error(), "private") {
			t.Fatalf("incorrect sanitized commit classification: %v", err)
		}
	}
}
