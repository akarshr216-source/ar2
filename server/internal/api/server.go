package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"netfusion/server/internal/auth"
	"netfusion/server/internal/config"
	"netfusion/server/internal/database"
	"netfusion/server/internal/metrics"
	"netfusion/server/internal/network"
)

type Server struct {
	httpServer *http.Server
}

type attemptLimiter struct {
	mu          sync.Mutex
	attempts    map[string][]time.Time
	maxAttempts int
	window      time.Duration
}

func newAttemptLimiter(maxAttempts int, window time.Duration) *attemptLimiter {
	return &attemptLimiter{
		attempts:    make(map[string][]time.Time),
		maxAttempts: maxAttempts,
		window:      window,
	}
}

func (l *attemptLimiter) isBlocked(key string) (bool, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	var recent []time.Time
	for _, ts := range l.attempts[key] {
		if now.Sub(ts) < l.window {
			recent = append(recent, ts)
		}
	}
	l.attempts[key] = recent
	if len(recent) >= l.maxAttempts {
		retryAfter := int((l.window - now.Sub(recent[0])).Seconds()) + 1
		if retryAfter < 1 {
			retryAfter = 1
		}
		return true, retryAfter
	}
	return false, 0
}

func (l *attemptLimiter) recordFailure(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	var recent []time.Time
	for _, ts := range l.attempts[key] {
		if now.Sub(ts) < l.window {
			recent = append(recent, ts)
		}
	}
	recent = append(recent, now)
	l.attempts[key] = recent
}

func (l *attemptLimiter) clear(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, key)
}

func getLanIPv4Addresses() []string {
	var ips []string
	ifaces, err := net.Interfaces()
	if err != nil {
		return ips
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			if ipNet, ok := a.(*net.IPNet); ok {
				if v4 := ipNet.IP.To4(); v4 != nil && !v4.IsLoopback() {
					ips = append(ips, v4.String())
				}
			}
		}
	}
	return ips
}

func isLocalOrLanIP(remoteAddr string) bool {
	host := remoteAddr
	if h, _, err := net.SplitHostPort(remoteAddr); err == nil {
		host = h
	}
	ip := net.ParseIP(strings.TrimSpace(host))
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

func NewServer(
	cfg *config.Config,
	_ *database.Store,
	discoverer *network.Discoverer,
	collector *metrics.Collector,
	pairing *auth.PairingService,
) *Server {
	mux := http.NewServeMux()
	adminPasscode := strings.TrimSpace(os.Getenv("NETFUSION_ADMIN_PASSCODE"))
	pairLimiter := newAttemptLimiter(5, 5*time.Minute)
	loginLimiter := newAttemptLimiter(5, 5*time.Minute)

	var sessionsMu sync.RWMutex
	adminSessions := map[string]time.Time{}

	issueAdminSession := func() (string, time.Time) {
		buf := make([]byte, 24)
		_, _ = rand.Read(buf)
		tok := "nf_adm_" + hex.EncodeToString(buf)
		exp := time.Now().Add(12 * time.Hour)
		sessionsMu.Lock()
		adminSessions[tok] = exp
		sessionsMu.Unlock()
		return tok, exp
	}

	isAdminTokenValid := func(tok string) bool {
		if tok == "" {
			return false
		}
		if adminPasscode != "" && auth.ConstantTimeAdminMatch(tok, adminPasscode) {
			return true
		}
		sessionsMu.RLock()
		exp, ok := adminSessions[tok]
		sessionsMu.RUnlock()
		if !ok {
			return false
		}
		if time.Now().After(exp) {
			sessionsMu.Lock()
			delete(adminSessions, tok)
			sessionsMu.Unlock()
			return false
		}
		return true
	}

	requireLanAdmin := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if cfg.Server.LANOnly && !isLocalOrLanIP(r.RemoteAddr) {
				writeJSON(w, http.StatusForbidden, map[string]string{
					"error": "Administration endpoints are restricted to the local PC and local Wi-Fi network.",
				})
				return
			}
			next(w, r)
		}
	}

	requireAdmin := func(next http.HandlerFunc) http.HandlerFunc {
		return requireLanAdmin(func(w http.ResponseWriter, r *http.Request) {
			tok := extractBearer(r)
			if !isAdminTokenValid(tok) {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "administrator authorization required"})
				return
			}
			next(w, r)
		})
	}

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":        "ok",
			"application":   "NetFusion",
			"version":       cfg.Application.Version,
			"server_port":   cfg.Server.Port,
			"lan_addresses": getLanIPv4Addresses(),
			"timestamp":     time.Now().UTC().Format(time.RFC3339),
		})
	})

	mux.HandleFunc("GET /api/admin/status", requireLanAdmin(func(w http.ResponseWriter, r *http.Request) {
		tok := extractBearer(r)
		writeJSON(w, http.StatusOK, map[string]any{
			"configured_via_env": adminPasscode != "",
			"claimed":            adminPasscode != "",
			"authenticated":      isAdminTokenValid(tok),
		})
	}))

	mux.HandleFunc("POST /api/admin/login", requireLanAdmin(func(w http.ResponseWriter, r *http.Request) {
		key := clientIPFromAddr(r.RemoteAddr)
		if blocked, retry := loginLimiter.isBlocked(key); blocked {
			w.Header().Set("Retry-After", fmt.Sprintf("%d", retry))
			writeJSON(w, http.StatusTooManyRequests, map[string]string{
				"error": fmt.Sprintf("Too many failed login attempts. Try again in %d seconds.", retry),
			})
			return
		}
		if adminPasscode == "" {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{
				"error": "Set NETFUSION_ADMIN_PASSCODE before starting the Windows server.",
			})
			return
		}
		var body struct {
			Passcode string `json:"passcode"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if !auth.ConstantTimeAdminMatch(strings.TrimSpace(body.Passcode), adminPasscode) {
			loginLimiter.recordFailure(key)
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Incorrect administrator password."})
			return
		}
		loginLimiter.clear(key)
		tok, exp := issueAdminSession()
		writeJSON(w, http.StatusOK, map[string]any{
			"admin_token": tok,
			"expires_at":  exp.UTC().Format(time.RFC3339),
		})
	}))

	mux.HandleFunc("POST /api/admin/logout", requireLanAdmin(func(w http.ResponseWriter, r *http.Request) {
		tok := extractBearer(r)
		if tok != "" {
			sessionsMu.Lock()
			delete(adminSessions, tok)
			sessionsMu.Unlock()
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))

	mux.HandleFunc("GET /api/clients", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		devices, err := pairing.ListDevices()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"clients": devices})
	}))

	mux.HandleFunc("POST /api/pairing/generate", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			TTLSeconds   int    `json:"ttl_seconds"`
			PlatformHint string `json:"platform_hint"`
			ServerURL    string `json:"server_url"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.TTLSeconds == 0 {
			body.TTLSeconds = 120
		}
		res, err := pairing.GeneratePairingCode(body.TTLSeconds, body.PlatformHint)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		lanIPs := getLanIPv4Addresses()
		res.LanAddresses = lanIPs
		serverURL := strings.TrimRight(strings.TrimSpace(body.ServerURL), "/")
		if serverURL == "" && len(lanIPs) > 0 {
			serverURL = fmt.Sprintf("http://%s:%d", lanIPs[0], cfg.Server.Port)
		}
		if serverURL != "" {
			res.QrPayload = fmt.Sprintf(
				"netfusion://pair?server=%s&pairing_id=%s&secret=%s",
				url.QueryEscape(serverURL),
				url.QueryEscape(res.PairingID),
				url.QueryEscape(res.Secret),
			)
		}
		writeJSON(w, http.StatusCreated, res)
	}))

	mux.HandleFunc("GET /api/pairing/status", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		st, err := pairing.Status()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, st)
	}))

	mux.HandleFunc("POST /api/clients/pair", func(w http.ResponseWriter, r *http.Request) {
		key := clientIPFromAddr(r.RemoteAddr)
		if blocked, retry := pairLimiter.isBlocked(key); blocked {
			w.Header().Set("Retry-After", fmt.Sprintf("%d", retry))
			writeJSON(w, http.StatusTooManyRequests, map[string]any{
				"error":  fmt.Sprintf("Too many failed pairing attempts. Try again in %d seconds.", retry),
				"reason": "rate_limited",
			})
			return
		}

		var body struct {
			PairingID   string `json:"pairing_id"`
			Secret      string `json:"secret"`
			PairingCode string `json:"pairing_code"`
			DeviceName  string `json:"device_name"`
			Platform    string `json:"platform"`
			DeviceModel string `json:"device_model"`
			IPAddress   string `json:"ip_address"`
			AppVersion  string `json:"app_version"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON payload"})
			return
		}
		rawSecret := strings.TrimSpace(body.Secret)
		if rawSecret == "" {
			rawSecret = strings.TrimSpace(body.PairingCode)
		}
		if rawSecret == "" {
			pairLimiter.recordFailure(key)
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "A valid pairing QR code or secret is required.", "reason": "invalid"})
			return
		}
		if body.DeviceName == "" || (body.Platform != "android" && body.Platform != "windows") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "valid device_name and platform required"})
			return
		}
		if body.IPAddress == "" {
			body.IPAddress = clientIPFromAddr(r.RemoteAddr)
		}
		if body.DeviceModel == "" {
			body.DeviceModel = "Unknown"
		}
		if body.AppVersion == "" {
			body.AppVersion = "1.0.0"
		}

		dev, token, err := pairing.PairWithCode(
			strings.TrimSpace(body.PairingID),
			rawSecret,
			body.DeviceName,
			body.Platform,
			body.DeviceModel,
			body.IPAddress,
			body.AppVersion,
		)
		if err != nil {
			pairLimiter.recordFailure(key)
			code := http.StatusUnauthorized
			reason := "invalid"
			switch {
			case errors.Is(err, auth.ErrExpiredCode):
				reason = "expired"
			case errors.Is(err, auth.ErrUsedCode):
				reason = "used"
			case errors.Is(err, auth.ErrInvalidCode):
				reason = "invalid"
			default:
				code = http.StatusInternalServerError
				reason = "server_error"
			}
			writeJSON(w, code, map[string]any{"error": err.Error(), "reason": reason})
			return
		}
		pairLimiter.clear(key)
		writeJSON(w, http.StatusCreated, map[string]any{
			"device":                     dev,
			"auth_token":                 token,
			"heartbeat_interval_seconds": 5,
		})
	})

	mux.HandleFunc("POST /api/clients/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		tok := extractBearer(r)
		if tok == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "device bearer token required"})
			return
		}
		var body struct {
			IPAddress   string   `json:"ip_address"`
			AppVersion  string   `json:"app_version"`
			DeviceModel string   `json:"device_model"`
			RxBytes     *int64   `json:"rx_bytes"`
			TxBytes     *int64   `json:"tx_bytes"`
			DownloadBps *float64 `json:"download_bps"`
			UploadBps   *float64 `json:"upload_bps"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.IPAddress == "" {
			body.IPAddress = clientIPFromAddr(r.RemoteAddr)
		}

		dev, err := pairing.RecordHeartbeat(
			tok,
			body.IPAddress,
			body.AppVersion,
			body.DeviceModel,
			body.RxBytes,
			body.TxBytes,
			body.DownloadBps,
			body.UploadBps,
		)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"status":      "ok",
			"device":      dev,
			"server_time": time.Now().UTC().Format(time.RFC3339),
		})
	})

	mux.HandleFunc("DELETE /api/clients/{id}", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if err := pairing.RevokeDevice(id); err != nil {
			code := http.StatusInternalServerError
			if errors.Is(err, auth.ErrNotFound) {
				code = http.StatusNotFound
			}
			writeJSON(w, code, map[string]string{"error": err.Error()})
			return
		}
		devices, _ := pairing.ListDevices()
		writeJSON(w, http.StatusOK, map[string]any{"clients": devices})
	}))

	mux.HandleFunc("GET /api/interfaces", func(w http.ResponseWriter, r *http.Request) {
		ifaces, err := discoverer.Scan()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"interfaces": ifaces})
	})

	mux.HandleFunc("GET /api/metrics", func(w http.ResponseWriter, r *http.Request) {
		st, _ := pairing.Status()
		ifaces, _ := discoverer.Scan()
		samples := collector.Snapshot()
		internetStatus := "unavailable"
		var latencyMs *float64
		for _, s := range samples {
			if s.LatencyMs >= 0 {
				internetStatus = "online"
				v := s.LatencyMs
				latencyMs = &v
				break
			}
			internetStatus = "offline"
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"timestamp":           time.Now().UTC().Format(time.RFC3339),
			"server_status":       "running",
			"internet_status":     internetStatus,
			"internet_latency_ms": latencyMs,
			"interfaces":          ifaces,
			"samples":             samples,
			"devices_summary": map[string]int{
				"total":        st.RegisteredDevices,
				"connected":    st.ConnectedDevices,
				"disconnected": st.DisconnectedCount,
			},
		})
	})

	// Serve built frontend dashboard when dist/ is present alongside the Go server
	distDir := filepath.Clean("../dist")
	if info, err := os.Stat(distDir); err == nil && info.IsDir() {
		fs := http.FileServer(http.Dir(distDir))
		mux.Handle("/", fs)
	}

	addr := strings.TrimSpace(os.Getenv("NETFUSION_HOST_BIND"))
	if addr == "" {
		if cfg.Server.LANOnly {
			addr = fmt.Sprintf("0.0.0.0:%d", cfg.Server.Port)
		} else {
			addr = fmt.Sprintf("127.0.0.1:%d", cfg.Server.Port)
		}
	}

	return &Server{
		httpServer: &http.Server{
			Addr:    addr,
			Handler: mux,
		},
	}
}

func clientIPFromAddr(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err == nil {
		return host
	}
	return remoteAddr
}

func extractBearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && strings.EqualFold(h[:7], "Bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

func (s *Server) ListenAndServe() error {
	return s.httpServer.ListenAndServe()
}

func (s *Server) Shutdown(ctx context.Context) error {
	return s.httpServer.Shutdown(ctx)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
