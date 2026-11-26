import { useState } from 'react';
import type { NetFusionSettings, SystemEvent } from '../types/netfusion';

interface SettingsViewProps {
  settings: NetFusionSettings;
  events: SystemEvent[];
  apiBaseUrl: string;
  publicUrl: string | null;
  backendMode: 'go' | 'node' | null;
  onChangeApiBaseUrl: (url: string) => void;
  onUpdateSettings: (patch: Partial<NetFusionSettings>) => void;
}

function isRemoteHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:') return false;
    const h = parsed.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) return false;
    const parts = h.split('.').map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      if (parts[0] === 10 || parts[0] === 127) return false;
      if (parts[0] === 192 && parts[1] === 168) return false;
      if (parts[0] === 169 && parts[1] === 254) return false;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function SettingsView({
  settings,
  events,
  apiBaseUrl,
  publicUrl,
  backendMode,
  onChangeApiBaseUrl,
  onUpdateSettings,
}: SettingsViewProps) {
  const [apiUrlDraft, setApiUrlDraft] = useState(apiBaseUrl);

  return (
    <div className="space-y-6">
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              NetFusion Settings
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Settings are saved automatically in the local database.
            </p>
          </div>
          <div className="text-xs font-mono text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800">
            API: {backendMode === 'go' ? 'Go Server' : 'Node Server'} · QR Target: {publicUrl ?? 'Not Configured'}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              Appearance
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
              Device Disconnect Timeout (seconds)
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
              QR Code Expiry Time (seconds)
            </span>
            <input
              type="number"
              min={30}
              max={600}
              value={settings.pairing_code_ttl_seconds}
              onChange={(e) =>
                onUpdateSettings({ pairing_code_ttl_seconds: Number(e.target.value) || 120 })
              }
              className="w-full px-3 py-2 text-sm font-mono tabular-nums rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
          </label>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              Windows Server Port
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

        <div className="pt-4 border-t border-slate-100 dark:border-slate-800 space-y-2">
          <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
            Remote Server Address (Optional)
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Leave blank when using this PC directly. Enter your Windows LAN URL (e.g. http://192.168.1.25:8080) or an HTTPS address when managing remotely.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={apiUrlDraft}
              onChange={(e) => setApiUrlDraft(e.target.value)}
              placeholder="Same computer (leave empty)"
              className="flex-1 px-3 py-2 text-sm font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            />
            <button
              type="button"
              onClick={() => onChangeApiBaseUrl(apiUrlDraft)}
              className="px-4 py-2 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              Apply
            </button>
          </div>
          {isRemoteHttpUrl(apiUrlDraft) && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Use HTTPS when connecting to a server outside your local Wi-Fi network.
            </p>
          )}
        </div>

        <div className="pt-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
              Local Network Admin Protection
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Blocks admin access from the public internet and allows only this PC or your local Wi-Fi network.
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
            {settings.lan_only ? 'Local Network Only' : 'Allow All'}
          </button>
        </div>
      </section>

      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 mb-3">
          Recent Activity
        </h2>
        {events.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">No recent events recorded yet.</p>
        ) : (
          <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-80 overflow-y-auto">
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
        )}
      </section>
    </div>
  );
}
