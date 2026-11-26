import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import express, { type NextFunction, type Request, type Response } from 'express';
import { NetFusionStore } from './db.ts';
import { NetworkMonitor } from './network-monitor.ts';
import type { DevicePlatform, NetFusionSettings } from './types.ts';

function getLanIPv4Addresses(): string[] {
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const addrs of Object.values(nets)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  return ips;
}

function normalizeClientIp(req: Request, bodyIp?: unknown): string {
  if (typeof bodyIp === 'string' && bodyIp.trim().length > 0 && bodyIp.trim().length <= 45) {
    return bodyIp.trim();
  }
  const raw = req.ip || req.socket.remoteAddress || '0.0.0.0';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

function extractRemoteSocketIp(req: Request): string {
  const raw = req.socket.remoteAddress || req.ip || '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

export function isLocalOrLanAddress(ip: string): boolean {
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    return false;
  }
  const lower = ip.toLowerCase();
  return lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd');
}

function extractBearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

class SlidingAttemptLimiter {
  private readonly attempts = new Map<string, number[]>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;

  constructor(maxAttempts = 5, windowMs = 5 * 60 * 1000) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
  }

  public isBlocked(key: string): { blocked: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const list = (this.attempts.get(key) ?? []).filter((ts) => now - ts < this.windowMs);
    this.attempts.set(key, list);
    if (list.length >= this.maxAttempts) {
      const oldest = list[0];
      const retryAfterSeconds = Math.max(1, Math.ceil((this.windowMs - (now - oldest)) / 1000));
      return { blocked: true, retryAfterSeconds };
    }
    return { blocked: false, retryAfterSeconds: 0 };
  }

  public recordFailure(key: string): void {
    const now = Date.now();
    const list = (this.attempts.get(key) ?? []).filter((ts) => now - ts < this.windowMs);
    list.push(now);
    this.attempts.set(key, list);
  }

  public clear(key: string): void {
    this.attempts.delete(key);
  }
}

export interface NetFusionAppInstance {
  app: express.Express;
  store: NetFusionStore;
  monitor: NetworkMonitor;
  close: () => void;
}

export function createNetFusionApp(options?: { dbPath?: string; startMonitor?: boolean }): NetFusionAppInstance {
  const dbPath = options?.dbPath || process.env.NETFUSION_DB_PATH || './data/netfusion.db';
  const store = new NetFusionStore(dbPath);
  const monitor = new NetworkMonitor(store);
  if (options?.startMonitor !== false) {
    monitor.start();
  }

  const adminSessions = new Map<string, number>();
  const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
  const pairLimiter = new SlidingAttemptLimiter(5, 5 * 60 * 1000);
  const adminLoginLimiter = new SlidingAttemptLimiter(5, 5 * 60 * 1000);

  const isAdminSessionValid = (token: string | null): boolean => {
    if (!token) return false;
    const expiresAt = adminSessions.get(token);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
      adminSessions.delete(token);
      return false;
    }
    return true;
  };

  const issueAdminSession = (): { admin_token: string; expires_at: string } => {
    const token = `nf_adm_${crypto.randomBytes(24).toString('hex')}`;
    const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
    adminSessions.set(token, expiresAt);
    return { admin_token: token, expires_at: new Date(expiresAt).toISOString() };
  };

  const requireLanAdminAccess = (req: Request, res: Response, next: NextFunction): void => {
    const settings = store.getSettings();
    if (settings.lan_only) {
      const remoteIp = extractRemoteSocketIp(req);
      if (!isLocalOrLanAddress(remoteIp)) {
        res.status(403).json({
          error: 'Administration endpoints are restricted to the local PC and local Wi-Fi network.',
        });
        return;
      }
    }
    next();
  };

  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    const token = extractBearerToken(req);
    if (!isAdminSessionValid(token)) {
      res.status(401).json({ error: 'Administrator password required for device management.' });
      return;
    }
    next();
  };

  const app = express();
  app.use(express.json({ limit: '128kb' }));

  app.get('/api/health', (_req, res) => {
    const settings = store.getSettings();
    res.json({
      status: 'ok',
      application: 'NetFusion',
      version: '0.2.0',
      server_port: settings.server_port,
      lan_addresses: getLanIPv4Addresses(),
      uptime_seconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // Administrator Auth Endpoints (protected against public internet & brute force)
  app.get('/api/admin/status', requireLanAdminAccess, (req, res) => {
    const authMode = store.getAdminAuthMode();
    const token = extractBearerToken(req);
    res.json({
      configured_via_env: authMode.configured_via_env,
      claimed: authMode.claimed,
      authenticated: isAdminSessionValid(token),
    });
  });

  app.post('/api/admin/claim', requireLanAdminAccess, (req, res) => {
    const body = req.body as Record<string, unknown>;
    const passcode = typeof body.passcode === 'string' ? body.passcode.trim() : '';
    if (passcode.length < 6 || passcode.length > 128) {
      res.status(400).json({ error: 'Password must be between 6 and 128 characters.' });
      return;
    }
    try {
      store.claimAdminPasscode(passcode);
      const session = issueAdminSession();
      res.status(201).json(session);
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : 'Admin already configured.' });
    }
  });

  app.post('/api/admin/login', requireLanAdminAccess, (req, res) => {
    const limiterKey = extractRemoteSocketIp(req);
    const rate = adminLoginLimiter.isBlocked(limiterKey);
    if (rate.blocked) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      res.status(429).json({
        error: `Too many failed login attempts. Try again in ${rate.retryAfterSeconds} seconds.`,
      });
      return;
    }

    const authMode = store.getAdminAuthMode();
    if (!authMode.claimed) {
      res.status(409).json({ error: 'Administrator password not configured yet.' });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const passcode = typeof body.passcode === 'string' ? body.passcode.trim() : '';
    if (!passcode || !store.verifyAdminPasscode(passcode)) {
      adminLoginLimiter.recordFailure(limiterKey);
      res.status(401).json({ error: 'Incorrect administrator password.' });
      return;
    }

    adminLoginLimiter.clear(limiterKey);
    const session = issueAdminSession();
    res.json(session);
  });

  app.post('/api/admin/logout', requireLanAdminAccess, (req, res) => {
    const token = extractBearerToken(req);
    if (token) {
      adminSessions.delete(token);
    }
    res.json({ ok: true });
  });

  // Protected QR Pairing & Device Registry Endpoints
  app.post('/api/pairing/generate', requireLanAdminAccess, requireAdmin, (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const ttl =
      typeof body.ttl_seconds === 'number' && Number.isFinite(body.ttl_seconds)
        ? body.ttl_seconds
        : 120;
    const platformHint =
      body.platform_hint === 'android' || body.platform_hint === 'windows' || body.platform_hint === 'any'
        ? body.platform_hint
        : 'any';

    const generated = store.generatePairingCode(ttl, platformHint);
    const lanAddresses = getLanIPv4Addresses();
    const settings = store.getSettings();
    const requestedServerUrl =
      typeof body.server_url === 'string' && /^https?:\/\/[^/\s]+/i.test(body.server_url.trim())
        ? body.server_url.trim().replace(/\/+$/, '')
        : lanAddresses.length > 0
          ? `http://${lanAddresses[0]}:${settings.server_port}`
          : '';

    const qrPayload = requestedServerUrl
      ? `netfusion://pair?server=${encodeURIComponent(requestedServerUrl)}&pairing_id=${encodeURIComponent(generated.pairing_id)}&secret=${encodeURIComponent(generated.secret)}`
      : '';

    res.status(201).json({
      ...generated,
      platform_hint: platformHint,
      lan_addresses: lanAddresses,
      qr_payload: qrPayload,
    });
  });

  app.get('/api/pairing/status', requireLanAdminAccess, requireAdmin, (_req, res) => {
    res.json(store.getPairingStatus());
  });

  app.get('/api/clients', requireLanAdminAccess, requireAdmin, (_req, res) => {
    res.json({
      clients: store.getClients(),
      heartbeat_timeout_seconds: store.getSettings().heartbeat_timeout_seconds,
    });
  });

  app.delete('/api/clients/:id', requireLanAdminAccess, requireAdmin, (req, res) => {
    const ok = store.revokeClient(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    monitor.notifyDeviceChange();
    res.json({ clients: store.getClients() });
  });

  // Client Registration & Heartbeat Endpoints (Rate-limited against guessing)
  app.post('/api/clients/pair', (req, res) => {
    const limiterKey = extractRemoteSocketIp(req);
    const rate = pairLimiter.isBlocked(limiterKey);
    if (rate.blocked) {
      res.setHeader('Retry-After', String(rate.retryAfterSeconds));
      res.status(429).json({
        error: `Too many failed pairing attempts. Try again in ${rate.retryAfterSeconds} seconds.`,
        reason: 'rate_limited',
      });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const pairingId = typeof body.pairing_id === 'string' ? body.pairing_id.trim() : undefined;
    const rawSecret =
      typeof body.secret === 'string' && body.secret.trim()
        ? body.secret.trim()
        : typeof body.pairing_code === 'string'
          ? body.pairing_code.trim()
          : '';
    const deviceName = typeof body.device_name === 'string' ? body.device_name.trim() : '';
    const platform: DevicePlatform | null =
      body.platform === 'android' || body.platform === 'windows' ? body.platform : null;
    const deviceModel =
      typeof body.device_model === 'string' && body.device_model.trim()
        ? body.device_model.trim().slice(0, 64)
        : 'Unknown';
    const appVersion =
      typeof body.app_version === 'string' && body.app_version.trim()
        ? body.app_version.trim().slice(0, 24)
        : '1.0.0';
    const ipAddress = normalizeClientIp(req, body.ip_address);

    if (!rawSecret) {
      pairLimiter.recordFailure(limiterKey);
      res.status(401).json({
        error: 'A valid single-use pairing QR code or secret is required.',
        reason: 'invalid',
      });
      return;
    }
    if (!deviceName || deviceName.length > 64 || !platform) {
      res.status(400).json({ error: 'Valid device_name and platform (android|windows) are required.' });
      return;
    }

    const result = store.pairDeviceWithCode({
      pairing_id: pairingId,
      pairing_code: rawSecret,
      device_name: deviceName,
      platform,
      device_model: deviceModel,
      ip_address: ipAddress,
      app_version: appVersion,
    });

    if (!result.ok) {
      pairLimiter.recordFailure(limiterKey);
      const messages: Record<typeof result.reason, string> = {
        invalid: 'Invalid QR code or pairing secret.',
        expired: 'Pairing QR code has expired. Generate a new code on the NetFusion dashboard.',
        used: 'This pairing QR code has already been used.',
        platform_mismatch: 'Pairing code is restricted to a different device platform.',
      };
      res.status(401).json({ error: messages[result.reason], reason: result.reason });
      return;
    }

    pairLimiter.clear(limiterKey);
    monitor.notifyDeviceChange();
    res.status(201).json({
      device: result.device,
      auth_token: result.auth_token,
      heartbeat_interval_seconds: Math.max(
        3,
        Math.floor(store.getSettings().heartbeat_timeout_seconds / 3),
      ),
    });
  });

  app.post('/api/clients/heartbeat', (req, res) => {
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'Device authentication token required.' });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;
    const toNonNegNumberOrUndefined = (val: unknown): number | undefined =>
      typeof val === 'number' && Number.isFinite(val) && val >= 0 ? val : undefined;

    const updated = store.recordDeviceHeartbeat(token, {
      ip_address:
        typeof body.ip_address === 'string' && body.ip_address.trim()
          ? body.ip_address.trim().slice(0, 45)
          : normalizeClientIp(req),
      app_version:
        typeof body.app_version === 'string' && body.app_version.trim()
          ? body.app_version.trim().slice(0, 24)
          : undefined,
      device_model:
        typeof body.device_model === 'string' && body.device_model.trim()
          ? body.device_model.trim().slice(0, 64)
          : undefined,
      rx_bytes: toNonNegNumberOrUndefined(body.rx_bytes),
      tx_bytes: toNonNegNumberOrUndefined(body.tx_bytes),
      download_bps: toNonNegNumberOrUndefined(body.download_bps),
      upload_bps: toNonNegNumberOrUndefined(body.upload_bps),
    });

    if (!updated) {
      res.status(401).json({ error: 'Invalid or revoked device authentication token.' });
      return;
    }

    monitor.notifyDeviceChange();
    res.json({
      status: 'ok',
      device: updated,
      server_time: new Date().toISOString(),
    });
  });

  // Real Host Network Interfaces & Internet Check Endpoints
  app.get('/api/interfaces', (_req, res) => {
    const snapshot = monitor.getSnapshot();
    res.json({ interfaces: snapshot.interfaces, timestamp: snapshot.timestamp });
  });

  app.post('/api/network/check', async (_req, res) => {
    const cloudflareMs = await monitor.probeHostTcp('1.1.1.1', 443);
    const googleMs = await monitor.probeHostTcp('8.8.8.8', 443);
    store.addSystemEvent(
      cloudflareMs !== null || googleMs !== null ? 'info' : 'warning',
      'network',
      `Internet check: 1.1.1.1=${cloudflareMs !== null ? `${cloudflareMs}ms` : 'unreachable'}, 8.8.8.8=${googleMs !== null ? `${googleMs}ms` : 'unreachable'}.`,
    );
    const snapshot = await monitor.runCycle();
    res.json({
      probe: {
        cloudflare_ms: cloudflareMs,
        google_dns_ms: googleMs,
      },
      snapshot,
    });
  });

  app.get('/api/metrics', (_req, res) => {
    res.json(monitor.getSnapshot());
  });

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (payload: unknown) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    send(monitor.getSnapshot());
    const unsubscribe = monitor.subscribe((snapshot) => {
      send(snapshot);
    });

    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  app.get('/api/settings', requireLanAdminAccess, (_req, res) => {
    res.json({ settings: store.getSettings() });
  });

  app.put('/api/settings', requireLanAdminAccess, (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const patch: Partial<NetFusionSettings> = {};

    if (body.theme === 'light' || body.theme === 'dark' || body.theme === 'system') {
      patch.theme = body.theme;
    }
    if (typeof body.lan_only === 'boolean') {
      patch.lan_only = body.lan_only;
    }
    if (typeof body.auto_discovery === 'boolean') {
      patch.auto_discovery = body.auto_discovery;
    }
    if (typeof body.monitor_interval_seconds === 'number' && Number.isFinite(body.monitor_interval_seconds)) {
      patch.monitor_interval_seconds = Math.max(1, Math.min(30, Math.round(body.monitor_interval_seconds)));
    }
    if (typeof body.heartbeat_timeout_seconds === 'number' && Number.isFinite(body.heartbeat_timeout_seconds)) {
      patch.heartbeat_timeout_seconds = Math.max(5, Math.min(300, Math.round(body.heartbeat_timeout_seconds)));
    }
    if (typeof body.pairing_code_ttl_seconds === 'number' && Number.isFinite(body.pairing_code_ttl_seconds)) {
      patch.pairing_code_ttl_seconds = Math.max(30, Math.min(600, Math.round(body.pairing_code_ttl_seconds)));
    }
    if (typeof body.server_port === 'number' && Number.isFinite(body.server_port)) {
      patch.server_port = Math.max(1024, Math.min(65535, Math.round(body.server_port)));
    }

    const updated = store.updateSettings(patch);
    if (patch.monitor_interval_seconds !== undefined) {
      monitor.reschedule();
    }
    store.addSystemEvent('info', 'settings', 'Updated NetFusion configuration.');
    res.json({ settings: updated });
  });

  app.get('/api/system-events', (_req, res) => {
    res.json({ events: store.getSystemEvents(60) });
  });

  return {
    app,
    store,
    monitor,
    close: () => {
      monitor.stop();
      store.db.close();
    },
  };
}
