[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LauncherPath,

    [Parameter(Mandatory)]
    [ValidateSet(
        'port-refused',
        'ready',
        'cold-start',
        'start-failed',
        'already-running',
        'broker-before-attach-death',
        'early-exit',
        'identity-unverified'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
. $LauncherPath -DefinitionOnly

$state = [pscustomobject]@{
    HealthChecks = 0
    RemoteStartCalls = 0
    DesktopLaunchCalls = 0
    CreatedProcessChecks = 0
    StopCalls = 0
    ChildOverridePresent = $false
    ChildOverride = $null
    LaunchOverrides = [System.Collections.Generic.List[object]]::new()
}
$originalOverride = 'ws://127.0.0.1:49999/original-parent-value'
$env:CODEX_APP_SERVER_WS_URL = $originalOverride
$capabilityEndpoint = (
    'ws://127.0.0.1:18791/ws/' +
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789_-'
)

function New-ReadinessSnapshot {
    param([bool]$DesktopConnected)

    return [pscustomobject]@{
        status = 'ready'
        appServerReady = $true
        desktopConnected = $DesktopConnected
        sidecarConnected = $true
        degraded = $false
        unknownCount = 0
        runtimeInvocationId = '0123456789abcdef0123456789abcdef'
        brokerProcessId = 41001
        upstreamProcessId = 41002
    }
}

$result = Invoke-CodexDesktopFailOpenLaunch `
    -GetRunningDesktopAction {
        if ($Mode -ceq 'already-running') {
            [pscustomobject]@{ ProcessId = 42001 }
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
            'broker-before-attach-death',
            'early-exit',
            'identity-unverified'
        )) {
            if ($Mode -ceq 'cold-start') {
                if ($state.RemoteStartCalls -eq 0) {
                    return $null
                }
                return New-ReadinessSnapshot `
                    -DesktopConnected ($state.DesktopLaunchCalls -gt 0)
            }
            if ($state.HealthChecks -eq 1) {
                return New-ReadinessSnapshot -DesktopConnected $false
            }
            if ($Mode -ceq 'ready') {
                return New-ReadinessSnapshot -DesktopConnected $true
            }
        }
        return $null
    } `
    -StartRemoteAction {
        $state.RemoteStartCalls++
        if ($Mode -ceq 'start-failed') {
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
            $RemoteEndpoint
        } else {
            $null
        }
        $state.LaunchOverrides.Add($state.ChildOverride)
        $processId = 42001 + $state.DesktopLaunchCalls
        return [pscustomobject]@{
            Id = $processId
            ExecutablePath = $DesktopExecutablePath
            StartTimeUtcTicks = 638900000000000000 +
                $state.DesktopLaunchCalls
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
        return 'running'
    } `
    -StopCreatedDesktopAction {
        param(
            [int]$ProcessId,
            [long]$StartTimeUtcTicks
        )
        $null = $ProcessId
        $null = $StartTimeUtcTicks
        $state.StopCalls++
        return 'stopped'
    } `
    -RemoteStartupTimeoutMilliseconds 0 `
    -RemoteAttachTimeoutMilliseconds 0 `
    -RemoteAttachRequiredObservations 1 `
    -RemotePollMilliseconds 1

$feedback = Get-CodexRemoteLaunchFeedback -Result $result

[pscustomobject]@{
    Result = $result
    Feedback = $feedback
    State = $state
    ParentOverride = [string]$env:CODEX_APP_SERVER_WS_URL
    OriginalOverride = $originalOverride
    CapabilityEndpoint = $capabilityEndpoint
} | ConvertTo-Json -Compress -Depth 10 -EscapeHandling EscapeNonAscii
