[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptPath,

    [Parameter(Mandatory)]
    [ValidateSet(
        'barrier-current',
        'barrier-bound-stdio',
        'barrier-foreign-stdio',
        'barrier-multiple-stdio',
        'barrier-stdio-ownership-drift',
        'barrier-cancelled',
        'barrier-legacy-native-rewrite',
        'barrier-remote-superseded',
        'barrier-native-runtime-superseded',
        'barrier-ready-native-superseded',
        'barrier-rearm-failure',
        'barrier-rearm-external-remote',
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
    'Complete-OnDemandDrainedDesktopHandoffPreparation',
    'Invoke-OnDemandImmediateAuthorizedDesktopRestartBarrier',
    'Invoke-OnDemandOpenCompensation'
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
$script:CompensationError = ''
$script:CompensationStatus = ''
$script:DesiredModeReadCalls = 0
$script:DesiredModeWrites = [System.Collections.Generic.List[string]]::new()
$script:DesiredMode = 'Remote'
$script:DesiredIntentId = 'a' * 32
$script:DesiredRuntimeVersionId = 'b' * 64
$script:DesiredRuntimeRoot = 'C:\fixture\runtime'
$script:deferredIntentIdForCompensation = 'a' * 32
$script:DrainCalls = 0
$script:IdentityOpenCalls = 0
$script:NativeStartCalls = 0
$script:OpenContinuationCalls = 0
$script:PortWaitCalls = 0
$script:RootStopCalls = 0
$script:GroupStopCalls = 0
$script:StopCalls = 0
$script:WaitCalls = 0

function Get-ProcessCreationIdentity {
    param([object]$CreationDate)
    $null = $CreationDate
    return [pscustomobject]@{ CreationDateUtcTicks = 123456789 }
}

function Get-CodexDesktopOwnerRootIdentityKey {
    param(
        [int]$ProcessId,
        [long]$StartTimeUtcTicks,
        [string]$ExecutablePath
    )
    return "$ProcessId|$StartTimeUtcTicks|$ExecutablePath"
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

function Assert-OnDemandRuntimeFreshForDesktopSwitch {
    param([object]$ExpectedRuntime)
    return $ExpectedRuntime
}

function Get-CodexLocalRemoteDesiredMode {
    param([string]$DataDir)
    $null = $DataDir
    $script:DesiredModeReadCalls++
    if ($Mode -ceq 'barrier-cancelled' -and
        $script:DesiredModeReadCalls -eq 1) {
        $script:DesiredMode = 'Native'
        $script:DesiredIntentId = 'e' * 32
    }
    return [pscustomobject]@{
        Mode = [string]$script:DesiredMode
        IntentId = [string]$script:DesiredIntentId
        RuntimeVersionId = [string]$script:DesiredRuntimeVersionId
        RuntimeRoot = [string]$script:DesiredRuntimeRoot
    }
}

function Set-CodexLocalRemoteDesiredMode {
    param(
        [string]$DataDir,
        [string]$Mode,
        [string]$RuntimeVersionId,
        [string]$RuntimeRoot
    )
    $null = $DataDir
    $script:DesiredModeWrites.Add($Mode)
    $intentId = if ($Mode -ceq 'Remote') {
        'd' * 32
    } elseif ($script:DesiredModeWrites.Count -eq 1) {
        'c' * 32
    } else {
        'f' * 32
    }
    $script:DesiredMode = $Mode
    $script:DesiredIntentId = $intentId
    $script:DesiredRuntimeVersionId = $RuntimeVersionId
    $script:DesiredRuntimeRoot = $RuntimeRoot
    return [pscustomobject]@{
        Mode = $Mode
        IntentId = $intentId
        RuntimeVersionId = $RuntimeVersionId
        RuntimeRoot = $RuntimeRoot
    }
}

function Stop-OnDemandDesktopRoot {
    param(
        [object]$DesktopRoot,
        [string]$ExpectedDesktopPath
    )
    $null = $DesktopRoot
    $null = $ExpectedDesktopPath
    $script:RootStopCalls++
    $script:StopCalls++
}

function Get-CodexLocalRemoteNativeDesktopOwnershipSnapshot {
    param([string]$DesktopExecutablePath)
    $null = $DesktopExecutablePath
    return [pscustomobject]@{
        DesktopRootProcessId = 1234
        DesktopRootStartTimeUtcTicks = 123456789
        DesktopAppServerProcessId = if (
            $Mode -ceq 'barrier-stdio-ownership-drift'
        ) { 3456 } else { 2345 }
        DesktopAppServerStartTimeUtcTicks = 123456789
    }
}

function Stop-OnDemandDesktopProcessGroup {
    param(
        [object]$Preparation,
        [string]$ExpectedDesktopPath
    )
    $null = $Preparation
    $null = $ExpectedDesktopPath
    $script:GroupStopCalls++
    $script:StopCalls++
}

function Wait-OnDemandDesktopDrain {
    $script:DrainCalls++
}

function Read-CodexLocalRemoteDesktopHandoffPreparation {
    return $null
}

function Complete-CodexLocalRemoteDesktopHandoffPreparation {
    throw 'A missing fixture preparation must remain a no-op.'
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
    switch ($Mode) {
        'barrier-legacy-native-rewrite' {
            $script:DesiredMode = 'Native'
            $script:DesiredIntentId = 'e' * 32
        }
        'barrier-remote-superseded' {
            $script:DesiredMode = 'Remote'
            $script:DesiredIntentId = 'e' * 32
        }
        'barrier-native-runtime-superseded' {
            $script:DesiredMode = 'Native'
            $script:DesiredIntentId = 'e' * 32
            $script:DesiredRuntimeVersionId = '9' * 64
            $script:DesiredRuntimeRoot = 'C:\fixture\other-runtime'
        }
        'barrier-ready-native-superseded' {
            $script:DesiredMode = 'Native'
            $script:DesiredIntentId = 'e' * 32
        }
    }
    return [pscustomobject]@{ State = 'Ready' }
}

function Open-OnDemandManagedUpstreamProcessTree {
    param([object]$Configuration)
    $null = $Configuration
    return [pscustomobject]@{ RootProcessId = 4321; Members = @() }
}

function Stop-ProcessTreeIdentitySnapshot {
    param([object]$Snapshot)
    $null = $Snapshot
}

function Wait-OnDemandManagedPortsReleased {
    param([int[]]$Ports)
    $null = $Ports
    $script:PortWaitCalls++
}

function Close-ProcessTreeIdentitySnapshot {
    param([object]$Snapshot)
    $null = $Snapshot
}

function Get-CodexLocalRemoteNativeDesktopRootCandidates {
    param([string]$DesktopExecutablePath)
    $null = $DesktopExecutablePath
    return @()
}

function Get-OnDemandIndependentStdioProcesses {
    return @()
}

function Start-OnDemandNativeDesktop {
    param(
        [string]$RuntimeRoot,
        [string]$DesktopExecutablePath
    )
    $null = $RuntimeRoot
    $null = $DesktopExecutablePath
    $script:NativeStartCalls++
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
            CurrentManifestSha256 = 'c' * 64
        }
        $configuration = [pscustomobject]@{
            SidecarPort = 18790
            BrokerPort = 18791
            BrokerUpstreamPort = 18795
        }
        $desktopRoot = [pscustomobject]@{
            ProcessId = 1234
            CreationDate = '20260731120000.000000-000'
            ExecutablePath = $expectedDesktopPath
        }
        $independentStdioProcesses = switch ($Mode) {
            'barrier-bound-stdio' {
                @([pscustomobject]@{
                    ProcessId = 2345
                    ParentProcessId = 1234
                    CreationDate = '20260731120000.000000-000'
                })
            }
            'barrier-foreign-stdio' {
                @([pscustomobject]@{
                    ProcessId = 2345
                    ParentProcessId = 9999
                    CreationDate = '20260731120000.000000-000'
                })
            }
            'barrier-multiple-stdio' {
                @(
                    [pscustomobject]@{
                        ProcessId = 2345
                        ParentProcessId = 1234
                        CreationDate = '20260731120000.000000-000'
                    },
                    [pscustomobject]@{
                        ProcessId = 3456
                        ParentProcessId = 1234
                        CreationDate = '20260731120000.000000-000'
                    }
                )
            }
            'barrier-stdio-ownership-drift' {
                @([pscustomobject]@{
                    ProcessId = 2345
                    ParentProcessId = 1234
                    CreationDate = '20260731120000.000000-000'
                })
            }
            default { @() }
        }
        try {
            $startupTaskState = if (
                $Mode -ceq 'barrier-ready-native-superseded'
            ) {
                'Ready'
            } else {
                'Running'
            }
            $null = Invoke-OnDemandImmediateAuthorizedDesktopRestartBarrier `
                -Runtime $runtime `
                -StartupTask ([pscustomobject]@{ State = $startupTaskState }) `
                -Configuration $configuration `
                -DesktopRoots @($desktopRoot) `
                -IndependentStdioProcesses @($independentStdioProcesses) `
                -ExpectedDesktopPath $expectedDesktopPath `
                -ExpectedIntentId ('a' * 32) `
                -Name 'Codex Local Remote' `
                -TaskDrainTimeoutSeconds 120
            if ($Mode -ceq 'barrier-rearm-external-remote') {
                $script:DesiredMode = 'Remote'
                $script:DesiredIntentId = '8' * 32
            }
            if ($Mode -cin @(
                'barrier-rearm-failure',
                'barrier-rearm-external-remote'
            )) {
                throw 'simulated failure after Remote re-arm'
            }
            $script:OpenContinuationCalls++
        } catch {
            $failure = $_
            if ($script:nativeDesktopWasClosedForOpen) {
                $script:CompensationCalls++
                if ($Mode -cin @(
                    'barrier-rearm-failure',
                    'barrier-rearm-external-remote'
                )) {
                    try {
                        $compensation = Invoke-OnDemandOpenCompensation `
                            -Runtime $runtime `
                            -Name 'Codex Local Remote' `
                            -BrokerPort 18791 `
                            -DesktopExecutablePath $expectedDesktopPath `
                            -TaskStartAttempted $false `
                            -DeferredIntentId (
                                [string]$script:deferredIntentIdForCompensation
                            )
                        $script:CompensationStatus =
                            [string]$compensation.Status
                    } catch {
                        $script:CompensationError = $_.Exception.Message
                    }
                }
            }
            throw $failure
        }
    }
    $succeeded = $true
} catch {
    $errorText = $_.Exception.Message
}

[pscustomobject]@{
    CloseCalls = $script:CloseCalls
    CompensationCalls = $script:CompensationCalls
    CompensationError = $script:CompensationError
    CompensationStatus = $script:CompensationStatus
    CurrentDesiredIntentId = [string]$script:DesiredIntentId
    CurrentDesiredMode = [string]$script:DesiredMode
    DesiredModeReadCalls = $script:DesiredModeReadCalls
    DesiredModeWrites = @($script:DesiredModeWrites)
    DeferredCompensationIntentId =
        [string]$script:deferredIntentIdForCompensation
    DrainCalls = $script:DrainCalls
    Error = $errorText
    IdentityOpenCalls = $script:IdentityOpenCalls
    NativeDesktopWasClosed = [bool]$script:nativeDesktopWasClosedForOpen
    NativeStartCalls = $script:NativeStartCalls
    OpenContinuationCalls = $script:OpenContinuationCalls
    PortWaitCalls = $script:PortWaitCalls
    RootStopCalls = $script:RootStopCalls
    GroupStopCalls = $script:GroupStopCalls
    StopCalls = $script:StopCalls
    WaitCalls = $script:WaitCalls
    Succeeded = $succeeded
} | ConvertTo-Json -Compress
