package database

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	DB *sql.DB
}

type Settings struct {
	Theme                   string `json:"theme"`
	ServerPort              int    `json:"server_port"`
	LANOnly                 bool   `json:"lan_only"`
	AutoDiscovery           bool   `json:"auto_discovery"`
	MonitorIntervalSeconds  int    `json:"monitor_interval_seconds"`
	HeartbeatTimeoutSeconds int    `json:"heartbeat_timeout_seconds"`
	PairingCodeTTLSeconds   int    `json:"pairing_code_ttl_seconds"`
}

type SystemEvent struct {
	ID        int64  `json:"id"`
	Level     string `json:"level"`
	Category  string `json:"category"`
	Message   string `json:"message"`
	CreatedAt string `json:"created_at"`
}

const initSchemaSQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('windows', 'android')),
  device_model TEXT NOT NULL DEFAULT 'Unknown',
  ip_address TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  pairing_status TEXT NOT NULL DEFAULT 'paired' CHECK(pairing_status IN ('paired', 'pending', 'revoked')),
  connection_status TEXT NOT NULL DEFAULT 'disconnected' CHECK(connection_status IN ('connected', 'disconnected')),
  app_version TEXT NOT NULL DEFAULT '1.0.0',
  rx_bytes INTEGER,
  tx_bytes INTEGER,
  download_bps REAL,
  upload_bps REAL,
  status TEXT NOT NULL DEFAULT 'paired',
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  code_hint TEXT NOT NULL,
  platform_hint TEXT NOT NULL DEFAULT 'any' CHECK(platform_hint IN ('any', 'windows', 'android')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by_device_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_credentials (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  passcode_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL CHECK(level IN ('info', 'warning', 'error')),
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`

func Open(path string) (*Store, error) {
	dir := filepath.Dir(path)
	if dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(initSchemaSQL); err != nil {
		_ = db.Close()
		return nil, err
	}

	store := &Store{DB: db}
	store.migrateLegacyColumns()
	store.seedDefaults()
	// Remove any legacy experimental/mock rows if opening an older DB
	_, _ = db.Exec(`DELETE FROM devices WHERE id IN ('dev-win-local', 'dev-pixel-9')`)
	_, _ = db.Exec(`DELETE FROM system_events WHERE category = 'failover' OR message LIKE '%Airtel%' OR message LIKE '%Jio%' OR message LIKE '%Mobile Hotspot%'`)
	return store, nil
}

func (s *Store) migrateLegacyColumns() {
	rows, err := s.DB.Query(`PRAGMA table_info(devices)`)
	if err != nil {
		return
	}
	defer rows.Close()

	existing := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, colType string
		var notNull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &colType, &notNull, &dflt, &pk); err == nil {
			existing[name] = true
		}
	}
	if !existing["rx_bytes"] {
		_, _ = s.DB.Exec(`ALTER TABLE devices ADD COLUMN rx_bytes INTEGER`)
	}
	if !existing["tx_bytes"] {
		_, _ = s.DB.Exec(`ALTER TABLE devices ADD COLUMN tx_bytes INTEGER`)
	}
	if !existing["download_bps"] {
		_, _ = s.DB.Exec(`ALTER TABLE devices ADD COLUMN download_bps REAL`)
	}
	if !existing["upload_bps"] {
		_, _ = s.DB.Exec(`ALTER TABLE devices ADD COLUMN upload_bps REAL`)
	}
}

func (s *Store) seedDefaults() {
	now := time.Now().UTC().Format(time.RFC3339)
	defaults := map[string]string{
		"theme":                      "system",
		"server_port":                "8080",
		"lan_only":                   "true",
		"auto_discovery":             "true",
		"monitor_interval_seconds":   "3",
		"heartbeat_timeout_seconds":  "15",
		"pairing_code_ttl_seconds":   "120",
	}
	for k, v := range defaults {
		_, _ = s.DB.Exec(`INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`, k, v, now)
	}
}

func (s *Store) GetSettings(defaultPort int, defaultLANOnly bool) Settings {
	if defaultPort <= 0 {
		defaultPort = 8080
	}
	out := Settings{
		Theme:                   "system",
		ServerPort:              defaultPort,
		LANOnly:                 defaultLANOnly,
		AutoDiscovery:           true,
		MonitorIntervalSeconds:  3,
		HeartbeatTimeoutSeconds: 15,
		PairingCodeTTLSeconds:   120,
	}
	rows, err := s.DB.Query(`SELECT key, value FROM app_settings`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			continue
		}
		switch k {
		case "theme":
			if v == "light" || v == "dark" || v == "system" {
				out.Theme = v
			}
		case "server_port":
			if n, err := strconv.Atoi(v); err == nil && n >= 1024 && n <= 65535 {
				out.ServerPort = n
			}
		case "lan_only":
			out.LANOnly = v != "false"
		case "auto_discovery":
			out.AutoDiscovery = v != "false"
		case "monitor_interval_seconds":
			if n, err := strconv.Atoi(v); err == nil && n >= 1 && n <= 60 {
				out.MonitorIntervalSeconds = n
			}
		case "heartbeat_timeout_seconds":
			if n, err := strconv.Atoi(v); err == nil && n >= 5 && n <= 300 {
				out.HeartbeatTimeoutSeconds = n
			}
		case "pairing_code_ttl_seconds":
			if n, err := strconv.Atoi(v); err == nil && n >= 30 && n <= 600 {
				out.PairingCodeTTLSeconds = n
			}
		}
	}
	return out
}

func (s *Store) UpdateSettings(values map[string]string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	for k, v := range values {
		if _, err := s.DB.Exec(
			`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
			k, v, now,
		); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) AddSystemEvent(level, category, message string) {
	if level != "info" && level != "warning" && level != "error" {
		level = "info"
	}
	_, _ = s.DB.Exec(
		`INSERT INTO system_events (level, category, message, created_at) VALUES (?, ?, ?, ?)`,
		level, category, message, time.Now().UTC().Format(time.RFC3339),
	)
	_, _ = s.DB.Exec(
		`DELETE FROM system_events WHERE id NOT IN (SELECT id FROM system_events ORDER BY id DESC LIMIT 120)`,
	)
}

func (s *Store) GetSystemEvents(limit int) []SystemEvent {
	if limit <= 0 {
		limit = 40
	}
	rows, err := s.DB.Query(`SELECT id, level, category, message, created_at FROM system_events ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return []SystemEvent{}
	}
	defer rows.Close()
	events := make([]SystemEvent, 0)
	for rows.Next() {
		var e SystemEvent
		if err := rows.Scan(&e.ID, &e.Level, &e.Category, &e.Message, &e.CreatedAt); err == nil {
			events = append(events, e)
		}
	}
	return events
}

func pbkdf2SHA256(password, salt []byte, iter, keyLen int) []byte {
	prf := func(key, data []byte) []byte {
		mac := hmac.New(sha256.New, key)
		mac.Write(data)
		return mac.Sum(nil)
	}
	numBlocks := (keyLen + sha256.Size - 1) / sha256.Size
	var dk []byte
	for block := 1; block <= numBlocks; block++ {
		uInput := make([]byte, len(salt)+4)
		copy(uInput, salt)
		uInput[len(salt)] = byte(block >> 24)
		uInput[len(salt)+1] = byte(block >> 16)
		uInput[len(salt)+2] = byte(block >> 8)
		uInput[len(salt)+3] = byte(block)
		u := prf(password, uInput)
		t := make([]byte, len(u))
		copy(t, u)
		for i := 2; i <= iter; i++ {
			u = prf(password, u)
			for j := range t {
				t[j] ^= u[j]
			}
		}
		dk = append(dk, t...)
	}
	return dk[:keyLen]
}

func (s *Store) IsAdminClaimed() bool {
	var id int
	err := s.DB.QueryRow(`SELECT id FROM admin_credentials WHERE id = 1`).Scan(&id)
	return err == nil
}

func (s *Store) ClaimAdminPasscode(passcode string) error {
	saltBuf := make([]byte, 16)
	if _, err := rand.Read(saltBuf); err != nil {
		return err
	}
	saltHex := hex.EncodeToString(saltBuf)
	hashHex := hex.EncodeToString(pbkdf2SHA256([]byte(passcode), []byte(saltHex), 60000, 32))
	now := time.Now().UTC().Format(time.RFC3339)

	res, err := s.DB.Exec(
		`INSERT OR IGNORE INTO admin_credentials (id, passcode_hash, salt, updated_at) VALUES (1, ?, ?, ?)`,
		"pbkdf2:"+hashHex, saltHex, now,
	)
	if err != nil {
		return err
	}
	affected, _ := res.RowsAffected()
	if affected == 0 {
		return errors.New("administrator password is already configured")
	}
	s.AddSystemEvent("info", "security", "Administrator password configured for device management.")
	return nil
}

func (s *Store) VerifyAdminPasscode(passcode string) bool {
	var storedHash, salt string
	err := s.DB.QueryRow(`SELECT passcode_hash, salt FROM admin_credentials WHERE id = 1`).Scan(&storedHash, &salt)
	if err != nil {
		return false
	}
	if len(storedHash) > 7 && storedHash[:7] == "pbkdf2:" {
		expected := storedHash[7:]
		derived := hex.EncodeToString(pbkdf2SHA256([]byte(passcode), []byte(salt), 60000, 32))
		return subtle.ConstantTimeCompare([]byte(expected), []byte(derived)) == 1
	}
	return false
}

func (s *Store) Close() error {
	if s.DB == nil {
		return nil
	}
	return s.DB.Close()
}
