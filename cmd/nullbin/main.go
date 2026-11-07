// Command nullbin runs the Nullbin zero-knowledge pastebin server.
//
// Configuration comes only from environment variables; see README.md.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jacobzymet/nullbin-go/internal/assets"
	"github.com/jacobzymet/nullbin-go/internal/server"
	"github.com/jacobzymet/nullbin-go/internal/storage"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

const sweepInterval = time.Minute

func main() {
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	if len(os.Args) == 3 && os.Args[1] == "delete" {
		os.Exit(deletePaste(os.Environ(), os.Args[2], os.Stdout))
	}
	if len(os.Args) == 2 && os.Args[1] == "stats" {
		os.Exit(showStats(os.Environ(), os.Stdout))
	}
	if len(os.Args) > 1 {
		log.Printf("usage: nullbin [healthcheck | stats | delete <paste id>] (configuration comes from NULLBIN_* environment variables)")
		os.Exit(2)
	}
	os.Exit(run())
}

// showStats prints counts and sizes for the operator. It only reads the
// data directory, so it is safe while the server runs.
func showStats(environ []string, out io.Writer) int {
	cfg, err := loadConfig(environ)
	if err != nil {
		fmt.Fprintln(out, "invalid configuration:", err)
		return 2
	}
	st, err := storage.ReadStats(cfg.DataDir, time.Now())
	if err != nil {
		fmt.Fprintln(out, "read data directory:", err)
		return 1
	}
	free, total, ok := storage.DiskSpace(cfg.DataDir)
	fmt.Fprint(out, formatStats(st, cfg, free, total, ok))
	return 0
}

// formatStats renders stats for people. It contains no identifiers.
func formatStats(st storage.Stats, cfg config, free, total int64, diskKnown bool) string {
	var b strings.Builder
	line := func(format string, args ...any) { fmt.Fprintf(&b, format+"\n", args...) }
	line("Pastes:              %d (%d burn after reading, %d with a discussion)", st.Pastes, st.Burn, st.Discussion)
	line("  encrypted size:    %s", humanBytes(st.PasteBytes))
	line("Comments:            %d (%s)", st.Comments, humanBytes(st.CommentBytes))
	line("Unfinished uploads:  %d", st.Pending)
	if st.Removable > 0 {
		line("Waiting for cleanup: %d expired or used-up pastes (removed within a minute)", st.Removable)
	}
	if st.Newer > 0 {
		line("From a newer version: %d pastes, kept but not served", st.Newer)
	}
	line("Storage budget:      %s of %s used (%s)", humanBytes(st.Charged), humanBytes(cfg.MaxStorage), percent(st.Charged, cfg.MaxStorage))
	line("Paste limit:         %d of %d used (%s)", st.Entries, cfg.MaxPastes, percent(int64(st.Entries), int64(cfg.MaxPastes)))
	if diskKnown {
		line("Disk:                %s free of %s", humanBytes(free), humanBytes(total))
	} else {
		line("Disk:                unknown on this platform")
	}
	return b.String()
}

func humanBytes(n int64) string {
	if n < 1024 {
		return fmt.Sprintf("%d B", n)
	}
	v, unit := float64(n)/1024, "KiB"
	for _, u := range []string{"MiB", "GiB", "TiB"} {
		if v < 1024 {
			break
		}
		v, unit = v/1024, u
	}
	return fmt.Sprintf("%.1f %s", v, unit)
}

func percent(n, of int64) string {
	if of <= 0 {
		return "-"
	}
	return fmt.Sprintf("%.1f%%", float64(n)*100/float64(of))
}

// healthcheck asks the running server on this machine for its version and
// exits 0 if it answers. It is meant for container health checks, since the
// image has no shell or curl.
// deletePaste removes one paste or unfinished upload by ID, for operators
// taking down reported content. Stop the server first: it keeps storage
// accounting in memory and rebuilds it from disk when it starts.
func deletePaste(environ []string, id string, out io.Writer) int {
	if !storage.ValidID(id) {
		fmt.Fprintln(out, "Give the paste ID: the 32 characters after /p/ or /d/ in its link, without the part after #.")
		return 2
	}
	cfg, err := loadConfig(environ)
	if err != nil {
		fmt.Fprintln(out, "invalid configuration:", err)
		return 2
	}
	store, err := storage.OpenWithLimits(cfg.DataDir, storage.Limits{MaxBytes: cfg.MaxStorage, MaxPending: cfg.MaxPending, MaxPastes: cfg.MaxPastes})
	if err != nil {
		fmt.Fprintln(out, "open data directory:", err)
		return 1
	}
	defer store.Close()
	switch err := store.Remove(id); {
	case err == nil:
		fmt.Fprintln(out, "Deleted.")
		return 0
	case errors.Is(err, storage.ErrNotErased):
		fmt.Fprintln(out, "The paste can no longer be opened, but some of its files could not be erased. Check that the data volume is writable; Nullbin keeps trying every minute.")
		return 1
	case errors.Is(err, storage.ErrNotFound):
		fmt.Fprintln(out, "No paste with that ID. It may have expired or been deleted already.")
		return 1
	default:
		fmt.Fprintln(out, "delete failed:", err)
		return 1
	}
}

func healthcheck() int {
	cfg, err := loadConfig(os.Environ())
	if err != nil {
		log.Printf("unhealthy: invalid configuration")
		return 1
	}
	url, err := healthURL(cfg.ListenAddr)
	if err != nil {
		log.Printf("unhealthy: %v", err)
		return 1
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		log.Printf("unhealthy: server not reachable")
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("unhealthy: status %d", resp.StatusCode)
		return 1
	}
	return 0
}

// healthURL turns the listen address into a local URL: a wildcard host
// (":8080", "0.0.0.0:8080", "[::]:8080") is reached via 127.0.0.1.
func healthURL(listen string) (string, error) {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return "", err
	}
	switch host {
	case "", "0.0.0.0", "::":
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port) + "/api/v1/version", nil
}

func run() int {
	// Logs never contain IPs, paste IDs, tokens, user agents or bodies:
	// only startup information, errors without identifiers, and counts.
	logger := log.New(os.Stderr, "", log.LstdFlags|log.LUTC)

	cfg, err := loadConfig(os.Environ())
	if err != nil {
		logger.Printf("invalid configuration: %v", err)
		return 2
	}
	bundle := &assets.Bundle{}
	if !cfg.APIOnly {
		bundle, err = assets.Load()
		if err != nil {
			logger.Printf("startup: %v", err)
			return 1
		}
	}
	store, err := storage.OpenWithLimits(cfg.DataDir, storage.Limits{MaxBytes: cfg.MaxStorage, MaxPending: cfg.MaxPending, MaxPastes: cfg.MaxPastes})
	if err != nil {
		logger.Printf("startup: %v", err)
		return 1
	}
	defer store.Close()

	srv := server.New(server.Config{
		Store:          store,
		Assets:         bundle,
		Version:        version,
		MaxSize:        cfg.MaxSize,
		BehindHTTPS:    cfg.BehindHTTPS,
		TrustedProxies: cfg.TrustedProxies,
		Logger:         logger,
		APIOnly:        cfg.APIOnly,
		FrontendOrigin: cfg.FrontendOrigin,
	})
	httpSrv := srv.HTTPServer(cfg.ListenAddr)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	sweep(store, srv, logger) // clean up anything left by a previous run
	go func() {
		t := time.NewTicker(sweepInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				sweep(store, srv, logger)
			}
		}
	}()

	errc := make(chan error, 1)
	go func() { errc <- httpSrv.ListenAndServe() }()
	logger.Printf("nullbin %s listening on %s (max paste size %d bytes, %d trusted proxies, https headers %v)",
		version, cfg.ListenAddr, cfg.MaxSize, len(cfg.TrustedProxies), cfg.BehindHTTPS)
	if cfg.APIOnly {
		logger.Printf("API-only mode; frontend files are served separately")
	} else {
		logger.Printf("frontend sha256: js %s css %s html %s", bundle.JSSHA256, bundle.CSSSHA256, bundle.HTMLSHA256)
	}

	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Printf("server: %v", err)
			return 1
		}
	case <-ctx.Done():
		logger.Printf("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := httpSrv.Shutdown(shutdownCtx); err != nil {
			logger.Printf("shutdown: %v", err)
		}
	}
	return 0
}

func sweep(store *storage.Store, srv *server.Server, logger *log.Logger) {
	st := store.Sweep()
	srv.Prune()
	if st != (storage.SweepStats{}) {
		logger.Printf("sweep: removed %d expired pastes, %d with unreadable metadata, %d stale uploads, %d leftover claims; kept %d it could not check and %d from a newer version",
			st.Expired, st.Unreadable, st.StalePending, st.Claimed, st.Errors, st.Newer)
	}
}
