[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LauncherPath
)

$ErrorActionPreference = 'Stop'
. $LauncherPath -DefinitionOnly

$originalOverride = 'ws://127.0.0.1:49999/original-parent-value'
$capabilityEndpoint = (
    'ws://127.0.0.1:18791/ws/' +
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789_-'
)
$env:CODEX_APP_SERVER_WS_URL = $originalOverride
$captureScript = (
    '[Console]::Out.Write(' +
    '[string]$env:CODEX_APP_SERVER_WS_URL)'
)

function Invoke-EnvironmentCapture {
    param([AllowNull()][string]$RemoteEndpoint)

    $process = Start-CodexDesktopProcess `
        -DesktopExecutablePath (Join-Path $PSHOME 'pwsh.exe') `
        -RemoteEndpoint $RemoteEndpoint `
        -ArgumentList @(
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            $captureScript
        ) `
        -RedirectStandardOutput `
        -TestElevatedAction { $false }
    try {
        $captured = $process.StandardOutput.ReadToEnd()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            throw "Environment capture child exited with $($process.ExitCode)."
        }
        return $captured
    } finally {
        $process.Dispose()
    }
}

[pscustomobject]@{
    RemoteChildOverride = Invoke-EnvironmentCapture `
        -RemoteEndpoint $capabilityEndpoint
    NativeChildOverride = Invoke-EnvironmentCapture -RemoteEndpoint $null
    ParentOverride = [string]$env:CODEX_APP_SERVER_WS_URL
    OriginalOverride = $originalOverride
    CapabilityEndpoint = $capabilityEndpoint
} | ConvertTo-Json -Compress
