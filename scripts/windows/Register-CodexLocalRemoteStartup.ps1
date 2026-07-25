[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$InstallRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,

    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexLocalRemote'),

    [ValidateRange(1, 65535)]
    [int]$Port = 18790,

    [string]$BasePath = '/codex-remote',

    [string]$TaskName = 'Codex Local Remote',

    [string]$NodePath,

    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'CodexLocalRemote.Windows.psm1') -Force
Assert-CanonicalBasePath -BasePath $BasePath

if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $NodePath = (Get-Command node -CommandType Application -ErrorAction Stop).Source
}

$expected = Get-StartupTaskDefinition `
    -TaskName $TaskName `
    -NodePath $NodePath `
    -InstallRoot $InstallRoot `
    -DataDir $DataDir `
    -Port $Port `
    -BasePath $BasePath

if (-not (Test-Path -LiteralPath $expected.Execute -PathType Leaf)) {
    throw "Node executable not found at '$($expected.Execute)'."
}
if (-not (Test-Path -LiteralPath $expected.Cli -PathType Leaf)) {
    throw "Built sidecar not found at '$($expected.Cli)'. Run pnpm build first."
}

$existing = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    $ownership = Test-ManagedStartupTask -Task $existing -Expected $expected
    if (-not $ownership.IsManaged) {
        throw "Scheduled task '$TaskName' exists but is not the exact managed task ($($ownership.Mismatches -join ', ')); refusing to overwrite it."
    }
}

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction `
    -Execute $expected.Execute `
    -Argument $expected.Arguments `
    -WorkingDirectory $expected.WorkingDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

$applied = $false
if ($PSCmdlet.ShouldProcess($TaskName, "Register current-user startup task for $currentUser")) {
    # Re-check immediately before -Force to avoid overwriting a task that changed
    # after the initial ownership check.
    $current = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
    if ($null -ne $current) {
        $currentOwnership = Test-ManagedStartupTask -Task $current -Expected $expected
        if (-not $currentOwnership.IsManaged) {
            throw "Scheduled task '$TaskName' changed before registration and is not the exact managed task; refusing to overwrite it."
        }
    }

    $null = New-Item -ItemType Directory -Force -Path $expected.DataDir
    Register-ScheduledTask `
        -TaskName $TaskName `
        -TaskPath '\' `
        -Action $action `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $settings `
        -Description $expected.Description `
        -Force | Out-Null
    $applied = $true

    if (-not $NoStart) {
        Start-ScheduledTask -TaskName $TaskName -TaskPath '\'
    }
}

[pscustomobject]@{
    Status = if ($applied) { 'registered' } else { 'what-if' }
    TaskName = $TaskName
    User = $currentUser
    LocalUrl = Join-BasePathUrl -Origin "http://127.0.0.1:$Port" -BasePath $BasePath
    DataDir = $expected.DataDir
}
