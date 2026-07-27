[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ModulePath,

    [Parameter(Mandatory)]
    [ValidateSet('same', 'path-drift', 'hash-drift', 'invalid-active')]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
Import-Module $ModulePath -Force

$sameHash = ('A' * 64)
$active = [pscustomobject]@{
    Signature = if ($Mode -ceq 'invalid-active') {
        'foreign/runtime'
    } else {
        'codex-local-remote/codex-desktop-runtime/v1'
    }
    Version = 1
    CodexPath = 'C:\Managed\Codex\codex.exe'
    CodexSha256 = $sameHash
}
$current = [pscustomobject]@{
    Signature = 'codex-local-remote/codex-desktop-runtime/v1'
    Version = 1
    CodexPath = if ($Mode -ceq 'path-drift') {
        'C:\Managed\Codex-New\codex.exe'
    } else {
        'C:\Managed\Codex\codex.exe'
    }
    CodexSha256 = if ($Mode -ceq 'hash-drift') {
        ('B' * 64)
    } else {
        $sameHash
    }
}

Test-ActiveCodexRuntimeMatchesCurrentDiscovery `
    -ActiveRuntime $active `
    -CurrentRuntime $current |
    ConvertTo-Json -Compress
