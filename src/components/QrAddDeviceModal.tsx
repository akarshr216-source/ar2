import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertCircle, Check, Copy, Lock, QrCode, RefreshCw, X } from 'lucide-react';
import QRCode from 'qrcode';
import type { AdminAuthStatus, GeneratedPairingCode, PairingStatusSummary } from '../types/netfusion';

interface QrAddDeviceModalProps {
  open: boolean;
  onClose: () => void;
  apiBaseUrl: string;
  publicUrl: string | null;
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

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h === '0.0.0.0' || h === '::1' || h === '::') {
    return true;
  }
  return h.startsWith('127.');
}

function isLocalOrLanUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    const h = u.hostname.toLowerCase();
    if (h.endsWith('.local')) return true;
    const parts = h.split('.').map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      if (parts[0] === 10) return true;
      if (parts[0] === 192 && parts[1] === 168) return true;
      if (parts[0] === 169 && parts[1] === 254) return true;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function validateQrServerUrlClient(
  rawUrl: string,
): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return {
      ok: false,
      error: 'Enter your Windows PC’s Wi-Fi IPv4 URL (for example http://192.168.1.16:8080).',
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      error: 'Invalid server URL. Use http://<LAN_IP>:8080 (for example http://192.168.1.16:8080).',
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'Server URL must start with http:// or https://.' };
  }
  if (isLoopbackHost(parsed.hostname)) {
    return {
      ok: false,
      error:
        'QR pairing cannot use localhost or 127.0.0.1 because your Android phone cannot reach it. Use your Windows PC’s Wi-Fi IPv4 address.',
    };
  }
  if (parsed.protocol === 'http:' && !isLocalOrLanUrl(parsed.origin)) {
    return {
      ok: false,
      error: 'Servers outside your trusted local Wi-Fi network must use HTTPS.',
    };
  }
  return { ok: true, url: parsed.origin };
}

export function validateQrPayloadClient(payload: string): string | null {
  try {
    const parsed = new URL(payload);
    if (parsed.protocol !== 'netfusion:' || parsed.hostname !== 'pair') {
      return 'Invalid NetFusion QR pairing protocol.';
    }
    if (parsed.searchParams.get('auth_token') || parsed.searchParams.get('token')) {
      return 'Rejected unsafe QR payload containing a permanent token.';
    }
    const server = parsed.searchParams.get('server') || '';
    const pairingId = parsed.searchParams.get('pairing_id') || '';
    const secret = parsed.searchParams.get('secret') || '';
    const serverCheck = validateQrServerUrlClient(server);
    if (!serverCheck.ok) {
      return serverCheck.error;
    }
    if (!pairingId || !secret) {
      return 'QR payload is missing pairing credentials.';
    }
    return null;
  } catch {
    return 'Generated QR payload is malformed.';
  }
}

export function QrAddDeviceModal({
  open,
  onClose,
  apiBaseUrl,
  publicUrl,
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
    const addCandidate = (raw: string | null | undefined) => {
      if (!raw) return;
      const check = validateQrServerUrlClient(raw);
      if (check.ok && !urls.includes(check.url)) {
        urls.push(check.url);
      }
    };

    addCandidate(publicUrl);
    addCandidate(apiBaseUrl);
    for (const ip of lanAddresses) {
      if (ip && !isLoopbackHost(ip)) {
        addCandidate(`http://${ip}:${serverPort}`);
      }
    }
    return urls;
  }, [apiBaseUrl, lanAddresses, publicUrl, serverPort]);

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

  const serverUrlCheck = useMemo(
    () => validateQrServerUrlClient(selectedServerUrl),
    [selectedServerUrl],
  );

  const qrPayload = useMemo(() => {
    if (!generated || !serverUrlCheck.ok) return '';
    return `netfusion://pair?server=${encodeURIComponent(serverUrlCheck.url)}&pairing_id=${encodeURIComponent(generated.pairing_id)}&secret=${encodeURIComponent(generated.secret)}`;
  }, [generated, serverUrlCheck]);

  const payloadError = useMemo(() => {
    if (!generated) return null;
    if (!serverUrlCheck.ok) return serverUrlCheck.error;
    return validateQrPayloadClient(qrPayload);
  }, [generated, qrPayload, serverUrlCheck]);

  useEffect(() => {
    if (!qrPayload || payloadError) {
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
  }, [payloadError, qrPayload]);

  const generateNewQr = useCallback(async () => {
    if (!isAdminAuthenticated) return;
    const candidate = selectedServerUrl || availableServerUrls[0] || '';
    const check = validateQrServerUrlClient(candidate);
    if (!check.ok) {
      setGenerateError(check.error);
      return;
    }
    setGenerating(true);
    setGenerateError(null);
    setPairedSuccess(false);
    try {
      const result = await onGeneratePairingCode({
        platformHint: 'any',
        ttlSeconds: 120,
        serverUrl: check.url,
      });
      if (result.server_url && !selectedServerUrl) {
        setSelectedServerUrl(result.server_url);
      }
      setGenerated(result);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Unable to generate pairing QR code');
    } finally {
      setGenerating(false);
    }
  }, [availableServerUrls, isAdminAuthenticated, onGeneratePairingCode, selectedServerUrl]);

  useEffect(() => {
    if (open && isAdminAuthenticated && !generated && !generating && !generateError) {
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
  }, [
    open,
    isAdminAuthenticated,
    generated,
    generating,
    generateError,
    generateNewQr,
    pairingStatus?.registered_devices,
  ]);

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
    selectedServerUrl.startsWith('http://') &&
    !isLoopbackHost(selectedServerUrl) &&
    !isLocalOrLanUrl(selectedServerUrl);

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
                    onChange={(e) => {
                      setSelectedServerUrl(e.target.value);
                      setGenerateError(null);
                    }}
                    placeholder="e.g. http://192.168.1.16:8080"
                    className="flex-1 px-3 py-2 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
                  />
                  {availableServerUrls.length > 1 && (
                    <select
                      aria-label="Choose detected LAN address"
                      value={selectedServerUrl}
                      onChange={(e) => {
                        setSelectedServerUrl(e.target.value);
                        setGenerateError(null);
                      }}
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
                {availableServerUrls.length === 0 && !selectedServerUrl && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    No active LAN IP detected automatically. Enter your Windows PC’s Wi-Fi URL above (for example http://192.168.1.16:8080) or set NETFUSION_PUBLIC_URL.
                  </p>
                )}
                {showHttpsWarning && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    Use HTTPS when connecting outside your trusted home or office Wi-Fi network.
                  </p>
                )}
              </div>

              {(generateError || payloadError) && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-xs text-red-700 dark:text-red-400">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{generateError || payloadError}</span>
                </div>
              )}

              <div className="flex flex-col items-center justify-center p-5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-3">
                {generating ? (
                  <div className="w-56 h-56 flex items-center justify-center text-xs text-slate-500 dark:text-slate-400">
                    Generating secure QR code...
                  </div>
                ) : !serverUrlCheck.ok || payloadError ? (
                  <div className="w-56 h-56 flex flex-col items-center justify-center text-center gap-2 px-3 text-xs text-red-600 dark:text-red-400">
                    <span>Invalid server address for QR pairing.</span>
                    <span>Enter a reachable Wi-Fi IPv4 URL and click Generate New QR Code.</span>
                  </div>
                ) : qrDataUrl && secondsLeft > 0 ? (
                  <img
                    src={qrDataUrl}
                    alt="NetFusion device pairing QR code"
                    className="w-56 h-56 rounded-lg bg-white p-2 border border-slate-200"
                  />
                ) : (
                  <div className="w-56 h-56 flex flex-col items-center justify-center text-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <span>{generated ? 'QR code expired.' : 'Ready to generate QR code.'}</span>
                    <span>Click Generate New QR Code to continue.</span>
                  </div>
                )}

                {serverUrlCheck.ok && (
                  <div className="text-xs font-mono text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 px-3 py-1.5 rounded-md border border-slate-200 dark:border-slate-800 max-w-full truncate">
                    Server: {serverUrlCheck.url}
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
                      : generated
                        ? 'Expired'
                        : 'Not generated'}
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
                  disabled={generating || !serverUrlCheck.ok}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
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
                        {serverUrlCheck.ok ? serverUrlCheck.url : 'Not Configured'}
                      </span>
                      {serverUrlCheck.ok && (
                        <button
                          type="button"
                          onClick={() => void handleCopy(serverUrlCheck.url, 'url')}
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
