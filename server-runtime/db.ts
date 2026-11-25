import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  DevicePlatform,
  DeviceRecord,
  NetFusionSettings,
  NetworkInterfaceRecord,
  NetworkMetricRecord,
  PairingStatusSummary,
  QosRuleRecord,
  StreamingProfileRecord,
  SystemEventRecord,
  UsageStatRecord,
} from './types.ts';

const SCHEMA_SQL = `
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
`;

export function normalizePairingCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export class NetFusionStore {
  public readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const resolved = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new DatabaseSync(resolved);
    this.db.exec(SCHEMA_SQL);
    this.migrateLegacySchema();
    this.purgeExperimentalDevices();
    this.seedDefaults();
    this.syncHostInterfaces();
  }

  private migrateLegacySchema(): void {
    const cols = this.db.prepare(`PRAGMA table_info(devices)`).all() as Array<{ name: string }>;
    const existing = new Set(cols.map((c) => c.name));

    if (!existing.has('device_model')) {
      this.db.exec(`ALTER TABLE devices ADD COLUMN device_model TEXT NOT NULL DEFAULT 'Unknown'`);
    }
    if (!existing.has('pairing_status')) {
      this.db.exec(
        `ALTER TABLE devices ADD COLUMN pairing_status TEXT NOT NULL DEFAULT 'paired' CHECK(pairing_status IN ('paired', 'pending', 'revoked'))`,
      );
    }
    if (!existing.has('connection_status')) {
      this.db.exec(
        `ALTER TABLE devices ADD COLUMN connection_status TEXT NOT NULL DEFAULT 'connected' CHECK(connection_status IN ('connected', 'disconnected'))`,
      );
    }
    if (!existing.has('app_version')) {
      this.db.exec(`ALTER TABLE devices ADD COLUMN app_version TEXT NOT NULL DEFAULT '1.0.0'`);
    }
  }

  private purgeExperimentalDevices(): void {
    // Remove previously seeded experimental/demo devices so only real paired devices appear
    this.db.prepare(`DELETE FROM devices WHERE id IN ('dev-win-local', 'dev-pixel-9')`).run();
  }

  private seedDefaults(): void {
    const now = new Date().toISOString();
    const envTimeout = Number(process.env.NETFUSION_HEARTBEAT_TIMEOUT_SECONDS || 15);
    const envTtl = Number(process.env.NETFUSION_PAIRING_CODE_TTL_SECONDS || 300);

    const defaultSettings: Record<string, string> = {
      theme: 'system',
      gateway_mode: 'false',
      server_port: '8080',
      lan_only: 'true',
      auto_discovery: 'true',
      monitor_interval_seconds: '3',
      heartbeat_timeout_seconds: String(Number.isFinite(envTimeout) && envTimeout >= 5 ? envTimeout : 15),
      pairing_code_ttl_seconds: String(Number.isFinite(envTtl) && envTtl >= 30 ? envTtl : 300),
      automatic_failover: 'true',
      load_balancing_enabled: 'true',
      load_balancing_algorithm: 'weighted_health',
      bonding_enabled: 'false',
      relay_mode: 'optional',
    };

    const insertSetting = this.db.prepare(
      `INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`,
    );
    for (const [key, val] of Object.entries(defaultSettings)) {
      insertSetting.run(key, val, now);
    }

    const profileCount = this.db.prepare(`SELECT COUNT(*) as c FROM streaming_profiles`).get() as { c: number };
    if (profileCount.c === 0) {
      const insertProfile = this.db.prepare(
        `INSERT INTO streaming_profiles (id, name, description, realtime_priority, gaming_priority, video_priority, normal_priority, background_priority, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertProfile.run(
        'automatic',
        'Automatic Balanced',
        'Prioritizes real-time calls and gaming while distributing video and normal traffic across healthy uplinks.',
        100,
        90,
        70,
        50,
        30,
        1,
      );
      insertProfile.run(
        'gaming',
        'Low-Latency Gaming',
        'Pins P1 gaming flows to the lowest jitter and lowest RTT healthy uplink.',
        95,
        100,
        60,
        45,
        20,
        0,
      );
      insertProfile.run(
        'streaming_4k',
        '4K Media & Live Stream',
        'Allocates highest sustained bandwidth uplinks to P2 video playback and live broadcasts.',
        95,
        80,
        90,
        50,
        25,
        0,
      );
      insertProfile.run(
        'conferencing',
        'Video Conferencing',
        'Reserves primary stable uplink capacity for P0 interactive audio/video calls.',
        100,
        75,
        65,
        40,
        15,
        0,
      );
    }

    const qosCount = this.db.prepare(`SELECT COUNT(*) as c FROM qos_rules`).get() as { c: number };
    if (qosCount.c === 0) {
      const insertRule = this.db.prepare(
        `INSERT INTO qos_rules (id, app_name, match_pattern, tier, priority_weight, preferred_interface_id, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertRule.run('rule-meet', 'Google Meet / Zoom', 'webrtc,zoom,meet', 'P0', 100, 'wan-airtel', 1, now);
      insertRule.run('rule-valorant', 'Online & Cloud Gaming', 'udp:27015,geforce,xbox', 'P1', 90, 'wan-airtel', 1, now);
      insertRule.run('rule-youtube', 'YouTube / OTT 4K', 'youtube,netflix,twitch', 'P2', 70, 'wan-jio', 1, now);
      insertRule.run('rule-browser', 'General Web Browsing', 'https:443', 'P3', 50, null, 1, now);
      insertRule.run('rule-updates', 'OS & Steam Downloads', 'windowsupdate,steamcdn', 'P4', 30, 'wan-wifi', 1, now);
    }

    const ifaceCount = this.db.prepare(`SELECT COUNT(*) as c FROM interfaces`).get() as { c: number };
    if (ifaceCount.c === 0) {
      const insertIface = this.db.prepare(
        `INSERT INTO interfaces (id, system_name, display_name, provider, kind, ip_address, mac_address, is_host_detected, enabled, simulated_down, weight, priority_order, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertIface.run(
        'wan-airtel',
        'Ethernet 2',
        'Airtel Fiber Uplink',
        'Airtel Broadband',
        'ethernet',
        '192.168.10.24',
        '00:1B:44:11:3A:B7',
        0,
        1,
        0,
        85,
        1,
        'healthy',
        now,
      );
      insertIface.run(
        'wan-jio',
        'USB RNDIS',
        'Jio 5G USB Tether',
        'Reliance Jio',
        'cellular_usb',
        '192.168.42.129',
        '02:50:F2:84:19:0C',
        0,
        1,
        0,
        65,
        2,
        'healthy',
        now,
      );
      insertIface.run(
        'wan-wifi',
        'Wi-Fi 6',
        'Mobile Hotspot Wi-Fi',
        'Airtel 5G Hotspot',
        'wifi',
        '172.20.10.4',
        'A4:5E:60:C9:22:18',
        0,
        1,
        0,
        40,
        3,
        'healthy',
        now,
      );
    }

    const bondCount = this.db.prepare(`SELECT COUNT(*) as c FROM bonding_sessions`).get() as { c: number };
    if (bondCount.c === 0) {
      this.db
        .prepare(`INSERT INTO bonding_sessions (id, relay_endpoint, mode, active_paths, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('default', null, 'disabled', 0, 'disabled', now);
    }

    const eventCount = this.db.prepare(`SELECT COUNT(*) as c FROM system_events`).get() as { c: number };
    if (eventCount.c === 0) {
      this.addSystemEvent('info', 'startup', 'NetFusion v0.1 monitoring engine initialized in safe Monitoring Mode.');
      this.addSystemEvent('info', 'discovery', 'Scanned local host network adapters. Real device registry awaiting pairing.');
    }
  }

  public syncHostInterfaces(): void {
    const now = new Date().toISOString();
    const nets = os.networkInterfaces();
    const upsert = this.db.prepare(`
      INSERT INTO interfaces (id, system_name, display_name, provider, kind, ip_address, mac_address, is_host_detected, enabled, simulated_down, weight, priority_order, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 0, ?, ?, 'healthy', ?)
      ON CONFLICT(id) DO UPDATE SET
        ip_address = excluded.ip_address,
        mac_address = excluded.mac_address,
        is_host_detected = 1,
        updated_at = excluded.updated_at
    `);

    let order = 10;
    for (const [name, addrs] of Object.entries(nets)) {
      if (!addrs || name === 'lo') continue;
      const ipv4 = addrs.find((a) => a.family === 'IPv4' && !a.internal);
      if (!ipv4) continue;
      const id = `host-${name.replace(/[^a-zA-Z0-9_-]/g, '')}`;
      const lower = name.toLowerCase();
      const kind: NetworkInterfaceRecord['kind'] =
        lower.includes('wlan') || lower.includes('wi-fi')
          ? 'wifi'
          : lower.includes('usb') || lower.includes('rndis')
            ? 'cellular_usb'
            : 'ethernet';
      upsert.run(
        id,
        name,
        `Host Adapter (${name})`,
        'Detected OS Interface',
        kind,
        ipv4.address,
        ipv4.mac || '00:00:00:00:00:00',
        75,
        order++,
        now,
      );
    }
  }

  // Admin credential management (scrypt + env override)
  public getAdminAuthMode(): { configured_via_env: boolean; claimed: boolean } {
    const envPass = (process.env.NETFUSION_ADMIN_PASSCODE || '').trim();
    if (envPass.length > 0) {
      return { configured_via_env: true, claimed: true };
    }
    const row = this.db.prepare(`SELECT id FROM admin_credentials WHERE id = 1`).get() as { id: number } | undefined;
    return { configured_via_env: false, claimed: Boolean(row) };
  }

  public claimAdminPasscode(passcode: string): void {
    const envPass = (process.env.NETFUSION_ADMIN_PASSCODE || '').trim();
    if (envPass.length > 0) {
      throw new Error('Administrator passcode is configured via environment secret.');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(passcode, salt, 64).toString('hex');
    const now = new Date().toISOString();

    const info = this.db
      .prepare(`INSERT OR IGNORE INTO admin_credentials (id, passcode_hash, salt, updated_at) VALUES (1, ?, ?, ?)`)
      .run(derived, salt, now);

    if (info.changes === 0) {
      throw new Error('Administrator passcode is already configured.');
    }
    this.addSystemEvent('info', 'security', 'Administrator access claimed for local NetFusion device management.');
  }

  public verifyAdminPasscode(passcode: string): boolean {
    const envPass = (process.env.NETFUSION_ADMIN_PASSCODE || '').trim();
    if (envPass.length > 0) {
      const a = crypto.createHash('sha256').update(passcode).digest();
      const b = crypto.createHash('sha256').update(envPass).digest();
      return crypto.timingSafeEqual(a, b);
    }
    const row = this.db
      .prepare(`SELECT passcode_hash, salt FROM admin_credentials WHERE id = 1`)
      .get() as { passcode_hash: string; salt: string } | undefined;
    if (!row) return false;
    const derived = crypto.scryptSync(passcode, row.salt, 64);
    const stored = Buffer.from(row.passcode_hash, 'hex');
    if (derived.length !== stored.length) return false;
    return crypto.timingSafeEqual(derived, stored);
  }

  // Temporary single-use pairing code management
  public generatePairingCode(
    ttlSeconds?: number,
    platformHint: DevicePlatform | 'any' = 'any',
  ): { pairing_code: string; expires_at: string; ttl_seconds: number; code_hint: string } {
    const settings = this.getSettings();
    const ttl = Math.max(30, Math.min(900, ttlSeconds ?? settings.pairing_code_ttl_seconds));
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let raw = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) {
      raw += alphabet[bytes[i] % alphabet.length];
    }
    const formattedCode = `NF-${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
    const normalized = normalizePairingCode(formattedCode);
    const codeHash = crypto.createHash('sha256').update(normalized).digest('hex');
    const codeHint = `NF-****-**${raw.slice(6, 8)}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
    const id = `pc-${crypto.randomBytes(6).toString('hex')}`;

    this.db
      .prepare(
        `INSERT INTO pairing_codes (id, code_hash, code_hint, platform_hint, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, codeHash, codeHint, platformHint, expiresAt, now.toISOString());

    this.addSystemEvent('info', 'pairing', `Generated temporary single-use pairing code (${codeHint}, expires in ${ttl}s).`);
    return { pairing_code: formattedCode, expires_at: expiresAt, ttl_seconds: ttl, code_hint: codeHint };
  }

  public getPairingStatus(): PairingStatusSummary {
    this.evaluateDeviceHeartbeats();
    const nowIso = new Date().toISOString();
    const settings = this.getSettings();

    const activeCodes = this.db
      .prepare(`SELECT code_hint, platform_hint, expires_at FROM pairing_codes WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC`)
      .all(nowIso) as Array<{ code_hint: string; platform_hint: DevicePlatform | 'any'; expires_at: string }>;

    const counts = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN connection_status = 'connected' THEN 1 ELSE 0 END) AS connected,
           SUM(CASE WHEN connection_status = 'disconnected' THEN 1 ELSE 0 END) AS disconnected
         FROM devices WHERE pairing_status = 'paired'`,
      )
      .get() as { total: number; connected: number | null; disconnected: number | null };

    return {
      active_codes: activeCodes.length,
      latest_code_expires_at: activeCodes[0]?.expires_at ?? null,
      latest_code_hint: activeCodes[0]?.code_hint ?? null,
      platform_hint: activeCodes[0]?.platform_hint ?? null,
      registered_devices: counts.total ?? 0,
      connected_devices: counts.connected ?? 0,
      disconnected_devices: counts.disconnected ?? 0,
      heartbeat_timeout_seconds: settings.heartbeat_timeout_seconds,
    };
  }

  public pairDeviceWithCode(input: {
    pairing_code: string;
    device_name: string;
    platform: DevicePlatform;
    device_model: string;
    ip_address: string;
    app_version: string;
  }): { ok: true; device: DeviceRecord; auth_token: string } | { ok: false; reason: 'invalid' | 'expired' | 'used' | 'platform_mismatch' } {
    const normalized = normalizePairingCode(input.pairing_code);
    if (normalized.length < 6) {
      return { ok: false, reason: 'invalid' };
    }
    const codeHash = crypto.createHash('sha256').update(normalized).digest('hex');
    const nowIso = new Date().toISOString();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const codeRow = this.db
        .prepare(`SELECT id, platform_hint, expires_at, used_at FROM pairing_codes WHERE code_hash = ?`)
        .get(codeHash) as
        | { id: string; platform_hint: DevicePlatform | 'any'; expires_at: string; used_at: string | null }
        | undefined;

      if (!codeRow) {
        this.db.exec('ROLLBACK');
        this.addSystemEvent('warning', 'pairing', `Rejected pairing attempt with invalid code from ${input.ip_address}.`);
        return { ok: false, reason: 'invalid' };
      }

      if (codeRow.used_at !== null) {
        this.db.exec('ROLLBACK');
        this.addSystemEvent('warning', 'pairing', `Rejected reuse of already-consumed pairing code from ${input.ip_address}.`);
        return { ok: false, reason: 'used' };
      }

      if (Date.parse(codeRow.expires_at) <= Date.now()) {
        this.db.exec('ROLLBACK');
        this.addSystemEvent('warning', 'pairing', `Rejected expired pairing code from ${input.ip_address}.`);
        return { ok: false, reason: 'expired' };
      }

      if (codeRow.platform_hint !== 'any' && codeRow.platform_hint !== input.platform) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'platform_mismatch' };
      }

      const id = `dev-${crypto.randomBytes(6).toString('hex')}`;
      const authToken = `nf_dev_${crypto.randomBytes(24).toString('hex')}`;
      const tokenHash = crypto.createHash('sha256').update(authToken).digest('hex');

      const consumeResult = this.db
        .prepare(`UPDATE pairing_codes SET used_at = ?, used_by_device_id = ? WHERE id = ? AND used_at IS NULL`)
        .run(nowIso, id, codeRow.id);

      if (consumeResult.changes === 0) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'used' };
      }

      this.db
        .prepare(
          `INSERT INTO devices (id, name, platform, device_model, ip_address, token_hash, pairing_status, connection_status, app_version, status, last_seen_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'paired', 'connected', ?, 'paired', ?, ?)`,
        )
        .run(
          id,
          input.device_name,
          input.platform,
          input.device_model,
          input.ip_address,
          tokenHash,
          input.app_version,
          nowIso,
          nowIso,
        );

      this.db.exec('COMMIT');

      const device = this.db
        .prepare(
          `SELECT id, name, platform, device_model, ip_address, pairing_status, connection_status, app_version, last_seen_at, created_at FROM devices WHERE id = ?`,
        )
        .get(id) as unknown as DeviceRecord;

      this.addSystemEvent(
        'info',
        'pairing',
        `Paired ${input.platform} device "${input.device_name}" (${input.device_model}) at ${input.ip_address}.`,
      );
      return { ok: true, device, auth_token: authToken };
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore rollback error
      }
      throw err;
    }
  }

  public recordDeviceHeartbeat(
    bearerToken: string,
    patch: { ip_address?: string; app_version?: string; device_model?: string },
  ): DeviceRecord | null {
    if (!bearerToken.startsWith('nf_dev_')) return null;
    const tokenHash = crypto.createHash('sha256').update(bearerToken).digest('hex');
    const existing = this.db
      .prepare(
        `SELECT id, name, platform, device_model, ip_address, pairing_status, connection_status, app_version, last_seen_at, created_at
         FROM devices WHERE token_hash = ? AND pairing_status = 'paired'`,
      )
      .get(tokenHash) as unknown as DeviceRecord | undefined;

    if (!existing) return null;

    const nowIso = new Date().toISOString();
    const nextIp = patch.ip_address || existing.ip_address;
    const nextVersion = patch.app_version || existing.app_version;
    const nextModel = patch.device_model || existing.device_model;

    this.db
      .prepare(
        `UPDATE devices SET connection_status = 'connected', last_seen_at = ?, ip_address = ?, app_version = ?, device_model = ? WHERE id = ?`,
      )
      .run(nowIso, nextIp, nextVersion, nextModel, existing.id);

    if (existing.connection_status === 'disconnected') {
      this.addSystemEvent('info', 'device', `${existing.name} (${existing.platform}) reconnected at ${nextIp}.`);
    }

    return this.db
      .prepare(
        `SELECT id, name, platform, device_model, ip_address, pairing_status, connection_status, app_version, last_seen_at, created_at FROM devices WHERE id = ?`,
      )
      .get(existing.id) as unknown as DeviceRecord;
  }

  public evaluateDeviceHeartbeats(): boolean {
    const settings = this.getSettings();
    const cutoffIso = new Date(Date.now() - settings.heartbeat_timeout_seconds * 1000).toISOString();

    const stale = this.db
      .prepare(
        `SELECT id, name, platform FROM devices
         WHERE pairing_status = 'paired' AND connection_status = 'connected' AND last_seen_at < ?`,
      )
      .all(cutoffIso) as Array<{ id: string; name: string; platform: string }>;

    if (stale.length === 0) return false;

    const markStmt = this.db.prepare(`UPDATE devices SET connection_status = 'disconnected' WHERE id = ?`);
    for (const dev of stale) {
      markStmt.run(dev.id);
      this.addSystemEvent(
        'warning',
        'device',
        `${dev.name} (${dev.platform}) heartbeat timed out after ${settings.heartbeat_timeout_seconds}s; marked disconnected.`,
      );
    }
    return true;
  }

  public getClients(): DeviceRecord[] {
    this.evaluateDeviceHeartbeats();
    return this.db
      .prepare(
        `SELECT id, name, platform, device_model, ip_address, pairing_status, connection_status, app_version, last_seen_at, created_at
         FROM devices ORDER BY CASE WHEN connection_status = 'connected' THEN 0 ELSE 1 END, last_seen_at DESC`,
      )
      .all() as unknown as DeviceRecord[];
  }

  public getDeviceCounts(): { total: number; connected: number; disconnected: number } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN connection_status = 'connected' THEN 1 ELSE 0 END) AS connected,
           SUM(CASE WHEN connection_status = 'disconnected' THEN 1 ELSE 0 END) AS disconnected
         FROM devices WHERE pairing_status = 'paired'`,
      )
      .get() as { total: number; connected: number | null; disconnected: number | null };
    return {
      total: row.total ?? 0,
      connected: row.connected ?? 0,
      disconnected: row.disconnected ?? 0,
    };
  }

  public revokeClient(id: string): boolean {
    const existing = this.db.prepare(`SELECT name, platform FROM devices WHERE id = ?`).get(id) as
      | { name: string; platform: string }
      | undefined;
    if (!existing) return false;
    this.db.prepare(`DELETE FROM devices WHERE id = ?`).run(id);
    this.addSystemEvent('warning', 'pairing', `Unpaired and removed ${existing.platform} device "${existing.name}".`);
    return true;
  }

  public addSystemEvent(level: 'info' | 'warning' | 'error', category: string, message: string): void {
    this.db
      .prepare(`INSERT INTO system_events (level, category, message, created_at) VALUES (?, ?, ?, ?)`)
      .run(level, category, message, new Date().toISOString());
    this.db
      .prepare(`DELETE FROM system_events WHERE id NOT IN (SELECT id FROM system_events ORDER BY id DESC LIMIT 120)`)
      .run();
  }

  public getSettings(): NetFusionSettings {
    const rows = this.db.prepare(`SELECT key, value FROM app_settings`).all() as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    return {
      theme: (map.get('theme') as NetFusionSettings['theme']) || 'system',
      gateway_mode: map.get('gateway_mode') === 'true',
      server_port: Number(map.get('server_port') || 8080),
      lan_only: map.get('lan_only') !== 'false',
      auto_discovery: map.get('auto_discovery') !== 'false',
      monitor_interval_seconds: Math.max(1, Math.min(60, Number(map.get('monitor_interval_seconds') || 3))),
      heartbeat_timeout_seconds: Math.max(5, Math.min(300, Number(map.get('heartbeat_timeout_seconds') || 15))),
      pairing_code_ttl_seconds: Math.max(30, Math.min(900, Number(map.get('pairing_code_ttl_seconds') || 300))),
      automatic_failover: map.get('automatic_failover') !== 'false',
      load_balancing_enabled: map.get('load_balancing_enabled') !== 'false',
      load_balancing_algorithm:
        (map.get('load_balancing_algorithm') as NetFusionSettings['load_balancing_algorithm']) || 'weighted_health',
      bonding_enabled: map.get('bonding_enabled') === 'true',
      relay_mode: map.get('relay_mode') || 'optional',
    };
  }

  public updateSettings(patch: Partial<NetFusionSettings>): NetFusionSettings {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) {
        stmt.run(k, String(v), now);
      }
    }
    return this.getSettings();
  }

  public getInterfaces(): NetworkInterfaceRecord[] {
    return this.db
      .prepare(`SELECT * FROM interfaces ORDER BY is_host_detected DESC, priority_order ASC, display_name ASC`)
      .all() as unknown as NetworkInterfaceRecord[];
  }

  public getInterfaceById(id: string): NetworkInterfaceRecord | undefined {
    return this.db.prepare(`SELECT * FROM interfaces WHERE id = ?`).get(id) as unknown as
      | NetworkInterfaceRecord
      | undefined;
  }

  public updateInterface(
    id: string,
    patch: Partial<Pick<NetworkInterfaceRecord, 'enabled' | 'simulated_down' | 'weight' | 'priority_order' | 'status'>>,
  ): NetworkInterfaceRecord | undefined {
    const current = this.getInterfaceById(id);
    if (!current) return undefined;
    const now = new Date().toISOString();
    const nextEnabled = patch.enabled !== undefined ? patch.enabled : current.enabled;
    const nextSimDown = patch.simulated_down !== undefined ? patch.simulated_down : current.simulated_down;
    const nextWeight = patch.weight !== undefined ? patch.weight : current.weight;
    const nextPriority = patch.priority_order !== undefined ? patch.priority_order : current.priority_order;
    const nextStatus = patch.status !== undefined ? patch.status : current.status;

    this.db
      .prepare(
        `UPDATE interfaces SET enabled = ?, simulated_down = ?, weight = ?, priority_order = ?, status = ?, updated_at = ? WHERE id = ?`,
      )
      .run(nextEnabled, nextSimDown, nextWeight, nextPriority, nextStatus, now, id);
    return this.getInterfaceById(id);
  }

  public insertMetric(metric: NetworkMetricRecord): void {
    this.db
      .prepare(
        `INSERT INTO network_metrics (interface_id, download_mbps, upload_mbps, latency_ms, jitter_ms, packet_loss_pct, health_score, rx_bytes, tx_bytes, probe_source, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        metric.interface_id,
        metric.download_mbps,
        metric.upload_mbps,
        metric.latency_ms,
        metric.jitter_ms,
        metric.packet_loss_pct,
        metric.health_score,
        metric.rx_bytes,
        metric.tx_bytes,
        metric.probe_source,
        metric.recorded_at,
      );

    this.db
      .prepare(
        `DELETE FROM network_metrics WHERE interface_id = ? AND id NOT IN (SELECT id FROM network_metrics WHERE interface_id = ? ORDER BY id DESC LIMIT 400)`,
      )
      .run(metric.interface_id, metric.interface_id);

    const dateKey = metric.recorded_at.slice(0, 10);
    const intervalSec = this.getSettings().monitor_interval_seconds;
    const rxMbDelta = (metric.download_mbps * intervalSec) / 8;
    const txMbDelta = (metric.upload_mbps * intervalSec) / 8;
    this.db
      .prepare(
        `INSERT INTO usage_stats (interface_id, date_key, rx_mb, tx_mb, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(interface_id, date_key) DO UPDATE SET
           rx_mb = rx_mb + excluded.rx_mb,
           tx_mb = tx_mb + excluded.tx_mb,
           updated_at = excluded.updated_at`,
      )
      .run(metric.interface_id, dateKey, rxMbDelta, txMbDelta, metric.recorded_at);
  }

  public getLatestMetricPerInterface(): Map<string, NetworkMetricRecord> {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM network_metrics m
         INNER JOIN (
           SELECT interface_id, MAX(id) AS max_id FROM network_metrics GROUP BY interface_id
         ) latest ON m.id = latest.max_id`,
      )
      .all() as unknown as NetworkMetricRecord[];
    return new Map(rows.map((r) => [r.interface_id, r]));
  }

  public getMetricHistory(limitPerInterface = 30): NetworkMetricRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY interface_id ORDER BY id DESC) AS rn
           FROM network_metrics
         ) WHERE rn <= ? ORDER BY id ASC`,
      )
      .all(limitPerInterface) as unknown as NetworkMetricRecord[];
  }

  public getStreamingProfiles(): StreamingProfileRecord[] {
    return this.db.prepare(`SELECT * FROM streaming_profiles ORDER BY is_active DESC, name ASC`).all() as unknown as StreamingProfileRecord[];
  }

  public activateStreamingProfile(profileId: string): StreamingProfileRecord[] {
    const exists = this.db.prepare(`SELECT id, name FROM streaming_profiles WHERE id = ?`).get(profileId) as
      | { id: string; name: string }
      | undefined;
    if (!exists) {
      throw new Error('Streaming profile not found');
    }
    this.db.prepare(`UPDATE streaming_profiles SET is_active = 0`).run();
    this.db.prepare(`UPDATE streaming_profiles SET is_active = 1 WHERE id = ?`).run(profileId);
    this.addSystemEvent('info', 'streaming', `Activated streaming priority profile "${exists.name}".`);
    return this.getStreamingProfiles();
  }

  public getQosRules(): QosRuleRecord[] {
    return this.db
      .prepare(`SELECT * FROM qos_rules ORDER BY priority_weight DESC, created_at ASC`)
      .all() as unknown as QosRuleRecord[];
  }

  public createQosRule(input: {
    app_name: string;
    match_pattern: string;
    tier: QosRuleRecord['tier'];
    preferred_interface_id: string | null;
  }): QosRuleRecord {
    const weights: Record<QosRuleRecord['tier'], number> = {
      P0: 100,
      P1: 90,
      P2: 70,
      P3: 50,
      P4: 30,
    };
    const id = `rule-${crypto.randomBytes(5).toString('hex')}`;
    const now = new Date().toISOString();
    const weight = weights[input.tier];

    this.db
      .prepare(
        `INSERT INTO qos_rules (id, app_name, match_pattern, tier, priority_weight, preferred_interface_id, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(id, input.app_name, input.match_pattern, input.tier, weight, input.preferred_interface_id, now);

    this.addSystemEvent('info', 'qos', `Added ${input.tier} (${weight}/100) traffic rule for ${input.app_name}.`);
    return this.db.prepare(`SELECT * FROM qos_rules WHERE id = ?`).get(id) as unknown as QosRuleRecord;
  }

  public toggleQosRule(id: string, enabled: boolean): QosRuleRecord | undefined {
    const existing = this.db.prepare(`SELECT * FROM qos_rules WHERE id = ?`).get(id) as unknown as QosRuleRecord | undefined;
    if (!existing) return undefined;
    this.db.prepare(`UPDATE qos_rules SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
    return this.db.prepare(`SELECT * FROM qos_rules WHERE id = ?`).get(id) as unknown as QosRuleRecord;
  }

  public deleteQosRule(id: string): boolean {
    const existing = this.db.prepare(`SELECT app_name FROM qos_rules WHERE id = ?`).get(id) as { app_name: string } | undefined;
    if (!existing) return false;
    this.db.prepare(`DELETE FROM qos_rules WHERE id = ?`).run(id);
    this.addSystemEvent('info', 'qos', `Removed QoS rule for ${existing.app_name}.`);
    return true;
  }

  public getUsageStats(): UsageStatRecord[] {
    const today = new Date().toISOString().slice(0, 10);
    return this.db
      .prepare(`SELECT interface_id, date_key, rx_mb, tx_mb, updated_at FROM usage_stats WHERE date_key = ? ORDER BY rx_mb DESC`)
      .all(today) as unknown as UsageStatRecord[];
  }

  public getSystemEvents(limit = 40): SystemEventRecord[] {
    return this.db
      .prepare(`SELECT * FROM system_events ORDER BY id DESC LIMIT ?`)
      .all(limit) as unknown as SystemEventRecord[];
  }
}
