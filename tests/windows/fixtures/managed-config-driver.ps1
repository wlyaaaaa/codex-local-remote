[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ModulePath,

    [Parameter(Mandatory)]
    [string]$DataDir,

    [ValidateSet('round-trip', 'duplicate-port')]
    [string]$Mode = 'round-trip'
)

$ErrorActionPreference = 'Stop'
Import-Module $ModulePath -Force

if ($Mode -ceq 'duplicate-port') {
    try {
        $null = Set-CodexLocalRemoteManagedConfiguration `
            -DataDir $DataDir `
            -SidecarPort 18790 `
            -BrokerPort 18791 `
            -BrokerUpstreamPort 18791 `
            -BasePath '/codex-remote' `
            -TaskName 'Codex Local Remote'
        throw 'duplicate ports were accepted'
    } catch {
        [pscustomobject]@{
            Rejected = $_.Exception.Message -match 'distinct'
        } | ConvertTo-Json -Compress
        exit 0
    }
}

$written = Set-CodexLocalRemoteManagedConfiguration `
    -DataDir $DataDir `
    -SidecarPort 18790 `
    -BrokerPort 18791 `
    -BrokerUpstreamPort 18795 `
    -BasePath '/codex-remote' `
    -TaskName 'Codex Local Remote'
$reopened = Get-CodexLocalRemoteManagedConfiguration -DataDir $DataDir

[pscustomobject]@{
    Written = $written
    Reopened = $reopened
} | ConvertTo-Json -Compress -Depth 10
