[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexLocalRemote'),

    [string]$TaskName = 'Codex Local Remote',

    [string]$NodePath,

    [string]$PwshPath,

    [ValidateRange(1, 65535)]
    [int]$Port = 18790,

    [ValidateRange(1, 65535)]
    [int]$BrokerPort = 18791,

    [ValidateRange(1, 65535)]
    [int]$BrokerUpstreamPort = 18792,

    [string]$BasePath = '/codex-remote'
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'CodexLocalRemote.Windows.psm1') -Force

$current = Get-CodexLocalRemoteCurrentRuntime -DataDir $DataDir
if ($null -eq $current) {
    throw 'No managed immutable runtime is active.'
}
if ([string]::IsNullOrWhiteSpace([string]$current.PreviousVersionId) -or
    [string]::IsNullOrWhiteSpace([string]$current.PreviousRoot)) {
    throw 'No previous immutable runtime is available for rollback.'
}
$previousValidation = Test-CodexLocalRemoteRuntimeVersion `
    -RuntimeRoot ([string]$current.PreviousRoot) `
    -ExpectedVersionId ([string]$current.PreviousVersionId)
if (-not $previousValidation.IsValid -or
    [string]$previousValidation.ManifestSha256 -cne
    [string]$current.PreviousManifestSha256) {
    throw "Previous runtime failed exact verification: $($previousValidation.Reason)."
}

$registerScript = Join-Path $current.PreviousRoot 'scripts\windows\Register-CodexLocalRemoteStartup.ps1'
if (-not (Test-Path -LiteralPath $registerScript -PathType Leaf)) {
    throw "Previous runtime registration script '$registerScript' is missing."
}
if ($PSCmdlet.ShouldProcess(
    [string]$current.PreviousVersionId,
    'Make the previous immutable runtime the next startup version'
)) {
    $arguments = @{
        InstallRoot = [string]$current.PreviousRoot
        DataDir = [System.IO.Path]::GetFullPath($DataDir)
        TaskName = $TaskName
        Port = $Port
        BrokerPort = $BrokerPort
        BrokerUpstreamPort = $BrokerUpstreamPort
        BasePath = $BasePath
        NoStart = $true
        Confirm = $false
    }
    if (-not [string]::IsNullOrWhiteSpace($NodePath)) {
        $arguments.NodePath = $NodePath
    }
    if (-not [string]::IsNullOrWhiteSpace($PwshPath)) {
        $arguments.PwshPath = $PwshPath
    }
    $registration = & $registerScript @arguments
    $readBack = Get-CodexLocalRemoteCurrentRuntime -DataDir $DataDir
    if ($null -eq $readBack -or
        [string]$readBack.CurrentVersionId -cne [string]$current.PreviousVersionId -or
        [string]$readBack.PreviousVersionId -cne [string]$current.CurrentVersionId) {
        throw 'Rollback pointer failed exact read-back verification.'
    }
    [pscustomobject]@{
        Status = 'rolled-back-for-next-start'
        CurrentVersionId = [string]$readBack.CurrentVersionId
        CurrentRoot = [string]$readBack.CurrentRoot
        PreviousVersionId = [string]$readBack.PreviousVersionId
        RegistrationStatus = [string]$registration.Status
        RunningInstanceChanged = $false
    }
}
