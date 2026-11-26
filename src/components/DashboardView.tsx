import { QrCode, RefreshCw, Settings, Smartphone } from 'lucide-react';
import type { PairedDevice, TelemetrySnapshot } from '../types/netfusion';

interface DashboardViewProps {
  snapshot: TelemetrySnapshot;
  lanAddresses: string[];
  clients: PairedDevice[];
  isAdminAuthenticated: boolean;
  checkingNetwork: boolean;
  onAddDevice: () => void;
  onOpenDevices: () => void;
  onOpenSettings: () => void;
  onCheckNetwork: () => void;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'Unavailable';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatBpsRate(bps: number | null): string {
  if (bps === null) return 'Unavailable';
  const mbps = (bps * 8) / 1_000_000;
  if (mbps >= 1) return `${mbps.toFixed(1)} Mbps`;
  return `${((bps * 8) / 1000).toFixed(0)} Kbps`;
}

export function DashboardView({
  snapshot,
  lanAddresses,
  clients,
  isAdminAuthenticated,
  checkingNetwork,
  onAddDevice,
  onOpenDevices,
  onOpenSettings,
  onCheckNetwork,
}: DashboardViewProps) {
  const lanIpDisplay =
    lanAddresses.find((ip) => ip !== '127.0.0.1') ?? 'Localhost only';

  const internetLabel =
    snapshot.internet_status === 'online'
      ? 'Online'
      : snapshot.internet_status === 'offline'
        ? 'Offline'
        : 'Unavailable';

  const internetCls =
    snapshot.internet_status === 'online'
      ? 'text-emerald-700 dark:text-emerald-400'
      : snapshot.internet_status === 'offline'
        ? 'text-red-700 dark:text-red-400'
        : 'text-slate-500 dark:text-slate-400';

  const trafficRateAvailable =
    snapshot.total_download_mbps !== null && snapshot.total_upload_mbps !== null;

  return (
    <div className="space-y-6">
      {/* 4 Core Cards: Server status, Internet connection, Connected devices, Total download & upload traffic */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col justify-between gap-2">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Server Status
          </div>
          <div className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">
            Running
          </div>
          <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 truncate">
            {lanIpDisplay} · Port {snapshot.settings.server_port}
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col justify-between gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Internet Connection
            </span>
            <button
              type="button"
              onClick={onCheckNetwork}
              disabled={checkingNetwork}
              aria-label="Check internet connection"
              className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
            >
              <RefreshCw className={`w-3 h-3 ${checkingNetwork ? 'animate-spin' : ''}`} />
              <span>Check</span>
            </button>
          </div>
          <div className={`text-2xl font-bold ${internetCls}`}>{internetLabel}</div>
          <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
            {snapshot.internet_latency_ms !== null
              ? `Ping ${snapshot.internet_latency_ms.toFixed(1)} ms`
              : 'No ping response'}
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col justify-between gap-2">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Connected Devices
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {snapshot.devices_summary.connected}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {snapshot.devices_summary.total === 0
              ? 'No paired devices yet'
              : `${snapshot.devices_summary.total} paired · ${snapshot.devices_summary.disconnected} offline`}
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col justify-between gap-2">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Total Download & Upload Traffic
          </div>
          {trafficRateAvailable ? (
            <>
              <div className="text-xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {snapshot.total_download_mbps?.toFixed(2)} / {snapshot.total_upload_mbps?.toFixed(2)} Mbps
              </div>
              <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                RX {formatBytes(snapshot.total_rx_bytes)} · TX {formatBytes(snapshot.total_tx_bytes)}
              </div>
            </>
          ) : (
            <>
              <div className="text-xl font-semibold text-slate-500 dark:text-slate-400">
                Unavailable
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Waiting for host interface byte counters
              </div>
            </>
          )}
        </div>
      </section>

      {/* Primary Beginner Action Strip: Add Device + Settings */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Connect Your Phone or Computer
          </h2>
          <p className="text-xs text-slate-600 dark:text-slate-400 max-w-xl">
            Click Add Device to display a 2-minute QR code. Scan it from the NetFusion Android app on the same Wi-Fi network.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
          >
            <Settings className="w-3.5 h-3.5" />
            <span>Settings</span>
          </button>
          <button
            type="button"
            onClick={onAddDevice}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white whitespace-nowrap"
          >
            <QrCode className="w-3.5 h-3.5" />
            <span>Add Device</span>
          </button>
        </div>
      </section>

      {/* Connected Devices Summary */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Connected Devices
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Only devices paired via your QR code or temporary pairing secret appear here.
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenDevices}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
          >
            {isAdminAuthenticated ? 'View All Devices' : 'Unlock Devices'}
          </button>
        </div>

        {!isAdminAuthenticated ? (
          <div className="p-8 text-center space-y-3">
            <Smartphone className="w-7 h-7 mx-auto text-slate-400 dark:text-slate-500" />
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
              Device list is password-protected
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              Click Add Device or View All Devices to unlock with your administrator password.
            </p>
          </div>
        ) : clients.length === 0 ? (
          <div className="p-8 text-center space-y-3">
            <Smartphone className="w-7 h-7 mx-auto text-slate-400 dark:text-slate-500" />
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
              No devices paired yet
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              Click Add Device to create a single-use QR code and scan it from your Android phone.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {clients.map((dev) => {
              const isConnected = dev.connection_status === 'connected';
              return (
                <div key={dev.id} className="px-5 py-3.5 flex flex-wrap items-center justify-between gap-4 text-xs">
                  <div className="space-y-0.5 min-w-0">
                    <div className="font-semibold text-sm text-slate-900 dark:text-slate-100">
                      {dev.name}
                    </div>
                    <div className="text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-1.5">
                      <span className="capitalize">{dev.platform}</span>
                      <span aria-hidden="true">·</span>
                      <span>{dev.device_model}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">{dev.ip_address}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-6">
                    <div className="text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                      {dev.download_bps !== null && dev.upload_bps !== null
                        ? `${formatBpsRate(dev.download_bps)} ↓ · ${formatBpsRate(dev.upload_bps)} ↑`
                        : 'Traffic unavailable'}
                    </div>
                    <div
                      className={`font-semibold ${
                        isConnected
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-red-700 dark:text-red-400'
                      }`}
                    >
                      {isConnected ? 'Connected' : 'Disconnected'}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
