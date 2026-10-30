package handler

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"intermesh-ledger/internal/dto"
	"intermesh-ledger/internal/repository"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type monetaryCase struct {
	token, canonical string
}

var validAmounts = []monetaryCase{
	{"1", "1.00"}, {"12.3", "12.30"}, {"12.30", "12.30"}, {"12.3000", "12.30"},
	{"0.01", "0.01"}, {"9999999999999.99", "9999999999999.99"},
	{"1e0", "1.00"}, {"123e-1", "12.30"}, {"100e-4", "0.01"},
}

var invalidAmounts = []string{
	"-1", "-0.01", "null", `"12.30"`, `"NaN"`, `"Infinity"`, "true", "false", "[]", "{}",
	"12.345", "1.00000000000000001", "9999999999999.9901", "10000000000000",
	"1e-3", "1e13", "NaN", "Infinity", "-Infinity", "1e999999999999999999999",
	"1e-999999999999999999999", "0e1025", "1e1025", "1e-1025", "01", ".1", "1.", "1e", "",
}

func monetaryBody(field, token string) string {
	return `{"account_id":"ACC-TEST","target_account":"TEST-IBAN","user_id":"test-user","holder_name":"Test","` + field + `":` + token + `}`
}

func TestMonetaryWriteValidation(t *testing.T) {
	for _, endpoint := range []string{"accounts", "freeze", "commit", "unfreeze"} {
		t.Run(endpoint, func(t *testing.T) {
			field := "amount"
			if endpoint == "accounts" {
				field = "initial_deposit"
			}
			cases := append([]string{}, invalidAmounts...)
			cases = append(cases, strings.Repeat("1", 257))
			if endpoint != "accounts" {
				cases = append(cases, "0", "0.00", "-0.00", "0e2")
			}
			var bodies []string
			for _, token := range cases {
				bodies = append(bodies, monetaryBody(field, token))
			}
			bodies = append(bodies, `{}`, `null`, `[]`, `true`, ``, `{`,
				monetaryBody(field, "1")+` garbage`, monetaryBody(field, "1")+` {}`,
				monetaryBody(field, "1")+strings.Repeat(" ", 64<<10))
			for i, body := range bodies {
				t.Run(fmt.Sprint(i), func(t *testing.T) {
					state, db, handler := testLedger(t)
					defer db.Close()
					response := serveWrite(handler, endpoint, body)
					if response.Code != http.StatusBadRequest || strings.TrimSpace(response.Body.String()) != `{"error":"Invalid monetary request"}` {
						t.Fatalf("expected sanitized 400, got %d %s", response.Code, response.Body.String())
					}
					if state.calls != 0 {
						t.Fatalf("invalid request reached SQL: %d calls", state.calls)
					}
				})
			}
		})
	}
}

func TestValidMonetaryWritesUseExactSQLParameters(t *testing.T) {
	for _, endpoint := range []string{"accounts", "freeze", "commit", "unfreeze"} {
		cases := append([]monetaryCase{}, validAmounts...)
		field := "amount"
		if endpoint == "accounts" {
			field = "initial_deposit"
			cases = append(cases, monetaryCase{"0", "0.00"}, monetaryCase{"0.00", "0.00"})
		}
		for _, tc := range cases {
			t.Run(endpoint+"/"+tc.token, func(t *testing.T) {
				state, db, handler := testLedger(t)
				defer db.Close()
				response := serveWrite(handler, endpoint, monetaryBody(field, tc.token))
				wantStatus := 200
				if endpoint == "accounts" {
					wantStatus = 201
				}
				if response.Code != wantStatus {
					t.Fatalf("expected %d, got %d %s", wantStatus, response.Code, response.Body.String())
				}
				wantParameters := 1
				if endpoint == "freeze" {
					wantParameters = 2
				}
				if len(state.amounts) != wantParameters {
					t.Fatalf("amount parameters: got %v", state.amounts)
				}
				for _, amount := range state.amounts {
					if amount != tc.canonical {
						t.Fatalf("inexact SQL parameter: %q, expected %q", amount, tc.canonical)
					}
				}
			})
		}
	}
}

func TestAmountPresenceAndJSONRepresentation(t *testing.T) {
	var missing dto.Amount
	if missing.Valid(true) {
		t.Fatal("missing value must not be explicit zero")
	}
	if _, err := missing.Value(); err == nil {
		t.Fatal("missing value must not be a SQL parameter")
	}
	for _, tc := range append(validAmounts, monetaryCase{"0", "0.00"}) {
		var amount dto.Amount
		if err := json.Unmarshal([]byte(tc.token), &amount); err != nil {
			t.Fatal(err)
		}
		body, err := json.Marshal(amount)
		if err != nil || string(body) != tc.canonical {
			t.Fatalf("expected numeric JSON %s, got %s (%v)", tc.canonical, body, err)
		}
	}
}

func serveWrite(h *LedgerHandler, endpoint, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/v1/ledger/"+endpoint, strings.NewReader(body))
	w := httptest.NewRecorder()
	switch endpoint {
	case "accounts":
		h.HandleCreateAccount(w, r)
	case "freeze":
		h.HandleFreeze(w, r)
	case "commit":
		h.HandleCommit(w, r)
	case "unfreeze":
		h.HandleUnfreeze(w, r)
	}
	return w
}

// This driver exercises database/sql's real Valuer conversion, without a server.
type recordingSQL struct {
	calls   int
	amounts []string
}

type recordingConnector struct{ state *recordingSQL }
type recordingDriver struct{}
type recordingConn struct{ state *recordingSQL }
type recordingTx struct{}
type recordingRows struct {
	value driver.Value
	done  bool
}

func testLedger(t *testing.T) (*recordingSQL, *sql.DB, *LedgerHandler) {
	t.Helper()
	state := &recordingSQL{}
	db := sql.OpenDB(recordingConnector{state})
	return state, db, NewLedgerHandler(repository.NewAccountRepository(db))
}

func (c recordingConnector) Connect(context.Context) (driver.Conn, error) {
	return recordingConn{c.state}, nil
}
func (c recordingConnector) Driver() driver.Driver       { return recordingDriver{} }
func (recordingDriver) Open(string) (driver.Conn, error) { return nil, errors.New("use connector") }
func (recordingConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("unexpected prepare")
}
func (recordingConn) Close() error              { return nil }
func (recordingConn) Begin() (driver.Tx, error) { return recordingTx{}, nil }
func (recordingTx) Commit() error               { return nil }
func (recordingTx) Rollback() error             { return nil }

func (c recordingConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.state.calls++
	index := -1
	switch {
	case strings.Contains(query, "INSERT INTO intermesh_accounts"):
		index = 4
	case strings.Contains(query, "INSERT INTO intermesh_transactions"):
		index = 3
	case strings.Contains(query, "UPDATE intermesh_accounts"):
		index = 1
	}
	if index >= 0 {
		amount, ok := args[index].Value.(string)
		if !ok {
			return nil, errors.New("monetary SQL parameter must be decimal text")
		}
		c.state.amounts = append(c.state.amounts, amount)
	}
	return driver.RowsAffected(1), nil
}

func (c recordingConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	c.state.calls++
	if strings.Contains(query, "NEXTVAL") {
		return &recordingRows{value: int64(4000)}, nil
	}
	return &recordingRows{value: "TX-TEST"}, nil
}

func (*recordingRows) Columns() []string { return []string{"value"} }
func (*recordingRows) Close() error      { return nil }
func (r *recordingRows) Next(values []driver.Value) error {
	if r.done {
		return io.EOF
	}
	values[0], r.done = r.value, true
	return nil
}
