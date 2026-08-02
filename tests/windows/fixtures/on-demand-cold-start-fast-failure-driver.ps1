[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptPath,

    [Parameter(Mandatory)]
    [string]$ModulePath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot
)

$ErrorActionPreference = 'Stop'
Import-Module $ModulePath -Force
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

$requiredFunctions = @(
    'Get-OnDemandCachedRuntimeValidation',
    'Get-OnDemandCachedBrokerPayloadCompatibility',
    'Assert-OnDemandDesktopLaunchNotTerminal'
)
foreach ($functionName in $requiredFunctions) {
    $functionAst = $ast.FindAll(
        {
            param($node)
            $node -is
                [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -ceq $functionName
        },
        $true
    ) | Select-Object -First 1
    if ($null -eq $functionAst) {
        throw "The cold-start helper '$functionName' was not found."
    }
    Invoke-Expression ([string]$functionAst.Extent.Text)
}

$script:onDemandRuntimeValidationCache = @{}
$script:onDemandBrokerPayloadCompatibilityCache = @{}
$script:runtimeValidationCalls = 0
$script:compatibilityCalls = 0

function Test-CodexLocalRemoteRuntimeVersion {
    param(
        [string]$RuntimeRoot,
        [string]$ExpectedVersionId
    )

    $script:runtimeValidationCalls++
    return [pscustomobject]@{
        IsValid = $true
        RuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
        VersionId = $ExpectedVersionId
        ManifestSha256 = 'm' * 64
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
    $script:compatibilityCalls++
    return [pscustomobject]@{
        IsCompatible = $true
        Reason = 'fixture-compatible'
    }
}

function Test-NonNegativeInteger {
    param([AllowNull()][object]$Value)
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

$runtimeRoot = Join-Path $SandboxRoot ('runtime-' + ('a' * 64))
$null = New-Item -ItemType Directory -Path $runtimeRoot -Force
$versionId = 'a' * 64
$null = Get-OnDemandCachedRuntimeValidation `
    -RuntimeRoot $runtimeRoot `
    -ExpectedVersionId $versionId
$runtimeValidationCallsAfterCache = $script:runtimeValidationCalls
$null = Get-OnDemandCachedRuntimeValidation `
    -RuntimeRoot $runtimeRoot `
    -ExpectedVersionId $versionId `
    -Refresh
$runtimeValidationCallsAfterRefresh = $script:runtimeValidationCalls
$null = Get-OnDemandCachedRuntimeValidation `
    -RuntimeRoot $runtimeRoot `
    -ExpectedVersionId $versionId
$compatibilityArguments = @{
    CurrentRuntimeRoot = $runtimeRoot
    CurrentVersionId = $versionId
    CurrentManifestSha256 = 'b' * 64
    ActiveRuntimeRoot = $runtimeRoot
    ActiveVersionId = $versionId
    ActiveManifestSha256 = 'b' * 64
}
$null = Get-OnDemandCachedBrokerPayloadCompatibility @compatibilityArguments
$null = Get-OnDemandCachedBrokerPayloadCompatibility @compatibilityArguments

$correlationId = 'c' * 32
$notBefore = [DateTimeOffset]::UtcNow.AddSeconds(-2)
$receiptPath = Join-Path $SandboxRoot 'desktop-launch-last.json'
function Write-FixtureReceipt {
    param(
        [string]$Status,
        [string]$CorrelationId,
        [DateTimeOffset]$RecordedAtUtc,
        [AllowNull()][object]$FailureStage,
        [AllowNull()][object]$FailureCode,
        [string]$RemoteDecision
    )

    [pscustomobject][ordered]@{
        Signature = 'codex-local-remote/desktop-launch/v2'
        Version = 2
        Status = $Status
        RemoteEnabled = $false
        RemoteDecision = if (-not [string]::IsNullOrWhiteSpace(
            $RemoteDecision
        )) {
            $RemoteDecision
        } elseif ($Status -ceq 'launched-native') {
                'remote-not-ready'
        } else {
            'remote-attach-failed-process-preserved'
        }
        RemoteFallbackAttempts = if ($Status -ceq 'launched-native') { 1 } else { 0 }
        RemoteStopAttempts = 0
        DesktopProcessId = 42001
        RemoteFailureStage = $FailureStage
        RemoteFailureCode = $FailureCode
        CorrelationId = $CorrelationId
        FeedbackStatus = 'filtered'
        FeedbackFailureCode = $null
        RecordedAtUtc = $RecordedAtUtc.ToUniversalTime().ToString('O')
    } | ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath $receiptPath -Encoding utf8NoBOM
}

Write-FixtureReceipt `
    -Status 'launched-native' `
    -CorrelationId $correlationId `
    -RecordedAtUtc ([DateTimeOffset]::UtcNow) `
    -FailureStage $null `
    -FailureCode $null
$native = Read-CodexDesktopLaunchReceipt -DataDir $SandboxRoot
$terminalError = $null
try {
    Assert-OnDemandDesktopLaunchNotTerminal `
        -DataDir $SandboxRoot `
        -ExpectedCorrelationId $correlationId `
        -NotBeforeUtc $notBefore
} catch {
    $terminalError = $_.Exception
}
if ($null -eq $terminalError) {
    throw 'The fresh correlated native receipt did not fail fast.'
}

Write-FixtureReceipt `
    -Status 'remote-launch-unverified' `
    -CorrelationId $correlationId `
    -RecordedAtUtc ([DateTimeOffset]::UtcNow) `
    -FailureStage 'desktop-attach' `
    -FailureCode 'desktop-attach-failed'
$unverified = Read-CodexDesktopLaunchReceipt -DataDir $SandboxRoot

Write-FixtureReceipt `
    -Status 'launched-native' `
    -CorrelationId $correlationId `
    -RecordedAtUtc $notBefore.AddSeconds(-1) `
    -FailureStage $null `
    -FailureCode $null
$stale = Assert-OnDemandDesktopLaunchNotTerminal `
    -DataDir $SandboxRoot `
    -ExpectedCorrelationId $correlationId `
    -NotBeforeUtc $notBefore

Write-FixtureReceipt `
    -Status 'launched-native' `
    -CorrelationId ('d' * 32) `
    -RecordedAtUtc ([DateTimeOffset]::UtcNow) `
    -FailureStage $null `
    -FailureCode $null
$wrongCorrelation = Assert-OnDemandDesktopLaunchNotTerminal `
    -DataDir $SandboxRoot `
    -ExpectedCorrelationId $correlationId `
    -NotBeforeUtc $notBefore

Write-FixtureReceipt `
    -Status 'launched-native' `
    -CorrelationId $correlationId `
    -RecordedAtUtc ([DateTimeOffset]::UtcNow) `
    -FailureStage $null `
    -FailureCode $null `
    -RemoteDecision 'not-an-allowlisted-decision'
$invalidAllowlist = Read-CodexDesktopLaunchReceipt -DataDir $SandboxRoot
[pscustomobject][ordered]@{
    RuntimeValidationCallsAfterCache = $runtimeValidationCallsAfterCache
    RuntimeValidationCallsAfterRefresh =
        $runtimeValidationCallsAfterRefresh
    CompatibilityCalls = $script:compatibilityCalls
    Native = $native
    Unverified = $unverified
    Stale = $stale
    WrongCorrelation = $wrongCorrelation
    InvalidAllowlist = $invalidAllowlist
    ErrorData = [pscustomobject]@{
        Status = [string]$terminalError.Data[
            'CodexLocalRemote.DesktopLaunchStatus'
        ]
        Stage = [string]$terminalError.Data[
            'CodexLocalRemote.FailureStage'
        ]
        Code = [string]$terminalError.Data[
            'CodexLocalRemote.FailureCode'
        ]
    }
} | ConvertTo-Json -Depth 8
