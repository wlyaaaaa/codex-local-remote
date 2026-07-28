[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ModulePath,

    [Parameter(Mandatory)]
    [string]$Sandbox
)

$ErrorActionPreference = 'Stop'
Import-Module $ModulePath -Force

$sourceRoot = Join-Path $Sandbox 'source'
$dataDir = Join-Path $Sandbox 'data'
foreach ($relativeDirectory in @(
    'apps\broker\dist',
    'apps\sidecar\dist',
    'apps\web\dist',
    'scripts\windows'
)) {
    $null = [System.IO.Directory]::CreateDirectory(
        (Join-Path $sourceRoot $relativeDirectory)
    )
}
Set-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Encoding utf8NoBOM -Value @'
{"name":"runtime-fixture","private":true,"type":"module"}
'@
Set-Content -LiteralPath (Join-Path $sourceRoot 'apps\broker\dist\cli.js') -Encoding utf8NoBOM -Value 'console.log("broker");'
Set-Content -LiteralPath (Join-Path $sourceRoot 'apps\sidecar\dist\cli.js') -Encoding utf8NoBOM -Value 'console.log("sidecar");'
Set-Content -LiteralPath (Join-Path $sourceRoot 'apps\web\dist\index.html') -Encoding utf8NoBOM -Value '<!doctype html><title>one</title>'
Set-Content -LiteralPath (Join-Path $sourceRoot 'scripts\windows\Start-CodexLocalRemote.ps1') -Encoding utf8NoBOM -Value 'Write-Output start'

$firstPlan = Get-CodexLocalRemoteRuntimeVersionPlan `
    -SourceRoot $sourceRoot `
    -DataDir $dataDir
$firstInstall = Install-CodexLocalRemoteRuntimeVersion -Plan $firstPlan
$firstPointer = Set-CodexLocalRemoteCurrentRuntime `
    -DataDir $dataDir `
    -Runtime $firstInstall
$stagingRoot = Join-Path `
    (Split-Path -Parent $firstInstall.RuntimeRoot) `
    ".$([string]$firstInstall.VersionId).$([guid]::NewGuid().ToString('N')).installing"
Copy-Item -LiteralPath $firstInstall.RuntimeRoot -Destination $stagingRoot -Recurse
$stagingValidation = Test-CodexLocalRemoteRuntimeVersion `
    -RuntimeRoot $stagingRoot `
    -ExpectedVersionId ([string]$firstInstall.VersionId) `
    -AllowStagingDirectory
$strictStagingValidation = Test-CodexLocalRemoteRuntimeVersion `
    -RuntimeRoot $stagingRoot `
    -ExpectedVersionId ([string]$firstInstall.VersionId)

Set-Content -LiteralPath (Join-Path $sourceRoot 'apps\web\dist\index.html') -Encoding utf8NoBOM -Value '<!doctype html><title>two</title>'
$secondPlan = Get-CodexLocalRemoteRuntimeVersionPlan `
    -SourceRoot $sourceRoot `
    -DataDir $dataDir
$secondInstall = Install-CodexLocalRemoteRuntimeVersion -Plan $secondPlan
$secondPointer = Set-CodexLocalRemoteCurrentRuntime `
    -DataDir $dataDir `
    -Runtime $secondInstall
$current = Get-CodexLocalRemoteCurrentRuntime -DataDir $dataDir
$rollbackPointer = Set-CodexLocalRemoteCurrentRuntime `
    -DataDir $dataDir `
    -Runtime $firstInstall

$tamperedFile = Join-Path $secondInstall.RuntimeRoot 'apps\web\dist\index.html'
Set-Content -LiteralPath $tamperedFile -Encoding utf8NoBOM -Value 'tampered'
$tamperedValidation = Test-CodexLocalRemoteRuntimeVersion `
    -RuntimeRoot $secondInstall.RuntimeRoot

[pscustomobject]@{
    FirstVersionId = [string]$firstInstall.VersionId
    SecondVersionId = [string]$secondInstall.VersionId
    FirstRuntimeExists = Test-Path -LiteralPath $firstInstall.RuntimeRoot -PathType Container
    SecondRuntimeExists = Test-Path -LiteralPath $secondInstall.RuntimeRoot -PathType Container
    ManifestExists = Test-Path -LiteralPath $secondInstall.ManifestPath -PathType Leaf
    CurrentVersionId = [string]$current.CurrentVersionId
    PreviousVersionId = [string]$current.PreviousVersionId
    FirstPointerPrevious = $firstPointer.PreviousVersionId
    SecondPointerPrevious = [string]$secondPointer.PreviousVersionId
    RollbackCurrent = [string]$rollbackPointer.CurrentVersionId
    RollbackPrevious = [string]$rollbackPointer.PreviousVersionId
    StagingValid = [bool]$stagingValidation.IsValid
    StrictStagingValid = [bool]$strictStagingValidation.IsValid
    StrictStagingReason = [string]$strictStagingValidation.Reason
    TamperedValid = [bool]$tamperedValidation.IsValid
    TamperedReason = [string]$tamperedValidation.Reason
} | ConvertTo-Json -Compress -Depth 10
