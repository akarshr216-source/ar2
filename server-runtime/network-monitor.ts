import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
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
  private prevLatency: number | null = null;
  private lastProbeLatencyMs: number | null = null;
  private recentProbeResults: boolean[] = [];

  constructor(store: NetFusionStore) {
    this.store = store;
  }

  public start(): void {
    void this.runCycle().catch((err) => {
      console.warn('Initial network monitor cycle error:', err instanceof Error ? err.message : err);
    });
    this.scheduleNext();
  }

  public reschedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduleNext();
  }

  public stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    const intervalMs = this.store.getSettings().monitor_interval_seconds * 1000;
    this.timer = setTimeout(async () => {
      try {
        await this.runCycle();
      } catch (err) {
        console.warn('Network monitor cycle error:', err instanceof Error ? err.message : err);
      }
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
      // Non-Linux host where /proc/net/dev is unavailable
    }
    return map;
  }

  private isOsLinkUp(systemName: string): boolean {
    try {
      const state = fs.readFileSync(`/sys/class/net/${path.basename(systemName)}/operstate`, 'utf8').trim();
      return state === 'up' || state === 'unknown';
    } catch {
      return true;
    }
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
    let realTcpMs = await this.probeHostTcp('1.1.1.1', 443);
    if (realTcpMs === null) {
      realTcpMs = await this.probeHostTcp('8.8.8.8', 443);
    }

    this.lastProbeLatencyMs = realTcpMs;
    this.recentProbeResults.push(realTcpMs !== null);
    if (this.recentProbeResults.length > 10) {
      this.recentProbeResults.shift();
    }

    const failedProbes = this.recentProbeResults.filter((ok) => !ok).length;
    const realLossPct =
      this.recentProbeResults.length > 0
        ? Number(((failedProbes / this.recentProbeResults.length) * 100).toFixed(1))
        : null;

    let jitterMs: number | null = null;
    if (realTcpMs !== null) {
      jitterMs =
        this.prevLatency !== null
          ? Number(Math.min(100, Math.abs(realTcpMs - this.prevLatency) * 0.35).toFixed(2))
          : 0;
      this.prevLatency = realTcpMs;
    }

    const nowIso = new Date().toISOString();
    const nowTs = Date.now();

    for (const iface of interfaces) {
      const linkUp = this.isOsLinkUp(iface.system_name);
      const counters = procMap.get(iface.system_name);
      const prev = this.prevProcCounters.get(iface.id);

      let downMbps: number | null = null;
      let upMbps: number | null = null;
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

      const metric: NetworkMetricRecord = {
        interface_id: iface.id,
        download_mbps: linkUp ? downMbps : 0,
        upload_mbps: linkUp ? upMbps : 0,
        latency_ms: linkUp ? realTcpMs : null,
        jitter_ms: linkUp ? jitterMs : null,
        packet_loss_pct: linkUp ? realLossPct : 100,
        health_score: null,
        rx_bytes: counters ? counters.rxBytes : null,
        tx_bytes: counters ? counters.txBytes : null,
        metrics_available: Boolean(counters && prev),
        probe_source: counters ? 'os_proc_net_dev' : 'os_adapter_only',
        recorded_at: nowIso,
      };
      this.store.insertMetric(metric);

      const nextStatus: NetworkInterfaceRecord['status'] = !linkUp
        ? 'offline'
        : realTcpMs === null
          ? 'degraded'
          : 'healthy';
      if (nextStatus !== iface.status) {
        this.store.updateInterfaceStatus(iface.id, nextStatus);
      }
    }

    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    return snapshot;
  }

  public getSnapshot(): TelemetrySnapshot {
    const settings = this.store.getSettings();
    const interfaces = this.store.getInterfaces();
    const latestMap = this.store.getLatestMetricPerInterface();

    const enriched: InterfaceWithMetrics[] = interfaces.map((iface) => ({
      ...iface,
      latest_metric: latestMap.get(iface.id) ?? null,
    }));

    let hasDownloadMetrics = false;
    let totalDownload = 0;
    let totalUpload = 0;
    let totalRxBytes = 0;
    let totalTxBytes = 0;
    let hasByteTotals = false;

    for (const iface of enriched) {
      const m = iface.latest_metric;
      if (m && m.download_mbps !== null && m.upload_mbps !== null) {
        hasDownloadMetrics = true;
        totalDownload += m.download_mbps;
        totalUpload += m.upload_mbps;
      }
      if (m && m.rx_bytes !== null && m.tx_bytes !== null) {
        hasByteTotals = true;
        totalRxBytes += m.rx_bytes;
        totalTxBytes += m.tx_bytes;
      }
    }

    const internetStatus: TelemetrySnapshot['internet_status'] =
      this.recentProbeResults.length === 0
        ? 'unavailable'
        : this.lastProbeLatencyMs !== null
          ? 'online'
          : 'offline';

    return {
      timestamp: new Date().toISOString(),
      server_status: 'running',
      internet_status: internetStatus,
      internet_latency_ms: this.lastProbeLatencyMs,
      total_download_mbps: hasDownloadMetrics ? Number(totalDownload.toFixed(2)) : null,
      total_upload_mbps: hasDownloadMetrics ? Number(totalUpload.toFixed(2)) : null,
      total_rx_bytes: hasByteTotals ? totalRxBytes : null,
      total_tx_bytes: hasByteTotals ? totalTxBytes : null,
      settings,
      interfaces: enriched,
      usage: this.store.getUsageStats(),
      events: this.store.getSystemEvents(25),
      devices_summary: this.store.getDeviceCounts(),
    };
  }
}

export interface TelemetrySnapshot {
  timestamp: string;
  server_status: 'running';
  internet_status: 'online' | 'offline' | 'unavailable';
  internet_latency_ms: number | null;
  total_download_mbps: number | null;
  total_upload_mbps: number | null;
  total_rx_bytes: number | null;
  total_tx_bytes: number | null;
  settings: ReturnType<NetFusionStore['getSettings']>;
  interfaces: InterfaceWithMetrics[];
  usage: ReturnType<NetFusionStore['getUsageStats']>;
  events: ReturnType<NetFusionStore['getSystemEvents']>;
  devices_summary: {
    total: number;
    connected: number;
    disconnected: number;
  };
}
