package storage

import (
	"bytes"
	"errors"
	"path"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// An upload that sends nothing must cost only its fixed overhead, so empty
// uploads cannot use up the budget; bytes are charged as they arrive.
func TestQuotaChargesUploadsOnlyForBytesReceived(t *testing.T) {
	const size = 1000
	s, err := OpenWithLimits(t.TempDir(), Limits{MaxBytes: 4*entryOverhead + size, MaxPending: 100})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.SetMinChunk(1)
	var ups []Created
	for range 4 {
		c, err := s.CreatePending(time.Hour, false, size, "")
		if err != nil {
			t.Fatal(err)
		}
		ups = append(ups, c)
	}
	if s.used != 4*entryOverhead {
		t.Fatalf("empty uploads charged %d, want %d", s.used, 4*entryOverhead)
	}
	// A fifth could not be stored in full right now, so it fails at once.
	if _, err := s.CreatePending(time.Hour, false, size, ""); !errors.Is(err, ErrQuota) {
		t.Fatalf("create beyond the budget: %v", err)
	}
	// Uploads that send data compete for what is left: only one fits.
	var winners atomic.Int32
	var wg sync.WaitGroup
	for _, c := range ups {
		wg.Go(func() {
			err := s.AppendChunk(c.ID, 0, c.UploadToken, bytes.NewReader(make([]byte, size)))
			if err == nil {
				winners.Add(1)
			} else if !errors.Is(err, ErrQuota) {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if winners.Load() != 1 || s.used != 4*entryOverhead+size {
		t.Fatalf("accepted %d chunks, charged %d", winners.Load(), s.used)
	}
}

// Anyone can create a paste with a discussion, so a discussion must cost
// nothing until comments arrive. Charging room for 200 comments up front let
// tiny pastes reserve 7 MiB each and fill the budget with a few kilobytes.
func TestQuotaDiscussionCostsNothingUntilCommentsArrive(t *testing.T) {
	const size = 67
	each, _ := allocationSize(size)
	s, err := OpenWithLimits(t.TempDir(), Limits{MaxBytes: 4 * each, MaxPending: 10})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	token := NewToken()
	var last Created
	for i := range 4 {
		c, err := s.CreatePending(30*24*time.Hour, false, size, token)
		if err != nil {
			t.Fatalf("paste %d: %v", i, err)
		}
		if err := s.AppendChunk(c.ID, 0, c.UploadToken, bytes.NewReader(make([]byte, size))); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Finalize(c.ID, c.UploadToken); err != nil {
			t.Fatalf("publish %d: %v", i, err)
		}
		last = c
	}
	if s.used != 4*each {
		t.Fatalf("charged %d, want %d", s.used, 4*each)
	}
	// With the budget full, a comment is refused and nothing is written.
	if _, err := s.AddComment(last.ID, token, make([]byte, 100)); !errors.Is(err, ErrQuota) {
		t.Fatalf("comment beyond the budget: %v", err)
	}
	if s.used != 4*each {
		t.Fatalf("a refused comment changed the charge to %d", s.used)
	}
}

func TestQuotaSurvivesRestartAndStaleUploadSweep(t *testing.T) {
	dir := t.TempDir()
	limits := Limits{MaxBytes: entryOverhead + 100_000, MaxPending: 1}
	s, err := OpenWithLimits(dir, limits)
	if err != nil {
		t.Fatal(err)
	}
	s.SetMinChunk(1)
	c, err := s.CreatePending(time.Hour, false, 100_000, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.AppendChunk(c.ID, 0, c.UploadToken, bytes.NewReader(make([]byte, 50_000))); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = OpenWithLimits(dir, limits)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.used != entryOverhead+50_000 || s.pending != 1 {
		t.Fatalf("lost reservations: %d, %d", s.used, s.pending)
	}
	if _, err := s.CreatePending(time.Hour, false, 1, ""); !errors.Is(err, ErrUploadLimit) {
		t.Fatal(err)
	}
	s.SetClock(func() time.Time { return time.Now().Add(2 * PendingTTL) })
	if st := s.Sweep(); st.StalePending != 1 {
		t.Fatalf("%+v", st)
	}
	if s.used != 0 || s.pending != 0 {
		t.Fatalf("leaked reservation: %d, %d", s.used, s.pending)
	}
	if _, err := s.CreatePending(time.Hour, false, 100_000, ""); err != nil {
		t.Fatal(err)
	}
}

func TestQuotaKeepsDeletedOpenFilesCharged(t *testing.T) {
	if runtime.GOOS == "windows" {
		// Windows refuses to delete a paste while it is being downloaded;
		// this tests the Unix behavior. Linux is the production platform.
		t.Skip("deleting files that are open is Unix behavior")
	}
	charge, _ := allocationSize(1000)
	s, err := OpenWithLimits(t.TempDir(), Limits{MaxBytes: charge, MaxPending: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c := publish(t, s, make([]byte, 1000), false, time.Hour, 1000)
	if s.pending != 0 {
		t.Fatal("finalize did not free pending slot")
	}
	p, err := s.Get(c.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if err := s.Delete(c.ID, c.DeleteToken); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreatePending(time.Hour, false, 1000, ""); !errors.Is(err, ErrQuota) {
		t.Fatal(err)
	}
	p.Close()
	if s.used != 0 {
		t.Fatal("reader close did not release space")
	}
	if _, err := s.CreatePending(time.Hour, false, 1000, ""); err != nil {
		t.Fatal(err)
	}
}

func TestQuotaChargesCommentsAndSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	paste, _ := allocationSize(1000)
	charge := paste + commentCharge(MaxCommentBytes)
	limits := Limits{MaxBytes: charge, MaxPending: 1}
	s, err := OpenWithLimits(dir, limits)
	if err != nil {
		t.Fatal(err)
	}
	token := NewToken()
	c, err := s.CreatePending(time.Hour, false, 1000, token)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.AppendChunk(c.ID, 0, c.UploadToken, bytes.NewReader(make([]byte, 1000))); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Finalize(c.ID, c.UploadToken); err != nil {
		t.Fatal(err)
	}
	if s.used != paste {
		t.Fatalf("published paste charged %d, want %d", s.used, paste)
	}
	if _, err := s.AddComment(c.ID, token, make([]byte, MaxCommentBytes)); err != nil {
		t.Fatal(err)
	}
	if s.used != charge {
		t.Fatalf("comment charged %d, want %d", s.used-paste, charge-paste)
	}
	if _, err := s.AddComment(c.ID, token, make([]byte, 1)); !errors.Is(err, ErrQuota) {
		t.Fatalf("comment beyond the budget: %v", err)
	}
	s.Close()
	s, err = OpenWithLimits(dir, limits)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.used != charge || s.pending != 0 {
		t.Fatalf("lost published allocation: %d, %d", s.used, s.pending)
	}
	if _, err := s.CreatePending(time.Hour, false, 1, ""); !errors.Is(err, ErrQuota) {
		t.Fatal(err)
	}
	if err := s.Delete(c.ID, c.DeleteToken); err != nil {
		t.Fatal(err)
	}
	if s.used != 0 {
		t.Fatal("discussion allocation leaked")
	}
}

func TestBurnCapabilityAndLegacyFailClosed(t *testing.T) {
	s, _, _ := newTestStore(t)
	c := publish(t, s, testContent, true, time.Hour, 1000)
	for _, token := range []string{"", c.UploadToken, c.DeleteToken, NewToken()} {
		if _, err := s.ReadBurn(c.ID, token); !errors.Is(err, ErrNotFound) {
			t.Fatal(err)
		}
	}
	if _, err := s.Get(c.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("GET exposed burn ciphertext")
	}
	prefix, err := s.BurnPrefix(c.ID)
	if err != nil || !bytes.Equal(prefix, testContent[:22]) {
		t.Fatalf("prefix: %v", err)
	}
	if p, err := s.ReadBurn(c.ID, testBurnToken); err != nil {
		t.Fatal(err)
	} else {
		p.Close()
	}
	if s.used != 0 {
		t.Fatal("burn allocation leaked")
	}
	legacy := publish(t, s, testContent, true, time.Hour, 1000)
	dir := path.Join(dirPastes, legacy.ID)
	m, _ := s.readMeta(dir, legacy.ID)
	m.BurnTokenHash = ""
	if err := s.writeJSON(dir, fileMeta, m); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(legacy.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	if _, err := s.ReadBurn(legacy.ID, testBurnToken); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	if err := s.Delete(legacy.ID, legacy.DeleteToken); err != nil {
		t.Fatal(err)
	}
}
