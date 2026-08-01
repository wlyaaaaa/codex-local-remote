[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$RegistrationPath
)

$ErrorActionPreference = 'Stop'
$BrokerPort = 18791
$script:ObservedListenerCount = -1
$env:CODEX_REMOTE_TEST_FIXTURE = '0'

function Get-CodexLocalRemoteTcpListenerSnapshot {
    param([int[]]$LocalPorts)
    return @()
}

function Test-IsLoopbackListenerAddress {
    param([string]$Address)
    return $true
}

function Get-ManagedIpv4Listeners {
    param(
        [AllowEmptyCollection()]
        [Parameter(Mandatory)]
        [object[]]$Listeners
    )

    $script:ObservedListenerCount = $Listeners.Count
    return @()
}

$tokens = $null
$parseErrors = $null
$registrationAst = [Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $RegistrationPath),
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) {
    throw 'fixture could not parse registration script'
}
$functionAst = @(
    $registrationAst.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        [string]$node.Name -ceq 'Get-RegistrationActiveRuntimeEvidence'
    }, $true)
)
if ($functionAst.Count -ne 1) {
    throw "fixture expected exactly one 'Get-RegistrationActiveRuntimeEvidence' function"
}
Invoke-Expression ([string]$functionAst[0].Extent.Text)

$result = Get-RegistrationActiveRuntimeEvidence
[pscustomobject]@{
    ResultIsNull = $null -eq $result
    ObservedListenerCount = $script:ObservedListenerCount
} | ConvertTo-Json -Compress
