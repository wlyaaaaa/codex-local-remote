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
$script:killedProcesses = 0
$script:waitForExitCalls = 0
$script:releaseMismatchedWorkerAfterReads = 0
$script:startCalls = [Collections.Generic.List[object]]::new()

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

    $script:startCalls.Add([pscustomobject]@{
        FilePath = $FilePath
        ArgumentList = $ArgumentList
        WorkingDirectory = $WorkingDirectory
        WindowStyle = $WindowStyle
        RedirectStandardOutput = $RedirectStandardOutput
        RedirectStandardError = $RedirectStandardError
        PassThru = [bool]$PassThru
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
    }
    $process = [pscustomobject]@{
        Id = 8123
        StartTime = [DateTime]::UtcNow
        HasExited = $false
    }
    $process | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
    $process | Add-Member -MemberType ScriptMethod -Name Kill -Value {
        $script:killedProcesses++
        $this.HasExited = $true
    }
    $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
        param([int]$TimeoutMilliseconds)
        $script:waitForExitCalls++
        return $TimeoutMilliseconds -eq 5000
    }
    $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
    return $process
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
    KilledProcesses = $script:killedProcesses
    WaitForExitCalls = $script:waitForExitCalls
    StartCalls = @($script:startCalls)
    RuntimeVersionId = $runtimeVersionId
    RuntimeRoot = $runtimeRoot
    DataDir = $resolvedDataDir
} | ConvertTo-Json -Depth 6 -Compress
