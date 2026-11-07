package storage

import (
	"errors"
	"io/fs"
	"math"
	"path"
)

const (
	DefaultMaxBytes = 10 << 30
	// An unfinished upload costs a directory and its overhead until data
	// arrives, so many can be allowed; that makes holding them all take
	// many client networks (see the server's per-client limits).
	DefaultMaxPending = 1024
	// Each paste takes about four inodes. On a dedicated volume sized for
	// the budget, many tiny pastes would run out of inodes long before
	// bytes, and then every write fails; this cap makes that a clean "full".
	DefaultMaxPastes = 100_000
	// Charge for directory entries, metadata, block rounding and atomic
	// replacement files, including the transient finalize metadata.
	entryOverhead = 32 << 10
)

var (
	ErrQuota       = errors.New("storage quota reached")
	ErrUploadLimit = errors.New("too many unfinished uploads")
)

type Limits struct {
	MaxBytes   int64
	MaxPending int
	MaxPastes  int // published, unfinished and being-deleted pastes together; 0 means the default
}

type allocation struct {
	bytes   int64
	pending bool
	readers int
	removed bool
}

// allocationSize is what a paste of size bytes is charged once published.
// Its comments are charged separately, as they arrive (commentCharge).
func allocationSize(size int64) (int64, error) {
	if size <= 0 || size > math.MaxInt64-entryOverhead {
		return 0, ErrQuota
	}
	return size + entryOverhead, nil
}

// commentCharge is what one comment of n bytes is charged: its data
// rounded up to whole blocks, plus a directory entry and the temporary
// file it is written through.
func commentCharge(n int) int64 {
	return int64(n/4096+1)*4096 + 4096
}

// reserve starts a new upload's allocation with its fixed overhead only.
// Its bytes are charged as chunks arrive (resize), and comments as they
// are posted (grow). An upload that never sends data therefore costs almost
// nothing, so empty uploads cannot use up the budget, and charging is always
// for data someone actually sent.
// Holding quotaMu makes simultaneous requests compete for the same budget.
//
// need is the paste's full allocation. It must fit in the budget right now,
// so an upload that cannot fit fails at once rather than part-way, but it
// is not held.
func (s *Store) reserve(dir string, need int64) error {
	const n = entryOverhead
	s.quotaMu.Lock()
	defer s.quotaMu.Unlock()
	if s.pending >= s.limits.MaxPending {
		return ErrUploadLimit
	}
	if len(s.allocations) >= s.limits.MaxPastes {
		return ErrQuota
	}
	if s.used > s.limits.MaxBytes || max(need, n) > s.limits.MaxBytes-s.used {
		return ErrQuota
	}
	if s.allocations[dir] != nil {
		return ErrConflict
	}
	s.allocations[dir] = &allocation{bytes: n, pending: true}
	s.used += n
	s.pending++
	return nil
}

// resize sets a pending upload's allocation to n bytes. Growing fails with
// ErrQuota if the budget does not allow it; shrinking always succeeds.
func (s *Store) resize(dir string, n int64) error {
	s.quotaMu.Lock()
	defer s.quotaMu.Unlock()
	a := s.allocations[dir]
	if a == nil || !a.pending {
		return ErrNotFound
	}
	if delta := n - a.bytes; delta > 0 && (s.used > s.limits.MaxBytes || delta > s.limits.MaxBytes-s.used) {
		return ErrQuota
	}
	s.used += n - a.bytes
	a.bytes = n
	return nil
}

// grow adds delta bytes to a published paste's allocation. Growing fails
// with ErrQuota if the budget does not allow it; a negative delta undoes an
// earlier grow and always succeeds.
func (s *Store) grow(dir string, delta int64) error {
	s.quotaMu.Lock()
	defer s.quotaMu.Unlock()
	a := s.allocations[dir]
	if a == nil || a.pending {
		return ErrNotFound
	}
	if delta > 0 && (s.used > s.limits.MaxBytes || delta > s.limits.MaxBytes-s.used) {
		return ErrQuota
	}
	s.used += delta
	a.bytes += delta
	return nil
}

// All methods ending in Locked require quotaMu. An unlinked file keeps
// its allocation until the last open reader closes, because it still
// occupies disk space on Unix.
func (s *Store) forgetLocked(dir string) {
	a := s.allocations[dir]
	if a == nil {
		return
	}
	delete(s.allocations, dir)
	a.removed = true
	if a.pending {
		s.pending--
		a.pending = false
	}
	if a.readers == 0 {
		s.used -= a.bytes
	}
}

func (s *Store) moveLocked(from, to string, publish bool) {
	a := s.allocations[from]
	if a == nil {
		return
	}
	delete(s.allocations, from)
	s.allocations[to] = a
	if publish && a.pending {
		s.pending--
		a.pending = false
	}
}

func (s *Store) removeAllocated(dir string) error {
	s.quotaMu.Lock()
	defer s.quotaMu.Unlock()
	if err := s.root.RemoveAll(dir); err != nil {
		return err
	}
	s.forgetLocked(dir)
	return nil
}

// rebuildAllocations runs before requests can start. Pending uploads are
// charged for the bytes they have received, published pastes for their
// full allocation.
// Unknown/corrupt entries are still counted; only successful removal frees
// their capacity. Lowering the quota never deletes live pastes.
func (s *Store) rebuildAllocations() error {
	for _, parent := range []string{dirPending, dirPastes, dirClaimed} {
		entries, err := fs.ReadDir(s.root.FS(), parent)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			dir := path.Join(parent, entry.Name())
			var physical, comments int64
			err := fs.WalkDir(s.root.FS(), dir, func(name string, d fs.DirEntry, err error) error {
				if err != nil {
					return err
				}
				info, err := d.Info()
				if err != nil {
					return err
				}
				n := info.Size()
				if n < 0 || n > math.MaxInt64-4096 {
					return ErrQuota
				}
				if !d.IsDir() && path.Base(path.Dir(name)) == dirComments && validCommentName(d.Name()) {
					comments += commentCharge(int(min(n, MaxCommentBytes)))
				}
				n = (n/4096 + 1) * 4096
				if n > math.MaxInt64-physical {
					return ErrQuota
				}
				physical += n
				return nil
			})
			if err != nil {
				return err
			}
			// The bytes on disk are always charged. Valid metadata can only
			// raise that; invalid values are ignored rather than stopping the
			// server from starting (the sweeper deals with such entries).
			reserved := physical
			if parent == dirPending {
				var u upload
				if err := s.readJSON(path.Join(dir, fileUpload), &u); err == nil || errors.Is(err, ErrNewerFormat) {
					if u.Received >= 0 && u.Received <= math.MaxInt64-entryOverhead {
						reserved = max(reserved, entryOverhead+u.Received)
					}
				}
			} else {
				var m Meta
				if err := s.readJSON(path.Join(dir, fileMeta), &m); err == nil || errors.Is(err, ErrNewerFormat) {
					if n, err := allocationSize(m.Size); err == nil && n <= math.MaxInt64-comments {
						reserved = max(reserved, n+comments)
					}
				}
			}
			if reserved > math.MaxInt64-s.used {
				return ErrQuota
			}
			a := &allocation{bytes: reserved, pending: parent == dirPending}
			s.allocations[dir] = a
			s.used += reserved
			if a.pending {
				s.pending++
			}
		}
	}
	return nil
}
