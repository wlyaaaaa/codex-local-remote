[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)]
    [string]$NodePath,

    [Parameter(Mandatory)]
    [string]$ExpectedSidecarCliPath,

    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexLocalRemote'),

    [ValidateRange(1, 65535)]
    [int]$Port = 18790,

    [string]$BasePath = '/codex-remote',

    [ValidateRange(1, 2147483647)]
    [int]$ExpectedProcessId
)

$ErrorActionPreference = 'Stop'
$expectedProcessIdWasProvided = $PSBoundParameters.ContainsKey('ExpectedProcessId')
Import-Module (Join-Path $PSScriptRoot 'CodexLocalRemote.Windows.psm1') -Force
$managedConfiguration = Get-CodexLocalRemoteManagedConfiguration -DataDir $DataDir
if ($null -ne $managedConfiguration) {
    if (-not $PSBoundParameters.ContainsKey('Port')) {
        $Port = [int]$managedConfiguration.SidecarPort
    }
    if (-not $PSBoundParameters.ContainsKey('BasePath')) {
        $BasePath = [string]$managedConfiguration.BasePath
    }
}
Assert-CanonicalBasePath -BasePath $BasePath

$resolvedNode = [System.IO.Path]::GetFullPath($NodePath)
$resolvedCli = [System.IO.Path]::GetFullPath($ExpectedSidecarCliPath)
$resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)

function Get-SidecarListeners {
    return @(
        Get-NetTCPConnection `
            -State Listen `
            -LocalPort $Port `
            -ErrorAction SilentlyContinue
    )
}

function Get-ManagedSidecarOwnerSnapshot {
    $observedProcessId = $null
    for ($attempt = 0; $attempt -lt 2; $attempt++) {
        $listeners = @(Get-SidecarListeners)
        if ($listeners.Count -eq 0) {
            return [pscustomobject]@{
                Status = 'not-found'
                ProcessId = $null
                Process = $null
            }
        }
        if (@(
            $listeners |
                Where-Object {
                    -not (Test-IsLoopbackListenerAddress -Address $_.LocalAddress)
                }
        ).Count -gt 0) {
            throw "TCP port $Port has a non-loopback listener; refusing to stop it."
        }
        $managedListeners = @(Get-ManagedIpv4Listeners -Listeners $listeners)
        if ($managedListeners.Count -eq 0) {
            return [pscustomobject]@{
                Status = 'not-found'
                ProcessId = $null
                Process = $null
            }
        }
        $listenerPids = @(
            $managedListeners |
                Select-Object -ExpandProperty OwningProcess -Unique
        )
        if ($listenerPids.Count -ne 1) {
            throw "TCP port $Port does not have one exclusive listener owner; refusing to stop it."
        }

        $processId = [int]$listenerPids[0]
        if ($null -ne $observedProcessId -and $processId -ne $observedProcessId) {
            throw "TCP port $Port ownership changed during bounded verification; refusing to stop either PID."
        }
        $observedProcessId = $processId
        $process = Get-CimInstance `
            Win32_Process `
            -Filter "ProcessId = $processId" `
            -ErrorAction SilentlyContinue
        if ($null -eq $process) {
            if ($attempt -eq 0) {
                continue
            }
            throw "TCP port $Port owner PID $processId disappeared during bounded verification."
        }
        $ownership = Test-ManagedSidecarProcess `
            -CommandLine ([string]$process.CommandLine) `
            -ExecutablePath ([string]$process.ExecutablePath) `
            -ExpectedNodePath $resolvedNode `
            -ExpectedSidecarCliPath $resolvedCli `
            -Port $Port `
            -BasePath $BasePath `
            -DataDir $resolvedDataDir
        if (-not $ownership.IsManaged) {
            throw "TCP port $Port owner PID $processId is not the exact managed Sidecar ($($ownership.Reason)); refusing to stop it."
        }

        return [pscustomobject]@{
            Status = 'managed'
            ProcessId = $processId
            Process = $process
        }
    }
}

$initialOwner = Get-ManagedSidecarOwnerSnapshot
if ($initialOwner.Status -ceq 'not-found') {
    [pscustomobject]@{ Status = 'not-found'; ProcessId = $null }
    return
}
if ($expectedProcessIdWasProvided -and
    [int]$initialOwner.ProcessId -ne $ExpectedProcessId) {
    throw "Fresh managed Sidecar PID $($initialOwner.ProcessId) does not match expected PID $ExpectedProcessId; refusing to stop it."
}

$processId = [int]$initialOwner.ProcessId
$process = $initialOwner.Process
$creationIdentity = Get-ProcessCreationIdentity -CreationDate $process.CreationDate
$identityHandle = Open-ProcessIdentityHandle `
    -ProcessId $processId `
    -ExpectedCreationDateUtcTicks $creationIdentity.CreationDateUtcTicks
$snapshot = [pscustomobject]@{
    ProcessId = $processId
    CreationDateUtcTicks = [long]$creationIdentity.CreationDateUtcTicks
    CommandLine = [string]$process.CommandLine
    ExecutablePath = [string]$process.ExecutablePath
}
try {
    $description = "exact managed Sidecar PID $processId on 127.0.0.1:$Port"
    if (-not $PSCmdlet.ShouldProcess($description, 'Stop verified process')) {
        [pscustomobject]@{ Status = 'what-if'; ProcessId = $processId }
        return
    }

    $currentOwner = Get-ManagedSidecarOwnerSnapshot
    if ($currentOwner.Status -ceq 'not-found') {
        [pscustomobject]@{ Status = 'already-stopped'; ProcessId = $processId }
        return
    }

    $current = $currentOwner.Process
    $currentCreationIdentity = Get-ProcessCreationIdentity `
        -CreationDate $current.CreationDate
    if ([int]$currentOwner.ProcessId -ne $processId -or
        [long]$currentCreationIdentity.CreationDateUtcTicks -ne
            $snapshot.CreationDateUtcTicks -or
        [string]$current.CommandLine -cne $snapshot.CommandLine -or
        [string]$current.ExecutablePath -cne $snapshot.ExecutablePath) {
        throw "Managed Sidecar ownership changed before stop; refusing to stop PID $processId."
    }

    try {
        $stopped = Stop-ProcessIdentityHandle -IdentityHandle $identityHandle
    } catch {
        if (@(
            Get-ManagedIpv4Listeners -Listeners @(Get-SidecarListeners)
        ).Count -eq 0) {
            [pscustomobject]@{ Status = 'already-stopped'; ProcessId = $processId }
            return
        }
        throw "TCP port $Port remained occupied after stopping exact managed Sidecar PID $processId raced with process exit."
    }
    if (-not $stopped) {
        if (@(
            Get-ManagedIpv4Listeners -Listeners @(Get-SidecarListeners)
        ).Count -eq 0) {
            [pscustomobject]@{ Status = 'already-stopped'; ProcessId = $processId }
            return
        }
        throw "TCP port $Port remained occupied after the exact managed Sidecar exited."
    }
    if (@(
        Get-ManagedIpv4Listeners -Listeners @(Get-SidecarListeners)
    ).Count -gt 0) {
        throw "TCP port $Port remained occupied after the exact managed Sidecar stopped."
    }

    [pscustomobject]@{ Status = 'stopped'; ProcessId = $processId }
} finally {
    $identityHandle.Process.Dispose()
}
