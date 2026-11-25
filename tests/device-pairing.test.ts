import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createNetFusionApp, type NetFusionAppInstance } from '../server-runtime/app.ts';

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

describe('NetFusion real device detection, pairing, and heartbeat lifecycle', () => {
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

    // Claim administrator access for device management tests
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

  it('1. returns empty device registry when no Android/Windows devices are paired', async () => {
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
  });

  it('10. rejects unauthorized registration, heartbeat, and admin endpoints', async () => {
    const unauthClients = await fetch(`${baseUrl}/api/clients`);
    assert.equal(unauthClients.status, 401);

    const unauthGen = await fetch(`${baseUrl}/api/pairing/generate`, { method: 'POST' });
    assert.equal(unauthGen.status, 401);

    const unauthPair = await fetch(`${baseUrl}/api/clients/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_name: 'Rogue Phone',
        platform: 'android',
      }),
    });
    assert.equal(unauthPair.status, 401);

    const unauthHeartbeat = await fetch(`${baseUrl}/api/clients/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer nf_dev_invalidtoken',
      },
      body: JSON.stringify({ ip_address: '192.168.1.99' }),
    });
    assert.equal(unauthHeartbeat.status, 401);
  });

  it('6 & 7. rejects invalid, expired, and already-used pairing codes', async () => {
    const invalidRes = await fetch(`${baseUrl}/api/clients/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairing_code: 'NF-0000-0000',
        device_name: 'Pixel Test',
        platform: 'android',
      }),
    });
    assert.equal(invalidRes.status, 401);

    // Insert an already-expired code directly to test expiry without waiting 30s
    const expiredCode = 'NF-EXPR-9999';
    const { default: crypto } = await import('node:crypto');
    const codeHash = crypto.createHash('sha256').update('NFEXPR9999').digest('hex');
    instance.store.db
      .prepare(
        `INSERT INTO pairing_codes (id, code_hash, code_hint, platform_hint, expires_at, created_at)
         VALUES ('pc-expired', ?, 'NF-****-**99', 'android', ?, ?)`,
      )
      .run(codeHash, new Date(Date.now() - 10_000).toISOString(), new Date(Date.now() - 60_000).toISOString());

    const expiredRes = await fetch(`${baseUrl}/api/clients/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairing_code: expiredCode,
        device_name: 'Pixel Test',
        platform: 'android',
      }),
    });
    assert.equal(expiredRes.status, 401);
    const expiredBody = (await expiredRes.json()) as { reason: string };
    assert.equal(expiredBody.reason, 'expired');
  });

  it('2 & 3. pairs one and then a second real Android device with single-use codes', async () => {
    const gen1 = await fetch(`${baseUrl}/api/pairing/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ platform_hint: 'android', ttl_seconds: 120 }),
    });
    assert.equal(gen1.status, 201);
    const code1 = ((await gen1.json()) as { pairing_code: string }).pairing_code;

    const pair1 = await fetch(`${baseUrl}/api/clients/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairing_code: code1,
        device_name: 'Akarsh Pixel 9',
        platform: 'android',
        device_model: 'Google Pixel 9 Pro',
        ip_address: '192.168.1.41',
        app_version: '1.0.0',
      }),
    });
    assert.equal(pair1.status, 201);
    const pair1Body = (await pair1.json()) as {
      device: { id: string; connection_status: string; device_model: string };
      auth_token: string;
    };
    assert.equal(pair1Body.device.connection_status, 'connected');
    assert.equal(pair1Body.device.device_model, 'Google Pixel 9 Pro');
    firstDeviceToken = pair1Body.auth_token;
    firstDeviceId = pair1Body.device.id;

    // Verify single-use code cannot be reused
    const reuseRes = await fetch(`${baseUrl}/api/clients/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairing_code: code1,
        device_name: 'Clone Phone',
        platform: 'android',
      }),
    });
    assert.equal(reuseRes.status, 401);

    // Pair second real Android device
    const gen2 = await fetch(`${baseUrl}/api/pairing/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ platform_hint: 'android' }),
    });
    const code2 = ((await gen2.json()) as { pairing_code: string }).pairing_code;
    const pair2 = await fetch(`${baseUrl}/api/clients/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pairing_code: code2,
        device_name: 'Work Galaxy S25',
        platform: 'android',
        device_model: 'Samsung SM-S931B',
        ip_address: '192.168.1.58',
        app_version: '1.0.0',
      }),
    });
    assert.equal(pair2.status, 201);

    const listRes = await fetch(`${baseUrl}/api/clients`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const listBody = (await listRes.json()) as { clients: Array<{ id: string }> };
    assert.equal(listBody.clients.length, 2);
  });

  it('4 & 5. marks device disconnected after heartbeat timeout and restores connected on heartbeat', async () => {
    // Age first device's last_seen_at past heartbeat timeout (15s)
    const staleIso = new Date(Date.now() - 30_000).toISOString();
    instance.store.db.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`).run(staleIso, firstDeviceId);

    const listRes = await fetch(`${baseUrl}/api/clients`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const listBody = (await listRes.json()) as {
      clients: Array<{ id: string; connection_status: string }>;
    };
    const dev1 = listBody.clients.find((c) => c.id === firstDeviceId);
    assert.equal(dev1?.connection_status, 'disconnected');

    // Device reconnects via authenticated heartbeat
    const hbRes = await fetch(`${baseUrl}/api/clients/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${firstDeviceToken}`,
      },
      body: JSON.stringify({ ip_address: '192.168.1.42', app_version: '1.0.1' }),
    });
    assert.equal(hbRes.status, 200);
    const hbBody = (await hbRes.json()) as {
      device: { connection_status: string; ip_address: string; app_version: string };
    };
    assert.equal(hbBody.device.connection_status, 'connected');
    assert.equal(hbBody.device.ip_address, '192.168.1.42');
    assert.equal(hbBody.device.app_version, '1.0.1');
  });

  it('8 & 9. persists paired devices across server restarts and accepts stored token reconnects', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    instance.close();

    // Restart server against the same SQLite database
    instance = createNetFusionApp({ dbPath, startMonitor: false });
    const restarted = await startListening(instance);
    server = restarted.server;
    baseUrl = restarted.baseUrl;

    // Re-authenticate admin after restart
    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'test-admin-secret' }),
    });
    assert.equal(loginRes.status, 200);
    adminToken = ((await loginRes.json()) as { admin_token: string }).admin_token;

    // Verify paired devices survived restart
    const listRes = await fetch(`${baseUrl}/api/clients`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const listBody = (await listRes.json()) as { clients: Array<{ id: string }> };
    assert.equal(listBody.clients.length, 2);

    // Previously paired Android device reconnects using its persisted auth_token
    const hbRes = await fetch(`${baseUrl}/api/clients/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${firstDeviceToken}`,
      },
      body: JSON.stringify({ ip_address: '192.168.1.43' }),
    });
    assert.equal(hbRes.status, 200);

    // Revoking device removes it and invalidates its token
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
});
