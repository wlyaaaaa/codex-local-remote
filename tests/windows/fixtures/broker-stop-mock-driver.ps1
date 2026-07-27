[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$TargetScript,

    [Parameter(Mandatory)]
    [string]$ScenarioFile,

    [Parameter(Mandatory)]
    [string]$NodePath,

    [Parameter(Mandatory)]
    [string]$CodexPath,

    [Parameter(Mandatory)]
    [string]$InstallRoot,

    [Parameter(Mandatory)]
    [string]$DataDir,

    [int]$BrokerPort = 49731,

    [int]$UpstreamPort = 49732
)

$ErrorActionPreference = 'Stop'
$global:CodexRemoteBrokerStopScenario = Get-Content -LiteralPath $ScenarioFile -Raw |
    ConvertFrom-Json -Depth 20
$global:CodexRemoteBrokerListenerRead = 0
$global:CodexRemoteUpstreamListenerRead = 0
$global:CodexRemoteBrokerProcessRead = 0
$global:CodexRemoteBrokerStopIds = [System.Collections.Generic.List[int]]::new()
$global:CodexRemoteBrokerStopTrace = [System.Collections.Generic.List[string]]::new()
$global:CodexRemoteBrokerProcessHandles = @{}

function Invoke-RestMethod {
    param(
        [object]$Method,
        [string]$Uri,
        [int]$TimeoutSec
    )

    $global:CodexRemoteBrokerStopTrace.Add("readiness:$Uri")
    return $global:CodexRemoteBrokerStopScenario.BrokerReadiness
}

function Get-NetTCPConnection {
    param(
        [object]$State,
        [int]$LocalPort,
        [object]$ErrorAction
    )

    if ($LocalPort -eq $BrokerPort) {
        $index = $global:CodexRemoteBrokerListenerRead
        $snapshots = @($global:CodexRemoteBrokerStopScenario.BrokerListenerSnapshots)
        $global:CodexRemoteBrokerListenerRead += 1
        $global:CodexRemoteBrokerStopTrace.Add("broker-listeners:$index")
    } elseif ($LocalPort -eq $UpstreamPort) {
        $index = $global:CodexRemoteUpstreamListenerRead
        $snapshots = @($global:CodexRemoteBrokerStopScenario.UpstreamListenerSnapshots)
        $global:CodexRemoteUpstreamListenerRead += 1
        $global:CodexRemoteBrokerStopTrace.Add("upstream-listeners:$index")
    } else {
        throw "Unexpected listener port $LocalPort."
    }
    if ($index -ge $snapshots.Count) {
        throw "Unexpected listener snapshot read $index for port $LocalPort."
    }
    return @($snapshots[$index])
}

function Get-CimInstance {
    param(
        [string]$ClassName,
        [string]$Filter,
        [object]$ErrorAction
    )

    $index = $global:CodexRemoteBrokerProcessRead
    $snapshots = @($global:CodexRemoteBrokerStopScenario.ProcessSnapshots)
    if ($index -ge $snapshots.Count) {
        throw "Unexpected process snapshot read $index."
    }
    $global:CodexRemoteBrokerProcessRead += 1
    $global:CodexRemoteBrokerStopTrace.Add("process:${index}:$Filter")
    return $snapshots[$index]
}

function Get-Process {
    param(
        [int]$Id,
        [object]$ErrorAction
    )

    $snapshot = @(
        @($global:CodexRemoteBrokerStopScenario.ProcessSnapshots) |
            Where-Object { $null -ne $_ -and [int]$_.ProcessId -eq $Id } |
            Select-Object -First 1
    )
    if ($snapshot.Count -ne 1) {
        throw "Mock process handle PID $Id is unavailable."
    }
    $startTime = [System.Management.ManagementDateTimeConverter]::ToDateTime(
        [string]$snapshot[0].CreationDate
    ).ToUniversalTime()
    $handle = [pscustomobject]@{
        Id = $Id
        StartTime = $startTime.ToLocalTime()
        HasExited = $false
    }
    $handle | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
    $handle | Add-Member -MemberType ScriptMethod -Name Kill -Value {
        $global:CodexRemoteBrokerStopIds.Add([int]$this.Id)
        $global:CodexRemoteBrokerStopTrace.Add("kill:$($this.Id)")
        $this.HasExited = $true
        foreach ($exitId in @(
            $global:CodexRemoteBrokerStopScenario.ExitProcessIdsOnKill
        )) {
            $key = [string][int]$exitId
            if ($global:CodexRemoteBrokerProcessHandles.ContainsKey($key)) {
                $global:CodexRemoteBrokerProcessHandles[$key].HasExited = $true
                $global:CodexRemoteBrokerStopTrace.Add("cascade-exit:$key")
            }
        }
    }
    $handle | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
        param([int]$TimeoutMilliseconds)
        $global:CodexRemoteBrokerStopTrace.Add("wait:$($this.Id)")
        return $true
    }
    $handle | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
    $global:CodexRemoteBrokerProcessHandles[[string]$Id] = $handle
    return $handle
}

$succeeded = $true
$errorMessage = $null
$result = $null
try {
    $result = & $TargetScript `
        -CodexPath $CodexPath `
        -NodePath $NodePath `
        -InstallRoot $InstallRoot `
        -DataDir $DataDir `
        -BrokerPort $BrokerPort `
        -BrokerUpstreamPort $UpstreamPort `
        -Confirm:$false
} catch {
    $succeeded = $false
    $errorMessage = $_.Exception.Message
}

[pscustomobject]@{
    Succeeded = $succeeded
    Error = $errorMessage
    Result = $result
    StopIds = @($global:CodexRemoteBrokerStopIds)
    Trace = @($global:CodexRemoteBrokerStopTrace)
    BrokerListenerReads = $global:CodexRemoteBrokerListenerRead
    UpstreamListenerReads = $global:CodexRemoteUpstreamListenerRead
    ProcessReads = $global:CodexRemoteBrokerProcessRead
    StateExists = Test-Path -LiteralPath (Join-Path $DataDir 'app-server-broker.json')
} | ConvertTo-Json -Compress -Depth 20

if (-not $succeeded) {
    exit 1
}
