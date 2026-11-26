# Start NetFusion Go API Server on Windows PC (Port 8080)
$env:NETFUSION_DB_PATH = "C:\NetFusion\data\netfusion.db"
$env:NETFUSION_HOST_BIND = "0.0.0.0:8080"
$env:NETFUSION_HEARTBEAT_TIMEOUT_SECONDS = "15"
$env:NETFUSION_PAIRING_CODE_TTL_SECONDS = "120"

# Automatically detect an active private-network IPv4 address if NETFUSION_PUBLIC_URL is not overridden
if (-not $env:NETFUSION_PUBLIC_URL) {
    $detectedIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' -and
            $_.InterfaceAlias -notmatch '(vEthernet|WSL|Hyper-V|Docker|VMware|VirtualBox|Loopback|Tailscale)'
        } |
        Select-Object -First 1 -ExpandProperty IPAddress)
    if ($detectedIp) {
        $env:NETFUSION_PUBLIC_URL = "http://${detectedIp}:8080"
    } else {
        Write-Host "Warning: Could not auto-detect a private LAN IPv4. Set `$env:NETFUSION_PUBLIC_URL = 'http://<YOUR_PC_LAN_IP>:8080' manually."
    }
}

# Set a strong administrator passcode before starting in production:
if (-not $env:NETFUSION_ADMIN_PASSCODE) {
    Write-Host "Tip: Set `$env:NETFUSION_ADMIN_PASSCODE before starting in production, or create it on first dashboard open."
}

$DbDir = Split-Path -Parent $env:NETFUSION_DB_PATH
if (-not (Test-Path $DbDir)) {
    New-Item -ItemType Directory -Path $DbDir -Force | Out-Null
}

Write-Host "Starting NetFusion Go API server on $env:NETFUSION_HOST_BIND"
Write-Host "Public LAN QR endpoint: $env:NETFUSION_PUBLIC_URL"
Write-Host "SQLite DB: $env:NETFUSION_DB_PATH"
Set-Location (Join-Path $PSScriptRoot "..\..\server")
go run ./cmd/netfusion-server
