[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptPath
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
$requiredFunctionNames = @(
    'Test-OnDemandRuntimePathEqual',
    'Test-OnDemandRuntimeIdentity',
    'Resolve-OnDemandOpenCompensationRuntime',
    'Set-OnDemandOpenDesiredRemote',
    'Invoke-OnDemandOpenCompensation'
)
foreach ($functionName in $requiredFunctionNames) {
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
        throw "The Open helper '$functionName' was not found."
    }
    Invoke-Expression ([string]$functionAst.Extent.Text)
}

$resolvedDataDir = 'C:\fixture\data'
$script:onDemandLastReadiness = $null
$script:fixtureState = $null
$script:fixtureRuntime = $null

function Get-CodexLocalRemoteCurrentRuntime {
    param([string]$DataDir)
    $null = $DataDir
    return $script:fixtureRuntime
}

function Get-VerifiedOnDemandStartupTask {
    param(
        [object]$Runtime,
        [string]$Name
    )
    $null = $Runtime
    $null = $Name
    return [pscustomobject]@{
        State = [string]$script:fixtureState.TaskState
    }
}

function Get-OnDemandRemoteState {
    param(
        [object]$Runtime,
        [int]$BrokerPort
    )
    $null = $Runtime
    $null = $BrokerPort
    $script:onDemandLastReadiness = switch (
        [string]$script:fixtureState.ReadinessMode
    ) {
        'verified' {
            [pscustomobject]@{
                unknownCount = 0
                unsafeThreadCount = 0
            }
        }
        'unknown' {
            [pscustomobject]@{
                unknownCount = 1
                unsafeThreadCount = 0
            }
        }
        'unsafe' {
            [pscustomobject]@{
                unknownCount = 0
                unsafeThreadCount = 10
            }
        }
        'missing-counts' {
            [pscustomobject]@{
                status = 'starting'
            }
        }
        default {
            $null
        }
    }
    return [string]$script:fixtureState.RemoteState
}

function Test-NonNegativeInteger {
    param([object]$Value)
    return (
        $Value -is [byte] -or
        $Value -is [sbyte] -or
        $Value -is [short] -or
        $Value -is [ushort] -or
        $Value -is [int] -or
        $Value -is [uint] -or
        $Value -is [long] -or
        $Value -is [ulong] -or
        $Value -is [decimal]
    ) -and [decimal]$Value -ge 0 -and
        [decimal]::Truncate([decimal]$Value) -eq [decimal]$Value
}

function Stop-ScheduledTask {
    [CmdletBinding()]
    param(
        [string]$TaskName,
        [string]$TaskPath
    )
    $null = $TaskName
    $null = $TaskPath
    $script:fixtureState.TaskStopCalls++
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
    $script:fixtureState.TaskWaitCalls++
    return [pscustomobject]@{ State = 'Ready' }
}

function New-CodexDesktopOwnerIntent {
    param(
        [string]$DataDir,
        [string]$TargetRuntimeVersionId,
        [string]$TargetRuntimeRoot
    )
    $null = $DataDir
    $null = $TargetRuntimeVersionId
    $null = $TargetRuntimeRoot
    $script:fixtureState.IntentCalls++
    return [pscustomobject]@{ IntentId = 'fixture-intent' }
}

function Get-CimInstance {
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [string]$ClassName,
        [string]$Filter
    )
    $null = $ClassName
    if ($Filter -ceq "Name = 'ChatGPT.exe'") {
        return @($script:fixtureState.DesktopRoots)
    }
    return @()
}

function Assert-OnDemandDesktopRootExecutable {
    param(
        [object]$DesktopRoot,
        [string]$ExpectedDesktopPath
    )
    $null = $DesktopRoot
    $null = $ExpectedDesktopPath
    $script:fixtureState.RootAssertCalls++
}

function Wait-OnDemandDesktopDrain {
    $script:fixtureState.DrainCalls++
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
    $script:fixtureState.NativeStartCalls++
}

function Invoke-FixtureCase {
    param(
        [Parameter(Mandatory)]
        [string]$Mode
    )

    $script:onDemandLastReadiness = $null
    $script:fixtureState = [pscustomobject]@{
        TaskState = switch ($Mode) {
            'verified-idle' { 'Running' }
            'running-not-ready' { 'Running' }
            'unknown-clients' { 'Running' }
            'missing-counts' { 'Running' }
            'active-turns' { 'Running' }
            default { 'Ready' }
        }
        RemoteState = switch ($Mode) {
            'verified-idle' { 'desktop-detached' }
            'active-turns' { 'desktop-detached' }
            default { 'unverified' }
        }
        ReadinessMode = switch ($Mode) {
            'verified-idle' { 'verified' }
            'unknown-clients' { 'unknown' }
            'missing-counts' { 'missing-counts' }
            'active-turns' { 'unsafe' }
            default { 'unverified' }
        }
        DesktopRoots = @()
        TaskStopCalls = 0
        TaskWaitCalls = 0
        IntentCalls = 0
        RootAssertCalls = 0
        DrainCalls = 0
        NativeStartCalls = 0
    }
    $taskStartAttempted = $Mode -cne 'start-failed'
    $script:fixtureRuntime = [pscustomobject]@{
        CurrentVersionId = 'a' * 64 -join ''
        CurrentRoot = 'C:\fixture\runtime'
        CurrentManifestSha256 = 'b' * 64 -join ''
        PreviousVersionId = 'd' * 64 -join ''
        PreviousRoot = 'C:\fixture\prior-runtime'
        PreviousManifestSha256 = 'e' * 64 -join ''
    }
    $result = Invoke-OnDemandOpenCompensation `
        -Runtime $script:fixtureRuntime `
        -Name 'Codex Local Remote' `
        -BrokerPort 18791 `
        -DesktopExecutablePath 'C:\fixture\ChatGPT.exe' `
        -TaskStartAttempted $taskStartAttempted
    return [pscustomobject]@{
        Result = $result
        State = $script:fixtureState
    }
}

function Invoke-OuterCatchFixture {
    param(
        [Parameter(Mandatory)]
        [ValidateSet(
            'activation-read-fails',
            'prior-rollback',
            'pointer-drift'
        )]
        [string]$Mode
    )

    $fixtureRoot = Join-Path `
        ([System.IO.Path]::GetTempPath()) `
        ('clr-open-catch-' + [guid]::NewGuid().ToString('N'))
    $fixtureWindowsRoot = Join-Path $fixtureRoot 'scripts\windows'
    $fixtureDataDir = Join-Path $fixtureRoot 'data'
    $fixtureScript = Join-Path `
        $fixtureWindowsRoot `
        'Invoke-CodexLocalRemoteOnDemandHandoff.ps1'
    $fixtureModule = Join-Path `
        $fixtureWindowsRoot `
        'CodexLocalRemote.Windows.psm1'
    $fixtureLauncher = Join-Path `
        $fixtureWindowsRoot `
        'Launch-CodexWithRemote.ps1'
    $fixtureDesktopPath = Join-Path $fixtureRoot 'ChatGPT.exe'
    New-Item -ItemType Directory -Path $fixtureWindowsRoot -Force |
        Out-Null
    New-Item -ItemType Directory -Path $fixtureDataDir -Force |
        Out-Null
    [System.IO.File]::Copy($ScriptPath, $fixtureScript, $true)
    [System.IO.File]::WriteAllText(
        $fixtureDesktopPath,
        '',
        [System.Text.UTF8Encoding]::new($false)
    )
    $mockModule = @'
function Get-CodexLocalRemoteCurrentRuntime {
    param([string]$DataDir)
    $null = $DataDir
    $global:OnDemandOpenCatchFixture.PointerReadCalls++
    $usePrior = (
        $global:OnDemandOpenCatchFixture.CurrentRuntime -ceq 'prior' -or
        (
            $global:OnDemandOpenCatchFixture.Mode -ceq 'pointer-drift' -and
            $global:OnDemandOpenCatchFixture.PointerReadCalls -gt 1
        )
    )
    $versionId = if ($usePrior) {
        [string]$global:OnDemandOpenCatchFixture.PriorVersionId
    } else {
        [string]$global:OnDemandOpenCatchFixture.VersionId
    }
    $runtimeRoot = if ($usePrior) {
        [string]$global:OnDemandOpenCatchFixture.PriorRuntimeRoot
    } else {
        [string]$global:OnDemandOpenCatchFixture.RuntimeRoot
    }
    $manifestSha256 = if ($usePrior) {
        [string]$global:OnDemandOpenCatchFixture.PriorManifestSha256
    } else {
        [string]$global:OnDemandOpenCatchFixture.ManifestSha256
    }
    $taskSha256 = if ($usePrior) {
        [string]$global:OnDemandOpenCatchFixture.PriorTaskSha256
    } else {
        [string]$global:OnDemandOpenCatchFixture.TaskSha256
    }
    return [pscustomobject]@{
        CurrentVersionId = $versionId
        CurrentRoot = $runtimeRoot
        CurrentManifestSha256 = $manifestSha256
        PreviousVersionId =
            [string]$global:OnDemandOpenCatchFixture.PriorVersionId
        PreviousRoot =
            [string]$global:OnDemandOpenCatchFixture.PriorRuntimeRoot
        PreviousManifestSha256 =
            [string]$global:OnDemandOpenCatchFixture.PriorManifestSha256
        HasPreviousTaskPreImage = $true
        PreviousTaskPreImageSha256 =
            [string]$global:OnDemandOpenCatchFixture.PriorTaskSha256
        PreviousTaskPreImageTaskName =
            [string]$global:OnDemandOpenCatchFixture.TaskName
        PreviousTaskPreImageRuntimeVersionId =
            [string]$global:OnDemandOpenCatchFixture.PriorVersionId
        PreviousTaskPreImageRuntimeRoot =
            [string]$global:OnDemandOpenCatchFixture.PriorRuntimeRoot
        HasCurrentTaskDefinition = $true
        CurrentTaskDefinitionTaskName =
            [string]$global:OnDemandOpenCatchFixture.TaskName
        CurrentTaskDefinitionRuntimeVersionId =
            $versionId
        CurrentTaskDefinitionRuntimeRoot =
            $runtimeRoot
        CurrentTaskDefinitionSha256 =
            $taskSha256
    }
}

function Test-CodexLocalRemoteRuntimeVersion {
    param(
        [string]$RuntimeRoot,
        [string]$ExpectedVersionId
    )
    $null = $RuntimeRoot
    $null = $ExpectedVersionId
    return [pscustomobject]@{
        IsValid = $true
        Reason = 'fixture'
        BrokerSidecarCompatibilityId = 'fixture-compatibility'
    }
}

function Get-CodexLocalRemoteManagedConfiguration {
    param([string]$DataDir)
    $null = $DataDir
    return [pscustomobject]@{
        TaskName = [string]$global:OnDemandOpenCatchFixture.TaskName
        SidecarPort = 18790
        BrokerPort = 18791
        BrokerUpstreamPort = 18795
        BasePath = '/codex-remote'
    }
}

function Get-CodexLocalRemoteDesiredMode {
    param([string]$DataDir)
    $null = $DataDir
    return [pscustomobject]@{
        Mode = [string]$global:OnDemandOpenCatchFixture.DesiredMode
        IntentId = [string]$global:OnDemandOpenCatchFixture.DesiredIntentId
        RuntimeVersionId =
            [string](
                $global:OnDemandOpenCatchFixture.DesiredRuntimeVersionId
            )
        RuntimeRoot =
            [string]$global:OnDemandOpenCatchFixture.DesiredRuntimeRoot
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
    $global:OnDemandOpenCatchFixture.DesiredMode = $Mode
    $global:OnDemandOpenCatchFixture.DesiredRuntimeVersionId =
        $RuntimeVersionId
    $global:OnDemandOpenCatchFixture.DesiredRuntimeRoot = $RuntimeRoot
    if ($Mode -ceq 'Remote') {
        $global:OnDemandOpenCatchFixture.DesiredIntentId =
            'fixture-open-remote-intent'
    } else {
        $global:OnDemandOpenCatchFixture.RestoreDesiredCalls++
        $global:OnDemandOpenCatchFixture.DesiredIntentId =
            'fixture-restored-native-intent'
    }
    return [pscustomobject]@{
        Mode = $Mode
        IntentId =
            [string]$global:OnDemandOpenCatchFixture.DesiredIntentId
    }
}

function Resolve-CodexDesktopPackageStatusIdentity {
    return [pscustomobject]@{
        DesktopExecutablePath =
            [string]$global:OnDemandOpenCatchFixture.DesktopPath
    }
}

function Get-StringSha256 {
    param([string]$Value)
    $null = $Value
    return $(if (
        $global:OnDemandOpenCatchFixture.CurrentRuntime -ceq 'prior'
    ) {
        [string]$global:OnDemandOpenCatchFixture.PriorTaskSha256
    } else {
        [string]$global:OnDemandOpenCatchFixture.TaskSha256
    })
}

function Get-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath
    )
    $null = $TaskName
    $null = $TaskPath
    $global:OnDemandOpenCatchFixture.TaskReadCalls++
    if ($global:OnDemandOpenCatchFixture.Mode -ceq
            'activation-read-fails' -and
        $global:OnDemandOpenCatchFixture.TaskStarted) {
        throw 'fixture task state read failed after transactional activation'
    }
    return [pscustomobject]@{
        State = if ($global:OnDemandOpenCatchFixture.TaskStarted) {
            'Running'
        } else {
            'Ready'
        }
    }
}

function Export-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath
    )
    $null = $TaskName
    $null = $TaskPath
    return $(if (
        $global:OnDemandOpenCatchFixture.CurrentRuntime -ceq 'prior'
    ) {
        '<Task>prior fixture</Task>'
    } else {
        '<Task>selected fixture</Task>'
    })
}

function Start-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath
    )
    $null = $TaskName
    $null = $TaskPath
    $global:OnDemandOpenCatchFixture.TaskStartCalls++
    $global:OnDemandOpenCatchFixture.TaskStarted = $true
}

function Stop-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath
    )
    $null = $TaskName
    $null = $TaskPath
    $global:OnDemandOpenCatchFixture.TaskStopCalls++
    $global:OnDemandOpenCatchFixture.TaskStarted = $false
}

function Get-CimInstance {
    param(
        [Parameter(Position = 0)]
        [string]$ClassName,
        [string]$Filter
    )
    $null = $ClassName
    if ($Filter -ceq "Name = 'ChatGPT.exe'" -and
        -not $global:OnDemandOpenCatchFixture.DesktopClosed) {
        return [pscustomobject]@{
            ProcessId = 41001
            ParentProcessId = 1
            CreationDate = '20260730120000.000000-000'
            ExecutablePath =
                [string]$global:OnDemandOpenCatchFixture.DesktopPath
            CommandLine =
                [string]$global:OnDemandOpenCatchFixture.DesktopPath
        }
    }
    return @()
}

function Get-NetTCPConnection {
    param(
        [string]$State,
        [int]$LocalPort
    )
    $null = $State
    $null = $LocalPort
    return @()
}

function Test-IndependentDesktopAppServer {
    param(
        [string]$CommandLine,
        [string]$ParentProcessName
    )
    $null = $CommandLine
    $null = $ParentProcessName
    return $false
}

function Get-ProcessCreationIdentity {
    param([object]$CreationDate)
    $null = $CreationDate
    return [pscustomobject]@{
        CreationDateUtcTicks = 638894448000000000
    }
}

function Open-ProcessIdentityHandle {
    param(
        [int]$ProcessId,
        [long]$ExpectedCreationDateUtcTicks
    )
    $null = $ProcessId
    $null = $ExpectedCreationDateUtcTicks
    $process = [pscustomobject]@{ HasExited = $false }
    $process | Add-Member ScriptMethod CloseMainWindow {
        $global:OnDemandOpenCatchFixture.DesktopClosed = $true
        $this.HasExited = $true
        return $true
    }
    $process | Add-Member ScriptMethod WaitForExit { param($Timeout) return $true }
    $process | Add-Member ScriptMethod Refresh { return }
    $process | Add-Member ScriptMethod Dispose { return }
    return [pscustomobject]@{ Process = $process }
}

function Stop-ProcessIdentityHandle {
    param(
        [object]$IdentityHandle,
        [int]$TimeoutMilliseconds
    )
    $null = $IdentityHandle
    $null = $TimeoutMilliseconds
    throw 'fixture did not expect a forced Desktop stop'
}

function New-CodexDesktopOwnerIntent {
    param(
        [string]$DataDir,
        [string]$TargetRuntimeVersionId,
        [string]$TargetRuntimeRoot
    )
    $null = $DataDir
    $global:OnDemandOpenCatchFixture.RecoveryIntentCalls++
    $global:OnDemandOpenCatchFixture.RecoveryIntentRuntimeVersionId =
        $TargetRuntimeVersionId
    $global:OnDemandOpenCatchFixture.RecoveryIntentRuntimeRoot =
        $TargetRuntimeRoot
    return [pscustomobject]@{ IntentId = 'fixture-recovery-intent' }
}

function Get-CodexLocalRemoteNativeDesktopOwnershipSnapshot {
    param([string]$DesktopExecutablePath)
    return [pscustomobject]@{
        DesktopRootProcessId = 41001
        DesktopRootStartTimeUtcTicks = 638894448000000000
        DesktopExecutablePath = $DesktopExecutablePath
        DesktopRootIdentityKey = 'fixture-desktop-root'
        DesktopAppServerProcessId = 41002
        DesktopAppServerStartTimeUtcTicks = 638894448000000001
        DesktopAppServerExecutablePath =
            (Join-Path (Split-Path -Parent $DesktopExecutablePath) 'resources\codex.exe')
        DesktopAppServerIdentityKey = 'fixture-desktop-app-server'
    }
}

function New-CodexLocalRemoteDesktopHandoffPreparation {
    param(
        [string]$DataDir,
        [string]$RuntimeVersionId,
        [string]$RuntimeRoot,
        [string]$ManifestSha256,
        [object]$Ownership
    )
    $null = $DataDir
    return [pscustomobject]@{
        PreparationId = '1' * 32
        Phase = 'requested'
        RuntimeVersionId = $RuntimeVersionId
        RuntimeRoot = $RuntimeRoot
        ManifestSha256 = $ManifestSha256
        DesktopRootProcessId = [int]$Ownership.DesktopRootProcessId
        DesktopRootStartTimeUtcTicks =
            [long]$Ownership.DesktopRootStartTimeUtcTicks
        DesktopExecutablePath =
            [string]$Ownership.DesktopExecutablePath
        DesktopRootIdentityKey =
            [string]$Ownership.DesktopRootIdentityKey
        DesktopAppServerProcessId =
            [int]$Ownership.DesktopAppServerProcessId
        DesktopAppServerStartTimeUtcTicks =
            [long]$Ownership.DesktopAppServerStartTimeUtcTicks
        DesktopAppServerExecutablePath =
            [string]$Ownership.DesktopAppServerExecutablePath
        DesktopAppServerIdentityKey =
            [string]$Ownership.DesktopAppServerIdentityKey
    }
}

function Complete-CodexLocalRemoteDesktopHandoffPreparation {
    param(
        [string]$DataDir,
        [object]$Preparation,
        [string]$Outcome
    )
    $null = $DataDir
    $null = $Preparation
    $null = $Outcome
    return $true
}

function Test-NonNegativeInteger {
    param([object]$Value)
    return $Value -is [int] -and [int]$Value -ge 0
}

Export-ModuleMember -Function *
'@
    [System.IO.File]::WriteAllText(
        $fixtureModule,
        $mockModule,
        [System.Text.UTF8Encoding]::new($false)
    )
$mockLauncher = @'
[CmdletBinding()]
param(
    [string]$DataDir,
    [int]$SidecarPort,
    [int]$BrokerPort,
    [int]$BrokerUpstreamPort,
    [string]$BasePath,
    [string]$TaskName,
    [switch]$DefinitionOnly
)

function Get-CodexLocalRemoteRuntimeGenerationStatus {
    param([string]$ManagedDataDir)
    $null = $ManagedDataDir
    return [pscustomobject]@{
        Status = 'active-receipt-missing'
    }
}

function Get-CodexLocalRemoteRuntimeHandoffDecision {
    param(
        [string]$TaskState,
        [string]$GenerationStatus,
        [int]$DesktopProcessCount
    )
    $null = $TaskState
    $null = $GenerationStatus
    $null = $DesktopProcessCount
    return 'start'
}

function Get-CodexLocalRemoteReadinessSnapshot {
    param([int]$Port)
    $null = $Port
    throw 'fixture start preflight must not request active readiness'
}

function Start-CodexLocalRemoteRegisteredTask {
    param(
        [string]$Name,
        [string]$ManagedDataDir,
        [int]$ManagedSidecarPort,
        [int]$ManagedBrokerPort,
        [int]$ManagedBrokerUpstreamPort,
        [string]$ManagedBasePath,
        [string]$ExpectedSelectedRuntimeVersionId,
        [string]$ExpectedSelectedRuntimeRoot,
        [string]$ExpectedSelectedManifestSha256,
        [object]$DesktopHandoffPreparation
    )
    $global:OnDemandOpenCatchFixture.SharedActivationCalls++
    $global:OnDemandOpenCatchFixture.ActivationArgumentsValid = (
        $Name -ceq $global:OnDemandOpenCatchFixture.TaskName -and
        $ManagedDataDir -ceq $global:OnDemandOpenCatchFixture.DataDir -and
        $ManagedSidecarPort -eq 18790 -and
        $ManagedBrokerPort -eq 18791 -and
        $ManagedBrokerUpstreamPort -eq 18795 -and
        $ManagedBasePath -ceq '/codex-remote' -and
        $ExpectedSelectedRuntimeVersionId -ceq
            [string]$global:OnDemandOpenCatchFixture.VersionId -and
        $ExpectedSelectedRuntimeRoot -ceq
            [string]$global:OnDemandOpenCatchFixture.RuntimeRoot -and
        $ExpectedSelectedManifestSha256 -ceq
            [string]$global:OnDemandOpenCatchFixture.ManifestSha256 -and
        $null -ne $DesktopHandoffPreparation -and
        [string]$DesktopHandoffPreparation.PreparationId -ceq
            ('1' * 32)
    )
    $global:OnDemandOpenCatchFixture.TaskStarted = $true
    if ($global:OnDemandOpenCatchFixture.Mode -ceq 'prior-rollback') {
        $global:OnDemandOpenCatchFixture.CurrentRuntime = 'prior'
        throw 'fixture switch restored prior runtime then reported failure'
    }
}

if (-not $DefinitionOnly) {
    throw 'fixture launcher is definitions-only'
}
'@
    [System.IO.File]::WriteAllText(
        $fixtureLauncher,
        $mockLauncher,
        [System.Text.UTF8Encoding]::new($false)
    )

    $global:OnDemandOpenCatchFixture = [pscustomobject]@{
        Mode = $Mode
        RuntimeRoot = $fixtureRoot
        PriorRuntimeRoot = Join-Path $fixtureRoot 'prior-runtime'
        DataDir = $fixtureDataDir
        DesktopPath = $fixtureDesktopPath
        TaskName = 'Fixture Remote Task'
        VersionId = 'a' * 64 -join ''
        PriorVersionId = 'd' * 64 -join ''
        ManifestSha256 = 'b' * 64 -join ''
        PriorManifestSha256 = 'e' * 64 -join ''
        TaskSha256 = 'c' * 64 -join ''
        PriorTaskSha256 = 'f' * 64 -join ''
        CurrentRuntime = 'selected'
        PointerReadCalls = 0
        DesiredMode = 'Native'
        DesiredIntentId = 'fixture-prior-native-intent'
        DesiredRuntimeVersionId = 'd' * 64 -join ''
        DesiredRuntimeRoot = Join-Path $fixtureRoot 'prior-runtime'
        RestoreDesiredCalls = 0
        TaskReadCalls = 0
        TaskStartCalls = 0
        SharedActivationCalls = 0
        ActivationArgumentsValid = $false
        TaskStopCalls = 0
        TaskStarted = $false
        DesktopClosed = $false
        RecoveryIntentCalls = 0
        RecoveryIntentRuntimeVersionId = $null
        RecoveryIntentRuntimeRoot = $null
    }
    $caught = $null
    try {
        $null = & $fixtureScript `
            -Operation Open `
            -DataDir $fixtureDataDir `
            -TaskName 'Fixture Remote Task' `
            -DispatchDelaySeconds 0 `
            -DesktopExitTimeoutSeconds 1 `
            -DesktopDrainTimeoutSeconds 1 `
            -ReadyWaitSeconds 15 `
            -AllowDesktopRestart
    } catch {
        $caught = $_
    }
    $statusReceipt = Get-Content `
        -LiteralPath (Join-Path $fixtureDataDir 'on-demand-handoff-last.json') `
        -Raw `
        -Encoding utf8 |
        ConvertFrom-Json
    $result = [pscustomobject]@{
        ErrorCaught = $null -ne $caught
        ErrorMessage = [string]$caught.Exception.Message
        ErrorRecoveryStatus = [string](
            $caught.Exception.Data['CodexLocalRemote.RecoveryStatus']
        )
        ErrorRecoveryIntentId = [string](
            $caught.Exception.Data['CodexLocalRemote.RecoveryIntentId']
        )
        DesiredMode =
            [string]$global:OnDemandOpenCatchFixture.DesiredMode
        DesiredIntentId =
            [string]$global:OnDemandOpenCatchFixture.DesiredIntentId
        RestoreDesiredCalls =
            [int]$global:OnDemandOpenCatchFixture.RestoreDesiredCalls
        TaskStartCalls =
            [int]$global:OnDemandOpenCatchFixture.TaskStartCalls
        SharedActivationCalls =
            [int]$global:OnDemandOpenCatchFixture.SharedActivationCalls
        ActivationArgumentsValid =
            [bool]$global:OnDemandOpenCatchFixture.ActivationArgumentsValid
        TaskStopCalls =
            [int]$global:OnDemandOpenCatchFixture.TaskStopCalls
        RecoveryIntentCalls =
            [int]$global:OnDemandOpenCatchFixture.RecoveryIntentCalls
        PointerReadCalls =
            [int]$global:OnDemandOpenCatchFixture.PointerReadCalls
        DesktopClosed =
            [bool]$global:OnDemandOpenCatchFixture.DesktopClosed
        DesiredUsesPrior = (
            [string]$global:OnDemandOpenCatchFixture.
                DesiredRuntimeVersionId -ceq
                [string]$global:OnDemandOpenCatchFixture.PriorVersionId -and
            [string]$global:OnDemandOpenCatchFixture.DesiredRuntimeRoot -ceq
                [string]$global:OnDemandOpenCatchFixture.PriorRuntimeRoot
        )
        RecoveryIntentUsesPrior = (
            [string]$global:OnDemandOpenCatchFixture.
                RecoveryIntentRuntimeVersionId -ceq
                [string]$global:OnDemandOpenCatchFixture.PriorVersionId -and
            [string]$global:OnDemandOpenCatchFixture.
                RecoveryIntentRuntimeRoot -ceq
                [string]$global:OnDemandOpenCatchFixture.PriorRuntimeRoot
        )
        PersistedStatus = [string]$statusReceipt.Status
        PersistedStage = [string]$statusReceipt.Stage
        PersistedCode = [string]$statusReceipt.Code
    }
    Remove-Module CodexLocalRemote.Windows -Force -ErrorAction SilentlyContinue
    Remove-Variable `
        OnDemandOpenCatchFixture `
        -Scope Global `
        -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    return $result
}

[pscustomobject]@{
    StartFailed = Invoke-FixtureCase -Mode 'start-failed'
    VerifiedIdle = Invoke-FixtureCase -Mode 'verified-idle'
    RunningNotReady = Invoke-FixtureCase -Mode 'running-not-ready'
    UnknownClients = Invoke-FixtureCase -Mode 'unknown-clients'
    MissingCounts = Invoke-FixtureCase -Mode 'missing-counts'
    LauncherFailed = Invoke-FixtureCase -Mode 'launcher-failed'
    ActiveTurns = Invoke-FixtureCase -Mode 'active-turns'
    OuterCatch = Invoke-OuterCatchFixture `
        -Mode 'activation-read-fails'
    PriorRollback = Invoke-OuterCatchFixture `
        -Mode 'prior-rollback'
    PointerDrift = Invoke-OuterCatchFixture `
        -Mode 'pointer-drift'
} | ConvertTo-Json -Compress -Depth 8
