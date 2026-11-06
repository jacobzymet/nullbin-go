package server

import (
	"net/http"
	"strings"
	"testing"
)

func TestAPIOnlyDoesNotServeFrontend(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.APIOnly = true; c.Assets = nil })
	for _, path := range []string{"/", "/p/0123456789abcdef0123456789abcdef", "/d/0123456789abcdef0123456789abcdef", "/assets/app.js", "/assets/app.css"} {
		resp, _ := e.do(t, "GET", path, nil, nil)
		if resp.StatusCode != 404 {
			t.Fatalf("%s: %d", path, resp.StatusCode)
		}
	}
	resp, body := e.do(t, "GET", "/api/v1/version", nil, nil)
	if resp.StatusCode != 200 || !strings.Contains(string(body), `"mode":"api"`) || strings.Contains(string(body), "sha256") {
		t.Fatalf("version: %d %s", resp.StatusCode, body)
	}
}

func TestCORSExactOriginAndPreflight(t *testing.T) {
	const frontend = "https://paste.example.com"
	e := newEnv(t, func(c *Config) { c.APIOnly = true; c.FrontendOrigin = frontend })
	for _, method := range []string{"GET", "HEAD", "POST", "PUT", "DELETE"} {
		resp, _ := e.do(t, "OPTIONS", "/api/v1/pastes", nil, map[string]string{
			"Origin": frontend, "Access-Control-Request-Method": method,
			"Access-Control-Request-Headers": "content-type, nullbin-upload-token, nullbin-delete-token, nullbin-burn-token, nullbin-comment-token",
		})
		if resp.StatusCode != 204 || resp.Header.Get("Access-Control-Allow-Origin") != frontend || resp.Header.Get("Access-Control-Allow-Credentials") != "" {
			t.Fatalf("%s preflight: %d %v", method, resp.StatusCode, resp.Header)
		}
	}
	for _, tc := range []struct{ origin, method, headers string }{
		{"https://evil.example", "POST", "content-type"}, {"null", "POST", "content-type"},
		{"https://paste.example.com.evil.example", "POST", "content-type"},
		{frontend, "TRACE", "content-type"}, {frontend, "POST", "authorization"},
	} {
		resp, _ := e.do(t, "OPTIONS", "/api/v1/pastes", nil, map[string]string{"Origin": tc.origin, "Access-Control-Request-Method": tc.method, "Access-Control-Request-Headers": tc.headers})
		if resp.StatusCode != 403 || resp.Header.Get("Access-Control-Allow-Origin") != "" {
			t.Fatalf("bad preflight accepted: %+v %d", tc, resp.StatusCode)
		}
	}
	// No CORS grant is made for another site's GET, including error paths.
	resp, _ := e.do(t, "GET", "/api/v1/version", nil, map[string]string{"Origin": "https://evil.example"})
	if resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("foreign origin allowed")
	}
	// The exact origin gets CORS on errors too, so it can display API errors.
	resp, _ = e.do(t, "GET", "/api/v1/pastes/0123456789abcdef0123456789abcdef", nil, map[string]string{"Origin": frontend})
	if resp.StatusCode != 404 || resp.Header.Get("Access-Control-Allow-Origin") != frontend || !strings.Contains(resp.Header.Get("Access-Control-Expose-Headers"), "Retry-After") {
		t.Fatalf("CORS error response: %d %v", resp.StatusCode, resp.Header)
	}
}

func TestTrustedFrontendCanWriteButStillNeedsCapabilities(t *testing.T) {
	const frontend = "https://paste.example.com"
	e := newEnv(t, func(c *Config) { c.APIOnly = true; c.FrontendOrigin = frontend })
	hdr := map[string]string{"Origin": frontend, "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json"}
	resp, _ := e.do(t, "POST", "/api/v1/pastes", []byte(`{"expires_in":300,"burn_after_reading":false,"total_size":100}`), hdr)
	if resp.StatusCode != 201 || resp.Header.Get("Access-Control-Allow-Origin") != frontend {
		t.Fatalf("trusted create: %d", resp.StatusCode)
	}
	c := e.publish(t, blob(100), true, 100)
	url := "/api/v1/pastes/" + c.ID + "/read"
	for _, token := range []string{"", "wrong", testBurnToken} {
		resp, _ := e.do(t, "POST", url, nil, map[string]string{"Origin": frontend, "Sec-Fetch-Site": "cross-site", BurnTokenHeader: token})
		want := 404
		if token == testBurnToken {
			want = 200
		}
		if resp.StatusCode != want {
			t.Fatalf("burn capability: %d want %d", resp.StatusCode, want)
		}
	}
	resp, _ = e.do(t, "POST", "/api/v1/pastes", []byte(`{}`), map[string]string{"Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json"})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign write: %d", resp.StatusCode)
	}
}

func TestCORSDisabledByDefault(t *testing.T) {
	e := newEnv(t, nil)
	resp, _ := e.do(t, "OPTIONS", "/api/v1/pastes", nil, map[string]string{"Origin": "https://paste.example.com", "Access-Control-Request-Method": "POST"})
	if resp.Header.Get("Access-Control-Allow-Origin") != "" || resp.StatusCode == 204 {
		t.Fatal("CORS was enabled implicitly")
	}
}

func TestValidateFrontendOrigin(t *testing.T) {
	for _, origin := range []string{"https://paste.example.com", "https://paste.example.com:8443", "http://localhost:4173", "http://127.0.0.1:4173", "http://[::1]:4173"} {
		if err := ValidateFrontendOrigin(origin); err != nil {
			t.Errorf("%s rejected: %v", origin, err)
		}
	}
	for _, origin := range []string{"*", "null", "https://*.example.com", "http://paste.example.com", "https://paste.example.com/", "https://paste.example.com/path", "https://u:p@paste.example.com", "https://paste.example.com?x", "https://paste.example.com#x", "https://paste.example.com:443", "https://paste.example.com:0", "https://paste.example.com:99999", "https://PASTE.example.com", "https://paste.example.com\n"} {
		if err := ValidateFrontendOrigin(origin); err == nil {
			t.Errorf("%q accepted", origin)
		}
	}
}
