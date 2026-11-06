package server

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jacobzymet/nullbin-go/internal/assets"
	"github.com/jacobzymet/nullbin-go/internal/storage"
)

func TestBurnRequiresAuthorizedSameOriginPOST(t *testing.T) {
	e := newEnv(t, nil)
	content := blob(1000)
	c := e.publish(t, content, true, 1000)
	url := "/api/v1/pastes/" + c.ID
	for _, req := range []struct {
		method, suffix string
		headers        map[string]string
		status         int
	}{
		{"GET", "", nil, 404},
		{"GET", "", map[string]string{BurnTokenHeader: testBurnToken}, 404},
		{"HEAD", "", nil, 405},
		{"GET", "/read", nil, 405},
		{"POST", "/read", nil, 404},
		{"POST", "/read", map[string]string{BurnTokenHeader: storage.NewToken()}, 404},
		{"POST", "/read", map[string]string{BurnTokenHeader: testBurnToken, "Sec-Fetch-Site": "cross-site"}, 403},
	} {
		resp, _ := e.do(t, req.method, url+req.suffix, nil, req.headers)
		if resp.StatusCode != req.status {
			t.Fatalf("%s %s: %d", req.method, req.suffix, resp.StatusCode)
		}
	}
	resp, prefix := e.do(t, "GET", url+"/prefix", nil, nil)
	if resp.StatusCode != 200 || !bytes.Equal(prefix, content[:22]) {
		t.Fatalf("prefix: %d, %d", resp.StatusCode, len(prefix))
	}
	resp, data := e.do(t, "POST", url+"/read", nil, map[string]string{BurnTokenHeader: testBurnToken})
	if resp.StatusCode != 200 || !bytes.Equal(data, content) {
		t.Fatalf("authorized read: %d", resp.StatusCode)
	}
	resp, _ = e.do(t, "POST", url+"/read", nil, map[string]string{BurnTokenHeader: testBurnToken})
	if resp.StatusCode != 404 {
		t.Fatalf("replay: %d", resp.StatusCode)
	}
}

func TestCreateMapsStorageCapacityErrors(t *testing.T) {
	for _, tc := range []struct {
		name   string
		limits storage.Limits
		status int
	}{
		{"quota", storage.Limits{MaxBytes: 64 << 10, MaxPending: 10}, http.StatusInsufficientStorage},
		{"pending", storage.Limits{MaxBytes: 1 << 20, MaxPending: 1}, http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st, err := storage.OpenWithLimits(t.TempDir(), tc.limits)
			if err != nil {
				t.Fatal(err)
			}
			defer st.Close()
			e := newEnv(t, func(c *Config) { c.Store = st })
			e.create(t, 100, false)
			resp, _ := e.do(t, "POST", "/api/v1/pastes", []byte(`{"expires_in":300,"burn_after_reading":false,"total_size":100}`), jsonHdr)
			if resp.StatusCode != tc.status {
				t.Fatalf("got %d, want %d", resp.StatusCode, tc.status)
			}
		})
	}
}

func TestActiveUploadLimitDoesNotAcceptBody(t *testing.T) {
	e := newEnv(t, nil)
	c := e.create(t, 100, false)
	for range cap(e.srv.chunkSlots.global) {
		e.srv.chunkSlots.global <- struct{}{}
	}
	if status := e.chunk(t, c, 0, blob(100)); status != 503 {
		t.Fatalf("busy: %d", status)
	}
	<-e.srv.chunkSlots.global
	if status := e.chunk(t, c, 0, blob(100)); status != 204 {
		t.Fatalf("retry: %d", status)
	}
}

func TestDownloadRateLimitAndProxySpoofResistance(t *testing.T) {
	e := newEnv(t, nil)
	c := e.publish(t, blob(100), false, 100)
	for i := range 21 {
		resp, _ := e.do(t, "GET", "/api/v1/pastes/"+c.ID, nil, map[string]string{"X-Forwarded-For": storage.NewID()})
		want := 200
		if i == 20 {
			want = 429
		}
		if resp.StatusCode != want {
			t.Fatalf("request %d: %d", i, resp.StatusCode)
		}
		if want == 429 && resp.Header.Get("Retry-After") == "" {
			t.Fatal("missing Retry-After")
		}
	}
}

func TestBandwidthCancellationAndSharedBudget(t *testing.T) {
	e := newEnv(t, nil)
	ip := netip.MustParseAddr("192.0.2.1")
	now := time.Now()
	e.srv.downloadBytes.allowN(ip, now, clientBytesPerSecond)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var out bytes.Buffer
	w := bandwidthWriter{ctx: ctx, dst: &out, s: e.srv, ip: ip}
	if n, err := w.Write(make([]byte, bandwidthChunk)); n != 0 || !errors.Is(err, context.Canceled) {
		t.Fatalf("%d, %v", n, err)
	}
	// Every IP competes for one global bucket; a depleted global budget
	// cancels a different client's stream too, before any bytes are sent.
	// Drain it as of a minute from now, so it cannot refill (32 KiB takes
	// 2 ms) before the write below, however slow the machine is.
	e.srv.globalBytes.allowN(netip.Addr{}, time.Now().Add(time.Minute), globalBytesPerSecond)
	ctx, stop := context.WithTimeout(context.Background(), time.Millisecond)
	defer stop()
	w.ctx, w.ip = ctx, netip.MustParseAddr("192.0.2.2")
	if n, err := w.Write(make([]byte, bandwidthChunk)); n != 0 || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("%d, %v", n, err)
	}
}

// A stopped response must abort the HTTP stream, not finish a partial
// success body. net/http handles this sentinel without logging the request.
func serveAborted(t *testing.T, s *Server, w http.ResponseWriter, r *http.Request) {
	t.Helper()
	defer func() {
		if v := recover(); v != http.ErrAbortHandler {
			t.Fatalf("abort = %v", v)
		}
	}()
	s.Handler().ServeHTTP(w, r)
	t.Fatal("response did not abort")
}

func TestStaticAssetsShareBandwidthAndConcurrencyLimits(t *testing.T) {
	for _, budget := range []string{"client", "global"} {
		t.Run(budget, func(t *testing.T) {
			e := newEnv(t, func(c *Config) {
				c.Assets = assets.New(make([]byte, bandwidthChunk), make([]byte, bandwidthChunk), make([]byte, bandwidthChunk))
			})
			ip := netip.MustParseAddr("192.0.2.1")
			lim := newLimiter(1, bandwidthChunk, 10)
			key := ip
			if budget == "client" {
				e.srv.downloadBytes = lim
			} else {
				e.srv.globalBytes = lim
				key = netip.Addr{}
			}
			lim.allowN(key, time.Now(), bandwidthChunk)
			for _, path := range []string{"/", "/p/0123456789abcdef0123456789abcdef", "/d/0123456789abcdef0123456789abcdef", "/assets/app.js", "/assets/app.css"} {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
				r := httptest.NewRequest("GET", path, nil).WithContext(ctx)
				r.RemoteAddr = "192.0.2.1:1234"
				w := httptest.NewRecorder()
				serveAborted(t, e.srv, w, r)
				cancel()
				if w.Body.Len() != 0 {
					t.Fatalf("%s bypassed %s budget", path, budget)
				}
			}
			for range cap(e.srv.downloadSlots.global) {
				e.srv.downloadSlots.global <- struct{}{}
			}
			w := httptest.NewRecorder()
			e.srv.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/assets/app.js", nil))
			if w.Code != 503 {
				t.Fatalf("slot limit: %d", w.Code)
			}
		})
	}
}

func TestStaticRequestLimitAndHEAD(t *testing.T) {
	e := newEnv(t, nil)
	resp, body := e.do(t, "HEAD", "/assets/app.js", nil, nil)
	if resp.StatusCode != 200 || len(body) != 0 || resp.ContentLength != int64(len(testBundle.JS)) {
		t.Fatal("invalid HEAD response")
	}
	for range 99 {
		resp, _ = e.do(t, "GET", "/assets/app.js", nil, nil)
		if resp.StatusCode != 200 {
			t.Fatalf("asset: %d", resp.StatusCode)
		}
	}
	resp, _ = e.do(t, "GET", "/assets/app.css", nil, map[string]string{"X-Forwarded-For": "198.51.100.1"})
	if resp.StatusCode != 429 {
		t.Fatalf("static request limit: %d", resp.StatusCode)
	}
}

func TestCancelledDiscussionDoesNotReadCommentBodies(t *testing.T) {
	e := newEnv(t, nil)
	token := storage.NewToken()
	c, err := e.store.CreatePending(time.Hour, false, 100, token)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.store.AppendChunk(c.ID, 0, c.UploadToken, bytes.NewReader(blob(100))); err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.Finalize(c.ID, c.UploadToken); err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.AddComment(c.ID, token, []byte("first")); err != nil {
		t.Fatal(err)
	}
	// A cancelled request must stop before even reading this corrupt file.
	if err := os.WriteFile(filepath.Join(e.dir, "pastes", c.ID, "comments", "000001"), make([]byte, storage.MaxCommentBytes+1), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := httptest.NewRequest("GET", "/api/v1/pastes/"+c.ID+"/comments", nil).WithContext(ctx)
	r.Header.Set(CommentTokenHeader, token)
	w := httptest.NewRecorder()
	serveAborted(t, e.srv, w, r)
	if w.Body.Len() != 0 || e.logs.String() != "" {
		t.Fatalf("read data after cancellation: %q %q", w.Body.String(), e.logs.String())
	}
}
