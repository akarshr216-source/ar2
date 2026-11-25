import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { NetFusionStore } from './db.ts';
import { NetworkMonitor } from './network-monitor.ts';
import type { DevicePlatform, NetFusionSettings, QosRuleRecord } from './types.ts';

const WORKSPACE_ROOT = path.resolve(process.cwd());

export const REPO_ALLOWLIST_FILES = [
  'README.md',
  'docs/ARCHITECTURE.md',
  'docs/API.md',
  'docs/SECURITY.md',
  'deployment/windows/configure-firewall.ps1',
  'deployment/windows/run-server.ps1',
  'server/go.mod',
  'server/configs/server.json',
  'server/configs/streaming.json',
  'server/configs/qos.json',
  'server/migrations/001_init.sql',
  'server/cmd/netfusion-server/main.go',
  'server/cmd/netfusion-diagnostics/main.go',
  'server/internal/config/config.go',
  'server/internal/database/sqlite.go',
  'server/internal/network/discovery.go',
  'server/internal/network/monitor.go',
  'server/internal/metrics/collector.go',
  'server/internal/scheduler/scheduler.go',
  'server/internal/streaming/classifier.go',
  'server/internal/bonding/manager.go',
  'server/internal/auth/pairing.go',
  'server/internal/api/server.go',
  'android/settings.gradle.kts',
  'android/build.gradle.kts',
  'android/app/build.gradle.kts',
  'android/app/src/main/AndroidManifest.xml',
  'android/app/src/main/java/com/netfusion/MainActivity.kt',
  'android/app/src/main/java/com/netfusion/data/Models.kt',
  'android/app/src/main/java/com/netfusion/data/TokenStore.kt',
  'android/app/src/main/java/com/netfusion/network/DeviceInfoProvider.kt',
  'android/app/src/main/java/com/netfusion/network/NetFusionApiClient.kt',
  'android/app/src/main/java/com/netfusion/services/HeartbeatManager.kt',
  'android/app/src/main/java/com/netfusion/ui/PairingScreen.kt',
];

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

function extractBearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
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

  // Server-side in-memory admin bearer sessions (never persisted in plaintext)
  const adminSessions = new Map<string, number>();
  const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

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

  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    const token = extractBearerToken(req);
    if (!isAdminSessionValid(token)) {
      res.status(401).json({ error: 'Administrator authentication required for device management.' });
      return;
    }
    next();
  };

  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => {
    const settings = store.getSettings();
    res.json({
      status: 'ok',
      application: 'NetFusion',
      version: '0.1.0',
      mode: settings.gateway_mode ? 'gateway' : 'monitoring',
      lan_addresses: getLanIPv4Addresses(),
      uptime_seconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // Administrator Auth Endpoints for Device Management
  app.get('/api/admin/status', (req, res) => {
    const authMode = store.getAdminAuthMode();
    const token = extractBearerToken(req);
    res.json({
      configured_via_env: authMode.configured_via_env,
      claimed: authMode.claimed,
      authenticated: isAdminSessionValid(token),
    });
  });

  app.post('/api/admin/claim', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const passcode = typeof body.passcode === 'string' ? body.passcode.trim() : '';
    if (passcode.length < 6 || passcode.length > 128) {
      res.status(400).json({ error: 'Passcode must be between 6 and 128 characters.' });
      return;
    }
    try {
      store.claimAdminPasscode(passcode);
      const session = issueAdminSession();
      res.status(201).json(session);
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : 'Admin already claimed.' });
    }
  });

  app.post('/api/admin/login', (req, res) => {
    const authMode = store.getAdminAuthMode();
    if (!authMode.claimed) {
      res.status(409).json({ error: 'Administrator passcode not yet configured. Claim admin access first.' });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const passcode = typeof body.passcode === 'string' ? body.passcode.trim() : '';
    if (!passcode || !store.verifyAdminPasscode(passcode)) {
      res.status(401).json({ error: 'Invalid administrator passcode.' });
      return;
    }
    const session = issueAdminSession();
    res.json(session);
  });

  app.post('/api/admin/logout', (req, res) => {
    const token = extractBearerToken(req);
    if (token) {
      adminSessions.delete(token);
    }
    res.json({ ok: true });
  });

  // Protected Device Management & Pairing Code Endpoints
  app.post('/api/pairing/generate', requireAdmin, (req, res) => {
    const body = req.body as Record<string, unknown>;
    const ttl =
      typeof body.ttl_seconds === 'number' && Number.isFinite(body.ttl_seconds)
        ? body.ttl_seconds
        : undefined;
    const platformHint =
      body.platform_hint === 'android' || body.platform_hint === 'windows' || body.platform_hint === 'any'
        ? body.platform_hint
        : 'any';

    const generated = store.generatePairingCode(ttl, platformHint);
    res.status(201).json({
      ...generated,
      platform_hint: platformHint,
      lan_addresses: getLanIPv4Addresses(),
    });
  });

  app.get('/api/pairing/status', requireAdmin, (_req, res) => {
    res.json(store.getPairingStatus());
  });

  app.get('/api/clients', requireAdmin, (_req, res) => {
    res.json({
      clients: store.getClients(),
      heartbeat_timeout_seconds: store.getSettings().heartbeat_timeout_seconds,
    });
  });

  app.delete('/api/clients/:id', requireAdmin, (req, res) => {
    const ok = store.revokeClient(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }
    monitor.notifyDeviceChange();
    res.json({ clients: store.getClients() });
  });

  // Client Registration & Heartbeat Endpoints (LAN Android / Windows Clients)
  app.post('/api/clients/pair', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const pairingCode = typeof body.pairing_code === 'string' ? body.pairing_code.trim() : '';
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

    if (!pairingCode) {
      res.status(401).json({ error: 'A valid temporary pairing code is required to register a device.' });
      return;
    }
    if (!deviceName || deviceName.length > 64 || !platform) {
      res.status(400).json({ error: 'Valid device_name and platform (android|windows) are required.' });
      return;
    }

    const result = store.pairDeviceWithCode({
      pairing_code: pairingCode,
      device_name: deviceName,
      platform,
      device_model: deviceModel,
      ip_address: ipAddress,
      app_version: appVersion,
    });

    if (!result.ok) {
      const messages: Record<typeof result.reason, string> = {
        invalid: 'Invalid pairing code.',
        expired: 'Pairing code has expired. Generate a new code on the NetFusion server.',
        used: 'Pairing code has already been used.',
        platform_mismatch: 'Pairing code is restricted to a different device platform.',
      };
      res.status(401).json({ error: messages[result.reason], reason: result.reason });
      return;
    }

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

  // Network Interfaces & Telemetry Endpoints
  app.get('/api/interfaces', (_req, res) => {
    const snapshot = monitor.getSnapshot();
    res.json({ interfaces: snapshot.interfaces, timestamp: snapshot.timestamp });
  });

  app.put('/api/interfaces/:id', async (req, res) => {
    const { id } = req.params;
    const existing = store.getInterfaceById(id);
    if (!existing) {
      res.status(404).json({ error: 'Interface not found' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const patch: Parameters<typeof store.updateInterface>[1] = {};

    if (typeof body.enabled === 'boolean') {
      patch.enabled = body.enabled ? 1 : 0;
      store.addSystemEvent(
        'info',
        'interface',
        `${existing.display_name} ${body.enabled ? 'enabled' : 'disabled'} by operator.`,
      );
    }
    if (typeof body.simulated_down === 'boolean') {
      patch.simulated_down = body.simulated_down ? 1 : 0;
      store.addSystemEvent(
        body.simulated_down ? 'warning' : 'info',
        'failover',
        body.simulated_down
          ? `Simulated disconnect triggered on ${existing.display_name}.`
          : `Cleared simulated disconnect on ${existing.display_name}.`,
      );
    }
    if (typeof body.weight === 'number' && Number.isFinite(body.weight)) {
      patch.weight = Math.max(5, Math.min(100, Math.round(body.weight)));
    }
    if (typeof body.priority_order === 'number' && Number.isFinite(body.priority_order)) {
      patch.priority_order = Math.max(1, Math.min(50, Math.round(body.priority_order)));
    }

    store.updateInterface(id, patch);
    const snapshot = await monitor.runCycle();
    res.json({ snapshot });
  });

  app.post('/api/interfaces/:id/probe', async (req, res) => {
    const { id } = req.params;
    const existing = store.getInterfaceById(id);
    if (!existing) {
      res.status(404).json({ error: 'Interface not found' });
      return;
    }

    const cloudflareMs = await monitor.probeHostTcp('1.1.1.1', 443);
    const googleMs = await monitor.probeHostTcp('8.8.8.8', 443);
    store.addSystemEvent(
      'info',
      'probe',
      `Live probe on ${existing.display_name}: 1.1.1.1=${cloudflareMs ?? 'timeout'}ms, 8.8.8.8=${googleMs ?? 'timeout'}ms.`,
    );
    const snapshot = await monitor.runCycle();
    res.json({
      probe: {
        interface_id: id,
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

  app.get('/api/streaming/profiles', (_req, res) => {
    res.json({ profiles: store.getStreamingProfiles() });
  });

  app.put('/api/streaming/profile', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const profileId = typeof body.profile_id === 'string' ? body.profile_id.trim() : '';
    if (!profileId) {
      res.status(400).json({ error: 'profile_id is required' });
      return;
    }
    try {
      const profiles = store.activateStreamingProfile(profileId);
      res.json({ profiles });
    } catch {
      res.status(404).json({ error: 'Streaming profile not found' });
    }
  });

  app.get('/api/qos/policies', (_req, res) => {
    res.json({
      rules: store.getQosRules(),
      tiers: [
        { tier: 'P0', label: 'Real-time', weight: 100, description: 'Video calls and interactive audio' },
        { tier: 'P1', label: 'Gaming', weight: 90, description: 'Online and cloud gaming' },
        { tier: 'P2', label: 'Video', weight: 70, description: 'YouTube, OTT, and live video playback' },
        { tier: 'P3', label: 'Normal', weight: 50, description: 'Web browsing and general apps' },
        { tier: 'P4', label: 'Background', weight: 30, description: 'Bulk downloads and OS updates' },
      ],
    });
  });

  app.put('/api/qos/policies', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const id = typeof body.id === 'string' ? body.id : '';
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : null;
    if (!id || enabled === null) {
      res.status(400).json({ error: 'Rule id and enabled boolean are required' });
      return;
    }
    const updated = store.toggleQosRule(id, enabled);
    if (!updated) {
      res.status(404).json({ error: 'QoS rule not found' });
      return;
    }
    res.json({ rules: store.getQosRules() });
  });

  app.post('/api/qos/rules', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const appName = typeof body.app_name === 'string' ? body.app_name.trim() : '';
    const matchPattern = typeof body.match_pattern === 'string' ? body.match_pattern.trim() : '';
    const tier = body.tier as QosRuleRecord['tier'];
    const preferred =
      typeof body.preferred_interface_id === 'string' && body.preferred_interface_id.trim()
        ? body.preferred_interface_id.trim()
        : null;

    if (!appName || !matchPattern || !['P0', 'P1', 'P2', 'P3', 'P4'].includes(tier)) {
      res.status(400).json({ error: 'Invalid QoS rule payload' });
      return;
    }
    store.createQosRule({
      app_name: appName.slice(0, 64),
      match_pattern: matchPattern.slice(0, 80),
      tier,
      preferred_interface_id: preferred,
    });
    res.status(201).json({ rules: store.getQosRules() });
  });

  app.delete('/api/qos/rules/:id', (req, res) => {
    const ok = store.deleteQosRule(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'QoS rule not found' });
      return;
    }
    res.json({ rules: store.getQosRules() });
  });

  app.get('/api/bonding/status', (_req, res) => {
    const snapshot = monitor.getSnapshot();
    const healthyCount = snapshot.interfaces.filter(
      (i) => i.enabled && !i.simulated_down && i.status !== 'offline',
    ).length;

    res.json({
      enabled: false,
      relay_mode: 'optional',
      relay_connected: false,
      active_tunnels: 0,
      candidate_paths: healthyCount,
      capabilities: {
        network_monitoring: true,
        load_balancing: true,
        failover: true,
        streaming_prioritization: true,
        single_flow_aggregation: false,
        combined_public_exit: false,
      },
      explanation:
        'True single-flow bandwidth bonding is disabled in NetFusion v0.1 and requires an optional remote QUIC relay. Separate sessions currently load-balance independently across healthy interfaces.',
    });
  });

  app.get('/api/bonding/paths', (_req, res) => {
    const snapshot = monitor.getSnapshot();
    const paths = snapshot.interfaces.map((iface) => ({
      interface_id: iface.id,
      display_name: iface.display_name,
      provider: iface.provider,
      tunnel_state: 'standby_no_relay',
      ready_for_quic: Boolean(iface.enabled && !iface.simulated_down && iface.status !== 'offline'),
      latency_ms: iface.latest_metric?.latency_ms ?? 0,
      jitter_ms: iface.latest_metric?.jitter_ms ?? 0,
      packet_loss_pct: iface.latest_metric?.packet_loss_pct ?? 0,
    }));
    res.json({ paths });
  });

  app.get('/api/stats/usage', (_req, res) => {
    res.json({ usage: store.getUsageStats() });
  });

  app.get('/api/settings', (_req, res) => {
    res.json({ settings: store.getSettings() });
  });

  app.put('/api/settings', (req, res) => {
    const body = req.body as Record<string, unknown>;
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
    if (typeof body.automatic_failover === 'boolean') {
      patch.automatic_failover = body.automatic_failover;
    }
    if (typeof body.load_balancing_enabled === 'boolean') {
      patch.load_balancing_enabled = body.load_balancing_enabled;
    }
    if (
      body.load_balancing_algorithm === 'weighted_health' ||
      body.load_balancing_algorithm === 'lowest_latency' ||
      body.load_balancing_algorithm === 'round_robin'
    ) {
      patch.load_balancing_algorithm = body.load_balancing_algorithm;
    }
    if (typeof body.monitor_interval_seconds === 'number' && Number.isFinite(body.monitor_interval_seconds)) {
      patch.monitor_interval_seconds = Math.max(1, Math.min(30, Math.round(body.monitor_interval_seconds)));
    }
    if (typeof body.heartbeat_timeout_seconds === 'number' && Number.isFinite(body.heartbeat_timeout_seconds)) {
      patch.heartbeat_timeout_seconds = Math.max(5, Math.min(300, Math.round(body.heartbeat_timeout_seconds)));
    }
    if (typeof body.pairing_code_ttl_seconds === 'number' && Number.isFinite(body.pairing_code_ttl_seconds)) {
      patch.pairing_code_ttl_seconds = Math.max(30, Math.min(900, Math.round(body.pairing_code_ttl_seconds)));
    }
    if (typeof body.server_port === 'number' && Number.isFinite(body.server_port)) {
      patch.server_port = Math.max(1024, Math.min(65535, Math.round(body.server_port)));
    }

    const updated = store.updateSettings(patch);
    if (patch.monitor_interval_seconds !== undefined) {
      monitor.reschedule();
    }
    store.addSystemEvent('info', 'settings', 'Updated NetFusion server configuration.');
    res.json({ settings: updated });
  });

  app.post('/api/gateway/mode', (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (typeof body.gateway_mode !== 'boolean') {
      res.status(400).json({ error: 'gateway_mode boolean is required' });
      return;
    }
    const updated = store.updateSettings({ gateway_mode: body.gateway_mode });
    store.addSystemEvent(
      body.gateway_mode ? 'warning' : 'info',
      'gateway',
      body.gateway_mode
        ? 'Activated Gateway Routing Mode for paired LAN clients.'
        : 'Returned to safe Monitoring Mode (no system route changes).',
    );
    res.json({ settings: updated, snapshot: monitor.getSnapshot() });
  });

  app.get('/api/system-events', (_req, res) => {
    res.json({ events: store.getSystemEvents(60) });
  });

  app.get('/api/repo/files', (_req, res) => {
    const available = REPO_ALLOWLIST_FILES.filter((rel) => {
      const resolved = path.resolve(WORKSPACE_ROOT, rel);
      return (
        (resolved === WORKSPACE_ROOT || resolved.startsWith(WORKSPACE_ROOT + path.sep)) &&
        fs.existsSync(resolved)
      );
    });
    res.json({ files: available });
  });

  app.get('/api/repo/file', (req, res) => {
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    if (!REPO_ALLOWLIST_FILES.includes(rel)) {
      res.status(403).json({ error: 'File is not in allowlisted repository source list' });
      return;
    }
    const resolved = path.resolve(WORKSPACE_ROOT, rel);
    if (!resolved.startsWith(WORKSPACE_ROOT + path.sep) || !fs.existsSync(resolved)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const content = fs.readFileSync(resolved, 'utf8');
    res.json({ path: rel, content });
  });

  return {
    app,
    store,
    monitor,
    close: () => {
      store.db.close();
    },
  };
}
