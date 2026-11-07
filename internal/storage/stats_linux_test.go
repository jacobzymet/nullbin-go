//go:build linux

package storage

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// A data directory booby-trapped by someone who could write it (R21): links
// out of it, links between pastes, named pipes that would block a reader,
// and absurd sizes. Stats must finish quickly, read nothing outside the
// directory, and count none of the traps as pastes.
func TestReadStatsSurvivesATrappedDataDirectory(t *testing.T) {
	s, clk, dir := newTestStore(t)
	real := publish(t, s, []byte("genuine content"), false, time.Hour, 100)
	s.Close()
	pastes := filepath.Join(dir, dirPastes)
	meta := func(id string, size int64) []byte {
		b, _ := json.Marshal(Meta{ID: id, CreatedAt: clk.now(), ExpiresAt: clk.now().Add(time.Hour), Size: size, DeleteTokenHash: HashToken("x")})
		return b
	}
	mustDir := func(p string) {
		if err := os.MkdirAll(p, 0o700); err != nil {
			t.Fatal(err)
		}
	}

	// 1. A paste directory that is a link to a directory outside, holding a
	//    perfectly valid paste.
	outside := t.TempDir()
	linkID := "11111111111111111111111111111111"
	if err := os.WriteFile(filepath.Join(outside, fileMeta), meta(linkID, 5), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, fileBlob), []byte("12345"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(pastes, linkID)); err != nil {
		t.Fatal(err)
	}
	// 2. A paste whose metadata is a link to the genuine paste's.
	stealID := "22222222222222222222222222222222"
	mustDir(filepath.Join(pastes, stealID))
	if err := os.Symlink(filepath.Join(pastes, real.ID, fileMeta), filepath.Join(pastes, stealID, fileMeta)); err != nil {
		t.Fatal(err)
	}
	// 3. Metadata that is a named pipe: opening it would block forever.
	pipeID := "33333333333333333333333333333333"
	mustDir(filepath.Join(pastes, pipeID))
	if err := syscall.Mkfifo(filepath.Join(pastes, pipeID, fileMeta), 0o600); err != nil {
		t.Fatal(err)
	}
	// 4. A discussion paste claiming an absurd size, whose comments
	//    directory is a link and whose comment is a named pipe.
	hugeID := "44444444444444444444444444444444"
	mustDir(filepath.Join(pastes, hugeID))
	huge := Meta{ID: hugeID, CreatedAt: clk.now(), ExpiresAt: clk.now().Add(time.Hour), Size: math.MaxInt64 - 10, DeleteTokenHash: HashToken("x"), CommentTokenHash: HashToken("c")}
	b, _ := json.Marshal(huge)
	if err := os.WriteFile(filepath.Join(pastes, hugeID, fileMeta), b, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(pastes, hugeID, dirComments)); err != nil {
		t.Fatal(err)
	}
	pipeComments := "55555555555555555555555555555555"
	mustDir(filepath.Join(pastes, pipeComments, dirComments))
	cm := huge
	cm.ID, cm.Size = pipeComments, 10
	b, _ = json.Marshal(cm)
	if err := os.WriteFile(filepath.Join(pastes, pipeComments, fileMeta), b, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(pastes, pipeComments, dirComments, "000001"), 0o600); err != nil {
		t.Fatal(err)
	}
	// 5. A link standing in for the whole pending directory's entry.
	if err := os.Symlink("/", filepath.Join(dir, dirPending, "66666666666666666666666666666666")); err != nil {
		t.Fatal(err)
	}

	done := make(chan Stats, 1)
	go func() {
		st, err := ReadStats(dir, clk.now())
		if err != nil {
			t.Error(err)
		}
		done <- st
	}()
	var st Stats
	select {
	case st = <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("stats hung on a trapped data directory")
	}
	// Genuine, plus the huge and pipe-comment pastes, whose metadata is
	// valid; the links and pipes count as nothing.
	if st.Pastes != 3 || st.Pending != 0 || st.Comments != 0 {
		t.Fatalf("traps were counted: %+v", st)
	}
	if st.PasteBytes != math.MaxInt64 {
		t.Fatalf("absurd sizes must cap, not wrap: %d", st.PasteBytes)
	}
	if st.Charged < 0 {
		t.Fatalf("charged wrapped: %d", st.Charged)
	}
}
