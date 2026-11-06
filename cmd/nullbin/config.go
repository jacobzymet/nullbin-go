package main

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sort"
	"strconv"
	"strings"

	"github.com/jacobzymet/nullbin-go/internal/server"
	"github.com/jacobzymet/nullbin-go/internal/storage"
)

type config struct {
	ListenAddr     string
	DataDir        string
	MaxSize        int64
	MaxStorage     int64
	MaxPending     int
	BehindHTTPS    bool
	TrustedProxies []netip.Prefix
	APIOnly        bool
	FrontendOrigin string
}

const (
	defaultListenAddr = "127.0.0.1:8080"
	defaultDataDir    = "data"
	minMaxSize        = 64 << 10
)

var knownVars = map[string]bool{
	"NULLBIN_LISTEN_ADDR":     true,
	"NULLBIN_DATA_DIR":        true,
	"NULLBIN_MAX_SIZE":        true,
	"NULLBIN_MAX_STORAGE":     true,
	"NULLBIN_MAX_PENDING":     true,
	"NULLBIN_BEHIND_HTTPS":    true,
	"NULLBIN_TRUSTED_PROXIES": true,
	"NULLBIN_API_ONLY":        true,
	"NULLBIN_FRONTEND_ORIGIN": true,
}

// loadConfig reads and validates the environment. Any bad value, and any
// unknown NULLBIN_* variable (likely a typo), is an error.
func loadConfig(environ []string) (config, error) {
	env := map[string]string{}
	var unknown []string
	for _, kv := range environ {
		k, v, _ := strings.Cut(kv, "=")
		if !strings.HasPrefix(k, "NULLBIN_") {
			continue
		}
		if !knownVars[k] {
			unknown = append(unknown, k)
			continue
		}
		env[k] = v
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return config{}, fmt.Errorf("unknown variables: %s", strings.Join(unknown, ", "))
	}

	cfg := config{
		ListenAddr: defaultListenAddr,
		DataDir:    defaultDataDir,
		MaxSize:    server.DefaultMaxSize,
		MaxStorage: storage.DefaultMaxBytes,
		MaxPending: storage.DefaultMaxPending,
	}
	var errs []error
	if v := env["NULLBIN_API_ONLY"]; v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			errs = append(errs, errors.New("NULLBIN_API_ONLY: must be true or false"))
		}
		cfg.APIOnly = b
	}
	if v := env["NULLBIN_FRONTEND_ORIGIN"]; v != "" {
		if err := server.ValidateFrontendOrigin(v); err != nil {
			errs = append(errs, fmt.Errorf("NULLBIN_FRONTEND_ORIGIN: %w", err))
		}
		cfg.FrontendOrigin = v
	}
	if v, ok := env["NULLBIN_LISTEN_ADDR"]; ok {
		if err := validateListenAddr(v); err != nil {
			errs = append(errs, fmt.Errorf("NULLBIN_LISTEN_ADDR: %w", err))
		}
		cfg.ListenAddr = v
	}
	if v, ok := env["NULLBIN_DATA_DIR"]; ok {
		if strings.TrimSpace(v) == "" || strings.ContainsRune(v, 0) {
			errs = append(errs, errors.New("NULLBIN_DATA_DIR: must be a non-empty path"))
		}
		cfg.DataDir = v
	}
	if v, ok := env["NULLBIN_MAX_SIZE"]; ok {
		n, err := parseSize(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("NULLBIN_MAX_SIZE: %w", err))
		}
		cfg.MaxSize = n
	}
	if v, ok := env["NULLBIN_MAX_STORAGE"]; ok {
		n, err := parseSizeLimit(v, 1<<50)
		if err != nil {
			errs = append(errs, fmt.Errorf("NULLBIN_MAX_STORAGE: %w", err))
		}
		cfg.MaxStorage = n
	}
	if v, ok := env["NULLBIN_MAX_PENDING"]; ok {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 4096 || strconv.Itoa(n) != v {
			errs = append(errs, errors.New("NULLBIN_MAX_PENDING: must be an integer from 1 to 4096"))
		}
		cfg.MaxPending = n
	}
	if v, ok := env["NULLBIN_BEHIND_HTTPS"]; ok && v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("NULLBIN_BEHIND_HTTPS: %q is not true or false", v))
		}
		cfg.BehindHTTPS = b
	}
	if v, ok := env["NULLBIN_TRUSTED_PROXIES"]; ok && strings.TrimSpace(v) != "" {
		p, err := parseProxies(v)
		if err != nil {
			errs = append(errs, fmt.Errorf("NULLBIN_TRUSTED_PROXIES: %w", err))
		}
		cfg.TrustedProxies = p
	}
	if err := errors.Join(errs...); err != nil {
		return config{}, err
	}
	return cfg, nil
}

// validateListenAddr accepts "host:port" where host is empty, "localhost"
// or an IP literal, and port is 1-65535.
func validateListenAddr(v string) error {
	host, port, err := net.SplitHostPort(v)
	if err != nil {
		return fmt.Errorf("%q is not host:port", v)
	}
	if host != "" && host != "localhost" {
		if _, err := netip.ParseAddr(host); err != nil {
			return fmt.Errorf("host %q must be empty, localhost or an IP address", host)
		}
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 || strconv.Itoa(p) != port {
		return fmt.Errorf("port %q must be a number from 1 to 65535", port)
	}
	return nil
}

// parseSize parses a byte count with an optional binary unit:
// 104857600, 100MiB, 512KiB, 1GiB (also K, M, G).
func parseSize(v string) (int64, error) { return parseSizeLimit(v, server.HardMaxSize) }

func parseSizeLimit(v string, maximum int64) (int64, error) {
	s := strings.TrimSpace(v)
	units := []struct {
		suffix string
		mult   int64
	}{
		{"KiB", 1 << 10}, {"MiB", 1 << 20}, {"GiB", 1 << 30},
		{"K", 1 << 10}, {"M", 1 << 20}, {"G", 1 << 30}, {"B", 1},
	}
	mult := int64(1)
	for _, u := range units {
		if strings.HasSuffix(s, u.suffix) {
			s, mult = strings.TrimSuffix(s, u.suffix), u.mult
			break
		}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 || s[0] == '+' {
		return 0, fmt.Errorf("%q is not a positive size like 104857600 or 100MiB", v)
	}
	if n > maximum/mult {
		return 0, fmt.Errorf("%q exceeds the limit of %d bytes", v, maximum)
	}
	n *= mult
	if n < minMaxSize {
		return 0, fmt.Errorf("%q is below the minimum of 64KiB", v)
	}
	return n, nil
}

// parseProxies parses comma-separated IPs or CIDR prefixes.
func parseProxies(v string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, item := range strings.Split(v, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			return nil, errors.New("empty entry")
		}
		if strings.Contains(item, "/") {
			p, err := netip.ParsePrefix(item)
			if err != nil {
				return nil, fmt.Errorf("%q is not a valid CIDR prefix", item)
			}
			if p != p.Masked() {
				return nil, fmt.Errorf("%q has host bits set; did you mean %s?", item, p.Masked())
			}
			if p.Addr().Is4In6() || p.Addr().Zone() != "" {
				return nil, fmt.Errorf("%q: write IPv4 prefixes in IPv4 form, without zones", item)
			}
			out = append(out, p)
			continue
		}
		ip, err := netip.ParseAddr(item)
		if err != nil || ip.Zone() != "" {
			return nil, fmt.Errorf("%q is not a valid IP address", item)
		}
		ip = ip.Unmap()
		out = append(out, netip.PrefixFrom(ip, ip.BitLen()))
	}
	return out, nil
}
