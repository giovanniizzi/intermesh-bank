package repository_test

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"intermesh-ledger/internal/dto"
	"intermesh-ledger/internal/handler"
	"intermesh-ledger/internal/repository"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestHistoryRepositoryAndHTTPContract(t *testing.T) {
	queryFailure := errors.New("synthetic query failure")
	iterationFailure := errors.New("synthetic iteration failure")
	closeFailure := errors.New("synthetic close failure")
	first := dto.TransactionHistoryDTO{TransactionID: "TX-A", TargetIBAN: "TEST-IBAN-A", Amount: 12.30,
		Status: "APPROVED", Timestamp: "2026-11-23 12:30:00"}
	second := dto.TransactionHistoryDTO{TransactionID: "TX-B", TargetIBAN: "TEST-IBAN-B", Amount: 0.01,
		Status: "PENDING", Timestamp: "2026-11-22 10:00:00"}
	row := func(tx dto.TransactionHistoryDTO) []driver.Value {
		return []driver.Value{tx.TransactionID, tx.TargetIBAN, tx.Amount, tx.Status, tx.Timestamp}
	}
	for _, tc := range []struct {
		name     string
		rows     [][]driver.Value
		queryErr error
		nextErr  error
		closeErr error
		want     []dto.TransactionHistoryDTO
		wantErr  error
		scanErr  bool
	}{
		{name: "empty", want: []dto.TransactionHistoryDTO{}},
		{name: "one", rows: [][]driver.Value{row(first)}, want: []dto.TransactionHistoryDTO{first}},
		{name: "multiple", rows: [][]driver.Value{row(first), row(second)}, want: []dto.TransactionHistoryDTO{first, second}},
		{name: "query error", queryErr: queryFailure, wantErr: queryFailure},
		{name: "scan error after valid row", rows: [][]driver.Value{row(first), {"TX-B", "TEST-IBAN-B", "invalid amount", "PENDING", second.Timestamp}}, scanErr: true},
		{name: "iteration error before rows", nextErr: iterationFailure, wantErr: iterationFailure},
		{name: "iteration error after valid row", rows: [][]driver.Value{row(first)}, nextErr: iterationFailure, wantErr: iterationFailure},
		{name: "close error at end of rows", rows: [][]driver.Value{row(first)}, closeErr: closeFailure, wantErr: closeFailure},
	} {
		for _, throughHTTP := range []bool{false, true} {
			layer := "repository"
			if throughHTTP {
				layer = "handler"
			}
			t.Run(tc.name+"/"+layer, func(t *testing.T) {
				state := &historyFixture{rows: tc.rows, queryErr: tc.queryErr, nextErr: tc.nextErr, closeErr: tc.closeErr}
				db := sql.OpenDB(historyConnector{state})
				t.Cleanup(func() { db.Close() })
				repo := repository.NewAccountRepository(db)
				failed := tc.wantErr != nil || tc.scanErr
				if throughHTTP {
					mux := http.NewServeMux()
					mux.HandleFunc("GET /v1/ledger/account/{id}/transactions", handler.NewLedgerHandler(repo).HandleHistory)
					response := httptest.NewRecorder()
					mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/ledger/account/ACC-TEST/transactions", nil))
					if failed {
						if response.Code != http.StatusInternalServerError || response.Body.Len() != 0 {
							t.Fatalf("expected existing sanitized 500 response, got %d %q", response.Code, response.Body.String())
						}
					} else {
						wantJSON, err := json.Marshal(tc.want)
						if err != nil {
							t.Fatal(err)
						}
						if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "application/json" || strings.TrimSpace(response.Body.String()) != string(wantJSON) {
							t.Fatalf("unexpected history response: status=%d type=%q body=%q", response.Code, response.Header().Get("Content-Type"), response.Body.String())
						}
					}
				} else {
					history, err := repo.GetHistory("ACC-TEST")
					if failed {
						if err == nil || history != nil {
							t.Fatalf("read failure must propagate without partial history: history=%v err=%v", history, err)
						}
						if tc.wantErr != nil && !errors.Is(err, tc.wantErr) {
							t.Fatalf("expected %v, got %v", tc.wantErr, err)
						}
						if tc.scanErr && !strings.Contains(err.Error(), "converting driver.Value") {
							t.Fatalf("expected database/sql scan error, got %v", err)
						}
					} else if err != nil || !reflect.DeepEqual(history, tc.want) {
						t.Fatalf("unexpected history: got %#v (%v), want %#v", history, err, tc.want)
					}
				}
				if len(state.args) != 1 || state.args[0].Value != "ACC-TEST" || !strings.Contains(state.query, "WHERE source_account_id = $1 ORDER BY timestamp DESC") {
					t.Fatalf("history query scope/order changed: %s %v", state.query, state.args)
				}
				if tc.queryErr == nil && !state.closed {
					t.Fatal("history rows were not closed")
				}
			})
		}
	}
}

// Exercise database/sql scanning and iteration without a PostgreSQL dependency.
type historyFixture struct {
	rows     [][]driver.Value
	queryErr error
	nextErr  error
	closeErr error
	query    string
	args     []driver.NamedValue
	closed   bool
}

type historyConnector struct{ state *historyFixture }
type historyDriver struct{}
type historyConn struct{ state *historyFixture }
type historyRows struct {
	state *historyFixture
	index int
}

func (c historyConnector) Connect(context.Context) (driver.Conn, error) {
	return historyConn{c.state}, nil
}
func (historyConnector) Driver() driver.Driver          { return historyDriver{} }
func (historyDriver) Open(string) (driver.Conn, error)  { return nil, errors.New("use connector") }
func (historyConn) Close() error                        { return nil }
func (historyConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("unexpected prepare") }
func (historyConn) Begin() (driver.Tx, error)           { return nil, errors.New("unexpected transaction") }
func (c historyConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	c.state.query, c.state.args = query, args
	if c.state.queryErr != nil {
		return nil, c.state.queryErr
	}
	return &historyRows{state: c.state}, nil
}
func (*historyRows) Columns() []string {
	return []string{"transaction_id", "target_iban", "amount", "status", "timestamp"}
}
func (r *historyRows) Close() error { r.state.closed = true; return r.state.closeErr }
func (r *historyRows) Next(values []driver.Value) error {
	if r.index == len(r.state.rows) {
		if r.state.nextErr != nil {
			return r.state.nextErr
		}
		return io.EOF
	}
	copy(values, r.state.rows[r.index])
	r.index++
	return nil
}
