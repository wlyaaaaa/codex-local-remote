[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LauncherPath
)

$ErrorActionPreference = 'Stop'
. $LauncherPath -DefinitionOnly

$script:startTaskCalls = 0
$script:desktopStartCalls = 0
$expectedVersionId = 'a' * 64
$expectedRoot = 'C:\Runtime\expected'

function Get-CodexLocalRemoteCurrentRuntime {
    param([string]$DataDir)
    $null = $DataDir
    return [pscustomobject]@{
        CurrentVersionId = 'b' * 64
        CurrentRoot = 'C:\Runtime\foreign'
    }
}

$requestFailure = $null
$desktopFailure = $null
try {
    $null = Assert-CodexExpectedSelectedRuntime `
        -ManagedDataDir 'C:\Data' `
        -ExpectedVersionId $expectedVersionId `
        -ExpectedRoot $expectedRoot
    $script:startTaskCalls++
} catch {
    $requestFailure = Get-CodexRemoteFailureDiagnostic `
        -ErrorRecord $_ `
        -DefaultStage 'unexpected' `
        -DefaultCode 'unexpected'
}

try {
    $null = Assert-CodexExpectedSelectedRuntime `
        -ManagedDataDir 'C:\Data' `
        -ExpectedVersionId $expectedVersionId `
        -ExpectedRoot $expectedRoot
    $script:desktopStartCalls++
} catch {
    $desktopFailure = Get-CodexRemoteFailureDiagnostic `
        -ErrorRecord $_ `
        -DefaultStage 'unexpected' `
        -DefaultCode 'unexpected'
}

[pscustomobject][ordered]@{
    StartTaskCalls = $script:startTaskCalls
    DesktopStartCalls = $script:desktopStartCalls
    RequestFailureStage = [string]$requestFailure.Stage
    RequestFailureCode = [string]$requestFailure.Code
    DesktopFailureStage = [string]$desktopFailure.Stage
    DesktopFailureCode = [string]$desktopFailure.Code
} | ConvertTo-Json -Compress
