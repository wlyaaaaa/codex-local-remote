[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LauncherPath
)

$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $LauncherPath),
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    throw 'The launcher did not parse.'
}
$functionAst = @(
    $ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        [string]$node.Name -ceq
            'Get-CodexLocalRemoteReceiptProcessLiveness'
    }, $true)
)
if ($functionAst.Count -ne 1) {
    throw 'The receipt process liveness helper was not found exactly once.'
}
Invoke-Expression ([string]$functionAst[0].Extent.Text)

function Test-NonNegativeInteger {
    param([Parameter(Mandatory)][object]$Value)

    if ($Value -isnot [byte] -and
        $Value -isnot [uint16] -and
        $Value -isnot [uint32] -and
        $Value -isnot [uint64] -and
        $Value -isnot [sbyte] -and
        $Value -isnot [int16] -and
        $Value -isnot [int32] -and
        $Value -isnot [int64]) {
        return $false
    }
    return [decimal]$Value -ge 0
}

function New-Identity {
    param([int]$ProcessId)

    return [pscustomobject]@{
        ProcessId = $ProcessId
        ProcessStartTimeUtcTicks = 638000000000000000 + $ProcessId
    }
}

$receipt = [pscustomobject]@{
    Bootstrap = New-Identity -ProcessId 11
    Broker = New-Identity -ProcessId 12
    Sidecar = $null
    Upstream = New-Identity -ProcessId 13
}
$allAbsent = {
    param([object]$Identity)
    return 'absent'
}
$brokerLive = {
    param([object]$Identity)
    return $(if ([int]$Identity.ProcessId -eq 12) { 'live' } else { 'absent' })
}
$unknown = {
    param([object]$Identity)
    return $(if ([int]$Identity.ProcessId -eq 13) { 'unknown' } else { 'absent' })
}
$missingMandatory = [pscustomobject]@{
    Bootstrap = $receipt.Bootstrap
    Broker = $null
    Sidecar = $null
    Upstream = $receipt.Upstream
}

[pscustomobject]@{
    AllAbsent = Get-CodexLocalRemoteReceiptProcessLiveness `
        -Receipt $receipt `
        -GetProcessIdentityStateAction $allAbsent
    BrokerLive = Get-CodexLocalRemoteReceiptProcessLiveness `
        -Receipt $receipt `
        -GetProcessIdentityStateAction $brokerLive
    OneUnknown = Get-CodexLocalRemoteReceiptProcessLiveness `
        -Receipt $receipt `
        -GetProcessIdentityStateAction $unknown
    MissingMandatory = Get-CodexLocalRemoteReceiptProcessLiveness `
        -Receipt $missingMandatory `
        -GetProcessIdentityStateAction $allAbsent
} | ConvertTo-Json -Compress
