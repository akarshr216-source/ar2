# Run as Administrator in PowerShell on your Windows PC.
# Configures Windows Firewall inbound rules for:
#   - TCP 8080: NetFusion Go API server (required for Android pairing & heartbeats)
#   - TCP 3000: NetFusion Dashboard (optional local LAN access)
# Both rules are restricted strictly to -RemoteAddress LocalSubnet on -Profile Private.

param(
    [switch]$Approve,
    [switch]$SkipDashboardPort
)

if (-not $Approve) {
    Write-Host "This script will create Windows Firewall Inbound Allow rules on Private networks (LocalSubnet only):"
    Write-Host "  1. TCP Port 8080 -> NetFusion Go API Server"
    if (-not $SkipDashboardPort) {
        Write-Host "  2. TCP Port 3000 -> NetFusion Dashboard UI"
    }
    $reply = Read-Host "Proceed? Type YES to confirm"
    if ($reply -ne "YES") {
        Write-Host "Cancelled. No Windows Firewall changes were made."
        exit 0
    }
}

$Rules = @(
    @{ Name = "NetFusion Go API Server (TCP 8080)"; Port = 8080 }
)
if (-not $SkipDashboardPort) {
    $Rules += @{ Name = "NetFusion Dashboard (TCP 3000)"; Port = 3000 }
}

foreach ($rule in $Rules) {
    if (Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue) {
        Remove-NetFirewallRule -DisplayName $rule.Name
    }

    New-NetFirewallRule `
        -DisplayName $rule.Name `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort $rule.Port `
        -RemoteAddress LocalSubnet `
        -Profile Private | Out-Null

    Write-Host "Configured rule '$($rule.Name)' on TCP port $($rule.Port) (LocalSubnet, Private profile)."
}
