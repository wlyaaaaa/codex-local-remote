[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexLocalRemote'),

    [ValidateRange(1, 65535)]
    [int]$BrokerPort = 18791,

    [string]$TaskName = 'Codex Local Remote',

    [switch]$WaitForNaturalDesktopExit,

    [ValidateRange(1, 1440)]
    [int]$IdleWaitTimeoutMinutes = 360,

    [ValidateRange(1, 60)]
    [int]$DesktopShutdownTimeoutSeconds = 20,

    [ValidateRange(1, 30)]
    [int]$DisconnectDelaySeconds = 5,

    [ValidateRange(10, 600)]
    [int]$VerificationTimeoutSeconds = 180,

    [ValidatePattern('^[a-f0-9]{64}$')]
    [string]$ExpectedSelectedVersionId,

    [string]$ExpectedSelectedRuntimeRoot,

    [switch]$InvokeInstalledControl,

    [ValidatePattern('^[a-f0-9]{32}$')]
    [string]$ExpectedDesiredModeIntentId,

    [string]$PublicReadyUrl,

    [Parameter(DontShow)]
    [switch]$DefinitionOnly
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'CodexLocalRemote.Windows.psm1') -Force

function Get-DeferredHandoffWorkerMutexName {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $identity = [System.IO.Path]::GetFullPath($DataDir).ToUpperInvariant()
    $identityHash = Get-StringSha256 -Value $identity
    return "Global\CodexLocalRemote.DeferredHandoff.$identityHash"
}

function Get-DeferredHandoffWorkerClaimPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    return Join-Path `
        ([System.IO.Path]::GetFullPath($DataDir)) `
        'deferred-handoff-worker.json'
}

function Write-DeferredHandoffWorkerClaim {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter(Mandatory)]
        [ValidatePattern('^[a-f0-9]{32}$')]
        [string]$ClaimId,

        [Parameter(Mandatory)]
        [ValidatePattern('^[a-f0-9]{32}$')]
        [string]$DesiredModeIntentId,

        [Parameter(Mandatory)]
        [ValidatePattern('^[a-f0-9]{64}$')]
        [string]$RuntimeVersionId,

        [Parameter(Mandatory)]
        [string]$RuntimeRoot
    )

    $workerProcess = Get-Process -Id $PID -ErrorAction Stop
    try {
        $processStartTimeUtcTicks =
            $workerProcess.StartTime.ToUniversalTime().Ticks
        Write-AtomicJsonFile -Path $Path -Value ([ordered]@{
            Signature = 'codex-local-remote/deferred-handoff-worker/v1'
            Version = 1
            ClaimId = $ClaimId
            DesiredModeIntentId = $DesiredModeIntentId
            RuntimeVersionId = $RuntimeVersionId
            RuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
            ProcessId = $PID
            ProcessStartTimeUtcTicks = $processStartTimeUtcTicks
            RecordedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        })
    } finally {
        $workerProcess.Dispose()
    }
}

function Remove-DeferredHandoffWorkerClaim {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter(Mandatory)]
        [ValidatePattern('^[a-f0-9]{32}$')]
        [string]$ExpectedClaimId
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return
    }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        ($item.Attributes -band
            [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [long]$item.Length -lt 2 -or
        [long]$item.Length -gt 131072) {
        return
    }
    try {
        $claim = Get-Content `
            -LiteralPath $Path `
            -Raw `
            -Encoding utf8 `
            -ErrorAction Stop |
            ConvertFrom-Json -Depth 10 -DateKind String -ErrorAction Stop
    } catch {
        return
    }
    if ([string]$claim.Signature -cne
            'codex-local-remote/deferred-handoff-worker/v1' -or
        [int]$claim.Version -ne 1 -or
        [string]$claim.ClaimId -cne $ExpectedClaimId) {
        return
    }
    Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
}

function Test-DeferredHandoffDesiredModeIntent {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$DesiredMode,

        [Parameter(Mandatory)]
        [ValidatePattern('^[a-f0-9]{32}$')]
        [string]$ExpectedIntentId,

        [Parameter(Mandatory)]
        [ValidatePattern('^[a-f0-9]{64}$')]
        [string]$ExpectedVersionId,

        [Parameter(Mandatory)]
        [string]$ExpectedRoot
    )

    if ($null -eq $DesiredMode -or
        [string]$DesiredMode.Mode -cne 'Remote' -or
        [string]$DesiredMode.IntentId -cne $ExpectedIntentId -or
        [string]$DesiredMode.RuntimeVersionId -cne $ExpectedVersionId) {
        return $false
    }
    return Test-DeferredHandoffPathEqual `
        -Left ([string]$DesiredMode.RuntimeRoot) `
        -Right $ExpectedRoot
}

function Test-DeferredHandoffCurrentDesiredModeIntent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [ValidatePattern('^[a-f0-9]{32}$')]
        [string]$ExpectedIntentId,

        [Parameter(Mandatory)]
        [ValidatePattern('^[a-f0-9]{64}$')]
        [string]$ExpectedVersionId,

        [Parameter(Mandatory)]
        [string]$ExpectedRoot
    )

    try {
        $desiredMode = Get-CodexLocalRemoteDesiredMode -DataDir $DataDir
    } catch {
        return $false
    }
    return Test-DeferredHandoffDesiredModeIntent `
        -DesiredMode $desiredMode `
        -ExpectedIntentId $ExpectedIntentId `
        -ExpectedVersionId $ExpectedVersionId `
        -ExpectedRoot $ExpectedRoot
}

function Enter-DeferredHandoffWorkerMutex {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [ValidateRange(0, 60000)]
        [int]$TimeoutMilliseconds = 0
    )

    $mutex = [System.Threading.Mutex]::new(
        $false,
        (Get-DeferredHandoffWorkerMutexName -DataDir $DataDir)
    )
    $lockTaken = $false
    try {
        try {
            $lockTaken = $mutex.WaitOne(
                [TimeSpan]::FromMilliseconds($TimeoutMilliseconds)
            )
        } catch [System.Threading.AbandonedMutexException] {
            $lockTaken = $true
        }
        if (-not $lockTaken) {
            throw (
                'Another deferred handoff worker already owns this DataDir; ' +
                'refusing to run a duplicate worker.'
            )
        }
        return $mutex
    } catch {
        if ($lockTaken) {
            $mutex.ReleaseMutex()
        }
        $mutex.Dispose()
        throw
    }
}

function Test-DeferredHandoffPathEqual {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Left,

        [Parameter(Mandatory)]
        [string]$Right
    )

    try {
        $resolvedLeft = [System.IO.Path]::TrimEndingDirectorySeparator(
            [System.IO.Path]::GetFullPath($Left)
        )
        $resolvedRight = [System.IO.Path]::TrimEndingDirectorySeparator(
            [System.IO.Path]::GetFullPath($Right)
        )
        return [string]::Equals(
            $resolvedLeft,
            $resolvedRight,
            [System.StringComparison]::OrdinalIgnoreCase
        )
    } catch {
        return $false
    }
}

function Get-DeferredHandoffLaunchReceiptObservation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject]@{
            IsValid = $false
            CorrelationId = $null
            RecordedAtUtc = $null
        }
    }
    try {
        $receipt = Get-Content `
            -LiteralPath $Path `
            -Raw `
            -Encoding utf8 |
            ConvertFrom-Json -Depth 10 -DateKind String
        if ([string]$receipt.Signature -cne
                'codex-local-remote/desktop-launch/v2' -or
            [int]$receipt.Version -ne 2 -or
            [string]$receipt.CorrelationId -cnotmatch '^[0-9a-f]{32}$') {
            throw 'The launch receipt identity is invalid.'
        }
        $recordedAtUtc = [DateTimeOffset]::Parse(
            [string]$receipt.RecordedAtUtc,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
        return [pscustomobject]@{
            IsValid = $true
            CorrelationId = [string]$receipt.CorrelationId
            RecordedAtUtc = $recordedAtUtc
        }
    } catch {
        return [pscustomobject]@{
            IsValid = $false
            CorrelationId = $null
            RecordedAtUtc = $null
        }
    }
}

function Test-DeferredHandoffVerificationCandidate {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$CurrentRuntime,

        [AllowNull()]
        [object]$BrokerReceipt,

        [AllowNull()]
        [object]$LaunchReceipt,

        [Parameter(Mandatory)]
        [string]$ExpectedVersionId,

        [Parameter(Mandatory)]
        [string]$ExpectedRoot,

        [Parameter(Mandatory)]
        [DateTimeOffset]$LaunchStartedAt,

        [Parameter(Mandatory)]
        [ValidatePattern('^[0-9a-f]{32}$')]
        [string]$ExpectedCorrelationId,

        [Parameter(Mandatory)]
        [object]$Baseline
    )

    if ($null -eq $CurrentRuntime -or
        [string]$CurrentRuntime.CurrentVersionId -cne $ExpectedVersionId -or
        -not (Test-DeferredHandoffPathEqual `
            -Left ([string]$CurrentRuntime.CurrentRoot) `
            -Right $ExpectedRoot)) {
        return [pscustomobject]@{
            IsValid = $false
            Reason = 'expected-runtime-mismatch'
        }
    }
    $expectedBrokerCli = [System.IO.Path]::GetFullPath(
        (Join-Path $ExpectedRoot 'apps\broker\dist\cli.js')
    )
    if ($null -eq $BrokerReceipt -or
        -not (Test-DeferredHandoffPathEqual `
            -Left ([string]$BrokerReceipt.BrokerCliPath) `
            -Right $expectedBrokerCli)) {
        return [pscustomobject]@{
            IsValid = $false
            Reason = 'expected-broker-root-mismatch'
        }
    }
    if ($null -eq $LaunchReceipt -or
        [string]$LaunchReceipt.Signature -cne
            'codex-local-remote/desktop-launch/v2' -or
        [int]$LaunchReceipt.Version -ne 2 -or
        $LaunchReceipt.RemoteEnabled -ne $true -or
        [string]$LaunchReceipt.CorrelationId -cnotmatch
            '^[0-9a-f]{32}$') {
        return [pscustomobject]@{
            IsValid = $false
            Reason = 'launch-receipt-invalid'
        }
    }
    if ([string]$LaunchReceipt.CorrelationId -cne
        $ExpectedCorrelationId) {
        return [pscustomobject]@{
            IsValid = $false
            Reason = 'launch-receipt-correlation-mismatch'
        }
    }
    try {
        $recordedAtUtc = [DateTimeOffset]::Parse(
            [string]$LaunchReceipt.RecordedAtUtc,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
    } catch {
        return [pscustomobject]@{
            IsValid = $false
            Reason = 'launch-receipt-time-invalid'
        }
    }
    if ($recordedAtUtc -le $LaunchStartedAt) {
        return [pscustomobject]@{
            IsValid = $false
            Reason = 'launch-receipt-predates-launch'
        }
    }
    if ($Baseline.IsValid -and
        ([string]$LaunchReceipt.CorrelationId -ceq
            [string]$Baseline.CorrelationId -or
        $recordedAtUtc -le [DateTimeOffset]$Baseline.RecordedAtUtc)) {
        return [pscustomobject]@{
            IsValid = $false
            Reason = 'launch-receipt-not-new'
        }
    }
    return [pscustomobject]@{
        IsValid = $true
        Reason = 'verified'
        CorrelationId = [string]$LaunchReceipt.CorrelationId
        RecordedAtUtc = $recordedAtUtc
    }
}

function Get-CodexLocalRemoteDeferredHandoffDecision {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [bool]$BrokerReachable,

        [Parameter(Mandatory)]
        [bool]$DesktopConnected,

        [Parameter(Mandatory)]
        [ValidateRange(0, 2147483647)]
        [int]$DesktopProcessCount,

        [Parameter(Mandatory)]
        [bool]$SidecarConnected,

        [Parameter(Mandatory)]
        [ValidateRange(0, 2147483647)]
        [int]$UnsafeThreadCount
    )

    if (-not $BrokerReachable) {
        return 'wait-broker'
    }
    if ($UnsafeThreadCount -gt 0) {
        return 'wait-turns'
    }
    if ($DesktopConnected -or $DesktopProcessCount -gt 0) {
        return 'close-desktop'
    }
    return 'launch'
}

function Get-DeferredHandoffBrokerSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$Port
    )

    try {
        $ready = Invoke-RestMethod `
            -Method Get `
            -Uri "http://127.0.0.1:$Port/ready" `
            -TimeoutSec 3
    } catch {
        return [pscustomobject]@{
            BrokerReachable = $false
            DesktopConnected = $false
            SidecarConnected = $false
            UnsafeThreadCount = 0
        }
    }
    foreach ($property in @(
        'desktopConnected',
        'sidecarConnected',
        'unsafeThreadCount'
    )) {
        if ($null -eq $ready.PSObject.Properties[$property]) {
            throw "Broker readiness lacks '$property'; refusing deferred handoff."
        }
    }
    if ($ready.desktopConnected -isnot [bool] -or
        $ready.sidecarConnected -isnot [bool] -or
        -not (Test-NonNegativeInteger -Value $ready.unsafeThreadCount)) {
        throw 'Broker readiness has invalid handoff fields.'
    }
    return [pscustomobject]@{
        BrokerReachable = $true
        DesktopConnected = [bool]$ready.desktopConnected
        SidecarConnected = [bool]$ready.sidecarConnected
        UnsafeThreadCount = [int]$ready.unsafeThreadCount
    }
}

function Invoke-DeferredHandoffBrokerLifecycleReconciliation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$RuntimeRoot,

        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$Port,

        [ValidateRange(10, 120)]
        [int]$TimeoutSeconds = 45
    )

    $brokerCliPath = Join-Path `
        ([System.IO.Path]::GetFullPath($RuntimeRoot)) `
        'apps\broker\dist\cli.js'
    if (-not (Test-Path -LiteralPath $brokerCliPath -PathType Leaf)) {
        throw 'The selected runtime lacks the lifecycle reconciler.'
    }
    try {
        $nodePath = (Get-Command `
            node.exe `
            -CommandType Application `
            -ErrorAction Stop |
            Select-Object -First 1).Source
        $rawOutput = @(
            & $nodePath `
                $brokerCliPath `
                'reconcile' `
                '--data-dir' `
                ([System.IO.Path]::GetFullPath($DataDir)) `
                '--port' `
                ([string]$Port) `
                '--timeout-ms' `
                ([string]($TimeoutSeconds * 1000)) `
                2>$null
        )
        $exitCode = $LASTEXITCODE
    } catch {
        throw 'Broker lifecycle reconciliation could not be started.'
    }
    if ($exitCode -ne 0) {
        throw 'Broker lifecycle reconciliation did not complete.'
    }
    $lines = @(
        $rawOutput |
        ForEach-Object { [string]$_ } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
    if ($lines.Count -eq 0) {
        throw 'Broker lifecycle reconciliation returned no receipt.'
    }
    try {
        $receipt = $lines[-1] |
            ConvertFrom-Json -Depth 10 -DateKind String -ErrorAction Stop
    } catch {
        throw 'Broker lifecycle reconciliation returned an invalid receipt.'
    }
    if ([string]$receipt.Signature -cne
            'codex-local-remote/broker-lifecycle-reconciliation/v1' -or
        [int]$receipt.Version -ne 1 -or
        [string]$receipt.Status -cne 'reconciled' -or
        $receipt.HasMore -isnot [bool] -or
        [bool]$receipt.HasMore -or
        -not (Test-NonNegativeInteger -Value $receipt.ObservedThreadCount) -or
        -not (Test-NonNegativeInteger -Value $receipt.ResumedThreadCount) -or
        [int64]$receipt.ResumedThreadCount -ne
            [int64]$receipt.ObservedThreadCount) {
        throw 'Broker lifecycle reconciliation receipt failed validation.'
    }
    return [pscustomobject]@{
        ObservedThreadCount = [int]$receipt.ObservedThreadCount
        ResumedThreadCount = [int]$receipt.ResumedThreadCount
    }
}

function Get-DeferredHandoffDesktopProcesses {
    [CmdletBinding()]
    param()

    return @(
        Get-CimInstance `
            Win32_Process `
            -Filter "Name = 'ChatGPT.exe'" `
            -ErrorAction Stop |
            Where-Object {
                $path = [string]$_.ExecutablePath
                [string]::IsNullOrWhiteSpace($path) -or
                $path -match
                    '(?i)\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$'
            }
    )
}

function Wait-DeferredHandoffNaturalDesktopExit {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$Port,

        [Parameter(Mandatory)]
        [DateTime]$Deadline,

        [ValidateRange(2, 10)]
        [int]$RequiredConsecutiveZeroObservations = 2,

        [ValidateRange(1, 60000)]
        [int]$PollIntervalMilliseconds = 500
    )

    $consecutiveZeroObservations = 0
    $lastDesktopProcessCount = -1
    $lastBrokerReachable = $false
    $lastUnsafeThreadCount = -1
    do {
        $desktopProcesses = @(Get-DeferredHandoffDesktopProcesses)
        $broker = Get-DeferredHandoffBrokerSnapshot -Port $Port
        $lastDesktopProcessCount = $desktopProcesses.Count
        $lastBrokerReachable = [bool]$broker.BrokerReachable
        $lastUnsafeThreadCount = [int]$broker.UnsafeThreadCount
        if ($lastDesktopProcessCount -eq 0 -and
            $lastBrokerReachable -and
            $lastUnsafeThreadCount -eq 0) {
            $consecutiveZeroObservations++
            if ($consecutiveZeroObservations -ge
                $RequiredConsecutiveZeroObservations) {
                return [pscustomobject]@{
                    ConsecutiveZeroObservations = (
                        $consecutiveZeroObservations
                    )
                    BrokerReachable = $lastBrokerReachable
                    UnsafeThreadCount = $lastUnsafeThreadCount
                }
            }
        } else {
            $consecutiveZeroObservations = 0
        }
        if ([DateTime]::UtcNow -ge $Deadline) {
            break
        }
        Start-Sleep -Milliseconds $PollIntervalMilliseconds
    } while ([DateTime]::UtcNow -lt $Deadline)

    throw (
        'Timed out waiting for Desktop to exit naturally with two ' +
        'consecutive zero-process observations and an idle Broker ' +
        "(desktopProcessCount=$lastDesktopProcessCount, " +
        "brokerReachable=$lastBrokerReachable, " +
        "unsafeThreadCount=$lastUnsafeThreadCount); no launch was attempted."
    )
}

function Assert-DeferredHandoffDesktopStopped {
    [CmdletBinding()]
    param()

    $remaining = @(Get-DeferredHandoffDesktopProcesses)
    if ($remaining.Count -eq 0) {
        return
    }
    $processIds = @(
        $remaining |
            ForEach-Object {
                [string]$_.ProcessId
            }
    ) -join ', '
    throw (
        'Desktop remains running after the authorized shutdown window ' +
        "(process IDs: $processIds); refusing to launch another instance."
    )
}

function Stop-DeferredHandoffDesktopImmediately {
    [CmdletBinding()]
    param(
        [ValidateRange(1, 60)]
        [int]$TimeoutSeconds = 20
    )

    foreach ($desktop in @(Get-DeferredHandoffDesktopProcesses)) {
        $process = Get-Process `
            -Id ([int]$desktop.ProcessId) `
            -ErrorAction SilentlyContinue
        if ($null -ne $process) {
            try {
                if ($process.MainWindowHandle -ne 0) {
                    $null = $process.CloseMainWindow()
                }
            } finally {
                $process.Dispose()
            }
        }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 250
        $remaining = @(Get-DeferredHandoffDesktopProcesses)
    } while ($remaining.Count -gt 0 -and
        [DateTime]::UtcNow -lt $deadline)
    foreach ($desktop in $remaining) {
        Stop-Process `
            -Id ([int]$desktop.ProcessId) `
            -Force `
            -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 250
    Assert-DeferredHandoffDesktopStopped
}

function Assert-DeferredHandoffNaturalLaunchBarrier {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$Port
    )

    Assert-DeferredHandoffDesktopStopped
    $broker = Get-DeferredHandoffBrokerSnapshot -Port $Port
    if (-not $broker.BrokerReachable) {
        throw (
            'The Broker became unreachable after Desktop exited naturally; ' +
            'refusing to launch.'
        )
    }
    if ($broker.DesktopConnected) {
        throw (
            'The Broker still reports Desktop connected after the natural ' +
            'disconnect delay; refusing to launch.'
        )
    }
    if ([int]$broker.UnsafeThreadCount -ne 0) {
        throw (
            'The Broker reported an unsafe thread after Desktop exited ' +
            'naturally; refusing to launch.'
        )
    }
}

function Write-DeferredHandoffReceipt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter(Mandatory)]
        [string]$Status,

        [Parameter(Mandatory)]
        [string]$Message,

        [Parameter(Mandatory)]
        [string]$SelectedRoot,

        [hashtable]$Extra = @{}
    )

    $value = [ordered]@{
        Signature = 'codex-local-remote/deferred-handoff/v1'
        Version = 1
        Status = $Status
        Message = $Message
        SelectedRoot = $SelectedRoot
        RecordedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    }
    foreach ($key in @($Extra.Keys | Sort-Object)) {
        $value[$key] = $Extra[$key]
    }
    Write-AtomicJsonFile -Path $Path -Value $value
}

function Get-ReadyStatusCode {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Url
    )

    try {
        return [int](
            Invoke-WebRequest `
                -Uri $Url `
                -UseBasicParsing `
                -TimeoutSec 15
        ).StatusCode
    } catch {
        if ($null -ne $_.Exception.Response) {
            return [int]$_.Exception.Response.StatusCode
        }
        return 0
    }
}

if (-not $DefinitionOnly) {
    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
    $managedConfiguration = Get-CodexLocalRemoteManagedConfiguration `
        -DataDir $resolvedDataDir
    if ($null -eq $managedConfiguration) {
        throw 'The managed runtime configuration is missing.'
    }
    if (-not $PSBoundParameters.ContainsKey('BrokerPort')) {
        $BrokerPort = [int]$managedConfiguration.BrokerPort
    }
    if (-not $PSBoundParameters.ContainsKey('TaskName')) {
        $TaskName = [string]$managedConfiguration.TaskName
    }
    $selected = Get-CodexLocalRemoteCurrentRuntime -DataDir $resolvedDataDir
    if ($null -eq $selected) {
        throw 'No selected immutable runtime is registered.'
    }
    $expectedVersionId = [string]$selected.CurrentVersionId
    if ($expectedVersionId -cnotmatch '^[0-9a-f]{64}$') {
        throw 'The selected immutable runtime version ID is invalid.'
    }
    $selectedRoot = [System.IO.Path]::GetFullPath(
        [string]$selected.CurrentRoot
    )
    $expectedSelectionArguments = @(
        -not [string]::IsNullOrWhiteSpace($ExpectedSelectedVersionId),
        -not [string]::IsNullOrWhiteSpace($ExpectedSelectedRuntimeRoot)
    )
    if (@($expectedSelectionArguments | Where-Object { $_ }).Count -notin @(0, 2)) {
        throw 'Expected selected runtime identity must be supplied as one complete set.'
    }
    if ($InvokeInstalledControl -and
        (
            -not $expectedSelectionArguments[0] -or
            [string]::IsNullOrWhiteSpace($ExpectedDesiredModeIntentId)
        )) {
        throw (
            'Installed-control deferral requires one complete selected ' +
            'runtime identity and desired-mode intent.'
        )
    }
    if (-not $InvokeInstalledControl -and
        -not [string]::IsNullOrWhiteSpace(
            $ExpectedDesiredModeIntentId
        )) {
        throw 'ExpectedDesiredModeIntentId requires InvokeInstalledControl.'
    }
    if ($expectedSelectionArguments[0] -and
        (
            $expectedVersionId -cne $ExpectedSelectedVersionId -or
            -not (Test-DeferredHandoffPathEqual `
                -Left $selectedRoot `
                -Right $ExpectedSelectedRuntimeRoot)
        )) {
        throw 'The selected immutable runtime changed before the deferred worker started.'
    }
    $selectedValidation = Test-CodexLocalRemoteRuntimeVersion `
        -RuntimeRoot $selectedRoot
    if (-not $selectedValidation.IsValid) {
        throw "The selected immutable runtime is invalid: $($selectedValidation.Reason)."
    }
    if ([string]$selectedValidation.VersionId -cne $expectedVersionId) {
        throw 'The selected immutable runtime does not match its version pointer.'
    }
    $launcherPath = Join-Path $PSScriptRoot 'Launch-CodexWithRemote.ps1'
    if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
        throw "The runtime-bound Desktop launcher is missing at '$launcherPath'."
    }
    $receiptPath = Join-Path $resolvedDataDir 'deferred-handoff-last.json'
    $handoffMode = if ($WaitForNaturalDesktopExit) {
        'natural-exit'
    } else {
        'authorized-shutdown'
    }
    $targetDescription = if ($WaitForNaturalDesktopExit) {
        (
            'wait without closing Desktop until it exits naturally, then ' +
            "replace the active runtime with '$selectedRoot' and reopen Desktop"
        )
    } else {
        (
            "wait for every Broker-observed turn to become idle, then replace " +
            "the active runtime with '$selectedRoot' and reopen Desktop"
        )
    }
    if (-not $PSCmdlet.ShouldProcess(
        $targetDescription,
        'Complete one deferred immutable-runtime handoff'
    )) {
        return
    }

    $workerMutex = $null
    $workerClaimId = $null
    $workerClaimPath = Get-DeferredHandoffWorkerClaimPath `
        -DataDir $resolvedDataDir
    try {
        $workerMutex = Enter-DeferredHandoffWorkerMutex `
            -DataDir $resolvedDataDir
        if ($InvokeInstalledControl) {
            $workerClaimId = [guid]::NewGuid().ToString('N')
            Write-DeferredHandoffWorkerClaim `
                -Path $workerClaimPath `
                -ClaimId $workerClaimId `
                -DesiredModeIntentId $ExpectedDesiredModeIntentId `
                -RuntimeVersionId $expectedVersionId `
                -RuntimeRoot $selectedRoot
        }
        Write-DeferredHandoffReceipt `
            -Path $receiptPath `
            -Status 'waiting-for-idle' `
            -Message 'Waiting for every Broker-observed turn to become idle.' `
            -SelectedRoot $selectedRoot `
            -Extra @{
                DesiredModeIntentId = $ExpectedDesiredModeIntentId
                ExpectedVersionId = $expectedVersionId
                WorkerClaimId = $workerClaimId
            }
        if ($InvokeInstalledControl -and -not $WaitForNaturalDesktopExit) {
            Write-DeferredHandoffReceipt `
                -Path $receiptPath `
                -Status 'switching' `
                -Message (
                    'Explicit restart authority accepted; restarting the ' +
                    'product immediately even while turns are active.'
                ) `
                -SelectedRoot $selectedRoot `
                -Extra @{
                    DesiredModeIntentId = $ExpectedDesiredModeIntentId
                    ExpectedVersionId = $expectedVersionId
                    Mode = 'authorized-active-restart'
                    WorkerClaimId = $workerClaimId
                }
            $controlPath = Join-Path `
                $resolvedDataDir `
                'control\CodexLocalRemote.Control.ps1'
            if (-not (Test-Path -LiteralPath $controlPath -PathType Leaf)) {
                throw 'The stable installed Remote control dispatcher is missing.'
            }
            $operationResult = @(
                & $controlPath `
                    -Operation Open `
                    -DataDir $resolvedDataDir `
                    -AllowDesktopRestart `
                    -ExpectedDesiredModeIntentId (
                        $ExpectedDesiredModeIntentId
                    )
            )
            if ($operationResult.Count -ne 1 -or
                [string]$operationResult[0].Status -cnotin @(
                    'ready',
                    'repaired',
                    'already-active'
                ) -or
                [string]$operationResult[0].RemoteState -cne 'ready') {
                throw (
                    'The immediate installed control operation did not ' +
                    'adopt one ready selected runtime.'
                )
            }
            $localReady = Get-ReadyStatusCode `
                -Url (
                    'http://127.0.0.1:' +
                    [string]$managedConfiguration.SidecarPort +
                    [string]$managedConfiguration.BasePath +
                    '/api/v1/ready'
                )
            $publicReady = if ([string]::IsNullOrWhiteSpace(
                $PublicReadyUrl
            )) {
                $null
            } else {
                Get-ReadyStatusCode -Url $PublicReadyUrl
            }
            if ($localReady -ne 200 -or
                ($null -ne $publicReady -and $publicReady -ne 200)) {
                throw (
                    'The immediate installed control operation did not ' +
                    'pass its configured readiness checks.'
                )
            }
            Write-DeferredHandoffReceipt `
                -Path $receiptPath `
                -Status 'verified' `
                -Message (
                    'The stable dispatcher immediately adopted the selected ' +
                    'runtime while prior turns were active.'
                ) `
                -SelectedRoot $selectedRoot `
                -Extra @{
                    ExpectedVersionId = $expectedVersionId
                    Mode = 'authorized-active-restart'
                    OperationStatus =
                        [string]$operationResult[0].Status
                    LocalReady = $localReady
                    PublicReady = $publicReady
                }
            [pscustomobject]@{
                Status = 'verified'
                SelectedRoot = $selectedRoot
                LocalReady = $localReady
                PublicReady = $publicReady
                ReceiptPath = $receiptPath
            }
            return
        }
        $idleDeadline = [DateTime]::UtcNow.AddMinutes(
            $IdleWaitTimeoutMinutes
        )
        $decision = 'wait-broker'
        $reconciliationAttempts = 0
        $nextReconciliationAtUtc = [DateTime]::MinValue
        do {
            if ($InvokeInstalledControl -and
                -not (Test-DeferredHandoffCurrentDesiredModeIntent `
                    -DataDir $resolvedDataDir `
                    -ExpectedIntentId $ExpectedDesiredModeIntentId `
                    -ExpectedVersionId $expectedVersionId `
                    -ExpectedRoot $selectedRoot)) {
                Write-DeferredHandoffReceipt `
                    -Path $receiptPath `
                    -Status 'cancelled' `
                    -Message (
                        'The deferred Remote intent was cancelled or ' +
                        'superseded before the product became idle.'
                    ) `
                    -SelectedRoot $selectedRoot `
                    -Extra @{
                        DesiredModeIntentId = $ExpectedDesiredModeIntentId
                        ExpectedVersionId = $expectedVersionId
                        WorkerClaimId = $workerClaimId
                    }
                return
            }
            $broker = Get-DeferredHandoffBrokerSnapshot -Port $BrokerPort
            $desktopProcessCount = @(
                Get-DeferredHandoffDesktopProcesses
            ).Count
            $decision = Get-CodexLocalRemoteDeferredHandoffDecision `
                -BrokerReachable $broker.BrokerReachable `
                -DesktopConnected $broker.DesktopConnected `
                -DesktopProcessCount $desktopProcessCount `
                -SidecarConnected $broker.SidecarConnected `
                -UnsafeThreadCount $broker.UnsafeThreadCount
            if ($decision -ceq 'wait-turns' -and
                $InvokeInstalledControl -and
                $broker.DesktopConnected -and
                $broker.SidecarConnected -and
                $reconciliationAttempts -lt 3 -and
                [DateTime]::UtcNow -ge $nextReconciliationAtUtc) {
                $reconciliationAttempts += 1
                $nextReconciliationAtUtc = [DateTime]::UtcNow.AddSeconds(30)
                try {
                    $null =
                        Invoke-DeferredHandoffBrokerLifecycleReconciliation `
                            -RuntimeRoot $selectedRoot `
                            -DataDir $resolvedDataDir `
                            -Port $BrokerPort
                    $reconciliationAttempts = 3
                } catch {
                    # Fail closed: the authoritative idle decision remains with
                    # Broker readiness, and a bounded later attempt may retry.
                }
            }
            if ($decision -notin @('wait-broker', 'wait-turns')) {
                break
            }
            Start-Sleep -Seconds 2
        } while ([DateTime]::UtcNow -lt $idleDeadline)
        if ($decision -in @('wait-broker', 'wait-turns')) {
            throw 'The Broker did not reach a verifiable idle state before the deferred-handoff timeout.'
        }
        if ($InvokeInstalledControl -and
            -not (Test-DeferredHandoffCurrentDesiredModeIntent `
                -DataDir $resolvedDataDir `
                -ExpectedIntentId $ExpectedDesiredModeIntentId `
                -ExpectedVersionId $expectedVersionId `
                -ExpectedRoot $selectedRoot)) {
            Write-DeferredHandoffReceipt `
                -Path $receiptPath `
                -Status 'cancelled' `
                -Message (
                    'The deferred Remote intent was cancelled or superseded ' +
                    'before the runtime switch.'
                ) `
                -SelectedRoot $selectedRoot `
                -Extra @{
                    DesiredModeIntentId = $ExpectedDesiredModeIntentId
                    ExpectedVersionId = $expectedVersionId
                    WorkerClaimId = $workerClaimId
                }
            return
        }

        Write-DeferredHandoffReceipt `
            -Path $receiptPath `
            -Status 'switching' `
            -Message 'All observed turns are idle; the authorized handoff is starting.' `
            -SelectedRoot $selectedRoot `
            -Extra @{
                Mode = $handoffMode
            }
        if ($InvokeInstalledControl) {
            $controlPath = Join-Path `
                $resolvedDataDir `
                'control\CodexLocalRemote.Control.ps1'
            if (-not (Test-Path -LiteralPath $controlPath -PathType Leaf)) {
                throw 'The stable installed Remote control dispatcher is missing.'
            }
            $operationResult = @(
                & $controlPath `
                    -Operation Open `
                    -DataDir $resolvedDataDir `
                    -AllowDesktopRestart `
                    -ExpectedDesiredModeIntentId (
                        $ExpectedDesiredModeIntentId
                    )
            )
            if ($operationResult.Count -ne 1 -or
                [string]$operationResult[0].Status -cnotin @(
                    'ready',
                    'repaired',
                    'already-active'
                ) -or
                [string]$operationResult[0].RemoteState -cne 'ready') {
                throw (
                    'The deferred installed control operation did not ' +
                    'adopt one ready selected runtime.'
                )
            }
            $localReady = Get-ReadyStatusCode `
                -Url (
                    'http://127.0.0.1:' +
                    [string]$managedConfiguration.SidecarPort +
                    [string]$managedConfiguration.BasePath +
                    '/api/v1/ready'
                )
            $publicReady = if ([string]::IsNullOrWhiteSpace(
                $PublicReadyUrl
            )) {
                $null
            } else {
                Get-ReadyStatusCode -Url $PublicReadyUrl
            }
            if ($localReady -ne 200 -or
                ($null -ne $publicReady -and $publicReady -ne 200)) {
                throw (
                    'The deferred installed control operation did not ' +
                    'pass its configured readiness checks.'
                )
            }
            Write-DeferredHandoffReceipt `
                -Path $receiptPath `
                -Status 'verified' `
                -Message (
                    'The stable dispatcher adopted the selected runtime ' +
                    'after every observed turn became idle.'
                ) `
                -SelectedRoot $selectedRoot `
                -Extra @{
                    ExpectedVersionId = $expectedVersionId
                    Mode = 'installed-control'
                    OperationStatus =
                        [string]$operationResult[0].Status
                    LocalReady = $localReady
                    PublicReady = $publicReady
                }
            [pscustomobject]@{
                Status = 'verified'
                SelectedRoot = $selectedRoot
                LocalReady = $localReady
                PublicReady = $publicReady
                ReceiptPath = $receiptPath
            }
            return
        }
        if ($WaitForNaturalDesktopExit) {
            Write-DeferredHandoffReceipt `
                -Path $receiptPath `
                -Status 'waiting-for-natural-desktop-exit' `
                -Message (
                    'All observed turns are idle; waiting without closing or ' +
                    'stopping Desktop until it exits naturally.'
                ) `
                -SelectedRoot $selectedRoot `
                -Extra @{
                    Mode = $handoffMode
                }
            $null = Wait-DeferredHandoffNaturalDesktopExit `
                -Port $BrokerPort `
                -Deadline $idleDeadline
        } else {
            if ($decision -ceq 'close-desktop') {
                foreach ($desktop in @(Get-DeferredHandoffDesktopProcesses)) {
                    $process = Get-Process `
                        -Id ([int]$desktop.ProcessId) `
                        -ErrorAction SilentlyContinue
                    if ($null -ne $process) {
                        try {
                            if ($process.MainWindowHandle -ne 0) {
                                $null = $process.CloseMainWindow()
                            }
                        } finally {
                            $process.Dispose()
                        }
                    }
                }
                $desktopDeadline = [DateTime]::UtcNow.AddSeconds(
                    $DesktopShutdownTimeoutSeconds
                )
                do {
                    Start-Sleep -Milliseconds 250
                    $remaining = @(Get-DeferredHandoffDesktopProcesses)
                } while ($remaining.Count -gt 0 -and
                    [DateTime]::UtcNow -lt $desktopDeadline)
                if ($remaining.Count -gt 0) {
                    foreach ($desktop in $remaining) {
                        Stop-Process `
                            -Id ([int]$desktop.ProcessId) `
                            -Force `
                            -ErrorAction SilentlyContinue
                    }
                }
            }
        }
        Start-Sleep -Seconds $DisconnectDelaySeconds

        if ($WaitForNaturalDesktopExit) {
            Assert-DeferredHandoffNaturalLaunchBarrier -Port $BrokerPort
        } else {
            Assert-DeferredHandoffDesktopStopped
        }
        $currentBeforeLaunch = Get-CodexLocalRemoteCurrentRuntime `
            -DataDir $resolvedDataDir
        if ($null -eq $currentBeforeLaunch -or
            [string]$currentBeforeLaunch.CurrentVersionId -cne
                $expectedVersionId -or
            -not (Test-DeferredHandoffPathEqual `
                -Left ([string]$currentBeforeLaunch.CurrentRoot) `
                -Right $selectedRoot)) {
            throw (
                'The selected runtime changed while the deferred handoff was ' +
                'waiting; this worker is stale and will not launch.'
            )
        }
        $launchReceiptPath = Join-Path `
            $resolvedDataDir `
            'desktop-launch-last.json'
        $launchReceiptBaseline = (
            Get-DeferredHandoffLaunchReceiptObservation `
                -Path $launchReceiptPath
        )
        $launchStartedAt = [DateTimeOffset]::UtcNow
        $launchRequest = & $launcherPath `
            -DataDir $resolvedDataDir `
            -BrokerPort ([int]$managedConfiguration.BrokerPort) `
            -SidecarPort ([int]$managedConfiguration.SidecarPort) `
            -BrokerUpstreamPort (
                [int]$managedConfiguration.BrokerUpstreamPort
            ) `
            -BasePath ([string]$managedConfiguration.BasePath) `
            -TaskName $TaskName `
            -RequestDesktopLaunch `
            -ExpectedSelectedRuntimeVersionId $expectedVersionId `
            -ExpectedSelectedRuntimeRoot $selectedRoot `
            -SuppressNotification
        if ($null -eq $launchRequest -or
            [string]$launchRequest.Status -cne
                'desktop-owner-requested' -or
            [string]$launchRequest.IntentId -cnotmatch
                '^[0-9a-f]{32}$' -or
            [string]$launchRequest.TargetRuntimeVersionId -cne
                $expectedVersionId) {
            throw (
                'The runtime-bound Desktop launch request did not return ' +
                'the expected intent identity.'
            )
        }
        $expectedLaunchCorrelationId = [string]$launchRequest.IntentId
        $verificationDeadline = [DateTime]::UtcNow.AddSeconds(
            $VerificationTimeoutSeconds
        )
        $verified = $false
        do {
            Start-Sleep -Seconds 2
            try {
                $current = Get-CodexLocalRemoteCurrentRuntime `
                    -DataDir $resolvedDataDir
                $brokerReceipt = Get-Content `
                    -LiteralPath (
                        Join-Path $resolvedDataDir 'app-server-broker.json'
                    ) `
                    -Raw `
                    -Encoding utf8 |
                    ConvertFrom-Json -Depth 20 -DateKind String
                $launchReceipt = Get-Content `
                    -LiteralPath $launchReceiptPath `
                    -Raw `
                    -Encoding utf8 |
                    ConvertFrom-Json -Depth 10 -DateKind String
                $verificationCandidate = (
                    Test-DeferredHandoffVerificationCandidate `
                        -CurrentRuntime $current `
                        -BrokerReceipt $brokerReceipt `
                        -LaunchReceipt $launchReceipt `
                        -ExpectedVersionId $expectedVersionId `
                        -ExpectedRoot $selectedRoot `
                        -LaunchStartedAt $launchStartedAt `
                        -ExpectedCorrelationId (
                            $expectedLaunchCorrelationId
                        ) `
                        -Baseline $launchReceiptBaseline
                )
                $localReady = Get-ReadyStatusCode `
                    -Url (
                        'http://127.0.0.1:' +
                        [string]$managedConfiguration.SidecarPort +
                        [string]$managedConfiguration.BasePath +
                        '/api/v1/ready'
                    )
                $publicReady = if ([string]::IsNullOrWhiteSpace(
                    $PublicReadyUrl
                )) {
                    200
                } else {
                    Get-ReadyStatusCode -Url $PublicReadyUrl
                }
                $verified = (
                    $verificationCandidate.IsValid -and
                    $localReady -eq 200 -and
                    $publicReady -eq 200 -and
                    @(Get-DeferredHandoffDesktopProcesses).Count -gt 0
                )
            } catch {
                $verified = $false
            }
        } while (-not $verified -and
            [DateTime]::UtcNow -lt $verificationDeadline)
        if (-not $verified) {
            throw 'The deferred handoff ran but did not satisfy every readiness condition.'
        }
        Write-DeferredHandoffReceipt `
            -Path $receiptPath `
            -Status 'verified' `
            -Message 'The selected runtime owns Desktop, local Web, and the configured public readiness endpoint.' `
            -SelectedRoot $selectedRoot `
            -Extra @{
                ExpectedVersionId = $expectedVersionId
                LaunchDecision = [string]$launchReceipt.RemoteDecision
                LaunchCorrelationId = (
                    [string]$verificationCandidate.CorrelationId
                )
                LocalReady = $localReady
                PublicReady = $publicReady
            }
        [pscustomobject]@{
            Status = 'verified'
            SelectedRoot = $selectedRoot
            LocalReady = $localReady
            PublicReady = $publicReady
            ReceiptPath = $receiptPath
        }
    } catch {
        if ($null -ne $workerMutex) {
            Write-DeferredHandoffReceipt `
                -Path $receiptPath `
                -Status 'failed' `
                -Message $_.Exception.Message `
                -SelectedRoot $selectedRoot `
                -Extra @{
                    ExpectedVersionId = $expectedVersionId
                    Mode = $handoffMode
                }
        }
        throw
    } finally {
        if ($null -ne $workerMutex) {
            if (-not [string]::IsNullOrWhiteSpace($workerClaimId)) {
                try {
                    Remove-DeferredHandoffWorkerClaim `
                        -Path $workerClaimPath `
                        -ExpectedClaimId $workerClaimId
                } catch {
                    # The mutex remains authoritative; stale diagnostics are
                    # ignored whenever no worker owns that mutex.
                }
            }
            try {
                $workerMutex.ReleaseMutex()
            } catch [System.ApplicationException] {
                # An abandoned owner remains safe to dispose.
            }
            $workerMutex.Dispose()
        }
    }
}
