[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LauncherPath,

    [Parameter(Mandatory)]
    [ValidateSet(
        'unsafe-after-task-stop',
        'unknown-after-task-stop',
        'generation-drift-after-task-stop',
        'broker-unreachable-after-task-stop'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
. $LauncherPath -DefinitionOnly

$fixtureRoot = Join-Path `
    ([System.IO.Path]::GetTempPath()) `
    "codex-runtime-restart-$PID-$([guid]::NewGuid().ToString('N'))"
$runtimeRoot = Join-Path $fixtureRoot 'runtime'
$scriptRoot = Join-Path $runtimeRoot 'scripts\windows'
$null = New-Item -ItemType Directory -Path $scriptRoot -Force
$sidecarStopPath = Join-Path `
    $scriptRoot `
    'Stop-CodexLocalRemoteSidecar.ps1'
$brokerStopPath = Join-Path `
    $scriptRoot `
    'Stop-CodexAppServerBroker.ps1'
'$global:FixtureSidecarStopCalls += 1' |
    Set-Content -LiteralPath $sidecarStopPath -Encoding utf8
'$global:FixtureBrokerStopCalls += 1' |
    Set-Content -LiteralPath $brokerStopPath -Encoding utf8

$global:FixtureSidecarStopCalls = 0
$global:FixtureBrokerStopCalls = 0
$script:taskStopCalls = 0
$script:taskStartCalls = 0
$script:generationObservations = 0
$script:readinessObservations = 0
$runtimeInvocationId = 'a' * 32
$brokerProcessId = 41001
$upstreamProcessId = 41002

function New-FixtureGeneration {
    param([switch]$Drifted)

    return [pscustomobject]@{
        Status = 'current'
        SelectedRoot = $runtimeRoot
        ActiveRoot = $(if ($Drifted) {
            Join-Path $fixtureRoot 'foreign-runtime'
        } else {
            $runtimeRoot
        })
        RegisteredTask = [pscustomobject]@{
            TaskState = 'Running'
        }
        ActiveBootstrap = [pscustomobject]@{
            Status = 'verified'
            Contract = 'desktop-owner-v5'
        }
        Receipt = [pscustomobject]@{
            RuntimeInvocationId = $runtimeInvocationId
            ProcessId = $brokerProcessId
            NodePath = Join-Path $fixtureRoot 'node.exe'
            CodexPath = Join-Path $fixtureRoot 'codex.exe'
            Upstream = [pscustomobject]@{
                ProcessId = $upstreamProcessId
            }
        }
    }
}

$generation = New-FixtureGeneration

function Get-CodexDesktopHandoffProcesses {
    return @()
}

function Get-CodexLocalRemoteActiveCodexRuntimeStatus {
    return [pscustomobject]@{
        Status = 'drifted'
    }
}

function Get-CodexLocalRemoteRuntimeGenerationStatus {
    $script:generationObservations += 1
    return New-FixtureGeneration -Drifted:$(
        $Mode -ceq 'generation-drift-after-task-stop' -and
        $script:generationObservations -ge 3
    )
}

function Get-CodexLocalRemoteReadinessSnapshot {
    $script:readinessObservations += 1
    if ($Mode -ceq 'broker-unreachable-after-task-stop' -and
        $script:readinessObservations -ge 3) {
        return $null
    }
    return [pscustomobject]@{
        status = 'ready'
        appServerReady = $true
        desktopConnected = $false
        sidecarConnected = $true
        degraded = $false
        unknownCount = $(if (
            $Mode -ceq 'unknown-after-task-stop' -and
            $script:readinessObservations -ge 3
        ) { 1 } else { 0 })
        unsafeThreadCount = $(if (
            $Mode -ceq 'unsafe-after-task-stop' -and
            $script:readinessObservations -ge 3
        ) { 1 } else { 0 })
        runtimeInvocationId = $runtimeInvocationId
        brokerProcessId = $brokerProcessId
        upstreamProcessId = $upstreamProcessId
    }
}

function Stop-ScheduledTask {
    $script:taskStopCalls += 1
}

function Wait-CodexLocalRemoteScheduledTaskStoppedBounded {
    return $null
}

function Start-CodexLocalRemoteScheduledTaskBounded {
    $script:taskStartCalls += 1
}

function Wait-CodexLocalRemoteCodexRuntimeReady {
    return [pscustomobject]@{
        Status = 'current'
    }
}

function Start-Sleep {
    return $null
}

$failure = $null
$succeeded = $true
try {
    $null = Restart-CodexLocalRemoteCodexRuntime `
        -Name 'Codex Local Remote' `
        -Generation $generation `
        -CurrentRuntime ([pscustomobject]@{}) `
        -ManagedDataDir (Join-Path $fixtureRoot 'data') `
        -ManagedSidecarPort 18790 `
        -ManagedBrokerPort 18791 `
        -ManagedBrokerUpstreamPort 18792 `
        -ManagedBasePath '/codex-remote'
} catch {
    $succeeded = $false
    $failure = $_.Exception.Message
}

[pscustomobject][ordered]@{
    Succeeded = $succeeded
    Failure = [string]$failure
    TaskStopCalls = $script:taskStopCalls
    TaskStartCalls = $script:taskStartCalls
    SidecarStopCalls = $global:FixtureSidecarStopCalls
    BrokerStopCalls = $global:FixtureBrokerStopCalls
    GenerationObservations = $script:generationObservations
    ReadinessObservations = $script:readinessObservations
} | ConvertTo-Json -Compress

Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
Remove-Variable `
    -Name FixtureSidecarStopCalls, FixtureBrokerStopCalls `
    -Scope Global `
    -ErrorAction SilentlyContinue
