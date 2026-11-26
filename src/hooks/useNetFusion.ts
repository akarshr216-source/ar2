import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AdminAuthStatus,
  GeneratedPairingCode,
  NetFusionSettings,
  PairedDevice,
  PairingStatusSummary,
  TelemetrySnapshot,
} from '../types/netfusion';

const DEFAULT_API_BASE = (import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');

export function useNetFusion() {
  const [apiBaseUrl, setApiBaseUrlState] = useState<string>(DEFAULT_API_BASE);
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [lanAddresses, setLanAddresses] = useState<string[]>([]);
  const [clients, setClients] = useState<PairedDevice[]>([]);
  const [clientsLoading, setClientsLoading] = useState(false);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [pairingStatus, setPairingStatus] = useState<PairingStatusSummary | null>(null);
  const [adminAuthStatus, setAdminAuthStatus] = useState<AdminAuthStatus>({
    configured_via_env: false,
    claimed: false,
    authenticated: false,
  });
  // Held strictly in React memory (never persisted to localStorage/sessionStorage)
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkingNetwork, setCheckingNetwork] = useState(false);

  const prevDeviceSigRef = useRef<string>('');

  const apiUrl = useCallback((path: string) => `${apiBaseUrl}${path}`, [apiBaseUrl]);

  const setApiBaseUrl = useCallback((nextUrl: string) => {
    const trimmed = nextUrl.trim().replace(/\/+$/, '');
    if (trimmed === '') {
      setApiBaseUrlState('');
      return;
    }
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        setApiBaseUrlState(parsed.origin);
      }
    } catch {
      // Ignore invalid URL
    }
  }, []);

  const applyThemeToDom = useCallback((theme: NetFusionSettings['theme']) => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else if (theme === 'light') {
      root.classList.remove('dark');
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.toggle('dark', prefersDark);
    }
  }, []);

  const fetchAdminStatus = useCallback(
    async (tokenOverride?: string | null) => {
      const token = tokenOverride !== undefined ? tokenOverride : adminToken;
      try {
        const res = await fetch(apiUrl('/api/admin/status'), {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (res.ok) {
          const data = (await res.json()) as AdminAuthStatus;
          setAdminAuthStatus(data);
          if (!data.authenticated && token) {
            setAdminToken(null);
          }
          return data;
        }
      } catch {
        // Ignore transient network errors
      }
      return null;
    },
    [adminToken, apiUrl],
  );

  const fetchClientsAndPairing = useCallback(
    async (tokenOverride?: string | null) => {
      const token = tokenOverride !== undefined ? tokenOverride : adminToken;
      if (!token) {
        setClients([]);
        setPairingStatus(null);
        return;
      }

      setClientsLoading(true);
      setClientsError(null);
      try {
        const headers = { Authorization: `Bearer ${token}` };
        const [clientsRes, pairingRes] = await Promise.all([
          fetch(apiUrl('/api/clients'), { headers }),
          fetch(apiUrl('/api/pairing/status'), { headers }),
        ]);

        if (clientsRes.status === 401 || pairingRes.status === 401) {
          setAdminToken(null);
          setAdminAuthStatus((prev) => ({ ...prev, authenticated: false }));
          setClientsError('Administrator session expired. Enter your password to continue.');
          return;
        }

        if (!clientsRes.ok) {
          const errBody = (await clientsRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(errBody.error || 'Failed to load registered devices');
        }

        const clientsData = (await clientsRes.json()) as { clients: PairedDevice[] };
        setClients(clientsData.clients);

        if (pairingRes.ok) {
          setPairingStatus((await pairingRes.json()) as PairingStatusSummary);
        }
      } catch (err) {
        setClientsError(err instanceof Error ? err.message : 'Unable to fetch devices');
      } finally {
        setClientsLoading(false);
      }
    },
    [adminToken, apiUrl],
  );

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/health'));
      if (res.ok) {
        const data = (await res.json()) as { lan_addresses?: string[] };
        setLanAddresses(data.lan_addresses ?? []);
      }
    } catch {
      // Ignore transient errors
    }
  }, [apiUrl]);

  useEffect(() => {
    let active = true;

    const loadInitial = async () => {
      try {
        const res = await fetch(apiUrl('/api/metrics'));
        if (!res.ok) throw new Error('Unable to reach NetFusion server');
        const data = (await res.json()) as TelemetrySnapshot;
        if (!active) return;
        setSnapshot(data);
        applyThemeToDom(data.settings.theme);
        setError(null);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Connection failed');
      } finally {
        if (active) setLoading(false);
      }
    };

    void loadInitial();
    void fetchHealth();
    void fetchAdminStatus();

    const eventSource = new EventSource(apiUrl('/api/events'));
    eventSource.onopen = () => {
      if (active) setSseConnected(true);
    };
    eventSource.onmessage = (event) => {
      if (!active) return;
      try {
        const next = JSON.parse(event.data) as TelemetrySnapshot;
        setSnapshot(next);
        setSseConnected(true);
        setError(null);
      } catch {
        // Ignore malformed tick
      }
    };
    eventSource.onerror = () => {
      if (active) setSseConnected(false);
    };

    return () => {
      active = false;
      eventSource.close();
    };
  }, [apiUrl, applyThemeToDom, fetchAdminStatus, fetchHealth]);

  useEffect(() => {
    if (!adminToken || !snapshot) return;
    const sig = `${snapshot.devices_summary.total}:${snapshot.devices_summary.connected}:${snapshot.devices_summary.disconnected}`;
    if (sig !== prevDeviceSigRef.current) {
      prevDeviceSigRef.current = sig;
      void fetchClientsAndPairing(adminToken);
    }
  }, [adminToken, snapshot, fetchClientsAndPairing]);

  useEffect(() => {
    if (!adminToken) return;
    void fetchClientsAndPairing(adminToken);
    const interval = setInterval(() => {
      void fetchClientsAndPairing(adminToken);
    }, 5000);
    return () => clearInterval(interval);
  }, [adminToken, fetchClientsAndPairing]);

  useEffect(() => {
    if (!snapshot?.settings.theme) return;
    applyThemeToDom(snapshot.settings.theme);

    if (snapshot.settings.theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => applyThemeToDom('system');
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
    return undefined;
  }, [snapshot?.settings.theme, applyThemeToDom]);

  const claimAdminPasscode = async (passcode: string) => {
    const res = await fetch(apiUrl('/api/admin/claim'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode }),
    });
    const data = (await res.json()) as { admin_token?: string; error?: string };
    if (!res.ok || !data.admin_token) {
      throw new Error(data.error || 'Failed to set administrator password');
    }
    setAdminToken(data.admin_token);
    setAdminAuthStatus({ configured_via_env: false, claimed: true, authenticated: true });
    await fetchClientsAndPairing(data.admin_token);
  };

  const loginAdmin = async (passcode: string) => {
    const res = await fetch(apiUrl('/api/admin/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode }),
    });
    const data = (await res.json()) as { admin_token?: string; error?: string };
    if (!res.ok || !data.admin_token) {
      throw new Error(data.error || 'Incorrect administrator password');
    }
    setAdminToken(data.admin_token);
    setAdminAuthStatus((prev) => ({ ...prev, claimed: true, authenticated: true }));
    await fetchClientsAndPairing(data.admin_token);
  };

  const logoutAdmin = async () => {
    if (adminToken) {
      await fetch(apiUrl('/api/admin/logout'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      }).catch(() => undefined);
    }
    setAdminToken(null);
    setClients([]);
    setPairingStatus(null);
    setAdminAuthStatus((prev) => ({ ...prev, authenticated: false }));
  };

  const generatePairingCode = async (options?: {
    platformHint?: 'any' | 'android' | 'windows';
    ttlSeconds?: number;
    serverUrl?: string;
  }): Promise<GeneratedPairingCode> => {
    if (!adminToken) {
      throw new Error('Administrator authentication required');
    }
    const res = await fetch(apiUrl('/api/pairing/generate'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        platform_hint: options?.platformHint ?? 'any',
        ttl_seconds: options?.ttlSeconds ?? 120,
        server_url: options?.serverUrl,
      }),
    });
    const data = (await res.json()) as GeneratedPairingCode & { error?: string };
    if (!res.ok) {
      throw new Error(data.error || 'Failed to generate QR pairing code');
    }
    await fetchClientsAndPairing(adminToken);
    return data;
  };

  const revokeClient = async (id: string) => {
    if (!adminToken) return;
    const res = await fetch(apiUrl(`/api/clients/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (res.ok) {
      const data = (await res.json()) as { clients: PairedDevice[] };
      setClients(data.clients);
      await fetchClientsAndPairing(adminToken);
    } else {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      setClientsError(err.error || 'Failed to remove device');
    }
  };

  const checkNetworkNow = async () => {
    setCheckingNetwork(true);
    try {
      const res = await fetch(apiUrl('/api/network/check'), { method: 'POST' });
      if (res.ok) {
        const data = (await res.json()) as { snapshot: TelemetrySnapshot };
        setSnapshot(data.snapshot);
      }
    } finally {
      setCheckingNetwork(false);
    }
  };

  const updateSettings = async (patch: Partial<NetFusionSettings>) => {
    if (patch.theme) {
      applyThemeToDom(patch.theme);
    }
    const res = await fetch(apiUrl('/api/settings'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const data = (await res.json()) as { settings: NetFusionSettings };
      setSnapshot((prev) => (prev ? { ...prev, settings: data.settings } : prev));
    }
  };

  return {
    apiBaseUrl,
    setApiBaseUrl,
    lanAddresses,
    snapshot,
    clients,
    clientsLoading,
    clientsError,
    pairingStatus,
    adminAuthStatus,
    isAdminAuthenticated: Boolean(adminToken),
    claimAdminPasscode,
    loginAdmin,
    logoutAdmin,
    refreshClients: () => fetchClientsAndPairing(adminToken),
    generatePairingCode,
    revokeClient,
    sseConnected,
    loading,
    error,
    checkingNetwork,
    checkNetworkNow,
    updateSettings,
  };
}
