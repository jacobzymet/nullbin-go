package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

func TestReadLimitValidation(t *testing.T) {
	e := newEnv(t, nil)
	for _, limit := range []string{"0", "-1", "1001", "1.5", `"3"`, "true", "[]", "{}", "99999999999999999999999999999"} {
		body := fmt.Sprintf(`{"expires_in":300,"burn_after_reading":true,"total_size":100,"burn_token":%q,"max_reads":%s}`, testBurnToken, limit)
		resp, _ := e.do(t, "POST", "/api/v1/pastes", []byte(body), jsonHdr)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("max_reads=%s: %d", limit, resp.StatusCode)
		}
	}
	resp, _ := e.do(t, "POST", "/api/v1/pastes", []byte(`{"expires_in":300,"burn_after_reading":false,"total_size":100,"max_reads":3}`), jsonHdr)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("reusable paste with read limit: %d", resp.StatusCode)
	}
}

func TestReadLimitCountsOnlyAuthorizedTransfersAndExposesRemainingReads(t *testing.T) {
	const origin = "https://paste.example.com"
	e := newEnv(t, func(c *Config) { c.FrontendOrigin = origin })
	content := blob(100)
	body := fmt.Sprintf(`{"expires_in":300,"burn_after_reading":true,"total_size":100,"burn_token":%q,"max_reads":3}`, testBurnToken)
	resp, data := e.do(t, "POST", "/api/v1/pastes", []byte(body), jsonHdr)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", resp.StatusCode, data)
	}
	var c createResponse
	if err := json.Unmarshal(data, &c); err != nil {
		t.Fatal(err)
	}
	if e.chunk(t, c, 0, content) != http.StatusNoContent || e.finalize(t, c) != http.StatusOK {
		t.Fatal("publish failed")
	}
	url := "/api/v1/pastes/" + c.ID
	for range 2 {
		resp, data := e.do(t, "GET", url+"/prefix", nil, nil)
		if resp.StatusCode != http.StatusOK || len(data) != 22 || resp.Header.Get(ReadsRemainingHeader) != "" {
			t.Fatalf("public prefix: %d %v", resp.StatusCode, resp.Header)
		}
		resp, _ = e.do(t, "POST", url+"/read", nil, map[string]string{BurnTokenHeader: "wrong"})
		if resp.StatusCode != http.StatusNotFound || resp.Header.Get(ReadsRemainingHeader) != "" {
			t.Fatalf("unauthorized read: %d", resp.StatusCode)
		}
	}
	for remaining := 2; remaining >= 0; remaining-- {
		resp, data = e.do(t, "POST", url+"/read", nil, map[string]string{BurnTokenHeader: testBurnToken, "Origin": origin})
		if resp.StatusCode != http.StatusOK || !bytes.Equal(data, content) || resp.Header.Get(ReadsRemainingHeader) != strconv.Itoa(remaining) {
			t.Fatalf("remaining=%d: status %d, header %q", remaining, resp.StatusCode, resp.Header.Get(ReadsRemainingHeader))
		}
		if !strings.Contains(resp.Header.Get("Access-Control-Expose-Headers"), ReadsRemainingHeader) {
			t.Fatal("separately hosted frontend cannot read the counter")
		}
	}
	for _, suffix := range []string{"", "/prefix", "/read"} {
		method := "GET"
		if suffix == "/read" {
			method = "POST"
		}
		resp, _ := e.do(t, method, url+suffix, nil, map[string]string{BurnTokenHeader: testBurnToken})
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("exhausted %s: %d", suffix, resp.StatusCode)
		}
	}
}
