[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$TargetScript,

    [int]$Port = 18790,

    [string]$BasePath = '/codex-remote',

    [switch]$WhatIf,

    [switch]$ConfirmFalse,

    [switch]$Json
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

function Invoke-WebRequest {
    return [pscustomobject]@{ StatusCode = 503 }
}

function Get-ScheduledTask {
    return [pscustomobject]@{ State = 'Running' }
}

function Get-NetTCPConnection {
    return [pscustomobject]@{
        LocalAddress = '127.0.0.1'
        OwningProcess = 0
    }
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
if ($Json) {
    $parameters.Json = $true
}

$result = & $TargetScript @parameters
if ($Json) {
    $result
} else {
    $result | ConvertTo-Json -Compress -Depth 20
}
