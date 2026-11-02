package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"intermesh-ledger/internal/dto"
	"intermesh-ledger/internal/repository"
	"io"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"
)

type TransferRepository interface {
	AdmitTransfer(context.Context, dto.VerifiedTransferIdentity, dto.TransferIntent) (dto.TransferAdmissionResult, error)
	GetTransferRequest(context.Context, dto.VerifiedTransferIdentity, dto.TransferRequestID) (dto.TransferAdmissionResult, error)
}

type TransferHandler struct{ repo TransferRepository }

func NewTransferHandler(repo TransferRepository) *TransferHandler {
	return &TransferHandler{repo: repo}
}

// RegisterRoutes replaces the legacy freeze route; it must not be registered
// alongside it. Production activation requires the coordinated Orchestrator contract.
func (h *TransferHandler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/ledger/freeze", h.HandleAdmission)
	mux.HandleFunc("GET /v1/ledger/transfer-requests/{transfer_request_id}", h.HandleRecovery)
}

type transferResponse struct {
	Status                   string                    `json:"status"`
	RequestID                dto.TransferRequestID     `json:"transfer_request_id"`
	AdmissionStatus          dto.AdmissionDecision     `json:"admission_status"`
	RejectionCode            dto.TransferRejectionCode `json:"rejection_code,omitempty"`
	TransactionID            *string                   `json:"transaction_id"`
	TransactionState         *string                   `json:"transaction_state"`
	NewTransactionCreated    bool                      `json:"new_transaction_created"`
	DuplicatePendingApproved bool                      `json:"duplicate_pending_approved"`
	MatchingPendingCount     int                       `json:"matching_pending_count"`
}

func transferJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

func transferError(w http.ResponseWriter, status int, code, message string) {
	transferJSON(w, status, map[string]string{"code": code, "error": message})
}

func writeTransferResult(w http.ResponseWriter, status int, kind string, result dto.TransferAdmissionResult) {
	body := transferResponse{Status: kind, RequestID: result.RequestID, AdmissionStatus: result.Decision,
		RejectionCode: result.RejectionCode, NewTransactionCreated: result.NewTransactionCreated,
		DuplicatePendingApproved: result.DuplicatePendingApproved, MatchingPendingCount: result.MatchingPendingCount}
	if result.TransactionID != "" {
		body.TransactionID, body.TransactionState = &result.TransactionID, &result.TransactionState
	}
	transferJSON(w, status, body)
}

// This validates scalar context, not caller authenticity or JWT signatures.
// The caller must be restricted by receiving-Sidecar mTLS/AuthorizationPolicy,
// and Orchestrator must replace these headers from its verified BankingIdentity.
func orchestratorIdentityContext(r *http.Request) (dto.VerifiedTransferIdentity, bool) {
	values := make([]string, 3)
	for i, name := range []string{"X-Intermesh-Issuer", "X-Intermesh-Subject", "X-Intermesh-Owner-Key"} {
		header := r.Header.Values(name)
		if len(header) != 1 || strings.TrimSpace(header[0]) != header[0] || strings.Contains(header[0], ",") {
			return dto.VerifiedTransferIdentity{}, false
		}
		values[i] = header[0]
	}
	identity := dto.VerifiedTransferIdentity{Issuer: values[0], Subject: values[1], OwnerKey: values[2]}
	return identity, identity.Valid()
}

func (h *TransferHandler) HandleAdmission(w http.ResponseWriter, r *http.Request) {
	identity, ok := orchestratorIdentityContext(r)
	if !ok {
		transferError(w, http.StatusUnauthorized, "INVALID_IDENTITY_CONTEXT", "Valid Orchestrator identity context is required")
		return
	}
	mediaType, parameters, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" ||
		(parameters["charset"] != "" && !strings.EqualFold(parameters["charset"], "utf-8")) {
		transferError(w, http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE", "A UTF-8 JSON request is required")
		return
	}
	intent, err := decodeTransferIntent(w, r)
	if err != nil || !intent.Valid() {
		transferError(w, http.StatusBadRequest, "INVALID_TRANSFER_REQUEST", "Invalid transfer request")
		return
	}
	result, err := h.repo.AdmitTransfer(r.Context(), identity, intent)
	var rejected *repository.AdmissionRejectedError
	if errors.As(err, &rejected) {
		status := http.StatusConflict
		if rejected.Code == dto.InsufficientFunds {
			status = http.StatusUnprocessableEntity
		}
		writeTransferResult(w, status, "REJECTED", result)
		return
	}
	if err != nil {
		writeTransferFailure(w, err)
		return
	}
	kind := "REPLAYED"
	if result.NewTransactionCreated {
		kind = "FROZEN"
	}
	writeTransferResult(w, http.StatusOK, kind, result)
}

func (h *TransferHandler) HandleRecovery(w http.ResponseWriter, r *http.Request) {
	identity, ok := orchestratorIdentityContext(r)
	if !ok {
		transferError(w, http.StatusUnauthorized, "INVALID_IDENTITY_CONTEXT", "Valid Orchestrator identity context is required")
		return
	}
	id := dto.TransferRequestID(r.PathValue("transfer_request_id"))
	if !id.Valid() {
		transferError(w, http.StatusBadRequest, "INVALID_TRANSFER_REQUEST", "Invalid transfer request identifier")
		return
	}
	result, err := h.repo.GetTransferRequest(r.Context(), identity, id)
	if err != nil {
		writeTransferFailure(w, err)
		return
	}
	writeTransferResult(w, http.StatusOK, "RECOVERED", result)
}

func writeTransferFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, repository.ErrTransferCommitUnknown):
		transferError(w, http.StatusServiceUnavailable, "COMMIT_OUTCOME_UNKNOWN",
			"Admission outcome is unknown; recover using the original transfer_request_id")
	case errors.Is(err, repository.ErrInvalidTransferInput):
		transferError(w, http.StatusBadRequest, "INVALID_TRANSFER_REQUEST", "Invalid transfer request")
	case errors.Is(err, repository.ErrTransferUnauthorized), errors.Is(err, repository.ErrTransferAccountNotFound),
		errors.Is(err, repository.ErrTransferRequestNotFound):
		transferError(w, http.StatusNotFound, "TRANSFER_REQUEST_NOT_FOUND",
			"Request not found or inaccessible; an in-flight admission may still complete")
	case errors.Is(err, repository.ErrTransferIntentConflict):
		transferError(w, http.StatusConflict, "REQUEST_INTENT_CONFLICT", "Transfer request intent does not match")
	default:
		transferError(w, http.StatusServiceUnavailable, "TRANSFER_PERSISTENCE_UNAVAILABLE", "Transfer persistence is unavailable")
	}
}

func decodeTransferIntent(w http.ResponseWriter, r *http.Request) (dto.TransferIntent, error) {
	var intent dto.TransferIntent
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		return intent, err
	}
	if !utf8.Valid(body) {
		return intent, errors.New("invalid UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return intent, errors.New("expected JSON object")
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return intent, err
		}
		name, ok := key.(string)
		if !ok {
			return intent, errors.New("invalid field name")
		}
		switch name {
		case "transfer_request_id", "account_id", "target_account", "amount", "allowDuplicatePendingTransfer":
		default:
			return intent, errors.New("unknown field")
		}
		if _, exists := fields[name]; exists {
			return intent, errors.New("duplicate field")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return intent, err
		}
		fields[name] = value
	}
	if _, err := decoder.Token(); err != nil {
		return intent, err
	}
	var extra json.RawMessage
	if err := decoder.Decode(&extra); err != io.EOF || len(fields) != 5 {
		return intent, errors.New("incomplete or trailing JSON")
	}
	for _, field := range []struct {
		name   string
		target any
	}{
		{"transfer_request_id", &intent.RequestID}, {"account_id", &intent.SourceAccountID},
		{"target_account", &intent.Destination}, {"amount", &intent.Amount},
		{"allowDuplicatePendingTransfer", &intent.AllowDuplicatePendingTransfer},
	} {
		if bytes.Equal(bytes.TrimSpace(fields[field.name]), []byte("null")) {
			return intent, errors.New("null field")
		}
		if err := json.Unmarshal(fields[field.name], field.target); err != nil {
			return intent, err
		}
	}
	return intent, nil
}
