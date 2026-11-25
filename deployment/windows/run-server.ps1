# Start NetFusion Server on Windows PC
$env:NETFUSION_DB_PATH = "C:\NetFusion\data\netfusion.db"
$env:NETFUSION_HOST_BIND = "0.0.0.0:8080"
$env:NETFUSION_HEARTBEAT_TIMEOUT_SECONDS = "15"

# Set a strong administrator passcode before starting:
if (-not $env:NETFUSION_ADMIN_PASSCODE) {
    Write-Host "Tip: Set `$env:NETFUSION_ADMIN_PASSCODE before starting in production."
}

$DbDir = Split-Path -Parent $env:NETFUSION_DB_PATH
if (-not (Test-Path $DbDir)) {
    New-Item -ItemType Directory -Path $DbDir -Force | Out-Null
}

Write-Host "Starting NetFusion Server on $env:NETFUSION_HOST_BIND (DB: $env:NETFUSION_DB_PATH)"
Set-Location (Join-Path $PSScriptRoot "..\..\server")
go run ./cmd/netfusion-server
