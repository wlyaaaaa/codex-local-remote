[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$StartScriptPath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot,

    [Parameter(Mandatory)]
    [ValidateSet(
        'success',
        'payload-mismatch',
        'old-sidecar-live',
        'sidecar-port-occupied',
        'broker-identity-drift',
        'upstream-identity-drift',
        'invocation-identity-drift',
        'proof-preserved',
        'proof-missing',
        'proof-multiple-connections',
        'proof-identity-drift',
        'proof-independent-stdio',
        'recovery-success',
        'recovery-receipt-drift',
        'recovery-root-drift',
        'recovery-nonce-drift',
        'recovery-runtime-drift',
        'recovery-multiple-connections',
        'recovery-unknown-readiness',
        'recovery-multiple-roots',
        'recovery-independent-stdio',
        'recovery-payload-drift',
        'recovery-proof-race',
        'recovery-post-commit-root-drift'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
$env:CODEX_REMOTE_TEST_FIXTURE = '1'
$currentVersionId = 'c' * 64
$previousVersionId = 'b' * 64
$currentManifestSha256 = 'a' * 64
$previousManifestSha256 = 'e' * 64
$runtimeInvocationId = '0123456789abcdef0123456789abcdef'
$currentRoot = Join-Path $SandboxRoot $currentVersionId
$previousRoot = Join-Path $SandboxRoot $previousVersionId
$currentBrokerCli = Join-Path $currentRoot 'apps\broker\dist\cli.js'
$previousBrokerCli = Join-Path $previousRoot 'apps\broker\dist\cli.js'
$desktopExecutablePath = Join-Path $currentRoot 'app\ChatGPT.exe'
$brokerStatePath = Join-Path $SandboxRoot 'app-server-broker.json'
$desktopOwnerProofPath = Join-Path $SandboxRoot 'desktop-owner-proof.json'
$null = New-Item -ItemType Directory -Path (Split-Path -Parent $currentBrokerCli) -Force
$null = New-Item -ItemType Directory -Path (Split-Path -Parent $previousBrokerCli) -Force
$null = New-Item -ItemType Directory -Path (Split-Path -Parent $desktopExecutablePath) -Force
Set-Content -LiteralPath $currentBrokerCli -Value 'current-broker' -NoNewline
Set-Content -LiteralPath $previousBrokerCli -Value 'previous-broker' -NoNewline
Set-Content -LiteralPath $desktopExecutablePath -Value 'desktop' -NoNewline

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $StartScriptPath,
    [ref]$tokens,
    [ref]$errors
)
if ($errors.Count -gt 0) {
    throw ($errors | Out-String)
}
$functionNames = @(
    'Get-PreviousBrokerAdoptionBinding',
    'Get-AdoptedDesktopOwnerProofBinding',
    'Write-BrokerRuntimeReceipt'
)
if ($Mode -like 'recovery-*') {
    $functionNames += @(
        'Get-BoundedBrokerReceiptSnapshot',
        'Get-UniqueCodexDesktopRootBinding',
        'Get-AdoptedDesktopOwnerRecoveryObservation',
        'Test-AdoptedDesktopOwnerRecoveryObservationPair',
        'Invoke-AdoptedDesktopOwnerProofRecovery'
    )
}
foreach ($functionName in $functionNames) {
    $definitions = @(
        $ast.FindAll(
            {
                param($node)
                $node -is
                    [System.Management.Automation.Language.FunctionDefinitionAst] -and
                    $node.Name -ceq $functionName
            }.GetNewClosure(),
            $true
        )
    )
    if ($definitions.Count -ne 1) {
        throw "Expected exactly one $functionName function."
    }
    . ([scriptblock]::Create($definitions[0].Extent.Text))
}

$resolvedRoot = [System.IO.Path]::GetFullPath($currentRoot)
$brokerCli = [System.IO.Path]::GetFullPath($currentBrokerCli)
$brokerSidecarCompatibilityId = 'codex-local-remote/broker-sidecar/v1'
$script:events = [System.Collections.Generic.List[string]]::new()
$script:recoveryObservationPhase = 1
$script:recoveryObservationDelayCount = 0
$script:recoveryWriteCount = 0
$script:recoveryReadCount = 0
$script:recoveryRemoveCount = 0

function Test-NonNegativeInteger {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) {
        return $false
    }
    return (
        [System.Type]::GetTypeCode($Value.GetType()) -in @(
            [System.TypeCode]::Byte,
            [System.TypeCode]::UInt16,
            [System.TypeCode]::UInt32,
            [System.TypeCode]::UInt64,
            [System.TypeCode]::SByte,
            [System.TypeCode]::Int16,
            [System.TypeCode]::Int32,
            [System.TypeCode]::Int64
        ) -and
        [decimal]$Value -ge 0
    )
}

function Get-BrokerReadinessDecision {
    param(
        [AllowNull()][object]$Readiness,
        [string]$Phase
    )
    if ($Phase -cne 'StrictRuntime') {
        throw "Unexpected readiness phase '$Phase'."
    }
    if ($null -eq $Readiness -or
        -not [bool]$Readiness.appServerReady -or
        -not [bool]$Readiness.desktopConnected -or
        -not [bool]$Readiness.sidecarConnected -or
        [bool]$Readiness.degraded -or
        [int]$Readiness.unknownCount -ne 0) {
        return 'Reject'
    }
    return 'Ready'
}

function Test-BrokerReadinessRuntimeIdentity {
    param(
        [AllowNull()][object]$Readiness,
        [int]$ExpectedBrokerProcessId,
        [int]$ExpectedUpstreamProcessId,
        [string]$ExpectedRuntimeInvocationId
    )
    return (
        $Mode -cne 'proof-identity-drift' -and
        $null -ne $Readiness -and
        [int]$Readiness.brokerProcessId -eq $ExpectedBrokerProcessId -and
        [int]$Readiness.upstreamProcessId -eq $ExpectedUpstreamProcessId -and
        [string]$Readiness.runtimeInvocationId -ceq
            $ExpectedRuntimeInvocationId
    )
}

function Test-CodexDesktopNonceReadinessSnapshot {
    param([AllowNull()][object]$Readiness)
    return (
        $null -ne $Readiness -and
        [int]$Readiness.desktopConnectionCount -gt 0 -and
        @($Readiness.desktopLaunchNonceDigests).Count -gt 0
    )
}

function Test-CodexDesktopOwnerConnectionProof {
    param(
        [AllowNull()][object]$Readiness,
        [AllowNull()][object]$Proof,
        [string]$ExpectedRuntimeInvocationId,
        [AllowEmptyString()][string]$RootIdentityKey
    )
    return (
        $null -ne $Readiness -and
        $null -ne $Proof -and
        [string]$Proof.RuntimeInvocationId -ceq
            $ExpectedRuntimeInvocationId -and
        [string]$Proof.RootIdentityKey -ceq $RootIdentityKey -and
        [string]$Proof.LaunchNonceDigest -ceq
            [string]@($Readiness.desktopLaunchNonceDigests)[0]
    )
}

function Test-CodexDesktopOwnerRuntimePathEqual {
    param([string]$Left, [string]$Right)
    return [string]::Equals(
        [System.IO.Path]::GetFullPath($Left),
        [System.IO.Path]::GetFullPath($Right),
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Get-ProcessCreationIdentity {
    param([AllowNull()][object]$CreationDate)
    $ticks = if ([string]$CreationDate -ceq 'fixture-root-2') {
        638500000000000001L
    } else {
        638500000000000000L
    }
    return [pscustomobject]@{
        CreationDate = [string]$CreationDate
        CreationDateUtcTicks = $ticks
    }
}

function Open-ProcessIdentityHandle {
    param(
        [int]$ProcessId,
        [long]$ExpectedCreationDateUtcTicks
    )
    $process = [pscustomobject]@{
        HasExited = $false
        Id = $ProcessId
        MainModule = [pscustomobject]@{
            FileName = $desktopExecutablePath
        }
    }
    $process | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
    $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
    return [pscustomobject]@{
        Process = $process
        ProcessId = $ProcessId
        StartTimeUtcTicks = $ExpectedCreationDateUtcTicks
    }
}

function Get-CodexDesktopOwnerRootIdentityKey {
    param(
        [int]$ProcessId,
        [long]$StartTimeUtcTicks,
        [string]$ExecutablePath
    )
    $null = $ExecutablePath
    return "$ProcessId|$StartTimeUtcTicks|$('9' * 64)"
}

function Get-RunningCodexDesktopRootProcesses {
    $rootProcessId = if (
        (
            $Mode -ceq 'recovery-root-drift' -and
            $script:recoveryObservationPhase -eq 2
        ) -or (
            $Mode -ceq 'recovery-post-commit-root-drift' -and
            $script:recoveryObservationPhase -eq 3
        )
    ) {
        42002
    } else {
        42001
    }
    $roots = @(
        [pscustomobject]@{
            ProcessId = $rootProcessId
            CreationDate = if ($rootProcessId -eq 42002) {
                'fixture-root-2'
            } else {
                'fixture-root-1'
            }
            ExecutablePath = $desktopExecutablePath
        }
    )
    if ($Mode -ceq 'recovery-multiple-roots') {
        $roots += [pscustomobject]@{
            ProcessId = 42003
            CreationDate = 'fixture-root-2'
            ExecutablePath = $desktopExecutablePath
        }
    }
    return $roots
}

function Get-VerifiedBrokerRuntimeSnapshot {
    param([int]$ExpectedBrokerProcessId)
    $effectiveRuntimeInvocationId = if (
        $Mode -ceq 'recovery-runtime-drift' -and
        $script:recoveryObservationPhase -eq 2
    ) {
        'fedcba9876543210fedcba9876543210'
    } else {
        $runtimeInvocationId
    }
    $effectiveNonceDigest = if (
        $Mode -ceq 'recovery-nonce-drift' -and
        $script:recoveryObservationPhase -eq 2
    ) {
        '8' * 64
    } else {
        '7' * 64
    }
    $readiness = [pscustomobject]@{
        status = 'ready'
        appServerReady = $true
        brokerProcessId = $ExpectedBrokerProcessId
        upstreamProcessId = 411
        runtimeInvocationId = $effectiveRuntimeInvocationId
        runtimeReceiptInvocationId = $effectiveRuntimeInvocationId
        runtimeReceiptBrokerProcessId = $ExpectedBrokerProcessId
        runtimeReceiptUpstreamProcessId = 411
        desktopConnected = $true
        sidecarConnected = $true
        degraded = $false
        unknownCount = if ($Mode -ceq 'recovery-unknown-readiness') {
            1
        } else {
            0
        }
        desktopConnectionCount = if (
            $Mode -ceq 'recovery-multiple-connections'
        ) {
            2
        } else {
            1
        }
        desktopLaunchNonceDigests = if (
            $Mode -ceq 'recovery-multiple-connections'
        ) {
            @($effectiveNonceDigest, $effectiveNonceDigest)
        } else {
            @($effectiveNonceDigest)
        }
    }
    return [pscustomobject]@{
        Readiness = $readiness
        RuntimeInvocationId = $effectiveRuntimeInvocationId
        Upstream = [pscustomobject]@{ ProcessId = 411 }
    }
}

function Get-IndependentDesktopAppServerProcessIds {
    if ($Mode -ceq 'recovery-independent-stdio') {
        return @(42100)
    }
    return @()
}

function Get-CodexLocalRemoteCurrentRuntime {
    param([string]$DataDir)
    $null = $DataDir
    return $currentRuntime
}

function Get-CodexDesktopOwnerConnectionProofPath {
    param([string]$DataDir)
    $null = $DataDir
    return $desktopOwnerProofPath
}

function Write-CodexDesktopOwnerConnectionProof {
    param(
        [string]$DataDir,
        [string]$RuntimeInvocationId,
        [int]$ProcessId,
        [long]$StartTimeUtcTicks,
        [string]$ExecutablePath,
        [string]$LaunchNonceDigest
    )
    $null = $DataDir
    $script:recoveryWriteCount++
    $resolvedExecutablePath =
        [System.IO.Path]::GetFullPath($ExecutablePath)
    $proof = [ordered]@{
        Signature = 'codex-local-remote/desktop-owner-proof/v1'
        Version = 1
        RuntimeInvocationId = $RuntimeInvocationId
        ProcessId = $ProcessId
        StartTimeUtcTicks = $StartTimeUtcTicks
        ExecutablePath = $resolvedExecutablePath
        RootIdentityKey = Get-CodexDesktopOwnerRootIdentityKey `
            -ProcessId $ProcessId `
            -StartTimeUtcTicks $StartTimeUtcTicks `
            -ExecutablePath $resolvedExecutablePath
        LaunchNonceDigest = $LaunchNonceDigest
        RecordedAtUtc = '2026-08-01T00:00:02.0000000Z'
    }
    [System.IO.File]::WriteAllText(
        $desktopOwnerProofPath,
        ($proof | ConvertTo-Json -Depth 5 -Compress),
        [System.Text.UTF8Encoding]::new($false)
    )
    $script:recoveryObservationPhase = 3
    return [pscustomobject]$proof
}

function Read-CodexDesktopOwnerConnectionProof {
    param([string]$DataDir)
    $null = $DataDir
    $script:recoveryReadCount++
    if (-not (Test-Path -LiteralPath $desktopOwnerProofPath -PathType Leaf)) {
        return $null
    }
    try {
        $proof = Get-Content `
            -LiteralPath $desktopOwnerProofPath `
            -Raw |
            ConvertFrom-Json
        if ([string]$proof.Signature -cne
            'codex-local-remote/desktop-owner-proof/v1' -or
            [int]$proof.Version -ne 1) {
            return $null
        }
        return $proof
    } catch {
        return $null
    }
}

function Remove-CodexDesktopOwnerConnectionProof {
    param([string]$DataDir)
    $null = $DataDir
    $script:recoveryRemoveCount++
    if (Test-Path -LiteralPath $desktopOwnerProofPath) {
        Remove-Item -LiteralPath $desktopOwnerProofPath -Force
    }
}

function Start-Sleep {
    param([int]$Milliseconds, [int]$Seconds)
    $null = $Seconds
    if ($Milliseconds -gt 0) {
        $script:recoveryObservationDelayCount++
        $script:recoveryObservationPhase = 2
        if ($Mode -ceq 'recovery-receipt-drift') {
            $script:recoveryReceipt.RecordedAtUtc =
                '2026-08-01T00:00:01.0000000Z'
            $script:recoveryReceipt |
                ConvertTo-Json -Depth 20 |
                Set-Content `
                    -LiteralPath $brokerStatePath `
                    -Encoding utf8
        }
        if ($Mode -ceq 'recovery-proof-race') {
            Set-Content `
                -LiteralPath $desktopOwnerProofPath `
                -Value '{"appeared":true}' `
                -Encoding utf8
        }
    }
}

function Test-CodexLocalRemoteBrokerPayloadCompatibility {
    [CmdletBinding()]
    param(
        [string]$CurrentRuntimeRoot,
        [string]$CurrentVersionId,
        [string]$CurrentManifestSha256,
        [string]$ActiveRuntimeRoot,
        [string]$ActiveVersionId,
        [string]$ActiveManifestSha256
    )
    $script:events.Add('payload-checked')
    $null = @(
        $CurrentRuntimeRoot,
        $CurrentVersionId,
        $CurrentManifestSha256,
        $ActiveRuntimeRoot,
        $ActiveVersionId,
        $ActiveManifestSha256
    )
    $payloadMismatch = (
        $Mode -ceq 'payload-mismatch' -or
        (
            $Mode -ceq 'recovery-payload-drift' -and
            $script:recoveryObservationPhase -eq 2
        )
    )
    return [pscustomobject]@{
        IsCompatible = -not $payloadMismatch
        Reason = if ($payloadMismatch) {
            'fixture-payload-mismatch'
        } else {
            'fixture-payload-match'
        }
        Current = $null
        Active = $null
    }
}

function Get-CimInstance {
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [string]$ClassName,
        [string]$Filter
    )
    $null = @($ClassName, $Filter)
    if ($Mode -ceq 'old-sidecar-live') {
        return [pscustomobject]@{ ProcessId = 412 }
    }
    return $null
}

function Start-Process {
    $script:events.Add('broker-or-desktop-started')
    throw 'The adoption fixture must never start a process.'
}

function Stop-Process {
    $script:events.Add('broker-or-desktop-stopped')
    throw 'The adoption fixture must never stop a process.'
}

function Stop-ExactManagedBrokerAndOrphan {
    $script:events.Add('broker-stopped')
    throw 'The adoption fixture must never stop Broker.'
}

function Invoke-ManagedDesktopLaunch {
    $script:events.Add('desktop-started')
    throw 'The adoption fixture must never launch Desktop.'
}

function Write-AtomicJsonFile {
    param([string]$Path, [object]$Value)
    $null = $Path
    $script:writtenReceipt = $Value
}

$currentRuntime = [pscustomobject]@{
    CurrentVersionId = $currentVersionId
    CurrentRoot = $currentRoot
    CurrentManifestSha256 = $currentManifestSha256
    PreviousVersionId = $previousVersionId
    PreviousRoot = $previousRoot
    PreviousManifestSha256 = $previousManifestSha256
}
$supervisorRuntimeIdentity = [pscustomobject]@{
    VersionId = $currentVersionId
    RuntimeRoot = $currentRoot
    ManifestSha256 = $currentManifestSha256
}
$currentSidecarBinding = [pscustomobject]@{
    VersionId = $currentVersionId
    RuntimeRoot = $currentRoot
    ManifestSha256 = $currentManifestSha256
    SidecarCli = Join-Path $currentRoot 'apps\sidecar\dist\cli.js'
    BrokerSidecarCompatibilityId = $brokerSidecarCompatibilityId
}
$receiptRuntimeInvocationId = if ($Mode -ceq 'invocation-identity-drift') {
    'fedcba9876543210fedcba9876543210'
} else {
    $runtimeInvocationId
}
$receiptBrokerProcessId = if ($Mode -ceq 'broker-identity-drift') {
    499
} else {
    410
}
$receiptUpstreamProcessId = if ($Mode -ceq 'upstream-identity-drift') {
    498
} else {
    411
}
$activeReceipt = [pscustomobject]@{
    Signature = 'codex-local-remote/app-server-broker/v3'
    Version = 3
    Status = 'ready'
    RuntimeInvocationId = $receiptRuntimeInvocationId
    ProcessId = $receiptBrokerProcessId
    BrokerCliPath = $previousBrokerCli
    BrokerSidecarCompatibilityId = $brokerSidecarCompatibilityId
    Broker = [pscustomobject]@{
        RuntimeInvocationId = $receiptRuntimeInvocationId
        ProcessId = $receiptBrokerProcessId
    }
    Upstream = [pscustomobject]@{
        RuntimeInvocationId = $receiptRuntimeInvocationId
        ProcessId = $receiptUpstreamProcessId
    }
    Sidecar = [pscustomobject]@{
        RuntimeInvocationId = $receiptRuntimeInvocationId
        ProcessId = 412
    }
}
$readiness = [pscustomobject]@{
    status = 'ready'
    appServerReady = $true
    brokerProcessId = 410
    upstreamProcessId = 411
    runtimeInvocationId = $runtimeInvocationId
    desktopConnected = $true
    sidecarConnected = $false
    degraded = $false
    unknownCount = 0
    unsafeThreadCount = 1
}
$sidecarListeners = if ($Mode -ceq 'sidecar-port-occupied') {
    @([pscustomobject]@{
        LocalAddress = '127.0.0.1'
        LocalPort = 18790
        OwningProcess = 412
    })
} else {
    @()
}

$result = Get-PreviousBrokerAdoptionBinding `
    -CurrentRuntime $currentRuntime `
    -ActiveBrokerReceipt $activeReceipt `
    -Readiness $readiness `
    -BrokerListenerProcessId 410 `
    -SidecarListeners $sidecarListeners

$script:recoveryReceipt = [pscustomobject][ordered]@{
    Signature = 'codex-local-remote/app-server-broker/v3'
    Version = 3
    Status = 'ready'
    RuntimeInvocationId = $runtimeInvocationId
    ProcessId = 410
    BrokerCliPath = $previousBrokerCli
    BrokerSidecarCompatibilityId = $brokerSidecarCompatibilityId
    SupervisorRuntimeVersionId = $currentVersionId
    SupervisorRuntimeRoot = $currentRoot
    SupervisorRuntimeManifestSha256 = $currentManifestSha256
    SidecarRuntimeVersionId = $currentVersionId
    SidecarRuntimeRoot = $currentRoot
    SidecarRuntimeManifestSha256 = $currentManifestSha256
    BrokerRuntimeVersionId = $previousVersionId
    BrokerRuntimeRoot = $previousRoot
    BrokerRuntimeManifestSha256 = $previousManifestSha256
    SupervisorOnlyAdoptedPreviousBroker = $true
    Broker = [pscustomobject]@{
        RuntimeInvocationId = $runtimeInvocationId
        ProcessId = 410
    }
    Upstream = [pscustomobject]@{
        RuntimeInvocationId = $runtimeInvocationId
        ProcessId = 411
    }
    Sidecar = [pscustomobject]@{
        RuntimeInvocationId = $runtimeInvocationId
        ProcessId = 413
    }
    RecordedAtUtc = '2026-08-01T00:00:00.0000000Z'
}
$script:recoveryReceipt |
    ConvertTo-Json -Depth 20 |
    Set-Content -LiteralPath $brokerStatePath -Encoding utf8

$recoveryResult = if ($Mode -like 'recovery-*' -and
    [bool]$result.AdoptedFromPrevious) {
    Invoke-AdoptedDesktopOwnerProofRecovery `
        -SupervisorOnlyAdoptedPreviousBroker $true `
        -DataDir $SandboxRoot `
        -BrokerReceiptPath $brokerStatePath `
        -SupervisorRuntimeIdentity $supervisorRuntimeIdentity `
        -SidecarRuntimeBinding $currentSidecarBinding `
        -BrokerRuntimeIdentity $result.ActiveBrokerRuntime `
        -BrokerCliPath $previousBrokerCli `
        -BrokerSidecarCompatibilityId $brokerSidecarCompatibilityId `
        -ExpectedBrokerProcessId 410 `
        -ExpectedSidecarProcessId 413 `
        -ExpectedRuntimeInvocationId $runtimeInvocationId `
        -ExpectedDesktopExecutablePath $desktopExecutablePath `
        -ObservationDelayMilliseconds 1
} else {
    [pscustomobject]@{
        Status = 'not-requested'
        Reason = 'not-requested'
        Proof = $null
    }
}

$desktopRootIdentityKey =
    "42001|638500000000000000|$('9' * 64)"
$desktopLaunchNonceDigest = '7' * 64
$desktopConnectionCount = if ($Mode -ceq 'proof-multiple-connections') {
    2
} else {
    1
}
$desktopProofReadiness = [pscustomobject]@{
    status = 'ready'
    appServerReady = $true
    brokerProcessId = 410
    upstreamProcessId = 411
    runtimeInvocationId = $runtimeInvocationId
    runtimeReceiptInvocationId = $runtimeInvocationId
    runtimeReceiptBrokerProcessId = 410
    runtimeReceiptUpstreamProcessId = 411
    desktopConnected = $true
    sidecarConnected = $true
    degraded = $false
    unknownCount = 0
    desktopConnectionCount = $desktopConnectionCount
    desktopLaunchNonceDigests = @(
        1..$desktopConnectionCount |
            ForEach-Object { $desktopLaunchNonceDigest }
    )
}
$desktopProof = if ($Mode -ceq 'proof-missing') {
    $null
} else {
    [pscustomobject]@{
        RuntimeInvocationId = $runtimeInvocationId
        RootIdentityKey = $desktopRootIdentityKey
        LaunchNonceDigest = $desktopLaunchNonceDigest
    }
}
$independentStdioProcessIds = if (
    $Mode -ceq 'proof-independent-stdio'
) {
    @(42100)
} else {
    @()
}
$desktopProofBinding = if ([bool]$result.AdoptedFromPrevious) {
    Get-AdoptedDesktopOwnerProofBinding `
        -RuntimeSnapshot ([pscustomobject]@{
            Readiness = $desktopProofReadiness
            RuntimeInvocationId = $runtimeInvocationId
            Upstream = [pscustomobject]@{ ProcessId = 411 }
        }) `
        -RootIdentityKey $desktopRootIdentityKey `
        -Proof $desktopProof `
        -IndependentStdioProcessIds $independentStdioProcessIds `
        -ExpectedBrokerProcessId 410 `
        -ExpectedRuntimeInvocationId $runtimeInvocationId
} else {
    [pscustomobject]@{
        IsValid = $false
        Reason = 'broker-not-adopted'
        RootIdentityKey = $null
    }
}

$script:writtenReceipt = $null
if ([bool]$result.AdoptedFromPrevious) {
    $brokerCli = [string]$result.BrokerCliPath
    $supervisorRuntimeIdentity = [pscustomobject]@{
        VersionId = $currentVersionId
        RuntimeRoot = $currentRoot
        ManifestSha256 = $currentManifestSha256
    }
    $activeBrokerRuntimeIdentity = $result.ActiveBrokerRuntime
    $brokerRuntimeAdoptedFromPrevious = $true
    $brokerStatePath = Join-Path $SandboxRoot 'app-server-broker.json'
    $brokerSidecarCompatibilityId =
        'codex-local-remote/broker-sidecar/v1'
    $resolvedNode = 'C:\fixture\node.exe'
    $resolvedCodex = 'C:\fixture\codex.exe'
    $runtimeDiscovery = [pscustomobject]@{ Signature = 'fixture' }
    $bootstrapReceipt = [pscustomobject]@{ ProcessId = 409 }
    $runtimeInvocationId = $runtimeInvocationId
    $startedBroker = $false
    $currentSidecarBinding = [pscustomobject]@{
        VersionId = $currentVersionId
        RuntimeRoot = $currentRoot
        ManifestSha256 = $currentManifestSha256
        SidecarCli = Join-Path $currentRoot 'apps\sidecar\dist\cli.js'
    }
    Write-BrokerRuntimeReceipt `
        -Status ready `
        -BrokerReceipt ([pscustomobject]@{
            ProcessId = 410
            CreationDate = 'fixture'
            CreationDateUtcTicks = 10
            ProcessStartTimeUtcTicks = 10
        }) `
        -SidecarReceipt ([pscustomobject]@{ ProcessId = 413 }) `
        -UpstreamReceipt ([pscustomobject]@{ ProcessId = 411 }) `
        -SidecarRuntimeBinding $currentSidecarBinding
}

[pscustomobject]@{
    AdoptedFromPrevious = [bool]$result.AdoptedFromPrevious
    Reason = [string]$result.Reason
    BrokerCliPath = [string]$result.BrokerCliPath
    BrokerRuntimeVersionId =
        [string]$result.ActiveBrokerRuntime.VersionId
    BrokerRuntimeRoot = [string]$result.ActiveBrokerRuntime.RuntimeRoot
    BrokerRuntimeManifestSha256 =
        [string]$result.ActiveBrokerRuntime.ManifestSha256
    PayloadCompatibilityReason =
        [string]$result.PayloadCompatibilityReason
    BrokerOrDesktopStartStopCount = @(
        $script:events |
            Where-Object { $_ -cne 'payload-checked' }
    ).Count
    Events = [string[]]$script:events.ToArray()
    ReceiptVersion = [int]$script:writtenReceipt.Version
    ReceiptBrokerCliPath = [string]$script:writtenReceipt.BrokerCliPath
    ReceiptSupervisorRuntimeVersionId =
        [string]$script:writtenReceipt.SupervisorRuntimeVersionId
    ReceiptSupervisorRuntimeRoot =
        [string]$script:writtenReceipt.SupervisorRuntimeRoot
    ReceiptSupervisorRuntimeManifestSha256 =
        [string]$script:writtenReceipt.SupervisorRuntimeManifestSha256
    ReceiptSidecarRuntimeVersionId =
        [string]$script:writtenReceipt.SidecarRuntimeVersionId
    ReceiptSidecarRuntimeRoot =
        [string]$script:writtenReceipt.SidecarRuntimeRoot
    ReceiptSidecarRuntimeManifestSha256 =
        [string]$script:writtenReceipt.SidecarRuntimeManifestSha256
    ReceiptBrokerRuntimeVersionId =
        [string]$script:writtenReceipt.BrokerRuntimeVersionId
    ReceiptBrokerRuntimeRoot =
        [string]$script:writtenReceipt.BrokerRuntimeRoot
    ReceiptBrokerRuntimeManifestSha256 =
        [string]$script:writtenReceipt.BrokerRuntimeManifestSha256
    ReceiptSupervisorOnlyAdoptedPreviousBroker =
        [bool]$script:writtenReceipt.SupervisorOnlyAdoptedPreviousBroker
    DesktopProofValid = [bool]$desktopProofBinding.IsValid
    DesktopProofReason = [string]$desktopProofBinding.Reason
    DesktopProofRootIdentityKey =
        [string]$desktopProofBinding.RootIdentityKey
    RecoveryStatus = [string]$recoveryResult.Status
    RecoveryReason = [string]$recoveryResult.Reason
    RecoveryWriteCount = [int]$script:recoveryWriteCount
    RecoveryReadCount = [int]$script:recoveryReadCount
    RecoveryRemoveCount = [int]$script:recoveryRemoveCount
    RecoveryProofFileExists =
        (Test-Path -LiteralPath $desktopOwnerProofPath -PathType Leaf)
    RecoveryObservationDelayCount =
        [int]$script:recoveryObservationDelayCount
    RecoveryProofRootIdentityKey =
        [string]$recoveryResult.Proof.RootIdentityKey
    RecoveryProofLaunchNonceDigest =
        [string]$recoveryResult.Proof.LaunchNonceDigest
} | ConvertTo-Json -Depth 6 -Compress
