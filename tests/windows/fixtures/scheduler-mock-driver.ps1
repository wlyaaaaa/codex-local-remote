[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$TargetScript,

    [Parameter(Mandatory)]
    [string]$StateFile,

    [Parameter(Mandatory)]
    [ValidateSet('register', 'unregister')]
    [string]$Operation,

    [Parameter(Mandatory)]
    [string]$InstallRoot,

    [Parameter(Mandatory)]
    [string]$DataDir,

    [Parameter(Mandatory)]
    [string]$NodePath,

    [string]$CodexPath,

    [string]$PwshPath = (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop |
        Select-Object -First 1).Source,

    [int]$Port = 18790,

    [int]$BrokerPort = 18791,

    [int]$BrokerUpstreamPort = 18792,

    [string]$BasePath = '/codex-remote',

    [string]$TaskName = 'Codex Local Remote',

    [switch]$Start,

    [switch]$WhatIf,

    [switch]$JsonResult,

    [switch]$ExerciseFailOpenLifecycle
)

$ErrorActionPreference = 'Stop'
$global:CodexRemoteSchedulerMockState = Get-Content -LiteralPath $StateFile -Raw |
    ConvertFrom-Json -Depth 20
$global:CodexRemoteSchedulerGetCount = 0

function Save-MockState {
    $global:CodexRemoteSchedulerMockState | ConvertTo-Json -Depth 20 |
        Set-Content -LiteralPath $StateFile -Encoding utf8NoBOM
}

function Get-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath,
        [object]$ErrorAction
    )
    $global:CodexRemoteSchedulerGetCount += 1
    $swapAt = 0
    $null = [int]::TryParse(
        [string]$env:MOCK_SCHEDULER_SWAP_ON_GET_COUNT,
        [ref]$swapAt
    )
    if ($swapAt -gt 0 -and
        $global:CodexRemoteSchedulerGetCount -eq $swapAt -and
        $null -ne $global:CodexRemoteSchedulerMockState.Task) {
        $global:CodexRemoteSchedulerMockState.Task.Description = 'foreign replacement'
        Save-MockState
    }
    return $global:CodexRemoteSchedulerMockState.Task
}

function New-ScheduledTaskAction {
    param(
        [string]$Execute,
        [string]$Argument,
        [string]$WorkingDirectory
    )
    return [pscustomobject]@{
        Execute = $Execute
        Arguments = $Argument
        WorkingDirectory = $WorkingDirectory
    }
}

function New-ScheduledTaskTrigger {
    param([switch]$AtLogOn, [string]$User)
    return [pscustomobject]@{
        CimClassName = 'MSFT_TaskLogonTrigger'
        UserId = $User
        Enabled = $true
    }
}

function New-ScheduledTaskPrincipal {
    param([string]$UserId, [object]$LogonType, [object]$RunLevel)
    return [pscustomobject]@{
        UserId = $UserId
        LogonType = [string]$LogonType
        RunLevel = [string]$RunLevel
    }
}

function New-ScheduledTaskSettingsSet {
    param(
        [switch]$AllowStartIfOnBatteries,
        [switch]$DontStopIfGoingOnBatteries,
        [object]$ExecutionTimeLimit,
        [object]$MultipleInstances,
        [int]$RestartCount,
        [object]$RestartInterval,
        [switch]$StartWhenAvailable,
        [switch]$DisallowDemandStart,
        [switch]$RunOnlyIfIdle,
        [switch]$RunOnlyIfNetworkAvailable,
        [switch]$Disable
    )
    return [pscustomobject]@{
        DisallowStartIfOnBatteries = -not [bool]$AllowStartIfOnBatteries
        StopIfGoingOnBatteries = -not [bool]$DontStopIfGoingOnBatteries
        ExecutionTimeLimit = 'P3650D'
        MultipleInstances = [string]$MultipleInstances
        RestartCount = $RestartCount
        RestartInterval = 'PT1M'
        StartWhenAvailable = [bool]$StartWhenAvailable
        Enabled = -not [bool]$Disable
        AllowDemandStart = -not [bool]$DisallowDemandStart
        RunOnlyIfIdle = [bool]$RunOnlyIfIdle
        RunOnlyIfNetworkAvailable = [bool]$RunOnlyIfNetworkAvailable
    }
}

function Register-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath,
        [object]$Action,
        [object]$Trigger,
        [object]$Principal,
        [object]$Settings,
        [string]$Description,
        [switch]$Force
    )
    if ($env:MOCK_SCHEDULER_COLLIDE_ON_REGISTER -ceq '1') {
        $global:CodexRemoteSchedulerMockState.Task = [pscustomobject]@{
            TaskName = $TaskName
            TaskPath = $TaskPath
            Description = 'foreign collision'
            Actions = @()
        }
        Save-MockState
        throw 'mock scheduler name collision'
    }
    $preservedState = if ($Force -and
        $null -ne $global:CodexRemoteSchedulerMockState.Task -and
        $null -ne $global:CodexRemoteSchedulerMockState.Task.PSObject.Properties['State']) {
        [string]$global:CodexRemoteSchedulerMockState.Task.State
    } else {
        'Ready'
    }
    $global:CodexRemoteSchedulerMockState.Task = [pscustomobject]@{
        TaskName = $TaskName
        TaskPath = $TaskPath
        Description = $Description
        Actions = @($Action)
        Triggers = @($Trigger)
        Principal = $Principal
        Settings = $Settings
        State = $preservedState
    }
    $global:CodexRemoteSchedulerMockState.Operations =
        @($global:CodexRemoteSchedulerMockState.Operations) + 'register'
    Save-MockState
    return $global:CodexRemoteSchedulerMockState.Task
}

function Start-ScheduledTask {
    param([string]$TaskName, [string]$TaskPath)
    $global:CodexRemoteSchedulerMockState.Operations =
        @($global:CodexRemoteSchedulerMockState.Operations) + 'start'
    Save-MockState
}

function Stop-ScheduledTask {
    param([string]$TaskName, [string]$TaskPath, [object]$ErrorAction)
    if ($env:MOCK_SCHEDULER_STOP_MODE -ceq 'fail') {
        throw 'mock scheduled task stop failure'
    }
    $global:CodexRemoteSchedulerMockState.Operations =
        @($global:CodexRemoteSchedulerMockState.Operations) + 'stop'
    if ($null -ne $global:CodexRemoteSchedulerMockState.Task) {
        $global:CodexRemoteSchedulerMockState.Task |
            Add-Member `
                -NotePropertyName State `
                -NotePropertyValue $(if ($env:MOCK_SCHEDULER_STOP_MODE -ceq 'still-running') {
                    'Running'
                } else {
                    'Ready'
                }) `
                -Force
    }
    Save-MockState
}

function Unregister-ScheduledTask {
    param([string]$TaskName, [string]$TaskPath, [bool]$Confirm)
    $global:CodexRemoteSchedulerMockState.Operations =
        @($global:CodexRemoteSchedulerMockState.Operations) + 'unregister'
    $global:CodexRemoteSchedulerMockState.Task = $null
    Save-MockState
}

$parameters = @{
    InstallRoot = $InstallRoot
    DataDir = $DataDir
    NodePath = $NodePath
    CodexPath = $CodexPath
    PwshPath = $PwshPath
    Port = $Port
    BrokerPort = $BrokerPort
    BrokerUpstreamPort = $BrokerUpstreamPort
    BasePath = $BasePath
    TaskName = $TaskName
}
if ($ExerciseFailOpenLifecycle) {
    $parameters.LauncherShortcutPath = Join-Path $DataDir 'Codex Remote safe launch.lnk'
    if ($Operation -eq 'unregister') {
        $parameters.SkipRuntimeStop = $true
    }
} else {
    $parameters.SkipEnvironmentConfiguration = $true
}
if ($Operation -eq 'register' -and -not $Start) {
    $parameters.NoStart = $true
}
if ($Operation -eq 'unregister') {
    $parameters.Confirm = $false
}
if ($WhatIf) {
    $parameters.WhatIf = $true
}

try {
    $env:CODEX_REMOTE_TEST_FIXTURE = '1'
    $userEnvironmentBefore = [System.Environment]::GetEnvironmentVariable(
        'CODEX_APP_SERVER_WS_URL',
        [System.EnvironmentVariableTarget]::User
    )
    $targetResult = & $TargetScript @parameters
    $userEnvironmentAfter = [System.Environment]::GetEnvironmentVariable(
        'CODEX_APP_SERVER_WS_URL',
        [System.EnvironmentVariableTarget]::User
    )
    if ($ExerciseFailOpenLifecycle -and
        [string]$userEnvironmentBefore -cne [string]$userEnvironmentAfter) {
        throw 'The fail-open lifecycle fixture detected a persistent user environment mutation.'
    }
    if ($JsonResult) {
        $targetResult | ConvertTo-Json -Compress -Depth 20
    } else {
        $targetResult
    }
} finally {
    Remove-Item Env:\CODEX_REMOTE_TEST_FIXTURE -ErrorAction SilentlyContinue
    Save-MockState
}
