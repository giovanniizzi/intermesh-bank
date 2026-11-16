package repository

import (
	"context"
	"errors"
	"intermesh-ledger/internal/dto"
	"testing"
	"time"
)

func TestTransferRecoveryValidationBeforeSQL(t *testing.T) {
	repo := NewAccountRepository(nil)
	if result, err := repo.GetTransferRequest(context.Background(), admissionIdentity(), "invalid"); !errors.Is(err, ErrInvalidTransferInput) || result != (dto.TransferAdmissionResult{}) {
		t.Fatalf("invalid UUID reached SQL: %+v %v", result, err)
	}
	if result, err := repo.GetTransferRequest(context.Background(), dto.VerifiedTransferIdentity{}, admissionIntent(t, 1).RequestID); !errors.Is(err, ErrTransferUnauthorized) || result != (dto.TransferAdmissionResult{}) {
		t.Fatalf("invalid identity reached SQL: %+v %v", result, err)
	}
}

func TestPostgresTransferRecoveryInFlightVisibility(t *testing.T) {
	repo, db := postgresRepository(t)
	seedAccount(t, db, "SOURCE", "100.00")
	identity, intent := admissionIdentity(), admissionIntent(t, 1)
	writer, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback()
	if _, err := writer.Exec(`UPDATE intermesh_accounts SET balance=87.70,frozen_balance=12.30 WHERE account_id='SOURCE'`); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Exec(`INSERT INTO intermesh_transfer_requests
		(transfer_request_id,issuer,subject,source_account_id,target_iban,amount,
		allow_duplicate_pending_transfer,admission_status)
		VALUES ($1,$2,$3,'SOURCE',$4,12.30,false,'ADMITTED')`,
		string(intent.RequestID), identity.Issuer, identity.Subject, intent.Destination); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Exec(`INSERT INTO intermesh_transactions
		(transaction_id,source_account_id,target_iban,amount,status,transfer_request_id)
		VALUES ('TX-IM-00000000-0000-4000-8000-000000000001','SOURCE',$1,12.30,'PENDING',$2)`,
		intent.Destination, string(intent.RequestID)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if result, err := repo.GetTransferRequest(ctx, identity, intent.RequestID); !errors.Is(err, ErrTransferRequestNotFound) || result != (dto.TransferAdmissionResult{}) {
		t.Fatalf("in-flight row should be invisible without waiting for its write lock: %+v %v", result, err)
	}
	if err := writer.Commit(); err != nil {
		t.Fatal(err)
	}
	before := admissionSnapshot(t, db)
	result, err := repo.GetTransferRequest(context.Background(), identity, intent.RequestID)
	if err != nil || result.Decision != dto.AdmissionAdmitted || result.TransactionState != "PENDING" ||
		result.NewTransactionCreated || result.MatchingPendingCount != 1 {
		t.Fatalf("404 did not exclude a later commit: %+v %v", result, err)
	}
	assertAdmissionUnchanged(t, db, before)
}

func TestPostgresTransferRecoveryInconsistentAdmission(t *testing.T) {
	repo, db := postgresRepository(t)
	seedAccount(t, db, "SOURCE", "100.00")
	identity, intent := admissionIdentity(), admissionIntent(t, 1)
	execTestSQL(t, db, `INSERT INTO intermesh_transfer_requests
		(transfer_request_id,issuer,subject,source_account_id,target_iban,amount,
		allow_duplicate_pending_transfer,admission_status)
		VALUES ($1,$2,$3,'SOURCE',$4,12.30,false,'ADMITTED')`,
		string(intent.RequestID), identity.Issuer, identity.Subject, intent.Destination)
	before := admissionSnapshot(t, db)
	if result, err := repo.GetTransferRequest(context.Background(), identity, intent.RequestID); !errors.Is(err, ErrTransferInfrastructure) || errors.Is(err, ErrTransferRequestNotFound) || result != (dto.TransferAdmissionResult{}) {
		t.Fatalf("inconsistent admission became not-found or success: %+v %v", result, err)
	}
	assertAdmissionUnchanged(t, db, before)
}
