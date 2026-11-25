package bonding

type Status struct {
	Enabled     bool   `json:"enabled"`
	RelayMode   string `json:"relay_mode"`
	ActivePaths int    `json:"active_paths"`
	Note        string `json:"note"`
}

type Manager struct {
	enabled bool
}

func NewManager(enabled bool) *Manager {
	return &Manager{enabled: enabled}
}

func (m *Manager) Status() Status {
	return Status{
		Enabled:     m.enabled,
		RelayMode:   "optional",
		ActivePaths: 0,
		Note:        "Bonding engine is disabled by default in NetFusion v0.1. Enable an optional remote QUIC relay to aggregate single-flow bandwidth.",
	}
}
