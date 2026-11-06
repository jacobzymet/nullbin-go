package server

import (
	"net/http"
	"net/netip"
	"testing"
	"time"
)

func TestClientIP(t *testing.T) {
	trusted := ipResolver{trusted: []netip.Prefix{
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("fd00::/8"),
	}}
	none := ipResolver{}
	cases := []struct {
		name   string
		res    ipResolver
		remote string
		xff    []string
		want   string
	}{
		{"no proxies, header ignored", none, "203.0.113.5:4000", []string{"198.51.100.1"}, "203.0.113.5"},
		{"untrusted peer, header ignored", trusted, "203.0.113.5:4000", []string{"198.51.100.1"}, "203.0.113.5"},
		{"trusted peer, no header", trusted, "10.1.1.1:4000", nil, "10.1.1.1"},
		{"trusted peer, single hop", trusted, "10.1.1.1:4000", []string{"198.51.100.1"}, "198.51.100.1"},
		{"spoofed hops on the left are ignored", trusted, "10.1.1.1:4000", []string{"1.1.1.1, 2.2.2.2, 198.51.100.1"}, "198.51.100.1"},
		{"chain of trusted proxies", trusted, "10.1.1.1:4000", []string{"198.51.100.1, 10.2.2.2, 10.3.3.3"}, "198.51.100.1"},
		{"multiple header lines", trusted, "10.1.1.1:4000", []string{"6.6.6.6", "198.51.100.1, 10.2.2.2"}, "198.51.100.1"},
		{"garbage stops the walk", trusted, "10.1.1.1:4000", []string{"198.51.100.1, garbage, 10.2.2.2"}, "10.2.2.2"},
		{"empty header value", trusted, "10.1.1.1:4000", []string{""}, "10.1.1.1"},
		{"all trusted", trusted, "10.1.1.1:4000", []string{"10.9.9.9, 10.2.2.2"}, "10.9.9.9"},
		{"hop with port", trusted, "10.1.1.1:4000", []string{"198.51.100.1:5555"}, "198.51.100.1"},
		{"bracketed IPv6 hop", trusted, "10.1.1.1:4000", []string{"[2001:db8::1]:443"}, "2001:db8::1"},
		{"IPv6 peer", trusted, "[fd00::1]:4000", []string{"2001:db8::7"}, "2001:db8::7"},
		{"IPv4-mapped peer", trusted, "[::ffff:10.1.1.1]:4000", []string{"198.51.100.1"}, "198.51.100.1"},
		{"IPv4-mapped hop", trusted, "10.1.1.1:4000", []string{"::ffff:198.51.100.1"}, "198.51.100.1"},
		{"zone dropped", none, "[fe80::1%eth0]:4000", nil, "fe80::1"},
		{"unparseable peer", trusted, "not-an-address", []string{"198.51.100.1"}, "invalid IP"},
	}
	for _, c := range cases {
		r := &http.Request{RemoteAddr: c.remote, Header: http.Header{}}
		for _, v := range c.xff {
			r.Header.Add("X-Forwarded-For", v)
		}
		if got := c.res.clientIP(r).String(); got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
}

func TestLimiterTokenBucket(t *testing.T) {
	l := newLimiter(1, 3, 100)
	ip := netip.MustParseAddr("192.0.2.1")
	now := time.Unix(1_000_000, 0)
	for i := range 3 {
		if ok, _ := l.allow(ip, now); !ok {
			t.Fatalf("request %d within burst denied", i)
		}
	}
	ok, wait := l.allow(ip, now)
	if ok || wait <= 0 || wait > time.Second {
		t.Fatalf("over burst: ok=%v wait=%v", ok, wait)
	}
	if ok, _ := l.allow(netip.MustParseAddr("192.0.2.2"), now); !ok {
		t.Fatal("another client was limited")
	}
	if ok, _ := l.allow(ip, now.Add(time.Second)); !ok {
		t.Fatal("token not refilled after 1s")
	}
	if ok, _ := l.allow(ip, now.Add(time.Second)); ok {
		t.Fatal("refilled more than one token")
	}
}

func TestLimiterGroupsIPv6By64(t *testing.T) {
	l := newLimiter(1, 1, 100)
	now := time.Unix(1_000_000, 0)
	if ok, _ := l.allow(netip.MustParseAddr("2001:db8:1:2::1"), now); !ok {
		t.Fatal("first request denied")
	}
	if ok, _ := l.allow(netip.MustParseAddr("2001:db8:1:2:ffff::9"), now); ok {
		t.Fatal("same /64 not limited together")
	}
	if ok, _ := l.allow(netip.MustParseAddr("2001:db8:1:3::1"), now); !ok {
		t.Fatal("different /64 limited")
	}
	if ok, _ := l.allow(netip.MustParseAddr("::ffff:192.0.2.1"), now); !ok {
		t.Fatal("mapped IPv4 denied")
	}
	if ok, _ := l.allow(netip.MustParseAddr("192.0.2.1"), now); ok {
		t.Fatal("mapped and plain IPv4 are different clients")
	}
}

func TestLimiterIsBoundedAndFailsClosed(t *testing.T) {
	l := newLimiter(1, 2, 10)
	now := time.Unix(1_000_000, 0)
	for i := range 10 {
		ip := netip.AddrFrom4([4]byte{198, 51, 100, byte(i)})
		l.allow(ip, now)
	}
	if l.size() != 10 {
		t.Fatalf("size %d", l.size())
	}
	// Table full of active clients: a new client is refused.
	if ok, _ := l.allow(netip.MustParseAddr("203.0.113.1"), now); ok {
		t.Fatal("new client admitted to a full table")
	}
	// Once the others have refilled, they are pruned and room is made.
	if ok, _ := l.allow(netip.MustParseAddr("203.0.113.1"), now.Add(time.Minute)); !ok {
		t.Fatal("new client refused after idle entries expired")
	}
	if l.size() != 1 {
		t.Fatalf("size after prune %d", l.size())
	}
	l.prune(now.Add(2 * time.Minute))
	if l.size() != 0 {
		t.Fatalf("size after prune %d", l.size())
	}
}

func TestLimiterNeverStoresRawIPs(t *testing.T) {
	l := newLimiter(1, 1, 10)
	ip := netip.MustParseAddr("192.0.2.77")
	l.allow(ip, time.Now())
	raw := ip.As4()
	for k := range l.buckets {
		if string(k[:4]) == string(raw[:]) {
			t.Fatal("bucket key starts with the raw address")
		}
	}
	other := newLimiter(1, 1, 10)
	if l.hash(ip) == other.hash(ip) {
		t.Fatal("hash key is not random per limiter")
	}
}
