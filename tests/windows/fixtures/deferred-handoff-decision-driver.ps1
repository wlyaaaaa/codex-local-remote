[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptPath,

    [Parameter(Mandatory)]
    [ValidateSet(0, 1)]
    [int]$BrokerReachable,

    [Parameter(Mandatory)]
    [ValidateSet(0, 1)]
    [int]$DesktopConnected,

    [Parameter(Mandatory)]
    [ValidateRange(0, 2147483647)]
    [int]$DesktopProcessCount,

    [Parameter(Mandatory)]
    [ValidateSet(0, 1)]
    [int]$SidecarConnected,

    [Parameter(Mandatory)]
    [int]$UnsafeThreadCount
)

$ErrorActionPreference = 'Stop'
. $ScriptPath -DefinitionOnly

[pscustomobject]@{
    Decision = Get-CodexLocalRemoteDeferredHandoffDecision `
        -BrokerReachable ([bool]$BrokerReachable) `
        -DesktopConnected ([bool]$DesktopConnected) `
        -DesktopProcessCount $DesktopProcessCount `
        -SidecarConnected ([bool]$SidecarConnected) `
        -UnsafeThreadCount $UnsafeThreadCount
} | ConvertTo-Json -Compress
