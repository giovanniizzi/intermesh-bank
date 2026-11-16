package handler

import (
	"bytes"
	"encoding/json"
	"intermesh-channel-hub/internal/dto"
	"io"
	"log"
	"net/http"
)

type ProxyHandler struct {
	OrchestratorURL string
}

func NewProxyHandler(orchestratorURL string) *ProxyHandler {
	return &ProxyHandler{OrchestratorURL: orchestratorURL}
}

func (h *ProxyHandler) HandleAccountOnboarding(w http.ResponseWriter, r *http.Request) {
	log.Println("[Channel Hub] Intercepted public onboarding request. Validating proxy layout...")

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read inbound account payload", http.StatusBadRequest)
		return
	}

	var checkDTO dto.AccountCreationRequestDTO
	if err := json.Unmarshal(bodyBytes, &checkDTO); err != nil {
		http.Error(w, "Invalid Account Creation DTO structural layout", http.StatusBadRequest)
		return
	}

	forwardURL := h.OrchestratorURL + "/v1/accounts"
	h.forwardToOrchestrator(w, r, "POST", forwardURL, bodyBytes)
}

func (h *ProxyHandler) HandleTransfer(w http.ResponseWriter, r *http.Request) {
	log.Println("[Channel Hub] Intercepted public transfer layout. Forwarding inside the mesh perimeters...")

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Failed to read inbound transfer payload", http.StatusBadRequest)
		return
	}

	var checkDTO dto.TransferRequestDTO
	if err := json.Unmarshal(bodyBytes, &checkDTO); err != nil {
		http.Error(w, "Invalid Transfer DTO structural layout", http.StatusBadRequest)
		return
	}

	forwardURL := h.OrchestratorURL + "/v1/transfers"
	h.forwardToOrchestrator(w, r, "POST", forwardURL, bodyBytes)
}

func (h *ProxyHandler) HandleLedgerHistory(w http.ResponseWriter, r *http.Request) {
	log.Println("[Channel Hub] Intercepted historical lookup. Routing to Orchestrator...")

	accountID := r.PathValue("id")
	if accountID == "" {
		http.Error(w, "Missing required account identifier", http.StatusBadRequest)
		return
	}

	forwardURL := h.OrchestratorURL + "/v1/transfers/account/" + accountID + "/transactions"

	// For GET requests, we pass nil as the body payload
	h.forwardToOrchestrator(w, r, "GET", forwardURL, nil)
}

func (h *ProxyHandler) HandleUserAccounts(w http.ResponseWriter, r *http.Request) {
	log.Println("[Channel Hub] Intercepted user account lookup. Routing to Orchestrator...")

	userID := r.PathValue("userID")
	if userID == "" {
		http.Error(w, "Missing required user identifier", http.StatusBadRequest)
		return
	}

	forwardURL := h.OrchestratorURL + "/v1/accounts/" + userID

	// For GET requests, we pass nil as the body payload
	h.forwardToOrchestrator(w, r, "GET", forwardURL, nil)
}

func (h *ProxyHandler) forwardToOrchestrator(w http.ResponseWriter, r *http.Request, method string, targetURL string, body []byte) {
	var bodyBuffer io.Reader
	if body != nil {
		bodyBuffer = bytes.NewBuffer(body)
	}

	outboundReq, err := http.NewRequest(method, targetURL, bodyBuffer)
	if err != nil {
		http.Error(w, "Internal gateway proxy mirroring failed", http.StatusInternalServerError)
		return
	}

	if method == "POST" {
		outboundReq.Header.Set("Content-Type", "application/json")
	}

	// Forward inbound headers (Including JWT Authorization and Stateful Java Cookies)
	traceHeaders := []string{
		"Authorization",
		"Cookie",
		"X-Request-Id",
		"X-B3-Traceid",
		"X-B3-Spanid",
		"X-B3-Sampled",
		"X-B3-Flags",
		"X-Ot-Span-Context",
		"x-intermesh-channel",
		"x-intermesh-route-class",
		"x-intermesh-user",
	}

	for _, header := range traceHeaders {
		if value := r.Header.Get(header); value != "" {
			outboundReq.Header.Set(header, value)
		}
	}

	client := &http.Client{}
	resp, err := client.Do(outboundReq)
	if err != nil {
		log.Printf("[Channel Hub Link Fault] Upstream destination unreachable: %v\n", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte(`{"status":"FAILED","reason":"Upstream Core Orchestrator service is momentarily offline."}`))
		return
	}
	defer resp.Body.Close()

	// Propagate outbound headers (Copies JSESSIONID Set-Cookie header back to the browser)
	for key, values := range resp.Header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}

	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

/*
func (h *ProxyHandler) executeProxyForward(w http.ResponseWriter, r *http.Request, targetURL string, body []byte) {
	outboundReq, err := http.NewRequest("POST", targetURL, bytes.NewBuffer(body))
	if err != nil {
		http.Error(w, "Internal gateway proxy mirroring failed", http.StatusInternalServerError)
		return
	}

	outboundReq.Header.Set("Content-Type", "application/json")

	// B3 propagation specs for tracing telemetry
	traceHeaders := []string{
		"Authorization",
		"X-Request-Id",
		"X-B3-Traceid",
		"X-B3-Spanid",
		"X-B3-Sampled",
		"X-B3-Flags",
		"X-Ot-Span-Context",
	}

	for _, header := range traceHeaders {
		if value := r.Header.Get(header); value != "" {
			outboundReq.Header.Set(header, value)
		}
	}

	client := &http.Client{}
	resp, err := client.Do(outboundReq)
	if err != nil {
		log.Printf("[Channel Hub Link Fault] Upstream destination unreachable: %v\n", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte(`{"status":"FAILED","reason":"Upstream Core Orchestrator service is momentarily offline."}`))
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// HandleLedgerHistory forwards GET requests for transaction history to the Orchestrator
func (h *ProxyHandler) HandleLedgerHistory(w http.ResponseWriter, r *http.Request) {
	log.Println("[Channel Hub] Intercepted historical lookup. Routing to Orchestrator...")

	accountID := r.PathValue("id")
	if accountID == "" {
		http.Error(w, "Missing required account identifier", http.StatusBadRequest)
		return
	}

	// We assume the Orchestrator exposes this path (e.g., /v1/ledger/accounts/{id}/transactions)
	forwardURL := h.OrchestratorURL + "/v1/ledger/accounts/" + accountID + "/transactions"

	// Create outbound GET request
	outboundReq, err := http.NewRequest("GET", forwardURL, nil)
	if err != nil {
		http.Error(w, "Internal gateway proxy mirroring failed", http.StatusInternalServerError)
		return
	}

	// Propagate tracing headers and Authorization token (JWT)
	traceHeaders := []string{
		"Authorization",
		"X-Request-Id",
		"X-B3-Traceid",
		"X-B3-Spanid",
		"X-B3-Sampled",
		"X-B3-Flags",
		"X-Ot-Span-Context",
	}

	for _, header := range traceHeaders {
		if value := r.Header.Get(header); value != "" {
			outboundReq.Header.Set(header, value)
		}
	}

	client := &http.Client{}
	resp, err := client.Do(outboundReq)
	if err != nil {
		log.Printf("[Channel Hub Link Fault] Upstream Orchestrator destination unreachable: %v\n", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte(`{"status":"FAILED","reason":"Orchestrator service is momentarily offline."}`))
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}
*/
