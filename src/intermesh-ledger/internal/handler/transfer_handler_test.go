package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"intermesh-ledger/internal/dto"
	"intermesh-ledger/internal/repository"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const transferTestID = "00000000-0000-4000-8000-000000000001"

func transferTestBody(id, amount, approval string) string {
	return fmt.Sprintf(`{"transfer_request_id":%q,"account_id":"SOURCE","target_account":"TEST-RECIPIENT-IBAN","amount":%s,"allowDuplicatePendingTransfer":%s}`, id, amount, approval)
}

func transferTestRequest(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Intermesh-Issuer", "https://issuer.example.invalid/realms/demo")
	r.Header.Set("X-Intermesh-Subject", "synthetic-subject")
	r.Header.Set("X-Intermesh-Owner-Key", "synthetic-user")
	return r
}

func performTransferRequest(t *testing.T, mux http.Handler, r *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("sensitive response lacks JSON/no-store headers: %v", w.Header())
	}
	return w
}

type transferRepositoryStub struct {
	admissions, recoveries int
	identity               dto.VerifiedTransferIdentity
	intent                 dto.TransferIntent
	id                     dto.TransferRequestID
	result                 dto.TransferAdmissionResult
	err                    error
}

func (s *transferRepositoryStub) AdmitTransfer(_ context.Context, identity dto.VerifiedTransferIdentity, intent dto.TransferIntent) (dto.TransferAdmissionResult, error) {
	s.admissions++
	s.identity, s.intent = identity, intent
	return s.result, s.err
}

func (s *transferRepositoryStub) GetTransferRequest(_ context.Context, identity dto.VerifiedTransferIdentity, id dto.TransferRequestID) (dto.TransferAdmissionResult, error) {
	s.recoveries++
	s.identity, s.id = identity, id
	return s.result, s.err
}

func transferTestMux(repo TransferRepository) *http.ServeMux {
	mux := http.NewServeMux()
	NewTransferHandler(repo).RegisterRoutes(mux)
	return mux
}

func TestTransferHTTPStrictJSON(t *testing.T) {
	valid := transferTestBody(transferTestID, "12.30", "false")
	cases := append([]string{}, invalidAmounts...)
	cases = append(cases, "0", "0.00", "-0.00", strings.Repeat("1", 257))
	var bodies []string
	for _, token := range cases {
		bodies = append(bodies, transferTestBody(transferTestID, token, "false"))
	}
	for _, approval := range []string{"null", `"true"`, "0", "1", "[]", "{}"} {
		bodies = append(bodies, transferTestBody(transferTestID, "12.30", approval))
	}
	bodies = append(bodies, "", "null", "[]", "{}", "{", valid+` {}`, valid+` trailing`,
		valid+strings.Repeat(" ", 64<<10),
		strings.Replace(valid, `,"allowDuplicatePendingTransfer":false`, "", 1),
		strings.Replace(valid, `"transfer_request_id":"`+transferTestID+`",`, "", 1),
		strings.Replace(valid, `"transfer_request_id":"`+transferTestID+`"`, `"transfer_request_id":null`, 1),
		strings.Replace(valid, transferTestID, "not-a-uuid", 1),
		strings.Replace(valid, `"SOURCE"`, `null`, 1),
		strings.Replace(valid, `"TEST-RECIPIENT-IBAN"`, `true`, 1),
		strings.Replace(valid, `"amount":12.30`, `"amount":12.30,"amount":1`, 1),
		strings.Replace(valid, `"amount":12.30`, `"AMOUNT":12.30`, 1),
		strings.Replace(valid, `"amount":12.30`, `"amount":12.30,"issuer":"forged"`, 1),
		strings.Replace(valid, `"transfer_request_id":`, `"transfer_request_id":"different", "transfer_\u0072equest_id":`, 1),
		strings.Replace(valid, "SOURCE", string([]byte{0xff}), 1))
	for n, body := range bodies {
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			stub := &transferRepositoryStub{}
			w := performTransferRequest(t, transferTestMux(stub), transferTestRequest("POST", "/v1/ledger/freeze", body))
			if w.Code != 400 || stub.admissions != 0 || stub.recoveries != 0 {
				t.Fatalf("invalid input reached repository: status=%d calls=%d/%d", w.Code, stub.admissions, stub.recoveries)
			}
		})
	}
	for _, tc := range validAmounts {
		t.Run("valid/"+tc.token, func(t *testing.T) {
			stub := &transferRepositoryStub{}
			w := performTransferRequest(t, transferTestMux(stub), transferTestRequest("POST", "/v1/ledger/freeze",
				transferTestBody(transferTestID, tc.token, "true")))
			value, err := stub.intent.Amount.Value()
			if w.Code != 200 || stub.admissions != 1 || err != nil || value != tc.canonical || !stub.intent.AllowDuplicatePendingTransfer {
				t.Fatalf("inexact or missing input: status=%d value=%v err=%v", w.Code, value, err)
			}
		})
	}
}

func TestTransferHTTPIdentityContext(t *testing.T) {
	for _, method := range []string{"POST", "GET"} {
		for _, name := range []string{"X-Intermesh-Issuer", "X-Intermesh-Subject", "X-Intermesh-Owner-Key"} {
			for _, mutation := range []string{"missing", "blank", "duplicate", "combined", "padding", "oversized"} {
				t.Run(method+"/"+name+"/"+mutation, func(t *testing.T) {
					stub := &transferRepositoryStub{}
					path := "/v1/ledger/freeze"
					if method == "GET" {
						path = "/v1/ledger/transfer-requests/" + transferTestID
					}
					r := transferTestRequest(method, path, transferTestBody(transferTestID, "12.30", "false"))
					switch mutation {
					case "missing":
						r.Header.Del(name)
					case "blank":
						r.Header.Set(name, " ")
					case "duplicate":
						r.Header.Add(name, r.Header.Get(name))
					case "combined":
						r.Header.Set(name, r.Header.Get(name)+",forged")
					case "padding":
						r.Header.Set(name, " "+r.Header.Get(name))
					case "oversized":
						r.Header.Set(name, strings.Repeat("x", 2049))
					}
					r.Header.Set("X-Intermesh-User", "synthetic-user")
					w := performTransferRequest(t, transferTestMux(stub), r)
					if w.Code != 401 || stub.admissions != 0 || stub.recoveries != 0 {
						t.Fatalf("malformed context reached repository: %d", w.Code)
					}
				})
			}
		}
	}
	stub := &transferRepositoryStub{}
	r := transferTestRequest("POST", "/v1/ledger/freeze", transferTestBody(transferTestID, "12.30", "false"))
	r.Header.Set("X-Intermesh-User", "forged-user")
	w := performTransferRequest(t, transferTestMux(stub), r)
	if w.Code != 200 || stub.identity.OwnerKey != "synthetic-user" || stub.identity.Subject != "synthetic-subject" {
		t.Fatal("legacy user header influenced the identity context")
	}
}

func TestTransferHTTPResponseMapping(t *testing.T) {
	for _, tc := range []struct {
		name, kind string
		result     dto.TransferAdmissionResult
		err        error
		status     int
		code       string
	}{
		{"new", "FROZEN", dto.TransferAdmissionResult{RequestID: transferTestID, Decision: dto.AdmissionAdmitted,
			TransactionID: "TX-IM-synthetic", TransactionState: "PENDING", NewTransactionCreated: true}, nil, 200, ""},
		{"replay", "REPLAYED", dto.TransferAdmissionResult{RequestID: transferTestID, Decision: dto.AdmissionAdmitted,
			TransactionID: "TX-IM-synthetic", TransactionState: "APPROVED"}, nil, 200, ""},
		{"confirmation", "REJECTED", dto.TransferAdmissionResult{RequestID: transferTestID, Decision: dto.AdmissionRejected,
			RejectionCode: dto.DuplicateApprovalRequired}, &repository.AdmissionRejectedError{Code: dto.DuplicateApprovalRequired}, 409, ""},
		{"funds", "REJECTED", dto.TransferAdmissionResult{RequestID: transferTestID, Decision: dto.AdmissionRejected,
			RejectionCode: dto.InsufficientFunds}, &repository.AdmissionRejectedError{Code: dto.InsufficientFunds}, 422, ""},
		{"intent", "", dto.TransferAdmissionResult{}, repository.ErrTransferIntentConflict, 409, "REQUEST_INTENT_CONFLICT"},
		{"unauthorized", "", dto.TransferAdmissionResult{}, repository.ErrTransferUnauthorized, 404, "TRANSFER_REQUEST_NOT_FOUND"},
		{"missing", "", dto.TransferAdmissionResult{}, repository.ErrTransferRequestNotFound, 404, "TRANSFER_REQUEST_NOT_FOUND"},
		{"invalid", "", dto.TransferAdmissionResult{}, repository.ErrInvalidTransferInput, 400, "INVALID_TRANSFER_REQUEST"},
		{"infrastructure", "", dto.TransferAdmissionResult{}, fmt.Errorf("%w: private synthetic details", repository.ErrTransferInfrastructure), 503, "TRANSFER_PERSISTENCE_UNAVAILABLE"},
		{"unknown", "", dto.TransferAdmissionResult{}, errors.Join(repository.ErrTransferInfrastructure, repository.ErrTransferCommitUnknown), 503, "COMMIT_OUTCOME_UNKNOWN"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stub := &transferRepositoryStub{result: tc.result, err: tc.err}
			w := performTransferRequest(t, transferTestMux(stub), transferTestRequest("POST", "/v1/ledger/freeze",
				transferTestBody(transferTestID, "12.30", "false")))
			if w.Code != tc.status || strings.Contains(w.Body.String(), "private") {
				t.Fatalf("incorrect sanitized response: %d %s", w.Code, w.Body.String())
			}
			if tc.code != "" {
				var body map[string]string
				if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body["code"] != tc.code {
					t.Fatalf("incorrect error: %s %v", w.Body.String(), err)
				}
			} else {
				var body transferResponse
				if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body.Status != tc.kind ||
					body.NewTransactionCreated != tc.result.NewTransactionCreated || body.RequestID != transferTestID {
					t.Fatalf("incorrect result: %+v %v", body, err)
				}
			}
		})
	}
}

func TestTransferHTTPRecoveryAndRoutingValidation(t *testing.T) {
	for _, path := range []string{"/v1/ledger/transfer-requests/invalid", "/v1/ledger/transfer-requests/not-a-uuid"} {
		stub := &transferRepositoryStub{}
		w := performTransferRequest(t, transferTestMux(stub), transferTestRequest("GET", path, ""))
		if w.Code != 400 || stub.recoveries != 0 {
			t.Fatal("malformed recovery UUID reached repository")
		}
	}
	for _, contentType := range []string{"", "text/plain", "application/json; charset=iso-8859-1"} {
		stub := &transferRepositoryStub{}
		r := transferTestRequest("POST", "/v1/ledger/freeze", transferTestBody(transferTestID, "12.30", "false"))
		r.Header.Set("Content-Type", contentType)
		w := performTransferRequest(t, transferTestMux(stub), r)
		if w.Code != 415 || stub.admissions != 0 {
			t.Fatal("unsupported media type reached repository")
		}
	}
	for _, reverse := range []bool{false, true} {
		t.Run(fmt.Sprint(reverse), func(t *testing.T) {
			mux := http.NewServeMux()
			legacy := func(http.ResponseWriter, *http.Request) {}
			strict := NewTransferHandler(&transferRepositoryStub{})
			defer func() {
				if recover() == nil {
					t.Fatal("legacy and strict freeze registrations must not coexist")
				}
			}()
			if reverse {
				mux.HandleFunc("POST /v1/ledger/freeze", legacy)
				strict.RegisterRoutes(mux)
			} else {
				strict.RegisterRoutes(mux)
				mux.HandleFunc("POST /v1/ledger/freeze", legacy)
			}
		})
	}
}

func TestProductionTransferRoutesRejectLegacyBypass(t *testing.T) {
	mux := NewRouter(nil)
	for _, tc := range []struct {
		method, path, body string
		status             int
	}{
		{"POST", "/v1/ledger/freeze", `{"account_id":"SOURCE","target_account":"TEST","amount":1}`, 400},
		{"GET", "/v1/ledger/transfer-requests/not-a-uuid", "", 400},
	} {
		r := transferTestRequest(tc.method, tc.path, tc.body)
		w := performTransferRequest(t, mux, r)
		if w.Code != tc.status {
			t.Fatalf("%s: status=%d", tc.path, w.Code)
		}
	}
	r := transferTestRequest("POST", "/v1/ledger/freeze", transferTestBody(transferTestID, "12.30", "false"))
	r.Header.Del("X-Intermesh-Subject")
	if w := performTransferRequest(t, mux, r); w.Code != 401 {
		t.Fatalf("identity-free freeze: %d", w.Code)
	}
}
