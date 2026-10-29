param(
    [string]$GatewayConfigFile,
    [string]$WorkerConfigFile,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$gatewayDirectory = $PSScriptRoot
$rootDirectory = Split-Path -Parent $gatewayDirectory

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script from an elevated PowerShell window.'
}

if ([string]::IsNullOrWhiteSpace($GatewayConfigFile)) {
    $GatewayConfigFile = Join-Path $gatewayDirectory 'gateway.json'
}
if ([string]::IsNullOrWhiteSpace($WorkerConfigFile)) {
    $WorkerConfigFile = Join-Path $rootDirectory 'Worker\worker01.json'
}

$GatewayConfigFile = [System.IO.Path]::GetFullPath($GatewayConfigFile)
$WorkerConfigFile = [System.IO.Path]::GetFullPath($WorkerConfigFile)
$gatewayConfig = Get-Content -LiteralPath $GatewayConfigFile -Raw -Encoding UTF8 |
    ConvertFrom-Json
$workerConfig = Get-Content -LiteralPath $WorkerConfigFile -Raw -Encoding UTF8 |
    ConvertFrom-Json

$gatewayRuleName = 'PixelStreaming Gateway TCP'
$directPlayerRuleName = 'PixelStreaming Block Direct Player TCP'

if ($Remove) {
    foreach ($ruleName in @($directPlayerRuleName, $gatewayRuleName)) {
        Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue |
            Remove-NetFirewallRule
    }
    Write-Host '[gateway] Pixel Streaming firewall rules removed.'
    exit 0
}

$gatewayPort = [int]$gatewayConfig.listenPort
$playerPorts = @(
    $workerConfig.slots |
        ForEach-Object { [int]$_.playerPort } |
        Sort-Object -Unique
)
if ($gatewayPort -le 0 -or $playerPorts.Count -eq 0) {
    throw 'Gateway port or Worker Slot player ports are invalid.'
}

foreach ($ruleName in @($directPlayerRuleName, $gatewayRuleName)) {
    Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule
}

New-NetFirewallRule `
    -DisplayName $gatewayRuleName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $gatewayPort `
    -Profile Any | Out-Null

New-NetFirewallRule `
    -DisplayName $directPlayerRuleName `
    -Direction Inbound `
    -Action Block `
    -Protocol TCP `
    -LocalPort $playerPorts `
    -Profile Any | Out-Null

Write-Host "[gateway] Allowed inbound TCP $gatewayPort."
Write-Host "[gateway] Blocked remote inbound TCP $($playerPorts -join ', ') while preserving local loopback access."
Write-Host '[gateway] WebRTC UDP and TURN are separate and must still be configured.'
