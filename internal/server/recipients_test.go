package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/jacobzymet/nullbin-go/internal/storage"
)

func tok(i int) string { return fmt.Sprintf("%042d%c", i, 'A') }

func recipientsBody(entries string) []byte {
	return []byte(`{"expires_in":300,"burn_after_reading":true,"total_size":100,"recipients":[` + entries + `]}`)
}

func TestRecipientCreateValidation(t *testing.T) {
	e := newEnv(t, nil)
	two := fmt.Sprintf(`{"token":%q},{"token":%q}`, tok(1), tok(2))
	many := make([]string, storage.MaxRecipients+1)
	for i := range many {
		many[i] = fmt.Sprintf(`{"token":%q}`, tok(i))
	}
	bad := map[string][]byte{
		"not burn":        []byte(fmt.Sprintf(`{"expires_in":300,"burn_after_reading":false,"total_size":100,"recipients":[%s]}`, two)),
		"with burn_token": []byte(fmt.Sprintf(`{"expires_in":300,"burn_after_reading":true,"total_size":100,"burn_token":%q,"recipients":[%s]}`, testBurnToken, two)),
		"with max_reads":  []byte(fmt.Sprintf(`{"expires_in":300,"burn_after_reading":true,"total_size":100,"max_reads":2,"recipients":[%s]}`, two)),
		"with discussion": []byte(fmt.Sprintf(`{"expires_in":300,"burn_after_reading":true,"total_size":100,"comment_token":%q,"recipients":[%s]}`, tok(9), two)),
		"empty":           recipientsBody(""),
		"one":             recipientsBody(fmt.Sprintf(`{"token":%q}`, tok(1))),
		"too many":        recipientsBody(strings.Join(many, ",")),
		"duplicate":       recipientsBody(fmt.Sprintf(`{"token":%q},{"token":%q}`, tok(1), tok(1))),
		"missing token":   recipientsBody(fmt.Sprintf(`{"token":%q},{"max_reads":2}`, tok(1))),
		"short token":     recipientsBody(fmt.Sprintf(`{"token":%q},{"token":"abc"}`, tok(1))),
		"bad characters":  recipientsBody(fmt.Sprintf(`{"token":%q},{"token":%q}`, tok(1), strings.Repeat("+", 43))),
		"zero opens":      recipientsBody(fmt.Sprintf(`{"token":%q},{"token":%q,"max_reads":0}`, tok(1), tok(2))),
		"too many opens":  recipientsBody(fmt.Sprintf(`{"token":%q},{"token":%q,"max_reads":1001}`, tok(1), tok(2))),
		"unknown field":   recipientsBody(fmt.Sprintf(`{"token":%q},{"token":%q,"label":"Ann"}`, tok(1), tok(2))),
		"null list":       []byte(`{"expires_in":300,"burn_after_reading":true,"total_size":100,"recipients":null}`),
		"not a list":      []byte(`{"expires_in":300,"burn_after_reading":true,"total_size":100,"recipients":{}}`),
	}
	for name, body := range bad {
		resp, data := e.do(t, "POST", "/api/v1/pastes", body, jsonHdr)
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: %d %s", name, resp.StatusCode, data)
		}
	}
	// The most links, each with an open limit, fit the request size limit.
	full := make([]string, storage.MaxRecipients)
	for i := range full {
		full[i] = fmt.Sprintf(`{"token":%q,"max_reads":1000}`, tok(i))
	}
	resp, data := e.do(t, "POST", "/api/v1/pastes", recipientsBody(strings.Join(full, ",")), jsonHdr)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("20 links: %d %s", resp.StatusCode, data)
	}
}

func TestRecipientLinksOpenRevokeAndReportOverHTTP(t *testing.T) {
	const origin = "https://paste.example.com"
	e := newEnv(t, func(c *Config) { c.FrontendOrigin = origin })
	content := blob(100)
	body := recipientsBody(fmt.Sprintf(`{"token":%q,"max_reads":2},{"token":%q},{"token":%q,"max_reads":1}`, tok(1), tok(2), tok(3)))
	resp, data := e.do(t, "POST", "/api/v1/pastes", body, jsonHdr)
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
	read := func(token string) *http.Response {
		resp, data := e.do(t, "POST", url+"/read", nil, map[string]string{BurnTokenHeader: token, "Origin": origin})
		if resp.StatusCode == http.StatusOK && !bytes.Equal(data, content) {
			t.Fatal("wrong content")
		}
		return resp
	}

	// Not by ID alone, nor by a token that is not one of the links.
	if resp, _ := e.do(t, "GET", url, nil, nil); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("ID-only GET: %d", resp.StatusCode)
	}
	for _, wrong := range []string{"", testBurnToken, c.DeleteToken, c.UploadToken} {
		if resp := read(wrong); resp.StatusCode != http.StatusNotFound {
			t.Fatalf("token %q: %d", wrong, resp.StatusCode)
		}
	}
	if resp, data := e.do(t, "GET", url+"/prefix", nil, nil); resp.StatusCode != http.StatusOK || len(data) != 22 {
		t.Fatalf("prefix: %d", resp.StatusCode)
	}

	// Each link counts its own opens. An unlimited link sends no count.
	for _, want := range []string{"1", "0"} {
		resp := read(tok(1))
		if resp.StatusCode != http.StatusOK || resp.Header.Get(ReadsRemainingHeader) != want {
			t.Fatalf("link 1: %d, remaining %q, want %q", resp.StatusCode, resp.Header.Get(ReadsRemainingHeader), want)
		}
		left, err := strconv.Atoi(resp.Header.Get(ExpiresInHeader))
		if err != nil || left <= 0 || left > 300 {
			t.Fatalf("expires-in %q", resp.Header.Get(ExpiresInHeader))
		}
		if !strings.Contains(resp.Header.Get("Access-Control-Expose-Headers"), ExpiresInHeader) {
			t.Fatal("a separately hosted frontend cannot read the expiry")
		}
	}
	// The link's own token learns it is closed; nobody else learns anything.
	if resp := read(tok(1)); resp.StatusCode != http.StatusGone {
		t.Fatalf("link 1 past its limit: %d", resp.StatusCode)
	}
	resp = read(tok(2))
	if resp.StatusCode != http.StatusOK || resp.Header.Get(ReadsRemainingHeader) != "" || resp.Header.Get(ExpiresInHeader) == "" {
		t.Fatalf("unlimited link: %d %v", resp.StatusCode, resp.Header)
	}

	// Only the delete token sees and revokes links.
	owner := map[string]string{DeleteTokenHeader: c.DeleteToken}
	for _, wrong := range []map[string]string{nil, {DeleteTokenHeader: tok(2)}, {DeleteTokenHeader: c.UploadToken}} {
		if resp, _ := e.do(t, "GET", url+"/recipients", nil, wrong); resp.StatusCode != http.StatusNotFound {
			t.Fatalf("status without the delete token: %d", resp.StatusCode)
		}
		if resp, _ := e.do(t, "POST", url+"/recipients/1/revoke", nil, wrong); resp.StatusCode != http.StatusNotFound {
			t.Fatalf("revoke without the delete token: %d", resp.StatusCode)
		}
	}
	resp, data = e.do(t, "GET", url+"/recipients", nil, owner)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: %d", resp.StatusCode)
	}
	want := `{"recipients":[{"opens":2,"max_opens":2,"revoked":false},{"opens":1,"max_opens":null,"revoked":false},{"opens":0,"max_opens":1,"revoked":false}]}`
	if strings.TrimSpace(string(data)) != want {
		t.Fatalf("status body:\n%s\nwant\n%s", data, want)
	}
	if strings.Contains(string(data), "sha256") || strings.Contains(string(data), tok(2)) {
		t.Fatal("status reveals token hashes")
	}
	for _, n := range []string{"3", "20", "-1", "01", "x", "99999999999"} {
		if resp, _ := e.do(t, "POST", url+"/recipients/"+n+"/revoke", nil, owner); resp.StatusCode != http.StatusNotFound {
			t.Fatalf("revoke %s: %d", n, resp.StatusCode)
		}
	}
	if resp, _ := e.do(t, "GET", url+"/recipients/1/revoke", nil, owner); resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET revoke: %d", resp.StatusCode)
	}
	if resp, _ := e.do(t, "POST", url+"/recipients/1/revoke", nil, owner); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("revoke: %d", resp.StatusCode)
	}
	if resp := read(tok(2)); resp.StatusCode != http.StatusGone {
		t.Fatalf("revoked link: %d", resp.StatusCode)
	}
	if resp := read(tok(3)); resp.StatusCode != http.StatusOK || resp.Header.Get(ReadsRemainingHeader) != "0" {
		t.Fatalf("link 3: %d", resp.StatusCode)
	}
	// Every link is now closed, so the paste is gone.
	for _, path := range []string{"/prefix", "/recipients"} {
		if resp, _ := e.do(t, "GET", url+path, nil, owner); resp.StatusCode != http.StatusNotFound {
			t.Fatalf("%s after every link closed: %d", path, resp.StatusCode)
		}
	}
}

func TestRecipientsEndpointsRefuseOtherPastes(t *testing.T) {
	e := newEnv(t, nil)
	c := e.publish(t, blob(100), false, 100)
	owner := map[string]string{DeleteTokenHeader: c.DeleteToken}
	url := "/api/v1/pastes/" + c.ID
	if resp, _ := e.do(t, "GET", url+"/recipients", nil, owner); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status of an ordinary paste: %d", resp.StatusCode)
	}
	if resp, _ := e.do(t, "POST", url+"/recipients/0/revoke", nil, owner); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("revoke on an ordinary paste: %d", resp.StatusCode)
	}
	// The ordinary paste still opens and reports its expiry.
	resp, _ := e.do(t, "GET", url, nil, nil)
	if resp.StatusCode != http.StatusOK || resp.Header.Get(ExpiresInHeader) == "" {
		t.Fatalf("GET: %d %v", resp.StatusCode, resp.Header)
	}
}
