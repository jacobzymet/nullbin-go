package server

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"runtime/debug"
	"strings"
	"syscall"

	"github.com/jacobzymet/nullbin-go/internal/storage"
)

// ContentSecurityPolicy is sent on every response. 'wasm-unsafe-eval'
// lets the bundled libsodium compile its WebAssembly; it does not allow
// JavaScript eval or any other script source. img-src allows data: only
// because Bootstrap's form controls use inline SVG data URIs, and blob: for
// image previews, which the page makes itself from verified attachments.
const ContentSecurityPolicy = "default-src 'none'; " +
	"script-src 'self' 'wasm-unsafe-eval'; " +
	"style-src 'self'; " +
	"connect-src 'self'; " +
	"img-src 'self' blob: data:; " +
	"font-src 'self'; " +
	"base-uri 'none'; " +
	"form-action 'none'; " +
	"frame-ancestors 'none'; " +
	// Trusted Types: browsers that enforce it refuse HTML-injection sinks such as
	// innerHTML, so a future DOM XSS bug fails closed. No policies exist.
	"require-trusted-types-for 'script'; trusted-types 'none'"

// PermissionsPolicy denies every powerful feature. The one exception is
// clipboard-write for this origin, which the copy buttons need.
const PermissionsPolicy = "accelerometer=(), autoplay=(), browsing-topics=(), camera=(), " +
	"clipboard-read=(), clipboard-write=(self), display-capture=(), encrypted-media=(), " +
	"fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), " +
	"magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), " +
	"publickey-credentials-create=(), publickey-credentials-get=(), screen-wake-lock=(), " +
	"serial=(), sync-xhr=(), usb=(), web-share=(), xr-spatial-tracking=()"

// securityHeaders sets the security headers on every response, including
// errors and redirects produced by the router.
func securityHeaders(behindHTTPS bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", ContentSecurityPolicy)
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Cache-Control", "no-store")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		// With COOP, this isolates the page in its own process group, which
		// limits side-channel (Spectre-style) reads of its memory.
		h.Set("Cross-Origin-Embedder-Policy", "require-corp")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Permissions-Policy", PermissionsPolicy)
		if behindHTTPS {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

// limitBody caps every request body. Individual routes narrow it further.
func limitBody(n int64, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, n)
		next.ServeHTTP(w, r)
	})
}

// recoverPanics turns a handler panic into a 500 and logs it without the
// panic value or any request details. Without this, net/http would log
// the client's address.
func recoverPanics(logger *log.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			v := recover()
			if v == nil {
				return
			}
			if v == http.ErrAbortHandler {
				panic(v) // net/http aborts the response silently
			}
			logger.Printf("error: handler panic (%T)\n%s", v, debug.Stack())
			writeError(w, http.StatusInternalServerError, "internal error")
		}()
		next.ServeHTTP(w, r)
	})
}

// NewErrorLog returns a logger for http.Server.ErrorLog that redacts
// anything that looks like a network address before passing the message
// to logger.
func NewErrorLog(logger *log.Logger) *log.Logger {
	return log.New(scrubWriter{logger}, "", 0)
}

type scrubWriter struct{ logger *log.Logger }

func (s scrubWriter) Write(p []byte) (int, error) {
	s.logger.Print(scrubAddresses(string(p)))
	return len(p), nil
}

// scrubAddresses replaces every word that contains a digit together with
// a '.' or an inner ':' (IPv4, IPv6, host:port) with [redacted].
func scrubAddresses(msg string) string {
	fields := strings.Fields(msg)
	for i, f := range fields {
		core := strings.TrimRight(f, ":,;)")
		if strings.ContainsAny(core, "0123456789") && strings.ContainsAny(core, ".:") {
			fields[i] = "[redacted]"
		}
	}
	return strings.Join(fields, " ")
}

// describeError renders an error for the log without paths (which contain
// paste IDs) or any other request data. Unknown error types are reported
// by type only.
func describeError(err error) string {
	switch {
	case err == nil:
		return "<nil>"
	case errors.Is(err, storage.ErrCorrupt),
		errors.Is(err, storage.ErrNotFound),
		errors.Is(err, storage.ErrConflict),
		errors.Is(err, storage.ErrTooLarge),
		errors.Is(err, storage.ErrIncomplete),
		errors.Is(err, storage.ErrEmptyChunk),
		errors.Is(err, storage.ErrChunkTooSmall),
		errors.Is(err, storage.ErrNotErased),
		errors.Is(err, storage.ErrNewerFormat),
		errors.Is(err, io.ErrUnexpectedEOF):
		return err.Error()
	}
	// Path errors carry the path (with the paste ID) separately from the
	// cause. The cause is an errno or a fixed message, so it is safe to log.
	var pe *fs.PathError
	if errors.As(err, &pe) {
		return pe.Op + ": " + describeCause(pe.Err)
	}
	var le *os.LinkError
	if errors.As(err, &le) {
		return le.Op + ": " + describeCause(le.Err)
	}
	var se *os.SyscallError
	if errors.As(err, &se) {
		return se.Syscall + ": " + describeError(se.Err)
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return errno.Error()
	}
	return fmt.Sprintf("%T", err)
}

func describeCause(err error) string {
	var pe *fs.PathError
	var le *os.LinkError
	if err == nil || errors.As(err, &pe) || errors.As(err, &le) {
		return describeError(err)
	}
	return err.Error()
}
