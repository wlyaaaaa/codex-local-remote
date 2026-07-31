[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$DataDir,

    [Parameter(Mandatory)]
    [string]$TaskName,

    [Parameter(Mandatory)]
    [ValidateRange(1, 65535)]
    [int]$SidecarPort,

    [Parameter(Mandatory)]
    [ValidateRange(1, 65535)]
    [int]$BrokerPort,

    [Parameter(Mandatory)]
    [ValidateRange(1, 65535)]
    [int]$BrokerUpstreamPort,

    [Parameter(Mandatory)]
    [string]$BasePath,

    [Parameter(Mandatory)]
    [string]$IntentId,

    [Parameter(Mandatory)]
    [string]$WorkerNonce,

    [Parameter(DontShow)]
    [switch]$DefinitionOnly
)

$ErrorActionPreference = 'Stop'
$workerParameters = [pscustomobject]@{
    DataDir = $DataDir
    TaskName = $TaskName
    SidecarPort = $SidecarPort
    BrokerPort = $BrokerPort
    BrokerUpstreamPort = $BrokerUpstreamPort
    BasePath = $BasePath
    IntentId = $IntentId
    WorkerNonce = $WorkerNonce
    DefinitionOnly = [bool]$DefinitionOnly
}
$launcherPath = Join-Path $PSScriptRoot 'Launch-CodexWithRemote.ps1'
. $launcherPath -DefinitionOnly
$DataDir = [string]$workerParameters.DataDir
$TaskName = [string]$workerParameters.TaskName
$SidecarPort = [int]$workerParameters.SidecarPort
$BrokerPort = [int]$workerParameters.BrokerPort
$BrokerUpstreamPort = [int]$workerParameters.BrokerUpstreamPort
$BasePath = [string]$workerParameters.BasePath
$IntentId = [string]$workerParameters.IntentId
$WorkerNonce = [string]$workerParameters.WorkerNonce
$DefinitionOnly = [bool]$workerParameters.DefinitionOnly
$resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)

$intentPath = Join-Path `
    $resolvedDataDir `
    'desktop-package-refresh-intent.json'
$resultPath = Join-Path `
    $resolvedDataDir `
    'desktop-package-refresh-last.json'
$suppressionPath = Join-Path `
    $resolvedDataDir `
    'desktop-owner-fallback-suppression.json'

function Read-PackageRefreshIntent {
    if (-not (Test-Path -LiteralPath $intentPath -PathType Leaf)) {
        throw 'The package refresh intent is missing.'
    }
    $item = Get-Item -LiteralPath $intentPath -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        ($item.Attributes -band
            [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [long]$item.Length -lt 64 -or
        [long]$item.Length -gt 8192) {
        throw 'The package refresh intent is not an ordinary bounded file.'
    }
    $rawBefore = Get-Content -LiteralPath $intentPath -Raw -Encoding utf8
    $intent = $rawBefore |
        ConvertFrom-Json -Depth 8 -DateKind String -ErrorAction Stop
    $rawAfter = Get-Content -LiteralPath $intentPath -Raw -Encoding utf8
    $requestedAt = [DateTimeOffset]::Parse(
        [string]$intent.RequestedAtUtc,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind
    )
    if ($rawBefore -cne $rawAfter -or
        [string]$intent.Signature -cne
            'codex-local-remote/desktop-package-refresh-intent/v1' -or
        [int]$intent.Version -ne 1 -or
        [string]$intent.IntentId -cne $IntentId -or
        [string]$intent.WorkerNonce -cne $WorkerNonce -or
        [string]$intent.ExpectedRootIdentityKey -cnotmatch
            '^[1-9][0-9]*\|[1-9][0-9]*\|[0-9a-f]{64}$' -or
        [string]$intent.ExpectedRuntimeInvocationId -cnotmatch
            '^[0-9a-f]{32}$' -or
        $requestedAt.Offset -ne [TimeSpan]::Zero -or
        $requestedAt -lt [DateTimeOffset]::UtcNow.AddMinutes(-2) -or
        $requestedAt -gt [DateTimeOffset]::UtcNow.AddSeconds(5)) {
        throw 'The package refresh intent is invalid or stale.'
    }
    return $intent
}

function Claim-PackageRefreshIntent {
    $workerProcess = Get-Process -Id $PID -ErrorAction Stop
    try {
        $workerProcess.Refresh()
        $workerStartTimeUtcTicks =
            $workerProcess.StartTime.ToUniversalTime().Ticks
    } finally {
        $workerProcess.Dispose()
    }
    return Invoke-WithCodexRequesterDesktopOwnerMutex `
        -ManagedDataDir $resolvedDataDir `
        -TimeoutSeconds 15 `
        -Action {
            $intent = Read-PackageRefreshIntent
            $isUnclaimed = (
                [int]$intent.WorkerProcessId -eq 0 -and
                [long]$intent.WorkerStartTimeUtcTicks -eq 0
            )
            $isClaimedByThisWorker = (
                [int]$intent.WorkerProcessId -eq $PID -and
                [long]$intent.WorkerStartTimeUtcTicks -eq
                    $workerStartTimeUtcTicks
            )
            if (-not $isUnclaimed -and -not $isClaimedByThisWorker) {
                throw 'The package refresh intent belongs to another worker.'
            }
            if ($isUnclaimed) {
                $intent.WorkerProcessId = $PID
                $intent.WorkerStartTimeUtcTicks = $workerStartTimeUtcTicks
                Write-AtomicJsonFile -Path $intentPath -Value $intent
                $intent = Read-PackageRefreshIntent
            }
            if ([int]$intent.WorkerProcessId -ne $PID -or
                [long]$intent.WorkerStartTimeUtcTicks -ne
                    $workerStartTimeUtcTicks) {
                throw 'The package refresh worker claim was not published.'
            }
            return $intent
        }
}

function Write-PackageRefreshResult {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('refreshed', 'native-fallback', 'preserved')]
        [string]$Outcome,

        [AllowEmptyString()]
        [string]$RootIdentityKey = ''
    )

    Write-AtomicJsonFile -Path $resultPath -Value ([ordered]@{
        Signature =
            'codex-local-remote/desktop-package-refresh-result/v1'
        Version = 1
        IntentId = $IntentId
        Outcome = $Outcome
        RootIdentityKey = $RootIdentityKey
        RecordedAtUtc = [DateTime]::UtcNow.ToString('O')
    })
}

function Remove-PackageRefreshIntentIfCurrent {
    param(
        [Parameter(Mandatory)]
        [string]$ExpectedIntentId
    )

    try {
        $null = Invoke-WithCodexRequesterDesktopOwnerMutex `
            -ManagedDataDir $resolvedDataDir `
            -TimeoutSeconds 5 `
            -Action {
                if (-not (Test-Path -LiteralPath $intentPath -PathType Leaf)) {
                    return
                }
                $item = Get-Item -LiteralPath $intentPath -Force -ErrorAction Stop
                if ($item.PSIsContainer -or
                    ($item.Attributes -band
                        [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
                    [long]$item.Length -lt 64 -or
                    [long]$item.Length -gt 8192) {
                    return
                }
                $rawBefore =
                    Get-Content -LiteralPath $intentPath -Raw -Encoding utf8
                $currentIntent = $rawBefore |
                    ConvertFrom-Json -Depth 8 -DateKind String -ErrorAction Stop
                $rawAfter =
                    Get-Content -LiteralPath $intentPath -Raw -Encoding utf8
                if ($rawBefore -cne $rawAfter -or
                    [string]$currentIntent.Signature -cne
                        'codex-local-remote/desktop-package-refresh-intent/v1' -or
                    [int]$currentIntent.Version -ne 1 -or
                    [string]$currentIntent.IntentId -cne
                        $ExpectedIntentId) {
                    return
                }
                Remove-Item -LiteralPath $intentPath -Force -ErrorAction Stop
            }
    } catch {
        # A newer or unreadable claim must be preserved for the supervisor.
    }
}

function Get-PackageRefreshSafetyObservation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$ExpectedGeneration,

        [Parameter(Mandatory)]
        [string]$ExpectedRootIdentityKey,

        [Parameter(Mandatory)]
        [string]$ExpectedExecutablePath
    )

    $rootProcesses = @(
        Get-CodexDesktopHandoffProcesses |
            Where-Object {
                [string]$_.CommandLine -notmatch
                    '(?i)(?:^|\s)--type='
            }
    )
    if ($rootProcesses.Count -ne 1) {
        throw 'The package refresh Desktop root is not strictly unique.'
    }
    $latestGeneration =
        Get-CodexLocalRemoteRuntimeGenerationStatus `
            -ManagedDataDir $resolvedDataDir
    if ([string]$latestGeneration.Status -cne 'current' -or
        $null -eq $latestGeneration.Receipt -or
        [string]$latestGeneration.Receipt.RuntimeInvocationId -cne
            [string]$ExpectedGeneration.Receipt.RuntimeInvocationId -or
        [int]$latestGeneration.Receipt.ProcessId -ne
            [int]$ExpectedGeneration.Receipt.ProcessId -or
        [int]$latestGeneration.Receipt.Upstream.ProcessId -ne
            [int]$ExpectedGeneration.Receipt.Upstream.ProcessId -or
        -not (Test-CodexLocalRemotePathEqual `
            -Left ([string]$latestGeneration.ActiveRoot) `
            -Right ([string]$ExpectedGeneration.ActiveRoot))) {
        throw 'The package refresh runtime generation changed.'
    }
    $readiness = Get-CodexLocalRemoteReadinessSnapshot `
        -Port $BrokerPort
    if (-not (Test-CodexLocalRemoteCodexRuntimeRestartSafe `
        -Readiness $readiness `
        -Generation $latestGeneration)) {
        throw (
            'The package refresh Broker is unreachable, changed, or has ' +
            'an active or unknown request.'
        )
    }
    $rootIdentity = Get-CodexDesktopLaunchIdentity `
        -Process $rootProcesses[0]
    if ($null -eq $rootIdentity -or
        [string]::IsNullOrWhiteSpace(
            [string]$rootIdentity.ExecutablePath
        )) {
        throw 'The package refresh Desktop root identity is unavailable.'
    }
    $rootKey = Get-CodexDesktopOwnerRootIdentityKey `
        -ProcessId ([int]$rootIdentity.ProcessId) `
        -StartTimeUtcTicks ([long]$rootIdentity.StartTimeUtcTicks) `
        -ExecutablePath ([string]$rootIdentity.ExecutablePath)
    if ($rootKey -cne $ExpectedRootIdentityKey -or
        -not [string]::Equals(
            [System.IO.Path]::GetFullPath(
                [string]$rootIdentity.ExecutablePath
            ),
            [System.IO.Path]::GetFullPath($ExpectedExecutablePath),
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'The package refresh Desktop root changed.'
    }
    return $rootIdentity
}

function Invoke-CodexLocalRemotePackageRefreshWorkerCore {
    $intent = $null
    try {
    $intent = Claim-PackageRefreshIntent
    $null = Invoke-WithCodexRequesterDesktopOwnerMutex `
        -ManagedDataDir $resolvedDataDir `
        -TimeoutSeconds 30 `
        -Action {
            $generation = Get-CodexLocalRemoteRuntimeGenerationStatus `
                -ManagedDataDir $resolvedDataDir
            if ([string]$generation.Status -cne 'current' -or
                [string]$generation.Receipt.RuntimeInvocationId -cne
                    [string]$intent.ExpectedRuntimeInvocationId) {
                throw 'The active runtime invocation changed before refresh.'
            }
            $currentRuntime = Resolve-CodexDesktopRuntime `
                -DesktopProcessCandidates @() `
                -RuntimeCachePath (
                    Join-Path $resolvedDataDir 'desktop-runtime-cache.json'
                )
            $activeStatus =
                Get-CodexLocalRemoteActiveCodexRuntimeStatus `
                    -ManagedDataDir $resolvedDataDir `
                    -Generation $generation `
                    -CurrentRuntime $currentRuntime
            if ([string]$activeStatus.Status -cne 'drifted') {
                throw 'The active Codex runtime is not one verified drift.'
            }
            $firstSafetyObservation =
                Get-PackageRefreshSafetyObservation `
                    -ExpectedGeneration $generation `
                    -ExpectedRootIdentityKey (
                        [string]$intent.ExpectedRootIdentityKey
                    ) `
                    -ExpectedExecutablePath (
                        [string]$currentRuntime.DesktopExecutablePath
                    )
            Start-Sleep -Milliseconds 100
            $secondSafetyObservation =
                Get-PackageRefreshSafetyObservation `
                    -ExpectedGeneration $generation `
                    -ExpectedRootIdentityKey (
                        [string]$intent.ExpectedRootIdentityKey
                    ) `
                    -ExpectedExecutablePath (
                        [string]$currentRuntime.DesktopExecutablePath
                    )
            if (-not (Test-CodexDesktopLaunchIdentityMatch `
                -Expected $firstSafetyObservation `
                -Actual $secondSafetyObservation)) {
                throw 'The package refresh Desktop root changed during grace.'
            }
            $rootIdentity = Get-PackageRefreshSafetyObservation `
                -ExpectedGeneration $generation `
                -ExpectedRootIdentityKey (
                    [string]$intent.ExpectedRootIdentityKey
                ) `
                -ExpectedExecutablePath (
                    [string]$currentRuntime.DesktopExecutablePath
                )
            if (-not (Test-CodexDesktopLaunchIdentityMatch `
                -Expected $secondSafetyObservation `
                -Actual $rootIdentity)) {
                throw (
                    'The package refresh Desktop root changed at the final ' +
                    'destructive barrier.'
                )
            }
            $stopResult = Stop-CodexDesktopCreatedProcess `
                -ProcessId ([int]$rootIdentity.ProcessId) `
                -StartTimeUtcTicks ([long]$rootIdentity.StartTimeUtcTicks) `
                -ExpectedExecutablePath (
                    [string]$rootIdentity.ExecutablePath
                )
            if ($stopResult -cnotin @('stopped', 'already-exited') -or
                (Test-CodexDesktopRootPresent)) {
                throw 'The exact fresh vendor Desktop root could not be stopped.'
            }
            try {
                $null = Restart-CodexLocalRemoteCodexRuntime `
                    -Name $TaskName `
                    -Generation $generation `
                    -CurrentRuntime $currentRuntime `
                    -ManagedDataDir $resolvedDataDir `
                    -ManagedSidecarPort $SidecarPort `
                    -ManagedBrokerPort $BrokerPort `
                    -ManagedBrokerUpstreamPort $BrokerUpstreamPort `
                    -ManagedBasePath $BasePath `
                    -SkipCompensation
                Remove-Item `
                    -LiteralPath $suppressionPath `
                    -Force `
                    -ErrorAction SilentlyContinue
                Write-PackageRefreshResult -Outcome 'refreshed'
                return
            } catch {
                $fallback = Invoke-CodexRequesterNativeFailOpen
                $fallbackRootKeys = @(Get-CodexDesktopRootIdentityKeys)
                if ($fallbackRootKeys.Count -eq 1) {
                    Write-AtomicJsonFile `
                        -Path $suppressionPath `
                        -Value ([ordered]@{
                            Signature =
                                'codex-local-remote/desktop-owner-fallback-suppression/v1'
                            Version = 1
                            RootIdentityKey =
                                [string]$fallbackRootKeys[0]
                            Reason = 'package-refresh-failed'
                            RecordedAtUtc =
                                [DateTime]::UtcNow.ToString('O')
                            ExpiresAtUtc =
                                [DateTime]::UtcNow.AddMinutes(2).ToString('O')
                        })
                }
                $feedback = Get-CodexRemoteLaunchFeedback -Result $fallback
                try {
                    $feedbackResult = Show-CodexRemoteLaunchFeedback `
                        -Feedback $feedback `
                        -IconPath (
                            Join-Path $resolvedDataDir 'managed-chatgpt.ico'
                        )
                    $fallback | Add-Member `
                        -NotePropertyName FeedbackStatus `
                        -NotePropertyValue ([string]$feedbackResult.Status) `
                        -Force
                    $fallback | Add-Member `
                        -NotePropertyName FeedbackFailureCode `
                        -NotePropertyValue (
                            [string]$feedbackResult.FailureCode
                        ) `
                        -Force
                } catch {
                    $fallback | Add-Member `
                        -NotePropertyName FeedbackStatus `
                        -NotePropertyValue 'render-failed' `
                        -Force
                    $fallback | Add-Member `
                        -NotePropertyName FeedbackFailureCode `
                        -NotePropertyValue 'feedback-render-failed' `
                        -Force
                }
                try {
                    Write-CodexDesktopLaunchReceipt `
                        -DataDir $resolvedDataDir `
                        -Result $fallback
                } catch {
                    # Receipt failure does not block the native fallback.
                }
                Start-CodexLocalRemoteScheduledTaskBounded `
                    -Name $TaskName `
                    -TimeoutSeconds 30
                Write-PackageRefreshResult `
                    -Outcome 'native-fallback' `
                    -RootIdentityKey $(if (
                        $fallbackRootKeys.Count -eq 1
                    ) {
                        [string]$fallbackRootKeys[0]
                    } else {
                        ''
                    })
                $null = $fallback
                return
            }
        }
    } catch {
        if ($null -eq $intent) {
            return
        }
        try {
            Start-CodexLocalRemoteScheduledTaskBounded `
                -Name $TaskName `
                -TimeoutSeconds 30
        } catch {
            # A bounded result receipt still records that no root was changed.
        }
        Write-PackageRefreshResult -Outcome 'preserved'
    } finally {
        if ($null -ne $intent -and
            [string]$intent.IntentId -ceq $IntentId) {
            Remove-PackageRefreshIntentIfCurrent `
                -ExpectedIntentId $IntentId
        }
    }
}

if (-not $DefinitionOnly) {
    Invoke-CodexLocalRemotePackageRefreshWorkerCore
}
