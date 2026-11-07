package server

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"net/netip"
	"sync"
	"time"
)

// limiterMaxEntries bounds the memory a limiter can use. When the table is
// full of active clients, new clients are refused (fail closed).
const limiterMaxEntries = 100_000

// limiter is an in-memory token bucket per client network.
//
// Clients are keyed by a keyed hash (HMAC-SHA256 with a random per-process
// key) of their IPv4 address or IPv6 /64 prefix. Raw IPs are never stored,
// written to disk or logged. Note that the IPv4 space is small enough that
// anyone who can read process memory (including the key) can still recover
// addresses; the hashing keeps them out of casual dumps and debugging
// output.
type limiter struct {
	rate  float64 // tokens per second
	burst float64
	max   int
	key   [32]byte
	// site, if set, also limits each IPv6 /48 as a whole. One /48 holds
	// 65,536 /64s and is free from tunnel brokers, so per-/64 limits alone
	// would barely slow one person down.
	site *limiter

	mu       sync.Mutex
	buckets  map[[16]byte]*bucket
	lastFull time.Time // when a full table was last scanned for free entries
}

type bucket struct {
	tokens float64
	last   time.Time
}

func newLimiter(perSecond float64, burst, maxEntries int) *limiter {
	l := &limiter{
		rate:    perSecond,
		burst:   float64(burst),
		max:     maxEntries,
		buckets: make(map[[16]byte]*bucket),
	}
	rand.Read(l.key[:])
	return l
}

// siteShare is how many clients' worth of requests one IPv6 /48 may make.
const siteShare = 4

// newClientLimiter limits each client network, and each IPv6 /48 to
// siteShare times that.
func newClientLimiter(perSecond float64, burst int) *limiter {
	l := newLimiter(perSecond, burst, limiterMaxEntries)
	l.site = newLimiter(siteShare*perSecond, siteShare*burst, limiterMaxEntries)
	return l
}

// allow takes one token for ip. If none is available it returns false and
// how long until one will be.
func (l *limiter) allow(ip netip.Addr, now time.Time) (bool, time.Duration) {
	return l.allowN(ip, now, 1)
}

// allowN takes cost tokens for ip, and for its /48 when there is a site
// limit. The client is checked first, so requests it refuses never use up
// the /48's tokens: one busy network cannot drain its neighbours' share.
func (l *limiter) allowN(ip netip.Addr, now time.Time, cost float64) (bool, time.Duration) {
	k := l.hash(ip)
	if ok, wait := l.take(k, now, cost); !ok || l.site == nil {
		return ok, wait
	}
	if sk, isV6 := l.site.hashSite(ip); isV6 {
		if ok, wait := l.site.take(sk, now, cost); !ok {
			l.refund(k, cost)
			return false, wait
		}
	}
	return true, 0
}

// refund returns tokens taken for a request that was refused later.
func (l *limiter) refund(k [16]byte, cost float64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if b := l.buckets[k]; b != nil {
		b.tokens = min(l.burst, b.tokens+cost)
	}
}

func (l *limiter) take(k [16]byte, now time.Time, cost float64) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.buckets[k]
	if !ok {
		if len(l.buckets) >= l.max {
			// Scanning a full table is slow, so do it at most once a second
			// here; Server.Prune does it regularly anyway.
			if now.Sub(l.lastFull) >= time.Second {
				l.lastFull = now
				l.pruneLocked(now)
			}
			if len(l.buckets) >= l.max {
				return false, time.Minute
			}
		}
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[k] = b
	}
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens = min(l.burst, b.tokens+elapsed*l.rate)
		b.last = now
	}
	if b.tokens < cost {
		wait := time.Duration((cost - b.tokens) / l.rate * float64(time.Second))
		return false, wait
	}
	b.tokens -= cost
	return true, 0
}

// prune removes buckets that have refilled completely; they carry no
// state worth keeping.
func (l *limiter) prune(now time.Time) {
	l.mu.Lock()
	l.pruneLocked(now)
	l.mu.Unlock()
	if l.site != nil {
		l.site.prune(now)
	}
}

func (l *limiter) pruneLocked(now time.Time) {
	for k, b := range l.buckets {
		if b.tokens+now.Sub(b.last).Seconds()*l.rate >= l.burst {
			delete(l.buckets, k)
		}
	}
}

func (l *limiter) size() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

// hash maps an address to its bucket key. IPv6 addresses are grouped by
// /64, since one host usually controls a whole /64.
func (l *limiter) hash(ip netip.Addr) [16]byte {
	ip = ip.Unmap().WithZone("")
	var input []byte
	switch {
	case ip.Is4():
		a := ip.As4()
		input = append([]byte{4}, a[:]...)
	case ip.Is6():
		a := ip.As16()
		input = append([]byte{6}, a[:8]...)
	default:
		input = []byte{0} // unknown peer: one shared bucket
	}
	return l.mac(input)
}

// hashSite maps an IPv6 address to a key for its /48. It reports false for
// other addresses, which have no wider grouping.
func (l *limiter) hashSite(ip netip.Addr) ([16]byte, bool) {
	ip = ip.Unmap().WithZone("")
	if !ip.Is6() {
		return [16]byte{}, false
	}
	a := ip.As16()
	return l.mac(append([]byte{48}, a[:6]...)), true
}

// hashBytes maps any other identifier to a key that cannot collide with an
// address key.
func (l *limiter) hashBytes(s string) [16]byte {
	return l.mac(append([]byte{'s'}, s...))
}

func (l *limiter) mac(input []byte) [16]byte {
	m := hmac.New(sha256.New, l.key[:])
	m.Write(input)
	var out [16]byte
	copy(out[:], m.Sum(nil))
	return out
}
