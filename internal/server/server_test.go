package server

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jacobzymet/nullbin-go/internal/assets"
	"github.com/jacobzymet/nullbin-go/internal/storage"
)

// syncBuffer is a goroutine-safe log sink.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type testEnv struct {
	srv   *Server
	ts    *httptest.Server
	store *storage.Store
	dir   string
	logs  *syncBuffer
	clock *fakeClock
}

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

var testBundle = assets.New(
	[]byte("<!doctype html><title>Nullbin</title>"),
	[]byte("console.log('app')"),
	[]byte("body{color:red}"),
)

func newEnv(t testing.TB, mutate func(*Config)) *testEnv {
	t.Helper()
	dir := t.TempDir()
	st, err := storage.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	clock := &fakeClock{t: time.Now()}
	st.SetClock(clock.now)
	st.SetMinChunk(1) // most tests upload in small chunks; see TestChunkSizeAndIdleRules
	logs := &syncBuffer{}
	cfg := Config{
		Store:   st,
		Assets:  testBundle,
		Version: "v-test",
		MaxSize: 1 << 20,
		Logger:  log.New(logs, "", 0),
	}
	if mutate != nil {
		mutate(&cfg)
	}
	srv := New(cfg)
	srv.nowFunc = clock.now // rate limits only refill when a test moves the clock
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(func() {
		ts.Close()
		st.Close()
	})
	return &testEnv{srv: srv, ts: ts, store: st, dir: dir, logs: logs, clock: clock}
}

func (e *testEnv) do(t testing.TB, method, path string, body []byte, hdr map[string]string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(method, e.ts.URL+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := e.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp, b
}

const testBurnToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

var jsonHdr = map[string]string{"Content-Type": "application/json"}

func (e *testEnv) create(t testing.TB, size int, burn bool) createResponse {
	t.Helper()
	body := fmt.Sprintf(`{"expires_in":3600,"burn_after_reading":%v,"total_size":%d}`, burn, size)
	if burn {
		body = strings.TrimSuffix(body, "}") + `,"burn_token":"` + testBurnToken + `"}`
	}
	resp, b := e.do(t, "POST", "/api/v1/pastes", []byte(body), jsonHdr)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", resp.StatusCode, b)
	}
	var c createResponse
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func (e *testEnv) chunk(t testing.TB, c createResponse, n int, data []byte) int {
	t.Helper()
	resp, _ := e.do(t, "PUT", "/api/v1/pastes/"+c.ID+"/chunks/"+strconv.Itoa(n), data, map[string]string{
		"Content-Type":    "application/octet-stream",
		UploadTokenHeader: c.UploadToken,
	})
	return resp.StatusCode
}

func (e *testEnv) finalize(t testing.TB, c createResponse) int {
	t.Helper()
	resp, _ := e.do(t, "POST", "/api/v1/pastes/"+c.ID+"/finalize", nil, map[string]string{UploadTokenHeader: c.UploadToken})
	return resp.StatusCode
}

// publish uploads content in chunks of chunkSize and finalizes it.
func (e *testEnv) publish(t testing.TB, content []byte, burn bool, chunkSize int) createResponse {
	t.Helper()
	c := e.create(t, len(content), burn)
	for n, off := 0, 0; off < len(content); n++ {
		end := min(off+chunkSize, len(content))
		if code := e.chunk(t, c, n, content[off:end]); code != http.StatusNoContent {
			t.Fatalf("chunk %d: %d", n, code)
		}
		off = end
	}
	if code := e.finalize(t, c); code != http.StatusOK {
		t.Fatalf("finalize: %d", code)
	}
	return c
}

func blob(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i * 7)
	}
	return b
}

func checkSecurityHeaders(t *testing.T, label string, h http.Header, hsts bool) {
	t.Helper()
	want := map[string]string{
		"Content-Security-Policy":      "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; img-src 'self' blob: data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'",
		"Referrer-Policy":              "no-referrer",
		"X-Content-Type-Options":       "nosniff",
		"Cache-Control":                "no-store",
		"Cross-Origin-Opener-Policy":   "same-origin",
		"Cross-Origin-Embedder-Policy": "require-corp",
		"Cross-Origin-Resource-Policy": "same-origin",
		"X-Frame-Options":              "DENY",
		"Permissions-Policy":           PermissionsPolicy,
	}
	for k, v := range want {
		if got := h.Get(k); got != v {
			t.Errorf("%s: %s = %q, want %q", label, k, got, v)
		}
	}
	if got := h.Get("Strict-Transport-Security"); hsts != (got != "") {
		t.Errorf("%s: Strict-Transport-Security = %q, want present=%v", label, got, hsts)
	}
	if strings.Contains(h.Get("Permissions-Policy"), "*") {
		t.Errorf("%s: Permissions-Policy allows a wildcard", label)
	}
}

func TestSecurityHeadersOnEveryResponse(t *testing.T) {
	for _, https := range []bool{false, true} {
		e := newEnv(t, func(c *Config) { c.BehindHTTPS = https })
		e.srv.creates.burst = 2 // the 415 and 400 below use both tokens; then 429
		id := storage.NewID()
		requests := []struct {
			method, path string
			body         string
			hdr          map[string]string
			status       int
		}{
			{"GET", "/", "", nil, 200},
			{"GET", "/p/" + id, "", nil, 200},
			{"GET", "/d/" + id, "", nil, 200},
			{"GET", "/p/not-an-id", "", nil, 404},
			{"GET", "/assets/app.js", "", nil, 200},
			{"GET", "/assets/app.css", "", nil, 200},
			{"GET", "/api/v1/version", "", nil, 200},
			{"GET", "/nope", "", nil, 404},
			{"POST", "/", "", nil, 405},
			{"GET", "/api/v1/pastes/" + id, "", nil, 404},
			{"HEAD", "/api/v1/pastes/" + id, "", nil, 405},
			{"POST", "/api/v1/pastes", "{}", nil, 415},
			{"POST", "/api/v1/pastes", "{}", jsonHdr, 400},
			{"POST", "/api/v1/pastes", "{}", jsonHdr, 429},
			{"POST", "/api/v1/pastes", "{}", map[string]string{"Sec-Fetch-Site": "cross-site"}, 403},
		}
		for _, r := range requests {
			resp, _ := e.do(t, r.method, r.path, []byte(r.body), r.hdr)
			label := fmt.Sprintf("https=%v %s %s", https, r.method, r.path)
			if resp.StatusCode != r.status {
				t.Errorf("%s: status %d, want %d", label, resp.StatusCode, r.status)
			}
			checkSecurityHeaders(t, label, resp.Header, https)
		}
	}
}

func TestStaticFilesAndVersion(t *testing.T) {
	e := newEnv(t, nil)
	for path, want := range map[string]struct{ ct, body string }{
		"/":               {"text/html; charset=utf-8", string(testBundle.HTML)},
		"/assets/app.js":  {"text/javascript; charset=utf-8", string(testBundle.JS)},
		"/assets/app.css": {"text/css; charset=utf-8", string(testBundle.CSS)},
	} {
		resp, body := e.do(t, "GET", path, nil, nil)
		if resp.Header.Get("Content-Type") != want.ct || string(body) != want.body {
			t.Errorf("%s: %q %q", path, resp.Header.Get("Content-Type"), body)
		}
	}

	resp, body := e.do(t, "GET", "/api/v1/version", nil, nil)
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("version: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	var v map[string]string
	if err := json.Unmarshal(body, &v); err != nil {
		t.Fatal(err)
	}
	sum := func(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
	if v["version"] != "v-test" || v["js_sha256"] != sum(testBundle.JS) || v["css_sha256"] != sum(testBundle.CSS) || v["html_sha256"] != sum(testBundle.HTML) {
		t.Fatalf("version response %v", v)
	}
}

func TestPasteLifecycle(t *testing.T) {
	e := newEnv(t, nil)
	content := blob(300_000)
	c := e.publish(t, content, false, 100_000)

	for range 2 { // not burn: readable repeatedly
		resp, body := e.do(t, "GET", "/api/v1/pastes/"+c.ID, nil, nil)
		if resp.StatusCode != 200 || !bytes.Equal(body, content) {
			t.Fatalf("GET: %d, %d bytes", resp.StatusCode, len(body))
		}
		h := resp.Header
		if h.Get("Content-Type") != "application/octet-stream" ||
			!strings.HasPrefix(h.Get("Content-Disposition"), "attachment") ||
			h.Get("Content-Length") != strconv.Itoa(len(content)) {
			t.Fatalf("GET headers %v", h)
		}
	}

	del := func(token string) int {
		resp, _ := e.do(t, "DELETE", "/api/v1/pastes/"+c.ID, nil, map[string]string{DeleteTokenHeader: token})
		return resp.StatusCode
	}
	if code := del(c.UploadToken); code != 404 {
		t.Fatalf("delete with upload token: %d", code)
	}
	if code := del(""); code != 404 {
		t.Fatalf("delete without token: %d", code)
	}
	if code := del(c.DeleteToken); code != 204 {
		t.Fatalf("delete: %d", code)
	}
	if resp, _ := e.do(t, "GET", "/api/v1/pastes/"+c.ID, nil, nil); resp.StatusCode != 404 {
		t.Fatalf("GET after delete: %d", resp.StatusCode)
	}
}

// Exactly these expiries are offered; nothing longer than 30 days.
func TestAllowedExpiries(t *testing.T) {
	want := map[int64]time.Duration{
		300: 5 * time.Minute, 1800: 30 * time.Minute, 3600: time.Hour,
		10800: 3 * time.Hour, 43200: 12 * time.Hour, 86400: 24 * time.Hour,
		259200: 72 * time.Hour, 604800: 7 * 24 * time.Hour, 2592000: 30 * 24 * time.Hour,
	}
	if len(allowedExpiry) != len(want) {
		t.Fatalf("%d expiries allowed, want %d", len(allowedExpiry), len(want))
	}
	for s, d := range want {
		if allowedExpiry[s] != d {
			t.Errorf("expires_in %d: got %v, want %v", s, allowedExpiry[s], d)
		}
	}
	e := newEnv(t, nil)
	e.srv.creates.burst = 1000
	for _, s := range []int64{1800, 10800, 43200, 259200} {
		body := fmt.Sprintf(`{"expires_in":%d,"burn_after_reading":false,"total_size":100}`, s)
		if resp, _ := e.do(t, "POST", "/api/v1/pastes", []byte(body), map[string]string{"Content-Type": "application/json"}); resp.StatusCode != 201 {
			t.Errorf("expires_in %d: status %d", s, resp.StatusCode)
		}
	}
	for _, s := range []int64{1799, 7200, 31536000} {
		body := fmt.Sprintf(`{"expires_in":%d,"burn_after_reading":false,"total_size":100}`, s)
		if resp, _ := e.do(t, "POST", "/api/v1/pastes", []byte(body), map[string]string{"Content-Type": "application/json"}); resp.StatusCode != 400 {
			t.Errorf("expires_in %d: status %d, want 400", s, resp.StatusCode)
		}
	}
}

func TestCreateValidation(t *testing.T) {
	e := newEnv(t, nil)
	e.srv.creates.burst = 1000
	cases := []struct {
		name, ct, body string
		status         int
	}{
		{"ok", "application/json", `{"expires_in":300,"burn_after_reading":false,"total_size":100}`, 201},
		{"ok charset", "application/json; charset=utf-8", `{"expires_in":2592000,"burn_after_reading":true,"total_size":1048576,"burn_token":"` + testBurnToken + `"}`, 201},
		{"no content type", "", `{"expires_in":300,"burn_after_reading":false,"total_size":100}`, 415},
		{"form", "application/x-www-form-urlencoded", `expires_in=300`, 415},
		{"text/plain", "text/plain", `{"expires_in":300,"burn_after_reading":false,"total_size":100}`, 415},
		{"not json", "application/json", `nope`, 400},
		{"empty", "application/json", ``, 400},
		{"array", "application/json", `[]`, 400},
		{"unknown field", "application/json", `{"expires_in":300,"burn_after_reading":false,"total_size":100,"filename":"x"}`, 400},
		{"missing burn", "application/json", `{"expires_in":300,"total_size":100}`, 400},
		{"missing size", "application/json", `{"expires_in":300,"burn_after_reading":false}`, 400},
		{"null size", "application/json", `{"expires_in":300,"burn_after_reading":false,"total_size":null}`, 400},
		{"trailing data", "application/json", `{"expires_in":300,"burn_after_reading":false,"total_size":100}{}`, 400},
		{"never expires", "application/json", `{"expires_in":0,"burn_after_reading":false,"total_size":100}`, 400},
		{"odd expiry", "application/json", `{"expires_in":301,"burn_after_reading":false,"total_size":100}`, 400},
		{"negative expiry", "application/json", `{"expires_in":-300,"burn_after_reading":false,"total_size":100}`, 400},
		{"string expiry", "application/json", `{"expires_in":"1h","burn_after_reading":false,"total_size":100}`, 400},
		{"float size", "application/json", `{"expires_in":300,"burn_after_reading":false,"total_size":1.5}`, 400},
		{"tiny size", "application/json", `{"expires_in":300,"burn_after_reading":false,"total_size":66}`, 400},
		{"zero size", "application/json", `{"expires_in":300,"burn_after_reading":false,"total_size":0}`, 400},
		{"negative size", "application/json", `{"expires_in":300,"burn_after_reading":false,"total_size":-1}`, 400},
		{"over max", "application/json", `{"expires_in":300,"burn_after_reading":false,"total_size":1048577}`, 413},
		{"huge", "application/json", `{"expires_in":300,"burn_after_reading":false,"total_size":99999999999999999}`, 413},
		{"overflow", "application/json", `{"expires_in":300,"burn_after_reading":false,"total_size":999999999999999999999}`, 400},
		{"body too large", "application/json", `{"expires_in":300,"burn_after_reading":false,"total_size":100,"x":"` + strings.Repeat("a", 5000) + `"}`, 413},
	}
	for _, c := range cases {
		hdr := map[string]string{}
		if c.ct != "" {
			hdr["Content-Type"] = c.ct
		}
		resp, body := e.do(t, "POST", "/api/v1/pastes", []byte(c.body), hdr)
		if resp.StatusCode != c.status {
			t.Errorf("%s: status %d (%s), want %d", c.name, resp.StatusCode, body, c.status)
		}
		if c.status == 413 && c.name == "over max" && !strings.Contains(string(body), `"max_size":1048576`) {
			t.Errorf("413 does not report max_size: %s", body)
		}
	}
}

func TestChunkErrors(t *testing.T) {
	e := newEnv(t, nil)
	c := e.create(t, 100, false)
	put := func(id, n string, body []byte, ct, token string) int {
		resp, _ := e.do(t, "PUT", "/api/v1/pastes/"+id+"/chunks/"+n, body, map[string]string{"Content-Type": ct, UploadTokenHeader: token})
		return resp.StatusCode
	}
	oct := "application/octet-stream"
	cases := []struct {
		name   string
		id, n  string
		body   []byte
		ct     string
		token  string
		status int
	}{
		{"bad id", "XYZ", "0", blob(10), oct, c.UploadToken, 404},
		{"unknown id", storage.NewID(), "0", blob(10), oct, c.UploadToken, 404},
		{"leading zero", c.ID, "00", blob(10), oct, c.UploadToken, 400},
		{"negative", c.ID, "-1", blob(10), oct, c.UploadToken, 400},
		{"plus", c.ID, "+1", blob(10), oct, c.UploadToken, 400},
		{"hex", c.ID, "0x1", blob(10), oct, c.UploadToken, 400},
		{"huge index", c.ID, "99999999999", blob(10), oct, c.UploadToken, 400},
		{"wrong content type", c.ID, "0", blob(10), "text/plain", c.UploadToken, 415},
		{"no token", c.ID, "0", blob(10), oct, "", 404},
		{"delete token", c.ID, "0", blob(10), oct, c.DeleteToken, 404},
		{"out of order", c.ID, "1", blob(10), oct, c.UploadToken, 409},
		{"empty", c.ID, "0", nil, oct, c.UploadToken, 400},
		{"over total", c.ID, "0", blob(101), oct, c.UploadToken, 413},
		{"ok", c.ID, "0", blob(60), oct, c.UploadToken, 204},
		{"repeat", c.ID, "0", blob(40), oct, c.UploadToken, 409},
		{"running total over", c.ID, "1", blob(41), oct, c.UploadToken, 413},
		{"ok 2", c.ID, "1", blob(40), oct, c.UploadToken, 204},
		{"full", c.ID, "2", blob(1), oct, c.UploadToken, 413},
	}
	for _, tc := range cases {
		if got := put(tc.id, tc.n, tc.body, tc.ct, tc.token); got != tc.status {
			t.Errorf("%s: status %d, want %d", tc.name, got, tc.status)
		}
	}
	if code := e.finalize(t, c); code != 200 {
		t.Fatalf("finalize: %d", code)
	}
}

func TestTruncatedUploadIsRejected(t *testing.T) {
	e := newEnv(t, nil)
	c := e.create(t, 1000, false)
	if code := e.chunk(t, c, 0, blob(999)); code != 204 {
		t.Fatal(code)
	}
	if code := e.finalize(t, c); code != 400 {
		t.Fatalf("finalize truncated upload: %d, want 400", code)
	}
	if resp, _ := e.do(t, "GET", "/api/v1/pastes/"+c.ID, nil, nil); resp.StatusCode != 404 {
		t.Fatalf("GET truncated upload: %d", resp.StatusCode)
	}
	other := c
	other.UploadToken = storage.NewToken()
	if code := e.finalize(t, other); code != 404 {
		t.Fatalf("finalize with wrong token: %d", code)
	}
}

// 50 clients GET the same burn-after-reading paste at once. Exactly one
// gets the content; all others get 404.
func TestBurnConcurrentPOSTsExactlyOneSucceeds(t *testing.T) {
	const clients = 50
	e := newEnv(t, nil)
	e.srv.downloads.burst = 100
	// All requests share one address; this test is about the burn claim,
	// not the per-client download cap.
	e.srv.downloadSlots = newSlotPool(clients, clients, clients)
	content := blob(200_000)
	c := e.publish(t, content, true, 64_000)

	var (
		wg      sync.WaitGroup
		start   = make(chan struct{})
		mu      sync.Mutex
		codes   = map[int]int{}
		goodOne bool
	)
	client := &http.Client{Transport: &http.Transport{MaxConnsPerHost: 0, MaxIdleConnsPerHost: clients}}
	for range clients {
		wg.Go(func() {
			<-start
			req, _ := http.NewRequest("POST", e.ts.URL+"/api/v1/pastes/"+c.ID+"/read", nil)
			req.Header.Set(BurnTokenHeader, testBurnToken)
			resp, err := client.Do(req)
			if err != nil {
				t.Error(err)
				return
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			mu.Lock()
			codes[resp.StatusCode]++
			if resp.StatusCode == 200 && bytes.Equal(body, content) {
				goodOne = true
			}
			mu.Unlock()
		})
	}
	close(start)
	wg.Wait()
	if codes[200] != 1 || codes[404] != clients-1 || !goodOne {
		t.Fatalf("status counts %v (full content delivered: %v)\nserver log:\n%s", codes, goodOne, e.logs.String())
	}
}

func TestHeadNeverBurns(t *testing.T) {
	e := newEnv(t, nil)
	content := blob(1000)
	c := e.publish(t, content, true, 1000)
	if resp, _ := e.do(t, "HEAD", "/api/v1/pastes/"+c.ID, nil, nil); resp.StatusCode != 405 {
		t.Fatalf("HEAD: %d", resp.StatusCode)
	}
	resp, body := e.do(t, "POST", "/api/v1/pastes/"+c.ID+"/read", nil, map[string]string{BurnTokenHeader: testBurnToken})
	if resp.StatusCode != 200 || !bytes.Equal(body, content) {
		t.Fatalf("GET after HEAD: %d", resp.StatusCode)
	}
	if resp, _ := e.do(t, "POST", "/api/v1/pastes/"+c.ID+"/read", nil, map[string]string{BurnTokenHeader: testBurnToken}); resp.StatusCode != 404 {
		t.Fatalf("second GET of burn paste: %d", resp.StatusCode)
	}
}

// Not found, expired, burned and wrong-token all look the same.
func TestUniform404(t *testing.T) {
	e := newEnv(t, nil)
	e.srv.creates.burst = 100

	burned := e.publish(t, blob(100), true, 100)
	e.do(t, "POST", "/api/v1/pastes/"+burned.ID+"/read", nil, map[string]string{BurnTokenHeader: testBurnToken})

	expired := e.create(t, 100, false)
	e.chunk(t, expired, 0, blob(100))
	e.finalize(t, expired)
	deleted := e.publish(t, blob(100), false, 100)
	e.do(t, "DELETE", "/api/v1/pastes/"+deleted.ID, nil, map[string]string{DeleteTokenHeader: deleted.DeleteToken})
	e.clock.add(time.Hour)

	var first []byte
	for name, id := range map[string]string{
		"unknown": storage.NewID(), "burned": burned.ID, "expired": expired.ID, "deleted": deleted.ID, "malformed": "zz",
	} {
		resp, body := e.do(t, "GET", "/api/v1/pastes/"+id, nil, nil)
		if resp.StatusCode != 404 {
			t.Errorf("%s: %d", name, resp.StatusCode)
		}
		if first == nil {
			first = body
		} else if !bytes.Equal(body, first) {
			t.Errorf("%s: body %q differs from %q", name, body, first)
		}
	}
	live := e.publish(t, blob(100), false, 100)
	resp, body := e.do(t, "DELETE", "/api/v1/pastes/"+live.ID, nil, map[string]string{DeleteTokenHeader: "wrong"})
	if resp.StatusCode != 404 || !bytes.Equal(body, first) {
		t.Errorf("wrong delete token: %d %q", resp.StatusCode, body)
	}
}

// rawRequest sends a request line exactly as given, bypassing Go's client
// path normalization.
func rawRequest(t *testing.T, addr, method, target string) int {
	t.Helper()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprintf(conn, "%s %s HTTP/1.1\r\nHost: test\r\nContent-Type: application/octet-stream\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndata", method, target)
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatalf("%s %s: %v", method, target, err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

func TestPathTraversalIsRejected(t *testing.T) {
	e := newEnv(t, nil)
	addr := strings.TrimPrefix(e.ts.URL, "http://")
	targets := []string{
		"/api/v1/pastes/..%2F..%2F..%2Fetc%2Fpasswd",
		"/api/v1/pastes/%2e%2e%2f%2e%2e%2fpastes",
		"/api/v1/pastes/../../../../etc/passwd",
		"/api/v1/pastes/..",
		"/api/v1/pastes/0123456789abcdef0123456789abcdef%00",
		"/api/v1/pastes/0123456789abcdef0123456789abcde%2F",
		"/api/v1/pastes/0123456789ABCDEF0123456789ABCDEF",
		"/api/v1/pastes/..%5C..%5Cwindows",
		"/api/v1/pastes/..%2Fpending/chunks/0",
		"/api/v1/pastes/..%2Fpending/finalize",
		"/p/..%2F..%2Fetc%2Fpasswd",
		"/d/%2e%2e",
		"/assets/..%2F..%2Fgo.mod",
		"/assets/../../go.mod",
	}
	for _, target := range targets {
		for _, method := range []string{"GET", "PUT", "POST", "DELETE"} {
			code := rawRequest(t, addr, method, target)
			if code < 300 && !(method == "GET" && code == 200 && (strings.HasPrefix(target, "/p/") || strings.HasPrefix(target, "/d/"))) {
				t.Errorf("%s %s: status %d", method, target, code)
			}
		}
	}
	// Nothing was created anywhere in the data directory.
	for _, d := range []string{"pending", "pastes", "claimed"} {
		if des, _ := os.ReadDir(filepath.Join(e.dir, d)); len(des) != 0 {
			t.Errorf("%s not empty after traversal attempts", d)
		}
	}
}

func TestRateLimitAndSpoofedForwardedFor(t *testing.T) {
	body := []byte(`{"expires_in":300,"burn_after_reading":false,"total_size":100}`)
	createWithXFF := func(e *testEnv, xff string) int {
		// Test the request limiter alone, not the unfinished-upload cap.
		e.srv.pending = newPendingTracker(1000, 1000, time.Hour)
		hdr := map[string]string{"Content-Type": "application/json"}
		if xff != "" {
			hdr["X-Forwarded-For"] = xff
		}
		resp, _ := e.do(t, "POST", "/api/v1/pastes", body, hdr)
		if resp.StatusCode == 429 && resp.Header.Get("Retry-After") == "" {
			t.Error("429 without Retry-After")
		}
		return resp.StatusCode
	}

	t.Run("untrusted peer: X-Forwarded-For ignored", func(t *testing.T) {
		e := newEnv(t, nil)
		for i := range 20 {
			if code := createWithXFF(e, fmt.Sprintf("10.0.%d.1", i)); code != 201 {
				t.Fatalf("request %d: %d", i, code)
			}
		}
		if code := createWithXFF(e, "203.0.113.99"); code != 429 {
			t.Fatalf("spoofed X-Forwarded-For bypassed the limit: %d", code)
		}
	})

	t.Run("trusted proxy: rightmost untrusted hop", func(t *testing.T) {
		e := newEnv(t, func(c *Config) {
			c.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8"), netip.MustParsePrefix("::1/128")}
		})
		for i := range 20 {
			if code := createWithXFF(e, "198.51.100.7"); code != 201 {
				t.Fatalf("request %d: %d", i, code)
			}
		}
		if code := createWithXFF(e, "198.51.100.7"); code != 429 {
			t.Fatalf("limit not applied per client: %d", code)
		}
		// The client prepends fake hops; the proxy appended the real one.
		if code := createWithXFF(e, "203.0.113.1, 192.0.2.5, 198.51.100.7"); code != 429 {
			t.Fatalf("client-supplied hops were trusted: %d", code)
		}
		// A different real client is not affected.
		if code := createWithXFF(e, "198.51.100.8"); code != 201 {
			t.Fatalf("other client limited: %d", code)
		}
	})
}

func TestUploadRateLimit(t *testing.T) {
	e := newEnv(t, nil)
	c := e.create(t, 10_000, false)
	codes := map[int]int{}
	for n := range 60 {
		codes[e.chunk(t, c, n, blob(1))]++
	}
	if codes[204] != 50 || codes[429] != 10 {
		t.Fatalf("status counts %v, want 50x204 then 429s", codes)
	}
}

func TestLogsNeverContainIdentifiers(t *testing.T) {
	e := newEnv(t, nil)
	c := e.publish(t, blob(5000), false, 1000)
	burn := e.publish(t, blob(5000), true, 1000)
	e.do(t, "GET", "/api/v1/pastes/"+burn.ID, nil, map[string]string{"User-Agent": "SecretAgent/1.0"})

	// Force internal errors: corrupt metadata, then a missing blob.
	os.WriteFile(filepath.Join(e.dir, "pastes", c.ID, "meta.json"), []byte(`{"id":"`+c.ID+`"}`), 0o600)
	if resp, _ := e.do(t, "GET", "/api/v1/pastes/"+c.ID, nil, nil); resp.StatusCode != 500 {
		t.Fatalf("corrupt paste: %d", resp.StatusCode)
	}
	other := e.publish(t, blob(5000), false, 1000)
	os.Remove(filepath.Join(e.dir, "pastes", other.ID, "blob"))
	os.Mkdir(filepath.Join(e.dir, "pastes", other.ID, "blob"), 0o700)
	e.do(t, "GET", "/api/v1/pastes/"+other.ID, nil, nil)

	logs := e.logs.String()
	if !strings.Contains(logs, "error: get") {
		t.Fatalf("expected an error log line, got %q", logs)
	}
	for _, secret := range []string{c.ID, c.UploadToken, c.DeleteToken, burn.ID, other.ID, "127.0.0.1", "SecretAgent", e.dir} {
		if strings.Contains(logs, secret) {
			t.Fatalf("log contains %q:\n%s", secret, logs)
		}
	}
}

func TestPanicIsRecoveredWithoutLeakingRequestData(t *testing.T) {
	logs := &syncBuffer{}
	logger := log.New(logs, "", 0)
	h := recoverPanics(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom for " + r.URL.Path)
	}))
	ts := httptest.NewUnstartedServer(h)
	ts.Config.ErrorLog = NewErrorLog(logger)
	ts.Start()
	defer ts.Close()
	id := storage.NewID()
	resp, err := http.Get(ts.URL + "/api/v1/pastes/" + id)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 500 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if l := logs.String(); !strings.Contains(l, "handler panic (string)") || strings.Contains(l, id) || strings.Contains(l, "127.0.0.1") {
		t.Fatalf("panic log %q", l)
	}
}

func TestScrubAddresses(t *testing.T) {
	cases := map[string]string{
		"http: TLS handshake error from 192.0.2.1:52144: EOF":  "http: TLS handshake error from [redacted] EOF",
		"http: panic serving [2001:db8::1]:443: boom":          "http: panic serving [redacted] boom",
		"http2: server: error reading preface from client ::1": "http2: server: error reading preface from client [redacted]",
		"http: Accept error: too many open files; retrying":    "http: Accept error: too many open files; retrying",
		"from 10.1.2.3, and fe80::1%eth0:80":                   "from [redacted] and [redacted]",
	}
	for in, want := range cases {
		if got := scrubAddresses(in); got != want {
			t.Errorf("scrubAddresses(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDescribeErrorHidesPaths(t *testing.T) {
	id := storage.NewID()
	_, err := os.Open(filepath.Join(t.TempDir(), "pastes", id, "blob"))
	got := describeError(fmt.Errorf("wrapped %s: %w", id, err))
	if strings.Contains(got, id) || !strings.HasPrefix(got, "open: ") {
		t.Fatalf("describeError = %q", got)
	}
	if got := describeError(fmt.Errorf("custom error with %s", id)); strings.Contains(got, id) {
		t.Fatalf("describeError leaked: %q", got)
	}
}

func TestHTTPServerHasTimeoutsAndLimits(t *testing.T) {
	e := newEnv(t, nil)
	hs := e.srv.HTTPServer("127.0.0.1:0")
	if hs.ReadHeaderTimeout <= 0 || hs.ReadTimeout <= 0 || hs.WriteTimeout <= 0 || hs.IdleTimeout <= 0 {
		t.Fatalf("missing timeouts: %+v", hs)
	}
	if hs.MaxHeaderBytes <= 0 || hs.MaxHeaderBytes > 64<<10 {
		t.Fatalf("MaxHeaderBytes = %d", hs.MaxHeaderBytes)
	}
	if hs.ErrorLog == nil {
		t.Fatal("ErrorLog not set")
	}
}

// A client that stops sending in the middle of a chunk is cut off by the
// per-request deadline instead of holding the connection forever.
func TestStalledChunkUploadTimesOut(t *testing.T) {
	e := newEnv(t, nil)
	e.srv.chunkTimeout = 300 * time.Millisecond
	c := e.create(t, 1000, false)

	hs := e.srv.HTTPServer("127.0.0.1:0")
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go hs.Serve(ln)
	defer hs.Close()

	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(conn, "PUT /api/v1/pastes/%s/chunks/0 HTTP/1.1\r\nHost: test\r\nContent-Type: application/octet-stream\r\n%s: %s\r\nContent-Length: 1000\r\n\r\npartial",
		c.ID, UploadTokenHeader, c.UploadToken)

	startWait := time.Now()
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err == nil {
		resp.Body.Close()
		if resp.StatusCode < 400 {
			t.Fatalf("stalled upload got %d", resp.StatusCode)
		}
	}
	if waited := time.Since(startWait); waited > 5*time.Second {
		t.Fatalf("stalled upload held the connection for %v", waited)
	}
	// The partial bytes were discarded; the chunk can be sent again.
	if code := e.chunk(t, c, 0, blob(1000)); code != 204 {
		t.Fatalf("retry after timeout: %d", code)
	}
}

func TestChunkBodyLimit(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.MaxSize = 32 << 20 })
	c := e.create(t, 20<<20, false)
	if code := e.chunk(t, c, 0, blob(maxChunkBody+1)); code != 413 {
		t.Fatalf("chunk over the per-request limit: %d, want 413", code)
	}
	if code := e.chunk(t, c, 0, blob(maxChunkBody)); code != 204 {
		t.Fatalf("chunk at the limit: %d", code)
	}
}

func TestOutOfOrderChunkReportsNextIndexOnlyToTokenHolder(t *testing.T) {
	e := newEnv(t, nil)
	c := e.create(t, 100, false)
	if code := e.chunk(t, c, 0, blob(10)); code != 204 {
		t.Fatal(code)
	}
	resp, body := e.do(t, "PUT", "/api/v1/pastes/"+c.ID+"/chunks/0", blob(10), map[string]string{
		"Content-Type": "application/octet-stream", UploadTokenHeader: c.UploadToken,
	})
	if resp.StatusCode != 409 || !strings.Contains(string(body), `"next_chunk":1`) {
		t.Fatalf("repeated chunk: %d %s", resp.StatusCode, body)
	}
	resp, body = e.do(t, "PUT", "/api/v1/pastes/"+c.ID+"/chunks/0", blob(10), map[string]string{
		"Content-Type": "application/octet-stream", UploadTokenHeader: storage.NewToken(),
	})
	if resp.StatusCode != 404 || strings.Contains(string(body), "next_chunk") {
		t.Fatalf("wrong token: %d %s", resp.StatusCode, body)
	}
}

// publishDiscussion publishes a paste with a discussion over HTTP.
func (e *testEnv) publishDiscussion(t *testing.T, content []byte) (createResponse, string) {
	t.Helper()
	token := storage.NewToken()
	body := fmt.Sprintf(`{"expires_in":3600,"burn_after_reading":false,"total_size":%d,"comment_token":%q}`, len(content), token)
	resp, b := e.do(t, "POST", "/api/v1/pastes", []byte(body), jsonHdr)
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d %s", resp.StatusCode, b)
	}
	var c createResponse
	json.Unmarshal(b, &c)
	if code := e.chunk(t, c, 0, content); code != 204 {
		t.Fatalf("chunk: %d", code)
	}
	if code := e.finalize(t, c); code != 200 {
		t.Fatalf("finalize: %d", code)
	}
	return c, token
}

func (e *testEnv) postComment(t *testing.T, id, token string, body []byte) (int, string) {
	t.Helper()
	resp, b := e.do(t, "POST", "/api/v1/pastes/"+id+"/comments", body, map[string]string{
		"Content-Type": "application/octet-stream", CommentTokenHeader: token,
	})
	return resp.StatusCode, string(b)
}

func (e *testEnv) getComments(t *testing.T, id, token string) (int, [][]byte) {
	t.Helper()
	resp, b := e.do(t, "GET", "/api/v1/pastes/"+id+"/comments", nil, map[string]string{CommentTokenHeader: token})
	var v struct {
		Comments [][]byte `json:"comments"`
	}
	json.Unmarshal(b, &v)
	return resp.StatusCode, v.Comments
}

func TestDiscussionLifecycle(t *testing.T) {
	e := newEnv(t, nil)
	c, token := e.publishDiscussion(t, blob(500))

	if code, list := e.getComments(t, c.ID, token); code != 200 || list == nil || len(list) != 0 {
		t.Fatalf("empty discussion: %d %v", code, list)
	}
	first, second := blob(100), blob(300)
	if code, body := e.postComment(t, c.ID, token, first); code != 201 || body != `{"count":1}` {
		t.Fatalf("post 1: %d %s", code, body)
	}
	if code, _ := e.postComment(t, c.ID, token, second); code != 201 {
		t.Fatalf("post 2: %d", code)
	}
	code, list := e.getComments(t, c.ID, token)
	if code != 200 || len(list) != 2 || !bytes.Equal(list[0], first) || !bytes.Equal(list[1], second) {
		t.Fatalf("comments: %d %d", code, len(list))
	}
	// The paste itself still downloads normally.
	if resp, body := e.do(t, "GET", "/api/v1/pastes/"+c.ID, nil, nil); resp.StatusCode != 200 || len(body) != 500 {
		t.Fatalf("paste GET: %d", resp.StatusCode)
	}
	// Deleting the paste deletes the discussion.
	e.do(t, "DELETE", "/api/v1/pastes/"+c.ID, nil, map[string]string{DeleteTokenHeader: c.DeleteToken})
	if code, _ := e.getComments(t, c.ID, token); code != 404 {
		t.Fatalf("comments after delete: %d", code)
	}
}

func TestDiscussionAccessAndValidation(t *testing.T) {
	e := newEnv(t, nil)
	e.srv.creates.burst = 100
	c, token := e.publishDiscussion(t, blob(500))
	plain := e.publish(t, blob(500), false, 500)

	for _, tc := range []struct {
		name, id, token, ct string
		body                []byte
		status              int
	}{
		{"no token", c.ID, "", "application/octet-stream", blob(60), 404},
		{"wrong token", c.ID, storage.NewToken(), "application/octet-stream", blob(60), 404},
		{"delete token", c.ID, c.DeleteToken, "application/octet-stream", blob(60), 404},
		{"plain paste", plain.ID, token, "application/octet-stream", blob(60), 404},
		{"bad id", "../" + c.ID, token, "application/octet-stream", blob(60), 404},
		{"json body", c.ID, token, "application/json", blob(60), 415},
		{"too short", c.ID, token, "application/octet-stream", blob(40), 400},
		{"too large", c.ID, token, "application/octet-stream", blob(storage.MaxCommentBytes + 1), 413},
		{"ok", c.ID, token, "application/octet-stream", blob(41), 201},
	} {
		resp, _ := e.do(t, "POST", "/api/v1/pastes/"+tc.id+"/comments", tc.body, map[string]string{"Content-Type": tc.ct, CommentTokenHeader: tc.token})
		if resp.StatusCode != tc.status {
			t.Errorf("%s: %d, want %d", tc.name, resp.StatusCode, tc.status)
		}
	}
	for _, wrong := range []string{"", storage.NewToken()} {
		if code, _ := e.getComments(t, c.ID, wrong); code != 404 {
			t.Errorf("GET comments with wrong token: %d", code)
		}
	}
	if code, _ := e.getComments(t, plain.ID, ""); code != 404 {
		t.Errorf("GET comments of a plain paste: %d", code)
	}

	bad := []string{
		`{"expires_in":3600,"burn_after_reading":true,"total_size":100,"comment_token":"` + storage.NewToken() + `"}`,
		`{"expires_in":3600,"burn_after_reading":false,"total_size":100,"comment_token":"short"}`,
		`{"expires_in":3600,"burn_after_reading":false,"total_size":100,"comment_token":"` + strings.Repeat("+", 43) + `"}`,
		`{"expires_in":3600,"burn_after_reading":false,"total_size":100,"comment_token":""}`,
		`{"expires_in":3600,"burn_after_reading":false,"total_size":100,"comment_token":5}`,
	}
	for _, body := range bad {
		if resp, b := e.do(t, "POST", "/api/v1/pastes", []byte(body), jsonHdr); resp.StatusCode != 400 {
			t.Errorf("create %s: %d %s", body, resp.StatusCode, b)
		}
	}
}

func TestCommentRateLimit(t *testing.T) {
	e := newEnv(t, nil)
	c, token := e.publishDiscussion(t, blob(500))
	codes := map[int]int{}
	for range 12 {
		code, _ := e.postComment(t, c.ID, token, blob(50))
		codes[code]++
	}
	if codes[201] != 10 || codes[429] != 2 {
		t.Fatalf("status counts %v, want 10x201 then 429", codes)
	}
}
