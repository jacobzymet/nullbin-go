package server

import (
	"errors"
	"io"
	"net/http"
	"net/netip"
	"sync"
	"time"
)

// slotPool bounds concurrent requests globally and per client network, so
// one client cannot hold every slot and lock everyone else out.
//
// A client network is an IPv4 address or an IPv6 /64. IPv6 networks are
// also capped per /48: one /48 holds 65,536 /64s and is easy to get (free
// tunnel brokers hand them out), so without it one attacker could still
// take every slot.
type slotPool struct {
	global    chan struct{}
	perClient int
	perSite   int      // per IPv6 /48
	keys      *limiter // only its keyed hashes are used

	mu     sync.Mutex
	active map[[16]byte]int // per client and per /48; at most 2*cap(global) entries
}

func newSlotPool(global, perClient, perSite int) *slotPool {
	return &slotPool{
		global:    make(chan struct{}, global),
		perClient: perClient,
		perSite:   perSite,
		keys:      newLimiter(0, 0, 0),
		active:    make(map[[16]byte]int),
	}
}

// acquire takes a slot for ip. It never blocks; ok is false when the
// client, its /48 or the server is at its limit. Call release exactly once.
func (p *slotPool) acquire(ip netip.Addr) (release func(), ok bool) {
	k := p.keys.hash(ip)
	site, isV6 := p.keys.hashSite(ip)
	p.mu.Lock()
	if p.active[k] >= p.perClient || (isV6 && p.active[site] >= p.perSite) {
		p.mu.Unlock()
		return nil, false
	}
	select {
	case p.global <- struct{}{}:
	default:
		p.mu.Unlock()
		return nil, false
	}
	p.active[k]++
	if isV6 {
		p.active[site]++
	}
	p.mu.Unlock()
	return func() {
		p.mu.Lock()
		p.drop(k)
		if isV6 {
			p.drop(site)
		}
		<-p.global
		p.mu.Unlock()
	}, true
}

// drop decrements a counter, forgetting it at zero. Requires mu.
func (p *slotPool) drop(k [16]byte) {
	if p.active[k]--; p.active[k] <= 0 {
		delete(p.active, k)
	}
}

// errTooSlow reports an upload body arriving below the minimum rate.
var errTooSlow = errors.New("upload too slow")

// minRateReader fails a request body that falls behind a minimum average
// rate after a grace period. A client trickling a few bytes cannot hold an
// upload slot for the whole chunk deadline. Read deadlines on the
// connection catch clients that stop sending altogether.
type minRateReader struct {
	r     io.Reader
	rc    *http.ResponseController
	start time.Time
	grace time.Duration
	rate  float64 // bytes per second
	hard  time.Time
	n     int64
	now   func() time.Time
}

// due is when the client falls behind with n bytes received.
func (m *minRateReader) due() time.Time {
	d := m.start.Add(m.grace + time.Duration(float64(m.n)/m.rate*float64(time.Second)))
	if d.After(m.hard) {
		return m.hard
	}
	return d
}

func (m *minRateReader) Read(p []byte) (int, error) {
	if m.rc != nil {
		m.rc.SetReadDeadline(m.due()) // unsupported writers fall back to the check below
	}
	n, err := m.r.Read(p)
	m.n += int64(n)
	if err == nil && m.now().After(m.due()) {
		err = errTooSlow
	}
	return n, err
}

// pendingTracker caps the unfinished uploads each client network may hold
// open, so one client cannot take every pending slot (and its storage
// reservation) for the whole pending lifetime.
//
// Each reservation belongs to one upload and ends when that upload is
// finalized, from any network, or would have expired. So the tracker never
// holds more entries than there are unfinished uploads. Only keyed hashes
// are kept, never addresses or upload IDs, and nothing links a client to a
// paste once it is published.
type pendingTracker struct {
	max  int
	ttl  time.Duration
	keys *limiter // only its keyed hashes are used

	mu      sync.Mutex
	clients map[[16]byte][]pendingUpload // oldest first, at most max per client
	owners  map[[16]byte][16]byte        // upload ID hash -> client hash
}

type pendingUpload struct {
	start time.Time
	id    [16]byte // keyed hash of the upload ID, once it was created
	named bool
}

func newPendingTracker(max int, ttl time.Duration) *pendingTracker {
	return &pendingTracker{
		max:     max,
		ttl:     ttl,
		keys:    newLimiter(0, 0, 0),
		clients: make(map[[16]byte][]pendingUpload),
		owners:  make(map[[16]byte][16]byte),
	}
}

// live drops entries that have expired. Requires mu.
func (p *pendingTracker) live(k [16]byte, now time.Time) []pendingUpload {
	s := p.clients[k]
	i := 0
	for i < len(s) && now.Sub(s[i].start) > p.ttl {
		if s[i].named {
			delete(p.owners, s[i].id)
		}
		i++
	}
	return p.set(k, s[i:])
}

// set stores a client's entries, forgetting the client when none are left.
// Requires mu.
func (p *pendingTracker) set(k [16]byte, s []pendingUpload) []pendingUpload {
	if len(s) == 0 {
		delete(p.clients, k)
		return nil
	}
	p.clients[k] = s
	return s
}

// reserve counts a new upload for ip, or reports false at the limit.
// Follow it with created once the upload exists, or cancel if it does not.
func (p *pendingTracker) reserve(ip netip.Addr, now time.Time) bool {
	k := p.keys.hash(ip)
	p.mu.Lock()
	defer p.mu.Unlock()
	s := p.live(k, now)
	if len(s) >= p.max {
		return false
	}
	if s == nil && len(p.clients) >= limiterMaxEntries {
		return false // bounded memory; fail closed like the rate limiters
	}
	p.clients[k] = append(s, pendingUpload{start: now})
	return true
}

// created ties ip's newest reservation to the upload it became.
func (p *pendingTracker) created(ip netip.Addr, id string) {
	k := p.keys.hash(ip)
	idh := p.keys.hashBytes(id)
	p.mu.Lock()
	defer p.mu.Unlock()
	s := p.clients[k]
	for i := len(s) - 1; i >= 0; i-- {
		if !s[i].named {
			s[i].id, s[i].named = idh, true
			p.owners[idh] = k
			return
		}
	}
}

// cancel undoes ip's newest reserve when no upload was created.
func (p *pendingTracker) cancel(ip netip.Addr) {
	k := p.keys.hash(ip)
	p.mu.Lock()
	defer p.mu.Unlock()
	s := p.clients[k]
	for i := len(s) - 1; i >= 0; i-- {
		if !s[i].named {
			p.set(k, append(s[:i:i], s[i+1:]...))
			return
		}
	}
}

// release ends the reservation of a finalized upload, whichever network
// created it.
func (p *pendingTracker) release(id string) {
	idh := p.keys.hashBytes(id)
	p.mu.Lock()
	defer p.mu.Unlock()
	k, ok := p.owners[idh]
	if !ok {
		return // created before a restart, or already expired
	}
	delete(p.owners, idh)
	s := p.clients[k]
	for i := range s {
		if s[i].named && s[i].id == idh {
			p.set(k, append(s[:i:i], s[i+1:]...))
			return
		}
	}
}

// reconcileMargin covers the moment between reserving a place and the
// upload existing in storage.
const reconcileMargin = 10 * time.Second

// reconcile drops reservations of uploads that storage no longer holds,
// such as idle uploads it expired, so they stop counting at once. ids must
// have been listed at or after listed. Newer reservations are kept: their
// upload may not have existed yet when the list was taken.
func (p *pendingTracker) reconcile(ids []string, listed time.Time) {
	held := make(map[[16]byte]bool, len(ids))
	for _, id := range ids {
		held[p.keys.hashBytes(id)] = true
	}
	cutoff := listed.Add(-reconcileMargin)
	p.mu.Lock()
	defer p.mu.Unlock()
	for k, s := range p.clients {
		var kept []pendingUpload
		for _, u := range s {
			if u.start.Before(cutoff) && !(u.named && held[u.id]) {
				if u.named {
					delete(p.owners, u.id)
				}
				continue
			}
			kept = append(kept, u)
		}
		p.set(k, kept)
	}
}

func (p *pendingTracker) prune(now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for k := range p.clients {
		p.live(k, now)
	}
}
