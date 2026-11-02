package repository

import (
	"context"
	"database/sql"
	"errors"
	"intermesh-ledger/internal/dto"
	"strings"

	"github.com/lib/pq"
)

var (
	ErrInvalidTransferInput    = errors.New("invalid transfer admission input")
	ErrTransferUnauthorized    = errors.New("transfer access denied")
	ErrTransferAccountNotFound = errors.New("source account not found")
	ErrTransferIntentConflict  = errors.New("transfer request intent conflict")
	ErrTransferInfrastructure  = errors.New("transfer admission persistence failure")
	ErrTransferCommitUnknown   = errors.New("transfer admission commit outcome unknown")
)

type AdmissionRejectedError struct {
	Code dto.TransferRejectionCode
}

func (e *AdmissionRejectedError) Error() string {
	return "transfer admission rejected: " + string(e.Code)
}

// Error text contains no SQL, identifiers or financial payloads. The cause remains
// available to internal error classification through errors.Is/errors.As.
type admissionDBError struct {
	operation string
	cause     error
	unknown   bool
}

func (e *admissionDBError) Error() string {
	if e.unknown {
		return ErrTransferCommitUnknown.Error()
	}
	return ErrTransferInfrastructure.Error() + ": " + e.operation
}

func (e *admissionDBError) Unwrap() []error {
	errs := []error{ErrTransferInfrastructure}
	if e.unknown {
		errs = append(errs, ErrTransferCommitUnknown)
	}
	if e.cause != nil {
		errs = append(errs, e.cause)
	}
	return errs
}

func admissionFailure(operation string, cause error) error {
	return &admissionDBError{operation: operation, cause: cause}
}

// AdmitTransfer returns a persisted result only after commit. A domain rejection
// returns that result with *AdmissionRejectedError; other errors return no result.
// It is deliberately separate from the existing HTTP freeze implementation.
func (r *AccountRepository) AdmitTransfer(ctx context.Context, identity dto.VerifiedTransferIdentity,
	intent dto.TransferIntent) (dto.TransferAdmissionResult, error) {
	var empty dto.TransferAdmissionResult
	if !identity.Valid() {
		return empty, ErrTransferUnauthorized
	}
	if !intent.Valid() {
		return empty, ErrInvalidTransferInput
	}
	intent.RequestID = dto.TransferRequestID(strings.ToLower(string(intent.RequestID)))
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return empty, admissionFailure("begin", err)
	}
	defer tx.Rollback()

	var owner string
	var sufficient bool
	err = tx.QueryRowContext(ctx, `SELECT user_id, balance >= $2
		FROM intermesh_accounts WHERE account_id = $1 FOR UPDATE`,
		intent.SourceAccountID, intent.Amount).Scan(&owner, &sufficient)
	if errors.Is(err, sql.ErrNoRows) {
		return empty, ErrTransferAccountNotFound
	}
	if err != nil {
		return empty, admissionFailure("lock account", err)
	}
	if owner != identity.OwnerKey {
		return empty, ErrTransferUnauthorized
	}

	if result, found, err := loadTransferRequest(ctx, tx, identity, intent); err != nil {
		return empty, err
	} else if found {
		return finishTransferAdmission(tx, result)
	}

	parent, code, err := transferCycleDecision(ctx, tx, intent)
	if err != nil {
		return empty, err
	}
	if code == "" && !sufficient {
		code = dto.InsufficientFunds
	}
	result := dto.TransferAdmissionResult{RequestID: intent.RequestID, Decision: dto.AdmissionAdmitted, RejectionCode: code}
	var rejection any
	if code != "" {
		result.Decision, rejection = dto.AdmissionRejected, string(code)
	}
	registered, err := tx.ExecContext(ctx, `INSERT INTO intermesh_transfer_requests
		(transfer_request_id,issuer,subject,source_account_id,target_iban,amount,
		allow_duplicate_pending_transfer,admission_status,rejection_code)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (transfer_request_id) DO NOTHING`, string(intent.RequestID), identity.Issuer,
		identity.Subject, intent.SourceAccountID, intent.Destination, intent.Amount,
		intent.AllowDuplicatePendingTransfer, string(result.Decision), rejection)
	if err != nil {
		return empty, admissionFailure("register request", err)
	}
	count, err := registered.RowsAffected()
	if err != nil || count < 0 || count > 1 {
		return empty, admissionFailure("registration row count", err)
	}
	if count == 0 {
		// Another account can race for this global UUID. A fresh READ COMMITTED
		// statement observes its committed row; never reuse our losing decision.
		existing, found, err := loadTransferRequest(ctx, tx, identity, intent)
		if err != nil {
			return empty, err
		}
		if !found {
			return empty, admissionFailure("registration missing", nil)
		}
		return finishTransferAdmission(tx, existing)
	}
	if result.Decision == dto.AdmissionAdmitted {
		if err := createAdmittedFreeze(ctx, tx, intent, parent, &result); err != nil {
			return empty, err
		}
	}
	result.MatchingPendingCount, err = matchingPendingCount(ctx, tx, intent)
	if err != nil {
		return empty, err
	}
	return finishTransferAdmission(tx, result)
}

func loadTransferRequest(ctx context.Context, tx *sql.Tx, identity dto.VerifiedTransferIdentity,
	intent dto.TransferIntent) (dto.TransferAdmissionResult, bool, error) {
	var result dto.TransferAdmissionResult
	var issuer, subject string
	var termsMatch bool
	var code, transactionID, state sql.NullString
	var approved, consistent sql.NullBool
	err := tx.QueryRowContext(ctx, `SELECT r.issuer,r.subject,
		r.source_account_id = $2 AND r.target_iban = $3 AND r.amount = $4
		AND r.allow_duplicate_pending_transfer = $5,
		r.admission_status,r.rejection_code,t.transaction_id,t.status,t.duplicate_pending_approved,
		t.source_account_id = r.source_account_id AND t.target_iban = r.target_iban AND t.amount = r.amount
		AND t.duplicate_pending_approved = r.allow_duplicate_pending_transfer
		AND ((NOT t.duplicate_pending_approved AND t.ordinary_transaction_id IS NULL)
		 OR (t.duplicate_pending_approved AND p.ordinary_transaction_id IS NULL
		     AND NOT p.duplicate_pending_approved AND p.source_account_id = t.source_account_id
		     AND p.target_iban = t.target_iban AND p.amount = t.amount))
		FROM intermesh_transfer_requests AS r
		LEFT JOIN intermesh_transactions AS t ON t.transfer_request_id = r.transfer_request_id
		LEFT JOIN intermesh_transactions AS p ON p.transaction_id = t.ordinary_transaction_id
		WHERE r.transfer_request_id = $1`, string(intent.RequestID), intent.SourceAccountID,
		intent.Destination, intent.Amount, intent.AllowDuplicatePendingTransfer).
		Scan(&issuer, &subject, &termsMatch, &result.Decision, &code, &transactionID, &state, &approved, &consistent)
	if errors.Is(err, sql.ErrNoRows) {
		return result, false, nil
	}
	if err != nil {
		return dto.TransferAdmissionResult{}, false, admissionFailure("read request", err)
	}
	if issuer != identity.Issuer || subject != identity.Subject {
		return dto.TransferAdmissionResult{}, false, ErrTransferUnauthorized
	}
	if !termsMatch {
		return dto.TransferAdmissionResult{}, false, ErrTransferIntentConflict
	}
	result.RequestID = intent.RequestID
	switch result.Decision {
	case dto.AdmissionAdmitted:
		if code.Valid || !transactionID.Valid || transactionID.String == "" || !state.Valid ||
			!financialStateValid(state.String) || !approved.Valid || !consistent.Valid || !consistent.Bool {
			return dto.TransferAdmissionResult{}, false, admissionFailure("invalid admitted request", nil)
		}
		result.TransactionID, result.TransactionState = transactionID.String, state.String
		result.DuplicatePendingApproved = approved.Bool
	case dto.AdmissionRejected:
		result.RejectionCode = dto.TransferRejectionCode(code.String)
		if !code.Valid || !result.RejectionCode.Valid() || transactionID.Valid {
			return dto.TransferAdmissionResult{}, false, admissionFailure("invalid rejected request", nil)
		}
	default:
		return dto.TransferAdmissionResult{}, false, admissionFailure("invalid admission decision", nil)
	}
	result.MatchingPendingCount, err = matchingPendingCount(ctx, tx, intent)
	return result, true, err
}

func matchingPendingCount(ctx context.Context, tx *sql.Tx, intent dto.TransferIntent) (int, error) {
	var count int
	err := tx.QueryRowContext(ctx, `SELECT count(*) FROM intermesh_transactions
		WHERE source_account_id = $1 AND target_iban = $2 AND amount = $3 AND status = 'PENDING'`,
		intent.SourceAccountID, intent.Destination, intent.Amount).Scan(&count)
	if err != nil {
		return 0, admissionFailure("count pending transactions", err)
	}
	return count, nil
}

func financialStateValid(state string) bool {
	return state == "PENDING" || state == "APPROVED" || state == "FAILED"
}

func transferCycleDecision(ctx context.Context, tx *sql.Tx, intent dto.TransferIntent) (string, dto.TransferRejectionCode, error) {
	rows, err := tx.QueryContext(ctx, `SELECT DISTINCT o.transaction_id,o.status,
		o.source_account_id = $1 AND o.target_iban = $2 AND o.amount = $3
		AND o.ordinary_transaction_id IS NULL AND NOT o.duplicate_pending_approved,
		c.transaction_id,c.status,
		c.source_account_id = $1 AND c.target_iban = $2 AND c.amount = $3
		AND c.duplicate_pending_approved AND c.transfer_request_id IS NOT NULL
		FROM intermesh_transactions AS pending
		LEFT JOIN intermesh_transactions AS o
		 ON o.transaction_id = COALESCE(pending.ordinary_transaction_id,pending.transaction_id)
		LEFT JOIN intermesh_transactions AS c ON c.ordinary_transaction_id = o.transaction_id
		WHERE pending.source_account_id = $1 AND pending.target_iban = $2
		 AND pending.amount = $3 AND pending.status = 'PENDING'`,
		intent.SourceAccountID, intent.Destination, intent.Amount)
	if err != nil {
		return "", "", admissionFailure("read active cycle", err)
	}
	defer rows.Close()
	var rootID, rootState, childID, childState sql.NullString
	var rootValid, childValid sql.NullBool
	roots := 0
	conflict := false
	for rows.Next() {
		if err := rows.Scan(&rootID, &rootState, &rootValid, &childID, &childState, &childValid); err != nil {
			return "", "", admissionFailure("read active cycle", err)
		}
		roots++
		if !rootID.Valid || !rootState.Valid || !financialStateValid(rootState.String) ||
			!rootValid.Valid || !rootValid.Bool || (childID.Valid &&
			(!childState.Valid || !financialStateValid(childState.String) || !childValid.Valid || !childValid.Bool)) {
			conflict = true
		}
	}
	if err := rows.Err(); err != nil {
		return "", "", admissionFailure("read active cycle", err)
	}
	if conflict || roots > 1 {
		return "", dto.ActiveCycleConflict, nil
	}
	if roots == 0 {
		if intent.AllowDuplicatePendingTransfer {
			return "", dto.DuplicateApprovalNotEligible, nil
		}
		return "", "", nil
	}
	if rootState.String != "PENDING" {
		return "", dto.ActiveCycleBlocked, nil
	}
	if childID.Valid {
		return "", dto.DuplicateExceptionUsed, nil
	}
	if !intent.AllowDuplicatePendingTransfer {
		return "", dto.DuplicateApprovalRequired, nil
	}
	return rootID.String, "", nil
}

func createAdmittedFreeze(ctx context.Context, tx *sql.Tx, intent dto.TransferIntent, parent string,
	result *dto.TransferAdmissionResult) error {
	if err := tx.QueryRowContext(ctx, `SELECT 'TX-IM-' || gen_random_uuid()::text`).Scan(&result.TransactionID); err != nil {
		return admissionFailure("generate transaction ID", err)
	}
	updated, err := tx.ExecContext(ctx, `UPDATE intermesh_accounts
		SET balance = balance - $2, frozen_balance = frozen_balance + $2
		WHERE account_id = $1 AND balance >= $2`, intent.SourceAccountID, intent.Amount)
	if err != nil {
		return admissionFailure("freeze balance", err)
	}
	if err := requireOneRow(updated); err != nil {
		return admissionFailure("freeze row count", err)
	}
	var parentValue any
	if parent != "" {
		parentValue = parent
	}
	inserted, err := tx.ExecContext(ctx, `INSERT INTO intermesh_transactions
		(transaction_id,source_account_id,target_iban,amount,status,
		transfer_request_id,duplicate_pending_approved,ordinary_transaction_id)
		VALUES ($1,$2,$3,$4,'PENDING',$5,$6,$7)`, result.TransactionID, intent.SourceAccountID,
		intent.Destination, intent.Amount, string(intent.RequestID), parent != "", parentValue)
	if err != nil {
		return admissionFailure("insert frozen transaction", err)
	}
	if err := requireOneRow(inserted); err != nil {
		return admissionFailure("transaction row count", err)
	}
	result.TransactionState, result.NewTransactionCreated = "PENDING", true
	result.DuplicatePendingApproved = parent != ""
	return nil
}

func finishTransferAdmission(tx *sql.Tx, result dto.TransferAdmissionResult) (dto.TransferAdmissionResult, error) {
	if err := tx.Commit(); err != nil {
		return dto.TransferAdmissionResult{}, transferCommitError(err)
	}
	if result.Decision == dto.AdmissionRejected {
		return result, &AdmissionRejectedError{Code: result.RejectionCode}
	}
	return result, nil
}

func transferCommitError(cause error) error {
	var pgErr *pq.Error
	definiteAbort := errors.As(cause, &pgErr) &&
		(pgErr.Code.Class() == "23" || (pgErr.Code.Class() == "40" && pgErr.Code != "40003"))
	return &admissionDBError{operation: "commit", cause: cause, unknown: !definiteAbort}
}
