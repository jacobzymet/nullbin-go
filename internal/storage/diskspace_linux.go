package storage

import "syscall"

// DiskSpace reports the free and total bytes of the filesystem holding dir.
// Free counts only what an unprivileged process such as Nullbin can use.
func DiskSpace(dir string) (free, total int64, ok bool) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil || st.Bsize <= 0 {
		return 0, 0, false
	}
	return int64(st.Bavail) * int64(st.Bsize), int64(st.Blocks) * int64(st.Bsize), true
}
