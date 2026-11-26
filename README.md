# NetFusion

Simple, secure QR-code device pairing and real operating-system network monitoring across Windows PC and Android phones over your local Wi-Fi network.

## Repository Layout
- `server/` — Go Windows/LAN control plane, SQLite schema (`migrations/001_init.sql`), pairing/rate-limit middleware, and OS network monitor (`cmd/netfusion-server`).
- `server-runtime/` & `server.ts` — Node.js/Express + SQLite (`node:sqlite`) control plane & SSE telemetry server.
- `src/` — Beginner-friendly React + TypeScript dashboard (**Dashboard**, **Devices**, **Networks**, **Settings**) with **Add Device** QR pairing.
- `android/` — Android Kotlin + Jetpack Compose app with CameraX + ML Kit QR scanning, server confirmation prompt, `EncryptedSharedPreferences`, and `TrafficStats` heartbeat reporting.
- `deployment/windows/` — PowerShell firewall (`LocalSubnet`) and Windows launch scripts.
- `tests/` — Automated pairing, security, and persistence test suite (`device-pairing.test.ts`).

## Quick Start (Windows Server + Android QR Pairing)
1. Start the Windows server:
   ```powershell
   .\deployment\windows\configure-firewall.ps1
   .\deployment\windows\run-server.ps1
   ```
   Key environment variables:
   - `NETFUSION_DB_PATH=C:\NetFusion\data\netfusion.db`
   - `NETFUSION_HOST_BIND=0.0.0.0:8080`
   - `NETFUSION_ADMIN_PASSCODE=<your-admin-passcode>`

2. Open the dashboard (`http://localhost:8080` or your PC's LAN IP) and set or unlock your administrator password.
3. Click **Add Device** to generate a single-use QR code valid for 2 minutes (`netfusion://pair?server=...&pairing_id=...&secret=...`).
4. Open the **NetFusion** app on your Android phone on the same Wi-Fi network, tap **Scan QR Code**, verify the server address in the confirmation prompt, and tap **Connect**.

## Development & Automated Tests
```bash
npm install
npm run dev
node --test tests/device-pairing.test.ts
```
