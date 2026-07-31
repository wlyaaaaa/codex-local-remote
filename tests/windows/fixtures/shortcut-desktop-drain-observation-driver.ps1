[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LauncherPath,

    [Parameter(Mandatory)]
    [ValidateSet(
        'drains-consecutively',
        'empty-observation-resets',
        'cim-fails'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
. $LauncherPath -DefinitionOnly

$script:processChecks = 0
$script:readinessChecks = 0

function Get-CodexDesktopHandoffProcesses {
    $script:processChecks += 1
    if ($Mode -ceq 'cim-fails') {
        throw 'CIM enumeration failed.'
    }
    if ($Mode -ceq 'drains-consecutively') {
        if ($script:processChecks -eq 1) {
            return [pscustomobject]@{ Id = 42001 }
        }
        return
    }
    if ($script:processChecks -eq 2) {
        return [pscustomobject]@{ Id = 42001 }
    }
}

function Get-CodexLocalRemoteReadinessSnapshot {
    param([int]$Port)
    $null = $Port
    $script:readinessChecks += 1
    return [pscustomobject]@{
        desktopConnected = $false
    }
}

$drained = Wait-CodexDesktopOwnerHandoffDrain `
    -ManagedBrokerPort 18791 `
    -TimeoutSeconds 1 `
    -PollMilliseconds 1 `
    -RequiredEmptyObservations 2

[pscustomobject][ordered]@{
    Drained = $drained
    ProcessChecks = $script:processChecks
    ReadinessChecks = $script:readinessChecks
} | ConvertTo-Json -Compress
