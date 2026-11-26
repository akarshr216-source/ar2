package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"netfusion/server/internal/database"
)

var (
	ErrInvalidCode  = errors.New("invalid pairing code")
	ErrExpiredCode  = errors.New("pairing code expired")
	ErrUsedCode     = errors.New("pairing code already used")
	ErrUnauthorized = errors.New("unauthorized device token")
	ErrNotFound     = errors.New("device not found")
)

type Device struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	Platform         string   `json:"platform"`
	DeviceModel      string   `json:"device_model"`
	IPAddress        string   `json:"ip_address"`
	PairingStatus    string   `json:"pairing_status"`
	ConnectionStatus string   `json:"connection_status"`
	AppVersion       string   `json:"app_version"`
	RxBytes          *int64   `json:"rx_bytes"`
	TxBytes          *int64   `json:"tx_bytes"`
	DownloadBps      *float64 `json:"download_bps"`
	UploadBps        *float64 `json:"upload_bps"`
	LastSeenAt       string   `json:"last_seen_at"`
	CreatedAt        string   `json:"created_at"`
}

type PairingCodeResult struct {
	PairingID    string   `json:"pairing_id"`
	PairingCode  string   `json:"pairing_code"`
	Secret       string   `json:"secret"`
	ExpiresAt    string   `json:"expires_at"`
	TTLSeconds   int      `json:"ttl_seconds"`
	CodeHint     string   `json:"code_hint"`
	PlatformHint string   `json:"platform_hint"`
	LanAddresses []string `json:"lan_addresses,omitempty"`
	QrPayload    string   `json:"qr_payload,omitempty"`
}

type PairingStatus struct {
	ActiveCodes       int    `json:"active_codes"`
	LatestCodeExpires string `json:"latest_code_expires_at,omitempty"`
	LatestPairingID   string `json:"latest_pairing_id,omitempty"`
	LatestCodeHint    string `json:"latest_code_hint,omitempty"`
	RegisteredDevices int    `json:"registered_devices"`
	ConnectedDevices  int    `json:"connected_devices"`
	DisconnectedCount int    `json:"disconnected_devices"`
	HeartbeatTimeoutS int    `json:"heartbeat_timeout_seconds"`
}

type PairingService struct {
	store             *database.Store
	heartbeatTimeoutS int
}

func NewPairingService(store *database.Store, heartbeatTimeoutSeconds int) *PairingService {
	if heartbeatTimeoutSeconds < 5 {
		heartbeatTimeoutSeconds = 15
	}
	return &PairingService{
		store:             store,
		heartbeatTimeoutS: heartbeatTimeoutSeconds,
	}
}

func normalizeCode(raw string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(raw) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func hashSHA256(val string) string {
	sum := sha256.Sum256([]byte(val))
	return hex.EncodeToString(sum[:])
}

func randomHex(nBytes int) (string, error) {
	buf := make([]byte, nBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func (p *PairingService) GeneratePairingCode(ttlSeconds int, platformHint string) (*PairingCodeResult, error) {
	if ttlSeconds < 30 || ttlSeconds > 600 {
		ttlSeconds = 120
	}
	if platformHint != "android" && platformHint != "windows" {
		platformHint = "any"
	}

	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return nil, err
	}
	raw := make([]byte, 12)
	for i := range buf {
		raw[i] = alphabet[int(buf[i])%len(alphabet)]
	}
	formatted := "NF-" + string(raw[:4]) + "-" + string(raw[4:8]) + "-" + string(raw[8:12])
	codeHash := hashSHA256(normalizeCode(formatted))

	idHex, err := randomHex(8)
	if err != nil {
		return nil, err
	}
	pairingID := "pc-" + idHex
	now := time.Now().UTC()
	expiresAt := now.Add(time.Duration(ttlSeconds) * time.Second)

	_, err = p.store.DB.Exec(
		`INSERT INTO pairing_codes (id, code_hash, code_hint, platform_hint, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		pairingID, codeHash, pairingID, platformHint, expiresAt.Format(time.RFC3339), now.Format(time.RFC3339),
	)
	if err != nil {
		return nil, err
	}

	return &PairingCodeResult{
		PairingID:    pairingID,
		PairingCode:  formatted,
		Secret:       formatted,
		ExpiresAt:    expiresAt.Format(time.RFC3339),
		TTLSeconds:   ttlSeconds,
		CodeHint:     pairingID,
		PlatformHint: platformHint,
	}, nil
}

func (p *PairingService) PairWithCode(pairingID, code, deviceName, platform, deviceModel, ipAddress, appVersion string) (*Device, string, error) {
	norm := normalizeCode(code)
	if len(norm) < 6 {
		return nil, "", ErrInvalidCode
	}
	providedHash := hashSHA256(norm)
	now := time.Now().UTC()
	nowStr := now.Format(time.RFC3339)

	tx, err := p.store.DB.Begin()
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback() }()

	var codeID, storedHash, platformHint, expiresAtStr string
	var usedAt sql.NullString
	if pairingID != "" {
		err = tx.QueryRow(
			`SELECT id, code_hash, platform_hint, expires_at, used_at FROM pairing_codes WHERE id = ?`,
			pairingID,
		).Scan(&codeID, &storedHash, &platformHint, &expiresAtStr, &usedAt)
	} else {
		err = tx.QueryRow(
			`SELECT id, code_hash, platform_hint, expires_at, used_at FROM pairing_codes WHERE code_hash = ?`,
			providedHash,
		).Scan(&codeID, &storedHash, &platformHint, &expiresAtStr, &usedAt)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", ErrInvalidCode
	}
	if err != nil {
		return nil, "", err
	}
	if subtle.ConstantTimeCompare([]byte(storedHash), []byte(providedHash)) != 1 {
		return nil, "", ErrInvalidCode
	}
	if usedAt.Valid {
		return nil, "", ErrUsedCode
	}
	expiresAt, err := time.Parse(time.RFC3339, expiresAtStr)
	if err != nil || !expiresAt.After(now) {
		return nil, "", ErrExpiredCode
	}
	if platformHint != "any" && platformHint != platform {
		return nil, "", ErrInvalidCode
	}

	devHex, err := randomHex(6)
	if err != nil {
		return nil, "", err
	}
	tokHex, err := randomHex(24)
	if err != nil {
		return nil, "", err
	}
	deviceID := "dev-" + devHex
	authToken := "nf_dev_" + tokHex
	tokenHash := hashSHA256(authToken)

	res, err := tx.Exec(
		`UPDATE pairing_codes SET used_at = ?, used_by_device_id = ? WHERE id = ? AND used_at IS NULL`,
		nowStr, deviceID, codeID,
	)
	if err != nil {
		return nil, "", err
	}
	rows, _ := res.RowsAffected()
	if rows == 0 {
		return nil, "", ErrUsedCode
	}

	// Pairing and live connectivity are separate: starts 'disconnected' until first authenticated heartbeat
	_, err = tx.Exec(
		`INSERT INTO devices (id, name, platform, device_model, ip_address, token_hash, pairing_status, connection_status, app_version, rx_bytes, tx_bytes, download_bps, upload_bps, status, last_seen_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'paired', 'disconnected', ?, NULL, NULL, NULL, NULL, 'paired', ?, ?)`,
		deviceID, deviceName, platform, deviceModel, ipAddress, tokenHash, appVersion, nowStr, nowStr,
	)
	if err != nil {
		return nil, "", err
	}

	if err := tx.Commit(); err != nil {
		return nil, "", err
	}

	return &Device{
		ID:               deviceID,
		Name:             deviceName,
		Platform:         platform,
		DeviceModel:      deviceModel,
		IPAddress:        ipAddress,
		PairingStatus:    "paired",
		ConnectionStatus: "disconnected",
		AppVersion:       appVersion,
		LastSeenAt:       nowStr,
		CreatedAt:        nowStr,
	}, authToken, nil
}

func (p *PairingService) RecordHeartbeat(
	bearerToken, ipAddress, appVersion, deviceModel string,
	rxBytes, txBytes *int64,
	downloadBps, uploadBps *float64,
) (*Device, error) {
	if !strings.HasPrefix(bearerToken, "nf_dev_") {
		return nil, ErrUnauthorized
	}
	tokenHash := hashSHA256(bearerToken)
	nowStr := time.Now().UTC().Format(time.RFC3339)

	var dev Device
	var nullRx, nullTx sql.NullInt64
	var nullDown, nullUp sql.NullFloat64
	err := p.store.DB.QueryRow(
		`SELECT id, name, platform, device_model, ip_address, pairing_status, connection_status, app_version, rx_bytes, tx_bytes, download_bps, upload_bps, last_seen_at, created_at
		 FROM devices WHERE token_hash = ? AND pairing_status = 'paired'`,
		tokenHash,
	).Scan(&dev.ID, &dev.Name, &dev.Platform, &dev.DeviceModel, &dev.IPAddress, &dev.PairingStatus, &dev.ConnectionStatus, &dev.AppVersion, &nullRx, &nullTx, &nullDown, &nullUp, &dev.LastSeenAt, &dev.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnauthorized
	}
	if err != nil {
		return nil, err
	}

	if nullRx.Valid {
		v := nullRx.Int64
		dev.RxBytes = &v
	}
	if nullTx.Valid {
		v := nullTx.Int64
		dev.TxBytes = &v
	}
	if nullDown.Valid {
		v := nullDown.Float64
		dev.DownloadBps = &v
	}
	if nullUp.Valid {
		v := nullUp.Float64
		dev.UploadBps = &v
	}

	if ipAddress != "" {
		dev.IPAddress = ipAddress
	}
	if appVersion != "" {
		dev.AppVersion = appVersion
	}
	if deviceModel != "" {
		dev.DeviceModel = deviceModel
	}
	if rxBytes != nil {
		dev.RxBytes = rxBytes
	}
	if txBytes != nil {
		dev.TxBytes = txBytes
	}
	if downloadBps != nil {
		dev.DownloadBps = downloadBps
	}
	if uploadBps != nil {
		dev.UploadBps = uploadBps
	}
	dev.ConnectionStatus = "connected"
	dev.LastSeenAt = nowStr

	_, err = p.store.DB.Exec(
		`UPDATE devices SET connection_status = 'connected', last_seen_at = ?, ip_address = ?, app_version = ?, device_model = ?, rx_bytes = ?, tx_bytes = ?, download_bps = ?, upload_bps = ? WHERE id = ?`,
		nowStr, dev.IPAddress, dev.AppVersion, dev.DeviceModel, dev.RxBytes, dev.TxBytes, dev.DownloadBps, dev.UploadBps, dev.ID,
	)
	if err != nil {
		return nil, err
	}
	return &dev, nil
}

func (p *PairingService) EvaluateTimeouts() error {
	cutoff := time.Now().UTC().Add(-time.Duration(p.heartbeatTimeoutS) * time.Second).Format(time.RFC3339)
	_, err := p.store.DB.Exec(
		`UPDATE devices SET connection_status = 'disconnected' WHERE pairing_status = 'paired' AND connection_status = 'connected' AND last_seen_at < ?`,
		cutoff,
	)
	return err
}

func (p *PairingService) ListDevices() ([]Device, error) {
	_ = p.EvaluateTimeouts()
	rows, err := p.store.DB.Query(
		`SELECT id, name, platform, device_model, ip_address, pairing_status, connection_status, app_version, rx_bytes, tx_bytes, download_bps, upload_bps, last_seen_at, created_at
		 FROM devices ORDER BY CASE WHEN connection_status = 'connected' THEN 0 ELSE 1 END, last_seen_at DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	devices := make([]Device, 0)
	for rows.Next() {
		var d Device
		var nullRx, nullTx sql.NullInt64
		var nullDown, nullUp sql.NullFloat64
		if err := rows.Scan(&d.ID, &d.Name, &d.Platform, &d.DeviceModel, &d.IPAddress, &d.PairingStatus, &d.ConnectionStatus, &d.AppVersion, &nullRx, &nullTx, &nullDown, &nullUp, &d.LastSeenAt, &d.CreatedAt); err != nil {
			return nil, err
		}
		if nullRx.Valid {
			v := nullRx.Int64
			d.RxBytes = &v
		}
		if nullTx.Valid {
			v := nullTx.Int64
			d.TxBytes = &v
		}
		if nullDown.Valid {
			v := nullDown.Float64
			d.DownloadBps = &v
		}
		if nullUp.Valid {
			v := nullUp.Float64
			d.UploadBps = &v
		}
		devices = append(devices, d)
	}
	return devices, nil
}

func (p *PairingService) RevokeDevice(id string) error {
	res, err := p.store.DB.Exec(`DELETE FROM devices WHERE id = ?`, id)
	if err != nil {
		return err
	}
	rows, _ := res.RowsAffected()
	if rows == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *PairingService) Status() (*PairingStatus, error) {
	_ = p.EvaluateTimeouts()
	nowStr := time.Now().UTC().Format(time.RFC3339)

	var activeCodes int
	_ = p.store.DB.QueryRow(`SELECT COUNT(*) FROM pairing_codes WHERE used_at IS NULL AND expires_at > ?`, nowStr).Scan(&activeCodes)

	var latestID, hint, expires sql.NullString
	_ = p.store.DB.QueryRow(
		`SELECT id, code_hint, expires_at FROM pairing_codes WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1`,
		nowStr,
	).Scan(&latestID, &hint, &expires)

	var total, connected, disconnected int
	_ = p.store.DB.QueryRow(
		`SELECT COUNT(*), COALESCE(SUM(CASE WHEN connection_status='connected' THEN 1 ELSE 0 END),0), COALESCE(SUM(CASE WHEN connection_status='disconnected' THEN 1 ELSE 0 END),0)
		 FROM devices WHERE pairing_status = 'paired'`,
	).Scan(&total, &connected, &disconnected)

	return &PairingStatus{
		ActiveCodes:       activeCodes,
		LatestCodeExpires: expires.String,
		LatestPairingID:   latestID.String,
		LatestCodeHint:    hint.String,
		RegisteredDevices: total,
		ConnectedDevices:  connected,
		DisconnectedCount: disconnected,
		HeartbeatTimeoutS: p.heartbeatTimeoutS,
	}, nil
}

func ConstantTimeAdminMatch(provided, expected string) bool {
	if expected == "" || provided == "" {
		return false
	}
	a := sha256.Sum256([]byte(provided))
	b := sha256.Sum256([]byte(expected))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}
