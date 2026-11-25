# Security & Privacy Policy

- **No Plaintext Tokens**: Device pairing tokens are hashed with SHA-256 on the server; only the hash is stored in SQLite.
- **No Browsing History Collection**: NetFusion v0.1 monitors interface health, throughput, and aggregate QoS tiers without logging destination URLs or browsing history.
- **Local-First Administration**: Administrative endpoints are designed for authenticated local/LAN control without external cloud dependencies.
- **Reversible Network State**: Gateway routing remains off by default and restores original network state when disabled.
