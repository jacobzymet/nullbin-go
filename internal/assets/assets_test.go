package assets

import (
	"testing"
	"testing/fstest"
)

func TestLoadFSRequiresAllFiles(t *testing.T) {
	full := fstest.MapFS{
		"index.html": {Data: []byte("<!doctype html>")},
		"app.js":     {Data: []byte("js")},
		"app.css":    {Data: []byte("css")},
	}
	b, err := LoadFS(full)
	if err != nil {
		t.Fatal(err)
	}
	if string(b.JS) != "js" || len(b.JSSHA256) != 64 {
		t.Fatalf("bundle %+v", b)
	}
	for _, missing := range []string{"index.html", "app.js", "app.css"} {
		partial := fstest.MapFS{}
		for k, v := range full {
			if k != missing {
				partial[k] = v
			}
		}
		if _, err := LoadFS(partial); err == nil {
			t.Errorf("LoadFS without %s succeeded", missing)
		}
		partial[missing] = &fstest.MapFile{Data: nil}
		if _, err := LoadFS(partial); err == nil {
			t.Errorf("LoadFS with empty %s succeeded", missing)
		}
	}
}

func TestNewHashes(t *testing.T) {
	b := New([]byte("a"), []byte("b"), []byte("c"))
	// Known SHA-256 values of "a", "b" and "c".
	if b.HTMLSHA256 != "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb" ||
		b.JSSHA256 != "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d" ||
		b.CSSSHA256 != "2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6" {
		t.Fatalf("hashes %+v", b)
	}
}
