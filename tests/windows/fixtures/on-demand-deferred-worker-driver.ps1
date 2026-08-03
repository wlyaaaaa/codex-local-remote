[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptPath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot
)

$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $ScriptPath,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    throw 'The on-demand handoff script did not parse.'
}
foreach ($functionName in @(
    'ConvertTo-OnDemandWindowsCommandLineArgument',
    'Test-OnDemandDeferredHandoffWorkerMatches',
    'Start-OnDemandDeferredRuntimeHandoff',
    'Test-OnDemandRuntimePathEqual',
    'Set-OnDemandOpenDesiredRemote'
)) {
    $functionAst = @(
        $ast.FindAll(
            {
                param($node)
                $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
                    $node.Name -ceq $functionName
            },
            $true
        )
    )
    if ($functionAst.Count -ne 1) {
        throw "Expected exactly one '$functionName' helper."
    }
    Invoke-Expression ([string]$functionAst[0].Extent.Text)
}

$resolvedDataDir = Join-Path $SandboxRoot 'data dir'
$runtimeVersionId = 'c' * 64
$runtimeRoot = Join-Path $SandboxRoot "runtime $runtimeVersionId"
$workerPath = Join-Path `
    $runtimeRoot `
    'scripts\windows\Complete-CodexLocalRemoteDeferredHandoff.ps1'
$null = New-Item -ItemType Directory -Path $resolvedDataDir -Force
$null = New-Item -ItemType Directory -Path (Split-Path -Parent $workerPath) -Force
$null = New-Item -ItemType File -Path $workerPath -Force
$DesktopDrainTimeoutSeconds = 20
$ReadyWaitSeconds = 120
$script:workerState = [pscustomobject]@{
    Active = $false
    ClaimValid = $false
}
$script:injectWorkerStateReadFailure = $false
$script:workerStartedForFailure = $false
$script:releaseMismatchedWorkerAfterReads = 0
$script:registeredTasks = @{}
$script:registrationCalls = [Collections.Generic.List[object]]::new()
$script:startCalls = [Collections.Generic.List[object]]::new()
$script:stopCalls = [Collections.Generic.List[object]]::new()
$script:unregisterCalls = [Collections.Generic.List[object]]::new()
$script:directStartProcessCalls = 0

function Get-OnDemandDeferredHandoffWorkerState {
    if ($script:injectWorkerStateReadFailure -and
        $script:workerStartedForFailure) {
        throw 'fixture worker claim read failed'
    }
    if ($script:workerState.Active -and
        $script:releaseMismatchedWorkerAfterReads -gt 0) {
        $script:releaseMismatchedWorkerAfterReads--
        if ($script:releaseMismatchedWorkerAfterReads -eq 0) {
            $script:workerState = [pscustomobject]@{
                Active = $false
                ClaimValid = $false
            }
        }
    }
    return $script:workerState
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

function New-ScheduledTaskPrincipal {
    param(
        [string]$UserId,
        [string]$LogonType,
        [string]$RunLevel
    )

    return [pscustomobject]@{
        UserId = $UserId
        LogonType = $LogonType
        RunLevel = $RunLevel
    }
}

function New-ScheduledTaskSettingsSet {
    param(
        [switch]$AllowStartIfOnBatteries,
        [switch]$DontStopIfGoingOnBatteries,
        [timespan]$ExecutionTimeLimit,
        [string]$MultipleInstances,
        [bool]$StartWhenAvailable,
        [bool]$DisallowDemandStart,
        [bool]$RunOnlyIfIdle,
        [bool]$RunOnlyIfNetworkAvailable,
        [bool]$Disable
    )

    return [pscustomobject]@{
        AllowStartIfOnBatteries = [bool]$AllowStartIfOnBatteries
        DontStopIfGoingOnBatteries = [bool]$DontStopIfGoingOnBatteries
        ExecutionTimeLimit = $ExecutionTimeLimit
        MultipleInstances = $MultipleInstances
        StartWhenAvailable = $StartWhenAvailable
        DisallowDemandStart = $DisallowDemandStart
        RunOnlyIfIdle = $RunOnlyIfIdle
        RunOnlyIfNetworkAvailable = $RunOnlyIfNetworkAvailable
        Disable = $Disable
    }
}

function Get-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath,
        [object]$ErrorAction
    )

    if (-not $script:registeredTasks.ContainsKey($TaskName)) {
        return $null
    }
    return $script:registeredTasks[$TaskName]
}

function Register-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath,
        [object]$Action,
        [object]$Principal,
        [object]$Settings,
        [string]$Description,
        [AllowNull()]
        [object]$Trigger,
        [object]$ErrorAction
    )

    $task = [pscustomobject]@{
        TaskName = $TaskName
        TaskPath = $TaskPath
        Actions = @($Action)
        Principal = $Principal
        Settings = $Settings
        Triggers = if ($PSBoundParameters.ContainsKey('Trigger')) {
            @($Trigger)
        } else {
            @()
        }
        Description = $Description
        State = 'Ready'
    }
    $script:registeredTasks[$TaskName] = $task
    $script:registrationCalls.Add([pscustomobject]@{
        TaskName = $TaskName
        TaskPath = $TaskPath
        Action = $Action
        Principal = $Principal
        Settings = $Settings
        Description = $Description
        TriggerSupplied = $PSBoundParameters.ContainsKey('Trigger')
    })
    return $task
}

function Start-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath,
        [object]$ErrorAction
    )

    if (-not $script:registeredTasks.ContainsKey($TaskName)) {
        throw 'fixture scheduled task is not registered'
    }
    $task = $script:registeredTasks[$TaskName]
    $task.State = 'Running'
    $script:startCalls.Add([pscustomobject]@{
        TaskName = $TaskName
        TaskPath = $TaskPath
    })
    if ($script:injectWorkerStateReadFailure) {
        $script:workerStartedForFailure = $true
    }
    $script:workerState = [pscustomobject]@{
        Active = $true
        ClaimValid = $true
        DesiredModeIntentId = $desiredModeIntentId
        RuntimeVersionId = $runtimeVersionId
        RuntimeRoot = $runtimeRoot
        ProcessId = 8123
        ProcessStartTimeUtcTicks = [DateTime]::UtcNow.Ticks
    }
}

function Stop-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath,
        [object]$ErrorAction
    )

    $script:stopCalls.Add([pscustomobject]@{
        TaskName = $TaskName
        TaskPath = $TaskPath
    })
    if ($script:registeredTasks.ContainsKey($TaskName)) {
        $script:registeredTasks[$TaskName].State = 'Ready'
    }
}

function Unregister-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath,
        [switch]$Confirm,
        [object]$ErrorAction
    )

    $script:unregisterCalls.Add([pscustomobject]@{
        TaskName = $TaskName
        TaskPath = $TaskPath
        Confirm = [bool]$Confirm
    })
    $script:registeredTasks.Remove($TaskName)
}

function Start-Process {
    param(
        [string]$FilePath,
        [string]$ArgumentList,
        [string]$WorkingDirectory,
        [string]$WindowStyle,
        [string]$RedirectStandardOutput,
        [string]$RedirectStandardError,
        [switch]$PassThru
    )

    $script:directStartProcessCalls++
    throw 'The deferred handoff worker must not inherit the Desktop process job.'
}

$runtime = [pscustomobject]@{
    CurrentVersionId = $runtimeVersionId
    CurrentRoot = $runtimeRoot
}
$configuration = [pscustomobject]@{ BrokerPort = 18791 }
$desiredModeIntentId = 'f' * 32
$script:currentDesiredMode = [pscustomobject]@{
    Mode = 'Remote'
    IntentId = $desiredModeIntentId
    RuntimeVersionId = $runtimeVersionId
    RuntimeRoot = $runtimeRoot
}
$script:desiredModeSetCalls = 0
function Get-CodexLocalRemoteDesiredMode {
    return $script:currentDesiredMode
}
function Set-CodexLocalRemoteDesiredMode {
    $script:desiredModeSetCalls++
    $script:currentDesiredMode = [pscustomobject]@{
        Mode = 'Remote'
        IntentId = ('d' * 32)
        RuntimeVersionId = $runtimeVersionId
        RuntimeRoot = $runtimeRoot
    }
    return $script:currentDesiredMode
}
$reusedDesiredMode = Set-OnDemandOpenDesiredRemote -Runtime $runtime
$reusedDesiredModeWasCreated = $script:openDesiredModeWasCreated
$script:currentDesiredMode = [pscustomobject]@{
    Mode = 'Native'
    IntentId = ('e' * 32)
    RuntimeVersionId = $runtimeVersionId
    RuntimeRoot = $runtimeRoot
}
$createdDesiredMode = Set-OnDemandOpenDesiredRemote -Runtime $runtime
$createdDesiredModeWasCreated = $script:openDesiredModeWasCreated
$fresh = Start-OnDemandDeferredRuntimeHandoff `
    -Runtime $runtime `
    -Configuration $configuration `
    -Name 'Codex Local Remote' `
    -DesiredModeIntentId $desiredModeIntentId
$script:workerState = [pscustomobject]@{
    Active = $true
    ClaimValid = $true
    DesiredModeIntentId = $desiredModeIntentId
    RuntimeVersionId = $runtimeVersionId
    RuntimeRoot = $runtimeRoot
}
$existing = Start-OnDemandDeferredRuntimeHandoff `
    -Runtime $runtime `
    -Configuration $configuration `
    -Name 'Codex Local Remote' `
    -DesiredModeIntentId $desiredModeIntentId
$script:workerState = [pscustomobject]@{
    Active = $true
    ClaimValid = $true
    DesiredModeIntentId = ('e' * 32)
    RuntimeVersionId = $runtimeVersionId
    RuntimeRoot = $runtimeRoot
}
$script:releaseMismatchedWorkerAfterReads = 2
$superseded = Start-OnDemandDeferredRuntimeHandoff `
    -Runtime $runtime `
    -Configuration $configuration `
    -Name 'Codex Local Remote' `
    -DesiredModeIntentId $desiredModeIntentId
$script:workerState = [pscustomobject]@{
    Active = $false
    ClaimValid = $false
}
$script:injectWorkerStateReadFailure = $true
$workerAdmissionFailureCaught = $false
try {
    $null = Start-OnDemandDeferredRuntimeHandoff `
        -Runtime $runtime `
        -Configuration $configuration `
        -Name 'Codex Local Remote' `
        -DesiredModeIntentId $desiredModeIntentId
} catch {
    $workerAdmissionFailureCaught = $true
}

[pscustomobject]@{
    Fresh = $fresh
    Existing = $existing
    Superseded = $superseded
    ReusedDesiredMode = $reusedDesiredMode
    ReusedDesiredModeWasCreated = $reusedDesiredModeWasCreated
    CreatedDesiredMode = $createdDesiredMode
    CreatedDesiredModeWasCreated = $createdDesiredModeWasCreated
    DesiredModeSetCalls = $script:desiredModeSetCalls
    WorkerAdmissionFailureCaught = $workerAdmissionFailureCaught
    DirectStartProcessCalls = $script:directStartProcessCalls
    RegistrationCalls = @($script:registrationCalls)
    StartCalls = @($script:startCalls)
    StopCalls = @($script:stopCalls)
    UnregisterCalls = @($script:unregisterCalls)
    RuntimeVersionId = $runtimeVersionId
    RuntimeRoot = $runtimeRoot
    DataDir = $resolvedDataDir
} | ConvertTo-Json -Depth 6 -Compress
