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

    [int]$Port = 18790,

    [string]$BasePath = '/codex-remote',

    [string]$TaskName = 'Codex Local Remote',

    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$global:CodexRemoteSchedulerMockState = Get-Content -LiteralPath $StateFile -Raw |
    ConvertFrom-Json -Depth 20

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
    return [pscustomobject]@{ Type = 'AtLogOn'; User = $User }
}

function New-ScheduledTaskPrincipal {
    param([string]$UserId, [object]$LogonType, [object]$RunLevel)
    return [pscustomobject]@{ UserId = $UserId }
}

function New-ScheduledTaskSettingsSet {
    return [pscustomobject]@{ Mock = $true }
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
    $global:CodexRemoteSchedulerMockState.Task = [pscustomobject]@{
        TaskName = $TaskName
        TaskPath = $TaskPath
        Description = $Description
        Actions = @($Action)
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
    $global:CodexRemoteSchedulerMockState.Operations =
        @($global:CodexRemoteSchedulerMockState.Operations) + 'stop'
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
    Port = $Port
    BasePath = $BasePath
    TaskName = $TaskName
}
if ($Operation -eq 'register') {
    $parameters.NoStart = $true
}
if ($Operation -eq 'unregister') {
    $parameters.Confirm = $false
}
if ($WhatIf) {
    $parameters.WhatIf = $true
}

try {
    & $TargetScript @parameters
} finally {
    Save-MockState
}
