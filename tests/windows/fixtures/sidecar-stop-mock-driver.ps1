[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$TargetScript,

    [Parameter(Mandatory)]
    [string]$ScenarioFile,

    [Parameter(Mandatory)]
    [string]$NodePath,

    [Parameter(Mandatory)]
    [string]$SidecarCliPath,

    [Parameter(Mandatory)]
    [string]$DataDir,

    [int]$Port = 49732,

    [string]$BasePath = '/codex-remote',

    [int]$ExpectedProcessId = 0
)

$ErrorActionPreference = 'Stop'
$global:CodexRemoteSidecarStopScenario = Get-Content -LiteralPath $ScenarioFile -Raw |
    ConvertFrom-Json -Depth 20
$global:CodexRemoteSidecarStopListenerRead = 0
$global:CodexRemoteSidecarStopProcessRead = 0
$global:CodexRemoteSidecarStopHandleRead = 0
$global:CodexRemoteSidecarStopTrace = [System.Collections.Generic.List[string]]::new()
$global:CodexRemoteSidecarStopIds = [System.Collections.Generic.List[int]]::new()

function Get-NetTCPConnection {
    param(
        [object]$State,
        [int]$LocalPort,
        [object]$ErrorAction
    )

    $index = $global:CodexRemoteSidecarStopListenerRead
    $snapshots = @($global:CodexRemoteSidecarStopScenario.ListenerSnapshots)
    if ($index -ge $snapshots.Count) {
        throw "Unexpected listener snapshot read $index."
    }
    $global:CodexRemoteSidecarStopListenerRead += 1
    $global:CodexRemoteSidecarStopTrace.Add("listeners:$index")
    return @($snapshots[$index])
}

function Get-CimInstance {
    param(
        [string]$ClassName,
        [string]$Filter,
        [object]$ErrorAction
    )

    $index = $global:CodexRemoteSidecarStopProcessRead
    $snapshots = @($global:CodexRemoteSidecarStopScenario.ProcessSnapshots)
    if ($index -ge $snapshots.Count) {
        throw "Unexpected process snapshot read $index."
    }
    $global:CodexRemoteSidecarStopProcessRead += 1
    $global:CodexRemoteSidecarStopTrace.Add("process:${index}:$Filter")
    return $snapshots[$index]
}

function Get-Process {
    param(
        [int]$Id,
        [object]$ErrorAction
    )

    $global:CodexRemoteSidecarStopHandleRead += 1
    $snapshots = @($global:CodexRemoteSidecarStopScenario.ProcessSnapshots)
    $snapshot = @(
        $snapshots |
            Where-Object { $null -ne $_ -and [int]$_.ProcessId -eq $Id } |
            Select-Object -First 1
    )
    if ($snapshot.Count -ne 1) {
        throw "Mock process handle PID $Id is unavailable."
    }
    $startTime = [System.Management.ManagementDateTimeConverter]::ToDateTime(
        [string]$snapshot[0].CreationDate
    ).ToUniversalTime()
    $configuredTicks = $global:CodexRemoteSidecarStopScenario.PSObject.Properties[
        'HandleStartTimeUtcTicks'
    ]
    if ($null -ne $configuredTicks -and [long]$configuredTicks.Value -gt 0) {
        $startTime = [datetime]::new(
            [long]$configuredTicks.Value,
            [System.DateTimeKind]::Utc
        )
    }
    $handle = [pscustomobject]@{
        Id = $Id
        StartTime = $startTime.ToLocalTime()
        HasExited = $false
    }
    $handle | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
    $handle | Add-Member -MemberType ScriptMethod -Name Kill -Value {
        $global:CodexRemoteSidecarStopIds.Add([int]$this.Id)
        $global:CodexRemoteSidecarStopTrace.Add("stop:$($this.Id)")
        $stopError = $global:CodexRemoteSidecarStopScenario.PSObject.Properties['StopError']
        if ($null -ne $stopError -and
            -not [string]::IsNullOrEmpty([string]$stopError.Value)) {
            throw [string]$stopError.Value
        }
        $this.HasExited = $true
    }
    $handle | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
        param([int]$TimeoutMilliseconds)
        $global:CodexRemoteSidecarStopTrace.Add("wait:$($this.Id)")
        return $true
    }
    $handle | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
    return $handle
}

$parameters = @{
    NodePath = $NodePath
    ExpectedSidecarCliPath = $SidecarCliPath
    DataDir = $DataDir
    Port = $Port
    BasePath = $BasePath
    Confirm = $false
}
if ($ExpectedProcessId -gt 0) {
    $parameters.ExpectedProcessId = $ExpectedProcessId
}

$succeeded = $true
$errorMessage = $null
$result = $null
try {
    $result = & $TargetScript @parameters
} catch {
    $succeeded = $false
    $errorMessage = $_.Exception.Message
}

[pscustomobject]@{
    Succeeded = $succeeded
    Error = $errorMessage
    Result = $result
    StopIds = @($global:CodexRemoteSidecarStopIds)
    Trace = @($global:CodexRemoteSidecarStopTrace)
    ListenerReads = $global:CodexRemoteSidecarStopListenerRead
    ProcessReads = $global:CodexRemoteSidecarStopProcessRead
    HandleReads = $global:CodexRemoteSidecarStopHandleRead
} | ConvertTo-Json -Compress -Depth 20

if (-not $succeeded) {
    exit 1
}
