package metrics

import (
	"sync"
	"time"

	"netfusion/server/internal/database"
)

type Sample struct {
	InterfaceID   string    `json:"interface_id"`
	DownloadMbps  float64   `json:"download_mbps"`
	UploadMbps    float64   `json:"upload_mbps"`
	LatencyMs     float64   `json:"latency_ms"`
	JitterMs      float64   `json:"jitter_ms"`
	PacketLossPct float64   `json:"packet_loss_pct"`
	HealthScore   float64   `json:"health_score"`
	RecordedAt    time.Time `json:"recorded_at"`
}

type Collector struct {
	store  *database.Store
	mu     sync.RWMutex
	latest map[string]Sample
}

func NewCollector(store *database.Store) *Collector {
	return &Collector{
		store:  store,
		latest: make(map[string]Sample),
	}
}

func (c *Collector) RecordSample(s Sample) {
	c.mu.Lock()
	c.latest[s.InterfaceID] = s
	c.mu.Unlock()
}

func (c *Collector) Snapshot() []Sample {
	c.mu.RLock()
	defer c.mu.RUnlock()

	out := make([]Sample, 0, len(c.latest))
	for _, v := range c.latest {
		out = append(out, v)
	}
	return out
}
