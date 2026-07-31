[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ModulePath,

    [Parameter(Mandatory)]
    [string]$SourcePath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot
)

$ErrorActionPreference = 'Stop'
Import-Module $ModulePath -Force
$dataDir = Join-Path $SandboxRoot 'managed-data'

$created = Install-CodexLocalRemoteControlDispatcher `
    -SourcePath $SourcePath `
    -DataDir $dataDir
$reused = Install-CodexLocalRemoteControlDispatcher `
    -SourcePath $SourcePath `
    -DataDir $dataDir
$targetPath =
    Get-CodexLocalRemoteControlDispatcherPath -DataDir $dataDir
[System.IO.File]::WriteAllText(
    $targetPath,
    "# foreign`n",
    [System.Text.UTF8Encoding]::new($false)
)
$foreignBlocked = $false
try {
    $null = Install-CodexLocalRemoteControlDispatcher `
        -SourcePath $SourcePath `
        -DataDir $dataDir
} catch {
    $foreignBlocked = $true
}

$markerOnlyDataDir = Join-Path $SandboxRoot 'marker-only-data'
$markerOnlyPath =
    Get-CodexLocalRemoteControlDispatcherPath `
        -DataDir $markerOnlyDataDir
$null = [System.IO.Directory]::CreateDirectory(
    (Split-Path -Parent $markerOnlyPath)
)
[System.IO.File]::Copy($SourcePath, $markerOnlyPath, $false)
$markerOnlyBlocked = $false
try {
    $null = Install-CodexLocalRemoteControlDispatcher `
        -SourcePath $SourcePath `
        -DataDir $markerOnlyDataDir
} catch {
    $markerOnlyBlocked = $true
}

$removalDataDir = Join-Path $SandboxRoot 'removal-data'
$null = Install-CodexLocalRemoteControlDispatcher `
    -SourcePath $SourcePath `
    -DataDir $removalDataDir
$removed = Remove-CodexLocalRemoteControlDispatcher `
    -DataDir $removalDataDir
$removedAgain = Remove-CodexLocalRemoteControlDispatcher `
    -DataDir $removalDataDir

[pscustomobject]@{
    Created = [string]$created.Status
    Reused = [string]$reused.Status
    Path = [string]$created.Path
    ForeignBlocked = $foreignBlocked
    MarkerOnlyBlocked = $markerOnlyBlocked
    Removed = [string]$removed.Status
    RemovedAgain = [string]$removedAgain.Status
} | ConvertTo-Json -Compress
