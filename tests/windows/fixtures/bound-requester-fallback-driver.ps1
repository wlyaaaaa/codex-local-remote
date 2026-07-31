[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LauncherPath,

    [Parameter(Mandatory)]
    [ValidateSet(
        'bound-invalid',
        'bound-version-only',
        'bound-root-only',
        'bound-mismatch',
        'bound-pointer-missing',
        'bound-pointer-damaged',
        'unbound-owner-failure'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$launcherAst = [System.Management.Automation.Language.Parser]::ParseFile(
    $LauncherPath,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    throw 'The launcher did not parse.'
}
$entryAst = $launcherAst.EndBlock.Statements |
    Where-Object {
        $_ -is [System.Management.Automation.Language.IfStatementAst] -and
        [string]$_.Extent.Text -cmatch 'if \(-not \$DefinitionOnly\)'
    } |
    Select-Object -First 1
if ($null -eq $entryAst) {
    throw 'The requester entry block was not found.'
}
$entrySource = [string]$entryAst.Extent.Text

. $LauncherPath -DefinitionOnly

$script:fallbackCalls = 0
$script:nativeStartCalls = 0
$script:taskStartCalls = 0
$script:WindowsModuleAvailable = $true

function Get-CodexDesktopRootIdentityKeys {
    return @()
}

function Invoke-WithCodexDesktopOwnerMutex {
    param(
        [string]$DataDir,
        [scriptblock]$Action
    )
    $null = $DataDir
    return & $Action
}

function Invoke-CodexDesktopOwnerRequestWithDrainRetry {
    param(
        [scriptblock]$RequestOwnerAction,
        [scriptblock]$WaitForDesktopDrainAction
    )
    $null = $WaitForDesktopDrainAction
    return & $RequestOwnerAction
}

function Get-CodexLocalRemoteCurrentRuntime {
    param([string]$DataDir)
    $null = $DataDir
    if ($Mode -ceq 'bound-pointer-missing') {
        return $null
    }
    if ($Mode -ceq 'bound-pointer-damaged') {
        return [pscustomobject]@{
            CurrentVersionId = 'not-a-runtime-version'
            CurrentRoot = ''
        }
    }
    return [pscustomobject]@{
        CurrentVersionId = 'b' * 64
        CurrentRoot = 'C:\Runtime\current'
    }
}

function Start-CodexLocalRemoteRegisteredTask {
    $script:taskStartCalls += 1
    throw (New-CodexRemoteFailureException `
        -Stage 'runtime-handoff' `
        -Code 'runtime-handoff-failed')
}

function Invoke-CodexRequesterFailOpenAfterOwnerFailure {
    $script:fallbackCalls += 1
    $script:nativeStartCalls += 1
    return [pscustomobject][ordered]@{
        Status = 'launched-native'
        RemoteEnabled = $false
        RemoteDecision = 'native-fallback'
        RemoteFallbackAttempts = 0
        RemoteStopAttempts = 0
        DesktopProcessId = 42001
        RemoteFailureStage = 'runtime-handoff'
        RemoteFailureCode = 'runtime-handoff-failed'
        CorrelationId = 'c' * 32
        FeedbackStatus = 'pending'
        FeedbackFailureCode = $null
    }
}

function Invoke-CodexRequesterNativeFailOpen {
    $script:fallbackCalls += 1
    $script:nativeStartCalls += 1
    return [pscustomobject][ordered]@{
        Status = 'launched-native'
        RemoteEnabled = $false
        RemoteDecision = 'legacy-direct-launcher-native'
        RemoteFallbackAttempts = 0
        RemoteStopAttempts = 0
        DesktopProcessId = 42001
        RemoteFailureStage = $null
        RemoteFailureCode = $null
        CorrelationId = 'c' * 32
        FeedbackStatus = 'pending'
        FeedbackFailureCode = $null
    }
}

function Get-CodexRemoteLaunchFeedback {
    return [pscustomobject]@{}
}

function Write-CodexDesktopLaunchReceipt {
    return $null
}

function Invoke-FixtureRequesterEntry {
    $DataDir = 'C:\Data'
    $BrokerPort = 18791
    $SidecarPort = 18790
    $BrokerUpstreamPort = 18792
    $BasePath = '/codex-remote'
    $TaskName = 'Codex Local Remote'
    $RequestDesktopLaunch = $true
    $DesktopOwnerExecution = $false
    $DesktopExitDrainTimeoutSeconds = 1
    $DesktopOwnerRequestAckTimeoutSeconds = 1
    $SuppressNotification = $true
    $ExpectedSelectedRuntimeVersionId = switch ($Mode) {
        'bound-invalid' { 'invalid' }
        'bound-version-only' { 'a' * 64 }
        'bound-root-only' { '' }
        'bound-mismatch' { 'a' * 64 }
        'bound-pointer-missing' { 'a' * 64 }
        'bound-pointer-damaged' { 'a' * 64 }
        default { '' }
    }
    $ExpectedSelectedRuntimeRoot = switch ($Mode) {
        'bound-invalid' { 'C:\Runtime\expected' }
        'bound-version-only' { '' }
        'bound-root-only' { 'C:\Runtime\expected' }
        'bound-mismatch' { 'C:\Runtime\expected' }
        'bound-pointer-missing' { 'C:\Runtime\expected' }
        'bound-pointer-damaged' { 'C:\Runtime\expected' }
        default { '' }
    }
    $DefinitionOnly = $false
    return Invoke-Expression $entrySource
}

$result = @(Invoke-FixtureRequesterEntry) |
    Where-Object { $null -ne $_ } |
    Select-Object -Last 1
[pscustomobject][ordered]@{
    Result = $result
    FallbackCalls = $script:fallbackCalls
    NativeStartCalls = $script:nativeStartCalls
    TaskStartCalls = $script:taskStartCalls
} | ConvertTo-Json -Depth 8 -Compress
