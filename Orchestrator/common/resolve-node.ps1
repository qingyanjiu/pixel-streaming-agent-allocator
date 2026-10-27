param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'

try {
    $resolvedConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
    $configDirectory = [System.IO.Path]::GetDirectoryName($resolvedConfigPath)
    $config = Get-Content -LiteralPath $resolvedConfigPath -Raw -Encoding UTF8 |
        ConvertFrom-Json

    $candidate = $env:PS_NODE_EXE
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $candidate = $config.nodeExecutable
    }

    if (-not [string]::IsNullOrWhiteSpace($candidate)) {
        if (-not [System.IO.Path]::IsPathRooted($candidate)) {
            $baseDirectory = $config.webServersDirectory
            if ([string]::IsNullOrWhiteSpace($baseDirectory)) {
                $baseDirectory = $configDirectory
            } elseif (-not [System.IO.Path]::IsPathRooted($baseDirectory)) {
                $baseDirectory = Join-Path $configDirectory $baseDirectory
            }
            $candidate = Join-Path $baseDirectory $candidate
        }
        $candidate = [System.IO.Path]::GetFullPath($candidate)
    }

    if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($null -ne $systemNode) {
            $candidate = $systemNode.Source
        }
    }

    if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "Node.js was not found. Set PS_NODE_EXE or fix nodeExecutable in $resolvedConfigPath."
    }

    Write-Output $candidate
}
catch {
    Write-Error $_
    exit 1
}
