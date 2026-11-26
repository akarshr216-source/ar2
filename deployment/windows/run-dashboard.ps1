# Start NetFusion Dashboard on Windows PC (Port 3000) proxying /api/* to Go API server (Port 8080)
$env:PORT = "3000"
if (-not $env:NETFUSION_API_PROXY_TARGET) {
    $env:NETFUSION_API_PROXY_TARGET = "http://127.0.0.1:8080"
}

Write-Host "Starting NetFusion Dashboard on http://0.0.0.0:$env:PORT"
Write-Host "Proxying /api/* requests to Go API server at $env:NETFUSION_API_PROXY_TARGET"
Set-Location (Join-Path $PSScriptRoot "..\..")
npm run dev
