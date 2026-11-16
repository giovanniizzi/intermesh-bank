package dto

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// TransactionReference identifies one frozen transaction and its expected terms.
// It is separate from the legacy HTTP request DTO until API integration.
type TransactionReference struct {
	TransactionID string `json:"transaction_id"`
	AccountID     string `json:"account_id"`
	Amount        Amount `json:"amount"`
}

func (ref TransactionReference) Valid() bool {
	return validReferenceID(ref.TransactionID) && validReferenceID(ref.AccountID) && ref.Amount.Valid(false)
}

func validReferenceID(id string) bool {
	return utf8.ValidString(id) && strings.TrimSpace(id) == id && id != "" && utf8.RuneCountInString(id) <= 50 &&
		!strings.ContainsFunc(id, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) })
}
