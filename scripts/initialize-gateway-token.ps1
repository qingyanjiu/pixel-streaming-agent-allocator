param(
    [string]$OutputFile
)

$ErrorActionPreference = 'Stop'
$rootDirectory = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputFile)) {
    $OutputFile = Join-Path $rootDirectory 'secrets\gateway-token.txt'
}
$OutputFile = [System.IO.Path]::GetFullPath($OutputFile)

if (Test-Path -LiteralPath $OutputFile -PathType Leaf) {
    Write-Host "[secrets] Gateway token already exists; it was not changed."
    exit 0
}

$secretsDirectory = Split-Path -Parent $OutputFile
New-Item -ItemType Directory -Path $secretsDirectory -Force | Out-Null

$bytes = New-Object byte[] 48
$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $random.GetBytes($bytes)
} finally {
    $random.Dispose()
}
$token = [Convert]::ToBase64String($bytes).
    TrimEnd('=').
    Replace('+', '-').
    Replace('/', '_')

[System.IO.File]::WriteAllText(
    $OutputFile,
    $token,
    [System.Text.UTF8Encoding]::new($false)
)
Write-Host "[secrets] Generated Gateway token: $OutputFile"
Write-Warning 'Copy this file securely to every Gateway and the Allocator; never commit it.'
