package main

import (
	"bytes"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/jacobzymet/nullbin-go/internal/storage"
)

func TestConfigDefaults(t *testing.T) {
	cfg, err := loadConfig([]string{"PATH=/bin", "HOME=/root"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ListenAddr != "127.0.0.1:8080" || cfg.DataDir != "data" || cfg.MaxSize != 100<<20 || cfg.MaxStorage != 10<<30 || cfg.MaxPending != 64 || cfg.BehindHTTPS || len(cfg.TrustedProxies) != 0 {
		t.Fatalf("defaults %+v", cfg)
	}
}

func TestConfigValid(t *testing.T) {
	cfg, err := loadConfig([]string{
		"NULLBIN_LISTEN_ADDR=:8080",
		"NULLBIN_DATA_DIR=/data",
		"NULLBIN_MAX_SIZE=2GiB",
		"NULLBIN_MAX_STORAGE=20GiB",
		"NULLBIN_MAX_PENDING=12",
		"NULLBIN_BEHIND_HTTPS=true",
		"NULLBIN_TRUSTED_PROXIES=10.0.0.0/8, 192.0.2.1 ,fd00::/8,::1",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"10.0.0.0/8", "192.0.2.1/32", "fd00::/8", "::1/128"}
	if len(cfg.TrustedProxies) != len(want) {
		t.Fatalf("proxies %v", cfg.TrustedProxies)
	}
	for i, p := range cfg.TrustedProxies {
		if p.String() != want[i] {
			t.Errorf("proxy %d = %v, want %s", i, p, want[i])
		}
	}
	if cfg.ListenAddr != ":8080" || cfg.DataDir != "/data" || cfg.MaxSize != 2<<30 || cfg.MaxStorage != 20<<30 || cfg.MaxPending != 12 || !cfg.BehindHTTPS {
		t.Fatalf("config %+v", cfg)
	}
	// Empty values fall back to defaults for the optional switches.
	cfg, err = loadConfig([]string{"NULLBIN_BEHIND_HTTPS=", "NULLBIN_TRUSTED_PROXIES="})
	if err != nil || cfg.BehindHTTPS || cfg.TrustedProxies != nil {
		t.Fatalf("empty switches: %+v %v", cfg, err)
	}
}

func TestConfigRejectsBadValues(t *testing.T) {
	bad := []string{
		"NULLBIN_LISTEN_ADDR=8080",
		"NULLBIN_LISTEN_ADDR=:0",
		"NULLBIN_LISTEN_ADDR=:65536",
		"NULLBIN_LISTEN_ADDR=:http",
		"NULLBIN_LISTEN_ADDR=:080",
		"NULLBIN_LISTEN_ADDR=example.com:80",
		"NULLBIN_LISTEN_ADDR=",
		"NULLBIN_DATA_DIR=",
		"NULLBIN_DATA_DIR=   ",
		"NULLBIN_MAX_STORAGE=",
		"NULLBIN_MAX_STORAGE=9999999999999999999GiB",
		"NULLBIN_MAX_PENDING=0",
		"NULLBIN_MAX_PENDING=4097",
		"NULLBIN_MAX_PENDING=1.5",
		"NULLBIN_MAX_PENDING=+2",
		"NULLBIN_MAX_SIZE=",
		"NULLBIN_MAX_SIZE=0",
		"NULLBIN_MAX_SIZE=-1",
		"NULLBIN_MAX_SIZE=+100",
		"NULLBIN_MAX_SIZE=1.5GiB",
		"NULLBIN_MAX_SIZE=3GiB",
		"NULLBIN_MAX_SIZE=2147483649",
		"NULLBIN_MAX_SIZE=9999999999999999999",
		"NULLBIN_MAX_SIZE=100 MiB",
		"NULLBIN_MAX_SIZE=100MB",
		"NULLBIN_MAX_SIZE=1KiB",
		"NULLBIN_BEHIND_HTTPS=yes",
		"NULLBIN_BEHIND_HTTPS=on",
		"NULLBIN_TRUSTED_PROXIES=10.0.0.1/8",
		"NULLBIN_TRUSTED_PROXIES=10.0.0.0/33",
		"NULLBIN_TRUSTED_PROXIES=10.0.0.0/8,,192.0.2.1",
		"NULLBIN_TRUSTED_PROXIES=proxy.internal",
		"NULLBIN_TRUSTED_PROXIES=fe80::1%eth0",
		"NULLBIN_TRUSTED_PROXIES=::ffff:10.0.0.0/104",
		"NULLBIN_TRUSTED_PROXIES=*",
		"NULLBIN_MAXSIZE=100MiB", // typo: unknown variable
		"NULLBIN_DEBUG=1",
	}
	for _, kv := range bad {
		if _, err := loadConfig([]string{kv}); err == nil {
			t.Errorf("%s accepted", kv)
		}
	}
}

func TestConfigReportsAllErrors(t *testing.T) {
	_, err := loadConfig([]string{"NULLBIN_MAX_SIZE=x", "NULLBIN_BEHIND_HTTPS=maybe"})
	if err == nil || !strings.Contains(err.Error(), "NULLBIN_MAX_SIZE") || !strings.Contains(err.Error(), "NULLBIN_BEHIND_HTTPS") {
		t.Fatalf("error %v", err)
	}
}

func TestParseSize(t *testing.T) {
	cases := map[string]int64{
		"65536":      64 << 10,
		"64KiB":      64 << 10,
		"64K":        64 << 10,
		"100MiB":     100 << 20,
		"100M":       100 << 20,
		"1GiB":       1 << 30,
		"2G":         2 << 30,
		"2147483648": 2 << 30,
		"104857600B": 100 << 20,
	}
	for in, want := range cases {
		got, err := parseSize(in)
		if err != nil || got != want {
			t.Errorf("parseSize(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
}

func TestParseProxiesMapsIPv4(t *testing.T) {
	p, err := parseProxies("::ffff:192.0.2.1")
	if err != nil || len(p) != 1 || p[0] != netip.MustParsePrefix("192.0.2.1/32") {
		t.Fatalf("%v %v", p, err)
	}
}

func TestHealthURL(t *testing.T) {
	cases := map[string]string{
		":8080":          "http://127.0.0.1:8080/api/v1/version",
		"0.0.0.0:80":     "http://127.0.0.1:80/api/v1/version",
		"[::]:8080":      "http://127.0.0.1:8080/api/v1/version",
		"127.0.0.1:9000": "http://127.0.0.1:9000/api/v1/version",
		"[::1]:8080":     "http://[::1]:8080/api/v1/version",
		"localhost:8080": "http://localhost:8080/api/v1/version",
	}
	for in, want := range cases {
		if got, err := healthURL(in); err != nil || got != want {
			t.Errorf("healthURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
}

func TestConfigSplitDeployment(t *testing.T) {
	cfg, err := loadConfig([]string{"NULLBIN_API_ONLY=true", "NULLBIN_FRONTEND_ORIGIN=https://paste.example.com"})
	if err != nil || !cfg.APIOnly || cfg.FrontendOrigin != "https://paste.example.com" {
		t.Fatalf("split config: %+v %v", cfg, err)
	}
	for _, kv := range []string{"NULLBIN_API_ONLY=maybe", "NULLBIN_FRONTEND_ORIGIN=*", "NULLBIN_FRONTEND_ORIGIN=https://paste.example.com/", "NULLBIN_FRONTEND_ORIGIN=http://paste.example.com"} {
		if _, err := loadConfig([]string{kv}); err == nil {
			t.Errorf("accepted %s", kv)
		}
	}
}

func TestDeletePasteCommand(t *testing.T) {
	dir := t.TempDir()
	env := []string{"NULLBIN_DATA_DIR=" + dir}
	st, err := storage.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	c, err := st.CreatePending(time.Hour, false, 1, "")
	if err != nil {
		t.Fatal(err)
	}
	st.Close()
	var out bytes.Buffer
	if code := deletePaste(env, c.ID, &out); code != 0 || !strings.Contains(out.String(), "Deleted") {
		t.Fatalf("delete: %d %q", code, out.String())
	}
	out.Reset()
	if code := deletePaste(env, c.ID, &out); code != 1 || !strings.Contains(out.String(), "No paste") {
		t.Fatalf("delete again: %d %q", code, out.String())
	}
	out.Reset()
	link := "https://paste.example.com/p/" + c.ID + "#key"
	if code := deletePaste(env, link, &out); code != 2 || !strings.Contains(out.String(), "32 characters") {
		t.Fatalf("delete with a link: %d %q", code, out.String())
	}
}
