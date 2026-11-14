// json.go — JSON body parsing and serialization helpers with JavaScript
// semantics where they differ from Go's encoding/json (HTML escaping off,
// JS Number() parsing for path/query values).
package main

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// marshalJSON serializes v like JSON.stringify: no HTML escaping.
func marshalJSON(v interface{}) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	// Encoder adds a trailing newline; strip it.
	if err := enc.Encode(v); err != nil {
		return []byte("null")
	}
	b := buf.Bytes()
	if len(b) > 0 && b[len(b)-1] == '\n' {
		b = b[:len(b)-1]
	}
	return b
}

// parseJSONBody parses a request body as JSON. An empty body counts as {}.
func parseJSONBody(raw []byte) (interface{}, bool) {
	if len(raw) == 0 {
		return map[string]interface{}{}, true
	}
	var v interface{}
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, false
	}
	return v, true
}

// parseJSONObject parses the body as a JSON object, coercing null/scalar to {}.
func parseJSONObject(raw []byte) (map[string]interface{}, bool) {
	v, ok := parseJSONBody(raw)
	if !ok {
		return nil, false
	}
	if v == nil {
		return map[string]interface{}{}, true
	}
	m, ok := v.(map[string]interface{})
	if !ok {
		return map[string]interface{}{}, true
	}
	return m, true
}

func asObj(v interface{}) map[string]interface{} {
	m, _ := v.(map[string]interface{})
	return m
}

func getStr(m map[string]interface{}, k string) (string, bool) {
	if m == nil {
		return "", false
	}
	s, ok := m[k].(string)
	return s, ok
}

func getStrOr(m map[string]interface{}, k, def string) string {
	if s, ok := getStr(m, k); ok {
		return s
	}
	return def
}

func getBool(m map[string]interface{}, k string) bool {
	if m == nil {
		return false
	}
	b, _ := m[k].(bool)
	return b
}

func getNum(m map[string]interface{}, k string) (float64, bool) {
	if m == nil {
		return 0, false
	}
	f, ok := m[k].(float64)
	return f, ok
}

// jsNumber mirrors JavaScript's Number(s): trims whitespace, "" -> 0,
// hex supported, anything else NaN.
func jsNumber(s string) float64 {
	t := strings.TrimSpace(s)
	if t == "" {
		return 0
	}
	if t == "Infinity" || t == "+Infinity" {
		return math.Inf(1)
	}
	if t == "-Infinity" {
		return math.Inf(-1)
	}
	if t == "NaN" || t == "Inf" || t == "+Inf" || t == "-Inf" {
		return math.NaN()
	}
	if len(t) > 2 && (t[:2] == "0x" || t[:2] == "0X") {
		neg := false
		rest := t[2:]
		if strings.HasPrefix(rest, "+") {
			rest = rest[1:]
		} else if strings.HasPrefix(rest, "-") {
			neg = true
			rest = rest[1:]
		}
		if rest == "" {
			return math.NaN()
		}
		n, err := strconv.ParseUint(rest, 16, 64)
		if err != nil {
			return math.NaN()
		}
		if neg {
			return -float64(n)
		}
		return float64(n)
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return math.NaN()
	}
	return f
}

// jsNumStr formats a float64 the way JavaScript prints a number in a
// template string (integers without a decimal point).
func jsNumStr(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	if f == math.Trunc(f) && math.Abs(f) < 1e21 {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

// jsIsInteger mirrors Number.isInteger.
func jsIsInteger(f float64) bool {
	return !math.IsNaN(f) && !math.IsInf(f, 0) && f == math.Trunc(f)
}

// paginate slices a list like the TS paginate(): per_page clamped to
// [1,100] default 30, page >= 1 default 1, non-numeric falls back.
func paginateLen(total int, query map[string]string) (start, end int, totalPages int, pageNum float64, perPage float64) {
	perPage = jsNumber(query["per_page"])
	if perPage == 0 || math.IsNaN(perPage) {
		perPage = 30
	}
	if perPage < 1 {
		perPage = 1
	}
	if perPage > 100 {
		perPage = 100
	}
	pageNum = jsNumber(query["page"])
	if pageNum == 0 || math.IsNaN(pageNum) {
		pageNum = 1
	}
	if pageNum < 1 {
		pageNum = 1
	}
	startF := (pageNum - 1) * perPage
	start = int(startF)
	if start < 0 {
		start = 0
	}
	if start > total {
		start = total
	}
	end = int(startF + perPage)
	if end < start {
		end = start
	}
	if end > total {
		end = total
	}
	totalPages = int(math.Ceil(float64(total) / perPage))
	if totalPages < 1 {
		totalPages = 1
	}
	return start, end, totalPages, pageNum, perPage
}
