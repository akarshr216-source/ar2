# NetFusion

Simple, secure QR-code device pairing and real operating-system network monitoring across Windows PC and Android phones over your local Wi-Fi network.

## Repository Layout
- `server/` — Go Windows/LAN control plane, SQLite schema (`migrations/001_init.sql`), pairing/rate-limit middleware, and OS network monitor (`cmd/netfusion-server`).
- `server-runtime/` & `server.ts` — Node.js/Express + SQLite (`node:sqlite`) control plane & SSE telemetry server.
- `src/` — Beginner-friendly React + TypeScript dashboard (**Dashboard**, **Devices**, **Networks**, **Settings**) with **Add Device** QR pairing.
- `android/` — Android Kotlin + Jetpack Compose app with CameraX + ML Kit QR scanning, server confirmation prompt, `EncryptedSharedPreferences`, and `TrafficStats` heartbeat reporting.
- `deployment/windows/` — PowerShell firewall (`LocalSubnet`) and Windows launch scripts.
- `tests/` — Automated pairing, security, and persistence test suite (`device-pairing.test.ts`).

## Quick Start (Windows Go API :8080 + Dashboard :3000 + Android QR Pairing)
1. Optionally allow ports `8080` and `3000` on your Private Windows Wi-Fi network (prompts for confirmation):
   ```powershell
   .\deployment\windows\configure-firewall.ps1
   ```
2. Start the Windows Go API server on port `8080`:
   ```powershell
   .\deployment\windows\run-server.ps1
   ```
3. In a second terminal, start the Node.js + Vite dashboard on port `3000` (automatically proxies `/api/*` to Go on `127.0.0.1:8080`):
   ```powershell
   .\deployment\windows\run-dashboard.ps1
   ```
   Key environment variables (see `.env.example`):
   - `NETFUSION_DB_PATH=C:\NetFusion\data\netfusion.db`
   - `NETFUSION_HOST_BIND=0.0.0.0:8080`
   - `NETFUSION_PUBLIC_URL=http://192.168.1.16:8080` (optional override; auto-detects active private LAN IPv4)
   - `NETFUSION_API_PROXY_TARGET=http://127.0.0.1:8080`
   - `NETFUSION_ADMIN_PASSCODE=<your-admin-passcode>`

4. Open the dashboard (`http://localhost:3000` on the PC or `http://<PC_LAN_IP>:3000`) and set or unlock your administrator password.
5. Click **Add Device** to generate a single-use QR code valid for 2 minutes (`netfusion://pair?server=http://<PC_LAN_IP>:8080&pairing_id=...&secret=...`).
6. Open the **NetFusion** app on your Android phone on the same Wi-Fi network, tap **Scan QR Code**, verify the server address in the confirmation prompt, and tap **Connect**.

## Development & Automated Tests
```bash
npm install
npm run dev
node --test tests/device-pairing.test.ts
cd server && go test ./...
```
