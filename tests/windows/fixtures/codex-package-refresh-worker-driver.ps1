[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$WorkerPath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot,

    [Parameter(Mandatory)]
    [ValidateSet(
        'success',
        'restart-failed',
        'child-first-claim',
        'interleaved-intent',
        'cim-unknown',
        'unsafe-first',
        'unsafe-final',
        'generation-drift-final'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
$dataDir = Join-Path $SandboxRoot 'Data'
$null = New-Item -ItemType Directory -Path $dataDir -Force
$intentId = '0123456789abcdef0123456789abcdef'
$workerNonce = '1234567890abcdef1234567890abcdef'
. $WorkerPath `
    -DataDir $dataDir `
    -TaskName 'Codex Local Remote' `
    -SidecarPort 18790 `
    -BrokerPort 18791 `
    -BrokerUpstreamPort 18792 `
    -BasePath '/codex-remote' `
    -IntentId $intentId `
    -WorkerNonce $workerNonce `
    -DefinitionOnly

$script:rootPresent = $true
$script:rootProcessId = 42001
$script:rootStartTicks = 638899999999999999
$script:stopCalls = 0
$script:restartCalls = 0
$script:nativeFallbackCalls = 0
$script:taskStartCalls = 0
$script:feedbackCalls = 0
$script:receiptWrites = 0
$script:strictDesktopEnumerations = 0
$script:readinessChecks = 0
$script:generationChecks = 0
$desktopPath = 'C:\fixture\OpenAI.Codex\ChatGPT.exe'
$expectedRootKey = Get-CodexDesktopOwnerRootIdentityKey `
    -ProcessId $script:rootProcessId `
    -StartTimeUtcTicks $script:rootStartTicks `
    -ExecutablePath $desktopPath
$runtimeInvocationId = 'fedcba9876543210fedcba9876543210'
$fixtureWorker = Get-Process -Id $PID
try {
    $fixtureWorkerStartTimeUtcTicks =
        $fixtureWorker.StartTime.ToUniversalTime().Ticks
} finally {
    $fixtureWorker.Dispose()
}

Write-AtomicJsonFile `
    -Path (Join-Path $dataDir 'desktop-package-refresh-intent.json') `
    -Value ([ordered]@{
        Signature =
            'codex-local-remote/desktop-package-refresh-intent/v1'
        Version = 1
        IntentId = $intentId
        WorkerNonce = $workerNonce
        ExpectedRootIdentityKey = $expectedRootKey
        ExpectedRuntimeInvocationId = $runtimeInvocationId
        WorkerProcessId = $(if ($Mode -ceq 'child-first-claim') {
            0
        } else {
            $PID
        })
        WorkerStartTimeUtcTicks = $(if ($Mode -ceq 'child-first-claim') {
            0
        } else {
            $fixtureWorkerStartTimeUtcTicks
        })
        RequestedAtUtc = [DateTime]::UtcNow.ToString('O')
    })

function Invoke-WithCodexRequesterDesktopOwnerMutex {
    param(
        [string]$ManagedDataDir,
        [int]$TimeoutSeconds,
        [scriptblock]$Action
    )
    return & $Action
}

function Get-CodexLocalRemoteRuntimeGenerationStatus {
    $script:generationChecks += 1
    return [pscustomobject]@{
        Status = if ($Mode -ceq 'generation-drift-final' -and
            $script:generationChecks -ge 4) {
            'transition-required'
        } else {
            'current'
        }
        ActiveRoot = Join-Path $SandboxRoot 'Runtime'
        Receipt = [pscustomobject]@{
            RuntimeInvocationId = $runtimeInvocationId
            ProcessId = 41001
            Upstream = [pscustomobject]@{
                ProcessId = 41002
            }
        }
    }
}

function Get-CodexLocalRemoteReadinessSnapshot {
    $script:readinessChecks += 1
    return [pscustomobject]@{
        status = 'ready'
        appServerReady = $true
        desktopConnected = $false
        sidecarConnected = $true
        degraded = $false
        unknownCount = 0
        unsafeThreadCount = if (
            $Mode -ceq 'unsafe-first' -or
            ($Mode -ceq 'unsafe-final' -and
                $script:readinessChecks -ge 3)
        ) {
            1
        } else {
            0
        }
        runtimeInvocationId = $runtimeInvocationId
        brokerProcessId = 41001
        upstreamProcessId = 41002
    }
}

function Resolve-CodexDesktopRuntime {
    return [pscustomobject]@{
        Signature = 'codex-local-remote/codex-desktop-runtime/v1'
        Version = 1
        PackageFullName = 'OpenAI.Codex_new_x64__2p2nqsd0c76g0'
        DesktopExecutablePath = $desktopPath
        DesktopExecutableSha256 = 'A' * 64
        BundledCodexPath = 'C:\fixture\OpenAI.Codex\codex.exe'
        BundledCodexSha256 = 'B' * 64
        CodexPath = 'C:\fixture\OpenAI.Codex\codex.exe'
        CodexSha256 = 'B' * 64
    }
}

function Get-CodexLocalRemoteActiveCodexRuntimeStatus {
    return [pscustomobject]@{
        Status = 'drifted'
    }
}

function Get-RunningCodexDesktopProcesses {
    if ($script:rootPresent) {
        return [pscustomobject]@{
            ProcessId = $script:rootProcessId
            ExecutablePath = $desktopPath
            StartTimeUtcTicks = $script:rootStartTicks
            CommandLine = ''
        }
    }
    return @()
}

function Get-CodexDesktopHandoffProcesses {
    $script:strictDesktopEnumerations += 1
    if ($Mode -ceq 'cim-unknown') {
        throw 'fixture strict CIM enumeration failed'
    }
    return @(Get-RunningCodexDesktopProcesses)
}

function Stop-CodexDesktopCreatedProcess {
    $script:stopCalls += 1
    $script:rootPresent = $false
    return 'stopped'
}

function Restart-CodexLocalRemoteCodexRuntime {
    $script:restartCalls += 1
    if ($Mode -ceq 'restart-failed') {
        throw 'fixture restart failure'
    }
    return [pscustomobject]@{
        Status = 'current'
    }
}

function Invoke-CodexRequesterNativeFailOpen {
    $script:nativeFallbackCalls += 1
    $script:rootPresent = $true
    $script:rootProcessId = 42002
    $script:rootStartTicks = 638900000000000001
    return [pscustomobject]@{
        Status = 'launched-native'
    }
}

function Start-CodexLocalRemoteScheduledTaskBounded {
    $script:taskStartCalls += 1
}

function Get-CodexRemoteLaunchFeedback {
    return [pscustomobject]@{
        Kind = 'degraded'
        Title = 'fixture'
        Message = 'fixture degraded'
        Icon = 'Warning'
    }
}

function Show-CodexRemoteLaunchFeedback {
    $script:feedbackCalls += 1
    return [pscustomobject]@{
        Status = 'shown'
        FailureCode = $null
    }
}

function Write-CodexDesktopLaunchReceipt {
    $script:receiptWrites += 1
}

if ($Mode -ceq 'child-first-claim') {
    $claimed = Claim-PackageRefreshIntent
    [pscustomobject][ordered]@{
        ClaimedByCurrentWorker = (
            [int]$claimed.WorkerProcessId -eq $PID -and
            [long]$claimed.WorkerStartTimeUtcTicks -eq
                $fixtureWorkerStartTimeUtcTicks
        )
        StopCalls = $script:stopCalls
    } | ConvertTo-Json -Depth 8
    return
}

if ($Mode -ceq 'interleaved-intent') {
    $replacementIntentId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    $replacementNonce = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    Write-AtomicJsonFile `
        -Path (Join-Path $dataDir 'desktop-package-refresh-intent.json') `
        -Value ([ordered]@{
            Signature =
                'codex-local-remote/desktop-package-refresh-intent/v1'
            Version = 1
            IntentId = $replacementIntentId
            WorkerNonce = $replacementNonce
            ExpectedRootIdentityKey = $expectedRootKey
            ExpectedRuntimeInvocationId = $runtimeInvocationId
            WorkerProcessId = 0
            WorkerStartTimeUtcTicks = 0
            RequestedAtUtc = [DateTime]::UtcNow.ToString('O')
        })
    Remove-PackageRefreshIntentIfCurrent -ExpectedIntentId $intentId
    $remaining = Get-Content `
        -LiteralPath (
            Join-Path $dataDir 'desktop-package-refresh-intent.json'
        ) `
        -Raw `
        -Encoding utf8 |
        ConvertFrom-Json -Depth 8
    [pscustomobject][ordered]@{
        NewIntentPreserved =
            [string]$remaining.IntentId -ceq $replacementIntentId
        StopCalls = $script:stopCalls
    } | ConvertTo-Json -Depth 8
    return
}

Invoke-CodexLocalRemotePackageRefreshWorkerCore
$result = Get-Content `
    -LiteralPath (Join-Path $dataDir 'desktop-package-refresh-last.json') `
    -Raw `
    -Encoding utf8 |
    ConvertFrom-Json -Depth 8

[pscustomobject][ordered]@{
    Outcome = [string]$result.Outcome
    StopCalls = $script:stopCalls
    RestartCalls = $script:restartCalls
    NativeFallbackCalls = $script:nativeFallbackCalls
    TaskStartCalls = $script:taskStartCalls
    FeedbackCalls = $script:feedbackCalls
    ReceiptWrites = $script:receiptWrites
    StrictDesktopEnumerations = $script:strictDesktopEnumerations
    ReadinessChecks = $script:readinessChecks
    GenerationChecks = $script:generationChecks
    SuppressionExists = Test-Path `
        -LiteralPath (
            Join-Path $dataDir 'desktop-owner-fallback-suppression.json'
        ) `
        -PathType Leaf
} | ConvertTo-Json -Depth 8
