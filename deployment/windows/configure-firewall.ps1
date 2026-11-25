# Run as Administrator in PowerShell on your Windows PC
# Restricts NetFusion Server port 8080 strictly to the trusted LocalSubnet (LAN)

$RuleName = "NetFusion Local LAN Control Plane"
$Port = 8080

if (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue) {
    Remove-NetFirewallRule -DisplayName $RuleName
}

New-NetFirewallRule `
    -DisplayName $RuleName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -RemoteAddress LocalSubnet `
    -Profile Private

Write-Host "Configured Windows Firewall rule '$RuleName' on TCP port $Port for LocalSubnet (Private profile only)."
