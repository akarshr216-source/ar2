# NetFusion Local Control API

## Public / Monitoring Endpoints
| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Server health, configured port, and detected LAN IPv4 addresses |
| GET | `/api/interfaces` | Real host network adapters detected from the operating system |
| GET | `/api/metrics` | Latest real traffic totals, internet reachability, latency, and adapter metrics (`null` / `Unavailable` if unavailable) |
| POST | `/api/network/check` | Run an immediate TCP reachability check (`1.1.1.1:443` / `8.8.8.8:443`) and refresh snapshot |
| GET | `/api/events` | Server-Sent Events live status & telemetry stream |
| GET | `/api/system-events` | Recent server, pairing, and connectivity events |

## Administrator & QR Device Pairing Endpoints
Restricted to local/LAN addresses when `lan_only=true` (`403` for public internet IPs). All device management routes require `Authorization: Bearer <admin_token>`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/admin/status` | Check whether admin password is configured and current token is valid |
| POST | `/api/admin/claim` | Set initial administrator password (when `NETFUSION_ADMIN_PASSCODE` is unset) |
| POST | `/api/admin/login` | Sign in with administrator password (`429` after 5 failures in 5 minutes) |
| POST | `/api/admin/logout` | Sign out current administrator session |
| POST | `/api/pairing/generate` | Create a single-use 2-minute (`120s`) pairing session returning `pairing_id`, `secret`, `qr_payload` (`netfusion://pair?...`), and `expires_at` (never contains `auth_token`) |
| GET | `/api/pairing/status` | Active QR pairing status and connected/disconnected device counts |
| GET | `/api/clients` | List all real paired devices with live `connection_status` and traffic counters |
| DELETE | `/api/clients/{id}` | Unpair a device and immediately revoke its `auth_token` |
| GET / PUT | `/api/settings` | Read or update server theme, port, `lan_only`, monitoring interval, heartbeat timeout, and QR expiration |

## Client Registration & Heartbeat Endpoints
| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/clients/pair` | Exchange QR `{ pairing_id, secret }` (or manual `{ pairing_code }`) for a permanent `auth_token`. Device starts `paired` + `disconnected` until first heartbeat (`429` rate limited after 5 failed attempts in 5 minutes) |
| POST | `/api/clients/heartbeat` | Authenticate via `Authorization: Bearer <auth_token>`, update `last_seen_at`, optional `rx_bytes`/`tx_bytes`/`download_bps`/`upload_bps`, and mark device `connected` |
