package dto

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

type TransferRequestID string

var transferRequestUUID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func (id TransferRequestID) Valid() bool {
	return transferRequestUUID.MatchString(string(id))
}

// VerifiedTransferIdentity must be constructed by a trusted authentication boundary,
// never by decoding identity fields supplied by a browser.
type VerifiedTransferIdentity struct {
	Issuer   string
	Subject  string
	OwnerKey string
}

func (i VerifiedTransferIdentity) Valid() bool {
	return validAdmissionText(i.Issuer, 2048) && validAdmissionText(i.Subject, 255) &&
		validAdmissionText(i.OwnerKey, 50)
}

type TransferIntent struct {
	RequestID                     TransferRequestID
	SourceAccountID               string
	Destination                   string
	Amount                        Amount
	AllowDuplicatePendingTransfer bool
}

func (i TransferIntent) Valid() bool {
	return i.RequestID.Valid() && validReferenceID(i.SourceAccountID) &&
		validAdmissionText(i.Destination, 34) && i.Amount.Valid(false)
}

func validAdmissionText(value string, maximum int) bool {
	return utf8.ValidString(value) && strings.TrimSpace(value) != "" &&
		utf8.RuneCountInString(value) <= maximum && !strings.ContainsFunc(value, unicode.IsControl)
}

type AdmissionDecision string

const (
	AdmissionAdmitted AdmissionDecision = "ADMITTED"
	AdmissionRejected AdmissionDecision = "REJECTED"
)

type TransferRejectionCode string

const (
	DuplicateApprovalRequired    TransferRejectionCode = "DUPLICATE_APPROVAL_REQUIRED"
	DuplicateApprovalNotEligible TransferRejectionCode = "DUPLICATE_APPROVAL_NOT_ELIGIBLE"
	DuplicateExceptionUsed       TransferRejectionCode = "DUPLICATE_EXCEPTION_USED"
	ActiveCycleBlocked           TransferRejectionCode = "ACTIVE_CYCLE_BLOCKED"
	ActiveCycleConflict          TransferRejectionCode = "ACTIVE_CYCLE_CONFLICT"
	InsufficientFunds            TransferRejectionCode = "INSUFFICIENT_FUNDS"
)

func (c TransferRejectionCode) Valid() bool {
	switch c {
	case DuplicateApprovalRequired, DuplicateApprovalNotEligible, DuplicateExceptionUsed,
		ActiveCycleBlocked, ActiveCycleConflict, InsufficientFunds:
		return true
	}
	return false
}

type TransferAdmissionResult struct {
	RequestID                TransferRequestID
	Decision                 AdmissionDecision
	RejectionCode            TransferRejectionCode
	TransactionID            string
	TransactionState         string
	NewTransactionCreated    bool
	DuplicatePendingApproved bool
	MatchingPendingCount     int
}
