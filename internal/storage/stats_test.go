package storage

import (
	"bytes"
	"fmt"
	"io/fs"
	"path/filepath"
	"testing"
	"time"
)

// snapshot records every path with its size, mode and modification time.
func snapshot(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		out[p] = fmt.Sprint(info.Mode(), info.ModTime(), info.Size())
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestReadStatsCountsWithoutChangingAnything(t *testing.T) {
	s, clk, dir := newTestStore(t)
	publish(t, s, bytes.Repeat([]byte("a"), 1000), false, time.Hour, 1000)
	publish(t, s, bytes.Repeat([]byte("b"), 2000), true, time.Hour, 2000)
	c, token := publishDiscussion(t, s)
	for _, body := range [][]byte{bytes.Repeat([]byte("c"), 50), bytes.Repeat([]byte("d"), 70)} {
		if _, err := s.AddComment(c.ID, token, body); err != nil {
			t.Fatal(err)
		}
	}
	publish(t, s, bytes.Repeat([]byte("e"), 300), false, time.Minute, 300) // expires first
	if _, err := s.CreatePending(time.Hour, false, 5000, ""); err != nil {
		t.Fatal(err)
	}

	before := snapshot(t, dir)
	st, err := ReadStats(dir, clk.now().Add(10*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if after := snapshot(t, dir); len(after) != len(before) {
		t.Fatalf("stats changed the data directory: %d entries before, %d after", len(before), len(after))
	} else {
		for p, v := range before {
			if after[p] != v {
				t.Fatalf("stats changed %s", p)
			}
		}
	}

	want := Stats{
		Pastes: 3, Burn: 1, Discussion: 1, Comments: 2,
		PasteBytes:   1000 + 2000 + int64(len(testContent)),
		CommentBytes: 120,
		Pending:      1, Removable: 1, Entries: 5,
	}
	got := st
	got.Charged = 0
	if got != want {
		t.Fatalf("stats = %+v, want %+v", got, want)
	}
	// While nothing changes, stats agree exactly with the server's own budget.
	s.quotaMu.Lock()
	used := s.used
	s.quotaMu.Unlock()
	if st.Charged != used {
		t.Fatalf("charged %d, server accounting %d", st.Charged, used)
	}
}

func TestReadStatsRefusesOtherDirectories(t *testing.T) {
	dir := t.TempDir()
	if _, err := ReadStats(dir, time.Now()); err == nil {
		t.Fatal("an empty directory was accepted as a data directory")
	}
	if names := entries(t, dir); len(names) != 0 {
		t.Fatalf("stats created %v", names)
	}
	if _, err := ReadStats(filepath.Join(dir, "missing"), time.Now()); err == nil {
		t.Fatal("a missing directory was accepted")
	}
}
