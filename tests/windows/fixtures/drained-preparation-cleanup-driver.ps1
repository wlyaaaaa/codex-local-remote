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
        $node.Name -ceq
            'Complete-OnDemandDrainedDesktopHandoffPreparation'
    },
    $true
) | Select-Object -First 1
if ($null -eq $functionAst) {
    throw 'The drained preparation cleanup helper was not found.'
}
Invoke-Expression ([string]$functionAst.Extent.Text)

$resolvedDataDir = 'C:\fixture\data'
$expectedDesktopPath =
    'C:\Program Files\WindowsApps\OpenAI.ChatGPT\ChatGPT.exe'
$runtime = [pscustomobject]@{
    CurrentVersionId = 'a' * 64
    CurrentRoot = 'C:\fixture\current-runtime'
    CurrentManifestSha256 = 'b' * 64
    PreviousVersionId = 'c' * 64
    PreviousRoot = 'C:\fixture\previous-runtime'
    PreviousManifestSha256 = 'd' * 64
}
$desktopRoot = [pscustomobject]@{
    ProcessId = 1234
    CreationDate = '20260802120000.000000-000'
    ExecutablePath = $expectedDesktopPath
}
$script:Scenario = ''
$script:ReadCalls = 0
$script:CompleteCalls = 0
$script:CompletedOutcome = ''

function Assert-OnDemandDesktopRootExecutable {
    param(
        [object]$DesktopRoot,
        [string]$ExpectedDesktopPath
    )
    if ([int]$DesktopRoot.ProcessId -ne 1234 -or
        [string]$ExpectedDesktopPath -cne $expectedDesktopPath) {
        throw 'Fixture received an unexpected Desktop root.'
    }
}

function Get-ProcessCreationIdentity {
    param([object]$CreationDate)
    $null = $CreationDate
    return [pscustomobject]@{
        CreationDateUtcTicks = 123456789
    }
}

function Get-CodexDesktopOwnerRootIdentityKey {
    param(
        [int]$ProcessId,
        [long]$StartTimeUtcTicks,
        [string]$ExecutablePath
    )
    return "$ProcessId|$StartTimeUtcTicks|$ExecutablePath"
}

function Read-CodexLocalRemoteDesktopHandoffPreparation {
    param(
        [string]$DataDir,
        [string]$ExpectedRuntimeVersionId,
        [string]$ExpectedRuntimeRoot,
        [string]$ExpectedManifestSha256
    )
    $null = $DataDir
    $null = $ExpectedRuntimeRoot
    $null = $ExpectedManifestSha256
    $script:ReadCalls++
    $isCurrent = $ExpectedRuntimeVersionId -ceq $runtime.CurrentVersionId
    $isPrevious = $ExpectedRuntimeVersionId -ceq $runtime.PreviousVersionId
    $phase = switch ($script:Scenario) {
        'ready' { 'ready' }
        'requested' { 'requested' }
        default { 'attaching' }
    }
    $shouldReturn = switch ($script:Scenario) {
        'previous-attaching' { $isPrevious }
        'no-match' { $false }
        default { $isCurrent }
    }
    if (-not $shouldReturn) {
        return $null
    }
    $identityKey = if ($script:Scenario -ceq 'foreign-root') {
        '9999|987654321|C:\foreign\ChatGPT.exe'
    } else {
        '1234|123456789|' + $expectedDesktopPath
    }
    return [pscustomobject]@{
        PreparationId = [guid]::NewGuid().ToString('N')
        Phase = $phase
        DesktopRootIdentityKey = $identityKey
    }
}

function Complete-CodexLocalRemoteDesktopHandoffPreparation {
    param(
        [string]$DataDir,
        [object]$Preparation,
        [string]$Outcome
    )
    $null = $DataDir
    $null = $Preparation
    $script:CompleteCalls++
    $script:CompletedOutcome = $Outcome
    return $true
}

$results = [ordered]@{}
foreach ($scenario in @(
    'current-attaching',
    'previous-attaching',
    'foreign-root',
    'ready',
    'requested',
    'no-match'
)) {
    $script:Scenario = $scenario
    $script:ReadCalls = 0
    $script:CompleteCalls = 0
    $script:CompletedOutcome = ''
    Complete-OnDemandDrainedDesktopHandoffPreparation `
        -Runtime $runtime `
        -DesktopRoot $desktopRoot `
        -ExpectedDesktopPath $expectedDesktopPath
    $results[$scenario] = [ordered]@{
        ReadCalls = $script:ReadCalls
        CompleteCalls = $script:CompleteCalls
        Outcome = $script:CompletedOutcome
    }
}

[pscustomobject]$results | ConvertTo-Json -Compress -Depth 5
