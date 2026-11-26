-- NetFusion SQLite Schema (Shared Authoritative Registry)
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

CREATE TABLE IF NOT EXISTS interfaces (
  id TEXT PRIMARY KEY,
  system_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('ethernet', 'wifi', 'cellular_usb', 'hotspot', 'loopback')),
  ip_address TEXT NOT NULL,
  mac_address TEXT NOT NULL,
  is_host_detected INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  simulated_down INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 50,
  priority_order INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'healthy',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS network_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interface_id TEXT NOT NULL,
  download_mbps REAL,
  upload_mbps REAL,
  latency_ms REAL,
  jitter_ms REAL,
  packet_loss_pct REAL,
  health_score REAL,
  rx_bytes INTEGER,
  tx_bytes INTEGER,
  probe_source TEXT NOT NULL DEFAULT 'os_nic',
  recorded_at TEXT NOT NULL,
  FOREIGN KEY(interface_id) REFERENCES interfaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_metrics_iface_time ON network_metrics(interface_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS usage_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interface_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  rx_mb REAL NOT NULL DEFAULT 0,
  tx_mb REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(interface_id, date_key),
  FOREIGN KEY(interface_id) REFERENCES interfaces(id) ON DELETE CASCADE
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
