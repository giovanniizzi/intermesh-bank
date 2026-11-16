package integration

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"intermesh-ledger/internal/handler"
	"intermesh-ledger/internal/repository"
	"intermesh-ledger/internal/testutil"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fraudPlan struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
	status  int
}

func (p *fraudPlan) finish() { p.once.Do(func() { close(p.release) }) }

type stack struct {
	db     *sql.DB
	url    string
	issuer string
	key    *rsa.PrivateKey
	client *http.Client
	plans  chan *fraudPlan
	fraud  atomic.Int32
	jwks   atomic.Int32
	serial atomic.Int32
	mu     sync.Mutex
	calls  map[string]int
}

type reply struct {
	status int
	body   map[string]any
	err    error
}

type pendingTransfer struct {
	plan   *fraudPlan
	done   chan struct{}
	result reply
}

func TestOrchestratorLedgerPostgres(t *testing.T) {
	jar := os.Getenv("INTERMESH_TEST_ORCHESTRATOR_JAR")
	if jar == "" {
		t.Skip("run tests/run-fin03-integration.sh to enable the real Orchestrator integration")
	}
	s := startStack(t, jar)
	t.Run("ordinary_replay_recovery_identity", func(t *testing.T) { s.ordinary(t) })
	for _, first := range []string{"duplicate", "ordinary"} {
		t.Run(first+"_finishes_first", func(t *testing.T) { s.cycle(t, first) })
	}
	t.Run("invalid_requests", func(t *testing.T) { s.invalidRequests(t) })
	t.Run("exact_boundary_amounts", func(t *testing.T) {
		for _, amount := range []string{"0.01", "9999999999999.99"} {
			t.Run(amount, func(t *testing.T) {
				s.reset(t, amount)
				id := s.id()
				s.plan(t, 200, false)
				expect(t, s.post(s.intent(id, amount, false), s.token(t, "alice")), 200, "", "")
				s.transaction(t, id, "APPROVED", amount, "", false)
				s.balances(t, "0.00", "0.00")
				s.transactionCount(t, 1)
			})
		}
	})
	for _, status := range []int{503, 504} {
		t.Run(fmt.Sprintf("fraud_%d_compensation", status), func(t *testing.T) {
			s.reset(t, "1000.00")
			id := s.id()
			s.plan(t, status, false)
			r := expect(t, s.post(s.intent(id, "12.30", false), s.token(t, "alice")), 504, "status", "FAILED")
			reason, _ := r.body["reason"].(string)
			if !strings.Contains(reason, "acknowledged") || !strings.Contains(reason, "not independently verified") {
				t.Fatal("compensation must report acknowledgment without asserting verified restoration")
			}
			s.transaction(t, id, "FAILED", "12.30", "", false)
			s.balances(t, "1000.00", "0.00")
			s.assertCalls(t, 1, 0, 1, 1)
			before := s.snapshot(t)
			expect(t, s.recover(id, s.token(t, "alice")), 200, "transaction_state", "FAILED")
			s.unchanged(t, before)
		})
	}
	if s.jwks.Load() == 0 {
		t.Fatal("Quarkus never fetched the synthetic JWKS")
	}
}

func startStack(t *testing.T, jar string) *stack {
	t.Helper()
	if !filepath.IsAbs(jar) {
		t.Fatal("INTERMESH_TEST_ORCHESTRATOR_JAR must be an absolute packaged application path")
	}
	if _, err := os.Stat(jar); err != nil {
		t.Fatal("build the packaged Orchestrator before running integration tests")
	}
	s := &stack{db: testutil.Postgres(t), client: &http.Client{Timeout: 30 * time.Second},
		plans: make(chan *fraudPlan, 16), calls: make(map[string]int)}
	t.Cleanup(s.client.CloseIdleConnections)
	var err error
	s.key, err = rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/realms/intermesh-bank/protocol/openid-connect/certs":
			s.jwks.Add(1)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]string{
				"kty": "RSA", "use": "sig", "alg": "RS256", "kid": "integration-synthetic",
				"n": base64.RawURLEncoding.EncodeToString(s.key.N.Bytes()),
				"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(s.key.E)).Bytes()),
			}}})
		case "/v2/fraud/analyze":
			s.fraud.Add(1)
			select {
			case p := <-s.plans:
				close(p.entered)
				select {
				case <-p.release:
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(p.status)
					io.WriteString(w, `{"fraud_status":"APPROVED"}`)
				case <-r.Context().Done():
				}
			default:
				t.Error("unexpected Fraud call without a test plan")
				http.Error(w, "unplanned synthetic call", 503)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(fixture.Close)
	s.issuer = fixture.URL + "/realms/intermesh-bank"
	router := handler.NewRouter(repository.NewAccountRepository(s.db))
	ledger := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.calls[r.Method+" "+r.URL.Path]++
		s.mu.Unlock()
		router.ServeHTTP(w, r)
	}))
	t.Cleanup(ledger.Close)
	log, err := os.Create(filepath.Join(t.TempDir(), "orchestrator.log"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { log.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, "java", "-Dquarkus.http.host=127.0.0.1", "-Dquarkus.http.port=0",
		"-Dmp.jwt.verify.issuer="+s.issuer, "-Dledger-service/mp-rest/url="+ledger.URL,
		"-Dfraud-service/mp-rest/url="+fixture.URL,
		"-Dintermesh.integration.fixture="+os.Getenv("INTERMESH_TEST_POSTGRES_SOCKET_DIR"), "-jar", jar)
	// Do not inherit application credentials, issuer overrides or external service URLs.
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "LANG=C"}
	cmd.Stdout, cmd.Stderr = log, log
	if err := cmd.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	pidFile := filepath.Join(os.Getenv("INTERMESH_TEST_POSTGRES_SOCKET_DIR"), fmt.Sprintf("orchestrator-%d.pid", cmd.Process.Pid))
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
			os.Remove(pidFile)
		case <-time.After(10 * time.Second):
			t.Error("Orchestrator did not stop")
		}
	})
	if err := os.WriteFile(pidFile, []byte(fmt.Sprint(cmd.Process.Pid)), 0600); err != nil {
		t.Fatal(err)
	}
	address := regexp.MustCompile(`Listening on: (http://127\.0\.0\.1:[0-9]+)`)
	deadline := time.After(45 * time.Second)
	tick := time.NewTicker(25 * time.Millisecond)
	defer tick.Stop()
	for {
		data, err := os.ReadFile(log.Name())
		if err != nil {
			t.Fatal(err)
		}
		if match := address.FindSubmatch(data); match != nil {
			s.url = string(match[1])
			r, err := s.client.Get(s.url + "/hello")
			if err == nil {
				r.Body.Close()
				if r.StatusCode == 200 {
					return s
				}
			}
		}
		select {
		case err := <-done:
			done <- err
			t.Fatalf("packaged Orchestrator exited before readiness: %v", err)
		case <-deadline:
			t.Fatal("packaged Orchestrator did not become ready on loopback")
		case <-tick.C:
		}
	}
}

func (s *stack) token(t *testing.T, owner string) string {
	t.Helper()
	now := time.Now().Unix()
	payload, err := json.Marshal(map[string]any{"iss": s.issuer, "sub": "synthetic-" + owner,
		"preferred_username": owner, "iat": now, "exp": now + 300})
	if err != nil {
		t.Fatal(err)
	}
	input := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT","kid":"integration-synthetic"}`)) + "." + base64.RawURLEncoding.EncodeToString(payload)
	digest := sha256.Sum256([]byte(input))
	signature, err := rsa.SignPKCS1v15(rand.Reader, s.key, crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return input + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func (s *stack) id() string { return fmt.Sprintf("00000000-0000-4000-8000-%012x", s.serial.Add(1)) }

func (s *stack) intent(id, amount string, approval bool) string {
	return fmt.Sprintf(`{"transfer_request_id":%q,"source_account":"SOURCE","target_account":"TEST-DESTINATION","amount":%s,"allowDuplicatePendingTransfer":%t}`, id, amount, approval)
}

func (s *stack) request(method, path, body, token string) reply {
	r, err := http.NewRequest(method, s.url+path, strings.NewReader(body))
	if err != nil {
		return reply{err: err}
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	response, err := s.client.Do(r)
	if err != nil {
		return reply{err: err}
	}
	defer response.Body.Close()
	var data map[string]any
	err = json.NewDecoder(response.Body).Decode(&data)
	// Authentication errors need not have JSON bodies.
	if response.StatusCode == 401 {
		err = nil
	}
	return reply{status: response.StatusCode, body: data, err: err}
}

func (s *stack) post(body, token string) reply {
	return s.request("POST", "/api/v1/transfers", body, token)
}
func (s *stack) recover(id, token string) reply {
	return s.request("GET", "/api/v1/transfer-requests/"+id, "", token)
}

func expect(t *testing.T, r reply, status int, field, value string) reply {
	t.Helper()
	if r.err != nil {
		t.Fatalf("HTTP request failed: %v", r.err)
	}
	if r.status != status || (field != "" && r.body[field] != value) {
		t.Fatalf("unexpected HTTP response: status=%d body=%v; expected %d %s=%s", r.status, r.body, status, field, value)
	}
	return r
}

func (s *stack) plan(t *testing.T, status int, blocked bool) *fraudPlan {
	t.Helper()
	p := &fraudPlan{entered: make(chan struct{}), release: make(chan struct{}), status: status}
	if !blocked {
		p.finish()
	}
	s.plans <- p
	t.Cleanup(p.finish)
	return p
}

func (s *stack) pending(t *testing.T, body, jwt string) *pendingTransfer {
	t.Helper()
	p := s.plan(t, 200, true)
	request := &pendingTransfer{plan: p, done: make(chan struct{})}
	go func() { request.result = s.post(body, jwt); close(request.done) }()
	// Release and join even when an assertion fails, before the next subtest resets SQL.
	t.Cleanup(func() {
		p.finish()
		select {
		case <-request.done:
		case <-time.After(35 * time.Second):
			t.Error("in-flight transfer did not finish")
		}
	})
	select {
	case <-p.entered:
		return request
	case <-request.done:
		t.Fatalf("transfer ended before controlled Fraud request: status=%d err=%v", request.result.status, request.result.err)
	case <-time.After(15 * time.Second):
		t.Fatal("transfer did not reach controlled Fraud request")
	}
	return nil
}

func finish(t *testing.T, request *pendingTransfer) {
	t.Helper()
	request.plan.finish()
	select {
	case <-request.done:
		expect(t, request.result, 200, "", "")
	case <-time.After(15 * time.Second):
		t.Fatal("transfer did not finalize")
	}
}

func (s *stack) exec(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := s.db.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}

func (s *stack) reset(t *testing.T, balance string) {
	t.Helper()
	s.exec(t, `TRUNCATE intermesh_transactions,intermesh_transfer_requests,intermesh_accounts CASCADE`)
	s.exec(t, `INSERT INTO intermesh_accounts (account_id,user_id,iban,holder_name,balance)
		VALUES ('SOURCE','alice','SYNTHETIC-A','Synthetic Alice',$1),('OTHER','bob','SYNTHETIC-B','Synthetic Bob',1000.00)`, balance)
	s.mu.Lock()
	s.calls = make(map[string]int)
	s.mu.Unlock()
	s.fraud.Store(0)
}

func (s *stack) balances(t *testing.T, balance, frozen string) {
	t.Helper()
	var b, f, other string
	if err := s.db.QueryRow(`SELECT balance::text,frozen_balance::text FROM intermesh_accounts WHERE account_id='SOURCE'`).Scan(&b, &f); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow(`SELECT balance::text FROM intermesh_accounts WHERE account_id='OTHER'`).Scan(&other); err != nil {
		t.Fatal(err)
	}
	if b != balance || f != frozen || other != "1000.00" {
		t.Fatalf("unexpected source balance/frozen or destination balance: %s/%s/%s", b, f, other)
	}
}

func (s *stack) transaction(t *testing.T, id, state, amount, parent string, duplicate bool) string {
	t.Helper()
	var tx, gotState, gotAmount, gotParent, decision, issuer, subject, source, destination string
	var approved bool
	if err := s.db.QueryRow(`SELECT t.transaction_id,t.status,t.amount::text,COALESCE(t.ordinary_transaction_id,''),
		t.duplicate_pending_approved,r.admission_status,r.issuer,r.subject,t.source_account_id,t.target_iban
		FROM intermesh_transactions t JOIN intermesh_transfer_requests r USING(transfer_request_id)
		WHERE transfer_request_id=$1`, id).Scan(&tx, &gotState, &gotAmount, &gotParent, &approved, &decision, &issuer, &subject, &source, &destination); err != nil {
		t.Fatal(err)
	}
	if len(tx) != 42 || !strings.HasPrefix(tx, "TX-IM-") || gotState != state || gotAmount != amount || gotParent != parent || approved != duplicate || decision != "ADMITTED" || issuer != s.issuer || subject != "synthetic-alice" || source != "SOURCE" || destination != "TEST-DESTINATION" {
		t.Fatalf("invalid persisted transaction association/state for request %s", id)
	}
	return tx
}

func (s *stack) assertCalls(t *testing.T, freeze, commit, unfreeze, fraud int) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.calls["POST /v1/ledger/freeze"] != freeze || s.calls["POST /v1/ledger/commit"] != commit || s.calls["POST /v1/ledger/unfreeze"] != unfreeze || int(s.fraud.Load()) != fraud {
		t.Fatalf("unexpected financial HTTP call counts: freeze=%d commit=%d unfreeze=%d fraud=%d", s.calls["POST /v1/ledger/freeze"], s.calls["POST /v1/ledger/commit"], s.calls["POST /v1/ledger/unfreeze"], s.fraud.Load())
	}
}

func (s *stack) snapshot(t *testing.T) []string {
	t.Helper()
	var snapshot []string
	for _, table := range []string{"intermesh_accounts", "intermesh_transfer_requests", "intermesh_transactions"} {
		rows, err := s.db.Query("SELECT row_to_json(t)::text FROM " + table + " t ORDER BY 1")
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var row string
			if err := rows.Scan(&row); err != nil {
				rows.Close()
				t.Fatal(err)
			}
			snapshot = append(snapshot, row)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	return snapshot
}

func (s *stack) unchanged(t *testing.T, before []string) {
	t.Helper()
	if !reflect.DeepEqual(before, s.snapshot(t)) {
		t.Fatal("unexpected persisted mutation")
	}
}

func (s *stack) transactionCount(t *testing.T, expected int) {
	t.Helper()
	var count int
	if err := s.db.QueryRow(`SELECT count(*) FROM intermesh_transactions`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != expected {
		t.Fatalf("financial transaction count: got %d, expected %d", count, expected)
	}
}

func (s *stack) ordinary(t *testing.T) {
	s.reset(t, "1000.00")
	jwt := s.token(t, "alice")
	id := s.id()
	body := s.intent(id, "12.30", false)
	s.plan(t, 200, false)
	expect(t, s.post(body, jwt), 200, "", "")
	s.transaction(t, id, "APPROVED", "12.30", "", false)
	s.transactionCount(t, 1)
	s.balances(t, "987.70", "0.00")
	s.assertCalls(t, 1, 1, 0, 1)
	before := s.snapshot(t)
	expect(t, s.post(body, jwt), 200, "status", "REPLAYED")
	expect(t, s.post(s.intent(id, "12.31", false), jwt), 409, "code", "REQUEST_INTENT_CONFLICT")
	expect(t, s.recover(id, jwt), 200, "transaction_state", "APPROVED")
	s.unchanged(t, before)
	s.assertCalls(t, 3, 1, 0, 1)
	other := s.token(t, "bob")
	r := expect(t, s.recover(id, other), 404, "code", "TRANSFER_REQUEST_NOT_FOUND")
	if _, exists := r.body["transaction_id"]; exists {
		t.Fatal("cross-user recovery disclosed financial data")
	}
	expect(t, s.post(body, other), 403, "error", "Access denied")
	expect(t, s.post(body, ""), 401, "", "")
	parts := strings.Split(jwt, ".")
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	signature[0] ^= 1
	parts[2] = base64.RawURLEncoding.EncodeToString(signature)
	expect(t, s.post(body, strings.Join(parts, ".")), 401, "", "")
	s.unchanged(t, before)
	s.assertCalls(t, 3, 1, 0, 1)
}

func (s *stack) cycle(t *testing.T, first string) {
	s.reset(t, "1000.00")
	jwt := s.token(t, "alice")
	rootID := s.id()
	rootBody := s.intent(rootID, "12.30", false)
	root := s.pending(t, rootBody, jwt)
	rootTx := s.transaction(t, rootID, "PENDING", "12.30", "", false)
	s.transactionCount(t, 1)
	s.balances(t, "987.70", "12.30")
	before := s.snapshot(t)
	expect(t, s.post(rootBody, jwt), 200, "transaction_state", "PENDING")
	expect(t, s.recover(rootID, jwt), 200, "transaction_state", "PENDING")
	s.unchanged(t, before)
	rejectedID := s.id()
	rejected := s.intent(rejectedID, "12.30", false)
	expect(t, s.post(rejected, jwt), 409, "rejection_code", "DUPLICATE_APPROVAL_REQUIRED")
	childID := s.id()
	childBody := s.intent(childID, "12.30", true)
	child := s.pending(t, childBody, jwt)
	s.transaction(t, childID, "PENDING", "12.30", rootTx, true)
	s.transactionCount(t, 2)
	s.balances(t, "975.40", "24.60")
	expect(t, s.post(s.intent(s.id(), "12.30", true), jwt), 409, "rejection_code", "DUPLICATE_EXCEPTION_USED")
	if first == "duplicate" {
		finish(t, child)
		s.transaction(t, childID, "APPROVED", "12.30", rootTx, true)
		expect(t, s.post(s.intent(s.id(), "12.30", true), jwt), 409, "rejection_code", "DUPLICATE_EXCEPTION_USED")
	} else {
		finish(t, root)
		s.transaction(t, rootID, "APPROVED", "12.30", "", false)
		expect(t, s.post(s.intent(s.id(), "12.30", true), jwt), 409, "rejection_code", "ACTIVE_CYCLE_BLOCKED")
	}
	s.balances(t, "975.40", "12.30")
	expect(t, s.post(childBody, jwt), 200, "status", "REPLAYED")
	if first == "duplicate" {
		finish(t, root)
	} else {
		finish(t, child)
	}
	s.balances(t, "975.40", "0.00")
	s.transaction(t, rootID, "APPROVED", "12.30", "", false)
	s.transaction(t, childID, "APPROVED", "12.30", rootTx, true)
	before = s.snapshot(t)
	expect(t, s.post(rejected, jwt), 409, "rejection_code", "DUPLICATE_APPROVAL_REQUIRED")
	expect(t, s.recover(rejectedID, jwt), 200, "admission_status", "REJECTED")
	s.unchanged(t, before)
	s.assertCalls(t, 8, 2, 0, 2)
	next := s.id()
	s.plan(t, 200, false)
	expect(t, s.post(s.intent(next, "12.30", false), jwt), 200, "", "")
	s.transaction(t, next, "APPROVED", "12.30", "", false)
	s.balances(t, "963.10", "0.00")
	var count, children int
	if err := s.db.QueryRow(`SELECT count(*),count(*) FILTER (WHERE ordinary_transaction_id=$1) FROM intermesh_transactions`, rootTx).Scan(&count, &children); err != nil {
		t.Fatal(err)
	}
	if count != 3 || children != 1 {
		t.Fatal("unexpected transactions or duplicate count after cycle closure")
	}
}

func (s *stack) invalidRequests(t *testing.T) {
	s.reset(t, "1000.00")
	jwt := s.token(t, "alice")
	before := s.snapshot(t)
	for _, amount := range []string{"0", "-0.01", "null", `"12.30"`, "true", "0.001", "10000000000000.00", "NaN", "Infinity", "1e1025"} {
		t.Run(amount, func(t *testing.T) { expect(t, s.post(s.intent(s.id(), amount, false), jwt), 400, "", "") })
	}
	valid := s.intent(s.id(), "12.30", false)
	for _, body := range []string{`{`, strings.Replace(valid, `"amount":12.30,`, "", 1), strings.Replace(valid, `false`, `"false"`, 1), strings.Replace(valid, `"transfer_request_id":`, `"amount":12.30,"transfer_request_id":`, 1), s.intent("not-a-uuid", "12.30", false)} {
		expect(t, s.post(body, jwt), 400, "", "")
	}
	s.unchanged(t, before)
	s.assertCalls(t, 0, 0, 0, 0)
}
