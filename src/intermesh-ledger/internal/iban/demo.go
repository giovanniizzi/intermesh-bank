// Package iban generates synthetic account identifiers for the demo.
package iban

import (
	"fmt"
	"regexp"
)

// National structures follow the SWIFT IBAN Registry (release 103).
// These identifiers are test data, not verified bank accounts.
var structures = map[string]*regexp.Regexp{
	"IT": regexp.MustCompile(`^IT[0-9]{2}[A-Z][0-9]{10}[A-Z0-9]{12}$`),
	"DE": regexp.MustCompile(`^DE[0-9]{20}$`),
}

// Demo preserves the historical Italian bank, branch and numeric account offset.
// German demo accounts use an eight-digit bank code and ten-digit account number.
func Demo(country string, serial int64) (string, error) {
	var body string
	switch country {
	case "IT":
		if serial < 1 || serial > 999899999999 {
			return "", fmt.Errorf("demo IBAN serial out of range")
		}
		body = fmt.Sprintf("0306905000%012d", 100000000+serial)
		body = string(italianCIN(body)) + body
	case "DE":
		if serial < 1 || serial > 9899999999 {
			return "", fmt.Errorf("demo IBAN serial out of range")
		}
		body = fmt.Sprintf("03069050%010d", 100000000+serial)
	default:
		return "", fmt.Errorf("unsupported demo IBAN country")
	}
	value := fmt.Sprintf("%s%02d%s", country, 98-mod97(body+country+"00"), body)
	if !ValidDemo(value) {
		return "", fmt.Errorf("invalid generated demo IBAN")
	}
	return value, nil
}

// ValidDemo validates normalized Italian and German identifiers. Recipient input
// supports other registered countries in the UI; this is not a recipient lookup.
func ValidDemo(value string) bool {
	if len(value) < 2 {
		return false
	}
	pattern, ok := structures[value[:2]]
	if !ok || !pattern.MatchString(value) || mod97(value[4:]+value[:4]) != 1 {
		return false
	}
	return value[:2] != "IT" || value[4] == italianCIN(value[5:])
}

func mod97(value string) int {
	remainder := 0
	for _, c := range value {
		if c >= 'A' && c <= 'Z' {
			remainder = (remainder*100 + int(c-'A') + 10) % 97
		} else {
			remainder = (remainder*10 + int(c-'0')) % 97
		}
	}
	return remainder
}

func italianCIN(body string) byte {
	odd := [...]int{1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23}
	sum := 0
	for i, c := range body {
		value := int(c - '0')
		if c >= 'A' {
			value = int(c - 'A')
		}
		if i%2 == 0 {
			value = odd[value]
		}
		sum += value
	}
	return byte('A' + sum%26)
}
