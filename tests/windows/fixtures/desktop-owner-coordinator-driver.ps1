[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ModulePath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot
)

$ErrorActionPreference = 'Stop'
Import-Module $ModulePath -Force

$dataDir = Join-Path $SandboxRoot 'data'
$runtimeRoot = Join-Path $SandboxRoot 'runtime'
$null = [System.IO.Directory]::CreateDirectory($runtimeRoot)
$versionId = 'a' * 64

$first = New-CodexDesktopOwnerIntent `
    -DataDir $dataDir `
    -TargetRuntimeVersionId $versionId `
    -TargetRuntimeRoot $runtimeRoot
$second = New-CodexDesktopOwnerIntent `
    -DataDir $dataDir `
    -TargetRuntimeVersionId $versionId `
    -TargetRuntimeRoot $runtimeRoot
$read = Read-CodexDesktopOwnerIntent `
    -DataDir $dataDir `
    -ExpectedRuntimeVersionId $versionId `
    -ExpectedRuntimeRoot $runtimeRoot
$nowUtc = [DateTimeOffset]::UtcNow
$freshness = [ordered]@{
    Fresh = Get-CodexDesktopOwnerIntentFreshnessDecision `
        -RequestedAtUtc $nowUtc.AddSeconds(-30).ToString('o') `
        -NowUtc $nowUtc
    Expired = Get-CodexDesktopOwnerIntentFreshnessDecision `
        -RequestedAtUtc $nowUtc.AddSeconds(-121).ToString('o') `
        -NowUtc $nowUtc
    Future = Get-CodexDesktopOwnerIntentFreshnessDecision `
        -RequestedAtUtc $nowUtc.AddMinutes(5).ToString('o') `
        -NowUtc $nowUtc
    Invalid = Get-CodexDesktopOwnerIntentFreshnessDecision `
        -RequestedAtUtc 'not-a-time' `
        -NowUtc $nowUtc
}

$validReadiness = [pscustomobject]@{
    appServerReady = $true
    desktopConnected = $true
    sidecarConnected = $true
    degraded = $false
    unknownCount = 0
    runtimeInvocationId = ('b' * 32)
    brokerProcessId = 4101
    upstreamProcessId = 4102
    runtimeReceiptInvocationId = ('b' * 32)
    runtimeReceiptBrokerProcessId = 4101
    runtimeReceiptUpstreamProcessId = 4102
    desktopConnectionCount = 1
    desktopLaunchNonceDigests = @(('c' * 64))
}
$desktopExecutablePath = Join-Path $runtimeRoot 'ChatGPT.exe'
Set-Content -LiteralPath $desktopExecutablePath -Value 'fixture' -Encoding utf8
$rootIdentityKey = Get-CodexDesktopOwnerRootIdentityKey `
    -ProcessId 4200 `
    -StartTimeUtcTicks 638000000000000000 `
    -ExecutablePath $desktopExecutablePath
$null = Write-CodexDesktopOwnerConnectionProof `
    -DataDir $dataDir `
    -RuntimeInvocationId ('b' * 32) `
    -ProcessId 4200 `
    -StartTimeUtcTicks 638000000000000000 `
    -ExecutablePath $desktopExecutablePath `
    -LaunchNonceDigest ('c' * 64)
$persistedProof = Read-CodexDesktopOwnerConnectionProof -DataDir $dataDir
$runtimeMismatchProof = $persistedProof.PSObject.Copy()
$runtimeMismatchProof.RuntimeInvocationId = 'd' * 32
$rootMismatchProof = $persistedProof.PSObject.Copy()
$rootMismatchProof.RootIdentityKey = 'different-root'
$missingNonceReadiness = $validReadiness.PSObject.Copy()
$missingNonceReadiness.desktopLaunchNonceDigests = @()
$countMismatchReadiness = $validReadiness.PSObject.Copy()
$countMismatchReadiness.desktopConnectionCount = 2
$runtimeMismatchReadiness = $validReadiness.PSObject.Copy()
$runtimeMismatchReadiness.runtimeReceiptInvocationId = ('d' * 32)
$unknownClientReadiness = $validReadiness.PSObject.Copy()
$unknownClientReadiness.unknownCount = 1
$connectedProofs = [ordered]@{
    Complete = Test-CodexDesktopOwnerConnectedProof `
        -Readiness $validReadiness `
        -ExpectedRuntimeInvocationId ('b' * 32) `
        -ExpectedLaunchNonceDigest ('c' * 64) `
        -RootIdentityKey $rootIdentityKey
    ArbitraryNonce = Test-CodexDesktopOwnerConnectedProof `
        -Readiness $validReadiness `
        -ExpectedRuntimeInvocationId ('b' * 32) `
        -ExpectedLaunchNonceDigest ('d' * 64) `
        -RootIdentityKey $rootIdentityKey
    MissingNonce = Test-CodexDesktopOwnerConnectedProof `
        -Readiness $missingNonceReadiness `
        -ExpectedRuntimeInvocationId ('b' * 32) `
        -ExpectedLaunchNonceDigest ('c' * 64) `
        -RootIdentityKey $rootIdentityKey
    CountMismatch = Test-CodexDesktopOwnerConnectedProof `
        -Readiness $countMismatchReadiness `
        -ExpectedRuntimeInvocationId ('b' * 32) `
        -ExpectedLaunchNonceDigest ('c' * 64) `
        -RootIdentityKey $rootIdentityKey
    RuntimeMismatch = Test-CodexDesktopOwnerConnectedProof `
        -Readiness $runtimeMismatchReadiness `
        -ExpectedRuntimeInvocationId ('b' * 32) `
        -ExpectedLaunchNonceDigest ('c' * 64) `
        -RootIdentityKey $rootIdentityKey
    UnknownClient = Test-CodexDesktopOwnerConnectedProof `
        -Readiness $unknownClientReadiness `
        -ExpectedRuntimeInvocationId ('b' * 32) `
        -ExpectedLaunchNonceDigest ('c' * 64) `
        -RootIdentityKey $rootIdentityKey
    MissingRoot = Test-CodexDesktopOwnerConnectedProof `
        -Readiness $validReadiness `
        -ExpectedRuntimeInvocationId ('b' * 32) `
        -ExpectedLaunchNonceDigest ('c' * 64) `
        -RootIdentityKey ' '
    EmptyRoot = Test-CodexDesktopOwnerConnectedProof `
        -Readiness $validReadiness `
        -ExpectedRuntimeInvocationId ('b' * 32) `
        -ExpectedLaunchNonceDigest ('c' * 64) `
        -RootIdentityKey ''
    Persisted = Test-CodexDesktopOwnerConnectionProof `
        -Readiness $validReadiness `
        -Proof $persistedProof `
        -ExpectedRuntimeInvocationId ('b' * 32) `
        -RootIdentityKey $rootIdentityKey
    PersistedEmptyRoot = Test-CodexDesktopOwnerConnectionProof `
        -Readiness $validReadiness `
        -Proof $persistedProof `
        -ExpectedRuntimeInvocationId ('b' * 32) `
        -RootIdentityKey ''
    ProofRuntimeMismatch = Test-CodexDesktopOwnerConnectionProof `
        -Readiness $validReadiness `
        -Proof $runtimeMismatchProof `
        -ExpectedRuntimeInvocationId ('b' * 32) `
        -RootIdentityKey $rootIdentityKey
    ProofRootMismatch = Test-CodexDesktopOwnerConnectionProof `
        -Readiness $validReadiness `
        -Proof $rootMismatchProof `
        -ExpectedRuntimeInvocationId ('b' * 32) `
        -RootIdentityKey $rootIdentityKey
}

$decisions = [ordered]@{
    Startup = Get-CodexDesktopOwnerDecision `
        -DesktopConnected $false `
        -StartupIntentPending $true `
        -HasPendingIntent $false
    Intent = Get-CodexDesktopOwnerDecision `
        -DesktopConnected $false `
        -StartupIntentPending $false `
        -HasPendingIntent $true
    NativeFirst = Get-CodexDesktopOwnerDecision `
        -DesktopConnected $false `
        -StartupIntentPending $false `
        -HasPendingIntent $false `
        -RootIdentityKey 'pid|ticks|path'
    NativeRepeated = Get-CodexDesktopOwnerDecision `
        -DesktopConnected $false `
        -StartupIntentPending $false `
        -HasPendingIntent $false `
        -RootIdentityKey 'pid|ticks|path' `
        -LastAttemptedRootIdentityKey 'pid|ticks|path'
    UserClosed = Get-CodexDesktopOwnerDecision `
        -DesktopConnected $false `
        -StartupIntentPending $false `
        -HasPendingIntent $false
    Connected = Get-CodexDesktopOwnerDecision `
        -DesktopConnected $true `
        -StartupIntentPending $false `
        -HasPendingIntent $true
    BridgeThenNative = Get-CodexDesktopOwnerDecision `
        -DesktopConnected $connectedProofs.MissingNonce `
        -StartupIntentPending $false `
        -HasPendingIntent $false `
        -RootIdentityKey 'new-pid|ticks|path'
    SameRootDisconnectedOnce = Get-CodexDesktopOwnerDecision `
        -DesktopConnected $false `
        -StartupIntentPending $false `
        -HasPendingIntent $false `
        -RootIdentityKey 'pid|ticks|path' `
        -LastAttemptedRootIdentityKey 'pid|ticks|path' `
        -LastVerifiedConnectedRootIdentityKey 'pid|ticks|path'
    SameRootDisconnectedRepeated = Get-CodexDesktopOwnerDecision `
        -DesktopConnected $false `
        -StartupIntentPending $false `
        -HasPendingIntent $false `
        -RootIdentityKey 'pid|ticks|path' `
        -LastAttemptedRootIdentityKey 'pid|ticks|path' `
        -LastVerifiedConnectedRootIdentityKey 'pid|ticks|path' `
        -LastDisconnectedRecoveryRootIdentityKey 'pid|ticks|path'
    FallbackRootRepeated = Get-CodexDesktopOwnerDecision `
        -DesktopConnected $false `
        -StartupIntentPending $false `
        -HasPendingIntent $false `
        -RootIdentityKey 'fallback-pid|ticks|path' `
        -LastAttemptedRootIdentityKey 'fallback-pid|ticks|path' `
        -LastVerifiedConnectedRootIdentityKey 'old-pid|ticks|path' `
        -LastDisconnectedRecoveryRootIdentityKey 'fallback-pid|ticks|path'
    ResumeSuppressed = Get-CodexDesktopOwnerDecision `
        -DesktopConnected $false `
        -StartupIntentPending $false `
        -HasPendingIntent $false `
        -RootIdentityKey 'resume-pid|ticks|path' `
        -AutomaticTakeoverAllowed:$false
    PackageChanged = Get-CodexDesktopOwnerDecision `
        -DesktopConnected $false `
        -StartupIntentPending $false `
        -HasPendingIntent $false `
        -RootIdentityKey 'updated-pid|ticks|path' `
        -RuntimeGenerationCurrent:$false
    ExplicitIntentAfterResume = Get-CodexDesktopOwnerDecision `
        -DesktopConnected $false `
        -StartupIntentPending $false `
        -HasPendingIntent $true `
        -RootIdentityKey 'resume-pid|ticks|path' `
        -AutomaticTakeoverAllowed:$false `
        -RuntimeGenerationCurrent:$false
}
$resumeGap = [ordered]@{
    OrdinaryLoop = Test-CodexDesktopOwnerResumeGap `
        -PreviousObservationUtc (
            [DateTimeOffset]'2026-07-30T16:00:00Z'
        ) `
        -CurrentObservationUtc (
            [DateTimeOffset]'2026-07-30T16:00:02Z'
        ) `
        -MinimumGapSeconds 30
    SleepResume = Test-CodexDesktopOwnerResumeGap `
        -PreviousObservationUtc (
            [DateTimeOffset]'2026-07-30T16:00:00Z'
        ) `
        -CurrentObservationUtc (
            [DateTimeOffset]'2026-07-30T16:05:00Z'
        ) `
        -MinimumGapSeconds 30
}

Complete-CodexDesktopOwnerIntent `
    -DataDir $dataDir `
    -Intent $read `
    -RuntimeInvocationId ('b' * 32) `
    -Outcome 'launched-remote'

$expired = New-CodexDesktopOwnerIntent `
    -DataDir $dataDir `
    -TargetRuntimeVersionId $versionId `
    -TargetRuntimeRoot $runtimeRoot
$intentPath = Get-CodexDesktopOwnerIntentPath -DataDir $dataDir
$expiredJson = Get-Content -LiteralPath $intentPath -Raw -Encoding utf8 |
    ConvertFrom-Json -Depth 8
$expiredJson.RequestedAtUtc = $nowUtc.AddMinutes(-5).ToString('o')
$expiredJson |
    ConvertTo-Json -Depth 8 |
    Set-Content -LiteralPath $intentPath -Encoding utf8
$expiredRead = Read-CodexDesktopOwnerIntent `
    -DataDir $dataDir `
    -ExpectedRuntimeVersionId $versionId `
    -ExpectedRuntimeRoot $runtimeRoot
if ([string]$expiredRead.Freshness -ceq 'expired') {
    Complete-CodexDesktopOwnerIntent `
        -DataDir $dataDir `
        -Intent $expiredRead `
        -RuntimeInvocationId ('b' * 32) `
        -Outcome 'expired'
}
$expiredReceipt = Get-Content `
    -LiteralPath (Join-Path $dataDir 'desktop-owner-intent-last.json') `
    -Raw `
    -Encoding utf8 |
    ConvertFrom-Json -Depth 8

function Invoke-NonFreshIntentCase {
    param(
        [Parameter(Mandatory)]
        [string]$RequestedAtUtc
    )

    $null = New-CodexDesktopOwnerIntent `
        -DataDir $dataDir `
        -TargetRuntimeVersionId $versionId `
        -TargetRuntimeRoot $runtimeRoot
    $json = Get-Content -LiteralPath $intentPath -Raw -Encoding utf8 |
        ConvertFrom-Json -Depth 8
    $json.RequestedAtUtc = $RequestedAtUtc
    $json |
        ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath $intentPath -Encoding utf8
    $intent = Read-CodexDesktopOwnerIntent `
        -DataDir $dataDir `
        -ExpectedRuntimeVersionId $versionId `
        -ExpectedRuntimeRoot $runtimeRoot
    Complete-CodexDesktopOwnerIntent `
        -DataDir $dataDir `
        -Intent $intent `
        -RuntimeInvocationId ('b' * 32) `
        -Outcome ([string]$intent.Freshness)
    $receipt = Get-Content `
        -LiteralPath (Join-Path $dataDir 'desktop-owner-intent-last.json') `
        -Raw `
        -Encoding utf8 |
        ConvertFrom-Json -Depth 8
    return [pscustomobject]@{
        Removed = -not (Test-Path -LiteralPath $intentPath)
        Outcome = [string]$receipt.Outcome
    }
}

$futureCase = Invoke-NonFreshIntentCase `
    -RequestedAtUtc $nowUtc.AddMinutes(5).ToString('o')
$invalidCase = Invoke-NonFreshIntentCase -RequestedAtUtc 'not-a-time'

[pscustomobject]@{
    FirstIntentId = [string]$first.IntentId
    SecondIntentId = [string]$second.IntentId
    ReadIntentId = [string]$read.IntentId
    IntentRemoved = -not (
        Test-Path -LiteralPath (
            Get-CodexDesktopOwnerIntentPath -DataDir $dataDir
        )
    )
    ReceiptExists = Test-Path -LiteralPath (
        Join-Path $dataDir 'desktop-owner-intent-last.json'
    )
    ExpiredIntentRemoved = -not (Test-Path -LiteralPath $intentPath)
    ExpiredReceiptOutcome = [string]$expiredReceipt.Outcome
    FutureIntentRemoved = [bool]$futureCase.Removed
    FutureReceiptOutcome = [string]$futureCase.Outcome
    InvalidIntentRemoved = [bool]$invalidCase.Removed
    InvalidReceiptOutcome = [string]$invalidCase.Outcome
    Freshness = $freshness
    ConnectedProofs = $connectedProofs
    Decisions = $decisions
    ResumeGap = $resumeGap
} | ConvertTo-Json -Depth 5
