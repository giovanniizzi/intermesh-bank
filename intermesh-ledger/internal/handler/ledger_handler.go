package handler

import (
	"encoding/json"
	"errors"
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
	return decodeJSONWrite(w, r, payload, false)
}

func decodeJSONWrite(w http.ResponseWriter, r *http.Request, payload any, strict bool) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	if strict {
		decoder.DisallowUnknownFields()
	}
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

func finalizationError(w http.ResponseWriter, err error) {
	status, message := http.StatusInternalServerError, "Database processing error"
	switch {
	case errors.Is(err, repository.ErrInvalidTransactionReference):
		status, message = http.StatusBadRequest, "Invalid transaction reference"
	case errors.Is(err, repository.ErrTransactionNotFound):
		status, message = http.StatusNotFound, "Transaction not found"
	case errors.Is(err, repository.ErrTransactionConflict):
		status, message = http.StatusConflict, "Transaction conflict"
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func (h *LedgerHandler) HandleCommit(w http.ResponseWriter, r *http.Request) {
	var ref dto.TransactionReference
	if err := decodeJSONWrite(w, r, &ref, true); err != nil || !ref.Valid() {
		finalizationError(w, repository.ErrInvalidTransactionReference)
		return
	}
	id, err := h.Repo.CommitReferencedTransaction(ref)
	if err != nil {
		finalizationError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "COMMITTED", "transaction_id": id})
}

func (h *LedgerHandler) HandleUnfreeze(w http.ResponseWriter, r *http.Request) {
	var ref dto.TransactionReference
	if err := decodeJSONWrite(w, r, &ref, true); err != nil || !ref.Valid() {
		finalizationError(w, repository.ErrInvalidTransactionReference)
		return
	}
	if err := h.Repo.RollbackReferencedTransaction(ref); err != nil {
		finalizationError(w, err)
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
