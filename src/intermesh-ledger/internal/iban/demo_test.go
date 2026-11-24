package iban

import (
	"math"
	"testing"
)

func TestDemoGeneration(t *testing.T) {
	for _, tc := range []struct {
		country string
		serial  int64
		want    string
	}{
		{"IT", 1001, "IT29B0306905000000100001001"},
		{"DE", 2002, "DE72030690500100002002"},
		{"IT", 3003, "IT40K0306905000000100003003"},
		{"IT", 4000, "IT83J0306905000000100004000"},
		{"IT", 4001, "IT60K0306905000000100004001"},
	} {
		got, err := Demo(tc.country, tc.serial)
		if err != nil || got != tc.want || !ValidDemo(got) {
			t.Fatalf("%s/%d: got %q (%v), want %q", tc.country, tc.serial, got, err, tc.want)
		}
		again, _ := Demo(tc.country, tc.serial)
		if got != again {
			t.Fatal("IBAN generation is not deterministic")
		}
	}
}

func TestDemoLengthAndUniqueness(t *testing.T) {
	for country, maximum := range map[string]int64{"IT": 999899999999, "DE": 9899999999} {
		seen := make(map[string]bool)
		for _, serial := range []int64{1, 2, 1001, 2002, 3003, 4000, 4001, 9999, 10000, 99999, 100000, maximum} {
			value, err := Demo(country, serial)
			if err != nil || seen[value] || !ValidDemo(value) || len(value) != map[string]int{"IT": 27, "DE": 22}[country] {
				t.Fatalf("invalid or duplicate IBAN: %s/%d: %q (%v)", country, serial, value, err)
			}
			again, err := Demo(country, serial)
			if err != nil || again != value {
				t.Fatal("generation is not deterministic")
			}
			seen[value] = true
		}
		for _, serial := range []int64{0, -1, maximum + 1, math.MaxInt64} {
			if value, err := Demo(country, serial); err == nil || value != "" {
				t.Fatalf("invalid serial accepted: %s/%d", country, serial)
			}
		}
	}
	if _, err := Demo("GB", 4000); err == nil {
		t.Fatal("unsupported account generation country accepted")
	}
}

func TestNationalStructureAndCheckDigits(t *testing.T) {
	for _, value := range []string{"IT60X0542811101000000123456", "DE89370400440532013000"} {
		if !ValidDemo(value) {
			t.Fatalf("published registry example rejected: %s", value)
		}
	}
	// Recalculate international digits around a wrong CIN to isolate the domestic check.
	wrongCIN := "A0306905000000100001001"
	wrongCIN = "IT" + twoDigits(98-mod97(wrongCIN+"IT00")) + wrongCIN
	for _, value := range []string{"", "IT", "DE00", "GB29NWBK60161331926819", wrongCIN,
		"IT99X0306905000000100001001", "DE880306905000000100002002", "IT99X0306905000000100003003",
		"IT29B0306905000000100001002", "DE720306905001000020020", "DE72A30690500100002002",
		"de72030690500100002002", "DE72 030690500100002002"} {
		if ValidDemo(value) {
			t.Fatalf("invalid normalized demo IBAN accepted: %q", value)
		}
	}
}

func twoDigits(value int) string {
	return string([]byte{byte('0' + value/10), byte('0' + value%10)})
}
