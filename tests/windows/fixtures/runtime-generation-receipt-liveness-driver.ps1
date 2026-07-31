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
$incompleteBrokerReady = [pscustomobject]@{
    Status = 'broker-ready'
    RuntimeInvocationId = '0123456789abcdef0123456789abcdef'
    ProcessId = 12
    Bootstrap = [pscustomobject]@{
        RuntimeInvocationId = '0123456789abcdef0123456789abcdef'
        ProcessId = 11
        ProcessStartTimeUtcTicks = 638000000000000011
    }
    Broker = [pscustomobject]@{
        RuntimeInvocationId = '0123456789abcdef0123456789abcdef'
        ProcessId = 12
        ProcessStartTimeUtcTicks = 638000000000000012
    }
    Sidecar = $null
    Upstream = $null
}
$noListeners = {
    param([int]$Port)
    $null = $Port
    return 0
}
$oneManagedListener = {
    param([int]$Port)
    return $(if ($Port -eq 18791) { 1 } else { 0 })
}
$noListenerNotFound = {
    param([int]$Port)
    $errorRecord = [System.Management.Automation.ErrorRecord]::new(
        [System.Management.Automation.ItemNotFoundException]::new(
            "No matching listener exists on port $Port."
        ),
        'CmdletizationQuery_NotFound,Get-NetTCPConnection',
        [System.Management.Automation.ErrorCategory]::ObjectNotFound,
        $Port
    )
    Write-Error -ErrorRecord $errorRecord -ErrorAction Stop
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
    IncompleteBrokerReadyAbsent =
        Get-CodexLocalRemoteReceiptProcessLiveness `
            -Receipt $incompleteBrokerReady `
            -GetProcessIdentityStateAction $allAbsent `
            -AllowIncompleteBrokerReadyReceipt `
            -ManagedPorts @(18790, 18791, 18795) `
            -GetListenerCountAction $noListeners
    IncompleteBrokerReadyListener =
        Get-CodexLocalRemoteReceiptProcessLiveness `
            -Receipt $incompleteBrokerReady `
            -GetProcessIdentityStateAction $allAbsent `
            -AllowIncompleteBrokerReadyReceipt `
            -ManagedPorts @(18790, 18791, 18795) `
            -GetListenerCountAction $oneManagedListener
    IncompleteBrokerReadyNotFound =
        Get-CodexLocalRemoteReceiptProcessLiveness `
            -Receipt $incompleteBrokerReady `
            -GetProcessIdentityStateAction $allAbsent `
            -AllowIncompleteBrokerReadyReceipt `
            -ManagedPorts @(18790, 18791, 18795) `
            -GetListenerCountAction $noListenerNotFound
    IncompleteBrokerReadyLive =
        Get-CodexLocalRemoteReceiptProcessLiveness `
            -Receipt $incompleteBrokerReady `
            -GetProcessIdentityStateAction $brokerLive `
            -AllowIncompleteBrokerReadyReceipt `
            -ManagedPorts @(18790, 18791, 18795) `
            -GetListenerCountAction $noListeners
} | ConvertTo-Json -Compress
