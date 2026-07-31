[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$StartPath,

    [Parameter(Mandatory)]
    [ValidateSet('late-suppression', 'active-worker', 'stale-worker')]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $StartPath,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    throw 'The startup script did not parse.'
}
$functionAst = $ast.FindAll(
    {
        param($node)
        $node -is
            [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -ceq
            'Update-CodexDesktopOwnerPackageRefreshState'
    },
    $true
) | Select-Object -First 1
if ($null -eq $functionAst) {
    throw 'The package refresh state helper was not found.'
}
Invoke-Expression ([string]$functionAst.Extent.Text)
Import-Module (
    Join-Path (Split-Path -Parent $StartPath) 'CodexLocalRemote.Windows.psm1'
) -Force

$rootKey = '42001|638899999999999999|' + ('a' * 64)
$state = [pscustomobject]@{
    LastAttemptedRootIdentityKey = $null
    PendingPackageRefreshRootIdentityKey = $rootKey
}
$suppressed = ''
$active = ''
if ($Mode -ceq 'late-suppression') {
    $suppressed = $rootKey
} elseif ($Mode -ceq 'active-worker') {
    $active = $rootKey
}
$updated = Update-CodexDesktopOwnerPackageRefreshState `
    -State $state `
    -CurrentRootIdentityKey $rootKey `
    -SuppressedRootIdentityKey $suppressed `
    -ActiveRefreshRootIdentityKey $active
$decision = Get-CodexDesktopOwnerDecision `
    -DesktopConnected $false `
    -StartupIntentPending $false `
    -HasPendingIntent $false `
    -RootIdentityKey $rootKey `
    -LastAttemptedRootIdentityKey (
        [string]$updated.LastAttemptedRootIdentityKey
    ) `
    -LastVerifiedConnectedRootIdentityKey '' `
    -LastDisconnectedRecoveryRootIdentityKey ''

[pscustomobject][ordered]@{
    LastAttemptedRootIdentityKey =
        [string]$updated.LastAttemptedRootIdentityKey
    PendingPackageRefreshRootIdentityKey =
        [string]$updated.PendingPackageRefreshRootIdentityKey
    Decision = [string]$decision
} | ConvertTo-Json -Depth 8
