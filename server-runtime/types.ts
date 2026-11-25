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
  simulated_down: number;
  weight: number;
  priority_order: number;
  status: 'healthy' | 'degraded' | 'offline' | 'disabled';
  updated_at: string;
}

export interface NetworkMetricRecord {
  id?: number;
  interface_id: string;
  download_mbps: number;
  upload_mbps: number;
  latency_ms: number;
  jitter_ms: number;
  packet_loss_pct: number;
  health_score: number;
  rx_bytes: number;
  tx_bytes: number;
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
  last_seen_at: string;
  created_at: string;
}

export interface PairingStatusSummary {
  active_codes: number;
  latest_code_expires_at: string | null;
  latest_code_hint: string | null;
  platform_hint: DevicePlatform | 'any' | null;
  registered_devices: number;
  connected_devices: number;
  disconnected_devices: number;
  heartbeat_timeout_seconds: number;
}

export interface StreamingProfileRecord {
  id: string;
  name: string;
  description: string;
  realtime_priority: number;
  gaming_priority: number;
  video_priority: number;
  normal_priority: number;
  background_priority: number;
  is_active: number;
}

export interface QosRuleRecord {
  id: string;
  app_name: string;
  match_pattern: string;
  tier: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
  priority_weight: number;
  preferred_interface_id: string | null;
  enabled: number;
  created_at: string;
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
  gateway_mode: boolean;
  server_port: number;
  lan_only: boolean;
  auto_discovery: boolean;
  monitor_interval_seconds: number;
  heartbeat_timeout_seconds: number;
  pairing_code_ttl_seconds: number;
  automatic_failover: boolean;
  load_balancing_enabled: boolean;
  load_balancing_algorithm: 'weighted_health' | 'lowest_latency' | 'round_robin';
  bonding_enabled: boolean;
  relay_mode: string;
}

export interface InterfaceWithMetrics extends NetworkInterfaceRecord {
  latest_metric: NetworkMetricRecord | null;
  traffic_share_pct: number;
  is_primary_failover: boolean;
}
