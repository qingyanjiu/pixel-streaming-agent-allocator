param(
    [string]$AllocatorConfig,
    [string]$WorkersFile,
    [string]$AllocatorUrl,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$rootDirectory = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($AllocatorConfig)) {
    $AllocatorConfig = Join-Path $rootDirectory 'Allocator\allocator.json'
}

if (-not (Test-Path -LiteralPath $AllocatorConfig -PathType Leaf)) {
    throw "Allocator configuration not found: $AllocatorConfig"
}

$AllocatorConfig = [System.IO.Path]::GetFullPath($AllocatorConfig)
$allocatorConfigDirectory = Split-Path -Parent $AllocatorConfig
$allocator = Get-Content -LiteralPath $AllocatorConfig -Raw -Encoding UTF8 |
    ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($WorkersFile)) {
    if (-not [string]::IsNullOrWhiteSpace($allocator.workersFile)) {
        $WorkersFile = if ([System.IO.Path]::IsPathRooted([string]$allocator.workersFile)) {
            [string]$allocator.workersFile
        } else {
            Join-Path $allocatorConfigDirectory ([string]$allocator.workersFile)
        }
    } else {
        $WorkersFile = Join-Path $allocatorConfigDirectory 'config\workers.json'
    }
}

if (-not (Test-Path -LiteralPath $WorkersFile -PathType Leaf)) {
    throw "Worker registry not found: $WorkersFile"
}

$WorkersFile = [System.IO.Path]::GetFullPath($WorkersFile)
$workerRegistry = Get-Content -LiteralPath $WorkersFile -Raw -Encoding UTF8 |
    ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($AllocatorUrl)) {
    $listenPort = if ($allocator.listenPort) { [int]$allocator.listenPort } else { 9200 }
    $AllocatorUrl = "http://127.0.0.1:$listenPort"
}
$AllocatorUrl = $AllocatorUrl.TrimEnd('/')

function Get-ConfiguredSecret {
    param(
        $Value,
        [string]$EnvironmentName
    )

    if (-not [string]::IsNullOrWhiteSpace($EnvironmentName)) {
        $environmentValue = [Environment]::GetEnvironmentVariable($EnvironmentName)
        if (-not [string]::IsNullOrWhiteSpace($environmentValue)) {
            return $environmentValue
        }
    }
    return [string]$Value
}

function Stop-LocalAllocatorProcess {
    param([string]$Url)

    try {
        $uri = [System.Uri]$Url
    } catch {
        return $false
    }

    if ($uri.Host -notin @('127.0.0.1', 'localhost', '::1')) {
        return $false
    }

    $listener = Get-NetTCPConnection `
        -State Listen `
        -LocalPort $uri.Port `
        -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $listener) {
        return $false
    }

    $ownerProcessId = [int]$listener.OwningProcess
    $process = Get-Process -Id $ownerProcessId -ErrorAction SilentlyContinue
    if (-not $process -or $process.ProcessName -notlike 'node*') {
        return $false
    }

    Stop-Process -Id $ownerProcessId -Force
    Write-Host "[stop-all] Stopped local Allocator process pid=$ownerProcessId on port $($uri.Port)"
    return $true
}

$workerResults = @()
$workers = @($workerRegistry.workers)

Write-Host "[stop-all] Root: $rootDirectory"
Write-Host "[stop-all] Worker registry: $WorkersFile"
Write-Host "[stop-all] Workers: $($workers.Count)"

foreach ($worker in $workers) {
    $workerUrl = ([string]$worker.baseUrl).TrimEnd('/')
    $token = Get-ConfiguredSecret -Value $worker.token -EnvironmentName ([string]$worker.tokenEnv)
    $headers = @{}
    if (-not [string]::IsNullOrWhiteSpace($token)) {
        $headers.Authorization = "Bearer $token"
    }

    if ($DryRun) {
        Write-Host "[stop-all] Would shut down worker=$($worker.id) url=$workerUrl"
        $workerResults += [pscustomobject]@{
            Worker = $worker.id
            Url = $workerUrl
            Status = 'would_shutdown'
            RunningSlots = $null
            Error = $null
        }
        continue
    }

    try {
        $slotState = Invoke-RestMethod `
            -Uri "$workerUrl/slots" `
            -Headers $headers `
            -Method Get `
            -TimeoutSec 15
        $runningSlots = @($slotState.slots | Where-Object { $_.running -eq $true })
        $runningIds = @($runningSlots | ForEach-Object { $_.id }) -join ', '
        Write-Host "[stop-all] Worker $($worker.id): stopping $($runningSlots.Count) running Slot(s): $runningIds"

        Invoke-RestMethod `
            -Uri "$workerUrl/shutdown" `
            -Headers $headers `
            -Method Post `
            -ContentType 'application/json' `
            -Body '{}' `
            -TimeoutSec 30 | Out-Null

        $workerResults += [pscustomobject]@{
            Worker = $worker.id
            Url = $workerUrl
            Status = 'shutdown_accepted'
            RunningSlots = $runningSlots.Count
            Error = $null
        }
    } catch {
        $errorMessage = $_.Exception.Message
        Write-Warning "[stop-all] Worker $($worker.id) could not be shut down: $errorMessage"
        $workerResults += [pscustomobject]@{
            Worker = $worker.id
            Url = $workerUrl
            Status = 'failed'
            RunningSlots = $null
            Error = $errorMessage
        }
    }
}

$allocatorStatus = 'not_attempted'
if ($DryRun) {
    Write-Host "[stop-all] Would shut down Allocator url=$AllocatorUrl"
    $allocatorStatus = 'would_shutdown'
} else {
    $apiKey = Get-ConfiguredSecret -Value $allocator.apiKey -EnvironmentName ([string]$allocator.apiKeyEnv)
    $allocatorHeaders = @{}
    if (-not [string]::IsNullOrWhiteSpace($apiKey)) {
        $allocatorHeaders['X-API-Key'] = $apiKey
    }
    try {
        Invoke-RestMethod `
            -Uri "$AllocatorUrl/shutdown" `
            -Headers $allocatorHeaders `
            -Method Post `
            -ContentType 'application/json' `
            -Body '{}' `
            -TimeoutSec 15 | Out-Null
        $allocatorStatus = 'shutdown_accepted'
        Write-Host "[stop-all] Allocator shutdown accepted: $AllocatorUrl"
    } catch {
        Write-Warning "[stop-all] Allocator shutdown endpoint failed: $($_.Exception.Message)"
        if (Stop-LocalAllocatorProcess -Url $AllocatorUrl) {
            $allocatorStatus = 'process_stopped'
        } else {
            $allocatorStatus = 'failed'
        }
    }
}

$workerResults | Format-Table Worker, Url, Status, RunningSlots, Error -AutoSize
Write-Host "[stop-all] Summary: workers=$($workers.Count), failed=$(@($workerResults | Where-Object Status -eq 'failed').Count), allocator=$allocatorStatus"

$failedWorkers = @($workerResults | Where-Object Status -eq 'failed').Count
$allocatorFailed = $allocatorStatus -eq 'failed'
if ($failedWorkers -gt 0 -or $allocatorFailed) {
    exit 1
}
exit 0
