param(
    [string]$ConfigPath = 'worker01.json',
    [string]$SlotId,
    [switch]$All
)

$ErrorActionPreference = 'Stop'

function Resolve-WorkerConfigPath {
    param([string]$PathValue)

    $candidate = if ([System.IO.Path]::IsPathRooted($PathValue)) {
        $PathValue
    } else {
        Join-Path $PSScriptRoot $PathValue
    }

    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf) -and -not $candidate.EndsWith('.json')) {
        $candidate = "$candidate.json"
    }

    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "Worker configuration not found: $candidate"
    }

    return [System.IO.Path]::GetFullPath($candidate)
}

try {
    $resolvedConfigPath = Resolve-WorkerConfigPath -PathValue $ConfigPath
    $config = Get-Content -LiteralPath $resolvedConfigPath -Raw -Encoding UTF8 |
        ConvertFrom-Json

    if (-not $All -and [string]::IsNullOrWhiteSpace($SlotId)) {
        throw 'Specify a Slot ID, or use stop-all-slots.bat.'
    }

    $token = $null
    if (-not [string]::IsNullOrWhiteSpace($config.authTokenEnv)) {
        $token = [Environment]::GetEnvironmentVariable([string]$config.authTokenEnv)
    }
    if ([string]::IsNullOrWhiteSpace($token)) {
        $token = $config.authToken
    }
    if ([string]::IsNullOrWhiteSpace($token)) {
        throw "No authToken/authTokenEnv configured in $resolvedConfigPath"
    }

    $listenPort = [int]$config.listenPort
    if ($listenPort -le 0) {
        throw "Invalid listenPort in $resolvedConfigPath"
    }

    $headers = @{
        Authorization = "Bearer $token"
    }
    $baseUrl = "http://127.0.0.1:$listenPort"
    $state = Invoke-RestMethod `
        -Uri "$baseUrl/slots" `
        -Headers $headers `
        -Method Get `
        -TimeoutSec 10

    $targets = if ($All) {
        @($state.slots)
    } else {
        @($state.slots | Where-Object { $_.id -eq $SlotId })
    }

    if ($targets.Count -eq 0) {
        $available = @($state.slots | ForEach-Object { $_.id }) -join ', '
        throw "Slot '$SlotId' was not found. Available slots: $available"
    }

    Write-Host "[Worker] Config: $resolvedConfigPath"
    Write-Host "[Worker] Agent:  $baseUrl"

    foreach ($target in $targets) {
        Write-Host "[Worker] Stopping slot $($target.id) (current status: $($target.status))..."
        $escapedSlotId = [System.Uri]::EscapeDataString([string]$target.id)
        $result = Invoke-RestMethod `
            -Uri "$baseUrl/slots/$escapedSlotId/stop" `
            -Headers $headers `
            -Method Post `
            -TimeoutSec 30
        Write-Host "[Worker] Slot $($result.id) stopped. status=$($result.status), running=$($result.running)"
    }

    exit 0
}
catch {
    Write-Error $_
    exit 1
}
