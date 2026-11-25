# NetFusion

Cross-platform multi-network monitoring, load balancing, streaming QoS, and authenticated device pairing control plane.

## Repository Layout
- `server/` — Go Windows/LAN monitoring server, SQLite migrations (`001_init.sql`), and pairing/heartbeat API (`cmd/netfusion-server`).
- `server-runtime/` & `server.ts` — Live Node.js/Express + SQLite (`node:sqlite`) control plane & SSE telemetry engine serving the web dashboard.
- `android/` — Android Kotlin + Jetpack Compose client (`TokenStore` via `EncryptedSharedPreferences`, `DeviceInfoProvider`, `HeartbeatManager`, `PairingScreen`).
- `deployment/windows/` — Windows PowerShell launch and LocalSubnet Firewall configuration scripts.
- `tests/` — Automated integration tests (`device-pairing.test.ts`).
- `src/` — React + TypeScript dual-theme (Light/Dark) NetFusion Dashboard.

## Running on Windows Server (Go)
```powershell
.\deployment\windows\configure-firewall.ps1
.\deployment\windows\run-server.ps1
```
Environment variables used:
- `NETFUSION_DB_PATH=C:\NetFusion\data\netfusion.db` (directory created automatically)
- `NETFUSION_HOST_BIND=0.0.0.0:8080`
- `NETFUSION_ADMIN_PASSCODE=<your-admin-passcode>`

## Running the Live Control Plane & Tests
```bash
npm install
npm run dev
node --test tests/device-pairing.test.ts
```
