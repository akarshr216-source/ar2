import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AdminAuthStatus,
  BondingPathItem,
  BondingStatusResponse,
  GeneratedPairingCode,
  NetFusionSettings,
  PairedDevice,
  PairingStatusSummary,
  QosRule,
  QosTierDef,
  StreamingProfile,
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

  const [profiles, setProfiles] = useState<StreamingProfile[]>([]);
  const [qosRules, setQosRules] = useState<QosRule[]>([]);
  const [qosTiers, setQosTiers] = useState<QosTierDef[]>([]);
  const [bondingStatus, setBondingStatus] = useState<BondingStatusResponse | null>(null);
  const [bondingPaths, setBondingPaths] = useState<BondingPathItem[]>([]);
  const [sseConnected, setSseConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [probingId, setProbingId] = useState<string | null>(null);

  const prevDeviceSigRef = useRef<string>('');

  const apiUrl = useCallback(
    (path: string) => `${apiBaseUrl}${path}`,
    [apiBaseUrl],
  );

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
      // Ignore invalid URL until valid
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
          setClientsError('Administrator session expired. Unlock device management to continue.');
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

  const fetchSecondaryData = useCallback(async () => {
    try {
      const [healthRes, profilesRes, qosRes, bondRes, pathsRes] = await Promise.all([
        fetch(apiUrl('/api/health')),
        fetch(apiUrl('/api/streaming/profiles')),
        fetch(apiUrl('/api/qos/policies')),
        fetch(apiUrl('/api/bonding/status')),
        fetch(apiUrl('/api/bonding/paths')),
      ]);

      if (healthRes.ok) {
        const data = (await healthRes.json()) as { lan_addresses?: string[] };
        setLanAddresses(data.lan_addresses ?? []);
      }
      if (profilesRes.ok) {
        const data = (await profilesRes.json()) as { profiles: StreamingProfile[] };
        setProfiles(data.profiles);
      }
      if (qosRes.ok) {
        const data = (await qosRes.json()) as { rules: QosRule[]; tiers: QosTierDef[] };
        setQosRules(data.rules);
        setQosTiers(data.tiers);
      }
      if (bondRes.ok) {
        setBondingStatus((await bondRes.json()) as BondingStatusResponse);
      }
      if (pathsRes.ok) {
        const data = (await pathsRes.json()) as { paths: BondingPathItem[] };
        setBondingPaths(data.paths);
      }
    } catch {
      // Non-fatal secondary refresh error
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
    void fetchSecondaryData();
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
  }, [apiUrl, applyThemeToDom, fetchAdminStatus, fetchSecondaryData]);

  // Live refresh authenticated devices whenever SSE reports a device count/status shift or periodically
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
      throw new Error(data.error || 'Failed to configure administrator passcode');
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
      throw new Error(data.error || 'Invalid administrator passcode');
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

  const generatePairingCode = async (
    platformHint: 'any' | 'android' | 'windows' = 'any',
    ttlSeconds?: number,
  ): Promise<GeneratedPairingCode> => {
    if (!adminToken) {
      throw new Error('Administrator authentication required');
    }
    const res = await fetch(apiUrl('/api/pairing/generate'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ platform_hint: platformHint, ttl_seconds: ttlSeconds }),
    });
    const data = (await res.json()) as GeneratedPairingCode & { error?: string };
    if (!res.ok) {
      throw new Error(data.error || 'Failed to generate pairing code');
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

  const updateInterface = async (
    id: string,
    patch: { enabled?: boolean; simulated_down?: boolean; weight?: number },
  ) => {
    const res = await fetch(apiUrl(`/api/interfaces/${encodeURIComponent(id)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const data = (await res.json()) as { snapshot: TelemetrySnapshot };
      setSnapshot(data.snapshot);
      void fetchSecondaryData();
    }
  };

  const probeInterface = async (id: string) => {
    setProbingId(id);
    try {
      const res = await fetch(apiUrl(`/api/interfaces/${encodeURIComponent(id)}/probe`), {
        method: 'POST',
      });
      if (res.ok) {
        const data = (await res.json()) as {
          probe: { cloudflare_ms: number | null; google_dns_ms: number | null };
          snapshot: TelemetrySnapshot;
        };
        setSnapshot(data.snapshot);
        return data.probe;
      }
    } finally {
      setProbingId(null);
    }
    return null;
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

  const setGatewayMode = async (gatewayMode: boolean) => {
    const res = await fetch(apiUrl('/api/gateway/mode'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gateway_mode: gatewayMode }),
    });
    if (res.ok) {
      const data = (await res.json()) as { snapshot: TelemetrySnapshot };
      setSnapshot(data.snapshot);
    }
  };

  const activateStreamingProfile = async (profileId: string) => {
    const res = await fetch(apiUrl('/api/streaming/profile'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: profileId }),
    });
    if (res.ok) {
      const data = (await res.json()) as { profiles: StreamingProfile[] };
      setProfiles(data.profiles);
    }
  };

  const toggleQosRule = async (id: string, enabled: boolean) => {
    const res = await fetch(apiUrl('/api/qos/policies'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, enabled }),
    });
    if (res.ok) {
      const data = (await res.json()) as { rules: QosRule[] };
      setQosRules(data.rules);
    }
  };

  const createQosRule = async (input: {
    app_name: string;
    match_pattern: string;
    tier: QosRule['tier'];
    preferred_interface_id: string | null;
  }) => {
    const res = await fetch(apiUrl('/api/qos/rules'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (res.ok) {
      const data = (await res.json()) as { rules: QosRule[] };
      setQosRules(data.rules);
    }
  };

  const deleteQosRule = async (id: string) => {
    const res = await fetch(apiUrl(`/api/qos/rules/${encodeURIComponent(id)}`), { method: 'DELETE' });
    if (res.ok) {
      const data = (await res.json()) as { rules: QosRule[] };
      setQosRules(data.rules);
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
    profiles,
    qosRules,
    qosTiers,
    bondingStatus,
    bondingPaths,
    sseConnected,
    loading,
    error,
    probingId,
    updateInterface,
    probeInterface,
    updateSettings,
    setGatewayMode,
    activateStreamingProfile,
    toggleQosRule,
    createQosRule,
    deleteQosRule,
  };
}
