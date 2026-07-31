[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptPath
)

$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $ScriptPath,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    throw 'The on-demand handoff script did not parse.'
}
$functionAst = $ast.FindAll(
    {
        param($node)
        $node -is
            [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -ceq 'Invoke-OnDemandPreparedAttachCompensation'
    },
    $true
) | Select-Object -First 1
if ($null -eq $functionAst) {
    throw 'Prepared attach compensation function was not found.'
}
Invoke-Expression ([string]$functionAst.Extent.Text)

$resolvedDataDir = 'C:\fixture\CodexLocalRemote'
$DesktopExitTimeoutSeconds = 1
$desktopPath =
    'C:\Program Files\WindowsApps\OpenAI.Codex_fixture\app\ChatGPT.exe'
$script:preparedAttachIntent = $null

function New-FixtureRoot {
    param(
        [int]$ProcessId,
        [long]$StartTimeUtcTicks
    )
    return [pscustomobject]@{
        ProcessId = $ProcessId
        CreationDate = $StartTimeUtcTicks
        ExecutablePath = $desktopPath
        CommandLine = '"ChatGPT.exe"'
    }
}

function Get-CimInstance {
    param(
        [string]$ClassName,
        [string]$Filter,
        [object]$ErrorAction
    )
    $null = $ClassName
    $null = $Filter
    $null = $ErrorAction
    return @($script:fixtureState.Roots)
}

function Get-CodexLocalRemoteNativeDesktopRootCandidates {
    param([string]$DesktopExecutablePath)
    $null = $DesktopExecutablePath
    return @($script:fixtureState.Roots)
}

function Assert-OnDemandDesktopRootExecutable {
    param(
        [object]$DesktopRoot,
        [string]$ExpectedDesktopPath
    )
    if (-not [string]::Equals(
        [string]$DesktopRoot.ExecutablePath,
        $ExpectedDesktopPath,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'Fixture Desktop path mismatch.'
    }
}

function Get-ProcessCreationIdentity {
    param([object]$CreationDate)
    return [pscustomobject]@{
        CreationDateUtcTicks = [long]$CreationDate
    }
}

function Open-ProcessIdentityHandle {
    param(
        [int]$ProcessId,
        [long]$ExpectedCreationDateUtcTicks
    )
    $null = $ProcessId
    $process = [pscustomobject]@{}
    $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
    return [pscustomobject]@{
        StartTimeUtcTicks = $ExpectedCreationDateUtcTicks
        Process = $process
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

function Stop-OnDemandDesktopRoot {
    param(
        [object]$DesktopRoot,
        [string]$ExpectedDesktopPath
    )
    Assert-OnDemandDesktopRootExecutable `
        -DesktopRoot $DesktopRoot `
        -ExpectedDesktopPath $ExpectedDesktopPath
    $script:fixtureState.StopCalls++
    $script:fixtureState.Roots = @()
}

function Start-OnDemandNativeDesktop {
    param(
        [string]$RuntimeRoot,
        [string]$DesktopExecutablePath
    )
    $null = $RuntimeRoot
    $null = $DesktopExecutablePath
    $script:fixtureState.NativeStartCalls++
    $script:fixtureState.Roots = @(
        New-FixtureRoot `
            -ProcessId 61001 `
            -StartTimeUtcTicks 610010
    )
}

function Set-CodexLocalRemoteDesiredMode {
    param(
        [string]$DataDir,
        [string]$Mode,
        [string]$RuntimeVersionId,
        [string]$RuntimeRoot
    )
    $null = $DataDir
    $null = $RuntimeVersionId
    $null = $RuntimeRoot
    if ($Mode -cne 'Native') {
        throw 'Fixture expected Native desired mode.'
    }
    $script:fixtureState.DesiredNativeCalls++
    return [pscustomobject]@{ Mode = $Mode }
}

function Complete-CodexLocalRemoteDesktopHandoffPreparation {
    param(
        [string]$DataDir,
        [object]$Preparation,
        [string]$Outcome
    )
    $null = $DataDir
    $null = $Preparation
    if ($Outcome -cne 'attach-compensated') {
        throw 'Fixture compensation outcome mismatch.'
    }
    $script:fixtureState.CompletionCalls++
    return $true
}

function Start-Sleep {
    param([int]$Milliseconds)
    $null = $Milliseconds
}

$runtime = [pscustomobject]@{
    CurrentVersionId = 'a' * 64
    CurrentRoot = 'C:\fixture\runtime'
}
$originalRootIdentityKey =
    Get-CodexDesktopOwnerRootIdentityKey `
        -ProcessId 41001 `
        -StartTimeUtcTicks 410010 `
        -ExecutablePath $desktopPath
$preparation = [pscustomobject]@{
    RuntimeInvocationId = 'b' * 32
    DesktopRootIdentityKey = $originalRootIdentityKey
}

function Invoke-FixtureScenario {
    param(
        [ValidateSet(
            'OriginalStillPresent',
            'NoRootPresent',
            'FailedAttachedRootPresent'
        )]
        [string]$Mode
    )
    $roots = switch ($Mode) {
        'OriginalStillPresent' {
            @(
                New-FixtureRoot `
                    -ProcessId 41001 `
                    -StartTimeUtcTicks 410010
            )
        }
        'FailedAttachedRootPresent' {
            @(
                New-FixtureRoot `
                    -ProcessId 51001 `
                    -StartTimeUtcTicks 510010
            )
        }
        default {
            @()
        }
    }
    $script:fixtureState = [pscustomobject]@{
        Roots = @($roots)
        StopCalls = 0
        NativeStartCalls = 0
        DesiredNativeCalls = 0
        CompletionCalls = 0
    }
    $result =
        Invoke-OnDemandPreparedAttachCompensation `
            -Preparation $preparation `
            -Runtime $runtime `
            -DesktopExecutablePath $desktopPath
    return [ordered]@{
        Status = [string]$result.Status
        DesktopRestored = [bool]$result.DesktopRestored
        StopCalls = [int]$script:fixtureState.StopCalls
        NativeStartCalls = [int]$script:fixtureState.NativeStartCalls
        DesiredNativeCalls =
            [int]$script:fixtureState.DesiredNativeCalls
        CompletionCalls = [int]$script:fixtureState.CompletionCalls
    }
}

[ordered]@{
    OriginalStillPresent =
        Invoke-FixtureScenario -Mode OriginalStillPresent
    NoRootPresent =
        Invoke-FixtureScenario -Mode NoRootPresent
    FailedAttachedRootPresent =
        Invoke-FixtureScenario -Mode FailedAttachedRootPresent
} | ConvertTo-Json -Depth 8 -Compress
