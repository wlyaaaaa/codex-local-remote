[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LauncherPath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot,

    [Parameter(Mandatory)]
    [ValidateSet(
        'happy',
        'desktop-after-stop',
        'generation-drift-after-stop',
        'readiness-drift-after-stop',
        'sidecar-stop-fails',
        'broker-stop-fails',
        'start-fails-once',
        'start-after-effect-throws',
        'delayed-start-after-effect',
        'selected-owner-reappears-after-cleanup',
        'selected-pair-drift-after-readiness',
        'old-pair-drift-after-readiness',
        'start-readiness-fails',
        'recovery-start-fails',
        'recovery-register-fails',
        'recovery-register-after-effect-throws',
        'recovery-pointer-fails',
        'recovery-pointer-after-effect-throws',
        'recovery-selected-binding-repair-fails',
        'selected-task-contract-drift',
        'interrupted-post-stop',
        'interrupted-post-stop-start-fails',
        'interrupted-task-ready-sidecar-orphan',
        'interrupted-task-ready-sidecar-delayed-disconnect',
        'desktop-detached-degraded-unprepared',
        'desktop-detached-degraded-prepared'
    )]
    [string]$Mode,

    [ValidateRange(1, 60)]
    [int]$TaskControlTimeoutSeconds = 1,

    [ValidateRange(90, 300)]
    [int]$RuntimeReadyTimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
. $LauncherPath -DefinitionOnly

$activeRoot = Join-Path $SandboxRoot 'RuntimeVersions\old'
$selectedRoot = Join-Path $SandboxRoot 'RuntimeVersions\new'
$dataDir = Join-Path $SandboxRoot 'Data'
$eventLog = Join-Path $SandboxRoot 'events.log'
$sidecarStop = Join-Path $activeRoot `
    'scripts\windows\Stop-CodexLocalRemoteSidecar.ps1'
$brokerStop = Join-Path $activeRoot `
    'scripts\windows\Stop-CodexAppServerBroker.ps1'
$selectedSidecarStop = Join-Path $selectedRoot `
    'scripts\windows\Stop-CodexLocalRemoteSidecar.ps1'
$selectedBrokerStop = Join-Path $selectedRoot `
    'scripts\windows\Stop-CodexAppServerBroker.ps1'

$null = New-Item `
    -ItemType Directory `
    -Path (Split-Path -Parent $sidecarStop) `
    -Force
$null = New-Item `
    -ItemType Directory `
    -Path (Split-Path -Parent $selectedSidecarStop) `
    -Force

$stopScript = @'
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$NodePath,
    [string]$ExpectedSidecarCliPath,
    [string]$CodexPath,
    [string]$InstallRoot,
    [string]$DataDir,
    [int]$Port,
    [int]$BrokerPort,
    [int]$BrokerUpstreamPort,
    [string]$BasePath
)
$kind = if ($PSBoundParameters.ContainsKey('ExpectedSidecarCliPath')) {
    'sidecar-stop'
} else {
    'broker-stop'
}
$generation = if ($InstallRoot -like '*\new' -or
    $ExpectedSidecarCliPath -like '*\new\*') {
    'new'
} else {
    'old'
}
$event = if ($generation -ceq 'old') {
    $kind
} else {
    "$generation-$kind"
}
Add-Content -LiteralPath $env:CODEX_HANDOFF_TEST_EVENT_LOG -Value $event
if (($kind -ceq 'sidecar-stop' -and
        $generation -ceq 'old' -and
        ($env:CODEX_HANDOFF_TEST_MODE -ceq 'sidecar-stop-fails' -or
            $env:CODEX_HANDOFF_TEST_MODE -cin @(
                'recovery-register-fails',
                'recovery-register-after-effect-throws',
                'recovery-pointer-fails',
                'recovery-pointer-after-effect-throws',
                'recovery-selected-binding-repair-fails',
                'old-pair-drift-after-readiness'
            ))) -or
    ($kind -ceq 'broker-stop' -and
        $generation -ceq 'old' -and
        $env:CODEX_HANDOFF_TEST_MODE -ceq 'broker-stop-fails')) {
    throw "$kind injected failure"
}
'stopped'
'@
Set-Content -LiteralPath $sidecarStop -Value $stopScript -Encoding utf8
Set-Content -LiteralPath $brokerStop -Value $stopScript -Encoding utf8
Set-Content -LiteralPath $selectedSidecarStop -Value $stopScript -Encoding utf8
Set-Content -LiteralPath $selectedBrokerStop -Value $stopScript -Encoding utf8

$script:taskState = if (
    $Mode -clike 'interrupted-post-stop*' -or
    $Mode -ceq 'interrupted-task-ready-sidecar-orphan' -or
    $Mode -ceq 'interrupted-task-ready-sidecar-delayed-disconnect'
) {
    'Ready'
} else {
    'Running'
}
$script:taskRuntimeRoot = $selectedRoot
$script:taskXml = $null
$script:pointerRuntimeRoot = $selectedRoot
$script:pointerPreviousRoot = $activeRoot
$script:activeRuntimeRoot = $activeRoot
$script:startAttempts = 0
$script:stopAttempts = 0
$script:registerAttempts = 0
$script:pointerAttempts = 0
$script:pointerWrites = 0
$script:desktopReads = 0
$script:generationReads = 0
$script:readinessReads = 0
$script:sidecarDisconnectReads = 0
$script:delayedStartPending = $false
$script:delayedObservationReads = 0
$script:firstDelayedTaskObservation = $null
$script:firstDelayedGenerationObservation = $null
$script:selectedOwnerReappeared = $false
$script:selectedOwnerSilenced = $false
$script:selectedCleanupSilentReads = 0
$script:cleanupSilentReadsBeforeOldRestore = 0
$script:activeRuntimeBeforeOldRestore = $null
$script:selectedPairDriftInjected = $false
$script:selectedActiveReadinessObservations = 0
$script:oldPairDriftInjected = $false
$oldVersionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
$newVersionId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
$oldRuntimeInvocationId = '0123456789abcdef0123456789abcdef'
$newRuntimeInvocationId = 'fedcba9876543210fedcba9876543210'
$oldBrokerProcessId = 4101
$oldUpstreamProcessId = 4102
$newBrokerProcessId = 4201
$newUpstreamProcessId = 4202
$preparedManifestSha256 =
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
$desktopHandoffPreparation = if (
    $Mode -ceq 'desktop-detached-degraded-prepared'
) {
    [pscustomobject]@{
        PreparationId = '11223344556677889900aabbccddeeff'
        Phase = 'requested'
        RuntimeVersionId = $newVersionId
        RuntimeRoot = $selectedRoot
        ManifestSha256 = $preparedManifestSha256
    }
} else {
    $null
}

$generation = [pscustomobject]@{
    Status = 'transition-required'
    SelectedRoot = $selectedRoot
    ActiveRoot = $activeRoot
    Receipt = [pscustomobject]@{
        Signature = 'codex-local-remote/app-server-broker/v3'
        Version = 3
        Status = 'ready'
        RuntimeInvocationId = $oldRuntimeInvocationId
        ProcessId = $oldBrokerProcessId
        BrokerCliPath = (
            Join-Path $activeRoot 'apps\broker\dist\cli.js'
        )
        NodePath = (Join-Path $SandboxRoot 'node.exe')
        CodexPath = (Join-Path $SandboxRoot 'codex.exe')
        Upstream = [pscustomobject]@{
            ProcessId = $oldUpstreamProcessId
            RuntimeInvocationId = $oldRuntimeInvocationId
        }
    }
}

function Add-TestEvent {
    param([Parameter(Mandatory)][string]$Value)

    Add-Content -LiteralPath $eventLog -Value $Value
}

function Get-TestRuntimeLabel {
    param([AllowNull()][string]$RuntimeRoot)

    if ([string]::Equals(
        $RuntimeRoot,
        $activeRoot,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        return 'old'
    }
    if ([string]::Equals(
        $RuntimeRoot,
        $selectedRoot,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        return 'new'
    }
    return 'unexpected'
}

function New-TestTaskXml {
    param(
        [Parameter(Mandatory)]
        [string]$RuntimeRoot,

        [Parameter(Mandatory)]
        [ValidateSet('old', 'selected')]
        [string]$Contract
    )

    $document = [xml]@'
<Task>
  <RegistrationInfo>
    <Description />
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay />
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel />
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy />
    <ExecutionTimeLimit />
    <Priority />
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>conhost.exe</Command>
      <Arguments />
      <WorkingDirectory />
    </Exec>
  </Actions>
</Task>
'@
    $isOld = $Contract -ceq 'old'
    $document.Task.RegistrationInfo.Description = if ($isOld) {
        'exact-old-contract'
    } else {
        'selected-new-contract'
    }
    $document.Task.Triggers.LogonTrigger.Delay = if ($isOld) {
        'PT17S'
    } else {
        'PT1S'
    }
    $document.Task.Principals.Principal.RunLevel = if ($isOld) {
        'LeastPrivilege'
    } else {
        'HighestAvailable'
    }
    $document.Task.Settings.MultipleInstancesPolicy = if ($isOld) {
        'StopExisting'
    } else {
        'IgnoreNew'
    }
    $document.Task.Settings.ExecutionTimeLimit = if ($isOld) {
        'PT37M'
    } else {
        'PT0S'
    }
    $document.Task.Settings.Priority = if ($isOld) { '6' } else { '4' }
    $document.Task.Actions.Exec.Arguments =
        "--headless pwsh.exe -InstallRoot `"$RuntimeRoot`""
    $document.Task.Actions.Exec.WorkingDirectory = $RuntimeRoot
    return $document.OuterXml
}

$oldTaskXml = New-TestTaskXml `
    -RuntimeRoot $activeRoot `
    -Contract 'old'
$selectedTaskXml = New-TestTaskXml `
    -RuntimeRoot $selectedRoot `
    -Contract 'selected'
$oldTaskXmlSha256 = Get-StringSha256 -Value $oldTaskXml
$selectedTaskXmlSha256 = Get-StringSha256 -Value $selectedTaskXml
$script:currentTaskDefinitionSha256 = $selectedTaskXmlSha256
$script:currentTaskDefinitionRuntimeRoot = $selectedRoot
$script:currentTaskDefinitionRuntimeVersionId = $newVersionId
$script:taskXml = if ($Mode -ceq 'selected-task-contract-drift') {
    $driftedTask = [xml]$selectedTaskXml
    $driftedTask.Task.Triggers.LogonTrigger.Delay = 'PT59S'
    $driftedTask.Task.Settings.Priority = '9'
    $driftedTask.OuterXml
} else {
    $selectedTaskXml
}

function Complete-TestDelayedStartIfObservable {
    if ($Mode -cne 'delayed-start-after-effect' -or
        -not $script:delayedStartPending) {
        return
    }
    $script:delayedObservationReads++
    if ($script:delayedObservationReads -lt 4) {
        return
    }
    $script:delayedStartPending = $false
    $script:taskState = 'Running'
    $script:activeRuntimeRoot = $selectedRoot
    Add-TestEvent -Value 'task-delayed-running:new'
}

function Get-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath,
        [object]$ErrorAction
    )

    Complete-TestDelayedStartIfObservable
    if ($Mode -ceq 'delayed-start-after-effect' -and
        $null -eq $script:firstDelayedTaskObservation -and
        $script:startAttempts -gt 0) {
        $script:firstDelayedTaskObservation = [string]$script:taskState
    }
    $document = [xml]$script:taskXml
    $workingDirectory = [string](
        $document.Task.Actions.Exec.WorkingDirectory
    )
    return [pscustomobject]@{
        TaskName = $TaskName
        TaskPath = $TaskPath
        State = $script:taskState
        Description = [string]$document.Task.RegistrationInfo.Description
        Actions = @(
            [pscustomobject]@{
                Execute = [string]$document.Task.Actions.Exec.Command
                Arguments = [string]$document.Task.Actions.Exec.Arguments
                WorkingDirectory = $workingDirectory
            }
        )
    }
}

function Export-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath,
        [object]$ErrorAction
    )

    $null = $TaskName
    $null = $TaskPath
    $null = $ErrorAction
    return $script:taskXml
}

function Register-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath,
        [string]$Xml,
        [switch]$Force
    )

    $null = $TaskName
    $null = $TaskPath
    $null = $Force
    $document = [xml]$Xml
    $workingDirectory = [string](
        $document.Task.Actions.Exec.WorkingDirectory
    )
    if ((Get-TestRuntimeLabel -RuntimeRoot $workingDirectory) -ceq
        'unexpected') {
        throw 'fixture task XML did not identify old or new runtime'
    }
    $script:registerAttempts++
    $label = Get-TestRuntimeLabel -RuntimeRoot $workingDirectory
    if ($Mode -cin @(
            'recovery-register-fails',
            'recovery-selected-binding-repair-fails'
        ) -and
        $label -ceq 'old') {
        if ($Mode -ceq 'recovery-selected-binding-repair-fails') {
            $script:currentTaskDefinitionSha256 =
                'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
            Add-TestEvent -Value 'selected-binding-drifted'
        }
        Add-TestEvent -Value 'task-register-failed:old'
        throw 'task registration injected failure'
    }
    if ($Mode -ceq 'selected-owner-reappears-after-cleanup' -and
        $label -ceq 'old') {
        $script:cleanupSilentReadsBeforeOldRestore =
            $script:selectedCleanupSilentReads
        $script:activeRuntimeBeforeOldRestore =
            Get-TestRuntimeLabel -RuntimeRoot $script:activeRuntimeRoot
    }
    $script:taskRuntimeRoot = $workingDirectory
    $script:taskXml = $Xml
    Add-TestEvent -Value (
        'task-register:' +
        (Get-TestRuntimeLabel -RuntimeRoot $script:taskRuntimeRoot)
    )
    if ($Mode -ceq 'recovery-register-after-effect-throws' -and
        $label -ceq 'old') {
        throw 'task registration injected failure after effect'
    }
    return Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
}

function Stop-ScheduledTask {
    param([string]$TaskName, [string]$TaskPath)

    $script:stopAttempts++
    Add-TestEvent -Value "task-stop:$($script:stopAttempts)"
    if ($Mode -ceq 'delayed-start-after-effect' -and
        $script:delayedStartPending -and
        [string]$script:taskState -cne 'Running') {
        Add-TestEvent -Value 'task-stop-before-delayed-observation'
        return
    }
    $script:delayedStartPending = $false
    $script:taskState = 'Ready'
}

function Start-ScheduledTask {
    param([string]$TaskName, [string]$TaskPath)

    $script:startAttempts++
    Add-TestEvent -Value "task-start:$($script:startAttempts)"
    if ((($Mode -ceq 'start-fails-once' -or
            $Mode -ceq 'interrupted-post-stop-start-fails') -and
            $script:startAttempts -eq 1) -or
        $Mode -ceq 'recovery-start-fails') {
        throw 'task start injected failure'
    }
    if ($Mode -ceq 'delayed-start-after-effect' -and
        $script:startAttempts -eq 1) {
        $script:delayedStartPending = $true
        $script:delayedObservationReads = 0
        Add-TestEvent -Value 'task-start-accepted-delayed'
        throw 'task start accepted before delayed observability'
    }
    $script:taskState = 'Running'
    $script:activeRuntimeRoot = $script:taskRuntimeRoot
    Add-TestEvent -Value (
        'task-running:' +
        (Get-TestRuntimeLabel -RuntimeRoot $script:activeRuntimeRoot)
    )
    if ($Mode -cin @(
            'start-after-effect-throws',
            'selected-owner-reappears-after-cleanup'
        ) -and
        $script:startAttempts -eq 1) {
        throw 'task start injected failure after effect'
    }
}

function Get-RunningCodexDesktopProcesses {
    $script:desktopReads++
    if ($Mode -ceq 'desktop-after-stop' -and
        $script:taskState -cne 'Running') {
        return @([pscustomobject]@{ ProcessId = 9001 })
    }
    return @()
}

function Get-CodexDesktopHandoffProcesses {
    return @(Get-RunningCodexDesktopProcesses)
}

function Read-CodexLocalRemoteDesktopHandoffPreparation {
    param(
        [string]$DataDir,
        [string]$ExpectedRuntimeVersionId,
        [string]$ExpectedRuntimeRoot,
        [string]$ExpectedManifestSha256,
        [switch]$RequireLiveOwnership
    )

    $null = $DataDir
    $null = $RequireLiveOwnership
    if ($null -eq $desktopHandoffPreparation -or
        $ExpectedRuntimeVersionId -cne $newVersionId -or
        $ExpectedManifestSha256 -cne $preparedManifestSha256 -or
        -not [string]::Equals(
            [System.IO.Path]::GetFullPath($ExpectedRuntimeRoot),
            [System.IO.Path]::GetFullPath($selectedRoot),
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        return $null
    }
    return $desktopHandoffPreparation
}

function Get-CodexLocalRemoteRuntimeGenerationStatus {
    param([string]$ManagedDataDir)

    Complete-TestDelayedStartIfObservable
    if ($Mode -ceq 'selected-owner-reappears-after-cleanup' -and
        $script:startAttempts -gt 0) {
        $selectedBrokerStopCount = 0
        if (Test-Path -LiteralPath $eventLog -PathType Leaf) {
            $selectedBrokerStopCount = @(
                Get-Content -LiteralPath $eventLog |
                    Where-Object { $_ -ceq 'new-broker-stop' }
            ).Count
        }
        if ($selectedBrokerStopCount -ge 2 -and
            $script:selectedOwnerReappeared -and
            -not $script:selectedOwnerSilenced) {
            $script:selectedOwnerSilenced = $true
            $script:taskState = 'Ready'
            $script:activeRuntimeRoot = $activeRoot
            Add-TestEvent -Value 'selected-owner-silent-after-second-cleanup'
        } elseif ($selectedBrokerStopCount -ge 1 -and
            -not $script:selectedOwnerReappeared) {
            $script:selectedOwnerReappeared = $true
            $script:taskState = 'Running'
            $script:activeRuntimeRoot = $selectedRoot
            Add-TestEvent -Value 'selected-owner-reappeared'
        }
        if ($script:selectedOwnerSilenced -and
            (Get-TestRuntimeLabel `
                -RuntimeRoot $script:activeRuntimeRoot) -cne 'new') {
            $script:selectedCleanupSilentReads++
        }
    }
    if ($Mode -cne 'selected-owner-reappears-after-cleanup' -and
        $script:startAttempts -gt 0 -and
        [string]$script:taskState -cne 'Running' -and
        (Get-TestRuntimeLabel `
            -RuntimeRoot $script:activeRuntimeRoot) -ceq 'new' -and
        (Test-Path -LiteralPath $eventLog -PathType Leaf) -and
        @(
            Get-Content -LiteralPath $eventLog |
                Where-Object { $_ -ceq 'new-broker-stop' }
        ).Count -ge 1) {
        $script:activeRuntimeRoot = $activeRoot
    }
    if ($Mode -ceq 'delayed-start-after-effect' -and
        $null -eq $script:firstDelayedGenerationObservation -and
        $script:startAttempts -gt 0) {
        $script:firstDelayedGenerationObservation =
            Get-TestRuntimeLabel `
                -RuntimeRoot $script:activeRuntimeRoot
    }
    $script:generationReads++
    $activeLabel = Get-TestRuntimeLabel `
        -RuntimeRoot $script:activeRuntimeRoot
    $pointerLabel = Get-TestRuntimeLabel `
        -RuntimeRoot $script:pointerRuntimeRoot
    $runtimeInvocationId = if ($activeLabel -ceq 'old') {
        $oldRuntimeInvocationId
    } else {
        $newRuntimeInvocationId
    }
    $brokerProcessId = if ($activeLabel -ceq 'old') {
        $oldBrokerProcessId
    } else {
        $newBrokerProcessId
    }
    $upstreamProcessId = if ($activeLabel -ceq 'old') {
        $oldUpstreamProcessId
    } else {
        $newUpstreamProcessId
    }
    $snapshot = [pscustomobject]@{
        Status = if ($pointerLabel -ceq $activeLabel) {
            'current'
        } else {
            'transition-required'
        }
        SelectedRoot = $script:pointerRuntimeRoot
        ActiveRoot = $script:activeRuntimeRoot
        Receipt = [pscustomobject]@{
            Signature = 'codex-local-remote/app-server-broker/v3'
            Version = 3
            Status = 'ready'
            RuntimeInvocationId = $runtimeInvocationId
            ProcessId = $brokerProcessId
            BrokerCliPath = Join-Path $script:activeRuntimeRoot `
                'apps\broker\dist\cli.js'
            NodePath = (Join-Path $SandboxRoot 'node.exe')
            CodexPath = (Join-Path $SandboxRoot 'codex.exe')
            Upstream = [pscustomobject]@{
                ProcessId = $upstreamProcessId
                RuntimeInvocationId = $runtimeInvocationId
            }
        }
    }
    if ($Mode -ceq 'generation-drift-after-stop' -and
        $script:taskState -cne 'Running' -and
        $pointerLabel -ceq 'new') {
        $snapshot.ActiveRoot = Join-Path $SandboxRoot `
            'RuntimeVersions\unexpected'
    }
    return $snapshot
}

function Get-CodexLocalRemoteCurrentRuntime {
    param([string]$DataDir)

    $null = $DataDir
    $currentLabel = Get-TestRuntimeLabel `
        -RuntimeRoot $script:pointerRuntimeRoot
    $previousLabel = Get-TestRuntimeLabel `
        -RuntimeRoot $script:pointerPreviousRoot
    return [pscustomobject]@{
        Signature = 'codex-local-remote/runtime-current/v1'
        Version = 1
        CurrentVersionId = if ($currentLabel -ceq 'old') {
            $oldVersionId
        } else {
            $newVersionId
        }
        CurrentRoot = $script:pointerRuntimeRoot
        CurrentManifestSha256 = if ($currentLabel -ceq 'old') {
            $oldVersionId
        } else {
            $newVersionId
        }
        PreviousVersionId = if ($previousLabel -ceq 'old') {
            $oldVersionId
        } else {
            $newVersionId
        }
        PreviousRoot = $script:pointerPreviousRoot
        PreviousManifestSha256 = if ($previousLabel -ceq 'old') {
            $oldVersionId
        } else {
            $newVersionId
        }
        HasPreviousTaskPreImage = $true
        PreviousTaskPreImageSha256 = $oldTaskXmlSha256
        PreviousTaskPreImageTaskName = 'Codex Local Remote'
        PreviousTaskPreImageRuntimeVersionId = $oldVersionId
        PreviousTaskPreImageRuntimeRoot = $activeRoot
        HasCurrentTaskDefinition =
            $null -ne $script:currentTaskDefinitionSha256
        CurrentTaskDefinitionSha256 =
            $script:currentTaskDefinitionSha256
        CurrentTaskDefinitionTaskName = if (
            $null -eq $script:currentTaskDefinitionSha256
        ) {
            $null
        } else {
            'Codex Local Remote'
        }
        CurrentTaskDefinitionRuntimeVersionId =
            $script:currentTaskDefinitionRuntimeVersionId
        CurrentTaskDefinitionRuntimeRoot =
            $script:currentTaskDefinitionRuntimeRoot
    }
}

function Get-CodexLocalRemoteRuntimeTaskPreImage {
    param(
        [string]$DataDir,
        [string]$ExpectedTaskName,
        [string]$ExpectedRuntimeVersionId,
        [string]$ExpectedRuntimeRoot
    )

    $null = $DataDir
    if ($ExpectedTaskName -cne 'Codex Local Remote' -or
        $ExpectedRuntimeVersionId -cne $oldVersionId -or
        -not [string]::Equals(
            [System.IO.Path]::GetFullPath($ExpectedRuntimeRoot),
            [System.IO.Path]::GetFullPath($activeRoot),
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'fixture rejected mismatched task pre-image expectations'
    }
    return [pscustomobject]@{
        Signature = 'codex-local-remote/runtime-task-preimage/v1'
        Version = 1
        TaskName = 'Codex Local Remote'
        RuntimeVersionId = $oldVersionId
        RuntimeRoot = $activeRoot
        Xml = $oldTaskXml
        XmlSha256 = $oldTaskXmlSha256
    }
}

function Set-CodexLocalRemoteCurrentRuntime {
    param(
        [string]$DataDir,
        [object]$Runtime,
        [object]$PreviousTaskPreImage,
        [object]$CurrentTaskDefinition
    )

    $null = $DataDir
    $runtimeRoot = [System.IO.Path]::GetFullPath(
        [string]$Runtime.RuntimeRoot
    )
    if ((Get-TestRuntimeLabel -RuntimeRoot $runtimeRoot) -ceq
        'unexpected') {
        throw 'fixture pointer update did not identify old or new runtime'
    }
    $runtimeLabel = Get-TestRuntimeLabel -RuntimeRoot $runtimeRoot
    $script:pointerAttempts++
    if ($Mode -ceq 'recovery-selected-binding-repair-fails' -and
        $runtimeLabel -ceq 'new') {
        Add-TestEvent -Value 'pointer-binding-repair-failed:new'
        throw 'selected pointer binding repair injected failure'
    }
    if ($Mode -ceq 'recovery-pointer-fails' -and
        $runtimeLabel -ceq 'old') {
        Add-TestEvent -Value 'pointer-failed:old'
        throw 'pointer update injected failure'
    }
    $previousPointerLabel = Get-TestRuntimeLabel `
        -RuntimeRoot $script:pointerRuntimeRoot
    $script:pointerPreviousRoot = $script:pointerRuntimeRoot
    $script:pointerRuntimeRoot = $runtimeRoot
    if ($PSBoundParameters.ContainsKey('CurrentTaskDefinition')) {
        if ($null -eq $CurrentTaskDefinition) {
            $script:currentTaskDefinitionSha256 = $null
            $script:currentTaskDefinitionRuntimeRoot = $null
            $script:currentTaskDefinitionRuntimeVersionId = $null
        } else {
            $script:currentTaskDefinitionSha256 =
                [string]$CurrentTaskDefinition.XmlSha256
            $script:currentTaskDefinitionRuntimeRoot =
                [string]$CurrentTaskDefinition.RuntimeRoot
            $script:currentTaskDefinitionRuntimeVersionId =
                [string]$CurrentTaskDefinition.RuntimeVersionId
        }
    } elseif ($previousPointerLabel -cne $runtimeLabel) {
        $script:currentTaskDefinitionSha256 = $null
        $script:currentTaskDefinitionRuntimeRoot = $null
        $script:currentTaskDefinitionRuntimeVersionId = $null
    }
    $script:pointerWrites++
    Add-TestEvent -Value (
        'pointer-set:' +
        (Get-TestRuntimeLabel -RuntimeRoot $script:pointerRuntimeRoot)
    )
    if ($Mode -ceq 'recovery-pointer-after-effect-throws' -and
        $runtimeLabel -ceq 'old') {
        throw 'pointer update injected failure after effect'
    }
    return Get-CodexLocalRemoteCurrentRuntime -DataDir $DataDir
}

function Get-CodexLocalRemoteReadinessSnapshot {
    param([int]$Port)

    $script:readinessReads++
    $activeLabel = Get-TestRuntimeLabel `
        -RuntimeRoot $script:activeRuntimeRoot
    $invocation = if (
        $Mode -ceq 'readiness-drift-after-stop' -and
        $script:taskState -cne 'Running' -and
        (Get-TestRuntimeLabel `
            -RuntimeRoot $script:pointerRuntimeRoot) -ceq 'new'
    ) {
        '11111111111111111111111111111111'
    } elseif ($activeLabel -ceq 'old') {
        $oldRuntimeInvocationId
    } else {
        $newRuntimeInvocationId
    }
    $readinessFails = (
        $Mode -ceq 'start-readiness-fails' -and
        $activeLabel -ceq 'new'
    )
    $desktopDetachedDegraded = (
        $Mode -cin @(
            'desktop-detached-degraded-unprepared',
            'desktop-detached-degraded-prepared'
        ) -and
        $activeLabel -ceq 'new'
    )
    $sidecarStopObserved = (
        (Test-Path -LiteralPath $eventLog -PathType Leaf) -and
        @(
            Get-Content -LiteralPath $eventLog |
                Where-Object { $_ -ceq 'sidecar-stop' }
        ).Count -gt 0
    )
    $orphanSidecarStillConnected = (
        $Mode -ceq 'interrupted-task-ready-sidecar-orphan' -and
        -not $sidecarStopObserved
    )
    if ($Mode -ceq
            'interrupted-task-ready-sidecar-delayed-disconnect') {
        if (-not $sidecarStopObserved) {
            $orphanSidecarStillConnected = $true
        } else {
            $script:sidecarDisconnectReads++
            $orphanSidecarStillConnected =
                $script:sidecarDisconnectReads -le 2
        }
    }
    $snapshot = [pscustomobject]@{
        status = if ($readinessFails) {
            'starting'
        } elseif ($desktopDetachedDegraded) {
            'degraded'
        } else {
            'ready'
        }
        appServerReady = -not $readinessFails
        desktopConnected = $false
        sidecarConnected = (
            -not $readinessFails -and
            (
                [string]$script:taskState -ceq 'Running' -or
                $orphanSidecarStillConnected
            )
        )
        degraded = $readinessFails -or $desktopDetachedDegraded
        unknownCount = 0
        unsafeThreadCount = 0
        runtimeInvocationId = $invocation
        brokerProcessId = if ($activeLabel -ceq 'old') {
            $oldBrokerProcessId
        } else {
            $newBrokerProcessId
        }
        upstreamProcessId = if ($activeLabel -ceq 'old') {
            $oldUpstreamProcessId
        } else {
            $newUpstreamProcessId
        }
    }
    if ($Mode -ceq 'selected-pair-drift-after-readiness' -and
        $script:startAttempts -gt 0 -and
        $activeLabel -ceq 'new' -and
        [string]$script:taskState -ceq 'Running') {
        $script:selectedActiveReadinessObservations++
        if (-not $script:selectedPairDriftInjected -and
            $script:selectedActiveReadinessObservations -ge 2) {
            $driftedTask = [xml]$script:taskXml
            $driftedTask.Task.Settings.Priority = '9'
            $script:taskXml = $driftedTask.OuterXml
            $script:selectedPairDriftInjected = $true
            Add-TestEvent -Value 'selected-pair-drifted-during-final-readiness-audit'
        }
    }
    if ($Mode -ceq 'old-pair-drift-after-readiness' -and
        -not $script:oldPairDriftInjected -and
        $script:startAttempts -gt 0 -and
        $activeLabel -ceq 'old' -and
        [string]$script:taskState -ceq 'Running') {
        $script:currentTaskDefinitionSha256 =
            'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
        $script:oldPairDriftInjected = $true
        Add-TestEvent -Value 'old-binding-drifted-after-readiness'
    }
    return $snapshot
}

$script:taskControlTimeouts =
    [System.Collections.Generic.List[int]]::new()
$script:runtimeReadyTimeouts =
    [System.Collections.Generic.List[int]]::new()
$script:originalStartScheduledTaskBounded =
    ${function:Start-CodexLocalRemoteScheduledTaskBounded}
$script:originalWaitScheduledTaskStoppedBounded =
    ${function:Wait-CodexLocalRemoteScheduledTaskStoppedBounded}
$script:originalWaitRuntimeReadyForRoot =
    ${function:Wait-CodexLocalRemoteRuntimeReadyForRoot}

function Start-CodexLocalRemoteScheduledTaskBounded {
    param(
        [string]$Name,
        [int]$TimeoutSeconds = 15
    )

    $script:taskControlTimeouts.Add($TimeoutSeconds)
    & $script:originalStartScheduledTaskBounded @PSBoundParameters
}

function Wait-CodexLocalRemoteScheduledTaskStoppedBounded {
    param(
        [string]$Name,
        [int]$TimeoutSeconds = 15
    )

    $script:taskControlTimeouts.Add($TimeoutSeconds)
    & $script:originalWaitScheduledTaskStoppedBounded @PSBoundParameters
}

function Wait-CodexLocalRemoteRuntimeReadyForRoot {
    param(
        [string]$Name,
        [string]$ExpectedRoot,
        [string]$ForbiddenRoot,
        [string]$ManagedDataDir,
        [int]$ManagedBrokerPort,
        [object]$DesktopHandoffPreparation,
        [int]$TimeoutSeconds = 120
    )

    $script:runtimeReadyTimeouts.Add($TimeoutSeconds)
    if ($Mode -cin @(
            'start-readiness-fails',
            'desktop-detached-degraded-unprepared',
            'desktop-detached-degraded-prepared'
        ) -and
        (Test-CodexLocalRemotePathEqual `
            -Left $ExpectedRoot `
            -Right $selectedRoot)) {
        $acceleratedParameters = @{}
        foreach ($entry in $PSBoundParameters.GetEnumerator()) {
            $acceleratedParameters[$entry.Key] = $entry.Value
        }
        $acceleratedParameters['TimeoutSeconds'] = 1
        return & $script:originalWaitRuntimeReadyForRoot `
            @acceleratedParameters
    }
    & $script:originalWaitRuntimeReadyForRoot @PSBoundParameters
}

$env:CODEX_HANDOFF_TEST_EVENT_LOG = $eventLog
$env:CODEX_HANDOFF_TEST_MODE = $Mode
$succeeded = $false
$errorMessage = $null
try {
    Switch-CodexLocalRemoteRuntimeGeneration `
        -Name 'Codex Local Remote' `
        -Generation $generation `
        -ManagedDataDir $dataDir `
        -ManagedSidecarPort 18790 `
        -ManagedBrokerPort 18791 `
        -ManagedBrokerUpstreamPort 18795 `
        -ManagedBasePath '/codex-remote' `
        -DesktopHandoffPreparation $desktopHandoffPreparation `
        -TimeoutSeconds $TaskControlTimeoutSeconds `
        -RuntimeReadyTimeoutSeconds $RuntimeReadyTimeoutSeconds
    $succeeded = $true
} catch {
    $errorMessage = $_.Exception.Message
} finally {
    Remove-Item Env:CODEX_HANDOFF_TEST_EVENT_LOG `
        -ErrorAction SilentlyContinue
    Remove-Item Env:CODEX_HANDOFF_TEST_MODE `
        -ErrorAction SilentlyContinue
}

$finalReadiness = Get-CodexLocalRemoteReadinessSnapshot -Port 18791
$finalTaskXmlSha256 = Get-StringSha256 -Value $script:taskXml
$pointerRuntimeLabel = Get-TestRuntimeLabel `
    -RuntimeRoot $script:pointerRuntimeRoot
$taskRuntimeLabel = Get-TestRuntimeLabel `
    -RuntimeRoot $script:taskRuntimeRoot
$activeRuntimeLabel = Get-TestRuntimeLabel `
    -RuntimeRoot $script:activeRuntimeRoot
$exactOldTaskXml = $finalTaskXmlSha256 -ceq $oldTaskXmlSha256
$exactSelectedTaskXml =
    $finalTaskXmlSha256 -ceq $selectedTaskXmlSha256
$priorTaskBindingVerified = (
    $pointerRuntimeLabel -ceq 'old' -and
    [string]$script:currentTaskDefinitionRuntimeVersionId -ceq
        $oldVersionId -and
    [string]::Equals(
        [System.IO.Path]::GetFullPath(
            [string]$script:currentTaskDefinitionRuntimeRoot
        ),
        [System.IO.Path]::GetFullPath($activeRoot),
        [System.StringComparison]::OrdinalIgnoreCase
    ) -and
    [string]$script:currentTaskDefinitionSha256 -ceq
        $oldTaskXmlSha256
)
$selectedTaskBindingVerified = (
    $pointerRuntimeLabel -ceq 'new' -and
    [string]$script:currentTaskDefinitionRuntimeVersionId -ceq
        $newVersionId -and
    [string]::Equals(
        [System.IO.Path]::GetFullPath(
            [string]$script:currentTaskDefinitionRuntimeRoot
        ),
        [System.IO.Path]::GetFullPath($selectedRoot),
        [System.StringComparison]::OrdinalIgnoreCase
    ) -and
    [string]$script:currentTaskDefinitionSha256 -ceq
        $selectedTaskXmlSha256
)
$pairState = if ($pointerRuntimeLabel -ceq $taskRuntimeLabel) {
    $pointerRuntimeLabel
} else {
    'mixed'
}
$priorRuntimeVerified = (
    [string]$script:taskState -ceq 'Running' -and
    $pointerRuntimeLabel -ceq 'old' -and
    $taskRuntimeLabel -ceq 'old' -and
    $activeRuntimeLabel -ceq 'old' -and
    $exactOldTaskXml -and
    $priorTaskBindingVerified -and
    (Test-CodexLocalRemoteInfrastructureSnapshot `
        -Readiness $finalReadiness) -and
    [string]$finalReadiness.runtimeInvocationId -ceq
        $oldRuntimeInvocationId -and
    [int]$finalReadiness.brokerProcessId -eq
        $oldBrokerProcessId -and
    [int]$finalReadiness.upstreamProcessId -eq
        $oldUpstreamProcessId
)
$selectedPairVerified = (
    $pointerRuntimeLabel -ceq 'new' -and
    $taskRuntimeLabel -ceq 'new' -and
    $exactSelectedTaskXml -and
    $selectedTaskBindingVerified
)
if (-not $succeeded -and
    $errorMessage -match '(?i)\brestored\b' -and
    -not $priorRuntimeVerified) {
    $errorMessage = 'fixture detected a prior-runtime recovery invariant violation'
}

$events = @()
if (Test-Path -LiteralPath $eventLog -PathType Leaf) {
    $events = @(Get-Content -LiteralPath $eventLog)
}
[pscustomobject]@{
    Mode = $Mode
    Succeeded = $succeeded
    Error = $errorMessage
    TaskState = $script:taskState
    PointerRuntime = $pointerRuntimeLabel
    TaskRuntime = $taskRuntimeLabel
    ActiveRuntime = $activeRuntimeLabel
    PairState = $pairState
    PriorRuntimeVerified = $priorRuntimeVerified
    SelectedPairVerified = $selectedPairVerified
    PriorTaskBindingVerified = $priorTaskBindingVerified
    SelectedTaskBindingVerified = $selectedTaskBindingVerified
    ExactOldTaskXml = $exactOldTaskXml
    ExactSelectedTaskXml = $exactSelectedTaskXml
    TaskXmlSha256 = $finalTaskXmlSha256
    OldTaskXmlSha256 = $oldTaskXmlSha256
    SelectedTaskXmlSha256 = $selectedTaskXmlSha256
    StartAttempts = $script:startAttempts
    StopAttempts = $script:stopAttempts
    RegisterAttempts = $script:registerAttempts
    PointerAttempts = $script:pointerAttempts
    PointerWrites = $script:pointerWrites
    DesktopReads = $script:desktopReads
    GenerationReads = $script:generationReads
    ReadinessReads = $script:readinessReads
    TaskControlTimeouts = [int[]]$script:taskControlTimeouts.ToArray()
    RuntimeReadyTimeouts = [int[]]$script:runtimeReadyTimeouts.ToArray()
    FirstDelayedTaskObservation =
        $script:firstDelayedTaskObservation
    FirstDelayedGenerationObservation =
        $script:firstDelayedGenerationObservation
    CleanupSilentReadsBeforeOldRestore =
        $script:cleanupSilentReadsBeforeOldRestore
    ActiveRuntimeBeforeOldRestore =
        $script:activeRuntimeBeforeOldRestore
    Events = [object[]]$events
} | ConvertTo-Json -Depth 20 -Compress
