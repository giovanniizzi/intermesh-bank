package handler

import (
	"encoding/json"
	"fmt"
	"intermesh-ledger/internal/dto"
	"intermesh-ledger/internal/repository"
	"io"
	"log"
	"net/http"
)

type LedgerHandler struct {
	Repo *repository.AccountRepository
}

func NewLedgerHandler(repo *repository.AccountRepository) *LedgerHandler {
	return &LedgerHandler{Repo: repo}
}

func decodeWrite(w http.ResponseWriter, r *http.Request, payload any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	if err := decoder.Decode(payload); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return fmt.Errorf("invalid trailing JSON")
	}
	return nil
}

func invalidMonetaryRequest(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	json.NewEncoder(w).Encode(map[string]string{"error": "Invalid monetary request"})
}

func (h *LedgerHandler) HandleCreateAccount(w http.ResponseWriter, r *http.Request) {
	var payload dto.AccountCreationPayloadDTO
	if err := decodeWrite(w, r, &payload); err != nil || !payload.InitialDeposit.Valid(true) {
		invalidMonetaryRequest(w)
		return
	}

	status, err := h.Repo.CreateAccount(payload)
	if err != nil {
		log.Printf("[Ledger Error] Failed to insert new account record: %v\n", err)
		http.Error(w, "Database persistence failure", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(status)
}

func (h *LedgerHandler) HandleFreeze(w http.ResponseWriter, r *http.Request) {
	var payload dto.LedgerPayloadDTO
	if err := decodeWrite(w, r, &payload); err != nil || !payload.Amount.Valid(false) {
		invalidMonetaryRequest(w)
		return
	}

	txID, err := h.Repo.FreezeFunds(payload)
	if err != nil {
		log.Printf("[Ledger Error] Freeze balance query failed: %v\n", err)
		if err.Error() == "insufficient_funds_or_invalid_account" {
			w.WriteHeader(http.StatusUnprocessableEntity)
			w.Write([]byte(`{"error":"Insufficient liquidity"}`))
			return
		}
		http.Error(w, "Database processing error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "FROZEN", "tmp_tx_id": txID})
}

func (h *LedgerHandler) HandleCommit(w http.ResponseWriter, r *http.Request) {
	var payload dto.LedgerPayloadDTO
	if err := decodeWrite(w, r, &payload); err != nil || !payload.Amount.Valid(false) {
		invalidMonetaryRequest(w)
		return
	}

	txID, err := h.Repo.CommitTransaction(payload)
	if err != nil {
		log.Printf("[Ledger Error] Commit balance update failed: %v\n", err)
		http.Error(w, "Database processing error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "COMMITTED", "transaction_id": txID})
}

func (h *LedgerHandler) HandleUnfreeze(w http.ResponseWriter, r *http.Request) {
	var payload dto.LedgerPayloadDTO
	if err := decodeWrite(w, r, &payload); err != nil || !payload.Amount.Valid(false) {
		invalidMonetaryRequest(w)
		return
	}

	err := h.Repo.RollbackTransaction(payload)
	if err != nil {
		log.Printf("[Ledger Error] Unfreeze balance update failed: %v\n", err)
		http.Error(w, "Database processing error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (h *LedgerHandler) HandleBalance(w http.ResponseWriter, r *http.Request) {
	accountID := r.PathValue("id")
	account, err := h.Repo.GetBalance(accountID)
	if err != nil {
		http.Error(w, "Account record not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(account)
}

func (h *LedgerHandler) HandleHistory(w http.ResponseWriter, r *http.Request) {
	accountID := r.PathValue("id")
	history, err := h.Repo.GetHistory(accountID)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(history)
}

func (h *LedgerHandler) HandleUserAccounts(w http.ResponseWriter, r *http.Request) {
	userID := r.PathValue("userID")
	accounts, err := h.Repo.GetUserAccounts(userID)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(accounts)
}
