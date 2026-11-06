package storage

import (
	"bytes"
	"errors"
	"io"
	"path"
	"sync"
	"testing"
	"time"
)

func publishLimited(t *testing.T, s *Store, reads int) Created {
	t.Helper()
	c, err := s.CreatePendingWithReadLimit(time.Hour, true, int64(len(testContent)), "", testBurnToken, reads)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.AppendChunk(c.ID, 0, c.UploadToken, bytes.NewReader(testContent)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Finalize(c.ID, c.UploadToken); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestLimitedReadsPersistAndInterruptedTransfersCount(t *testing.T) {
	s, clk, dir := newTestStore(t)
	c := publishLimited(t, s, 3)
	for range 3 {
		if _, err := s.BurnPrefix(c.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := s.ReadBurn(c.ID, NewToken()); !errors.Is(err, ErrNotFound) {
			t.Fatalf("wrong token: %v", err)
		}
		if _, err := s.Get(c.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("ordinary GET: %v", err)
		}
	}
	p, err := s.ReadBurn(c.ID, testBurnToken)
	if err != nil {
		t.Fatal(err)
	}
	if p.Meta.ReadLimit != 3 || p.Meta.ReadsUsed != 1 {
		t.Fatalf("read count: %+v", p.Meta)
	}
	// Disconnect before reading any bytes: the reservation still counts.
	p.Close()
	s.Close()
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	reopened.SetClock(clk.now)
	for used := 2; used <= 3; used++ {
		p, err := reopened.ReadBurn(c.ID, testBurnToken)
		if err != nil {
			t.Fatal(err)
		}
		if p.Meta.ReadsUsed != used {
			t.Fatalf("used %d, want %d", p.Meta.ReadsUsed, used)
		}
		got, err := io.ReadAll(p)
		p.Close()
		if err != nil || !bytes.Equal(got, testContent) {
			t.Fatalf("read: %v", err)
		}
	}
	if _, err := reopened.ReadBurn(c.ID, testBurnToken); !errors.Is(err, ErrNotFound) {
		t.Fatalf("read after limit: %v", err)
	}
	if _, err := reopened.BurnPrefix(c.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("prefix after limit: %v", err)
	}
	if reopened.used != 0 {
		t.Fatal("exhausted paste still charged after all readers closed")
	}
}

func TestLimitedReadsConcurrentReservationsNeverExceedLimit(t *testing.T) {
	s, _, _ := newTestStore(t)
	const limit = 7
	c := publishLimited(t, s, limit)
	var mu sync.Mutex
	var readers []*Paste
	var unexpected []error
	var wg sync.WaitGroup
	start := make(chan struct{})
	for range 50 {
		wg.Go(func() {
			<-start
			p, err := s.ReadBurn(c.ID, testBurnToken)
			mu.Lock()
			defer mu.Unlock()
			if err == nil {
				readers = append(readers, p)
			} else if !errors.Is(err, ErrNotFound) {
				unexpected = append(unexpected, err)
			}
		})
	}
	close(start)
	wg.Wait()
	defer func() {
		for _, p := range readers {
			p.Close()
		}
	}()
	if len(readers) != limit || len(unexpected) != 0 {
		t.Fatalf("readers=%d, errors=%v", len(readers), unexpected)
	}
	seen := make(map[int]bool)
	for _, p := range readers {
		seen[p.Meta.ReadsUsed] = true
		got, err := io.ReadAll(p)
		if err != nil || !bytes.Equal(got, testContent) {
			t.Fatalf("concurrent read: %v", err)
		}
	}
	if len(seen) != limit {
		t.Fatal("two readers reserved the same open")
	}
	if _, err := s.BurnPrefix(c.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("exhausted prefix while transfers are open: %v", err)
	}
}

func TestExhaustedReadsStayUnavailableAfterRestartAndAreSwept(t *testing.T) {
	s, clk, dir := newTestStore(t)
	c := publishLimited(t, s, 2)
	first, _ := s.ReadBurn(c.ID, testBurnToken)
	first.Close()
	last, err := s.ReadBurn(c.ID, testBurnToken)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate restart after the final durable reservation, before cleanup.
	s.Close()
	last.Close()
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	reopened.SetClock(clk.now)
	if _, err := reopened.ReadBurn(c.ID, testBurnToken); !errors.Is(err, ErrNotFound) {
		t.Fatalf("exhausted read after restart: %v", err)
	}
	if _, err := reopened.BurnPrefix(c.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("exhausted prefix after restart: %v", err)
	}
	if st := reopened.Sweep(); st.Expired != 1 || st.Errors != 0 {
		t.Fatalf("exhausted sweep: %+v", st)
	}
	if reopened.used != 0 {
		t.Fatal("exhausted allocation not released")
	}
}

func TestLimitedReadValidationAndCorruptionFailClosed(t *testing.T) {
	s, _, _ := newTestStore(t)
	for _, limit := range []int{-1, 0, MaxBurnReads + 1} {
		if _, err := s.CreatePendingWithReadLimit(time.Hour, true, 100, "", testBurnToken, limit); err == nil {
			t.Fatalf("accepted limit %d", limit)
		}
	}
	if _, err := s.CreatePendingWithReadLimit(time.Hour, false, 100, "", "", 2); err == nil {
		t.Fatal("reusable paste accepted a read limit")
	}
	c := publishLimited(t, s, 3)
	dir := path.Join(dirPastes, c.ID)
	m, _ := s.readMeta(dir, c.ID)
	m.ReadsUsed = 4
	if err := s.writeJSON(dir, fileMeta, m); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadBurn(c.ID, testBurnToken); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("corrupt counter: %v", err)
	}
}
