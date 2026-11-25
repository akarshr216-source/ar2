import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { NetworkInterfaceItem, UsageStat } from '../types/netfusion';

interface InterfacesViewProps {
  interfaces: NetworkInterfaceItem[];
  usage: UsageStat[];
  probingId: string | null;
  onUpdateWeight: (id: string, weight: number) => void;
  onToggleEnabled: (id: string, enabled: boolean) => void;
  onToggleSimDown: (id: string, simDown: boolean) => void;
  onProbe: (id: string) => void;
}

export function InterfacesView({
  interfaces,
  usage,
  probingId,
  onUpdateWeight,
  onToggleEnabled,
  onToggleSimDown,
  onProbe,
}: InterfacesViewProps) {
  const [query, setQuery] = useState('');
  const [filterMode, setFilterMode] = useState<'all' | 'host' | 'wan'>('all');

  const usageMap = useMemo(() => new Map(usage.map((u) => [u.interface_id, u])), [usage]);

  const filtered = useMemo(() => {
    return interfaces.filter((iface) => {
      if (filterMode === 'host' && !iface.is_host_detected) return false;
      if (filterMode === 'wan' && iface.is_host_detected) return false;
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      return (
        iface.display_name.toLowerCase().includes(q) ||
        iface.provider.toLowerCase().includes(q) ||
        iface.system_name.toLowerCase().includes(q) ||
        iface.ip_address.includes(q)
      );
    });
  }, [interfaces, filterMode, query]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by adapter, provider, or IP..."
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-2 focus:outline-blue-600"
          />
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg self-start">
          {(
            [
              { id: 'all', label: 'All Adapters' },
              { id: 'host', label: 'OS Detected' },
              { id: 'wan', label: 'WAN Profiles' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilterMode(tab.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                filterMode === tab.id
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                <th className="py-3 px-4">Adapter / Provider</th>
                <th className="py-3 px-4">IP / MAC</th>
                <th className="py-3 px-4">State</th>
                <th className="py-3 px-4 text-right">Down / Up</th>
                <th className="py-3 px-4 text-right">RTT / Loss</th>
                <th className="py-3 px-4">Scheduler Weight</th>
                <th className="py-3 px-4 text-right">Today Usage</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                    No matching network interfaces found.
                  </td>
                </tr>
              ) : (
                filtered.map((iface) => {
                  const m = iface.latest_metric;
                  const u = usageMap.get(iface.id);
                  return (
                    <tr
                      key={iface.id}
                      className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
                    >
                      <td className="py-3.5 px-4">
                        <div className="font-medium text-slate-900 dark:text-slate-100">
                          {iface.display_name}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          {iface.provider} · {iface.system_name}
                          {iface.is_host_detected ? ' · Host NIC' : ''}
                        </div>
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
                                : iface.status === 'offline'
                                  ? 'text-red-700 dark:text-red-400'
                                  : 'text-slate-500 dark:text-slate-400'
                          }
                        >
                          {iface.status.charAt(0).toUpperCase() + iface.status.slice(1)}
                        </span>
                        <div className="font-mono tabular-nums font-normal text-slate-500 dark:text-slate-400 mt-0.5">
                          Share {iface.traffic_share_pct}%
                        </div>
                      </td>

                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-xs text-slate-900 dark:text-slate-100">
                        <div>{(m?.download_mbps ?? 0).toFixed(1)} Mbps</div>
                        <div className="text-slate-500 dark:text-slate-400">
                          {(m?.upload_mbps ?? 0).toFixed(1)} Mbps
                        </div>
                      </td>

                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-xs text-slate-900 dark:text-slate-100">
                        <div>{(m?.latency_ms ?? 0).toFixed(1)} ms</div>
                        <div className="text-slate-500 dark:text-slate-400">
                          {(m?.packet_loss_pct ?? 0).toFixed(1)}% loss
                        </div>
                      </td>

                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-2">
                          <input
                            type="range"
                            min={10}
                            max={100}
                            step={5}
                            aria-label={`Scheduler weight for ${iface.display_name}`}
                            value={iface.weight}
                            onChange={(e) => onUpdateWeight(iface.id, Number(e.target.value))}
                            className="w-20 accent-blue-600"
                          />
                          <span className="text-xs font-mono tabular-nums text-slate-700 dark:text-slate-300 w-8">
                            {iface.weight}
                          </span>
                        </div>
                      </td>

                      <td className="py-3.5 px-4 text-right font-mono tabular-nums text-xs text-slate-600 dark:text-slate-300">
                        <div>{((u?.rx_mb ?? 0) + (u?.tx_mb ?? 0)).toFixed(1)} MB</div>
                      </td>

                      <td className="py-3.5 px-4 text-right">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => onProbe(iface.id)}
                            disabled={probingId === iface.id}
                            className="px-2.5 py-1 text-xs font-medium rounded border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                          >
                            {probingId === iface.id ? 'Probing...' : 'Probe'}
                          </button>
                          <button
                            type="button"
                            onClick={() => onToggleSimDown(iface.id, !iface.simulated_down)}
                            className="px-2.5 py-1 text-xs font-medium rounded border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                          >
                            {iface.simulated_down ? 'Restore' : 'Drop'}
                          </button>
                          <button
                            type="button"
                            onClick={() => onToggleEnabled(iface.id, !iface.enabled)}
                            className="px-2.5 py-1 text-xs font-medium rounded border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                          >
                            {iface.enabled ? 'Disable' : 'Enable'}
                          </button>
                        </div>
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
