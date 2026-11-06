package storage

import (
	"errors"
	"io/fs"
	"math"
	"path"
)

const (
	DefaultMaxBytes   = 10 << 30
	DefaultMaxPending = 64
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
}

type allocation struct {
	bytes   int64
	pending bool
	readers int
	removed bool
}

func allocationSize(size int64, discussion bool) (int64, error) {
	overhead := int64(entryOverhead)
	if discussion {
		overhead += MaxComments*(MaxCommentBytes+4096) + 4096
	}
	if size <= 0 || size > math.MaxInt64-overhead {
		return 0, ErrQuota
	}
	return size + overhead, nil
}

// reserve accounts for the entire upload before any disk write. Holding
// quotaMu makes simultaneous create requests compete for the same budget.
func (s *Store) reserve(dir string, size int64, discussion bool) error {
	n, err := allocationSize(size, discussion)
	if err != nil {
		return err
	}
	s.quotaMu.Lock()
	defer s.quotaMu.Unlock()
	if s.pending >= s.limits.MaxPending {
		return ErrUploadLimit
	}
	if s.used > s.limits.MaxBytes || n > s.limits.MaxBytes-s.used {
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
// charged for their declared size, including bytes not received yet.
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
			var physical int64
			err := fs.WalkDir(s.root.FS(), dir, func(_ string, d fs.DirEntry, err error) error {
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
			reserved := physical
			if parent == dirPending {
				var u upload
				if s.readJSON(path.Join(dir, fileUpload), &u) == nil {
					n, err := allocationSize(u.TotalSize, u.CommentTokenHash != "")
					if err != nil {
						return err
					}
					reserved = max(reserved, n)
				}
			} else {
				var m Meta
				if s.readJSON(path.Join(dir, fileMeta), &m) == nil {
					n, err := allocationSize(m.Size, m.CommentTokenHash != "")
					if err != nil {
						return err
					}
					reserved = max(reserved, n)
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
