[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ModulePath,

    [Parameter(Mandatory)]
    [string]$RegistrationPath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot,

    [Parameter(Mandatory)]
    [ValidateSet(
        'pre-takeover',
        'pre-takeover-prehidden',
        'pre-takeover-preheadless',
        'pre-takeover-preheadless-prehidden',
        'foreign-drift'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
Import-Module $ModulePath -Force

$sourceRoot = Join-Path $SandboxRoot 'source'
$dataDir = Join-Path $SandboxRoot 'data'
foreach ($relativeDirectory in @(
    'apps\broker\dist',
    'apps\sidecar\dist',
    'apps\web\dist',
    'scripts\windows'
)) {
    $null = New-Item `
        -ItemType Directory `
        -Path (Join-Path $sourceRoot $relativeDirectory) `
        -Force
}
Set-Content `
    -LiteralPath (Join-Path $sourceRoot 'package.json') `
    -Value '{"name":"ownership-fixture","private":true,"type":"module"}' `
    -Encoding utf8NoBOM
Set-Content `
    -LiteralPath (Join-Path $sourceRoot 'apps\broker\dist\cli.js') `
    -Value 'console.log("broker");' `
    -Encoding utf8NoBOM
Set-Content `
    -LiteralPath (Join-Path $sourceRoot 'apps\sidecar\dist\cli.js') `
    -Value 'console.log("sidecar");' `
    -Encoding utf8NoBOM
Set-Content `
    -LiteralPath (Join-Path $sourceRoot 'apps\web\dist\index.html') `
    -Value '<!doctype html><title>old</title>' `
    -Encoding utf8NoBOM
Set-Content `
    -LiteralPath (
        Join-Path $sourceRoot 'scripts\windows\Start-CodexLocalRemote.ps1'
    ) `
    -Value 'Write-Output start' `
    -Encoding utf8NoBOM

$oldPlan = Get-CodexLocalRemoteRuntimeVersionPlan `
    -SourceRoot $sourceRoot `
    -DataDir $dataDir
$oldRuntime = Install-CodexLocalRemoteRuntimeVersion -Plan $oldPlan
Set-Content `
    -LiteralPath (Join-Path $sourceRoot 'apps\web\dist\index.html') `
    -Value '<!doctype html><title>candidate</title>' `
    -Encoding utf8NoBOM
$candidatePlan = Get-CodexLocalRemoteRuntimeVersionPlan `
    -SourceRoot $sourceRoot `
    -DataDir $dataDir
$candidateRuntime =
    Install-CodexLocalRemoteRuntimeVersion -Plan $candidatePlan

$TaskName = 'Codex Local Remote'
$NodePath = Join-Path $SandboxRoot 'node.exe'
$PwshPath = (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop |
    Select-Object -First 1).Source
$InstallRoot = $sourceRoot
$DataDir = $dataDir
$Port = 18790
$BrokerPort = 18791
$BrokerUpstreamPort = 18792
$BasePath = '/codex-remote'
$expected = Get-StartupTaskDefinition `
    -TaskName $TaskName `
    -NodePath $NodePath `
    -PwshPath $PwshPath `
    -InstallRoot ([string]$candidateRuntime.RuntimeRoot) `
    -DataDir $DataDir `
    -Port $Port `
    -BrokerPort $BrokerPort `
    -BrokerUpstreamPort $BrokerUpstreamPort `
    -BasePath $BasePath
$sourceExpected = Get-StartupTaskDefinition `
    -TaskName $TaskName `
    -NodePath $NodePath `
    -PwshPath $PwshPath `
    -InstallRoot $sourceRoot `
    -DataDir $DataDir `
    -Port $Port `
    -BrokerPort $BrokerPort `
    -BrokerUpstreamPort $BrokerUpstreamPort `
    -BasePath $BasePath
$legacyExpected = Get-LegacyStartupTaskDefinition `
    -TaskName $TaskName `
    -NodePath $NodePath `
    -InstallRoot $sourceRoot `
    -DataDir $DataDir `
    -Port $Port `
    -BasePath $BasePath
$oldDefinition = Get-StartupTaskDefinition `
    -TaskName $TaskName `
    -NodePath $NodePath `
    -PwshPath $PwshPath `
    -InstallRoot ([string]$oldRuntime.RuntimeRoot) `
    -DataDir $DataDir `
    -Port $Port `
    -BrokerPort $BrokerPort `
    -BrokerUpstreamPort $BrokerUpstreamPort `
    -BasePath $BasePath

$functionNames = @(
    'Get-PreHiddenWindowStartupTaskDefinition',
    'Get-PreTakeoverStartupTaskDefinition',
    'Get-LimitedRunLevelStartupTaskDefinition',
    'Test-ManagedStartupTaskWithLegacyRunLevel',
    'Test-ExistingTaskOwnership'
)
$tokens = $null
$parseErrors = $null
$registrationAst = [Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $RegistrationPath),
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) {
    throw 'fixture could not parse registration script'
}
foreach ($functionName in $functionNames) {
    $functionAst = @(
        $registrationAst.FindAll({
            param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            [string]$node.Name -ceq $functionName
        }, $true)
    )
    if ($functionAst.Count -ne 1) {
        throw "fixture expected exactly one '$functionName' function"
    }
    Invoke-Expression ([string]$functionAst[0].Extent.Text)
}

$legacyDesktopOwnerDefinition =
    Get-LegacyDesktopOwningStartupTaskDefinitionV3 `
        -Definition $oldDefinition
$historicalDefinition =
    Get-PreTakeoverStartupTaskDefinition `
        -Definition $legacyDesktopOwnerDefinition
if ($Mode -cin @(
    'pre-takeover-preheadless',
    'pre-takeover-preheadless-prehidden'
)) {
    $historicalDefinition =
        Get-PreHeadlessConsoleStartupTaskDefinition `
            -Definition $historicalDefinition
}
if ($Mode -cin @(
    'pre-takeover-prehidden',
    'pre-takeover-preheadless-prehidden'
)) {
    $historicalDefinition =
        Get-PreHiddenWindowStartupTaskDefinition `
            -Definition $historicalDefinition
}

$taskExecute = if (
    $null -ne $historicalDefinition.PSObject.Properties['TaskExecute']
) {
    [string]$historicalDefinition.TaskExecute
} else {
    [string]$historicalDefinition.Execute
}
$taskArguments = if (
    $null -ne $historicalDefinition.PSObject.Properties['TaskArguments']
) {
    [string]$historicalDefinition.TaskArguments
} else {
    [string]$historicalDefinition.Arguments
}
if ($Mode -ceq 'foreign-drift') {
    $taskArguments = $taskArguments.Replace(
        '-BrokerPort 18791',
        '-BrokerPort 19999'
    )
}
$task = [pscustomobject]@{
    TaskName = [string]$historicalDefinition.TaskName
    TaskPath = [string]$historicalDefinition.TaskPath
    Description = [string]$historicalDefinition.Description
    Actions = @([pscustomobject]@{
        Execute = $taskExecute
        Arguments = $taskArguments
        WorkingDirectory = [string]$historicalDefinition.WorkingDirectory
    })
    Principal = [pscustomobject]@{
        UserId = [string]$historicalDefinition.PrincipalUserSid
        LogonType = [string]$historicalDefinition.PrincipalLogonType
        RunLevel = [string]$historicalDefinition.PrincipalRunLevel
    }
    Triggers = @([pscustomobject]@{
        CimClassName = [string]$historicalDefinition.TriggerClass
        UserId = [string]$historicalDefinition.TriggerUserSid
        Enabled = [bool]$historicalDefinition.TriggerEnabled
    })
    Settings = $historicalDefinition.Settings
    State = 'Ready'
}

$ownership = Test-ExistingTaskOwnership -Task $task
$oldValidation = Test-CodexLocalRemoteRuntimeVersion `
    -RuntimeRoot ([string]$oldRuntime.RuntimeRoot)
[pscustomobject]@{
    Mode = $Mode
    IsManaged = [bool]$ownership.IsManaged
    Kind = [string]$ownership.Kind
    OldRuntimeRoot = [string]$oldRuntime.RuntimeRoot
    CandidateRuntimeRoot = [string]$candidateRuntime.RuntimeRoot
    RootsDiffer = -not [string]::Equals(
        [string]$oldRuntime.RuntimeRoot,
        [string]$candidateRuntime.RuntimeRoot,
        [System.StringComparison]::OrdinalIgnoreCase
    )
    OldRuntimeValid = [bool]$oldValidation.IsValid
    HasTakeoverSwitch = $taskArguments.Contains(
        '-TakeOverExistingNativeDesktop',
        [System.StringComparison]::Ordinal
    )
} | ConvertTo-Json -Depth 10 -Compress
