package storage

import (
	"bytes"
	"io"
	"math"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Stats run while the server is busy: creating, uploading, burning,
// commenting, deleting and sweeping all at once. Run with -race. Stats must
// never fail, panic, race or report impossible numbers.
func TestReadStatsDuringHeavyChurn(t *testing.T) {
	s, clk, dir := newTestStore(t)
	var stop atomic.Bool
	var wg sync.WaitGroup
	work := func(f func()) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for !stop.Load() {
				f()
			}
		}()
	}
	content := bytes.Repeat([]byte("z"), 300)
	work(func() { // publish and delete
		c, err := s.CreatePending(time.Hour, false, int64(len(content)), "")
		if err != nil {
			return
		}
		if s.AppendChunk(c.ID, 0, c.UploadToken, bytes.NewReader(content)) == nil {
			if _, err := s.Finalize(c.ID, c.UploadToken); err == nil {
				s.Delete(c.ID, c.DeleteToken)
			}
		}
	})
	work(func() { // publish and burn
		c, err := s.CreatePending(time.Hour, true, int64(len(content)), "", testBurnToken)
		if err != nil {
			return
		}
		if s.AppendChunk(c.ID, 0, c.UploadToken, bytes.NewReader(content)) == nil {
			if _, err := s.Finalize(c.ID, c.UploadToken); err == nil {
				if p, err := s.ReadBurn(c.ID, testBurnToken); err == nil {
					io.Copy(io.Discard, p)
					p.Close()
				}
			}
		}
	})
	work(func() { // discussions
		token := NewToken()
		c, err := s.CreatePending(time.Hour, false, int64(len(content)), token)
		if err != nil {
			return
		}
		if s.AppendChunk(c.ID, 0, c.UploadToken, bytes.NewReader(content)) == nil {
			if _, err := s.Finalize(c.ID, c.UploadToken); err == nil {
				for i := 0; i < 3; i++ {
					s.AddComment(c.ID, token, bytes.Repeat([]byte("c"), 64))
				}
				s.Delete(c.ID, c.DeleteToken)
			}
		}
	})
	work(func() { s.Sweep() })

	deadline := time.Now().Add(1500 * time.Millisecond)
	runs := 0
	for time.Now().Before(deadline) {
		st, err := ReadStats(dir, clk.now())
		if err != nil {
			t.Fatalf("stats failed during churn: %v", err)
		}
		for _, n := range []int64{int64(st.Pastes), int64(st.Burn), int64(st.Discussion), int64(st.Comments), st.PasteBytes, st.CommentBytes, int64(st.Pending), int64(st.Removable), int64(st.Entries), st.Charged} {
			if n < 0 {
				t.Fatalf("negative count: %+v", st)
			}
		}
		if st.Burn > st.Pastes || st.Discussion > st.Pastes || st.Pastes+st.Pending > st.Entries {
			t.Fatalf("inconsistent stats: %+v", st)
		}
		runs++
	}
	stop.Store(true)
	wg.Wait()
	if runs < 5 {
		t.Fatalf("only %d stats runs", runs)
	}
}

func TestAddCappedNeverWraps(t *testing.T) {
	if got := addCapped(math.MaxInt64-1, 5); got != math.MaxInt64 {
		t.Fatalf("got %d", got)
	}
	if got := addCapped(10, -5); got != 10 {
		t.Fatalf("negative sizes are ignored, got %d", got)
	}
	if got := addCapped(1, 2); got != 3 {
		t.Fatalf("got %d", got)
	}
}
