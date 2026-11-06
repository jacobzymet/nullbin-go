package server

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/jacobzymet/nullbin-go/internal/storage"
)

var chunkIndexPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,9})$`)

func FuzzParseChunkIndex(f *testing.F) {
	for _, s := range []string{"0", "1", "00", "-1", "+1", "2147483647", "2147483648", "9999999999", "", " 1", "1e3", "٣"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		n, ok := parseChunkIndex(s)
		wantOK := false
		if chunkIndexPattern.MatchString(s) {
			v, err := strconv.ParseInt(s, 10, 64)
			wantOK = err == nil && v <= maxChunkIndex
			if wantOK && int64(n) != v {
				t.Fatalf("parseChunkIndex(%q) = %d, want %d", s, n, v)
			}
		}
		if ok != wantOK {
			t.Fatalf("parseChunkIndex(%q) ok = %v, want %v", s, ok, wantOK)
		}
	})
}

func FuzzClientIP(f *testing.F) {
	f.Add("10.0.0.1:80", "198.51.100.1, 10.0.0.2")
	f.Add("[fd00::1]:80", "[2001:db8::1]:443")
	f.Add("203.0.113.9:1", "garbage")
	f.Add("x", "")
	res := ipResolver{trusted: []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8"), netip.MustParsePrefix("fd00::/8")}}
	f.Fuzz(func(t *testing.T, remote, xff string) {
		r := &http.Request{RemoteAddr: remote, Header: http.Header{"X-Forwarded-For": {xff}}}
		got := res.clientIP(r)
		peer, ok := parseHost(remote)
		if !ok {
			if got.IsValid() {
				t.Fatalf("unparseable peer %q gave %v", remote, got)
			}
			return
		}
		if !res.isTrusted(peer) && got != peer {
			t.Fatalf("untrusted peer %v, X-Forwarded-For %q: got %v", peer, xff, got)
		}
		if got.Zone() != "" || got.Is4In6() {
			t.Fatalf("result %v not normalized", got)
		}
	})
}

// FuzzHandler throws arbitrary requests at the full handler stack and
// checks invariants: no panics, a known status code, security headers on
// every response, and nothing created outside the store's directories.
func FuzzHandler(f *testing.F) {
	id := storage.NewID()
	seeds := []struct {
		method, path, ct, token, body string
	}{
		{"POST", "/api/v1/pastes", "application/json", "", `{"expires_in":300,"burn_after_reading":true,"total_size":100,"burn_token":"` + strings.Repeat("A", 43) + `"}`},
		{"PUT", "/api/v1/pastes/" + id + "/chunks/0", "application/octet-stream", "tok", "NBN1"},
		{"POST", "/api/v1/pastes/" + id + "/finalize", "", "tok", ""},
		{"GET", "/api/v1/pastes/" + id, "", "", ""},
		{"GET", "/api/v1/pastes/" + id + "/prefix", "", "", ""},
		{"POST", "/api/v1/pastes/" + id + "/read", "", "tok", ""},
		{"DELETE", "/api/v1/pastes/" + id, "", "tok", ""},
		{"GET", "/api/v1/pastes/..%2F..%2Fetc%2Fpasswd", "", "", ""},
		{"GET", "/p/" + id, "", "", ""},
		{"HEAD", "/api/v1/pastes/" + id, "", "", ""},
		{"GET", "/api/v1/version", "", "", ""},
		{"POST", "/api/v1/pastes", "application/json", "", `{"expires_in":300,"burn_after_reading":false,"total_size":100,"comment_token":"` + strings.Repeat("A", 43) + `"}`},
		{"POST", "/api/v1/pastes/" + id + "/comments", "application/octet-stream", "tok", strings.Repeat("c", 64)},
		{"GET", "/api/v1/pastes/" + id + "/comments", "", "tok", ""},
	}
	for _, s := range seeds {
		f.Add(s.method, s.path, s.ct, s.token, []byte(s.body))
	}

	e := newEnv(f, nil)
	e.srv.creates.burst = 1e9
	e.srv.uploads.burst = 1e9
	e.srv.comments.burst = 1e9
	allowed := map[int]bool{200: true, 201: true, 204: true, 301: true, 307: true, 308: true, 400: true, 403: true, 404: true, 405: true, 409: true, 413: true, 415: true, 429: true, 503: true, 507: true}
	tokenPattern := regexp.MustCompile(`^[!#$%&'*+.^_` + "`" + `|~0-9A-Za-z-]+$`)

	f.Fuzz(func(t *testing.T, method, path, ct, token string, body []byte) {
		if !tokenPattern.MatchString(method) || len(path) == 0 || path[0] != '/' {
			return // net/http rejects these before any handler runs
		}
		u, err := url.ParseRequestURI(path)
		if err != nil {
			return
		}
		r := httptest.NewRequest("GET", "/", bytes.NewReader(body))
		r.Method, r.URL, r.RequestURI = method, u, path
		r.Header.Set("Content-Type", ct)
		r.Header.Set(UploadTokenHeader, token)
		r.Header.Set(DeleteTokenHeader, token)
		r.Header.Set(CommentTokenHeader, token)
		r.Header.Set(BurnTokenHeader, token)
		w := httptest.NewRecorder()
		e.srv.Handler().ServeHTTP(w, r)

		if !allowed[w.Code] {
			t.Fatalf("%s %q: unexpected status %d", method, path, w.Code)
		}
		if w.Header().Get("Content-Security-Policy") != ContentSecurityPolicy {
			t.Fatalf("%s %q: missing CSP", method, path)
		}
		if strings.Contains(e.logs.String(), "panic") {
			t.Fatalf("%s %q: handler panicked:\n%s", method, path, e.logs.String())
		}
		des, err := os.ReadDir(e.dir)
		if err != nil || len(des) != 3 {
			t.Fatalf("data dir changed: %v %v", des, err)
		}
		for _, d := range des {
			sub, _ := os.ReadDir(filepath.Join(e.dir, d.Name()))
			for _, s := range sub {
				name := s.Name()
				if !storage.ValidID(name) && !(d.Name() == "claimed" && len(name) == 49) {
					t.Fatalf("unexpected entry %s/%s", d.Name(), name)
				}
			}
		}
	})
}
