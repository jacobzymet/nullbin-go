// Package server implements Nullbin's HTTP interface: the static UI and
// the /api/v1 endpoints. The server only ever handles ciphertext.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"net/netip"
	"os"
	"strconv"
	"time"

	"github.com/jacobzymet/nullbin-go/internal/assets"
	"github.com/jacobzymet/nullbin-go/internal/storage"
)

// Size limits.
const (
	// HardMaxSize is the largest paste any configuration may allow.
	HardMaxSize = 2 << 30
	// DefaultMaxSize is the default paste size limit.
	DefaultMaxSize = 100 << 20
	// MinBlobSize is the smallest possible valid blob: 46-byte header plus
	// one frame (4-byte length and 17-byte authentication overhead).
	MinBlobSize = 46 + 4 + 17

	maxCreateBody = 1 << 10               // bounded create JSON, including tokens and max_reads
	maxChunkBody  = storage.MaxChunkBytes // one upload chunk (the browser sends 4 MiB)
	maxChunkIndex = 1<<31 - 1
)

// Timeouts.
const (
	readHeaderTimeout = 10 * time.Second
	readTimeout       = 30 * time.Second // default; chunk uploads extend it
	writeTimeout      = 30 * time.Second // default; downloads extend it
	idleTimeout       = 60 * time.Second
	maxHeaderBytes    = 16 << 10

	chunkDeadline = 5 * time.Minute
	chunkGrace    = 15 * time.Second
	chunkMinRate  = 16 << 10 // bytes per second, averaged after the grace period
	// Slots are cheap (a goroutine and a small buffer each); generous totals
	// mean holding them all takes many client networks.
	chunkSlotsTotal        = 128
	chunkSlotsPerClient    = 4  // the browser sends one chunk at a time
	chunkSlotsPerSite      = 16 // per IPv6 /48
	downloadBaseDeadline   = time.Minute
	downloadGrace          = 2 * time.Minute // password and save dialogs pause a download
	downloadSlotsTotal     = 512
	downloadSlotsPerClient = 16
	downloadSlotsPerSite   = 64       // per IPv6 /48
	pendingPerClient       = 8        // unfinished uploads per client network
	pendingPerSite         = 32       // unfinished uploads per IPv6 /48
	downloadMinRate        = 32 << 10 // bytes per second
)

// Header names for capability tokens.
const (
	UploadTokenHeader    = "Nullbin-Upload-Token"
	DeleteTokenHeader    = "Nullbin-Delete-Token"
	CommentTokenHeader   = "Nullbin-Comment-Token"
	BurnTokenHeader      = "Nullbin-Burn-Token"
	ReadsRemainingHeader = "Nullbin-Reads-Remaining"
)

// Expiries are fixed in code. "1m" is one month (30 days). There is no
// "never".
var allowedExpiry = map[int64]time.Duration{
	5 * 60:            5 * time.Minute,     // 5m
	60 * 60:           time.Hour,           // 1h
	24 * 60 * 60:      24 * time.Hour,      // 1d
	7 * 24 * 60 * 60:  7 * 24 * time.Hour,  // 1w
	30 * 24 * 60 * 60: 30 * 24 * time.Hour, // 1m (30 days)
}

// Config configures a Server.
type Config struct {
	Store          *storage.Store
	Assets         *assets.Bundle
	Version        string
	MaxSize        int64
	BehindHTTPS    bool
	TrustedProxies []netip.Prefix
	Logger         *log.Logger
	APIOnly        bool
	FrontendOrigin string
}

// Server serves the UI and the API.
type Server struct {
	cfg           Config
	ips           ipResolver
	creates       *limiter
	uploads       *limiter
	comments      *limiter
	pages         *limiter
	downloads     *limiter
	downloadBytes *limiter
	globalBytes   *limiter
	chunkSlots    *slotPool
	downloadSlots *slotPool
	pending       *pendingTracker
	handler       http.Handler
	logger        *log.Logger
	nowFunc       func() time.Time // clock for rate limiting

	chunkTimeout  time.Duration // per chunk upload; fields so tests can shorten them
	chunkGrace    time.Duration
	downloadGrace time.Duration
	downloadRate  float64 // minimum bytes per second a client must read
}

// New returns a Server. Store and Logger are required; Assets is required
// only when serving the optional combined UI/API mode.
func New(cfg Config) *Server {
	s := &Server{
		cfg:           cfg,
		ips:           ipResolver{trusted: cfg.TrustedProxies},
		creates:       newLimiter(1.0/3, 20, limiterMaxEntries), // 20 per minute, burst 20
		uploads:       newLimiter(10, 50, limiterMaxEntries),    // 10 requests/s, burst 50
		comments:      newLimiter(1.0/3, 10, limiterMaxEntries), // 20 per minute, burst 10
		pages:         newLimiter(5, 100, limiterMaxEntries),    // pages and static assets
		downloads:     newLimiter(1.0/3, 20, limiterMaxEntries),
		downloadBytes: newLimiter(clientBytesPerSecond, clientBytesPerSecond, limiterMaxEntries),
		globalBytes:   newLimiter(globalBytesPerSecond, globalBytesPerSecond, 1),
		chunkSlots:    newSlotPool(chunkSlotsTotal, chunkSlotsPerClient, chunkSlotsPerSite),
		downloadSlots: newSlotPool(downloadSlotsTotal, downloadSlotsPerClient, downloadSlotsPerSite),
		pending:       newPendingTracker(pendingPerClient, pendingPerSite, storage.PendingTTL),
		logger:        cfg.Logger,
		nowFunc:       time.Now,

		chunkTimeout:  chunkDeadline,
		chunkGrace:    chunkGrace,
		downloadGrace: downloadGrace,
		downloadRate:  downloadMinRate,
	}
	mux := http.NewServeMux()

	// Static UI. All pages are the same document; the script decides what
	// to show from the path.
	if !cfg.APIOnly {
		mux.Handle("GET /{$}", s.route(0, s.pages, s.page))
		mux.Handle("GET /p/{id}", s.route(0, s.pages, s.pageWithID))
		mux.Handle("GET /d/{id}", s.route(0, s.pages, s.pageWithID))
		mux.Handle("GET /assets/app.js", s.route(0, s.pages, s.static(cfg.Assets.JS, "text/javascript; charset=utf-8")))
		mux.Handle("GET /assets/app.css", s.route(0, s.pages, s.static(cfg.Assets.CSS, "text/css; charset=utf-8")))
	}

	// API. Every route declares its maximum body size; most take none.
	mux.Handle("POST /api/v1/pastes", s.route(maxCreateBody, s.creates, s.handleCreate))
	mux.Handle("PUT /api/v1/pastes/{id}/chunks/{n}", s.route(maxChunkBody, s.uploads, s.handleChunk))
	mux.Handle("POST /api/v1/pastes/{id}/finalize", s.route(0, s.uploads, s.handleFinalize))
	mux.Handle("GET /api/v1/pastes/{id}", s.route(0, s.downloads, s.handleGet))
	mux.Handle("GET /api/v1/pastes/{id}/prefix", s.route(0, s.downloads, s.handleBurnPrefix))
	mux.Handle("POST /api/v1/pastes/{id}/read", s.route(0, s.downloads, s.handleReadBurn))
	mux.Handle("DELETE /api/v1/pastes/{id}", s.route(0, nil, s.handleDelete))
	mux.Handle("POST /api/v1/pastes/{id}/comments", s.route(storage.MaxCommentBytes, s.comments, s.handleAddComment))
	mux.Handle("GET /api/v1/pastes/{id}/comments", s.route(0, s.downloads, s.handleComments))
	mux.Handle("GET /api/v1/version", s.route(0, nil, s.handleVersion))

	var h http.Handler = mux
	crossOrigin := http.NewCrossOriginProtection()
	if cfg.FrontendOrigin != "" {
		if err := ValidateFrontendOrigin(cfg.FrontendOrigin); err != nil {
			panic("invalid frontend origin")
		}
		if err := crossOrigin.AddTrustedOrigin(cfg.FrontendOrigin); err != nil {
			panic("invalid trusted frontend origin")
		}
	}
	h = cors(cfg.FrontendOrigin, crossOrigin.Handler(h))
	h = limitBody(maxChunkBody, h) // outer bound for every body; routes narrow it
	h = securityHeaders(cfg.BehindHTTPS, h)
	h = recoverPanics(s.logger, h)
	s.handler = h
	return s
}

// Handler returns the root HTTP handler.
func (s *Server) Handler() http.Handler { return s.handler }

// HTTPServer returns an http.Server with Nullbin's timeouts and limits.
func (s *Server) HTTPServer(addr string) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           s.handler,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
		ErrorLog:          NewErrorLog(s.logger),
	}
}

// Prune drops idle rate-limiter entries and reservations of uploads that
// storage no longer holds. Call it periodically, after the store's sweep.
func (s *Server) Prune() {
	now := s.nowFunc()
	if ids, ok := s.cfg.Store.PendingIDs(); ok {
		s.pending.reconcile(ids, now)
	}
	s.creates.prune(now)
	s.uploads.prune(now)
	s.comments.prune(now)
	s.pages.prune(now)
	s.downloads.prune(now)
	s.downloadBytes.prune(time.Now())
	s.globalBytes.prune(time.Now())
	s.pending.prune(now)
}

// route wraps an API handler with a body limit and optional rate limit.
func (s *Server) route(maxBody int64, lim *limiter, h http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if lim != nil {
			ip := s.ips.clientIP(r)
			if ok, wait := lim.allow(ip, s.nowFunc()); !ok {
				w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds()+0.999)))
				writeError(w, http.StatusTooManyRequests, "rate limited")
				return
			}
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBody)
		h(w, r)
	})
}

func (s *Server) page(w http.ResponseWriter, r *http.Request) {
	s.serveStatic(w, r, s.cfg.Assets.HTML, "text/html; charset=utf-8")
}

func (s *Server) pageWithID(w http.ResponseWriter, r *http.Request) {
	// The page does not reveal whether the paste exists; only the ID
	// format is checked.
	if !storage.ValidID(r.PathValue("id")) {
		http.NotFound(w, r)
		return
	}
	s.page(w, r)
}

func (s *Server) static(body []byte, contentType string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.serveStatic(w, r, body, contentType)
	}
}

// Public bundles must use the same transfer budgets as paste downloads;
// otherwise the largest public asset bypasses every bandwidth limit.
func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request, body []byte, contentType string) {
	ip := s.ips.clientIP(r)
	release, ok := s.downloadSlots.acquire(ip)
	if !ok {
		w.Header().Set("Retry-After", "5")
		writeError(w, http.StatusServiceUnavailable, "too many active downloads")
		return
	}
	defer release()
	if ok, _ := s.downloadBytes.allowN(ip, time.Now(), 0); !ok {
		w.Header().Set("Retry-After", "60")
		writeError(w, http.StatusTooManyRequests, "rate limited")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	if r.Method == http.MethodHead {
		return
	}
	deadline := downloadBaseDeadline + time.Duration(len(body)/downloadMinRate)*time.Second
	ctx, cancel := context.WithTimeout(r.Context(), deadline)
	defer cancel()
	if _, err := s.downloadWriter(ctx, w, ip, deadline).Write(body); err != nil {
		panic(http.ErrAbortHandler)
	}
}

type createRequest struct {
	ExpiresIn        *int64 `json:"expires_in"`
	BurnAfterReading *bool  `json:"burn_after_reading"`
	TotalSize        *int64 `json:"total_size"`
	// CommentToken, if present, enables a discussion. The browser derives
	// it from the paste key and password; only its hash is stored.
	CommentToken *string `json:"comment_token"`
	BurnToken    *string `json:"burn_token"`
	MaxReads     *int    `json:"max_reads"`
}

type createResponse struct {
	ID          string `json:"id"`
	UploadToken string `json:"upload_token"`
	DeleteToken string `json:"delete_token"`
}

// downloadWriter streams a response under the bandwidth limits, and fails
// it if the client reads too slowly or takes longer than deadline overall.
func (s *Server) downloadWriter(ctx context.Context, w http.ResponseWriter, ip netip.Addr, deadline time.Duration) bandwidthWriter {
	rc := http.NewResponseController(w)
	hard := time.Now().Add(deadline)
	rc.SetWriteDeadline(hard)
	slow := &minRateWriter{w: w, rc: rc, grace: s.downloadGrace, rate: s.downloadRate, hard: hard, now: time.Now}
	return bandwidthWriter{ctx: ctx, dst: slow, s: s, ip: ip}
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	if !hasContentType(r, "application/json") {
		writeError(w, http.StatusUnsupportedMediaType, "content type must be application/json")
		return
	}
	var req createRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		s.bodyError(w, err, "invalid JSON")
		return
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		s.bodyError(w, err, "unexpected data after JSON object")
		return
	}
	if req.ExpiresIn == nil || req.BurnAfterReading == nil || req.TotalSize == nil {
		writeError(w, http.StatusBadRequest, "expires_in, burn_after_reading and total_size are required")
		return
	}
	expires, ok := allowedExpiry[*req.ExpiresIn]
	if !ok {
		writeError(w, http.StatusBadRequest, "expires_in must be one of 300, 3600, 86400, 604800, 2592000")
		return
	}
	if *req.TotalSize < MinBlobSize {
		writeError(w, http.StatusBadRequest, "total_size is too small")
		return
	}
	if *req.TotalSize > s.cfg.MaxSize {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{"error": "paste too large", "max_size": s.cfg.MaxSize})
		return
	}
	commentToken := ""
	if req.CommentToken != nil {
		commentToken = *req.CommentToken
		if !validToken(commentToken) {
			writeError(w, http.StatusBadRequest, "comment_token must be 43 base64url characters")
			return
		}
		if *req.BurnAfterReading {
			writeError(w, http.StatusBadRequest, "a burn-after-reading paste cannot have a discussion")
			return
		}
	}
	burnToken := ""
	if req.BurnToken != nil {
		burnToken = *req.BurnToken
	}
	if (*req.BurnAfterReading && !validToken(burnToken)) || (!*req.BurnAfterReading && req.BurnToken != nil) {
		writeError(w, http.StatusBadRequest, "burn_token is required only for burn-after-reading pastes and must be 43 base64url characters")
		return
	}
	reads := 0
	if *req.BurnAfterReading {
		reads = 1
	}
	if req.MaxReads != nil {
		if !*req.BurnAfterReading || *req.MaxReads < 1 || *req.MaxReads > storage.MaxBurnReads {
			writeError(w, http.StatusBadRequest, "max_reads requires burn_after_reading and must be an integer from 1 to 1000")
			return
		}
		reads = *req.MaxReads
	}
	ip := s.ips.clientIP(r)
	if !s.pending.reserve(ip, s.nowFunc()) {
		w.Header().Set("Retry-After", "60")
		writeError(w, http.StatusServiceUnavailable, "too many unfinished uploads")
		return
	}
	c, err := s.cfg.Store.CreatePendingWithReadLimit(expires, *req.BurnAfterReading, *req.TotalSize, commentToken, burnToken, reads)
	if err != nil {
		s.pending.cancel(ip)
	}
	if errors.Is(err, storage.ErrQuota) {
		writeError(w, http.StatusInsufficientStorage, "storage capacity reached")
		return
	}
	if errors.Is(err, storage.ErrUploadLimit) {
		w.Header().Set("Retry-After", "60")
		writeError(w, http.StatusServiceUnavailable, "too many unfinished uploads")
		return
	}
	if err != nil {
		s.internalError(w, "create", err)
		return
	}
	s.pending.created(ip, c.ID)
	writeJSON(w, http.StatusCreated, createResponse{ID: c.ID, UploadToken: c.UploadToken, DeleteToken: c.DeleteToken})
}

func (s *Server) handleChunk(w http.ResponseWriter, r *http.Request) {
	release, ok := s.chunkSlots.acquire(s.ips.clientIP(r))
	if !ok {
		w.Header().Set("Retry-After", "5")
		writeError(w, http.StatusServiceUnavailable, "too many active uploads")
		return
	}
	defer release()
	id := r.PathValue("id")
	if !storage.ValidID(id) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	n, ok := parseChunkIndex(r.PathValue("n"))
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid chunk index")
		return
	}
	if !hasContentType(r, "application/octet-stream") {
		writeError(w, http.StatusUnsupportedMediaType, "content type must be application/octet-stream")
		return
	}
	// A chunk gets a bounded amount of time and must keep arriving at a
	// minimum rate, so a slow client cannot hold an upload slot.
	start := time.Now()
	deadline := start.Add(s.chunkTimeout)
	rc := http.NewResponseController(w)
	rc.SetWriteDeadline(deadline.Add(10 * time.Second))

	body := &readErrRecorder{r: &minRateReader{
		r: r.Body, rc: rc, start: start, grace: s.chunkGrace, rate: chunkMinRate, hard: deadline, now: time.Now,
	}}
	err := s.cfg.Store.AppendChunk(id, n, r.Header.Get(UploadTokenHeader), body)
	var maxErr *http.MaxBytesError
	var order *storage.OutOfOrderError
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.As(err, &maxErr), errors.Is(err, storage.ErrTooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, "chunk too large")
	case errors.Is(err, storage.ErrNotFound):
		writeError(w, http.StatusNotFound, "not found")
	case errors.As(err, &order):
		// Only reached with a valid upload token.
		writeJSON(w, http.StatusConflict, map[string]any{"error": "chunk out of order", "next_chunk": order.Next})
	case errors.Is(err, storage.ErrConflict):
		writeError(w, http.StatusConflict, "upload busy")
	case errors.Is(err, storage.ErrEmptyChunk):
		writeError(w, http.StatusBadRequest, "empty chunk")
	case errors.Is(err, storage.ErrChunkTooSmall):
		writeError(w, http.StatusBadRequest, "chunk too small: every chunk but the last must be at least 4 MiB")
	case errors.Is(err, storage.ErrQuota):
		writeError(w, http.StatusInsufficientStorage, "storage capacity reached")
	case errors.Is(body.err, errTooSlow), errors.Is(body.err, os.ErrDeadlineExceeded):
		writeError(w, http.StatusRequestTimeout, "upload too slow")
	case body.err != nil:
		writeError(w, http.StatusBadRequest, "could not read request body")
	default:
		s.internalError(w, "chunk", err)
	}
}

func (s *Server) handleFinalize(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !storage.ValidID(id) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	m, err := s.cfg.Store.Finalize(id, r.Header.Get(UploadTokenHeader))
	switch {
	case err == nil:
		s.pending.release(id)
		writeJSON(w, http.StatusOK, map[string]any{"expires_at": m.ExpiresAt.Format(time.RFC3339)})
	case errors.Is(err, storage.ErrNotFound):
		writeError(w, http.StatusNotFound, "not found")
	case errors.Is(err, storage.ErrConflict):
		writeError(w, http.StatusConflict, "upload busy")
	case errors.Is(err, storage.ErrIncomplete):
		writeError(w, http.StatusBadRequest, "upload incomplete")
	case errors.Is(err, storage.ErrQuota):
		writeError(w, http.StatusInsufficientStorage, "storage capacity reached")
	default:
		s.internalError(w, "finalize", err)
	}
}

func (s *Server) handleGet(w http.ResponseWriter, r *http.Request) {
	// "GET" patterns also match HEAD. A HEAD must never claim (and so
	// destroy) a burn-after-reading paste without delivering it.
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET, DELETE")
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	s.download(w, r, false)
}

func (s *Server) handleReadBurn(w http.ResponseWriter, r *http.Request) { s.download(w, r, true) }

func (s *Server) handleBurnPrefix(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	prefix, err := s.cfg.Store.BurnPrefix(r.PathValue("id"))
	if errors.Is(err, storage.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		s.internalError(w, "prefix", err)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(prefix)))
	w.Write(prefix)
}

func (s *Server) download(w http.ResponseWriter, r *http.Request, burn bool) {
	ip := s.ips.clientIP(r)
	release, ok := s.downloadSlots.acquire(ip)
	if !ok {
		w.Header().Set("Retry-After", "5")
		writeError(w, http.StatusServiceUnavailable, "too many active downloads")
		return
	}
	defer release()
	id := r.PathValue("id")
	if !storage.ValidID(id) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	// Allocate a bandwidth bucket before claiming a burn paste. Fail closed
	// if the bounded client table is full.
	if ok, _ := s.downloadBytes.allowN(ip, time.Now(), 0); !ok {
		w.Header().Set("Retry-After", "60")
		writeError(w, http.StatusTooManyRequests, "rate limited")
		return
	}
	var p *storage.Paste
	var err error
	if burn {
		p, err = s.cfg.Store.ReadBurn(id, r.Header.Get(BurnTokenHeader))
	} else {
		p, err = s.cfg.Store.Get(id)
	}
	if errors.Is(err, storage.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		s.internalError(w, "get", err)
		return
	}
	defer p.Close() // removes a burn paste once its allowed opens are exhausted

	// Allow slow clients, but not forever.
	deadline := downloadBaseDeadline + time.Duration(p.Meta.Size/downloadMinRate)*time.Second

	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Disposition", `attachment; filename="nullbin.bin"`)
	h.Set("Content-Length", strconv.FormatInt(p.Meta.Size, 10))
	if burn {
		remaining := 0
		if p.Meta.ReadLimit > 1 {
			remaining = p.Meta.ReadLimit - p.Meta.ReadsUsed
		}
		h.Set(ReadsRemainingHeader, strconv.Itoa(remaining))
	}
	w.WriteHeader(http.StatusOK)
	// The context also bounds time spent waiting for bandwidth, which a
	// socket write deadline alone cannot do.
	ctx, cancel := context.WithTimeout(r.Context(), deadline)
	defer cancel()
	io.Copy(s.downloadWriter(ctx, w, ip, deadline), p) // client disconnects stop streaming
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !storage.ValidID(id) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	err := s.cfg.Store.Delete(id, r.Header.Get(DeleteTokenHeader))
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, storage.ErrNotFound):
		writeError(w, http.StatusNotFound, "not found")
	case errors.Is(err, storage.ErrConflict):
		writeError(w, http.StatusConflict, "paste busy, try again")
	default:
		s.internalError(w, "delete", err)
	}
}

// minCommentSize is the smallest valid encrypted comment: a version byte,
// a 24-byte nonce and a 16-byte authentication tag.
const minCommentSize = 1 + 24 + 16

func (s *Server) handleAddComment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !storage.ValidID(id) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if !hasContentType(r, "application/octet-stream") {
		writeError(w, http.StatusUnsupportedMediaType, "content type must be application/octet-stream")
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		s.bodyError(w, err, "could not read request body")
		return
	}
	if len(body) < minCommentSize {
		writeError(w, http.StatusBadRequest, "comment too short")
		return
	}
	n, err := s.cfg.Store.AddComment(id, r.Header.Get(CommentTokenHeader), body)
	switch {
	case err == nil:
		writeJSON(w, http.StatusCreated, map[string]int{"count": n})
	case errors.Is(err, storage.ErrNotFound):
		writeError(w, http.StatusNotFound, "not found")
	case errors.Is(err, storage.ErrTooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, "comment too large")
	case errors.Is(err, storage.ErrDiscussionFull):
		writeError(w, http.StatusConflict, "this discussion is full")
	case errors.Is(err, storage.ErrConflict):
		writeError(w, http.StatusConflict, "paste busy, try again")
	default:
		s.internalError(w, "comment", err)
	}
}

func (s *Server) handleComments(w http.ResponseWriter, r *http.Request) {
	ip := s.ips.clientIP(r)
	release, ok := s.downloadSlots.acquire(ip)
	if !ok {
		w.Header().Set("Retry-After", "5")
		writeError(w, http.StatusServiceUnavailable, "too many active downloads")
		return
	}
	defer release()
	if ok, _ := s.downloadBytes.allowN(ip, time.Now(), 0); !ok {
		w.Header().Set("Retry-After", "60")
		writeError(w, http.StatusTooManyRequests, "rate limited")
		return
	}
	id := r.PathValue("id")
	if !storage.ValidID(id) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	comments, err := s.cfg.Store.Comments(id, r.Header.Get(CommentTokenHeader))
	switch {
	case err == nil:
		// Stream one base64-encoded comment at a time. Slow clients must not
		// each retain the whole discussion and its serialized JSON copy.
		const maxResponse = storage.MaxComments * ((storage.MaxCommentBytes+2)/3*4 + 4)
		deadline := downloadBaseDeadline + time.Duration(maxResponse/downloadMinRate)*time.Second
		ctx, cancel := context.WithTimeout(r.Context(), deadline)
		defer cancel()
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodHead {
			return
		}
		bw := s.downloadWriter(ctx, w, ip, deadline)
		if _, err := io.WriteString(bw, `{"comments":[`); err != nil {
			panic(http.ErrAbortHandler)
		}
		enc := json.NewEncoder(bw)
		first := true
		for b, err := range comments {
			if err != nil {
				s.logger.Printf("error: comments: %s", describeError(err))
				panic(http.ErrAbortHandler)
			}
			if !first {
				if _, err := io.WriteString(bw, ","); err != nil {
					panic(http.ErrAbortHandler)
				}
			}
			if err := enc.Encode(b); err != nil {
				panic(http.ErrAbortHandler)
			}
			first = false
		}
		if _, err := io.WriteString(bw, "]}"); err != nil {
			panic(http.ErrAbortHandler)
		}
	case errors.Is(err, storage.ErrNotFound):
		writeError(w, http.StatusNotFound, "not found")
	default:
		s.internalError(w, "comments", err)
	}
}

// validToken reports whether t looks like a 256-bit base64url token.
func validToken(t string) bool {
	if len(t) != 43 {
		return false
	}
	for i := 0; i < len(t); i++ {
		c := t[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	if s.cfg.APIOnly {
		writeJSON(w, http.StatusOK, map[string]string{"version": s.cfg.Version, "mode": "api"})
		return
	}
	a := s.cfg.Assets
	writeJSON(w, http.StatusOK, map[string]string{
		"version":     s.cfg.Version,
		"js_sha256":   a.JSSHA256,
		"css_sha256":  a.CSSSHA256,
		"html_sha256": a.HTMLSHA256,
	})
}

func (s *Server) bodyError(w http.ResponseWriter, err error, msg string) {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
		return
	}
	writeError(w, http.StatusBadRequest, msg)
}

func (s *Server) internalError(w http.ResponseWriter, op string, err error) {
	s.logger.Printf("error: %s: %s", op, describeError(err))
	writeError(w, http.StatusInternalServerError, "internal error")
}

// parseChunkIndex accepts a plain decimal number without sign or leading
// zeros.
func parseChunkIndex(s string) (int, bool) {
	if s == "" || len(s) > 10 || (len(s) > 1 && s[0] == '0') {
		return 0, false
	}
	n := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + int(c-'0')
	}
	if n > maxChunkIndex {
		return 0, false
	}
	return n, true
}

func hasContentType(r *http.Request, want string) bool {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return err == nil && mt == want
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		status, body = http.StatusInternalServerError, []byte(`{"error":"internal error"}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	w.Write(body)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// readErrRecorder remembers read errors so the handler can tell a client
// failure (bad or interrupted body) from a server failure (disk).
type readErrRecorder struct {
	r   io.Reader
	err error
}

func (rr *readErrRecorder) Read(p []byte) (int, error) {
	n, err := rr.r.Read(p)
	if err != nil && err != io.EOF {
		rr.err = err
	}
	return n, err
}
