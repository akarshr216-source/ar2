import { RefreshCw } from 'lucide-react';
import type { NetworkInterfaceItem } from '../types/netfusion';

interface NetworksViewProps {
  interfaces: NetworkInterfaceItem[];
  internetStatus: 'online' | 'offline' | 'unavailable';
  internetLatencyMs: number | null;
  checkingNetwork: boolean;
  onCheckNetwork: () => void;
}

function formatKindLabel(kind: NetworkInterfaceItem['kind']): string {
  switch (kind) {
    case 'wifi':
      return 'Wi-Fi';
    case 'cellular_usb':
      return 'USB Tether';
    case 'ethernet':
      return 'Ethernet';
    case 'hotspot':
      return 'Hotspot';
    default:
      return 'Loopback';
  }
}

export function NetworksView({
  interfaces,
  internetStatus,
  internetLatencyMs,
  checkingNetwork,
  onCheckNetwork,
}: NetworksViewProps) {
  return (
    <div className="space-y-6">
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Host Network Adapters
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Real network interfaces detected by the operating system. NetFusion reads status passively without changing your system routes.
          </p>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-xs text-right">
            <div className="text-slate-500 dark:text-slate-400">Internet Check</div>
            <div
              className={`font-semibold font-mono tabular-nums ${
                internetStatus === 'online'
                  ? 'text-emerald-700 dark:text-emerald-400'
                  : internetStatus === 'offline'
                    ? 'text-red-700 dark:text-red-400'
                    : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              {internetStatus === 'online' && internetLatencyMs !== null
                ? `Online · ${internetLatencyMs.toFixed(1)} ms`
                : internetStatus === 'offline'
                  ? 'Offline'
                  : 'Not Configured'}
            </div>
          </div>

          <button
            type="button"
            onClick={onCheckNetwork}
            disabled={checkingNetwork}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${checkingNetwork ? 'animate-spin' : ''}`} />
            <span>{checkingNetwork ? 'Checking...' : 'Check Connection'}</span>
          </button>
        </div>
      </section>

      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                <th className="py-3 px-4">Interface</th>
                <th className="py-3 px-4">Type</th>
                <th className="py-3 px-4">IP / MAC Address</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Download / Upload</th>
                <th className="py-3 px-4 text-right">Ping</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
              {interfaces.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                    Not Configured — no active network interfaces detected on this host.
                  </td>
                </tr>
              ) : (
                interfaces.map((iface) => {
                  const m = iface.latest_metric;
                  const ratesAvailable = m && m.download_mbps !== null && m.upload_mbps !== null;
                  return (
                    <tr key={iface.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="py-3.5 px-4 font-medium text-slate-900 dark:text-slate-100">
                        {iface.display_name}
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-600 dark:text-slate-300">
                        {formatKindLabel(iface.kind)}
                      </td>
                      <td className="py-3.5 px-4 font-mono tabular-nums text-xs text-slate-600 dark:text-slate-300">
                        <div>{iface.ip_address}</div>
                        <div className="text-slate-400 dark:text-slate-500">{iface.mac_address}</div>
                      </td>
                      <td className="py-3.5 px-4 text-xs font-semibold">
                        <span
                          className={
                            iface.status === 'healthy'
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : iface.status === 'degraded'
                                ? 'text-amber-700 dark:text-amber-400'
                                : 'text-red-700 dark:text-red-400'
                          }
                        >
                          {iface.status === 'healthy'
                            ? 'Up'
                            : iface.status === 'degraded'
                              ? 'No Internet'
                              : 'Offline'}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-xs text-slate-700 dark:text-slate-300">
                        {ratesAvailable
                          ? `${m.download_mbps?.toFixed(2)} / ${m.upload_mbps?.toFixed(2)} Mbps`
                          : 'Unavailable'}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-xs text-slate-700 dark:text-slate-300">
                        {m && m.latency_ms !== null ? `${m.latency_ms.toFixed(1)} ms` : 'Unavailable'}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
