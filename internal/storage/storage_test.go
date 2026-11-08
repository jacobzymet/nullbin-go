package storage

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *testClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *testClock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func newTestStore(t *testing.T) (*Store, *testClock, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	clk := &testClock{t: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)}
	s.now = clk.now
	s.minChunk = 1 // most tests upload in small chunks; see TestMinimumChunkSize
	t.Cleanup(func() { s.Close() })
	return s, clk, dir
}

const testBurnToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

// publish uploads content in chunks of chunkSize and finalizes it.
func publish(t *testing.T, s *Store, content []byte, burn bool, expires time.Duration, chunkSize int) Created {
	t.Helper()
	token := ""
	if burn {
		token = testBurnToken
	}
	c, err := s.CreatePending(expires, burn, int64(len(content)), "", token)
	if err != nil {
		t.Fatal(err)
	}
	for n, off := 0, 0; off < len(content); n++ {
		end := min(off+chunkSize, len(content))
		if err := s.AppendChunk(c.ID, n, c.UploadToken, bytes.NewReader(content[off:end])); err != nil {
			t.Fatalf("chunk %d: %v", n, err)
		}
		off = end
	}
	if _, err := s.Finalize(c.ID, c.UploadToken); err != nil {
		t.Fatal(err)
	}
	return c
}

func readAll(t *testing.T, s *Store, id string) []byte {
	t.Helper()
	p, err := s.Get(id)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	defer p.Close()
	b, err := io.ReadAll(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func entries(t *testing.T, dir string) []string {
	t.Helper()
	des, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, de := range des {
		names = append(names, de.Name())
	}
	sort.Strings(names)
	return names
}

var testContent = bytes.Repeat([]byte("ciphertext-bytes-"), 100)

func TestValidID(t *testing.T) {
	good := []string{
		"0123456789abcdef0123456789abcdef",
		"00000000000000000000000000000000",
		"ffffffffffffffffffffffffffffffff",
		NewID(),
	}
	bad := []string{
		"",
		"0123456789abcdef0123456789abcde",
		"0123456789abcdef0123456789abcdef0",
		"0123456789ABCDEF0123456789abcdef",
		"0123456789abcdef0123456789abcdeg",
		"../../../../../../../../etc/passwd",
		"0123456789abcdef0123456789abcd/.",
		"0123456789abcdef0123456789abcde\x00",
		"0123456789abcdef0123456789abcde\n",
		" 0123456789abcdef0123456789abcde",
		"０123456789abcdef0123456789abcd",
	}
	for _, id := range good {
		if !ValidID(id) {
			t.Errorf("ValidID(%q) = false, want true", id)
		}
	}
	for _, id := range bad {
		if ValidID(id) {
			t.Errorf("ValidID(%q) = true, want false", id)
		}
	}
}

var idPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

func FuzzValidID(f *testing.F) {
	f.Add("0123456789abcdef0123456789abcdef")
	f.Add("../0123456789abcdef0123456789ab")
	f.Add("0123456789abcdef0123456789abcdef\n")
	f.Add("")
	f.Fuzz(func(t *testing.T, id string) {
		if got, want := ValidID(id), idPattern.MatchString(id); got != want {
			t.Fatalf("ValidID(%q) = %v, regexp says %v", id, got, want)
		}
	})
}

func TestNewIDAndTokens(t *testing.T) {
	seen := map[string]bool{}
	for range 100 {
		id := NewID()
		if !ValidID(id) || seen[id] {
			t.Fatalf("bad or repeated id %q", id)
		}
		seen[id] = true
	}
	tok := NewToken()
	if len(tok) != 43 || strings.ContainsAny(tok, "+/=") {
		t.Fatalf("token %q is not 32 bytes of unpadded base64url", tok)
	}
	if tok == NewToken() {
		t.Fatal("tokens repeat")
	}
	h := HashToken(tok)
	if len(h) != 64 {
		t.Fatalf("hash length %d", len(h))
	}
	if !TokenMatches(h, tok) {
		t.Fatal("token does not match its own hash")
	}
	for _, wrong := range []string{"", tok[:42], tok + "a", NewToken()} {
		if TokenMatches(h, wrong) {
			t.Fatalf("wrong token %q matched", wrong)
		}
	}
	for _, stored := range []string{"", "zz", h[:62], h + "00"} {
		if TokenMatches(stored, tok) {
			t.Fatalf("malformed stored hash %q matched", stored)
		}
	}
}

func TestRoundTrip(t *testing.T) {
	s, clk, _ := newTestStore(t)
	c := publish(t, s, testContent, false, time.Hour, 300)

	p, err := s.Get(c.ID)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(p)
	p.Close()
	if !bytes.Equal(got, testContent) {
		t.Fatal("content mismatch")
	}
	m := p.Meta
	if m.ID != c.ID || m.Burn || m.Size != int64(len(testContent)) {
		t.Fatalf("unexpected meta %+v", m)
	}
	if !m.CreatedAt.Equal(clk.now().Truncate(time.Second)) || m.ExpiresAt.Sub(m.CreatedAt) != time.Hour {
		t.Fatalf("unexpected times %+v", m)
	}
	// Not burned: can be read again.
	if !bytes.Equal(readAll(t, s, c.ID), testContent) {
		t.Fatal("second read mismatch")
	}
}

func TestStoredMetadataIsMinimal(t *testing.T) {
	s, _, dir := newTestStore(t)
	c := publish(t, s, testContent, true, time.Hour, 1000)

	pasteDir := filepath.Join(dir, "pastes", c.ID)
	if got := entries(t, pasteDir); strings.Join(got, ",") != "blob,meta.json" {
		t.Fatalf("paste directory holds %v", got)
	}
	raw, err := os.ReadFile(filepath.Join(pasteDir, "meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	var keys []string
	for k := range fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	want := "burn_after_reading,burn_token_sha256,created_at,delete_token_sha256,expires_at,id,size"
	if strings.Join(keys, ",") != want {
		t.Fatalf("meta.json keys = %v, want %s", keys, want)
	}
	// Raw tokens never touch the disk.
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, _ := os.ReadFile(p)
		if bytes.Contains(b, []byte(c.UploadToken)) || bytes.Contains(b, []byte(c.DeleteToken)) {
			t.Errorf("%s contains a raw token", p)
		}
		if bytes.Contains(b, []byte(HashToken(c.UploadToken))) {
			t.Errorf("%s still holds the upload token hash after finalize", p)
		}
		return nil
	})
}

func TestChunksMustArriveInOrder(t *testing.T) {
	s, _, _ := newTestStore(t)
	c, err := s.CreatePending(time.Hour, false, 6, "")
	if err != nil {
		t.Fatal(err)
	}
	chunk := func(n int, data string) error {
		return s.AppendChunk(c.ID, n, c.UploadToken, strings.NewReader(data))
	}
	if err := chunk(1, "ab"); !errors.Is(err, ErrConflict) {
		t.Fatalf("chunk 1 first: %v, want ErrConflict", err)
	}
	if err := chunk(-1, "ab"); !errors.Is(err, ErrConflict) {
		t.Fatalf("chunk -1: %v, want ErrConflict", err)
	}
	if err := chunk(0, "ab"); err != nil {
		t.Fatal(err)
	}
	if err := chunk(0, "ab"); !errors.Is(err, ErrConflict) {
		t.Fatalf("repeated chunk 0: %v, want ErrConflict", err)
	}
	if err := chunk(2, "cd"); !errors.Is(err, ErrConflict) {
		t.Fatalf("skipped chunk: %v, want ErrConflict", err)
	}
	if err := chunk(1, "cd"); err != nil {
		t.Fatal(err)
	}
	if err := chunk(2, "ef"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Finalize(c.ID, c.UploadToken); err != nil {
		t.Fatal(err)
	}
	if got := readAll(t, s, c.ID); string(got) != "abcdef" {
		t.Fatalf("got %q", got)
	}
}

func TestChunkCannotExceedTotalSize(t *testing.T) {
	s, _, dir := newTestStore(t)
	c, _ := s.CreatePending(time.Hour, false, 10, "")
	if err := s.AppendChunk(c.ID, 0, c.UploadToken, strings.NewReader("12345678901")); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversized chunk: %v, want ErrTooLarge", err)
	}
	if err := s.AppendChunk(c.ID, 0, c.UploadToken, strings.NewReader("123456")); err != nil {
		t.Fatal(err)
	}
	if err := s.AppendChunk(c.ID, 1, c.UploadToken, strings.NewReader("78901")); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("running total over limit: %v, want ErrTooLarge", err)
	}
	// The rejected bytes were discarded.
	fi, err := os.Stat(filepath.Join(dir, "pending", c.ID, "blob"))
	if err != nil || fi.Size() != 6 {
		t.Fatalf("blob size after rejected chunk = %v, %v; want 6", fi, err)
	}
	if err := s.AppendChunk(c.ID, 1, c.UploadToken, strings.NewReader("7890")); err != nil {
		t.Fatal(err)
	}
	if err := s.AppendChunk(c.ID, 2, c.UploadToken, strings.NewReader("x")); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("chunk after full: %v, want ErrTooLarge", err)
	}
	if _, err := s.Finalize(c.ID, c.UploadToken); err != nil {
		t.Fatal(err)
	}
	if got := readAll(t, s, c.ID); string(got) != "1234567890" {
		t.Fatalf("got %q", got)
	}
}

func TestEmptyChunkRejected(t *testing.T) {
	s, _, _ := newTestStore(t)
	c, _ := s.CreatePending(time.Hour, false, 10, "")
	if err := s.AppendChunk(c.ID, 0, c.UploadToken, strings.NewReader("")); !errors.Is(err, ErrEmptyChunk) {
		t.Fatalf("empty chunk: %v, want ErrEmptyChunk", err)
	}
}

var errBoom = errors.New("connection reset")

type failingReader struct {
	data []byte
	sent bool
}

func (r *failingReader) Read(p []byte) (int, error) {
	if r.sent {
		return 0, errBoom
	}
	r.sent = true
	return copy(p, r.data), nil
}

func TestFailedChunkCanBeRetried(t *testing.T) {
	s, _, _ := newTestStore(t)
	c, _ := s.CreatePending(time.Hour, false, 8, "")
	err := s.AppendChunk(c.ID, 0, c.UploadToken, &failingReader{data: []byte("XYZ")})
	if !errors.Is(err, errBoom) {
		t.Fatalf("interrupted chunk: %v, want read error", err)
	}
	if err := s.AppendChunk(c.ID, 0, c.UploadToken, strings.NewReader("abcd")); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if err := s.AppendChunk(c.ID, 1, c.UploadToken, strings.NewReader("efgh")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Finalize(c.ID, c.UploadToken); err != nil {
		t.Fatal(err)
	}
	if got := readAll(t, s, c.ID); string(got) != "abcdefgh" {
		t.Fatalf("got %q", got)
	}
}

func TestTruncatedUploadIsNeverPublished(t *testing.T) {
	s, clk, dir := newTestStore(t)
	c, _ := s.CreatePending(time.Hour, false, 10, "")
	if err := s.AppendChunk(c.ID, 0, c.UploadToken, strings.NewReader("12345")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Finalize(c.ID, c.UploadToken); !errors.Is(err, ErrIncomplete) {
		t.Fatalf("finalize of partial upload: %v, want ErrIncomplete", err)
	}
	if _, err := s.Get(c.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get of unpublished paste: %v, want ErrNotFound", err)
	}
	// Abandoned: the sweeper removes it once it has been idle too long.
	clk.add(PendingIdle - time.Second)
	if st := s.Sweep(); st.StalePending != 0 {
		t.Fatalf("young pending upload swept: %+v", st)
	}
	clk.add(2 * time.Second)
	if err := s.AppendChunk(c.ID, 1, c.UploadToken, strings.NewReader("67890")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("chunk to stale upload: %v, want ErrNotFound", err)
	}
	if st := s.Sweep(); st.StalePending != 1 || st.Errors != 0 {
		t.Fatalf("stale pending not swept: %+v", st)
	}
	if got := entries(t, filepath.Join(dir, "pending")); len(got) != 0 {
		t.Fatalf("pending dir still holds %v", got)
	}
}

func TestUploadTokenRequired(t *testing.T) {
	s, _, _ := newTestStore(t)
	c, _ := s.CreatePending(time.Hour, false, 4, "")
	other := NewToken()
	if err := s.AppendChunk(c.ID, 0, other, strings.NewReader("abcd")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("wrong token chunk: %v", err)
	}
	if err := s.AppendChunk(c.ID, 0, "", strings.NewReader("abcd")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("empty token chunk: %v", err)
	}
	if err := s.AppendChunk(c.ID, 0, c.DeleteToken, strings.NewReader("abcd")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete token accepted as upload token: %v", err)
	}
	if err := s.AppendChunk(c.ID, 0, c.UploadToken, strings.NewReader("abcd")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Finalize(c.ID, other); !errors.Is(err, ErrNotFound) {
		t.Fatalf("wrong token finalize: %v", err)
	}
	if _, err := s.Finalize(c.ID, c.UploadToken); err != nil {
		t.Fatal(err)
	}
	// After publishing, the upload token is useless.
	if err := s.AppendChunk(c.ID, 1, c.UploadToken, strings.NewReader("e")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("chunk after finalize: %v", err)
	}
	if _, err := s.Finalize(c.ID, c.UploadToken); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second finalize: %v", err)
	}
}

func TestConcurrentOperationOnSameUpload(t *testing.T) {
	s, _, _ := newTestStore(t)
	c, _ := s.CreatePending(time.Hour, false, 4, "")
	if !s.lock(c.ID) {
		t.Fatal("lock")
	}
	if err := s.AppendChunk(c.ID, 0, c.UploadToken, strings.NewReader("abcd")); !errors.Is(err, ErrConflict) {
		t.Fatalf("chunk while busy: %v, want ErrConflict", err)
	}
	if _, err := s.Finalize(c.ID, c.UploadToken); !errors.Is(err, ErrConflict) {
		t.Fatalf("finalize while busy: %v, want ErrConflict", err)
	}
	s.unlock(c.ID)
	if err := s.AppendChunk(c.ID, 0, c.UploadToken, strings.NewReader("abcd")); err != nil {
		t.Fatal(err)
	}
}

func TestExpiry(t *testing.T) {
	s, clk, dir := newTestStore(t)
	a := publish(t, s, testContent, false, 5*time.Minute, 500)
	b := publish(t, s, testContent, false, 5*time.Minute, 500)
	keep := publish(t, s, testContent, false, time.Hour, 500)

	clk.add(5*time.Minute - time.Second)
	readAll(t, s, a.ID)
	clk.add(time.Second) // now == expires_at: expired

	// Checked on every read, and removed right away.
	if _, err := s.Get(a.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get expired: %v, want ErrNotFound", err)
	}
	if err := s.Delete(b.ID, b.DeleteToken); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Delete expired: %v, want ErrNotFound", err)
	}
	if got := entries(t, filepath.Join(dir, "pastes")); len(got) != 1 || got[0] != keep.ID {
		t.Fatalf("pastes after expiry reads = %v", got)
	}

	clk.add(time.Hour)
	if st := s.Sweep(); st.Expired != 1 || st.Errors != 0 {
		t.Fatalf("sweep stats %+v, want 1 expired", st)
	}
	if got := entries(t, filepath.Join(dir, "pastes")); len(got) != 0 {
		t.Fatalf("pastes after sweep = %v", got)
	}
	if got := entries(t, filepath.Join(dir, "claimed")); len(got) != 0 {
		t.Fatalf("claimed after sweep = %v", got)
	}
}

func TestBurnAfterReading(t *testing.T) {
	s, _, dir := newTestStore(t)
	c := publish(t, s, testContent, true, time.Hour, 700)

	p, err := s.ReadBurn(c.ID, testBurnToken)
	if err != nil {
		t.Fatal(err)
	}
	// Claimed: already gone from pastes/ before a single byte is read.
	if got := entries(t, filepath.Join(dir, "pastes")); len(got) != 0 {
		t.Fatalf("pastes while streaming = %v", got)
	}
	if _, err := s.ReadBurn(c.ID, testBurnToken); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second Get while first streams: %v", err)
	}
	// An active claim survives a sweep.
	if st := s.Sweep(); st.Claimed != 0 {
		t.Fatalf("sweep removed an active claim: %+v", st)
	}
	got, err := io.ReadAll(p)
	if err != nil || !bytes.Equal(got, testContent) {
		t.Fatalf("burn read: %v", err)
	}
	p.Close()
	if got := entries(t, filepath.Join(dir, "claimed")); len(got) != 0 {
		t.Fatalf("claimed after close = %v", got)
	}
	if _, err := s.ReadBurn(c.ID, testBurnToken); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after burn: %v", err)
	}
	if err := s.Delete(c.ID, c.DeleteToken); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Delete after burn: %v", err)
	}
}

func TestBurnInterruptedReadStillDestroys(t *testing.T) {
	s, _, dir := newTestStore(t)
	c := publish(t, s, testContent, true, time.Hour, 700)
	p, err := s.ReadBurn(c.ID, testBurnToken)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 10)
	p.Read(buf) // read a little, then the "connection drops"
	p.Close()
	if _, err := s.ReadBurn(c.ID, testBurnToken); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after interrupted burn: %v", err)
	}
	if got := entries(t, filepath.Join(dir, "claimed")); len(got) != 0 {
		t.Fatalf("claimed = %v", got)
	}
}

// 50 goroutines GET the same burn-after-reading paste at once. Exactly one
// must succeed. Repeated to give the race detector and the scheduler
// several chances.
func TestBurnConcurrentReadersExactlyOneWins(t *testing.T) {
	s, _, dir := newTestStore(t)
	const readers = 50
	for round := range 10 {
		c := publish(t, s, testContent, true, time.Hour, 400)
		var (
			wg      sync.WaitGroup
			start   = make(chan struct{})
			mu      sync.Mutex
			winners int
			other   []error
		)
		for range readers {
			wg.Go(func() {
				<-start
				p, err := s.ReadBurn(c.ID, testBurnToken)
				if err != nil {
					if !errors.Is(err, ErrNotFound) {
						mu.Lock()
						other = append(other, err)
						mu.Unlock()
					}
					return
				}
				got, rerr := io.ReadAll(p)
				p.Close()
				mu.Lock()
				winners++
				if rerr != nil || !bytes.Equal(got, testContent) {
					other = append(other, errors.New("winner read wrong content"))
				}
				mu.Unlock()
			})
		}
		close(start)
		wg.Wait()
		if winners != 1 || len(other) != 0 {
			t.Fatalf("round %d: %d winners, unexpected errors %v", round, winners, other)
		}
	}
	for _, d := range []string{"pastes", "claimed", "pending"} {
		if got := entries(t, filepath.Join(dir, d)); len(got) != 0 {
			t.Fatalf("%s not empty: %v", d, got)
		}
	}
}

func TestDelete(t *testing.T) {
	s, _, _ := newTestStore(t)
	c := publish(t, s, testContent, false, time.Hour, 900)
	for _, wrong := range []string{"", c.UploadToken, NewToken()} {
		if err := s.Delete(c.ID, wrong); !errors.Is(err, ErrNotFound) {
			t.Fatalf("Delete with wrong token: %v", err)
		}
	}
	readAll(t, s, c.ID) // still there
	if err := s.Delete(c.ID, c.DeleteToken); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(c.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after delete: %v", err)
	}
	if err := s.Delete(c.ID, c.DeleteToken); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}

	burn := publish(t, s, testContent, true, time.Hour, 900)
	if err := s.Delete(burn.ID, burn.DeleteToken); err != nil {
		t.Fatalf("delete burn paste: %v", err)
	}
	if _, err := s.Get(burn.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after delete: %v", err)
	}
}

func TestSweepLeftoversAndUnknownEntries(t *testing.T) {
	s, _, dir := newTestStore(t)
	mk := func(p string) {
		if err := os.MkdirAll(filepath.Join(dir, p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, p, "blob"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	id := NewID()
	mk("claimed/" + id + "-0123456789abcdef") // leftover from a crash
	mk("claimed/not-a-claim")                 // unknown: left alone
	mk("pastes/README")                       // unknown: left alone
	mk("pending/notes")                       // unknown: left alone
	mk("pastes/" + NewID())                   // published dir without meta.json: corrupt
	corrupt := NewID()
	mk("pastes/" + corrupt)
	os.WriteFile(filepath.Join(dir, "pastes", corrupt, "meta.json"), []byte("{not json"), 0o600)

	st := s.Sweep()
	if st.Claimed != 1 || st.Unreadable != 2 || st.Expired != 0 || st.Errors != 0 {
		t.Fatalf("sweep stats %+v", st)
	}
	if got := entries(t, filepath.Join(dir, "claimed")); strings.Join(got, ",") != "not-a-claim" {
		t.Fatalf("claimed = %v", got)
	}
	if got := entries(t, filepath.Join(dir, "pastes")); strings.Join(got, ",") != "README" {
		t.Fatalf("pastes = %v", got)
	}
	if got := entries(t, filepath.Join(dir, "pending")); strings.Join(got, ",") != "notes" {
		t.Fatalf("pending = %v", got)
	}
}

func TestPathTraversalIsRejected(t *testing.T) {
	s, _, dir := newTestStore(t)
	outside := filepath.Join(filepath.Dir(dir), "outside-"+NewID())
	t.Cleanup(func() { os.RemoveAll(outside) })
	ids := []string{
		"../../../../etc/passwd",
		"..",
		".",
		"",
		"/",
		`..\..\..\windows`,
		"../" + filepath.Base(outside),
		"0123456789abcdef0123456789abcde/",
		"0123456789abcdef0123456789abcdef/../../x",
		"0123456789ABCDEF0123456789ABCDEF",
		"%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2f",
		strings.Repeat("\x00", 32),
	}
	for _, id := range ids {
		if _, err := s.Get(id); !errors.Is(err, ErrNotFound) {
			t.Errorf("Get(%q) = %v", id, err)
		}
		if err := s.Delete(id, "x"); !errors.Is(err, ErrNotFound) {
			t.Errorf("Delete(%q) = %v", id, err)
		}
		if err := s.AppendChunk(id, 0, "x", strings.NewReader("data")); !errors.Is(err, ErrNotFound) {
			t.Errorf("AppendChunk(%q) = %v", id, err)
		}
		if _, err := s.Finalize(id, "x"); !errors.Is(err, ErrNotFound) {
			t.Errorf("Finalize(%q) = %v", id, err)
		}
	}
	if _, err := os.Stat(outside); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("something was created outside the data dir: %v", err)
	}
	if got := entries(t, dir); strings.Join(got, ",") != "claimed,pastes,pending" {
		t.Fatalf("data dir = %v", got)
	}
}

// Even if an attacker could plant a symlink inside the data directory,
// os.Root must refuse to follow it outside.
func TestSymlinkCannotEscapeDataDir(t *testing.T) {
	s, _, dir := newTestStore(t)
	outside := t.TempDir()
	id := NewID()
	meta, _ := json.Marshal(Meta{ID: id, CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour), Size: 6, DeleteTokenHash: HashToken("t")})
	os.WriteFile(filepath.Join(outside, "meta.json"), meta, 0o600)
	os.WriteFile(filepath.Join(outside, "blob"), []byte("secret"), 0o600)
	if err := os.Symlink(outside, filepath.Join(dir, "pastes", id)); err != nil {
		t.Skipf("cannot create symlinks here: %v", err)
	}

	if p, err := s.Get(id); err == nil {
		p.Close()
		t.Fatal("Get followed a symlink out of the data directory")
	}
	if err := s.Delete(id, "t"); err == nil {
		t.Fatal("Delete followed a symlink out of the data directory")
	}
	s.Sweep()
	for _, f := range []string{"meta.json", "blob"} {
		if _, err := os.Stat(filepath.Join(outside, f)); err != nil {
			t.Fatalf("file outside the data dir was touched: %v", err)
		}
	}
}

func TestFilePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permissions only")
	}
	s, _, dir := newTestStore(t)
	c := publish(t, s, testContent, false, time.Hour, 1000)
	pending, _ := s.CreatePending(time.Hour, false, 10, "")
	check := func(p string, want fs.FileMode) {
		fi, err := os.Stat(filepath.Join(dir, p))
		if err != nil {
			t.Fatal(err)
		}
		if perm := fi.Mode().Perm(); perm&^want != 0 {
			t.Errorf("%s has mode %o, want at most %o", p, perm, want)
		}
	}
	for _, d := range []string{".", "pending", "pastes", "claimed", "pastes/" + c.ID, "pending/" + pending.ID} {
		check(d, 0o700)
	}
	for _, f := range []string{"pastes/" + c.ID + "/meta.json", "pastes/" + c.ID + "/blob", "pending/" + pending.ID + "/upload.json", "pending/" + pending.ID + "/blob"} {
		check(f, 0o600)
	}
}

func TestOpenRejectsNonDirectories(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "pastes"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if s, err := Open(dir); err == nil {
		s.Close()
		t.Fatal("Open accepted a file named pastes")
	}
}

func TestCreatePendingValidatesInput(t *testing.T) {
	s, _, _ := newTestStore(t)
	if _, err := s.CreatePending(0, false, 10, ""); err == nil {
		t.Fatal("zero expiry accepted")
	}
	if _, err := s.CreatePending(time.Hour, false, 0, ""); err == nil {
		t.Fatal("zero size accepted")
	}
}

func TestOutOfOrderErrorReportsNextChunk(t *testing.T) {
	s, _, _ := newTestStore(t)
	c, _ := s.CreatePending(time.Hour, false, 10, "")
	s.AppendChunk(c.ID, 0, c.UploadToken, strings.NewReader("abc"))
	err := s.AppendChunk(c.ID, 0, c.UploadToken, strings.NewReader("abc"))
	var ooo *OutOfOrderError
	if !errors.As(err, &ooo) || ooo.Next != 1 || !errors.Is(err, ErrConflict) {
		t.Fatalf("err = %v", err)
	}
}

// publishDiscussion publishes a paste with a discussion and returns it with
// its comment token.
func publishDiscussion(t *testing.T, s *Store) (Created, string) {
	t.Helper()
	token := NewToken()
	c, err := s.CreatePending(time.Hour, false, int64(len(testContent)), token)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.AppendChunk(c.ID, 0, c.UploadToken, bytes.NewReader(testContent)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Finalize(c.ID, c.UploadToken); err != nil {
		t.Fatal(err)
	}
	return c, token
}

func TestCommentsRoundTrip(t *testing.T) {
	s, _, dir := newTestStore(t)
	c, token := publishDiscussion(t, s)

	if got, err := allComments(s, c.ID, token); err != nil || len(got) != 0 {
		t.Fatalf("empty discussion: %v %v", got, err)
	}
	want := [][]byte{[]byte("first"), []byte("second"), bytes.Repeat([]byte{7}, MaxCommentBytes)}
	for i, w := range want {
		n, err := s.AddComment(c.ID, token, w)
		if err != nil || n != i+1 {
			t.Fatalf("AddComment %d: n=%d err=%v", i, n, err)
		}
	}
	got, err := allComments(s, c.ID, token)
	if err != nil || len(got) != len(want) {
		t.Fatalf("Comments: %d, %v", len(got), err)
	}
	for i := range want {
		if !bytes.Equal(got[i], want[i]) {
			t.Fatalf("comment %d differs", i)
		}
	}
	// The paste itself is unchanged and the token never touches the disk.
	if !bytes.Equal(readAll(t, s, c.ID), testContent) {
		t.Fatal("paste content changed")
	}
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if b, _ := os.ReadFile(p); bytes.Contains(b, []byte(token)) {
				t.Errorf("%s contains the raw comment token", p)
			}
		}
		return nil
	})
	raw, _ := os.ReadFile(filepath.Join(dir, "pastes", c.ID, "meta.json"))
	if !bytes.Contains(raw, []byte(`"comment_token_sha256":"`+HashToken(token)+`"`)) {
		t.Fatalf("meta.json lacks the comment token hash: %s", raw)
	}
}

// A comment is never written over another one, and a listing that fails is
// an error, not an empty discussion.
func TestCommentNeverReplacesAnother(t *testing.T) {
	s, _, _ := newTestStore(t)
	c, token := publishDiscussion(t, s)
	if _, err := s.AddComment(c.ID, token, []byte("first")); err != nil {
		t.Fatal(err)
	}
	cdir := path.Join(dirPastes, c.ID, dirComments)
	if err := s.createFile(cdir, "000001", []byte("replacement")); !errors.Is(err, fs.ErrExist) {
		t.Fatalf("createFile over an existing comment: %v", err)
	}
	got, err := allComments(s, c.ID, token)
	if err != nil || len(got) != 1 || string(got[0]) != "first" {
		t.Fatalf("comments after the refused write: %q %v", got, err)
	}
	if names, err := s.commentNames(path.Join(cdir, "000001")); err == nil {
		t.Fatalf("listing a file instead of a folder: %v, no error", names)
	}
	if names, err := s.commentNames(path.Join(dirPastes, c.ID, "missing")); err != nil || names != nil {
		t.Fatalf("a missing folder means no comments: %v %v", names, err)
	}
}

func TestCommentTokenRequired(t *testing.T) {
	s, _, _ := newTestStore(t)
	c, token := publishDiscussion(t, s)
	for _, wrong := range []string{"", c.DeleteToken, c.UploadToken, NewToken(), token + "x"} {
		if _, err := s.AddComment(c.ID, wrong, []byte("spam")); !errors.Is(err, ErrNotFound) {
			t.Errorf("AddComment with wrong token: %v", err)
		}
		if _, err := allComments(s, c.ID, wrong); !errors.Is(err, ErrNotFound) {
			t.Errorf("Comments with wrong token: %v", err)
		}
	}
	for _, id := range []string{"../" + c.ID, strings.ToUpper(c.ID), ""} {
		if _, err := s.AddComment(id, token, []byte("x")); !errors.Is(err, ErrNotFound) {
			t.Errorf("AddComment(%q): %v", id, err)
		}
	}
}

func TestPastesWithoutDiscussionTakeNoComments(t *testing.T) {
	s, _, dir := newTestStore(t)
	c := publish(t, s, testContent, false, time.Hour, 1000)
	for _, token := range []string{"", NewToken()} {
		if _, err := s.AddComment(c.ID, token, []byte("x")); !errors.Is(err, ErrNotFound) {
			t.Fatalf("AddComment on a plain paste: %v", err)
		}
		if _, err := allComments(s, c.ID, token); !errors.Is(err, ErrNotFound) {
			t.Fatalf("Comments on a plain paste: %v", err)
		}
	}
	if got := entries(t, filepath.Join(dir, "pastes", c.ID)); strings.Join(got, ",") != "blob,meta.json" {
		t.Fatalf("plain paste dir = %v", got)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "pastes", c.ID, "meta.json"))
	if bytes.Contains(raw, []byte("comment")) {
		t.Fatalf("plain paste stores comment fields: %s", raw)
	}
}

func TestBurnPastesCannotHaveDiscussions(t *testing.T) {
	s, _, _ := newTestStore(t)
	if _, err := s.CreatePending(time.Hour, true, 100, NewToken()); err == nil {
		t.Fatal("burn-after-reading paste with a discussion was accepted")
	}
}

func TestCommentLimits(t *testing.T) {
	s, _, _ := newTestStore(t)
	c, token := publishDiscussion(t, s)
	if _, err := s.AddComment(c.ID, token, nil); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("empty comment: %v", err)
	}
	if _, err := s.AddComment(c.ID, token, make([]byte, MaxCommentBytes+1)); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("oversized comment: %v", err)
	}
	for i := range MaxComments {
		if _, err := s.AddComment(c.ID, token, []byte{byte(i)}); err != nil {
			t.Fatalf("comment %d: %v", i, err)
		}
	}
	if _, err := s.AddComment(c.ID, token, []byte("one too many")); !errors.Is(err, ErrDiscussionFull) {
		t.Fatalf("comment over the limit: %v", err)
	}
	if got, _ := allComments(s, c.ID, token); len(got) != MaxComments {
		t.Fatalf("stored %d comments", len(got))
	}
}

func TestCommentsGoWithThePaste(t *testing.T) {
	s, clk, dir := newTestStore(t)
	a, tokA := publishDiscussion(t, s)
	b, tokB := publishDiscussion(t, s)
	s.AddComment(a.ID, tokA, []byte("x"))
	s.AddComment(b.ID, tokB, []byte("y"))

	if err := s.Delete(a.ID, a.DeleteToken); err != nil {
		t.Fatal(err)
	}
	if _, err := allComments(s, a.ID, tokA); !errors.Is(err, ErrNotFound) {
		t.Fatalf("comments of a deleted paste: %v", err)
	}
	clk.add(time.Hour)
	if _, err := s.AddComment(b.ID, tokB, []byte("late")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("comment on an expired paste: %v", err)
	}
	if _, err := allComments(s, b.ID, tokB); !errors.Is(err, ErrNotFound) {
		t.Fatalf("comments of an expired paste: %v", err)
	}
	s.Sweep()
	for _, d := range []string{"pastes", "claimed"} {
		if got := entries(t, filepath.Join(dir, d)); len(got) != 0 {
			t.Fatalf("%s not empty: %v", d, got)
		}
	}
}

func TestConcurrentCommentsAreAllKept(t *testing.T) {
	s, _, _ := newTestStore(t)
	c, token := publishDiscussion(t, s)
	const writers = 20
	var wg sync.WaitGroup
	for i := range writers {
		wg.Go(func() {
			for {
				_, err := s.AddComment(c.ID, token, []byte{byte(i)})
				if errors.Is(err, ErrConflict) {
					time.Sleep(time.Millisecond) // busy: the client retries
					continue
				}
				if err != nil {
					t.Error(err)
				}
				return
			}
		})
	}
	wg.Wait()
	got, err := allComments(s, c.ID, token)
	if err != nil || len(got) != writers {
		t.Fatalf("%d comments, %v", len(got), err)
	}
	seen := map[byte]bool{}
	for _, b := range got {
		seen[b[0]] = true
	}
	if len(seen) != writers {
		t.Fatalf("lost or duplicated comments: %v", seen)
	}
}

func TestDeleteWhileBusyIsAConflict(t *testing.T) {
	s, _, _ := newTestStore(t)
	c := publish(t, s, testContent, false, time.Hour, 1000)
	s.lock(c.ID)
	if err := s.Delete(c.ID, c.DeleteToken); !errors.Is(err, ErrConflict) {
		t.Fatalf("Delete while busy: %v", err)
	}
	s.unlock(c.ID)
	if err := s.Delete(c.ID, c.DeleteToken); err != nil {
		t.Fatal(err)
	}
}

// Only tests collect a whole discussion; the HTTP handler streams it.
func allComments(s *Store, id, token string) ([][]byte, error) {
	comments, err := s.Comments(id, token)
	if err != nil {
		return nil, err
	}
	out := [][]byte{}
	for b, err := range comments {
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, nil
}

func TestCommentsReadLazilyAndStopAtCorruption(t *testing.T) {
	s, _, dir := newTestStore(t)
	c, token := publishDiscussion(t, s)
	for _, text := range []string{"first", "second", "third"} {
		if _, err := s.AddComment(c.ID, token, []byte(text)); err != nil {
			t.Fatal(err)
		}
	}
	comments, err := s.Comments(c.ID, token)
	if err != nil {
		t.Fatal(err)
	}
	// Change a later file after opening. The first item must still arrive;
	// breaking the iteration must not read or retain the other comments.
	if err := os.WriteFile(filepath.Join(dir, "pastes", c.ID, "comments", "000002"), make([]byte, MaxCommentBytes+1), 0600); err != nil {
		t.Fatal(err)
	}
	seen := 0
	for b, err := range comments {
		if err != nil || string(b) != "first" {
			t.Fatalf("first: %q, %v", b, err)
		}
		seen++
		break
	}
	if seen != 1 {
		t.Fatal("missing first comment")
	}
	seen = 0
	for _, err := range comments {
		seen++
		if seen == 2 && !errors.Is(err, ErrCorrupt) {
			t.Fatalf("corruption: %v", err)
		}
		if seen > 2 {
			t.Fatal("continued after corrupt comment")
		}
	}
	if seen != 2 {
		t.Fatalf("read %d comments", seen)
	}
}

func TestMinimumChunkSize(t *testing.T) {
	fresh, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if fresh.minChunk != MinChunkBytes {
		t.Fatalf("default minimum chunk %d, want %d", fresh.minChunk, MinChunkBytes)
	}
	fresh.Close()
	s, _, _ := newTestStore(t)
	s.minChunk = 8
	c, _ := s.CreatePending(time.Hour, false, 20, "")
	if err := s.AppendChunk(c.ID, 0, c.UploadToken, strings.NewReader("12345")); !errors.Is(err, ErrChunkTooSmall) {
		t.Fatalf("small chunk: %v, want ErrChunkTooSmall", err)
	}
	// The rejected chunk left nothing behind and the same index works.
	for i, part := range []string{"12345678", "abcdefgh", "wxyz"} { // the last chunk may be short
		if err := s.AppendChunk(c.ID, i, c.UploadToken, strings.NewReader(part)); err != nil {
			t.Fatalf("chunk %d: %v", i, err)
		}
	}
	if _, err := s.Finalize(c.ID, c.UploadToken); err != nil {
		t.Fatal(err)
	}
	p, err := s.Get(c.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if b, _ := io.ReadAll(p); string(b) != "12345678abcdefghwxyz" {
		t.Fatalf("content %q", b)
	}
}

// An upload that stops sending chunks is freed after PendingIdle, not after
// PendingTTL, so idle uploads cannot hold every pending slot for an hour.
func TestIdleUploadExpiresAndFreesItsSlot(t *testing.T) {
	s, err := OpenWithLimits(t.TempDir(), Limits{MaxBytes: DefaultMaxBytes, MaxPending: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	clk := &testClock{t: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)}
	s.now = clk.now
	s.minChunk = 1
	c, err := s.CreatePending(time.Hour, false, 100, "")
	if err != nil {
		t.Fatal(err)
	}
	// Steady progress keeps it alive well past PendingIdle.
	for i := range 5 {
		clk.add(PendingIdle - time.Second)
		if err := s.AppendChunk(c.ID, i, c.UploadToken, strings.NewReader("x")); err != nil {
			t.Fatalf("chunk %d after a short pause: %v", i, err)
		}
		if st := s.Sweep(); st.StalePending != 0 {
			t.Fatalf("active upload swept: %+v", st)
		}
	}
	if _, err := s.CreatePending(time.Hour, false, 100, ""); !errors.Is(err, ErrUploadLimit) {
		t.Fatalf("second upload while the first is active: %v, want ErrUploadLimit", err)
	}
	clk.add(PendingIdle + time.Second)
	if err := s.AppendChunk(c.ID, 5, c.UploadToken, strings.NewReader("x")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("chunk to idle upload: %v, want ErrNotFound", err)
	}
	if _, err := s.Finalize(c.ID, c.UploadToken); !errors.Is(err, ErrNotFound) {
		t.Fatalf("finalize of idle upload: %v, want ErrNotFound", err)
	}
	if st := s.Sweep(); st.StalePending != 1 {
		t.Fatalf("idle upload not swept: %+v", st)
	}
	if ids, ok := s.PendingIDs(); !ok || len(ids) != 0 {
		t.Fatalf("pending after sweep: %v %v", ids, ok)
	}
	if _, err := s.CreatePending(time.Hour, false, 100, ""); err != nil {
		t.Fatalf("slot not freed: %v", err)
	}
}

// Operators remove reported pastes by ID, without the delete link.
func TestRemoveByOperator(t *testing.T) {
	s, _, dir := newTestStore(t)
	c, token := publishDiscussion(t, s)
	if _, err := s.AddComment(c.ID, token, []byte("comment")); err != nil {
		t.Fatal(err)
	}
	pending, err := s.CreatePending(time.Hour, false, 100, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{c.ID, pending.ID} {
		if err := s.Remove(id); err != nil {
			t.Fatalf("Remove: %v", err)
		}
		if err := s.Remove(id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("second Remove: %v, want ErrNotFound", err)
		}
	}
	if _, err := s.Get(c.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after Remove: %v", err)
	}
	for _, bad := range []string{"", "../pastes", strings.Repeat("A", 32), strings.Repeat("a", 33)} {
		if err := s.Remove(bad); !errors.Is(err, ErrNotFound) {
			t.Fatalf("Remove(%q): %v, want ErrNotFound", bad, err)
		}
	}
	for _, sub := range []string{"pastes", "pending", "claimed"} {
		if got := entries(t, filepath.Join(dir, sub)); len(got) != 0 {
			t.Fatalf("%s still holds %v", sub, got)
		}
	}
	if s.used != 0 || s.pending != 0 {
		t.Fatalf("storage still charged: %d bytes, %d pending", s.used, s.pending)
	}
}

// A sweep must never delete a live paste because its metadata could not be
// read at that moment (out of file handles, an I/O error, a permission
// problem). It used to treat every read error as "unreadable forever".
func TestSweepKeepsPastesItCannotReadRightNow(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file permissions work differently on Windows")
	}
	s, _, dir := newTestStore(t)
	c := publish(t, s, testContent, false, time.Hour, 1000)
	meta := filepath.Join(dir, "pastes", c.ID, "meta.json")
	if err := os.Chmod(meta, 0); err != nil {
		t.Fatal(err)
	}
	if f, err := os.Open(meta); err == nil {
		f.Close()
		t.Skip("running as root: permissions do not stop reads")
	}
	st := s.Sweep()
	if st.Expired != 0 || st.Unreadable != 0 || st.Errors != 1 {
		t.Fatalf("sweep stats %+v", st)
	}
	if err := os.Chmod(meta, 0o600); err != nil {
		t.Fatal(err)
	}
	p, err := s.Get(c.ID)
	if err != nil {
		t.Fatalf("paste lost after a failed read: %v", err)
	}
	p.Close()
}

// Requests never create links, but one planted in the data directory must
// not let a paste's comments land in another paste's discussion.
func TestCommentsRefuseALinkedDirectory(t *testing.T) {
	s, _, dir := newTestStore(t)
	victim, _ := publishDiscussion(t, s)
	attacker, token := publishDiscussion(t, s)
	if err := os.Symlink(filepath.Join(dir, "pastes", victim.ID, "comments"), filepath.Join(dir, "pastes", attacker.ID, "comments")); err != nil {
		t.Skipf("cannot create links here: %v", err)
	}
	if _, err := s.AddComment(attacker.ID, token, make([]byte, 100)); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("comment through a link: %v", err)
	}
	if _, err := s.Comments(attacker.ID, token); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("comments read through a link: %v", err)
	}
}

// After a rollback, pastes written by a newer release can carry metadata
// fields this version does not know. They must be kept (not served) until
// they expire, never deleted as corrupt.
func TestPastesFromANewerVersionAreKept(t *testing.T) {
	s, clk, dir := newTestStore(t)
	c := publish(t, s, testContent, false, time.Hour, 1000)
	meta := filepath.Join(dir, "pastes", c.ID, "meta.json")
	raw, err := os.ReadFile(meta)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	m["a_future_field"] = true
	raw, _ = json.Marshal(m)
	if err := os.WriteFile(meta, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if st := s.Sweep(); st.Newer != 1 || st.Unreadable != 0 || st.Expired != 0 {
		t.Fatalf("sweep stats %+v", st)
	}
	if _, err := s.Get(c.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("served a paste from a newer version: %v", err)
	}
	clk.mu.Lock()
	clk.t = clk.t.Add(2 * time.Hour)
	clk.mu.Unlock()
	if st := s.Sweep(); st.Expired != 1 {
		t.Fatalf("an expired paste from a newer version was kept: %+v", st)
	}
}

// A gap in the comment files (one removed by hand) must never make a new
// comment replace an existing one.
func TestCommentNamesContinueAfterTheHighest(t *testing.T) {
	s, _, dir := newTestStore(t)
	c, token := publishDiscussion(t, s)
	for _, b := range []string{"first", "second"} {
		if _, err := s.AddComment(c.ID, token, []byte(b)); err != nil {
			t.Fatal(err)
		}
	}
	cdir := filepath.Join(dir, "pastes", c.ID, "comments")
	if err := os.Remove(filepath.Join(cdir, "000001")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddComment(c.ID, token, []byte("third")); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(cdir, "000002")); string(got) != "second" {
		t.Fatalf("an existing comment was replaced: %q", got)
	}
	if got, _ := os.ReadFile(filepath.Join(cdir, "000003")); string(got) != "third" {
		t.Fatalf("new comment: %q", got)
	}
}

func TestMaxPastesRefusesNewUploads(t *testing.T) {
	s, err := OpenWithLimits(t.TempDir(), Limits{MaxBytes: DefaultMaxBytes, MaxPending: 10, MaxPastes: 2})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for range 2 {
		if _, err := s.CreatePending(time.Hour, false, 100, ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.CreatePending(time.Hour, false, 100, ""); !errors.Is(err, ErrQuota) {
		t.Fatalf("third paste with a cap of two: %v", err)
	}
}

// A chunk is charged as its bytes arrive, so one that sends nothing holds
// at most one segment of the budget, not the whole chunk.
func TestChunkIsChargedAsBytesArrive(t *testing.T) {
	s, _, _ := newTestStore(t)
	c, err := s.CreatePending(time.Hour, false, MaxChunkBytes, "")
	if err != nil {
		t.Fatal(err)
	}
	pr, pw := io.Pipe()
	done := make(chan error, 1)
	go func() { done <- s.AppendChunk(c.ID, 0, c.UploadToken, pr) }()
	time.Sleep(100 * time.Millisecond)
	s.quotaMu.Lock()
	used := s.used
	s.quotaMu.Unlock()
	if used > entryOverhead+1<<20 {
		t.Fatalf("a chunk that sent nothing is charged %d bytes", used)
	}
	pw.CloseWithError(errors.New("client went away"))
	if err := <-done; err == nil {
		t.Fatal("an interrupted chunk succeeded")
	}
	if s.used != entryOverhead {
		t.Fatalf("an interrupted chunk left %d bytes charged", s.used-entryOverhead)
	}
}

// A one-open burn paste whose open is recorded as used is never served,
// even if its directory is still there.
func TestUsedUpBurnPasteIsNotServed(t *testing.T) {
	s, _, dir := newTestStore(t)
	c := publish(t, s, testContent, true, time.Hour, 1000)
	pdir := path.Join(dirPastes, c.ID)
	m, err := s.readMeta(pdir, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	m.ReadLimit, m.ReadsUsed = 1, 1
	if err := s.writeJSON(pdir, fileMeta, m); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadBurn(c.ID, testBurnToken); !errors.Is(err, ErrNotFound) {
		t.Fatalf("used-up burn paste: %v", err)
	}
	_ = dir
}

// Invalid sizes in one paste's metadata must not stop the server starting.
func TestStartupToleratesInvalidSizes(t *testing.T) {
	s, _, dir := newTestStore(t)
	c := publish(t, s, testContent, false, time.Hour, 1000)
	meta := filepath.Join(dir, "pastes", c.ID, "meta.json")
	raw, _ := os.ReadFile(meta)
	var m map[string]any
	json.Unmarshal(raw, &m)
	m["size"] = -5
	raw, _ = json.Marshal(m)
	if err := os.WriteFile(meta, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("one invalid paste stopped startup: %v", err)
	}
	s2.Close()
}
