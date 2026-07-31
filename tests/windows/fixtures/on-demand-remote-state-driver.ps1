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
$functionAst = @(
    $ast.FindAll(
        {
            param($node)
            $node -is
                [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -ceq 'Get-OnDemandRemoteState'
        },
        $true
    )
)
if ($functionAst.Count -ne 1) {
    throw 'The on-demand remote-state helper was not found exactly once.'
}
Invoke-Expression ([string]$functionAst[0].Extent.Text)

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
        BrokerSidecarCompatibilityId = 'fixture-compatibility'
        ManifestSha256 = $manifestSha256
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

        [switch]$AllowActiveTurns
    )

    $global:OnDemandRemoteStateScenario = $Scenario
    $activeRoot = switch ($Scenario) {
        { $_ -clike 'Current*' } { $currentRoot; break }
        { $_ -clike 'Previous*' } { $previousRoot; break }
        default { $unrelatedRoot }
    }
    $sidecarConnected = $Scenario -cin @(
        'CurrentActive',
        'CurrentDetached',
        'CurrentHandshakeUnpublished',
        'CurrentUnsafeDetached',
        'PreviousWithSidecar',
        'PreviousActive',
        'PreviousIdleActive'
    )
    $global:OnDemandRemoteStateReadiness = [pscustomobject]@{
        status = if ($Scenario -ceq 'CurrentDetached') {
            'degraded'
        } else {
            'ready'
        }
        appServerReady = $true
        desktopConnected = $Scenario -cin @(
            'CurrentActive',
            'PreviousDesktopConnected',
            'PreviousActive',
            'PreviousIdleActive'
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
            'PreviousUnsafe',
            'PreviousActive'
        )) {
            4
        } else {
            0
        }
        runtimeInvocationId = $runtimeInvocationId
        brokerProcessId = 4101
        upstreamProcessId = 4102
    }
    [ordered]@{
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
        Broker = [ordered]@{ ProcessId = 4101 }
        Upstream = [ordered]@{ ProcessId = 4102 }
        Sidecar = if (
            $sidecarConnected -and
            $Scenario -cne 'CurrentHandshakeUnpublished'
        ) {
            [ordered]@{
                RuntimeInvocationId = $runtimeInvocationId
                ProcessId = 4103
                ProcessStartTimeUtcTicks = 638000000000000000
            }
        } else {
            $null
        }
        BrokerCliPath = Join-Path $activeRoot 'apps\broker\dist\cli.js'
        BrokerSidecarCompatibilityId = 'fixture-compatibility'
    } |
        ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath $receiptPath -Encoding utf8NoBOM

    return Get-OnDemandRemoteState `
        -Runtime $runtime `
        -BrokerPort 18791 `
        -AllowActiveTurns:$AllowActiveTurns
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
    PreviousUnknown =
        Invoke-RemoteStateCase -Scenario 'PreviousUnknown'
    PreviousUnsafe =
        Invoke-RemoteStateCase -Scenario 'PreviousUnsafe'
    PreviousManifestMismatch =
        Invoke-RemoteStateCase -Scenario 'PreviousManifestMismatch'
    Unrelated = Invoke-RemoteStateCase -Scenario 'Unrelated'
} | ConvertTo-Json -Compress
