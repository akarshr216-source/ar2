import { useState, type FormEvent } from 'react';
import { Lock, QrCode, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import type { AdminAuthStatus, PairedDevice, PairingStatusSummary } from '../types/netfusion';

interface DevicesViewProps {
  clients: PairedDevice[];
  clientsLoading: boolean;
  clientsError: string | null;
  pairingStatus: PairingStatusSummary | null;
  adminAuthStatus: AdminAuthStatus;
  isAdminAuthenticated: boolean;
  onClaimAdmin: (passcode: string) => Promise<void>;
  onLoginAdmin: (passcode: string) => Promise<void>;
  onLogoutAdmin: () => Promise<void>;
  onRefreshClients: () => Promise<void>;
  onOpenAddDevice: () => void;
  onRevokeClient: (id: string) => Promise<void>;
}

function formatRelativeTime(iso: string): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (diffSec < 5) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  return new Date(iso).toLocaleString();
}

function formatTraffic(dev: PairedDevice): string {
  if (dev.download_bps === null && dev.upload_bps === null && dev.rx_bytes === null && dev.tx_bytes === null) {
    return 'Unavailable';
  }
  const fmtRate = (bps: number | null) => {
    if (bps === null) return '—';
    const mbps = (bps * 8) / 1_000_000;
    return mbps >= 1 ? `${mbps.toFixed(1)} Mbps` : `${((bps * 8) / 1000).toFixed(0)} Kbps`;
  };
  return `${fmtRate(dev.download_bps)} ↓ · ${fmtRate(dev.upload_bps)} ↑`;
}

export function DevicesView({
  clients,
  clientsLoading,
  clientsError,
  pairingStatus,
  adminAuthStatus,
  isAdminAuthenticated,
  onClaimAdmin,
  onLoginAdmin,
  onLogoutAdmin,
  onRefreshClients,
  onOpenAddDevice,
  onRevokeClient,
}: DevicesViewProps) {
  const [passcode, setPasscode] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const handleAuthSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthSubmitting(true);
    try {
      if (!adminAuthStatus.claimed) {
        await onClaimAdmin(passcode);
      } else {
        await onLoginAdmin(passcode);
      }
      setPasscode('');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setAuthSubmitting(false);
    }
  };

  if (!isAdminAuthenticated) {
    return (
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 max-w-lg space-y-4">
        <div className="flex items-center gap-2.5 text-slate-900 dark:text-slate-100">
          <Lock className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          <h2 className="text-base font-semibold">
            {adminAuthStatus.claimed ? 'Unlock Devices' : 'Set Administrator Password'}
          </h2>
        </div>

        <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
          {adminAuthStatus.claimed
            ? 'Enter your administrator password to view connected devices, scan new devices in, or remove old devices.'
            : 'Create an administrator password before adding your first device. This prevents unknown devices from joining without your QR code.'}
        </p>

        <form onSubmit={handleAuthSubmit} className="space-y-3">
          <input
            type="password"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            placeholder={
              adminAuthStatus.claimed
                ? 'Enter administrator password'
                : 'Create password (min 6 characters)'
            }
            minLength={6}
            required
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
          />

          {authError && <p className="text-xs text-red-600 dark:text-red-400">{authError}</p>}

          <button
            type="submit"
            disabled={authSubmitting}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white transition-colors"
          >
            {authSubmitting
              ? 'Verifying...'
              : adminAuthStatus.claimed
                ? 'Unlock Devices'
                : 'Save Password & Unlock'}
          </button>
        </form>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Paired & Connected Devices
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {pairingStatus
                ? `${pairingStatus.connected_devices} connected · ${pairingStatus.disconnected_devices} disconnected · Offline timeout ${pairingStatus.heartbeat_timeout_seconds}s`
                : 'Live heartbeat status'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void onRefreshClients()}
              disabled={clientsLoading}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${clientsLoading ? 'animate-spin' : ''}`} />
              <span>{clientsLoading ? 'Refreshing...' : 'Refresh'}</span>
            </button>

            <button
              type="button"
              onClick={onOpenAddDevice}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white whitespace-nowrap"
            >
              <QrCode className="w-3.5 h-3.5" />
              <span>Add Device</span>
            </button>

            <button
              type="button"
              onClick={() => void onLogoutAdmin()}
              className="px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              Lock
            </button>
          </div>
        </div>

        {clientsError && (
          <div className="px-5 py-3 bg-red-50 dark:bg-red-950/30 border-b border-red-200 dark:border-red-900 flex items-center justify-between text-xs text-red-700 dark:text-red-400">
            <span>{clientsError}</span>
            <button type="button" onClick={() => void onRefreshClients()} className="font-semibold underline">
              Retry
            </button>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                <th className="py-3 px-4">Device Name</th>
                <th className="py-3 px-4">Device Type</th>
                <th className="py-3 px-4">Local IP</th>
                <th className="py-3 px-4">Pairing</th>
                <th className="py-3 px-4">Connection Status</th>
                <th className="py-3 px-4">Download / Upload</th>
                <th className="py-3 px-4">Last Seen</th>
                <th className="py-3 px-4 text-right">Remove</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
              {clientsLoading && clients.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                    Loading paired devices...
                  </td>
                </tr>
              ) : clients.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 px-6 text-center">
                    <div className="max-w-md mx-auto space-y-3">
                      <ShieldCheck className="w-7 h-7 mx-auto text-slate-400 dark:text-slate-500" />
                      <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        No devices registered yet
                      </div>
                      <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                        Click Add Device to display a 2-minute QR code and scan it from your Android phone on this Wi-Fi network.
                      </p>
                      <button
                        type="button"
                        onClick={onOpenAddDevice}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white"
                      >
                        <QrCode className="w-3.5 h-3.5" />
                        <span>Add Device</span>
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                clients.map((client) => {
                  const isConnected = client.connection_status === 'connected';
                  return (
                    <tr key={client.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="py-3.5 px-4">
                        <div className="font-medium text-slate-900 dark:text-slate-100">
                          {client.name}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          {client.device_model} · v{client.app_version}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-600 dark:text-slate-300 capitalize">
                        {client.platform === 'android' ? 'Android Phone' : 'Windows PC'}
                      </td>
                      <td className="py-3.5 px-4 font-mono tabular-nums text-xs text-slate-700 dark:text-slate-300">
                        {client.ip_address}
                      </td>
                      <td className="py-3.5 px-4 text-xs font-medium text-slate-700 dark:text-slate-300 capitalize">
                        {client.pairing_status}
                      </td>
                      <td className="py-3.5 px-4 text-xs font-semibold">
                        <span
                          className={
                            isConnected
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-red-700 dark:text-red-400'
                          }
                        >
                          {isConnected ? 'Connected' : 'Disconnected'}
                        </span>
                      </td>
                      <td className="py-3.5 px-4 font-mono tabular-nums text-xs text-slate-600 dark:text-slate-300">
                        {formatTraffic(client)}
                      </td>
                      <td className="py-3.5 px-4 font-mono tabular-nums text-xs text-slate-500 dark:text-slate-400">
                        <div>{formatRelativeTime(client.last_seen_at)}</div>
                        <div className="text-[11px] text-slate-400 dark:text-slate-500">
                          {new Date(client.last_seen_at).toLocaleTimeString()}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => void onRevokeClient(client.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded border border-slate-200 dark:border-slate-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Remove</span>
                        </button>
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
