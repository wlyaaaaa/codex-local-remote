[CmdletBinding()]
param(
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexLocalRemote'),

    [ValidateRange(1, 65535)]
    [int]$BrokerPort = 18791,

    [string]$TaskName = 'Codex Local Remote',

    [ValidateRange(0, 60)]
    [int]$InfrastructureStartupTimeoutSeconds = 30,

    [ValidateRange(1, 60)]
    [int]$DesktopAttachTimeoutSeconds = 15,

    [switch]$SuppressNotification,

    [Parameter(DontShow)]
    [switch]$DefinitionOnly
)

$ErrorActionPreference = 'Stop'
$script:WindowsModuleAvailable = $false
try {
    Import-Module `
        (Join-Path $PSScriptRoot 'CodexLocalRemote.Windows.psm1') `
        -Force `
        -ErrorAction Stop
    $script:WindowsModuleAvailable = $true
} catch {
    # The native Desktop fallback below deliberately remains available even if
    # the optional Remote integration module cannot load.
}

function Get-RunningCodexDesktopProcesses {
    [CmdletBinding()]
    param()

    return @(
        Get-CimInstance `
            Win32_Process `
            -Filter "Name = 'ChatGPT.exe'" `
            -ErrorAction SilentlyContinue |
            Where-Object {
                $path = [string]$_.ExecutablePath
                [string]::IsNullOrWhiteSpace($path) -or
                $path -match
                    '(?i)\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$'
            }
    )
}

function Resolve-NativeCodexDesktopRuntime {
    [CmdletBinding()]
    param()

    $packages = @(
        Get-AppxPackage `
            -Name 'OpenAI.Codex' `
            -ErrorAction Stop |
            Where-Object {
                [string]$_.PackageFamilyName -ceq
                    'OpenAI.Codex_2p2nqsd0c76g0' -and
                [string]$_.Status -ceq 'Ok' -and
                -not [string]::IsNullOrWhiteSpace(
                    [string]$_.InstallLocation
                )
            } |
            Sort-Object Version -Descending
    )
    if ($packages.Count -eq 0) {
        throw 'No healthy Codex Desktop package is registered for this user.'
    }
    $desktopExecutablePath = [System.IO.Path]::GetFullPath(
        (Join-Path ([string]$packages[0].InstallLocation) 'app\ChatGPT.exe')
    )
    if (-not (Test-Path -LiteralPath $desktopExecutablePath -PathType Leaf)) {
        throw "The native Codex Desktop executable is missing at '$desktopExecutablePath'."
    }
    return [pscustomobject]@{
        DesktopExecutablePath = $desktopExecutablePath
        RemoteRuntimeVerified = $false
    }
}

function Get-CodexLocalRemoteReadinessSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$Port
    )

    try {
        return Invoke-RestMethod `
            -Method Get `
            -Uri "http://127.0.0.1:$Port/ready" `
            -TimeoutSec 1
    } catch {
        return $null
    }
}

function Test-CodexLocalRemoteInfrastructureSnapshot {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Readiness
    )

    if ($null -eq $Readiness) {
        return $false
    }
    $required = @(
        'status',
        'appServerReady',
        'desktopConnected',
        'sidecarConnected',
        'degraded',
        'unknownCount',
        'runtimeInvocationId',
        'brokerProcessId',
        'upstreamProcessId'
    )
    foreach ($name in $required) {
        if ($null -eq $Readiness.PSObject.Properties[$name]) {
            return $false
        }
    }
    return (
        [string]$Readiness.status -ceq 'ready' -and
        $Readiness.appServerReady -is [bool] -and
        [bool]$Readiness.appServerReady -and
        $Readiness.desktopConnected -is [bool] -and
        $Readiness.sidecarConnected -is [bool] -and
        [bool]$Readiness.sidecarConnected -and
        $Readiness.degraded -is [bool] -and
        -not [bool]$Readiness.degraded -and
        (Test-NonNegativeInteger -Value $Readiness.unknownCount) -and
        [decimal]$Readiness.unknownCount -eq 0 -and
        [string]$Readiness.runtimeInvocationId -cmatch '^[0-9a-f]{32}$' -and
        (Test-NonNegativeInteger -Value $Readiness.brokerProcessId) -and
        [decimal]$Readiness.brokerProcessId -gt 0 -and
        (Test-NonNegativeInteger -Value $Readiness.upstreamProcessId) -and
        [decimal]$Readiness.upstreamProcessId -gt 0
    )
}

function Test-CodexLocalRemoteSameGeneration {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Before,

        [AllowNull()]
        [object]$After
    )

    return (
        (Test-CodexLocalRemoteInfrastructureSnapshot -Readiness $Before) -and
        (Test-CodexLocalRemoteInfrastructureSnapshot -Readiness $After) -and
        [string]$After.runtimeInvocationId -ceq
            [string]$Before.runtimeInvocationId -and
        [decimal]$After.brokerProcessId -eq
            [decimal]$Before.brokerProcessId -and
        [decimal]$After.upstreamProcessId -eq
            [decimal]$Before.upstreamProcessId
    )
}

function Start-CodexLocalRemoteRegisteredTask {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name
    )

    $task = Get-ScheduledTask `
        -TaskName $Name `
        -TaskPath '\' `
        -ErrorAction Stop
    if ($null -eq $task -or
        [string]$task.TaskName -cne $Name -or
        [string]$task.TaskPath -cne '\' -or
        [string]$task.Description -cne
            'codex-local-remote/startup-task/v3 - Starts the loopback app-server broker before the local-only Codex Local Remote sidecar at user sign-in.') {
        throw "Scheduled task '$Name' is not the exact managed startup task."
    }
    if ([string]$task.State -cne 'Running') {
        Start-ScheduledTask -TaskName $Name -TaskPath '\'
    }
}

function Invoke-CodexDesktopScopedProcessStart {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DesktopExecutablePath,

        [AllowNull()]
        [string]$RemoteEndpoint,

        [Parameter(Mandatory)]
        [scriptblock]$StartDesktopAction
    )

    return & $StartDesktopAction $DesktopExecutablePath $RemoteEndpoint
}

function Start-CodexDesktopProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DesktopExecutablePath,

        [AllowNull()]
        [string]$RemoteEndpoint,

        [AllowEmptyCollection()]
        [string[]]$ArgumentList = @(),

        [switch]$RedirectStandardOutput
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = [System.IO.Path]::GetFullPath(
        $DesktopExecutablePath
    )
    $startInfo.WorkingDirectory = Split-Path `
        -Parent `
        $startInfo.FileName
    # Windows PowerShell's Start-Process may delegate through ShellExecute for
    # packaged applications. That path can create the real Electron process
    # outside the launcher's environment, silently dropping the scoped Broker
    # endpoint. CreateProcess semantics keep the endpoint on the exact child.
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $false
    $startInfo.RedirectStandardOutput = [bool]$RedirectStandardOutput
    foreach ($argument in $ArgumentList) {
        $startInfo.ArgumentList.Add($argument)
    }
    $null = $startInfo.Environment.Remove('CODEX_APP_SERVER_WS_URL')
    if (-not [string]::IsNullOrWhiteSpace($RemoteEndpoint)) {
        $startInfo.Environment['CODEX_APP_SERVER_WS_URL'] = $RemoteEndpoint
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            throw 'Codex Desktop process creation returned false.'
        }
        return $process
    } catch {
        $process.Dispose()
        throw
    }
}

function Write-CodexDesktopLaunchReceipt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [object]$Result
    )

    $receipt = [pscustomobject][ordered]@{
        Signature = 'codex-local-remote/desktop-launch/v1'
        Version = 1
        Status = [string]$Result.Status
        RemoteEnabled = $Result.RemoteEnabled
        RemoteDecision = [string]$Result.RemoteDecision
        RemoteFallbackAttempts = [int]$Result.RemoteFallbackAttempts
        RemoteStopAttempts = [int]$Result.RemoteStopAttempts
        DesktopProcessId = $Result.DesktopProcessId
        RecordedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    Write-AtomicJsonFile `
        -Path (Join-Path $DataDir 'desktop-launch-last.json') `
        -Value $receipt
}

function Get-CodexDesktopLaunchIdentity {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Process
    )

    if ($null -eq $Process) {
        return $null
    }
    $idProperty = if ($null -ne $Process.PSObject.Properties['Id']) {
        $Process.PSObject.Properties['Id']
    } else {
        $Process.PSObject.Properties['ProcessId']
    }
    if ($null -eq $idProperty -or [int]$idProperty.Value -lt 1) {
        return $null
    }
    $startTimeUtcTicks = if (
        $null -ne $Process.PSObject.Properties['StartTimeUtcTicks']
    ) {
        [long]$Process.StartTimeUtcTicks
    } elseif ($null -ne $Process.PSObject.Properties['StartTime']) {
        ([datetime]$Process.StartTime).ToUniversalTime().Ticks
    } else {
        0
    }
    if ($startTimeUtcTicks -le 0) {
        return $null
    }
    return [pscustomobject]@{
        ProcessId = [int]$idProperty.Value
        StartTimeUtcTicks = $startTimeUtcTicks
    }
}

function Get-CodexDesktopCreatedProcessState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateRange(1, 2147483647)]
        [int]$ProcessId,

        [Parameter(Mandatory)]
        [long]$StartTimeUtcTicks
    )

    $process = Get-Process `
        -Id $ProcessId `
        -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return 'exited'
    }
    try {
        $process.Refresh()
        if ($process.HasExited) {
            return 'exited'
        }
        if ($process.StartTime.ToUniversalTime().Ticks -ne
            $StartTimeUtcTicks) {
            return 'identity-mismatch'
        }
        return 'running'
    } catch {
        return 'identity-unverified'
    } finally {
        $process.Dispose()
    }
}

function Stop-CodexDesktopCreatedProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateRange(1, 2147483647)]
        [int]$ProcessId,

        [Parameter(Mandatory)]
        [long]$StartTimeUtcTicks
    )

    try {
        $identity = Open-ProcessIdentityHandle `
            -ProcessId $ProcessId `
            -ExpectedCreationDateUtcTicks $StartTimeUtcTicks `
            -ExpectedStartTimeUtcTicks $StartTimeUtcTicks
    } catch {
        if ($null -eq (
            Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        )) {
            return 'already-exited'
        }
        return 'identity-unverified'
    }
    try {
        $stopped = Stop-ProcessIdentityHandle `
            -IdentityHandle $identity `
            -TimeoutMilliseconds 5000
        if ($stopped) {
            return 'stopped'
        }
        return 'already-exited'
    } catch {
        return 'identity-unverified'
    } finally {
        $identity.Process.Dispose()
    }
}

function ConvertFrom-UnicodeCharacterCodes {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [int[]]$CodePoints
    )

    return (($CodePoints | ForEach-Object { [char]$_ }) -join '')
}

function Get-CodexRemoteLaunchFeedback {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Result
    )

    $startedTitle = ConvertFrom-UnicodeCharacterCodes -CodePoints @(
        0x0043, 0x0068, 0x0061, 0x0074, 0x0047, 0x0050, 0x0054,
        0x0020, 0x5DF2, 0x542F, 0x52A8
    )
    if ($Result.RemoteEnabled -eq $true) {
        return [pscustomobject][ordered]@{
            Kind = 'connected'
            Title = $startedTitle
            Message = ConvertFrom-UnicodeCharacterCodes -CodePoints @(
                0x8FDC, 0x7A0B, 0x5DF2, 0x8FDE, 0x63A5, 0xFF0C,
                0x53EF, 0x4EE5, 0x4ECE, 0x624B, 0x673A, 0x7EE7,
                0x7EED, 0x4F7F, 0x7528, 0x3002
            )
            Icon = 'Info'
        }
    }
    if ([string]$Result.Status -ceq 'already-running') {
        return [pscustomobject][ordered]@{
            Kind = 'already-running'
            Title = ConvertFrom-UnicodeCharacterCodes -CodePoints @(
                0x0043, 0x0068, 0x0061, 0x0074, 0x0047, 0x0050,
                0x0054, 0x0020, 0x5DF2, 0x5728, 0x8FD0, 0x884C
            )
            Message = ConvertFrom-UnicodeCharacterCodes -CodePoints @(
                0x8FDC, 0x7A0B, 0x72B6, 0x6001, 0x672A, 0x786E,
                0x8BA4, 0xFF1B, 0x8BF7, 0x5148, 0x9000, 0x51FA,
                0x0020, 0x0043, 0x0068, 0x0061, 0x0074, 0x0047,
                0x0050, 0x0054, 0xFF0C, 0x518D, 0x4F7F, 0x7528,
                0x6B64, 0x5FEB, 0x6377, 0x65B9, 0x5F0F, 0x3002
            )
            Icon = 'Warning'
        }
    }
    return [pscustomobject][ordered]@{
        Kind = 'degraded'
        Title = $startedTitle
        Message = ConvertFrom-UnicodeCharacterCodes -CodePoints @(
            0x8FDC, 0x7A0B, 0x672A, 0x8FDE, 0x63A5, 0xFF0C,
            0x0043, 0x0068, 0x0061, 0x0074, 0x0047, 0x0050,
            0x0054, 0x0020, 0x5DF2, 0x6309, 0x539F, 0x751F,
            0x6A21, 0x5F0F, 0x542F, 0x52A8, 0x3002
        )
        Icon = 'Warning'
    }
}

function Show-CodexRemoteLaunchFeedback {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Feedback
    )

    $notification = $null
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        $notification = [System.Windows.Forms.NotifyIcon]::new()
        $notification.Icon = if ([string]$Feedback.Icon -ceq 'Info') {
            [System.Drawing.SystemIcons]::Information
        } else {
            [System.Drawing.SystemIcons]::Warning
        }
        $notification.BalloonTipIcon = if ([string]$Feedback.Icon -ceq 'Info') {
            [System.Windows.Forms.ToolTipIcon]::Info
        } else {
            [System.Windows.Forms.ToolTipIcon]::Warning
        }
        $notification.BalloonTipTitle = [string]$Feedback.Title
        $notification.BalloonTipText = [string]$Feedback.Message
        $notification.Text = ConvertFrom-UnicodeCharacterCodes -CodePoints @(
            0x8FDC, 0x7A0B, 0x8FDE, 0x63A5, 0x72B6, 0x6001
        )
        $notification.Visible = $true
        $notification.ShowBalloonTip(4000)
        Start-Sleep -Milliseconds 4500
    } catch {
        # Notification failure must never block ChatGPT startup.
    } finally {
        if ($null -ne $notification) {
            $notification.Visible = $false
            $notification.Dispose()
        }
    }
}

function Invoke-CodexDesktopFailOpenLaunch {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [scriptblock]$GetRunningDesktopAction,

        [Parameter(Mandatory)]
        [scriptblock]$ResolveDesktopRuntimeAction,

        [Parameter(Mandatory)]
        [scriptblock]$GetRemoteReadinessAction,

        [Parameter(Mandatory)]
        [scriptblock]$StartRemoteAction,

        [Parameter(Mandatory)]
        [scriptblock]$GetRemoteEndpointAction,

        [Parameter(Mandatory)]
        [scriptblock]$StartDesktopAction,

        [Parameter(Mandatory)]
        [scriptblock]$GetCreatedDesktopStateAction,

        [Parameter(Mandatory)]
        [scriptblock]$StopCreatedDesktopAction,

        [ValidateRange(0, 60000)]
        [int]$RemoteStartupTimeoutMilliseconds = 30000,

        [ValidateRange(0, 60000)]
        [int]$RemoteAttachTimeoutMilliseconds = 15000,

        [ValidateRange(1, 5)]
        [int]$RemoteAttachRequiredObservations = 2,

        [ValidateRange(1, 1000)]
        [int]$RemotePollMilliseconds = 100
    )

    $running = @(& $GetRunningDesktopAction)
    if ($running.Count -gt 0) {
        return [pscustomobject][ordered]@{
            Status = 'already-running'
            RemoteEnabled = $null
            RemoteDecision = 'existing-desktop-preserved'
            RemoteFallbackAttempts = 0
            RemoteStopAttempts = 0
            DesktopProcessId = if ($null -ne $running[0].PSObject.Properties['ProcessId']) {
                [int]$running[0].ProcessId
            } else {
                $null
            }
        }
    }

    $runtime = & $ResolveDesktopRuntimeAction
    if ($null -eq $runtime -or
        [string]::IsNullOrWhiteSpace([string]$runtime.DesktopExecutablePath)) {
        throw 'The current Codex Desktop executable could not be resolved.'
    }
    $desktopExecutablePath = [System.IO.Path]::GetFullPath(
        [string]$runtime.DesktopExecutablePath
    )

    $remoteReady = $false
    $remoteDecision = 'remote-not-ready'
    $remoteReadiness = $null
    try {
        $remoteReadiness = & $GetRemoteReadinessAction
        $remoteReady = Test-CodexLocalRemoteInfrastructureSnapshot `
            -Readiness $remoteReadiness
    } catch {
        $remoteDecision = 'remote-health-check-failed'
    }

    if ($remoteReady -and [bool]$remoteReadiness.desktopConnected) {
        return [pscustomobject][ordered]@{
            Status = 'already-running'
            RemoteEnabled = $true
            RemoteDecision = 'broker-reports-desktop-connected'
            RemoteFallbackAttempts = 0
            RemoteStopAttempts = 0
            DesktopProcessId = $null
        }
    }

    if (-not $remoteReady) {
        $remoteStartFailed = $false
        try {
            & $StartRemoteAction
        } catch {
            $remoteStartFailed = $true
            $remoteDecision = 'remote-start-failed'
        }

        if (-not $remoteStartFailed) {
            $deadline = [DateTime]::UtcNow.AddMilliseconds(
                $RemoteStartupTimeoutMilliseconds
            )
            do {
                try {
                    $remoteReadiness = & $GetRemoteReadinessAction
                    $remoteReady =
                        Test-CodexLocalRemoteInfrastructureSnapshot `
                            -Readiness $remoteReadiness
                } catch {
                    $remoteDecision = 'remote-health-check-failed'
                    $remoteReady = $false
                }
                if ($remoteReady) {
                    break
                }
                if ([DateTime]::UtcNow -ge $deadline) {
                    break
                }
                Start-Sleep -Milliseconds $RemotePollMilliseconds
            } while ($true)
        }
    }

    if ($remoteReady -and [bool]$remoteReadiness.desktopConnected) {
        return [pscustomobject][ordered]@{
            Status = 'already-running'
            RemoteEnabled = $true
            RemoteDecision = 'broker-reports-desktop-connected'
            RemoteFallbackAttempts = 0
            RemoteStopAttempts = 0
            DesktopProcessId = $null
        }
    }

    $remoteEndpoint = $null
    if ($remoteReady) {
        try {
            $candidateEndpoint = [string](& $GetRemoteEndpointAction)
            $null = Assert-LoopbackWebSocketUrl `
                -WebSocketUrl ($candidateEndpoint -replace '/ws/[A-Za-z0-9_-]+$', '')
            if ($candidateEndpoint -cnotmatch
                "^ws://127\.0\.0\.1:\d+/ws/[A-Za-z0-9_-]{32,}$") {
                throw 'The managed Broker capability endpoint is invalid.'
            }
            $remoteEndpoint = $candidateEndpoint
            $remoteDecision = 'remote-ready'
        } catch {
            $remoteReady = $false
            $remoteDecision = 'remote-endpoint-unavailable'
        }
    }

    if (-not $remoteReady) {
        $desktopProcess = Invoke-CodexDesktopScopedProcessStart `
            -DesktopExecutablePath $desktopExecutablePath `
            -RemoteEndpoint $null `
            -StartDesktopAction $StartDesktopAction
        $desktopIdentity = Get-CodexDesktopLaunchIdentity `
            -Process $desktopProcess
        return [pscustomobject][ordered]@{
            Status = 'launched-native'
            RemoteEnabled = $false
            RemoteDecision = $remoteDecision
            RemoteFallbackAttempts = 0
            RemoteStopAttempts = 0
            DesktopExecutablePath = $desktopExecutablePath
            DesktopProcessId = if ($null -eq $desktopIdentity) {
                $null
            } else {
                [int]$desktopIdentity.ProcessId
            }
        }
    }

    try {
        $desktopProcess = Invoke-CodexDesktopScopedProcessStart `
            -DesktopExecutablePath $desktopExecutablePath `
            -RemoteEndpoint $remoteEndpoint `
            -StartDesktopAction $StartDesktopAction
    } catch {
        $fallbackProcess = Invoke-CodexDesktopScopedProcessStart `
            -DesktopExecutablePath $desktopExecutablePath `
            -RemoteEndpoint $null `
            -StartDesktopAction $StartDesktopAction
        $fallbackIdentity = Get-CodexDesktopLaunchIdentity `
            -Process $fallbackProcess
        return [pscustomobject][ordered]@{
            Status = 'launched-native'
            RemoteEnabled = $false
            RemoteDecision = 'remote-desktop-launch-failed'
            RemoteFallbackAttempts = 1
            RemoteStopAttempts = 0
            DesktopExecutablePath = $desktopExecutablePath
            DesktopProcessId = if ($null -eq $fallbackIdentity) {
                $null
            } else {
                [int]$fallbackIdentity.ProcessId
            }
        }
    }

    $desktopIdentity = Get-CodexDesktopLaunchIdentity -Process $desktopProcess
    if ($null -eq $desktopIdentity) {
        return [pscustomobject][ordered]@{
            Status = 'remote-launch-unverified'
            RemoteEnabled = $false
            RemoteDecision = 'created-desktop-identity-unavailable'
            RemoteFallbackAttempts = 0
            RemoteStopAttempts = 0
            DesktopExecutablePath = $desktopExecutablePath
            DesktopProcessId = $null
        }
    }

    $attachDeadline = [DateTime]::UtcNow.AddMilliseconds(
        $RemoteAttachTimeoutMilliseconds
    )
    $attachObservations = 0
    $everAttached = $false
    $createdProcessState = 'running'
    do {
        $createdProcessState = [string](
            & $GetCreatedDesktopStateAction `
                ([int]$desktopIdentity.ProcessId) `
                ([long]$desktopIdentity.StartTimeUtcTicks)
        )
        if ($createdProcessState -ceq 'exited') {
            break
        }
        if ($createdProcessState -cne 'running') {
            return [pscustomobject][ordered]@{
                Status = 'remote-launch-unverified'
                RemoteEnabled = $false
                RemoteDecision = 'created-desktop-identity-unverified'
                RemoteFallbackAttempts = 0
                RemoteStopAttempts = 0
                DesktopExecutablePath = $desktopExecutablePath
                DesktopProcessId = [int]$desktopIdentity.ProcessId
            }
        }

        $afterLaunchReadiness = $null
        try {
            $afterLaunchReadiness = & $GetRemoteReadinessAction
        } catch {
            $afterLaunchReadiness = $null
        }
        if ((Test-CodexLocalRemoteSameGeneration `
            -Before $remoteReadiness `
            -After $afterLaunchReadiness) -and
            [bool]$afterLaunchReadiness.desktopConnected) {
            $everAttached = $true
            $attachObservations++
            if ($attachObservations -ge
                $RemoteAttachRequiredObservations) {
                return [pscustomobject][ordered]@{
                    Status = 'launched-remote'
                    RemoteEnabled = $true
                    RemoteDecision = 'remote-attached'
                    RemoteFallbackAttempts = 0
                    RemoteStopAttempts = 0
                    DesktopExecutablePath = $desktopExecutablePath
                    DesktopProcessId = [int]$desktopIdentity.ProcessId
                }
            }
        } else {
            $attachObservations = 0
        }

        if ([DateTime]::UtcNow -ge $attachDeadline) {
            break
        }
        Start-Sleep -Milliseconds $RemotePollMilliseconds
    } while ($true)

    if ($createdProcessState -ceq 'exited') {
        $fallbackProcess = Invoke-CodexDesktopScopedProcessStart `
            -DesktopExecutablePath $desktopExecutablePath `
            -RemoteEndpoint $null `
            -StartDesktopAction $StartDesktopAction
        $fallbackIdentity = Get-CodexDesktopLaunchIdentity `
            -Process $fallbackProcess
        return [pscustomobject][ordered]@{
            Status = 'launched-native'
            RemoteEnabled = $false
            RemoteDecision = 'remote-desktop-exited-before-attach'
            RemoteFallbackAttempts = 1
            RemoteStopAttempts = 0
            DesktopExecutablePath = $desktopExecutablePath
            DesktopProcessId = if ($null -eq $fallbackIdentity) {
                $null
            } else {
                [int]$fallbackIdentity.ProcessId
            }
        }
    }

    if ($everAttached) {
        return [pscustomobject][ordered]@{
            Status = 'remote-launch-unverified'
            RemoteEnabled = $false
            RemoteDecision = 'remote-attached-then-unverified-process-preserved'
            RemoteFallbackAttempts = 0
            RemoteStopAttempts = 0
            DesktopExecutablePath = $desktopExecutablePath
            DesktopProcessId = [int]$desktopIdentity.ProcessId
        }
    }

    $stopResult = [string](
        & $StopCreatedDesktopAction `
            ([int]$desktopIdentity.ProcessId) `
            ([long]$desktopIdentity.StartTimeUtcTicks)
    )
    if ($stopResult -cnotin @('stopped', 'already-exited')) {
        return [pscustomobject][ordered]@{
            Status = 'remote-launch-unverified'
            RemoteEnabled = $false
            RemoteDecision = 'remote-attach-failed-process-preserved'
            RemoteFallbackAttempts = 0
            RemoteStopAttempts = 1
            DesktopExecutablePath = $desktopExecutablePath
            DesktopProcessId = [int]$desktopIdentity.ProcessId
        }
    }

    $fallbackProcess = Invoke-CodexDesktopScopedProcessStart `
        -DesktopExecutablePath $desktopExecutablePath `
        -RemoteEndpoint $null `
        -StartDesktopAction $StartDesktopAction
    $fallbackIdentity = Get-CodexDesktopLaunchIdentity `
        -Process $fallbackProcess
    return [pscustomobject][ordered]@{
        Status = 'launched-native'
        RemoteEnabled = $false
        RemoteDecision = 'remote-broker-lost-before-attach'
        RemoteFallbackAttempts = 1
        RemoteStopAttempts = 1
        DesktopExecutablePath = $desktopExecutablePath
        DesktopProcessId = if ($null -eq $fallbackIdentity) {
            $null
        } else {
            [int]$fallbackIdentity.ProcessId
        }
    }
}

if (-not $DefinitionOnly) {
    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
    $script:RemoteRuntimeVerifiedForLaunch = $false
    $launchResult = Invoke-CodexDesktopFailOpenLaunch `
        -GetRunningDesktopAction {
            Get-RunningCodexDesktopProcesses
        } `
        -ResolveDesktopRuntimeAction {
            if ($script:WindowsModuleAvailable) {
                try {
                    $verifiedRuntime = Resolve-CodexDesktopRuntime
                    $script:RemoteRuntimeVerifiedForLaunch = $true
                    return $verifiedRuntime
                } catch {
                    $script:RemoteRuntimeVerifiedForLaunch = $false
                }
            }
            Resolve-NativeCodexDesktopRuntime
        } `
        -GetRemoteReadinessAction {
            if (-not $script:RemoteRuntimeVerifiedForLaunch) {
                return $null
            }
            Get-CodexLocalRemoteReadinessSnapshot -Port $BrokerPort
        } `
        -StartRemoteAction {
            Start-CodexLocalRemoteRegisteredTask -Name $TaskName
        } `
        -GetRemoteEndpointAction {
            Get-BrokerCapabilityWebSocketUrl `
                -Port $BrokerPort `
                -TokenPath (
                    Get-BrokerCapabilityTokenPath -DataDir $resolvedDataDir
                )
        } `
        -StartDesktopAction {
            param(
                [string]$DesktopExecutablePath,
                [AllowNull()]
                [string]$RemoteEndpoint
            )
            Start-CodexDesktopProcess `
                -DesktopExecutablePath $DesktopExecutablePath `
                -RemoteEndpoint $RemoteEndpoint
        } `
        -GetCreatedDesktopStateAction {
            param(
                [int]$ProcessId,
                [long]$StartTimeUtcTicks
            )
            Get-CodexDesktopCreatedProcessState `
                -ProcessId $ProcessId `
                -StartTimeUtcTicks $StartTimeUtcTicks
        } `
        -StopCreatedDesktopAction {
            param(
                [int]$ProcessId,
                [long]$StartTimeUtcTicks
            )
            Stop-CodexDesktopCreatedProcess `
                -ProcessId $ProcessId `
                -StartTimeUtcTicks $StartTimeUtcTicks
        } `
        -RemoteStartupTimeoutMilliseconds (
            $InfrastructureStartupTimeoutSeconds * 1000
        ) `
        -RemoteAttachTimeoutMilliseconds (
            $DesktopAttachTimeoutSeconds * 1000
        )
    if ($script:WindowsModuleAvailable) {
        try {
            Write-CodexDesktopLaunchReceipt `
                -DataDir $resolvedDataDir `
                -Result $launchResult
        } catch {
            # Receipt failure must never block Desktop startup.
        }
    }
    $launchFeedback = Get-CodexRemoteLaunchFeedback -Result $launchResult
    if (-not $SuppressNotification) {
        Show-CodexRemoteLaunchFeedback -Feedback $launchFeedback
    }
    $launchResult
}
