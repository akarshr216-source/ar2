package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"netfusion/server/internal/api"
	"netfusion/server/internal/auth"
	"netfusion/server/internal/config"
	"netfusion/server/internal/database"
	"netfusion/server/internal/metrics"
	"netfusion/server/internal/network"
)

func newTestServer(t *testing.T) (*api.Server, *database.Store) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "test-netfusion.db")
	store, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	cfg := &config.Config{
		Application: config.ApplicationConfig{Name: "NetFusion", Version: "0.2.0", Theme: "system"},
		Server:      config.ServerConfig{Enabled: true, Port: 8080, LANOnly: true},
		Network:     config.NetworkConfig{AutoDiscovery: true, MonitorIntervalSeconds: 3},
	}
	discoverer := network.NewDiscoverer()
	collector := metrics.NewCollector(store)
	monitor := network.NewMonitor(discoverer, collector, 3*time.Second)
	pairingSvc := auth.NewPairingService(store, 15)
	srv := api.NewServer(cfg, store, discoverer, collector, monitor, pairingSvc)
	return srv, store
}

func TestGoServerHealthAndQrPairingLifecycle(t *testing.T) {
	srv, _ := newTestServer(t)
	h := srv.Handler()

	// 1. Health endpoint
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	req.RemoteAddr = "127.0.0.1:50000"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 health, got %d", rec.Code)
	}
	var health map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &health)
	if health["backend_mode"] != "go" {
		t.Fatalf("expected backend_mode=go, got %v", health["backend_mode"])
	}

	// 2. Claim admin password
	claimReq := httptest.NewRequest(http.MethodPost, "/api/admin/claim", bytes.NewBufferString(`{"passcode":"test-pass-123"}`))
	claimReq.RemoteAddr = "127.0.0.1:50000"
	claimRec := httptest.NewRecorder()
	h.ServeHTTP(claimRec, claimReq)
	if claimRec.Code != http.StatusCreated {
		t.Fatalf("expected 201 claim, got %d: %s", claimRec.Code, claimRec.Body.String())
	}
	var claimBody struct {
		AdminToken string `json:"admin_token"`
	}
	_ = json.Unmarshal(claimRec.Body.Bytes(), &claimBody)

	// 3. Reject localhost in QR payload generation
	badQrReq := httptest.NewRequest(http.MethodPost, "/api/pairing/generate", bytes.NewBufferString(`{"server_url":"http://localhost:8080"}`))
	badQrReq.RemoteAddr = "127.0.0.1:50000"
	badQrReq.Header.Set("Authorization", "Bearer "+claimBody.AdminToken)
	badQrRec := httptest.NewRecorder()
	h.ServeHTTP(badQrRec, badQrReq)
	if badQrRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 rejecting localhost QR url, got %d", badQrRec.Code)
	}

	// 4. Generate valid QR payload with LAN IP
	qrReq := httptest.NewRequest(http.MethodPost, "/api/pairing/generate", bytes.NewBufferString(`{"server_url":"http://192.168.1.16:8080","platform_hint":"android"}`))
	qrReq.RemoteAddr = "127.0.0.1:50000"
	qrReq.Header.Set("Authorization", "Bearer "+claimBody.AdminToken)
	qrRec := httptest.NewRecorder()
	h.ServeHTTP(qrRec, qrReq)
	if qrRec.Code != http.StatusCreated {
		t.Fatalf("expected 201 generate, got %d: %s", qrRec.Code, qrRec.Body.String())
	}
	var gen struct {
		PairingID string `json:"pairing_id"`
		Secret    string `json:"secret"`
		QrPayload string `json:"qr_payload"`
	}
	_ = json.Unmarshal(qrRec.Body.Bytes(), &gen)
	if !strings.HasPrefix(gen.QrPayload, "netfusion://pair?") {
		t.Fatalf("unexpected qr_payload: %s", gen.QrPayload)
	}
	u, err := url.Parse(gen.QrPayload)
	if err != nil {
		t.Fatalf("parse qr_payload: %v", err)
	}
	if u.Query().Get("server") != "http://192.168.1.16:8080" {
		t.Fatalf("unexpected QR server param: %s", u.Query().Get("server"))
	}
	if u.Query().Get("auth_token") != "" {
		t.Fatalf("QR payload must never contain auth_token")
	}

	// 5. Pair Android client -> paired & disconnected until heartbeat
	pairBody, _ := json.Marshal(map[string]string{
		"pairing_id":   gen.PairingID,
		"secret":       gen.Secret,
		"device_name":  "Pixel 9",
		"platform":     "android",
		"device_model": "Google Pixel 9",
		"ip_address":   "192.168.1.44",
		"app_version":  "0.2.0",
	})
	pairReq := httptest.NewRequest(http.MethodPost, "/api/clients/pair", bytes.NewReader(pairBody))
	pairReq.RemoteAddr = "192.168.1.44:51234"
	pairRec := httptest.NewRecorder()
	h.ServeHTTP(pairRec, pairReq)
	if pairRec.Code != http.StatusCreated {
		t.Fatalf("expected 201 pair, got %d: %s", pairRec.Code, pairRec.Body.String())
	}
	var paired struct {
		Device    auth.Device `json:"device"`
		AuthToken string      `json:"auth_token"`
	}
	_ = json.Unmarshal(pairRec.Body.Bytes(), &paired)
	if paired.Device.ConnectionStatus != "disconnected" {
		t.Fatalf("expected initial connection_status=disconnected before heartbeat, got %s", paired.Device.ConnectionStatus)
	}

	// 6. Reject reused code
	reuseReq := httptest.NewRequest(http.MethodPost, "/api/clients/pair", bytes.NewReader(pairBody))
	reuseReq.RemoteAddr = "192.168.1.45:51234"
	reuseRec := httptest.NewRecorder()
	h.ServeHTTP(reuseRec, reuseReq)
	if reuseRec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 on reused code, got %d", reuseRec.Code)
	}

	// 7. Heartbeat transitions device to connected
	hbReq := httptest.NewRequest(http.MethodPost, "/api/clients/heartbeat", bytes.NewBufferString(`{"ip_address":"192.168.1.44"}`))
	hbReq.RemoteAddr = "192.168.1.44:51235"
	hbReq.Header.Set("Authorization", "Bearer "+paired.AuthToken)
	hbRec := httptest.NewRecorder()
	h.ServeHTTP(hbRec, hbReq)
	if hbRec.Code != http.StatusOK {
		t.Fatalf("expected 200 heartbeat, got %d", hbRec.Code)
	}
	var hbResp struct {
		Device auth.Device `json:"device"`
	}
	_ = json.Unmarshal(hbRec.Body.Bytes(), &hbResp)
	if hbResp.Device.ConnectionStatus != "connected" {
		t.Fatalf("expected connected after heartbeat, got %s", hbResp.Device.ConnectionStatus)
	}
}
