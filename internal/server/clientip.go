package server

import (
	"net/http"
	"net/netip"
	"strings"
)

// maxForwardedHops bounds how many X-Forwarded-For entries are examined.
const maxForwardedHops = 32

// ipResolver finds the client address used for rate limiting.
type ipResolver struct {
	trusted []netip.Prefix
}

func (res ipResolver) isTrusted(ip netip.Addr) bool {
	for _, p := range res.trusted {
		if p.Contains(ip) {
			return true
		}
	}
	return false
}

// clientIP returns the connection's peer address, unless that peer is a
// trusted proxy. Then X-Forwarded-For is walked from right to left,
// skipping trusted hops, and the first untrusted address is the client.
// Entries to the left of it were written by the client and are ignored.
// If the header is missing or malformed, the nearest valid hop is used.
// An unparseable peer yields the zero Addr (one shared bucket).
func (res ipResolver) clientIP(r *http.Request) netip.Addr {
	peer, ok := parseHost(r.RemoteAddr)
	if !ok || !res.isTrusted(peer) {
		return peer
	}
	hops := forwardedHops(r.Header.Values("X-Forwarded-For"))
	client := peer
	for i := len(hops) - 1; i >= 0 && len(hops)-i <= maxForwardedHops; i-- {
		ip, ok := parseHost(hops[i])
		if !ok {
			break
		}
		client = ip
		if !res.isTrusted(ip) {
			break
		}
	}
	return client
}

func forwardedHops(values []string) []string {
	var hops []string
	for _, v := range values {
		for _, h := range strings.Split(v, ",") {
			hops = append(hops, strings.TrimSpace(h))
		}
	}
	return hops
}

// parseHost parses "ip", "ip:port", "[ipv6]" or "[ipv6]:port". IPv4-mapped
// IPv6 addresses are unmapped and zones are dropped.
func parseHost(s string) (netip.Addr, bool) {
	if ap, err := netip.ParseAddrPort(s); err == nil {
		return ap.Addr().Unmap().WithZone(""), true
	}
	s = strings.TrimSuffix(strings.TrimPrefix(s, "["), "]")
	ip, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Addr{}, false
	}
	return ip.Unmap().WithZone(""), true
}
