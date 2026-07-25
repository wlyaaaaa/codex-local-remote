[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$TargetScript,

    [int]$Port = 18790,

    [string]$BasePath = '/codex-remote',

    [switch]$WhatIf,

    [switch]$ConfirmFalse
)

function Invoke-RestMethod {
    param(
        [object]$Method,
        [string]$Uri,
        [int]$TimeoutSec
    )
    return [pscustomobject]@{
        productName = 'Codex Local Remote'
        configured = $true
        authenticated = $false
    }
}

function Get-ScheduledTask {
    return [pscustomobject]@{ State = 'Running' }
}

function Get-NetTCPConnection {
    return [pscustomobject]@{ LocalAddress = '127.0.0.1' }
}

$parameters = @{
    Port = $Port
    BasePath = $BasePath
}
if ($WhatIf) {
    $parameters.WhatIf = $true
}
if ($ConfirmFalse) {
    $parameters.Confirm = $false
}

$result = & $TargetScript @parameters
$result | ConvertTo-Json -Compress -Depth 20
