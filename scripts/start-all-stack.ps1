param(
    [string]$WorkerConfig = 'Worker\worker01.json',
    [switch]$NoGateway,
    [switch]$NoBrowser,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$rootDirectory = Split-Path -Parent $PSScriptRoot
$gatewayConfigPath = Join-Path $rootDirectory 'Gateway\gateway.json'
$gatewayStartScript = Join-Path $rootDirectory 'Gateway\start-gateway.bat'
$workerStartScript = Join-Path $rootDirectory 'Worker\start-worker.bat'
$allocatorStartScript = Join-Path $rootDirectory 'Allocator\start-allocator.bat'

if (-not [System.IO.Path]::IsPathRooted($WorkerConfig)) {
    $candidate = Join-Path $rootDirectory $WorkerConfig
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $WorkerConfig = $candidate
    } elseif (Test-Path -LiteralPath (Join-Path $rootDirectory "Worker\$WorkerConfig") -PathType Leaf) {
        $WorkerConfig = Join-Path $rootDirectory "Worker\$WorkerConfig"
    } elseif (Test-Path -LiteralPath (Join-Path $rootDirectory "Worker\$WorkerConfig.json") -PathType Leaf) {
        $WorkerConfig = Join-Path $rootDirectory "Worker\$WorkerConfig.json"
    }
}

if (-not (Test-Path -LiteralPath $WorkerConfig -PathType Leaf)) {
    throw "Worker config not found: $WorkerConfig"
}
if (-not (Test-Path -LiteralPath $gatewayConfigPath -PathType Leaf)) {
    throw "Gateway config not found: $gatewayConfigPath"
}

$WorkerConfig = [System.IO.Path]::GetFullPath($WorkerConfig)
$workerSettings = Get-Content -LiteralPath $WorkerConfig -Raw -Encoding UTF8 |
    ConvertFrom-Json
$gatewayConfig = Get-Content -LiteralPath $gatewayConfigPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
$allocatorUri = [Uri][string]$gatewayConfig.allocatorUrl
$allocatorBaseUrl = $allocatorUri.GetLeftPart([UriPartial]::Authority)
$allocatorHealthUrl = "$allocatorBaseUrl/health"
$dashboardUrl = "$allocatorBaseUrl/dashboard/"
$workerHealthUrl = "http://127.0.0.1:$($workerSettings.listenPort)/health"
$gatewayHealthUrl = "http://127.0.0.1:$($gatewayConfig.listenPort)/health"

function Test-ServiceHealth {
    param([string]$Url)
    try {
        $response = Invoke-RestMethod -Uri $Url -TimeoutSec 3
        return $response.ok -eq $true
    } catch {
        return $false
    }
}

function Wait-ServiceHealth {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 25
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-ServiceHealth -Url $Url) {
            return $true
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Test-AllocatorIsLocal {
    $allocatorHost = $allocatorUri.Host
    if ($allocatorHost -in @('localhost', '127.0.0.1', '::1')) {
        return $true
    }
    $localAddresses = @(
        [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
            ForEach-Object { $_.IPAddressToString }
    )
    return $allocatorHost -in $localAddresses
}

$allocatorIsLocal = Test-AllocatorIsLocal
$allocatorRunning = Test-ServiceHealth -Url $allocatorHealthUrl

if (-not $allocatorRunning -and -not $allocatorIsLocal) {
    throw "Remote Allocator is not reachable: $allocatorHealthUrl. Start it on $($allocatorUri.Host) first."
}

if ($allocatorIsLocal -and -not $allocatorRunning) {
    Write-Host "[start-all] Starting Allocator: $allocatorStartScript"
    if (-not $DryRun) {
        Start-Process `
            -FilePath $allocatorStartScript `
            -WorkingDirectory $rootDirectory `
            -WindowStyle Normal
        if (-not (Wait-ServiceHealth -Url $allocatorHealthUrl -TimeoutSeconds 20)) {
            throw "Allocator did not become healthy: $allocatorHealthUrl"
        }
    }
} elseif ($allocatorRunning) {
    Write-Host "[start-all] Allocator already running: $allocatorBaseUrl"
} elseif ($DryRun) {
    Write-Host "[start-all] Would start Allocator: $allocatorHealthUrl"
}

$workerRunning = Test-ServiceHealth -Url $workerHealthUrl
$gatewayRunning = Test-ServiceHealth -Url $gatewayHealthUrl
if ($gatewayRunning) {
    $gatewayHealth = Invoke-RestMethod -Uri $gatewayHealthUrl -TimeoutSec 3
    if ($gatewayHealth.agentId -ne $workerSettings.agentId) {
        throw "Port $($gatewayConfig.listenPort) belongs to Gateway $($gatewayHealth.agentId), expected $($workerSettings.agentId)."
    }
}
$workerStarted = $false
if ($workerRunning) {
    $workerHealth = Invoke-RestMethod -Uri $workerHealthUrl -TimeoutSec 3
    if ($workerHealth.agentId -ne $workerSettings.agentId) {
        throw "Port $($workerSettings.listenPort) belongs to $($workerHealth.agentId), expected $($workerSettings.agentId)."
    }
    Write-Host "[start-all] Worker already running: $($workerSettings.agentId)"
} else {
    $workerArguments = @($WorkerConfig)
    if ($NoGateway -or $gatewayRunning) {
        $workerArguments += '--no-gateway'
    }
    Write-Host "[start-all] Starting Worker: $WorkerConfig"
    if (-not $DryRun) {
        Start-Process `
            -FilePath $workerStartScript `
            -ArgumentList $workerArguments `
            -WorkingDirectory $rootDirectory `
            -WindowStyle Normal
        if (-not (Wait-ServiceHealth -Url $workerHealthUrl -TimeoutSeconds 30)) {
            throw "Worker did not become healthy: $workerHealthUrl"
        }
        $workerStarted = $true
    }
}

if (-not $NoGateway -and -not $gatewayRunning) {
    if ($DryRun) {
        Write-Host "[start-all] Would start Gateway: $gatewayHealthUrl"
    } elseif (-not $workerStarted) {
        Write-Host "[start-all] Starting Gateway: $gatewayStartScript"
        Start-Process `
            -FilePath $gatewayStartScript `
            -ArgumentList @('Gateway\gateway.json', $WorkerConfig) `
            -WorkingDirectory $rootDirectory `
            -WindowStyle Normal
    }
    if (-not $DryRun -and -not (Wait-ServiceHealth -Url $gatewayHealthUrl -TimeoutSeconds 20)) {
        throw "Gateway did not become healthy: $gatewayHealthUrl"
    }
} elseif (-not $NoGateway -and $gatewayRunning) {
    Write-Host "[start-all] Gateway already running: $gatewayHealthUrl"
}

if ($NoBrowser) {
    Write-Host '[start-all] Browser launch disabled.'
} elseif (-not $DryRun) {
    Start-Process -FilePath $dashboardUrl
}

Write-Host "[start-all] Allocator: $allocatorHealthUrl"
Write-Host "[start-all] Worker:    $workerHealthUrl"
if (-not $NoGateway) {
    Write-Host "[start-all] Gateway:   $gatewayHealthUrl"
}
