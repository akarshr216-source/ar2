import { ArrowDown, ArrowUp, RefreshCw } from 'lucide-react';
import type {
  NetworkInterfaceItem,
  PairedDevice,
  SystemEvent,
  TelemetrySnapshot,
} from '../types/netfusion';
import { TelemetryChart } from './TelemetryChart';

interface OverviewViewProps {
  snapshot: TelemetrySnapshot;
  clients: PairedDevice[];
  isAdminAuthenticated: boolean;
  probingId: string | null;
  onProbeInterface: (id: string) => void;
  onToggleInterface: (id: string, enabled: boolean) => void;
  onToggleSimulateDown: (id: string, simulatedDown: boolean) => void;
  onSetGatewayMode: (enabled: boolean) => void;
  onNavigateClients: () => void;
}

function formatStatusLabel(status: NetworkInterfaceItem['status']) {
  switch (status) {
    case 'healthy':
      return { text: 'Healthy', cls: 'text-emerald-700 dark:text-emerald-400' };
    case 'degraded':
      return { text: 'Degraded', cls: 'text-amber-700 dark:text-amber-400' };
    case 'offline':
      return { text: 'Offline', cls: 'text-red-700 dark:text-red-400' };
    case 'disabled':
      return { text: 'Disabled', cls: 'text-slate-500 dark:text-slate-400' };
  }
}

export function OverviewView({
  snapshot,
  clients,
  isAdminAuthenticated,
  probingId,
  onProbeInterface,
  onToggleInterface,
  onToggleSimulateDown,
  onSetGatewayMode,
  onNavigateClients,
}: OverviewViewProps) {
  const activeInterfaces = snapshot.interfaces.filter(
    (i) => i.enabled && !i.simulated_down && i.status !== 'offline',
  );

  const primaryUplink =
    activeInterfaces.find((i) => i.is_primary_failover) ?? activeInterfaces[0] ?? null;

  const avgLatency = activeInterfaces.length
    ? activeInterfaces.reduce((sum, i) => sum + (i.latest_metric?.latency_ms ?? 0), 0) /
      activeInterfaces.length
    : 0;

  const bestDownload = activeInterfaces.reduce(
    (max, i) => Math.max(max, i.latest_metric?.download_mbps ?? 0),
    0,
  );

  return (
    <div className="space-y-6">
      {/* 4-column KPI strip */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Active Uplinks
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
              {activeInterfaces.length} / {snapshot.interfaces.length}
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Load balanced
            </span>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Peak Single-Link Downlink
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
              {bestDownload.toFixed(1)} Mbps
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              No relay bonding
            </span>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Paired Clients
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
              {snapshot.devices_summary.connected} / {snapshot.devices_summary.total}
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400 truncate max-w-[140px]">
              {primaryUplink ? `${avgLatency.toFixed(1)} ms avg RTT` : 'No uplink'}
            </span>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Gateway Routing
            </span>
            <button
              type="button"
              onClick={() => onSetGatewayMode(!snapshot.settings.gateway_mode)}
              className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                snapshot.settings.gateway_mode
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              {snapshot.settings.gateway_mode ? 'Disable Gateway' : 'Enable Gateway'}
            </button>
          </div>
          <div className="mt-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            {snapshot.settings.gateway_mode ? 'Gateway Active' : 'Safe Monitoring Only'}
          </div>
        </div>
      </section>

      {/* Live Multi-Interface Telemetry Chart */}
      <TelemetryChart interfaces={snapshot.interfaces} history={snapshot.history} />

      {/* Connected Devices Summary Panel (No fake devices or invented device speeds) */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Connected Devices
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {snapshot.devices_summary.total === 0
                ? 'No Android or Windows devices registered yet'
                : `${snapshot.devices_summary.connected} connected · ${snapshot.devices_summary.disconnected} disconnected`}
            </p>
          </div>
          <button
            type="button"
            onClick={onNavigateClients}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            {isAdminAuthenticated ? 'Manage & Pair Devices' : 'Unlock Device Management'}
          </button>
        </div>

        {!isAdminAuthenticated ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Device roster is protected. Open Clients & Pairing to authenticate and view or pair real devices.
          </p>
        ) : clients.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            No real devices are currently paired. Use Pair New Device in Clients & Pairing to issue a temporary code.
          </p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {clients.map((dev) => (
              <div key={dev.id} className="py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-semibold text-slate-900 dark:text-slate-100">{dev.name}</span>
                  <span className="text-slate-400" aria-hidden="true">·</span>
                  <span className="capitalize text-slate-600 dark:text-slate-300">{dev.platform}</span>
                  <span className="text-slate-400" aria-hidden="true">·</span>
                  <span className="text-slate-500 dark:text-slate-400">{dev.device_model}</span>
                  <span className="text-slate-400" aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300">{dev.ip_address}</span>
                </div>
                <div className="flex items-center gap-4">
                  <span
                    className={`font-semibold ${
                      dev.connection_status === 'connected'
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-red-700 dark:text-red-400'
                    }`}
                  >
                    {dev.connection_status === 'connected' ? 'Connected' : 'Disconnected'}
                  </span>
                  <span className="font-mono tabular-nums text-slate-400 dark:text-slate-500">
                    {new Date(dev.last_seen_at).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Individual Network Cards */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Detected & Upstream Interfaces
          </h2>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Algorithm: {snapshot.settings.load_balancing_algorithm.replace('_', ' ')}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {snapshot.interfaces.map((iface) => {
            const m = iface.latest_metric;
            const statusInfo = formatStatusLabel(iface.status);
            return (
              <div
                key={iface.id}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col justify-between gap-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                        {iface.display_name}
                      </h3>
                      {iface.is_primary_failover && (
                        <span className="text-xs font-medium text-blue-600 dark:text-blue-400 whitespace-nowrap">
                          Primary
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-1.5">
                      <span>{iface.provider}</span>
                      <span aria-hidden="true">·</span>
                      <span>{iface.system_name}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">{iface.ip_address}</span>
                    </div>
                  </div>

                  <span className={`text-xs font-semibold whitespace-nowrap ${statusInfo.cls}`}>
                    {statusInfo.text}
                  </span>
                </div>

                <div className="grid grid-cols-4 gap-3 pt-3 border-t border-slate-100 dark:border-slate-800">
                  <div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                      <ArrowDown className="w-3 h-3" />
                      <span>Down</span>
                    </div>
                    <div className="mt-0.5 text-sm font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                      {(m?.download_mbps ?? 0).toFixed(1)}
                      <span className="text-[11px] font-normal text-slate-500 dark:text-slate-400 ml-1">
                        Mbps
                      </span>
                    </div>
                  </div>

                  <div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
                      <ArrowUp className="w-3 h-3" />
                      <span>Up</span>
                    </div>
                    <div className="mt-0.5 text-sm font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                      {(m?.upload_mbps ?? 0).toFixed(1)}
                      <span className="text-[11px] font-normal text-slate-500 dark:text-slate-400 ml-1">
                        Mbps
                      </span>
                    </div>
                  </div>

                  <div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">Latency</div>
                    <div className="mt-0.5 text-sm font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                      {(m?.latency_ms ?? 0).toFixed(1)}
                      <span className="text-[11px] font-normal text-slate-500 dark:text-slate-400 ml-1">
                        ms
                      </span>
                    </div>
                  </div>

                  <div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">Loss / Share</div>
                    <div className="mt-0.5 text-sm font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                      {(m?.packet_loss_pct ?? 0).toFixed(1)}% / {iface.traffic_share_pct}%
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
                  <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                    Health {(m?.health_score ?? 0).toFixed(0)} · Jitter {(m?.jitter_ms ?? 0).toFixed(1)} ms
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onProbeInterface(iface.id)}
                      disabled={probingId === iface.id}
                      className="px-2.5 py-1.5 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1"
                    >
                      <RefreshCw className={`w-3 h-3 ${probingId === iface.id ? 'animate-spin' : ''}`} />
                      <span>Probe</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onToggleSimulateDown(iface.id, !iface.simulated_down)}
                      className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        iface.simulated_down
                          ? 'bg-amber-600 text-white hover:bg-amber-700'
                          : 'border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
                      }`}
                    >
                      {iface.simulated_down ? 'Restore Link' : 'Test Failover'}
                    </button>

                    <button
                      type="button"
                      onClick={() => onToggleInterface(iface.id, !iface.enabled)}
                      className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        iface.enabled
                          ? 'border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
                          : 'bg-blue-600 text-white hover:bg-blue-700'
                      }`}
                    >
                      {iface.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Recent System Events */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Recent Engine & Failover Events
          </h2>
          <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
            Last {Math.min(6, snapshot.events.length)} events
          </span>
        </div>

        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {snapshot.events.slice(0, 6).map((evt: SystemEvent) => (
            <div key={evt.id} className="py-2.5 flex items-baseline justify-between gap-4 text-xs">
              <div className="flex items-baseline gap-3 min-w-0">
                <span
                  className={`font-semibold uppercase tracking-wide shrink-0 ${
                    evt.level === 'error'
                      ? 'text-red-600 dark:text-red-400'
                      : evt.level === 'warning'
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-blue-600 dark:text-blue-400'
                  }`}
                >
                  {evt.category}
                </span>
                <span className="text-slate-700 dark:text-slate-300 truncate">{evt.message}</span>
              </div>
              <span className="font-mono tabular-nums text-slate-400 dark:text-slate-500 shrink-0">
                {new Date(evt.created_at).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
