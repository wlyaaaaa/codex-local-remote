[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LauncherPath,

    [Parameter(Mandatory)]
    [ValidateSet(
        'updated-zero-desktop',
        'updated-existing-desktop',
        'current-package-resolution-failed',
        'updated-unsafe-turn',
        'updated-fresh-vendor-root'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
. $LauncherPath -DefinitionOnly

$script:restartCalls = 0
$script:workerCalls = 0
$script:activeStatus = if (
    $Mode -ceq 'current-package-resolution-failed'
) {
    'unverified'
} else {
    'drifted'
}
$currentRuntime = [pscustomobject]@{
    Signature = 'codex-local-remote/codex-desktop-runtime/v1'
    Version = 1
    PackageFullName = 'OpenAI.Codex_new_x64__2p2nqsd0c76g0'
    DesktopExecutablePath = 'C:\Program Files\WindowsApps\new\app\ChatGPT.exe'
    DesktopExecutableSha256 = 'A' * 64
    BundledCodexPath = 'C:\Program Files\WindowsApps\new\app\resources\codex.exe'
    BundledCodexSha256 = 'B' * 64
    CodexPath = 'C:\Users\fixture\AppData\Local\OpenAI\Codex\bin\new\codex.exe'
    CodexSha256 = 'B' * 64
}

$result = $null
$errorCode = $null
try {
    $result = Invoke-CodexLocalRemoteCodexRuntimeGate `
        -DesktopProcessCount $(if (
            $Mode -cin @(
                'updated-existing-desktop',
                'updated-fresh-vendor-root'
            )
        ) { 1 } else { 0 }) `
        -ResolveCurrentRuntimeAction {
            if ($Mode -ceq 'current-package-resolution-failed') {
                throw 'fixture package parse failure'
            }
            return $currentRuntime
        } `
        -GetActiveRuntimeStatusAction {
            param([object]$ExpectedRuntime)
            return [pscustomobject]@{
                Status = $script:activeStatus
                CurrentRuntime = $ExpectedRuntime
            }
        } `
        -GetRestartSafetyStatusAction {
            return $Mode -cne 'updated-unsafe-turn'
        } `
        -DelegateFreshTakeoverAction $(if (
            $Mode -ceq 'updated-fresh-vendor-root'
        ) {
            {
                param([object]$ExpectedRuntime)
                $null = $ExpectedRuntime
                $script:workerCalls += 1
                return $true
            }
        } else {
            $null
        }) `
        -RestartRuntimeAction {
            param([object]$ExpectedRuntime)
            $script:restartCalls += 1
            $script:activeStatus = 'current'
            return $ExpectedRuntime
        }
} catch {
    $errorCode = [string]$_.Exception.Data['CodexRemoteFailureCode']
}

[pscustomobject][ordered]@{
    Succeeded = $null -eq $errorCode
    RestartCalls = $script:restartCalls
    WorkerCalls = $script:workerCalls
    FinalStatus = $script:activeStatus
    ErrorCode = $errorCode
    PackageFullName = if ($null -eq $result) {
        $null
    } else {
        [string]$result.PackageFullName
    }
} | ConvertTo-Json -Depth 8
