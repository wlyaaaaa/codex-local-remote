[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LauncherPath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot,

    [Parameter(Mandatory)]
    [ValidateSet('live-v3', 'live-v4', 'live-v5', 'unverified')]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
. $LauncherPath -DefinitionOnly

$dataDir = Join-Path $SandboxRoot 'Data'
$runtimeRoot = Join-Path $SandboxRoot 'RuntimeVersions\same'
$null = New-Item -ItemType Directory -Path $dataDir -Force
$receipt = [ordered]@{
    Signature = 'codex-local-remote/app-server-broker/v3'
    Version = 3
    Status = 'ready'
    RuntimeInvocationId = '0123456789abcdef0123456789abcdef'
    ProcessId = 4101
    BrokerCliPath = Join-Path $runtimeRoot 'apps\broker\dist\cli.js'
    NodePath = Join-Path $SandboxRoot 'node.exe'
    CodexPath = Join-Path $SandboxRoot 'codex.exe'
    Bootstrap = [ordered]@{
        RuntimeInvocationId = '0123456789abcdef0123456789abcdef'
        ProcessId = 4100
        CreationDate = '2026-07-29T00:00:00.0000000Z'
        CreationDateUtcTicks = 639209664000000000
        ProcessStartTimeUtcTicks = 639209664000000000
    }
    Upstream = [ordered]@{
        ProcessId = 4102
    }
    Padding = ('x' * 128)
}
$receipt |
    ConvertTo-Json -Depth 20 |
    Set-Content `
        -LiteralPath (Join-Path $dataDir 'app-server-broker.json') `
        -Encoding utf8

$script:switchCount = 0
$script:switchedStatus = $null
$versionId = 'a' * 64

function Get-CodexLocalRemoteCurrentRuntime {
    param([string]$DataDir)

    $null = $DataDir
    return [pscustomobject]@{
        CurrentVersionId = $versionId
        CurrentRoot = $runtimeRoot
        HasCurrentTaskDefinition = $true
        CurrentTaskDefinitionTaskName = 'Codex Local Remote'
        CurrentTaskDefinitionRuntimeVersionId = $versionId
        CurrentTaskDefinitionRuntimeRoot = $runtimeRoot
        CurrentTaskDefinitionSha256 = ('b' * 64)
    }
}

function Get-CodexLocalRemoteRegisteredBootstrapEvidence {
    return [pscustomobject]@{
        Status = 'exact-v5'
        TaskState = 'Running'
        PwshPath = Join-Path $SandboxRoot 'pwsh.exe'
    }
}

function Get-CodexLocalRemoteActiveBootstrapEvidence {
    if ($Mode -ceq 'unverified') {
        return [pscustomobject]@{
            Status = 'unverified'
            Contract = 'unverified'
        }
    }
    return [pscustomobject]@{
        Status = 'verified'
        Contract = switch ($Mode) {
            'live-v3' { 'desktop-owner-v3' }
            'live-v4' { 'headless-v4' }
            default { 'desktop-owner-v5' }
        }
        ProcessId = 4100
        CreationDateUtcTicks = 639209664000000000
        ProcessStartTimeUtcTicks = 639209664000000000
        RuntimeInvocationId = '0123456789abcdef0123456789abcdef'
    }
}

function Get-ScheduledTask {
    return [pscustomobject]@{
        TaskName = 'Codex Local Remote'
        TaskPath = '\'
        Description = (
            'codex-local-remote/startup-task/v5 - Starts the loopback ' +
            'app-server broker before the local-only Codex Local Remote ' +
            'sidecar at user sign-in.'
        )
        State = 'Running'
    }
}

function Get-RunningCodexDesktopProcesses {
    return @()
}

function Get-CodexDesktopHandoffProcesses {
    return @()
}

function Resolve-CodexDesktopRuntime {
    return [pscustomobject]@{
        Signature = 'codex-local-remote/codex-desktop-runtime/v1'
        Version = 1
        PackageFullName =
            'OpenAI.Codex_fixture_x64__2p2nqsd0c76g0'
        CodexSha256 = 'C' * 64
    }
}

function Get-CodexLocalRemoteActiveCodexRuntimeStatus {
    return [pscustomobject]@{
        Status = 'current'
    }
}

function Get-CodexLocalRemoteReadinessSnapshot {
    return [pscustomobject]@{
        status = 'ready'
        appServerReady = $true
        desktopConnected = $false
        sidecarConnected = $true
        degraded = $false
        unknownCount = 0
        unsafeThreadCount = 0
        runtimeInvocationId = '0123456789abcdef0123456789abcdef'
        brokerProcessId = 4101
        upstreamProcessId = 4102
    }
}

function Switch-CodexLocalRemoteRuntimeGeneration {
    param([object]$Generation)

    $script:switchCount++
    $script:switchedStatus = [string]$Generation.Status
}

$succeeded = $true
$errorCode = $null
try {
    Start-CodexLocalRemoteRegisteredTask `
        -Name 'Codex Local Remote' `
        -ManagedDataDir $dataDir `
        -ManagedSidecarPort 18790 `
        -ManagedBrokerPort 18791 `
        -ManagedBrokerUpstreamPort 18792 `
        -ManagedBasePath '/codex-remote'
} catch {
    $succeeded = $false
    $errorCode = [string]$_.Exception.Data['CodexRemoteFailureCode']
}

[pscustomobject]@{
    Mode = $Mode
    Succeeded = $succeeded
    SwitchCount = $script:switchCount
    SwitchedStatus = $script:switchedStatus
    ErrorCode = $errorCode
} | ConvertTo-Json -Compress
