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
    return [pscustomobject]@{ productName = 'Codex Local Remote' }
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

& $TargetScript @parameters
