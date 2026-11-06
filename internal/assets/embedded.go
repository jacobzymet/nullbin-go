//go:build !api

package assets

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// Load reads the frontend embedded in the optional combined binary.
func Load() (*Bundle, error) {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		return nil, err
	}
	return LoadFS(sub)
}
