package repository

import (
	"context"
	"database/sql"
	"errors"
	"intermesh-ledger/internal/dto"
	"strings"
)

var ErrTransferRequestNotFound = errors.New("transfer request not found or inaccessible")

// GetTransferRequest observes one authorized snapshot without taking write locks
// or continuing a transfer. Absence does not exclude a later in-flight commit.
func (r *AccountRepository) GetTransferRequest(ctx context.Context, identity dto.VerifiedTransferIdentity,
	id dto.TransferRequestID) (dto.TransferAdmissionResult, error) {
	var empty dto.TransferAdmissionResult
	if !identity.Valid() {
		return empty, ErrTransferUnauthorized
	}
	if !id.Valid() {
		return empty, ErrInvalidTransferInput
	}
	id = dto.TransferRequestID(strings.ToLower(string(id)))
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return empty, admissionFailure("begin recovery", err)
	}
	defer tx.Rollback()
	intent := dto.TransferIntent{RequestID: id}
	var issuer, subject, owner, amount string
	err = tx.QueryRowContext(ctx, `SELECT r.issuer,r.subject,a.user_id,
		r.source_account_id,r.target_iban,r.amount::text,r.allow_duplicate_pending_transfer
		FROM intermesh_transfer_requests AS r
		JOIN intermesh_accounts AS a ON a.account_id = r.source_account_id
		WHERE r.transfer_request_id = $1`, string(id)).Scan(&issuer, &subject, &owner,
		&intent.SourceAccountID, &intent.Destination, &amount, &intent.AllowDuplicatePendingTransfer)
	if errors.Is(err, sql.ErrNoRows) {
		return empty, ErrTransferRequestNotFound
	}
	if err != nil {
		return empty, admissionFailure("read recovery identity", err)
	}
	if issuer != identity.Issuer || subject != identity.Subject || owner != identity.OwnerKey {
		return empty, ErrTransferUnauthorized
	}
	if err := intent.Amount.UnmarshalJSON([]byte(amount)); err != nil || !intent.Valid() {
		return empty, admissionFailure("invalid recovery intent", err)
	}
	result, found, err := loadTransferRequest(ctx, tx, identity, intent)
	if err != nil {
		return empty, err
	}
	if !found {
		return empty, admissionFailure("recovery record disappeared", nil)
	}
	if err := tx.Commit(); err != nil {
		return empty, admissionFailure("finish read-only recovery", err)
	}
	return result, nil
}
