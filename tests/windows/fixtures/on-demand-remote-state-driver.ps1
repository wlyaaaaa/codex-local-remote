[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptPath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot
)

$ErrorActionPreference = 'Stop'
$resolvedDataDir = [System.IO.Path]::GetFullPath($SandboxRoot)
$versionsRoot = Join-Path $resolvedDataDir 'RuntimeVersions'
$currentVersionId = 'c' * 64
$previousVersionId = 'b' * 64
$unrelatedVersionId = 'd' * 64
$currentRoot = Join-Path $versionsRoot $currentVersionId
$previousRoot = Join-Path $versionsRoot $previousVersionId
$unrelatedRoot = Join-Path $versionsRoot $unrelatedVersionId
$tamperedRoot = Join-Path $versionsRoot ('e' * 64)
$receiptPath = Join-Path $resolvedDataDir 'app-server-broker.json'
$runtimeInvocationId = '1' * 32

$null = New-Item -ItemType Directory -Path $resolvedDataDir -Force

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $ScriptPath),
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    throw 'The on-demand handoff script did not parse.'
}
$functionAsts = @(
    $ast.FindAll(
        {
            param($node)
            $node -is
                [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -cin @(
                'Get-OnDemandRemoteState',
                'Test-OnDemandReceiptProcessIdentity'
            )
        },
        $true
    )
)
if ($functionAsts.Count -ne 2) {
    throw 'The on-demand remote-state helpers were not found exactly once.'
}
foreach ($functionName in @(
    'Test-OnDemandReceiptProcessIdentity',
    'Get-OnDemandRemoteState'
)) {
    $functionAst = @(
        $functionAsts | Where-Object Name -CEQ $functionName
    )
    if ($functionAst.Count -ne 1) {
        throw "The '$functionName' helper was not found exactly once."
    }
    Invoke-Expression ([string]$functionAst[0].Extent.Text)
}

function Test-NonNegativeInteger {
    param([Parameter(Mandatory)][object]$Value)

    return (
        $Value -is [byte] -or
        $Value -is [uint16] -or
        $Value -is [uint32] -or
        $Value -is [uint64] -or
        $Value -is [sbyte] -or
        $Value -is [int16] -or
        $Value -is [int32] -or
        $Value -is [int64]
    ) -and [decimal]$Value -ge 0
}

function Test-CodexLocalRemoteRuntimeVersion {
    param(
        [Parameter(Mandatory)]
        [string]$RuntimeRoot,

        [Parameter(Mandatory)]
        [string]$ExpectedVersionId
    )

    $null = $RuntimeRoot
    $manifestSha256 = if (
        $global:OnDemandRemoteStateScenario -ceq
        'PreviousManifestMismatch' -and
        $ExpectedVersionId -ceq $previousVersionId
    ) {
        'e' * 64
    } else {
        $ExpectedVersionId
    }
    return [pscustomobject]@{
        IsValid = $true
        BrokerSidecarCompatibilityId = if (
            $global:OnDemandRemoteStateScenario -ceq
                'PreviousSupersededCompatibilityIdMismatch' -and
            $ExpectedVersionId -ceq $unrelatedVersionId
        ) {
            'fixture-incompatible'
        } else {
            'fixture-compatibility'
        }
        ManifestSha256 = $manifestSha256
    }
}

function Test-CodexLocalRemoteBrokerPayloadCompatibility {
    param(
        [string]$CurrentRuntimeRoot,
        [string]$CurrentVersionId,
        [string]$CurrentManifestSha256,
        [string]$ActiveRuntimeRoot,
        [string]$ActiveVersionId,
        [string]$ActiveManifestSha256
    )

    $null = @(
        $CurrentRuntimeRoot,
        $CurrentVersionId,
        $CurrentManifestSha256,
        $ActiveRuntimeRoot,
        $ActiveVersionId,
        $ActiveManifestSha256
    )
    $isSupersededPayloadMismatch = (
        $global:OnDemandRemoteStateScenario -ceq
            'PreviousSupersededSupervisorPayloadMismatch' -and
        $CurrentVersionId -ceq $unrelatedVersionId
    )
    $isSelectedPayloadMismatch = (
        $global:OnDemandRemoteStateScenario -ceq
            'PreviousSupersededSelectedPayloadMismatch' -and
        $CurrentVersionId -ceq $currentVersionId
    )
    $compatibilityValue = if (
        $global:OnDemandRemoteStateScenario -ceq
            'PreviousSupersededCompatibilityString'
    ) {
        'false'
    } else {
        -not (
            $global:OnDemandRemoteStateScenario -ceq
                'PreviousSupervisorPayloadMismatch' -or
            $isSupersededPayloadMismatch -or
            $isSelectedPayloadMismatch
        )
    }
    return [pscustomobject]@{
        IsCompatible = $compatibilityValue
        Reason = 'fixture'
    }
}

function Get-CimInstance {
    param(
        [string]$ClassName,
        [string]$Filter,
        [string]$ErrorAction
    )

    $null = $ClassName
    $null = $ErrorAction
    $processId = if ($Filter -match '(\d+)') { [int]$Matches[1] } else { 0 }
    if ($global:OnDemandRemoteStateScenario -ceq
            'PreviousSupersededBootstrapPidMismatch' -and
        $processId -eq 4100) {
        return $null
    }
    if ($global:OnDemandRemoteStateScenario -ceq
            'PreviousSupersededSidecarPidMismatch' -and
        $processId -eq 4103) {
        return $null
    }
    $isSidecar = $processId -eq 4103
    return [pscustomobject]@{
        ProcessId = $processId
        ParentProcessId = if ($isSidecar) { 4100 } else { 1 }
        CreationDate = if ($isSidecar) {
            638000000000000003
        } else {
            638000000000000000
        }
        CommandLine = if ($isSidecar) { 'sidecar-command' } else { 'bootstrap-command' }
        ExecutablePath = if ($isSidecar) {
            'C:\Program Files\nodejs\node.exe'
        } else {
            'C:\Program Files\PowerShell\7\pwsh.exe'
        }
    }
}

function Get-ProcessCreationIdentity {
    param([object]$CreationDate)

    return [pscustomobject]@{
        CreationDate = [string]$CreationDate
        CreationDateUtcTicks = [long]$CreationDate
    }
}

function Open-ProcessIdentityHandle {
    param(
        [int]$ProcessId,
        [long]$ExpectedCreationDateUtcTicks,
        [long]$ExpectedStartTimeUtcTicks
    )

    $null = $ExpectedCreationDateUtcTicks
    $startMismatch = (
        ($global:OnDemandRemoteStateScenario -ceq
            'PreviousSupersededBootstrapStartMismatch' -and
            $ProcessId -eq 4100) -or
        ($global:OnDemandRemoteStateScenario -ceq
            'PreviousSupersededSidecarStartMismatch' -and
            $ProcessId -eq 4103)
    )
    if ($startMismatch) {
        throw 'fixture process start mismatch'
    }
    $process = [pscustomobject]@{ ProcessId = $ProcessId }
    $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value { }
    return [pscustomobject]@{
        Process = $process
        ProcessId = $ProcessId
        StartTimeUtcTicks = $ExpectedStartTimeUtcTicks
    }
}

function Test-ManagedBootstrapProcess {
    param(
        [string]$CommandLine,
        [string]$ExecutablePath,
        [string]$TaskName,
        [string]$NodePath,
        [string]$PwshPath,
        [string]$InstallRoot,
        [string]$DataDir,
        [int]$Port,
        [int]$BrokerPort,
        [int]$BrokerUpstreamPort,
        [string]$BasePath
    )

    $null = @(
        $CommandLine,
        $ExecutablePath,
        $TaskName,
        $NodePath,
        $PwshPath,
        $InstallRoot,
        $DataDir,
        $Port,
        $BrokerPort,
        $BrokerUpstreamPort,
        $BasePath
    )
    return [pscustomobject]@{
        IsManaged = $global:OnDemandRemoteStateScenario -cne
            'PreviousSupersededBootstrapCommandMismatch'
    }
}

function Test-ManagedSidecarProcess {
    param(
        [string]$CommandLine,
        [string]$ExecutablePath,
        [string]$ExpectedNodePath,
        [string]$ExpectedSidecarCliPath,
        [int]$Port,
        [string]$BasePath,
        [string]$DataDir
    )

    $null = @(
        $CommandLine,
        $ExecutablePath,
        $ExpectedNodePath,
        $ExpectedSidecarCliPath,
        $Port,
        $BasePath,
        $DataDir
    )
    if ($global:OnDemandRemoteStateScenario -ceq
        'PreviousSupersededFinalReceiptDrift') {
        Add-Content -LiteralPath $receiptPath -Value ' ' -NoNewline
    }
    return [pscustomobject]@{
        IsManaged = $global:OnDemandRemoteStateScenario -cne
            'PreviousSupersededSidecarCommandMismatch'
    }
}

function Invoke-RestMethod {
    param(
        [string]$Method,
        [string]$Uri,
        [int]$TimeoutSec
    )

    $null = $Method
    $null = $Uri
    $null = $TimeoutSec
    return $global:OnDemandRemoteStateReadiness
}

$runtime = [pscustomobject]@{
    CurrentVersionId = $currentVersionId
    CurrentRoot = $currentRoot
    CurrentManifestSha256 = $currentVersionId
    PreviousVersionId = $previousVersionId
    PreviousRoot = $previousRoot
    PreviousManifestSha256 = $previousVersionId
}

function Invoke-RemoteStateCase {
    param(
        [Parameter(Mandatory)]
        [string]$Scenario,

        [switch]$AllowActiveTurns,

        [switch]$AllowNativePreviousDesktop
    )

    $global:OnDemandRemoteStateScenario = $Scenario
    $isSupersededScenario = $Scenario -clike 'PreviousSuperseded*'
    $activeRoot = switch ($Scenario) {
        { $_ -clike 'Current*' } { $currentRoot; break }
        { $_ -clike 'Previous*' } { $previousRoot; break }
        default { $unrelatedRoot }
    }
    $sidecarConnected = (
        $Scenario -cin @(
        'CurrentActive',
        'CurrentDetached',
        'CurrentHandshakeUnpublished',
        'CurrentUnsafeDetached',
        'PreviousWithSidecar',
        'PreviousActive',
        'PreviousIdleActive',
        'PreviousAdoptedCompatible'
        ) -or
        ($isSupersededScenario -and
            $Scenario -cne 'PreviousSupersededSidecarDisconnected')
    )
    $global:OnDemandRemoteStateReadiness = [pscustomobject]@{
        status = if ($Scenario -ceq 'CurrentDetached') {
            'degraded'
        } else {
            'ready'
        }
        appServerReady = $true
        desktopConnected = (
            $Scenario -cin @(
            'CurrentActive',
            'PreviousDesktopConnected',
            'PreviousUnsafeDesktopConnected',
            'PreviousActive',
            'PreviousIdleActive',
            'PreviousSupervisorRepairable',
            'PreviousSupervisorRepairableUnsafe',
            'PreviousSupervisorPayloadMismatch',
            'PreviousAdoptedCompatible'
            ) -or $isSupersededScenario
        )
        sidecarConnected = $sidecarConnected
        degraded = $Scenario -cin @(
            'CurrentDetached',
            'PreviousDegraded'
        )
        unknownCount = if ($Scenario -ceq 'PreviousUnknown') { 1 } else { 0 }
        unsafeThreadCount = if ($Scenario -cin @(
            'CurrentActive',
            'CurrentUnsafeDetached',
            'CurrentUnsafeBackground',
            'PreviousUnsafe',
            'PreviousUnsafeDesktopConnected',
            'PreviousActive',
            'PreviousSupervisorRepairableUnsafe',
            'PreviousAdoptedCompatible',
            'PreviousSupersededAdoptedCompatibleBusy'
        )) {
            4
        } else {
            0
        }
        runtimeInvocationId = $runtimeInvocationId
        brokerProcessId = 4101
        upstreamProcessId = 4102
    }
    $publishesSidecar = (
        $sidecarConnected -and
        $Scenario -cne 'CurrentHandshakeUnpublished'
    )
    $activeVersionId = Split-Path -Leaf $activeRoot
    $supervisorVersionId = if (
        $Scenario -ceq 'PreviousAdoptedCompatible'
    ) {
        $currentVersionId
    } elseif ($isSupersededScenario) {
        $unrelatedVersionId
    } else {
        $activeVersionId
    }
    $supervisorRoot = if (
        $Scenario -ceq 'PreviousAdoptedCompatible'
    ) {
        $currentRoot
    } elseif ($Scenario -ceq 'PreviousSupersededSupervisorRootMismatch') {
        $tamperedRoot
    } elseif ($isSupersededScenario) {
        $unrelatedRoot
    } else {
        $activeRoot
    }
    $supervisorManifestSha256 = if (
        $Scenario -ceq 'PreviousAdoptedCompatible'
    ) {
        $currentVersionId
    } elseif (
        $Scenario -ceq 'PreviousSupersededSupervisorManifestMismatch'
    ) {
        'e' * 64
    } else {
        $supervisorVersionId
    }
    $sidecarVersionId = if ($publishesSidecar) {
        $supervisorVersionId
    } else {
        $null
    }
    $sidecarRoot = if ($publishesSidecar) {
        if ($Scenario -ceq 'PreviousAdoptedCompatible') {
            $currentRoot
        } elseif ($isSupersededScenario) {
            $unrelatedRoot
        } else {
            $activeRoot
        }
    } else {
        $null
    }
    $sidecarManifestSha256 = if ($publishesSidecar) {
        $sidecarVersionId
    } else {
        $null
    }
    $adoptionFlag = if (
        $Scenario -ceq 'PreviousSupersededFlagString'
    ) {
        'true'
    } elseif ($Scenario -ceq 'PreviousSupersededFlagFalse') {
        $false
    } else {
        [bool](
            $Scenario -ceq 'PreviousAdoptedCompatible' -or
            $isSupersededScenario
        )
    }
    $receipt = [ordered]@{
        Signature = 'codex-local-remote/app-server-broker/v3'
        Version = 3
        Status = if (
            $sidecarConnected -and
            $Scenario -cne 'CurrentHandshakeUnpublished'
        ) {
            'ready'
        } else {
            'broker-ready'
        }
        RuntimeInvocationId = $runtimeInvocationId
        Bootstrap = [ordered]@{
            RuntimeInvocationId = $runtimeInvocationId
            ProcessId = 4100
            CreationDate = 'fixture-bootstrap'
            CreationDateUtcTicks = 638000000000000000
            ProcessStartTimeUtcTicks = 638000000000000000
        }
        Broker = [ordered]@{ ProcessId = 4101 }
        Upstream = [ordered]@{ ProcessId = 4102 }
        Sidecar = if ($publishesSidecar) {
            [ordered]@{
                RuntimeInvocationId = $runtimeInvocationId
                ProcessId = 4103
                CreationDate = 'fixture-sidecar'
                CreationDateUtcTicks = 638000000000000003
                ProcessStartTimeUtcTicks = 638000000000000003
            }
        } elseif ($Scenario -cin @(
            'PreviousSupervisorRepairable',
            'PreviousSupervisorRepairableUnsafe',
            'PreviousSupervisorPayloadMismatch'
        )) {
            [ordered]@{
                RuntimeInvocationId = $runtimeInvocationId
                ProcessId = 4999
                ProcessStartTimeUtcTicks = 638000000000000000
            }
        } else {
            $null
        }
        NodePath = 'C:\Program Files\nodejs\node.exe'
        BrokerCliPath = Join-Path $activeRoot 'apps\broker\dist\cli.js'
        BrokerSidecarCompatibilityId = 'fixture-compatibility'
        SupervisorRuntimeVersionId = $supervisorVersionId
        SupervisorRuntimeRoot = $supervisorRoot
        SupervisorRuntimeManifestSha256 = $supervisorManifestSha256
        SidecarRuntimeVersionId = $sidecarVersionId
        SidecarRuntimeRoot = $sidecarRoot
        SidecarRuntimeManifestSha256 = $sidecarManifestSha256
        BrokerRuntimeVersionId = $activeVersionId
        BrokerRuntimeRoot = $activeRoot
        BrokerRuntimeManifestSha256 = if (
            $Scenario -ceq 'PreviousSupersededBrokerBindingMismatch'
        ) { 'e' * 64 } else { $activeVersionId }
        SupervisorOnlyAdoptedPreviousBroker = $adoptionFlag
    }
    if ($Scenario -ceq 'PreviousSupersededFlagMissing') {
        $receipt.Remove('SupervisorOnlyAdoptedPreviousBroker')
    }
    $receipt |
        ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath $receiptPath -Encoding utf8NoBOM

    $processContext = [pscustomobject]@{
        RuntimeVersionId = $currentVersionId
        RuntimeRoot = $currentRoot
        TaskName = 'Codex Local Remote'
        NodePath = 'C:\Program Files\nodejs\node.exe'
        PwshPath = 'C:\Program Files\PowerShell\7\pwsh.exe'
        SidecarPort = 18790
        BrokerPort = 18791
        BrokerUpstreamPort = 18792
        BasePath = '/codex-remote'
        DataDir = $resolvedDataDir
    }
    return Get-OnDemandRemoteState `
        -Runtime $runtime `
        -BrokerPort 18791 `
        -ProcessContext $processContext `
        -AllowActiveTurns:$AllowActiveTurns `
        -AllowNativePreviousDesktop:$AllowNativePreviousDesktop `
        -AllowCompatibleSupervisorResume:($Scenario -cin @(
            'PreviousSupervisorRepairable',
            'PreviousSupervisorRepairableUnsafe',
            'PreviousSupervisorPayloadMismatch',
            'PreviousAdoptedCompatible',
            'PreviousAdoptedCompatible'
        ) -or $isSupersededScenario)
}

[pscustomobject][ordered]@{
    CurrentActive = Invoke-RemoteStateCase -Scenario 'CurrentActive'
    CurrentDetached = Invoke-RemoteStateCase -Scenario 'CurrentDetached'
    CurrentHandshakeUnpublished =
        Invoke-RemoteStateCase -Scenario 'CurrentHandshakeUnpublished'
    CurrentUnsafeDetached =
        Invoke-RemoteStateCase -Scenario 'CurrentUnsafeDetached'
    CurrentUnsafeDetachedAuthorized =
        Invoke-RemoteStateCase `
            -Scenario 'CurrentUnsafeDetached' `
            -AllowActiveTurns
    CurrentBackground = Invoke-RemoteStateCase -Scenario 'CurrentBackground'
    CurrentUnsafeBackground =
        Invoke-RemoteStateCase -Scenario 'CurrentUnsafeBackground'
    CurrentUnsafeBackgroundAuthorized =
        Invoke-RemoteStateCase `
            -Scenario 'CurrentUnsafeBackground' `
            -AllowActiveTurns
    PreviousSilent = Invoke-RemoteStateCase -Scenario 'PreviousSilent'
    PreviousWithSidecar =
        Invoke-RemoteStateCase -Scenario 'PreviousWithSidecar'
    PreviousActive = Invoke-RemoteStateCase -Scenario 'PreviousActive'
    PreviousIdleActive =
        Invoke-RemoteStateCase -Scenario 'PreviousIdleActive'
    PreviousDegraded =
        Invoke-RemoteStateCase -Scenario 'PreviousDegraded'
    PreviousDesktopConnected =
        Invoke-RemoteStateCase -Scenario 'PreviousDesktopConnected'
    PreviousDesktopConnectedAuthorized =
        Invoke-RemoteStateCase `
            -Scenario 'PreviousDesktopConnected' `
            -AllowActiveTurns `
            -AllowNativePreviousDesktop
    PreviousUnsafeDesktopConnected =
        Invoke-RemoteStateCase -Scenario 'PreviousUnsafeDesktopConnected'
    PreviousUnsafeDesktopConnectedAuthorized =
        Invoke-RemoteStateCase `
            -Scenario 'PreviousUnsafeDesktopConnected' `
            -AllowActiveTurns `
            -AllowNativePreviousDesktop
    PreviousUnknown =
        Invoke-RemoteStateCase -Scenario 'PreviousUnknown'
    PreviousUnsafe =
        Invoke-RemoteStateCase -Scenario 'PreviousUnsafe'
    PreviousSupervisorRepairable =
        Invoke-RemoteStateCase -Scenario 'PreviousSupervisorRepairable'
    PreviousSupervisorRepairableUnsafe =
        Invoke-RemoteStateCase -Scenario 'PreviousSupervisorRepairableUnsafe'
    PreviousSupervisorPayloadMismatch =
        Invoke-RemoteStateCase -Scenario 'PreviousSupervisorPayloadMismatch'
    PreviousAdoptedCompatible =
        Invoke-RemoteStateCase -Scenario 'PreviousAdoptedCompatible'
    PreviousSupersededAdoptedCompatible =
        Invoke-RemoteStateCase `
            -Scenario 'PreviousSupersededAdoptedCompatible'
    PreviousSupersededAdoptedCompatibleBusy =
        Invoke-RemoteStateCase `
            -Scenario 'PreviousSupersededAdoptedCompatibleBusy'
    PreviousSupersededSupervisorManifestMismatch =
        Invoke-RemoteStateCase `
            -Scenario 'PreviousSupersededSupervisorManifestMismatch'
    PreviousSupersededSupervisorPayloadMismatch =
        Invoke-RemoteStateCase `
            -Scenario 'PreviousSupersededSupervisorPayloadMismatch'
    PreviousSupersededSupervisorRootMismatch =
        Invoke-RemoteStateCase `
            -Scenario 'PreviousSupersededSupervisorRootMismatch'
    PreviousSupersededSelectedPayloadMismatch =
        Invoke-RemoteStateCase `
            -Scenario 'PreviousSupersededSelectedPayloadMismatch'
    PreviousSupersededCompatibilityIdMismatch =
        Invoke-RemoteStateCase `
            -Scenario 'PreviousSupersededCompatibilityIdMismatch'
    PreviousSupersededCompatibilityString =
        Invoke-RemoteStateCase `
            -Scenario 'PreviousSupersededCompatibilityString'
    PreviousSupersededFlagFalse =
        Invoke-RemoteStateCase -Scenario 'PreviousSupersededFlagFalse'
    PreviousSupersededFlagMissing =
        Invoke-RemoteStateCase -Scenario 'PreviousSupersededFlagMissing'
    PreviousSupersededFlagString =
        Invoke-RemoteStateCase -Scenario 'PreviousSupersededFlagString'
    PreviousSupersededSidecarDisconnected =
        Invoke-RemoteStateCase `
            -Scenario 'PreviousSupersededSidecarDisconnected'
    PreviousSupersededBootstrapPidMismatch =
        Invoke-RemoteStateCase `
            -Scenario 'PreviousSupersededBootstrapPidMismatch'
    PreviousSupersededBootstrapStartMismatch =
        Invoke-RemoteStateCase `
            -Scenario 'PreviousSupersededBootstrapStartMismatch'
    PreviousSupersededBootstrapCommandMismatch =
        Invoke-RemoteStateCase `
            -Scenario 'PreviousSupersededBootstrapCommandMismatch'
    PreviousSupersededSidecarPidMismatch =
        Invoke-RemoteStateCase `
            -Scenario 'PreviousSupersededSidecarPidMismatch'
    PreviousSupersededSidecarStartMismatch =
        Invoke-RemoteStateCase `
            -Scenario 'PreviousSupersededSidecarStartMismatch'
    PreviousSupersededSidecarCommandMismatch =
        Invoke-RemoteStateCase `
            -Scenario 'PreviousSupersededSidecarCommandMismatch'
    PreviousSupersededBrokerBindingMismatch =
        Invoke-RemoteStateCase `
            -Scenario 'PreviousSupersededBrokerBindingMismatch'
    PreviousSupersededFinalReceiptDrift =
        Invoke-RemoteStateCase `
            -Scenario 'PreviousSupersededFinalReceiptDrift'
    PreviousManifestMismatch =
        Invoke-RemoteStateCase -Scenario 'PreviousManifestMismatch'
    Unrelated = Invoke-RemoteStateCase -Scenario 'Unrelated'
} | ConvertTo-Json -Compress
