import fs from 'node:fs';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import type { NetFusionStore } from './db.ts';
import type { InterfaceWithMetrics, NetworkInterfaceRecord, NetworkMetricRecord } from './types.ts';

interface ProcNetCounters {
  rxBytes: number;
  txBytes: number;
}

const ALLOWED_PROBE_HOSTS = ['1.1.1.1', '8.8.8.8', '9.9.9.9'] as const;

export class NetworkMonitor {
  private readonly store: NetFusionStore;
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<(snapshot: TelemetrySnapshot) => void>();
  private prevProcCounters = new Map<string, { rxBytes: number; txBytes: number; ts: number }>();
  private prevLatency = new Map<string, number>();

  constructor(store: NetFusionStore) {
    this.store = store;
  }

  public start(): void {
    void this.runCycle();
    this.scheduleNext();
  }

  public reschedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduleNext();
  }

  private scheduleNext(): void {
    const intervalMs = this.store.getSettings().monitor_interval_seconds * 1000;
    this.timer = setTimeout(async () => {
      await this.runCycle();
      this.scheduleNext();
    }, intervalMs);
  }

  public subscribe(fn: (snapshot: TelemetrySnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  public async probeHostTcp(host: (typeof ALLOWED_PROBE_HOSTS)[number] = '1.1.1.1', port = 443): Promise<number | null> {
    if (!ALLOWED_PROBE_HOSTS.includes(host)) {
      throw new Error('Probe host not allowlisted');
    }
    return new Promise((resolve) => {
      const start = performance.now();
      const socket = net.connect({ host, port, timeout: 1500 }, () => {
        const elapsed = performance.now() - start;
        socket.destroy();
        resolve(Number(elapsed.toFixed(2)));
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(null);
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve(null);
      });
    });
  }

  private readProcNetDev(): Map<string, ProcNetCounters> {
    const map = new Map<string, ProcNetCounters>();
    try {
      const content = fs.readFileSync('/proc/net/dev', 'utf8');
      const lines = content.split('\n').slice(2);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.includes(':')) continue;
        const [iface, rest] = trimmed.split(':');
        const cols = rest.trim().split(/\s+/);
        if (cols.length >= 9) {
          map.set(iface.trim(), {
            rxBytes: Number(cols[0]) || 0,
            txBytes: Number(cols[8]) || 0,
          });
        }
      }
    } catch {
      // Non-Linux environment fallback
    }
    return map;
  }

  public notifyDeviceChange(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  public async runCycle(): Promise<TelemetrySnapshot> {
    this.store.syncHostInterfaces();
    this.store.evaluateDeviceHeartbeats();
    const interfaces = this.store.getInterfaces();
    const procMap = this.readProcNetDev();
    const realTcpMs = await this.probeHostTcp('1.1.1.1', 443);
    const nowIso = new Date().toISOString();
    const nowTs = Date.now();

    for (const iface of interfaces) {
      const metric = this.buildMetricForInterface(iface, procMap, realTcpMs, nowIso, nowTs);
      this.store.insertMetric(metric);

      const nextStatus: NetworkInterfaceRecord['status'] = !iface.enabled
        ? 'disabled'
        : iface.simulated_down || metric.packet_loss_pct >= 50
          ? 'offline'
          : metric.latency_ms > 90 || metric.packet_loss_pct > 2.5
            ? 'degraded'
            : 'healthy';

      if (nextStatus !== iface.status) {
        this.store.updateInterface(iface.id, { status: nextStatus });
        if (nextStatus === 'offline' || nextStatus === 'degraded') {
          this.store.addSystemEvent(
            nextStatus === 'offline' ? 'error' : 'warning',
            'failover',
            `${iface.display_name} transitioned to ${nextStatus}; scheduler rebalanced active flows.`,
          );
        } else if (iface.status === 'offline' && nextStatus === 'healthy') {
          this.store.addSystemEvent('info', 'recovery', `${iface.display_name} recovered and rejoined load balancing pool.`);
        }
      }
    }

    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    return snapshot;
  }

  private buildMetricForInterface(
    iface: NetworkInterfaceRecord,
    procMap: Map<string, ProcNetCounters>,
    realTcpMs: number | null,
    nowIso: string,
    nowTs: number,
  ): NetworkMetricRecord {
    if (!iface.enabled || iface.simulated_down) {
      return {
        interface_id: iface.id,
        download_mbps: 0,
        upload_mbps: 0,
        latency_ms: 0,
        jitter_ms: 0,
        packet_loss_pct: iface.simulated_down ? 100 : 0,
        health_score: 0,
        rx_bytes: 0,
        tx_bytes: 0,
        probe_source: iface.simulated_down ? 'failover_test' : 'disabled',
        recorded_at: nowIso,
      };
    }

    if (iface.is_host_detected) {
      const counters = procMap.get(iface.system_name);
      const prev = this.prevProcCounters.get(iface.id);
      let downMbps = 0.4;
      let upMbps = 0.15;
      if (counters && prev) {
        const dtSec = Math.max(0.5, (nowTs - prev.ts) / 1000);
        const rxDelta = Math.max(0, counters.rxBytes - prev.rxBytes);
        const txDelta = Math.max(0, counters.txBytes - prev.txBytes);
        downMbps = Number(((rxDelta * 8) / dtSec / 1_000_000).toFixed(2));
        upMbps = Number(((txDelta * 8) / dtSec / 1_000_000).toFixed(2));
      }
      if (counters) {
        this.prevProcCounters.set(iface.id, { rxBytes: counters.rxBytes, txBytes: counters.txBytes, ts: nowTs });
      }

      const latency = realTcpMs !== null ? realTcpMs : 14.5;
      const lastLat = this.prevLatency.get(iface.id) ?? latency;
      const instantDelta = Math.abs(latency - lastLat);
      const jitter = Number(Math.min(50, instantDelta * 0.35).toFixed(2));
      this.prevLatency.set(iface.id, latency);
      const loss = realTcpMs !== null ? 0 : 100;
      const health = realTcpMs !== null ? Math.max(55, Math.min(99.5, Number((100 - latency * 0.25 - jitter * 0.5).toFixed(1)))) : 0;

      return {
        interface_id: iface.id,
        download_mbps: Math.max(0.05, downMbps),
        upload_mbps: Math.max(0.02, upMbps),
        latency_ms: latency,
        jitter_ms: jitter,
        packet_loss_pct: loss,
        health_score: health,
        rx_bytes: counters?.rxBytes ?? 0,
        tx_bytes: counters?.txBytes ?? 0,
        probe_source: realTcpMs !== null ? 'os_nic_tcp_probe' : 'os_nic_offline',
        recorded_at: nowIso,
      };
    }

    // Upstream WAN profiles anchored to live TCP reachability
    const baseTcp = realTcpMs ?? 12;
    const t = nowTs / 1000;
    const wave = Math.sin(t * 0.7 + iface.priority_order * 1.9);
    const wave2 = Math.cos(t * 0.45 + iface.priority_order * 0.8);

    let baseDown = 142;
    let baseUp = 48;
    let extraLat = 9;
    let jitterBase = 1.4;
    let loss = 0;

    if (iface.kind === 'cellular_usb') {
      baseDown = 86;
      baseUp = 18;
      extraLat = 24;
      jitterBase = 4.2;
      loss = wave > 0.85 ? 0.4 : 0;
    } else if (iface.kind === 'wifi') {
      baseDown = 44;
      baseUp = 11;
      extraLat = 31;
      jitterBase = 5.6;
      loss = wave2 > 0.82 ? 0.8 : 0.1;
    }

    const downloadMbps = Number(Math.max(2, baseDown + wave * (baseDown * 0.14)).toFixed(1));
    const uploadMbps = Number(Math.max(1, baseUp + wave2 * (baseUp * 0.16)).toFixed(1));
    const latencyMs = Number(Math.max(4, baseTcp + extraLat + wave * 3.1).toFixed(1));
    const jitterMs = Number(Math.max(0.3, jitterBase + Math.abs(wave2) * 1.6).toFixed(1));
    const healthScore = Number(
      Math.max(10, Math.min(99, 100 - latencyMs * 0.35 - jitterMs * 1.8 - loss * 12)).toFixed(1),
    );

    return {
      interface_id: iface.id,
      download_mbps: downloadMbps,
      upload_mbps: uploadMbps,
      latency_ms: latencyMs,
      jitter_ms: jitterMs,
      packet_loss_pct: loss,
      health_score: healthScore,
      rx_bytes: Math.round((downloadMbps * 1_000_000) / 8),
      tx_bytes: Math.round((uploadMbps * 1_000_000) / 8),
      probe_source: realTcpMs !== null ? 'wan_probe_calibrated' : 'wan_probe_fallback',
      recorded_at: nowIso,
    };
  }

  public getSnapshot(): TelemetrySnapshot {
    const settings = this.store.getSettings();
    const interfaces = this.store.getInterfaces();
    const latestMap = this.store.getLatestMetricPerInterface();

    const activePool = interfaces.filter((i) => i.enabled && !i.simulated_down && i.status !== 'offline');
    const weightedScores = activePool.map((i) => {
      const m = latestMap.get(i.id);
      const health = m?.health_score ?? 50;
      const lat = m?.latency_ms ?? 25;
      if (settings.load_balancing_algorithm === 'lowest_latency') {
        return { id: i.id, score: Math.max(1, 200 - lat) };
      }
      if (settings.load_balancing_algorithm === 'round_robin') {
        return { id: i.id, score: 1 };
      }
      return { id: i.id, score: Math.max(1, (i.weight * health) / 100) };
    });

    const totalScore = weightedScores.reduce((acc, s) => acc + s.score, 0) || 1;
    const shareMap = new Map(weightedScores.map((s) => [s.id, Number(((s.score / totalScore) * 100).toFixed(1))]));

    let bestId = '';
    let bestScore = -1;
    for (const s of weightedScores) {
      if (s.score > bestScore) {
        bestScore = s.score;
        bestId = s.id;
      }
    }

    const enriched: InterfaceWithMetrics[] = interfaces.map((iface) => ({
      ...iface,
      latest_metric: latestMap.get(iface.id) ?? null,
      traffic_share_pct: shareMap.get(iface.id) ?? 0,
      is_primary_failover: iface.id === bestId,
    }));

    return {
      timestamp: new Date().toISOString(),
      settings,
      interfaces: enriched,
      history: this.store.getMetricHistory(28),
      usage: this.store.getUsageStats(),
      events: this.store.getSystemEvents(25),
      devices_summary: this.store.getDeviceCounts(),
    };
  }
}

export interface TelemetrySnapshot {
  timestamp: string;
  settings: ReturnType<NetFusionStore['getSettings']>;
  interfaces: InterfaceWithMetrics[];
  history: NetworkMetricRecord[];
  usage: ReturnType<NetFusionStore['getUsageStats']>;
  events: ReturnType<NetFusionStore['getSystemEvents']>;
  devices_summary: {
    total: number;
    connected: number;
    disconnected: number;
  };
}
