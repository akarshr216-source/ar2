import { useState } from 'react';
import type { NetFusionSettings, SystemEvent } from '../types/netfusion';

interface SettingsViewProps {
  settings: NetFusionSettings;
  events: SystemEvent[];
  apiBaseUrl: string;
  onChangeApiBaseUrl: (url: string) => void;
  onUpdateSettings: (patch: Partial<NetFusionSettings>) => void;
  onSetGatewayMode: (enabled: boolean) => void;
}

export function SettingsView({
  settings,
  events,
  apiBaseUrl,
  onChangeApiBaseUrl,
  onUpdateSettings,
  onSetGatewayMode,
}: SettingsViewProps) {
  const [apiUrlDraft, setApiUrlDraft] = useState(apiBaseUrl);

  return (
    <div className="space-y-6">
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Server & Device Heartbeat Configuration
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Persisted in local SQLite storage without plaintext credentials.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              Appearance Theme
            </span>
            <select
              value={settings.theme}
              onChange={(e) =>
                onUpdateSettings({ theme: e.target.value as NetFusionSettings['theme'] })
              }
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            >
              <option value="system">System Default</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              Load Balancing Algorithm
            </span>
            <select
              value={settings.load_balancing_algorithm}
              onChange={(e) =>
                onUpdateSettings({
                  load_balancing_algorithm: e.target
                    .value as NetFusionSettings['load_balancing_algorithm'],
                })
              }
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            >
              <option value="weighted_health">Weighted Health Score</option>
              <option value="lowest_latency">Lowest Latency First</option>
              <option value="round_robin">Equal Round Robin</option>
            </select>
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              Monitor Interval (seconds)
            </span>
            <input
              type="number"
              min={1}
              max={30}
              value={settings.monitor_interval_seconds}
              onChange={(e) =>
                onUpdateSettings({ monitor_interval_seconds: Number(e.target.value) || 3 })
              }
              className="w-full px-3 py-2 text-sm font-mono tabular-nums rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              Device Heartbeat Timeout (seconds)
            </span>
            <input
              type="number"
              min={5}
              max={300}
              value={settings.heartbeat_timeout_seconds}
              onChange={(e) =>
                onUpdateSettings({ heartbeat_timeout_seconds: Number(e.target.value) || 15 })
              }
              className="w-full px-3 py-2 text-sm font-mono tabular-nums rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              Pairing Code Expiry TTL (seconds)
            </span>
            <input
              type="number"
              min={30}
              max={900}
              value={settings.pairing_code_ttl_seconds}
              onChange={(e) =>
                onUpdateSettings({ pairing_code_ttl_seconds: Number(e.target.value) || 300 })
              }
              className="w-full px-3 py-2 text-sm font-mono tabular-nums rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              Windows Server Port (Go Service)
            </span>
            <input
              type="number"
              min={1024}
              max={65535}
              value={settings.server_port}
              onChange={(e) =>
                onUpdateSettings({ server_port: Number(e.target.value) || 8080 })
              }
              className="w-full px-3 py-2 text-sm font-mono tabular-nums rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </label>
        </div>

        <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-2">
          <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
            Dashboard API Base URL (optional override for remote LAN Windows server)
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={apiUrlDraft}
              onChange={(e) => setApiUrlDraft(e.target.value)}
              placeholder="Same origin (leave empty) or e.g. http://192.168.1.10:8080"
              className="flex-1 px-3 py-2 text-sm font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
            <button
              type="button"
              onClick={() => onChangeApiBaseUrl(apiUrlDraft)}
              className="px-4 py-2 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              Apply Endpoint
            </button>
          </div>
        </div>

        <div className="divide-y divide-slate-100 dark:divide-slate-800 border-t border-slate-100 dark:border-slate-800 pt-2">
          <div className="py-3 flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Automatic Failover
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Move new sessions away from offline or high-loss uplinks automatically.
              </div>
            </div>
            <button
              type="button"
              onClick={() => onUpdateSettings({ automatic_failover: !settings.automatic_failover })}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                settings.automatic_failover
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
              }`}
            >
              {settings.automatic_failover ? 'Enabled' : 'Disabled'}
            </button>
          </div>

          <div className="py-3 flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                LAN-Only Administration Binding
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Restrict API binding to local network interfaces rather than public exposure.
              </div>
            </div>
            <button
              type="button"
              onClick={() => onUpdateSettings({ lan_only: !settings.lan_only })}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                settings.lan_only
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
              }`}
            >
              {settings.lan_only ? 'LAN Only' : 'All Interfaces'}
            </button>
          </div>

          <div className="py-3 flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Gateway Routing Mode
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                Disabled by default at startup so system routes remain untouched until explicitly enabled.
              </div>
            </div>
            <button
              type="button"
              onClick={() => onSetGatewayMode(!settings.gateway_mode)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                settings.gateway_mode
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
              }`}
            >
              {settings.gateway_mode ? 'Gateway Active' : 'Monitoring Only'}
            </button>
          </div>
        </div>
      </section>

      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 mb-3">
          System Events Audit Log
        </h2>
        <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-96 overflow-y-auto">
          {events.map((evt) => (
            <div key={evt.id} className="py-2.5 flex items-baseline justify-between gap-4 text-xs">
              <div className="flex items-baseline gap-3 min-w-0">
                <span
                  className={`font-semibold uppercase shrink-0 ${
                    evt.level === 'error'
                      ? 'text-red-600 dark:text-red-400'
                      : evt.level === 'warning'
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-blue-600 dark:text-blue-400'
                  }`}
                >
                  {evt.category}
                </span>
                <span className="text-slate-700 dark:text-slate-300">{evt.message}</span>
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
