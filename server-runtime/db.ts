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
`;

export function normalizePairingSecret(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function readOsLinkOperState(ifaceName: string): boolean {
  try {
    const state = fs.readFileSync(`/sys/class/net/${path.basename(ifaceName)}/operstate`, 'utf8').trim();
    return state === 'up' || state === 'unknown';
  } catch {
    return true;
  }
}

export class NetFusionStore {
  public readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const resolved = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new DatabaseSync(resolved);
    this.db.exec(SCHEMA_SQL);
    this.migrateLegacySchema();
    this.purgeMockAndExperimentalData();
    this.seedDefaults();
    this.syncHostInterfaces();
  }

  private migrateLegacySchema(): void {
    const deviceCols = this.db.prepare(`PRAGMA table_info(devices)`).all() as Array<{ name: string }>;
    const existingDevice = new Set(deviceCols.map((c) => c.name));

    if (!existingDevice.has('device_model')) {
      this.db.exec(`ALTER TABLE devices ADD COLUMN device_model TEXT NOT NULL DEFAULT 'Unknown'`);
    }
    if (!existingDevice.has('pairing_status')) {
      this.db.exec(
        `ALTER TABLE devices ADD COLUMN pairing_status TEXT NOT NULL DEFAULT 'paired' CHECK(pairing_status IN ('paired', 'pending', 'revoked'))`,
      );
    }
    if (!existingDevice.has('connection_status')) {
      this.db.exec(
        `ALTER TABLE devices ADD COLUMN connection_status TEXT NOT NULL DEFAULT 'disconnected' CHECK(connection_status IN ('connected', 'disconnected'))`,
      );
    }
    if (!existingDevice.has('app_version')) {
      this.db.exec(`ALTER TABLE devices ADD COLUMN app_version TEXT NOT NULL DEFAULT '1.0.0'`);
    }
    if (!existingDevice.has('rx_bytes')) {
      this.db.exec(`ALTER TABLE devices ADD COLUMN rx_bytes INTEGER`);
    }
    if (!existingDevice.has('tx_bytes')) {
      this.db.exec(`ALTER TABLE devices ADD COLUMN tx_bytes INTEGER`);
    }
    if (!existingDevice.has('download_bps')) {
      this.db.exec(`ALTER TABLE devices ADD COLUMN download_bps REAL`);
    }
    if (!existingDevice.has('upload_bps')) {
      this.db.exec(`ALTER TABLE devices ADD COLUMN upload_bps REAL`);
    }

    const metricCols = this.db.prepare(`PRAGMA table_info(network_metrics)`).all() as Array<{
      name: string;
      notnull: number;
    }>;
    const nullableMetricCols = new Set([
      'download_mbps',
      'upload_mbps',
      'latency_ms',
      'jitter_ms',
      'packet_loss_pct',
      'health_score',
    ]);
    const needsMetricMigration = metricCols.some((c) => nullableMetricCols.has(c.name) && c.notnull === 1);
    if (needsMetricMigration) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE network_metrics RENAME TO network_metrics_legacy;
        CREATE TABLE network_metrics (
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
        INSERT INTO network_metrics (id, interface_id, download_mbps, upload_mbps, latency_ms, jitter_ms, packet_loss_pct, health_score, rx_bytes, tx_bytes, probe_source, recorded_at)
        SELECT id, interface_id, download_mbps, upload_mbps, latency_ms, jitter_ms, packet_loss_pct, health_score, rx_bytes, tx_bytes, probe_source, recorded_at
        FROM network_metrics_legacy;
        DROP TABLE network_metrics_legacy;
        CREATE INDEX IF NOT EXISTS idx_metrics_iface_time ON network_metrics(interface_id, recorded_at DESC);
        COMMIT;
      `);
    }
  }

  private purgeMockAndExperimentalData(): void {
    // Remove legacy experimental devices and seeded mock WAN interfaces
    this.db.prepare(`DELETE FROM devices WHERE id IN ('dev-win-local', 'dev-pixel-9')`).run();
    this.db.prepare(`DELETE FROM interfaces WHERE is_host_detected = 0 OR id IN ('wan-airtel', 'wan-jio', 'wan-wifi')`).run();
    // Remove legacy simulated failover/mock WAN event messages
    this.db
      .prepare(
        `DELETE FROM system_events WHERE category = 'failover' OR message LIKE '%Airtel%' OR message LIKE '%Jio%' OR message LIKE '%Mobile Hotspot%'`,
      )
      .run();
    // Ensure old simulated_down flags are cleared
    this.db.prepare(`UPDATE interfaces SET simulated_down = 0 WHERE simulated_down != 0`).run();
  }

  private seedDefaults(): void {
    const now = new Date().toISOString();
    const envTimeout = Number(process.env.NETFUSION_HEARTBEAT_TIMEOUT_SECONDS || 15);
    const envTtl = Number(process.env.NETFUSION_PAIRING_CODE_TTL_SECONDS || 120);

    const defaultSettings: Record<string, string> = {
      theme: 'system',
      server_port: '8080',
      lan_only: 'true',
      auto_discovery: 'true',
      monitor_interval_seconds: '3',
      heartbeat_timeout_seconds: String(Number.isFinite(envTimeout) && envTimeout >= 5 ? envTimeout : 15),
      pairing_code_ttl_seconds: String(Number.isFinite(envTtl) && envTtl >= 30 ? envTtl : 120),
    };

    const insertSetting = this.db.prepare(
      `INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`,
    );
    for (const [key, val] of Object.entries(defaultSettings)) {
      insertSetting.run(key, val, now);
    }

    // Upgrade legacy 300s default to 120s (2-minute QR expiration requirement)
    this.db
      .prepare(`UPDATE app_settings SET value = '120', updated_at = ? WHERE key = 'pairing_code_ttl_seconds' AND value = '300'`)
      .run(now);

    const eventCount = this.db.prepare(`SELECT COUNT(*) as c FROM system_events`).get() as { c: number };
    if (eventCount.c === 0) {
      this.addSystemEvent('info', 'startup', 'NetFusion server initialized using real OS network interfaces.');
    }
  }

  public syncHostInterfaces(): void {
    const now = new Date().toISOString();
    const nets = os.networkInterfaces();
    const seenIds = new Set<string>();

    const upsert = this.db.prepare(`
      INSERT INTO interfaces (id, system_name, display_name, provider, kind, ip_address, mac_address, is_host_detected, enabled, simulated_down, weight, priority_order, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 0, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        ip_address = excluded.ip_address,
        mac_address = excluded.mac_address,
        is_host_detected = 1,
        simulated_down = 0,
        status = excluded.status,
        updated_at = excluded.updated_at
    `);

    let order = 1;
    for (const [name, addrs] of Object.entries(nets)) {
      if (!addrs || name === 'lo') continue;
      const ipv4 = addrs.find((a) => a.family === 'IPv4' && !a.internal);
      if (!ipv4) continue;
      const id = `host-${name.replace(/[^a-zA-Z0-9_-]/g, '')}`;
      seenIds.add(id);
      const lower = name.toLowerCase();
      const kind: NetworkInterfaceRecord['kind'] =
        lower.includes('wlan') || lower.includes('wi-fi') || lower.includes('wifi')
          ? 'wifi'
          : lower.includes('usb') || lower.includes('rndis') || lower.includes('wwan')
            ? 'cellular_usb'
            : 'ethernet';
      const osUp = readOsLinkOperState(name);
      upsert.run(
        id,
        name,
        name,
        'Operating System Interface',
        kind,
        ipv4.address,
        ipv4.mac || '00:00:00:00:00:00',
        50,
        order++,
        osUp ? 'healthy' : 'offline',
        now,
      );
    }

    // Remove OS interfaces that are no longer present in os.networkInterfaces()
    const existingRows = this.db.prepare(`SELECT id FROM interfaces`).all() as Array<{ id: string }>;
    for (const row of existingRows) {
      if (!seenIds.has(row.id)) {
        this.db.prepare(`DELETE FROM interfaces WHERE id = ?`).run(row.id);
      }
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
    this.addSystemEvent('info', 'security', 'Administrator password configured for device management.');
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

  // Cryptographically secure, single-use, 2-minute expiring QR pairing session
  public generatePairingCode(
    ttlSeconds?: number,
    platformHint: DevicePlatform | 'any' = 'any',
  ): {
    pairing_id: string;
    pairing_code: string;
    secret: string;
    expires_at: string;
    ttl_seconds: number;
    code_hint: string;
  } {
    const settings = this.getSettings();
    const ttl = Math.max(30, Math.min(600, ttlSeconds ?? settings.pairing_code_ttl_seconds));
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(12);
    let raw = '';
    for (let i = 0; i < 12; i++) {
      raw += alphabet[bytes[i] % alphabet.length];
    }
    const formattedCode = `NF-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
    const normalized = normalizePairingSecret(formattedCode);
    const codeHash = crypto.createHash('sha256').update(normalized).digest('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
    const id = `pc-${crypto.randomBytes(8).toString('hex')}`;
    const codeHint = id;

    this.db
      .prepare(
        `INSERT INTO pairing_codes (id, code_hash, code_hint, platform_hint, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, codeHash, codeHint, platformHint, expiresAt, now.toISOString());

    // Never log pairing secret or partial characters
    this.addSystemEvent('info', 'pairing', `Created QR pairing session ${id} (expires in ${ttl}s).`);
    return {
      pairing_id: id,
      pairing_code: formattedCode,
      secret: formattedCode,
      expires_at: expiresAt,
      ttl_seconds: ttl,
      code_hint: codeHint,
    };
  }

  public getPairingStatus(): PairingStatusSummary {
    this.evaluateDeviceHeartbeats();
    const nowIso = new Date().toISOString();
    const settings = this.getSettings();

    const activeCodes = this.db
      .prepare(
        `SELECT id, code_hint, platform_hint, expires_at
         FROM pairing_codes WHERE used_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC`,
      )
      .all(nowIso) as Array<{
      id: string;
      code_hint: string;
      platform_hint: DevicePlatform | 'any';
      expires_at: string;
    }>;

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
      latest_pairing_id: activeCodes[0]?.id ?? null,
      latest_code_hint: activeCodes[0]?.code_hint ?? null,
      platform_hint: activeCodes[0]?.platform_hint ?? null,
      registered_devices: counts.total ?? 0,
      connected_devices: counts.connected ?? 0,
      disconnected_devices: counts.disconnected ?? 0,
      heartbeat_timeout_seconds: settings.heartbeat_timeout_seconds,
    };
  }

  public pairDeviceWithCode(input: {
    pairing_id?: string;
    pairing_code: string;
    device_name: string;
    platform: DevicePlatform;
    device_model: string;
    ip_address: string;
    app_version: string;
  }):
    | { ok: true; device: DeviceRecord; auth_token: string }
    | { ok: false; reason: 'invalid' | 'expired' | 'used' | 'platform_mismatch' } {
    const normalized = normalizePairingSecret(input.pairing_code);
    if (normalized.length < 6) {
      return { ok: false, reason: 'invalid' };
    }
    const providedHashHex = crypto.createHash('sha256').update(normalized).digest('hex');
    const nowIso = new Date().toISOString();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const codeRow = input.pairing_id
        ? (this.db
            .prepare(`SELECT id, code_hash, platform_hint, expires_at, used_at FROM pairing_codes WHERE id = ?`)
            .get(input.pairing_id) as
            | {
                id: string;
                code_hash: string;
                platform_hint: DevicePlatform | 'any';
                expires_at: string;
                used_at: string | null;
              }
            | undefined)
        : (this.db
            .prepare(`SELECT id, code_hash, platform_hint, expires_at, used_at FROM pairing_codes WHERE code_hash = ?`)
            .get(providedHashHex) as
            | {
                id: string;
                code_hash: string;
                platform_hint: DevicePlatform | 'any';
                expires_at: string;
                used_at: string | null;
              }
            | undefined);

      if (!codeRow) {
        this.db.exec('ROLLBACK');
        this.addSystemEvent('warning', 'pairing', `Rejected pairing attempt with invalid QR/code from ${input.ip_address}.`);
        return { ok: false, reason: 'invalid' };
      }

      // Constant-time verification against stored SHA-256 secret hash
      const a = Buffer.from(codeRow.code_hash, 'hex');
      const b = Buffer.from(providedHashHex, 'hex');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        this.db.exec('ROLLBACK');
        this.addSystemEvent('warning', 'pairing', `Rejected pairing attempt with mismatched secret from ${input.ip_address}.`);
        return { ok: false, reason: 'invalid' };
      }

      if (codeRow.used_at !== null) {
        this.db.exec('ROLLBACK');
        this.addSystemEvent('warning', 'pairing', `Rejected reuse of already-used pairing session ${codeRow.id}.`);
        return { ok: false, reason: 'used' };
      }

      if (Date.parse(codeRow.expires_at) <= Date.now()) {
        this.db.exec('ROLLBACK');
        this.addSystemEvent('warning', 'pairing', `Rejected expired pairing session ${codeRow.id}.`);
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

      // Pairing and live connectivity are separate: starts 'disconnected' until first live heartbeat arrives
      this.db
        .prepare(
          `INSERT INTO devices (id, name, platform, device_model, ip_address, token_hash, pairing_status, connection_status, app_version, rx_bytes, tx_bytes, download_bps, upload_bps, status, last_seen_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'paired', 'disconnected', ?, NULL, NULL, NULL, NULL, 'paired', ?, ?)`,
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
          `SELECT id, name, platform, device_model, ip_address, pairing_status, connection_status, app_version, rx_bytes, tx_bytes, download_bps, upload_bps, last_seen_at, created_at FROM devices WHERE id = ?`,
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
        // Ignore rollback failure
      }
      throw err;
    }
  }

  public recordDeviceHeartbeat(
    bearerToken: string,
    patch: {
      ip_address?: string;
      app_version?: string;
      device_model?: string;
      rx_bytes?: number | null;
      tx_bytes?: number | null;
      download_bps?: number | null;
      upload_bps?: number | null;
    },
  ): DeviceRecord | null {
    if (!bearerToken.startsWith('nf_dev_')) return null;
    const tokenHash = crypto.createHash('sha256').update(bearerToken).digest('hex');
    const existing = this.db
      .prepare(
        `SELECT id, name, platform, device_model, ip_address, pairing_status, connection_status, app_version, rx_bytes, tx_bytes, download_bps, upload_bps, last_seen_at, created_at
         FROM devices WHERE token_hash = ? AND pairing_status = 'paired'`,
      )
      .get(tokenHash) as unknown as DeviceRecord | undefined;

    if (!existing) return null;

    const nowIso = new Date().toISOString();
    const nextIp = patch.ip_address || existing.ip_address;
    const nextVersion = patch.app_version || existing.app_version;
    const nextModel = patch.device_model || existing.device_model;
    const nextRx = patch.rx_bytes !== undefined ? patch.rx_bytes : existing.rx_bytes;
    const nextTx = patch.tx_bytes !== undefined ? patch.tx_bytes : existing.tx_bytes;
    const nextDownBps = patch.download_bps !== undefined ? patch.download_bps : existing.download_bps;
    const nextUpBps = patch.upload_bps !== undefined ? patch.upload_bps : existing.upload_bps;

    this.db
      .prepare(
        `UPDATE devices
         SET connection_status = 'connected', last_seen_at = ?, ip_address = ?, app_version = ?, device_model = ?,
             rx_bytes = ?, tx_bytes = ?, download_bps = ?, upload_bps = ?
         WHERE id = ?`,
      )
      .run(nowIso, nextIp, nextVersion, nextModel, nextRx, nextTx, nextDownBps, nextUpBps, existing.id);

    if (existing.connection_status === 'disconnected') {
      this.addSystemEvent('info', 'device', `${existing.name} (${existing.platform}) connected at ${nextIp}.`);
    }

    return this.db
      .prepare(
        `SELECT id, name, platform, device_model, ip_address, pairing_status, connection_status, app_version, rx_bytes, tx_bytes, download_bps, upload_bps, last_seen_at, created_at
         FROM devices WHERE id = ?`,
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
        `SELECT id, name, platform, device_model, ip_address, pairing_status, connection_status, app_version, rx_bytes, tx_bytes, download_bps, upload_bps, last_seen_at, created_at
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
    this.addSystemEvent('warning', 'pairing', `Removed ${existing.platform} device "${existing.name}".`);
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
      server_port: Number(map.get('server_port') || 8080),
      lan_only: map.get('lan_only') !== 'false',
      auto_discovery: map.get('auto_discovery') !== 'false',
      monitor_interval_seconds: Math.max(1, Math.min(60, Number(map.get('monitor_interval_seconds') || 3))),
      heartbeat_timeout_seconds: Math.max(5, Math.min(300, Number(map.get('heartbeat_timeout_seconds') || 15))),
      pairing_code_ttl_seconds: Math.max(30, Math.min(600, Number(map.get('pairing_code_ttl_seconds') || 120))),
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
      .prepare(
        `SELECT id, system_name, display_name, provider, kind, ip_address, mac_address, is_host_detected, enabled, weight, priority_order, status, updated_at
         FROM interfaces ORDER BY priority_order ASC, display_name ASC`,
      )
      .all() as unknown as NetworkInterfaceRecord[];
  }

  public getInterfaceById(id: string): NetworkInterfaceRecord | undefined {
    return this.db
      .prepare(
        `SELECT id, system_name, display_name, provider, kind, ip_address, mac_address, is_host_detected, enabled, weight, priority_order, status, updated_at
         FROM interfaces WHERE id = ?`,
      )
      .get(id) as unknown as NetworkInterfaceRecord | undefined;
  }

  public updateInterfaceStatus(id: string, status: NetworkInterfaceRecord['status']): void {
    this.db
      .prepare(`UPDATE interfaces SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, new Date().toISOString(), id);
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
        `DELETE FROM network_metrics WHERE interface_id = ? AND id NOT IN (SELECT id FROM network_metrics WHERE interface_id = ? ORDER BY id DESC LIMIT 200)`,
      )
      .run(metric.interface_id, metric.interface_id);

    if (metric.download_mbps !== null && metric.upload_mbps !== null) {
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
  }

  public getLatestMetricPerInterface(): Map<string, NetworkMetricRecord> {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM network_metrics m
         INNER JOIN (
           SELECT interface_id, MAX(id) AS max_id FROM network_metrics GROUP BY interface_id
         ) latest ON m.id = latest.max_id`,
      )
      .all() as unknown as Array<Omit<NetworkMetricRecord, 'metrics_available'>>;
    return new Map(
      rows.map((r) => [
        r.interface_id,
        {
          ...r,
          metrics_available: r.download_mbps !== null && r.upload_mbps !== null,
        },
      ]),
    );
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
