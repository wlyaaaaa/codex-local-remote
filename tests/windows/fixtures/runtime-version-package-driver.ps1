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
$oldTaskXml = @"
<Task>
  <RegistrationInfo><Description>exact old task</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Delay>PT17S</Delay></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>StopExisting</MultipleInstancesPolicy></Settings>
  <Actions Context="Author">
    <Exec>
      <Command>conhost.exe</Command>
      <Arguments>--headless pwsh.exe -InstallRoot "$([string]$firstInstall.RuntimeRoot)"</Arguments>
      <WorkingDirectory>$([string]$firstInstall.RuntimeRoot)</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
$oldTaskXmlSha256 = Get-StringSha256 -Value $oldTaskXml
$previousTaskPreImage = [pscustomobject]@{
    TaskName = 'Codex Local Remote'
    RuntimeVersionId = [string]$firstInstall.VersionId
    RuntimeRoot = [string]$firstInstall.RuntimeRoot
    Xml = $oldTaskXml
    XmlSha256 = $oldTaskXmlSha256
}
$selectedTaskXml = @"
<Task>
  <RegistrationInfo><Description>exact selected task</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Delay>PT11S</Delay></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>StopExisting</MultipleInstancesPolicy></Settings>
  <Actions Context="Author">
    <Exec>
      <Command>conhost.exe</Command>
      <Arguments>--headless pwsh.exe -InstallRoot "$([string]$secondInstall.RuntimeRoot)"</Arguments>
      <WorkingDirectory>$([string]$secondInstall.RuntimeRoot)</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
$selectedTaskXmlSha256 = Get-StringSha256 -Value $selectedTaskXml
$currentTaskDefinition = [pscustomobject]@{
    TaskName = 'Codex Local Remote'
    RuntimeVersionId = [string]$secondInstall.VersionId
    RuntimeRoot = [string]$secondInstall.RuntimeRoot
    XmlSha256 = $selectedTaskXmlSha256
}
$secondPointer = Set-CodexLocalRemoteCurrentRuntime `
    -DataDir $dataDir `
    -Runtime $secondInstall `
    -PreviousTaskPreImage $previousTaskPreImage `
    -CurrentTaskDefinition $currentTaskDefinition
$strictTaskPreImage = Get-CodexLocalRemoteRuntimeTaskPreImage `
    -DataDir $dataDir `
    -ExpectedTaskName 'Codex Local Remote' `
    -ExpectedRuntimeVersionId ([string]$firstInstall.VersionId) `
    -ExpectedRuntimeRoot ([string]$firstInstall.RuntimeRoot)
$pointerPath = Join-Path $dataDir 'runtime-current.json'
$pointerRecordRaw = Get-Content `
    -LiteralPath $pointerPath `
    -Raw `
    -Encoding utf8
$pointerRecord = $pointerRecordRaw |
    ConvertFrom-Json -Depth 20
$ordinaryPointerJson = $secondPointer | ConvertTo-Json -Depth 20 -Compress
$tamperedPointer = $pointerRecordRaw | ConvertFrom-Json -Depth 20
$tamperedPointer.PreviousTaskPreImage.Xml += '<!-- tampered -->'
$tamperedPointer |
    ConvertTo-Json -Depth 20 |
    Set-Content -LiteralPath $pointerPath -Encoding utf8NoBOM
$tamperedTaskPreImageRejected = $false
try {
    $null = Get-CodexLocalRemoteCurrentRuntime -DataDir $dataDir
} catch {
    $tamperedTaskPreImageRejected = $true
} finally {
    Set-Content `
        -LiteralPath $pointerPath `
        -Value $pointerRecordRaw `
        -Encoding utf8NoBOM `
        -NoNewline
}
$current = Get-CodexLocalRemoteCurrentRuntime -DataDir $dataDir
$rollbackPointer = Set-CodexLocalRemoteCurrentRuntime `
    -DataDir $dataDir `
    -Runtime $firstInstall
$repairedPointer = Sync-CodexLocalRemoteCurrentRuntime `
    -DataDir $dataDir `
    -InstallRoot $secondInstall.RuntimeRoot
$alreadyCurrentPointer = Sync-CodexLocalRemoteCurrentRuntime `
    -DataDir $dataDir `
    -InstallRoot $secondInstall.RuntimeRoot

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
    PointerHasTaskPreImage = [bool]$secondPointer.HasPreviousTaskPreImage
    PointerTaskPreImageSha256 = [string]$secondPointer.PreviousTaskPreImageSha256
    PointerTaskPreImageTaskName = [string]$secondPointer.PreviousTaskPreImageTaskName
    PointerTaskPreImageRuntimeVersionId = [string]$secondPointer.PreviousTaskPreImageRuntimeVersionId
    PointerTaskPreImageRuntimeRoot = [string]$secondPointer.PreviousTaskPreImageRuntimeRoot
    PointerHasCurrentTaskDefinition =
        [bool]$secondPointer.HasCurrentTaskDefinition
    PointerCurrentTaskDefinitionSha256 =
        [string]$secondPointer.CurrentTaskDefinitionSha256
    PointerCurrentTaskDefinitionTaskName =
        [string]$secondPointer.CurrentTaskDefinitionTaskName
    PointerCurrentTaskDefinitionRuntimeVersionId =
        [string]$secondPointer.CurrentTaskDefinitionRuntimeVersionId
    PointerCurrentTaskDefinitionRuntimeRoot =
        [string]$secondPointer.CurrentTaskDefinitionRuntimeRoot
    StoredCurrentTaskDefinitionExact = (
        [string]$pointerRecord.CurrentTaskDefinition.TaskName -ceq
            'Codex Local Remote' -and
        [string]$pointerRecord.CurrentTaskDefinition.RuntimeVersionId -ceq
            [string]$secondInstall.VersionId -and
        [string]$pointerRecord.CurrentTaskDefinition.RuntimeRoot -ceq
            [string]$secondInstall.RuntimeRoot -and
        [string]$pointerRecord.CurrentTaskDefinition.XmlSha256 -ceq
            $selectedTaskXmlSha256
    )
    StoredCurrentTaskDefinitionHasXml =
        $null -ne $pointerRecord.CurrentTaskDefinition.PSObject.Properties['Xml']
    OrdinaryPointerExposesTaskXml = $ordinaryPointerJson.Contains(
        'exact old task',
        [System.StringComparison]::Ordinal
    )
    StoredTaskPreImageExact = (
        [string]$pointerRecord.PreviousTaskPreImage.Xml -ceq $oldTaskXml -and
        [string]$pointerRecord.PreviousTaskPreImage.XmlSha256 -ceq
            $oldTaskXmlSha256
    )
    StrictTaskPreImageExact = (
        [string]$strictTaskPreImage.Xml -ceq $oldTaskXml -and
        [string]$strictTaskPreImage.XmlSha256 -ceq $oldTaskXmlSha256
    )
    TamperedTaskPreImageRejected = $tamperedTaskPreImageRejected
    RollbackCurrent = [string]$rollbackPointer.CurrentVersionId
    RollbackPrevious = [string]$rollbackPointer.PreviousVersionId
    RepairedStatus = [string]$repairedPointer.Status
    RepairedCurrent = [string]$repairedPointer.Current.CurrentVersionId
    RepairedPrevious = [string]$repairedPointer.Current.PreviousVersionId
    AlreadyCurrentStatus = [string]$alreadyCurrentPointer.Status
    StagingValid = [bool]$stagingValidation.IsValid
    StrictStagingValid = [bool]$strictStagingValidation.IsValid
    StrictStagingReason = [string]$strictStagingValidation.Reason
    TamperedValid = [bool]$tamperedValidation.IsValid
    TamperedReason = [string]$tamperedValidation.Reason
} | ConvertTo-Json -Compress -Depth 10
