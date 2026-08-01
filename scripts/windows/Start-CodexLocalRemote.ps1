[CmdletBinding()]
param(
    [string]$CodexPath,

    [Parameter(Mandatory)]
    [string]$NodePath,

    [string]$InstallRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,

    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexLocalRemote'),

    [ValidateRange(1, 65535)]
    [int]$SidecarPort = 18790,

    [ValidateRange(1, 65535)]
    [int]$BrokerPort = 18791,

    [ValidateRange(1, 65535)]
    [int]$BrokerUpstreamPort = 18792,

    [string]$BasePath = '/codex-remote',

    [ValidateRange(1, 300)]
    [int]$BrokerStartupTimeoutSeconds = 75,

    [ValidateRange(1, 60)]
    [int]$SidecarHandshakeTimeoutSeconds = 60,

    [ValidateRange(1, 60)]
    [int]$RuntimeHandshakeTimeoutSeconds = 60,

    [ValidateRange(5, 3600)]
    [int]$DesktopRuntimeCheckIntervalSeconds = 30,

    [ValidateRange(10, 3600)]
    [int]$DesktopOwnerResumeGapSeconds = 30,

    [Parameter(DontShow)]
    [switch]$NoDesktopLaunch,

    [switch]$DesktopOwnerCoordinator,

    [switch]$TakeOverExistingNativeDesktop
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'CodexLocalRemote.Windows.psm1') -Force
$managedConfiguration = Get-CodexLocalRemoteManagedConfiguration -DataDir $DataDir
if ($null -ne $managedConfiguration) {
    if (-not $PSBoundParameters.ContainsKey('SidecarPort')) {
        $SidecarPort = [int]$managedConfiguration.SidecarPort
    }
    if (-not $PSBoundParameters.ContainsKey('BrokerPort')) {
        $BrokerPort = [int]$managedConfiguration.BrokerPort
    }
    if (-not $PSBoundParameters.ContainsKey('BrokerUpstreamPort')) {
        $BrokerUpstreamPort = [int]$managedConfiguration.BrokerUpstreamPort
    }
    if (-not $PSBoundParameters.ContainsKey('BasePath')) {
        $BasePath = [string]$managedConfiguration.BasePath
    }
}

# A persistent Desktop override is intentionally unsupported. The scheduled
# bootstrap starts from a clean process environment and grants the capability
# endpoint only to the Sidecar child process below.
Remove-Item Env:\CODEX_APP_SERVER_WS_URL -ErrorAction SilentlyContinue

$resolvedCodex = $null
$resolvedNode = [System.IO.Path]::GetFullPath($NodePath)
$resolvedRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
$brokerSidecarCompatibilityId =
    'codex-local-remote/broker-sidecar/v1'
$null = Assert-CodexLocalRemoteDataDirectoryStartupProtection `
    -DataDir $resolvedDataDir
$null = Sync-CodexLocalRemoteCurrentRuntime `
    -DataDir $resolvedDataDir `
    -InstallRoot $resolvedRoot
$startupStatusPath = Join-Path $resolvedDataDir 'startup-last.json'
$bootstrapInvocationId = [Guid]::NewGuid().ToString('N')
$runtimeInvocationId = $null
$bootstrapReceipt = $null
$runtimeDiscovery = $null
$activeBrokerRuntimeReceipt = $null
$startupStage = 'preflight'

function Protect-StartupStatusText {
    param([AllowNull()][object]$Value)
    $text = [string]$Value
    return [regex]::Replace($text, '/ws/[A-Za-z0-9_-]+', '/ws/<redacted>')
}

function Write-StartupStatus {
    param(
        [Parameter(Mandatory)][string]$Status,
        [AllowEmptyString()][string]$Message = ''
    )
    Write-AtomicJsonFile -Path $startupStatusPath -Value ([ordered]@{
        Signature = 'codex-local-remote/startup-status/v3'
        Version = 3
        Status = $Status
        Stage = $startupStage
        Message = Protect-StartupStatusText $Message
        BootstrapInvocationId = $bootstrapInvocationId
        RuntimeInvocationId = $runtimeInvocationId
        Bootstrap = $bootstrapReceipt
        Runtime = $runtimeDiscovery
        RecordedAtUtc = [DateTime]::UtcNow.ToString('O')
    })
}

function Get-DesktopHandoffPreparationForRuntime {
    param(
        [AllowNull()]
        [object]$Runtime,

        [switch]$RequireLiveOwnership
    )

    if ($null -eq $Runtime -or
        [string]$Runtime.CurrentVersionId -cnotmatch
            '^[0-9a-f]{64}$' -or
        [string]$Runtime.CurrentManifestSha256 -cnotmatch
            '^[0-9a-f]{64}$' -or
        [string]::IsNullOrWhiteSpace(
            [string]$Runtime.CurrentRoot
        )) {
        return $null
    }
    return Read-CodexLocalRemoteDesktopHandoffPreparation `
        -DataDir $resolvedDataDir `
        -ExpectedRuntimeVersionId (
            [string]$Runtime.CurrentVersionId
        ) `
        -ExpectedRuntimeRoot ([string]$Runtime.CurrentRoot) `
        -ExpectedManifestSha256 (
            [string]$Runtime.CurrentManifestSha256
        ) `
        -RequireLiveOwnership:$RequireLiveOwnership
}

function New-RuntimeProcessReceipt {
    param(
        [Parameter(Mandatory)][object]$CimProcess,
        [Parameter(Mandatory)][long]$StartTimeUtcTicks,
        [Parameter(Mandatory)][string]$RuntimeInvocationId
    )

    if ($RuntimeInvocationId -cnotmatch '^[0-9a-f]{32}$') {
        throw 'Broker runtime invocation ID is not a canonical 32-character lowercase hexadecimal identifier.'
    }
    $creationIdentity = Get-ProcessCreationIdentity `
        -CreationDate $CimProcess.CreationDate
    if ([Math]::Abs(
        [long]$creationIdentity.CreationDateUtcTicks - $StartTimeUtcTicks
    ) -gt [TimeSpan]::FromSeconds(2).Ticks) {
        throw "PID $([int]$CimProcess.ProcessId) receipt CreationDate does not match its held process handle."
    }
    return [ordered]@{
        RuntimeInvocationId = $RuntimeInvocationId
        ProcessId = [int]$CimProcess.ProcessId
        CreationDate = [string]$creationIdentity.CreationDate
        CreationDateUtcTicks = [long]$creationIdentity.CreationDateUtcTicks
        ProcessStartTimeUtcTicks = $StartTimeUtcTicks
    }
}

function Write-BrokerRuntimeReceipt {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('broker-ready', 'ready')]
        [string]$Status,

        [Parameter(Mandatory)][object]$BrokerReceipt,

        [AllowNull()][object]$SidecarReceipt,

        [AllowNull()][object]$UpstreamReceipt,

        [AllowNull()][object]$SidecarRuntimeBinding = $null
    )

    Write-AtomicJsonFile -Path $brokerStatePath -Value ([ordered]@{
        Signature = 'codex-local-remote/app-server-broker/v3'
        Version = 3
        Status = $Status
        RuntimeInvocationId = $runtimeInvocationId
        Bootstrap = $bootstrapReceipt
        Broker = $BrokerReceipt
        Sidecar = $SidecarReceipt
        Upstream = $UpstreamReceipt
        ProcessId = [int]$BrokerReceipt.ProcessId
        CreationDate = [string]$BrokerReceipt.CreationDate
        CreationDateUtcTicks = [long]$BrokerReceipt.CreationDateUtcTicks
        ProcessStartTimeUtcTicks = [long]$BrokerReceipt.ProcessStartTimeUtcTicks
        NodePath = $resolvedNode
        BrokerCliPath = $brokerCli
        BrokerSidecarCompatibilityId =
            $brokerSidecarCompatibilityId
        SupervisorRuntimeVersionId =
            [string]$supervisorRuntimeIdentity.VersionId
        SupervisorRuntimeRoot =
            [string]$supervisorRuntimeIdentity.RuntimeRoot
        SupervisorRuntimeManifestSha256 =
            [string]$supervisorRuntimeIdentity.ManifestSha256
        BrokerRuntimeVersionId =
            [string]$activeBrokerRuntimeIdentity.VersionId
        BrokerRuntimeRoot =
            [string]$activeBrokerRuntimeIdentity.RuntimeRoot
        BrokerRuntimeManifestSha256 =
            [string]$activeBrokerRuntimeIdentity.ManifestSha256
        SupervisorOnlyAdoptedPreviousBroker =
            $brokerRuntimeAdoptedFromPrevious
        SidecarRuntimeVersionId = if ($null -eq $SidecarReceipt -or
            $null -eq $SidecarRuntimeBinding) {
            $null
        } else {
            [string]$SidecarRuntimeBinding.VersionId
        }
        SidecarRuntimeRoot = if ($null -eq $SidecarReceipt -or
            $null -eq $SidecarRuntimeBinding) {
            $null
        } else {
            [string]$SidecarRuntimeBinding.RuntimeRoot
        }
        SidecarRuntimeManifestSha256 = if (
            $null -eq $SidecarReceipt -or
            $null -eq $SidecarRuntimeBinding
        ) {
            $null
        } else {
            [string]$SidecarRuntimeBinding.ManifestSha256
        }
        CodexPath = $resolvedCodex
        CodexRuntime = $runtimeDiscovery
        StartedByThisInvocation = $startedBroker
        RecordedAtUtc = [DateTime]::UtcNow.ToString('O')
    })
}

function Get-ActiveRuntimeDiscoveryReceipt {
    $activeBrokerPath = Join-Path $resolvedDataDir 'app-server-broker.json'
    $activeStartupPath = Join-Path $resolvedDataDir 'startup-last.json'
    if (-not (Test-Path -LiteralPath $activeBrokerPath -PathType Leaf)) {
        return $null
    }
    $brokerItem = Get-Item -LiteralPath $activeBrokerPath -Force -ErrorAction Stop
    if ($brokerItem.PSIsContainer -or
        ($brokerItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [long]$brokerItem.Length -lt 2 -or
        [long]$brokerItem.Length -gt 65536) {
        throw 'The active Broker receipt is not an ordinary bounded file.'
    }
    $brokerRawBefore = Get-Content -LiteralPath $activeBrokerPath -Raw -Encoding utf8
    $broker = $brokerRawBefore | ConvertFrom-Json -Depth 20 -ErrorAction Stop
    if ([string]$broker.Signature -cne
            'codex-local-remote/app-server-broker/v3' -or
        [int]$broker.Version -ne 3 -or
        [string]$broker.Status -cnotin @('broker-ready', 'ready') -or
        [string]::IsNullOrWhiteSpace([string]$broker.CodexPath)) {
        throw 'The active Broker receipt does not identify one managed Codex runtime.'
    }
    $activeCodexPath = [System.IO.Path]::GetFullPath([string]$broker.CodexPath)
    $activeCodexPathUnavailable =
        -not (Test-Path -LiteralPath $activeCodexPath -PathType Leaf)
    if ($activeCodexPathUnavailable) {
        $brokerRawAfter =
            Get-Content -LiteralPath $activeBrokerPath -Raw -Encoding utf8
        if ($brokerRawBefore -cne $brokerRawAfter) {
            throw 'The active Broker receipt changed during runtime recovery.'
        }
        # The generation gate separately proves that the prior task is stopped,
        # every recorded process identity is absent, and all managed listeners
        # are empty. Treat a now-uninstalled packaged Codex path as stale here;
        # any live listener still fails closed later because no reusable runtime
        # receipt is returned.
        return $null
    }
    $activeCodexItem = Get-Item -LiteralPath $activeCodexPath -Force
    if ($activeCodexItem.PSIsContainer -or
        ($activeCodexItem.Attributes -band
            [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The active Broker runtime path is not an ordinary file.'
    }
    $activeCodexHash = (
        Get-FileHash -LiteralPath $activeCodexPath -Algorithm SHA256
    ).Hash.ToUpperInvariant()
    $receipt = $null
    if (Test-Path -LiteralPath $activeStartupPath -PathType Leaf) {
        $startupItem = Get-Item -LiteralPath $activeStartupPath -Force
        if (-not $startupItem.PSIsContainer -and
            ($startupItem.Attributes -band
                [System.IO.FileAttributes]::ReparsePoint) -eq 0 -and
            [long]$startupItem.Length -ge 2 -and
            [long]$startupItem.Length -le 65536) {
            $startupRawBefore = Get-Content `
                -LiteralPath $activeStartupPath `
                -Raw `
                -Encoding utf8
            $startup = $startupRawBefore |
                ConvertFrom-Json -Depth 20 -ErrorAction Stop
            if ([string]$startup.Signature -ceq
                    'codex-local-remote/startup-status/v3' -and
                [int]$startup.Version -eq 3 -and
                $null -ne $startup.Runtime -and
                [string]$startup.Runtime.Signature -ceq
                    'codex-local-remote/codex-desktop-runtime/v1' -and
                [string]$startup.Runtime.CodexSha256 -ceq $activeCodexHash -and
                [string]::Equals(
                    [string]$startup.Runtime.CodexPath,
                    $activeCodexPath,
                    [System.StringComparison]::OrdinalIgnoreCase
                )) {
                $receipt = $startup.Runtime
            }
            $startupRawAfter = Get-Content `
                -LiteralPath $activeStartupPath `
                -Raw `
                -Encoding utf8
            if ($startupRawBefore -cne $startupRawAfter) {
                throw 'The active startup receipt changed during runtime recovery.'
            }
        }
    }
    if ($null -eq $receipt) {
        $receipt = [pscustomobject][ordered]@{
            Signature = 'codex-local-remote/codex-desktop-runtime/v1'
            Version = 1
            PackageName = 'active-receipt'
            PackageFamilyName = 'active-receipt'
            PackageFullName = 'active-receipt'
            PackageVersion = 'unknown'
            PackageInstallLocation = (Split-Path -Parent $activeCodexPath)
            DesktopExecutablePath = $activeCodexPath
            DesktopExecutableSha256 = $activeCodexHash
            BundledCodexPath = $activeCodexPath
            BundledCodexSha256 = $activeCodexHash
            CodexPath = $activeCodexPath
            CodexSha256 = $activeCodexHash
            Source = 'legacy-active-receipt'
            RunningDesktopObserved = $false
            DiscoveredAtUtc = [DateTime]::UtcNow.ToString('O')
        }
    }
    $brokerRawAfter = Get-Content -LiteralPath $activeBrokerPath -Raw -Encoding utf8
    if ($brokerRawBefore -cne $brokerRawAfter) {
        throw 'The active Broker receipt changed during runtime recovery.'
    }
    $script:activeBrokerRuntimeReceipt = $broker
    return $receipt
}

function Resolve-NewCodexDesktopRuntime {
    if (-not [string]::IsNullOrWhiteSpace($CodexPath)) {
        if ($env:CODEX_REMOTE_TEST_FIXTURE -cne '1') {
            throw 'A fixed -CodexPath override is not supported. The startup task must dynamically discover the current Codex Desktop runtime.'
        }
        $resolvedFixtureCodex = [System.IO.Path]::GetFullPath($CodexPath)
        if (-not (Test-Path -LiteralPath $resolvedFixtureCodex -PathType Leaf)) {
            throw "Fixture Codex runtime not found at '$resolvedFixtureCodex'."
        }
        $fixtureHash = (
            Get-FileHash -LiteralPath $resolvedFixtureCodex -Algorithm SHA256
        ).Hash.ToUpperInvariant()
        return [pscustomobject][ordered]@{
            Signature = 'codex-local-remote/codex-desktop-runtime/v1'
            Version = 1
            PackageName = 'fixture'
            PackageFamilyName = 'fixture'
            PackageFullName = 'fixture'
            PackageVersion = '0'
            PackageInstallLocation = (Split-Path -Parent $resolvedFixtureCodex)
            DesktopExecutablePath = $resolvedFixtureCodex
            DesktopExecutableSha256 = $fixtureHash
            BundledCodexPath = $resolvedFixtureCodex
            BundledCodexSha256 = $fixtureHash
            CodexPath = $resolvedFixtureCodex
            CodexSha256 = $fixtureHash
            Source = 'test-fixture'
            RunningDesktopObserved = $false
            DiscoveredAtUtc = [DateTime]::UtcNow.ToString('O')
        }
    }
    return Resolve-CodexDesktopRuntime `
        -RuntimeCachePath (
            Join-Path $resolvedDataDir 'desktop-runtime-cache.json'
        )
}

function Test-DesktopRuntimeIdentityCurrent {
    param(
        [AllowNull()][object]$ActiveRuntime,
        [AllowNull()][object]$CurrentRuntime
    )

    if ($null -eq $ActiveRuntime -or $null -eq $CurrentRuntime) {
        return $false
    }
    function Test-RuntimePathEqual {
        param(
            [AllowNull()][object]$Left,
            [AllowNull()][object]$Right
        )
        try {
            return [string]::Equals(
                [System.IO.Path]::GetFullPath([string]$Left),
                [System.IO.Path]::GetFullPath([string]$Right),
                [System.StringComparison]::OrdinalIgnoreCase
            )
        } catch {
            return $false
        }
    }
    return (
        [string]$ActiveRuntime.Signature -ceq
            'codex-local-remote/codex-desktop-runtime/v1' -and
        [string]$CurrentRuntime.Signature -ceq
            'codex-local-remote/codex-desktop-runtime/v1' -and
        [int]$ActiveRuntime.Version -eq 1 -and
        [int]$CurrentRuntime.Version -eq 1 -and
        [string]$ActiveRuntime.PackageName -ceq
            [string]$CurrentRuntime.PackageName -and
        [string]$ActiveRuntime.PackageFamilyName -ceq
            [string]$CurrentRuntime.PackageFamilyName -and
        [string]$ActiveRuntime.PackageFullName -ceq
            [string]$CurrentRuntime.PackageFullName -and
        [string]$ActiveRuntime.PackageVersion -ceq
            [string]$CurrentRuntime.PackageVersion -and
        (Test-RuntimePathEqual `
            -Left $ActiveRuntime.PackageInstallLocation `
            -Right $CurrentRuntime.PackageInstallLocation) -and
        (Test-RuntimePathEqual `
            -Left $ActiveRuntime.DesktopExecutablePath `
            -Right $CurrentRuntime.DesktopExecutablePath) -and
        [string]$ActiveRuntime.DesktopExecutableSha256 -ceq
            [string]$CurrentRuntime.DesktopExecutableSha256 -and
        (Test-RuntimePathEqual `
            -Left $ActiveRuntime.BundledCodexPath `
            -Right $CurrentRuntime.BundledCodexPath) -and
        [string]$ActiveRuntime.BundledCodexSha256 -ceq
            [string]$CurrentRuntime.BundledCodexSha256 -and
        (Test-RuntimePathEqual `
            -Left $ActiveRuntime.CodexPath `
            -Right $CurrentRuntime.CodexPath) -and
        [string]$ActiveRuntime.CodexSha256 -ceq
            [string]$CurrentRuntime.CodexSha256
    )
}

trap {
    try {
        Write-StartupStatus -Status 'failed' -Message $_.Exception.Message
    } catch {
        # Never replace the original startup failure with a diagnostic write failure.
    }
    exit 1
}

$initialDesiredMode =
    Get-CodexLocalRemoteDesiredMode -DataDir $resolvedDataDir
if ([string]$initialDesiredMode.Mode -ceq 'Native') {
    $startupStage = 'native-default'
    Write-StartupStatus `
        -Status 'inactive' `
        -Message (
            'Remote is explicitly closed. The demand-start task exited ' +
            'without starting Broker, Sidecar, or Codex Desktop.'
        )
    exit 0
}

$startupSelectedRuntime =
    Get-CodexLocalRemoteCurrentRuntime -DataDir $resolvedDataDir
$desktopHandoffPreparationPath =
    Get-CodexLocalRemoteDesktopHandoffPreparationPath `
        -DataDir $resolvedDataDir
$desktopHandoffPreparationPathPresent =
    Test-Path -LiteralPath $desktopHandoffPreparationPath
$desktopHandoffPreparation =
    Get-DesktopHandoffPreparationForRuntime `
        -Runtime $startupSelectedRuntime
$liveDesktopHandoffPreparation = if (
    $null -ne $desktopHandoffPreparation -and
    [string]$desktopHandoffPreparation.Phase -cin @(
        'requested',
        'ready'
    )
) {
    Get-DesktopHandoffPreparationForRuntime `
        -Runtime $startupSelectedRuntime `
        -RequireLiveOwnership
} else {
    $null
}
$runtimeDiscovery = Get-ActiveRuntimeDiscoveryReceipt
if ($null -ne $runtimeDiscovery) {
    $resolvedCodex = [System.IO.Path]::GetFullPath(
        [string]$runtimeDiscovery.CodexPath
    )
}
Write-StartupStatus -Status 'starting'
$bootstrapProcess = Get-CimInstance `
    Win32_Process `
    -Filter "ProcessId = $PID" `
    -ErrorAction Stop
$bootstrapCreationIdentity = Get-ProcessCreationIdentity `
    -CreationDate $bootstrapProcess.CreationDate
$bootstrapIdentityHandle = Open-ProcessIdentityHandle `
    -ProcessId $PID `
    -ExpectedCreationDateUtcTicks $bootstrapCreationIdentity.CreationDateUtcTicks
Assert-CanonicalBasePath -BasePath $BasePath
$sidecarLocalUrl = Join-BasePathUrl `
    -Origin "http://127.0.0.1:$SidecarPort" `
    -BasePath $BasePath
Assert-ForceCliDisabled
$sidecarCli = [System.IO.Path]::GetFullPath(
    (Join-Path $resolvedRoot 'apps\sidecar\dist\cli.js')
)
$brokerCli = [System.IO.Path]::GetFullPath(
    (Join-Path $resolvedRoot 'apps\broker\dist\cli.js')
)
$brokerOrigin = Get-BrokerWebSocketUrl -Port $BrokerPort
$null = Assert-LoopbackWebSocketUrl -WebSocketUrl $brokerOrigin
$brokerStatePath = Join-Path $resolvedDataDir 'app-server-broker.json'
$capabilityTokenPath = Get-BrokerCapabilityTokenPath -DataDir $resolvedDataDir
$upstreamTokenPath = [System.IO.Path]::GetFullPath(
    (Join-Path $resolvedDataDir 'app-server-upstream.token')
)

foreach ($requiredFile in @($resolvedNode, $brokerCli, $sidecarCli)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required runtime file not found at '$requiredFile'."
    }
}
if ($null -eq $startupSelectedRuntime -or
    [string]$startupSelectedRuntime.CurrentVersionId -cnotmatch
        '^[0-9a-f]{64}$' -or
    [string]$startupSelectedRuntime.CurrentManifestSha256 -cnotmatch
        '^[0-9a-f]{64}$' -or
    -not [string]::Equals(
        [System.IO.Path]::GetFullPath(
            [string]$startupSelectedRuntime.CurrentRoot
        ),
        $resolvedRoot,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw 'Supervisor runtime is not the exact selected immutable generation.'
}
$supervisorRuntimeIdentity = [pscustomobject][ordered]@{
    VersionId = [string]$startupSelectedRuntime.CurrentVersionId
    RuntimeRoot = $resolvedRoot
    ManifestSha256 =
        [string]$startupSelectedRuntime.CurrentManifestSha256
}
$activeBrokerRuntimeIdentity = [pscustomobject][ordered]@{
    VersionId = [string]$supervisorRuntimeIdentity.VersionId
    RuntimeRoot = [string]$supervisorRuntimeIdentity.RuntimeRoot
    ManifestSha256 = [string]$supervisorRuntimeIdentity.ManifestSha256
}
$brokerRuntimeAdoptedFromPrevious = $false
$webSocketUrl = Get-BrokerCapabilityWebSocketUrl `
    -Port $BrokerPort `
    -TokenPath $capabilityTokenPath

$desktopStdioPids = [System.Collections.Generic.List[int]]::new()
foreach ($candidate in @(
    Get-CimInstance Win32_Process -Filter "Name = 'codex.exe'" -ErrorAction SilentlyContinue
)) {
    $parent = Get-CimInstance `
        Win32_Process `
        -Filter "ProcessId = $([int]$candidate.ParentProcessId)" `
        -ErrorAction SilentlyContinue
    if (Test-IndependentDesktopAppServer `
        -CommandLine ([string]$candidate.CommandLine) `
        -ParentProcessName ([string]$parent.Name)) {
        if ($null -ne $liveDesktopHandoffPreparation -and
            [int]$candidate.ProcessId -eq
                [int](
                    $liveDesktopHandoffPreparation.DesktopAppServerProcessId
                )) {
            continue
        }
        $desktopStdioPids.Add([int]$candidate.ProcessId)
    }
}
if ($desktopStdioPids.Count -gt 0) {
    throw "Codex Desktop still owns an independent stdio app-server (PID(s): $($desktopStdioPids -join ', ')). Fully exit Desktop, start this task, then reopen Desktop so both clients use the shared broker."
}

function Get-BrokerListeners {
    return $(if ($env:CODEX_REMOTE_TEST_FIXTURE -ceq '1') {
        @(
            Get-NetTCPConnection `
                -State Listen `
                -LocalPort $BrokerPort `
                -ErrorAction SilentlyContinue
        )
    } else {
        @(
            Get-CodexLocalRemoteTcpListenerSnapshot `
                -LocalPorts @($BrokerPort)
        )
    })
}

function Get-SidecarListeners {
    return $(if ($env:CODEX_REMOTE_TEST_FIXTURE -ceq '1') {
        @(
            Get-NetTCPConnection `
                -State Listen `
                -LocalPort $SidecarPort `
                -ErrorAction SilentlyContinue
        )
    } else {
        @(
            Get-CodexLocalRemoteTcpListenerSnapshot `
                -LocalPorts @($SidecarPort)
        )
    })
}

function Get-UpstreamListeners {
    return $(if ($env:CODEX_REMOTE_TEST_FIXTURE -ceq '1') {
        @(
            Get-NetTCPConnection `
                -State Listen `
                -LocalPort $BrokerUpstreamPort `
                -ErrorAction SilentlyContinue
        )
    } else {
        @(
            Get-CodexLocalRemoteTcpListenerSnapshot `
                -LocalPorts @($BrokerUpstreamPort)
        )
    })
}

function Get-VerifiedManagedBroker {
    param([Parameter(Mandatory)][int]$ProcessId)

    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return $null
    }
    $ownership = Test-ManagedBrokerProcess `
        -CommandLine ([string]$process.CommandLine) `
        -ExecutablePath ([string]$process.ExecutablePath) `
        -ExpectedNodePath $resolvedNode `
        -ExpectedBrokerCliPath $brokerCli `
        -BrokerPort $BrokerPort `
        -UpstreamPort $BrokerUpstreamPort `
        -ExpectedCodexPath $resolvedCodex `
        -DataDir $resolvedDataDir `
        -CapabilityTokenFilePath $capabilityTokenPath
    if (-not $ownership.IsManaged) {
        throw "TCP port $BrokerPort is owned by PID $ProcessId, but it is not the exact managed Codex app-server broker ($($ownership.Reason)); refusing to reuse or stop it."
    }
    return $process
}

function Get-VerifiedManagedUpstream {
    $listeners = @(Get-UpstreamListeners)
    if (@(
        $listeners |
            Where-Object {
                -not (Test-IsLoopbackListenerAddress -Address $_.LocalAddress)
            }
    ).Count -gt 0) {
        throw "TCP port $BrokerUpstreamPort has a non-loopback listener; refusing to treat it as the managed app-server."
    }
    $managedListeners = @(Get-ManagedIpv4Listeners -Listeners $listeners)
    if ($managedListeners.Count -eq 0) {
        return $null
    }
    $pids = @(
        $managedListeners |
            Select-Object -ExpandProperty OwningProcess -Unique
    )
    if ($pids.Count -ne 1) {
        throw "TCP port $BrokerUpstreamPort has ambiguous ownership; refusing to reuse or stop it."
    }
    $processId = [int]$pids[0]
    $process = Get-CimInstance `
        Win32_Process `
        -Filter "ProcessId = $processId" `
        -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return $null
    }
    $ownership = Test-ManagedAppServerProcess `
        -CommandLine ([string]$process.CommandLine) `
        -ExecutablePath ([string]$process.ExecutablePath) `
        -ExpectedCodexPath $resolvedCodex `
        -WebSocketUrl (Get-BrokerWebSocketUrl -Port $BrokerUpstreamPort) `
        -TokenFilePath $upstreamTokenPath
    if (-not $ownership.IsManaged) {
        throw "TCP port $BrokerUpstreamPort is not owned by the exact authenticated managed app-server ($($ownership.Reason)); refusing to reuse or stop it."
    }
    return $process
}

function Get-BrokerReadinessSnapshot {
    try {
        return Invoke-RestMethod `
            -Method Get `
            -Uri "http://127.0.0.1:$BrokerPort/ready" `
            -TimeoutSec 1
    } catch {
        return $null
    }
}

function Test-SidecarRequestReady {
    try {
        $ready = Invoke-RestMethod `
            -Method Get `
            -Uri "${sidecarLocalUrl}api/v1/ready" `
            -TimeoutSec 2
        return [string]$ready.status -ceq 'ready'
    } catch {
        return $false
    }
}

function Invoke-ManagedDesktopLaunch {
    param(
        [switch]$SuppressFeedback,

        [switch]$NotifyOnRemoteSuccessOnly,

        [AllowEmptyString()]
        [string]$ExpectedTakeoverRootIdentityKey = '',

        [AllowEmptyString()]
        [string]$ExpectedSelectedRuntimeVersionId = '',

        [AllowEmptyString()]
        [string]$ExpectedSelectedRuntimeRoot = '',

        [AllowEmptyString()]
        [string]$LaunchCorrelationId = ''
    )

    if ($NoDesktopLaunch -or -not $DesktopOwnerCoordinator) {
        return $null
    }
    $launcherPath = Join-Path $PSScriptRoot 'Launch-CodexWithRemote.ps1'
    if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
        throw "Fail-open Codex Desktop launcher is missing at '$launcherPath'."
    }
    return & $launcherPath `
        -DataDir $resolvedDataDir `
        -BrokerPort $BrokerPort `
        -InfrastructureStartupTimeoutSeconds 0 `
        -DesktopAttachTimeoutSeconds 20 `
        -DesktopOwnerExecution `
        -TakeOverExistingNativeDesktop:$TakeOverExistingNativeDesktop `
        -ExpectedTakeoverRootIdentityKey $ExpectedTakeoverRootIdentityKey `
        -ExpectedSelectedRuntimeVersionId (
            $ExpectedSelectedRuntimeVersionId
        ) `
        -ExpectedSelectedRuntimeRoot $ExpectedSelectedRuntimeRoot `
        -LaunchCorrelationId $LaunchCorrelationId `
        -SuppressNotification:$SuppressFeedback `
        -NotifyOnRemoteSuccessOnly:$NotifyOnRemoteSuccessOnly
}

function Get-RunningCodexDesktopRootProcesses {
    return @(
        Get-CimInstance `
            Win32_Process `
            -Filter "Name = 'ChatGPT.exe'" `
            -ErrorAction SilentlyContinue |
            Where-Object {
                [string]$_.CommandLine -notmatch '(?i)(?:^|\s)--type=' -and
                (
                    [string]::IsNullOrWhiteSpace(
                        [string]$_.ExecutablePath
                    ) -or
                    [string]$_.ExecutablePath -match
                        '(?i)\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$'
                )
            }
    )
}

function Get-CodexDesktopOwnerHandoffRootProcesses {
    [CmdletBinding()]
    param()

    return @(
        Get-CimInstance `
            Win32_Process `
            -Filter "Name = 'ChatGPT.exe'" `
            -ErrorAction Stop |
            Where-Object {
                [string]$_.CommandLine -notmatch
                    '(?i)(?:^|\s)--type=' -and
                (
                    [string]::IsNullOrWhiteSpace(
                        [string]$_.ExecutablePath
                    ) -or
                    [string]$_.ExecutablePath -match
                        '(?i)\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$'
                )
            }
    )
}

function Test-CodexDesktopOwnerRuntimePathEqual {
    param(
        [Parameter(Mandatory)]
        [string]$Left,

        [Parameter(Mandatory)]
        [string]$Right
    )

    try {
        return [string]::Equals(
            [System.IO.Path]::GetFullPath($Left),
            [System.IO.Path]::GetFullPath($Right),
            [System.StringComparison]::OrdinalIgnoreCase
        )
    } catch {
        return $false
    }
}

function Assert-CodexDesktopOwnerTakeoverSafetyWindow {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ExpectedRootIdentityKey,

        [Parameter(Mandatory)]
        [string]$ExpectedRuntimeVersionId,

        [Parameter(Mandatory)]
        [string]$ExpectedRuntimeRoot,

        [Parameter(Mandatory)]
        [string]$ExpectedRuntimeInvocationId,

        [Parameter(Mandatory)]
        [ValidateRange(1, 2147483647)]
        [int]$ExpectedBrokerProcessId,

        [ValidateRange(2, 5)]
        [int]$RequiredObservations = 2,

        [ValidateRange(1, 1000)]
        [int]$GraceMilliseconds = 150
    )

    for ($observation = 1;
        $observation -le $RequiredObservations;
        $observation++) {
        $roots = @(Get-CodexDesktopOwnerHandoffRootProcesses)
        $rootIdentityKey = Get-UniqueCodexDesktopRootIdentityKey `
            -Processes $roots
        if ([string]$rootIdentityKey -cne
            $ExpectedRootIdentityKey) {
            throw (
                'Desktop takeover safety found a changed or ambiguous root.'
            )
        }
        $currentRuntime = Get-CodexLocalRemoteCurrentRuntime `
            -DataDir $resolvedDataDir
        if ($null -eq $currentRuntime -or
            [string]$currentRuntime.CurrentVersionId -cne
                $ExpectedRuntimeVersionId -or
            -not (Test-CodexDesktopOwnerRuntimePathEqual `
                -Left ([string]$currentRuntime.CurrentRoot) `
                -Right $ExpectedRuntimeRoot)) {
            throw 'Desktop takeover safety found selected runtime drift.'
        }
        $runtimeSnapshot = Get-VerifiedBrokerRuntimeSnapshot `
            -ExpectedBrokerProcessId $ExpectedBrokerProcessId
        $readiness = if ($null -eq $runtimeSnapshot) {
            $null
        } else {
            $runtimeSnapshot.Readiness
        }
        if ($null -eq $readiness -or
            [string]$runtimeSnapshot.RuntimeInvocationId -cne
                $ExpectedRuntimeInvocationId -or
            $readiness.desktopConnected -isnot [bool] -or
            [bool]$readiness.desktopConnected) {
            throw (
                'Desktop takeover safety found an unreachable, changed, or ' +
                'still-connected Broker. Managed turns remain owned by the ' +
                'verified Broker during this Desktop-only reconnect.'
            )
        }
        if ($observation -lt $RequiredObservations) {
            Start-Sleep -Milliseconds $GraceMilliseconds
        }
    }
}

function Get-UniqueCodexDesktopRootIdentityKey {
    param(
        [AllowNull()]
        [object[]]$Processes
    )

    $roots = @($Processes)
    if ($roots.Count -ne 1) {
        return $null
    }
    $root = $roots[0]
    if ($null -eq $root.PSObject.Properties['ProcessId'] -or
        [int]$root.ProcessId -lt 1 -or
        $null -eq $root.PSObject.Properties['CreationDate'] -or
        [string]::IsNullOrWhiteSpace([string]$root.ExecutablePath)) {
        return $null
    }
    try {
        $creationIdentity = Get-ProcessCreationIdentity `
            -CreationDate $root.CreationDate
        $identityHandle = Open-ProcessIdentityHandle `
            -ProcessId ([int]$root.ProcessId) `
            -ExpectedCreationDateUtcTicks (
                [long]$creationIdentity.CreationDateUtcTicks
            )
        try {
            return Get-CodexDesktopOwnerRootIdentityKey `
                -ProcessId ([int]$root.ProcessId) `
                -StartTimeUtcTicks ([long]$identityHandle.StartTimeUtcTicks) `
                -ExecutablePath ([string]$root.ExecutablePath)
        } finally {
            $identityHandle.Process.Dispose()
        }
    } catch {
        return $null
    }
}

function Get-CodexDesktopFallbackSuppressionRootIdentityKey {
    $path = Join-Path `
        $resolvedDataDir `
        'desktop-owner-fallback-suppression.json'
    try {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            return $null
        }
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or
            ($item.Attributes -band
                [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            [long]$item.Length -lt 64 -or
            [long]$item.Length -gt 8192) {
            return $null
        }
        $rawBefore = Get-Content -LiteralPath $path -Raw -Encoding utf8
        $receipt = $rawBefore |
            ConvertFrom-Json -Depth 8 -DateKind String -ErrorAction Stop
        $rawAfter = Get-Content -LiteralPath $path -Raw -Encoding utf8
        $expiresAt = [DateTimeOffset]::Parse(
            [string]$receipt.ExpiresAtUtc,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
        if ($rawBefore -cne $rawAfter -or
            [string]$receipt.Signature -cne
                'codex-local-remote/desktop-owner-fallback-suppression/v1' -or
            [int]$receipt.Version -ne 1 -or
            [string]$receipt.RootIdentityKey -cnotmatch
                '^[1-9][0-9]*\|[1-9][0-9]*\|[0-9a-f]{64}$' -or
            [string]$receipt.Reason -cne 'package-refresh-failed' -or
            $expiresAt.Offset -ne [TimeSpan]::Zero -or
            $expiresAt -lt [DateTimeOffset]::UtcNow) {
            return $null
        }
        $currentRootKey = Get-UniqueCodexDesktopRootIdentityKey `
            -Processes @(Get-RunningCodexDesktopRootProcesses)
        if ($currentRootKey -ceq [string]$receipt.RootIdentityKey) {
            return $currentRootKey
        }
    } catch {
        return $null
    }
    return $null
}

function Get-CodexPackageRefreshWorkerRootIdentityKey {
    $path = Join-Path `
        $resolvedDataDir `
        'desktop-package-refresh-intent.json'
    try {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            return $null
        }
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or
            ($item.Attributes -band
                [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            [long]$item.Length -lt 64 -or
            [long]$item.Length -gt 8192) {
            return $null
        }
        $rawBefore = Get-Content -LiteralPath $path -Raw -Encoding utf8
        $intent = $rawBefore |
            ConvertFrom-Json -Depth 8 -DateKind String -ErrorAction Stop
        $rawAfter = Get-Content -LiteralPath $path -Raw -Encoding utf8
        $requestedAt = [DateTimeOffset]::Parse(
            [string]$intent.RequestedAtUtc,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
        if ($rawBefore -cne $rawAfter -or
            [string]$intent.Signature -cne
                'codex-local-remote/desktop-package-refresh-intent/v1' -or
            [int]$intent.Version -ne 1 -or
            [string]$intent.ExpectedRootIdentityKey -cnotmatch
                '^[1-9][0-9]*\|[1-9][0-9]*\|[0-9a-f]{64}$' -or
            [string]$intent.WorkerNonce -cnotmatch '^[0-9a-f]{32}$' -or
            $requestedAt.Offset -ne [TimeSpan]::Zero -or
            $requestedAt -lt [DateTimeOffset]::UtcNow.AddMinutes(-2) -or
            -not (Test-NonNegativeInteger -Value $intent.WorkerProcessId) -or
            -not (Test-NonNegativeInteger `
                -Value $intent.WorkerStartTimeUtcTicks)) {
            return $null
        }
        $currentRootKey = Get-UniqueCodexDesktopRootIdentityKey `
            -Processes @(Get-RunningCodexDesktopRootProcesses)
        if ($currentRootKey -cne
            [string]$intent.ExpectedRootIdentityKey) {
            return $null
        }
        if ([int]$intent.WorkerProcessId -eq 0 -and
            [long]$intent.WorkerStartTimeUtcTicks -eq 0 -and
            $requestedAt -ge [DateTimeOffset]::UtcNow.AddSeconds(-15)) {
            return $currentRootKey
        }
        $worker = Get-Process `
            -Id ([int]$intent.WorkerProcessId) `
            -ErrorAction SilentlyContinue
        if ($null -eq $worker) {
            return $null
        }
        try {
            $worker.Refresh()
            if ($worker.HasExited -or
                $worker.StartTime.ToUniversalTime().Ticks -ne
                    [long]$intent.WorkerStartTimeUtcTicks) {
                return $null
            }
        } finally {
            $worker.Dispose()
        }
        return $currentRootKey
    } catch {
        return $null
    }
    return $null
}

function Update-CodexDesktopOwnerPackageRefreshState {
    param(
        [Parameter(Mandatory)]
        [object]$State,

        [AllowEmptyString()]
        [string]$CurrentRootIdentityKey = '',

        [AllowEmptyString()]
        [string]$SuppressedRootIdentityKey = '',

        [AllowEmptyString()]
        [string]$ActiveRefreshRootIdentityKey = ''
    )

    if (-not [string]::IsNullOrWhiteSpace(
        $SuppressedRootIdentityKey
    )) {
        $State.LastAttemptedRootIdentityKey =
            $SuppressedRootIdentityKey
        $State.PendingPackageRefreshRootIdentityKey = $null
    } elseif (-not [string]::IsNullOrWhiteSpace(
        $ActiveRefreshRootIdentityKey
    )) {
        $State.LastAttemptedRootIdentityKey =
            $ActiveRefreshRootIdentityKey
        $State.PendingPackageRefreshRootIdentityKey =
            $ActiveRefreshRootIdentityKey
    } elseif (
        -not [string]::IsNullOrWhiteSpace(
            $State.PendingPackageRefreshRootIdentityKey
        ) -and
        $State.PendingPackageRefreshRootIdentityKey -ceq
            $CurrentRootIdentityKey
    ) {
        $State.LastAttemptedRootIdentityKey = $null
        $State.PendingPackageRefreshRootIdentityKey = $null
    }
    return $State
}

function Test-BrokerReadinessRuntimeIdentity {
    param(
        [AllowNull()][object]$Readiness,
        [Parameter(Mandatory)][int]$ExpectedBrokerProcessId,
        [Parameter(Mandatory)][int]$ExpectedUpstreamProcessId,
        [Parameter(Mandatory)][string]$ExpectedRuntimeInvocationId
    )

    return (
        $null -ne $Readiness -and
        [string]$Readiness.runtimeInvocationId -ceq $ExpectedRuntimeInvocationId -and
        (Test-NonNegativeInteger -Value $Readiness.brokerProcessId) -and
        [int]$Readiness.brokerProcessId -eq $ExpectedBrokerProcessId -and
        (Test-NonNegativeInteger -Value $Readiness.upstreamProcessId) -and
        [int]$Readiness.upstreamProcessId -eq $ExpectedUpstreamProcessId
    )
}

function Get-VerifiedBrokerRuntimeSnapshot {
    param([Parameter(Mandatory)][int]$ExpectedBrokerProcessId)

    $readiness = Get-BrokerReadinessSnapshot
    if ((Get-BrokerReadinessDecision -Readiness $readiness -Phase Infrastructure) -cne 'Ready' -or
        [string]$readiness.runtimeInvocationId -cnotmatch '^[0-9a-f]{32}$' -or
        -not (Test-NonNegativeInteger -Value $readiness.brokerProcessId) -or
        [int]$readiness.brokerProcessId -ne $ExpectedBrokerProcessId -or
        -not (Test-NonNegativeInteger -Value $readiness.upstreamProcessId)) {
        return $null
    }
    $upstream = Get-VerifiedManagedUpstream
    if ($null -eq $upstream -or
        [int]$upstream.ProcessId -ne [int]$readiness.upstreamProcessId) {
        return $null
    }
    return [pscustomobject]@{
        Readiness = $readiness
        RuntimeInvocationId = [string]$readiness.runtimeInvocationId
        Upstream = $upstream
    }
}

function Test-BrokerInfrastructureReady {
    param([Parameter(Mandatory)][int]$ExpectedBrokerProcessId)
    return $null -ne (
        Get-VerifiedBrokerRuntimeSnapshot `
            -ExpectedBrokerProcessId $ExpectedBrokerProcessId
    )
}

function Wait-ForSidecarHandshake {
    param(
        [Parameter(Mandatory)][object]$SidecarProcess,
        [Parameter(Mandatory)][object]$BrokerIdentityHandle,
        [Parameter(Mandatory)][int]$TimeoutSeconds
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if ($SidecarProcess.HasExited) {
            throw "Sidecar exited with code $($SidecarProcess.ExitCode) during its Broker handshake."
        }
        $BrokerIdentityHandle.Process.Refresh()
        $brokerAlive = -not $BrokerIdentityHandle.Process.HasExited -and
            $BrokerIdentityHandle.Process.StartTime.ToUniversalTime().Ticks -eq
                [long]$BrokerIdentityHandle.StartTimeUtcTicks
        if (-not $brokerAlive) {
            throw 'Shared Broker exited during the Sidecar handshake.'
        }

        $readiness = Get-BrokerReadinessSnapshot
        $decision = Get-BrokerReadinessDecision `
            -Readiness $readiness `
            -Phase SidecarHandshake
        if ($decision -ceq 'Ready') {
            $upstream = Get-VerifiedManagedUpstream
            if ($null -eq $upstream -or
                -not (Test-BrokerReadinessRuntimeIdentity `
                    -Readiness $readiness `
                    -ExpectedBrokerProcessId ([int]$BrokerIdentityHandle.ProcessId) `
                    -ExpectedUpstreamProcessId ([int]$upstream.ProcessId) `
                    -ExpectedRuntimeInvocationId $runtimeInvocationId)) {
                throw 'Managed app-server ownership changed during the Sidecar handshake.'
            }
            # Cold start is deliberately two-phase. The Sidecar transport must
            # remain alive before Desktop is launched with its process-scoped
            # endpoint; application requests stay disabled until Desktop later
            # connects and the application-readiness probe becomes true.
            return $upstream
        }
        if ($decision -ceq 'Reject') {
            throw 'Broker rejected the Sidecar handshake readiness state.'
        }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Sidecar did not complete its Broker handshake within $TimeoutSeconds seconds."
}

function Get-SharedRuntimeDecision {
    $readiness = Get-BrokerReadinessSnapshot
    $decision = Get-BrokerReadinessDecision `
        -Readiness $readiness `
        -Phase RuntimeTransition
    if ($decision -ceq 'Reject' -or $null -eq $readiness) {
        return $decision
    }
    if ($decision -ceq 'Ready' -or
        $decision -ceq 'Degraded' -or
        $decision -ceq 'Wait') {
        $upstream = Get-VerifiedManagedUpstream
        if ($null -eq $upstream) {
            return 'Wait'
        }
        if (-not (Test-BrokerReadinessRuntimeIdentity `
                -Readiness $readiness `
                -ExpectedBrokerProcessId $brokerPid `
                -ExpectedUpstreamProcessId ([int]$upstream.ProcessId) `
                -ExpectedRuntimeInvocationId $runtimeInvocationId)) {
            return 'Reject'
        }
    }
    return $decision
}

function Get-PreviousBrokerAdoptionBinding {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$CurrentRuntime,

        [AllowNull()]
        [object]$ActiveBrokerReceipt,

        [AllowNull()]
        [object]$Readiness,

        [Parameter(Mandatory)]
        [ValidateRange(1, 2147483647)]
        [int]$BrokerListenerProcessId,

        [AllowNull()]
        [object[]]$SidecarListeners
    )

    $reject = {
        param([Parameter(Mandatory)][string]$Reason)
        return [pscustomobject][ordered]@{
            AdoptedFromPrevious = $false
            Reason = $Reason
            BrokerCliPath = $null
            ActiveBrokerRuntime = $null
            PayloadCompatibilityReason = $null
        }
    }
    function Test-AdoptionPathEqual {
        param(
            [AllowNull()][object]$Left,
            [AllowNull()][object]$Right
        )
        try {
            return [string]::Equals(
                [System.IO.Path]::GetFullPath([string]$Left),
                [System.IO.Path]::GetFullPath([string]$Right),
                [System.StringComparison]::OrdinalIgnoreCase
            )
        } catch {
            return $false
        }
    }

    try {
        if ($null -eq $CurrentRuntime -or
            [string]$CurrentRuntime.CurrentVersionId -cnotmatch
                '^[0-9a-f]{64}$' -or
            [string]$CurrentRuntime.CurrentManifestSha256 -cnotmatch
                '^[0-9a-f]{64}$' -or
            [string]$CurrentRuntime.PreviousVersionId -cnotmatch
                '^[0-9a-f]{64}$' -or
            [string]$CurrentRuntime.PreviousManifestSha256 -cnotmatch
                '^[0-9a-f]{64}$' -or
            -not (Test-AdoptionPathEqual `
                -Left $CurrentRuntime.CurrentRoot `
                -Right $resolvedRoot) -or
            (Test-AdoptionPathEqual `
                -Left $CurrentRuntime.CurrentRoot `
                -Right $CurrentRuntime.PreviousRoot)) {
            return (& $reject `
                'Current pointer does not identify one exact Previous runtime.')
        }

        $previousRoot = [System.IO.Path]::GetFullPath(
            [string]$CurrentRuntime.PreviousRoot
        )
        $previousBrokerCli = [System.IO.Path]::GetFullPath(
            (Join-Path $previousRoot 'apps\broker\dist\cli.js')
        )
        $previousRootPrefix =
            [System.IO.Path]::TrimEndingDirectorySeparator($previousRoot) + '\'
        if (-not $previousBrokerCli.StartsWith(
                $previousRootPrefix,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -or
            $null -eq $ActiveBrokerReceipt -or
            [string]$ActiveBrokerReceipt.Signature -cne
                'codex-local-remote/app-server-broker/v3' -or
            [int]$ActiveBrokerReceipt.Version -ne 3 -or
            [string]$ActiveBrokerReceipt.Status -cne 'ready' -or
            -not (Test-AdoptionPathEqual `
                -Left $ActiveBrokerReceipt.BrokerCliPath `
                -Right $previousBrokerCli) -or
            -not (Test-Path -LiteralPath $previousBrokerCli -PathType Leaf)) {
            return (& $reject `
                'Active receipt does not point to the exact Previous Broker path.')
        }
        $previousBrokerItem =
            Get-Item -LiteralPath $previousBrokerCli -Force -ErrorAction Stop
        if ($previousBrokerItem.PSIsContainer -or
            ($previousBrokerItem.Attributes -band
                [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            return (& $reject `
                'Active Previous Broker path is not one ordinary file.')
        }

        $payloadCompatibility =
            Test-CodexLocalRemoteBrokerPayloadCompatibility `
                -CurrentRuntimeRoot (
                    [string]$CurrentRuntime.CurrentRoot
                ) `
                -CurrentVersionId (
                    [string]$CurrentRuntime.CurrentVersionId
                ) `
                -CurrentManifestSha256 (
                    [string]$CurrentRuntime.CurrentManifestSha256
                ) `
                -ActiveRuntimeRoot $previousRoot `
                -ActiveVersionId (
                    [string]$CurrentRuntime.PreviousVersionId
                ) `
                -ActiveManifestSha256 (
                    [string]$CurrentRuntime.PreviousManifestSha256
                )
        if ($null -eq $payloadCompatibility -or
            $payloadCompatibility.IsCompatible -isnot [bool] -or
            -not [bool]$payloadCompatibility.IsCompatible) {
            $payloadReason = if ($null -eq $payloadCompatibility) {
                'missing compatibility evidence'
            } else {
                [string]$payloadCompatibility.Reason
            }
            return (& $reject `
                "Broker payload closure is not byte-compatible: $payloadReason")
        }

        # In production, collect live client and listener evidence only after
        # the comparatively expensive immutable-payload proof. Tests may inject
        # exact snapshots without consulting real listeners or processes.
        $effectiveReadiness = if (
            $PSBoundParameters.ContainsKey('Readiness')
        ) {
            $Readiness
        } else {
            Get-BrokerReadinessSnapshot
        }
        $effectiveSidecarListeners = if (
            $PSBoundParameters.ContainsKey('SidecarListeners')
        ) {
            $SidecarListeners
        } else {
            @(Get-SidecarListeners)
        }
        $readinessIsStrictPreviousBroker = (
            $null -ne $effectiveReadiness -and
            [string]$effectiveReadiness.status -ceq 'ready' -and
            $effectiveReadiness.appServerReady -is [bool] -and
            [bool]$effectiveReadiness.appServerReady -and
            $effectiveReadiness.desktopConnected -is [bool] -and
            [bool]$effectiveReadiness.desktopConnected -and
            $effectiveReadiness.sidecarConnected -is [bool] -and
            -not [bool]$effectiveReadiness.sidecarConnected -and
            $effectiveReadiness.degraded -is [bool] -and
            -not [bool]$effectiveReadiness.degraded -and
            (Test-NonNegativeInteger `
                -Value $effectiveReadiness.unknownCount) -and
            [int]$effectiveReadiness.unknownCount -eq 0
        )
        if (-not $readinessIsStrictPreviousBroker) {
            return (& $reject `
                'Previous Broker readiness is not exact for Sidecar-free adoption.')
        }

        $receiptInvocationId =
            [string]$ActiveBrokerReceipt.RuntimeInvocationId
        if ($receiptInvocationId -cnotmatch '^[0-9a-f]{32}$' -or
            [string]$effectiveReadiness.runtimeInvocationId -cne
                $receiptInvocationId -or
            [string]$ActiveBrokerReceipt.Broker.RuntimeInvocationId -cne
                $receiptInvocationId -or
            [string]$ActiveBrokerReceipt.Upstream.RuntimeInvocationId -cne
                $receiptInvocationId -or
            [string]$ActiveBrokerReceipt.Sidecar.RuntimeInvocationId -cne
                $receiptInvocationId) {
            return (& $reject `
                'Broker runtime invocation identity drifted across receipt and readiness.')
        }
        if (-not (Test-NonNegativeInteger `
                -Value $ActiveBrokerReceipt.ProcessId) -or
            -not (Test-NonNegativeInteger `
                -Value $ActiveBrokerReceipt.Broker.ProcessId) -or
            -not (Test-NonNegativeInteger `
                -Value $effectiveReadiness.brokerProcessId) -or
            [int]$ActiveBrokerReceipt.ProcessId -ne
                $BrokerListenerProcessId -or
            [int]$ActiveBrokerReceipt.Broker.ProcessId -ne
                $BrokerListenerProcessId -or
            [int]$effectiveReadiness.brokerProcessId -ne
                $BrokerListenerProcessId) {
            return (& $reject `
                'Broker identity drifted across listener, receipt, and readiness.')
        }
        if (-not (Test-NonNegativeInteger `
                -Value $ActiveBrokerReceipt.Upstream.ProcessId) -or
            -not (Test-NonNegativeInteger `
                -Value $effectiveReadiness.upstreamProcessId) -or
            [int]$ActiveBrokerReceipt.Upstream.ProcessId -ne
                [int]$effectiveReadiness.upstreamProcessId) {
            return (& $reject `
                'Broker upstream identity drifted across receipt and readiness.')
        }
        if ([string]$ActiveBrokerReceipt.BrokerSidecarCompatibilityId -cne
                $brokerSidecarCompatibilityId) {
            return (& $reject `
                'Broker and Current Sidecar compatibility identity drifted.')
        }
        if ($null -ne $effectiveSidecarListeners -and
            @($effectiveSidecarListeners).Count -ne 0) {
            return (& $reject 'Sidecar port is still occupied.')
        }
        if (-not (Test-NonNegativeInteger `
                -Value $ActiveBrokerReceipt.Sidecar.ProcessId) -or
            [int]$ActiveBrokerReceipt.Sidecar.ProcessId -lt 1) {
            return (& $reject `
                'Previous Sidecar receipt PID is missing or invalid.')
        }
        $oldSidecarProcess = Get-CimInstance `
            -ClassName Win32_Process `
            -Filter (
                "ProcessId = $([int]$ActiveBrokerReceipt.Sidecar.ProcessId)"
            ) `
            -ErrorAction SilentlyContinue
        if ($null -ne $oldSidecarProcess) {
            return (& $reject 'Previous Sidecar receipt PID is still alive.')
        }

        return [pscustomobject][ordered]@{
            AdoptedFromPrevious = $true
            Reason = 'exact-previous-broker-payload-adopted'
            BrokerCliPath = $previousBrokerCli
            ActiveBrokerRuntime = [pscustomobject][ordered]@{
                VersionId = [string]$CurrentRuntime.PreviousVersionId
                RuntimeRoot = $previousRoot
                ManifestSha256 =
                    [string]$CurrentRuntime.PreviousManifestSha256
            }
            PayloadCompatibilityReason =
                [string]$payloadCompatibility.Reason
        }
    } catch {
        return (& $reject `
            "Previous Broker adoption evidence failed: $($_.Exception.Message)")
    }
}

function Stop-ExactManagedBrokerAndOrphan {
    param(
        [AllowNull()]
        [object]$Broker
    )

    if ($null -ne $Broker) {
        $verified = Get-VerifiedManagedBroker -ProcessId ([int]$Broker.ProcessId)
        if ($null -ne $verified) {
            $creation = Get-ProcessCreationIdentity `
                -CreationDate $verified.CreationDate
            $identityHandle = Open-ProcessIdentityHandle `
                -ProcessId ([int]$Broker.ProcessId) `
                -ExpectedCreationDateUtcTicks $creation.CreationDateUtcTicks
            try {
                $listeners = @(
                    Get-ManagedIpv4Listeners -Listeners @(Get-BrokerListeners)
                )
                $fresh = Get-VerifiedManagedBroker `
                    -ProcessId ([int]$Broker.ProcessId)
                $freshCreation = Get-ProcessCreationIdentity `
                    -CreationDate $fresh.CreationDate
                if ($listeners.Count -ne 1 -or
                    $listeners[0].LocalAddress -cne '127.0.0.1' -or
                    [int]$listeners[0].OwningProcess -ne [int]$Broker.ProcessId -or
                    [long]$freshCreation.CreationDateUtcTicks -ne
                        [long]$creation.CreationDateUtcTicks -or
                    [string]$fresh.ExecutablePath -cne
                        [string]$verified.ExecutablePath -or
                    [string]$fresh.CommandLine -cne [string]$verified.CommandLine) {
                    throw 'Broker ownership changed during exact managed recovery.'
                }
                $null = Stop-ProcessIdentityHandle `
                    -IdentityHandle $identityHandle
            } finally {
                $identityHandle.Process.Dispose()
            }
        }
    }
    $upstream = Get-VerifiedManagedUpstream
    if ($null -ne $upstream) {
        $creation = Get-ProcessCreationIdentity `
            -CreationDate $upstream.CreationDate
        $identityHandle = Open-ProcessIdentityHandle `
            -ProcessId ([int]$upstream.ProcessId) `
            -ExpectedCreationDateUtcTicks $creation.CreationDateUtcTicks
        try {
            $fresh = Get-VerifiedManagedUpstream
            if ($null -eq $fresh) {
                return
            }
            $freshCreation = Get-ProcessCreationIdentity `
                -CreationDate $fresh.CreationDate
            if ([int]$fresh.ProcessId -ne [int]$upstream.ProcessId -or
                [long]$freshCreation.CreationDateUtcTicks -ne
                    [long]$creation.CreationDateUtcTicks -or
                [string]$fresh.ExecutablePath -cne
                    [string]$upstream.ExecutablePath -or
                [string]$fresh.CommandLine -cne [string]$upstream.CommandLine) {
                throw 'Managed upstream ownership changed during exact recovery.'
            }
            $null = Stop-ProcessIdentityHandle -IdentityHandle $identityHandle
        } finally {
            $identityHandle.Process.Dispose()
        }
    }
}

$listeners = @(Get-BrokerListeners)
$nonLoopback = @(
    $listeners |
        Where-Object {
            -not (Test-IsLoopbackListenerAddress -Address $_.LocalAddress)
        }
)
if ($nonLoopback.Count -gt 0) {
    throw "TCP port $BrokerPort has a non-loopback listener; refusing to start the app-server broker."
}
$managedBrokerListeners = @(Get-ManagedIpv4Listeners -Listeners $listeners)
$listenerPids = @(
    $managedBrokerListeners |
        Select-Object -ExpandProperty OwningProcess -Unique
)
if ($listenerPids.Count -gt 1) {
    throw "TCP port $BrokerPort has multiple owners; refusing an ambiguous app-server broker."
}

$brokerProcess = $null
$startedBroker = $false
$desktopRuntimeHealthStatus = 'current'
$desktopRuntimeHealthMessage = ''
if ($listenerPids.Count -eq 1) {
    if ($null -eq $runtimeDiscovery -or
        [string]::IsNullOrWhiteSpace($resolvedCodex)) {
        throw "TCP port $BrokerPort is occupied but no stable active runtime receipt is available; refusing to guess its Codex generation or start a second app-server."
    }
    $previousBrokerAdoption = Get-PreviousBrokerAdoptionBinding `
        -CurrentRuntime $startupSelectedRuntime `
        -ActiveBrokerReceipt $activeBrokerRuntimeReceipt `
        -BrokerListenerProcessId ([int]$listenerPids[0])
    if ([bool]$previousBrokerAdoption.AdoptedFromPrevious) {
        $brokerCli = [System.IO.Path]::GetFullPath(
            [string]$previousBrokerAdoption.BrokerCliPath
        )
        $activeBrokerRuntimeIdentity =
            $previousBrokerAdoption.ActiveBrokerRuntime
        $brokerRuntimeAdoptedFromPrevious = $true
    }
    $brokerProcess = Get-VerifiedManagedBroker -ProcessId ([int]$listenerPids[0])
    $brokerRuntimeSnapshot = Get-VerifiedBrokerRuntimeSnapshot `
        -ExpectedBrokerProcessId ([int]$listenerPids[0])
    if ($null -eq $brokerRuntimeSnapshot) {
        throw 'The existing managed Broker could not prove runtime readiness. It was preserved because stopping it could interrupt Codex Desktop.'
    } elseif ([bool]$brokerRuntimeSnapshot.Readiness.desktopConnected -ne $true) {
        $desktopRuntimeHealthStatus = 'blocked'
        $desktopRuntimeHealthMessage = 'The managed Broker is healthy, but Codex Desktop is not connected. Existing processes were preserved and new remote execution remains disabled.'
    } else {
        try {
            $currentDesktopRuntime = Resolve-NewCodexDesktopRuntime
            $runtimeIdentityCurrent = Test-DesktopRuntimeIdentityCurrent `
                -ActiveRuntime $runtimeDiscovery `
                -CurrentRuntime $currentDesktopRuntime
            $legacyRuntimeCanBePromoted = (
                [string]$runtimeDiscovery.Source -ceq
                    'legacy-active-receipt' -and
                (Test-ActiveCodexRuntimeMatchesCurrentDiscovery `
                    -ActiveRuntime $runtimeDiscovery `
                    -CurrentRuntime $currentDesktopRuntime)
            )
            if ($runtimeIdentityCurrent -or $legacyRuntimeCanBePromoted) {
                $runtimeDiscovery = $currentDesktopRuntime
                $resolvedCodex = [System.IO.Path]::GetFullPath(
                    [string]$runtimeDiscovery.CodexPath
                )
            } else {
                $desktopRuntimeHealthStatus = 'update-pending'
                $desktopRuntimeHealthMessage = 'Codex Desktop package generation or runtime hash changed while the managed Broker remained active. The live stack was left running; restart it manually after active work is complete.'
            }
        } catch {
            $desktopRuntimeHealthStatus = 'blocked'
            $desktopRuntimeHealthMessage = "Current Codex Desktop runtime could not be verified while the managed Broker remained active: $($_.Exception.Message)"
        }
    }
}

if ($null -eq $brokerProcess) {
    if ((Get-BrokerListeners).Count -gt 0) {
        throw "TCP port $BrokerPort remained occupied after exact managed recovery; refusing to start another broker."
    }
    $runtimeDiscovery = Resolve-NewCodexDesktopRuntime
    $resolvedCodex = [System.IO.Path]::GetFullPath(
        [string]$runtimeDiscovery.CodexPath
    )
    if (-not (Test-Path -LiteralPath $resolvedCodex -PathType Leaf)) {
        throw "The dynamically selected Codex Desktop runtime is missing at '$resolvedCodex'."
    }
    $startupStage = 'runtime-discovered'
    Write-StartupStatus -Status 'starting'
    if ($env:CODEX_REMOTE_TEST_FIXTURE -cne '1') {
        $freshRuntime = Resolve-CodexDesktopRuntime `
            -RuntimeCachePath (
                Join-Path $resolvedDataDir 'desktop-runtime-cache.json'
            )
        if ([string]$freshRuntime.PackageFullName -cne
                [string]$runtimeDiscovery.PackageFullName -or
            -not [string]::Equals(
                [string]$freshRuntime.CodexPath,
                $resolvedCodex,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -or
            [string]$freshRuntime.CodexSha256 -cne
                [string]$runtimeDiscovery.CodexSha256) {
            throw 'Codex Desktop updated or changed during startup. Remote startup is disabled for this attempt; retry after Desktop/package state converges.'
        }
    }
    $brokerArguments = @(
        (ConvertTo-WindowsCommandLineArgument -Value $brokerCli)
        'serve'
        '--host'
        '127.0.0.1'
        '--port'
        $BrokerPort.ToString([System.Globalization.CultureInfo]::InvariantCulture)
        '--upstream-port'
        $BrokerUpstreamPort.ToString([System.Globalization.CultureInfo]::InvariantCulture)
        '--codex-path'
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedCodex)
        '--data-dir'
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedDataDir)
        '--capability-token-file'
        (ConvertTo-WindowsCommandLineArgument -Value $capabilityTokenPath)
    ) -join ' '
    $startupStage = 'broker-start'
    Write-StartupStatus -Status 'starting'
    $brokerProcess = Start-Process `
        -FilePath $resolvedNode `
        -ArgumentList $brokerArguments `
        -WindowStyle Hidden `
        -PassThru
    $startedBroker = $true

    try {
        $deadline = [DateTime]::UtcNow.AddSeconds($BrokerStartupTimeoutSeconds)
        $brokerHealthReady = $false
        $matching = @()
        do {
            if ($brokerProcess.HasExited) {
                throw "Codex app-server broker exited with code $($brokerProcess.ExitCode) before it opened the loopback listener."
            }
            $listeners = @(Get-BrokerListeners)
            $matching = @(
                $listeners |
                    Where-Object {
                        $_.LocalAddress -ceq '127.0.0.1' -and
                        $_.OwningProcess -eq $brokerProcess.Id
                    }
            )
            if ($matching.Count -gt 0) {
                try {
                    $brokerHealthReady = Test-BrokerInfrastructureReady `
                        -ExpectedBrokerProcessId $brokerProcess.Id
                } catch {
                    $brokerHealthReady = $false
                }
            }
            if ($matching.Count -gt 0 -and $brokerHealthReady) {
                break
            }
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $deadline)

        if ($matching.Count -eq 0 -or -not $brokerHealthReady) {
            throw "Shared broker did not become healthy on the managed loopback endpoint within $BrokerStartupTimeoutSeconds seconds."
        }
        $null = Get-VerifiedManagedBroker -ProcessId $brokerProcess.Id
    } catch {
        if (-not $brokerProcess.HasExited) {
            Stop-ExactManagedBrokerAndOrphan -Broker ([pscustomobject]@{
                ProcessId = $brokerProcess.Id
            })
        }
        throw
    }
}

$brokerPid = if ($null -ne $brokerProcess.PSObject.Properties['ProcessId']) {
    [int]$brokerProcess.ProcessId
} else {
    [int]$brokerProcess.Id
}
$startupStage = 'broker-ready'
Write-StartupStatus -Status 'starting'
$brokerCimProcess = Get-VerifiedManagedBroker -ProcessId $brokerPid
$brokerRuntimeSnapshot = Get-VerifiedBrokerRuntimeSnapshot `
    -ExpectedBrokerProcessId $brokerPid
if ($null -eq $brokerRuntimeSnapshot) {
    throw 'Broker runtime generation could not be bound to the exact managed Broker and app-server processes.'
}
$runtimeInvocationId = [string]$brokerRuntimeSnapshot.RuntimeInvocationId
$brokerCreationIdentity = Get-ProcessCreationIdentity `
    -CreationDate $brokerCimProcess.CreationDate
$brokerIdentityHandle = Open-ProcessIdentityHandle `
    -ProcessId $brokerPid `
    -ExpectedCreationDateUtcTicks $brokerCreationIdentity.CreationDateUtcTicks
$brokerReceipt = New-RuntimeProcessReceipt `
    -CimProcess $brokerCimProcess `
    -StartTimeUtcTicks $brokerIdentityHandle.StartTimeUtcTicks `
    -RuntimeInvocationId $runtimeInvocationId
$bootstrapReceipt = New-RuntimeProcessReceipt `
    -CimProcess $bootstrapProcess `
    -StartTimeUtcTicks $bootstrapIdentityHandle.StartTimeUtcTicks `
    -RuntimeInvocationId $runtimeInvocationId
$initialUpstream = $brokerRuntimeSnapshot.Upstream
$initialUpstreamReceipt = $null
if ($null -ne $initialUpstream) {
    $upstreamCreationIdentity = Get-ProcessCreationIdentity `
        -CreationDate $initialUpstream.CreationDate
    $upstreamIdentityHandle = Open-ProcessIdentityHandle `
        -ProcessId ([int]$initialUpstream.ProcessId) `
        -ExpectedCreationDateUtcTicks $upstreamCreationIdentity.CreationDateUtcTicks
    try {
        $initialUpstreamReceipt = New-RuntimeProcessReceipt `
            -CimProcess $initialUpstream `
            -StartTimeUtcTicks $upstreamIdentityHandle.StartTimeUtcTicks `
            -RuntimeInvocationId $runtimeInvocationId
    } finally {
        $upstreamIdentityHandle.Process.Dispose()
    }
}
if (-not $brokerRuntimeAdoptedFromPrevious) {
    Write-BrokerRuntimeReceipt `
        -Status 'broker-ready' `
        -BrokerReceipt $brokerReceipt `
        -SidecarReceipt $null `
        -UpstreamReceipt $initialUpstreamReceipt
}

$startupStage = 'sidecar-start'
Write-StartupStatus -Status 'starting'

function Get-VerifiedSidecarRuntimeBinding {
    param(
        [Parameter(Mandatory)]
        [object]$Runtime
    )

    $runtimeCheck = Test-CodexLocalRemoteRuntimeVersion `
        -RuntimeRoot ([string]$Runtime.CurrentRoot) `
        -ExpectedVersionId ([string]$Runtime.CurrentVersionId)
    if (-not $runtimeCheck.IsValid) {
        throw "Selected Sidecar runtime is invalid: $($runtimeCheck.Reason)"
    }
    $runtimeRoot =
        [System.IO.Path]::GetFullPath([string]$Runtime.CurrentRoot)
    $runtimeSidecarCli = [System.IO.Path]::GetFullPath(
        (Join-Path $runtimeRoot 'apps\sidecar\dist\cli.js')
    )
    $runtimePrefix =
        [System.IO.Path]::TrimEndingDirectorySeparator($runtimeRoot) + '\'
    if (-not $runtimeSidecarCli.StartsWith(
        $runtimePrefix,
        [System.StringComparison]::OrdinalIgnoreCase
    ) -or
        -not (Test-Path -LiteralPath $runtimeSidecarCli -PathType Leaf)) {
        throw 'Selected Sidecar entry escaped or is missing from its runtime.'
    }
    $sidecarItem =
        Get-Item -LiteralPath $runtimeSidecarCli -Force -ErrorAction Stop
    if ($sidecarItem.PSIsContainer -or
        ($sidecarItem.Attributes -band
            [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Selected Sidecar entry is not one ordinary file.'
    }
    return [pscustomobject]@{
        VersionId = [string]$Runtime.CurrentVersionId
        RuntimeRoot = $runtimeRoot
        ManifestSha256 = [string]$Runtime.CurrentManifestSha256
        SidecarCli = $runtimeSidecarCli
        BrokerSidecarCompatibilityId =
            [string]$runtimeCheck.BrokerSidecarCompatibilityId
    }
}

function Get-ManagedSidecarArguments {
    param(
        [Parameter(Mandatory)]
        [object]$RuntimeBinding
    )

    return @(
        (ConvertTo-WindowsCommandLineArgument `
            -Value ([string]$RuntimeBinding.SidecarCli))
        'serve'
        '--host'
        '127.0.0.1'
        '--port'
        $SidecarPort.ToString(
            [System.Globalization.CultureInfo]::InvariantCulture
        )
        '--base-path'
        (ConvertTo-WindowsCommandLineArgument -Value $BasePath)
        '--codex-path'
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedCodex)
        '--data-dir'
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedDataDir)
    ) -join ' '
}

function Start-ManagedSidecarChild {
    param(
        [Parameter(Mandatory)]
        [object]$RuntimeBinding
    )

    $process = $null
    try {
        # The capability endpoint is scoped to this Sidecar child process.
        # Desktop receives its own process-scoped endpoint only through the
        # fail-open launcher after the managed Broker has passed
        # infrastructure readiness.
        try {
            $env:CODEX_APP_SERVER_WS_URL = $webSocketUrl
            $sidecarArguments =
                Get-ManagedSidecarArguments `
                    -RuntimeBinding $RuntimeBinding
            $process = Start-Process `
                -FilePath $resolvedNode `
                -ArgumentList $sidecarArguments `
                -WorkingDirectory ([string]$RuntimeBinding.RuntimeRoot) `
                -WindowStyle Hidden `
                -PassThru
        } finally {
            Remove-Item Env:\CODEX_APP_SERVER_WS_URL `
                -ErrorAction SilentlyContinue
        }
        $cimProcess = Get-CimInstance `
            Win32_Process `
            -Filter "ProcessId = $($process.Id)" `
            -ErrorAction Stop
        $creationIdentity = Get-ProcessCreationIdentity `
            -CreationDate $cimProcess.CreationDate
        $startTimeUtcTicks = $process.StartTime.ToUniversalTime().Ticks
        if ([Math]::Abs(
            [long]$creationIdentity.CreationDateUtcTicks -
                $startTimeUtcTicks
        ) -gt [TimeSpan]::FromSeconds(2).Ticks) {
            throw "Sidecar PID $($process.Id) CreationDate does not match its held process handle."
        }
        $identityHandle = [pscustomobject]@{
            Process = $process
            ProcessId = $process.Id
            StartTimeUtcTicks = $startTimeUtcTicks
        }
        $receipt = New-RuntimeProcessReceipt `
            -CimProcess $cimProcess `
            -StartTimeUtcTicks $startTimeUtcTicks `
            -RuntimeInvocationId $runtimeInvocationId
        return [pscustomobject]@{
            Process = $process
            IdentityHandle = $identityHandle
            Receipt = $receipt
            RuntimeBinding = $RuntimeBinding
        }
    } catch {
        if ($null -ne $process) {
            try {
                $process.Refresh()
                if (-not $process.HasExited) {
                    $process.Kill($true)
                    $null = $process.WaitForExit(5000)
                }
            } catch {
                # The process object is the exact child created above. A failed
                # cleanup is reported by the original startup exception and the
                # next bounded ownership probe.
            }
            $process.Dispose()
        }
        throw
    }
}

function New-VerifiedUpstreamReceipt {
    param(
        [Parameter(Mandatory)][object]$UpstreamProcess
    )
    $creationIdentity = Get-ProcessCreationIdentity `
        -CreationDate $UpstreamProcess.CreationDate
    $identityHandle = Open-ProcessIdentityHandle `
        -ProcessId ([int]$UpstreamProcess.ProcessId) `
        -ExpectedCreationDateUtcTicks $creationIdentity.CreationDateUtcTicks
    try {
        return New-RuntimeProcessReceipt `
            -CimProcess $UpstreamProcess `
            -StartTimeUtcTicks $identityHandle.StartTimeUtcTicks `
            -RuntimeInvocationId $runtimeInvocationId
    } finally {
        $identityHandle.Process.Dispose()
    }
}

function Get-SidecarOnlyUpdateInvariant {
    param(
        [Parameter(Mandatory)]
        [object]$TargetRuntimeBinding
    )

    $selectedRuntime =
        Get-CodexLocalRemoteCurrentRuntime -DataDir $resolvedDataDir
    if ($null -eq $selectedRuntime -or
        [string]$selectedRuntime.CurrentVersionId -cne
            [string]$TargetRuntimeBinding.VersionId -or
        -not [string]::Equals(
            [string]$selectedRuntime.CurrentRoot,
            [string]$TargetRuntimeBinding.RuntimeRoot,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'Selected runtime drifted during the Sidecar-only update.'
    }
    $runtimeCheck = Test-CodexLocalRemoteRuntimeVersion `
        -RuntimeRoot ([string]$TargetRuntimeBinding.RuntimeRoot) `
        -ExpectedVersionId ([string]$TargetRuntimeBinding.VersionId)
    if (-not $runtimeCheck.IsValid) {
        throw "Selected Sidecar runtime changed: $($runtimeCheck.Reason)"
    }
    $snapshot = Get-VerifiedBrokerRuntimeSnapshot `
        -ExpectedBrokerProcessId $brokerPid
    if ($null -eq $snapshot -or
        $null -eq $snapshot.Upstream -or
        [string]$snapshot.RuntimeInvocationId -cne
            $runtimeInvocationId) {
        throw 'Broker/upstream identity is not exact for a Sidecar-only update.'
    }
    $upstreamCreationIdentity = Get-ProcessCreationIdentity `
        -CreationDate $snapshot.Upstream.CreationDate
    $upstreamIdentityHandle = Open-ProcessIdentityHandle `
        -ProcessId ([int]$snapshot.Upstream.ProcessId) `
        -ExpectedCreationDateUtcTicks (
            [long]$upstreamCreationIdentity.CreationDateUtcTicks
        )
    try {
        $desktopRootIdentityKey =
            Get-UniqueCodexDesktopRootIdentityKey `
                -Processes @(Get-RunningCodexDesktopRootProcesses)
        return [pscustomobject]@{
            SelectedVersionId =
                [string]$TargetRuntimeBinding.VersionId
            SelectedRoot =
                [string]$TargetRuntimeBinding.RuntimeRoot
            BrokerProcessId = [int]$brokerPid
            BrokerStartTimeUtcTicks =
                [long]$brokerIdentityHandle.StartTimeUtcTicks
            RuntimeInvocationId = $runtimeInvocationId
            UpstreamProcessId = [int]$snapshot.Upstream.ProcessId
            UpstreamStartTimeUtcTicks =
                [long]$upstreamIdentityHandle.StartTimeUtcTicks
            DesktopRootIdentityKey =
                [string]$desktopRootIdentityKey
            BrokerSidecarCompatibilityId =
                $brokerSidecarCompatibilityId
            CandidateSidecarCompatibilityId =
                [string](
                    $TargetRuntimeBinding.BrokerSidecarCompatibilityId
                )
            UnsafeThreadCount =
                [int]$snapshot.Readiness.unsafeThreadCount
            UnknownCount =
                [int]$snapshot.Readiness.unknownCount
            DesktopConnected =
                [bool]$snapshot.Readiness.desktopConnected
        }
    } finally {
        $upstreamIdentityHandle.Process.Dispose()
    }
}

function Stop-ManagedSidecarChildExact {
    param(
        [Parameter(Mandatory)]
        [object]$SidecarChild
    )

    $null = Stop-ProcessIdentityHandle `
        -IdentityHandle $SidecarChild.IdentityHandle `
        -TimeoutMilliseconds 10000
}

$startupSidecarRuntime =
    Get-CodexLocalRemoteCurrentRuntime -DataDir $resolvedDataDir
if ($null -eq $startupSidecarRuntime -or
    -not [string]::Equals(
        [string]$startupSidecarRuntime.CurrentRoot,
        $resolvedRoot,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw 'Startup Sidecar runtime is not the exact selected generation.'
}
$activeSidecarRuntimeBinding =
    Get-VerifiedSidecarRuntimeBinding `
        -Runtime $startupSidecarRuntime
$sidecarChild = Start-ManagedSidecarChild `
    -RuntimeBinding $activeSidecarRuntimeBinding
$sidecarProcess = $sidecarChild.Process
$sidecarIdentityHandle = $sidecarChild.IdentityHandle
$sidecarReceipt = $sidecarChild.Receipt

try {
    $startupStage = 'sidecar-handshake'
    Write-StartupStatus -Status 'starting'
    $readyUpstream = Wait-ForSidecarHandshake `
        -SidecarProcess $sidecarProcess `
        -BrokerIdentityHandle $brokerIdentityHandle `
        -TimeoutSeconds $SidecarHandshakeTimeoutSeconds
    $readyUpstreamReceipt = New-VerifiedUpstreamReceipt `
        -UpstreamProcess $readyUpstream
    Write-BrokerRuntimeReceipt `
        -Status 'ready' `
        -BrokerReceipt $brokerReceipt `
        -SidecarReceipt $sidecarReceipt `
        -UpstreamReceipt $readyUpstreamReceipt `
        -SidecarRuntimeBinding $activeSidecarRuntimeBinding

    $initialDesktopLaunch = $null
    $desktopOwnerState = [pscustomobject]@{
        StartupIntentPending = [bool]$DesktopOwnerCoordinator
        LastAttemptedRootIdentityKey = $null
        LastVerifiedConnectedRootIdentityKey = $null
        LastDisconnectedRecoveryRootIdentityKey = $null
        PendingPackageRefreshRootIdentityKey = $null
        PendingFinalRootCapture = $false
        FinalRootCaptureDeadlineUtc = [DateTime]::MinValue
        LastSuppressedRootIdentityKey = $null
    }
    $desktopOwnerRuntime = Get-CodexLocalRemoteCurrentRuntime `
        -DataDir $resolvedDataDir
    if ($DesktopOwnerCoordinator) {
        $desktopOwnerState.StartupIntentPending = $false
        if ($null -ne $desktopHandoffPreparation -and
            [string]$desktopHandoffPreparation.Phase -cnotin @(
                'requested',
                'ready'
            )) {
            throw (
                'The live Desktop handoff preparation has an unsupported ' +
                'startup phase.'
            )
        }
        if ($desktopHandoffPreparationPathPresent -and
            $null -eq $desktopHandoffPreparation) {
            $initialDesktopLaunch = [pscustomobject]@{
                Status = 'handoff-preparation-blocked'
            }
            $startupStage = 'handoff-preparation-blocked'
            Write-StartupStatus `
                -Status 'degraded' `
                -Message (
                    'A Desktop handoff preparation exists but could not be ' +
                    'validated. Automatic Desktop launch remains suppressed.'
                )
        } elseif ($null -ne $desktopHandoffPreparation) {
            $initialDesktopLaunch = [pscustomobject]@{
                Status = 'handoff-preparing'
                PreparationId =
                    [string]$desktopHandoffPreparation.PreparationId
            }
            $desktopOwnerState.LastAttemptedRootIdentityKey =
                [string]$desktopHandoffPreparation.DesktopRootIdentityKey
            $startupStage = 'handoff-preparing'
            Write-StartupStatus `
                -Status 'degraded' `
                -Message (
                    'Broker and Sidecar are ready for the exact prepared ' +
                    'native Desktop owner. Desktop launch remains suppressed.'
                )
        } else {
            try {
                $initialDesktopLaunch = Invoke-WithCodexDesktopOwnerMutex `
                    -DataDir $resolvedDataDir `
                    -Action {
                        $suppressedRootIdentityKey =
                            Get-CodexDesktopFallbackSuppressionRootIdentityKey
                        if (-not [string]::IsNullOrWhiteSpace(
                            $suppressedRootIdentityKey
                        )) {
                            return [pscustomobject]@{
                                Status = 'already-running'
                                SuppressedRootIdentityKey =
                                    $suppressedRootIdentityKey
                            }
                        }
                        Invoke-ManagedDesktopLaunch `
                            -ExpectedSelectedRuntimeVersionId (
                                [string]$desktopOwnerRuntime.CurrentVersionId
                            ) `
                            -ExpectedSelectedRuntimeRoot (
                                [string]$desktopOwnerRuntime.CurrentRoot
                            )
                    }
                $suppressedRootProperty =
                    $initialDesktopLaunch.PSObject.Properties[
                        'SuppressedRootIdentityKey'
                    ]
                if ($null -ne $suppressedRootProperty) {
                    $desktopOwnerState.LastAttemptedRootIdentityKey =
                        [string]$suppressedRootProperty.Value
                } else {
                    $desktopOwnerState.LastAttemptedRootIdentityKey =
                        Get-UniqueCodexDesktopRootIdentityKey `
                            -Processes @(
                                Get-RunningCodexDesktopRootProcesses
                            )
                }
            } catch {
                $startupStage = 'desktop-owner-startup-degraded'
                Write-StartupStatus `
                    -Status 'degraded' `
                    -Message "The single Desktop owner preserved native availability after startup launch failed: $($_.Exception.Message)"
            }
        }
        if ($null -eq $initialDesktopLaunch -or
            [string]$initialDesktopLaunch.Status -cnotin @(
                'launched-remote',
                'already-running',
                'remote-launch-unverified',
                'handoff-preparing',
                'handoff-preparation-blocked'
            )) {
            $startupStage = 'desktop-launch-fallback'
            Write-StartupStatus `
                -Status 'degraded' `
                -Message 'Codex Desktop could not be verified on the shared Broker. The fail-open launcher preserved native Desktop availability while remote execution remains disabled.'
        }
    }

    $initialRequestReady = Test-SidecarRequestReady
    if ($desktopRuntimeHealthStatus -ceq 'current' -and $initialRequestReady) {
        $startupStage = 'supervising'
        Write-StartupStatus -Status 'ready'
    } else {
        $startupStage = if (-not $initialRequestReady) {
            'waiting-desktop'
        } elseif ($desktopRuntimeHealthStatus -ceq 'update-pending') {
            'update-pending'
        } else {
            'runtime-check-blocked'
        }
        $initialStartupMessage = if (-not $initialRequestReady) {
            'Broker and Sidecar transport are ready. Waiting for Codex Desktop before enabling remote execution.'
        } else {
            $desktopRuntimeHealthMessage
        }
        Write-StartupStatus `
            -Status 'degraded' `
            -Message $initialStartupMessage
    }
    $runtimeTransitionDeadline = $null
    $runtimeApplicationDegraded = $false
    $desktopRuntimeCheckClock = [Diagnostics.Stopwatch]::StartNew()
    $nextDesktopRuntimeCheckElapsedMilliseconds =
        [long]$DesktopRuntimeCheckIntervalSeconds * 1000
    $nextDesktopLaunchRecoveryAt = [DateTime]::UtcNow.AddSeconds(1)
    $sidecarRecoveryAttempt = 0
    $nextSidecarRecoveryAt = [DateTime]::MinValue
    $nextSidecarRuntimeUpdateCheckAt =
        [DateTime]::UtcNow.AddSeconds(2)
    $sidecarRuntimeUpdateAttempt = 0
    $nativeModeStatusWritten = $false
    $lastDesktopOwnerSupervisorObservationUtc = [DateTimeOffset]::UtcNow
    $desktopOwnerResumeSuppressedAtUtc = $null
    while ($true) {
        $desktopOwnerSupervisorObservationUtc =
            [DateTimeOffset]::UtcNow
        if ($DesktopOwnerCoordinator -and
            (Test-CodexDesktopOwnerResumeGap `
                -PreviousObservationUtc (
                    $lastDesktopOwnerSupervisorObservationUtc
                ) `
                -CurrentObservationUtc (
                    $desktopOwnerSupervisorObservationUtc
                ) `
                -MinimumGapSeconds $DesktopOwnerResumeGapSeconds) -and
            $null -eq $desktopOwnerResumeSuppressedAtUtc) {
            $desktopOwnerResumeSuppressedAtUtc =
                $lastDesktopOwnerSupervisorObservationUtc
        }
        $lastDesktopOwnerSupervisorObservationUtc =
            $desktopOwnerSupervisorObservationUtc
        $desiredMode =
            Get-CodexLocalRemoteDesiredMode `
                -DataDir $resolvedDataDir
        if ([string]$desiredMode.Mode -ceq 'Native') {
            if ($null -ne $sidecarIdentityHandle) {
                try {
                    Stop-ManagedSidecarChildExact `
                        -SidecarChild ([pscustomobject]@{
                            Process = $sidecarProcess
                            IdentityHandle = $sidecarIdentityHandle
                            Receipt = $sidecarReceipt
                            RuntimeBinding =
                                $activeSidecarRuntimeBinding
                        })
                } finally {
                    $sidecarIdentityHandle.Process.Dispose()
                    $sidecarProcess = $null
                    $sidecarIdentityHandle = $null
                    $sidecarReceipt = $null
                }
                $nativeModeSnapshot =
                    Get-VerifiedBrokerRuntimeSnapshot `
                        -ExpectedBrokerProcessId $brokerPid
                $nativeModeUpstreamReceipt = if (
                    $null -eq $nativeModeSnapshot
                ) {
                    $null
                } else {
                    New-VerifiedUpstreamReceipt `
                        -UpstreamProcess (
                            $nativeModeSnapshot.Upstream
                        )
                }
                Write-BrokerRuntimeReceipt `
                    -Status 'broker-ready' `
                    -BrokerReceipt $brokerReceipt `
                    -SidecarReceipt $null `
                    -UpstreamReceipt $nativeModeUpstreamReceipt
            }
            $remainingDesktopRoots =
                @(Get-RunningCodexDesktopRootProcesses)
            if ($remainingDesktopRoots.Count -eq 0) {
                $startupStage = 'native-owner-exited'
                Write-StartupStatus `
                    -Status 'inactive' `
                    -Message (
                        'Remote stayed closed until Codex Desktop exited ' +
                        'naturally; the exact Broker is now stopping.'
                    )
                Stop-ExactManagedBrokerAndOrphan `
                    -Broker $brokerCimProcess
                exit 0
            }
            $startupStage = 'native-awaiting-desktop-exit'
            if (-not $nativeModeStatusWritten) {
                Write-StartupStatus `
                    -Status 'inactive' `
                    -Message (
                        'Public Remote is closed. The current Codex Desktop ' +
                        'and its Broker remain untouched until Desktop exits ' +
                        'naturally.'
                    )
                $nativeModeStatusWritten = $true
            }
            Start-Sleep -Seconds 1
            continue
        }
        $nativeModeStatusWritten = $false
        if ($DesktopOwnerCoordinator) {
            $leaseRuntime =
                Get-CodexLocalRemoteCurrentRuntime `
                    -DataDir $resolvedDataDir
            $leaseIntent = if ($null -eq $leaseRuntime) {
                $null
            } else {
                Read-CodexDesktopOwnerIntent `
                    -DataDir $resolvedDataDir `
                    -ExpectedRuntimeVersionId (
                        [string]$leaseRuntime.CurrentVersionId
                    ) `
                    -ExpectedRuntimeRoot (
                        [string]$leaseRuntime.CurrentRoot
                    )
            }
            $leaseHandoffPreparation =
                Get-DesktopHandoffPreparationForRuntime `
                    -Runtime $leaseRuntime
            $leaseHandoffActive = $false
            if ($null -ne $leaseHandoffPreparation -and
                [string]$leaseHandoffPreparation.Phase -cin @(
                    'requested',
                    'ready'
                )) {
                $liveLeaseHandoffPreparation =
                    Get-DesktopHandoffPreparationForRuntime `
                        -Runtime $leaseRuntime `
                        -RequireLiveOwnership
                $leaseHandoffActive = (
                    $null -ne $liveLeaseHandoffPreparation -and
                    [string]$liveLeaseHandoffPreparation.PreparationId -ceq
                        [string]$leaseHandoffPreparation.PreparationId
                )
            } elseif ($null -ne $leaseHandoffPreparation -and
                [string]$leaseHandoffPreparation.Phase -ceq 'attaching') {
                try {
                    $attachStartedAt = [DateTimeOffset]::Parse(
                        [string](
                            $leaseHandoffPreparation.AttachStartedAtUtc
                        ),
                        [Globalization.CultureInfo]::InvariantCulture,
                        [Globalization.DateTimeStyles]::RoundtripKind
                    )
                    $leaseHandoffActive = (
                        $attachStartedAt.Offset -eq [TimeSpan]::Zero -and
                        $attachStartedAt -ge
                            [DateTimeOffset]::UtcNow.AddSeconds(-60) -and
                        $attachStartedAt -le
                            [DateTimeOffset]::UtcNow.AddSeconds(5)
                    )
                } catch {
                    $leaseHandoffActive = $false
                }
            }
            $leaseSnapshot = try {
                Get-VerifiedBrokerRuntimeSnapshot `
                    -ExpectedBrokerProcessId $brokerPid
            } catch {
                $null
            }
            $leaseDesktopConnected = (
                $null -ne $leaseSnapshot -and
                [bool]$leaseSnapshot.Readiness.desktopConnected
            )
            if ($null -eq $leaseIntent -and
                -not $leaseDesktopConnected -and
                $null -ne $leaseRuntime -and
                -not $leaseHandoffActive) {
                $null = Set-CodexLocalRemoteDesiredMode `
                    -DataDir $resolvedDataDir `
                    -Mode Native `
                    -RuntimeVersionId (
                        [string]$leaseRuntime.CurrentVersionId
                    ) `
                    -RuntimeRoot (
                        [string]$leaseRuntime.CurrentRoot
                    )
                $startupStage = 'remote-lease-ended'
                Write-StartupStatus `
                    -Status 'inactive' `
                    -Message (
                        'The explicit Remote Desktop lease ended. ' +
                        'A later ordinary vendor launch remains native.'
                    )
                continue
            }
        }
        if ($null -eq $sidecarProcess -or $sidecarProcess.HasExited) {
            $exitSummary = if ($null -eq $sidecarProcess) {
                'the previous recovery attempt did not start a child'
            } else {
                "the Sidecar exited with code $($sidecarProcess.ExitCode)"
            }
            if ($null -ne $sidecarIdentityHandle) {
                $sidecarIdentityHandle.Process.Dispose()
            }
            $sidecarProcess = $null
            $sidecarIdentityHandle = $null
            $sidecarReceipt = $null

            if ([DateTime]::UtcNow -lt $nextSidecarRecoveryAt) {
                Start-Sleep -Seconds 1
                continue
            }

            $sidecarRecoveryAttempt++
            $startupStage = 'sidecar-recovery'
            Write-StartupStatus `
                -Status 'degraded' `
                -Message "Remote transport is recovering because $exitSummary. The verified Broker and Codex Desktop remain untouched."
            try {
                $sidecarChild = Start-ManagedSidecarChild `
                    -RuntimeBinding $activeSidecarRuntimeBinding
                $sidecarProcess = $sidecarChild.Process
                $sidecarIdentityHandle = $sidecarChild.IdentityHandle
                $sidecarReceipt = $sidecarChild.Receipt
                $recoveredUpstream = Wait-ForSidecarHandshake `
                    -SidecarProcess $sidecarProcess `
                    -BrokerIdentityHandle $brokerIdentityHandle `
                    -TimeoutSeconds $SidecarHandshakeTimeoutSeconds
                $recoveredUpstreamReceipt = New-VerifiedUpstreamReceipt `
                    -UpstreamProcess $recoveredUpstream
                Write-BrokerRuntimeReceipt `
                    -Status 'ready' `
                    -BrokerReceipt $brokerReceipt `
                    -SidecarReceipt $sidecarReceipt `
                    -UpstreamReceipt $recoveredUpstreamReceipt `
                    -SidecarRuntimeBinding $activeSidecarRuntimeBinding
                $sidecarRecoveryAttempt = 0
                $nextSidecarRecoveryAt = [DateTime]::MinValue
                $startupStage = 'supervising'
                Write-StartupStatus -Status 'ready'
            } catch {
                if ($null -ne $sidecarIdentityHandle) {
                    $null = Stop-ProcessIdentityHandle `
                        -IdentityHandle $sidecarIdentityHandle `
                        -ErrorAction SilentlyContinue
                    $sidecarIdentityHandle.Process.Dispose()
                }
                $sidecarProcess = $null
                $sidecarIdentityHandle = $null
                $sidecarReceipt = $null
                $retryDelaySeconds = [Math]::Min(
                    30,
                    [Math]::Pow(
                        2,
                        [Math]::Min($sidecarRecoveryAttempt, 4)
                    )
                )
                $nextSidecarRecoveryAt = [DateTime]::UtcNow.AddSeconds(
                    $retryDelaySeconds
                )
                Write-StartupStatus `
                    -Status 'degraded' `
                    -Message "Sidecar recovery attempt $sidecarRecoveryAttempt failed. The verified Broker and Codex Desktop remain untouched; retrying in $retryDelaySeconds seconds."
            }
            Start-Sleep -Seconds 1
            continue
        }
        $brokerIdentityHandle.Process.Refresh()
        $brokerAlive = -not $brokerIdentityHandle.Process.HasExited -and
            $brokerIdentityHandle.Process.StartTime.ToUniversalTime().Ticks -eq
                $brokerIdentityHandle.StartTimeUtcTicks
        if (-not $brokerAlive) {
            Write-StartupStatus `
                -Status 'failed' `
                -Message 'Shared Broker exited during runtime supervision.'
            $null = Stop-ProcessIdentityHandle `
                -IdentityHandle $sidecarIdentityHandle `
                -ErrorAction SilentlyContinue
            exit 1
        }
        if ([DateTime]::UtcNow -ge
            $nextSidecarRuntimeUpdateCheckAt) {
            $nextSidecarRuntimeUpdateCheckAt =
                [DateTime]::UtcNow.AddSeconds(2)
            try {
                $selectedSidecarRuntime =
                    Get-CodexLocalRemoteCurrentRuntime `
                        -DataDir $resolvedDataDir
                if ($null -eq $selectedSidecarRuntime) {
                    throw 'Selected immutable runtime is missing.'
                }
                if ([string]$selectedSidecarRuntime.CurrentVersionId -cne
                        [string]$activeSidecarRuntimeBinding.VersionId -or
                    -not [string]::Equals(
                        [string]$selectedSidecarRuntime.CurrentRoot,
                        [string]$activeSidecarRuntimeBinding.RuntimeRoot,
                        [System.StringComparison]::OrdinalIgnoreCase
                    )) {
                    $candidateSidecarRuntimeBinding =
                        Get-VerifiedSidecarRuntimeBinding `
                            -Runtime $selectedSidecarRuntime
                    $oldSidecarRuntimeBinding =
                        $activeSidecarRuntimeBinding
                    $oldSidecarChild = [pscustomobject]@{
                        Process = $sidecarProcess
                        IdentityHandle = $sidecarIdentityHandle
                        Receipt = $sidecarReceipt
                        RuntimeBinding = $oldSidecarRuntimeBinding
                    }
                    $sidecarUpdate =
                        Invoke-CodexLocalRemoteSidecarUpdateTransaction `
                            -CaptureInvariant {
                                Get-SidecarOnlyUpdateInvariant `
                                    -TargetRuntimeBinding (
                                        $candidateSidecarRuntimeBinding
                                    )
                            } `
                            -StopOldSidecar {
                                Stop-ManagedSidecarChildExact `
                                    -SidecarChild $oldSidecarChild
                            } `
                            -StartNewSidecar {
                                Start-ManagedSidecarChild `
                                    -RuntimeBinding (
                                        $candidateSidecarRuntimeBinding
                                    )
                            } `
                            -VerifyNewSidecar {
                                param($candidateChild)
                                Wait-ForSidecarHandshake `
                                    -SidecarProcess (
                                        $candidateChild.Process
                                    ) `
                                    -BrokerIdentityHandle (
                                        $brokerIdentityHandle
                                    ) `
                                    -TimeoutSeconds (
                                        $SidecarHandshakeTimeoutSeconds
                                    )
                            } `
                            -StopNewSidecar {
                                param($candidateChild)
                                Stop-ManagedSidecarChildExact `
                                    -SidecarChild $candidateChild
                                $candidateChild.IdentityHandle.Process.Dispose()
                            } `
                            -StartOldSidecar {
                                $oldSidecarChild.Process.Refresh()
                                if (-not
                                    $oldSidecarChild.Process.HasExited) {
                                    $oldSidecarChild
                                } else {
                                    Start-ManagedSidecarChild `
                                        -RuntimeBinding (
                                            $oldSidecarRuntimeBinding
                                        )
                                }
                            } `
                            -VerifyOldSidecar {
                                param($rollbackChild)
                                Wait-ForSidecarHandshake `
                                    -SidecarProcess (
                                        $rollbackChild.Process
                                    ) `
                                    -BrokerIdentityHandle (
                                        $brokerIdentityHandle
                                    ) `
                                    -TimeoutSeconds (
                                        $SidecarHandshakeTimeoutSeconds
                                    )
                            }
                    if ([int]$sidecarUpdate.Sidecar.IdentityHandle.ProcessId -ne
                        [int]$oldSidecarChild.IdentityHandle.ProcessId) {
                        $oldSidecarChild.IdentityHandle.Process.Dispose()
                    }
                    $sidecarProcess = $sidecarUpdate.Sidecar.Process
                    $sidecarIdentityHandle =
                        $sidecarUpdate.Sidecar.IdentityHandle
                    $sidecarReceipt = $sidecarUpdate.Sidecar.Receipt
                    $activeSidecarRuntimeBinding = if (
                        [string]$sidecarUpdate.Status -ceq 'updated'
                    ) {
                        $candidateSidecarRuntimeBinding
                    } else {
                        $oldSidecarRuntimeBinding
                    }
                    $updatedUpstreamReceipt =
                        New-VerifiedUpstreamReceipt `
                            -UpstreamProcess (
                                $sidecarUpdate.Verification
                            )
                    Write-BrokerRuntimeReceipt `
                        -Status 'ready' `
                        -BrokerReceipt $brokerReceipt `
                        -SidecarReceipt $sidecarReceipt `
                        -UpstreamReceipt $updatedUpstreamReceipt `
                        -SidecarRuntimeBinding $activeSidecarRuntimeBinding
                    if ([string]$sidecarUpdate.Status -ceq 'updated') {
                        $sidecarRuntimeUpdateAttempt = 0
                        $desktopOwnerRuntime =
                            $selectedSidecarRuntime
                        $startupStage = 'sidecar-runtime-updated'
                        Write-StartupStatus `
                            -Status 'ready' `
                            -Message (
                                'The selected immutable Sidecar runtime ' +
                                'was adopted without restarting Broker, ' +
                                'upstream, or Codex Desktop.'
                            )
                    } else {
                        $sidecarRuntimeUpdateAttempt++
                        $nextSidecarRuntimeUpdateCheckAt =
                            [DateTime]::UtcNow.AddSeconds(
                                [Math]::Min(
                                    30,
                                    [Math]::Pow(
                                        2,
                                        [Math]::Min(
                                            $sidecarRuntimeUpdateAttempt,
                                            4
                                        )
                                    )
                                )
                            )
                        $startupStage = 'sidecar-runtime-rollback'
                        Write-StartupStatus `
                            -Status 'degraded' `
                            -Message (
                                'The selected Sidecar update failed and ' +
                                'the exact prior Sidecar was restored; ' +
                                'Broker and Codex Desktop were untouched.'
                            )
                    }
                }
            } catch {
                $sidecarRuntimeUpdateAttempt++
                $nextSidecarRuntimeUpdateCheckAt =
                    [DateTime]::UtcNow.AddSeconds(
                        [Math]::Min(
                            30,
                            [Math]::Pow(
                                2,
                                [Math]::Min(
                                    $sidecarRuntimeUpdateAttempt,
                                    4
                                )
                            )
                        )
                    )
                Write-StartupStatus `
                    -Status 'degraded' `
                    -Message (
                        'Sidecar-only update was deferred or rolled back: ' +
                        "$($_.Exception.Message) Broker and Codex Desktop " +
                        'were not restarted.'
                    )
            }
        }
        if ($DesktopOwnerCoordinator -and
            [DateTime]::UtcNow -ge $nextDesktopLaunchRecoveryAt) {
            $desktopRecoverySnapshot = try {
                Get-VerifiedBrokerRuntimeSnapshot `
                    -ExpectedBrokerProcessId $brokerPid
            } catch {
                $null
            }
            $desktopRootProcesses = @(
                Get-RunningCodexDesktopRootProcesses
            )
            $desktopRootIdentityKey =
                Get-UniqueCodexDesktopRootIdentityKey `
                    -Processes $desktopRootProcesses
            $desktopOwnerProof =
                Read-CodexDesktopOwnerConnectionProof `
                    -DataDir $resolvedDataDir
            $desktopConnected = (
                $null -ne $desktopRecoverySnapshot -and
                (Test-CodexDesktopOwnerConnectionProof `
                    -Readiness $desktopRecoverySnapshot.Readiness `
                    -Proof $desktopOwnerProof `
                    -ExpectedRuntimeInvocationId $runtimeInvocationId `
                    -RootIdentityKey $desktopRootIdentityKey)
            )
            if ($desktopOwnerState.PendingFinalRootCapture -and
                -not [string]::IsNullOrWhiteSpace(
                    $desktopRootIdentityKey
                )) {
                $desktopOwnerState.LastAttemptedRootIdentityKey =
                    $desktopRootIdentityKey
                $desktopOwnerState.LastDisconnectedRecoveryRootIdentityKey =
                    $desktopRootIdentityKey
                $desktopOwnerState.PendingFinalRootCapture = $false
            } elseif ($desktopOwnerState.PendingFinalRootCapture -and
                [DateTime]::UtcNow -ge
                    $desktopOwnerState.FinalRootCaptureDeadlineUtc) {
                $desktopOwnerState.PendingFinalRootCapture = $false
            }
            $desktopRecoveryLaunchAttempted = $false
            try {
                Invoke-WithCodexDesktopOwnerMutex `
                    -DataDir $resolvedDataDir `
                    -TimeoutSeconds 5 `
                    -Action {
                        $suppressedRootIdentityKey =
                            Get-CodexDesktopFallbackSuppressionRootIdentityKey
                        $activeRefreshRootIdentityKey =
                            Get-CodexPackageRefreshWorkerRootIdentityKey
                        $desktopOwnerState =
                            Update-CodexDesktopOwnerPackageRefreshState `
                                -State $desktopOwnerState `
                                -CurrentRootIdentityKey (
                                    [string]$desktopRootIdentityKey
                                ) `
                                -SuppressedRootIdentityKey (
                                    [string]$suppressedRootIdentityKey
                                ) `
                                -ActiveRefreshRootIdentityKey (
                                    [string]$activeRefreshRootIdentityKey
                                )
                        $pendingIntent = Read-CodexDesktopOwnerIntent `
                            -DataDir $resolvedDataDir `
                            -ExpectedRuntimeVersionId (
                                [string]$desktopOwnerRuntime.CurrentVersionId
                            ) `
                            -ExpectedRuntimeRoot (
                                [string]$desktopOwnerRuntime.CurrentRoot
                            )
                        if ($null -ne $pendingIntent -and
                            [string]$pendingIntent.Freshness -cne 'fresh') {
                            $intentFreshness = [string]$pendingIntent.Freshness
                            Complete-CodexDesktopOwnerIntent `
                                -DataDir $resolvedDataDir `
                                -Intent $pendingIntent `
                                -RuntimeInvocationId $runtimeInvocationId `
                                -Outcome $intentFreshness
                            $pendingIntent = $null
                        }
                        if ($null -ne $pendingIntent -and
                            $null -ne $desktopOwnerResumeSuppressedAtUtc) {
                            $intentRequestedAt =
                                [DateTimeOffset]::Parse(
                                    [string]$pendingIntent.RequestedAtUtc,
                                    [Globalization.CultureInfo]::InvariantCulture,
                                    [Globalization.DateTimeStyles]::RoundtripKind
                                )
                            if ($intentRequestedAt -le
                                $desktopOwnerResumeSuppressedAtUtc) {
                                Complete-CodexDesktopOwnerIntent `
                                    -DataDir $resolvedDataDir `
                                    -Intent $pendingIntent `
                                    -RuntimeInvocationId $runtimeInvocationId `
                                    -Outcome 'resume-suppressed'
                                $pendingIntent = $null
                            } else {
                                $desktopOwnerResumeSuppressedAtUtc = $null
                            }
                        }
                        if ($desktopConnected) {
                            $desktopOwnerState.LastVerifiedConnectedRootIdentityKey =
                                $desktopRootIdentityKey
                            $desktopOwnerState.LastDisconnectedRecoveryRootIdentityKey =
                                $null
                        }
                        $automaticRuntimeGenerationCurrent = $true
                        if ($null -eq $pendingIntent -and
                            -not [string]::IsNullOrWhiteSpace(
                                $desktopRootIdentityKey
                            )) {
                            $automaticRuntimeGenerationCurrent = try {
                                Test-DesktopRuntimeIdentityCurrent `
                                    -ActiveRuntime $runtimeDiscovery `
                                    -CurrentRuntime (
                                        Resolve-NewCodexDesktopRuntime
                                    )
                            } catch {
                                $false
                            }
                        }
                        $automaticTakeoverAllowed = (
                            $null -ne $pendingIntent -and
                            $null -eq $desktopOwnerResumeSuppressedAtUtc
                        )
                        $desktopOwnerDecision = Get-CodexDesktopOwnerDecision `
                            -DesktopConnected $desktopConnected `
                            -StartupIntentPending (
                                $desktopOwnerState.StartupIntentPending
                            ) `
                            -HasPendingIntent ($null -ne $pendingIntent) `
                            -RootIdentityKey $desktopRootIdentityKey `
                            -LastAttemptedRootIdentityKey (
                                $desktopOwnerState.LastAttemptedRootIdentityKey
                            ) `
                            -LastVerifiedConnectedRootIdentityKey (
                                $desktopOwnerState.LastVerifiedConnectedRootIdentityKey
                            ) `
                            -LastDisconnectedRecoveryRootIdentityKey (
                                $desktopOwnerState.LastDisconnectedRecoveryRootIdentityKey
                            ) `
                            -AutomaticTakeoverAllowed (
                                $automaticTakeoverAllowed
                            ) `
                            -RuntimeGenerationCurrent (
                                $automaticRuntimeGenerationCurrent
                            )
                        if ($desktopOwnerDecision -ceq 'idle' -and
                            $null -eq $pendingIntent -and
                            -not [string]::IsNullOrWhiteSpace(
                                $desktopRootIdentityKey
                            ) -and
                            [string]$desktopOwnerState.LastSuppressedRootIdentityKey -cne
                                $desktopRootIdentityKey) {
                            $desktopOwnerState.LastSuppressedRootIdentityKey =
                                $desktopRootIdentityKey
                            $startupStage = if (
                                -not $automaticTakeoverAllowed
                            ) {
                                'resume-suppressed'
                            } else {
                                'package-update-suppressed'
                            }
                            Write-StartupStatus `
                                -Status 'degraded' `
                                -Message $(if (
                                    -not $automaticTakeoverAllowed
                                ) {
                                    'Sleep/resume was detected. The native Desktop was preserved and Remote takeover now requires a fresh explicit Open request.'
                                } else {
                                    'Codex Desktop package generation changed. The native Desktop was preserved and Remote takeover now requires a fresh explicit Open request.'
                                })
                        }
                        if ($desktopOwnerDecision -ceq 'idle-connected' -and
                            $null -ne $pendingIntent) {
                            Complete-CodexDesktopOwnerIntent `
                                -DataDir $resolvedDataDir `
                                -Intent $pendingIntent `
                                -RuntimeInvocationId $runtimeInvocationId `
                                -Outcome 'already-connected'
                        } elseif ($desktopOwnerDecision -cin @(
                            'launch-intent',
                            'takeover-new-native-root',
                            'recover-disconnected-root'
                        )) {
                            $desktopOwnerState.StartupIntentPending = $false
                            if ($desktopOwnerDecision -cin @(
                                'takeover-new-native-root',
                                'recover-disconnected-root'
                            )) {
                                Assert-CodexDesktopOwnerTakeoverSafetyWindow `
                                    -ExpectedRootIdentityKey (
                                        $desktopRootIdentityKey
                                    ) `
                                    -ExpectedRuntimeVersionId (
                                        [string]$desktopOwnerRuntime.CurrentVersionId
                                    ) `
                                    -ExpectedRuntimeRoot (
                                        [string]$desktopOwnerRuntime.CurrentRoot
                                    ) `
                                    -ExpectedRuntimeInvocationId (
                                        $runtimeInvocationId
                                    ) `
                                    -ExpectedBrokerProcessId $brokerPid `
                                    -RequiredObservations $(if (
                                        $desktopOwnerDecision -ceq
                                            'recover-disconnected-root'
                                    ) { 4 } else { 2 }) `
                                    -GraceMilliseconds $(if (
                                        $desktopOwnerDecision -ceq
                                            'recover-disconnected-root'
                                    ) { 1000 } else { 150 })
                            }
                            if ($desktopOwnerDecision -ceq
                                'takeover-new-native-root') {
                                $desktopOwnerState.LastAttemptedRootIdentityKey =
                                    $desktopRootIdentityKey
                            } elseif ($desktopOwnerDecision -ceq
                                'recover-disconnected-root') {
                                $desktopOwnerState.LastDisconnectedRecoveryRootIdentityKey =
                                    $desktopRootIdentityKey
                            }
                            $desktopRecoveryLaunchAttempted = $true
                            $desktopRecoveryLaunch =
                                Invoke-ManagedDesktopLaunch `
                                    -NotifyOnRemoteSuccessOnly `
                                    -ExpectedTakeoverRootIdentityKey $(if (
                                        $desktopOwnerDecision -ceq
                                            'takeover-new-native-root'
                                    ) {
                                        $desktopRootIdentityKey
                                    } else {
                                        ''
                                    }) `
                                    -ExpectedSelectedRuntimeVersionId $(if (
                                        $null -ne $pendingIntent
                                    ) {
                                        [string]$pendingIntent.TargetRuntimeVersionId
                                    } else {
                                        [string]$desktopOwnerRuntime.CurrentVersionId
                                    }) `
                                    -ExpectedSelectedRuntimeRoot $(if (
                                        $null -ne $pendingIntent
                                    ) {
                                        [string]$pendingIntent.TargetRuntimeRoot
                                    } else {
                                        [string]$desktopOwnerRuntime.CurrentRoot
                                    }) `
                                    -LaunchCorrelationId $(if (
                                        $null -ne $pendingIntent
                                    ) {
                                        [string]$pendingIntent.IntentId
                                    } else {
                                        ''
                                    })
                            if ([string]$desktopRecoveryLaunch.RemoteFailureCode -ceq
                                'handoff-launch-denied') {
                                $desktopOwnerState.PendingPackageRefreshRootIdentityKey =
                                    $desktopRootIdentityKey
                            }
                            $finalDesktopRootIdentityKey =
                                Get-UniqueCodexDesktopRootIdentityKey `
                                    -Processes @(
                                        Get-RunningCodexDesktopRootProcesses
                                    )
                            if (-not [string]::IsNullOrWhiteSpace(
                                $finalDesktopRootIdentityKey
                            )) {
                                $desktopOwnerState.LastAttemptedRootIdentityKey =
                                    $finalDesktopRootIdentityKey
                                if ($desktopOwnerDecision -ceq
                                    'recover-disconnected-root') {
                                    $desktopOwnerState.LastDisconnectedRecoveryRootIdentityKey =
                                        $finalDesktopRootIdentityKey
                                }
                                $desktopOwnerState.PendingFinalRootCapture =
                                    $false
                            } else {
                                $desktopOwnerState.PendingFinalRootCapture =
                                    $true
                                $desktopOwnerState.FinalRootCaptureDeadlineUtc =
                                    [DateTime]::UtcNow.AddSeconds(10)
                            }
                            if ($null -ne $pendingIntent) {
                                Complete-CodexDesktopOwnerIntent `
                                    -DataDir $resolvedDataDir `
                                    -Intent $pendingIntent `
                                    -RuntimeInvocationId $runtimeInvocationId `
                                    -Outcome (
                                        [string]$desktopRecoveryLaunch.Status
                                    )
                            }
                            if ($null -ne $desktopRecoveryLaunch -and
                                [string]$desktopRecoveryLaunch.Status -ceq
                                    'launched-remote') {
                                $startupStage = 'supervising'
                                Write-StartupStatus -Status 'ready'
                            }
                        }
                    }
            } catch {
                $desktopOwnerState.StartupIntentPending = $false
                if ($desktopRecoveryLaunchAttempted) {
                    $finalDesktopRootIdentityKey =
                        Get-UniqueCodexDesktopRootIdentityKey `
                            -Processes @(
                                Get-RunningCodexDesktopRootProcesses
                            )
                    if (-not [string]::IsNullOrWhiteSpace(
                        $finalDesktopRootIdentityKey
                    )) {
                        $desktopOwnerState.LastAttemptedRootIdentityKey =
                            $finalDesktopRootIdentityKey
                        $desktopOwnerState.LastDisconnectedRecoveryRootIdentityKey =
                            $finalDesktopRootIdentityKey
                        $desktopOwnerState.PendingFinalRootCapture = $false
                    } else {
                        $desktopOwnerState.PendingFinalRootCapture = $true
                        $desktopOwnerState.FinalRootCaptureDeadlineUtc =
                            [DateTime]::UtcNow.AddSeconds(10)
                    }
                }
                $startupStage = 'desktop-recovery-blocked'
                Write-StartupStatus `
                    -Status 'degraded' `
                    -Message "The single Desktop owner preserved the current Desktop after one bounded recovery attempt failed: $($_.Exception.Message)"
            }
            $nextDesktopLaunchRecoveryAt =
                [DateTime]::UtcNow.AddSeconds(1)
        }
        $runtimeDecision = Get-SharedRuntimeDecision
        if ($runtimeDecision -ceq 'Ready' -and
            -not (Test-SidecarRequestReady)) {
            $runtimeDecision = 'Degraded'
        }
        if ($runtimeDecision -ceq 'Reject') {
            Write-StartupStatus `
                -Status 'failed' `
                -Message 'Shared runtime entered a rejected readiness state.'
            $null = Stop-ProcessIdentityHandle `
                -IdentityHandle $sidecarIdentityHandle `
                -ErrorAction SilentlyContinue
            exit 1
        }
        if ($runtimeDecision -ceq 'Degraded') {
            $runtimeTransitionDeadline = $null
            if (-not $runtimeApplicationDegraded) {
                $runtimeApplicationDegraded = $true
                $startupStage = 'application-degraded'
                Write-StartupStatus `
                    -Status 'degraded' `
                    -Message 'Application capability checks are temporarily degraded. Live processes were preserved and new remote execution remains paused.'
            }
        } elseif ($runtimeDecision -ceq 'Wait') {
            if ($null -eq $runtimeTransitionDeadline) {
                $runtimeTransitionDeadline = [DateTime]::UtcNow.AddSeconds(
                    $RuntimeHandshakeTimeoutSeconds
                )
            } elseif ([DateTime]::UtcNow -ge $runtimeTransitionDeadline) {
                $runtimeApplicationDegraded = $true
                $startupStage = 'runtime-recovery-wait'
                Write-StartupStatus `
                    -Status 'degraded' `
                    -Message "Runtime client handshake remains unavailable after $RuntimeHandshakeTimeoutSeconds seconds. The verified Broker and Sidecar stay alive and will keep retrying without restarting Codex Desktop."
                $runtimeTransitionDeadline = [DateTime]::UtcNow.AddSeconds(
                    $RuntimeHandshakeTimeoutSeconds
                )
            }
        } else {
            $runtimeTransitionDeadline = $null
            if ($runtimeApplicationDegraded) {
                $runtimeApplicationDegraded = $false
                if ($desktopRuntimeHealthStatus -ceq 'current') {
                    $startupStage = 'supervising'
                    Write-StartupStatus -Status 'ready'
                }
            }
        }
        if ($desktopRuntimeCheckClock.ElapsedMilliseconds -ge
            $nextDesktopRuntimeCheckElapsedMilliseconds) {
            try {
                $currentDesktopRuntime = Resolve-NewCodexDesktopRuntime
                $currentBrokerRuntimeSnapshot =
                    Get-VerifiedBrokerRuntimeSnapshot `
                        -ExpectedBrokerProcessId $brokerPid
                $currentDesktopRootIdentityKey =
                    Get-UniqueCodexDesktopRootIdentityKey `
                        -Processes @(
                            Get-RunningCodexDesktopRootProcesses
                        )
                $currentDesktopOwnerProof =
                    Read-CodexDesktopOwnerConnectionProof `
                        -DataDir $resolvedDataDir
                $desktopConnected = (
                    $null -ne $currentBrokerRuntimeSnapshot -and
                    (Test-CodexDesktopOwnerConnectionProof `
                        -Readiness $currentBrokerRuntimeSnapshot.Readiness `
                        -Proof $currentDesktopOwnerProof `
                        -ExpectedRuntimeInvocationId $runtimeInvocationId `
                        -RootIdentityKey $currentDesktopRootIdentityKey)
                )
                $runtimeIdentityCurrent =
                    Test-DesktopRuntimeIdentityCurrent `
                        -ActiveRuntime $runtimeDiscovery `
                        -CurrentRuntime $currentDesktopRuntime
                $legacyRuntimeCanBePromoted = (
                    $desktopConnected -and
                    [string]$runtimeDiscovery.Source -ceq
                        'legacy-active-receipt' -and
                    (Test-ActiveCodexRuntimeMatchesCurrentDiscovery `
                        -ActiveRuntime $runtimeDiscovery `
                        -CurrentRuntime $currentDesktopRuntime)
                )
                if ($desktopConnected -and
                    ($runtimeIdentityCurrent -or
                        $legacyRuntimeCanBePromoted)) {
                    $runtimeDiscovery = $currentDesktopRuntime
                    $resolvedCodex = [System.IO.Path]::GetFullPath(
                        [string]$runtimeDiscovery.CodexPath
                    )
                    if ($desktopRuntimeHealthStatus -cne 'current') {
                        $desktopRuntimeHealthStatus = 'current'
                        $desktopRuntimeHealthMessage = ''
                        if ($runtimeApplicationDegraded) {
                            $startupStage = 'application-degraded'
                            Write-StartupStatus `
                                -Status 'degraded' `
                                -Message 'Application capability checks are temporarily degraded. Live processes were preserved and new remote execution remains paused.'
                        } else {
                            $startupStage = 'supervising'
                            Write-StartupStatus -Status 'ready'
                        }
                    }
                } elseif (-not $desktopConnected) {
                    $desktopRuntimeHealthStatus = 'blocked'
                    $desktopRuntimeHealthMessage = 'The managed Broker is healthy, but Codex Desktop is not connected. Existing processes were preserved and new remote execution remains disabled.'
                    $startupStage = 'runtime-check-blocked'
                    Write-StartupStatus `
                        -Status 'degraded' `
                        -Message $desktopRuntimeHealthMessage
                } else {
                    $desktopRuntimeHealthStatus = 'update-pending'
                    $desktopRuntimeHealthMessage = 'Codex Desktop package generation or runtime hash changed while the managed stack was active. Broker, app-server, Desktop, and Sidecar were left running; restart the stack manually after active work is complete.'
                    $startupStage = 'update-pending'
                    Write-StartupStatus `
                        -Status 'degraded' `
                        -Message $desktopRuntimeHealthMessage
                }
            } catch {
                $desktopRuntimeHealthStatus = 'blocked'
                $desktopRuntimeHealthMessage = "Current Codex Desktop runtime verification is blocked: $($_.Exception.Message)"
                $startupStage = 'runtime-check-blocked'
                Write-StartupStatus `
                    -Status 'degraded' `
                    -Message $desktopRuntimeHealthMessage
            }
            $nextDesktopRuntimeCheckElapsedMilliseconds =
                $desktopRuntimeCheckClock.ElapsedMilliseconds +
                ([long]$DesktopRuntimeCheckIntervalSeconds * 1000)
        }
        Start-Sleep -Seconds 1
    }
} finally {
    if ($null -ne $sidecarIdentityHandle) {
        $null = Stop-ProcessIdentityHandle `
            -IdentityHandle $sidecarIdentityHandle `
            -ErrorAction SilentlyContinue
        $sidecarIdentityHandle.Process.Dispose()
    }
    $brokerIdentityHandle.Process.Dispose()
    $bootstrapIdentityHandle.Process.Dispose()
}
