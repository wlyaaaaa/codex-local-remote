[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LauncherPath
)

$ErrorActionPreference = 'Stop'
. $LauncherPath -DefinitionOnly

$script:taskStopCalls = 0
$script:taskStartCalls = 0
$script:restartActionCalls = 0
$script:desktopStartCalls = 0

function Get-CodexDesktopHandoffProcesses {
    throw 'fixture strict CIM enumeration failed'
}

function Stop-ScheduledTask {
    $script:taskStopCalls += 1
}

function Start-CodexLocalRemoteScheduledTaskBounded {
    $script:taskStartCalls += 1
}

$failure = $null
try {
    $null = Restart-CodexLocalRemoteCodexRuntime `
        -Name 'Codex Local Remote' `
        -Generation ([pscustomobject]@{
            Status = 'current'
            RegisteredTask = [pscustomobject]@{
                TaskState = 'Running'
            }
            ActiveBootstrap = [pscustomobject]@{
                Status = 'verified'
                Contract = 'desktop-owner-v5'
            }
        }) `
        -CurrentRuntime ([pscustomobject]@{}) `
        -ManagedDataDir 'C:\Data' `
        -ManagedSidecarPort 18790 `
        -ManagedBrokerPort 18791 `
        -ManagedBrokerUpstreamPort 18792 `
        -ManagedBasePath '/codex-remote'
} catch {
    $failure = $_.Exception.Message
}

[pscustomobject][ordered]@{
    Failure = [string]$failure
    RestartActionCalls = $script:restartActionCalls
    TaskStopCalls = $script:taskStopCalls
    TaskStartCalls = $script:taskStartCalls
    DesktopStartCalls = $script:desktopStartCalls
} | ConvertTo-Json -Compress
