[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LauncherPath,

    [Parameter(Mandatory)]
    [ValidateSet(
        'port-refused',
        'ready',
        'cold-start',
        'connected-without-root-no-nonce',
        'start-failed',
        'already-running',
        'already-running-proven-remote',
        'already-running-arbitrary-bridge',
        'already-running-managed-takeover',
        'already-running-managed-start-failed',
        'already-running-takeover-stop-failed',
        'already-running-takeover-readiness-drift',
        'already-running-takeover-unsafe',
        'already-running-takeover-desktop-connected-drift',
        'already-running-takeover-root-drift',
        'already-running-takeover-root-count-drift',
        'already-running-takeover-child-identity-unavailable-exited',
        'already-running-takeover-child-identity-unavailable-running',
        'already-running-takeover-created-state-unverified-exited',
        'already-running-takeover-created-state-unverified-running',
        'broker-before-attach-death',
        'attach-other-root',
        'attach-foreign-root-gone',
        'attach-nonce-mismatch',
        'attach-nonce-missing',
        'attach-nonce-malformed-shape',
        'attach-multiple-all-own',
        'attach-multiple-foreign',
        'attach-multiple-legacy',
        'attach-disconnect',
        'attach-runtime-invocation-drift',
        'attach-runtime-receipt-drift',
        'early-exit',
        'identity-unverified'
    )]
    [string]$Mode,

    [AllowEmptyString()]
    [string]$LaunchCorrelationId = ''
)

$ErrorActionPreference = 'Stop'
$requestedLaunchCorrelationId = $LaunchCorrelationId
. $LauncherPath -DefinitionOnly

$state = [pscustomobject]@{
    HealthChecks = 0
    RunningDesktopChecks = 0
    RemoteStartCalls = 0
    DesktopLaunchCalls = 0
    CreatedProcessChecks = 0
    ProcessHandleChecks = 0
    StopCalls = 0
    ExistingDesktopStopped = $false
    ChildOverridePresent = $false
    ChildOverride = $null
    LaunchOverrides = [System.Collections.Generic.List[object]]::new()
    LaunchOverrideNoncePresent = [System.Collections.Generic.List[bool]]::new()
    RemoteLaunchNonceDigest = $null
    PostLaunchHealthChecks = 0
}
$originalOverride = 'ws://127.0.0.1:49999/original-parent-value'
$env:CODEX_APP_SERVER_WS_URL = $originalOverride
$capabilityEndpoint = (
    'ws://127.0.0.1:18791/ws/' +
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789_-'
)
$foreignLaunchNonceDigest = (
    'f' * 64
)
$existingDesktopOwnerProof = if (
    $Mode -ceq 'already-running-proven-remote'
) {
    [pscustomobject]@{
        RuntimeInvocationId = '0123456789abcdef0123456789abcdef'
        RootIdentityKey = Get-CodexDesktopOwnerRootIdentityKey `
            -ProcessId 42001 `
            -StartTimeUtcTicks 638899999999999999 `
            -ExecutablePath 'C:\fixture\OpenAI.Codex\ChatGPT.exe'
        LaunchNonceDigest = $foreignLaunchNonceDigest
    }
} else {
    $null
}
# These modes assert consecutive observations. Keep their fixture window above
# full-suite process-scheduling stalls; production keeps its separate 15 s bound.
$observationSensitiveAttachModes = @(
    'ready',
    'cold-start',
    'connected-without-root-no-nonce',
    'already-running-arbitrary-bridge',
    'already-running-managed-takeover',
    'already-running-takeover-unsafe',
    'attach-multiple-all-own',
    'attach-disconnect',
    'attach-runtime-invocation-drift',
    'attach-runtime-receipt-drift'
)
$remoteAttachTimeoutMilliseconds = if (
    $Mode -cin $observationSensitiveAttachModes
) {
    1000
} else {
    50
}

function Get-FixtureSha256Hex {
    param(
        [Parameter(Mandatory)]
        [string]$Value
    )

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
        return [Convert]::ToHexString(
            $sha256.ComputeHash($bytes)
        ).ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
}

function New-ReadinessSnapshot {
    param(
        [bool]$DesktopConnected,
        [string]$RuntimeInvocationId = '0123456789abcdef0123456789abcdef',
        [string]$RuntimeReceiptInvocationId = $RuntimeInvocationId,
        [int]$DesktopConnectionCount = -1,
        [AllowEmptyCollection()]
        [string[]]$DesktopLaunchNonceDigests = @()
    )

    return [pscustomobject]@{
        status = 'ready'
        appServerReady = $true
        desktopConnected = $DesktopConnected
        sidecarConnected = $true
        degraded = $false
        unknownCount = 0
        unsafeThreadCount = if (
            $Mode -ceq 'already-running-takeover-unsafe' -and
            $state.HealthChecks -ge 2
        ) {
            1
        } else {
            0
        }
        runtimeInvocationId = $RuntimeInvocationId
        brokerProcessId = 41001
        upstreamProcessId = 41002
        runtimeReceiptInvocationId = $RuntimeReceiptInvocationId
        runtimeReceiptBrokerProcessId = 41001
        runtimeReceiptUpstreamProcessId = 41002
        desktopConnectionCount = if ($DesktopConnectionCount -ge 0) {
            $DesktopConnectionCount
        } elseif ($DesktopConnected) {
            [Math]::Max(1, $DesktopLaunchNonceDigests.Count)
        } else {
            0
        }
        desktopLaunchNonceDigests = @($DesktopLaunchNonceDigests)
    }
}

$result = Invoke-CodexDesktopFailOpenLaunch `
    -GetRunningDesktopAction {
        $state.RunningDesktopChecks++
        if ($Mode -clike 'already-running*' -and
            -not $state.ExistingDesktopStopped) {
            if ($Mode -ceq 'already-running-takeover-root-count-drift' -and
                $state.RunningDesktopChecks -gt 1) {
                [pscustomobject]@{
                    ProcessId = 42001
                    ExecutablePath = 'C:\fixture\OpenAI.Codex\ChatGPT.exe'
                    StartTimeUtcTicks = 638899999999999999
                }
                [pscustomobject]@{
                    ProcessId = 42009
                    ExecutablePath = 'C:\fixture\OpenAI.Codex\ChatGPT.exe'
                    StartTimeUtcTicks = 638899999999999998
                }
                return
            }
            $processId = if (
                $Mode -ceq 'already-running-takeover-root-drift' -and
                $state.RunningDesktopChecks -gt 1
            ) {
                42009
            } else {
                42001
            }
            [pscustomobject]@{
                ProcessId = $processId
                ExecutablePath = 'C:\fixture\OpenAI.Codex\ChatGPT.exe'
                StartTimeUtcTicks = if ($processId -eq 42001) {
                    638899999999999999
                } else {
                    638899999999999998
                }
            }
            return
        }
        if ($state.DesktopLaunchCalls -gt 0 -and
            $state.ChildOverridePresent) {
            [pscustomobject]@{
                ProcessId = 42001 + $state.DesktopLaunchCalls
                ExecutablePath = 'C:\fixture\OpenAI.Codex\ChatGPT.exe'
                StartTimeUtcTicks = (
                    638900000000000000 +
                    $state.DesktopLaunchCalls
                )
            }
            if ($Mode -ceq 'attach-other-root') {
                [pscustomobject]@{
                    ProcessId = 42009
                    ExecutablePath =
                        'C:\fixture\OpenAI.Codex\ChatGPT.exe'
                    StartTimeUtcTicks = 638900000000000099
                }
            }
        }
    } `
    -ResolveDesktopRuntimeAction {
        [pscustomobject]@{
            DesktopExecutablePath = 'C:\fixture\OpenAI.Codex\ChatGPT.exe'
        }
    } `
    -GetRemoteReadinessAction {
        $state.HealthChecks++
        if ($Mode -cin @(
            'ready',
            'cold-start',
            'connected-without-root-no-nonce',
            'already-running-proven-remote',
            'already-running-arbitrary-bridge',
            'already-running-managed-takeover',
            'already-running-takeover-stop-failed',
            'already-running-takeover-readiness-drift',
            'already-running-takeover-unsafe',
            'already-running-takeover-desktop-connected-drift',
            'already-running-takeover-root-drift',
            'already-running-takeover-root-count-drift',
            'already-running-takeover-child-identity-unavailable-exited',
            'already-running-takeover-child-identity-unavailable-running',
            'already-running-takeover-created-state-unverified-exited',
            'already-running-takeover-created-state-unverified-running',
            'broker-before-attach-death',
            'attach-other-root',
            'attach-foreign-root-gone',
            'attach-nonce-mismatch',
            'attach-nonce-missing',
            'attach-nonce-malformed-shape',
            'attach-multiple-all-own',
            'attach-multiple-foreign',
            'attach-multiple-legacy',
            'attach-disconnect',
            'attach-runtime-invocation-drift',
            'attach-runtime-receipt-drift',
            'early-exit',
            'identity-unverified'
        )) {
            if ($Mode -ceq 'cold-start') {
                if ($state.RemoteStartCalls -eq 0) {
                    return $null
                }
                return New-ReadinessSnapshot `
                    -DesktopConnected ($state.DesktopLaunchCalls -gt 0) `
                    -DesktopLaunchNonceDigests @(
                        if ($state.DesktopLaunchCalls -gt 0) {
                            [string]$state.RemoteLaunchNonceDigest
                        }
                    )
            }
            if ($Mode -ceq 'connected-without-root-no-nonce') {
                if ($state.DesktopLaunchCalls -eq 0) {
                    return New-ReadinessSnapshot `
                        -DesktopConnected $true `
                        -DesktopConnectionCount 1 `
                        -DesktopLaunchNonceDigests @()
                }
                return New-ReadinessSnapshot `
                    -DesktopConnected $true `
                    -DesktopConnectionCount 2 `
                    -DesktopLaunchNonceDigests @(
                        [string]$state.RemoteLaunchNonceDigest
                    )
            }
            if ($Mode -cin @(
                'already-running-proven-remote',
                'already-running-arbitrary-bridge'
            ) -and $state.DesktopLaunchCalls -eq 0) {
                return New-ReadinessSnapshot `
                    -DesktopConnected $true `
                    -DesktopLaunchNonceDigests @(
                        $foreignLaunchNonceDigest
                    )
            }
            if ($state.HealthChecks -eq 1) {
                return New-ReadinessSnapshot -DesktopConnected $false
            }
            if ($Mode -ceq 'already-running-takeover-readiness-drift' -and
                $state.HealthChecks -eq 2) {
                return New-ReadinessSnapshot `
                    -DesktopConnected $false `
                    -RuntimeInvocationId 'fedcba9876543210fedcba9876543210'
            }
            if ($Mode -ceq
                    'already-running-takeover-desktop-connected-drift' -and
                $state.HealthChecks -eq 2) {
                return New-ReadinessSnapshot -DesktopConnected $true
            }
            if ($state.DesktopLaunchCalls -gt 0) {
                $state.PostLaunchHealthChecks++
                if ($Mode -cin @(
                    'attach-foreign-root-gone',
                    'attach-nonce-mismatch'
                )) {
                    return New-ReadinessSnapshot `
                        -DesktopConnected $true `
                        -DesktopLaunchNonceDigests @(
                            $foreignLaunchNonceDigest
                        )
                }
                if ($Mode -ceq 'attach-nonce-missing') {
                    return New-ReadinessSnapshot `
                        -DesktopConnected $true `
                        -DesktopLaunchNonceDigests @()
                }
                if ($Mode -ceq 'attach-nonce-malformed-shape') {
                    $malformed = New-ReadinessSnapshot `
                        -DesktopConnected $true `
                        -DesktopLaunchNonceDigests @(
                            [string]$state.RemoteLaunchNonceDigest
                        )
                    $malformed.desktopLaunchNonceDigests =
                        [string]$state.RemoteLaunchNonceDigest
                    return $malformed
                }
                if ($Mode -ceq 'attach-multiple-all-own') {
                    return New-ReadinessSnapshot `
                        -DesktopConnected $true `
                        -DesktopLaunchNonceDigests @(
                            [string]$state.RemoteLaunchNonceDigest,
                            [string]$state.RemoteLaunchNonceDigest
                        )
                }
                if ($Mode -ceq 'attach-multiple-foreign') {
                    return New-ReadinessSnapshot `
                        -DesktopConnected $true `
                        -DesktopLaunchNonceDigests @(
                            [string]$state.RemoteLaunchNonceDigest,
                            $foreignLaunchNonceDigest
                        )
                }
                if ($Mode -ceq 'attach-multiple-legacy') {
                    return New-ReadinessSnapshot `
                        -DesktopConnected $true `
                        -DesktopConnectionCount 2 `
                        -DesktopLaunchNonceDigests @(
                            [string]$state.RemoteLaunchNonceDigest
                        )
                }
                if ($Mode -ceq 'attach-disconnect') {
                    if ($state.PostLaunchHealthChecks -eq 1) {
                        return New-ReadinessSnapshot `
                            -DesktopConnected $true `
                            -DesktopLaunchNonceDigests @(
                                [string]$state.RemoteLaunchNonceDigest
                            )
                    }
                    return New-ReadinessSnapshot -DesktopConnected $false
                }
                if ($Mode -ceq 'attach-runtime-invocation-drift') {
                    return New-ReadinessSnapshot `
                        -DesktopConnected $true `
                        -RuntimeInvocationId $(if (
                            $state.PostLaunchHealthChecks -gt 1
                        ) {
                            'fedcba9876543210fedcba9876543210'
                        } else {
                            '0123456789abcdef0123456789abcdef'
                        }) `
                        -DesktopLaunchNonceDigests @(
                            [string]$state.RemoteLaunchNonceDigest
                        )
                }
                if ($Mode -ceq 'attach-runtime-receipt-drift') {
                    return New-ReadinessSnapshot `
                        -DesktopConnected $true `
                        -RuntimeReceiptInvocationId $(if (
                            $state.PostLaunchHealthChecks -gt 1
                        ) {
                            'fedcba9876543210fedcba9876543210'
                        } else {
                            '0123456789abcdef0123456789abcdef'
                        }) `
                        -DesktopLaunchNonceDigests @(
                            [string]$state.RemoteLaunchNonceDigest
                        )
                }
            }
            if ($state.DesktopLaunchCalls -gt 0 -and
                $Mode -cin @(
                    'ready',
                    'attach-other-root',
                    'already-running-managed-takeover',
                    'already-running-takeover-unsafe',
                    'already-running-takeover-root-drift',
                    'already-running-takeover-child-identity-unavailable-exited',
                    'already-running-takeover-child-identity-unavailable-running',
                    'already-running-takeover-created-state-unverified-exited',
                    'already-running-takeover-created-state-unverified-running'
                )) {
                return New-ReadinessSnapshot `
                    -DesktopConnected $true `
                    -DesktopLaunchNonceDigests @(
                        [string]$state.RemoteLaunchNonceDigest
                    )
            }
            return New-ReadinessSnapshot -DesktopConnected $false
        }
        return $null
    } `
    -StartRemoteAction {
        $state.RemoteStartCalls++
        if ($Mode -cin @(
            'start-failed',
            'already-running-managed-start-failed'
        )) {
            throw 'fixture remote startup failure'
        }
    } `
    -GetRemoteEndpointAction {
        return $capabilityEndpoint
    } `
    -StartDesktopAction {
        param(
            [string]$DesktopExecutablePath,
            [AllowNull()]
            [string]$RemoteEndpoint
        )
        $state.DesktopLaunchCalls++
        $state.ChildOverridePresent = -not [string]::IsNullOrWhiteSpace(
            $RemoteEndpoint
        )
        $state.ChildOverride = if ($state.ChildOverridePresent) {
            ([uri]$RemoteEndpoint).GetLeftPart(
                [System.UriPartial]::Path
            )
        } else {
            $null
        }
        $state.LaunchOverrides.Add($state.ChildOverride)
        $launchUri = if ($state.ChildOverridePresent) {
            [uri]$RemoteEndpoint
        } else {
            $null
        }
        $launchNonce = if ($null -ne $launchUri -and
            $launchUri.Query -cmatch
                '^\?desktopLaunchNonce=([A-Za-z0-9_-]{43,256})$') {
            [string]$Matches[1]
        } else {
            $null
        }
        $noncePresent = -not [string]::IsNullOrWhiteSpace($launchNonce)
        $state.LaunchOverrideNoncePresent.Add($noncePresent)
        if ($noncePresent) {
            $state.RemoteLaunchNonceDigest = Get-FixtureSha256Hex `
                -Value $launchNonce
        }
        $processId = 42001 + $state.DesktopLaunchCalls
        $identityUnavailable = (
            $state.DesktopLaunchCalls -eq 1 -and
            $Mode -cin @(
                'already-running-takeover-child-identity-unavailable-exited',
                'already-running-takeover-child-identity-unavailable-running'
            )
        )
        $handleExited = (
            $state.DesktopLaunchCalls -eq 1 -and
            $Mode -cin @(
                'already-running-takeover-child-identity-unavailable-exited',
                'already-running-takeover-created-state-unverified-exited'
            )
        )
        return [pscustomobject]@{
            Id = $processId
            ExecutablePath = $DesktopExecutablePath
            StartTimeUtcTicks = if ($identityUnavailable) {
                0
            } else {
                638900000000000000 + $state.DesktopLaunchCalls
            }
            HasExited = $handleExited
        }
    } `
    -GetCreatedDesktopStateAction {
        param(
            [int]$ProcessId,
            [long]$StartTimeUtcTicks
        )
        $null = $ProcessId
        $null = $StartTimeUtcTicks
        $state.CreatedProcessChecks++
        if ($Mode -ceq 'early-exit' -and
            $state.DesktopLaunchCalls -eq 1) {
            return 'exited'
        }
        if ($Mode -ceq 'identity-unverified') {
            return 'identity-mismatch'
        }
        if ($state.DesktopLaunchCalls -eq 1 -and
            $Mode -cin @(
                'already-running-takeover-created-state-unverified-exited',
                'already-running-takeover-created-state-unverified-running'
            )) {
            return 'identity-unverified'
        }
        return 'running'
    } `
    -GetCreatedDesktopProcessHandleStateAction {
        param([object]$Process)

        $state.ProcessHandleChecks++
        if ([bool]$Process.HasExited) {
            return 'exited'
        }
        return 'running'
    } `
    -StopCreatedDesktopAction {
        param(
            [int]$ProcessId,
            [long]$StartTimeUtcTicks,
            [string]$ExpectedExecutablePath
        )
        $null = $ProcessId
        $null = $StartTimeUtcTicks
        if ($ExpectedExecutablePath -cne
            'C:\fixture\OpenAI.Codex\ChatGPT.exe') {
            return 'identity-unverified'
        }
        $state.StopCalls++
        if ($ProcessId -eq 42001) {
            if ($Mode -ceq 'already-running-takeover-stop-failed') {
                return 'identity-unverified'
            }
            $state.ExistingDesktopStopped = $true
        }
        return 'stopped'
    } `
    -ExistingDesktopOwnerProof $existingDesktopOwnerProof `
    -TakeOverExistingNativeDesktop:(
        $Mode -cin @(
            'already-running-managed-takeover',
            'already-running-proven-remote',
            'already-running-arbitrary-bridge',
            'already-running-managed-start-failed',
            'already-running-takeover-stop-failed',
            'already-running-takeover-readiness-drift',
            'already-running-takeover-unsafe',
            'already-running-takeover-desktop-connected-drift',
            'already-running-takeover-root-drift',
            'already-running-takeover-root-count-drift',
            'already-running-takeover-child-identity-unavailable-exited',
            'already-running-takeover-child-identity-unavailable-running',
            'already-running-takeover-created-state-unverified-exited',
            'already-running-takeover-created-state-unverified-running'
        )
    ) `
    -RemoteStartupTimeoutMilliseconds 0 `
    -RemoteAttachTimeoutMilliseconds $remoteAttachTimeoutMilliseconds `
    -RemoteAttachRequiredObservations 2 `
    -RemotePollMilliseconds 1 `
    -LaunchCorrelationId $requestedLaunchCorrelationId

$feedback = Get-CodexRemoteLaunchFeedback -Result $result

[pscustomobject]@{
    Result = $result
    Feedback = $feedback
    State = $state
    ParentOverride = [string]$env:CODEX_APP_SERVER_WS_URL
    OriginalOverride = $originalOverride
    CapabilityEndpoint = $capabilityEndpoint
} | ConvertTo-Json -Compress -Depth 10 -EscapeHandling EscapeNonAscii
