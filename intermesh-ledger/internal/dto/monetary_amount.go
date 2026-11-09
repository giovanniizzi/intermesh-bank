package dto

import (
	"bytes"
	"database/sql/driver"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Amount is an explicitly supplied, nonnegative NUMERIC(15,2) value.
// Its zero value represents a missing property, not an explicit monetary zero.
type Amount struct {
	cents   int64
	present bool
}

var amountToken = regexp.MustCompile(`^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$`)
var errInvalidAmount = errors.New("invalid monetary amount")

func (a *Amount) UnmarshalJSON(data []byte) error {
	*a = Amount{}
	data = bytes.TrimSpace(data)
	if len(data) == 0 || len(data) > 256 {
		return errInvalidAmount
	}
	parts := amountToken.FindStringSubmatch(string(data))
	if parts == nil {
		return errInvalidAmount
	}
	exponent := 0
	if parts[4] != "" {
		var err error
		exponent, err = strconv.Atoi(parts[4])
		if err != nil || exponent < -1024 || exponent > 1024 {
			return errInvalidAmount
		}
	}
	digits := strings.TrimLeft(parts[2]+parts[3], "0")
	if digits == "" {
		a.present = true
		return nil
	}
	if parts[1] == "-" {
		return errInvalidAmount
	}
	power := exponent - len(parts[3]) + 2
	if power < 0 {
		remove := -power
		if remove >= len(digits) || !strings.HasSuffix(digits, strings.Repeat("0", remove)) {
			return errInvalidAmount
		}
		digits = digits[:len(digits)-remove]
	} else {
		if len(digits)+power > 15 {
			return errInvalidAmount
		}
		digits += strings.Repeat("0", power)
	}
	if len(digits) > 15 {
		return errInvalidAmount
	}
	cents, err := strconv.ParseInt(digits, 10, 64)
	if err != nil {
		return errInvalidAmount
	}
	a.cents, a.present = cents, true
	return nil
}

func (a Amount) Valid(allowZero bool) bool {
	return a.present && (allowZero || a.cents > 0)
}

func (a Amount) decimal() string {
	return fmt.Sprintf("%d.%02d", a.cents/100, a.cents%100)
}

// Value keeps database/sql parameters decimal-exact without changing the SQL.
func (a Amount) Value() (driver.Value, error) {
	if !a.Valid(true) {
		return nil, errInvalidAmount
	}
	return a.decimal(), nil
}

func (a Amount) MarshalJSON() ([]byte, error) {
	if !a.Valid(true) {
		return nil, errInvalidAmount
	}
	return []byte(a.decimal()), nil
}

// Float64 is used only for the existing account response representation.
func (a Amount) Float64() float64 {
	return float64(a.cents) / 100
}
