[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ModulePath,

    [Parameter(Mandatory)]
    [string]$SandboxPath
)

$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $ModulePath,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    throw 'The Windows module did not parse.'
}
foreach ($functionName in @(
    'Get-CodexLocalRemoteDesktopHandoffPreparationPath',
    'Get-CodexLocalRemoteNativeDesktopOwnershipSnapshot',
    'Read-CodexLocalRemoteDesktopHandoffPreparation',
    'New-CodexLocalRemoteDesktopHandoffPreparation',
    'Set-CodexLocalRemoteDesktopHandoffPreparationReady',
    'Set-CodexLocalRemoteDesktopHandoffPreparationAttaching',
    'Complete-CodexLocalRemoteDesktopHandoffPreparation'
)) {
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
        throw "Preparation function '$functionName' was not found."
    }
    Invoke-Expression ([string]$functionAst.Extent.Text)
}
$realOwnershipSnapshot =
    (Get-Command `
        Get-CodexLocalRemoteNativeDesktopOwnershipSnapshot `
        -CommandType Function).ScriptBlock

function Get-CimInstance {
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [string]$ClassName,

        [string]$Filter
    )

    if ($ClassName -cne 'Win32_Process' -or
        $Filter -cne "Name = 'ChatGPT.exe'") {
        throw 'Unexpected fixture CIM query.'
    }
    return @(
        [pscustomobject]@{
            ProcessId = 40001
            CommandLine = 'ChatGPT.exe'
            ExecutablePath =
                'C:\Program Files\WindowsApps\OpenAI.Codex_fixture\app\ChatGPT.exe'
        },
        [pscustomobject]@{
            ProcessId = 40002
            CommandLine = 'ChatGPT.exe'
            ExecutablePath =
                'C:\Program Files\WindowsApps\OpenAI.Codex_other\app\ChatGPT.exe'
        }
    )
}

$ambiguousDesktopRootsBlocked = $false
try {
    $null = & $realOwnershipSnapshot `
        -DesktopExecutablePath (
            'C:\Program Files\WindowsApps\' +
            'OpenAI.Codex_fixture\app\ChatGPT.exe'
        )
} catch {
    $ambiguousDesktopRootsBlocked = (
        $_.Exception.Message -ceq
            'Desktop handoff preparation requires one unique native ' +
                'Desktop root, found 2.'
    )
}

function ConvertTo-CanonicalJson {
    param([object]$Value)
    return $Value | ConvertTo-Json -Depth 20 -Compress
}

function Test-NonNegativeInteger {
    param([object]$Value)
    try {
        $number = [decimal]$Value
        return (
            $number -ge 0 -and
            [decimal]::Truncate($number) -eq $number
        )
    } catch {
        return $false
    }
}

function Get-CodexDesktopOwnerRootIdentityKey {
    param(
        [int]$ProcessId,
        [long]$StartTimeUtcTicks,
        [string]$ExecutablePath
    )
    return (
        '{0}|{1}|{2}' -f
            $ProcessId,
            $StartTimeUtcTicks,
            ([System.IO.Path]::GetFullPath(
                $ExecutablePath
            ).ToUpperInvariant())
    )
}

function Get-CodexDesktopOwnerIntentFreshnessDecision {
    param(
        [string]$RequestedAtUtc,
        [int]$MaximumAgeSeconds
    )
    $requested = [DateTimeOffset]::Parse(
        $RequestedAtUtc,
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind
    )
    if ($requested.Offset -ne [TimeSpan]::Zero -or
        $requested -gt [DateTimeOffset]::UtcNow.AddSeconds(5) -or
        $requested -lt
            [DateTimeOffset]::UtcNow.AddSeconds(-$MaximumAgeSeconds)) {
        return 'stale'
    }
    return 'fresh'
}

function Write-AtomicJsonFile {
    param(
        [string]$Path,
        [object]$Value
    )
    $parent = Split-Path -Parent $Path
    $null = New-Item -ItemType Directory -Path $parent -Force
    $Value |
        ConvertTo-Json -Depth 20 |
        Set-Content -LiteralPath $Path -Encoding utf8NoBOM
}

function Get-CodexLocalRemoteNativeDesktopOwnershipSnapshot {
    param([string]$DesktopExecutablePath)
    if (-not [string]::Equals(
        [System.IO.Path]::GetFullPath($DesktopExecutablePath),
        [System.IO.Path]::GetFullPath(
            [string]$script:fixtureOwnership.DesktopExecutablePath
        ),
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'Fixture Desktop path mismatch.'
    }
    return $script:fixtureOwnership
}

$resolvedSandbox = [System.IO.Path]::GetFullPath($SandboxPath)
$null = New-Item -ItemType Directory -Path $resolvedSandbox -Force
$runtimeVersionId = 'a' * 64
$manifestSha256 = 'b' * 64
$runtimeRoot = Join-Path $resolvedSandbox $runtimeVersionId
$desktopPath =
    'C:\Program Files\WindowsApps\OpenAI.Codex_fixture\app\ChatGPT.exe'
$appServerPath =
    'C:\Program Files\WindowsApps\OpenAI.Codex_fixture\app\resources\codex.exe'
$script:fixtureOwnership = [pscustomobject]@{
    DesktopRootProcessId = 41001
    DesktopRootStartTimeUtcTicks = 638894448000000000
    DesktopExecutablePath = $desktopPath
    DesktopRootIdentityKey =
        Get-CodexDesktopOwnerRootIdentityKey `
            -ProcessId 41001 `
            -StartTimeUtcTicks 638894448000000000 `
            -ExecutablePath $desktopPath
    DesktopAppServerProcessId = 41002
    DesktopAppServerStartTimeUtcTicks = 638894448000000001
    DesktopAppServerExecutablePath = $appServerPath
    DesktopAppServerIdentityKey =
        Get-CodexDesktopOwnerRootIdentityKey `
            -ProcessId 41002 `
            -StartTimeUtcTicks 638894448000000001 `
            -ExecutablePath $appServerPath
}

$requested =
    New-CodexLocalRemoteDesktopHandoffPreparation `
        -DataDir $resolvedSandbox `
        -RuntimeVersionId $runtimeVersionId `
        -RuntimeRoot $runtimeRoot `
        -ManifestSha256 $manifestSha256 `
        -Ownership $script:fixtureOwnership
$readiness = [pscustomobject]@{
    status = 'ready'
    appServerReady = $true
    desktopConnected = $false
    sidecarConnected = $true
    degraded = $false
    unknownCount = 0
    unsafeThreadCount = 0
    runtimeInvocationId = 'c' * 32
    brokerProcessId = 42001
    upstreamProcessId = 42002
}
$ready =
    Set-CodexLocalRemoteDesktopHandoffPreparationReady `
        -DataDir $resolvedSandbox `
        -Preparation $requested `
        -Readiness $readiness `
        -SidecarProcessId 42003
$attaching =
    Set-CodexLocalRemoteDesktopHandoffPreparationAttaching `
        -DataDir $resolvedSandbox `
        -Preparation $ready
$completed =
    Complete-CodexLocalRemoteDesktopHandoffPreparation `
        -DataDir $resolvedSandbox `
        -Preparation $attaching `
        -Outcome 'fixture-attached'
$currentPath =
    Get-CodexLocalRemoteDesktopHandoffPreparationPath `
        -DataDir $resolvedSandbox
$lastPath =
    Join-Path $resolvedSandbox 'desktop-handoff-preparation-last.json'
$currentRemovedAfterCompletion =
    -not (Test-Path -LiteralPath $currentPath)

$second =
    New-CodexLocalRemoteDesktopHandoffPreparation `
        -DataDir $resolvedSandbox `
        -RuntimeVersionId $runtimeVersionId `
        -RuntimeRoot $runtimeRoot `
        -ManifestSha256 $manifestSha256 `
        -Ownership $script:fixtureOwnership
$tampered = Get-Content `
    -LiteralPath $currentPath `
    -Raw `
    -Encoding utf8 |
    ConvertFrom-Json -Depth 20 -DateKind String
$tampered | Add-Member -NotePropertyName Unexpected -NotePropertyValue $true
Write-AtomicJsonFile -Path $currentPath -Value $tampered
$tamperedRead =
    Read-CodexLocalRemoteDesktopHandoffPreparation `
        -DataDir $resolvedSandbox `
        -ExpectedRuntimeVersionId $runtimeVersionId `
        -ExpectedRuntimeRoot $runtimeRoot `
        -ExpectedManifestSha256 $manifestSha256
$replacement =
    New-CodexLocalRemoteDesktopHandoffPreparation `
        -DataDir $resolvedSandbox `
        -RuntimeVersionId $runtimeVersionId `
        -RuntimeRoot $runtimeRoot `
        -ManifestSha256 $manifestSha256 `
        -Ownership $script:fixtureOwnership
$tamperedReplaced = (
    [string]$replacement.PreparationId -cne
        [string]$second.PreparationId
)
$null =
    Complete-CodexLocalRemoteDesktopHandoffPreparation `
        -DataDir $resolvedSandbox `
        -Preparation $replacement `
        -Outcome 'fixture-replaced'
$differentRuntimeVersionId = 'd' * 64
$differentManifestSha256 = 'e' * 64
$differentRuntimeRoot =
    Join-Path $resolvedSandbox $differentRuntimeVersionId
$null =
    New-CodexLocalRemoteDesktopHandoffPreparation `
        -DataDir $resolvedSandbox `
        -RuntimeVersionId $differentRuntimeVersionId `
        -RuntimeRoot $differentRuntimeRoot `
        -ManifestSha256 $differentManifestSha256 `
        -Ownership $script:fixtureOwnership
$differentFreshPreparationBlocked = $false
try {
    $null =
        New-CodexLocalRemoteDesktopHandoffPreparation `
            -DataDir $resolvedSandbox `
            -RuntimeVersionId $runtimeVersionId `
            -RuntimeRoot $runtimeRoot `
            -ManifestSha256 $manifestSha256 `
            -Ownership $script:fixtureOwnership
} catch {
    $differentFreshPreparationBlocked = $true
}

[pscustomobject]@{
    RequestedPhase = [string]$requested.Phase
    ReadyPhase = [string]$ready.Phase
    ReadyInvocationId = [string]$ready.RuntimeInvocationId
    ReadySidecarProcessId = [int]$ready.SidecarProcessId
    AttachingPhase = [string]$attaching.Phase
    Completed = [bool]$completed
    CurrentRemovedAfterCompletion = $currentRemovedAfterCompletion
    LastReceiptWritten =
        (Test-Path -LiteralPath $lastPath -PathType Leaf)
    SecondPreparationId = [string]$second.PreparationId
    TamperedRejected = $null -eq $tamperedRead
    TamperedReplaced = $tamperedReplaced
    DifferentFreshPreparationBlocked =
        $differentFreshPreparationBlocked
    AmbiguousDesktopRootsBlocked = $ambiguousDesktopRootsBlocked
} | ConvertTo-Json -Depth 8 -Compress
