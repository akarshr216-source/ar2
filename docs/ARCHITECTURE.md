# NetFusion Architecture (v0.1)

NetFusion is a cross-platform multi-network control plane built around a central gateway service:

1. **Network Manager**: Discovers local adapters and monitors upstream latency, jitter, packet loss, and throughput.
2. **Load Balancer**: Assigns independent application flows across healthy interfaces using weighted health scoring and automatic failover.
3. **Streaming & QoS Engine**: Applies the P0–P4 traffic priority model (Real-time 100, Gaming 90, Video 70, Normal 50, Background 30).
4. **Bonding Engine (Optional Relay)**: Disabled by default in v0.1; true single-flow aggregation requires an external QUIC relay endpoint.

## Default Safe Operating Mode
The service starts in **Monitoring Mode** without modifying OS routing tables until the operator explicitly activates Gateway Mode.
