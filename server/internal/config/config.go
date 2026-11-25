package config

import (
	"encoding/json"
	"os"
)

type Config struct {
	Application   ApplicationConfig   `json:"application"`
	Server        ServerConfig        `json:"server"`
	Network       NetworkConfig       `json:"network"`
	LoadBalancing LoadBalancingConfig `json:"load_balancing"`
	Streaming     StreamingConfig     `json:"streaming"`
	Bonding       BondingConfig       `json:"bonding"`
	Security      SecurityConfig      `json:"security"`
}

type ApplicationConfig struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Theme   string `json:"theme"`
}

type ServerConfig struct {
	Enabled bool   `json:"enabled"`
	Startup string `json:"startup"`
	Port    int    `json:"port"`
	LANOnly bool   `json:"lan_only"`
}

type NetworkConfig struct {
	AutoDiscovery          bool `json:"auto_discovery"`
	MonitorIntervalSeconds int  `json:"monitor_interval_seconds"`
	AutomaticFailover      bool `json:"automatic_failover"`
}

type LoadBalancingConfig struct {
	Enabled   bool   `json:"enabled"`
	Algorithm string `json:"algorithm"`
}

type StreamingConfig struct {
	Enabled          bool   `json:"enabled"`
	Profile          string `json:"profile"`
	VideoPriority    int    `json:"video_priority"`
	GamingPriority   int    `json:"gaming_priority"`
	RealtimePriority int    `json:"realtime_priority"`
}

type BondingConfig struct {
	Enabled   bool   `json:"enabled"`
	RelayMode string `json:"relay_mode"`
}

type SecurityConfig struct {
	AuthenticationRequired bool   `json:"authentication_required"`
	Encryption             string `json:"encryption"`
}

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	if cfg.Network.MonitorIntervalSeconds <= 0 {
		cfg.Network.MonitorIntervalSeconds = 3
	}
	if cfg.Server.Port <= 0 {
		cfg.Server.Port = 8765
	}
	return &cfg, nil
}
