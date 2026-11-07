//go:build !linux

package storage

// DiskSpace is unknown off Linux, the supported production platform.
func DiskSpace(dir string) (free, total int64, ok bool) { return 0, 0, false }
