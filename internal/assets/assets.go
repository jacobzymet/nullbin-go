// Package assets describes frontend bundles and their hashes.
//
// The optional combined binary embeds internal/assets/dist (built by npm).
// API-only builds use the api tag and contain no frontend files.
package assets

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
)

// Bundle holds the frontend files and their SHA-256 hashes (hex).
type Bundle struct {
	HTML, JS, CSS                   []byte
	HTMLSHA256, JSSHA256, CSSSHA256 string
}

// LoadFS reads index.html, app.js and app.css from fsys.
func LoadFS(fsys fs.FS) (*Bundle, error) {
	var files [3][]byte
	for i, name := range []string{"index.html", "app.js", "app.css"} {
		b, err := fs.ReadFile(fsys, name)
		if err != nil || len(b) == 0 {
			return nil, fmt.Errorf("frontend file %s missing from the binary (run `npm run build` before `go build`): %w", name, errors.Join(err, fs.ErrNotExist))
		}
		files[i] = b
	}
	return New(files[0], files[1], files[2]), nil
}

// New builds a Bundle from raw file contents.
func New(html, js, css []byte) *Bundle {
	return &Bundle{
		HTML: html, JS: js, CSS: css,
		HTMLSHA256: sum(html), JSSHA256: sum(js), CSSSHA256: sum(css),
	}
}

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
