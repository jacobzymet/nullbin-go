package server

import (
	"errors"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

// ValidateFrontendOrigin requires an exact browser origin, with no paths,
// credentials, wildcard, query or fragment. Plain HTTP is local-test only.
func ValidateFrontendOrigin(origin string) error {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.ContainsAny(origin, "*%\\ \t\r\n") {
		return errors.New("use an origin such as https://paste.example.com, without a path or trailing slash")
	}
	host := u.Hostname()
	ip, _ := netip.ParseAddr(host)
	local := host == "localhost" || ip.IsLoopback()
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return errors.New("HTTPS is required (HTTP is allowed only on localhost)")
	}
	if origin != u.Scheme+"://"+strings.ToLower(u.Host) || host == "" || strings.HasSuffix(u.Host, ":") {
		return errors.New("use a lowercase, canonical browser origin")
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 || strconv.Itoa(n) != port || (u.Scheme == "https" && n == 443) || (u.Scheme == "http" && n == 80) {
			return errors.New("invalid port; omit the default HTTPS/HTTP port")
		}
	}
	return nil
}

var corsMethods = map[string]bool{"GET": true, "HEAD": true, "POST": true, "PUT": true, "DELETE": true}
var corsHeaders = map[string]bool{
	"content-type": true, "nullbin-upload-token": true, "nullbin-delete-token": true,
	"nullbin-burn-token": true, "nullbin-comment-token": true,
}

// Grant only the explicitly configured frontend origin. No cookies or
// ambient credentials are used; capability headers remain mandatory.
func cors(frontend string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/v1/") || frontend == "" {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Add("Vary", "Origin")
		origin := r.Header.Get("Origin")
		preflight := r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != ""
		if origin != frontend {
			if preflight {
				writeError(w, http.StatusForbidden, "origin not allowed")
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		if preflight {
			w.Header().Add("Vary", "Access-Control-Request-Method")
			w.Header().Add("Vary", "Access-Control-Request-Headers")
			if !corsMethods[r.Header.Get("Access-Control-Request-Method")] {
				writeError(w, http.StatusForbidden, "method not allowed")
				return
			}
			for _, name := range strings.Split(r.Header.Get("Access-Control-Request-Headers"), ",") {
				name = strings.ToLower(strings.TrimSpace(name))
				if name != "" && !corsHeaders[name] {
					writeError(w, http.StatusForbidden, "header not allowed")
					return
				}
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, DELETE")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Nullbin-Upload-Token, Nullbin-Delete-Token, Nullbin-Burn-Token, Nullbin-Comment-Token")
			w.Header().Set("Access-Control-Max-Age", "600")
		}
		w.Header().Set("Access-Control-Allow-Origin", frontend)
		w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Retry-After, Nullbin-Reads-Remaining")
		if preflight {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
