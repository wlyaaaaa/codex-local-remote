[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Open', 'Close', 'Status')]
    [string]$Operation,

    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexLocalRemote'),

    [string]$TaskName = 'Codex Local Remote',

    [ValidateRange(0, 30)]
    [int]$DispatchDelaySeconds = 4,

    [ValidateRange(1, 30)]
    [int]$DesktopExitTimeoutSeconds = 6,

    [ValidateRange(1, 60)]
    [int]$DesktopDrainTimeoutSeconds = 20,

    [ValidateRange(1, 60)]
    [int]$RecoveryWaitSeconds = 20,

    [ValidateRange(15, 180)]
    [int]$ReadyWaitSeconds = 120,

    [ValidatePattern('^[a-f0-9]{64}$')]
    [string]$ExpectedSelectedVersionId,

    [string]$ExpectedSelectedRuntimeRoot,

    [ValidatePattern('^[a-f0-9]{64}$')]
    [string]$ExpectedSelectedManifestSha256,

    [Parameter(DontShow)]
    [ValidatePattern('^[a-f0-9]{32}$')]
    [string]$ExpectedDesiredModeIntentId,

    [Parameter(DontShow)]
    [switch]$NativeDesktopAlreadyClosedForOpen,

    [switch]$AllowDesktopRestart
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($Operation -cne 'Open' -and $AllowDesktopRestart) {
    throw 'AllowDesktopRestart is valid only for an explicit Open operation.'
}
if ($NativeDesktopAlreadyClosedForOpen -and
    ($Operation -cne 'Open' -or -not $AllowDesktopRestart)) {
    throw (
        'NativeDesktopAlreadyClosedForOpen is valid only for one ' +
        'authorized Open operation.'
    )
}
$expectedSelectionArguments = @(
    -not [string]::IsNullOrWhiteSpace($ExpectedSelectedVersionId),
    -not [string]::IsNullOrWhiteSpace($ExpectedSelectedRuntimeRoot),
    -not [string]::IsNullOrWhiteSpace(
        $ExpectedSelectedManifestSha256
    )
)
if (@($expectedSelectionArguments | Where-Object { $_ }).Count -notin @(0, 3)) {
    throw 'Expected selected runtime identity must be supplied as one complete set.'
}
$resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
$statusPath = Join-Path $resolvedDataDir 'on-demand-handoff-last.json'
$script:onDemandLastReadiness = $null
$runtime = $null
$expectedDesktopPath = $null
$nativeDesktopWasClosedForOpen = [bool]$NativeDesktopAlreadyClosedForOpen
$remoteTaskStartAttemptedForOpen = $false
$desktopHandoffPreparation = $null
$preparedAttachCompensationHandled = $false
$script:preparedAttachIntent = $null
$script:desiredModeBeforeOpen = $null
$script:openDesiredModeIntentId = $null
$script:openDesiredModeWasCreated = $false
$controlMutexIdentity = $resolvedDataDir.ToUpperInvariant()
$controlMutexDigest = [Convert]::ToHexString(
    [System.Security.Cryptography.SHA256]::HashData(
        [System.Text.Encoding]::UTF8.GetBytes($controlMutexIdentity)
    )
).ToLowerInvariant()
$controlMutex = [System.Threading.Mutex]::new(
    $false,
    "Global\CodexLocalRemote.OnDemandControl.$controlMutexDigest"
)
$controlMutexTaken = $false

function Write-OnDemandHandoffStatus {
    param(
        [Parameter(Mandatory)]
        [string]$Status,

        [Parameter(Mandatory)]
        [string]$Stage,

        [string]$Code = 'none',

        [Parameter(Mandatory)]
        [string]$Message
    )

    $payload = [ordered]@{
        Signature = 'codex-local-remote/on-demand-handoff/v1'
        Version = 1
        Status = $Status
        Stage = $Stage
        Code = $Code
        Message = $Message
        RecordedAtUtc = [DateTime]::UtcNow.ToString('O')
    }
    $json = $payload | ConvertTo-Json -Depth 4
    $temporaryPath =
        $statusPath + '.tmp.' + [guid]::NewGuid().ToString('N')
    [System.IO.File]::WriteAllText(
        $temporaryPath,
        $json,
        [System.Text.UTF8Encoding]::new($false)
    )
    [System.IO.File]::Move($temporaryPath, $statusPath, $true)
}

function Get-OnDemandHandoffDecision {
    param(
        [Parameter(Mandatory)]
        [string]$TaskState,

        [Parameter(Mandatory)]
        [ValidateSet(
            'inactive',
            'ready',
            'desktop-detached',
            'background-repairable',
            'runtime-transition',
            'runtime-transition-busy',
            'unverified'
        )]
        [string]$RemoteState,

        [ValidateRange(0, 1024)]
        [int]$DesktopRootCount,

        [ValidateRange(0, 1024)]
        [int]$IndependentStdioCount,

        [bool]$AllowDesktopRestart,

        [ValidateSet('Native', 'Remote')]
        [string]$DesiredMode = 'Remote'
    )

    if ($TaskState -ceq 'Queued') {
        return 'remote-start-pending'
    }
    if ($TaskState -ceq 'Running' -and $RemoteState -ceq 'ready') {
        return 'remote-lease-active'
    }
    if ($TaskState -ceq 'Running' -and
        $RemoteState -ceq 'background-repairable') {
        if ($DesiredMode -ceq 'Remote') {
            return 'wait-background-recovery'
        }
        if ($DesktopRootCount -gt 1) {
            return 'blocked-ambiguous-desktop-roots'
        }
        if ($IndependentStdioCount -gt 0 -and
            $DesktopRootCount -eq 0) {
            return 'blocked-independent-stdio'
        }
        if ($DesktopRootCount -eq 0) {
            return 'start-without-desktop-restart'
        }
        if (-not $AllowDesktopRestart) {
            return 'desktop-restart-authorization-required'
        }
        return 'handoff-native-desktop-once'
    }
    if ($TaskState -ceq 'Running' -and
        $RemoteState -ceq 'runtime-transition') {
        if ($DesktopRootCount -gt 1) {
            return 'blocked-ambiguous-desktop-roots'
        }
        if ($IndependentStdioCount -gt 0 -and
            $DesktopRootCount -eq 0) {
            return 'blocked-independent-stdio'
        }
        if ($DesktopRootCount -eq 0) {
            return 'start-without-desktop-restart'
        }
        if (-not $AllowDesktopRestart) {
            return 'desktop-restart-authorization-required'
        }
        return 'handoff-native-desktop-once'
    }
    if ($TaskState -ceq 'Running' -and
        $RemoteState -ceq 'runtime-transition-busy') {
        if ($DesktopRootCount -gt 1) {
            return 'blocked-ambiguous-desktop-roots'
        }
        if ($IndependentStdioCount -gt 0 -and
            $DesktopRootCount -eq 0) {
            return 'blocked-independent-stdio'
        }
        if (-not $AllowDesktopRestart) {
            return 'deferred-handoff-authorization-required'
        }
        if ($DesktopRootCount -eq 0) {
            return 'start-without-desktop-restart'
        }
        return 'defer-runtime-handoff'
    }
    if ($TaskState -ceq 'Running' -and
        $RemoteState -ceq 'desktop-detached') {
        if ($DesktopRootCount -gt 1) {
            return 'blocked-ambiguous-desktop-roots'
        }
        if ($IndependentStdioCount -gt 0 -and
            $DesktopRootCount -eq 0) {
            return 'blocked-independent-stdio'
        }
        if ($DesktopRootCount -eq 1 -and
            -not $AllowDesktopRestart) {
            return 'desktop-restart-authorization-required'
        }
        return 'request-active-lease-recovery'
    }
    if ($TaskState -ceq 'Running') {
        return 'blocked-runtime-unverified'
    }
    if ($TaskState -cne 'Ready') {
        return 'blocked-task-state'
    }
    if ($DesktopRootCount -gt 1) {
        return 'blocked-ambiguous-desktop-roots'
    }
    if ($IndependentStdioCount -gt 0 -and
        $DesktopRootCount -eq 0) {
        return 'blocked-independent-stdio'
    }
    if ($DesktopRootCount -eq 0) {
        return 'start-without-desktop-restart'
    }
    if (-not $AllowDesktopRestart) {
        return 'desktop-restart-authorization-required'
    }
    return 'handoff-native-desktop-once'
}

function ConvertTo-OnDemandWindowsCommandLineArgument {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Value
    )

    if ($Value -notmatch '[\s"]' -and $Value.Length -gt 0) {
        return $Value
    }
    $builder = [System.Text.StringBuilder]::new()
    $null = $builder.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes++
            continue
        }
        if ($character -eq '"') {
            $null = $builder.Append('\' * (($backslashes * 2) + 1))
            $null = $builder.Append('"')
        } else {
            if ($backslashes -gt 0) {
                $null = $builder.Append('\' * $backslashes)
            }
            $null = $builder.Append($character)
        }
        $backslashes = 0
    }
    if ($backslashes -gt 0) {
        $null = $builder.Append('\' * ($backslashes * 2))
    }
    $null = $builder.Append('"')
    return $builder.ToString()
}

function Get-OnDemandDeferredHandoffMutexName {
    $identity = $resolvedDataDir.ToUpperInvariant()
    $identityHash = [Convert]::ToHexString(
        [System.Security.Cryptography.SHA256]::HashData(
            [System.Text.Encoding]::UTF8.GetBytes($identity)
        )
    ).ToLowerInvariant()
    return "Global\CodexLocalRemote.DeferredHandoff.$identityHash"
}

function Get-OnDemandDeferredHandoffWorkerClaimPath {
    return Join-Path $resolvedDataDir 'deferred-handoff-worker.json'
}

function Test-OnDemandDeferredHandoffWorkerActive {
    $workerMutex = $null
    $lockTaken = $false
    try {
        try {
            $workerMutex = [System.Threading.Mutex]::OpenExisting(
                (Get-OnDemandDeferredHandoffMutexName)
            )
        } catch [System.Threading.WaitHandleCannotBeOpenedException] {
            return $false
        }
        try {
            $lockTaken = $workerMutex.WaitOne(0)
        } catch [System.Threading.AbandonedMutexException] {
            $lockTaken = $true
        }
        return -not $lockTaken
    } finally {
        if ($lockTaken -and $null -ne $workerMutex) {
            $workerMutex.ReleaseMutex()
        }
        if ($null -ne $workerMutex) {
            $workerMutex.Dispose()
        }
    }
}

function Get-OnDemandDeferredHandoffWorkerState {
    $active = Test-OnDemandDeferredHandoffWorkerActive
    $state = [ordered]@{
        Active = $active
        ClaimValid = $false
        DesiredModeIntentId = $null
        RuntimeVersionId = $null
        RuntimeRoot = $null
        ProcessId = 0
        ProcessStartTimeUtcTicks = 0
    }
    if (-not $active) {
        return [pscustomobject]$state
    }
    $claimPath = Get-OnDemandDeferredHandoffWorkerClaimPath
    if (-not (Test-Path -LiteralPath $claimPath -PathType Leaf)) {
        return [pscustomobject]$state
    }
    try {
        $item = Get-Item -LiteralPath $claimPath -Force -ErrorAction Stop
        if ($item.PSIsContainer -or
            ($item.Attributes -band
                [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            [long]$item.Length -lt 2 -or
            [long]$item.Length -gt 131072) {
            return [pscustomobject]$state
        }
        $claim = Get-Content `
            -LiteralPath $claimPath `
            -Raw `
            -Encoding utf8 `
            -ErrorAction Stop |
            ConvertFrom-Json -Depth 10 -DateKind String -ErrorAction Stop
        if ([string]$claim.Signature -cne
                'codex-local-remote/deferred-handoff-worker/v1' -or
            [int]$claim.Version -ne 1 -or
            [string]$claim.ClaimId -cnotmatch '^[a-f0-9]{32}$' -or
            [string]$claim.DesiredModeIntentId -cnotmatch
                '^[a-f0-9]{32}$' -or
            [string]$claim.RuntimeVersionId -cnotmatch
                '^[a-f0-9]{64}$' -or
            [string]::IsNullOrWhiteSpace([string]$claim.RuntimeRoot) -or
            [int]$claim.ProcessId -lt 1 -or
            [long]$claim.ProcessStartTimeUtcTicks -lt 1) {
            return [pscustomobject]$state
        }
        $claimProcess = Get-Process `
            -Id ([int]$claim.ProcessId) `
            -ErrorAction Stop
        try {
            if ($claimProcess.StartTime.ToUniversalTime().Ticks -ne
                [long]$claim.ProcessStartTimeUtcTicks) {
                return [pscustomobject]$state
            }
        } finally {
            $claimProcess.Dispose()
        }
        if (-not (Test-OnDemandDeferredHandoffWorkerActive)) {
            $state.Active = $false
            return [pscustomobject]$state
        }
        $state.ClaimValid = $true
        $state.DesiredModeIntentId = [string]$claim.DesiredModeIntentId
        $state.RuntimeVersionId = [string]$claim.RuntimeVersionId
        $state.RuntimeRoot = [System.IO.Path]::GetFullPath(
            [string]$claim.RuntimeRoot
        )
        $state.ProcessId = [int]$claim.ProcessId
        $state.ProcessStartTimeUtcTicks =
            [long]$claim.ProcessStartTimeUtcTicks
    } catch {
        return [pscustomobject]$state
    }
    return [pscustomobject]$state
}

function Test-OnDemandDeferredHandoffWorkerMatches {
    param(
        [Parameter(Mandatory)]
        [object]$State,

        [Parameter(Mandatory)]
        [object]$Runtime,

        [Parameter(Mandatory)]
        [ValidatePattern('^[a-f0-9]{32}$')]
        [string]$DesiredModeIntentId
    )

    if (-not [bool]$State.Active -or
        -not [bool]$State.ClaimValid -or
        [string]$State.DesiredModeIntentId -cne $DesiredModeIntentId -or
        [string]$State.RuntimeVersionId -cne
            [string]$Runtime.CurrentVersionId) {
        return $false
    }
    try {
        return [string]::Equals(
            [System.IO.Path]::GetFullPath([string]$State.RuntimeRoot),
            [System.IO.Path]::GetFullPath([string]$Runtime.CurrentRoot),
            [System.StringComparison]::OrdinalIgnoreCase
        )
    } catch {
        return $false
    }
}

function Start-OnDemandDeferredRuntimeHandoff {
    param(
        [Parameter(Mandatory)]
        [object]$Runtime,

        [Parameter(Mandatory)]
        [object]$Configuration,

        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [ValidatePattern('^[a-f0-9]{32}$')]
        [string]$DesiredModeIntentId
    )

    $runtimeRoot = [System.IO.Path]::GetFullPath(
        [string]$Runtime.CurrentRoot
    )
    $existingWorkerWait = [System.Diagnostics.Stopwatch]::StartNew()
    do {
        $existingState = Get-OnDemandDeferredHandoffWorkerState
        if (-not [bool]$existingState.Active) {
            break
        }
        if (Test-OnDemandDeferredHandoffWorkerMatches `
            -State $existingState `
            -Runtime $Runtime `
            -DesiredModeIntentId $DesiredModeIntentId) {
            return [pscustomobject]@{
                AlreadyActive = $true
                ProcessId = 0
                ProcessStartTimeUtcTicks = 0
            }
        }
        if ($existingWorkerWait.Elapsed -ge [TimeSpan]::FromSeconds(5)) {
            throw (
                'A superseded deferred handoff worker did not release its ' +
                'singleton mutex within the bounded cancellation window.'
            )
        }
        Start-Sleep -Milliseconds 100
    } while ($true)
    $workerPath = Join-Path `
        $runtimeRoot `
        'scripts\windows\Complete-CodexLocalRemoteDeferredHandoff.ps1'
    if (-not (Test-Path -LiteralPath $workerPath -PathType Leaf)) {
        throw 'The selected runtime does not contain the deferred handoff worker.'
    }
    $pwshPath = Join-Path $PSHOME 'pwsh.exe'
    if (-not (Test-Path -LiteralPath $pwshPath -PathType Leaf)) {
        throw 'The current PowerShell runtime cannot launch the deferred handoff worker.'
    }
    $workerArguments = @(
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $workerPath,
        '-DataDir',
        $resolvedDataDir,
        '-BrokerPort',
        [string]$Configuration.BrokerPort,
        '-TaskName',
        $Name,
        '-DesktopShutdownTimeoutSeconds',
        [string]$DesktopDrainTimeoutSeconds,
        '-VerificationTimeoutSeconds',
        [string]$ReadyWaitSeconds,
        '-ExpectedSelectedVersionId',
        [string]$Runtime.CurrentVersionId,
        '-ExpectedSelectedRuntimeRoot',
        $runtimeRoot,
        '-InvokeInstalledControl',
        '-ExpectedDesiredModeIntentId',
        $DesiredModeIntentId,
        '-Confirm:$false'
    )
    $argumentLine = (
        $workerArguments |
            ForEach-Object {
                ConvertTo-OnDemandWindowsCommandLineArgument `
                    -Value ([string]$_)
            }
    ) -join ' '
    $workerNonce = [guid]::NewGuid().ToString('N')
    $stdoutPath = Join-Path `
        $resolvedDataDir `
        "deferred-handoff-worker-$workerNonce.stdout.log"
    $stderrPath = Join-Path `
        $resolvedDataDir `
        "deferred-handoff-worker-$workerNonce.stderr.log"
    $worker = Start-Process `
        -FilePath $pwshPath `
        -ArgumentList $argumentLine `
        -WorkingDirectory $runtimeRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru
    try {
        if ($null -eq $worker -or [int]$worker.Id -lt 1) {
            throw 'The deferred handoff worker returned no process identity.'
        }
        $workerStartTimeUtcTicks =
            $worker.StartTime.ToUniversalTime().Ticks
        $claimWait = [System.Diagnostics.Stopwatch]::StartNew()
        $workerClaimed = $false
        do {
            Start-Sleep -Milliseconds 100
            $worker.Refresh()
            if ($worker.HasExited) {
                throw (
                    'The deferred handoff worker exited before accepting ' +
                    'the idle wait.'
                )
            }
            $workerState = Get-OnDemandDeferredHandoffWorkerState
            $workerClaimed = Test-OnDemandDeferredHandoffWorkerMatches `
                -State $workerState `
                -Runtime $Runtime `
                -DesiredModeIntentId $DesiredModeIntentId
        } while (-not $workerClaimed -and
            $claimWait.Elapsed -lt [TimeSpan]::FromSeconds(30))
        if (-not $workerClaimed) {
            throw 'The deferred handoff worker did not claim its singleton mutex.'
        }
        return [pscustomobject]@{
            AlreadyActive = $false
            ProcessId = [int]$worker.Id
            ProcessStartTimeUtcTicks = [long]$workerStartTimeUtcTicks
        }
    } catch {
        if ($null -ne $worker) {
            try {
                $worker.Refresh()
                if (-not $worker.HasExited) {
                    $worker.Kill()
                    $null = $worker.WaitForExit(5000)
                }
            } catch {
                # Preserve the worker admission failure.
            }
        }
        throw
    } finally {
        if ($null -ne $worker) {
            $worker.Dispose()
        }
    }
}

function Get-OnDemandIndependentStdioProcesses {
    $independent = [System.Collections.Generic.List[object]]::new()
    foreach ($candidate in @(
        Get-CimInstance `
            Win32_Process `
            -Filter "Name = 'codex.exe'" `
            -ErrorAction SilentlyContinue
    )) {
        $parent = Get-CimInstance `
            Win32_Process `
            -Filter "ProcessId = $([int]$candidate.ParentProcessId)" `
            -ErrorAction SilentlyContinue
        if (Test-IndependentDesktopAppServer `
            -CommandLine ([string]$candidate.CommandLine) `
            -ParentProcessName ([string]$parent.Name)) {
            $independent.Add($candidate)
        }
    }
    return @($independent)
}

function Get-OnDemandRemoteState {
    param(
        [Parameter(Mandatory)]
        [object]$Runtime,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$BrokerPort
    )

    $script:onDemandLastReadiness = $null
    try {
        $receiptPath = Join-Path `
            $resolvedDataDir `
            'app-server-broker.json'
        if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
            return 'unverified'
        }
        $receiptItem =
            Get-Item -LiteralPath $receiptPath -Force -ErrorAction Stop
        if ($receiptItem.PSIsContainer -or
            ($receiptItem.Attributes -band
                [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            [long]$receiptItem.Length -lt 64 -or
            [long]$receiptItem.Length -gt 65536) {
            return 'unverified'
        }
        $rawBefore =
            Get-Content -LiteralPath $receiptPath -Raw -Encoding utf8
        $receipt = $rawBefore |
            ConvertFrom-Json -Depth 20 -DateKind String -ErrorAction Stop
        $readiness = Invoke-RestMethod `
            -Method Get `
            -Uri "http://127.0.0.1:$BrokerPort/ready" `
            -TimeoutSec 2
        $rawAfter =
            Get-Content -LiteralPath $receiptPath -Raw -Encoding utf8
        $actualBrokerCli = [System.IO.Path]::GetFullPath(
            [string]$receipt.BrokerCliPath
        )
        $brokerCliSuffix = '\apps\broker\dist\cli.js'
        if (-not $actualBrokerCli.EndsWith(
            $brokerCliSuffix,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            return 'unverified'
        }
        $activeBrokerRuntimeRoot = $actualBrokerCli.Substring(
            0,
            $actualBrokerCli.Length - $brokerCliSuffix.Length
        )
        $activeBrokerVersionId =
            Split-Path -Leaf $activeBrokerRuntimeRoot
        $expectedActiveBrokerRoot = [System.IO.Path]::GetFullPath(
            (Join-Path `
                (Join-Path $resolvedDataDir 'RuntimeVersions') `
                $activeBrokerVersionId)
        )
        $activeBrokerRuntimeCheck =
            Test-CodexLocalRemoteRuntimeVersion `
                -RuntimeRoot $activeBrokerRuntimeRoot `
                -ExpectedVersionId $activeBrokerVersionId
        $activeBrokerCompatibilityId =
            [string](
                $activeBrokerRuntimeCheck.BrokerSidecarCompatibilityId
            )
        foreach ($property in @(
            'status',
            'appServerReady',
            'desktopConnected',
            'sidecarConnected',
            'degraded',
            'unknownCount',
            'unsafeThreadCount',
            'runtimeInvocationId',
            'brokerProcessId',
            'upstreamProcessId'
        )) {
            if ($null -eq $readiness.PSObject.Properties[$property]) {
                return 'unverified'
            }
        }
        if ($rawBefore -cne $rawAfter -or
            [string]$receipt.Signature -cne
                'codex-local-remote/app-server-broker/v3' -or
            [int]$receipt.Version -ne 3 -or
            [string]$receipt.Status -cnotin @('broker-ready', 'ready') -or
            [string]$receipt.BrokerSidecarCompatibilityId -cne
                $activeBrokerCompatibilityId -or
            $activeBrokerVersionId -cnotmatch '^[a-f0-9]{64}$' -or
            -not [string]::Equals(
                $activeBrokerRuntimeRoot,
                $expectedActiveBrokerRoot,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -or
            -not $activeBrokerRuntimeCheck.IsValid -or
            [string]$receipt.RuntimeInvocationId -cnotmatch
                '^[0-9a-f]{32}$' -or
            [string]$readiness.runtimeInvocationId -cne
                [string]$receipt.RuntimeInvocationId -or
            -not (Test-NonNegativeInteger `
                -Value $readiness.brokerProcessId) -or
            [int]$readiness.brokerProcessId -lt 1 -or
            [int]$readiness.brokerProcessId -ne
                [int]$receipt.Broker.ProcessId -or
            -not (Test-NonNegativeInteger `
                -Value $readiness.upstreamProcessId) -or
            [int]$readiness.upstreamProcessId -lt 1 -or
            [int]$readiness.upstreamProcessId -ne
                [int]$receipt.Upstream.ProcessId -or
            $readiness.appServerReady -isnot [bool] -or
            $readiness.desktopConnected -isnot [bool] -or
            $readiness.sidecarConnected -isnot [bool] -or
            $readiness.degraded -isnot [bool] -or
            -not (Test-NonNegativeInteger `
                -Value $readiness.unknownCount) -or
            -not (Test-NonNegativeInteger `
                -Value $readiness.unsafeThreadCount) -or
            [int]$readiness.unknownCount -ne 0) {
            return 'unverified'
        }
        if ([bool]$readiness.sidecarConnected -and
            (
                [string]$receipt.Status -cne 'ready' -or
                $null -eq $receipt.Sidecar -or
                [string]$receipt.Sidecar.RuntimeInvocationId -cne
                    [string]$receipt.RuntimeInvocationId -or
                -not (Test-NonNegativeInteger `
                    -Value $receipt.Sidecar.ProcessId) -or
                [int]$receipt.Sidecar.ProcessId -le 0 -or
                -not (Test-NonNegativeInteger `
                    -Value $receipt.Sidecar.ProcessStartTimeUtcTicks) -or
                [long]$receipt.Sidecar.ProcessStartTimeUtcTicks -le 0
            )) {
            return 'unverified'
        }
        $currentGeneration = (
            [string]$activeBrokerVersionId -ceq
                [string]$Runtime.CurrentVersionId -and
            -not [string]::IsNullOrWhiteSpace(
                [string]$Runtime.CurrentRoot
            ) -and
            [string]::Equals(
                $activeBrokerRuntimeRoot,
                [System.IO.Path]::GetFullPath(
                    [string]$Runtime.CurrentRoot
                ),
                [System.StringComparison]::OrdinalIgnoreCase
            ) -and
            [string]$Runtime.CurrentManifestSha256 -cmatch
                '^[a-f0-9]{64}$' -and
            [string]$activeBrokerRuntimeCheck.ManifestSha256 -ceq
                [string]$Runtime.CurrentManifestSha256
        )
        $previousGeneration = (
            [string]$Runtime.PreviousVersionId -cmatch
                '^[a-f0-9]{64}$' -and
            [string]$Runtime.PreviousManifestSha256 -cmatch
                '^[a-f0-9]{64}$' -and
            -not [string]::IsNullOrWhiteSpace(
                [string]$Runtime.PreviousRoot
            ) -and
            [string]$activeBrokerVersionId -ceq
                [string]$Runtime.PreviousVersionId -and
            [string]::Equals(
                $activeBrokerRuntimeRoot,
                [System.IO.Path]::GetFullPath(
                    [string]$Runtime.PreviousRoot
                ),
                [System.StringComparison]::OrdinalIgnoreCase
            ) -and
            [string]$activeBrokerRuntimeCheck.ManifestSha256 -ceq
                [string]$Runtime.PreviousManifestSha256
        )
        if (-not $currentGeneration -and
            -not $previousGeneration) {
            return 'unverified'
        }
        $script:onDemandLastReadiness = $readiness
        if ($previousGeneration) {
            if ([string]$readiness.status -ceq 'ready' -and
                [bool]$readiness.appServerReady -and
                [bool]$readiness.desktopConnected -and
                [bool]$readiness.sidecarConnected -and
                -not [bool]$readiness.degraded -and
                [int]$readiness.unsafeThreadCount -gt 0) {
                return 'runtime-transition-busy'
            }
            if ([string]$readiness.status -ceq 'ready' -and
                [bool]$readiness.appServerReady -and
                [bool]$readiness.desktopConnected -and
                [bool]$readiness.sidecarConnected -and
                -not [bool]$readiness.degraded -and
                [int]$readiness.unsafeThreadCount -eq 0) {
                return 'runtime-transition'
            }
            if ([string]$readiness.status -ceq 'ready' -and
                [bool]$readiness.appServerReady -and
                -not [bool]$readiness.desktopConnected -and
                -not [bool]$readiness.degraded -and
                [int]$readiness.unsafeThreadCount -gt 0) {
                return 'runtime-transition-busy'
            }
            if ([string]$readiness.status -ceq 'ready' -and
                [bool]$readiness.appServerReady -and
                -not [bool]$readiness.desktopConnected -and
                -not [bool]$readiness.degraded -and
                [int]$readiness.unsafeThreadCount -eq 0) {
                return 'runtime-transition'
            }
            return 'unverified'
        }
        if ([string]$readiness.status -ceq 'ready' -and
            [bool]$readiness.appServerReady -and
            [bool]$readiness.desktopConnected -and
            [bool]$readiness.sidecarConnected -and
            -not [bool]$readiness.degraded) {
            # Active turns are expected product state after Desktop and the
            # Sidecar attach to the exact current Broker. They must still
            # block maintenance and generation changes, but they do not make
            # an otherwise exact live lease unverifiable.
            return 'ready'
        }
        if ([int]$readiness.unsafeThreadCount -ne 0) {
            return 'unverified'
        }
        if ([bool]$readiness.appServerReady -and
            -not [bool]$readiness.sidecarConnected) {
            return 'background-repairable'
        }
        if ([bool]$readiness.appServerReady -and
            [bool]$readiness.sidecarConnected -and
            -not [bool]$readiness.desktopConnected) {
            return 'desktop-detached'
        }
    } catch {
        return 'unverified'
    }
    return 'unverified'
}

function Get-VerifiedOnDemandStartupTask {
    param(
        [Parameter(Mandatory)]
        [object]$Runtime,

        [Parameter(Mandatory)]
        [string]$Name
    )

    if (-not [bool]$Runtime.HasCurrentTaskDefinition -or
        [string]$Runtime.CurrentTaskDefinitionTaskName -cne $Name -or
        [string]$Runtime.CurrentTaskDefinitionRuntimeVersionId -cne
            [string]$Runtime.CurrentVersionId -or
        -not [string]::Equals(
            [System.IO.Path]::GetFullPath(
                [string]$Runtime.CurrentTaskDefinitionRuntimeRoot
            ),
            [System.IO.Path]::GetFullPath([string]$Runtime.CurrentRoot),
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        [string]$Runtime.CurrentTaskDefinitionSha256 -cnotmatch
            '^[a-f0-9]{64}$') {
        throw 'Selected runtime does not own one exact current task binding.'
    }

    $task = Get-ScheduledTask `
        -TaskName $Name `
        -TaskPath '\' `
        -ErrorAction Stop
    $taskXml = Export-ScheduledTask `
        -TaskName $Name `
        -TaskPath '\' `
        -ErrorAction Stop
    if ((Get-StringSha256 -Value $taskXml) -cne
        [string]$Runtime.CurrentTaskDefinitionSha256) {
        throw 'Remote startup task changed after its runtime binding was recorded.'
    }
    return $task
}

function Assert-OnDemandDesktopRootExecutable {
    param(
        [Parameter(Mandatory)]
        [object]$DesktopRoot,

        [Parameter(Mandatory)]
        [string]$ExpectedDesktopPath
    )

    $actualDesktopPath = [System.IO.Path]::GetFullPath(
        [string]$DesktopRoot.ExecutablePath
    )
    if (-not [string]::Equals(
        $actualDesktopPath,
        $ExpectedDesktopPath,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'Desktop root executable does not match the healthy registered package.'
    }
}

function Stop-OnDemandDesktopRoot {
    param(
        [Parameter(Mandatory)]
        [object]$DesktopRoot,

        [Parameter(Mandatory)]
        [string]$ExpectedDesktopPath
    )

    Assert-OnDemandDesktopRootExecutable `
        -DesktopRoot $DesktopRoot `
        -ExpectedDesktopPath $ExpectedDesktopPath
    $creationIdentity = Get-ProcessCreationIdentity `
        -CreationDate $DesktopRoot.CreationDate
    $identityHandle = Open-ProcessIdentityHandle `
        -ProcessId ([int]$DesktopRoot.ProcessId) `
        -ExpectedCreationDateUtcTicks (
            [long]$creationIdentity.CreationDateUtcTicks
        )
    try {
        $null = $identityHandle.Process.CloseMainWindow()
        $null = $identityHandle.Process.WaitForExit(
            $DesktopExitTimeoutSeconds * 1000
        )
        $identityHandle.Process.Refresh()
        if (-not $identityHandle.Process.HasExited) {
            $null = Stop-ProcessIdentityHandle `
                -IdentityHandle $identityHandle `
                -TimeoutMilliseconds 10000
        }
    } finally {
        $identityHandle.Process.Dispose()
    }
}

function Wait-OnDemandDesktopDrain {
    $deadline =
        [DateTime]::UtcNow.AddSeconds($DesktopDrainTimeoutSeconds)
    do {
        $remainingDesktopRoots = @(
            Get-CimInstance `
                Win32_Process `
                -Filter "Name = 'ChatGPT.exe'" `
                -ErrorAction SilentlyContinue |
                Where-Object {
                    [string]$_.CommandLine -notmatch
                        '(?i)(?:^|\s)--type='
                }
        )
        $remainingIndependentAppServers =
            @(Get-OnDemandIndependentStdioProcesses)
        if ($remainingDesktopRoots.Count -eq 0 -and
            $remainingIndependentAppServers.Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)

    throw 'Desktop ownership did not drain completely.'
}

function Start-OnDemandNativeDesktop {
    param(
        [Parameter(Mandatory)]
        [string]$RuntimeRoot,

        [Parameter(Mandatory)]
        [string]$DesktopExecutablePath
    )

    $launcherPath = Join-Path `
        $RuntimeRoot `
        'scripts\windows\Launch-CodexWithRemote.ps1'
    if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
        throw 'The selected runtime has no native Desktop launcher.'
    }
    . $launcherPath -DefinitionOnly
    Remove-Item `
        Env:\CODEX_APP_SERVER_WS_URL `
        -ErrorAction SilentlyContinue
    $null = Start-CodexDesktopProcess `
        -DesktopExecutablePath $DesktopExecutablePath `
        -RemoteEndpoint $null
}

function Test-OnDemandRuntimePathEqual {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [string]$Left,

        [AllowNull()]
        [string]$Right
    )

    if ([string]::IsNullOrWhiteSpace($Left) -or
        [string]::IsNullOrWhiteSpace($Right)) {
        return (
            [string]::IsNullOrWhiteSpace($Left) -and
            [string]::IsNullOrWhiteSpace($Right)
        )
    }
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

function Test-OnDemandRuntimeIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Runtime,

        [AllowNull()]
        [string]$ExpectedVersionId,

        [AllowNull()]
        [string]$ExpectedRoot,

        [AllowNull()]
        [string]$ExpectedManifestSha256
    )

    return (
        $ExpectedVersionId -cmatch '^[a-f0-9]{64}$' -and
        $ExpectedManifestSha256 -cmatch '^[a-f0-9]{64}$' -and
        [string]$Runtime.CurrentVersionId -ceq $ExpectedVersionId -and
        [string]$Runtime.CurrentManifestSha256 -ceq
            $ExpectedManifestSha256 -and
        (Test-OnDemandRuntimePathEqual `
            -Left ([string]$Runtime.CurrentRoot) `
            -Right $ExpectedRoot)
    )
}

function Test-OnDemandRuntimePointerSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Expected,

        [Parameter(Mandatory)]
        [object]$Actual
    )

    foreach ($property in @(
        'CurrentVersionId',
        'CurrentManifestSha256',
        'PreviousVersionId',
        'PreviousManifestSha256',
        'PreviousTaskPreImageSha256',
        'PreviousTaskPreImageTaskName',
        'PreviousTaskPreImageRuntimeVersionId',
        'CurrentTaskDefinitionSha256',
        'CurrentTaskDefinitionTaskName',
        'CurrentTaskDefinitionRuntimeVersionId'
    )) {
        if ([string]$Expected.$property -cne
            [string]$Actual.$property) {
            return $false
        }
    }
    foreach ($property in @(
        'HasPreviousTaskPreImage',
        'HasCurrentTaskDefinition'
    )) {
        if ([bool]$Expected.$property -ne [bool]$Actual.$property) {
            return $false
        }
    }
    foreach ($property in @(
        'CurrentRoot',
        'PreviousRoot',
        'PreviousTaskPreImageRuntimeRoot',
        'CurrentTaskDefinitionRuntimeRoot'
    )) {
        if (-not (Test-OnDemandRuntimePathEqual `
            -Left ([string]$Expected.$property) `
            -Right ([string]$Actual.$property))) {
            return $false
        }
    }
    return $true
}

function Assert-OnDemandSelectedRuntimeUnchanged {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$ExpectedRuntime
    )

    $current =
        Get-CodexLocalRemoteCurrentRuntime -DataDir $resolvedDataDir
    if ($null -eq $current -or
        -not (Test-OnDemandRuntimePointerSnapshot `
            -Expected $ExpectedRuntime `
            -Actual $current)) {
        throw (
            'The selected runtime changed after activation preflight; ' +
            'Desktop was preserved.'
        )
    }
    return $current
}

function Resolve-OnDemandOpenCompensationRuntime {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$RequestedRuntime
    )

    $current =
        Get-CodexLocalRemoteCurrentRuntime -DataDir $resolvedDataDir
    if ($null -eq $current) {
        throw 'Open compensation found no verified immutable runtime.'
    }
    $matchesRequested = Test-OnDemandRuntimeIdentity `
        -Runtime $current `
        -ExpectedVersionId (
            [string]$RequestedRuntime.CurrentVersionId
        ) `
        -ExpectedRoot ([string]$RequestedRuntime.CurrentRoot) `
        -ExpectedManifestSha256 (
            [string]$RequestedRuntime.CurrentManifestSha256
        )
    $matchesPrior = Test-OnDemandRuntimeIdentity `
        -Runtime $current `
        -ExpectedVersionId (
            [string]$RequestedRuntime.PreviousVersionId
        ) `
        -ExpectedRoot ([string]$RequestedRuntime.PreviousRoot) `
        -ExpectedManifestSha256 (
            [string]$RequestedRuntime.PreviousManifestSha256
        )
    if (-not $matchesRequested -and -not $matchesPrior) {
        throw (
            'Open compensation found a runtime outside the exact requested ' +
            'or rollback generation.'
        )
    }
    return $current
}

function Assert-OnDemandSelectedRemoteRuntimeActivationPreflight {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Runtime,

        [Parameter(Mandatory)]
        [object]$Configuration,

        [Parameter(Mandatory)]
        [object]$StartupTask,

        [Parameter(Mandatory)]
        [string]$Name,

        [switch]$AllowActiveTurns
    )

    $launcherPath = Join-Path `
        ([string]$Runtime.CurrentRoot) `
        'scripts\windows\Launch-CodexWithRemote.ps1'
    if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
        throw 'The selected runtime has no transactional Desktop launcher.'
    }
    . $launcherPath `
        -DataDir $resolvedDataDir `
        -SidecarPort ([int]$Configuration.SidecarPort) `
        -BrokerPort ([int]$Configuration.BrokerPort) `
        -BrokerUpstreamPort ([int]$Configuration.BrokerUpstreamPort) `
        -BasePath ([string]$Configuration.BasePath) `
        -TaskName $Name `
        -DefinitionOnly
    foreach ($commandName in @(
        'Get-CodexLocalRemoteRuntimeGenerationStatus',
        'Get-CodexLocalRemoteRuntimeHandoffDecision',
        'Get-CodexLocalRemoteReadinessSnapshot'
    )) {
        if ($null -eq (Get-Command `
            -Name $commandName `
            -CommandType Function `
            -ErrorAction SilentlyContinue)) {
            throw (
                "The selected runtime is missing activation preflight " +
                "function '$commandName'."
            )
        }
    }

    $generation =
        Get-CodexLocalRemoteRuntimeGenerationStatus `
            -ManagedDataDir $resolvedDataDir
    $postDrainDecision =
        Get-CodexLocalRemoteRuntimeHandoffDecision `
            -TaskState ([string]$StartupTask.State) `
            -GenerationStatus ([string]$generation.Status) `
            -DesktopProcessCount 0
    if ($postDrainDecision -ceq 'start') {
        if ([string]$generation.Status -cnotin @(
            'active-receipt-missing',
            'current'
        )) {
            throw (
                "Remote activation preflight cannot start from generation " +
                "'$($generation.Status)'."
            )
        }
        foreach ($port in @(
            [int]$Configuration.SidecarPort,
            [int]$Configuration.BrokerPort,
            [int]$Configuration.BrokerUpstreamPort
        )) {
            if (@(
                Get-NetTCPConnection `
                    -State Listen `
                    -LocalPort $port `
                    -ErrorAction SilentlyContinue
            ).Count -gt 0) {
                throw (
                    "Remote activation preflight found an unowned listener " +
                    "on managed TCP port $port."
                )
            }
        }
        return $generation
    }
    if ($postDrainDecision -cnotin @('switch', 'reuse') -or
        $null -eq $generation.Receipt) {
        throw (
            "Remote activation preflight cannot safely continue from " +
            "generation '$($generation.Status)' and decision " +
            "'$postDrainDecision'."
        )
    }

    $readiness =
        Get-CodexLocalRemoteReadinessSnapshot `
            -Port ([int]$Configuration.BrokerPort)
    foreach ($property in @(
        'status',
        'appServerReady',
        'desktopConnected',
        'sidecarConnected',
        'degraded',
        'unknownCount',
        'unsafeThreadCount',
        'runtimeInvocationId',
        'brokerProcessId',
        'upstreamProcessId'
    )) {
        if ($null -eq $readiness -or
            $null -eq $readiness.PSObject.Properties[$property]) {
            throw (
                "Remote activation preflight readiness lacks '$property'."
            )
        }
    }
    if ([string]$readiness.status -cne 'ready' -or
        $readiness.appServerReady -isnot [bool] -or
        -not [bool]$readiness.appServerReady -or
        $readiness.desktopConnected -isnot [bool] -or
        [bool]$readiness.desktopConnected -or
        $readiness.sidecarConnected -isnot [bool] -or
        $readiness.degraded -isnot [bool] -or
        [bool]$readiness.degraded -or
        -not (Test-NonNegativeInteger -Value $readiness.unknownCount) -or
        [int]$readiness.unknownCount -ne 0 -or
        -not (Test-NonNegativeInteger -Value $readiness.unsafeThreadCount) -or
        (-not $AllowActiveTurns -and
            [int]$readiness.unsafeThreadCount -ne 0) -or
        [string]$readiness.runtimeInvocationId -cne
            [string]$generation.Receipt.RuntimeInvocationId -or
        [int]$readiness.brokerProcessId -ne
            [int]$generation.Receipt.ProcessId -or
        [int]$readiness.upstreamProcessId -ne
            [int]$generation.Receipt.Upstream.ProcessId) {
        throw (
            'Remote activation preflight found an active, unknown, ' +
            'detached-unsafe, or identity-mismatched managed generation.'
        )
    }
    return $generation
}

function Start-OnDemandSelectedRemoteRuntime {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Runtime,

        [Parameter(Mandatory)]
        [object]$Configuration,

        [Parameter(Mandatory)]
        [string]$Name,

        [AllowNull()]
        [object]$DesktopHandoffPreparation,

        [switch]$AllowActiveTurns
    )

    $launcherPath = Join-Path `
        ([string]$Runtime.CurrentRoot) `
        'scripts\windows\Launch-CodexWithRemote.ps1'
    if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
        throw 'The selected runtime has no transactional Desktop launcher.'
    }
    . $launcherPath `
        -DataDir $resolvedDataDir `
        -SidecarPort ([int]$Configuration.SidecarPort) `
        -BrokerPort ([int]$Configuration.BrokerPort) `
        -BrokerUpstreamPort ([int]$Configuration.BrokerUpstreamPort) `
        -BasePath ([string]$Configuration.BasePath) `
        -TaskName $Name `
        -DefinitionOnly
    $activationCommand = Get-Command `
        -Name 'Start-CodexLocalRemoteRegisteredTask' `
        -CommandType Function `
        -ErrorAction SilentlyContinue
    if ($null -eq $activationCommand) {
        throw 'The selected runtime has no transactional runtime activator.'
    }

    Start-CodexLocalRemoteRegisteredTask `
        -Name $Name `
        -ManagedDataDir $resolvedDataDir `
        -ManagedSidecarPort ([int]$Configuration.SidecarPort) `
        -ManagedBrokerPort ([int]$Configuration.BrokerPort) `
        -ManagedBrokerUpstreamPort (
            [int]$Configuration.BrokerUpstreamPort
        ) `
        -ManagedBasePath ([string]$Configuration.BasePath) `
        -ExpectedSelectedRuntimeVersionId (
            [string]$Runtime.CurrentVersionId
        ) `
        -ExpectedSelectedRuntimeRoot ([string]$Runtime.CurrentRoot) `
        -ExpectedSelectedManifestSha256 (
            [string]$Runtime.CurrentManifestSha256
        ) `
        -DesktopHandoffPreparation $DesktopHandoffPreparation `
        -AllowActiveTurns:$AllowActiveTurns
}

function Get-OnDemandPreparedTransportSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Runtime,

        [Parameter(Mandatory)]
        [object]$Configuration
    )

    $remoteState = Get-OnDemandRemoteState `
        -Runtime $Runtime `
        -BrokerPort ([int]$Configuration.BrokerPort)
    if ($remoteState -cne 'desktop-detached' -or
        $null -eq $script:onDemandLastReadiness) {
        throw (
            'Prepared transport is not one exact Desktop-detached ' +
            'infrastructure generation.'
        )
    }
    $receiptPath = Join-Path `
        $resolvedDataDir `
        'app-server-broker.json'
    $rawBefore =
        Get-Content -LiteralPath $receiptPath -Raw -Encoding utf8
    $receipt = $rawBefore |
        ConvertFrom-Json -Depth 20 -DateKind String -ErrorAction Stop
    $rawAfter =
        Get-Content -LiteralPath $receiptPath -Raw -Encoding utf8
    if ($rawBefore -cne $rawAfter -or
        [string]$receipt.Signature -cne
            'codex-local-remote/app-server-broker/v3' -or
        [int]$receipt.Version -ne 3 -or
        $null -eq $receipt.Sidecar -or
        -not (Test-NonNegativeInteger `
            -Value $receipt.Sidecar.ProcessId) -or
        [int]$receipt.Sidecar.ProcessId -le 0 -or
        [string]$receipt.RuntimeInvocationId -cne
            [string](
                $script:onDemandLastReadiness.runtimeInvocationId
            )) {
        throw 'Prepared transport receipt changed or lacks exact Sidecar identity.'
    }
    $sidecarProcess = Get-CimInstance `
        Win32_Process `
        -Filter "ProcessId = $([int]$receipt.Sidecar.ProcessId)" `
        -ErrorAction Stop
    $sidecarOwnership = Test-ManagedSidecarProcess `
        -CommandLine ([string]$sidecarProcess.CommandLine) `
        -ExecutablePath ([string]$sidecarProcess.ExecutablePath) `
        -ExpectedNodePath ([string]$receipt.NodePath) `
        -ExpectedSidecarCliPath (
            Join-Path `
                ([string]$Runtime.CurrentRoot) `
                'apps\sidecar\dist\cli.js'
        ) `
        -Port ([int]$Configuration.SidecarPort) `
        -BasePath ([string]$Configuration.BasePath) `
        -DataDir $resolvedDataDir
    if (-not [bool]$sidecarOwnership.IsManaged) {
        throw 'Prepared transport Sidecar process is not the exact managed owner.'
    }
    $sidecarCreation =
        Get-ProcessCreationIdentity `
            -CreationDate $sidecarProcess.CreationDate
    $sidecarHandle = Open-ProcessIdentityHandle `
        -ProcessId ([int]$sidecarProcess.ProcessId) `
        -ExpectedCreationDateUtcTicks (
            [long]$sidecarCreation.CreationDateUtcTicks
        ) `
        -ExpectedStartTimeUtcTicks (
            [long]$receipt.Sidecar.ProcessStartTimeUtcTicks
        )
    try {
        return [pscustomobject]@{
            RemoteState = $remoteState
            Readiness = $script:onDemandLastReadiness
            Receipt = $receipt
            SidecarProcessId = [int]$sidecarProcess.ProcessId
            SidecarStartTimeUtcTicks =
                [long]$sidecarHandle.StartTimeUtcTicks
        }
    } finally {
        $sidecarHandle.Process.Dispose()
    }
}

function Prepare-OnDemandSelectedRemoteRuntime {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Runtime,

        [Parameter(Mandatory)]
        [object]$Configuration,

        [Parameter(Mandatory)]
        [object]$StartupTask,

        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [object]$DesktopRoot,

        [Parameter(Mandatory)]
        [string]$DesktopExecutablePath
    )

    $null =
        Assert-OnDemandSelectedRemoteRuntimeActivationPreflight `
            -Runtime $Runtime `
            -Configuration $Configuration `
            -StartupTask $StartupTask `
            -Name $Name
    $ownership =
        Get-CodexLocalRemoteNativeDesktopOwnershipSnapshot `
            -DesktopExecutablePath $DesktopExecutablePath
    if ([int]$ownership.DesktopRootProcessId -ne
        [int]$DesktopRoot.ProcessId) {
        throw (
            'Desktop ownership changed between activation admission and ' +
            'infrastructure preparation.'
        )
    }
    $preparation =
        New-CodexLocalRemoteDesktopHandoffPreparation `
            -DataDir $resolvedDataDir `
            -RuntimeVersionId ([string]$Runtime.CurrentVersionId) `
            -RuntimeRoot ([string]$Runtime.CurrentRoot) `
            -ManifestSha256 (
                [string]$Runtime.CurrentManifestSha256
            ) `
            -Ownership $ownership
    try {
        $null = Set-OnDemandOpenDesiredRemote -Runtime $Runtime
        $script:remoteTaskStartAttemptedForOpen = $true
        Start-OnDemandSelectedRemoteRuntime `
            -Runtime $Runtime `
            -Configuration $Configuration `
            -Name $Name `
            -DesktopHandoffPreparation $preparation
        $null = Wait-OnDemandTaskState `
            -Name $Name `
            -ExpectedState 'Running' `
            -TimeoutSeconds 20
        $readyDeadline =
            [DateTime]::UtcNow.AddSeconds($ReadyWaitSeconds)
        do {
            Start-Sleep -Milliseconds 250
            $remoteState = Get-OnDemandRemoteState `
                -Runtime $Runtime `
                -BrokerPort ([int]$Configuration.BrokerPort)
            if ($remoteState -ceq 'desktop-detached') {
                break
            }
        } while ([DateTime]::UtcNow -lt $readyDeadline)
        if ($remoteState -cne 'desktop-detached') {
            throw (
                'Selected immutable runtime did not reach one exact ' +
                'Desktop-detached prepared state.'
            )
        }
        $transport =
            Get-OnDemandPreparedTransportSnapshot `
                -Runtime $Runtime `
                -Configuration $Configuration
        return Set-CodexLocalRemoteDesktopHandoffPreparationReady `
            -DataDir $resolvedDataDir `
            -Preparation $preparation `
            -Readiness $transport.Readiness `
            -SidecarProcessId $transport.SidecarProcessId
    } catch {
        $null =
            Complete-CodexLocalRemoteDesktopHandoffPreparation `
                -DataDir $resolvedDataDir `
                -Preparation $preparation `
                -Outcome 'prepare-failed'
        throw
    }
}

function Stop-OnDemandDesktopProcessGroup {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Preparation,

        [Parameter(Mandatory)]
        [string]$ExpectedDesktopPath
    )

    $expectedRootPath =
        [System.IO.Path]::GetFullPath($ExpectedDesktopPath)
    $expectedAppServerPath = [System.IO.Path]::GetFullPath(
        [string]$Preparation.DesktopAppServerExecutablePath
    )
    $allProcesses = @(
        Get-CimInstance Win32_Process -ErrorAction Stop
    )
    $root = @(
        $allProcesses |
            Where-Object {
                [int]$_.ProcessId -eq
                    [int]$Preparation.DesktopRootProcessId
            }
    )
    if ($root.Count -ne 1) {
        throw 'The prepared native Desktop root is no longer unique.'
    }
    Assert-OnDemandDesktopRootExecutable `
        -DesktopRoot $root[0] `
        -ExpectedDesktopPath $expectedRootPath
    $members = [System.Collections.Generic.List[object]]::new()
    $members.Add([pscustomobject]@{
        Process = $root[0]
        Kind = 'root'
    })
    foreach ($candidate in @(
        $allProcesses |
            Where-Object {
                [int]$_.ParentProcessId -eq
                    [int]$Preparation.DesktopRootProcessId
            }
    )) {
        $candidatePath = if ([string]::IsNullOrWhiteSpace(
            [string]$candidate.ExecutablePath
        )) {
            ''
        } else {
            [System.IO.Path]::GetFullPath(
                [string]$candidate.ExecutablePath
            )
        }
        if ([string]$candidate.Name -ieq 'ChatGPT.exe' -and
            [string]::Equals(
                $candidatePath,
                $expectedRootPath,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
            $members.Add([pscustomobject]@{
                Process = $candidate
                Kind = 'electron-child'
            })
            continue
        }
        if ([int]$candidate.ProcessId -eq
                [int]$Preparation.DesktopAppServerProcessId -and
            [string]$candidate.Name -ieq 'codex.exe' -and
            [string]::Equals(
                $candidatePath,
                $expectedAppServerPath,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
            $members.Add([pscustomobject]@{
                Process = $candidate
                Kind = 'desktop-app-server'
            })
        }
    }
    if (@(
        $members |
            Where-Object { [string]$_.Kind -ceq 'desktop-app-server' }
    ).Count -ne 1) {
        throw 'The prepared native Desktop app-server is no longer unique.'
    }

    $heldMembers = [System.Collections.Generic.List[object]]::new()
    try {
        foreach ($member in $members) {
            $creation = Get-ProcessCreationIdentity `
                -CreationDate $member.Process.CreationDate
            $handle = Open-ProcessIdentityHandle `
                -ProcessId ([int]$member.Process.ProcessId) `
                -ExpectedCreationDateUtcTicks (
                    [long]$creation.CreationDateUtcTicks
                )
            if ([string]$member.Kind -ceq 'root' -and
                [long]$handle.StartTimeUtcTicks -ne
                    [long]$Preparation.DesktopRootStartTimeUtcTicks) {
                $handle.Process.Dispose()
                throw 'The prepared Desktop root startup identity changed.'
            }
            if ([string]$member.Kind -ceq 'desktop-app-server' -and
                [long]$handle.StartTimeUtcTicks -ne
                    [long](
                        $Preparation.DesktopAppServerStartTimeUtcTicks
                    )) {
                $handle.Process.Dispose()
                throw 'The prepared Desktop app-server identity changed.'
            }
            $heldMembers.Add([pscustomobject]@{
                Kind = [string]$member.Kind
                IdentityHandle = $handle
            })
        }
        $rootHandle = @(
            $heldMembers |
                Where-Object { [string]$_.Kind -ceq 'root' }
        )[0].IdentityHandle
        $null = $rootHandle.Process.CloseMainWindow()
        $null = $rootHandle.Process.WaitForExit(
            $DesktopExitTimeoutSeconds * 1000
        )
        foreach ($member in @(
            $heldMembers |
                Sort-Object @{
                    Expression = {
                        if ([string]$_.Kind -ceq 'root') { 1 } else { 0 }
                    }
                }
        )) {
            $null = Stop-ProcessIdentityHandle `
                -IdentityHandle $member.IdentityHandle `
                -TimeoutMilliseconds 10000
        }
        foreach ($member in $heldMembers) {
            $member.IdentityHandle.Process.Refresh()
            if (-not $member.IdentityHandle.Process.HasExited) {
                throw (
                    'An exact prepared Desktop process remained after the ' +
                    'bounded close.'
                )
            }
        }
    } finally {
        foreach ($member in $heldMembers) {
            $member.IdentityHandle.Process.Dispose()
        }
    }
}

function Assert-OnDemandPreparedInfrastructureReadyForAttach {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Preparation,

        [Parameter(Mandatory)]
        [object]$Runtime,

        [Parameter(Mandatory)]
        [object]$Configuration,

        [Parameter(Mandatory)]
        [string]$Name
    )

    $current =
        Assert-OnDemandSelectedRuntimeUnchanged `
            -ExpectedRuntime $Runtime
    $task =
        Get-VerifiedOnDemandStartupTask `
            -Runtime $current `
            -Name $Name
    if ([string]$task.State -cne 'Running') {
        throw 'Prepared attach found that the selected task is no longer Running.'
    }
    $currentPreparation =
        Read-CodexLocalRemoteDesktopHandoffPreparation `
            -DataDir $resolvedDataDir `
            -ExpectedRuntimeVersionId (
                [string]$Preparation.RuntimeVersionId
            ) `
            -ExpectedRuntimeRoot ([string]$Preparation.RuntimeRoot) `
            -ExpectedManifestSha256 (
                [string]$Preparation.ManifestSha256
            ) `
            -RequireLiveOwnership
    if ($null -eq $currentPreparation -or
        [string]$currentPreparation.PreparationId -cne
            [string]$Preparation.PreparationId -or
        [string]$currentPreparation.Phase -cne 'ready') {
        throw 'Prepared attach receipt is no longer ready with its native owner.'
    }
    $transport =
        Get-OnDemandPreparedTransportSnapshot `
            -Runtime $current `
            -Configuration $Configuration
    if ([string]$transport.Readiness.runtimeInvocationId -cne
            [string]$currentPreparation.RuntimeInvocationId -or
        [int]$transport.Readiness.brokerProcessId -ne
            [int]$currentPreparation.BrokerProcessId -or
        [int]$transport.Readiness.upstreamProcessId -ne
            [int]$currentPreparation.UpstreamProcessId -or
        [int]$transport.SidecarProcessId -ne
            [int]$currentPreparation.SidecarProcessId) {
        throw 'Prepared attach infrastructure identity drifted before Desktop close.'
    }
    return [pscustomobject]@{
        Runtime = $current
        Preparation = $currentPreparation
        Transport = $transport
    }
}

function Assert-OnDemandPreparedInfrastructureStillExact {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Preparation,

        [Parameter(Mandatory)]
        [object]$Runtime,

        [Parameter(Mandatory)]
        [object]$Configuration,

        [Parameter(Mandatory)]
        [string]$Name
    )

    $current =
        Assert-OnDemandSelectedRuntimeUnchanged `
            -ExpectedRuntime $Runtime
    $task =
        Get-VerifiedOnDemandStartupTask `
            -Runtime $current `
            -Name $Name
    if ([string]$task.State -cne 'Running') {
        throw 'Prepared attach found that the selected task is no longer Running.'
    }
    $currentPreparation =
        Read-CodexLocalRemoteDesktopHandoffPreparation `
            -DataDir $resolvedDataDir `
            -ExpectedRuntimeVersionId (
                [string]$Preparation.RuntimeVersionId
            ) `
            -ExpectedRuntimeRoot ([string]$Preparation.RuntimeRoot) `
            -ExpectedManifestSha256 (
                [string]$Preparation.ManifestSha256
            )
    if ($null -eq $currentPreparation -or
        [string]$currentPreparation.PreparationId -cne
            [string]$Preparation.PreparationId -or
        [string]$currentPreparation.Phase -cne 'attaching') {
        throw 'Prepared attach receipt changed after Desktop close.'
    }
    $transport =
        Get-OnDemandPreparedTransportSnapshot `
            -Runtime $current `
            -Configuration $Configuration
    if ([string]$transport.Readiness.runtimeInvocationId -cne
            [string]$currentPreparation.RuntimeInvocationId -or
        [int]$transport.Readiness.brokerProcessId -ne
            [int]$currentPreparation.BrokerProcessId -or
        [int]$transport.Readiness.upstreamProcessId -ne
            [int]$currentPreparation.UpstreamProcessId -or
        [int]$transport.SidecarProcessId -ne
            [int]$currentPreparation.SidecarProcessId) {
        throw 'Prepared attach infrastructure identity drifted after Desktop close.'
    }
    return [pscustomobject]@{
        Runtime = $current
        Preparation = $currentPreparation
        Transport = $transport
    }
}

function Invoke-OnDemandPreparedAttach {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Preparation,

        [Parameter(Mandatory)]
        [object]$Runtime,

        [Parameter(Mandatory)]
        [object]$Configuration,

        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [string]$DesktopExecutablePath
    )

    $preClose =
        Assert-OnDemandPreparedInfrastructureReadyForAttach `
            -Preparation $Preparation `
            -Runtime $Runtime `
            -Configuration $Configuration `
            -Name $Name
    $attaching =
        Set-CodexLocalRemoteDesktopHandoffPreparationAttaching `
            -DataDir $resolvedDataDir `
            -Preparation $preClose.Preparation
    Stop-OnDemandDesktopProcessGroup `
        -Preparation $attaching `
        -ExpectedDesktopPath $DesktopExecutablePath
    $script:nativeDesktopWasClosedForOpen = $true
    $verified =
        Assert-OnDemandPreparedInfrastructureStillExact `
            -Preparation $attaching `
            -Runtime $preClose.Runtime `
            -Configuration $Configuration `
            -Name $Name
    $script:preparedAttachIntent =
        New-CodexDesktopOwnerIntent `
            -DataDir $resolvedDataDir `
            -TargetRuntimeVersionId (
                [string]$verified.Runtime.CurrentVersionId
            ) `
            -TargetRuntimeRoot (
                [string]$verified.Runtime.CurrentRoot
            )
    $readyDeadline =
        [DateTime]::UtcNow.AddSeconds($ReadyWaitSeconds)
    do {
        Start-Sleep -Milliseconds 250
        $remoteState = Get-OnDemandRemoteState `
            -Runtime $verified.Runtime `
            -BrokerPort ([int]$Configuration.BrokerPort)
        if ($remoteState -ceq 'ready') {
            break
        }
    } while ([DateTime]::UtcNow -lt $readyDeadline)
    if ($remoteState -cne 'ready') {
        throw (
            'The prepared attach published one owner intent, but the exact ' +
            'Remote lease did not become ready.'
        )
    }
    $null =
        Complete-CodexLocalRemoteDesktopHandoffPreparation `
            -DataDir $resolvedDataDir `
            -Preparation $verified.Preparation `
            -Outcome 'attached'
    return [pscustomobject]@{
        Status = 'ready'
        RemoteState = $remoteState
        DesktopRestarted = $true
        IntentId = [string]$script:preparedAttachIntent.IntentId
        RuntimeInvocationId =
            [string]$script:onDemandLastReadiness.runtimeInvocationId
    }
}

function Invoke-OnDemandPreparedAttachCompensation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Preparation,

        [Parameter(Mandatory)]
        [object]$Runtime,

        [Parameter(Mandatory)]
        [string]$DesktopExecutablePath
    )

    if ($null -ne $script:preparedAttachIntent) {
        $pending = Read-CodexDesktopOwnerIntent `
            -DataDir $resolvedDataDir `
            -ExpectedRuntimeVersionId (
                [string]$Runtime.CurrentVersionId
            ) `
            -ExpectedRuntimeRoot ([string]$Runtime.CurrentRoot)
        if ($null -ne $pending -and
            [string]$pending.IntentId -ceq
                [string]$script:preparedAttachIntent.IntentId) {
            Complete-CodexDesktopOwnerIntent `
                -DataDir $resolvedDataDir `
                -Intent $pending `
                -RuntimeInvocationId (
                    [string]$Preparation.RuntimeInvocationId
                ) `
                -Outcome 'attach-compensated'
        }
    }
    $null = Set-CodexLocalRemoteDesiredMode `
        -DataDir $resolvedDataDir `
        -Mode Native `
        -RuntimeVersionId ([string]$Runtime.CurrentVersionId) `
        -RuntimeRoot ([string]$Runtime.CurrentRoot)
    $desktopRoots = @(
        Get-CimInstance `
            Win32_Process `
            -Filter "Name = 'ChatGPT.exe'" `
            -ErrorAction Stop |
            Where-Object {
                [string]$_.CommandLine -notmatch
                    '(?i)(?:^|\s)--type='
            }
    )
    if ($desktopRoots.Count -gt 1) {
        throw 'Prepared attach compensation found ambiguous Desktop roots.'
    }
    $desktopRestored = $false
    $originalNativeRootStillPresent = $false
    if ($desktopRoots.Count -eq 1) {
        Assert-OnDemandDesktopRootExecutable `
            -DesktopRoot $desktopRoots[0] `
            -ExpectedDesktopPath $DesktopExecutablePath
        $rootCreation =
            Get-ProcessCreationIdentity `
                -CreationDate $desktopRoots[0].CreationDate
        $rootIdentityHandle =
            Open-ProcessIdentityHandle `
                -ProcessId ([int]$desktopRoots[0].ProcessId) `
                -ExpectedCreationDateUtcTicks (
                    [long]$rootCreation.CreationDateUtcTicks
                )
        try {
            $observedRootIdentityKey =
                Get-CodexDesktopOwnerRootIdentityKey `
                    -ProcessId ([int]$desktopRoots[0].ProcessId) `
                    -StartTimeUtcTicks (
                        [long]$rootIdentityHandle.StartTimeUtcTicks
                    ) `
                    -ExecutablePath $DesktopExecutablePath
        } finally {
            $rootIdentityHandle.Process.Dispose()
        }
        $originalNativeRootStillPresent = (
            $observedRootIdentityKey -ceq
                [string]$Preparation.DesktopRootIdentityKey
        )
        if (-not $originalNativeRootStillPresent) {
            Stop-OnDemandDesktopRoot `
                -DesktopRoot $desktopRoots[0] `
                -ExpectedDesktopPath $DesktopExecutablePath
            $desktopRoots = @(
                Get-CimInstance `
                    Win32_Process `
                    -Filter "Name = 'ChatGPT.exe'" `
                    -ErrorAction Stop |
                    Where-Object {
                        [string]$_.CommandLine -notmatch
                            '(?i)(?:^|\s)--type='
                    }
            )
            if ($desktopRoots.Count -ne 0) {
                throw (
                    'Prepared attach compensation could not establish zero ' +
                    'Desktop roots before native restore.'
                )
            }
        }
    }
    if (-not $originalNativeRootStillPresent) {
        Start-OnDemandNativeDesktop `
            -RuntimeRoot ([string]$Runtime.CurrentRoot) `
            -DesktopExecutablePath $DesktopExecutablePath
        $restoreDeadline =
            [DateTime]::UtcNow.AddSeconds($DesktopExitTimeoutSeconds)
        do {
            Start-Sleep -Milliseconds 250
            $desktopRoots = @(
                Get-CimInstance `
                    Win32_Process `
                    -Filter "Name = 'ChatGPT.exe'" `
                    -ErrorAction Stop |
                    Where-Object {
                        [string]$_.CommandLine -notmatch
                            '(?i)(?:^|\s)--type='
                    }
            )
            if ($desktopRoots.Count -eq 1) {
                Assert-OnDemandDesktopRootExecutable `
                    -DesktopRoot $desktopRoots[0] `
                    -ExpectedDesktopPath $DesktopExecutablePath
                $desktopRestored = $true
                break
            }
            if ($desktopRoots.Count -gt 1) {
                throw (
                    'Prepared attach compensation created ambiguous ' +
                    'Desktop roots.'
                )
            }
        } while ([DateTime]::UtcNow -lt $restoreDeadline)
        if (-not $desktopRestored) {
            throw (
                'Prepared attach compensation did not observe one native ' +
                'Desktop root within the bounded restore window.'
            )
        }
    }
    $null =
        Complete-CodexLocalRemoteDesktopHandoffPreparation `
            -DataDir $resolvedDataDir `
            -Preparation $Preparation `
            -Outcome 'attach-compensated'
    return [pscustomobject]@{
        Status = 'native-restored'
        DesktopRestored = $desktopRestored
    }
}

function Invoke-OnDemandOpenCompensation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Runtime,

        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$BrokerPort,

        [Parameter(Mandatory)]
        [string]$DesktopExecutablePath,

        [bool]$TaskStartAttempted
    )

    $taskStopped = $false
    $recoveryIntent = $null
    $compensationRuntime = $Runtime
    if ($TaskStartAttempted) {
        $compensationRuntime =
            Resolve-OnDemandOpenCompensationRuntime `
                -RequestedRuntime $Runtime
        $compensationTask = Get-VerifiedOnDemandStartupTask `
            -Runtime $compensationRuntime `
            -Name $Name
        if ([string]$compensationTask.State -cin @(
            'Running',
            'Queued'
        )) {
            $compensationRemoteState = Get-OnDemandRemoteState `
                -Runtime $compensationRuntime `
                -BrokerPort $BrokerPort
            $readinessVerifiedIdle = (
                $null -ne $script:onDemandLastReadiness -and
                $null -ne
                    $script:onDemandLastReadiness.PSObject.Properties[
                        'unknownCount'
                    ] -and
                $null -ne
                    $script:onDemandLastReadiness.PSObject.Properties[
                        'unsafeThreadCount'
                    ] -and
                (Test-NonNegativeInteger `
                    -Value $script:onDemandLastReadiness.unknownCount) -and
                (Test-NonNegativeInteger `
                    -Value $script:onDemandLastReadiness.unsafeThreadCount) -and
                [int]$script:onDemandLastReadiness.unknownCount -eq 0 -and
                [int]$script:onDemandLastReadiness.unsafeThreadCount -eq 0
            )
            if (-not $readinessVerifiedIdle) {
                # Missing, unverified, unknown-client, or active-work
                # readiness can never prove that stopping this generation is
                # safe. Keep it alive and reconnect Desktop to the same
                # verified selected or exact rollback runtime instead.
                if (-not (Test-OnDemandRuntimeIdentity `
                    -Runtime $compensationRuntime `
                    -ExpectedVersionId (
                        [string]$Runtime.CurrentVersionId
                    ) `
                    -ExpectedRoot ([string]$Runtime.CurrentRoot) `
                    -ExpectedManifestSha256 (
                        [string]$Runtime.CurrentManifestSha256
                    ))) {
                    $null =
                        Set-OnDemandOpenDesiredRemote `
                            -Runtime $compensationRuntime
                }
                $recoveryIntent = New-CodexDesktopOwnerIntent `
                    -DataDir $resolvedDataDir `
                    -TargetRuntimeVersionId (
                        [string]$compensationRuntime.CurrentVersionId
                    ) `
                    -TargetRuntimeRoot (
                        [string]$compensationRuntime.CurrentRoot
                    )
                return [pscustomobject]@{
                    Status = 'remote-recovery-requested'
                    RecoveryStatus = 'running-generation-preserved'
                    RecoveryReason = 'readiness-not-verified-idle'
                    RemoteState = $compensationRemoteState
                    TaskStopped = $false
                    DesktopRestored = $false
                    IntentId = [string]$recoveryIntent.IntentId
                }
            }

            # The task was demand-started by this Open attempt and has not
            # produced an active managed turn. Revalidate its immutable
            # binding above, then roll it back before restoring native mode.
            Stop-ScheduledTask `
                -TaskName $Name `
                -TaskPath '\' `
                -ErrorAction Stop
            $null = Wait-OnDemandTaskState `
                -Name $Name `
                -ExpectedState 'Ready' `
                -TimeoutSeconds 30
            $taskStopped = $true
        } elseif ([string]$compensationTask.State -cne 'Ready') {
            throw (
                "The demand-start task cannot be safely compensated from " +
                "state '$($compensationTask.State)'."
            )
        }
    }

    $desktopRoots = @(
        Get-CimInstance `
            Win32_Process `
            -Filter "Name = 'ChatGPT.exe'" `
            -ErrorAction Stop |
            Where-Object {
                [string]$_.CommandLine -notmatch
                    '(?i)(?:^|\s)--type='
            }
    )
    if ($desktopRoots.Count -gt 1) {
        throw (
            "Open compensation found $($desktopRoots.Count) Desktop roots; " +
            'refusing to duplicate or guess ownership.'
        )
    }
    if ($desktopRoots.Count -eq 1) {
        Assert-OnDemandDesktopRootExecutable `
            -DesktopRoot $desktopRoots[0] `
            -ExpectedDesktopPath $DesktopExecutablePath
        return [pscustomobject]@{
            Status = 'desktop-already-present'
            RemoteState = 'unknown'
            TaskStopped = $taskStopped
            DesktopRestored = $false
            IntentId = $null
        }
    }

    # Ensure that a failed task/launcher has drained its independent stdio
    # child before creating one native Desktop root.
    if ($taskStopped) {
        Wait-OnDemandDesktopDrain
    } elseif (@(Get-OnDemandIndependentStdioProcesses).Count -gt 0) {
        throw (
            'Open compensation found an independent stdio app-server; ' +
            'refusing to create a competing native Desktop owner.'
        )
    }
    Start-OnDemandNativeDesktop `
        -RuntimeRoot ([string]$compensationRuntime.CurrentRoot) `
        -DesktopExecutablePath $DesktopExecutablePath
    return [pscustomobject]@{
        Status = 'native-restored'
        RemoteState = 'inactive'
        TaskStopped = $taskStopped
        DesktopRestored = $true
        IntentId = $null
    }
}

function Wait-OnDemandTaskState {
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [ValidateSet('Ready', 'Running')]
        [string]$ExpectedState,

        [ValidateRange(1, 60)]
        [int]$TimeoutSeconds = 20
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 250
        $task = Get-ScheduledTask `
            -TaskName $Name `
            -TaskPath '\' `
            -ErrorAction Stop
        if ([string]$task.State -ceq $ExpectedState) {
            return $task
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Remote startup task did not enter ${ExpectedState}: $($task.State)"
}

function Set-OnDemandOpenDesiredRemote {
    param(
        [Parameter(Mandatory)]
        [object]$Runtime
    )

    $current = Get-CodexLocalRemoteDesiredMode `
        -DataDir $resolvedDataDir
    if ([string]$current.Mode -ceq 'Remote' -and
        [string]$current.IntentId -cmatch '^[a-f0-9]{32}$' -and
        [string]$current.RuntimeVersionId -ceq
            [string]$Runtime.CurrentVersionId -and
        (Test-OnDemandRuntimePathEqual `
            -Left ([string]$current.RuntimeRoot) `
            -Right ([string]$Runtime.CurrentRoot))) {
        $script:openDesiredModeIntentId = [string]$current.IntentId
        $script:openDesiredModeWasCreated = $false
        return $current
    }
    $receipt = Set-CodexLocalRemoteDesiredMode `
        -DataDir $resolvedDataDir `
        -Mode Remote `
        -RuntimeVersionId ([string]$Runtime.CurrentVersionId) `
        -RuntimeRoot ([string]$Runtime.CurrentRoot)
    $script:openDesiredModeIntentId = [string]$receipt.IntentId
    $script:openDesiredModeWasCreated = $true
    return $receipt
}

function Restore-OnDemandDesiredModeAfterOpenFailure {
    if (-not $script:openDesiredModeWasCreated -or
        [string]::IsNullOrWhiteSpace(
        $script:openDesiredModeIntentId
    ) -or $null -eq $script:desiredModeBeforeOpen) {
        return
    }
    $current =
        Get-CodexLocalRemoteDesiredMode `
            -DataDir $resolvedDataDir
    if ([string]$current.IntentId -cne
        $script:openDesiredModeIntentId) {
        return
    }
    $priorVersionId =
        [string]$script:desiredModeBeforeOpen.RuntimeVersionId
    $priorRuntimeRoot =
        [string]$script:desiredModeBeforeOpen.RuntimeRoot
    if ($priorVersionId -cnotmatch '^[a-f0-9]{64}$') {
        $priorVersionId = [string]$runtime.CurrentVersionId
    }
    if ([string]::IsNullOrWhiteSpace($priorRuntimeRoot)) {
        $priorRuntimeRoot = [string]$runtime.CurrentRoot
    }
    $null = Set-CodexLocalRemoteDesiredMode `
        -DataDir $resolvedDataDir `
        -Mode ([string]$script:desiredModeBeforeOpen.Mode) `
        -RuntimeVersionId $priorVersionId `
        -RuntimeRoot $priorRuntimeRoot
    $script:openDesiredModeIntentId = $null
    $script:openDesiredModeWasCreated = $false
}

try {
    try {
        $controlMutexTaken =
            $controlMutex.WaitOne([TimeSpan]::FromSeconds(30))
    } catch [System.Threading.AbandonedMutexException] {
        $controlMutexTaken = $true
    }
    if (-not $controlMutexTaken) {
        throw 'Timed out waiting for another Remote control operation.'
    }
    if ($DispatchDelaySeconds -gt 0) {
        Start-Sleep -Seconds $DispatchDelaySeconds
    }

    if ($Operation -cne 'Status') {
        Write-OnDemandHandoffStatus `
            -Status 'running' `
            -Stage 'identity-gate' `
            -Message 'Validating the current native Desktop owner.'
    }

    Import-Module `
        (Join-Path $PSScriptRoot 'CodexLocalRemote.Windows.psm1') `
        -Force
    $runtime = Get-CodexLocalRemoteCurrentRuntime -DataDir $resolvedDataDir
    if ($null -eq $runtime) {
        throw 'No selected immutable runtime.'
    }
    if ($expectedSelectionArguments[0]) {
        $actualExpectedRoot = [System.IO.Path]::GetFullPath(
            $ExpectedSelectedRuntimeRoot
        )
        if ([string]$runtime.CurrentVersionId -cne
                $ExpectedSelectedVersionId -or
            -not [string]::Equals(
                [System.IO.Path]::GetFullPath(
                    [string]$runtime.CurrentRoot
                ),
                $actualExpectedRoot,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -or
            [string]$runtime.CurrentManifestSha256 -cne
                $ExpectedSelectedManifestSha256) {
            throw 'The selected runtime changed after dispatcher verification.'
        }
    }
    $runtimeCheck = Test-CodexLocalRemoteRuntimeVersion `
        -RuntimeRoot $runtime.CurrentRoot `
        -ExpectedVersionId $runtime.CurrentVersionId
    if (-not $runtimeCheck.IsValid) {
        throw "Selected runtime invalid: $($runtimeCheck.Reason)"
    }

    Remove-Module CodexLocalRemote.Windows -Force
    Import-Module `
        (Join-Path `
            $runtime.CurrentRoot `
            'scripts\windows\CodexLocalRemote.Windows.psm1') `
        -Force
    $configuration =
        Get-CodexLocalRemoteManagedConfiguration -DataDir $resolvedDataDir
    if ($null -eq $configuration) {
        throw 'Managed configuration missing.'
    }
    if ($PSBoundParameters.ContainsKey('TaskName') -and
        $TaskName -cne [string]$configuration.TaskName) {
        throw 'Requested task name does not match managed configuration.'
    }
    $TaskName = [string]$configuration.TaskName
    $currentDesiredMode =
        Get-CodexLocalRemoteDesiredMode `
            -DataDir $resolvedDataDir
    if (-not [string]::IsNullOrWhiteSpace(
        $ExpectedDesiredModeIntentId
    )) {
        if ($Operation -cne 'Open' -or
            -not $AllowDesktopRestart) {
            throw (
                'A deferred desired-mode intent is valid only for one ' +
                'authorized Open operation.'
            )
        }
        if ([string]$currentDesiredMode.Mode -cne 'Remote' -or
            [string]$currentDesiredMode.IntentId -cne
                $ExpectedDesiredModeIntentId -or
            [string]$currentDesiredMode.RuntimeVersionId -cne
                [string]$runtime.CurrentVersionId -or
            -not [string]::Equals(
                [System.IO.Path]::GetFullPath(
                    [string]$currentDesiredMode.RuntimeRoot
                ),
                [System.IO.Path]::GetFullPath(
                    [string]$runtime.CurrentRoot
                ),
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
            throw 'The deferred Open authorization was cancelled or superseded.'
        }
    }
    if ($Operation -ceq 'Open') {
        $script:desiredModeBeforeOpen = $currentDesiredMode
    }

    $startupTask = Get-VerifiedOnDemandStartupTask `
        -Runtime $runtime `
        -Name $TaskName
    $packageRuntime = Resolve-CodexDesktopPackageStatusIdentity
    $expectedDesktopPath = [System.IO.Path]::GetFullPath(
        [string]$packageRuntime.DesktopExecutablePath
    )
    $desktopRoots = @(
        Get-CimInstance `
            Win32_Process `
            -Filter "Name = 'ChatGPT.exe'" `
            -ErrorAction Stop |
            Where-Object {
                [string]$_.CommandLine -notmatch
                    '(?i)(?:^|\s)--type='
            }
    )
    $independentAppServers = @(Get-OnDemandIndependentStdioProcesses)
    $remoteState = if ([string]$startupTask.State -ceq 'Running') {
        Get-OnDemandRemoteState `
            -Runtime $runtime `
            -BrokerPort ([int]$configuration.BrokerPort)
    } elseif ([string]$startupTask.State -ceq 'Ready') {
        'inactive'
    } else {
        'unverified'
    }
    $allowActiveRuntimeRestart = (
        $Operation -ceq 'Open' -and
        $AllowDesktopRestart -and
        $remoteState -ceq 'runtime-transition-busy' -and
        $desktopRoots.Count -eq 0
    )
    $decision = Get-OnDemandHandoffDecision `
        -TaskState ([string]$startupTask.State) `
        -RemoteState $remoteState `
        -DesktopRootCount $desktopRoots.Count `
        -IndependentStdioCount $independentAppServers.Count `
        -AllowDesktopRestart ([bool]$AllowDesktopRestart) `
        -DesiredMode ([string]$currentDesiredMode.Mode)

    if ($Operation -ceq 'Status') {
        $status = if ([string]$startupTask.State -ceq 'Queued') {
            'pending'
        } elseif ([string]$startupTask.State -ceq 'Ready') {
            'inactive'
        } elseif ($remoteState -ceq 'ready') {
            'active'
        } elseif ($remoteState -cin @(
            'desktop-detached',
            'background-repairable'
        )) {
            'degraded'
        } elseif ($remoteState -ceq 'runtime-transition') {
            'pending'
        } elseif ($remoteState -ceq 'runtime-transition-busy') {
            'pending'
        } else {
            'blocked'
        }
        [pscustomobject]@{
            Status = $status
            Operation = $Operation
            Decision = $decision
            TaskState = [string]$startupTask.State
            RemoteState = $remoteState
            DesktopRootCount = $desktopRoots.Count
            IndependentStdioCount = $independentAppServers.Count
            DesktopRestarted = $false
            TaskName = $TaskName
        }
        return
    }

    if ($Operation -ceq 'Close') {
        if ([string]$startupTask.State -cnotin @(
            'Ready',
            'Running',
            'Queued'
        )) {
            throw "Remote startup task cannot be closed from state '$($startupTask.State)'."
        }
        $null = Set-CodexLocalRemoteDesiredMode `
            -DataDir $resolvedDataDir `
            -Mode Native `
            -RuntimeVersionId ([string]$runtime.CurrentVersionId) `
            -RuntimeRoot ([string]$runtime.CurrentRoot)
        $closePreparation =
            Read-CodexLocalRemoteDesktopHandoffPreparation `
                -DataDir $resolvedDataDir `
                -ExpectedRuntimeVersionId (
                    [string]$runtime.CurrentVersionId
                ) `
                -ExpectedRuntimeRoot ([string]$runtime.CurrentRoot) `
                -ExpectedManifestSha256 (
                    [string]$runtime.CurrentManifestSha256
                ) `
                -RequireLiveOwnership
        if ($null -ne $closePreparation -and
            [string]$closePreparation.Phase -cin @(
                'requested',
                'ready'
            )) {
            $null =
                Complete-CodexLocalRemoteDesktopHandoffPreparation `
                    -DataDir $resolvedDataDir `
                    -Preparation $closePreparation `
                    -Outcome 'closed-by-user'
        }
        $desktopIntentPath =
            Get-CodexDesktopOwnerIntentPath `
                -DataDir $resolvedDataDir
        if (Test-Path -LiteralPath $desktopIntentPath -PathType Leaf) {
            $closeIntent = Read-CodexDesktopOwnerIntent `
                -DataDir $resolvedDataDir `
                -ExpectedRuntimeVersionId (
                    [string]$runtime.CurrentVersionId
                ) `
                -ExpectedRuntimeRoot (
                    [string]$runtime.CurrentRoot
                )
            if ($null -eq $closeIntent) {
                throw (
                    'Desktop owner intent is not the exact selected ' +
                    'runtime intent; public close is persisted but the ' +
                    'foreign intent was not removed.'
                )
            }
            Complete-CodexDesktopOwnerIntent `
                -DataDir $resolvedDataDir `
                -Intent $closeIntent `
                -RuntimeInvocationId $(if (
                    $null -ne $script:onDemandLastReadiness -and
                    [string](
                        $script:onDemandLastReadiness.runtimeInvocationId
                    ) -match '^[a-f0-9]{32}$'
                ) {
                    [string](
                        $script:onDemandLastReadiness.runtimeInvocationId
                    )
                } else {
                    '0' * 32
                }) `
                -Outcome 'closed-by-user'
        }
        if ([string]$startupTask.State -ceq 'Ready') {
            Write-OnDemandHandoffStatus `
                -Status 'already-native' `
                -Stage 'closed' `
                -Message (
                    'Remote is already stopped. Ordinary ChatGPT ' +
                    'launches remain native.'
                )
            [pscustomobject]@{
                Status = 'already-native'
                Operation = $Operation
                TaskState = [string]$startupTask.State
                RemoteState = 'inactive'
                DesktopRestarted = $false
                TaskName = $TaskName
            }
            return
        }
        $closeDeadline = [DateTime]::UtcNow.AddSeconds(20)
        do {
            Start-Sleep -Milliseconds 250
            $startupTask = Get-VerifiedOnDemandStartupTask `
                -Runtime $runtime `
                -Name $TaskName
            if ([string]$startupTask.State -ceq 'Ready') {
                break
            }
            $remoteState = Get-OnDemandRemoteState `
                -Runtime $runtime `
                -BrokerPort ([int]$configuration.BrokerPort)
            if ($null -ne $script:onDemandLastReadiness -and
                -not [bool](
                    $script:onDemandLastReadiness.sidecarConnected
                )) {
                break
            }
        } while ([DateTime]::UtcNow -lt $closeDeadline)
        if ([string]$startupTask.State -cne 'Ready' -and
            ($null -eq $script:onDemandLastReadiness -or
                [bool]$script:onDemandLastReadiness.sidecarConnected)) {
            throw (
                'The supervisor did not close the public Sidecar within ' +
                'the bounded close window; Broker and Desktop were preserved.'
            )
        }

        $closeStatus = if (
            [string]$startupTask.State -ceq 'Ready'
        ) {
            'native'
        } else {
            'native-pending-desktop-exit'
        }
        Write-OnDemandHandoffStatus `
            -Status $closeStatus `
            -Stage 'closed' `
            -Message (
                'Public Remote is closed. The current Codex Desktop and ' +
                'Broker remain untouched until Desktop exits naturally.'
            )
        [pscustomobject]@{
            Status = $closeStatus
            Operation = $Operation
            TaskState = [string]$startupTask.State
            RemoteState = 'inactive'
            DesktopRestarted = $false
            TaskName = $TaskName
        }
        return
    }

    if ([string]$startupTask.State -ceq 'Running' -and
        $remoteState -ceq 'desktop-detached' -and
        $desktopRoots.Count -eq 1) {
        $desktopHandoffPreparation =
            Read-CodexLocalRemoteDesktopHandoffPreparation `
                -DataDir $resolvedDataDir `
                -ExpectedRuntimeVersionId (
                    [string]$runtime.CurrentVersionId
                ) `
                -ExpectedRuntimeRoot ([string]$runtime.CurrentRoot) `
                -ExpectedManifestSha256 (
                    [string]$runtime.CurrentManifestSha256
                ) `
                -RequireLiveOwnership
        if ($null -ne $desktopHandoffPreparation -and
            [string]$desktopHandoffPreparation.Phase -ceq 'ready') {
            $null = Set-OnDemandOpenDesiredRemote -Runtime $runtime
            try {
                $verifiedReady =
                    Assert-OnDemandPreparedInfrastructureReadyForAttach `
                        -Preparation $desktopHandoffPreparation `
                        -Runtime $runtime `
                        -Configuration $configuration `
                        -Name $TaskName
            } catch {
                $readyFailure = $_
                try {
                    $null =
                        Complete-CodexLocalRemoteDesktopHandoffPreparation `
                            -DataDir $resolvedDataDir `
                            -Preparation $desktopHandoffPreparation `
                            -Outcome 'preclose-drift'
                } catch {
                    # Preserve the exact pre-close verification failure.
                }
                throw $readyFailure
            }
            $runtime = $verifiedReady.Runtime
            $desktopHandoffPreparation =
                $verifiedReady.Preparation
            if (-not $AllowDesktopRestart) {
                Write-OnDemandHandoffStatus `
                    -Status 'restart-required' `
                    -Stage 'prepared' `
                    -Message (
                        'Broker, Sidecar, task, pointer, and runtime are ' +
                        'prepared. Only the explicit Desktop attach remains.'
                    )
                [pscustomobject]@{
                    Status = 'restart-required'
                    Decision =
                        'desktop-restart-authorization-required'
                    Prepared = $true
                    PreparationId =
                        [string]$desktopHandoffPreparation.PreparationId
                    DesktopRestarted = $false
                    TaskName = $TaskName
                }
                return
            }
            try {
                $attachResult =
                    Invoke-OnDemandPreparedAttach `
                        -Preparation $desktopHandoffPreparation `
                        -Runtime $runtime `
                        -Configuration $configuration `
                        -Name $TaskName `
                        -DesktopExecutablePath $expectedDesktopPath
            } catch {
                $preparedAttachCompensationHandled = $true
                $null =
                    Invoke-OnDemandPreparedAttachCompensation `
                        -Preparation $desktopHandoffPreparation `
                        -Runtime $runtime `
                        -DesktopExecutablePath $expectedDesktopPath
                throw
            }
            Write-OnDemandHandoffStatus `
                -Status 'ready' `
                -Stage 'desktop-attach' `
                -Message (
                    'The prepared infrastructure accepted one exact ' +
                    'Desktop owner attach.'
                )
            [pscustomobject]@{
                Status = [string]$attachResult.Status
                Operation = $Operation
                Decision = 'prepared-attach'
                RemoteState = [string]$attachResult.RemoteState
                DesktopRestarted = $true
                IntentId = [string]$attachResult.IntentId
                TaskName = $TaskName
            }
            return
        }
    }

    if ($decision -ceq 'remote-lease-active') {
        $null = Set-OnDemandOpenDesiredRemote -Runtime $runtime
        Write-OnDemandHandoffStatus `
            -Status 'already-active' `
            -Stage 'remote-lease' `
            -Message 'Broker, Desktop, and Sidecar are already fully ready; no restart was requested.'
        [pscustomobject]@{
            Status = 'already-active'
            Decision = $decision
            RemoteState = $remoteState
            DesktopRestarted = $false
            TaskName = $TaskName
        }
        return
    }
    if ($decision -ceq 'remote-start-pending') {
        $null = Set-OnDemandOpenDesiredRemote -Runtime $runtime
        Write-OnDemandHandoffStatus `
            -Status 'pending' `
            -Stage 'remote-start' `
            -Message 'The demand-start task is queued but is not yet remotely ready.'
        [pscustomobject]@{
            Status = 'pending'
            Decision = $decision
            RemoteState = $remoteState
            DesktopRestarted = $false
            TaskName = $TaskName
        }
        return
    }
    if ($decision -ceq 'wait-background-recovery') {
        $null = Set-OnDemandOpenDesiredRemote -Runtime $runtime
        $recoveryDeadline =
            [DateTime]::UtcNow.AddSeconds($RecoveryWaitSeconds)
        do {
            Start-Sleep -Milliseconds 250
            $remoteState = Get-OnDemandRemoteState `
                -Runtime $runtime `
                -BrokerPort ([int]$configuration.BrokerPort)
            if ($remoteState -cne 'background-repairable') {
                break
            }
        } while ([DateTime]::UtcNow -lt $recoveryDeadline)
        if ($remoteState -ceq 'ready') {
            Write-OnDemandHandoffStatus `
                -Status 'repaired' `
                -Stage 'background-recovery' `
                -Message 'Background components recovered without a Desktop restart.'
            [pscustomobject]@{
                Status = 'repaired'
                Decision = 'background-recovered'
                RemoteState = $remoteState
                DesktopRestarted = $false
                TaskName = $TaskName
            }
            return
        }
        $decision = Get-OnDemandHandoffDecision `
            -TaskState ([string]$startupTask.State) `
            -RemoteState $remoteState `
            -DesktopRootCount $desktopRoots.Count `
            -IndependentStdioCount $independentAppServers.Count `
            -AllowDesktopRestart ([bool]$AllowDesktopRestart) `
            -DesiredMode Remote
        if ($decision -ceq 'wait-background-recovery') {
            Write-OnDemandHandoffStatus `
                -Status 'repair-pending' `
                -Stage 'background-recovery' `
                -Message 'Background recovery is still pending; no Desktop restart was attempted.'
            [pscustomobject]@{
                Status = 'repair-pending'
                Decision = $decision
                RemoteState = $remoteState
                DesktopRestarted = $false
                TaskName = $TaskName
            }
            return
        }
    }
    if ($decision -ceq 'request-active-lease-recovery' -and
        $desktopRoots.Count -eq 0) {
        $null = Set-OnDemandOpenDesiredRemote -Runtime $runtime
        $intent = New-CodexDesktopOwnerIntent `
            -DataDir $resolvedDataDir `
            -TargetRuntimeVersionId ([string]$runtime.CurrentVersionId) `
            -TargetRuntimeRoot ([string]$runtime.CurrentRoot)
        Write-OnDemandHandoffStatus `
            -Status 'repairing' `
            -Stage 'desktop-recovery' `
            -Message 'A fresh idempotent owner intent was published for the active Remote lease.'
        $recoveryDeadline =
            [DateTime]::UtcNow.AddSeconds($RecoveryWaitSeconds)
        do {
            Start-Sleep -Milliseconds 250
            $remoteState = Get-OnDemandRemoteState `
                -Runtime $runtime `
                -BrokerPort ([int]$configuration.BrokerPort)
            if ($remoteState -ceq 'ready') {
                break
            }
        } while ([DateTime]::UtcNow -lt $recoveryDeadline)
        if ($remoteState -ceq 'ready') {
            Write-OnDemandHandoffStatus `
                -Status 'repaired' `
                -Stage 'desktop-recovery' `
                -Message 'The active Remote lease reattached to the verified Broker.'
            [pscustomobject]@{
                Status = 'repaired'
                Decision = 'active-lease-recovered'
                RemoteState = $remoteState
                DesktopRestarted = ($desktopRoots.Count -eq 1)
                IntentId = [string]$intent.IntentId
                TaskName = $TaskName
            }
            return
        }
        Write-OnDemandHandoffStatus `
            -Status 'repair-pending' `
            -Stage 'desktop-recovery' `
            -Message 'The explicit recovery intent remains pending; Remote is not yet ready.'
        [pscustomobject]@{
            Status = 'repair-pending'
            Decision = $decision
            RemoteState = $remoteState
            DesktopRestarted = $false
            IntentId = [string]$intent.IntentId
            TaskName = $TaskName
        }
        return
    }
    if ($decision -ceq 'request-active-lease-recovery' -and
        $desktopRoots.Count -eq 1) {
        $decision = 'handoff-native-desktop-once'
    }
    if ($decision -ceq 'deferred-handoff-authorization-required') {
        $null = Set-OnDemandOpenDesiredRemote -Runtime $runtime
        Write-OnDemandHandoffStatus `
            -Status 'restart-required' `
            -Stage 'waiting-for-idle' `
            -Message (
                'The previous runtime is serving active turns. Explicit ' +
                'restart authority is required to queue one idle handoff.'
            )
        [pscustomobject]@{
            Status = 'restart-required'
            Operation = $Operation
            Decision = $decision
            RemoteState = $remoteState
            DesktopRestarted = $false
            TaskName = $TaskName
        }
        return
    }
    if ($decision -ceq 'defer-runtime-handoff') {
        $desiredMode =
            Set-OnDemandOpenDesiredRemote -Runtime $runtime
        $worker = Start-OnDemandDeferredRuntimeHandoff `
            -Runtime $runtime `
            -Configuration $configuration `
            -Name $TaskName `
            -DesiredModeIntentId ([string]$desiredMode.IntentId)
        Write-OnDemandHandoffStatus `
            -Status 'restart-deferred' `
            -Stage 'waiting-for-idle' `
            -Message (
                'One authorized runtime handoff is queued. The current ' +
                'product remains online until every observed turn is idle.'
            )
        [pscustomobject]@{
            Status = 'restart-deferred'
            Operation = $Operation
            Decision = $decision
            RemoteState = $remoteState
            DesktopRestarted = $false
            WorkerProcessId = [int]$worker.ProcessId
            WorkerStartTimeUtcTicks =
                [long]$worker.ProcessStartTimeUtcTicks
            WorkerAlreadyActive = [bool]$worker.AlreadyActive
            TaskName = $TaskName
        }
        return
    }
    if ($decision -ceq 'blocked-ambiguous-desktop-roots') {
        throw "Expected at most one native Desktop root, found $($desktopRoots.Count)."
    }
    if ($decision -ceq 'blocked-independent-stdio') {
        throw 'An independent stdio app-server exists without one unique Desktop root; refusing to guess ownership.'
    }
    if ($decision -ceq 'blocked-runtime-unverified') {
        throw 'The running task is not bound to one fully verified Broker readiness generation.'
    }
    if ($decision -ceq 'blocked-task-state') {
        throw "Remote startup task cannot be demand-started from state '$($startupTask.State)'."
    }
    if ($decision -cnotin @(
        'handoff-native-desktop-once',
        'start-without-desktop-restart',
        'desktop-restart-authorization-required'
    )) {
        throw "Remote activation has no safe path for decision '$decision'."
    }
    $startupTask = Get-VerifiedOnDemandStartupTask `
        -Runtime $runtime `
        -Name $TaskName
    if ([string]$startupTask.State -cnotin @(
        'Ready',
        'Running'
    )) {
        throw (
            'Remote activation task state changed after preflight; ' +
            'Desktop was preserved.'
        )
    }
    $runtime =
        Assert-OnDemandSelectedRuntimeUnchanged `
            -ExpectedRuntime $runtime
    if ($desktopRoots.Count -eq 1) {
        Write-OnDemandHandoffStatus `
            -Status 'running' `
            -Stage 'infrastructure-preparation' `
            -Message (
                'Preparing the exact selected Broker, Sidecar, task, and ' +
                'runtime identities while Desktop remains untouched.'
            )
        $desktopHandoffPreparation =
            Prepare-OnDemandSelectedRemoteRuntime `
                -Runtime $runtime `
                -Configuration $configuration `
                -StartupTask $startupTask `
                -Name $TaskName `
                -DesktopRoot $desktopRoots[0] `
                -DesktopExecutablePath $expectedDesktopPath
        try {
            $verifiedReady =
                Assert-OnDemandPreparedInfrastructureReadyForAttach `
                    -Preparation $desktopHandoffPreparation `
                    -Runtime $runtime `
                    -Configuration $configuration `
                    -Name $TaskName
        } catch {
            $readyFailure = $_
            try {
                $null =
                    Complete-CodexLocalRemoteDesktopHandoffPreparation `
                        -DataDir $resolvedDataDir `
                        -Preparation $desktopHandoffPreparation `
                        -Outcome 'preclose-drift'
            } catch {
                # Preserve the exact pre-close verification failure.
            }
            throw $readyFailure
        }
        $runtime = $verifiedReady.Runtime
        $desktopHandoffPreparation =
            $verifiedReady.Preparation
        if (-not $AllowDesktopRestart) {
            Write-OnDemandHandoffStatus `
                -Status 'restart-required' `
                -Stage 'prepared' `
                -Message (
                    'Infrastructure preparation passed with Desktop ' +
                    'unchanged. Explicit restart authority is still required.'
                )
            [pscustomobject]@{
                Status = 'restart-required'
                Operation = $Operation
                Decision =
                    'desktop-restart-authorization-required'
                Prepared = $true
                PreparationId =
                    [string]$desktopHandoffPreparation.PreparationId
                RemoteState = 'desktop-detached'
                DesktopRestarted = $false
                TaskName = $TaskName
            }
            return
        }
        Write-OnDemandHandoffStatus `
            -Status 'running' `
            -Stage 'desktop-attach' `
            -Message (
                'Infrastructure is immutable and ready. Beginning the ' +
                'attach-only Desktop handoff.'
            )
        try {
            $attachResult =
                Invoke-OnDemandPreparedAttach `
                    -Preparation $desktopHandoffPreparation `
                    -Runtime $runtime `
                    -Configuration $configuration `
                    -Name $TaskName `
                    -DesktopExecutablePath $expectedDesktopPath
        } catch {
            $preparedAttachCompensationHandled = $true
            $null =
                Invoke-OnDemandPreparedAttachCompensation `
                    -Preparation $desktopHandoffPreparation `
                    -Runtime $runtime `
                    -DesktopExecutablePath $expectedDesktopPath
            throw
        }
        Write-OnDemandHandoffStatus `
            -Status 'ready' `
            -Stage 'desktop-attach' `
            -Message (
                'Broker, Desktop, and Sidecar reached one verified ' +
                'prepared Remote lease.'
            )
        [pscustomobject]@{
            Status = [string]$attachResult.Status
            Operation = $Operation
            Decision = 'prepared-attach'
            RemoteState = [string]$attachResult.RemoteState
            DesktopRestarted = $true
            IntentId = [string]$attachResult.IntentId
            TaskName = $TaskName
        }
        return
    }

    $null =
        Assert-OnDemandSelectedRemoteRuntimeActivationPreflight `
            -Runtime $runtime `
            -Configuration $configuration `
            -StartupTask $startupTask `
            -Name $TaskName `
            -AllowActiveTurns:$allowActiveRuntimeRestart
    $null = Set-OnDemandOpenDesiredRemote -Runtime $runtime
    Write-OnDemandHandoffStatus `
        -Status 'running' `
        -Stage 'remote-start' `
        -Message 'Starting the selected immutable remote runtime.'
    $remoteTaskStartAttemptedForOpen = $true
    Start-OnDemandSelectedRemoteRuntime `
        -Runtime $runtime `
        -Configuration $configuration `
        -Name $TaskName `
        -DesktopHandoffPreparation $null `
        -AllowActiveTurns:$allowActiveRuntimeRestart
    $startupTask = Wait-OnDemandTaskState `
        -Name $TaskName `
        -ExpectedState 'Running' `
        -TimeoutSeconds 20
    $readyDeadline =
        [DateTime]::UtcNow.AddSeconds($ReadyWaitSeconds)
    do {
        Start-Sleep -Milliseconds 250
        $remoteState = Get-OnDemandRemoteState `
            -Runtime $runtime `
            -BrokerPort ([int]$configuration.BrokerPort)
        if ($remoteState -ceq 'ready') {
            break
        }
    } while ([DateTime]::UtcNow -lt $readyDeadline)

    $startStatus = if ($remoteState -ceq 'ready') {
        'ready'
    } else {
        'pending'
    }
    $startMessage = if ($remoteState -ceq 'ready') {
        'Broker, Desktop, and Sidecar reached one verified Remote lease.'
    } else {
        "The demand-start task is Running, but Remote readiness remains '$remoteState'."
    }
    Write-OnDemandHandoffStatus `
        -Status $startStatus `
        -Stage 'remote-start' `
        -Message $startMessage
    [pscustomobject]@{
        Status = $startStatus
        Operation = $Operation
        Decision = $decision
        RemoteState = $remoteState
        DesktopRestarted = $false
        TaskName = $TaskName
    }
} catch {
    $failure = $_
    $openFailureCompensation = $null
    $openFailureCompensationFailed = $false
    $nativeModeConfirmedAfterFailure = (
        $Operation -ceq 'Open' -and
        -not $nativeDesktopWasClosedForOpen
    )
    if ($Operation -ceq 'Open' -and
        $nativeDesktopWasClosedForOpen -and
        -not $preparedAttachCompensationHandled -and
        $null -ne $runtime -and
        -not [string]::IsNullOrWhiteSpace($expectedDesktopPath)) {
        try {
            $openFailureCompensation =
                Invoke-OnDemandOpenCompensation `
                -Runtime $runtime `
                -Name $TaskName `
                -BrokerPort ([int]$configuration.BrokerPort) `
                -DesktopExecutablePath $expectedDesktopPath `
                -TaskStartAttempted $remoteTaskStartAttemptedForOpen
            $nativeModeConfirmedAfterFailure = (
                ([string]$openFailureCompensation.Status -ceq
                    'native-restored' -and
                    [bool]$openFailureCompensation.DesktopRestored) -or
                [string]$openFailureCompensation.Status -ceq
                    'desktop-already-present'
            )
        } catch {
            # The primary Open failure remains authoritative. The bounded
            # compensation attempt is recorded by the final failed status.
            $openFailureCompensationFailed = $true
        }
    }
    $remoteGenerationPreserved = (
        $null -ne $openFailureCompensation -and
        [string]$openFailureCompensation.Status -ceq
            'remote-recovery-requested' -and
        [string]$openFailureCompensation.RecoveryStatus -ceq
            'running-generation-preserved'
    )
    if ($remoteGenerationPreserved) {
        $failure.Exception.Data[
            'CodexLocalRemote.RecoveryStatus'
        ] = [string]$openFailureCompensation.RecoveryStatus
        $failure.Exception.Data[
            'CodexLocalRemote.RecoveryReason'
        ] = [string]$openFailureCompensation.RecoveryReason
        $failure.Exception.Data[
            'CodexLocalRemote.RecoveryIntentId'
        ] = [string]$openFailureCompensation.IntentId
        $failure.Exception.Data[
            'CodexLocalRemote.TaskStopped'
        ] = [bool]$openFailureCompensation.TaskStopped
    }
    if ($Operation -ceq 'Open' -and
        $nativeModeConfirmedAfterFailure -and
        -not $remoteGenerationPreserved) {
        try {
            Restore-OnDemandDesiredModeAfterOpenFailure
        } catch {
            # Preserve the primary Open failure.
        }
    }
    if ($Operation -cne 'Status') {
        try {
            $failureStatus = if ($remoteGenerationPreserved) {
                'repair-pending'
            } else {
                'failed'
            }
            $failureStage = if ($remoteGenerationPreserved) {
                'open-compensation'
            } else {
                'handoff'
            }
            $failureCode = if ($remoteGenerationPreserved) {
                'running-generation-preserved'
            } elseif ($openFailureCompensationFailed) {
                'open-compensation-failed'
            } else {
                'control-operation-failed'
            }
            $failureMessage = if ($remoteGenerationPreserved) {
                'The started Remote generation and its recovery intent remain active because readiness was not verified idle.'
            } else {
                'The Remote control operation failed. ' +
                    'No exception text, path, endpoint, or token was persisted.'
            }
            Write-OnDemandHandoffStatus `
                -Status $failureStatus `
                -Stage $failureStage `
                -Code $failureCode `
                -Message $failureMessage
        } catch {
            # Preserve the original handoff failure.
        }
    }
    throw $failure
} finally {
    if ($controlMutexTaken) {
        try {
            $controlMutex.ReleaseMutex()
        } catch [System.ApplicationException] {
            # An abandoned owner is still safe to dispose.
        }
    }
    $controlMutex.Dispose()
}
