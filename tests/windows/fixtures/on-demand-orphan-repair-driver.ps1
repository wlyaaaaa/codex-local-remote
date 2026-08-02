[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptPath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot,

    [Parameter(Mandatory)]
    [ValidateSet(
        'live-without-authorization',
        'live-with-authorization',
        'dead-legacy-conhost'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $ScriptPath,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    throw 'The on-demand handoff script did not parse.'
}
$functionAst = $ast.FindAll(
    {
        param($node)
        $node -is
            [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -ceq 'Repair-OnDemandRecordedOrphanedUpstream'
    },
    $true
) | Select-Object -First 1
if ($null -eq $functionAst) {
    throw 'The recorded orphan repair helper was not found.'
}
Invoke-Expression ([string]$functionAst.Extent.Text)

$resolvedDataDir = Join-Path $SandboxRoot 'Data'
$selectedRuntimeRoot = Join-Path $SandboxRoot 'SelectedRuntime'
$retiredVersionId = 'a' * 64
$retiredRuntimeRoot = Join-Path `
    (Join-Path $resolvedDataDir 'RuntimeVersions') `
    $retiredVersionId
$brokerCliPath = Join-Path $retiredRuntimeRoot 'apps\broker\dist\cli.js'
$stopScriptPath = Join-Path `
    $selectedRuntimeRoot `
    'scripts\windows\Stop-CodexAppServerBroker.ps1'
$stopCallPath = Join-Path $SandboxRoot 'stop-call.json'

New-Item `
    -ItemType Directory `
    -Path (Split-Path -Parent $brokerCliPath) `
    -Force | Out-Null
New-Item `
    -ItemType Directory `
    -Path (Split-Path -Parent $stopScriptPath) `
    -Force | Out-Null
New-Item -ItemType File -Path $brokerCliPath -Force | Out-Null

$stopScript = @'
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$CodexPath,
    [string]$NodePath,
    [string]$InstallRoot,
    [string]$DataDir,
    [int]$BrokerPort,
    [int]$BrokerUpstreamPort,
    [switch]$AllowActiveTurns
)

[pscustomobject]@{
    AllowActiveTurns = [bool]$AllowActiveTurns
    InstallRoot = $InstallRoot
} | ConvertTo-Json -Compress |
    Set-Content -LiteralPath $env:CODEX_REMOTE_TEST_STOP_CALL_PATH -Encoding utf8
[pscustomobject]@{ Status = 'completed' }
'@
Set-Content `
    -LiteralPath $stopScriptPath `
    -Value $stopScript `
    -Encoding utf8

$state = [pscustomobject]@{
    Signature = 'codex-local-remote/app-server-broker/v3'
    BrokerCliPath = $brokerCliPath
    CodexPath = 'C:\fixture\codex.exe'
    NodePath = 'C:\fixture\node.exe'
    Upstream = [pscustomobject]@{
        ProcessId = 4200
    }
}
$state |
    ConvertTo-Json -Depth 10 |
    Set-Content `
        -LiteralPath (Join-Path $resolvedDataDir 'app-server-broker.json') `
        -Encoding utf8

$script:PortWaitCalls = 0

function Get-OnDemandManagedPortListeners {
    param([int[]]$Ports)
    $null = $Ports
    return @(
        [pscustomobject]@{
            LocalAddress = '127.0.0.1'
            LocalPort = 18795
            OwningProcess = 4200
        }
    )
}

function Test-NonNegativeInteger {
    param([object]$Value)
    $parsed = [long]0
    return [long]::TryParse(
        [string]$Value,
        [ref]$parsed
    ) -and $parsed -ge 0
}

function Get-CimInstance {
    param(
        [string]$ClassName,
        [string]$Filter,
        [object]$ErrorAction
    )
    $null = $ClassName
    $null = $Filter
    $null = $ErrorAction
    if ($Mode -cne 'dead-legacy-conhost') {
        return [pscustomobject]@{ ProcessId = 4200 }
    }
    return @()
}

function Get-OnDemandCachedRuntimeValidation {
    param(
        [string]$RuntimeRoot,
        [string]$ExpectedVersionId
    )
    $null = $RuntimeRoot
    $null = $ExpectedVersionId
    return [pscustomobject]@{ IsValid = $true }
}

function Wait-OnDemandManagedPortsReleased {
    param([int[]]$Ports)
    $null = $Ports
    $script:PortWaitCalls++
}

$runtime = [pscustomobject]@{
    CurrentRoot = $selectedRuntimeRoot
}
$configuration = [pscustomobject]@{
    SidecarPort = 18790
    BrokerPort = 18791
    BrokerUpstreamPort = 18795
}
$startupTask = [pscustomobject]@{ State = 'Ready' }
$allowActiveTurns = $Mode -ceq 'live-with-authorization'
$succeeded = $false
$errorText = $null
$result = $null
$priorStopCallPath = $env:CODEX_REMOTE_TEST_STOP_CALL_PATH
$env:CODEX_REMOTE_TEST_STOP_CALL_PATH = $stopCallPath
try {
    try {
        $result = Repair-OnDemandRecordedOrphanedUpstream `
            -Runtime $runtime `
            -Configuration $configuration `
            -StartupTask $startupTask `
            -AllowActiveTurns:$allowActiveTurns
        $succeeded = $true
    } catch {
        $errorText = $_.Exception.Message
    }
} finally {
    $env:CODEX_REMOTE_TEST_STOP_CALL_PATH = $priorStopCallPath
}

$stopCall = if (Test-Path -LiteralPath $stopCallPath -PathType Leaf) {
    Get-Content -LiteralPath $stopCallPath -Raw -Encoding utf8 |
        ConvertFrom-Json -Depth 10 -DateKind String
} else {
    $null
}

[pscustomobject]@{
    Succeeded = $succeeded
    Error = $errorText
    Result = $result
    StopCalls = if ($null -eq $stopCall) { 0 } else { 1 }
    StopAllowActiveTurns = if ($null -eq $stopCall) {
        $null
    } else {
        [bool]$stopCall.AllowActiveTurns
    }
    StopInstallRoot = if ($null -eq $stopCall) {
        $null
    } else {
        [string]$stopCall.InstallRoot
    }
    ExpectedRetiredRuntimeRoot = $retiredRuntimeRoot
    PortWaitCalls = $script:PortWaitCalls
} | ConvertTo-Json -Compress
