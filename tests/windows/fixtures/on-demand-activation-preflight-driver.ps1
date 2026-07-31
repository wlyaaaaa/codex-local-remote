[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptPath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot
)

$ErrorActionPreference = 'Stop'
$resolvedScriptPath = (Resolve-Path -LiteralPath $ScriptPath).Path
$resolvedSandboxRoot = [System.IO.Path]::GetFullPath($SandboxRoot)
$runtimeRoot = Join-Path $resolvedSandboxRoot 'runtime'
$launcherDirectory = Join-Path $runtimeRoot 'scripts\windows'
$launcherPath = Join-Path $launcherDirectory 'Launch-CodexWithRemote.ps1'
$resolvedDataDir = Join-Path $resolvedSandboxRoot 'data'

$null = New-Item `
    -ItemType Directory `
    -Path $launcherDirectory `
    -Force

$mockLauncher = @'
[CmdletBinding()]
param(
    [string]$DataDir,
    [int]$SidecarPort,
    [int]$BrokerPort,
    [int]$BrokerUpstreamPort,
    [string]$BasePath,
    [string]$TaskName,
    [switch]$DefinitionOnly
)

function Get-CodexLocalRemoteRuntimeGenerationStatus {
    param(
        [Parameter(Mandatory)]
        [string]$ManagedDataDir
    )

    if ($global:CodexLocalRemotePreflightFixtureScenario -cin @(
        'ForeignListenerStart',
        'MissingSelectedStart'
    )) {
        return [pscustomobject]@{
            Status = if (
                $global:CodexLocalRemotePreflightFixtureScenario -ceq
                'MissingSelectedStart'
            ) {
                'missing-selected-runtime'
            } else {
                'active-receipt-missing'
            }
            Receipt = $null
        }
    }
    return [pscustomobject]@{
        Status = 'transition-required'
        Receipt = [pscustomobject]@{
            RuntimeInvocationId = 'expected-invocation'
            ProcessId = 4101
            Upstream = [pscustomobject]@{
                ProcessId = 4102
            }
        }
    }
}

function Get-CodexLocalRemoteRuntimeHandoffDecision {
    param(
        [Parameter(Mandatory)]
        [string]$TaskState,

        [Parameter(Mandatory)]
        [string]$GenerationStatus,

        [Parameter(Mandatory)]
        [int]$DesktopProcessCount
    )

    if ($GenerationStatus -cin @(
        'active-receipt-missing',
        'missing-selected-runtime'
    )) {
        return 'start'
    }
    return 'switch'
}

function Get-CodexLocalRemoteReadinessSnapshot {
    param(
        [Parameter(Mandatory)]
        [int]$Port
    )

    $readiness = [pscustomobject]@{
        status = 'ready'
        appServerReady = $true
        desktopConnected = $false
        sidecarConnected = $true
        degraded = $false
        unknownCount = 0
        unsafeThreadCount = 0
        runtimeInvocationId = 'expected-invocation'
        brokerProcessId = 4101
        upstreamProcessId = 4102
    }
    switch ($global:CodexLocalRemotePreflightFixtureScenario) {
        'IdentityDrift' {
            $readiness.runtimeInvocationId = 'drifted-invocation'
        }
        'UnknownClient' {
            $readiness.unknownCount = 1
        }
        'UnsafeThread' {
            $readiness.unsafeThreadCount = 1
        }
    }
    $global:CodexLocalRemotePreflightFixtureReadiness = $readiness
    return $readiness
}
'@
Set-Content `
    -LiteralPath $launcherPath `
    -Value $mockLauncher `
    -Encoding utf8 `
    -NoNewline

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $resolvedScriptPath,
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
            $node.Name -ceq
                'Assert-OnDemandSelectedRemoteRuntimeActivationPreflight'
        },
        $true
    )
)
if ($functionAst.Count -ne 1) {
    throw 'The activation preflight helper was not found exactly once.'
}
Invoke-Expression ([string]$functionAst[0].Extent.Text)

function Test-NonNegativeInteger {
    param(
        [Parameter(Mandatory)]
        [object]$Value
    )

    if ($Value -isnot [byte] -and
        $Value -isnot [uint16] -and
        $Value -isnot [uint32] -and
        $Value -isnot [uint64] -and
        $Value -isnot [sbyte] -and
        $Value -isnot [int16] -and
        $Value -isnot [int32] -and
        $Value -isnot [int64]) {
        return $false
    }
    return [decimal]$Value -ge 0
}

$global:CodexLocalRemotePreflightFixtureMutationCalls = 0
function Start-ScheduledTask {
    $global:CodexLocalRemotePreflightFixtureMutationCalls += 1
    throw 'The activation preflight attempted to start a real task.'
}
function Stop-ScheduledTask {
    $global:CodexLocalRemotePreflightFixtureMutationCalls += 1
    throw 'The activation preflight attempted to stop a real task.'
}
function Start-Process {
    $global:CodexLocalRemotePreflightFixtureMutationCalls += 1
    throw 'The activation preflight attempted to start a real process.'
}
function Stop-Process {
    $global:CodexLocalRemotePreflightFixtureMutationCalls += 1
    throw 'The activation preflight attempted to stop a real process.'
}
function Get-NetTCPConnection {
    [CmdletBinding()]
    param(
        [string]$State,
        [int]$LocalPort
    )

    if ($global:CodexLocalRemotePreflightFixtureScenario -ceq
        'ForeignListenerStart' -and
        $LocalPort -eq 18790) {
        return [pscustomobject]@{
            State = 'Listen'
            LocalPort = $LocalPort
        }
    }
    return @()
}

$runtime = [pscustomobject]@{
    CurrentRoot = $runtimeRoot
}
$configuration = [pscustomobject]@{
    SidecarPort = 18790
    BrokerPort = 18791
    BrokerUpstreamPort = 18795
    BasePath = '/remote'
}
$startupTask = [pscustomobject]@{
    State = 'Ready'
}

function Invoke-ActivationPreflightCase {
    param(
        [Parameter(Mandatory)]
        [string]$Scenario
    )

    $global:CodexLocalRemotePreflightFixtureScenario = $Scenario
    $global:CodexLocalRemotePreflightFixtureReadiness = $null
    try {
        $generation =
            Assert-OnDemandSelectedRemoteRuntimeActivationPreflight `
                -Runtime $runtime `
                -Configuration $configuration `
                -StartupTask $startupTask `
                -Name 'Codex Local Remote Fixture'
        return [pscustomobject]@{
            Passed = $true
            GenerationStatus = [string]$generation.Status
            SidecarConnected =
                [bool]$global:CodexLocalRemotePreflightFixtureReadiness.
                    sidecarConnected
            UnknownCount =
                [int]$global:CodexLocalRemotePreflightFixtureReadiness.
                    unknownCount
            UnsafeThreadCount =
                [int]$global:CodexLocalRemotePreflightFixtureReadiness.
                    unsafeThreadCount
        }
    } catch {
        return [pscustomobject]@{
            Passed = $false
            Failure = [string]$_.Exception.Message
        }
    }
}

[pscustomobject][ordered]@{
    ExactTransition = Invoke-ActivationPreflightCase `
        -Scenario 'ExactTransition'
    IdentityDrift = Invoke-ActivationPreflightCase `
        -Scenario 'IdentityDrift'
    UnknownClient = Invoke-ActivationPreflightCase `
        -Scenario 'UnknownClient'
    UnsafeThread = Invoke-ActivationPreflightCase `
        -Scenario 'UnsafeThread'
    ForeignListenerStart = Invoke-ActivationPreflightCase `
        -Scenario 'ForeignListenerStart'
    MissingSelectedStart = Invoke-ActivationPreflightCase `
        -Scenario 'MissingSelectedStart'
    MutationCalls =
        $global:CodexLocalRemotePreflightFixtureMutationCalls
} | ConvertTo-Json -Depth 5 -Compress
