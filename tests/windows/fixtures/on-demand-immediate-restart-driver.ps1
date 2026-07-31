[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptPath,

    [Parameter(Mandatory)]
    [ValidateSet(
        'barrier-current',
        'barrier-cancelled',
        'barrier-superseded',
        'stop-exact',
        'stop-empty-path',
        'stop-wrong-path',
        'stop-identity-drift'
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
foreach ($functionName in @(
    'Assert-OnDemandDesktopRootExecutable',
    'Stop-OnDemandDesktopRoot',
    'Test-OnDemandDeferredOpenIntent',
    'Invoke-OnDemandImmediateAuthorizedDesktopRestartBarrier'
)) {
    $functionAst = $ast.FindAll(
        {
            param($node)
            $node -is
                [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -ceq $functionName
        },
        $true
    ) | Select-Object -First 1
    if ($null -eq $functionAst) {
        throw "The immediate restart helper '$functionName' was not found."
    }
    Invoke-Expression ([string]$functionAst.Extent.Text)
}

$expectedDesktopPath = 'C:\Program Files\WindowsApps\OpenAI.ChatGPT\ChatGPT.exe'
$resolvedDataDir = 'C:\fixture\data'
$DesktopExitTimeoutSeconds = 6
$script:nativeDesktopWasClosedForOpen = $false
$script:CloseCalls = 0
$script:CompensationCalls = 0
$script:DesiredModeReadCalls = 0
$script:DrainCalls = 0
$script:IdentityOpenCalls = 0
$script:OpenContinuationCalls = 0
$script:StopCalls = 0
$script:WaitCalls = 0

function Get-ProcessCreationIdentity {
    param([object]$CreationDate)
    $null = $CreationDate
    return [pscustomobject]@{ CreationDateUtcTicks = 123456789 }
}

function Open-ProcessIdentityHandle {
    param(
        [int]$ProcessId,
        [long]$ExpectedCreationDateUtcTicks
    )
    $null = $ProcessId
    $null = $ExpectedCreationDateUtcTicks
    $script:IdentityOpenCalls++
    if ($Mode -ceq 'stop-identity-drift') {
        throw 'simulated PID creation identity drift'
    }
    $process = [pscustomobject]@{ HasExited = $false }
    $process | Add-Member -MemberType ScriptMethod -Name CloseMainWindow -Value {
        $script:CloseCalls++
        $this.HasExited = $true
        return $true
    }
    $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
        param([int]$TimeoutMilliseconds)
        $null = $TimeoutMilliseconds
        return $true
    }
    $process | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
    $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
    return [pscustomobject]@{
        Process = $process
        StartTimeUtcTicks = 123456789
    }
}

function Stop-ProcessIdentityHandle {
    param(
        [object]$IdentityHandle,
        [int]$TimeoutMilliseconds
    )
    $null = $IdentityHandle
    $null = $TimeoutMilliseconds
    throw 'The exact fixture process should exit gracefully.'
}

function Test-OnDemandRuntimePathEqual {
    param(
        [string]$Left,
        [string]$Right
    )
    return [string]::Equals(
        $Left,
        $Right,
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Get-CodexLocalRemoteDesiredMode {
    param([string]$DataDir)
    $null = $DataDir
    $script:DesiredModeReadCalls++
    $isCurrent = switch ($Mode) {
        'barrier-cancelled' { $false }
        'barrier-superseded' { $script:DesiredModeReadCalls -eq 1 }
        default { $true }
    }
    return [pscustomobject]@{
        Mode = if ($isCurrent) { 'Remote' } else { 'Native' }
        IntentId = if ($isCurrent) { 'a' * 32 } else { 'c' * 32 }
        RuntimeVersionId = 'b' * 64
        RuntimeRoot = 'C:\fixture\runtime'
    }
}

function Stop-OnDemandDesktopRoot {
    param(
        [object]$DesktopRoot,
        [string]$ExpectedDesktopPath
    )
    $null = $DesktopRoot
    $null = $ExpectedDesktopPath
    $script:StopCalls++
}

function Wait-OnDemandDesktopDrain {
    $script:DrainCalls++
}

function Wait-OnDemandTaskState {
    param(
        [string]$Name,
        [string]$ExpectedState,
        [int]$TimeoutSeconds
    )
    $null = $Name
    $null = $ExpectedState
    $null = $TimeoutSeconds
    $script:WaitCalls++
    return [pscustomobject]@{ State = 'Ready' }
}

$succeeded = $false
$errorText = ''
try {
    if ($Mode -like 'stop-*') {
        $rootPath = switch ($Mode) {
            'stop-empty-path' { '' }
            'stop-wrong-path' { 'C:\fixture\not-chatgpt.exe' }
            default { $expectedDesktopPath }
        }
        $root = [pscustomobject]@{
            ProcessId = 1234
            CreationDate = '20260731120000.000000-000'
            ExecutablePath = $rootPath
        }
        Remove-Item Function:\Stop-OnDemandDesktopRoot
        $stopAst = $ast.FindAll(
            {
                param($node)
                $node -is
                    [System.Management.Automation.Language.FunctionDefinitionAst] -and
                $node.Name -ceq 'Stop-OnDemandDesktopRoot'
            },
            $true
        ) | Select-Object -First 1
        Invoke-Expression ([string]$stopAst.Extent.Text)
        Stop-OnDemandDesktopRoot `
            -DesktopRoot $root `
            -ExpectedDesktopPath $expectedDesktopPath
    } else {
        $runtime = [pscustomobject]@{
            CurrentVersionId = 'b' * 64
            CurrentRoot = 'C:\fixture\runtime'
        }
        $desktopRoot = [pscustomobject]@{
            ProcessId = 1234
            CreationDate = '20260731120000.000000-000'
            ExecutablePath = $expectedDesktopPath
        }
        try {
            $null = Invoke-OnDemandImmediateAuthorizedDesktopRestartBarrier `
                -Runtime $runtime `
                -StartupTask ([pscustomobject]@{ State = 'Running' }) `
                -DesktopRoots @($desktopRoot) `
                -IndependentStdioProcesses @() `
                -ExpectedDesktopPath $expectedDesktopPath `
                -ExpectedIntentId ('a' * 32) `
                -Name 'Codex Local Remote' `
                -TaskDrainTimeoutSeconds 120
            $script:OpenContinuationCalls++
        } catch {
            if ($script:nativeDesktopWasClosedForOpen) {
                $script:CompensationCalls++
            }
            throw
        }
    }
    $succeeded = $true
} catch {
    $errorText = $_.Exception.Message
}

[pscustomobject]@{
    CloseCalls = $script:CloseCalls
    CompensationCalls = $script:CompensationCalls
    DesiredModeReadCalls = $script:DesiredModeReadCalls
    DrainCalls = $script:DrainCalls
    Error = $errorText
    IdentityOpenCalls = $script:IdentityOpenCalls
    NativeDesktopWasClosed = [bool]$script:nativeDesktopWasClosedForOpen
    OpenContinuationCalls = $script:OpenContinuationCalls
    StopCalls = $script:StopCalls
    WaitCalls = $script:WaitCalls
    Succeeded = $succeeded
} | ConvertTo-Json -Compress
