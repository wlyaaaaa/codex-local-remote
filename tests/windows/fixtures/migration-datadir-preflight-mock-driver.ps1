[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$TargetScript,

    [Parameter(Mandatory)]
    [string]$ModulePath,

    [Parameter(Mandatory)]
    [string]$InstallRoot,

    [Parameter(Mandatory)]
    [string]$RollbackRoot,

    [Parameter(Mandatory)]
    [string]$DataDir
)

$ErrorActionPreference = 'Stop'
$resolvedInstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$resolvedRollbackRoot = [System.IO.Path]::GetFullPath($RollbackRoot)
$resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
$moduleDestination = Join-Path `
    $resolvedInstallRoot `
    'scripts\windows\CodexLocalRemote.Windows.psm1'
$nodePath = Join-Path $resolvedInstallRoot 'mock-runtime\node.exe'
$codexPath = Join-Path $resolvedInstallRoot 'desktop\bin\codex.exe'
$desktopPath = Join-Path $resolvedInstallRoot 'desktop\ChatGPT.exe'
$runtimeCodexPath = Join-Path $resolvedInstallRoot 'mock-runtime\codex.exe'
$pwshPath = Join-Path $resolvedInstallRoot 'mock-runtime\pwsh.exe'
$tailscalePath = Join-Path $resolvedInstallRoot 'mock-runtime\tailscale.exe'

foreach ($directory in @(
    (Split-Path -Parent $moduleDestination),
    (Split-Path -Parent $nodePath),
    (Split-Path -Parent $codexPath),
    (Split-Path -Parent $desktopPath),
    $resolvedRollbackRoot
)) {
    $null = New-Item -ItemType Directory -Path $directory -Force
}
Copy-Item -LiteralPath $ModulePath -Destination $moduleDestination -Force
foreach ($path in @(
    $nodePath,
    $codexPath,
    $desktopPath,
    $runtimeCodexPath,
    $pwshPath,
    $tailscalePath
)) {
    [System.IO.File]::WriteAllText($path, 'mock executable')
}

$global:CodexRemoteForbiddenMigrationCalls =
    [System.Collections.Generic.List[string]]::new()
function Add-ForbiddenMigrationCall {
    param([Parameter(Mandatory)][string]$Name)
    $global:CodexRemoteForbiddenMigrationCalls.Add($Name)
    throw "forbidden migration command '$Name' was invoked"
}
function Get-ScheduledTask { Add-ForbiddenMigrationCall 'Get-ScheduledTask' }
function Export-ScheduledTask { Add-ForbiddenMigrationCall 'Export-ScheduledTask' }
function Start-ScheduledTask { Add-ForbiddenMigrationCall 'Start-ScheduledTask' }
function Stop-ScheduledTask { Add-ForbiddenMigrationCall 'Stop-ScheduledTask' }
function Register-ScheduledTask { Add-ForbiddenMigrationCall 'Register-ScheduledTask' }
function Unregister-ScheduledTask { Add-ForbiddenMigrationCall 'Unregister-ScheduledTask' }
function Get-CimInstance { Add-ForbiddenMigrationCall 'Get-CimInstance' }
function Get-NetTCPConnection { Add-ForbiddenMigrationCall 'Get-NetTCPConnection' }
function Get-Process { Add-ForbiddenMigrationCall 'Get-Process' }
function Start-Process { Add-ForbiddenMigrationCall 'Start-Process' }
function Stop-Process { Add-ForbiddenMigrationCall 'Stop-Process' }

$tokenPath = Join-Path $resolvedDataDir 'foreign.token'
$tokenHandle = [System.IO.File]::Open(
    $tokenPath,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::None
)
$errorText = $null
$unexpectedSuccess = $false
$capturedOutput = @()
try {
    try {
        $env:CODEX_REMOTE_TEST_FIXTURE = '1'
        $capturedOutput = @(
            & $TargetScript `
                -InstallRoot $resolvedInstallRoot `
                -RollbackRoot $resolvedRollbackRoot `
                -DataDir $resolvedDataDir `
                -NodePath $nodePath `
                -CodexPath $codexPath `
                -RuntimeCodexPath $runtimeCodexPath `
                -PwshPath $pwshPath `
                -TailscalePath $tailscalePath `
                -PreflightOnly
        )
        $unexpectedSuccess = $true
    } catch {
        $errorText = $_.Exception.Message
    }
} finally {
    Remove-Item Env:\CODEX_REMOTE_TEST_FIXTURE -ErrorAction SilentlyContinue
    $tokenHandle.Dispose()
}

$renderedOutput = ($capturedOutput -join [Environment]::NewLine)
[pscustomobject]@{
    UnexpectedSuccess = $unexpectedSuccess
    Error = $errorText
    ForbiddenCalls = @($global:CodexRemoteForbiddenMigrationCalls)
    OutputContainsTokenSentinel = $renderedOutput.Contains(
        'TOKEN_SENTINEL_MUST_NOT_BE_READ'
    ) -or [string]$errorText -like '*TOKEN_SENTINEL_MUST_NOT_BE_READ*'
} | ConvertTo-Json -Compress -Depth 20
