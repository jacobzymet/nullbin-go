//go:build api

package assets

import "errors"

// API builds need no Node.js build or frontend files.
func Load() (*Bundle, error) {
	return nil, errors.New("this binary contains only the API; set NULLBIN_API_ONLY=true")
}
