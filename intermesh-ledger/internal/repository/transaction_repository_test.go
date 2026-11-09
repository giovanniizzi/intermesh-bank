package repository

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"intermesh-ledger/internal/dto"
	"io"
	"strings"
	"testing"
)

func TestReferenceValidationBeforeSQL(t *testing.T) {
	repo := NewAccountRepository(nil)
	valid := dto.TransactionReference{TransactionID: "TX-IM-legacy", AccountID: "SOURCE", Amount: exactAmount(t, "12.30")}
	for _, ref := range []dto.TransactionReference{
		{}, {TransactionID: valid.TransactionID, AccountID: valid.AccountID},
		{TransactionID: " ", AccountID: valid.AccountID, Amount: valid.Amount},
		{TransactionID: strings.Repeat("x", 51), AccountID: valid.AccountID, Amount: valid.Amount},
		{TransactionID: valid.TransactionID, AccountID: "", Amount: valid.Amount},
		{TransactionID: valid.TransactionID, AccountID: valid.AccountID, Amount: exactAmount(t, "0")},
	} {
		for _, restore := range []bool{false, true} {
			if err := repo.finalizeTransaction(ref, restore); !errors.Is(err, ErrInvalidTransactionReference) {
				t.Fatalf("invalid reference must fail before database access: %v", err)
			}
		}
	}

}

func TestFinalizationSQLContract(t *testing.T) {
	for _, restore := range []bool{false, true} {
		state := &scriptState{t: t, failStep: -1, restore: restore}
		db := sql.OpenDB(scriptConnector{state})
		repo := NewAccountRepository(db)
		ref := dto.TransactionReference{TransactionID: "TX-IM-legacy", AccountID: "SOURCE", Amount: exactAmount(t, "12.30")}
		if restore {
			if err := repo.RollbackReferencedTransaction(ref); err != nil {
				t.Fatal(err)
			}
		} else {
			if id, err := repo.CommitReferencedTransaction(ref); err != nil || id != ref.TransactionID {
				t.Fatalf("%q %v", id, err)
			}
		}
		if state.step != 6 || state.rolledBack {
			t.Fatalf("incorrect transaction lifecycle: %+v", state)
		}
		db.Close()
	}
}

func TestFinalizationSQLFailures(t *testing.T) {
	for _, restore := range []bool{false, true} {
		for _, tc := range []struct {
			name string
			step int
			err  error
			rows driver.Result
			want error
		}{
			{"begin", 0, errors.New("synthetic begin"), nil, ErrTransactionInfrastructure},
			{"account query", 1, errors.New("synthetic query"), nil, ErrTransactionInfrastructure},
			{"account missing", 1, io.EOF, nil, ErrTransactionNotFound},
			{"transaction query", 2, errors.New("synthetic query"), nil, ErrTransactionInfrastructure},
			{"transaction missing", 2, io.EOF, nil, ErrTransactionNotFound},
			{"balance SQL", 3, errors.New("synthetic update"), nil, ErrTransactionInfrastructure},
			{"balance zero rows", 3, nil, driver.RowsAffected(0), ErrTransactionConflict},
			{"balance excess rows", 3, nil, driver.RowsAffected(2), ErrTransactionInfrastructure},
			{"balance count error", 3, nil, failedRowCount{}, ErrTransactionInfrastructure},
			{"status SQL", 4, errors.New("synthetic update"), nil, ErrTransactionInfrastructure},
			{"status zero rows", 4, nil, driver.RowsAffected(0), ErrTransactionInfrastructure},
			{"status excess rows", 4, nil, driver.RowsAffected(2), ErrTransactionInfrastructure},
			{"status count error", 4, nil, failedRowCount{}, ErrTransactionInfrastructure},
			{"commit", 5, errors.New("synthetic commit"), nil, ErrTransactionInfrastructure},
		} {
			t.Run(tc.name+map[bool]string{false: "/commit", true: "/unfreeze"}[restore], func(t *testing.T) {
				state := &scriptState{t: t, failStep: tc.step, fail: tc.err, result: tc.rows, restore: restore}
				db := sql.OpenDB(scriptConnector{state})
				defer db.Close()
				ref := dto.TransactionReference{TransactionID: "TX-IM-legacy", AccountID: "SOURCE", Amount: exactAmount(t, "12.30")}
				if err := NewAccountRepository(db).finalizeTransaction(ref, restore); !errors.Is(err, tc.want) {
					t.Fatalf("got %v, want %v", err, tc.want)
				}
				if state.step != tc.step+1 {
					t.Fatalf("SQL continued after failure: %d steps", state.step)
				}
				wantRollback := tc.step > 0 && tc.step < 5
				if state.rolledBack != wantRollback {
					t.Fatalf("rollback=%t, want %t", state.rolledBack, wantRollback)
				}
			})
		}
	}
}

// Exercises database/sql conversion and ordered SQL without external mocks.
type scriptState struct {
	t          *testing.T
	step       int
	failStep   int
	fail       error
	result     driver.Result
	restore    bool
	rolledBack bool
}

func (s *scriptState) next() (bool, error) {
	fail := s.step == s.failStep
	s.step++
	if fail {
		return true, s.fail
	}
	return false, nil
}

type scriptConnector struct{ state *scriptState }
type scriptDriver struct{}
type scriptConn struct{ state *scriptState }
type scriptTx struct{ state *scriptState }
type scriptRows struct{ values []driver.Value }
type failedRowCount struct{}

func (failedRowCount) LastInsertId() (int64, error) { return 0, errors.New("unsupported") }
func (failedRowCount) RowsAffected() (int64, error) { return 0, errors.New("synthetic row count") }
func (c scriptConnector) Connect(context.Context) (driver.Conn, error) {
	return scriptConn{c.state}, nil
}
func (scriptConnector) Driver() driver.Driver          { return scriptDriver{} }
func (scriptDriver) Open(string) (driver.Conn, error)  { return nil, errors.New("use connector") }
func (scriptConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("unexpected prepare") }
func (scriptConn) Close() error                        { return nil }
func (c scriptConn) Begin() (driver.Tx, error) {
	_, err := c.state.next()
	return scriptTx{c.state}, err
}
func (tx scriptTx) Commit() error   { _, err := tx.state.next(); return err }
func (tx scriptTx) Rollback() error { tx.state.rolledBack = true; return nil }
func (c scriptConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	s := c.state
	step := s.step
	if !strings.Contains(query, "FOR UPDATE") {
		s.t.Fatal("row locks required")
	}
	values := []driver.Value{"SOURCE"}
	if step == 1 {
		if !strings.Contains(query, "FROM intermesh_accounts") || len(args) != 1 || args[0].Value != "SOURCE" {
			s.t.Fatal("must lock requested account first")
		}
	} else if step == 2 {
		if !strings.Contains(query, "source_account_id = $2") || len(args) != 3 || args[0].Value != "TX-IM-legacy" || args[1].Value != "SOURCE" || args[2].Value != "12.30" {
			s.t.Fatal("must lock matching transaction with exact decimal parameter")
		}
		values = []driver.Value{"PENDING", true}
	} else {
		s.t.Fatalf("unexpected query at step %d", step)
	}
	_, err := s.next()
	if err == io.EOF {
		return &scriptRows{}, nil
	}
	return &scriptRows{values: values}, err
}
func (c scriptConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	s := c.state
	if s.step == 3 {
		if !strings.Contains(query, "a.frozen_balance - t.amount") || len(args) != 2 || args[0].Value != "SOURCE" || args[1].Value != "TX-IM-legacy" {
			s.t.Fatal("balance arithmetic must use the recorded transaction amount")
		}
		if strings.Contains(query, "balance = a.balance + t.amount") != s.restore {
			s.t.Fatal("incorrect balance operation")
		}
	} else if s.step == 4 {
		status := "APPROVED"
		if s.restore {
			status = "FAILED"
		}
		if !strings.Contains(query, "transaction_id = $1 AND source_account_id = $2 AND status = 'PENDING'") || len(args) != 3 || args[2].Value != status {
			s.t.Fatal("status update must target one pending transaction")
		}
	} else {
		s.t.Fatalf("unexpected update at step %d", s.step)
	}
	fail, err := s.next()
	if fail && s.result != nil {
		return s.result, err
	}
	return driver.RowsAffected(1), err
}
func (r *scriptRows) Columns() []string {
	if len(r.values) == 2 {
		return []string{"status", "amount_matches"}
	}
	return []string{"account_id"}
}
func (*scriptRows) Close() error { return nil }
func (r *scriptRows) Next(values []driver.Value) error {
	if r.values == nil {
		return io.EOF
	}
	copy(values, r.values)
	r.values = nil
	return nil
}
