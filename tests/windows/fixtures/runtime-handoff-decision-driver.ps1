[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LauncherPath,

    [Parameter(Mandatory)]
    [string]$TaskState,

    [Parameter(Mandatory)]
    [string]$GenerationStatus,

    [int]$DesktopProcessCount = 0
)

$ErrorActionPreference = 'Stop'
. $LauncherPath -DefinitionOnly

[pscustomobject]@{
    Decision = Get-CodexLocalRemoteRuntimeHandoffDecision `
        -TaskState $TaskState `
        -GenerationStatus $GenerationStatus `
        -DesktopProcessCount $DesktopProcessCount
} | ConvertTo-Json -Compress
