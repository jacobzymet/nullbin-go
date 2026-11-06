package server

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/jacobzymet/nullbin-go/internal/storage"
)

func TestSlotPoolPerClientAndGlobalCaps(t *testing.T) {
	p := newSlotPool(3, 2, 2)
	a := netip.MustParseAddr("192.0.2.1")
	b := netip.MustParseAddr("192.0.2.2")
	c := netip.MustParseAddr("192.0.2.3")

	relA1, ok1 := p.acquire(a)
	_, ok2 := p.acquire(a)
	if !ok1 || !ok2 {
		t.Fatal("client could not take its own slots")
	}
	if _, ok := p.acquire(a); ok {
		t.Fatal("client exceeded its per-client cap")
	}
	if _, ok := p.acquire(b); !ok {
		t.Fatal("other client was locked out")
	}
	if _, ok := p.acquire(c); ok {
		t.Fatal("global cap exceeded")
	}
	relA1()
	if _, ok := p.acquire(c); !ok {
		t.Fatal("released slot was not reusable")
	}
	// IPv6 clients are grouped by /64.
	v6 := newSlotPool(10, 1, 10)
	if _, ok := v6.acquire(netip.MustParseAddr("2001:db8::1")); !ok {
		t.Fatal("first v6")
	}
	if _, ok := v6.acquire(netip.MustParseAddr("2001:db8::2")); ok {
		t.Fatal("same /64 counted as a different client")
	}
}

// startRealServer serves e's handler over TCP so connection deadlines apply.
func startRealServer(t *testing.T, e *testEnv) string {
	t.Helper()
	hs := e.srv.HTTPServer("127.0.0.1:0")
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go hs.Serve(ln)
	t.Cleanup(func() { hs.Close() })
	return ln.Addr().String()
}

// openChunk sends a chunk request's headers and a few body bytes, then
// leaves the body unfinished.
func openChunk(t *testing.T, addr string, c createResponse, xff string) net.Conn {
	t.Helper()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	fmt.Fprintf(conn, "PUT /api/v1/pastes/%s/chunks/0 HTTP/1.1\r\nHost: test\r\nX-Forwarded-For: %s\r\nContent-Type: application/octet-stream\r\n%s: %s\r\nContent-Length: 1000\r\n\r\nx",
		c.ID, xff, UploadTokenHeader, c.UploadToken)
	return conn
}

// Reproduces the audit finding: one client holding every upload slot with
// stalled bodies made other clients' uploads fail with 503.
func TestOneClientCannotHoldAllUploadSlots(t *testing.T) {
	e := newEnv(t, func(c *Config) {
		c.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}
	})
	addr := startRealServer(t, e)
	const attacker, victim = "198.51.100.66", "198.51.100.7"

	for i := range chunkSlotsPerClient {
		openChunk(t, addr, createFrom(t, e, attacker), attacker)
		waitForSlots(t, e, i+1) // held open with a stalled body
	}
	// Further uploads from the same client are refused at once.
	if code := chunkFrom(t, e, createFrom(t, e, attacker), attacker); code != http.StatusServiceUnavailable {
		t.Fatalf("upload over the per-client cap: %d", code)
	}
	// Other clients still get through.
	if code := chunkFrom(t, e, createFrom(t, e, victim), victim); code != http.StatusNoContent {
		t.Fatalf("victim upload: %d", code)
	}
}

func chunkFrom(t *testing.T, e *testEnv, c createResponse, xff string) int {
	t.Helper()
	resp, _ := e.do(t, "PUT", "/api/v1/pastes/"+c.ID+"/chunks/0", blob(100), map[string]string{
		"Content-Type":    "application/octet-stream",
		UploadTokenHeader: c.UploadToken,
		"X-Forwarded-For": xff,
	})
	return resp.StatusCode
}

// A client that keeps sending a byte now and then, below the minimum rate,
// is cut off after the grace period instead of holding the chunk deadline.
func TestTrickledChunkUploadIsCutOff(t *testing.T) {
	e := newEnv(t, nil)
	e.srv.chunkGrace = 200 * time.Millisecond
	addr := startRealServer(t, e)
	c := e.create(t, 1000, false)

	conn := openChunk(t, addr, c, "198.51.100.1")
	start := time.Now()
	go func() {
		for range 100 {
			time.Sleep(50 * time.Millisecond)
			if _, err := conn.Write([]byte("x")); err != nil {
				return
			}
		}
	}()
	conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestTimeout {
		t.Fatalf("trickled upload: %d", resp.StatusCode)
	}
	if waited := time.Since(start); waited > 3*time.Second {
		t.Fatalf("trickled upload held a slot for %v", waited)
	}
	e.srv.chunkSlots.mu.Lock()
	active := len(e.srv.chunkSlots.active)
	e.srv.chunkSlots.mu.Unlock()
	if active != 0 || len(e.srv.chunkSlots.global) != 0 {
		t.Fatal("slot not released")
	}
	// The partial bytes were discarded; the chunk can be sent again.
	if code := e.chunk(t, c, 0, blob(1000)); code != http.StatusNoContent {
		t.Fatalf("retry: %d", code)
	}
}

func createFrom(t *testing.T, e *testEnv, xff string) createResponse {
	t.Helper()
	resp, b := e.do(t, "POST", "/api/v1/pastes", []byte(`{"expires_in":3600,"burn_after_reading":false,"total_size":1000}`),
		map[string]string{"Content-Type": "application/json", "X-Forwarded-For": xff})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", resp.StatusCode, b)
	}
	var c createResponse
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func waitForSlots(t *testing.T, e *testEnv, n int) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); len(e.srv.chunkSlots.global) != n; {
		if time.Now().After(deadline) {
			t.Fatalf("%d slots held, want %d", len(e.srv.chunkSlots.global), n)
		}
		time.Sleep(time.Millisecond)
	}
}

// One client could open every unfinished upload (the global limit) in a
// couple of minutes and block all uploads for the pending lifetime.
func TestOneClientCannotHoldAllPendingUploads(t *testing.T) {
	e := newEnv(t, func(c *Config) {
		c.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}
	})
	const attacker, victim = "198.51.100.66", "198.51.100.7"
	create := func(xff string) (int, createResponse) {
		resp, b := e.do(t, "POST", "/api/v1/pastes", []byte(`{"expires_in":3600,"burn_after_reading":false,"total_size":100}`),
			map[string]string{"Content-Type": "application/json", "X-Forwarded-For": xff})
		var c createResponse
		json.Unmarshal(b, &c)
		return resp.StatusCode, c
	}
	var first createResponse
	for i := range pendingPerClient {
		code, c := create(attacker)
		if code != http.StatusCreated {
			t.Fatalf("create %d: %d", i, code)
		}
		if i == 0 {
			first = c
		}
	}
	if code, _ := create(attacker); code != http.StatusServiceUnavailable {
		t.Fatalf("create over the per-client limit: %d", code)
	}
	if code, _ := create(victim); code != http.StatusCreated {
		t.Fatalf("victim create: %d", code)
	}
	// Finishing an upload frees its place.
	resp, _ := e.do(t, "PUT", "/api/v1/pastes/"+first.ID+"/chunks/0", blob(100), map[string]string{
		"Content-Type": "application/octet-stream", UploadTokenHeader: first.UploadToken, "X-Forwarded-For": attacker,
	})
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("chunk: %d", resp.StatusCode)
	}
	resp, _ = e.do(t, "POST", "/api/v1/pastes/"+first.ID+"/finalize", nil, map[string]string{
		UploadTokenHeader: first.UploadToken, "X-Forwarded-For": attacker,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("finalize: %d", resp.StatusCode)
	}
	if code, _ := create(attacker); code != http.StatusCreated {
		t.Fatalf("create after finalize: %d", code)
	}
}

// A reservation must belong to its upload, not to whichever network
// finalizes it. Otherwise uploads created from many networks and finalized
// from one would each leave a reservation behind for an hour, and enough of
// them would fill the tracker and lock every new network out of creating.
func TestFinalizeFromAnotherNetworkFreesTheReservation(t *testing.T) {
	e := newEnv(t, func(c *Config) {
		c.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}
	})
	const creator, finisher = "198.51.100.66", "203.0.113.9"
	finish := func(c createResponse) {
		t.Helper()
		resp, _ := e.do(t, "PUT", "/api/v1/pastes/"+c.ID+"/chunks/0", blob(1000), map[string]string{
			"Content-Type": "application/octet-stream", UploadTokenHeader: c.UploadToken, "X-Forwarded-For": finisher,
		})
		if resp.StatusCode != http.StatusNoContent {
			t.Fatalf("chunk: %d", resp.StatusCode)
		}
		resp, _ = e.do(t, "POST", "/api/v1/pastes/"+c.ID+"/finalize", nil, map[string]string{
			UploadTokenHeader: c.UploadToken, "X-Forwarded-For": finisher,
		})
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("finalize: %d", resp.StatusCode)
		}
	}
	var created []createResponse
	for range pendingPerClient {
		created = append(created, createFrom(t, e, creator))
	}
	for _, c := range created {
		finish(c)
	}
	// The creator's places are free again, and nothing is left over.
	createFrom(t, e, creator)
	e.srv.pending.mu.Lock()
	clients, owners := len(e.srv.pending.clients), len(e.srv.pending.owners)
	e.srv.pending.mu.Unlock()
	if clients != 1 || owners != 1 {
		t.Fatalf("tracker holds %d clients and %d uploads, want 1 and 1", clients, owners)
	}
}

func TestPendingTrackerExpiresEntries(t *testing.T) {
	p := newPendingTracker(2, 1000, time.Hour)
	ip := netip.MustParseAddr("192.0.2.1")
	now := time.Now()
	for i, want := range []bool{true, true, false} {
		if got := p.reserve(ip, now); got != want {
			t.Fatalf("reserve %d = %v, want %v", i, got, want)
		}
	}
	if !p.reserve(ip, now.Add(time.Hour+time.Second)) {
		t.Fatal("expired uploads still counted")
	}
	p.prune(now.Add(3 * time.Hour))
	if len(p.clients) != 0 {
		t.Fatal("prune kept expired entries")
	}
}

// One client reading slowly could hold every download slot for most of an
// hour on a large paste, so nobody else could download.
func TestOneClientCannotHoldAllDownloadSlots(t *testing.T) {
	e := newEnv(t, func(c *Config) {
		c.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}
		c.MaxSize = 8 << 20
	})
	addr := startRealServer(t, e)
	c := e.publish(t, blob(4<<20), false, 4<<20)
	const attacker, victim = "198.51.100.66", "198.51.100.7"

	for i := range downloadSlotsPerClient {
		conn, err := net.Dial("tcp", addr)
		if err != nil {
			t.Fatal(err)
		}
		conn.(*net.TCPConn).SetReadBuffer(4096)
		t.Cleanup(func() { conn.Close() })
		fmt.Fprintf(conn, "GET /api/v1/pastes/%s HTTP/1.1\r\nHost: test\r\nX-Forwarded-For: %s\r\n\r\n", c.ID, attacker)
		for deadline := time.Now().Add(5 * time.Second); len(e.srv.downloadSlots.global) != i+1; {
			if time.Now().After(deadline) {
				t.Fatalf("%d download slots held, want %d", len(e.srv.downloadSlots.global), i+1)
			}
			time.Sleep(time.Millisecond)
		}
		e.clock.add(3 * time.Second) // stay under the download request limit
	}
	resp, _ := e.do(t, "GET", "/api/v1/pastes/"+c.ID, nil, map[string]string{"X-Forwarded-For": attacker})
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("download over the per-client limit: %d", resp.StatusCode)
	}
	resp, body := e.do(t, "GET", "/api/v1/pastes/"+c.ID, nil, map[string]string{"X-Forwarded-For": victim})
	if resp.StatusCode != http.StatusOK || len(body) != 4<<20 {
		t.Fatalf("victim download: %d, %d bytes", resp.StatusCode, len(body))
	}
}

// Every chunk but the last must be a real 4 MiB chunk, and an upload left
// idle stops counting against its network as soon as storage frees it.
func TestChunkSizeAndIdleRules(t *testing.T) {
	e := newEnv(t, func(c *Config) {
		c.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}
		c.MaxSize = 8 << 20
	})
	e.store.SetMinChunk(storage.MinChunkBytes)
	const client = "198.51.100.66"
	put := func(c createResponse, n int, b []byte) (int, string) {
		resp, body := e.do(t, "PUT", fmt.Sprintf("/api/v1/pastes/%s/chunks/%d", c.ID, n), b, map[string]string{
			"Content-Type": "application/octet-stream", UploadTokenHeader: c.UploadToken, "X-Forwarded-For": client,
		})
		return resp.StatusCode, string(body)
	}
	resp, b := e.do(t, "POST", "/api/v1/pastes", []byte(fmt.Sprintf(`{"expires_in":3600,"burn_after_reading":false,"total_size":%d}`, storage.MinChunkBytes+10)),
		map[string]string{"Content-Type": "application/json", "X-Forwarded-For": client})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", resp.StatusCode, b)
	}
	var c createResponse
	json.Unmarshal(b, &c)
	if code, body := put(c, 0, blob(1<<20)); code != http.StatusBadRequest || !strings.Contains(body, "4 MiB") {
		t.Fatalf("1 MiB first chunk: %d %s", code, body)
	}
	if code, body := put(c, 0, blob(storage.MinChunkBytes)); code != http.StatusNoContent {
		t.Fatalf("4 MiB chunk: %d %s", code, body)
	}
	if code, body := put(c, 1, blob(10)); code != http.StatusNoContent {
		t.Fatalf("short last chunk: %d %s", code, body)
	}
	if resp, body := e.do(t, "POST", "/api/v1/pastes/"+c.ID+"/finalize", nil, map[string]string{
		UploadTokenHeader: c.UploadToken, "X-Forwarded-For": client,
	}); resp.StatusCode != http.StatusOK {
		t.Fatalf("finalize: %d %s", resp.StatusCode, body)
	}

	// Fill this network's places with uploads, then abandon them.
	for range pendingPerClient {
		createFrom(t, e, client)
	}
	if code := e.statusOf(t, client); code != http.StatusServiceUnavailable {
		t.Fatalf("create over the limit: %d", code)
	}
	e.clock.add(storage.PendingIdle + time.Second)
	e.store.Sweep()
	e.srv.Prune()
	if code := e.statusOf(t, client); code != http.StatusCreated {
		t.Fatalf("create after idle uploads expired: %d", code)
	}
	e.srv.pending.mu.Lock()
	owners := len(e.srv.pending.owners)
	e.srv.pending.mu.Unlock()
	if owners != 1 {
		t.Fatalf("tracker holds %d uploads, want 1", owners)
	}
}

// statusOf creates a small upload from client and returns the status.
func (e *testEnv) statusOf(t *testing.T, client string) int {
	t.Helper()
	resp, _ := e.do(t, "POST", "/api/v1/pastes", []byte(`{"expires_in":3600,"burn_after_reading":false,"total_size":1000}`),
		map[string]string{"Content-Type": "application/json", "X-Forwarded-For": client})
	return resp.StatusCode
}

func TestReconcileKeepsNewReservations(t *testing.T) {
	p := newPendingTracker(8, 1000, time.Hour)
	ip := netip.MustParseAddr("192.0.2.1")
	now := time.Now()
	p.reserve(ip, now)
	p.created(ip, strings.Repeat("a", 32))
	// Listed just after creation, before the upload might appear on disk.
	p.reconcile(nil, now.Add(time.Second))
	if len(p.owners) != 1 {
		t.Fatal("a brand-new reservation was dropped")
	}
	p.reconcile([]string{strings.Repeat("a", 32)}, now.Add(time.Minute))
	if len(p.owners) != 1 {
		t.Fatal("a reservation storage still holds was dropped")
	}
	p.reconcile(nil, now.Add(time.Minute))
	if len(p.owners) != 0 || len(p.clients) != 0 {
		t.Fatal("a reservation storage no longer holds was kept")
	}
}

// One IPv6 /48 holds 65,536 /64 client networks. Its networks together
// must not take more than the per-/48 share of the slots.
func TestSlotPoolCapsIPv6Sites(t *testing.T) {
	p := newSlotPool(100, 2, 3)
	var releases []func()
	take := func(addr string) bool {
		release, ok := p.acquire(netip.MustParseAddr(addr))
		if ok {
			releases = append(releases, release)
		}
		return ok
	}
	// Three /64s inside 2001:db8:1::/48 share three slots.
	for i, addr := range []string{"2001:db8:1:1::1", "2001:db8:1:1::2", "2001:db8:1:2::1"} {
		if !take(addr) {
			t.Fatalf("slot %d refused", i)
		}
	}
	if take("2001:db8:1:3::1") {
		t.Fatal("a fourth /64 in the same /48 got a slot")
	}
	if !take("2001:db8:2:1::1") || !take("192.0.2.1") {
		t.Fatal("another /48 or an IPv4 client was refused")
	}
	releases[0]()
	if !take("2001:db8:1:3::1") {
		t.Fatal("a released slot was not reusable within the /48")
	}
	for _, r := range releases[1:] {
		r()
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.active) != 0 || len(p.global) != 0 { // everything was released
		t.Fatalf("pool state after release: %d counters, %d slots", len(p.active), len(p.global))
	}
}

// A client that stops reading loses its download slot soon after the grace
// period, instead of keeping it until the whole-response deadline.
func TestStalledDownloadIsCutOff(t *testing.T) {
	e := newEnv(t, func(c *Config) { c.MaxSize = 16 << 20 })
	e.srv.downloadGrace = 300 * time.Millisecond
	e.srv.downloadRate = 16 << 20
	addr := startRealServer(t, e)
	c := e.publish(t, blob(12<<20), false, 4<<20)

	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.(*net.TCPConn).SetReadBuffer(4096)
	fmt.Fprintf(conn, "GET /api/v1/pastes/%s HTTP/1.1\r\nHost: test\r\n\r\n", c.ID)
	for deadline := time.Now().Add(5 * time.Second); len(e.srv.downloadSlots.global) != 1; {
		if time.Now().After(deadline) {
			t.Fatal("download never started")
		}
		time.Sleep(time.Millisecond)
	}
	// Never read. The whole-response deadline is over a minute away.
	for deadline := time.Now().Add(20 * time.Second); len(e.srv.downloadSlots.global) != 0; {
		if time.Now().After(deadline) {
			t.Fatal("a client that stopped reading still holds its download slot")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// One /48 holds 65,536 /64s and is free from tunnel brokers, so the
// per-client limit alone would let one attacker open every unfinished upload.
func TestOneIPv6SiteCannotHoldAllPendingUploads(t *testing.T) {
	e := newEnv(t, func(c *Config) {
		c.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}
	})
	create := func(xff string) int {
		resp, _ := e.do(t, "POST", "/api/v1/pastes", []byte(`{"expires_in":3600,"burn_after_reading":false,"total_size":100}`),
			map[string]string{"Content-Type": "application/json", "X-Forwarded-For": xff})
		return resp.StatusCode
	}
	// One upload from each of many /64s inside 2001:db8:1::/48.
	for i := range pendingPerSite {
		if code := create(fmt.Sprintf("2001:db8:1:%x::1", i)); code != http.StatusCreated {
			t.Fatalf("create %d: %d", i, code)
		}
	}
	if code := create("2001:db8:1:ffff::1"); code != http.StatusServiceUnavailable {
		t.Fatalf("create beyond the /48 limit: %d, want 503", code)
	}
	if code := create("2001:db8:2::1"); code != http.StatusCreated {
		t.Fatalf("another /48 was refused: %d", code)
	}
	if code := create("192.0.2.9"); code != http.StatusCreated {
		t.Fatalf("an IPv4 client was refused: %d", code)
	}
}

func TestPendingTrackerCountsSitesExactly(t *testing.T) {
	p := newPendingTracker(2, 3, time.Hour)
	now := time.Now()
	a, b := netip.MustParseAddr("2001:db8:5:1::1"), netip.MustParseAddr("2001:db8:5:2::1")
	for i, tc := range []struct {
		ip   netip.Addr
		want bool
	}{{a, true}, {a, true}, {a, false}, {b, true}, {b, false}} {
		if got := p.reserve(tc.ip, now); got != tc.want {
			t.Fatalf("reserve %d = %v, want %v", i, got, tc.want)
		}
	}
	p.cancel(a) // frees one place in the /48
	if !p.reserve(b, now) {
		t.Fatal("cancelled reservation still counted for the /48")
	}
	p.prune(now.Add(2 * time.Hour))
	if len(p.clients) != 0 || len(p.sites) != 0 || len(p.siteOf) != 0 {
		t.Fatalf("left over: %d clients, %d sites, %d site links", len(p.clients), len(p.sites), len(p.siteOf))
	}
}

// Per-/64 limits alone let one /48 create 20 pastes from each of 65,536
// networks at once.
func TestOneIPv6SiteIsRateLimitedAsAWhole(t *testing.T) {
	e := newEnv(t, func(c *Config) {
		c.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}
	})
	create := func(xff string) int {
		resp, _ := e.do(t, "POST", "/api/v1/pastes", []byte(`{"expires_in":300,"burn_after_reading":false,"total_size":100}`),
			map[string]string{"Content-Type": "application/json", "X-Forwarded-For": xff})
		return resp.StatusCode
	}
	limited := 0
	for i := range 200 {
		if code := create(fmt.Sprintf("2001:db8:7:%x::1", i)); code == http.StatusTooManyRequests {
			limited++
		}
	}
	// The /48 gets 4 clients' burst (80); its unfinished-upload cap (32)
	// refuses most of the rest first, so count both kinds of refusal.
	if limited == 0 {
		t.Fatal("no create from 200 networks in one /48 was rate limited")
	}
	if code := create("2001:db8:8::1"); code != http.StatusCreated {
		t.Fatalf("another /48 was refused: %d", code)
	}
}

// Deletes read metadata from disk, so they must be rate limited too.
func TestDeletesAreRateLimited(t *testing.T) {
	e := newEnv(t, nil)
	id := strings.Repeat("ab", 16)
	limited := false
	for range 40 {
		resp, _ := e.do(t, "DELETE", "/api/v1/pastes/"+id, nil, map[string]string{DeleteTokenHeader: strings.Repeat("A", 43)})
		if resp.StatusCode == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("40 deletes in a row were never rate limited")
	}
}
