package repository

import (
	"database/sql"
	"fmt"
	"intermesh-ledger/internal/dto"
)

type AccountRepository struct {
	db *sql.DB
}

func NewAccountRepository(db *sql.DB) *AccountRepository {
	return &AccountRepository{db: db}
}

func (r *AccountRepository) CreateAccount(payload dto.AccountCreationPayloadDTO) (dto.AccountDTO, error) {
	var nextSerial int64
	var account dto.AccountDTO

	err := r.db.QueryRow("SELECT NEXTVAL('intermesh_account_seq')").Scan(&nextSerial)
	if err != nil {
		return account, err
	}

	accountID := fmt.Sprintf("ACC-%d", nextSerial)
	mockIBAN := fmt.Sprintf("IT99X030690500000010000%d", nextSerial)

	query := `
		INSERT INTO intermesh_accounts (account_id, user_id, iban, holder_name, balance, frozen_balance) 
		VALUES ($1, $2, $3, $4, $5, 0.00)
	`
	_, err = r.db.Exec(query, accountID, payload.UserID, mockIBAN, payload.HolderName, payload.InitialDeposit)
	if err != nil {
		return account, err
	}

	account = dto.AccountDTO{
		AccountID:     accountID,
		UserID:        payload.UserID,
		IBAN:          mockIBAN,
		HolderName:    payload.HolderName,
		Balance:       payload.InitialDeposit.Float64(),
		FrozenBalance: 0.00,
	}
	return account, nil
}

func (r *AccountRepository) GetBalance(accountID string) (dto.AccountDTO, error) {
	var account dto.AccountDTO
	query := `SELECT account_id, user_id, iban, holder_name, balance, frozen_balance FROM intermesh_accounts WHERE account_id = $1`
	err := r.db.QueryRow(query, accountID).Scan(&account.AccountID, &account.UserID, &account.IBAN, &account.HolderName, &account.Balance, &account.FrozenBalance)
	return account, err
}

func (r *AccountRepository) GetHistory(accountID string) ([]dto.TransactionHistoryDTO, error) {
	rows, err := r.db.Query("SELECT transaction_id, target_iban, amount, status, timestamp::text FROM intermesh_transactions WHERE source_account_id = $1 ORDER BY timestamp DESC", accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var history []dto.TransactionHistoryDTO
	for rows.Next() {
		var tx dto.TransactionHistoryDTO
		rows.Scan(&tx.TransactionID, &tx.TargetIBAN, &tx.Amount, &tx.Status, &tx.Timestamp)
		history = append(history, tx)
	}
	return history, nil
}

func (r *AccountRepository) GetUserAccounts(userID string) ([]dto.AccountDTO, error) {
	// AGGIORNATO: Ora selezioniamo tutte le colonne necessarie
	query := `
        SELECT account_id, user_id, iban, holder_name, balance, frozen_balance 
        FROM intermesh_accounts 
        WHERE user_id = $1`

	rows, err := r.db.Query(query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var accounts []dto.AccountDTO
	for rows.Next() {
		var account dto.AccountDTO
		err := rows.Scan(
			&account.AccountID,
			&account.UserID,
			&account.IBAN,
			&account.HolderName,
			&account.Balance,
			&account.FrozenBalance,
		)
		if err != nil {
			return nil, err
		}
		accounts = append(accounts, account)
	}

	if err = rows.Err(); err != nil {
		return nil, err
	}

	return accounts, nil
}
