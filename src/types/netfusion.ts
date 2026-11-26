export type NavSection = 'dashboard' | 'devices' | 'networks' | 'settings';

export interface NetworkMetric {
  id?: number;
  interface_id: string;
  download_mbps: number | null;
  upload_mbps: number | null;
  latency_ms: number | null;
  jitter_ms: number | null;
  packet_loss_pct: number | null;
  health_score: number | null;
  rx_bytes: number | null;
  tx_bytes: number | null;
  metrics_available: boolean;
  probe_source: string;
  recorded_at: string;
}

export interface NetworkInterfaceItem {
  id: string;
  system_name: string;
  display_name: string;
  provider: string;
  kind: 'ethernet' | 'wifi' | 'cellular_usb' | 'hotspot' | 'loopback';
  ip_address: string;
  mac_address: string;
  is_host_detected: number;
  enabled: number;
  weight: number;
  priority_order: number;
  status: 'healthy' | 'degraded' | 'offline' | 'disabled';
  updated_at: string;
  latest_metric: NetworkMetric | null;
}

export interface PairedDevice {
  id: string;
  name: string;
  platform: 'windows' | 'android';
  device_model: string;
  ip_address: string;
  pairing_status: 'paired' | 'pending' | 'revoked';
  connection_status: 'connected' | 'disconnected';
  app_version: string;
  rx_bytes: number | null;
  tx_bytes: number | null;
  download_bps: number | null;
  upload_bps: number | null;
  last_seen_at: string;
  created_at: string;
}

export interface GeneratedPairingCode {
  pairing_id: string;
  pairing_code: string;
  secret: string;
  expires_at: string;
  ttl_seconds: number;
  code_hint: string;
  platform_hint: 'any' | 'android' | 'windows';
  lan_addresses: string[];
  qr_payload: string;
}

export interface PairingStatusSummary {
  active_codes: number;
  latest_code_expires_at: string | null;
  latest_pairing_id: string | null;
  latest_code_hint: string | null;
  platform_hint: 'any' | 'android' | 'windows' | null;
  registered_devices: number;
  connected_devices: number;
  disconnected_devices: number;
  heartbeat_timeout_seconds: number;
}

export interface AdminAuthStatus {
  configured_via_env: boolean;
  claimed: boolean;
  authenticated: boolean;
}

export interface UsageStat {
  interface_id: string;
  date_key: string;
  rx_mb: number;
  tx_mb: number;
  updated_at: string;
}

export interface SystemEvent {
  id: number;
  level: 'info' | 'warning' | 'error';
  category: string;
  message: string;
  created_at: string;
}

export interface NetFusionSettings {
  theme: 'light' | 'dark' | 'system';
  server_port: number;
  lan_only: boolean;
  auto_discovery: boolean;
  monitor_interval_seconds: number;
  heartbeat_timeout_seconds: number;
  pairing_code_ttl_seconds: number;
}

export interface TelemetrySnapshot {
  timestamp: string;
  server_status: 'running';
  internet_status: 'online' | 'offline' | 'unavailable';
  internet_latency_ms: number | null;
  total_download_mbps: number | null;
  total_upload_mbps: number | null;
  total_rx_bytes: number | null;
  total_tx_bytes: number | null;
  settings: NetFusionSettings;
  interfaces: NetworkInterfaceItem[];
  usage: UsageStat[];
  events: SystemEvent[];
  devices_summary: {
    total: number;
    connected: number;
    disconnected: number;
  };
}
