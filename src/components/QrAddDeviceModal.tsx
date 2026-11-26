import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, Copy, Lock, QrCode, RefreshCw, X } from 'lucide-react';
import QRCode from 'qrcode';
import type { AdminAuthStatus, GeneratedPairingCode, PairingStatusSummary } from '../types/netfusion';

interface QrAddDeviceModalProps {
  open: boolean;
  onClose: () => void;
  apiBaseUrl: string;
  serverPort: number;
  lanAddresses: string[];
  adminAuthStatus: AdminAuthStatus;
  isAdminAuthenticated: boolean;
  pairingStatus: PairingStatusSummary | null;
  onClaimAdmin: (passcode: string) => Promise<void>;
  onLoginAdmin: (passcode: string) => Promise<void>;
  onGeneratePairingCode: (options?: {
    platformHint?: 'any' | 'android' | 'windows';
    ttlSeconds?: number;
    serverUrl?: string;
  }) => Promise<GeneratedPairingCode>;
}

function isLocalOrLanUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) return true;
    const parts = h.split('.').map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      if (parts[0] === 10 || parts[0] === 127) return true;
      if (parts[0] === 192 && parts[1] === 168) return true;
      if (parts[0] === 169 && parts[1] === 254) return true;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function QrAddDeviceModal({
  open,
  onClose,
  apiBaseUrl,
  serverPort,
  lanAddresses,
  adminAuthStatus,
  isAdminAuthenticated,
  pairingStatus,
  onClaimAdmin,
  onLoginAdmin,
  onGeneratePairingCode,
}: QrAddDeviceModalProps) {
  const [passcode, setPasscode] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);

  const availableServerUrls = useMemo(() => {
    const urls: string[] = [];
    if (apiBaseUrl) {
      urls.push(apiBaseUrl);
    }
    for (const ip of lanAddresses) {
      if (ip && ip !== '127.0.0.1') {
        const candidate = `http://${ip}:${serverPort}`;
        if (!urls.includes(candidate)) {
          urls.push(candidate);
        }
      }
    }
    if (typeof window !== 'undefined' && urls.length === 0) {
      urls.push(window.location.origin);
    }
    return urls;
  }, [apiBaseUrl, lanAddresses, serverPort]);

  const [selectedServerUrl, setSelectedServerUrl] = useState<string>('');
  const [generated, setGenerated] = useState<GeneratedPairingCode | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [showManual, setShowManual] = useState(false);
  const [copiedField, setCopiedField] = useState<'code' | 'url' | null>(null);
  const [pairedSuccess, setPairedSuccess] = useState(false);
  const [initialDeviceCount, setInitialDeviceCount] = useState<number | null>(null);

  useEffect(() => {
    if (!selectedServerUrl && availableServerUrls.length > 0) {
      setSelectedServerUrl(availableServerUrls[0]);
    }
  }, [availableServerUrls, selectedServerUrl]);

  const qrPayload = useMemo(() => {
    if (!generated || !selectedServerUrl.trim()) return '';
    const cleanServer = selectedServerUrl.trim().replace(/\/+$/, '');
    return `netfusion://pair?server=${encodeURIComponent(cleanServer)}&pairing_id=${encodeURIComponent(generated.pairing_id)}&secret=${encodeURIComponent(generated.secret)}`;
  }, [generated, selectedServerUrl]);

  useEffect(() => {
    if (!qrPayload) {
      setQrDataUrl('');
      return;
    }
    let active = true;
    void QRCode.toDataURL(qrPayload, {
      width: 240,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
    })
      .then((url) => {
        if (active) setQrDataUrl(url);
      })
      .catch(() => {
        if (active) setQrDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [qrPayload]);

  const generateNewQr = useCallback(async () => {
    if (!isAdminAuthenticated) return;
    setGenerating(true);
    setGenerateError(null);
    setPairedSuccess(false);
    try {
      const result = await onGeneratePairingCode({
        platformHint: 'any',
        ttlSeconds: 120,
        serverUrl: selectedServerUrl || availableServerUrls[0],
      });
      setGenerated(result);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Unable to generate pairing QR code');
    } finally {
      setGenerating(false);
    }
  }, [availableServerUrls, isAdminAuthenticated, onGeneratePairingCode, selectedServerUrl]);

  useEffect(() => {
    if (open && isAdminAuthenticated && !generated && !generating) {
      setInitialDeviceCount(pairingStatus?.registered_devices ?? null);
      void generateNewQr();
    }
    if (!open) {
      setGenerated(null);
      setQrDataUrl('');
      setGenerateError(null);
      setPairedSuccess(false);
      setInitialDeviceCount(null);
      setShowManual(false);
    }
  }, [open, isAdminAuthenticated, generated, generating, generateNewQr, pairingStatus?.registered_devices]);

  useEffect(() => {
    if (!generated) {
      setSecondsLeft(0);
      return;
    }
    const update = () => {
      const remaining = Math.max(0, Math.floor((Date.parse(generated.expires_at) - Date.now()) / 1000));
      setSecondsLeft(remaining);
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [generated]);

  useEffect(() => {
    if (
      open &&
      generated &&
      initialDeviceCount !== null &&
      pairingStatus &&
      pairingStatus.registered_devices > initialDeviceCount
    ) {
      setPairedSuccess(true);
    }
  }, [open, generated, initialDeviceCount, pairingStatus]);

  if (!open) return null;

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

  const handleCopy = async (text: string, field: 'code' | 'url') => {
    await navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1800);
  };

  const showHttpsWarning =
    selectedServerUrl.startsWith('http://') && !isLocalOrLanUrl(selectedServerUrl);

  const minutes = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-device-title"
    >
      <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <QrCode className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <h2 id="add-device-title" className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Add Device via QR Code
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Add Device"
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {!isAdminAuthenticated ? (
            <form onSubmit={handleAuthSubmit} className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                <Lock className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <span>
                  {adminAuthStatus.claimed
                    ? 'Enter your NetFusion password'
                    : 'Create an administrator password'}
                </span>
              </div>
              <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                {adminAuthStatus.claimed
                  ? 'Only an authorized user on your local network can generate pairing QR codes.'
                  : 'Set a password (minimum 6 characters) so unknown devices cannot pair without your permission.'}
              </p>
              <input
                type="password"
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                placeholder={adminAuthStatus.claimed ? 'Administrator password' : 'Create password (min 6 chars)'}
                minLength={6}
                required
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              />
              {authError && <p className="text-xs text-red-600 dark:text-red-400">{authError}</p>}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={authSubmitting}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white"
                >
                  {authSubmitting ? 'Checking...' : 'Continue'}
                </button>
              </div>
            </form>
          ) : pairedSuccess ? (
            <div className="py-6 text-center space-y-3">
              <div className="w-10 h-10 mx-auto rounded-lg bg-emerald-50 dark:bg-emerald-950/50 flex items-center justify-center text-emerald-700 dark:text-emerald-400">
                <Check className="w-5 h-5" />
              </div>
              <div className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Device Paired
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 max-w-sm mx-auto">
                Your device registered with the server. Its live status switches to Connected once its first heartbeat arrives.
              </p>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white"
              >
                Done
              </button>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Server Address on Your Local Wi-Fi
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={selectedServerUrl}
                    onChange={(e) => setSelectedServerUrl(e.target.value)}
                    placeholder="e.g. http://192.168.1.25:8080"
                    className="flex-1 px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                  {availableServerUrls.length > 1 && (
                    <select
                      aria-label="Choose detected LAN address"
                      value={selectedServerUrl}
                      onChange={(e) => setSelectedServerUrl(e.target.value)}
                      className="px-2.5 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                    >
                      {availableServerUrls.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
                {showHttpsWarning && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    Use HTTPS when connecting outside your trusted home or office Wi-Fi network.
                  </p>
                )}
              </div>

              {generateError && (
                <p className="text-xs text-red-600 dark:text-red-400">{generateError}</p>
              )}

              <div className="flex flex-col items-center justify-center p-5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-3">
                {generating ? (
                  <div className="w-56 h-56 flex items-center justify-center text-xs text-slate-500 dark:text-slate-400">
                    Generating secure QR code...
                  </div>
                ) : qrDataUrl && secondsLeft > 0 ? (
                  <img
                    src={qrDataUrl}
                    alt="NetFusion device pairing QR code"
                    className="w-56 h-56 rounded-lg bg-white p-2 border border-slate-200"
                  />
                ) : (
                  <div className="w-56 h-56 flex flex-col items-center justify-center text-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <span>QR code expired.</span>
                    <span>Generate a new QR code to continue.</span>
                  </div>
                )}

                <div className="flex items-center gap-3 text-xs">
                  <span
                    className={`font-mono tabular-nums font-semibold ${
                      secondsLeft > 0
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-red-600 dark:text-red-400'
                    }`}
                  >
                    {secondsLeft > 0
                      ? `Expires in ${minutes}:${String(secs).padStart(2, '0')}`
                      : 'Expired'}
                  </span>
                  <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">·</span>
                  <span className="text-slate-500 dark:text-slate-400">Single use</span>
                </div>

                <p className="text-xs text-center text-slate-600 dark:text-slate-400 max-w-xs">
                  Open NetFusion on your Android phone, tap <strong>Scan QR Code</strong>, and point your camera here.
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setShowManual((v) => !v)}
                  className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {showManual ? 'Hide manual pairing fallback' : 'Can’t scan? Enter manually'}
                </button>

                <button
                  type="button"
                  onClick={() => void generateNewQr()}
                  disabled={generating}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${generating ? 'animate-spin' : ''}`} />
                  <span>Generate New QR Code</span>
                </button>
              </div>

              {showManual && generated && (
                <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500 dark:text-slate-400">Server URL:</span>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-slate-900 dark:text-slate-100 truncate">
                        {selectedServerUrl || 'Unavailable'}
                      </span>
                      {selectedServerUrl && (
                        <button
                          type="button"
                          onClick={() => void handleCopy(selectedServerUrl, 'url')}
                          className="p-1 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
                          aria-label="Copy server URL"
                        >
                          {copiedField === 'url' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500 dark:text-slate-400">Temporary Secret:</span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold text-blue-700 dark:text-blue-400 select-all">
                        {generated.secret}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleCopy(generated.secret, 'code')}
                        className="p-1 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
                        aria-label="Copy pairing secret"
                      >
                        {copiedField === 'code' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-500 dark:text-slate-400">Pairing ID:</span>
                    <span className="font-mono text-slate-700 dark:text-slate-300">{generated.pairing_id}</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
