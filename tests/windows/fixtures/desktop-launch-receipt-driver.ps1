[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LauncherPath
)

$ErrorActionPreference = 'Stop'
. $LauncherPath -DefinitionOnly

$script:capturedReceipt = $null

function Write-AtomicJsonFile {
    param(
        [string]$Path,
        [object]$Value
    )
    $null = $Path
    $script:capturedReceipt = $Value
}

$result = [pscustomobject]@{
    Status = 'PRIVATE_SENTINEL_STATUS'
    RemoteEnabled = 'PRIVATE_SENTINEL_ENABLED'
    RemoteDecision = 'PRIVATE_SENTINEL_DECISION'
    RemoteFallbackAttempts = 'PRIVATE_SENTINEL_FALLBACK'
    RemoteStopAttempts = -1
    DesktopProcessId = 'PRIVATE_SENTINEL_PROCESS'
    RemoteFailureStage = 'PRIVATE_SENTINEL_STAGE'
    RemoteFailureCode = 'PRIVATE_SENTINEL_CODE'
    CorrelationId = 'PRIVATE_SENTINEL_CORRELATION'
    FeedbackStatus = 'PRIVATE_SENTINEL_FEEDBACK'
    FeedbackFailureCode = 'PRIVATE_SENTINEL_FEEDBACK_CODE'
}

Write-CodexDesktopLaunchReceipt `
    -DataDir 'C:\unused-fixture' `
    -Result $result

$script:capturedReceipt |
    ConvertTo-Json -Depth 10 -Compress
