import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createNetFusionApp, isLocalOrLanAddress, type NetFusionAppInstance } from '../server-runtime/app.ts';
import { createApiReverseProxy } from '../server-runtime/proxy.ts';

function startListening(instance: NetFusionAppInstance): Promise<{ server: http.Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = instance.app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('Failed to bind ephemeral port');
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe('NetFusion QR pairing, real device registry, and zero-mock networking', () => {
  let tmpDir: string;
  let dbPath: string;
  let instance: NetFusionAppInstance;
  let server: http.Server;
  let baseUrl: string;
  let adminToken: string;
  let firstDeviceToken: string;
  let firstDeviceId: string;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netfusion-test-'));
    dbPath = path.join(tmpDir, 'netfusion.db');
    instance = createNetFusionApp({ dbPath, startMonitor: false });
    const started = await startListening(instance);
    server = started.server;
    baseUrl = started.baseUrl;

    const claimRes = await fetch(`${baseUrl}/api/admin/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'test-admin-secret' }),
    });
    assert.equal(claimRes.status, 201);
    const claimBody = (await claimRes.json()) as { admin_token: string };
    adminToken = claimBody.admin_token;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    instance.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. returns empty device registry and zero fake WAN interfaces', async () => {
    const res = await fetch(`${baseUrl}/api/clients`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { clients: unknown[] };
    assert.equal(body.clients.length, 0);

    const statusRes = await fetch(`${baseUrl}/api/pairing/status`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const statusBody = (await statusRes.json()) as { registered_devices: number };
    assert.equal(statusBody.registered_devices, 0);

    const ifacesRes = await fetch(`${baseUrl}/api/interfaces`);
    assert.equal(ifacesRes.status, 200);
    const ifacesBody = (await ifacesRes.json()) as { interfaces: Array<{ id: string; is_host_detected: number }> };
    for (const iface of ifacesBody.interfaces) {
      assert.ok(!['wan-airtel', 'wan-jio', 'wan-wifi'].includes(iface.id));
      assert.equal(iface.is_host_detected, 1);
    }
  });

  it('2. generates single-use 2-minute QR payload without auth_token', async () => {
    const res = await fetch(`${baseUrl}/api/pairing/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        platform_hint: 'android',
        server_url: 'http://192.168.1.10:8080',
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      pairing_id: string;
      secret: string;
      ttl_seconds: number;
      qr_payload: string;
      auth_token?: string;
    };

    assert.equal(body.ttl_seconds, 120);
    assert.equal(body.auth_token, undefined);
    assert.ok(body.qr_payload.startsWith('netfusion://pair?'));

    const parsed = new URL(body.qr_payload);
    assert.equal(parsed.searchParams.get('server'), 'http://192.168.1.10:8080');
    assert.equal(parsed.searchParams.get('pairing_id'), body.pairing_id);
    assert.equal(parsed.searchParams.get('secret'), body.secret);
    assert.equal(parsed.searchParams.get('auth_token'), null);
    assert.equal(parsed.searchParams.get('token'), null);

    // Reject localhost / 127.0.0.1 / 0.0.0.0 / non-HTTPS remote URLs in QR generation
    for (const badServerUrl of [
      'http://localhost:3000',
      'http://127.0.0.1:8080',
      'http://0.0.0.0:8080',
      'http://203.0.113.10:8080',
    ]) {
      const badRes = await fetch(`${baseUrl}/api/pairing/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          platform_hint: 'android',
          server_url: badServerUrl,
        }),
      });
      assert.equal(badRes.status, 400, `expected 400 for ${badServerUrl}`);
    }

    // Verify /api/health returns ranked LAN addresses (no 127.0.0.1) and honors NETFUSION_PUBLIC_URL
    const prevPublicUrl = process.env.NETFUSION_PUBLIC_URL;
    process.env.NETFUSION_PUBLIC_URL = 'http://192.168.1.16:8080';
    try {
      const healthRes = await fetch(`${baseUrl}/api/health`);
      assert.equal(healthRes.status, 200);
      const healthBody = (await healthRes.json()) as {
        public_url: string | null;
        lan_addresses: string[];
        backend_mode: string;
      };
      assert.equal(healthBody.backend_mode, 'node');
      assert.equal(healthBody.public_url, 'http://192.168.1.16:8080');
      assert.ok(!healthBody.lan_addresses.includes('127.0.0.1'));

      const defaultQrRes = await fetch(`${baseUrl}/api/pairing/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ platform_hint: 'android' }),
      });
      assert.equal(defaultQrRes.status, 201);
      const defaultQrBody = (await defaultQrRes.json()) as { server_url: string; qr_payload: string };
      assert.equal(defaultQrBody.server_url, 'http://192.168.1.16:8080');
      assert.equal(
        new URL(defaultQrBody.qr_payload).searchParams.get('server'),
        'http://192.168.1.16:8080',
      );
    } finally {
      if (prevPublicUrl === undefined) {
        delete process.env.NETFUSION_PUBLIC_URL;
      } else {
        process.env.NETFUSION_PUBLIC_URL = prevPublicUrl;
      }
    }
  });

  it('3 & 4. rejects invalid and expired QR pairing sessions', async () => {
    const invalidRes = await fetch(`${baseUrl}/api/clients/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairing_id: 'pc-nonexistent',
        secret: 'NF-0000-0000-0000',
        device_name: 'Pixel Test',
        platform: 'android',
      }),
    });
    assert.equal(invalidRes.status, 401);
    const invalidBody = (await invalidRes.json()) as { reason: string };
    assert.equal(invalidBody.reason, 'invalid');

    const expiredSecret = 'NF-EXPR-9999-ABCD';
    const secretHash = crypto.createHash('sha256').update('NFEXPR9999ABCD').digest('hex');
    instance.store.db
      .prepare(
        `INSERT INTO pairing_codes (id, code_hash, code_hint, platform_hint, expires_at, created_at)
         VALUES ('pc-expired-qr', ?, 'pc-expired-qr', 'android', ?, ?)`,
      )
      .run(secretHash, new Date(Date.now() - 10_000).toISOString(), new Date(Date.now() - 130_000).toISOString());

    const expiredRes = await fetch(`${baseUrl}/api/clients/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairing_id: 'pc-expired-qr',
        secret: expiredSecret,
        device_name: 'Pixel Test',
        platform: 'android',
      }),
    });
    assert.equal(expiredRes.status, 401);
    const expiredBody = (await expiredRes.json()) as { reason: string };
    assert.equal(expiredBody.reason, 'expired');
  });

  it('5. pairs real Android devices via QR secret, separates pairing vs live connection, and blocks QR reuse', async () => {
    const gen1 = await fetch(`${baseUrl}/api/pairing/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ platform_hint: 'android', ttl_seconds: 120 }),
    });
    assert.equal(gen1.status, 201);
    const gen1Body = (await gen1.json()) as { pairing_id: string; secret: string };

    const pair1 = await fetch(`${baseUrl}/api/clients/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairing_id: gen1Body.pairing_id,
        secret: gen1Body.secret,
        device_name: 'Akarsh Pixel 9',
        platform: 'android',
        device_model: 'Google Pixel 9 Pro',
        ip_address: '192.168.1.41',
        app_version: '0.2.0',
      }),
    });
    assert.equal(pair1.status, 201);
    const pair1Body = (await pair1.json()) as {
      device: { id: string; pairing_status: string; connection_status: string; device_model: string };
      auth_token: string;
    };

    // Pairing and live connectivity are distinct: device starts paired + disconnected until first heartbeat arrives
    assert.equal(pair1Body.device.pairing_status, 'paired');
    assert.equal(pair1Body.device.connection_status, 'disconnected');
    assert.equal(pair1Body.device.device_model, 'Google Pixel 9 Pro');
    assert.ok(pair1Body.auth_token.startsWith('nf_dev_'));
    firstDeviceToken = pair1Body.auth_token;
    firstDeviceId = pair1Body.device.id;

    // QR session cannot be reused
    const reuseRes = await fetch(`${baseUrl}/api/clients/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairing_id: gen1Body.pairing_id,
        secret: gen1Body.secret,
        device_name: 'Clone Phone',
        platform: 'android',
      }),
    });
    assert.equal(reuseRes.status, 401);
    const reuseBody = (await reuseRes.json()) as { reason: string };
    assert.equal(reuseBody.reason, 'used');

    // First authenticated heartbeat transitions device to connected & stores real traffic bytes
    const hb1 = await fetch(`${baseUrl}/api/clients/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${firstDeviceToken}`,
      },
      body: JSON.stringify({
        ip_address: '192.168.1.41',
        app_version: '0.2.0',
        rx_bytes: 125_000_000,
        tx_bytes: 24_000_000,
        download_bps: 4_800_000,
        upload_bps: 1_200_000,
      }),
    });
    assert.equal(hb1.status, 200);
    const hb1Body = (await hb1.json()) as {
      device: { connection_status: string; download_bps: number | null; upload_bps: number | null };
    };
    assert.equal(hb1Body.device.connection_status, 'connected');
    assert.equal(hb1Body.device.download_bps, 4_800_000);
    assert.equal(hb1Body.device.upload_bps, 1_200_000);

    // Pair second real device
    const gen2 = await fetch(`${baseUrl}/api/pairing/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ platform_hint: 'android' }),
    });
    const gen2Body = (await gen2.json()) as { pairing_id: string; secret: string };
    const pair2 = await fetch(`${baseUrl}/api/clients/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairing_id: gen2Body.pairing_id,
        secret: gen2Body.secret,
        device_name: 'Work Galaxy S25',
        platform: 'android',
        device_model: 'Samsung SM-S931B',
        ip_address: '192.168.1.58',
        app_version: '0.2.0',
      }),
    });
    assert.equal(pair2.status, 201);

    const listRes = await fetch(`${baseUrl}/api/clients`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const listBody = (await listRes.json()) as { clients: Array<{ id: string }> };
    assert.equal(listBody.clients.length, 2);
  });

  it('6. marks device disconnected after heartbeat timeout and restores connected on next heartbeat', async () => {
    const staleIso = new Date(Date.now() - 30_000).toISOString();
    instance.store.db.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`).run(staleIso, firstDeviceId);

    const listRes = await fetch(`${baseUrl}/api/clients`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const listBody = (await listRes.json()) as {
      clients: Array<{ id: string; pairing_status: string; connection_status: string }>;
    };
    const dev1 = listBody.clients.find((c) => c.id === firstDeviceId);
    assert.equal(dev1?.pairing_status, 'paired');
    assert.equal(dev1?.connection_status, 'disconnected');

    const hbRes = await fetch(`${baseUrl}/api/clients/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${firstDeviceToken}`,
      },
      body: JSON.stringify({ ip_address: '192.168.1.42', app_version: '0.2.1' }),
    });
    assert.equal(hbRes.status, 200);
    const hbBody = (await hbRes.json()) as {
      device: { connection_status: string; ip_address: string; app_version: string };
    };
    assert.equal(hbBody.device.connection_status, 'connected');
    assert.equal(hbBody.device.ip_address, '192.168.1.42');
    assert.equal(hbBody.device.app_version, '0.2.1');
  });

  it('7. persists paired devices across restarts and revokes device tokens cleanly', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    instance.close();

    instance = createNetFusionApp({ dbPath, startMonitor: false });
    const restarted = await startListening(instance);
    server = restarted.server;
    baseUrl = restarted.baseUrl;

    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'test-admin-secret' }),
    });
    assert.equal(loginRes.status, 200);
    adminToken = ((await loginRes.json()) as { admin_token: string }).admin_token;

    const listRes = await fetch(`${baseUrl}/api/clients`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const listBody = (await listRes.json()) as { clients: Array<{ id: string }> };
    assert.equal(listBody.clients.length, 2);

    const hbRes = await fetch(`${baseUrl}/api/clients/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${firstDeviceToken}`,
      },
      body: JSON.stringify({ ip_address: '192.168.1.43' }),
    });
    assert.equal(hbRes.status, 200);

    const delRes = await fetch(`${baseUrl}/api/clients/${firstDeviceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(delRes.status, 200);

    const revokedHb = await fetch(`${baseUrl}/api/clients/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${firstDeviceToken}`,
      },
      body: JSON.stringify({ ip_address: '192.168.1.43' }),
    });
    assert.equal(revokedHb.status, 401);
  });

  it('8. enforces brute-force rate limit (429), 401 auth checks, and LAN-only IP classification', async () => {
    const unauthClients = await fetch(`${baseUrl}/api/clients`);
    assert.equal(unauthClients.status, 401);

    const unauthGen = await fetch(`${baseUrl}/api/pairing/generate`, { method: 'POST' });
    assert.equal(unauthGen.status, 401);

    // Verify LAN IP filter helper blocks public internet IPs while allowing local Wi-Fi ranges
    assert.equal(isLocalOrLanAddress('127.0.0.1'), true);
    assert.equal(isLocalOrLanAddress('192.168.1.42'), true);
    assert.equal(isLocalOrLanAddress('10.0.0.15'), true);
    assert.equal(isLocalOrLanAddress('172.16.4.2'), true);
    assert.equal(isLocalOrLanAddress('8.8.8.8'), false);
    assert.equal(isLocalOrLanAddress('203.0.113.10'), false);

    // Test sliding rate limit on an isolated instance so loopback rate limiter doesn't lock out main suite
    const rlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netfusion-rl-'));
    const rlInstance = createNetFusionApp({ dbPath: path.join(rlDir, 'rl.db'), startMonitor: false });
    const rlServer = await startListening(rlInstance);
    try {
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${rlServer.baseUrl}/api/clients/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pairing_id: 'pc-guess',
            secret: `NF-BAD0-000${i}-XXXX`,
            device_name: 'BruteForce',
            platform: 'android',
          }),
        });
        assert.equal(res.status, 401);
      }

      const blockedRes = await fetch(`${rlServer.baseUrl}/api/clients/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairing_id: 'pc-guess',
          secret: 'NF-BAD0-0006-XXXX',
          device_name: 'BruteForce',
          platform: 'android',
        }),
      });
      assert.equal(blockedRes.status, 429);
      assert.ok(Number(blockedRes.headers.get('retry-after')) >= 1);
    } finally {
      await new Promise<void>((resolve) => rlServer.server.close(() => resolve()));
      rlInstance.close();
      fs.rmSync(rlDir, { recursive: true, force: true });
    }
  });

  it('9. proxies /api/* transparently to upstream API server and returns 502 when offline', async () => {
    const proxyApp = express();
    proxyApp.use('/api', createApiReverseProxy(baseUrl));
    const proxyServer = await new Promise<http.Server>((resolve) => {
      const s = proxyApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = proxyServer.address();
    assert.ok(addr && typeof addr !== 'string');
    const proxyUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const healthRes = await fetch(`${proxyUrl}/api/health`);
      assert.equal(healthRes.status, 200);
      const healthBody = (await healthRes.json()) as { application: string };
      assert.equal(healthBody.application, 'NetFusion');

      const genRes = await fetch(`${proxyUrl}/api/pairing/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          platform_hint: 'android',
          server_url: 'http://192.168.1.16:8080',
        }),
      });
      assert.equal(genRes.status, 201);
      const genBody = (await genRes.json()) as { server_url: string; qr_payload: string };
      assert.equal(genBody.server_url, 'http://192.168.1.16:8080');
      assert.ok(genBody.qr_payload.includes('192.168.1.16'));
    } finally {
      await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
    }

    // Verify offline upstream returns clean 502 JSON instead of crashing
    const deadProxyApp = express();
    deadProxyApp.use('/api', createApiReverseProxy('http://127.0.0.1:1'));
    const deadProxyServer = await new Promise<http.Server>((resolve) => {
      const s = deadProxyApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    const deadAddr = deadProxyServer.address();
    assert.ok(deadAddr && typeof deadAddr !== 'string');

    try {
      const res = await fetch(`http://127.0.0.1:${deadAddr.port}/api/health`);
      assert.equal(res.status, 502);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /offline or unreachable/i);
    } finally {
      await new Promise<void>((resolve) => deadProxyServer.close(() => resolve()));
    }
  });
});
