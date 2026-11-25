# NetFusion Local Control API

## Public / Monitoring Endpoints
| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Server health, operating mode, and detected LAN addresses |
| GET | `/api/interfaces` | Detected host adapters & upstream WAN links |
| GET | `/api/metrics` | Latest & historical throughput/latency telemetry |
| GET | `/api/events` | Server-Sent Events live telemetry stream |
| GET | `/api/bonding/status` | Bonding engine state (disabled by default) |

## Administrator & Device Pairing Endpoints
All device-management endpoints require `Authorization: Bearer <admin_token>`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/admin/status` | Check whether admin passcode is claimed and session is authenticated |
| POST | `/api/admin/claim` | Claim first-run administrator passcode (when env passcode is unset) |
| POST | `/api/admin/login` | Sign in with administrator passcode and receive bearer session token |
| POST | `/api/pairing/generate` | Generate a temporary, single-use, expiring pairing code |
| GET | `/api/pairing/status` | Return active pairing code status and connected/disconnected device counts |
| GET | `/api/clients` | Return all real registered Windows and Android devices |
| DELETE | `/api/clients/{id}` | Unpair and remove a registered device |

## Client Registration & Heartbeat Endpoints
| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/clients/pair` | Register an Android or Windows client using a valid temporary pairing code; returns a device `auth_token` |
| POST | `/api/clients/heartbeat` | Update authenticated device `last_seen_at` and mark `connected` (`Authorization: Bearer <auth_token>`) |
