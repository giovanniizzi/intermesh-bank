package dto

type AccountDTO struct {
	AccountID     string  `json:"account_id"`
	UserID        string  `json:"user_id"`
	IBAN          string  `json:"iban"`
	HolderName    string  `json:"holder_name"`
	Balance       float64 `json:"balance"`
	FrozenBalance float64 `json:"frozen_balance"`
}

type AccountCreationPayloadDTO struct {
	UserID         string  `json:"user_id"`
	HolderName     string  `json:"holder_name"`
	InitialDeposit float64 `json:"initial_deposit"`
}

type LedgerPayloadDTO struct {
	AccountID     string  `json:"account_id"`
	TargetAccount string  `json:"target_account"`
	Amount        float64 `json:"amount"`
}

type TransactionHistoryDTO struct {
	TransactionID string  `json:"transaction_id"`
	TargetIBAN    string  `json:"target_iban"`
	Amount        float64 `json:"amount"`
	Status        string  `json:"status"`
	Timestamp     string  `json:"timestamp"`
}
