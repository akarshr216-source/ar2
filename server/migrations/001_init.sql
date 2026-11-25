-- NetFusion v0.1 SQLite Schema
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
  connection_status TEXT NOT NULL DEFAULT 'connected' CHECK(connection_status IN ('connected', 'disconnected')),
  app_version TEXT NOT NULL DEFAULT '1.0.0',
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
  is_host_detected INTEGER NOT NULL DEFAULT 0,
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
  download_mbps REAL NOT NULL,
  upload_mbps REAL NOT NULL,
  latency_ms REAL NOT NULL,
  jitter_ms REAL NOT NULL,
  packet_loss_pct REAL NOT NULL,
  health_score REAL NOT NULL,
  rx_bytes INTEGER NOT NULL DEFAULT 0,
  tx_bytes INTEGER NOT NULL DEFAULT 0,
  probe_source TEXT NOT NULL DEFAULT 'tcp_probe',
  recorded_at TEXT NOT NULL,
  FOREIGN KEY(interface_id) REFERENCES interfaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_metrics_iface_time ON network_metrics(interface_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS streaming_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  realtime_priority INTEGER NOT NULL,
  gaming_priority INTEGER NOT NULL,
  video_priority INTEGER NOT NULL,
  normal_priority INTEGER NOT NULL,
  background_priority INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS qos_rules (
  id TEXT PRIMARY KEY,
  app_name TEXT NOT NULL,
  match_pattern TEXT NOT NULL,
  tier TEXT NOT NULL CHECK(tier IN ('P0', 'P1', 'P2', 'P3', 'P4')),
  priority_weight INTEGER NOT NULL,
  preferred_interface_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bonding_sessions (
  id TEXT PRIMARY KEY,
  relay_endpoint TEXT,
  mode TEXT NOT NULL DEFAULT 'disabled',
  active_paths INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'disabled',
  updated_at TEXT NOT NULL
);

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
