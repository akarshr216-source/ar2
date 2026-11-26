package network

import (
	"context"
	"net"
	"sync"
	"time"

	"netfusion/server/internal/metrics"
)

type Monitor struct {
	discoverer *Discoverer
	collector  *metrics.Collector
	mu         sync.RWMutex
	interval   time.Duration
	onCycle    func()
}

func NewMonitor(d *Discoverer, c *metrics.Collector, interval time.Duration) *Monitor {
	if interval <= 0 {
		interval = 3 * time.Second
	}
	return &Monitor{
		discoverer: d,
		collector:  c,
		interval:   interval,
	}
}

func (m *Monitor) SetOnCycle(fn func()) {
	m.mu.Lock()
	m.onCycle = fn
	m.mu.Unlock()
}

func (m *Monitor) SetInterval(interval time.Duration) {
	if interval <= 0 {
		return
	}
	m.mu.Lock()
	m.interval = interval
	m.mu.Unlock()
}

func (m *Monitor) Start(ctx context.Context) {
	m.probeOnce()
	for {
		m.mu.RLock()
		d := m.interval
		m.mu.RUnlock()

		timer := time.NewTimer(d)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			m.probeOnce()
		}
	}
}

func (m *Monitor) ProbeNow() (*float64, *float64) {
	cf := measureTCP("1.1.1.1:443")
	gg := measureTCP("8.8.8.8:443")
	var cfPtr, ggPtr *float64
	if cf >= 0 {
		v := cf
		cfPtr = &v
	}
	if gg >= 0 {
		v := gg
		ggPtr = &v
	}
	m.probeOnce()
	return cfPtr, ggPtr
}

func (m *Monitor) probeOnce() {
	ifaces, err := m.discoverer.Scan()
	if err != nil {
		return
	}

	latencyMs := measureTCP("1.1.1.1:443")
	if latencyMs < 0 {
		latencyMs = measureTCP("8.8.8.8:443")
	}
	loss := 0.0
	if latencyMs < 0 {
		loss = 100.0
	}

	for _, iface := range ifaces {
		if iface.Kind == "loopback" || !iface.IsUp {
			continue
		}
		m.collector.RecordSample(metrics.Sample{
			InterfaceID:   iface.SystemName,
			LatencyMs:     latencyMs,
			PacketLossPct: loss,
			RecordedAt:    time.Now().UTC(),
		})
	}

	m.mu.RLock()
	cb := m.onCycle
	m.mu.RUnlock()
	if cb != nil {
		cb()
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
