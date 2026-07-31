[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LauncherPath,

    [Parameter(Mandatory)]
    [ValidateSet(
        'desktop-running-native',
        'handoff-failed-unresolved',
        'native-start-failed',
        'cim-fails-before-native-start'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
. $LauncherPath -DefinitionOnly

$productionNativeFailOpen =
    ${function:Invoke-CodexRequesterNativeFailOpen}
$productionRootPresent = ${function:Test-CodexDesktopRootPresent}
$fixtureRoot = Join-Path `
    ([System.IO.Path]::GetTempPath()) `
    "codex-shortcut-diagnostic-$([Guid]::NewGuid().ToString('N'))"
$null = New-Item -ItemType Directory -Path $fixtureRoot -Force
$script:nativeLaunchCalls = 0
$script:desktopStartCalls = 0
$script:strictDesktopReads = 0

function Get-CodexDesktopHandoffProcesses {
    $script:strictDesktopReads += 1
    if ($Mode -ceq 'cim-fails-before-native-start' -and
        $script:strictDesktopReads -gt 1) {
        throw 'CIM enumeration failed before native start.'
    }
    return @()
}

function Test-CodexDesktopRootPresent {
    if ($Mode -ceq 'cim-fails-before-native-start') {
        return & $productionRootPresent
    }
    return $Mode -ceq 'handoff-failed-unresolved'
}

function Invoke-CodexRequesterNativeFailOpen {
    $script:nativeLaunchCalls += 1
    if ($Mode -ceq 'cim-fails-before-native-start') {
        return & $productionNativeFailOpen
    }
    if ($Mode -ceq 'native-start-failed') {
        throw 'Native Desktop could not be started.'
    }
    return [pscustomobject][ordered]@{
        Status = 'launched-native'
        RemoteEnabled = $false
        RemoteDecision = 'remote-not-ready'
        RemoteFallbackAttempts = 0
        RemoteStopAttempts = 0
        DesktopProcessId = 42002
        RemoteFailureStage = 'unexpected'
        RemoteFailureCode = 'unexpected'
        CorrelationId = '0123456789abcdef0123456789abcdef'
        FeedbackStatus = 'pending'
        FeedbackFailureCode = $null
    }
}

function Start-CodexDesktopProcess {
    $script:desktopStartCalls += 1
    throw 'The fixture must not start Desktop in the CIM failure mode.'
}

$requestFailure = $null
try {
    $requestCode = if ($Mode -ceq 'desktop-running-native' -or
        $Mode -ceq 'native-start-failed' -or
        $Mode -ceq 'cim-fails-before-native-start') {
        'desktop-running'
    } else {
        'runtime-handoff-failed'
    }
    throw (New-CodexRemoteFailureException `
        -Stage 'runtime-handoff' `
        -Code $requestCode)
} catch {
    $requestFailure = $_
}

try {
    $result = Invoke-CodexRequesterFailOpenAfterOwnerFailure `
        -ManagedDataDir $fixtureRoot `
        -RequestFailure $requestFailure `
        -MutexTimeoutSeconds 1
    [pscustomobject][ordered]@{
        Result = $result
        NativeLaunchCalls = $script:nativeLaunchCalls
        DesktopStartCalls = $script:desktopStartCalls
    } | ConvertTo-Json -Depth 6 -Compress
} finally {
    Remove-Item `
        -LiteralPath $fixtureRoot `
        -Recurse `
        -Force `
        -ErrorAction SilentlyContinue
}
