[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ModulePath,

    [Parameter(Mandatory)]
    [string]$PackageRoot,

    [Parameter(Mandatory)]
    [string]$LocalAppDataPath,

    [Parameter(Mandatory)]
    [ValidateSet(
        'valid',
        'missing-package',
        'multiple-packages',
        'unhealthy-package',
        'foreign-running-desktop'
    )]
    [string]$Mode,

    [switch]$StatusOnly
)

$ErrorActionPreference = 'Stop'
Import-Module $ModulePath -Force

$package = [pscustomobject]@{
    Name = 'OpenAI.Codex'
    PackageFamilyName = 'OpenAI.Codex_2p2nqsd0c76g0'
    PackageFullName = 'OpenAI.Codex_dynamic-fixture_x64__2p2nqsd0c76g0'
    Version = '999.1.2.3'
    Status = if ($Mode -ceq 'unhealthy-package') { 'Error' } else { 'Ok' }
    InstallLocation = $PackageRoot
}
$packages = switch ($Mode) {
    'missing-package' { @() }
    'multiple-packages' { @($package, $package.PSObject.Copy()) }
    default { @($package) }
}
$processes = if ($Mode -ceq 'foreign-running-desktop') {
    @(
        [pscustomobject]@{
            Name = 'ChatGPT.exe'
            ExecutablePath = 'C:\Program Files\WindowsApps\OpenAI.Codex_old_x64__2p2nqsd0c76g0\app\ChatGPT.exe'
        }
    )
} else {
    @()
}

if ($StatusOnly) {
    Resolve-CodexDesktopPackageStatusIdentity `
        -PackageCandidates $packages |
        ConvertTo-Json -Compress -Depth 10
} else {
    Resolve-CodexDesktopRuntime `
        -PackageCandidates $packages `
        -DesktopProcessCandidates $processes `
        -LocalAppDataPath $LocalAppDataPath |
        ConvertTo-Json -Compress -Depth 10
}
