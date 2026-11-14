package storage

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"path"
	"testing"
	"time"
)

func publishRecipients(t *testing.T, s *Store, limits ...int) (Created, []string) {
	t.Helper()
	recipients := make([]NewRecipient, len(limits))
	tokens := make([]string, len(limits))
	for i, l := range limits {
		tokens[i] = NewToken()
		recipients[i] = NewRecipient{Token: tokens[i], ReadLimit: l}
	}
	c, err := s.CreatePendingWithRecipients(time.Hour, int64(len(testContent)), recipients)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.AppendChunk(c.ID, 0, c.UploadToken, bytes.NewReader(testContent)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Finalize(c.ID, c.UploadToken); err != nil {
		t.Fatal(err)
	}
	return c, tokens
}

func readRecipient(t *testing.T, s *Store, id, token string) *Paste {
	t.Helper()
	p, err := s.ReadBurn(id, token)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	got, err := io.ReadAll(p)
	p.Close()
	if err != nil || !bytes.Equal(got, testContent) {
		t.Fatalf("content: %v", err)
	}
	return p
}

func TestRecipientsHaveSeparateCountsAndOnlyTheirOwnTokenWorks(t *testing.T) {
	s, _, _ := newTestStore(t)
	c, tokens := publishRecipients(t, s, 2, 0, 1)

	// Nothing but a recipient token opens it: not an ID-only GET, not the
	// delete or upload token, not a random token.
	if _, err := s.Get(c.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GET: %v", err)
	}
	for _, wrong := range []string{"", NewToken(), c.DeleteToken, c.UploadToken, testBurnToken} {
		if _, err := s.ReadBurn(c.ID, wrong); !errors.Is(err, ErrNotFound) {
			t.Fatalf("token %q: %v", wrong, err)
		}
	}
	if _, err := s.BurnPrefix(c.ID); err != nil {
		t.Fatalf("prefix: %v", err)
	}

	// Link 0: two opens, then closed. Link 2: one open. Link 1: no limit.
	for want := 1; want <= 2; want++ {
		if p := readRecipient(t, s, c.ID, tokens[0]); p.Link != 0 || p.Meta.Recipients[0].ReadsUsed != want {
			t.Fatalf("link 0 open %d: link %d, %+v", want, p.Link, p.Meta.Recipients)
		}
	}
	if _, err := s.ReadBurn(c.ID, tokens[0]); !errors.Is(err, ErrLinkClosed) {
		t.Fatalf("link 0 after its limit: %v", err)
	}
	readRecipient(t, s, c.ID, tokens[2])
	if _, err := s.ReadBurn(c.ID, tokens[2]); !errors.Is(err, ErrLinkClosed) {
		t.Fatalf("link 2 after its limit: %v", err)
	}
	for range 5 {
		if p := readRecipient(t, s, c.ID, tokens[1]); p.Link != 1 {
			t.Fatalf("unlimited link: %d", p.Link)
		}
	}
	// An unlimited link's count stops at MaxBurnReads (no more disk
	// writes), and the link keeps opening.
	dir := path.Join(dirPastes, c.ID)
	m, err := s.readMeta(dir, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	m.Recipients[1].ReadsUsed = MaxBurnReads
	if err := s.writeJSON(dir, fileMeta, m); err != nil {
		t.Fatal(err)
	}
	if p := readRecipient(t, s, c.ID, tokens[1]); p.Meta.Recipients[1].ReadsUsed != MaxBurnReads {
		t.Fatalf("count past the cap: %d", p.Meta.Recipients[1].ReadsUsed)
	}
	m.Recipients[1].ReadsUsed = 5
	if err := s.writeJSON(dir, fileMeta, m); err != nil {
		t.Fatal(err)
	}
	// The unlimited link keeps the paste alive after the others closed.
	st, err := s.Recipients(c.ID, c.DeleteToken)
	if err != nil {
		t.Fatal(err)
	}
	want := []RecipientStatus{{ReadLimit: 2, ReadsUsed: 2}, {ReadsUsed: 5}, {ReadLimit: 1, ReadsUsed: 1}}
	for i := range want {
		if st[i] != want[i] {
			t.Fatalf("status %d: %+v, want %+v", i, st[i], want[i])
		}
	}
}

func TestRevokingALinkStopsOnlyThatLinkAndTheLastOneRemovesThePaste(t *testing.T) {
	s, clk, dir := newTestStore(t)
	c, tokens := publishRecipients(t, s, 0, 0, 3)

	// Only the delete token may see or revoke links.
	for _, wrong := range []string{"", NewToken(), tokens[0], c.UploadToken} {
		if _, err := s.Recipients(c.ID, wrong); !errors.Is(err, ErrNotFound) {
			t.Fatalf("status with %q: %v", wrong, err)
		}
		if err := s.Revoke(c.ID, wrong, 0); !errors.Is(err, ErrNotFound) {
			t.Fatalf("revoke with %q: %v", wrong, err)
		}
	}
	for _, n := range []int{-1, 3, MaxRecipients} {
		if err := s.Revoke(c.ID, c.DeleteToken, n); !errors.Is(err, ErrNotFound) {
			t.Fatalf("revoke link %d: %v", n, err)
		}
	}

	if err := s.Revoke(c.ID, c.DeleteToken, 0); err != nil {
		t.Fatal(err)
	}
	if err := s.Revoke(c.ID, c.DeleteToken, 0); err != nil {
		t.Fatalf("revoking twice: %v", err)
	}
	if _, err := s.ReadBurn(c.ID, tokens[0]); !errors.Is(err, ErrLinkClosed) {
		t.Fatalf("revoked link still opens: %v", err)
	}
	readRecipient(t, s, c.ID, tokens[1])
	readRecipient(t, s, c.ID, tokens[2])

	// Revocation is durable.
	s.Close()
	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	s2.SetClock(clk.now)
	if _, err := s2.ReadBurn(c.ID, tokens[0]); !errors.Is(err, ErrLinkClosed) {
		t.Fatalf("revoked link opens after a restart: %v", err)
	}
	if err := s2.Revoke(c.ID, c.DeleteToken, 1); err != nil {
		t.Fatal(err)
	}
	if err := s2.Revoke(c.ID, c.DeleteToken, 2); err != nil {
		t.Fatal(err)
	}
	// Every link closed: the paste is gone, for every token and route.
	if _, err := s2.ReadBurn(c.ID, tokens[2]); !errors.Is(err, ErrNotFound) {
		t.Fatalf("read after every link was revoked: %v", err)
	}
	if _, err := s2.BurnPrefix(c.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("prefix: %v", err)
	}
	if _, err := s2.Recipients(c.ID, c.DeleteToken); !errors.Is(err, ErrNotFound) {
		t.Fatalf("status: %v", err)
	}
	if _, err := s2.root.Lstat(path.Join(dirPastes, c.ID)); err == nil {
		t.Fatal("paste directory still there")
	}
	if s2.used != 0 {
		t.Fatal("removed paste still charged")
	}
}

func TestRecipientPastesRemovedWhenEveryLimitedLinkIsUsedUp(t *testing.T) {
	s, _, _ := newTestStore(t)
	c, tokens := publishRecipients(t, s, 1, 1)
	readRecipient(t, s, c.ID, tokens[0])
	readRecipient(t, s, c.ID, tokens[1])
	if _, err := s.root.Lstat(path.Join(dirPastes, c.ID)); err == nil {
		t.Fatal("paste kept after every link was used up")
	}
}

func TestRecipientCreationIsValidated(t *testing.T) {
	s, _, _ := newTestStore(t)
	tok := func() NewRecipient { return NewRecipient{Token: NewToken()} }
	dup := NewToken()
	many := make([]NewRecipient, MaxRecipients+1)
	for i := range many {
		many[i] = tok()
	}
	for name, rs := range map[string][]NewRecipient{
		"none":         nil,
		"one":          {tok()},
		"too many":     many,
		"empty token":  {tok(), {Token: ""}},
		"duplicate":    {{Token: dup}, {Token: dup}},
		"negative":     {tok(), {Token: NewToken(), ReadLimit: -1}},
		"over the max": {tok(), {Token: NewToken(), ReadLimit: MaxBurnReads + 1}},
	} {
		if _, err := s.CreatePendingWithRecipients(time.Hour, 100, rs); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := s.CreatePendingWithRecipients(time.Hour, 100, many[:MaxRecipients]); err != nil {
		t.Errorf("the maximum: %v", err)
	}
}

func TestInvalidRecipientMetadataIsRefused(t *testing.T) {
	s, _, _ := newTestStore(t)
	c, tokens := publishRecipients(t, s, 2, 0)
	dir := path.Join(dirPastes, c.ID)
	var good Meta
	if err := s.readJSON(path.Join(dir, fileMeta), &good); err != nil {
		t.Fatal(err)
	}
	h := good.Recipients[0].TokenHash
	for name, change := range map[string]func(m *Meta){
		"not burn":           func(m *Meta) { m.Burn = false },
		"also a burn token":  func(m *Meta) { m.BurnTokenHash = HashToken(testBurnToken) },
		"with a discussion":  func(m *Meta) { m.CommentTokenHash = HashToken(NewToken()) },
		"paste-wide limit":   func(m *Meta) { m.ReadLimit = 3 },
		"paste-wide count":   func(m *Meta) { m.ReadsUsed = 1 },
		"one link":           func(m *Meta) { m.Recipients = m.Recipients[:1] },
		"duplicate hash":     func(m *Meta) { m.Recipients[1].TokenHash = h },
		"uppercase hash":     func(m *Meta) { m.Recipients[0].TokenHash = "A" + h[1:] },
		"short hash":         func(m *Meta) { m.Recipients[0].TokenHash = h[:62] },
		"over its limit":     func(m *Meta) { m.Recipients[0].ReadsUsed = 3 },
		"negative count":     func(m *Meta) { m.Recipients[1].ReadsUsed = -1 },
		"limit over the max": func(m *Meta) { m.Recipients[0].ReadLimit = MaxBurnReads + 1 },
		"limit below zero":   func(m *Meta) { m.Recipients[0].ReadLimit = -1 },
	} {
		m := good
		m.Recipients = append([]Recipient(nil), good.Recipients...)
		change(&m)
		data, _ := json.Marshal(m)
		if err := s.writeJSON(dir, fileMeta, json.RawMessage(data)); err != nil {
			t.Fatal(err)
		}
		if _, err := s.ReadBurn(c.ID, tokens[1]); !errors.Is(err, ErrCorrupt) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// An explicitly empty list (the encoder above would omit it).
	var fields map[string]any
	data, _ := json.Marshal(good)
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	fields["recipients"] = []any{}
	if err := s.writeJSON(dir, fileMeta, fields); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReadBurn(c.ID, tokens[1]); !errors.Is(err, ErrCorrupt) {
		t.Errorf("empty list: %v", err)
	}
}

func TestReservationChecksTheRecipientTokenItself(t *testing.T) {
	// get() checks the token before taking the reservation lock; the
	// reservation must still check it on its own.
	s, _, _ := newTestStore(t)
	c, tokens := publishRecipients(t, s, 1, 0)
	for _, wrong := range []string{"", NewToken(), c.DeleteToken} {
		if _, err := s.readLimited(c.ID, wrong); !errors.Is(err, ErrNotFound) {
			t.Fatalf("token %q: %v", wrong, err)
		}
	}
	p, err := s.readLimited(c.ID, tokens[0])
	if err != nil {
		t.Fatal(err)
	}
	p.Close()
	if _, err := s.readLimited(c.ID, tokens[0]); !errors.Is(err, ErrLinkClosed) {
		t.Fatalf("used-up link: %v", err)
	}
}
