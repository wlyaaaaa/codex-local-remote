[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LauncherPath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot,

    [Parameter(Mandatory)]
    [ValidateSet('stale-worker', 'fresh-unclaimed')]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
$dataDir = Join-Path $SandboxRoot 'Data'
$null = New-Item -ItemType Directory -Path $dataDir -Force
. $LauncherPath -DefinitionOnly

$rootKey = '42001|638899999999999999|' + ('a' * 64)
$runtimeInvocationId = 'fedcba9876543210fedcba9876543210'
$originalIntentId = '0123456789abcdef0123456789abcdef'
$script:spawnCalls = 0

function Get-CodexDesktopRootIdentityKeys {
    return @($rootKey)
}

function Start-Process {
    $script:spawnCalls += 1
    $process = [pscustomobject]@{
        Id = 54321
    }
    $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
    return $process
}

Write-AtomicJsonFile `
    -Path (Join-Path $dataDir 'desktop-package-refresh-intent.json') `
    -Value ([ordered]@{
        Signature =
            'codex-local-remote/desktop-package-refresh-intent/v1'
        Version = 1
        IntentId = $originalIntentId
        WorkerNonce = '1234567890abcdef1234567890abcdef'
        ExpectedRootIdentityKey = $rootKey
        ExpectedRuntimeInvocationId = $runtimeInvocationId
        WorkerProcessId = $(if ($Mode -ceq 'fresh-unclaimed') {
            0
        } else {
            2147483000
        })
        WorkerStartTimeUtcTicks = $(if ($Mode -ceq 'fresh-unclaimed') {
            0
        } else {
            638899999999999999
        })
        RequestedAtUtc = [DateTime]::UtcNow.ToString('O')
    })

$started = Start-CodexLocalRemotePackageRefreshWorker `
    -Name 'Codex Local Remote' `
    -ManagedDataDir $dataDir `
    -ManagedSidecarPort 18790 `
    -ManagedBrokerPort 18791 `
    -ManagedBrokerUpstreamPort 18792 `
    -ManagedBasePath '/codex-remote' `
    -ExpectedRootIdentityKey $rootKey `
    -ExpectedRuntimeInvocationId $runtimeInvocationId
$intent = Get-Content `
    -LiteralPath (Join-Path $dataDir 'desktop-package-refresh-intent.json') `
    -Raw `
    -Encoding utf8 |
    ConvertFrom-Json -Depth 8

[pscustomobject][ordered]@{
    Started = [bool]$started
    SpawnCalls = $script:spawnCalls
    IntentReplaced =
        [string]$intent.IntentId -cne $originalIntentId
    ClaimStillUnowned = (
        [int]$intent.WorkerProcessId -eq 0 -and
        [long]$intent.WorkerStartTimeUtcTicks -eq 0
    )
} | ConvertTo-Json -Depth 8
