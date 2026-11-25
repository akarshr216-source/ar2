import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, KeyRound, Lock, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import type {
  AdminAuthStatus,
  GeneratedPairingCode,
  PairedDevice,
  PairingStatusSummary,
} from '../types/netfusion';

interface ClientsViewProps {
  clients: PairedDevice[];
  clientsLoading: boolean;
  clientsError: string | null;
  pairingStatus: PairingStatusSummary | null;
  adminAuthStatus: AdminAuthStatus;
  isAdminAuthenticated: boolean;
  serverPort: number;
  lanAddresses: string[];
  onClaimAdmin: (passcode: string) => Promise<void>;
  onLoginAdmin: (passcode: string) => Promise<void>;
  onLogoutAdmin: () => Promise<void>;
  onRefreshClients: () => Promise<void>;
  onGeneratePairingCode: (
    platformHint: 'any' | 'android' | 'windows',
  ) => Promise<GeneratedPairingCode>;
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

export function ClientsView({
  clients,
  clientsLoading,
  clientsError,
  pairingStatus,
  adminAuthStatus,
  isAdminAuthenticated,
  serverPort,
  lanAddresses,
  onClaimAdmin,
  onLoginAdmin,
  onLogoutAdmin,
  onRefreshClients,
  onGeneratePairingCode,
  onRevokeClient,
}: ClientsViewProps) {
  const [passcode, setPasscode] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const [platformHint, setPlatformHint] = useState<'any' | 'android' | 'windows'>('android');
  const [generatedCode, setGeneratedCode] = useState<GeneratedPairingCode | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number>(0);

  useEffect(() => {
    if (!generatedCode) {
      setSecondsLeft(0);
      return;
    }
    const updateCountdown = () => {
      const rem = Math.max(0, Math.floor((Date.parse(generatedCode.expires_at) - Date.now()) / 1000));
      setSecondsLeft(rem);
    };
    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);
    return () => clearInterval(timer);
  }, [generatedCode]);

  // Clear generated code card once a paired device consumes it (active_codes drops to 0)
  useEffect(() => {
    if (generatedCode && pairingStatus && pairingStatus.active_codes === 0 && clients.length > 0) {
      setGeneratedCode(null);
    }
  }, [generatedCode, pairingStatus, clients.length]);

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

  const handleGenerate = async () => {
    setGenerateError(null);
    setGenerating(true);
    try {
      const result = await onGeneratePairingCode(platformHint);
      setGeneratedCode(result);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Could not generate pairing code');
    } finally {
      setGenerating(false);
    }
  };

  const handleCopyCode = async () => {
    if (!generatedCode) return;
    await navigator.clipboard.writeText(generatedCode.pairing_code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 1800);
  };

  if (!isAdminAuthenticated) {
    return (
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 max-w-lg space-y-4">
        <div className="flex items-center gap-2.5 text-slate-900 dark:text-slate-100">
          <Lock className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          <h2 className="text-base font-semibold">
            {adminAuthStatus.claimed
              ? 'Unlock Device Management'
              : 'Configure Administrator Passcode'}
          </h2>
        </div>

        <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
          {adminAuthStatus.claimed
            ? 'Device registration, pairing code generation, and client revocation require administrator authorization.'
            : 'Set a local administrator passcode to protect device pairing and connected-client management. Only real paired devices will appear after authorization.'}
        </p>

        <form onSubmit={handleAuthSubmit} className="space-y-3">
          <input
            type="password"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            placeholder={
              adminAuthStatus.claimed
                ? 'Enter administrator passcode'
                : 'Create administrator passcode (min 6 chars)'
            }
            minLength={6}
            required
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
          />

          {authError && (
            <p className="text-xs text-red-600 dark:text-red-400">{authError}</p>
          )}

          <button
            type="submit"
            disabled={authSubmitting}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white transition-colors"
          >
            {authSubmitting
              ? 'Verifying...'
              : adminAuthStatus.claimed
                ? 'Unlock Devices'
                : 'Save Passcode & Unlock'}
          </button>
        </form>
      </section>
    );
  }

  const displayLanIps = (generatedCode?.lan_addresses?.length
    ? generatedCode.lan_addresses
    : lanAddresses
  ).filter((ip) => ip !== '127.0.0.1');

  return (
    <div className="space-y-6">
      {/* Pairing Code Generator Section */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Device Pairing & Registration
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Devices appear only after pairing with an expiring single-use code over your local network.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={platformHint}
              onChange={(e) => setPlatformHint(e.target.value as 'any' | 'android' | 'windows')}
              aria-label="Target device platform"
              className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
            >
              <option value="android">Android Device</option>
              <option value="windows">Windows Client</option>
              <option value="any">Any Platform</option>
            </select>

            <button
              type="button"
              onClick={() => void handleGenerate()}
              disabled={generating}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{generating ? 'Generating...' : 'Pair New Device'}</span>
            </button>

            <button
              type="button"
              onClick={() => void onLogoutAdmin()}
              className="px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              Lock Admin
            </button>
          </div>
        </div>

        {generateError && (
          <p className="text-xs text-red-600 dark:text-red-400">{generateError}</p>
        )}

        {generatedCode && (
          <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-slate-100">
                <KeyRound className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <span>Pending Pairing Code ({generatedCode.platform_hint})</span>
              </div>

              <div className="flex items-center gap-3">
                <span className="text-xs font-mono tabular-nums text-amber-700 dark:text-amber-400">
                  {secondsLeft > 0
                    ? `Expires in ${Math.floor(secondsLeft / 60)}m ${secondsLeft % 60}s`
                    : 'Expired — generate a new code'}
                </span>
                <button
                  type="button"
                  onClick={handleCopyCode}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200"
                >
                  {copiedCode ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  <span>{copiedCode ? 'Copied' : 'Copy Code'}</span>
                </button>
              </div>
            </div>

            <div className="text-2xl font-mono font-bold tracking-wider text-blue-700 dark:text-blue-400 select-all">
              {generatedCode.pairing_code}
            </div>

            <div className="text-xs text-slate-600 dark:text-slate-400 space-y-1">
              <div>
                Enter this single-use code in the NetFusion Android or Windows app along with your server LAN URL:
              </div>
              <div className="font-mono text-slate-800 dark:text-slate-200">
                {displayLanIps.length > 0
                  ? displayLanIps.map((ip) => `http://${ip}:${serverPort}`).join('  ·  ')
                  : `http://<YOUR_PC_LAN_IP>:${serverPort}`}
              </div>
            </div>
          </div>
        )}

        {!generatedCode && pairingStatus && pairingStatus.active_codes > 0 && (
          <div className="text-xs text-amber-700 dark:text-amber-400 flex items-center justify-between border-t border-slate-100 dark:border-slate-800 pt-3">
            <span>
              Pending pairing code active ({pairingStatus.latest_code_hint}) — waiting for client registration.
            </span>
            <span className="font-mono tabular-nums">
              Expires {new Date(pairingStatus.latest_code_expires_at || '').toLocaleTimeString()}
            </span>
          </div>
        )}
      </section>

      {/* Connected Devices Registry Table */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Connected Devices
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {pairingStatus
                ? `${pairingStatus.connected_devices} connected · ${pairingStatus.disconnected_devices} disconnected · Timeout ${pairingStatus.heartbeat_timeout_seconds}s`
                : 'Real-time heartbeat registry'}
            </p>
          </div>

          <button
            type="button"
            onClick={() => void onRefreshClients()}
            disabled={clientsLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${clientsLoading ? 'animate-spin' : ''}`} />
            <span>{clientsLoading ? 'Refreshing...' : 'Refresh Devices'}</span>
          </button>
        </div>

        {clientsError && (
          <div className="px-5 py-3 bg-red-50 dark:bg-red-950/30 border-b border-red-200 dark:border-red-900 flex items-center justify-between text-xs text-red-700 dark:text-red-400">
            <span>{clientsError}</span>
            <button
              type="button"
              onClick={() => void onRefreshClients()}
              className="font-semibold underline"
            >
              Retry
            </button>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-500 dark:text-slate-400">
                <th className="py-3 px-4">Device Name</th>
                <th className="py-3 px-4">Platform</th>
                <th className="py-3 px-4">Device Model</th>
                <th className="py-3 px-4">Local IP Address</th>
                <th className="py-3 px-4">Pairing Status</th>
                <th className="py-3 px-4">Connection Status</th>
                <th className="py-3 px-4">Last Seen</th>
                <th className="py-3 px-4 text-right">Remove</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
              {clientsLoading && clients.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">
                    Loading registered devices...
                  </td>
                </tr>
              ) : clients.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 px-6 text-center">
                    <div className="max-w-md mx-auto space-y-3">
                      <ShieldCheck className="w-7 h-7 mx-auto text-slate-400 dark:text-slate-500" />
                      <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        No paired devices registered
                      </div>
                      <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                        NetFusion never displays unverified Wi-Fi neighbors or experimental placeholder phones. Generate a temporary pairing code and register your Android or Windows client to see it here.
                      </p>
                      <button
                        type="button"
                        onClick={() => void handleGenerate()}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Pair New Device</span>
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
                        <div className="text-xs font-mono text-slate-400 dark:text-slate-500">
                          v{client.app_version}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-600 dark:text-slate-300 capitalize">
                        {client.platform}
                      </td>
                      <td className="py-3.5 px-4 text-xs text-slate-700 dark:text-slate-300">
                        {client.device_model}
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
