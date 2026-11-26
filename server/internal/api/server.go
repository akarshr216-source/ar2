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
	"sort"
	"strconv"
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
	notifyCh   chan struct{}
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

type lanCandidate struct {
	ip    string
	score int
}

func isVirtualAdapterName(name string) bool {
	lower := strings.ToLower(name)
	for _, kw := range []string{
		"vethernet", "hyper-v", "wsl", "docker", "vmware", "virtualbox", "vbox",
		"tailscale", "zerotier", "hamachi", "bluetooth", "loopback", "isatap", "teredo", "utun", "tun", "tap",
	} {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	return false
}

func scoreLanCandidate(ifaceName string, ip net.IP) int {
	v4 := ip.To4()
	if v4 == nil || v4.IsLoopback() || v4[0] == 127 || v4[0] == 0 {
		return -1000
	}
	score := 0
	switch {
	case v4[0] == 192 && v4[1] == 168:
		score += 100
	case v4[0] == 10:
		score += 80
	case v4[0] == 172 && v4[1] >= 16 && v4[1] <= 31:
		score += 60
	case v4[0] == 169 && v4[1] == 254:
		score -= 50
	default:
		score += 20
	}

	lower := strings.ToLower(ifaceName)
	if strings.Contains(lower, "wi-fi") || strings.Contains(lower, "wifi") || strings.Contains(lower, "wlan") {
		score += 25
	} else if strings.Contains(lower, "ethernet") || strings.HasPrefix(lower, "eth") || strings.HasPrefix(lower, "en") {
		score += 15
	}
	if isVirtualAdapterName(ifaceName) {
		score -= 80
	}
	return score
}

// GetLanIPv4Addresses returns active non-loopback IPv4 addresses sorted with private LAN adapters first.
func GetLanIPv4Addresses() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var candidates []lanCandidate
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
					candidates = append(candidates, lanCandidate{
						ip:    v4.String(),
						score: scoreLanCandidate(iface.Name, v4),
					})
				}
			}
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return candidates[i].score > candidates[j].score
	})
	seen := map[string]bool{}
	ips := make([]string, 0, len(candidates))
	for _, c := range candidates {
		if !seen[c.ip] {
			seen[c.ip] = true
			ips = append(ips, c.ip)
		}
	}
	return ips
}

func isLoopbackOrInvalidHost(host string) bool {
	h := strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	if h == "" || h == "localhost" || h == "0.0.0.0" || h == "::1" || h == "::" {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return ip.IsLoopback() || ip.IsUnspecified()
	}
	return false
}

func isLanHost(host string) bool {
	h := strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	if strings.HasSuffix(h, ".local") {
		return true
	}
	if ip := net.ParseIP(h); ip != nil {
		return ip.IsPrivate() || ip.IsLinkLocalUnicast()
	}
	return false
}

// ValidateQrServerURL ensures QR pairing server URLs are valid, never localhost/loopback, and require HTTPS outside LAN.
func ValidateQrServerURL(raw string) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return "", errors.New("server address is required and cannot be localhost")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("invalid server address; use a full URL such as http://192.168.1.16:8080")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", errors.New("server address must start with http:// or https://")
	}
	host := parsed.Hostname()
	if isLoopbackOrInvalidHost(host) {
		return "", errors.New("QR pairing cannot use localhost or 127.0.0.1; use your PC's Wi-Fi IPv4 address")
	}
	if scheme == "http" && !isLanHost(host) {
		return "", errors.New("server addresses outside the trusted local Wi-Fi network must use HTTPS")
	}
	return scheme + "://" + parsed.Host, nil
}

func resolvePublicServerURL(apiPort int, lanIPs []string) string {
	if raw := strings.TrimSpace(os.Getenv("NETFUSION_PUBLIC_URL")); raw != "" {
		if valid, err := ValidateQrServerURL(raw); err == nil {
			return valid
		}
	}
	for _, ip := range lanIPs {
		if !isLoopbackOrInvalidHost(ip) {
			return fmt.Sprintf("http://%s:%d", ip, apiPort)
		}
	}
	return ""
}

func isLocalOrLanIP(remoteAddr string, forwardedFor string) bool {
	checkIP := func(addr string) bool {
		host := addr
		if h, _, err := net.SplitHostPort(addr); err == nil {
			host = h
		}
		ip := net.ParseIP(strings.TrimSpace(host))
		if ip == nil {
			return false
		}
		return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
	}
	if !checkIP(remoteAddr) {
		return false
	}
	// If proxied from local Node server, verify the original client IP as well
	if strings.TrimSpace(forwardedFor) != "" {
		first := strings.TrimSpace(strings.Split(forwardedFor, ",")[0])
		if !checkIP(first) {
			return false
		}
	}
	return true
}

func NewServer(
	cfg *config.Config,
	store *database.Store,
	discoverer *network.Discoverer,
	collector *metrics.Collector,
	monitor *network.Monitor,
	pairing *auth.PairingService,
) *Server {
	mux := http.NewServeMux()
	adminPasscode := strings.TrimSpace(os.Getenv("NETFUSION_ADMIN_PASSCODE"))
	pairLimiter := newAttemptLimiter(5, 5*time.Minute)
	loginLimiter := newAttemptLimiter(5, 5*time.Minute)

	notifyCh := make(chan struct{}, 1)
	triggerSSE := func() {
		select {
		case notifyCh <- struct{}{}:
		default:
		}
	}
	if monitor != nil {
		monitor.SetOnCycle(triggerSSE)
	}

	var sseMu sync.Mutex
	sseClients := map[chan struct{}]struct{}{}
	go func() {
		for range notifyCh {
			sseMu.Lock()
			for ch := range sseClients {
				select {
				case ch <- struct{}{}:
				default:
				}
			}
			sseMu.Unlock()
		}
	}()

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

	resolvedListenAddr := strings.TrimSpace(os.Getenv("NETFUSION_HOST_BIND"))
	effectivePort := cfg.Server.Port
	if resolvedListenAddr != "" {
		if _, pStr, err := net.SplitHostPort(resolvedListenAddr); err == nil {
			if p, err := strconv.Atoi(pStr); err == nil && p > 0 {
				effectivePort = p
			}
		}
	} else {
		if cfg.Server.LANOnly {
			resolvedListenAddr = fmt.Sprintf("0.0.0.0:%d", cfg.Server.Port)
		} else {
			resolvedListenAddr = fmt.Sprintf("127.0.0.1:%d", cfg.Server.Port)
		}
	}

	buildSnapshot := func() map[string]any {
		settings := store.GetSettings(effectivePort, cfg.Server.LANOnly)
		st, _ := pairing.Status()
		ifaces, _ := discoverer.Scan()
		samples := collector.Snapshot()

		sampleMap := map[string]metrics.Sample{}
		internetStatus := "unavailable"
		var latencyMs *float64
		for _, s := range samples {
			sampleMap[s.InterfaceID] = s
			if s.LatencyMs >= 0 {
				internetStatus = "online"
				v := s.LatencyMs
				latencyMs = &v
			} else if internetStatus == "unavailable" {
				internetStatus = "offline"
			}
		}

		enrichedIfaces := make([]map[string]any, 0, len(ifaces))
		order := 1
		for _, iface := range ifaces {
			if iface.Kind == "loopback" {
				continue
			}
			status := "offline"
			if iface.IsUp {
				if internetStatus == "offline" {
					status = "degraded"
				} else {
					status = "healthy"
				}
			}
			var latestMetric map[string]any
			if s, ok := sampleMap[iface.SystemName]; ok {
				var latVal any
				if s.LatencyMs >= 0 {
					latVal = s.LatencyMs
				}
				latestMetric = map[string]any{
					"interface_id":      "host-" + iface.SystemName,
					"download_mbps":     nil,
					"upload_mbps":       nil,
					"latency_ms":        latVal,
					"jitter_ms":         nil,
					"packet_loss_pct":   s.PacketLossPct,
					"health_score":      nil,
					"rx_bytes":          nil,
					"tx_bytes":          nil,
					"metrics_available": false,
					"probe_source":      "os_tcp_probe",
					"recorded_at":       s.RecordedAt.UTC().Format(time.RFC3339),
				}
			}
			enrichedIfaces = append(enrichedIfaces, map[string]any{
				"id":               "host-" + iface.SystemName,
				"system_name":      iface.SystemName,
				"display_name":     iface.SystemName,
				"provider":         "Operating System Interface",
				"kind":             iface.Kind,
				"ip_address":       iface.IPAddress,
				"mac_address":      iface.MACAddress,
				"is_host_detected": 1,
				"enabled":          1,
				"weight":           50,
				"priority_order":   order,
				"status":           status,
				"updated_at":       time.Now().UTC().Format(time.RFC3339),
				"latest_metric":    latestMetric,
			})
			order++
		}

		return map[string]any{
			"timestamp":           time.Now().UTC().Format(time.RFC3339),
			"server_status":       "running",
			"internet_status":     internetStatus,
			"internet_latency_ms": latencyMs,
			"total_download_mbps": nil,
			"total_upload_mbps":   nil,
			"total_rx_bytes":      nil,
			"total_tx_bytes":      nil,
			"settings":            settings,
			"interfaces":          enrichedIfaces,
			"usage":               []any{},
			"events":              store.GetSystemEvents(25),
			"devices_summary": map[string]int{
				"total":        st.RegisteredDevices,
				"connected":    st.ConnectedDevices,
				"disconnected": st.DisconnectedCount,
			},
		}
	}

	requireLanAdmin := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			settings := store.GetSettings(effectivePort, cfg.Server.LANOnly)
			if settings.LANOnly && !isLocalOrLanIP(r.RemoteAddr, r.Header.Get("X-Forwarded-For")) {
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
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Administrator password required for device management."})
				return
			}
			next(w, r)
		})
	}

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		lanIPs := GetLanIPv4Addresses()
		publicURL := resolvePublicServerURL(effectivePort, lanIPs)
		writeJSON(w, http.StatusOK, map[string]any{
			"status":        "ok",
			"application":   "NetFusion",
			"version":       cfg.Application.Version,
			"backend_mode":  "go",
			"server_port":   effectivePort,
			"public_url":    publicURL,
			"lan_addresses": lanIPs,
			"timestamp":     time.Now().UTC().Format(time.RFC3339),
		})
	})

	mux.HandleFunc("GET /api/admin/status", requireLanAdmin(func(w http.ResponseWriter, r *http.Request) {
		tok := extractBearer(r)
		claimed := adminPasscode != "" || store.IsAdminClaimed()
		writeJSON(w, http.StatusOK, map[string]any{
			"configured_via_env": adminPasscode != "",
			"claimed":            claimed,
			"authenticated":      isAdminTokenValid(tok),
		})
	}))

	mux.HandleFunc("POST /api/admin/claim", requireLanAdmin(func(w http.ResponseWriter, r *http.Request) {
		if adminPasscode != "" {
			writeJSON(w, http.StatusConflict, map[string]string{
				"error": "Administrator passcode is configured via environment secret.",
			})
			return
		}
		var body struct {
			Passcode string `json:"passcode"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		passcode := strings.TrimSpace(body.Passcode)
		if len(passcode) < 6 || len(passcode) > 128 {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": "Password must be between 6 and 128 characters.",
			})
			return
		}
		if err := store.ClaimAdminPasscode(passcode); err != nil {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		tok, exp := issueAdminSession()
		writeJSON(w, http.StatusCreated, map[string]any{
			"admin_token": tok,
			"expires_at":  exp.UTC().Format(time.RFC3339),
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
		if adminPasscode == "" && !store.IsAdminClaimed() {
			writeJSON(w, http.StatusConflict, map[string]string{
				"error": "Administrator password not configured yet.",
			})
			return
		}
		var body struct {
			Passcode string `json:"passcode"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		provided := strings.TrimSpace(body.Passcode)
		valid := false
		if adminPasscode != "" {
			valid = auth.ConstantTimeAdminMatch(provided, adminPasscode)
		} else {
			valid = store.VerifyAdminPasscode(provided)
		}
		if !valid {
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
		settings := store.GetSettings(effectivePort, cfg.Server.LANOnly)
		writeJSON(w, http.StatusOK, map[string]any{
			"clients":                   devices,
			"heartbeat_timeout_seconds": settings.HeartbeatTimeoutSeconds,
		})
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

		lanIPs := GetLanIPv4Addresses()
		var serverURL string
		if strings.TrimSpace(body.ServerURL) != "" {
			valid, err := ValidateQrServerURL(body.ServerURL)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{
					"error":  err.Error(),
					"reason": "invalid_server_url",
				})
				return
			}
			serverURL = valid
		} else {
			serverURL = resolvePublicServerURL(effectivePort, lanIPs)
		}

		if serverURL == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error":  "No active local Wi-Fi IPv4 address was detected. Set NETFUSION_PUBLIC_URL or enter your PC LAN address.",
				"reason": "missing_lan_address",
			})
			return
		}

		res, err := pairing.GeneratePairingCode(body.TTLSeconds, body.PlatformHint)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		res.ServerURL = serverURL
		res.LanAddresses = lanIPs
		res.QrPayload = fmt.Sprintf(
			"netfusion://pair?server=%s&pairing_id=%s&secret=%s",
			url.QueryEscape(serverURL),
			url.QueryEscape(res.PairingID),
			url.QueryEscape(res.Secret),
		)
		store.AddSystemEvent("info", "pairing", fmt.Sprintf("Created QR pairing session %s (expires in %ds).", res.PairingID, res.TTLSeconds))
		triggerSSE()
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
			writeJSON(w, http.StatusUnauthorized, map[string]any{
				"error":  "A valid pairing QR code or secret is required.",
				"reason": "invalid",
			})
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
			msg := "Authentication failed. Invalid QR code or pairing secret."
			switch {
			case errors.Is(err, auth.ErrExpiredCode):
				reason = "expired"
				msg = "Pairing code expired. Generate a new QR code on your PC."
			case errors.Is(err, auth.ErrUsedCode):
				reason = "used"
				msg = "Pairing code already used. Generate a new QR code on your PC."
			case errors.Is(err, auth.ErrInvalidCode):
				reason = "invalid"
			default:
				code = http.StatusInternalServerError
				reason = "server_error"
				msg = err.Error()
			}
			writeJSON(w, code, map[string]any{"error": msg, "reason": reason})
			return
		}
		pairLimiter.clear(key)
		store.AddSystemEvent("info", "pairing", fmt.Sprintf("Paired %s device %q (%s) at %s.", dev.Platform, dev.Name, dev.DeviceModel, dev.IPAddress))
		triggerSSE()
		writeJSON(w, http.StatusCreated, map[string]any{
			"device":                     dev,
			"auth_token":                 token,
			"heartbeat_interval_seconds": 5,
		})
	})

	mux.HandleFunc("POST /api/clients/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		tok := extractBearer(r)
		if tok == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Device authentication token required."})
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
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Authentication failed. Invalid or revoked device token."})
			return
		}
		triggerSSE()
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
		store.AddSystemEvent("warning", "pairing", fmt.Sprintf("Removed device %s.", id))
		triggerSSE()
		devices, _ := pairing.ListDevices()
		writeJSON(w, http.StatusOK, map[string]any{"clients": devices})
	}))

	mux.HandleFunc("GET /api/interfaces", func(w http.ResponseWriter, r *http.Request) {
		snap := buildSnapshot()
		writeJSON(w, http.StatusOK, map[string]any{
			"interfaces": snap["interfaces"],
			"timestamp":  snap["timestamp"],
		})
	})

	mux.HandleFunc("POST /api/network/check", func(w http.ResponseWriter, r *http.Request) {
		var cfMs, ggMs *float64
		if monitor != nil {
			cfMs, ggMs = monitor.ProbeNow()
		}
		snap := buildSnapshot()
		writeJSON(w, http.StatusOK, map[string]any{
			"probe": map[string]any{
				"cloudflare_ms": cfMs,
				"google_dns_ms": ggMs,
			},
			"snapshot": snap,
		})
	})

	mux.HandleFunc("GET /api/metrics", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, buildSnapshot())
	})

	mux.HandleFunc("GET /api/events", func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

		clientCh := make(chan struct{}, 2)
		sseMu.Lock()
		sseClients[clientCh] = struct{}{}
		sseMu.Unlock()
		defer func() {
			sseMu.Lock()
			delete(sseClients, clientCh)
			sseMu.Unlock()
		}()

		sendSnap := func() {
			data, _ := json.Marshal(buildSnapshot())
			_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		}

		sendSnap()
		keepalive := time.NewTicker(15 * time.Second)
		defer keepalive.Stop()

		for {
			select {
			case <-r.Context().Done():
				return
			case <-clientCh:
				sendSnap()
			case <-keepalive.C:
				_, _ = fmt.Fprint(w, ": keepalive\n\n")
				flusher.Flush()
			}
		}
	})

	mux.HandleFunc("GET /api/settings", requireLanAdmin(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"settings": store.GetSettings(effectivePort, cfg.Server.LANOnly),
		})
	}))

	mux.HandleFunc("PUT /api/settings", requireLanAdmin(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid settings payload"})
			return
		}
		patch := map[string]string{}
		if v, ok := body["theme"].(string); ok && (v == "light" || v == "dark" || v == "system") {
			patch["theme"] = v
		}
		if v, ok := body["lan_only"].(bool); ok {
			patch["lan_only"] = strconv.FormatBool(v)
		}
		if v, ok := body["auto_discovery"].(bool); ok {
			patch["auto_discovery"] = strconv.FormatBool(v)
		}
		if v, ok := body["monitor_interval_seconds"].(float64); ok {
			n := int(v)
			if n < 1 {
				n = 1
			} else if n > 30 {
				n = 30
			}
			patch["monitor_interval_seconds"] = strconv.Itoa(n)
			if monitor != nil {
				monitor.SetInterval(time.Duration(n) * time.Second)
			}
		}
		if v, ok := body["heartbeat_timeout_seconds"].(float64); ok {
			n := int(v)
			if n < 5 {
				n = 5
			} else if n > 300 {
				n = 300
			}
			patch["heartbeat_timeout_seconds"] = strconv.Itoa(n)
		}
		if v, ok := body["pairing_code_ttl_seconds"].(float64); ok {
			n := int(v)
			if n < 30 {
				n = 30
			} else if n > 600 {
				n = 600
			}
			patch["pairing_code_ttl_seconds"] = strconv.Itoa(n)
		}
		if v, ok := body["server_port"].(float64); ok {
			n := int(v)
			if n >= 1024 && n <= 65535 {
				patch["server_port"] = strconv.Itoa(n)
			}
		}
		_ = store.UpdateSettings(patch)
		store.AddSystemEvent("info", "settings", "Updated NetFusion configuration.")
		triggerSSE()
		writeJSON(w, http.StatusOK, map[string]any{
			"settings": store.GetSettings(effectivePort, cfg.Server.LANOnly),
		})
	}))

	mux.HandleFunc("GET /api/system-events", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"events": store.GetSystemEvents(60),
		})
	})

	// Serve built frontend dashboard when dist/ is present alongside the Go server
	distDir := filepath.Clean("../dist")
	if info, err := os.Stat(distDir); err == nil && info.IsDir() {
		fs := http.FileServer(http.Dir(distDir))
		mux.Handle("/", fs)
	}

	return &Server{
		httpServer: &http.Server{
			Addr:    resolvedListenAddr,
			Handler: mux,
		},
		notifyCh: notifyCh,
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

func (s *Server) Handler() http.Handler {
	return s.httpServer.Handler
}

func (s *Server) Shutdown(ctx context.Context) error {
	return s.httpServer.Shutdown(ctx)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
