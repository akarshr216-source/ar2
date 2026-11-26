export interface NetworkInterfaceRecord {
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
}

export interface NetworkMetricRecord {
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

export type DevicePlatform = 'windows' | 'android';
export type DevicePairingStatus = 'paired' | 'pending' | 'revoked';
export type DeviceConnectionStatus = 'connected' | 'disconnected';

export interface DeviceRecord {
  id: string;
  name: string;
  platform: DevicePlatform;
  device_model: string;
  ip_address: string;
  pairing_status: DevicePairingStatus;
  connection_status: DeviceConnectionStatus;
  app_version: string;
  rx_bytes: number | null;
  tx_bytes: number | null;
  download_bps: number | null;
  upload_bps: number | null;
  last_seen_at: string;
  created_at: string;
}

export interface PairingStatusSummary {
  active_codes: number;
  latest_code_expires_at: string | null;
  latest_pairing_id: string | null;
  latest_code_hint: string | null;
  platform_hint: DevicePlatform | 'any' | null;
  registered_devices: number;
  connected_devices: number;
  disconnected_devices: number;
  heartbeat_timeout_seconds: number;
}

export interface UsageStatRecord {
  interface_id: string;
  date_key: string;
  rx_mb: number;
  tx_mb: number;
  updated_at: string;
}

export interface SystemEventRecord {
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

export interface InterfaceWithMetrics extends NetworkInterfaceRecord {
  latest_metric: NetworkMetricRecord | null;
}
