// Package storage keeps pastes on the local filesystem under one data
// directory.
//
// Every file access goes through an os.Root opened on the data directory,
// and paths are built only from constant names and validated IDs, so no
// request can reach a file outside it.
//
// Layout:
//
//	pending/<id>/upload.json   upload state (holds the upload-token hash)
//	pending/<id>/blob          ciphertext received so far
//	pastes/<id>/meta.json      published metadata (see Meta)
//	pastes/<id>/blob           ciphertext
//	pastes/<id>/comments/NNNNNN encrypted comments, in arrival order
//	claimed/<id>-<random>/     a paste being burned or deleted
//
// The store assumes a single process on a local filesystem: rename
// atomicity, upload locks and active claims are relied on for correctness.
package storage

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"iter"
	"os"
	"path"
	"runtime"
	"sort"
	"sync"
	"time"
)

const (
	dirPending  = "pending"
	dirPastes   = "pastes"
	dirClaimed  = "claimed"
	dirComments = "comments"

	fileUpload = "upload.json"
	fileMeta   = "meta.json"
	fileBlob   = "blob"

	filePerm = 0o600
	dirPerm  = 0o700

	// maxMetaFile bounds how much of a metadata file is ever read.
	maxMetaFile = 4096
)

// PendingTTL is how long an unfinished upload may exist before it is
// rejected and swept.
const PendingTTL = time.Hour

// PendingIdle is how long an unfinished upload may go without completing a
// chunk. Browsers send chunks back to back, so an idle upload was
// abandoned. Expiring it quickly stops idle uploads from holding the
// limited pending slots and the storage they were charged. A chunk still
// arriving keeps its upload alive: the upload stays locked meanwhile.
const PendingIdle = 2 * time.Minute

// MinChunkBytes is the smallest chunk accepted, except the one that
// completes an upload. Browsers send 4 MiB chunks. Keeping an upload alive
// therefore costs real bandwidth, not one byte every couple of minutes.
const MinChunkBytes = 4 << 20

// MaxChunkBytes is the largest chunk accepted. Each chunk is charged to
// the storage budget before it is written.
const MaxChunkBytes = 8 << 20

// MaxBurnReads bounds the configurable number of authorized opens.
const MaxBurnReads = 1000

// Discussion limits.
const (
	// MaxComments is the most comments one paste can hold.
	MaxComments = 200
	// MaxCommentBytes is the largest encrypted comment.
	MaxCommentBytes = 32 << 10
)

// Errors returned by the store. Callers map them to HTTP status codes.
var (
	// ErrNotFound covers unknown IDs, expired or burned pastes, stale
	// uploads and wrong tokens, so callers cannot tell them apart.
	ErrNotFound = errors.New("not found")
	// ErrConflict means another request is working on this upload or
	// paste right now, or a chunk arrived out of order.
	ErrConflict = errors.New("conflict")
	// ErrDiscussionFull means a paste already holds MaxComments comments.
	ErrDiscussionFull = errors.New("discussion is full")
	// ErrTooLarge means a chunk would exceed the declared total size.
	ErrTooLarge = errors.New("too large")
	// ErrEmptyChunk means a chunk had no data.
	ErrEmptyChunk = errors.New("empty chunk")
	// ErrChunkTooSmall means a chunk other than the last was below
	// MinChunkBytes.
	ErrChunkTooSmall = errors.New("chunk too small")
	// ErrIncomplete means finalize was called before all bytes arrived.
	ErrIncomplete = errors.New("upload incomplete")
	// ErrCorrupt means stored data failed a consistency check.
	ErrCorrupt = errors.New("corrupt stored data")
)

// OutOfOrderError is returned when a chunk index is not the next one
// expected. It matches ErrConflict with errors.Is. Next lets a client that
// lost the response to a successful upload see that the chunk arrived.
type OutOfOrderError struct{ Next int }

func (e *OutOfOrderError) Error() string        { return "chunk out of order" }
func (e *OutOfOrderError) Is(target error) bool { return target == ErrConflict }

// Meta is the only metadata kept for a published paste.
// CommentTokenHash is set only for pastes with a discussion: the hash of a
// token the browser derives from the paste key and password, so only
// readers who know both can read or post comments.
type Meta struct {
	ID               string    `json:"id"`
	CreatedAt        time.Time `json:"created_at"`
	ExpiresAt        time.Time `json:"expires_at"`
	Burn             bool      `json:"burn_after_reading"`
	Size             int64     `json:"size"`
	DeleteTokenHash  string    `json:"delete_token_sha256"`
	CommentTokenHash string    `json:"comment_token_sha256,omitempty"`
	BurnTokenHash    string    `json:"burn_token_sha256,omitempty"`
	ReadLimit        int       `json:"read_limit,omitempty"`
	ReadsUsed        int       `json:"reads_used,omitempty"`
}

// upload is the state of a pending upload. It is deleted on finalize.
type upload struct {
	CreatedAt        time.Time     `json:"created_at"`
	UpdatedAt        time.Time     `json:"updated_at,omitzero"` // last completed chunk
	ExpiresIn        time.Duration `json:"expires_in"`
	Burn             bool          `json:"burn_after_reading"`
	TotalSize        int64         `json:"total_size"`
	Received         int64         `json:"received"`
	NextChunk        int           `json:"next_chunk"`
	UploadTokenHash  string        `json:"upload_token_sha256"`
	DeleteTokenHash  string        `json:"delete_token_sha256"`
	CommentTokenHash string        `json:"comment_token_sha256,omitempty"`
	BurnTokenHash    string        `json:"burn_token_sha256,omitempty"`
	ReadLimit        int           `json:"read_limit,omitempty"`
}

// Store is a filesystem-backed paste store. It is safe for concurrent use.
type Store struct {
	root        *os.Root
	quotaMu     sync.Mutex
	limits      Limits
	used        int64
	pending     int
	allocations map[string]*allocation

	mu     sync.Mutex
	busy   map[string]bool // pending uploads with an operation in progress
	claims map[string]bool // claimed/ entries that are still in use
	readMu sync.Mutex      // serializes durable limited-read reservations

	now      func() time.Time
	minChunk int64
}

// Open opens (and if needed creates) a store in dir.
func Open(dir string) (*Store, error) {
	return OpenWithLimits(dir, Limits{MaxBytes: DefaultMaxBytes, MaxPending: DefaultMaxPending})
}

// OpenWithLimits reconstructs reservations before accepting any requests.
func OpenWithLimits(dir string, limits Limits) (*Store, error) {
	if limits.MaxBytes <= 0 || limits.MaxPending <= 0 {
		return nil, errors.New("invalid storage limits")
	}
	if err := os.MkdirAll(dir, dirPerm); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	// Tighten an existing directory too (for example a fresh Docker volume,
	// which starts as 0755). Best effort: it fails harmlessly if we do not
	// own the directory, and the subdirectories are 0700 regardless.
	_ = os.Chmod(dir, dirPerm)
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, fmt.Errorf("open data directory: %w", err)
	}
	for _, d := range []string{dirPending, dirPastes, dirClaimed} {
		if err := root.Mkdir(d, dirPerm); err != nil && !errors.Is(err, fs.ErrExist) {
			root.Close()
			return nil, fmt.Errorf("create %s directory: %w", d, err)
		}
		fi, err := root.Lstat(d)
		if err != nil {
			root.Close()
			return nil, fmt.Errorf("check %s directory: %w", d, err)
		}
		if !fi.IsDir() {
			root.Close()
			return nil, fmt.Errorf("%s in data directory is not a directory", d)
		}
	}
	s := &Store{
		limits:      limits,
		allocations: make(map[string]*allocation),
		root:        root,
		busy:        make(map[string]bool),
		claims:      make(map[string]bool),
		now:         time.Now,
		minChunk:    MinChunkBytes,
	}
	if err := s.rebuildAllocations(); err != nil {
		root.Close()
		return nil, fmt.Errorf("read storage usage: %w", err)
	}
	return s, nil
}

// Close releases the data directory handle.
func (s *Store) Close() error { return s.root.Close() }

// SetClock replaces the store's time source. Tests use it to move time
// forward; it must be called before the store is shared.
func (s *Store) SetClock(now func() time.Time) { s.now = now }

// SetMinChunk replaces MinChunkBytes. Tests use it to upload in small
// chunks; it must be called before the store is shared.
func (s *Store) SetMinChunk(n int64) { s.minChunk = n }

// ValidID reports whether id matches ^[0-9a-f]{32}$. Every entry point
// checks it before touching the filesystem.
func ValidID(id string) bool {
	if len(id) != 32 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// NewID returns 128 random bits, hex-encoded.
func NewID() string { return randomHex(16) }

// NewToken returns a 256-bit random token, base64url-encoded.
func NewToken() string {
	b := make([]byte, 32)
	rand.Read(b) // never returns an error; crashes the program if the OS RNG fails
	return base64.RawURLEncoding.EncodeToString(b)
}

// HashToken returns the hex SHA-256 of a token. Only hashes are stored.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// TokenMatches compares a presented token against a stored hash in
// constant time.
func TokenMatches(storedHash, token string) bool {
	want, err := hex.DecodeString(storedHash)
	if err != nil || len(want) != sha256.Size {
		return false
	}
	got := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(want, got[:]) == 1
}

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// Created is returned by CreatePending.
type Created struct {
	ID          string
	UploadToken string
	DeleteToken string
}

// CreatePending starts a new upload of exactly totalSize bytes. A non-empty
// commentToken enables a discussion (not allowed with burn after reading).
// The caller validates expiresIn, totalSize and the token format.
func (s *Store) CreatePending(expiresIn time.Duration, burn bool, totalSize int64, commentToken string, burnTokens ...string) (Created, error) {
	burnToken := ""
	if len(burnTokens) == 1 {
		burnToken = burnTokens[0]
	}
	if len(burnTokens) > 1 || (burn && burnToken == "") || (!burn && burnToken != "") {
		return Created{}, errors.New("invalid burn capability")
	}
	reads := 0
	if burn {
		reads = 1
	}
	return s.CreatePendingWithReadLimit(expiresIn, burn, totalSize, commentToken, burnToken, reads)
}

// CreatePendingWithReadLimit supports 1..MaxBurnReads opens for burn pastes;
// reusable pastes must use zero. Old callers retain the one-open default.
func (s *Store) CreatePendingWithReadLimit(expiresIn time.Duration, burn bool, totalSize int64, commentToken, burnToken string, reads int) (Created, error) {
	if expiresIn <= 0 || totalSize <= 0 || (burn && commentToken != "") || !validReadLimit(burn, reads) {
		return Created{}, errors.New("invalid upload parameters")
	}
	if (burn && burnToken == "") || (!burn && burnToken != "") {
		return Created{}, errors.New("invalid burn capability")
	}
	c := Created{ID: NewID(), UploadToken: NewToken(), DeleteToken: NewToken()}
	dir := path.Join(dirPending, c.ID)
	if !s.lock(c.ID) {
		return Created{}, ErrConflict
	}
	defer s.unlock(c.ID)
	need, err := allocationSize(totalSize, commentToken != "")
	if err != nil {
		return Created{}, err
	}
	if err := s.reserve(dir, need); err != nil {
		return Created{}, err
	}
	if err := s.root.Mkdir(dir, dirPerm); err != nil {
		s.quotaMu.Lock()
		s.forgetLocked(dir)
		s.quotaMu.Unlock()
		return Created{}, err
	}
	u := upload{
		CreatedAt:       s.now().UTC(),
		ExpiresIn:       expiresIn,
		Burn:            burn,
		ReadLimit:       reads,
		TotalSize:       totalSize,
		UploadTokenHash: HashToken(c.UploadToken),
		DeleteTokenHash: HashToken(c.DeleteToken),
	}
	if burnToken != "" {
		u.BurnTokenHash = HashToken(burnToken)
	}
	if commentToken != "" {
		u.CommentTokenHash = HashToken(commentToken)
	}
	err = s.writeJSON(dir, fileUpload, u)
	if err == nil {
		var f *os.File
		f, err = s.root.OpenFile(path.Join(dir, fileBlob), os.O_WRONLY|os.O_CREATE|os.O_EXCL, filePerm)
		if err == nil {
			err = f.Close()
		}
	}
	if err == nil {
		err = s.syncDir(dirPending)
	}
	if err != nil {
		s.removeAllocated(dir)
		return Created{}, err
	}
	return c, nil
}

// AppendChunk appends chunk number n (starting at 0) to a pending upload.
// Chunks must arrive in order. A chunk that failed part-way may be sent
// again with the same n: bytes from the failed attempt are discarded.
// Read errors from body are returned unwrapped by io.Copy semantics.
func (s *Store) AppendChunk(id string, n int, uploadToken string, body io.Reader) error {
	if !ValidID(id) {
		return ErrNotFound
	}
	if !s.lock(id) {
		return ErrConflict
	}
	defer s.unlock(id)

	dir := path.Join(dirPending, id)
	u, err := s.readUpload(dir, uploadToken)
	if err != nil {
		return err
	}
	if n != u.NextChunk {
		return &OutOfOrderError{Next: u.NextChunk}
	}
	remaining := u.TotalSize - u.Received
	if remaining <= 0 {
		return ErrTooLarge
	}

	// Charge the most this chunk can add before writing any of it. The
	// allocation is set absolutely, so an earlier failure never leaves it off.
	charged := entryOverhead + u.Received
	limit := min(remaining, MaxChunkBytes)
	if err := s.resize(dir, charged+limit); err != nil {
		return err
	}
	keep := charged // what stays charged afterwards; shrinking never fails
	defer func() { s.resize(dir, keep) }()
	f, err := s.root.OpenFile(path.Join(dir, fileBlob), os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	// Drop any bytes left behind by an earlier failed attempt.
	if err := f.Truncate(u.Received); err != nil {
		return err
	}
	if _, err := f.Seek(u.Received, io.SeekStart); err != nil {
		return err
	}
	written, err := io.Copy(f, io.LimitReader(body, limit+1))
	if err == nil && written > limit {
		err = ErrTooLarge
	}
	if err == nil && written == 0 {
		err = ErrEmptyChunk
	}
	if err == nil && written < s.minChunk && written != remaining {
		err = ErrChunkTooSmall
	}
	if err == nil {
		err = f.Sync()
	}
	if err != nil {
		f.Truncate(u.Received)
		return err
	}
	keep = charged + written
	u.Received += written
	u.NextChunk++
	u.UpdatedAt = s.now().UTC()
	return s.writeJSON(dir, fileUpload, u)
}

// Finalize atomically publishes a complete upload. From this point the
// paste is readable and the upload token is forgotten.
func (s *Store) Finalize(id, uploadToken string) (Meta, error) {
	if !ValidID(id) {
		return Meta{}, ErrNotFound
	}
	if !s.lock(id) {
		return Meta{}, ErrConflict
	}
	defer s.unlock(id)

	dir := path.Join(dirPending, id)
	u, err := s.readUpload(dir, uploadToken)
	if err != nil {
		return Meta{}, err
	}
	if u.Received != u.TotalSize {
		return Meta{}, ErrIncomplete
	}
	// Publishing charges the paste's whole allocation, including space for
	// a discussion. If the budget is full the upload stays unfinished.
	full, err := allocationSize(u.Received, u.CommentTokenHash != "")
	if err != nil {
		return Meta{}, err
	}
	if err := s.resize(dir, full); err != nil {
		return Meta{}, err
	}

	// Make sure the blob is exactly the received bytes and on disk.
	f, err := s.root.OpenFile(path.Join(dir, fileBlob), os.O_WRONLY, 0)
	if err != nil {
		return Meta{}, err
	}
	err = f.Truncate(u.Received)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return Meta{}, err
	}

	now := s.now().UTC().Truncate(time.Second)
	m := Meta{
		ID:               id,
		CreatedAt:        now,
		ExpiresAt:        now.Add(u.ExpiresIn),
		Burn:             u.Burn,
		Size:             u.Received,
		DeleteTokenHash:  u.DeleteTokenHash,
		CommentTokenHash: u.CommentTokenHash,
		BurnTokenHash:    u.BurnTokenHash,
	}
	if u.ReadLimit > 1 {
		m.ReadLimit = u.ReadLimit // keep the one-open metadata format minimal
	}
	if err := s.writeJSON(dir, fileMeta, m); err != nil {
		return Meta{}, err
	}
	if err := s.root.Remove(path.Join(dir, fileUpload)); err != nil {
		return Meta{}, err
	}
	if err := s.syncDir(dir); err != nil {
		return Meta{}, err
	}
	// The publish step: one atomic directory rename.
	published := path.Join(dirPastes, id)
	s.quotaMu.Lock()
	err = s.root.Rename(dir, published)
	if err == nil {
		s.moveLocked(dir, published, true)
	}
	s.quotaMu.Unlock()
	if err != nil {
		return Meta{}, err
	}
	if err := s.syncDir(dirPending); err != nil {
		return Meta{}, err
	}
	if err := s.syncDir(dirPastes); err != nil {
		return Meta{}, err
	}
	return m, nil
}

// Paste is an open paste. Read streams the ciphertext. Close must always
// be called; it releases storage accounting and cleans up exhausted pastes.
type Paste struct {
	Meta Meta
	f    *os.File
	done func()
}

func (p *Paste) Read(b []byte) (int, error) { return p.f.Read(b) }

// Close closes the blob and runs its reader or deletion cleanup.
func (p *Paste) Close() error {
	err := p.f.Close()
	if p.done != nil {
		p.done()
		p.done = nil
	}
	return err
}

// Get opens a reusable paste. It never consumes a burn paste.
func (s *Store) Get(id string) (*Paste, error) { return s.get(id, "", false) }

// ReadBurn requires the independent capability before claiming one allowed
// open. Legacy burn pastes without a capability fail closed.
func (s *Store) ReadBurn(id, token string) (*Paste, error) { return s.get(id, token, true) }

// BurnPrefix exposes only the public format flags and password salt, so a
// reader can derive the burn capability without consuming ciphertext.
func (s *Store) BurnPrefix(id string) ([]byte, error) {
	if !ValidID(id) {
		return nil, ErrNotFound
	}
	dir := path.Join(dirPastes, id)
	m, err := s.readMeta(dir, id)
	if err != nil {
		return nil, err
	}
	if !m.Burn || m.BurnTokenHash == "" || s.expired(m) || exhausted(m) {
		return nil, ErrNotFound
	}
	p, err := s.openUnclaimed(dir, m)
	if err != nil {
		return nil, err
	}
	defer p.Close()
	prefix := make([]byte, 22)
	if _, err := io.ReadFull(p, prefix); err != nil {
		return nil, err
	}
	return prefix, nil
}

func (s *Store) openUnclaimed(dir string, m Meta) (*Paste, error) {
	s.quotaMu.Lock()
	defer s.quotaMu.Unlock()
	a := s.allocations[dir]
	if a == nil {
		return nil, ErrNotFound
	}
	f, err := s.root.Open(path.Join(dir, fileBlob))
	if err != nil {
		return nil, notFoundIfMissing(err)
	}
	if err := checkSize(f, m.Size); err != nil {
		f.Close()
		return nil, err
	}
	a.readers++
	return &Paste{Meta: m, f: f, done: func() {
		s.quotaMu.Lock()
		defer s.quotaMu.Unlock()
		a.readers--
		if a.removed && a.readers == 0 {
			s.used -= a.bytes
		}
	}}, nil
}

func (s *Store) get(id, token string, consume bool) (*Paste, error) {
	if !ValidID(id) {
		return nil, ErrNotFound
	}
	dir := path.Join(dirPastes, id)
	m, err := s.readMeta(dir, id)
	if err != nil {
		return nil, err
	}
	if s.expired(m) {
		s.discard(dir, id)
		return nil, ErrNotFound
	}

	if m.Burn {
		if !consume || !TokenMatches(m.BurnTokenHash, token) {
			return nil, ErrNotFound
		}
		if m.ReadLimit > 1 {
			return s.readLimited(id, token)
		}
	} else {
		if consume {
			return nil, ErrNotFound
		}
		return s.openUnclaimed(dir, m)
	}

	claim, err := s.claim(dir, id)
	if errors.Is(err, ErrConflict) {
		return nil, ErrNotFound // another reader is claiming it right now
	}
	if err != nil {
		return nil, err
	}
	done := func() { s.removeClaim(claim) }
	// Expiry may have passed between the check above and the claim.
	if s.expired(m) {
		done()
		return nil, ErrNotFound
	}
	f, err := s.root.Open(path.Join(dirClaimed, claim, fileBlob))
	if err != nil {
		done()
		return nil, notFoundIfMissing(err)
	}
	if err := checkSize(f, m.Size); err != nil {
		f.Close()
		done()
		return nil, err
	}
	return &Paste{Meta: m, f: f, done: done}, nil
}

// readLimited commits one open before returning any ciphertext. The counter
// remains on disk, including when a connection drops or the process restarts.
func (s *Store) readLimited(id, token string) (*Paste, error) {
	s.readMu.Lock()
	defer s.readMu.Unlock()
	if !s.lock(id) {
		return nil, ErrNotFound
	}
	defer s.unlock(id)
	dir := path.Join(dirPastes, id)
	// Reload under the reservation lock: callers may have read older metadata.
	m, err := s.readMeta(dir, id)
	if err != nil {
		return nil, err
	}
	if !m.Burn || s.expired(m) || exhausted(m) || !TokenMatches(m.BurnTokenHash, token) {
		return nil, ErrNotFound
	}
	p, err := s.openUnclaimed(dir, m)
	if err != nil {
		return nil, err
	}
	m.ReadsUsed++
	if err := s.writeJSON(dir, fileMeta, m); err != nil {
		p.Close()
		return nil, err // never deliver bytes without a durable reservation
	}
	p.Meta = m
	closed := p.done
	p.done = func() {
		closed()
		// Closing any reader retries cleanup. On Windows, earlier readers may
		// prevent the final reader from removing the directory immediately.
		current, err := s.readMeta(dir, id)
		if err == nil && exhausted(current) {
			s.discard(dir, id)
		}
	}
	return p, nil
}

func validReadLimit(burn bool, reads int) bool {
	return (burn && reads >= 1 && reads <= MaxBurnReads) || (!burn && reads == 0)
}

func exhausted(m Meta) bool { return m.Burn && m.ReadsUsed >= m.ReadLimit }

// Delete removes a published paste if deleteToken matches.
func (s *Store) Delete(id, deleteToken string) error {
	if !ValidID(id) {
		return ErrNotFound
	}
	dir := path.Join(dirPastes, id)
	m, err := s.readMeta(dir, id)
	if err != nil {
		return err
	}
	if !TokenMatches(m.DeleteTokenHash, deleteToken) {
		return ErrNotFound
	}
	if s.expired(m) {
		s.discard(dir, id)
		return ErrNotFound
	}
	claim, err := s.claim(dir, id)
	if err != nil {
		return err
	}
	s.removeClaim(claim)
	return nil
}

// Remove deletes a paste, with its comments, or an unfinished upload,
// without a delete token. It is for operators removing reported content
// while the server is stopped; requests never reach it.
func (s *Store) Remove(id string) error {
	if !ValidID(id) {
		return ErrNotFound
	}
	if s.discard(path.Join(dirPastes, id), id) {
		return nil
	}
	dir := path.Join(dirPending, id)
	if _, err := s.root.Lstat(dir); err != nil {
		return notFoundIfMissing(err)
	}
	if !s.lock(id) {
		return ErrConflict
	}
	defer s.unlock(id)
	return s.removeAllocated(dir)
}

// AddComment appends an encrypted comment to a paste's discussion and
// returns how many comments it now holds. The comment token must match the
// one given at creation; pastes without a discussion behave as not found.
// The server cannot read comments or check who wrote them.
func (s *Store) AddComment(id, commentToken string, ciphertext []byte) (int, error) {
	if !ValidID(id) {
		return 0, ErrNotFound
	}
	if len(ciphertext) == 0 || len(ciphertext) > MaxCommentBytes {
		return 0, ErrTooLarge
	}
	dir := path.Join(dirPastes, id)
	if _, err := s.discussion(dir, id, commentToken); err != nil {
		return 0, err
	}
	if !s.lock(id) {
		return 0, ErrConflict
	}
	defer s.unlock(id)
	// Re-check under the lock: the paste may have been deleted meanwhile.
	if _, err := s.discussion(dir, id, commentToken); err != nil {
		return 0, err
	}

	cdir := path.Join(dir, dirComments)
	if err := s.root.Mkdir(cdir, dirPerm); err != nil && !errors.Is(err, fs.ErrExist) {
		return 0, err
	}
	n := len(s.commentNames(cdir))
	if n >= MaxComments {
		return 0, ErrDiscussionFull
	}
	name := fmt.Sprintf("%06d", n+1)
	if err := s.writeFile(cdir, name, ciphertext); err != nil {
		return 0, err
	}
	return n + 1, nil
}

// Comments authenticates and snapshots the comment names, then reads one
// bounded comment at a time. Stop iterating when the client disconnects.
func (s *Store) Comments(id, commentToken string) (iter.Seq2[[]byte, error], error) {
	if !ValidID(id) {
		return nil, ErrNotFound
	}
	dir := path.Join(dirPastes, id)
	if _, err := s.discussion(dir, id, commentToken); err != nil {
		return nil, err
	}
	cdir := path.Join(dir, dirComments)
	names := s.commentNames(cdir)
	if len(names) > MaxComments {
		return nil, ErrCorrupt
	}
	return func(yield func([]byte, error) bool) {
		for _, name := range names {
			b, err := s.readComment(path.Join(cdir, name))
			if !yield(b, err) || err != nil {
				return
			}
		}
	}, nil
}

func (s *Store) readComment(name string) ([]byte, error) {
	f, err := s.root.Open(name)
	if err != nil {
		return nil, notFoundIfMissing(err)
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, MaxCommentBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) == 0 || len(b) > MaxCommentBytes {
		return nil, ErrCorrupt
	}
	return b, nil
}

// discussion loads a live paste and checks that it has a discussion and
// that the comment token matches.
func (s *Store) discussion(dir, id, commentToken string) (Meta, error) {
	m, err := s.readMeta(dir, id)
	if err != nil {
		return Meta{}, err
	}
	if s.expired(m) || m.CommentTokenHash == "" || !TokenMatches(m.CommentTokenHash, commentToken) {
		return Meta{}, ErrNotFound
	}
	return m, nil
}

// commentNames lists comment files ("000001", "000002", ...) in order.
// Anything else in the directory (such as a temp file) is skipped.
func (s *Store) commentNames(cdir string) []string {
	f, err := s.root.Open(cdir)
	if err != nil {
		return nil
	}
	defer f.Close()
	names, _ := f.Readdirnames(-1)
	var out []string
	for _, n := range names {
		if validCommentName(n) {
			out = append(out, n)
		}
	}
	sort.Strings(out)
	return out
}

func validCommentName(name string) bool {
	if len(name) != 6 {
		return false
	}
	for i := 0; i < len(name); i++ {
		if name[i] < '0' || name[i] > '9' {
			return false
		}
	}
	return true
}

// SweepStats counts what one sweep removed. It never contains identifiers.
type SweepStats struct {
	Expired      int // expired or unreadable published pastes
	StalePending int // uploads older than PendingTTL
	Claimed      int // leftover claimed/ directories
	Errors       int
}

// Sweep deletes expired pastes, stale pending uploads and leftover
// claimed directories. Entries whose names are not valid IDs are left
// alone.
func (s *Store) Sweep() SweepStats {
	var st SweepStats
	now := s.now()

	for _, name := range s.list(dirPastes, &st) {
		if !ValidID(name) {
			continue
		}
		dir := path.Join(dirPastes, name)
		m, err := s.readMeta(dir, name)
		if errors.Is(err, ErrNotFound) {
			if _, lerr := s.root.Lstat(dir); errors.Is(lerr, fs.ErrNotExist) {
				continue // removed concurrently
			}
		}
		if err == nil && now.Before(m.ExpiresAt) && !exhausted(m) {
			continue
		}
		// Expired, or metadata unreadable: remove rather than keep data
		// that can never be served.
		if s.discard(dir, name) {
			st.Expired++
		} else {
			st.Errors++
		}
	}

	for _, name := range s.list(dirPending, &st) {
		if !ValidID(name) || !s.lock(name) {
			continue
		}
		dir := path.Join(dirPending, name)
		created, active, ok := s.pendingTimes(dir)
		if !ok || now.Sub(created) > PendingTTL || now.Sub(active) > PendingIdle {
			if err := s.removeAllocated(dir); err != nil {
				st.Errors++
			} else {
				st.StalePending++
			}
		}
		s.unlock(name)
	}

	for _, name := range s.list(dirClaimed, &st) {
		if !validClaimName(name) {
			continue
		}
		s.mu.Lock()
		active := s.claims[name]
		s.mu.Unlock()
		if active {
			continue
		}
		if err := s.removeAllocated(path.Join(dirClaimed, name)); err != nil {
			st.Errors++
		} else {
			st.Claimed++
		}
	}
	return st
}

func (s *Store) expired(m Meta) bool { return !s.now().Before(m.ExpiresAt) }

// claim moves dir into claimed/ under a fresh name. Only one concurrent
// caller can succeed; the others get ErrNotFound.
//
// The rename is serialized per ID in memory as well. On Linux renameat(2)
// alone guarantees a single winner, but os.Root.Rename on Windows renames
// through an open handle and can move an already-claimed directory again.
func (s *Store) claim(dir, id string) (string, error) {
	if !s.lock(id) {
		return "", ErrConflict
	}
	defer s.unlock(id)
	name := id + "-" + randomHex(8)
	s.mu.Lock()
	s.claims[name] = true // registered first, so Sweep never races us
	s.mu.Unlock()
	s.quotaMu.Lock()
	err := s.root.Rename(dir, path.Join(dirClaimed, name))
	// Windows refuses to rename a directory while another request has a
	// file inside it open (for example reading meta.json). That is brief,
	// so retry for a moment. Linux renames regardless, so it never loops.
	for attempt := 0; err != nil && runtime.GOOS == "windows" && !errors.Is(err, fs.ErrNotExist) && attempt < 40; attempt++ {
		time.Sleep(5 * time.Millisecond)
		err = s.root.Rename(dir, path.Join(dirClaimed, name))
	}
	if err == nil {
		s.moveLocked(dir, path.Join(dirClaimed, name), false)
	}
	s.quotaMu.Unlock()
	if err != nil {
		s.mu.Lock()
		delete(s.claims, name)
		s.mu.Unlock()
		return "", notFoundIfMissing(err)
	}
	return name, nil
}

func (s *Store) removeClaim(name string) {
	s.removeAllocated(path.Join(dirClaimed, name)) // Sweep retries on failure
	s.mu.Lock()
	delete(s.claims, name)
	s.mu.Unlock()
}

// discard claims and removes a published paste. It reports success.
func (s *Store) discard(dir, id string) bool {
	claim, err := s.claim(dir, id)
	if err != nil {
		return false
	}
	s.removeClaim(claim)
	return true
}

func (s *Store) lock(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.busy[id] {
		return false
	}
	s.busy[id] = true
	return true
}

func (s *Store) unlock(id string) {
	s.mu.Lock()
	delete(s.busy, id)
	s.mu.Unlock()
}

// readUpload loads a pending upload and checks the token and age.
func (s *Store) readUpload(dir, uploadToken string) (upload, error) {
	var u upload
	if err := s.readJSON(path.Join(dir, fileUpload), &u); err != nil {
		return upload{}, err
	}
	if !TokenMatches(u.UploadTokenHash, uploadToken) {
		return upload{}, ErrNotFound
	}
	if now := s.now(); now.Sub(u.CreatedAt) > PendingTTL || now.Sub(u.lastActive()) > PendingIdle {
		return upload{}, ErrNotFound
	}
	if u.TotalSize <= 0 || u.Received < 0 || u.Received > u.TotalSize || u.NextChunk < 0 || u.ExpiresIn <= 0 {
		return upload{}, ErrCorrupt
	}
	if u.Burn && u.ReadLimit == 0 {
		u.ReadLimit = 1 // pending uploads created before configurable reads
	}
	if !validReadLimit(u.Burn, u.ReadLimit) {
		return upload{}, ErrCorrupt
	}
	return u, nil
}

func (s *Store) readMeta(dir, id string) (Meta, error) {
	var m Meta
	if err := s.readJSON(path.Join(dir, fileMeta), &m); err != nil {
		return Meta{}, err
	}
	if m.ID != id || m.Size <= 0 || m.ExpiresAt.IsZero() {
		return Meta{}, ErrCorrupt
	}
	if m.Burn && m.ReadLimit == 0 && m.ReadsUsed == 0 {
		m.ReadLimit = 1 // existing burn pastes still allow exactly one open
	}
	if !validReadLimit(m.Burn, m.ReadLimit) || m.ReadsUsed < 0 || m.ReadsUsed > m.ReadLimit {
		return Meta{}, ErrCorrupt
	}
	return m, nil
}

// lastActive is when the upload started or last completed a chunk.
func (u upload) lastActive() time.Time {
	if u.UpdatedAt.After(u.CreatedAt) {
		return u.UpdatedAt
	}
	return u.CreatedAt
}

// pendingTimes returns when an upload started and when it last completed a
// chunk, falling back to the directory's modification time if its state
// file is unreadable.
func (s *Store) pendingTimes(dir string) (created, active time.Time, ok bool) {
	var u upload
	if err := s.readJSON(path.Join(dir, fileUpload), &u); err == nil {
		return u.CreatedAt, u.lastActive(), true
	}
	fi, err := s.root.Lstat(dir)
	if err != nil {
		return time.Time{}, time.Time{}, false
	}
	return fi.ModTime(), fi.ModTime(), true
}

// PendingIDs lists the unfinished uploads. ok is false if the list could
// not be read completely.
func (s *Store) PendingIDs() (ids []string, ok bool) {
	var st SweepStats
	for _, name := range s.list(dirPending, &st) {
		if ValidID(name) {
			ids = append(ids, name)
		}
	}
	return ids, st.Errors == 0
}

func (s *Store) list(dir string, st *SweepStats) []string {
	f, err := s.root.Open(dir)
	if err != nil {
		st.Errors++
		return nil
	}
	defer f.Close()
	names, err := f.Readdirnames(-1)
	if err != nil {
		st.Errors++
	}
	return names
}

func (s *Store) readJSON(name string, v any) error {
	f, err := s.root.Open(name)
	if err != nil {
		return notFoundIfMissing(err)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxMetaFile+1))
	if err != nil {
		return err
	}
	if len(data) > maxMetaFile {
		return ErrCorrupt
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return ErrCorrupt
	}
	if dec.More() {
		return ErrCorrupt
	}
	return nil
}

// writeJSON writes v as JSON to dir/name atomically.
func (s *Store) writeJSON(dir, name string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return s.writeFile(dir, name, data)
}

// writeFile writes dir/name atomically: temp file, fsync, rename, fsync dir.
func (s *Store) writeFile(dir, name string, data []byte) error {
	tmp := path.Join(dir, name+".tmp-"+randomHex(8))
	f, err := s.root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, filePerm)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = s.root.Rename(tmp, path.Join(dir, name))
	}
	if err != nil {
		s.root.Remove(tmp)
		return err
	}
	return s.syncDir(dir)
}

// syncDir fsyncs a directory so renames inside it are durable. Windows
// cannot fsync directories; there it is a no-op.
func (s *Store) syncDir(dir string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	f, err := s.root.Open(dir)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}

func checkSize(f *os.File, want int64) error {
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	if !fi.Mode().IsRegular() || fi.Size() != want {
		return ErrCorrupt
	}
	return nil
}

func notFoundIfMissing(err error) error {
	if errors.Is(err, fs.ErrNotExist) {
		return ErrNotFound
	}
	return err
}

// validClaimName reports whether name looks like "<id>-<16 hex>".
func validClaimName(name string) bool {
	if len(name) != 32+1+16 || name[32] != '-' || !ValidID(name[:32]) {
		return false
	}
	for i := 33; i < len(name); i++ {
		c := name[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
