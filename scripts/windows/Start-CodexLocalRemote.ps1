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

    [ValidateRange(1, 60)]
    [int]$BrokerStartupTimeoutSeconds = 15,

    [ValidateRange(1, 60)]
    [int]$SidecarHandshakeTimeoutSeconds = 60,

    [ValidateRange(1, 60)]
    [int]$RuntimeHandshakeTimeoutSeconds = 60,

    [ValidateRange(5, 3600)]
    [int]$DesktopRuntimeCheckIntervalSeconds = 30,

    [Parameter(DontShow)]
    [switch]$NoDesktopLaunch
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'CodexLocalRemote.Windows.psm1') -Force

# A persistent Desktop override is intentionally unsupported. The scheduled
# bootstrap starts from a clean process environment and grants the capability
# endpoint only to the Sidecar child process below.
Remove-Item Env:\CODEX_APP_SERVER_WS_URL -ErrorAction SilentlyContinue

$resolvedCodex = $null
$resolvedNode = [System.IO.Path]::GetFullPath($NodePath)
$resolvedRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
$null = Protect-CodexLocalRemoteDataDirectory -DataDir $resolvedDataDir
$startupStatusPath = Join-Path $resolvedDataDir 'startup-last.json'
$bootstrapInvocationId = [Guid]::NewGuid().ToString('N')
$runtimeInvocationId = $null
$bootstrapReceipt = $null
$runtimeDiscovery = $null
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

        [AllowNull()][object]$UpstreamReceipt
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
        CodexPath = $resolvedCodex
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
    if (-not (Test-Path -LiteralPath $activeCodexPath -PathType Leaf)) {
        throw "The active Broker runtime file is unavailable at '$activeCodexPath'."
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
    return Resolve-CodexDesktopRuntime
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
        $desktopStdioPids.Add([int]$candidate.ProcessId)
    }
}
if ($desktopStdioPids.Count -gt 0) {
    throw "Codex Desktop still owns an independent stdio app-server (PID(s): $($desktopStdioPids -join ', ')). Fully exit Desktop, start this task, then reopen Desktop so both clients use the shared broker."
}

function Get-BrokerListeners {
    return @(
        Get-NetTCPConnection `
            -State Listen `
            -LocalPort $BrokerPort `
            -ErrorAction SilentlyContinue
    )
}

function Get-UpstreamListeners {
    return @(
        Get-NetTCPConnection `
            -State Listen `
            -LocalPort $BrokerUpstreamPort `
            -ErrorAction SilentlyContinue
    )
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
    if ($NoDesktopLaunch) {
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
        -SuppressNotification
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
    if ($decision -ceq 'Ready' -or
        $decision -ceq 'Degraded' -or
        $decision -ceq 'Wait') {
        $upstream = Get-VerifiedManagedUpstream
        if ($null -eq $upstream -or
            -not (Test-BrokerReadinessRuntimeIdentity `
                -Readiness $readiness `
                -ExpectedBrokerProcessId $brokerPid `
                -ExpectedUpstreamProcessId ([int]$upstream.ProcessId) `
                -ExpectedRuntimeInvocationId $runtimeInvocationId)) {
            return 'Reject'
        }
    }
    return $decision
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
        $freshRuntime = Resolve-CodexDesktopRuntime
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
Write-BrokerRuntimeReceipt `
    -Status 'broker-ready' `
    -BrokerReceipt $brokerReceipt `
    -SidecarReceipt $null `
    -UpstreamReceipt $initialUpstreamReceipt

$startupStage = 'sidecar-start'
Write-StartupStatus -Status 'starting'
$sidecarArguments = @(
    (ConvertTo-WindowsCommandLineArgument -Value $sidecarCli)
    'serve'
    '--host'
    '127.0.0.1'
    '--port'
    $SidecarPort.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    '--base-path'
    (ConvertTo-WindowsCommandLineArgument -Value $BasePath)
    '--codex-path'
    (ConvertTo-WindowsCommandLineArgument -Value $resolvedCodex)
    '--data-dir'
    (ConvertTo-WindowsCommandLineArgument -Value $resolvedDataDir)
) -join ' '
$sidecarProcess = $null
try {
    # The capability endpoint is scoped to this Sidecar child process. Desktop
    # receives its own process-scoped endpoint only through the fail-open
    # launcher after the managed Broker has passed infrastructure readiness.
    $env:CODEX_APP_SERVER_WS_URL = $webSocketUrl
    $sidecarProcess = Start-Process `
        -FilePath $resolvedNode `
        -ArgumentList $sidecarArguments `
        -WorkingDirectory $resolvedRoot `
        -WindowStyle Hidden `
        -PassThru
} finally {
    Remove-Item Env:\CODEX_APP_SERVER_WS_URL -ErrorAction SilentlyContinue
}
$sidecarCimProcess = Get-CimInstance `
    Win32_Process `
    -Filter "ProcessId = $($sidecarProcess.Id)" `
    -ErrorAction Stop
$sidecarCreationIdentity = Get-ProcessCreationIdentity `
    -CreationDate $sidecarCimProcess.CreationDate
if ([Math]::Abs(
    [long]$sidecarCreationIdentity.CreationDateUtcTicks -
        $sidecarProcess.StartTime.ToUniversalTime().Ticks
) -gt [TimeSpan]::FromSeconds(2).Ticks) {
    throw "Sidecar PID $($sidecarProcess.Id) CreationDate does not match its held process handle."
}
$sidecarIdentityHandle = [pscustomobject]@{
    Process = $sidecarProcess
    ProcessId = $sidecarProcess.Id
    StartTimeUtcTicks = $sidecarProcess.StartTime.ToUniversalTime().Ticks
}
$sidecarReceipt = New-RuntimeProcessReceipt `
    -CimProcess $sidecarCimProcess `
    -StartTimeUtcTicks $sidecarIdentityHandle.StartTimeUtcTicks `
    -RuntimeInvocationId $runtimeInvocationId

try {
    $startupStage = 'sidecar-handshake'
    Write-StartupStatus -Status 'starting'
    $readyUpstream = Wait-ForSidecarHandshake `
        -SidecarProcess $sidecarProcess `
        -BrokerIdentityHandle $brokerIdentityHandle `
        -TimeoutSeconds $SidecarHandshakeTimeoutSeconds
    $readyUpstreamCreationIdentity = Get-ProcessCreationIdentity `
        -CreationDate $readyUpstream.CreationDate
    $readyUpstreamHandle = Open-ProcessIdentityHandle `
        -ProcessId ([int]$readyUpstream.ProcessId) `
        -ExpectedCreationDateUtcTicks $readyUpstreamCreationIdentity.CreationDateUtcTicks
    try {
        $readyUpstreamReceipt = New-RuntimeProcessReceipt `
            -CimProcess $readyUpstream `
            -StartTimeUtcTicks $readyUpstreamHandle.StartTimeUtcTicks `
            -RuntimeInvocationId $runtimeInvocationId
    } finally {
        $readyUpstreamHandle.Process.Dispose()
    }
    Write-BrokerRuntimeReceipt `
        -Status 'ready' `
        -BrokerReceipt $brokerReceipt `
        -SidecarReceipt $sidecarReceipt `
        -UpstreamReceipt $readyUpstreamReceipt

    $initialDesktopLaunch = $null
    if (-not $NoDesktopLaunch) {
        $initialDesktopLaunch = Invoke-ManagedDesktopLaunch
        if ($null -eq $initialDesktopLaunch -or
            [string]$initialDesktopLaunch.Status -cnotin @(
                'launched-remote',
                'already-running',
                'remote-launch-unverified'
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
    $nextDesktopRuntimeCheckAt = [DateTime]::UtcNow.AddSeconds(
        $DesktopRuntimeCheckIntervalSeconds
    )
    $nextDesktopLaunchRecoveryAt = [DateTime]::UtcNow.AddSeconds(10)
    while ($true) {
        if ($sidecarProcess.HasExited) {
            # A long-running scheduled task must return non-zero on every
            # unexpected child exit so Task Scheduler RestartCount is effective.
            Write-StartupStatus `
                -Status 'failed' `
                -Message "Sidecar exited unexpectedly with code $($sidecarProcess.ExitCode)."
            exit $(if ($sidecarProcess.ExitCode -eq 0) { 1 } else { $sidecarProcess.ExitCode })
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
        if (-not $NoDesktopLaunch -and
            [DateTime]::UtcNow -ge $nextDesktopLaunchRecoveryAt) {
            $desktopRecoveryReadiness = Get-BrokerReadinessSnapshot
            $desktopConnected = (
                $null -ne $desktopRecoveryReadiness -and
                $desktopRecoveryReadiness.desktopConnected -is [bool] -and
                [bool]$desktopRecoveryReadiness.desktopConnected
            )
            if (-not $desktopConnected -and
                @(Get-RunningCodexDesktopRootProcesses).Count -eq 0) {
                try {
                    $desktopRecoveryLaunch = Invoke-ManagedDesktopLaunch
                    if ($null -ne $desktopRecoveryLaunch -and
                        [string]$desktopRecoveryLaunch.Status -ceq
                            'launched-remote') {
                        $startupStage = 'supervising'
                        Write-StartupStatus -Status 'ready'
                    }
                } catch {
                    $startupStage = 'desktop-recovery-blocked'
                    Write-StartupStatus `
                        -Status 'degraded' `
                        -Message "Automatic Codex Desktop recovery is blocked: $($_.Exception.Message)"
                }
            }
            $nextDesktopLaunchRecoveryAt =
                [DateTime]::UtcNow.AddSeconds(10)
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
                Write-StartupStatus `
                    -Status 'failed' `
                    -Message "Runtime client handshake did not recover within $RuntimeHandshakeTimeoutSeconds seconds."
                $null = Stop-ProcessIdentityHandle `
                    -IdentityHandle $sidecarIdentityHandle `
                    -ErrorAction SilentlyContinue
                exit 1
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
        if ([DateTime]::UtcNow -ge $nextDesktopRuntimeCheckAt) {
            try {
                $currentDesktopRuntime = Resolve-NewCodexDesktopRuntime
                $currentBrokerRuntimeSnapshot =
                    Get-VerifiedBrokerRuntimeSnapshot `
                        -ExpectedBrokerProcessId $brokerPid
                $desktopConnected = (
                    $null -ne $currentBrokerRuntimeSnapshot -and
                    [bool]$currentBrokerRuntimeSnapshot.Readiness.desktopConnected
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
            $nextDesktopRuntimeCheckAt = [DateTime]::UtcNow.AddSeconds(
                $DesktopRuntimeCheckIntervalSeconds
            )
        }
        Start-Sleep -Seconds 1
    }
} finally {
    $null = Stop-ProcessIdentityHandle `
        -IdentityHandle $sidecarIdentityHandle `
        -ErrorAction SilentlyContinue
    $brokerIdentityHandle.Process.Dispose()
    $bootstrapIdentityHandle.Process.Dispose()
}
