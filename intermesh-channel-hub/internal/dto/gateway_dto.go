package dto

// AccountCreationRequestDTO maps the inbound registration data from UI
type AccountCreationRequestDTO struct {
	HolderName     string  `json:"holder_name"`
	InitialDeposit float64 `json:"initial_deposit"`
}

// TransferRequestDTO maps the inbound wire transfer data from UI
type TransferRequestDTO struct {
	SourceAccount string  `json:"source_account"`
	TargetAccount string  `json:"target_account"`
	Amount        float64 `json:"amount"`
}
