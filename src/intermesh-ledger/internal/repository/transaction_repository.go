package repository

import (
	"database/sql"
	"errors"
	"fmt"
	"intermesh-ledger/internal/dto"
)

var (
	ErrInvalidTransactionReference = errors.New("invalid transaction reference")
	ErrTransactionNotFound         = errors.New("transaction reference not found")
	ErrTransactionConflict         = errors.New("transaction state or amount conflict")
	ErrTransactionInfrastructure   = errors.New("transaction persistence failure")
)

func infrastructureError(operation string, cause error) error {
	if cause != nil {
		return fmt.Errorf("%w: %s: %w", ErrTransactionInfrastructure, operation, cause)
	}
	return fmt.Errorf("%w: %s", ErrTransactionInfrastructure, operation)
}

func requireOneRow(result sql.Result) error {
	count, err := result.RowsAffected()
	if err != nil || count != 1 {
		return infrastructureError("expected exactly one affected row", err)
	}
	return nil
}

func (r *AccountRepository) CommitReferencedTransaction(ref dto.TransactionReference) (string, error) {
	if err := r.finalizeTransaction(ref, false); err != nil {
		return "", err
	}
	return ref.TransactionID, nil
}

func (r *AccountRepository) RollbackReferencedTransaction(ref dto.TransactionReference) error {
	return r.finalizeTransaction(ref, true)
}

func (r *AccountRepository) finalizeTransaction(ref dto.TransactionReference, restore bool) error {
	if !ref.Valid() {
		return ErrInvalidTransactionReference
	}
	tx, err := r.db.Begin()
	if err != nil {
		return infrastructureError("begin", err)
	}
	defer tx.Rollback()

	// All finalizers lock account first, then transaction. Freeze's account
	// UPDATE takes the same first lock before inserting its transaction.
	var accountID string
	err = tx.QueryRow(`SELECT account_id FROM intermesh_accounts WHERE account_id = $1 FOR UPDATE`, ref.AccountID).Scan(&accountID)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrTransactionNotFound
	}
	if err != nil {
		return infrastructureError("lock account", err)
	}

	var status string
	var amountMatches bool
	err = tx.QueryRow(`
		SELECT status, amount = $3 AND amount > 0
		FROM intermesh_transactions
		WHERE transaction_id = $1 AND source_account_id = $2
		FOR UPDATE`, ref.TransactionID, ref.AccountID, ref.Amount).Scan(&status, &amountMatches)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrTransactionNotFound
	}
	if err != nil {
		return infrastructureError("lock transaction", err)
	}
	if status != "PENDING" || !amountMatches {
		return ErrTransactionConflict
	}

	// Only the locked, recorded NUMERIC amount participates in arithmetic.
	query := `UPDATE intermesh_accounts AS a
		SET frozen_balance = a.frozen_balance - t.amount
		FROM intermesh_transactions AS t
		WHERE a.account_id = $1 AND t.transaction_id = $2
		AND t.source_account_id = a.account_id AND t.status = 'PENDING'
		AND a.frozen_balance >= t.amount`
	nextStatus := "APPROVED"
	if restore {
		query = `UPDATE intermesh_accounts AS a
			SET balance = a.balance + t.amount, frozen_balance = a.frozen_balance - t.amount
			FROM intermesh_transactions AS t
			WHERE a.account_id = $1 AND t.transaction_id = $2
			AND t.source_account_id = a.account_id AND t.status = 'PENDING'
			AND a.frozen_balance >= t.amount`
		nextStatus = "FAILED"
	}
	result, err := tx.Exec(query, ref.AccountID, ref.TransactionID)
	if err != nil {
		return infrastructureError("update balance", err)
	}
	count, err := result.RowsAffected()
	if err != nil {
		return infrastructureError("balance row count", err)
	}
	if count == 0 {
		return ErrTransactionConflict
	}
	if count != 1 {
		return infrastructureError("balance row count", nil)
	}
	result, err = tx.Exec(`UPDATE intermesh_transactions SET status = $3
		WHERE transaction_id = $1 AND source_account_id = $2 AND status = 'PENDING'`, ref.TransactionID, ref.AccountID, nextStatus)
	if err != nil {
		return infrastructureError("update status", err)
	}
	if err := requireOneRow(result); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return infrastructureError("commit", err)
	}
	return nil
}
