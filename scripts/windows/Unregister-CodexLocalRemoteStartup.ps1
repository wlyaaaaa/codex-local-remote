[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$InstallRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,

    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexLocalRemote'),

    [ValidateRange(1, 65535)]
    [int]$Port = 18790,

    [string]$BasePath = '/codex-remote',

    [string]$TaskName = 'Codex Local Remote',

    [string]$NodePath
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

$existing = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
if ($null -eq $existing) {
    [pscustomobject]@{ Status = 'not-found'; TaskName = $TaskName }
    return
}

$ownership = Test-ManagedStartupTask -Task $existing -Expected $expected
if (-not $ownership.IsManaged) {
    throw "Scheduled task '$TaskName' is not the exact managed task ($($ownership.Mismatches -join ', ')); refusing to stop or remove it."
}

if ($PSCmdlet.ShouldProcess($TaskName, 'Stop and remove the startup task')) {
    # Re-check immediately before the first mutation so a same-name replacement
    # cannot be stopped or deleted based on stale ownership evidence.
    $current = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
    if ($null -eq $current) {
        [pscustomobject]@{ Status = 'not-found'; TaskName = $TaskName }
        return
    }
    $currentOwnership = Test-ManagedStartupTask -Task $current -Expected $expected
    if (-not $currentOwnership.IsManaged) {
        throw "Scheduled task '$TaskName' changed before removal and is not the exact managed task; refusing to stop or remove it."
    }

    Stop-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false
    [pscustomobject]@{ Status = 'removed'; TaskName = $TaskName }
} else {
    [pscustomobject]@{ Status = 'what-if'; TaskName = $TaskName }
}
