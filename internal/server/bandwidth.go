package server

import (
	"context"
	"io"
	"net/http"
	"net/netip"
	"time"
)

const (
	clientBytesPerSecond = 4 << 20
	globalBytesPerSecond = 16 << 20
	bandwidthChunk       = 32 << 10
)

// Throttle while streaming rather than buffering a response or admitting
// a huge burst of whole-file downloads. Cancellation stops waiting at once.
type bandwidthWriter struct {
	ctx context.Context
	dst io.Writer
	s   *Server
	ip  netip.Addr
}

func (w bandwidthWriter) Write(p []byte) (int, error) {
	total := 0
	for len(p) > 0 {
		n := min(len(p), bandwidthChunk)
		for _, budget := range []struct {
			lim *limiter
			ip  netip.Addr
		}{
			{w.s.downloadBytes, w.ip}, {w.s.globalBytes, netip.Addr{}},
		} {
			for {
				if err := w.ctx.Err(); err != nil {
					return total, err
				}
				ok, delay := budget.lim.allowN(budget.ip, time.Now(), float64(n))
				if ok {
					break
				}
				timer := time.NewTimer(delay)
				select {
				case <-w.ctx.Done():
					timer.Stop()
					return total, w.ctx.Err()
				case <-timer.C:
				}
			}
		}
		written, err := w.dst.Write(p[:n])
		total += written
		if err != nil {
			return total, err
		}
		if written != n {
			return total, io.ErrShortWrite
		}
		p = p[n:]
	}
	return total, nil
}

// minRateWriter fails a response that the client reads more slowly than
// rate on average, after a grace period for password and save dialogs. Only
// time spent waiting for the client counts: bandwidthWriter wraps it, so
// time the server spends on its own bandwidth limits never does. A client
// that stops reading cannot hold a download slot for the whole deadline.
type minRateWriter struct {
	w     io.Writer
	rc    *http.ResponseController
	grace time.Duration
	rate  float64   // bytes per second
	hard  time.Time // the response's overall deadline
	n     int64
	spent time.Duration // time blocked writing to the client
	now   func() time.Time
}

func (m *minRateWriter) Write(p []byte) (int, error) {
	allowed := m.grace + time.Duration(float64(m.n+int64(len(p)))/m.rate*float64(time.Second)) - m.spent
	start := m.now()
	deadline := start.Add(allowed)
	if deadline.After(m.hard) {
		deadline = m.hard
	}
	m.rc.SetWriteDeadline(deadline)
	n, err := m.w.Write(p)
	m.spent += m.now().Sub(start)
	m.n += int64(n)
	return n, err
}
