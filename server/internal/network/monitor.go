package network

import (
	"context"
	"net"
	"time"

	"netfusion/server/internal/metrics"
)

type Monitor struct {
	discoverer *Discoverer
	collector  *metrics.Collector
	interval   time.Duration
}

func NewMonitor(d *Discoverer, c *metrics.Collector, interval time.Duration) *Monitor {
	return &Monitor{
		discoverer: d,
		collector:  c,
		interval:   interval,
	}
}

func (m *Monitor) Start(ctx context.Context) {
	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()

	m.probeOnce()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.probeOnce()
		}
	}
}

func (m *Monitor) probeOnce() {
	ifaces, err := m.discoverer.Scan()
	if err != nil {
		return
	}

	latencyMs := measureTCP("1.1.1.1:443")
	for _, iface := range ifaces {
		if iface.Kind == "loopback" || !iface.IsUp {
			continue
		}
		m.collector.RecordSample(metrics.Sample{
			InterfaceID:   iface.SystemName,
			LatencyMs:     latencyMs,
			PacketLossPct: 0,
			RecordedAt:    time.Now().UTC(),
		})
	}
}

func measureTCP(addr string) float64 {
	start := time.Now()
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		return -1
	}
	_ = conn.Close()
	return float64(time.Since(start).Microseconds()) / 1000.0
}
