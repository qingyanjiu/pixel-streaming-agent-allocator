param(
    [string]$ConfigFile
)

$ErrorActionPreference = 'Stop'
$gatewayDirectory = $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($ConfigFile)) {
    $ConfigFile = Join-Path $gatewayDirectory 'gateway.json'
}

$ConfigFile = [System.IO.Path]::GetFullPath($ConfigFile)
$config = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 |
    ConvertFrom-Json
$configDirectory = Split-Path -Parent $ConfigFile

$token = $env:PS_GATEWAY_TOKEN
if ([string]::IsNullOrWhiteSpace($token) -and -not [string]::IsNullOrWhiteSpace($config.allocatorTokenEnv)) {
    $token = [Environment]::GetEnvironmentVariable([string]$config.allocatorTokenEnv)
}
if ([string]::IsNullOrWhiteSpace($token) -and -not [string]::IsNullOrWhiteSpace($config.allocatorTokenFile)) {
    $tokenFile = [string]$config.allocatorTokenFile
    if (-not [System.IO.Path]::IsPathRooted($tokenFile)) {
        $tokenFile = Join-Path $configDirectory $tokenFile
    }
    $token = (Get-Content -LiteralPath $tokenFile -Raw -Encoding UTF8).Trim()
}
if ([string]::IsNullOrWhiteSpace($token)) {
    $token = [string]$config.allocatorToken
}
if ([string]::IsNullOrWhiteSpace($token)) {
    throw 'Gateway token is not configured.'
}

$listenHost = if ([string]::IsNullOrWhiteSpace([string]$config.listenHost)) {
    '127.0.0.1'
} elseif ([string]$config.listenHost -in @('0.0.0.0', '::')) {
    '127.0.0.1'
} else {
    [string]$config.listenHost
}
$protocol = if (-not [string]::IsNullOrWhiteSpace([string]$config.tlsKeyFile)) {
    'https'
} else {
    'http'
}
$gatewayUrl = "${protocol}://${listenHost}:$($config.listenPort)"

Invoke-RestMethod `
    -Uri "$gatewayUrl/shutdown" `
    -Headers @{ 'X-Gateway-Token' = $token } `
    -Method Post `
    -ContentType 'application/json' `
    -Body '{}' `
    -TimeoutSec 15 | Out-Null

Write-Host "[gateway] Shutdown accepted: $gatewayUrl"
