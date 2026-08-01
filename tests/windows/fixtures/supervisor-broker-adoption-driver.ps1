[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$StartScriptPath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot,

    [Parameter(Mandatory)]
    [ValidateSet(
        'success',
        'payload-mismatch',
        'old-sidecar-live',
        'sidecar-port-occupied',
        'broker-identity-drift',
        'upstream-identity-drift',
        'invocation-identity-drift'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
$env:CODEX_REMOTE_TEST_FIXTURE = '1'
$currentVersionId = 'c' * 64
$previousVersionId = 'b' * 64
$currentManifestSha256 = 'a' * 64
$previousManifestSha256 = 'e' * 64
$runtimeInvocationId = '0123456789abcdef0123456789abcdef'
$currentRoot = Join-Path $SandboxRoot $currentVersionId
$previousRoot = Join-Path $SandboxRoot $previousVersionId
$currentBrokerCli = Join-Path $currentRoot 'apps\broker\dist\cli.js'
$previousBrokerCli = Join-Path $previousRoot 'apps\broker\dist\cli.js'
$null = New-Item -ItemType Directory -Path (Split-Path -Parent $currentBrokerCli) -Force
$null = New-Item -ItemType Directory -Path (Split-Path -Parent $previousBrokerCli) -Force
Set-Content -LiteralPath $currentBrokerCli -Value 'current-broker' -NoNewline
Set-Content -LiteralPath $previousBrokerCli -Value 'previous-broker' -NoNewline

$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $StartScriptPath,
    [ref]$tokens,
    [ref]$errors
)
if ($errors.Count -gt 0) {
    throw ($errors | Out-String)
}
foreach ($functionName in @(
    'Get-PreviousBrokerAdoptionBinding',
    'Write-BrokerRuntimeReceipt'
)) {
    $definitions = @(
        $ast.FindAll(
            {
                param($node)
                $node -is
                    [System.Management.Automation.Language.FunctionDefinitionAst] -and
                    $node.Name -ceq $functionName
            }.GetNewClosure(),
            $true
        )
    )
    if ($definitions.Count -ne 1) {
        throw "Expected exactly one $functionName function."
    }
    . ([scriptblock]::Create($definitions[0].Extent.Text))
}

$resolvedRoot = [System.IO.Path]::GetFullPath($currentRoot)
$brokerCli = [System.IO.Path]::GetFullPath($currentBrokerCli)
$brokerSidecarCompatibilityId = 'codex-local-remote/broker-sidecar/v1'
$script:events = [System.Collections.Generic.List[string]]::new()

function Test-NonNegativeInteger {
    param([AllowNull()][object]$Value)
    return $Value -is [int] -and [int]$Value -ge 0
}

function Test-CodexLocalRemoteBrokerPayloadCompatibility {
    [CmdletBinding()]
    param(
        [string]$CurrentRuntimeRoot,
        [string]$CurrentVersionId,
        [string]$CurrentManifestSha256,
        [string]$ActiveRuntimeRoot,
        [string]$ActiveVersionId,
        [string]$ActiveManifestSha256
    )
    $script:events.Add('payload-checked')
    $null = @(
        $CurrentRuntimeRoot,
        $CurrentVersionId,
        $CurrentManifestSha256,
        $ActiveRuntimeRoot,
        $ActiveVersionId,
        $ActiveManifestSha256
    )
    return [pscustomobject]@{
        IsCompatible = $Mode -cne 'payload-mismatch'
        Reason = if ($Mode -ceq 'payload-mismatch') {
            'fixture-payload-mismatch'
        } else {
            'fixture-payload-match'
        }
        Current = $null
        Active = $null
    }
}

function Get-CimInstance {
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [string]$ClassName,
        [string]$Filter
    )
    $null = @($ClassName, $Filter)
    if ($Mode -ceq 'old-sidecar-live') {
        return [pscustomobject]@{ ProcessId = 412 }
    }
    return $null
}

function Start-Process {
    $script:events.Add('broker-or-desktop-started')
    throw 'The adoption fixture must never start a process.'
}

function Stop-Process {
    $script:events.Add('broker-or-desktop-stopped')
    throw 'The adoption fixture must never stop a process.'
}

function Stop-ExactManagedBrokerAndOrphan {
    $script:events.Add('broker-stopped')
    throw 'The adoption fixture must never stop Broker.'
}

function Invoke-ManagedDesktopLaunch {
    $script:events.Add('desktop-started')
    throw 'The adoption fixture must never launch Desktop.'
}

function Write-AtomicJsonFile {
    param([string]$Path, [object]$Value)
    $null = $Path
    $script:writtenReceipt = $Value
}

$currentRuntime = [pscustomobject]@{
    CurrentVersionId = $currentVersionId
    CurrentRoot = $currentRoot
    CurrentManifestSha256 = $currentManifestSha256
    PreviousVersionId = $previousVersionId
    PreviousRoot = $previousRoot
    PreviousManifestSha256 = $previousManifestSha256
}
$receiptRuntimeInvocationId = if ($Mode -ceq 'invocation-identity-drift') {
    'fedcba9876543210fedcba9876543210'
} else {
    $runtimeInvocationId
}
$receiptBrokerProcessId = if ($Mode -ceq 'broker-identity-drift') {
    499
} else {
    410
}
$receiptUpstreamProcessId = if ($Mode -ceq 'upstream-identity-drift') {
    498
} else {
    411
}
$activeReceipt = [pscustomobject]@{
    Signature = 'codex-local-remote/app-server-broker/v3'
    Version = 3
    Status = 'ready'
    RuntimeInvocationId = $receiptRuntimeInvocationId
    ProcessId = $receiptBrokerProcessId
    BrokerCliPath = $previousBrokerCli
    BrokerSidecarCompatibilityId = $brokerSidecarCompatibilityId
    Broker = [pscustomobject]@{
        RuntimeInvocationId = $receiptRuntimeInvocationId
        ProcessId = $receiptBrokerProcessId
    }
    Upstream = [pscustomobject]@{
        RuntimeInvocationId = $receiptRuntimeInvocationId
        ProcessId = $receiptUpstreamProcessId
    }
    Sidecar = [pscustomobject]@{
        RuntimeInvocationId = $receiptRuntimeInvocationId
        ProcessId = 412
    }
}
$readiness = [pscustomobject]@{
    status = 'ready'
    appServerReady = $true
    brokerProcessId = 410
    upstreamProcessId = 411
    runtimeInvocationId = $runtimeInvocationId
    desktopConnected = $true
    sidecarConnected = $false
    degraded = $false
    unknownCount = 0
    unsafeThreadCount = 1
}
$sidecarListeners = if ($Mode -ceq 'sidecar-port-occupied') {
    @([pscustomobject]@{
        LocalAddress = '127.0.0.1'
        LocalPort = 18790
        OwningProcess = 412
    })
} else {
    @()
}

$result = Get-PreviousBrokerAdoptionBinding `
    -CurrentRuntime $currentRuntime `
    -ActiveBrokerReceipt $activeReceipt `
    -Readiness $readiness `
    -BrokerListenerProcessId 410 `
    -SidecarListeners $sidecarListeners

$script:writtenReceipt = $null
if ([bool]$result.AdoptedFromPrevious) {
    $brokerCli = [string]$result.BrokerCliPath
    $supervisorRuntimeIdentity = [pscustomobject]@{
        VersionId = $currentVersionId
        RuntimeRoot = $currentRoot
        ManifestSha256 = $currentManifestSha256
    }
    $activeBrokerRuntimeIdentity = $result.ActiveBrokerRuntime
    $brokerRuntimeAdoptedFromPrevious = $true
    $brokerStatePath = Join-Path $SandboxRoot 'app-server-broker.json'
    $brokerSidecarCompatibilityId =
        'codex-local-remote/broker-sidecar/v1'
    $resolvedNode = 'C:\fixture\node.exe'
    $resolvedCodex = 'C:\fixture\codex.exe'
    $runtimeDiscovery = [pscustomobject]@{ Signature = 'fixture' }
    $bootstrapReceipt = [pscustomobject]@{ ProcessId = 409 }
    $runtimeInvocationId = $runtimeInvocationId
    $startedBroker = $false
    $currentSidecarBinding = [pscustomobject]@{
        VersionId = $currentVersionId
        RuntimeRoot = $currentRoot
        ManifestSha256 = $currentManifestSha256
        SidecarCli = Join-Path $currentRoot 'apps\sidecar\dist\cli.js'
    }
    Write-BrokerRuntimeReceipt `
        -Status ready `
        -BrokerReceipt ([pscustomobject]@{
            ProcessId = 410
            CreationDate = 'fixture'
            CreationDateUtcTicks = 10
            ProcessStartTimeUtcTicks = 10
        }) `
        -SidecarReceipt ([pscustomobject]@{ ProcessId = 413 }) `
        -UpstreamReceipt ([pscustomobject]@{ ProcessId = 411 }) `
        -SidecarRuntimeBinding $currentSidecarBinding
}

[pscustomobject]@{
    AdoptedFromPrevious = [bool]$result.AdoptedFromPrevious
    Reason = [string]$result.Reason
    BrokerCliPath = [string]$result.BrokerCliPath
    BrokerRuntimeVersionId =
        [string]$result.ActiveBrokerRuntime.VersionId
    BrokerRuntimeRoot = [string]$result.ActiveBrokerRuntime.RuntimeRoot
    BrokerRuntimeManifestSha256 =
        [string]$result.ActiveBrokerRuntime.ManifestSha256
    PayloadCompatibilityReason =
        [string]$result.PayloadCompatibilityReason
    BrokerOrDesktopStartStopCount = @(
        $script:events |
            Where-Object { $_ -cne 'payload-checked' }
    ).Count
    Events = [string[]]$script:events.ToArray()
    ReceiptVersion = [int]$script:writtenReceipt.Version
    ReceiptBrokerCliPath = [string]$script:writtenReceipt.BrokerCliPath
    ReceiptSupervisorRuntimeVersionId =
        [string]$script:writtenReceipt.SupervisorRuntimeVersionId
    ReceiptSupervisorRuntimeRoot =
        [string]$script:writtenReceipt.SupervisorRuntimeRoot
    ReceiptSupervisorRuntimeManifestSha256 =
        [string]$script:writtenReceipt.SupervisorRuntimeManifestSha256
    ReceiptSidecarRuntimeVersionId =
        [string]$script:writtenReceipt.SidecarRuntimeVersionId
    ReceiptSidecarRuntimeRoot =
        [string]$script:writtenReceipt.SidecarRuntimeRoot
    ReceiptSidecarRuntimeManifestSha256 =
        [string]$script:writtenReceipt.SidecarRuntimeManifestSha256
    ReceiptBrokerRuntimeVersionId =
        [string]$script:writtenReceipt.BrokerRuntimeVersionId
    ReceiptBrokerRuntimeRoot =
        [string]$script:writtenReceipt.BrokerRuntimeRoot
    ReceiptBrokerRuntimeManifestSha256 =
        [string]$script:writtenReceipt.BrokerRuntimeManifestSha256
    ReceiptSupervisorOnlyAdoptedPreviousBroker =
        [bool]$script:writtenReceipt.SupervisorOnlyAdoptedPreviousBroker
} | ConvertTo-Json -Depth 6 -Compress
