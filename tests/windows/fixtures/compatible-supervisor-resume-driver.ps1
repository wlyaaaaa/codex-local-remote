[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptPath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot
)

$ErrorActionPreference = 'Stop'
$resolvedDataDir = [System.IO.Path]::GetFullPath($SandboxRoot)
$currentVersionId = 'c' * 64
$previousVersionId = 'b' * 64
$currentRoot = Join-Path $resolvedDataDir "RuntimeVersions\$currentVersionId"
$previousRoot = Join-Path $resolvedDataDir "RuntimeVersions\$previousVersionId"
$runtimeInvocationId = '1' * 32
$null = New-Item -ItemType Directory -Path $currentRoot -Force
$null = New-Item -ItemType Directory -Path $previousRoot -Force

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $ScriptPath),
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    throw 'The launcher did not parse.'
}
foreach ($name in @(
    'Assert-CodexLocalRemoteCompatibleSupervisorResume',
    'Test-CodexLocalRemoteCompatibleSupervisorResumeProof',
    'Start-CodexLocalRemoteRegisteredTask'
)) {
    $matches = @(
        $ast.FindAll(
            {
                param($node)
                $node -is
                    [System.Management.Automation.Language.FunctionDefinitionAst] -and
                $node.Name -ceq $name
            },
            $true
        )
    )
    if ($matches.Count -ne 1) {
        throw "Launcher helper '$name' was not found exactly once."
    }
    Invoke-Expression ([string]$matches[0].Extent.Text)
}

$runtime = [pscustomobject]@{
    CurrentVersionId = $currentVersionId
    CurrentRoot = $currentRoot
    CurrentManifestSha256 = 'd' * 64
    PreviousVersionId = $previousVersionId
    PreviousRoot = $previousRoot
    PreviousManifestSha256 = 'e' * 64
    HasCurrentTaskDefinition = $true
    CurrentTaskDefinitionTaskName = 'Codex Local Remote Fixture'
    CurrentTaskDefinitionRuntimeVersionId = $currentVersionId
    CurrentTaskDefinitionRuntimeRoot = $currentRoot
    CurrentTaskDefinitionSha256 = 'f' * 64
}
$global:CompatibleResumeScenario = 'Exact'
$global:CompatibleResumeStartCalls = 0
$global:CompatibleResumeSwitchCalls = 0
$global:CompatibleResumeDesktopGateCalls = 0

function Test-NonNegativeInteger {
    param([Parameter(Mandatory)][object]$Value)
    return $Value -is [int] -and [int]$Value -ge 0
}

function Test-CodexLocalRemotePathEqual {
    param([string]$Left, [string]$Right)
    return [string]::Equals(
        [System.IO.Path]::GetFullPath($Left),
        [System.IO.Path]::GetFullPath($Right),
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Assert-CodexExpectedSelectedRuntime {
    param(
        [string]$ManagedDataDir,
        [string]$ExpectedVersionId,
        [string]$ExpectedRoot,
        [string]$ExpectedManifestSha256
    )
    $null = @(
        $ManagedDataDir,
        $ExpectedVersionId,
        $ExpectedRoot,
        $ExpectedManifestSha256
    )
    return $runtime
}

function Resolve-CodexDesktopPackageStatusIdentity {
    return [pscustomobject]@{
        DesktopExecutablePath = 'C:\fixture\ChatGPT.exe'
    }
}

function Get-CodexLocalRemoteNativeDesktopRootCandidates {
    param([string]$DesktopExecutablePath)
    $null = $DesktopExecutablePath
    return @([pscustomobject]@{
        ProcessId = 4301
        CreationDate = '20260801153000.000000-000'
    })
}

function Get-CodexDesktopHandoffProcesses {
    return @(
        1..11 | ForEach-Object {
            [pscustomobject]@{ ProcessId = 4300 + $_ }
        }
    )
}

function Get-ProcessCreationIdentity {
    param([string]$CreationDate)
    $null = $CreationDate
    return [pscustomobject]@{
        CreationDateUtcTicks = 638896302000000000
    }
}

function Get-ScheduledTask {
    param([string]$TaskName, [string]$TaskPath)
    return [pscustomobject]@{
        TaskName = $TaskName
        TaskPath = $TaskPath
        State = 'Ready'
        Description =
            'codex-local-remote/startup-task/v5 - Starts the loopback app-server broker and local-only Codex Local Remote sidecar only on an explicit demand start.'
    }
}

function Export-ScheduledTask {
    param([string]$TaskName, [string]$TaskPath)
    $null = @($TaskName, $TaskPath)
    if ($global:CompatibleResumeScenario -ceq 'TaskDefinitionDrift') {
        return '<Task>drifted</Task>'
    }
    return '<Task>exact</Task>'
}

function Get-StringSha256 {
    param([string]$Value)
    if ($Value -ceq '<Task>exact</Task>') {
        return 'f' * 64
    }
    return '0' * 64
}

function Get-CodexLocalRemoteRuntimeGenerationStatus {
    param([string]$ManagedDataDir)
    $null = $ManagedDataDir
    return [pscustomobject]@{
        Status = 'transition-required'
        SelectedRoot = $currentRoot
        ActiveRoot = $previousRoot
        Receipt = [pscustomobject]@{
            RuntimeInvocationId = $runtimeInvocationId
            ProcessId = 4101
            Broker = [pscustomobject]@{ ProcessId = 4101 }
            Upstream = [pscustomobject]@{ ProcessId = 4102 }
            Sidecar = [pscustomobject]@{
                ProcessId = 4999
                ProcessStartTimeUtcTicks = 638000000000000000
            }
            BrokerCliPath = Join-Path $previousRoot 'apps\broker\dist\cli.js'
            BrokerSidecarCompatibilityId =
                'codex-local-remote/broker-sidecar/v1'
        }
    }
}

function Get-CodexLocalRemoteReadinessSnapshot {
    param([int]$Port)
    $null = $Port
    return [pscustomobject]@{
        status = 'ready'
        appServerReady = $true
        desktopConnected = $true
        sidecarConnected = $false
        degraded = $false
        unknownCount = if (
            $global:CompatibleResumeScenario -ceq 'UnknownClient'
        ) { 1 } else { 0 }
        unsafeThreadCount = 8
        runtimeInvocationId = if (
            $global:CompatibleResumeScenario -ceq 'IdentityDrift'
        ) { '2' * 32 } else { $runtimeInvocationId }
        brokerProcessId = 4101
        upstreamProcessId = 4102
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
    return [pscustomobject]@{
        IsCompatible = $global:CompatibleResumeScenario -cne 'PayloadMismatch'
        Reason = 'fixture'
    }
}

function Get-CodexLocalRemoteTcpListenerSnapshot {
    param([int[]]$LocalPorts)
    if ($global:CompatibleResumeScenario -ceq 'SidecarPortOccupied') {
        return [pscustomobject]@{
            LocalPort = [int]$LocalPorts[0]
            LocalAddress = '127.0.0.1'
            OwningProcess = 4998
        }
    }
    return @()
}

function Get-CimInstance {
    param([string]$ClassName, [string]$Filter)
    $null = @($ClassName, $Filter)
    if ($global:CompatibleResumeScenario -ceq 'StaleSidecarAlive') {
        return [pscustomobject]@{ ProcessId = 4999 }
    }
    return $null
}

function Get-CodexLocalRemoteDesktopHandoffPreparationPath {
    param([string]$DataDir)
    return Join-Path $DataDir 'desktop-handoff-preparation.json'
}

function Start-CodexLocalRemoteScheduledTaskBounded {
    param([string]$Name)
    $null = $Name
    $global:CompatibleResumeStartCalls += 1
}

function Switch-CodexLocalRemoteRuntimeGeneration {
    $global:CompatibleResumeSwitchCalls += 1
    throw 'The compatible supervisor resume attempted a generation switch.'
}

function Assert-CodexLocalRemoteDesktopHandoffProcessGate {
    $global:CompatibleResumeDesktopGateCalls += 1
    throw 'The compatible supervisor resume attempted a Desktop process gate.'
}

function New-CodexRemoteFailureException {
    param([string]$Stage, [string]$Code)
    return [System.InvalidOperationException]::new("$Stage/$Code")
}

function Invoke-ProofCase {
    param([Parameter(Mandatory)][string]$Scenario)
    $global:CompatibleResumeScenario = $Scenario
    try {
        $proof = Assert-CodexLocalRemoteCompatibleSupervisorResume `
            -SelectedRuntime $runtime `
            -TaskState 'Ready' `
            -TaskName 'Codex Local Remote Fixture' `
            -ManagedDataDir $resolvedDataDir `
            -ManagedSidecarPort 18790 `
            -ManagedBrokerPort 18791
        return [pscustomobject]@{
            Passed = $true
            Decision = [string]$proof.Decision
            ActiveRoot = [string]$proof.ActiveRuntimeRoot
            BrokerProcessId = [int]$proof.BrokerProcessId
            DesktopProcessIdentity = [string]$proof.DesktopProcessIdentity
            UnsafeThreadCount = [int]$proof.UnsafeThreadCount
        }
    } catch {
        return [pscustomobject]@{
            Passed = $false
            Failure = [string]$_.Exception.Message
        }
    }
}

$global:CompatibleResumeScenario = 'Exact'
$baselineProof = Assert-CodexLocalRemoteCompatibleSupervisorResume `
    -SelectedRuntime $runtime `
    -TaskState 'Ready' `
    -TaskName 'Codex Local Remote Fixture' `
    -ManagedDataDir $resolvedDataDir `
    -ManagedSidecarPort 18790 `
    -ManagedBrokerPort 18791

$proofMatches = Test-CodexLocalRemoteCompatibleSupervisorResumeProof `
    -Expected $baselineProof `
    -Current $baselineProof

Start-CodexLocalRemoteRegisteredTask `
    -Name 'Codex Local Remote Fixture' `
    -ManagedDataDir $resolvedDataDir `
    -ManagedSidecarPort 18790 `
    -ManagedBrokerPort 18791 `
    -ManagedBrokerUpstreamPort 18795 `
    -ManagedBasePath '/remote' `
    -ExpectedSelectedRuntimeVersionId $currentVersionId `
    -ExpectedSelectedRuntimeRoot $currentRoot `
    -ExpectedSelectedManifestSha256 ('d' * 64) `
    -CompatibleSupervisorResumeProof $baselineProof

$global:CompatibleResumeScenario = 'TaskDefinitionDrift'
$taskDefinitionDriftFailed = $false
try {
    Start-CodexLocalRemoteRegisteredTask `
        -Name 'Codex Local Remote Fixture' `
        -ManagedDataDir $resolvedDataDir `
        -ManagedSidecarPort 18790 `
        -ManagedBrokerPort 18791 `
        -ManagedBrokerUpstreamPort 18795 `
        -ManagedBasePath '/remote' `
        -ExpectedSelectedRuntimeVersionId $currentVersionId `
        -ExpectedSelectedRuntimeRoot $currentRoot `
        -ExpectedSelectedManifestSha256 ('d' * 64) `
        -CompatibleSupervisorResumeProof $baselineProof
} catch {
    $taskDefinitionDriftFailed = $true
}
$global:CompatibleResumeScenario = 'Exact'

$withoutProofFailed = $false
try {
    Start-CodexLocalRemoteRegisteredTask `
        -Name 'Codex Local Remote Fixture' `
        -ManagedDataDir $resolvedDataDir `
        -ManagedSidecarPort 18790 `
        -ManagedBrokerPort 18791 `
        -ManagedBrokerUpstreamPort 18795 `
        -ManagedBasePath '/remote' `
        -ExpectedSelectedRuntimeVersionId $currentVersionId `
        -ExpectedSelectedRuntimeRoot $currentRoot `
        -ExpectedSelectedManifestSha256 ('d' * 64)
} catch {
    $withoutProofFailed = $true
}

[pscustomobject][ordered]@{
    Exact = Invoke-ProofCase -Scenario 'Exact'
    PayloadMismatch = Invoke-ProofCase -Scenario 'PayloadMismatch'
    StaleSidecarAlive = Invoke-ProofCase -Scenario 'StaleSidecarAlive'
    SidecarPortOccupied = Invoke-ProofCase -Scenario 'SidecarPortOccupied'
    IdentityDrift = Invoke-ProofCase -Scenario 'IdentityDrift'
    UnknownClient = Invoke-ProofCase -Scenario 'UnknownClient'
    ProofMatches = [bool]$proofMatches
    StartCalls = $global:CompatibleResumeStartCalls
    SwitchCalls = $global:CompatibleResumeSwitchCalls
    DesktopGateCalls = $global:CompatibleResumeDesktopGateCalls
    TaskDefinitionDriftFailed = $taskDefinitionDriftFailed
    WithoutProofFailed = $withoutProofFailed
} | ConvertTo-Json -Depth 6 -Compress
