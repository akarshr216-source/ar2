package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"

	"netfusion/server/internal/auth"
	"netfusion/server/internal/bonding"
	"netfusion/server/internal/config"
	"netfusion/server/internal/database"
	"netfusion/server/internal/metrics"
	"netfusion/server/internal/network"
	"netfusion/server/internal/scheduler"
	"netfusion/server/internal/streaming"
)

type Server struct {
	httpServer *http.Server
}

func NewServer(
	cfg *config.Config,
	store *database.Store,
	discoverer *network.Discoverer,
	collector *metrics.Collector,
	sched *scheduler.WeightedHealthScheduler,
	classifier *streaming.Classifier,
	bondMgr *bonding.Manager,
	pairing *auth.PairingService,
) *Server {
	mux := http.NewServeMux()
	adminPasscode := strings.TrimSpace(os.Getenv("NETFUSION_ADMIN_PASSCODE"))

	requireAdmin := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if adminPasscode == "" {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{
					"error": "NETFUSION_ADMIN_PASSCODE environment variable is required for admin device-management endpoints",
				})
				return
			}
			tok := extractBearer(r)
			if !auth.ConstantTimeAdminMatch(tok, adminPasscode) {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "administrator authorization required"})
				return
			}
			next(w, r)
		}
	}

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":  "ok",
			"version": cfg.Application.Version,
			"mode":    "monitoring",
		})
	})

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
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		res, err := pairing.GeneratePairingCode(body.TTLSeconds, body.PlatformHint)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
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
		var body struct {
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
		if body.DeviceName == "" || (body.Platform != "android" && body.Platform != "windows") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "valid device_name and platform required"})
			return
		}
		if body.IPAddress == "" {
			host, _, err := net.SplitHostPort(r.RemoteAddr)
			if err == nil {
				body.IPAddress = host
			}
		}
		if body.DeviceModel == "" {
			body.DeviceModel = "Unknown"
		}
		if body.AppVersion == "" {
			body.AppVersion = "1.0.0"
		}

		dev, token, err := pairing.PairWithCode(
			body.PairingCode,
			body.DeviceName,
			body.Platform,
			body.DeviceModel,
			body.IPAddress,
			body.AppVersion,
		)
		if err != nil {
			code := http.StatusUnauthorized
			if !errors.Is(err, auth.ErrInvalidCode) && !errors.Is(err, auth.ErrExpiredCode) && !errors.Is(err, auth.ErrUsedCode) {
				code = http.StatusInternalServerError
			}
			writeJSON(w, code, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{
			"device":     dev,
			"auth_token": token,
		})
	})

	mux.HandleFunc("POST /api/clients/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		tok := extractBearer(r)
		if tok == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "device bearer token required"})
			return
		}
		var body struct {
			IPAddress   string `json:"ip_address"`
			AppVersion  string `json:"app_version"`
			DeviceModel string `json:"device_model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.IPAddress == "" {
			host, _, err := net.SplitHostPort(r.RemoteAddr)
			if err == nil {
				body.IPAddress = host
			}
		}

		dev, err := pairing.RecordHeartbeat(tok, body.IPAddress, body.AppVersion, body.DeviceModel)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"status": "ok",
			"device": dev,
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
		writeJSON(w, http.StatusOK, map[string]any{"samples": collector.Snapshot()})
	})

	mux.HandleFunc("GET /api/bonding/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, bondMgr.Status())
	})

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
