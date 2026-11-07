package main

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/jacobzymet/nullbin-go/internal/storage"
)

func TestStatsCommandShowsNoIdentifiers(t *testing.T) {
	dir := t.TempDir()
	s, err := storage.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	content := bytes.Repeat([]byte("x"), 100)
	c, err := s.CreatePending(time.Hour, false, int64(len(content)), "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.AppendChunk(c.ID, 0, c.UploadToken, bytes.NewReader(content)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Finalize(c.ID, c.UploadToken); err != nil {
		t.Fatal(err)
	}
	pending, err := s.CreatePending(time.Hour, false, 100, "")
	if err != nil {
		t.Fatal(err)
	}
	s.Close()

	var out bytes.Buffer
	if code := showStats([]string{"NULLBIN_DATA_DIR=" + dir}, &out); code != 0 {
		t.Fatalf("exit %d: %s", code, out.String())
	}
	report := out.String()
	for _, want := range []string{"Pastes:              1 (0 burn after reading, 0 with a discussion)", "Unfinished uploads:  1", "Paste limit:         2 of 100000"} {
		if !strings.Contains(report, want) {
			t.Errorf("report lacks %q:\n%s", want, report)
		}
	}
	for _, secret := range []string{c.ID, c.UploadToken, c.DeleteToken, pending.ID, pending.UploadToken, dir} {
		if strings.Contains(report, secret) {
			t.Fatalf("report contains an identifier or path:\n%s", report)
		}
	}
}

func TestStatsCommandRejectsBadConfiguration(t *testing.T) {
	var out bytes.Buffer
	if code := showStats([]string{"NULLBIN_DATA_DIR=" + t.TempDir()}, &out); code == 0 {
		t.Fatal("an empty directory was reported on")
	}
	if code := showStats([]string{"NULLBIN_TYPO=1"}, &out); code != 2 {
		t.Fatalf("unknown setting: exit %d", code)
	}
}

func TestHumanBytes(t *testing.T) {
	for n, want := range map[int64]string{0: "0 B", 1023: "1023 B", 1024: "1.0 KiB", 10 << 30: "10.0 GiB", 3 << 40: "3.0 TiB"} {
		if got := humanBytes(n); got != want {
			t.Errorf("humanBytes(%d) = %q, want %q", n, got, want)
		}
	}
	if percent(1, 0) != "-" || percent(1, 4) != "25.0%" {
		t.Error("percent")
	}
}
