[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$CodexPath,

    [Parameter(Mandatory)]
    [string]$NodePath,

    [string]$InstallRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,

    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexLocalRemote'),

    [ValidateRange(1, 65535)]
    [int]$BrokerPort = 18791,

    [ValidateRange(1, 65535)]
    [int]$BrokerUpstreamPort = 18792
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'CodexLocalRemote.Windows.psm1') -Force
$managedConfiguration = Get-CodexLocalRemoteManagedConfiguration -DataDir $DataDir
if ($null -ne $managedConfiguration) {
    if (-not $PSBoundParameters.ContainsKey('BrokerPort')) {
        $BrokerPort = [int]$managedConfiguration.BrokerPort
    }
    if (-not $PSBoundParameters.ContainsKey('BrokerUpstreamPort')) {
        $BrokerUpstreamPort = [int]$managedConfiguration.BrokerUpstreamPort
    }
}

$resolvedCodex = if ([string]::IsNullOrWhiteSpace($CodexPath)) {
    $null
} else {
    [System.IO.Path]::GetFullPath($CodexPath)
}
$resolvedNode = [System.IO.Path]::GetFullPath($NodePath)
$resolvedRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$brokerCli = [System.IO.Path]::GetFullPath(
    (Join-Path $resolvedRoot 'apps\broker\dist\cli.js')
)
$resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
$capabilityTokenPath = Get-BrokerCapabilityTokenPath -DataDir $resolvedDataDir
$upstreamTokenPath = [System.IO.Path]::GetFullPath(
    (Join-Path $resolvedDataDir 'app-server-upstream.token')
)
$statePath = Join-Path $resolvedDataDir 'app-server-broker.json'

function Get-ExactListenerOwner {
    param(
        [Parameter(Mandatory)]
        [int]$Port
    )

    $listeners = @(
        Get-NetTCPConnection `
            -State Listen `
            -LocalPort $Port `
            -ErrorAction SilentlyContinue
    )
    if ($listeners.Count -eq 0) {
        return $null
    }
    if (@(
        $listeners |
            Where-Object {
                -not (Test-IsLoopbackListenerAddress -Address $_.LocalAddress)
            }
    ).Count -gt 0) {
        return [pscustomobject]@{ Status = 'foreign-listener'; ProcessId = $null }
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
        return [pscustomobject]@{ Status = 'ambiguous-listener'; ProcessId = $null }
    }
    return [pscustomobject]@{ Status = 'single-loopback-owner'; ProcessId = [int]$pids[0] }
}

function Get-ProcessSnapshot {
    param([Parameter(Mandatory)][int]$ProcessId)

    return Get-CimInstance `
        Win32_Process `
        -Filter "ProcessId = $ProcessId" `
        -ErrorAction SilentlyContinue
}

function Test-ExactBrokerProcess {
    param([Parameter(Mandatory)][object]$Process)

    return Test-ManagedBrokerProcess `
        -CommandLine ([string]$Process.CommandLine) `
        -ExecutablePath ([string]$Process.ExecutablePath) `
        -ExpectedNodePath $resolvedNode `
        -ExpectedBrokerCliPath $brokerCli `
        -BrokerPort $BrokerPort `
        -UpstreamPort $BrokerUpstreamPort `
        -ExpectedCodexPath $resolvedCodex `
        -DataDir $resolvedDataDir `
        -CapabilityTokenFilePath $capabilityTokenPath
}

function Test-ExactUpstreamProcess {
    param([Parameter(Mandatory)][object]$Process)

    return Test-ManagedAppServerProcess `
        -CommandLine ([string]$Process.CommandLine) `
        -ExecutablePath ([string]$Process.ExecutablePath) `
        -ExpectedCodexPath $resolvedCodex `
        -WebSocketUrl (Get-BrokerWebSocketUrl -Port $BrokerUpstreamPort) `
        -TokenFilePath $upstreamTokenPath
}

function Assert-HeldTargetFresh {
    param(
        [Parameter(Mandatory)][object]$Target,
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][ValidateSet('Broker', 'Upstream')][string]$Kind
    )

    $owner = Get-ExactListenerOwner -Port $Port
    if ($null -eq $owner) {
        return $false
    }
    if ($owner.Status -cne 'single-loopback-owner' -or
        [int]$owner.ProcessId -ne [int]$Target.ProcessId) {
        throw "$Kind listener ownership changed before stop; refusing to stop any replacement."
    }
    $current = Get-ProcessSnapshot -ProcessId ([int]$Target.ProcessId)
    if ($null -eq $current) {
        $Target.IdentityHandle.Process.Refresh()
        if (-not $Target.IdentityHandle.Process.HasExited) {
            throw "$Kind PID $($Target.ProcessId) disappeared from the process snapshot while its held startup-identity handle remained live."
        }

        # Stopping the Broker can make its owned app-server exit before the
        # Windows TCP table has retired the final listener row. Accept only
        # that exact held-process exit, and only after the same PID's
        # loopback listener is fresh-proven empty. A replacement owner still
        # fails closed.
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            $afterExitOwner = Get-ExactListenerOwner -Port $Port
            if ($null -eq $afterExitOwner) {
                return $false
            }
            if ($afterExitOwner.Status -cne 'single-loopback-owner' -or
                [int]$afterExitOwner.ProcessId -ne [int]$Target.ProcessId) {
                throw "$Kind listener ownership changed while the exited held process was releasing its port; refusing to adopt any replacement."
            }
            if ($attempt -lt 19) {
                Start-Sleep -Milliseconds 50
            }
        }
        throw "$Kind held process exited but its exact listener did not clear within the bounded release window."
    }
    $creation = Get-ProcessCreationIdentity -CreationDate $current.CreationDate
    $ownership = if ($Kind -ceq 'Broker') {
        Test-ExactBrokerProcess -Process $current
    } else {
        Test-ExactUpstreamProcess -Process $current
    }
    if (-not $ownership.IsManaged -or
        [long]$creation.CreationDateUtcTicks -ne
            [long]$Target.CreationDateUtcTicks -or
        [string]$current.ExecutablePath -cne [string]$Target.ExecutablePath -or
        [string]$current.CommandLine -cne [string]$Target.CommandLine) {
        throw "$Kind PID $($Target.ProcessId) changed creation identity, executable, or full argv before stop."
    }
    $Target.IdentityHandle.Process.Refresh()
    if ($Target.IdentityHandle.Process.HasExited -or
        $Target.IdentityHandle.Process.StartTime.ToUniversalTime().Ticks -ne
            [long]$Target.IdentityHandle.StartTimeUtcTicks) {
        throw "$Kind held process handle no longer matches the verified startup identity."
    }
    return $true
}

$stateExists = Test-Path -LiteralPath $statePath -PathType Leaf
$state = $null
if ($stateExists) {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -Depth 20
    $requiredStateProperties = @(
        'Signature',
        'Version',
        'RuntimeInvocationId',
        'Broker',
        'Upstream',
        'ProcessId',
        'CreationDate',
        'CreationDateUtcTicks',
        'ProcessStartTimeUtcTicks',
        'CodexPath',
        'NodePath',
        'BrokerCliPath'
    )
    if (@(
        $requiredStateProperties |
            Where-Object { $null -eq $state.PSObject.Properties[$_] }
    ).Count -gt 0) {
        throw "Broker state '$statePath' lacks required process identity fields; refusing to stop any process."
    }
    $recordedCodexPath = try {
        [System.IO.Path]::GetFullPath([string]$state.CodexPath)
    } catch {
        throw "Broker state '$statePath' has an invalid Codex runtime path; refusing to stop any process."
    }
    if ($null -ne $resolvedCodex -and
        -not [string]::Equals(
            $resolvedCodex,
            $recordedCodexPath,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw "The requested Codex runtime does not match the active managed receipt; refusing to stop the old or new generation."
    }
    $resolvedCodex = $recordedCodexPath
    $validInvocationId = [string]$state.RuntimeInvocationId -cmatch '^[0-9a-f]{32}$'
    $brokerState = $state.Broker
    if (-not $validInvocationId -or
        $null -eq $brokerState -or
        [string]$state.Signature -cne 'codex-local-remote/app-server-broker/v3' -or
        [int]$state.Version -ne 3 -or
        [string]$state.Status -cnotin @('broker-ready', 'ready') -or
        [string]$brokerState.RuntimeInvocationId -cne
            [string]$state.RuntimeInvocationId -or
        -not [string]::Equals(
            [string]$state.CodexPath,
            $resolvedCodex,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        [string]$state.NodePath -cne $resolvedNode -or
        [string]$state.BrokerCliPath -cne $brokerCli -or
        [int]$state.ProcessId -le 0 -or
        [int]$brokerState.ProcessId -ne [int]$state.ProcessId -or
        [string]$brokerState.CreationDate -cne [string]$state.CreationDate -or
        [long]$brokerState.CreationDateUtcTicks -ne
            [long]$state.CreationDateUtcTicks -or
        [long]$brokerState.ProcessStartTimeUtcTicks -ne
            [long]$state.ProcessStartTimeUtcTicks -or
        [long]$state.CreationDateUtcTicks -le 0 -or
        [long]$state.ProcessStartTimeUtcTicks -le 0) {
        throw "Broker state '$statePath' is not the exact managed startup identity; refusing to stop any process."
    }
    $recordedCreation = Get-ProcessCreationIdentity `
        -CreationDate $state.CreationDate
    if ([long]$recordedCreation.CreationDateUtcTicks -ne
        [long]$state.CreationDateUtcTicks) {
        throw "Broker state '$statePath' has inconsistent CreationDate values; refusing to stop any process."
    }
}

$brokerTarget = $null
$brokerStatus = 'not-found'
$brokerOwner = Get-ExactListenerOwner -Port $BrokerPort
if ($null -ne $brokerOwner) {
    if (-not $stateExists) {
        throw "TCP port $BrokerPort is occupied without exact managed broker state; refusing to stop it."
    }
    if ($brokerOwner.Status -cne 'single-loopback-owner' -or
        [int]$brokerOwner.ProcessId -ne [int]$state.ProcessId) {
        throw "TCP port $BrokerPort is not owned by the broker startup identity in state; refusing to stop it."
    }
    $process = Get-ProcessSnapshot -ProcessId ([int]$state.ProcessId)
    if ($null -eq $process) {
        throw "Broker listener PID $($state.ProcessId) disappeared during verification."
    }
    $ownership = Test-ExactBrokerProcess -Process $process
    $creation = Get-ProcessCreationIdentity -CreationDate $process.CreationDate
    if (-not $ownership.IsManaged -or
        [long]$creation.CreationDateUtcTicks -ne
            [long]$state.CreationDateUtcTicks) {
        throw "Broker PID $($state.ProcessId) does not match state CreationDate, executable, and full argv."
    }
    $identityHandle = Open-ProcessIdentityHandle `
        -ProcessId ([int]$state.ProcessId) `
        -ExpectedCreationDateUtcTicks $creation.CreationDateUtcTicks `
        -ExpectedStartTimeUtcTicks ([long]$state.ProcessStartTimeUtcTicks)
    $brokerTarget = [pscustomobject]@{
        ProcessId = [int]$state.ProcessId
        CreationDateUtcTicks = [long]$creation.CreationDateUtcTicks
        ExecutablePath = [string]$process.ExecutablePath
        CommandLine = [string]$process.CommandLine
        IdentityHandle = $identityHandle
    }
    $brokerStatus = 'managed'
} elseif ($stateExists) {
    $staleProcess = Get-ProcessSnapshot -ProcessId ([int]$state.ProcessId)
    if ($null -ne $staleProcess) {
        throw "Broker state PID $($state.ProcessId) still exists without the exact listener; refusing PID-only termination."
    }
    $brokerStatus = 'stale-state'
}

if ($null -ne $brokerTarget) {
    $readiness = try {
        Invoke-RestMethod `
            -Method Get `
            -Uri "http://127.0.0.1:$BrokerPort/ready" `
            -TimeoutSec 2
    } catch {
        $null
    }
    if ($null -eq $readiness -or
        $null -eq $readiness.PSObject.Properties['brokerProcessId'] -or
        $null -eq $readiness.PSObject.Properties['desktopConnected'] -or
        $null -eq $readiness.PSObject.Properties['sidecarConnected'] -or
        $null -eq $readiness.PSObject.Properties['unsafeThreadCount'] -or
        [int]$readiness.brokerProcessId -ne [int]$brokerTarget.ProcessId -or
        $readiness.desktopConnected -isnot [bool] -or
        $readiness.sidecarConnected -isnot [bool] -or
        -not (Test-NonNegativeInteger -Value $readiness.unsafeThreadCount)) {
        throw 'Unable to prove that all Codex clients and turn lifecycles are safely quiescent; refusing to stop the shared Broker.'
    }
    if ([bool]$readiness.desktopConnected) {
        throw 'Codex Desktop is connected to the shared Broker. Close Desktop first; stopping the Broker would interrupt the account session.'
    }
    if ([bool]$readiness.sidecarConnected) {
        throw 'The Codex Remote Sidecar is connected to the shared Broker. Stop only the Sidecar first and verify that every remote turn has finished.'
    }
    if ([int]$readiness.unsafeThreadCount -gt 0) {
        throw 'At least one turn lifecycle is active, pending, or unknown. The shared Broker was preserved to avoid losing a task.'
    }
}

# Broker fail-stop may leave its owned app-server behind. Inspect only the
# fixed upstream port, and require its startup receipt before treating an
# otherwise identical argv as owned. Desktop stdio app-server and unrelated
# ports are never enumerated.
$upstreamTarget = $null
$upstreamStatus = 'not-found'
$upstreamOwner = Get-ExactListenerOwner -Port $BrokerUpstreamPort
if ($null -ne $upstreamOwner) {
    if (-not $stateExists -or $null -eq $state.Upstream) {
        throw "TCP port $BrokerUpstreamPort is occupied without a recorded upstream startup identity; refusing cleanup."
    }
    if ($upstreamOwner.Status -cne 'single-loopback-owner') {
        throw "TCP port $BrokerUpstreamPort has foreign or ambiguous ownership; refusing cleanup."
    }
    $upstreamProcess = Get-ProcessSnapshot -ProcessId ([int]$upstreamOwner.ProcessId)
    if ($null -eq $upstreamProcess) {
        throw "Upstream listener PID $($upstreamOwner.ProcessId) disappeared during verification."
    }
    $upstreamOwnership = Test-ExactUpstreamProcess -Process $upstreamProcess
    if (-not $upstreamOwnership.IsManaged) {
        throw "TCP port $BrokerUpstreamPort is foreign ($($upstreamOwnership.Reason)); refusing cleanup."
    }
    $upstreamCreation = Get-ProcessCreationIdentity `
        -CreationDate $upstreamProcess.CreationDate
    if ([string]$state.Upstream.RuntimeInvocationId -cne
            [string]$state.RuntimeInvocationId -or
        [int]$state.Upstream.ProcessId -ne [int]$upstreamProcess.ProcessId -or
        [long]$state.Upstream.CreationDateUtcTicks -ne
            [long]$upstreamCreation.CreationDateUtcTicks) {
        throw 'Managed upstream no longer matches the startup receipt; refusing cleanup.'
    }
    $expectedUpstreamStartTicks = [long]$state.Upstream.ProcessStartTimeUtcTicks
    $upstreamIdentityHandle = Open-ProcessIdentityHandle `
        -ProcessId ([int]$upstreamProcess.ProcessId) `
        -ExpectedCreationDateUtcTicks $upstreamCreation.CreationDateUtcTicks `
        -ExpectedStartTimeUtcTicks $expectedUpstreamStartTicks
    $upstreamTarget = [pscustomobject]@{
        ProcessId = [int]$upstreamProcess.ProcessId
        CreationDateUtcTicks = [long]$upstreamCreation.CreationDateUtcTicks
        ExecutablePath = [string]$upstreamProcess.ExecutablePath
        CommandLine = [string]$upstreamProcess.CommandLine
        IdentityHandle = $upstreamIdentityHandle
    }
    $upstreamStatus = 'managed-orphan'
}

try {
    $targetDescription = "exact managed broker/upstream on ports $BrokerPort/$BrokerUpstreamPort"
    if (-not $PSCmdlet.ShouldProcess($targetDescription, 'Stop verified managed processes')) {
        [pscustomobject]@{
            Status = 'what-if'
            BrokerStatus = $brokerStatus
            UpstreamStatus = $upstreamStatus
        }
        return
    }

    if ($null -ne $brokerTarget) {
        if (-not (Assert-HeldTargetFresh `
            -Target $brokerTarget `
            -Port $BrokerPort `
            -Kind Broker)) {
            throw 'Verified broker disappeared before stop; refusing to adopt any replacement.'
        }
        $null = Stop-ProcessIdentityHandle -IdentityHandle $brokerTarget.IdentityHandle
        if ($null -ne (Get-ExactListenerOwner -Port $BrokerPort)) {
            throw "TCP port $BrokerPort remained occupied after the held broker handle was stopped."
        }
        $brokerStatus = 'stopped'
    }
    if ($null -ne $upstreamTarget) {
        $upstreamStillPresent = Assert-HeldTargetFresh `
            -Target $upstreamTarget `
            -Port $BrokerUpstreamPort `
            -Kind Upstream
        if ($upstreamStillPresent) {
            $null = Stop-ProcessIdentityHandle `
                -IdentityHandle $upstreamTarget.IdentityHandle
        }
        if ($null -ne (Get-ExactListenerOwner -Port $BrokerUpstreamPort)) {
            throw "TCP port $BrokerUpstreamPort remained occupied after exact upstream cleanup."
        }
        $upstreamStatus = if ($upstreamStillPresent) { 'stopped' } else { 'already-stopped' }
    }
    if ($stateExists) {
        Remove-Item -LiteralPath $statePath -Force
    }

    [pscustomobject]@{
        Status = if ($brokerStatus -eq 'not-found' -and
            $upstreamStatus -eq 'not-found') {
            'not-found'
        } else {
            'completed'
        }
        BrokerStatus = $brokerStatus
        UpstreamStatus = $upstreamStatus
    }
} finally {
    if ($null -ne $brokerTarget) {
        $brokerTarget.IdentityHandle.Process.Dispose()
    }
    if ($null -ne $upstreamTarget) {
        $upstreamTarget.IdentityHandle.Process.Dispose()
    }
}
