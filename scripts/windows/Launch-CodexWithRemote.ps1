[CmdletBinding()]
param(
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexLocalRemote'),

    [ValidateRange(1, 65535)]
    [int]$BrokerPort = 18791,

    [ValidateRange(1, 65535)]
    [int]$SidecarPort = 18790,

    [ValidateRange(1, 65535)]
    [int]$BrokerUpstreamPort = 18792,

    [string]$BasePath = '/codex-remote',

    [string]$TaskName = 'Codex Local Remote',

    [ValidateRange(0, 60)]
    [int]$InfrastructureStartupTimeoutSeconds = 30,

    [ValidateRange(1, 60)]
    [int]$DesktopAttachTimeoutSeconds = 15,

    [switch]$SuppressNotification,

    [switch]$NotifyOnRemoteSuccessOnly,

    [switch]$TakeOverExistingNativeDesktop,

    [switch]$RequestDesktopLaunch,

    [Parameter(DontShow)]
    [switch]$DesktopOwnerExecution,

    [Parameter(DontShow)]
    [ValidateRange(1, 30)]
    [int]$DesktopOwnerRequestAckTimeoutSeconds = 8,

    [Parameter(DontShow)]
    [ValidateRange(1, 30)]
    [int]$DesktopExitDrainTimeoutSeconds = 8,

    [Parameter(DontShow)]
    [string]$ExpectedTakeoverRootIdentityKey,

    [Parameter(DontShow)]
    [AllowEmptyString()]
    [string]$ExpectedSelectedRuntimeVersionId = '',

    [Parameter(DontShow)]
    [AllowEmptyString()]
    [string]$ExpectedSelectedRuntimeRoot = '',

    [Parameter(DontShow)]
    [AllowEmptyString()]
    [ValidatePattern('^(?:|[0-9a-f]{32})$')]
    [string]$LaunchCorrelationId = '',

    [Parameter(DontShow)]
    [switch]$DefinitionOnly
)

$ErrorActionPreference = 'Stop'
$script:WindowsModuleAvailable = $false
try {
    Import-Module `
        (Join-Path $PSScriptRoot 'CodexLocalRemote.Windows.psm1') `
        -Force `
        -ErrorAction Stop
    $script:WindowsModuleAvailable = $true
} catch {
    # The native Desktop fallback below deliberately remains available even if
    # the optional Remote integration module cannot load.
}
if ($script:WindowsModuleAvailable) {
    try {
        $managedConfiguration = Get-CodexLocalRemoteManagedConfiguration `
            -DataDir $DataDir
        if ($null -ne $managedConfiguration) {
            if (-not $PSBoundParameters.ContainsKey('SidecarPort')) {
                $SidecarPort = [int]$managedConfiguration.SidecarPort
            }
            if (-not $PSBoundParameters.ContainsKey('BrokerPort')) {
                $BrokerPort = [int]$managedConfiguration.BrokerPort
            }
            if (-not $PSBoundParameters.ContainsKey('BrokerUpstreamPort')) {
                $BrokerUpstreamPort =
                    [int]$managedConfiguration.BrokerUpstreamPort
            }
            if (-not $PSBoundParameters.ContainsKey('BasePath')) {
                $BasePath = [string]$managedConfiguration.BasePath
            }
            if (-not $PSBoundParameters.ContainsKey('TaskName')) {
                $TaskName = [string]$managedConfiguration.TaskName
            }
        }
    } catch {
        # Invalid managed state disables only Remote. Native Desktop remains
        # available through the fail-open path below.
        $script:WindowsModuleAvailable = $false
    }
}

function Get-RunningCodexDesktopProcesses {
    [CmdletBinding()]
    param()

    return @(
        Get-CimInstance `
            Win32_Process `
            -Filter "Name = 'ChatGPT.exe'" `
            -ErrorAction SilentlyContinue |
            Where-Object {
                $path = [string]$_.ExecutablePath
                [string]::IsNullOrWhiteSpace($path) -or
                $path -match
                    '(?i)\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$'
            }
    )
}

function Get-CodexDesktopHandoffProcesses {
    [CmdletBinding()]
    param()

    return @(
        Get-CimInstance `
            Win32_Process `
            -Filter "Name = 'ChatGPT.exe'" `
            -ErrorAction Stop |
            Where-Object {
                $path = [string]$_.ExecutablePath
                [string]::IsNullOrWhiteSpace($path) -or
                $path -match
                    '(?i)\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$'
            }
    )
}

function Resolve-NativeCodexDesktopRuntime {
    [CmdletBinding()]
    param()

    $packages = @(
        Get-AppxPackage `
            -Name 'OpenAI.Codex' `
            -ErrorAction Stop |
            Where-Object {
                [string]$_.PackageFamilyName -ceq
                    'OpenAI.Codex_2p2nqsd0c76g0' -and
                [string]$_.Status -ceq 'Ok' -and
                -not [string]::IsNullOrWhiteSpace(
                    [string]$_.InstallLocation
                )
            } |
            Sort-Object Version -Descending
    )
    if ($packages.Count -eq 0) {
        throw 'No healthy Codex Desktop package is registered for this user.'
    }
    $desktopExecutablePath = [System.IO.Path]::GetFullPath(
        (Join-Path ([string]$packages[0].InstallLocation) 'app\ChatGPT.exe')
    )
    if (-not (Test-Path -LiteralPath $desktopExecutablePath -PathType Leaf)) {
        throw "The native Codex Desktop executable is missing at '$desktopExecutablePath'."
    }
    return [pscustomobject]@{
        DesktopExecutablePath = $desktopExecutablePath
        RemoteRuntimeVerified = $false
    }
}

function Get-CodexLocalRemoteReadinessSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$Port
    )

    try {
        return Invoke-RestMethod `
            -Method Get `
            -Uri "http://127.0.0.1:$Port/ready" `
            -TimeoutSec 1
    } catch {
        return $null
    }
}

function Test-CodexLocalRemoteInfrastructureSnapshot {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Readiness
    )

    if ($null -eq $Readiness) {
        return $false
    }
    $required = @(
        'status',
        'appServerReady',
        'desktopConnected',
        'sidecarConnected',
        'degraded',
        'unknownCount',
        'runtimeInvocationId',
        'brokerProcessId',
        'upstreamProcessId'
    )
    foreach ($name in $required) {
        if ($null -eq $Readiness.PSObject.Properties[$name]) {
            return $false
        }
    }
    return (
        [string]$Readiness.status -ceq 'ready' -and
        $Readiness.appServerReady -is [bool] -and
        [bool]$Readiness.appServerReady -and
        $Readiness.desktopConnected -is [bool] -and
        $Readiness.sidecarConnected -is [bool] -and
        [bool]$Readiness.sidecarConnected -and
        $Readiness.degraded -is [bool] -and
        -not [bool]$Readiness.degraded -and
        (Test-NonNegativeInteger -Value $Readiness.unknownCount) -and
        [decimal]$Readiness.unknownCount -eq 0 -and
        [string]$Readiness.runtimeInvocationId -cmatch '^[0-9a-f]{32}$' -and
        (Test-NonNegativeInteger -Value $Readiness.brokerProcessId) -and
        [decimal]$Readiness.brokerProcessId -gt 0 -and
        (Test-NonNegativeInteger -Value $Readiness.upstreamProcessId) -and
        [decimal]$Readiness.upstreamProcessId -gt 0
    )
}

function Test-CodexLocalRemotePreparedInfrastructureSnapshot {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Readiness
    )

    if ($null -eq $Readiness) {
        return $false
    }
    $required = @(
        'status',
        'appServerReady',
        'desktopConnected',
        'sidecarConnected',
        'degraded',
        'unknownCount',
        'unsafeThreadCount',
        'runtimeInvocationId',
        'brokerProcessId',
        'upstreamProcessId'
    )
    foreach ($name in $required) {
        if ($null -eq $Readiness.PSObject.Properties[$name]) {
            return $false
        }
    }
    if ($Readiness.degraded -isnot [bool]) {
        return $false
    }
    $expectedStatus = if ([bool]$Readiness.degraded) {
        'degraded'
    } else {
        'ready'
    }
    return (
        [string]$Readiness.status -ceq $expectedStatus -and
        $Readiness.appServerReady -is [bool] -and
        [bool]$Readiness.appServerReady -and
        $Readiness.desktopConnected -is [bool] -and
        -not [bool]$Readiness.desktopConnected -and
        $Readiness.sidecarConnected -is [bool] -and
        [bool]$Readiness.sidecarConnected -and
        (Test-NonNegativeInteger -Value $Readiness.unknownCount) -and
        [decimal]$Readiness.unknownCount -eq 0 -and
        (Test-NonNegativeInteger -Value $Readiness.unsafeThreadCount) -and
        [decimal]$Readiness.unsafeThreadCount -eq 0 -and
        [string]$Readiness.runtimeInvocationId -cmatch '^[0-9a-f]{32}$' -and
        (Test-NonNegativeInteger -Value $Readiness.brokerProcessId) -and
        [decimal]$Readiness.brokerProcessId -gt 0 -and
        (Test-NonNegativeInteger -Value $Readiness.upstreamProcessId) -and
        [decimal]$Readiness.upstreamProcessId -gt 0
    )
}

function Test-CodexLocalRemoteSameGeneration {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Before,

        [AllowNull()]
        [object]$After
    )

    return (
        (Test-CodexLocalRemoteInfrastructureSnapshot -Readiness $Before) -and
        (Test-CodexLocalRemoteInfrastructureSnapshot -Readiness $After) -and
        [string]$After.runtimeInvocationId -ceq
            [string]$Before.runtimeInvocationId -and
        [decimal]$After.brokerProcessId -eq
            [decimal]$Before.brokerProcessId -and
        [decimal]$After.upstreamProcessId -eq
            [decimal]$Before.upstreamProcessId
    )
}

function Get-CodexLocalRemoteRegisteredBootstrapEvidence {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [object]$SelectedRuntime,

        [Parameter(Mandatory)]
        [object]$Receipt,

        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedSidecarPort,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerPort,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerUpstreamPort,

        [Parameter(Mandatory)]
        [string]$ManagedBasePath
    )

    try {
        $task = Get-ScheduledTask `
            -TaskName $Name `
            -TaskPath '\' `
            -ErrorAction Stop
        $taskXml = [string](
            Export-ScheduledTask `
                -TaskName $Name `
                -TaskPath '\' `
                -ErrorAction Stop
        )
        $taskXmlSha256 = Get-StringSha256 -Value $taskXml
        if (-not [bool]$SelectedRuntime.HasCurrentTaskDefinition -or
            [string]$SelectedRuntime.CurrentTaskDefinitionTaskName -cne
                $Name -or
            [string]$SelectedRuntime.CurrentTaskDefinitionRuntimeVersionId -cne
                [string]$SelectedRuntime.CurrentVersionId -or
            -not (Test-CodexLocalRemotePathEqual `
                -Left (
                    [string]$SelectedRuntime.CurrentTaskDefinitionRuntimeRoot
                ) `
                -Right ([string]$SelectedRuntime.CurrentRoot)) -or
            [string]$SelectedRuntime.CurrentTaskDefinitionSha256 -cne
                $taskXmlSha256) {
            throw 'The registered task is not hash-bound to the selected runtime.'
        }

        $actions = @($task.Actions)
        if ($actions.Count -ne 1) {
            throw 'The registered task does not contain exactly one action.'
        }
        $taskArguments = @(
            ConvertFrom-WindowsCommandLine `
                -CommandLine ([string]$actions[0].Arguments)
        )
        if ($taskArguments.Count -lt 3 -or
            [string]$taskArguments[0] -cne '--headless') {
            throw 'The registered task does not expose one headless PowerShell action.'
        }
        $pwshPath = [System.IO.Path]::GetFullPath(
            [string]$taskArguments[1]
        )
        $expected = Get-StartupTaskDefinition `
            -TaskName $Name `
            -NodePath ([string]$Receipt.NodePath) `
            -PwshPath $pwshPath `
            -InstallRoot ([string]$SelectedRuntime.CurrentRoot) `
            -DataDir $ManagedDataDir `
            -Port $ManagedSidecarPort `
            -BrokerPort $ManagedBrokerPort `
            -BrokerUpstreamPort $ManagedBrokerUpstreamPort `
            -BasePath $ManagedBasePath
        $ownership = Test-ManagedStartupTask `
            -Task $task `
            -Expected $expected
        if (-not [bool]$ownership.IsManaged) {
            throw (
                'The registered task is not the exact V5 definition: ' +
                ($ownership.Mismatches -join ', ')
            )
        }
        return [pscustomobject]@{
            Status = 'exact-v5'
            Task = $task
            TaskState = [string]$task.State
            TaskXml = $taskXml
            TaskXmlSha256 = $taskXmlSha256
            PwshPath = $pwshPath
            Expected = $expected
        }
    } catch {
        return [pscustomobject]@{
            Status = 'unverified'
            Reason = [string]$_.Exception.Message
        }
    }
}

function Get-CodexLocalRemoteActiveBootstrapEvidence {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Receipt,

        [Parameter(Mandatory)]
        [object]$RegisteredTask,

        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [string]$RuntimeRoot,

        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedSidecarPort,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerPort,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerUpstreamPort,

        [Parameter(Mandatory)]
        [string]$ManagedBasePath
    )

    try {
        $bootstrap = $Receipt.Bootstrap
        foreach ($property in @(
            'RuntimeInvocationId',
            'ProcessId',
            'CreationDate',
            'CreationDateUtcTicks',
            'ProcessStartTimeUtcTicks'
        )) {
            if ($null -eq $bootstrap.PSObject.Properties[$property]) {
                throw "The active bootstrap receipt lacks '$property'."
            }
        }
        if ([string]$bootstrap.RuntimeInvocationId -cne
                [string]$Receipt.RuntimeInvocationId -or
            -not (Test-NonNegativeInteger -Value $bootstrap.ProcessId) -or
            [decimal]$bootstrap.ProcessId -le 0 -or
            -not (Test-NonNegativeInteger `
                -Value $bootstrap.CreationDateUtcTicks) -or
            [decimal]$bootstrap.CreationDateUtcTicks -le 0 -or
            -not (Test-NonNegativeInteger `
                -Value $bootstrap.ProcessStartTimeUtcTicks) -or
            [decimal]$bootstrap.ProcessStartTimeUtcTicks -le 0) {
            throw 'The active bootstrap receipt identity is invalid.'
        }
        $processes = @(
            Get-CimInstance `
                Win32_Process `
                -Filter "ProcessId = $([int]$bootstrap.ProcessId)" `
                -ErrorAction Stop
        )
        if ($processes.Count -ne 1 -or
            [int]$processes[0].ProcessId -ne [int]$bootstrap.ProcessId) {
            throw 'The active bootstrap PID is absent or ambiguous.'
        }
        $process = $processes[0]
        $creation = Get-ProcessCreationIdentity `
            -CreationDate $process.CreationDate
        if ([long]$creation.CreationDateUtcTicks -ne
            [long]$bootstrap.CreationDateUtcTicks) {
            throw 'The active bootstrap CIM creation identity changed.'
        }
        $identityHandle = Open-ProcessIdentityHandle `
            -ProcessId ([int]$bootstrap.ProcessId) `
            -ExpectedCreationDateUtcTicks (
                [long]$bootstrap.CreationDateUtcTicks
            ) `
            -ExpectedStartTimeUtcTicks (
                [long]$bootstrap.ProcessStartTimeUtcTicks
            )
        try {
            $contract = Get-ManagedBootstrapProcessContract `
                -CommandLine ([string]$process.CommandLine) `
                -ExecutablePath ([string]$process.ExecutablePath) `
                -TaskName $Name `
                -NodePath ([string]$Receipt.NodePath) `
                -PwshPath ([string]$RegisteredTask.PwshPath) `
                -InstallRoot $RuntimeRoot `
                -DataDir $ManagedDataDir `
                -Port $ManagedSidecarPort `
                -BrokerPort $ManagedBrokerPort `
                -BrokerUpstreamPort $ManagedBrokerUpstreamPort `
                -BasePath $ManagedBasePath
        } finally {
            if ($null -ne $identityHandle -and
                $null -ne $identityHandle.Process -and
                $null -ne $identityHandle.Process.PSObject.Methods['Dispose']) {
                $identityHandle.Process.Dispose()
            }
        }
        if (-not [bool]$contract.IsManaged) {
            throw 'The active bootstrap command line is not an exact managed contract.'
        }
        return [pscustomobject]@{
            Status = 'verified'
            Contract = [string]$contract.Contract
            ProcessId = [int]$bootstrap.ProcessId
            CreationDateUtcTicks =
                [long]$bootstrap.CreationDateUtcTicks
            ProcessStartTimeUtcTicks =
                [long]$bootstrap.ProcessStartTimeUtcTicks
            RuntimeInvocationId = [string]$bootstrap.RuntimeInvocationId
        }
    } catch {
        return [pscustomobject]@{
            Status = 'unverified'
            Contract = 'unverified'
            Reason = [string]$_.Exception.Message
        }
    }
}

function Get-CodexLocalRemoteRuntimeGenerationStatus {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ManagedDataDir
    )

    $resolvedDataDir = [System.IO.Path]::GetFullPath($ManagedDataDir)
    $selected = Get-CodexLocalRemoteCurrentRuntime -DataDir $resolvedDataDir
    if ($null -eq $selected) {
        return [pscustomobject]@{ Status = 'missing-selected-runtime' }
    }
    $statePath = Join-Path $resolvedDataDir 'app-server-broker.json'
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        return [pscustomobject]@{
            Status = 'active-receipt-missing'
            SelectedRoot = [string]$selected.CurrentRoot
        }
    }
    $item = Get-Item -LiteralPath $statePath -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [long]$item.Length -lt 64 -or
        [long]$item.Length -gt 65536) {
        throw "Active Broker receipt '$statePath' is not an ordinary bounded file."
    }
    $state = Get-Content -LiteralPath $statePath -Raw -Encoding utf8 |
        ConvertFrom-Json -Depth 20 -ErrorAction Stop
    foreach ($property in @(
        'Signature',
        'Version',
        'BrokerCliPath',
        'NodePath',
        'CodexPath'
    )) {
        if ($null -eq $state.PSObject.Properties[$property]) {
            throw "Active Broker receipt '$statePath' lacks '$property'."
        }
    }
    if ([string]$state.Signature -cne
            'codex-local-remote/app-server-broker/v3' -or
        [int]$state.Version -ne 3) {
        throw "Active Broker receipt '$statePath' has an unsupported schema."
    }
    $activeBrokerCli = [System.IO.Path]::GetFullPath(
        [string]$state.BrokerCliPath
    )
    $selectedBrokerCli = [System.IO.Path]::GetFullPath(
        (Join-Path ([string]$selected.CurrentRoot) 'apps\broker\dist\cli.js')
    )
    if ([string]::Equals(
        $activeBrokerCli,
        $selectedBrokerCli,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        $registeredTask =
            Get-CodexLocalRemoteRegisteredBootstrapEvidence `
                -Name $TaskName `
                -SelectedRuntime $selected `
                -Receipt $state `
                -ManagedDataDir $resolvedDataDir `
                -ManagedSidecarPort $SidecarPort `
                -ManagedBrokerPort $BrokerPort `
                -ManagedBrokerUpstreamPort $BrokerUpstreamPort `
                -ManagedBasePath $BasePath
        if ([string]$registeredTask.Status -cne 'exact-v5') {
            return [pscustomobject]@{
                Status = 'registered-task-unverified'
                SelectedRoot = [string]$selected.CurrentRoot
                ActiveRoot = [string]$selected.CurrentRoot
                Receipt = $state
            }
        }
        $activeBootstrap = $null
        if ([string]$registeredTask.TaskState -ceq 'Running') {
            $activeBootstrap =
                Get-CodexLocalRemoteActiveBootstrapEvidence `
                    -Receipt $state `
                    -RegisteredTask $registeredTask `
                    -Name $TaskName `
                    -RuntimeRoot ([string]$selected.CurrentRoot) `
                    -ManagedDataDir $resolvedDataDir `
                    -ManagedSidecarPort $SidecarPort `
                    -ManagedBrokerPort $BrokerPort `
                    -ManagedBrokerUpstreamPort $BrokerUpstreamPort `
                    -ManagedBasePath $BasePath
            if ([string]$activeBootstrap.Status -cne 'verified') {
                return [pscustomobject]@{
                    Status = 'active-bootstrap-unverified'
                    SelectedRoot = [string]$selected.CurrentRoot
                    ActiveRoot = [string]$selected.CurrentRoot
                    Receipt = $state
                    RegisteredTask = $registeredTask
                }
            }
            if ([string]$activeBootstrap.Contract -cin @(
                'desktop-owner-v3',
                'headless-v4'
            )) {
                return [pscustomobject]@{
                    Status = 'activation-required'
                    SelectedRoot = [string]$selected.CurrentRoot
                    ActiveRoot = [string]$selected.CurrentRoot
                    Receipt = $state
                    RegisteredTask = $registeredTask
                    ActiveBootstrap = $activeBootstrap
                }
            }
            if ([string]$activeBootstrap.Contract -cne 'desktop-owner-v5') {
                return [pscustomobject]@{
                    Status = 'active-bootstrap-unverified'
                    SelectedRoot = [string]$selected.CurrentRoot
                    ActiveRoot = [string]$selected.CurrentRoot
                    Receipt = $state
                    RegisteredTask = $registeredTask
                }
            }
        }
        return [pscustomobject]@{
            Status = 'current'
            SelectedRoot = [string]$selected.CurrentRoot
            ActiveRoot = [string]$selected.CurrentRoot
            Receipt = $state
            RegisteredTask = $registeredTask
            ActiveBootstrap = $activeBootstrap
        }
    }

    $activeRoot = $activeBrokerCli
    foreach ($level in 1..4) {
        $activeRoot = Split-Path -Parent $activeRoot
    }
    $activeRoot = [System.IO.Path]::GetFullPath($activeRoot)
    $versionsRoot = [System.IO.Path]::GetFullPath(
        (Join-Path $resolvedDataDir 'RuntimeVersions')
    )
    if (-not $activeRoot.StartsWith(
        "$versionsRoot$([System.IO.Path]::DirectorySeparatorChar)",
        [System.StringComparison]::OrdinalIgnoreCase
    ) -or
        -not [string]::Equals(
            $activeBrokerCli,
            [System.IO.Path]::GetFullPath(
                (Join-Path $activeRoot 'apps\broker\dist\cli.js')
            ),
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'The active Broker receipt does not identify a managed immutable runtime.'
    }
    $activeValidation = Test-CodexLocalRemoteRuntimeVersion `
        -RuntimeRoot $activeRoot
    if (-not $activeValidation.IsValid) {
        throw "The active immutable runtime is invalid: $($activeValidation.Reason)."
    }
    return [pscustomobject]@{
        Status = 'transition-required'
        SelectedRoot = [string]$selected.CurrentRoot
        ActiveRoot = $activeRoot
        Receipt = $state
    }
}

function Get-CodexLocalRemoteActiveCodexRuntimeStatus {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [object]$Generation,

        [Parameter(Mandatory)]
        [object]$CurrentRuntime
    )

    try {
        if ([string]$Generation.Status -cne 'current' -or
            $null -eq $Generation.Receipt -or
            [string]$Generation.Receipt.RuntimeInvocationId -cnotmatch
                '^[0-9a-f]{32}$') {
            throw 'The active Local Remote generation is not exact and current.'
        }
        $activeRuntime = $null
        if ($null -ne $Generation.Receipt.PSObject.Properties['CodexRuntime']) {
            $activeRuntime = $Generation.Receipt.CodexRuntime
        }
        if ($null -eq $activeRuntime) {
            $startupPath = Join-Path `
                ([System.IO.Path]::GetFullPath($ManagedDataDir)) `
                'startup-last.json'
            $item = Get-Item -LiteralPath $startupPath -Force -ErrorAction Stop
            if ($item.PSIsContainer -or
                ($item.Attributes -band
                    [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
                [long]$item.Length -lt 64 -or
                [long]$item.Length -gt 65536) {
                throw 'The startup runtime receipt is not an ordinary bounded file.'
            }
            $rawBefore = Get-Content `
                -LiteralPath $startupPath `
                -Raw `
                -Encoding utf8
            $startup = $rawBefore |
                ConvertFrom-Json -Depth 20 -DateKind String -ErrorAction Stop
            $rawAfter = Get-Content `
                -LiteralPath $startupPath `
                -Raw `
                -Encoding utf8
            if ($rawBefore -cne $rawAfter -or
                [string]$startup.Signature -cne
                    'codex-local-remote/startup-status/v3' -or
                [int]$startup.Version -ne 3 -or
                [string]$startup.RuntimeInvocationId -cne
                    [string]$Generation.Receipt.RuntimeInvocationId) {
                throw 'The startup runtime receipt is stale or changed.'
            }
            $activeRuntime = $startup.Runtime
        }
        foreach ($runtime in @($activeRuntime, $CurrentRuntime)) {
            if ($null -eq $runtime -or
                [string]$runtime.Signature -cne
                    'codex-local-remote/codex-desktop-runtime/v1' -or
                [string]$runtime.PackageFullName -notmatch
                    '^OpenAI\.Codex_.+__2p2nqsd0c76g0$' -or
                [string]$runtime.DesktopExecutableSha256 -cnotmatch
                    '^[0-9A-F]{64}$' -or
                [string]$runtime.BundledCodexSha256 -cnotmatch
                    '^[0-9A-F]{64}$' -or
                [string]$runtime.CodexSha256 -cnotmatch
                    '^[0-9A-F]{64}$') {
                throw 'A Codex runtime identity is incomplete or invalid.'
            }
        }
        $pathPairs = @(
            @(
                [string]$activeRuntime.DesktopExecutablePath,
                [string]$CurrentRuntime.DesktopExecutablePath
            ),
            @(
                [string]$activeRuntime.BundledCodexPath,
                [string]$CurrentRuntime.BundledCodexPath
            ),
            @(
                [string]$activeRuntime.CodexPath,
                [string]$CurrentRuntime.CodexPath
            )
        )
        $pathsMatch = $true
        foreach ($pair in $pathPairs) {
            if (-not (Test-CodexLocalRemotePathEqual `
                -Left $pair[0] `
                -Right $pair[1])) {
                $pathsMatch = $false
                break
            }
        }
        $isCurrent = (
            $pathsMatch -and
            [string]$activeRuntime.PackageFullName -ceq
                [string]$CurrentRuntime.PackageFullName -and
            [string]$activeRuntime.DesktopExecutableSha256 -ceq
                [string]$CurrentRuntime.DesktopExecutableSha256 -and
            [string]$activeRuntime.BundledCodexSha256 -ceq
                [string]$CurrentRuntime.BundledCodexSha256 -and
            [string]$activeRuntime.CodexSha256 -ceq
                [string]$CurrentRuntime.CodexSha256
        )
        return [pscustomobject]@{
            Status = $(if ($isCurrent) { 'current' } else { 'drifted' })
            ActiveRuntime = $activeRuntime
            CurrentRuntime = $CurrentRuntime
            RuntimeInvocationId =
                [string]$Generation.Receipt.RuntimeInvocationId
        }
    } catch {
        return [pscustomobject]@{
            Status = 'unverified'
            Reason = [string]$_.Exception.Message
        }
    }
}

function Test-CodexLocalRemoteCodexRuntimeRestartSafe {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Readiness,

        [AllowNull()]
        [object]$Generation
    )

    if ($null -eq $Readiness -or
        $null -eq $Generation -or
        [string]$Generation.Status -cne 'current' -or
        $null -eq $Generation.Receipt) {
        return $false
    }
    foreach ($property in @(
        'status',
        'appServerReady',
        'desktopConnected',
        'sidecarConnected',
        'degraded',
        'unknownCount',
        'unsafeThreadCount',
        'runtimeInvocationId',
        'brokerProcessId',
        'upstreamProcessId'
    )) {
        if ($null -eq $Readiness.PSObject.Properties[$property]) {
            return $false
        }
    }
    return (
        [string]$Readiness.status -ceq 'ready' -and
        $Readiness.appServerReady -is [bool] -and
        [bool]$Readiness.appServerReady -and
        $Readiness.desktopConnected -is [bool] -and
        -not [bool]$Readiness.desktopConnected -and
        $Readiness.sidecarConnected -is [bool] -and
        [bool]$Readiness.sidecarConnected -and
        $Readiness.degraded -is [bool] -and
        -not [bool]$Readiness.degraded -and
        (Test-NonNegativeInteger -Value $Readiness.unknownCount) -and
        [decimal]$Readiness.unknownCount -eq 0 -and
        (Test-NonNegativeInteger -Value $Readiness.unsafeThreadCount) -and
        [decimal]$Readiness.unsafeThreadCount -eq 0 -and
        [string]$Readiness.runtimeInvocationId -ceq
            [string]$Generation.Receipt.RuntimeInvocationId -and
        [int]$Readiness.brokerProcessId -eq
            [int]$Generation.Receipt.ProcessId -and
        [int]$Readiness.upstreamProcessId -eq
            [int]$Generation.Receipt.Upstream.ProcessId
    )
}

function Get-CodexLocalRemoteRuntimeHandoffDecision {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$TaskState,

        [Parameter(Mandatory)]
        [string]$GenerationStatus,

        [ValidateRange(0, 1024)]
        [int]$DesktopProcessCount = 0
    )

    if ($GenerationStatus -cin @(
        'transition-required',
        'activation-required'
    )) {
        return $(if ($DesktopProcessCount -eq 0) {
            'switch'
        } else {
            'block-desktop-running'
        })
    }
    if ($GenerationStatus -cin @(
        'registered-task-unverified',
        'active-bootstrap-unverified'
    )) {
        return 'block-unverified-generation'
    }
    if ($TaskState -cne 'Running') {
        return 'start'
    }
    if ($GenerationStatus -ceq 'current') {
        return 'reuse'
    }
    return 'block-unverified-generation'
}

function Invoke-CodexLocalRemoteCodexRuntimeGate {
    [CmdletBinding()]
    param(
        [ValidateRange(0, 1024)]
        [int]$DesktopProcessCount,

        [Parameter(Mandatory)]
        [scriptblock]$ResolveCurrentRuntimeAction,

        [Parameter(Mandatory)]
        [scriptblock]$GetActiveRuntimeStatusAction,

        [Parameter(Mandatory)]
        [scriptblock]$GetRestartSafetyStatusAction,

        [AllowNull()]
        [scriptblock]$DelegateFreshTakeoverAction,

        [Parameter(Mandatory)]
        [scriptblock]$RestartRuntimeAction
    )

    try {
        $currentRuntime = & $ResolveCurrentRuntimeAction
    } catch {
        throw (New-CodexRemoteFailureException `
            -Stage 'runtime-handoff' `
            -Code 'runtime-generation-unverified')
    }
    if ($null -eq $currentRuntime -or
        [string]$currentRuntime.Signature -cne
            'codex-local-remote/codex-desktop-runtime/v1' -or
        [string]$currentRuntime.PackageFullName -notmatch
            '^OpenAI\.Codex_.+__2p2nqsd0c76g0$' -or
        [string]$currentRuntime.CodexSha256 -cnotmatch '^[0-9A-F]{64}$') {
        throw (New-CodexRemoteFailureException `
            -Stage 'runtime-handoff' `
            -Code 'runtime-generation-unverified')
    }
    try {
        $activeStatus = & $GetActiveRuntimeStatusAction $currentRuntime
    } catch {
        throw (New-CodexRemoteFailureException `
            -Stage 'runtime-handoff' `
            -Code 'runtime-generation-unverified')
    }
    if ($null -ne $activeStatus -and
        [string]$activeStatus.Status -ceq 'current') {
        return $currentRuntime
    }
    if ($null -eq $activeStatus -or
        [string]$activeStatus.Status -cne 'drifted') {
        throw (New-CodexRemoteFailureException `
            -Stage 'runtime-handoff' `
            -Code 'runtime-generation-unverified')
    }
    if ($DesktopProcessCount -gt 0) {
        if ($null -ne $DelegateFreshTakeoverAction) {
            try {
                $delegated = & $DelegateFreshTakeoverAction $currentRuntime
            } catch {
                $delegated = $false
            }
            if ($delegated -is [bool] -and [bool]$delegated) {
                throw (New-CodexRemoteFailureException `
                    -Stage 'runtime-handoff' `
                    -Code 'handoff-launch-denied')
            }
        }
        throw (New-CodexRemoteFailureException `
            -Stage 'runtime-handoff' `
            -Code 'desktop-running')
    }
    try {
        $restartSafe = & $GetRestartSafetyStatusAction
    } catch {
        $restartSafe = $false
    }
    if ($restartSafe -isnot [bool] -or -not [bool]$restartSafe) {
        throw (New-CodexRemoteFailureException `
            -Stage 'runtime-handoff' `
            -Code 'runtime-handoff-failed')
    }
    try {
        $null = & $RestartRuntimeAction $currentRuntime
        $after = & $GetActiveRuntimeStatusAction $currentRuntime
    } catch {
        throw (New-CodexRemoteFailureException `
            -Stage 'runtime-handoff' `
            -Code 'runtime-handoff-failed')
    }
    if ($null -eq $after -or [string]$after.Status -cne 'current') {
        throw (New-CodexRemoteFailureException `
            -Stage 'runtime-handoff' `
            -Code 'runtime-handoff-failed')
    }
    return $currentRuntime
}

function New-CodexRemoteFailureException {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateSet(
            'remote-health-check',
            'runtime-handoff',
            'remote-readiness',
            'remote-endpoint',
            'desktop-start',
            'desktop-attach',
            'desktop-cleanup',
            'unexpected'
        )]
        [string]$Stage,

        [Parameter(Mandatory)]
        [ValidateSet(
            'health-check-failed',
            'runtime-generation-unverified',
            'desktop-running',
            'handoff-request-invalid',
            'handoff-launch-denied',
            'handoff-launch-failed',
            'handoff-timeout',
            'handoff-result-invalid',
            'handoff-result-mismatch',
            'runtime-handoff-failed',
            'readiness-timeout',
            'endpoint-invalid',
            'desktop-start-failed',
            'desktop-attach-failed',
            'desktop-cleanup-failed',
            'unexpected'
        )]
        [string]$Code
    )

    $exception = [InvalidOperationException]::new(
        'The Remote startup operation could not be completed safely.'
    )
    $exception.Data['CodexRemoteFailureStage'] = $Stage
    $exception.Data['CodexRemoteFailureCode'] = $Code
    return $exception
}

function Get-CodexRemoteFailureDiagnostic {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$ErrorRecord,

        [Parameter(Mandatory)]
        [ValidateSet(
            'remote-health-check',
            'runtime-handoff',
            'remote-readiness',
            'remote-endpoint',
            'desktop-start',
            'desktop-attach',
            'desktop-cleanup',
            'unexpected'
        )]
        [string]$DefaultStage,

        [Parameter(Mandatory)]
        [ValidateSet(
            'health-check-failed',
            'runtime-generation-unverified',
            'desktop-running',
            'handoff-request-invalid',
            'handoff-launch-denied',
            'handoff-launch-failed',
            'handoff-timeout',
            'handoff-result-invalid',
            'handoff-result-mismatch',
            'runtime-handoff-failed',
            'readiness-timeout',
            'endpoint-invalid',
            'desktop-start-failed',
            'desktop-attach-failed',
            'desktop-cleanup-failed',
            'unexpected'
        )]
        [string]$DefaultCode
    )

    $allowedStages = @(
        'remote-health-check',
        'runtime-handoff',
        'remote-readiness',
        'remote-endpoint',
        'desktop-start',
        'desktop-attach',
        'desktop-cleanup',
        'unexpected'
    )
    $allowedCodes = @(
        'health-check-failed',
        'runtime-generation-unverified',
        'desktop-running',
        'handoff-request-invalid',
        'handoff-launch-denied',
        'handoff-launch-failed',
        'handoff-timeout',
        'handoff-result-invalid',
        'handoff-result-mismatch',
        'runtime-handoff-failed',
        'readiness-timeout',
        'endpoint-invalid',
        'desktop-start-failed',
        'desktop-attach-failed',
        'desktop-cleanup-failed',
        'unexpected'
    )
    $exception = $ErrorRecord.Exception
    $stage = if ($null -ne $exception -and
        $allowedStages -ccontains
            [string]$exception.Data['CodexRemoteFailureStage']) {
        [string]$exception.Data['CodexRemoteFailureStage']
    } else {
        $DefaultStage
    }
    $code = if ($null -ne $exception -and
        $allowedCodes -ccontains
            [string]$exception.Data['CodexRemoteFailureCode']) {
        [string]$exception.Data['CodexRemoteFailureCode']
    } else {
        $DefaultCode
    }
    return [pscustomobject]@{
        Stage = $stage
        Code = $code
    }
}

function New-CodexRemoteCorrelationId {
    [CmdletBinding()]
    param()

    return [Convert]::ToHexString(
        [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(16)
    ).ToLowerInvariant()
}

function Test-CodexLocalRemoteRuntimeGenerationMatch {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Expected,

        [AllowNull()]
        [object]$Actual
    )

    if ($null -eq $Expected -or $null -eq $Actual -or
        [string]$Expected.Status -cnotin @(
            'transition-required',
            'activation-required'
        ) -or
        [string]$Actual.Status -cne [string]$Expected.Status) {
        return $false
    }
    foreach ($property in @('SelectedRoot', 'ActiveRoot')) {
        try {
            $expectedPath = [System.IO.Path]::GetFullPath(
                [string]$Expected.$property
            )
            $actualPath = [System.IO.Path]::GetFullPath(
                [string]$Actual.$property
            )
        } catch {
            return $false
        }
        if (-not [string]::Equals(
            $expectedPath,
            $actualPath,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            return $false
        }
    }

    $expectedReceipt = $Expected.Receipt
    $actualReceipt = $Actual.Receipt
    if ($null -eq $expectedReceipt -or $null -eq $actualReceipt -or
        [string]$expectedReceipt.RuntimeInvocationId -cnotmatch
            '^[0-9a-f]{32}$' -or
        [string]$actualReceipt.RuntimeInvocationId -cne
            [string]$expectedReceipt.RuntimeInvocationId -or
        [int]$actualReceipt.ProcessId -ne
            [int]$expectedReceipt.ProcessId -or
        [int]$actualReceipt.Upstream.ProcessId -ne
            [int]$expectedReceipt.Upstream.ProcessId) {
        return $false
    }
    foreach ($property in @('BrokerCliPath', 'NodePath', 'CodexPath')) {
        try {
            $expectedPath = [System.IO.Path]::GetFullPath(
                [string]$expectedReceipt.$property
            )
            $actualPath = [System.IO.Path]::GetFullPath(
                [string]$actualReceipt.$property
            )
        } catch {
            return $false
        }
        if (-not [string]::Equals(
            $expectedPath,
            $actualPath,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            return $false
        }
    }
    if ([string]$Expected.Status -ceq 'activation-required') {
        $expectedBootstrap = $Expected.ActiveBootstrap
        $actualBootstrap = $Actual.ActiveBootstrap
        if ($null -eq $expectedBootstrap -or
            $null -eq $actualBootstrap -or
            [string]$expectedBootstrap.Status -cne 'verified' -or
            [string]$actualBootstrap.Status -cne 'verified' -or
            [string]$expectedBootstrap.Contract -cne
                'desktop-owner-v3' -or
            [string]$actualBootstrap.Contract -cne
                [string]$expectedBootstrap.Contract -or
            [int]$actualBootstrap.ProcessId -ne
                [int]$expectedBootstrap.ProcessId -or
            [long]$actualBootstrap.CreationDateUtcTicks -ne
                [long]$expectedBootstrap.CreationDateUtcTicks -or
            [long]$actualBootstrap.ProcessStartTimeUtcTicks -ne
                [long]$expectedBootstrap.ProcessStartTimeUtcTicks) {
            return $false
        }
    }
    return $true
}

function Assert-CodexLocalRemoteDesktopHandoffProcessGate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [string]$Phase,

        [AllowNull()]
        [object]$DesktopHandoffPreparation
    )

    if ($null -eq $DesktopHandoffPreparation) {
        if (@(Get-CodexDesktopHandoffProcesses).Count -gt 0) {
            throw "Runtime handoff $Phase gate found a running ChatGPT process."
        }
        return $null
    }
    foreach ($property in @(
        'PreparationId',
        'Phase',
        'RuntimeVersionId',
        'RuntimeRoot',
        'ManifestSha256'
    )) {
        if ($null -eq
            $DesktopHandoffPreparation.PSObject.Properties[$property]) {
            throw (
                "Runtime handoff $Phase gate received an incomplete " +
                'Desktop preparation.'
            )
        }
    }
    $livePreparation =
        Read-CodexLocalRemoteDesktopHandoffPreparation `
            -DataDir $ManagedDataDir `
            -ExpectedRuntimeVersionId (
                [string]$DesktopHandoffPreparation.RuntimeVersionId
            ) `
            -ExpectedRuntimeRoot (
                [string]$DesktopHandoffPreparation.RuntimeRoot
            ) `
            -ExpectedManifestSha256 (
                [string]$DesktopHandoffPreparation.ManifestSha256
            ) `
            -RequireLiveOwnership
    if ($null -eq $livePreparation -or
        [string]$livePreparation.PreparationId -cne
            [string]$DesktopHandoffPreparation.PreparationId -or
        [string]$livePreparation.Phase -cnotin @(
            'requested',
            'ready'
        )) {
        throw (
            "Runtime handoff $Phase gate could not revalidate the exact " +
            'prepared native Desktop owner.'
        )
    }
    return $livePreparation
}

function Assert-CodexLocalRemoteRuntimeHandoffReadiness {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Readiness,

        [Parameter(Mandatory)]
        [object]$ExpectedGeneration,

        [Parameter(Mandatory)]
        [string]$Phase,

        [Parameter(Mandatory)]
        [bool]$ExpectedSidecarConnected
    )

    $requiredProperties = @(
        'status',
        'appServerReady',
        'desktopConnected',
        'sidecarConnected',
        'degraded',
        'unknownCount',
        'unsafeThreadCount',
        'runtimeInvocationId',
        'brokerProcessId',
        'upstreamProcessId'
    )
    $schemaComplete = $null -ne $Readiness
    if ($schemaComplete) {
        foreach ($property in $requiredProperties) {
            if ($null -eq $Readiness.PSObject.Properties[$property]) {
                $schemaComplete = $false
                break
            }
        }
    }
    if (-not $schemaComplete -or
        [string]$Readiness.status -cne 'ready' -or
        $Readiness.appServerReady -isnot [bool] -or
        -not [bool]$Readiness.appServerReady -or
        $Readiness.desktopConnected -isnot [bool] -or
        [bool]$Readiness.desktopConnected -or
        $Readiness.sidecarConnected -isnot [bool] -or
        [bool]$Readiness.sidecarConnected -ne
            $ExpectedSidecarConnected -or
        $Readiness.degraded -isnot [bool] -or
        [bool]$Readiness.degraded -or
        -not (Test-NonNegativeInteger `
            -Value $Readiness.unknownCount) -or
        [decimal]$Readiness.unknownCount -ne 0 -or
        -not (Test-NonNegativeInteger `
            -Value $Readiness.unsafeThreadCount) -or
        [decimal]$Readiness.unsafeThreadCount -ne 0 -or
        [string]$Readiness.runtimeInvocationId -cnotmatch
            '^[0-9a-f]{32}$' -or
        -not (Test-NonNegativeInteger `
            -Value $Readiness.brokerProcessId) -or
        [decimal]$Readiness.brokerProcessId -le 0 -or
        -not (Test-NonNegativeInteger `
            -Value $Readiness.upstreamProcessId) -or
        [decimal]$Readiness.upstreamProcessId -le 0 -or
        [string]$Readiness.runtimeInvocationId -cne
            [string]$ExpectedGeneration.Receipt.RuntimeInvocationId -or
        [int]$Readiness.brokerProcessId -ne
            [int]$ExpectedGeneration.Receipt.ProcessId -or
        [int]$Readiness.upstreamProcessId -ne
            [int]$ExpectedGeneration.Receipt.Upstream.ProcessId) {
        throw "Runtime handoff $Phase barrier found an unverified or non-silent runtime."
    }
    return $Readiness
}

function Assert-CodexLocalRemoteRuntimeHandoffBarrier {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$ExpectedGeneration,

        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerPort,

        [Parameter(Mandatory)]
        [string]$Phase,

        [Parameter(Mandatory)]
        [bool]$ExpectedSidecarConnected,

        [AllowNull()]
        [object]$DesktopHandoffPreparation
    )

    $null = Assert-CodexLocalRemoteDesktopHandoffProcessGate `
        -ManagedDataDir $ManagedDataDir `
        -Phase $Phase `
        -DesktopHandoffPreparation $DesktopHandoffPreparation
    $currentGeneration = Get-CodexLocalRemoteRuntimeGenerationStatus `
        -ManagedDataDir $ManagedDataDir
    if (-not (Test-CodexLocalRemoteRuntimeGenerationMatch `
        -Expected $ExpectedGeneration `
        -Actual $currentGeneration)) {
        throw "Runtime handoff $Phase barrier found runtime generation drift."
    }
    $readiness = Get-CodexLocalRemoteReadinessSnapshot `
        -Port $ManagedBrokerPort
    return Assert-CodexLocalRemoteRuntimeHandoffReadiness `
        -Readiness $readiness `
        -ExpectedGeneration $ExpectedGeneration `
        -Phase $Phase `
        -ExpectedSidecarConnected $ExpectedSidecarConnected
}

function Wait-CodexLocalRemoteSidecarDisconnectedBounded {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$ExpectedGeneration,

        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerPort,

        [AllowNull()]
        [object]$DesktopHandoffPreparation,

        [ValidateRange(1, 60)]
        [int]$TimeoutSeconds = 15
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $null = Assert-CodexLocalRemoteDesktopHandoffProcessGate `
            -ManagedDataDir $ManagedDataDir `
            -Phase 'sidecar-disconnect-wait' `
            -DesktopHandoffPreparation $DesktopHandoffPreparation
        $currentGeneration =
            Get-CodexLocalRemoteRuntimeGenerationStatus `
                -ManagedDataDir $ManagedDataDir
        if (-not (Test-CodexLocalRemoteRuntimeGenerationMatch `
            -Expected $ExpectedGeneration `
            -Actual $currentGeneration)) {
            throw (
                'Runtime handoff sidecar-disconnect-wait barrier found ' +
                'runtime generation drift.'
            )
        }
        $readiness = Get-CodexLocalRemoteReadinessSnapshot `
            -Port $ManagedBrokerPort
        if ($null -eq $readiness -or
            $null -eq
                $readiness.PSObject.Properties['sidecarConnected'] -or
            $readiness.sidecarConnected -isnot [bool]) {
            throw (
                'Runtime handoff sidecar-disconnect-wait could not prove ' +
                'the Sidecar connection state.'
            )
        }
        $readiness =
            Assert-CodexLocalRemoteRuntimeHandoffReadiness `
                -Readiness $readiness `
                -ExpectedGeneration $ExpectedGeneration `
                -Phase 'sidecar-disconnect-wait' `
                -ExpectedSidecarConnected (
                    [bool]$readiness.sidecarConnected
                )
        if (-not [bool]$readiness.sidecarConnected) {
            return $readiness
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            throw (
                'Runtime handoff timed out waiting for the exact Sidecar ' +
                'disconnect to propagate.'
            )
        }
        Start-Sleep -Milliseconds 100
    } while ($true)
}

function Start-CodexLocalRemoteScheduledTaskBounded {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [ValidateRange(1, 60)]
        [int]$TimeoutSeconds = 15
    )

    $task = Get-ScheduledTask `
        -TaskName $Name `
        -TaskPath '\' `
        -ErrorAction Stop
    if ([string]$task.State -cne 'Running') {
        Start-ScheduledTask -TaskName $Name -TaskPath '\'
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $task = Get-ScheduledTask `
            -TaskName $Name `
            -TaskPath '\' `
            -ErrorAction Stop
        if ([string]$task.State -ceq 'Running') {
            return
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "Scheduled task '$Name' did not enter Running state."
        }
        Start-Sleep -Milliseconds 100
    } while ($true)
}

function Wait-CodexLocalRemoteScheduledTaskStoppedBounded {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [ValidateRange(1, 60)]
        [int]$TimeoutSeconds = 15
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $task = Get-ScheduledTask `
            -TaskName $Name `
            -TaskPath '\' `
            -ErrorAction Stop
        if ([string]$task.State -cne 'Running') {
            return
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "Scheduled task '$Name' did not stop for runtime handoff."
        }
        Start-Sleep -Milliseconds 100
    } while ($true)
}

function Stop-CodexLocalRemotePossiblyStartedSelectedGeneration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [string]$SelectedRoot,

        [Parameter(Mandatory)]
        [string]$NodePath,

        [Parameter(Mandatory)]
        [string]$CodexPath,

        [Parameter(Mandatory)]
        [string]$SelectedSidecarStopPath,

        [Parameter(Mandatory)]
        [string]$SelectedBrokerStopPath,

        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedSidecarPort,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerPort,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerUpstreamPort,

        [Parameter(Mandatory)]
        [string]$ManagedBasePath,

        [AllowNull()]
        [object]$DesktopHandoffPreparation,

        [ValidateRange(1, 60)]
        [int]$TimeoutSeconds = 15
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $selectedObserved = $false
    $stopScriptPasses = 0
    $consecutiveSilentObservations = 0
    $invokeSelectedOwnerStopPass = {
        $null = & $SelectedSidecarStopPath `
            -NodePath $NodePath `
            -ExpectedSidecarCliPath (
                Join-Path $SelectedRoot 'apps\sidecar\dist\cli.js'
            ) `
            -DataDir $ManagedDataDir `
            -Port $ManagedSidecarPort `
            -BasePath $ManagedBasePath `
            -Confirm:$false
        $null = & $SelectedBrokerStopPath `
            -CodexPath $CodexPath `
            -NodePath $NodePath `
            -InstallRoot $SelectedRoot `
            -DataDir $ManagedDataDir `
            -BrokerPort $ManagedBrokerPort `
            -BrokerUpstreamPort $ManagedBrokerUpstreamPort `
            -Confirm:$false
        $stopScriptPasses++
    }
    do {
        $latestReadiness =
            Get-CodexLocalRemoteReadinessSnapshot `
                -Port $ManagedBrokerPort
        $null = Assert-CodexLocalRemoteDesktopHandoffProcessGate `
            -ManagedDataDir $ManagedDataDir `
            -Phase 'selected-generation-cleanup' `
            -DesktopHandoffPreparation $DesktopHandoffPreparation
        if ($null -ne $latestReadiness -and
            [bool]$latestReadiness.desktopConnected) {
            throw 'Selected runtime cleanup is blocked by a connected Desktop.'
        }
        $currentTask = Get-ScheduledTask `
            -TaskName $Name `
            -TaskPath '\' `
            -ErrorAction Stop
        $currentGeneration = $null
        try {
            $currentGeneration =
                Get-CodexLocalRemoteRuntimeGenerationStatus `
                    -ManagedDataDir $ManagedDataDir
        } catch {
            # A disappearing receipt is an expected cleanup observation.
        }
        $selectedOwnerPresent = (
            [string]$currentTask.State -ceq 'Running' -or
            ($null -ne $currentGeneration -and
                (Test-CodexLocalRemotePathEqual `
                    -Left ([string]$currentGeneration.ActiveRoot) `
                    -Right $SelectedRoot))
        )
        if ($selectedOwnerPresent) {
            $selectedObserved = $true
            $consecutiveSilentObservations = 0
        }

        # A start request may have been accepted before Task Scheduler exposes
        # Running. Repeating Stop across the full bounded window cancels both
        # the visible instance and a request that becomes visible later.
        Stop-ScheduledTask -TaskName $Name -TaskPath '\'
        Wait-CodexLocalRemoteScheduledTaskStoppedBounded `
            -Name $Name `
            -TimeoutSeconds $TimeoutSeconds
        if ($selectedOwnerPresent -or $stopScriptPasses -eq 0) {
            . $invokeSelectedOwnerStopPass
        } else {
            $consecutiveSilentObservations++
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            break
        }
        Start-Sleep -Milliseconds 100
    } while ($true)

    $finalReadiness =
        Get-CodexLocalRemoteReadinessSnapshot `
            -Port $ManagedBrokerPort
    $null = Assert-CodexLocalRemoteDesktopHandoffProcessGate `
        -ManagedDataDir $ManagedDataDir `
        -Phase 'selected-generation-final-cleanup' `
        -DesktopHandoffPreparation $DesktopHandoffPreparation
    if ($null -ne $finalReadiness -and
        [bool]$finalReadiness.desktopConnected) {
        throw 'Selected runtime final cleanup audit found a connected Desktop.'
    }
    $finalTask = Get-ScheduledTask `
        -TaskName $Name `
        -TaskPath '\' `
        -ErrorAction Stop
    $finalGeneration = $null
    try {
        $finalGeneration =
            Get-CodexLocalRemoteRuntimeGenerationStatus `
                -ManagedDataDir $ManagedDataDir
    } catch {
        # A disappearing receipt is an expected final cleanup observation.
    }
    $selectedOwnerPresentAtFinalAudit = (
        [string]$finalTask.State -ceq 'Running' -or
        ($null -ne $finalGeneration -and
            (Test-CodexLocalRemotePathEqual `
                -Left ([string]$finalGeneration.ActiveRoot) `
                -Right $SelectedRoot))
    )
    if ($selectedOwnerPresentAtFinalAudit) {
        Stop-ScheduledTask -TaskName $Name -TaskPath '\'
        Wait-CodexLocalRemoteScheduledTaskStoppedBounded `
            -Name $Name `
            -TimeoutSeconds $TimeoutSeconds
        . $invokeSelectedOwnerStopPass
        throw (
            'Selected runtime owner reappeared during the final cleanup ' +
            'audit; stable silence was not verified.'
        )
    }
    $consecutiveSilentObservations++
    if ($consecutiveSilentObservations -lt 2) {
        throw 'Selected runtime cleanup did not establish stable silence.'
    }
    return [pscustomobject]@{
        SelectedObserved = $selectedObserved
        StopScriptsInvoked = $stopScriptPasses -gt 0
        StopScriptPasses = $stopScriptPasses
        StableSilenceVerified = $true
        SilentObservations = $consecutiveSilentObservations
        FinalTaskState = [string]$finalTask.State
        FinalGenerationRoot = if ($null -eq $finalGeneration) {
            $null
        } else {
            [string]$finalGeneration.ActiveRoot
        }
    }
}

function Test-CodexLocalRemotePathEqual {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [string]$Left,

        [AllowNull()]
        [string]$Right
    )

    try {
        $leftPath = [System.IO.Path]::GetFullPath($Left)
        $rightPath = [System.IO.Path]::GetFullPath($Right)
    } catch {
        return $false
    }
    return [string]::Equals(
        $leftPath,
        $rightPath,
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Assert-CodexExpectedSelectedRuntime {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [AllowEmptyString()]
        [string]$ExpectedVersionId = '',

        [AllowEmptyString()]
        [string]$ExpectedRoot = '',

        [AllowEmptyString()]
        [string]$ExpectedManifestSha256 = ''
    )

    $hasExpectedVersion = -not [string]::IsNullOrWhiteSpace(
        $ExpectedVersionId
    )
    $hasExpectedRoot = -not [string]::IsNullOrWhiteSpace($ExpectedRoot)
    $hasExpectedManifest = -not [string]::IsNullOrWhiteSpace(
        $ExpectedManifestSha256
    )
    if ($hasExpectedVersion -ne $hasExpectedRoot -or
        ($hasExpectedManifest -and -not $hasExpectedVersion) -or
        ($hasExpectedVersion -and
            $ExpectedVersionId -cnotmatch '^[0-9a-f]{64}$') -or
        ($hasExpectedManifest -and
            $ExpectedManifestSha256 -cnotmatch '^[0-9a-f]{64}$')) {
        throw (New-CodexRemoteFailureException `
            -Stage 'runtime-handoff' `
            -Code 'handoff-request-invalid')
    }

    $current = Get-CodexLocalRemoteCurrentRuntime -DataDir $ManagedDataDir
    if ($null -eq $current -or
        [string]$current.CurrentVersionId -cnotmatch '^[0-9a-f]{64}$' -or
        [string]::IsNullOrWhiteSpace([string]$current.CurrentRoot)) {
        throw (New-CodexRemoteFailureException `
            -Stage 'runtime-handoff' `
            -Code 'runtime-generation-unverified')
    }
    if ($hasExpectedVersion -and
        ([string]$current.CurrentVersionId -cne $ExpectedVersionId -or
        -not (Test-CodexLocalRemotePathEqual `
            -Left ([string]$current.CurrentRoot) `
            -Right $ExpectedRoot) -or
        ($hasExpectedManifest -and
            [string]$current.CurrentManifestSha256 -cne
                $ExpectedManifestSha256))) {
        throw (New-CodexRemoteFailureException `
            -Stage 'runtime-handoff' `
            -Code 'handoff-result-mismatch')
    }
    return $current
}

function Test-CodexLocalRemoteTaskXmlRuntimeRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Xml,

        [Parameter(Mandatory)]
        [string]$ExpectedRoot,

        [AllowNull()]
        [string]$ForbiddenRoot
    )

    try {
        $document = [xml]$Xml
    } catch {
        return $false
    }
    $foundExpected = $false
    foreach ($node in @($document.SelectNodes('//text()'))) {
        $value = [string]$node.Value
        if ($value.IndexOf(
            $ExpectedRoot,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -ge 0) {
            $foundExpected = $true
        }
        if (-not [string]::IsNullOrWhiteSpace($ForbiddenRoot) -and
            $value.IndexOf(
                $ForbiddenRoot,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -ge 0) {
            return $false
        }
    }
    return $foundExpected
}

function Get-CodexLocalRemoteRuntimeRollbackPlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [object]$Generation,

        [Parameter(Mandatory)]
        [string]$ManagedDataDir
    )

    $selectedRoot = [System.IO.Path]::GetFullPath(
        [string]$Generation.SelectedRoot
    )
    $activeRoot = [System.IO.Path]::GetFullPath(
        [string]$Generation.ActiveRoot
    )
    $pointer = Get-CodexLocalRemoteCurrentRuntime `
        -DataDir $ManagedDataDir
    if ($null -eq $pointer -or
        -not (Test-CodexLocalRemotePathEqual `
            -Left ([string]$pointer.CurrentRoot) `
            -Right $selectedRoot) -or
        -not (Test-CodexLocalRemotePathEqual `
            -Left ([string]$pointer.PreviousRoot) `
            -Right $activeRoot) -or
        [string]$pointer.PreviousVersionId -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Runtime handoff cannot prove the prior active runtime from the selected pointer.'
    }
    $selectedTaskXml = [string](
        Export-ScheduledTask `
            -TaskName $Name `
            -TaskPath '\' `
            -ErrorAction Stop
    )
    if (-not (Test-CodexLocalRemoteTaskXmlRuntimeRoot `
        -Xml $selectedTaskXml `
        -ExpectedRoot $selectedRoot `
        -ForbiddenRoot $activeRoot)) {
        throw 'Runtime handoff cannot prove the selected scheduled-task definition.'
    }
    $selectedTaskXmlSha256 =
        Get-StringSha256 -Value $selectedTaskXml
    if (-not [bool]$pointer.HasCurrentTaskDefinition -or
        [string]$pointer.CurrentTaskDefinitionTaskName -cne $Name -or
        [string]$pointer.CurrentTaskDefinitionRuntimeVersionId -cne
            [string]$pointer.CurrentVersionId -or
        -not (Test-CodexLocalRemotePathEqual `
            -Left (
                [string]$pointer.CurrentTaskDefinitionRuntimeRoot
            ) `
            -Right $selectedRoot) -or
        [string]$pointer.CurrentTaskDefinitionSha256 -cne
            $selectedTaskXmlSha256) {
        throw 'Runtime handoff cannot prove the exact selected scheduled-task definition.'
    }
    $priorTaskPreImage =
        Get-CodexLocalRemoteRuntimeTaskPreImage `
            -DataDir $ManagedDataDir `
            -ExpectedTaskName $Name `
            -ExpectedRuntimeVersionId (
                [string]$pointer.PreviousVersionId
            ) `
            -ExpectedRuntimeRoot $activeRoot
    $priorTaskXml = [string]$priorTaskPreImage.Xml
    if ([string]$priorTaskPreImage.XmlSha256 -cne
            (Get-StringSha256 -Value $priorTaskXml) -or
        -not (Test-CodexLocalRemoteTaskXmlRuntimeRoot `
            -Xml $priorTaskXml `
            -ExpectedRoot $activeRoot `
            -ForbiddenRoot $selectedRoot)) {
        throw 'Runtime handoff cannot prove the exact prior scheduled-task pre-image.'
    }
    return [pscustomobject]@{
        SelectedRoot = $selectedRoot
        ActiveRoot = $activeRoot
        SelectedRuntime = [pscustomobject]@{
            VersionId = [string]$pointer.CurrentVersionId
            RuntimeRoot = $selectedRoot
        }
        PriorRuntime = [pscustomobject]@{
            VersionId = [string]$pointer.PreviousVersionId
            RuntimeRoot = $activeRoot
        }
        SelectedTaskXml = $selectedTaskXml
        SelectedTaskXmlSha256 = $selectedTaskXmlSha256
        SelectedTaskDefinition = [pscustomobject]@{
            TaskName = $Name
            RuntimeVersionId = [string]$pointer.CurrentVersionId
            RuntimeRoot = $selectedRoot
            XmlSha256 = $selectedTaskXmlSha256
        }
        PriorTaskXml = $priorTaskXml
        PriorTaskXmlSha256 = [string]$priorTaskPreImage.XmlSha256
        PriorTaskPreImage = $priorTaskPreImage
        PriorTaskDefinition = [pscustomobject]@{
            TaskName = $Name
            RuntimeVersionId = [string]$pointer.PreviousVersionId
            RuntimeRoot = $activeRoot
            XmlSha256 = [string]$priorTaskPreImage.XmlSha256
        }
    }
}

function Get-CodexLocalRemoteRuntimeTaskPairState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [object]$RollbackPlan
    )

    try {
        $task = Get-ScheduledTask `
            -TaskName $Name `
            -TaskPath '\' `
            -ErrorAction Stop
        $taskXml = [string](
            Export-ScheduledTask `
                -TaskName $Name `
                -TaskPath '\' `
                -ErrorAction Stop
        )
        $pointer = Get-CodexLocalRemoteCurrentRuntime `
            -DataDir $ManagedDataDir
        if ($null -eq $pointer) {
            throw 'runtime pointer is absent'
        }
        $taskXmlSha256 = Get-StringSha256 -Value $taskXml
        $taskMatchesPrior = (
            $taskXmlSha256 -ceq
                [string]$RollbackPlan.PriorTaskXmlSha256 -and
            (Test-CodexLocalRemoteTaskXmlRuntimeRoot `
                -Xml $taskXml `
                -ExpectedRoot ([string]$RollbackPlan.ActiveRoot) `
                -ForbiddenRoot ([string]$RollbackPlan.SelectedRoot))
        )
        $taskMatchesSelected = (
            $taskXmlSha256 -ceq
                [string]$RollbackPlan.SelectedTaskXmlSha256 -and
            (Test-CodexLocalRemoteTaskXmlRuntimeRoot `
                -Xml $taskXml `
                -ExpectedRoot ([string]$RollbackPlan.SelectedRoot) `
                -ForbiddenRoot ([string]$RollbackPlan.ActiveRoot))
        )
        $pointerRuntimeMatchesPrior = (
            [string]$pointer.CurrentVersionId -ceq
                [string]$RollbackPlan.PriorRuntime.VersionId -and
            (Test-CodexLocalRemotePathEqual `
                -Left ([string]$pointer.CurrentRoot) `
                -Right ([string]$RollbackPlan.ActiveRoot))
        )
        $pointerBindingMatchesPrior = (
            [bool]$pointer.HasCurrentTaskDefinition -and
            [string]$pointer.CurrentTaskDefinitionTaskName -ceq $Name -and
            [string]$pointer.CurrentTaskDefinitionRuntimeVersionId -ceq
                [string]$RollbackPlan.PriorRuntime.VersionId -and
            (Test-CodexLocalRemotePathEqual `
                -Left (
                    [string]$pointer.CurrentTaskDefinitionRuntimeRoot
                ) `
                -Right ([string]$RollbackPlan.ActiveRoot)) -and
            [string]$pointer.CurrentTaskDefinitionSha256 -ceq
                [string]$RollbackPlan.PriorTaskXmlSha256
        )
        $pointerMatchesPrior = (
            $pointerRuntimeMatchesPrior -and
            $pointerBindingMatchesPrior
        )
        $pointerRuntimeMatchesSelected = (
            [string]$pointer.CurrentVersionId -ceq
                [string]$RollbackPlan.SelectedRuntime.VersionId -and
            (Test-CodexLocalRemotePathEqual `
                -Left ([string]$pointer.CurrentRoot) `
                -Right ([string]$RollbackPlan.SelectedRoot))
        )
        $pointerBindingMatchesSelected = (
            [bool]$pointer.HasCurrentTaskDefinition -and
            [string]$pointer.CurrentTaskDefinitionTaskName -ceq $Name -and
            [string]$pointer.CurrentTaskDefinitionRuntimeVersionId -ceq
                [string]$RollbackPlan.SelectedRuntime.VersionId -and
            (Test-CodexLocalRemotePathEqual `
                -Left (
                    [string]$pointer.CurrentTaskDefinitionRuntimeRoot
                ) `
                -Right ([string]$RollbackPlan.SelectedRoot)) -and
            [string]$pointer.CurrentTaskDefinitionSha256 -ceq
                [string]$RollbackPlan.SelectedTaskXmlSha256
        )
        $pointerMatchesSelected = (
            $pointerRuntimeMatchesSelected -and
            $pointerBindingMatchesSelected
        )
        $kind = if ($taskMatchesPrior -and $pointerMatchesPrior) {
            'old'
        } elseif ($taskMatchesSelected -and $pointerMatchesSelected) {
            'selected'
        } else {
            'mixed'
        }
        return [pscustomobject]@{
            Kind = $kind
            Task = $task
            TaskState = [string]$task.State
            TaskXml = $taskXml
            TaskMatchesPrior = $taskMatchesPrior
            TaskMatchesSelected = $taskMatchesSelected
            Pointer = $pointer
            PointerMatchesPrior = $pointerMatchesPrior
            PointerMatchesSelected = $pointerMatchesSelected
            PointerRuntimeMatchesPrior = $pointerRuntimeMatchesPrior
            PointerBindingMatchesPrior = $pointerBindingMatchesPrior
            PointerRuntimeMatchesSelected =
                $pointerRuntimeMatchesSelected
            PointerBindingMatchesSelected =
                $pointerBindingMatchesSelected
            Failure = $null
        }
    } catch {
        return [pscustomobject]@{
            Kind = 'invalid'
            Task = $null
            TaskState = $null
            TaskXml = $null
            TaskMatchesPrior = $false
            TaskMatchesSelected = $false
            Pointer = $null
            PointerMatchesPrior = $false
            PointerMatchesSelected = $false
            PointerRuntimeMatchesPrior = $false
            PointerBindingMatchesPrior = $false
            PointerRuntimeMatchesSelected = $false
            PointerBindingMatchesSelected = $false
            Failure = $_.Exception.Message
        }
    }
}

function Wait-CodexLocalRemoteRuntimeReadyForRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [string]$ExpectedRoot,

        [Parameter(Mandatory)]
        [string]$ForbiddenRoot,

        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerPort,

        [AllowNull()]
        [object]$DesktopHandoffPreparation,

        [ValidateRange(1, 300)]
        [int]$TimeoutSeconds = 120
    )

    $expectedBrokerCli = [System.IO.Path]::GetFullPath(
        (Join-Path $ExpectedRoot 'apps\broker\dist\cli.js')
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastFailure = 'runtime state was unavailable'
    do {
        try {
            if ($null -ne $DesktopHandoffPreparation) {
                $null =
                    Assert-CodexLocalRemoteDesktopHandoffProcessGate `
                        -ManagedDataDir $ManagedDataDir `
                        -Phase 'runtime-ready-wait' `
                        -DesktopHandoffPreparation (
                            $DesktopHandoffPreparation
                        )
            }
            $task = Get-ScheduledTask `
                -TaskName $Name `
                -TaskPath '\' `
                -ErrorAction Stop
            $taskXml = [string](
                Export-ScheduledTask `
                    -TaskName $Name `
                    -TaskPath '\' `
                    -ErrorAction Stop
            )
            $pointer = Get-CodexLocalRemoteCurrentRuntime `
                -DataDir $ManagedDataDir
            $generation =
                Get-CodexLocalRemoteRuntimeGenerationStatus `
                    -ManagedDataDir $ManagedDataDir
            $readiness = Get-CodexLocalRemoteReadinessSnapshot `
                -Port $ManagedBrokerPort
            $infrastructureReady = if (
                $null -ne $DesktopHandoffPreparation
            ) {
                Test-CodexLocalRemotePreparedInfrastructureSnapshot `
                    -Readiness $readiness
            } else {
                Test-CodexLocalRemoteInfrastructureSnapshot `
                    -Readiness $readiness
            }
            $verified = (
                [string]$task.State -ceq 'Running' -and
                (Test-CodexLocalRemoteTaskXmlRuntimeRoot `
                    -Xml $taskXml `
                    -ExpectedRoot $ExpectedRoot `
                    -ForbiddenRoot $ForbiddenRoot) -and
                $null -ne $pointer -and
                (Test-CodexLocalRemotePathEqual `
                    -Left ([string]$pointer.CurrentRoot) `
                    -Right $ExpectedRoot) -and
                $null -ne $generation -and
                [string]$generation.Status -ceq 'current' -and
                (Test-CodexLocalRemotePathEqual `
                    -Left ([string]$generation.SelectedRoot) `
                    -Right $ExpectedRoot) -and
                (Test-CodexLocalRemotePathEqual `
                    -Left ([string]$generation.ActiveRoot) `
                    -Right $ExpectedRoot) -and
                (Test-CodexLocalRemotePathEqual `
                    -Left ([string]$generation.Receipt.BrokerCliPath) `
                    -Right $expectedBrokerCli) -and
                $infrastructureReady -and
                -not [bool]$readiness.desktopConnected -and
                [string]$readiness.runtimeInvocationId -ceq
                    [string]$generation.Receipt.RuntimeInvocationId -and
                [int]$readiness.brokerProcessId -eq
                    [int]$generation.Receipt.ProcessId -and
                [int]$readiness.upstreamProcessId -eq
                    [int]$generation.Receipt.Upstream.ProcessId
            )
            if ($verified) {
                return $readiness
            }
            $lastFailure =
                'task, pointer, receipt, or readiness did not match'
        } catch {
            $lastFailure = $_.Exception.Message
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            throw (
                "Runtime root '$ExpectedRoot' did not pass bounded " +
                "task/pointer/readiness verification: $lastFailure"
            )
        }
        Start-Sleep -Milliseconds 100
    } while ($true)
}

function Assert-CodexLocalRemoteRuntimeReadyPair {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerPort,

        [Parameter(Mandatory)]
        [object]$RollbackPlan,

        [Parameter(Mandatory)]
        [ValidateSet('old', 'selected')]
        [string]$ExpectedPairKind,

        [Parameter(Mandatory)]
        [string]$ExpectedRoot,

        [AllowNull()]
        [object]$DesktopHandoffPreparation
    )

    if ($null -ne $DesktopHandoffPreparation) {
        $null = Assert-CodexLocalRemoteDesktopHandoffProcessGate `
            -ManagedDataDir $ManagedDataDir `
            -Phase 'runtime-ready-pair-before' `
            -DesktopHandoffPreparation $DesktopHandoffPreparation
    }
    $pairBefore = Get-CodexLocalRemoteRuntimeTaskPairState `
        -Name $Name `
        -ManagedDataDir $ManagedDataDir `
        -RollbackPlan $RollbackPlan
    $generation =
        Get-CodexLocalRemoteRuntimeGenerationStatus `
            -ManagedDataDir $ManagedDataDir
    $readiness = Get-CodexLocalRemoteReadinessSnapshot `
        -Port $ManagedBrokerPort
    $pairAfter = Get-CodexLocalRemoteRuntimeTaskPairState `
        -Name $Name `
        -ManagedDataDir $ManagedDataDir `
        -RollbackPlan $RollbackPlan
    if ($null -ne $DesktopHandoffPreparation) {
        $null = Assert-CodexLocalRemoteDesktopHandoffProcessGate `
            -ManagedDataDir $ManagedDataDir `
            -Phase 'runtime-ready-pair-after' `
            -DesktopHandoffPreparation $DesktopHandoffPreparation
    }
    $expectedBrokerCli = [System.IO.Path]::GetFullPath(
        (Join-Path $ExpectedRoot 'apps\broker\dist\cli.js')
    )
    $infrastructureReady = if (
        $null -ne $DesktopHandoffPreparation
    ) {
        Test-CodexLocalRemotePreparedInfrastructureSnapshot `
            -Readiness $readiness
    } else {
        Test-CodexLocalRemoteInfrastructureSnapshot `
            -Readiness $readiness
    }
    $verified = (
        [string]$pairBefore.Kind -ceq $ExpectedPairKind -and
        [string]$pairBefore.TaskState -ceq 'Running' -and
        [string]$pairAfter.Kind -ceq $ExpectedPairKind -and
        [string]$pairAfter.TaskState -ceq 'Running' -and
        [string]$pairBefore.TaskXml -ceq
            [string]$pairAfter.TaskXml -and
        [string]$pairBefore.Pointer.CurrentVersionId -ceq
            [string]$pairAfter.Pointer.CurrentVersionId -and
        [string]$pairBefore.Pointer.CurrentTaskDefinitionSha256 -ceq
            [string]$pairAfter.Pointer.CurrentTaskDefinitionSha256 -and
        $null -ne $generation -and
        [string]$generation.Status -ceq 'current' -and
        (Test-CodexLocalRemotePathEqual `
            -Left ([string]$generation.SelectedRoot) `
            -Right $ExpectedRoot) -and
        (Test-CodexLocalRemotePathEqual `
            -Left ([string]$generation.ActiveRoot) `
            -Right $ExpectedRoot) -and
        (Test-CodexLocalRemotePathEqual `
            -Left ([string]$generation.Receipt.BrokerCliPath) `
            -Right $expectedBrokerCli) -and
        $infrastructureReady -and
        -not [bool]$readiness.desktopConnected -and
        [string]$readiness.runtimeInvocationId -ceq
            [string]$generation.Receipt.RuntimeInvocationId -and
        [int]$readiness.brokerProcessId -eq
            [int]$generation.Receipt.ProcessId -and
        [int]$readiness.upstreamProcessId -eq
            [int]$generation.Receipt.Upstream.ProcessId
    )
    if (-not $verified) {
        throw (
            "Runtime '$ExpectedPairKind' final exact task/pointer binding " +
            "and readiness audit failed " +
            "('$([string]$pairBefore.Failure)'; " +
            "'$([string]$pairAfter.Failure)')."
        )
    }
    return [pscustomobject]@{
        PairBefore = $pairBefore
        Pair = $pairAfter
        Generation = $generation
        Readiness = $readiness
    }
}

function Assert-CodexLocalRemoteBootstrapActivationPostStopBarrier {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [object]$ExpectedGeneration,

        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerPort,

        [AllowNull()]
        [object]$DesktopHandoffPreparation
    )

    $null = Assert-CodexLocalRemoteDesktopHandoffProcessGate `
        -ManagedDataDir $ManagedDataDir `
        -Phase 'bootstrap-activation-post-stop' `
        -DesktopHandoffPreparation $DesktopHandoffPreparation
    $task = Get-ScheduledTask `
        -TaskName $Name `
        -TaskPath '\' `
        -ErrorAction Stop
    if ([string]$task.State -ceq 'Running') {
        throw 'Bootstrap activation post-stop barrier found the old task running.'
    }
    $readiness = Get-CodexLocalRemoteReadinessSnapshot `
        -Port $ManagedBrokerPort
    foreach ($property in @(
        'status',
        'appServerReady',
        'desktopConnected',
        'sidecarConnected',
        'degraded',
        'unknownCount',
        'unsafeThreadCount',
        'runtimeInvocationId',
        'brokerProcessId',
        'upstreamProcessId'
    )) {
        if ($null -eq $readiness -or
            $null -eq $readiness.PSObject.Properties[$property]) {
            throw 'Bootstrap activation post-stop readiness schema is incomplete.'
        }
    }
    if ([string]$readiness.status -cne 'ready' -or
        $readiness.appServerReady -isnot [bool] -or
        -not [bool]$readiness.appServerReady -or
        $readiness.desktopConnected -isnot [bool] -or
        [bool]$readiness.desktopConnected -or
        $readiness.sidecarConnected -isnot [bool] -or
        [bool]$readiness.sidecarConnected -or
        $readiness.degraded -isnot [bool] -or
        [bool]$readiness.degraded -or
        -not (Test-NonNegativeInteger -Value $readiness.unknownCount) -or
        [decimal]$readiness.unknownCount -ne 0 -or
        -not (Test-NonNegativeInteger -Value $readiness.unsafeThreadCount) -or
        [decimal]$readiness.unsafeThreadCount -ne 0 -or
        [string]$readiness.runtimeInvocationId -cne
            [string]$ExpectedGeneration.Receipt.RuntimeInvocationId -or
        [int]$readiness.brokerProcessId -ne
            [int]$ExpectedGeneration.Receipt.ProcessId -or
        [int]$readiness.upstreamProcessId -ne
            [int]$ExpectedGeneration.Receipt.Upstream.ProcessId) {
        throw (
            'Bootstrap activation post-stop barrier found an unverified ' +
            'or non-silent runtime.'
        )
    }
    return $readiness
}

function Wait-CodexLocalRemoteBootstrapActivationReady {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerPort,

        [Parameter(Mandatory)]
        [string]$ExpectedRoot,

        [Parameter(Mandatory)]
        [string]$PreviousRuntimeInvocationId,

        [AllowNull()]
        [object]$DesktopHandoffPreparation,

        [ValidateRange(1, 300)]
        [int]$TimeoutSeconds = 120
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastFailure = 'the V4 bootstrap was not yet observable'
    do {
        try {
            $null = Assert-CodexLocalRemoteDesktopHandoffProcessGate `
                -ManagedDataDir $ManagedDataDir `
                -Phase 'bootstrap-activation-ready' `
                -DesktopHandoffPreparation $DesktopHandoffPreparation
            $task = Get-ScheduledTask `
                -TaskName $Name `
                -TaskPath '\' `
                -ErrorAction Stop
            $generation =
                Get-CodexLocalRemoteRuntimeGenerationStatus `
                    -ManagedDataDir $ManagedDataDir
            $readiness = Get-CodexLocalRemoteReadinessSnapshot `
                -Port $ManagedBrokerPort
            $infrastructureReady = if (
                $null -ne $DesktopHandoffPreparation
            ) {
                Test-CodexLocalRemotePreparedInfrastructureSnapshot `
                    -Readiness $readiness
            } else {
                Test-CodexLocalRemoteInfrastructureSnapshot `
                    -Readiness $readiness
            }
            $verified = (
                [string]$task.State -ceq 'Running' -and
                $null -ne $generation -and
                [string]$generation.Status -ceq 'current' -and
                (Test-CodexLocalRemotePathEqual `
                    -Left ([string]$generation.SelectedRoot) `
                    -Right $ExpectedRoot) -and
                (Test-CodexLocalRemotePathEqual `
                    -Left ([string]$generation.ActiveRoot) `
                    -Right $ExpectedRoot) -and
                $null -ne $generation.ActiveBootstrap -and
                [string]$generation.ActiveBootstrap.Status -ceq
                    'verified' -and
                [string]$generation.ActiveBootstrap.Contract -ceq
                    'headless-v4' -and
                [string]$generation.Receipt.RuntimeInvocationId -cmatch
                    '^[0-9a-f]{32}$' -and
                [string]$generation.Receipt.RuntimeInvocationId -cne
                    $PreviousRuntimeInvocationId -and
                $infrastructureReady -and
                -not [bool]$readiness.desktopConnected -and
                [string]$readiness.runtimeInvocationId -ceq
                    [string]$generation.Receipt.RuntimeInvocationId -and
                [int]$readiness.brokerProcessId -eq
                    [int]$generation.Receipt.ProcessId -and
                [int]$readiness.upstreamProcessId -eq
                    [int]$generation.Receipt.Upstream.ProcessId
            )
            if ($verified) {
                return $readiness
            }
            $lastFailure =
                'task, V4 bootstrap, receipt, or readiness did not match'
        } catch {
            $lastFailure = $_.Exception.Message
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            throw (
                'The exact V4 bootstrap did not pass bounded activation ' +
                "verification: $lastFailure"
            )
        }
        Start-Sleep -Milliseconds 100
    } while ($true)
}

function Switch-CodexLocalRemoteBootstrapActivation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [object]$Generation,

        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedSidecarPort,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerPort,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerUpstreamPort,

        [Parameter(Mandatory)]
        [string]$ManagedBasePath,

        [AllowNull()]
        [object]$DesktopHandoffPreparation,

        [ValidateRange(1, 60)]
        [int]$TimeoutSeconds = 15,

        [ValidateRange(90, 300)]
        [int]$RuntimeReadyTimeoutSeconds = 120
    )

    $runtimeRoot = [System.IO.Path]::GetFullPath(
        [string]$Generation.SelectedRoot
    )
    if ([string]$Generation.Status -cne 'activation-required' -or
        -not (Test-CodexLocalRemotePathEqual `
            -Left ([string]$Generation.ActiveRoot) `
            -Right $runtimeRoot) -or
        [string]$Generation.ActiveBootstrap.Status -cne 'verified' -or
        [string]$Generation.ActiveBootstrap.Contract -cne
            'desktop-owner-v3') {
        throw 'Bootstrap activation requires one exact live V3 owner.'
    }
    $nodePath = [System.IO.Path]::GetFullPath(
        [string]$Generation.Receipt.NodePath
    )
    $sidecarStop = Join-Path $runtimeRoot `
        'scripts\windows\Stop-CodexLocalRemoteSidecar.ps1'
    $brokerStop = Join-Path $runtimeRoot `
        'scripts\windows\Stop-CodexAppServerBroker.ps1'
    foreach ($scriptPath in @($sidecarStop, $brokerStop)) {
        if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
            throw "Bootstrap activation script '$scriptPath' is missing."
        }
    }

    $task = Get-ScheduledTask `
        -TaskName $Name `
        -TaskPath '\' `
        -ErrorAction Stop
    if ([string]$task.State -cne 'Running') {
        throw 'Bootstrap activation no longer has one Running V3 task instance.'
    }
    $null = Assert-CodexLocalRemoteRuntimeHandoffBarrier `
        -ExpectedGeneration $Generation `
        -ManagedDataDir $ManagedDataDir `
        -ManagedBrokerPort $ManagedBrokerPort `
        -Phase 'bootstrap-activation-initial' `
        -ExpectedSidecarConnected $true `
        -DesktopHandoffPreparation $DesktopHandoffPreparation

    $startAttempted = $false
    try {
        Stop-ScheduledTask -TaskName $Name -TaskPath '\'
        Wait-CodexLocalRemoteScheduledTaskStoppedBounded `
            -Name $Name `
            -TimeoutSeconds $TimeoutSeconds
        $null =
            Assert-CodexLocalRemoteBootstrapActivationPostStopBarrier `
                -Name $Name `
                -ExpectedGeneration $Generation `
                -ManagedDataDir $ManagedDataDir `
                -ManagedBrokerPort $ManagedBrokerPort `
                -DesktopHandoffPreparation $DesktopHandoffPreparation
        $null = & $sidecarStop `
            -NodePath $nodePath `
            -ExpectedSidecarCliPath (
                Join-Path $runtimeRoot 'apps\sidecar\dist\cli.js'
            ) `
            -DataDir $ManagedDataDir `
            -Port $ManagedSidecarPort `
            -BasePath $ManagedBasePath `
            -Confirm:$false
        $null = Assert-CodexLocalRemoteDesktopHandoffProcessGate `
            -ManagedDataDir $ManagedDataDir `
            -Phase 'bootstrap-before-broker-stop' `
            -DesktopHandoffPreparation $DesktopHandoffPreparation
        $null = & $brokerStop `
            -CodexPath ([string]$Generation.Receipt.CodexPath) `
            -NodePath $nodePath `
            -InstallRoot $runtimeRoot `
            -DataDir $ManagedDataDir `
            -BrokerPort $ManagedBrokerPort `
            -BrokerUpstreamPort $ManagedBrokerUpstreamPort `
            -Confirm:$false
        $null = Assert-CodexLocalRemoteDesktopHandoffProcessGate `
            -ManagedDataDir $ManagedDataDir `
            -Phase 'bootstrap-before-task-start' `
            -DesktopHandoffPreparation $DesktopHandoffPreparation
        $startAttempted = $true
        Start-CodexLocalRemoteScheduledTaskBounded `
            -Name $Name `
            -TimeoutSeconds $TimeoutSeconds
        return Wait-CodexLocalRemoteBootstrapActivationReady `
            -Name $Name `
            -ManagedDataDir $ManagedDataDir `
            -ManagedBrokerPort $ManagedBrokerPort `
            -ExpectedRoot $runtimeRoot `
            -PreviousRuntimeInvocationId (
                [string]$Generation.Receipt.RuntimeInvocationId
            ) `
            -DesktopHandoffPreparation $DesktopHandoffPreparation `
            -TimeoutSeconds $RuntimeReadyTimeoutSeconds
    } catch {
        $activationFailure = $_.Exception.Message
        $cleanupFailure = $null
        $cleanupGatePassed = $false
        if ($startAttempted) {
            try {
                $null =
                    Assert-CodexLocalRemoteDesktopHandoffProcessGate `
                        -ManagedDataDir $ManagedDataDir `
                        -Phase 'bootstrap-activation-cleanup' `
                        -DesktopHandoffPreparation (
                            $DesktopHandoffPreparation
                        )
                $cleanupGatePassed = $true
            } catch {
                $cleanupFailure = $_.Exception.Message
            }
        }
        if ($startAttempted -and $cleanupGatePassed) {
            try {
                Stop-ScheduledTask -TaskName $Name -TaskPath '\'
                Wait-CodexLocalRemoteScheduledTaskStoppedBounded `
                    -Name $Name `
                    -TimeoutSeconds $TimeoutSeconds
                $null = & $sidecarStop `
                    -NodePath $nodePath `
                    -ExpectedSidecarCliPath (
                        Join-Path $runtimeRoot 'apps\sidecar\dist\cli.js'
                    ) `
                    -DataDir $ManagedDataDir `
                    -Port $ManagedSidecarPort `
                    -BasePath $ManagedBasePath `
                    -Confirm:$false
                $null = & $brokerStop `
                    -CodexPath ([string]$Generation.Receipt.CodexPath) `
                    -NodePath $nodePath `
                    -InstallRoot $runtimeRoot `
                    -DataDir $ManagedDataDir `
                    -BrokerPort $ManagedBrokerPort `
                    -BrokerUpstreamPort $ManagedBrokerUpstreamPort `
                    -Confirm:$false
            } catch {
                $cleanupFailure = $_.Exception.Message
            }
        }
        if ([string]::IsNullOrWhiteSpace($cleanupFailure)) {
            throw (
                "Bootstrap activation failed ('$activationFailure'); " +
                'no unverified V4 runtime was reused.'
            )
        }
        throw (
            "Bootstrap activation failed ('$activationFailure'); cleanup " +
            "also failed ('$cleanupFailure')."
        )
    }
}

function Switch-CodexLocalRemoteRuntimeGeneration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [object]$Generation,

        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedSidecarPort,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerPort,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerUpstreamPort,

        [Parameter(Mandatory)]
        [string]$ManagedBasePath,

        [AllowNull()]
        [object]$DesktopHandoffPreparation,

        [ValidateRange(1, 60)]
        [int]$TimeoutSeconds = 15,

        [ValidateRange(90, 300)]
        [int]$RuntimeReadyTimeoutSeconds = 120
    )

    if ([string]$Generation.Status -ceq 'activation-required') {
        return Switch-CodexLocalRemoteBootstrapActivation `
            -Name $Name `
            -Generation $Generation `
            -ManagedDataDir $ManagedDataDir `
            -ManagedSidecarPort $ManagedSidecarPort `
            -ManagedBrokerPort $ManagedBrokerPort `
            -ManagedBrokerUpstreamPort $ManagedBrokerUpstreamPort `
            -ManagedBasePath $ManagedBasePath `
            -DesktopHandoffPreparation $DesktopHandoffPreparation `
            -TimeoutSeconds $TimeoutSeconds `
            -RuntimeReadyTimeoutSeconds $RuntimeReadyTimeoutSeconds
    }
    if ([string]$Generation.Status -cne 'transition-required') {
        throw 'Runtime generation switch requires one verified transition.'
    }
    $activeRoot = [System.IO.Path]::GetFullPath(
        [string]$Generation.ActiveRoot
    )
    $nodePath = [System.IO.Path]::GetFullPath(
        [string]$Generation.Receipt.NodePath
    )
    $sidecarStop = Join-Path $activeRoot `
        'scripts\windows\Stop-CodexLocalRemoteSidecar.ps1'
    $brokerStop = Join-Path $activeRoot `
        'scripts\windows\Stop-CodexAppServerBroker.ps1'
    $selectedRoot = [System.IO.Path]::GetFullPath(
        [string]$Generation.SelectedRoot
    )
    $selectedSidecarStop = Join-Path $selectedRoot `
        'scripts\windows\Stop-CodexLocalRemoteSidecar.ps1'
    $selectedBrokerStop = Join-Path $selectedRoot `
        'scripts\windows\Stop-CodexAppServerBroker.ps1'
    foreach ($scriptPath in @(
        $sidecarStop,
        $brokerStop,
        $selectedSidecarStop,
        $selectedBrokerStop
    )) {
        if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
            throw "Runtime handoff script '$scriptPath' is missing."
        }
    }

    $task = Get-ScheduledTask `
        -TaskName $Name `
        -TaskPath '\' `
        -ErrorAction Stop
    $taskWasRunning = [string]$task.State -ceq 'Running'
    $initialReadinessObservation =
        Get-CodexLocalRemoteReadinessSnapshot `
            -Port $ManagedBrokerPort
    if ($null -eq $initialReadinessObservation -or
        $initialReadinessObservation.sidecarConnected -isnot [bool]) {
        throw (
            'Runtime handoff initial observation could not prove the ' +
            'Sidecar connection state.'
        )
    }
    $initialReadiness = Assert-CodexLocalRemoteRuntimeHandoffBarrier `
        -ExpectedGeneration $Generation `
        -ManagedDataDir $ManagedDataDir `
        -ManagedBrokerPort $ManagedBrokerPort `
        -Phase 'initial' `
        -ExpectedSidecarConnected (
            [bool]$initialReadinessObservation.sidecarConnected
        ) `
        -DesktopHandoffPreparation $DesktopHandoffPreparation
    $rollbackPlan = Get-CodexLocalRemoteRuntimeRollbackPlan `
        -Name $Name `
        -Generation $Generation `
        -ManagedDataDir $ManagedDataDir
    $forwardTaskStarted = $false
    $forwardTaskStartAttempted = $false
    $sidecarStoppedBeforePostStopBarrier = $false
    try {
        if ($taskWasRunning) {
            Stop-ScheduledTask -TaskName $Name -TaskPath '\'
        }
        Wait-CodexLocalRemoteScheduledTaskStoppedBounded `
            -Name $Name `
            -TimeoutSeconds $TimeoutSeconds

        $postTaskStopObservation =
            Get-CodexLocalRemoteReadinessSnapshot `
                -Port $ManagedBrokerPort
        if ($null -eq $postTaskStopObservation -or
            $postTaskStopObservation.sidecarConnected -isnot [bool]) {
            throw (
                'Runtime handoff post-task-stop observation could not prove ' +
                'the Sidecar connection state.'
            )
        }
        $postTaskStopReadiness =
            Assert-CodexLocalRemoteRuntimeHandoffBarrier `
                -ExpectedGeneration $Generation `
                -ManagedDataDir $ManagedDataDir `
                -ManagedBrokerPort $ManagedBrokerPort `
                -Phase 'post-task-stop' `
                -ExpectedSidecarConnected (
                    [bool]$postTaskStopObservation.sidecarConnected
                ) `
                -DesktopHandoffPreparation $DesktopHandoffPreparation
        if ([bool]$postTaskStopReadiness.sidecarConnected) {
            $null = & $sidecarStop `
                -NodePath $nodePath `
                -ExpectedSidecarCliPath (
                    Join-Path $activeRoot 'apps\sidecar\dist\cli.js'
                ) `
                -DataDir $ManagedDataDir `
                -Port $ManagedSidecarPort `
                -BasePath $ManagedBasePath `
                -Confirm:$false
            $sidecarStoppedBeforePostStopBarrier = $true
        }
        $postStopReadiness = if (
            $sidecarStoppedBeforePostStopBarrier
        ) {
            Wait-CodexLocalRemoteSidecarDisconnectedBounded `
                -ExpectedGeneration $Generation `
                -ManagedDataDir $ManagedDataDir `
                -ManagedBrokerPort $ManagedBrokerPort `
                -DesktopHandoffPreparation $DesktopHandoffPreparation `
                -TimeoutSeconds $TimeoutSeconds
        } else {
            Assert-CodexLocalRemoteRuntimeHandoffBarrier `
                -ExpectedGeneration $Generation `
                -ManagedDataDir $ManagedDataDir `
                -ManagedBrokerPort $ManagedBrokerPort `
                -Phase 'post-stop' `
                -ExpectedSidecarConnected $false `
                -DesktopHandoffPreparation $DesktopHandoffPreparation
        }
        if ([string]$postStopReadiness.runtimeInvocationId -cne
                [string]$initialReadiness.runtimeInvocationId -or
            [int]$postStopReadiness.brokerProcessId -ne
                [int]$initialReadiness.brokerProcessId -or
            [int]$postStopReadiness.upstreamProcessId -ne
                [int]$initialReadiness.upstreamProcessId) {
            throw 'Runtime handoff post-stop barrier found Broker identity drift.'
        }

        if (-not $sidecarStoppedBeforePostStopBarrier) {
            $null = & $sidecarStop `
                -NodePath $nodePath `
                -ExpectedSidecarCliPath (
                    Join-Path $activeRoot 'apps\sidecar\dist\cli.js'
                ) `
                -DataDir $ManagedDataDir `
                -Port $ManagedSidecarPort `
                -BasePath $ManagedBasePath `
                -Confirm:$false
        }
        $null = Assert-CodexLocalRemoteDesktopHandoffProcessGate `
            -ManagedDataDir $ManagedDataDir `
            -Phase 'before-broker-stop' `
            -DesktopHandoffPreparation $DesktopHandoffPreparation
        $null = & $brokerStop `
            -CodexPath ([string]$Generation.Receipt.CodexPath) `
            -NodePath $nodePath `
            -InstallRoot $activeRoot `
            -DataDir $ManagedDataDir `
            -BrokerPort $ManagedBrokerPort `
            -BrokerUpstreamPort $ManagedBrokerUpstreamPort `
            -Confirm:$false
        $null = Assert-CodexLocalRemoteDesktopHandoffProcessGate `
            -ManagedDataDir $ManagedDataDir `
            -Phase 'before-selected-task-start' `
            -DesktopHandoffPreparation $DesktopHandoffPreparation
        $forwardTaskStartAttempted = $true
        Start-CodexLocalRemoteScheduledTaskBounded `
            -Name $Name `
            -TimeoutSeconds $TimeoutSeconds
        $forwardTaskStarted = $true
        $null = Wait-CodexLocalRemoteRuntimeReadyForRoot `
            -Name $Name `
            -ExpectedRoot $selectedRoot `
            -ForbiddenRoot $activeRoot `
            -ManagedDataDir $ManagedDataDir `
            -ManagedBrokerPort $ManagedBrokerPort `
            -DesktopHandoffPreparation $DesktopHandoffPreparation `
            -TimeoutSeconds $RuntimeReadyTimeoutSeconds
        $null = Assert-CodexLocalRemoteRuntimeReadyPair `
            -Name $Name `
            -ManagedDataDir $ManagedDataDir `
            -ManagedBrokerPort $ManagedBrokerPort `
            -RollbackPlan $rollbackPlan `
            -ExpectedPairKind 'selected' `
            -ExpectedRoot $selectedRoot `
            -DesktopHandoffPreparation $DesktopHandoffPreparation
    } catch {
        $handoffFailure = $_.Exception.Message
        $recoveryDiagnostics =
            [System.Collections.Generic.List[string]]::new()
        $pairAfterFailure =
            Get-CodexLocalRemoteRuntimeTaskPairState `
                -Name $Name `
                -ManagedDataDir $ManagedDataDir `
                -RollbackPlan $rollbackPlan
        $selectedGenerationObserved = (
            $forwardTaskStarted -or
            ($forwardTaskStartAttempted -and
                $pairAfterFailure.TaskMatchesSelected -and
                [string]$pairAfterFailure.TaskState -ceq 'Running')
        )
        try {
            $generationAfterFailure =
                Get-CodexLocalRemoteRuntimeGenerationStatus `
                    -ManagedDataDir $ManagedDataDir
            if ($null -ne $generationAfterFailure -and
                (Test-CodexLocalRemotePathEqual `
                    -Left ([string]$generationAfterFailure.ActiveRoot) `
                    -Right $selectedRoot)) {
                $selectedGenerationObserved = $true
            }
        } catch {
            $recoveryDiagnostics.Add(
                "selected-generation audit failed: $($_.Exception.Message)"
            )
        }

        $cleanupBlocked = $false
        if ($forwardTaskStartAttempted -or
            $selectedGenerationObserved) {
            try {
                $null =
                    Stop-CodexLocalRemotePossiblyStartedSelectedGeneration `
                        -Name $Name `
                        -SelectedRoot $selectedRoot `
                        -NodePath $nodePath `
                        -CodexPath (
                            [string]$Generation.Receipt.CodexPath
                        ) `
                        -SelectedSidecarStopPath $selectedSidecarStop `
                        -SelectedBrokerStopPath $selectedBrokerStop `
                        -ManagedDataDir $ManagedDataDir `
                        -ManagedSidecarPort $ManagedSidecarPort `
                        -ManagedBrokerPort $ManagedBrokerPort `
                        -ManagedBrokerUpstreamPort (
                            $ManagedBrokerUpstreamPort
                        ) `
                        -ManagedBasePath $ManagedBasePath `
                        -DesktopHandoffPreparation (
                            $DesktopHandoffPreparation
                        ) `
                        -TimeoutSeconds $TimeoutSeconds
            } catch {
                $cleanupBlocked = $true
                $recoveryDiagnostics.Add(
                    "selected-generation cleanup failed: $($_.Exception.Message)"
                )
            }
        }

        $pair = Get-CodexLocalRemoteRuntimeTaskPairState `
            -Name $Name `
            -ManagedDataDir $ManagedDataDir `
            -RollbackPlan $rollbackPlan
        if (-not $cleanupBlocked -and
            -not $pair.TaskMatchesPrior) {
            try {
                Register-ScheduledTask `
                    -TaskName $Name `
                    -TaskPath '\' `
                    -Xml ([string]$rollbackPlan.PriorTaskXml) `
                    -Force | Out-Null
            } catch {
                $recoveryDiagnostics.Add(
                    "exact prior task registration failed: $($_.Exception.Message)"
                )
            }
            $pair = Get-CodexLocalRemoteRuntimeTaskPairState `
                -Name $Name `
                -ManagedDataDir $ManagedDataDir `
                -RollbackPlan $rollbackPlan
        }
        if (-not $cleanupBlocked -and
            $pair.TaskMatchesPrior -and
            -not $pair.PointerMatchesPrior) {
            try {
                $null = Set-CodexLocalRemoteCurrentRuntime `
                    -DataDir $ManagedDataDir `
                    -Runtime $rollbackPlan.PriorRuntime `
                    -CurrentTaskDefinition (
                        $rollbackPlan.PriorTaskDefinition
                    )
            } catch {
                $recoveryDiagnostics.Add(
                    "prior runtime pointer restore failed: $($_.Exception.Message)"
                )
            }
            $pair = Get-CodexLocalRemoteRuntimeTaskPairState `
                -Name $Name `
                -ManagedDataDir $ManagedDataDir `
                -RollbackPlan $rollbackPlan
        }

        if ([string]$pair.Kind -ceq 'old') {
            try {
                if ($null -ne $DesktopHandoffPreparation) {
                    throw (
                        'The exact prior pointer/task pair was restored but ' +
                        'was intentionally left stopped while the prepared ' +
                        'native Desktop owner remains live.'
                    )
                }
                Start-CodexLocalRemoteScheduledTaskBounded `
                    -Name $Name `
                    -TimeoutSeconds $TimeoutSeconds
                $null = Wait-CodexLocalRemoteRuntimeReadyForRoot `
                    -Name $Name `
                    -ExpectedRoot $activeRoot `
                    -ForbiddenRoot $selectedRoot `
                    -ManagedDataDir $ManagedDataDir `
                    -ManagedBrokerPort $ManagedBrokerPort `
                    -TimeoutSeconds $RuntimeReadyTimeoutSeconds
                $null = Assert-CodexLocalRemoteRuntimeReadyPair `
                    -Name $Name `
                    -ManagedDataDir $ManagedDataDir `
                    -ManagedBrokerPort $ManagedBrokerPort `
                    -RollbackPlan $rollbackPlan `
                    -ExpectedPairKind 'old' `
                    -ExpectedRoot $activeRoot
            } catch {
                $recoveryDiagnostics.Add(
                    "prior runtime readiness failed: $($_.Exception.Message)"
                )
                throw (
                    "Runtime handoff failed ('$handoffFailure'); " +
                    "the exact prior runtime pointer/task pair was verified, " +
                    "but prior runtime recovery was not verified " +
                    "('$($recoveryDiagnostics -join '; ')')."
                )
            }
            throw (
                "Runtime handoff failed ('$handoffFailure'); " +
                "the prior runtime pointer, exact task definition, and " +
                "readiness were restored and verified."
            )
        }

        if (-not $pair.TaskMatchesSelected) {
            try {
                Register-ScheduledTask `
                    -TaskName $Name `
                    -TaskPath '\' `
                    -Xml ([string]$rollbackPlan.SelectedTaskXml) `
                    -Force | Out-Null
            } catch {
                $recoveryDiagnostics.Add(
                    "selected task restore failed: $($_.Exception.Message)"
                )
            }
            $pair = Get-CodexLocalRemoteRuntimeTaskPairState `
                -Name $Name `
                -ManagedDataDir $ManagedDataDir `
                -RollbackPlan $rollbackPlan
        }
        if ($pair.TaskMatchesSelected -and
            -not $pair.PointerMatchesSelected) {
            try {
                $null = Set-CodexLocalRemoteCurrentRuntime `
                    -DataDir $ManagedDataDir `
                    -Runtime $rollbackPlan.SelectedRuntime `
                    -PreviousTaskPreImage (
                        $rollbackPlan.PriorTaskPreImage
                    ) `
                    -CurrentTaskDefinition (
                        $rollbackPlan.SelectedTaskDefinition
                    )
            } catch {
                $recoveryDiagnostics.Add(
                    "selected runtime pointer restore failed: $($_.Exception.Message)"
                )
            }
            $pair = Get-CodexLocalRemoteRuntimeTaskPairState `
                -Name $Name `
                -ManagedDataDir $ManagedDataDir `
                -RollbackPlan $rollbackPlan
        }
        if ([string]$pair.Kind -ceq 'selected') {
            throw (
                "Runtime handoff failed ('$handoffFailure'); prior runtime " +
                "recovery was not verified; the selected runtime pointer " +
                "and task definition remain verified."
            )
        }

        if (-not [string]::IsNullOrWhiteSpace(
            [string]$pair.Failure
        )) {
            $recoveryDiagnostics.Add(
                "final pair audit failed: $([string]$pair.Failure)"
            )
        }
        throw (
            "Runtime handoff failed ('$handoffFailure'); neither the exact " +
            "prior nor selected runtime pointer/task pair was verified " +
            "('$($recoveryDiagnostics -join '; ')')."
        )
    }
}

function Wait-CodexLocalRemoteCodexRuntimeReady {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerPort,

        [Parameter(Mandatory)]
        [object]$CurrentRuntime,

        [Parameter(Mandatory)]
        [string]$PreviousRuntimeInvocationId,

        [ValidateRange(1, 300)]
        [int]$TimeoutSeconds = 120
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastFailure = 'the new Codex runtime was not yet observable'
    do {
        try {
            if (@(Get-CodexDesktopHandoffProcesses).Count -gt 0) {
                throw 'a Desktop root appeared during the Codex runtime restart'
            }
            $task = Get-ScheduledTask `
                -TaskName $Name `
                -TaskPath '\' `
                -ErrorAction Stop
            $generation = Get-CodexLocalRemoteRuntimeGenerationStatus `
                -ManagedDataDir $ManagedDataDir
            $active = Get-CodexLocalRemoteActiveCodexRuntimeStatus `
                -ManagedDataDir $ManagedDataDir `
                -Generation $generation `
                -CurrentRuntime $CurrentRuntime
            $readiness = Get-CodexLocalRemoteReadinessSnapshot `
                -Port $ManagedBrokerPort
            $verified = (
                [string]$task.State -ceq 'Running' -and
                [string]$generation.Status -ceq 'current' -and
                [string]$generation.Receipt.RuntimeInvocationId -cmatch
                    '^[0-9a-f]{32}$' -and
                [string]$generation.Receipt.RuntimeInvocationId -cne
                    $PreviousRuntimeInvocationId -and
                [string]$active.Status -ceq 'current' -and
                (Test-CodexLocalRemoteInfrastructureSnapshot `
                    -Readiness $readiness) -and
                -not [bool]$readiness.desktopConnected -and
                [string]$readiness.runtimeInvocationId -ceq
                    [string]$generation.Receipt.RuntimeInvocationId -and
                [int]$readiness.brokerProcessId -eq
                    [int]$generation.Receipt.ProcessId -and
                [int]$readiness.upstreamProcessId -eq
                    [int]$generation.Receipt.Upstream.ProcessId
            )
            if ($verified) {
                return $active
            }
            $lastFailure =
                'task, runtime receipt, package identity, or readiness did not match'
        } catch {
            $lastFailure = [string]$_.Exception.Message
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            throw (
                'The restarted V5 task did not adopt the current Codex ' +
                "package within the bounded window: $lastFailure"
            )
        }
        Start-Sleep -Milliseconds 100
    } while ($true)
}

function Restart-CodexLocalRemoteCodexRuntime {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [object]$Generation,

        [Parameter(Mandatory)]
        [object]$CurrentRuntime,

        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedSidecarPort,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerPort,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerUpstreamPort,

        [Parameter(Mandatory)]
        [string]$ManagedBasePath,

        [switch]$SkipCompensation,

        [ValidateRange(1, 60)]
        [int]$TimeoutSeconds = 30,

        [ValidateRange(90, 300)]
        [int]$RuntimeReadyTimeoutSeconds = 120
    )

    if ([string]$Generation.Status -cne 'current' -or
        $null -eq $Generation.RegisteredTask -or
        [string]$Generation.RegisteredTask.TaskState -cne 'Running' -or
        $null -eq $Generation.ActiveBootstrap -or
        [string]$Generation.ActiveBootstrap.Status -cne 'verified' -or
        [string]$Generation.ActiveBootstrap.Contract -cne
            'desktop-owner-v5') {
        throw 'Codex runtime restart requires one exact Running V5 owner.'
    }
    if (@(Get-CodexDesktopHandoffProcesses).Count -gt 0) {
        throw 'Codex runtime restart is blocked while Desktop is running.'
    }
    $activeStatus = Get-CodexLocalRemoteActiveCodexRuntimeStatus `
        -ManagedDataDir $ManagedDataDir `
        -Generation $Generation `
        -CurrentRuntime $CurrentRuntime
    if ([string]$activeStatus.Status -cne 'drifted') {
        throw 'Codex runtime restart requires one verified package drift.'
    }
    $runtimeRoot = [System.IO.Path]::GetFullPath(
        [string]$Generation.ActiveRoot
    )
    $nodePath = [System.IO.Path]::GetFullPath(
        [string]$Generation.Receipt.NodePath
    )
    $sidecarStop = Join-Path $runtimeRoot `
        'scripts\windows\Stop-CodexLocalRemoteSidecar.ps1'
    $brokerStop = Join-Path $runtimeRoot `
        'scripts\windows\Stop-CodexAppServerBroker.ps1'
    foreach ($scriptPath in @($sidecarStop, $brokerStop)) {
        if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
            throw "Codex runtime restart script '$scriptPath' is missing."
        }
    }
    $previousInvocationId =
        [string]$Generation.Receipt.RuntimeInvocationId
    $startAttempted = $false
    try {
        $assertRestartSafe = {
            if (@(Get-CodexDesktopHandoffProcesses).Count -gt 0) {
                throw 'A Desktop root appeared before the V5 task stopped.'
            }
            $latestGeneration =
                Get-CodexLocalRemoteRuntimeGenerationStatus `
                    -ManagedDataDir $ManagedDataDir
            $latestReadiness =
                Get-CodexLocalRemoteReadinessSnapshot `
                    -Port $ManagedBrokerPort
            if (-not (Test-CodexLocalRemoteCodexRuntimeRestartSafe `
                -Readiness $latestReadiness `
                -Generation $latestGeneration) -or
                -not (Test-CodexLocalRemotePathEqual `
                    -Left ([string]$latestGeneration.SelectedRoot) `
                    -Right $runtimeRoot) -or
                -not (Test-CodexLocalRemotePathEqual `
                    -Left ([string]$latestGeneration.ActiveRoot) `
                    -Right $runtimeRoot) -or
                [string]$latestGeneration.Receipt.RuntimeInvocationId -cne
                    $previousInvocationId -or
                [int]$latestGeneration.Receipt.ProcessId -ne
                    [int]$Generation.Receipt.ProcessId -or
                [int]$latestGeneration.Receipt.Upstream.ProcessId -ne
                    [int]$Generation.Receipt.Upstream.ProcessId -or
                [string]$latestReadiness.runtimeInvocationId -cne
                    $previousInvocationId -or
                [int]$latestReadiness.brokerProcessId -ne
                    [int]$Generation.Receipt.ProcessId -or
                [int]$latestReadiness.upstreamProcessId -ne
                    [int]$Generation.Receipt.Upstream.ProcessId) {
                throw (
                    'Codex runtime restart safety changed; an active or ' +
                    'unknown request, runtime drift, or Broker drift may ' +
                    'still exist.'
                )
            }
        }
        . $assertRestartSafe
        Start-Sleep -Milliseconds 100
        . $assertRestartSafe
        Stop-ScheduledTask -TaskName $Name -TaskPath '\'
        Wait-CodexLocalRemoteScheduledTaskStoppedBounded `
            -Name $Name `
            -TimeoutSeconds $TimeoutSeconds
        . $assertRestartSafe
        $null = & $sidecarStop `
            -NodePath $nodePath `
            -ExpectedSidecarCliPath (
                Join-Path $runtimeRoot 'apps\sidecar\dist\cli.js'
            ) `
            -DataDir $ManagedDataDir `
            -Port $ManagedSidecarPort `
            -BasePath $ManagedBasePath `
            -Confirm:$false
        $null = & $brokerStop `
            -CodexPath ([string]$Generation.Receipt.CodexPath) `
            -NodePath $nodePath `
            -InstallRoot $runtimeRoot `
            -DataDir $ManagedDataDir `
            -BrokerPort $ManagedBrokerPort `
            -BrokerUpstreamPort $ManagedBrokerUpstreamPort `
            -Confirm:$false
        if (@(Get-CodexDesktopHandoffProcesses).Count -gt 0) {
            throw 'A Desktop root appeared before the V5 task restart.'
        }
        $startAttempted = $true
        Start-CodexLocalRemoteScheduledTaskBounded `
            -Name $Name `
            -TimeoutSeconds $TimeoutSeconds
        return Wait-CodexLocalRemoteCodexRuntimeReady `
            -Name $Name `
            -ManagedDataDir $ManagedDataDir `
            -ManagedBrokerPort $ManagedBrokerPort `
            -CurrentRuntime $CurrentRuntime `
            -PreviousRuntimeInvocationId $previousInvocationId `
            -TimeoutSeconds $RuntimeReadyTimeoutSeconds
    } catch {
        $restartFailure = [string]$_.Exception.Message
        $compensationFailure = $null
        if (-not $SkipCompensation -and
            @(Get-CodexDesktopHandoffProcesses).Count -eq 0) {
            try {
                Start-CodexLocalRemoteScheduledTaskBounded `
                    -Name $Name `
                    -TimeoutSeconds $TimeoutSeconds
            } catch {
                $compensationFailure = [string]$_.Exception.Message
            }
        }
        if ($SkipCompensation) {
            throw (
                "Codex runtime restart failed ('$restartFailure'); external " +
                'worker compensation remains required.'
            )
        }
        if ([string]::IsNullOrWhiteSpace($compensationFailure)) {
            throw (
                "Codex runtime restart failed ('$restartFailure'); the exact " +
                'V5 task was left Running or restarted as compensation.'
            )
        }
        throw (
            "Codex runtime restart failed ('$restartFailure'); compensating " +
            "V5 task start also failed ('$compensationFailure')."
        )
    }
}

function Start-CodexLocalRemotePackageRefreshWorker {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedSidecarPort,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerPort,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerUpstreamPort,

        [Parameter(Mandatory)]
        [string]$ManagedBasePath,

        [Parameter(Mandatory)]
        [string]$ExpectedRootIdentityKey,

        [Parameter(Mandatory)]
        [string]$ExpectedRuntimeInvocationId
    )

    if ($ExpectedRootIdentityKey -cnotmatch
            '^[1-9][0-9]*\|[1-9][0-9]*\|[0-9a-f]{64}$' -or
        $ExpectedRuntimeInvocationId -cnotmatch '^[0-9a-f]{32}$') {
        return $false
    }
    $rootKeys = @(Get-CodexDesktopRootIdentityKeys)
    if ($rootKeys.Count -ne 1 -or
        [string]$rootKeys[0] -cne $ExpectedRootIdentityKey) {
        return $false
    }
    $resolvedDataDir = [System.IO.Path]::GetFullPath($ManagedDataDir)
    $intentPath = Join-Path `
        $resolvedDataDir `
        'desktop-package-refresh-intent.json'
    if (Test-Path -LiteralPath $intentPath -PathType Leaf) {
        try {
            $existingItem =
                Get-Item -LiteralPath $intentPath -Force -ErrorAction Stop
            if ($existingItem.PSIsContainer -or
                ($existingItem.Attributes -band
                    [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
                [long]$existingItem.Length -lt 64 -or
                [long]$existingItem.Length -gt 8192) {
                throw 'The package refresh intent is not an ordinary bounded file.'
            }
            $rawBefore = Get-Content `
                -LiteralPath $intentPath `
                -Raw `
                -Encoding utf8
            $existing = $rawBefore |
                ConvertFrom-Json -Depth 8 -DateKind String -ErrorAction Stop
            $rawAfter = Get-Content `
                -LiteralPath $intentPath `
                -Raw `
                -Encoding utf8
            $requestedAt = [DateTimeOffset]::Parse(
                [string]$existing.RequestedAtUtc,
                [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind
            )
            if ($rawBefore -ceq $rawAfter -and
                [string]$existing.Signature -ceq
                    'codex-local-remote/desktop-package-refresh-intent/v1' -and
                [int]$existing.Version -eq 1 -and
                [string]$existing.ExpectedRootIdentityKey -ceq
                    $ExpectedRootIdentityKey -and
                [string]$existing.ExpectedRuntimeInvocationId -ceq
                    $ExpectedRuntimeInvocationId -and
                [string]$existing.WorkerNonce -cmatch
                    '^[0-9a-f]{32}$' -and
                $requestedAt.Offset -eq [TimeSpan]::Zero -and
                $requestedAt -ge [DateTimeOffset]::UtcNow.AddMinutes(-2) -and
                (Test-NonNegativeInteger -Value $existing.WorkerProcessId) -and
                (Test-NonNegativeInteger `
                    -Value $existing.WorkerStartTimeUtcTicks)) {
                if ([int]$existing.WorkerProcessId -eq 0 -and
                    [long]$existing.WorkerStartTimeUtcTicks -eq 0 -and
                    $requestedAt -ge
                        [DateTimeOffset]::UtcNow.AddSeconds(-15)) {
                    return $true
                }
                $existingWorker = Get-Process `
                    -Id ([int]$existing.WorkerProcessId) `
                    -ErrorAction SilentlyContinue
                if ($null -ne $existingWorker) {
                    try {
                        $existingWorker.Refresh()
                        if (-not $existingWorker.HasExited -and
                            $existingWorker.StartTime.ToUniversalTime().Ticks -eq
                                [long]$existing.WorkerStartTimeUtcTicks) {
                            return $true
                        }
                    } finally {
                        $existingWorker.Dispose()
                    }
                }
            }
        } catch {
            # An invalid or stale claim is replaced under the owner mutex.
        }
    }
    $intentId = [Guid]::NewGuid().ToString('N')
    $workerNonce = [Guid]::NewGuid().ToString('N')
    $requestedAtUtc = [DateTime]::UtcNow.ToString('O')
    $intentValue = [ordered]@{
        Signature =
            'codex-local-remote/desktop-package-refresh-intent/v1'
        Version = 1
        IntentId = $intentId
        WorkerNonce = $workerNonce
        ExpectedRootIdentityKey = $ExpectedRootIdentityKey
        ExpectedRuntimeInvocationId = $ExpectedRuntimeInvocationId
        WorkerProcessId = 0
        WorkerStartTimeUtcTicks = 0
        RequestedAtUtc = $requestedAtUtc
    }
    Write-AtomicJsonFile -Path $intentPath -Value $intentValue
    $workerPath = Join-Path `
        $PSScriptRoot `
        'Invoke-CodexLocalRemotePackageRefresh.ps1'
    if (-not (Test-Path -LiteralPath $workerPath -PathType Leaf)) {
        Remove-Item -LiteralPath $intentPath -Force -ErrorAction SilentlyContinue
        return $false
    }
    $pwshPath = Join-Path $PSHOME 'pwsh.exe'
    $workerArguments = @(
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        $workerPath,
        '-DataDir',
        $resolvedDataDir,
        '-TaskName',
        $Name,
        '-SidecarPort',
        [string]$ManagedSidecarPort,
        '-BrokerPort',
        [string]$ManagedBrokerPort,
        '-BrokerUpstreamPort',
        [string]$ManagedBrokerUpstreamPort,
        '-BasePath',
        $ManagedBasePath,
        '-IntentId',
        $intentId,
        '-WorkerNonce',
        $workerNonce
    )
    $argumentLine = (
        $workerArguments |
            ForEach-Object {
                ConvertTo-CodexWindowsCommandLineArgument -Value ([string]$_)
            }
    ) -join ' '
    try {
        $worker = Start-Process `
            -FilePath $pwshPath `
            -ArgumentList $argumentLine `
            -WindowStyle Hidden `
            -PassThru
        if ($null -eq $worker -or $worker.Id -lt 1) {
            throw 'The package refresh worker did not return a process identity.'
        }
        $worker.Dispose()
        return $true
    } catch {
        Remove-Item -LiteralPath $intentPath -Force -ErrorAction SilentlyContinue
        return $false
    }
}

function Start-CodexLocalRemoteRegisteredTask {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [int]$ManagedSidecarPort,

        [Parameter(Mandatory)]
        [int]$ManagedBrokerPort,

        [Parameter(Mandatory)]
        [int]$ManagedBrokerUpstreamPort,

        [Parameter(Mandatory)]
        [string]$ManagedBasePath,

        [AllowEmptyString()]
        [string]$ExpectedTakeoverRootIdentityKey = '',

        [AllowEmptyString()]
        [string]$ExpectedSelectedRuntimeVersionId = '',

        [AllowEmptyString()]
        [string]$ExpectedSelectedRuntimeRoot = '',

        [AllowEmptyString()]
        [string]$ExpectedSelectedManifestSha256 = '',

        [AllowNull()]
        [object]$DesktopHandoffPreparation
    )

    $selectedRuntime = $null
    if (-not [string]::IsNullOrWhiteSpace(
        $ExpectedSelectedRuntimeVersionId
    ) -or
        -not [string]::IsNullOrWhiteSpace(
            $ExpectedSelectedRuntimeRoot
        ) -or
        -not [string]::IsNullOrWhiteSpace(
            $ExpectedSelectedManifestSha256
        )) {
        $selectedRuntime = Assert-CodexExpectedSelectedRuntime `
            -ManagedDataDir $ManagedDataDir `
            -ExpectedVersionId $ExpectedSelectedRuntimeVersionId `
            -ExpectedRoot $ExpectedSelectedRuntimeRoot `
            -ExpectedManifestSha256 (
                $ExpectedSelectedManifestSha256
            )
    }
    if ($null -eq $selectedRuntime) {
        $selectedRuntime =
            Assert-CodexExpectedSelectedRuntime `
                -ManagedDataDir $ManagedDataDir
    }
    $desktopProcessCount = @(Get-CodexDesktopHandoffProcesses).Count
    if ($null -ne $DesktopHandoffPreparation) {
        if ([string]$DesktopHandoffPreparation.RuntimeVersionId -cne
                [string]$selectedRuntime.CurrentVersionId -or
            [string]$DesktopHandoffPreparation.ManifestSha256 -cne
                [string]$selectedRuntime.CurrentManifestSha256 -or
            -not (Test-CodexLocalRemotePathEqual `
                -Left ([string]$DesktopHandoffPreparation.RuntimeRoot) `
                -Right ([string]$selectedRuntime.CurrentRoot))) {
            throw (New-CodexRemoteFailureException `
                -Stage 'runtime-handoff' `
                -Code 'handoff-result-mismatch')
        }
        $null = Assert-CodexLocalRemoteDesktopHandoffProcessGate `
            -ManagedDataDir $ManagedDataDir `
            -Phase 'registered-task-start' `
            -DesktopHandoffPreparation $DesktopHandoffPreparation
        $desktopProcessCount = 0
    }
    try {
        $task = Get-ScheduledTask `
            -TaskName $Name `
            -TaskPath '\' `
            -ErrorAction Stop
    } catch {
        throw (New-CodexRemoteFailureException `
            -Stage 'runtime-handoff' `
            -Code 'runtime-generation-unverified')
    }
    if ($null -eq $task -or
        [string]$task.TaskName -cne $Name -or
        [string]$task.TaskPath -cne '\' -or
        [string]$task.Description -cnotin @(
            'codex-local-remote/startup-task/v3 - Starts the loopback app-server broker before the local-only Codex Local Remote sidecar at user sign-in.',
            'codex-local-remote/startup-task/v4 - Starts the loopback app-server broker before the local-only Codex Local Remote sidecar at user sign-in.',
            'codex-local-remote/startup-task/v5 - Starts the loopback app-server broker and local-only Codex Local Remote sidecar only on an explicit demand start.',
            'codex-local-remote/startup-task/v5 - Starts the loopback app-server broker before the local-only Codex Local Remote sidecar at user sign-in.'
        )) {
        throw (New-CodexRemoteFailureException `
            -Stage 'runtime-handoff' `
            -Code 'runtime-generation-unverified')
    }
    try {
        $generation = Get-CodexLocalRemoteRuntimeGenerationStatus `
            -ManagedDataDir $ManagedDataDir
    } catch {
        throw (New-CodexRemoteFailureException `
            -Stage 'runtime-handoff' `
            -Code 'runtime-generation-unverified')
    }
    $decision = Get-CodexLocalRemoteRuntimeHandoffDecision `
        -TaskState ([string]$task.State) `
        -GenerationStatus ([string]$generation.Status) `
        -DesktopProcessCount $desktopProcessCount
    if ($decision -ceq 'switch') {
        try {
            Switch-CodexLocalRemoteRuntimeGeneration `
                -Name $Name `
                -Generation $generation `
                -ManagedDataDir $ManagedDataDir `
                -ManagedSidecarPort $ManagedSidecarPort `
                -ManagedBrokerPort $ManagedBrokerPort `
                -ManagedBrokerUpstreamPort $ManagedBrokerUpstreamPort `
                -ManagedBasePath $ManagedBasePath `
                -DesktopHandoffPreparation $DesktopHandoffPreparation
        } catch {
            throw (New-CodexRemoteFailureException `
                -Stage 'runtime-handoff' `
                -Code 'runtime-handoff-failed')
        }
    } elseif ($decision -ceq 'start') {
        try {
            $null = Assert-CodexLocalRemoteDesktopHandoffProcessGate `
                -ManagedDataDir $ManagedDataDir `
                -Phase 'registered-task-start-final' `
                -DesktopHandoffPreparation $DesktopHandoffPreparation
            Start-CodexLocalRemoteScheduledTaskBounded -Name $Name
        } catch {
            throw (New-CodexRemoteFailureException `
                -Stage 'runtime-handoff' `
                -Code 'runtime-handoff-failed')
        }
    } elseif ($decision -cnotin @('reuse')) {
        $code = if ($decision -ceq 'block-desktop-running') {
            'desktop-running'
        } else {
            'runtime-generation-unverified'
        }
        throw (New-CodexRemoteFailureException `
            -Stage 'runtime-handoff' `
            -Code $code)
    } else {
        $desktopProcessCount = if (
            $null -ne $DesktopHandoffPreparation
        ) {
            0
        } else {
            @(Get-CodexDesktopHandoffProcesses).Count
        }
        $delegateFreshTakeoverAction = if (
            -not [string]::IsNullOrWhiteSpace(
                $ExpectedTakeoverRootIdentityKey
            )
        ) {
            {
                param([object]$ExpectedRuntime)
                $null = $ExpectedRuntime
                $latestGeneration =
                    Get-CodexLocalRemoteRuntimeGenerationStatus `
                        -ManagedDataDir $ManagedDataDir
                Start-CodexLocalRemotePackageRefreshWorker `
                    -Name $Name `
                    -ManagedDataDir $ManagedDataDir `
                    -ManagedSidecarPort $ManagedSidecarPort `
                    -ManagedBrokerPort $ManagedBrokerPort `
                    -ManagedBrokerUpstreamPort $ManagedBrokerUpstreamPort `
                    -ManagedBasePath $ManagedBasePath `
                    -ExpectedRootIdentityKey (
                        $ExpectedTakeoverRootIdentityKey
                    ) `
                    -ExpectedRuntimeInvocationId (
                        [string]$latestGeneration.Receipt.RuntimeInvocationId
                    )
            }
        } else {
            $null
        }
        $null = Invoke-CodexLocalRemoteCodexRuntimeGate `
            -DesktopProcessCount $desktopProcessCount `
            -ResolveCurrentRuntimeAction {
                Resolve-CodexDesktopRuntime `
                    -DesktopProcessCandidates @() `
                    -RuntimeCachePath (
                        Join-Path `
                            ([System.IO.Path]::GetFullPath($ManagedDataDir)) `
                            'desktop-runtime-cache.json'
                    )
            } `
            -GetActiveRuntimeStatusAction {
                param([object]$ExpectedRuntime)
                $latestGeneration =
                    Get-CodexLocalRemoteRuntimeGenerationStatus `
                        -ManagedDataDir $ManagedDataDir
                Get-CodexLocalRemoteActiveCodexRuntimeStatus `
                    -ManagedDataDir $ManagedDataDir `
                    -Generation $latestGeneration `
                    -CurrentRuntime $ExpectedRuntime
            } `
            -GetRestartSafetyStatusAction {
                $latestGeneration =
                    Get-CodexLocalRemoteRuntimeGenerationStatus `
                        -ManagedDataDir $ManagedDataDir
                $latestReadiness =
                    Get-CodexLocalRemoteReadinessSnapshot `
                        -Port $ManagedBrokerPort
                Test-CodexLocalRemoteCodexRuntimeRestartSafe `
                    -Readiness $latestReadiness `
                    -Generation $latestGeneration
            } `
            -DelegateFreshTakeoverAction $delegateFreshTakeoverAction `
            -RestartRuntimeAction {
                param([object]$ExpectedRuntime)
                $latestGeneration =
                    Get-CodexLocalRemoteRuntimeGenerationStatus `
                        -ManagedDataDir $ManagedDataDir
                Restart-CodexLocalRemoteCodexRuntime `
                    -Name $Name `
                    -Generation $latestGeneration `
                    -CurrentRuntime $ExpectedRuntime `
                    -ManagedDataDir $ManagedDataDir `
                    -ManagedSidecarPort $ManagedSidecarPort `
                    -ManagedBrokerPort $ManagedBrokerPort `
                    -ManagedBrokerUpstreamPort $ManagedBrokerUpstreamPort `
                    -ManagedBasePath $ManagedBasePath
            }
    }
}

function Invoke-CodexDesktopScopedProcessStart {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DesktopExecutablePath,

        [AllowNull()]
        [string]$RemoteEndpoint,

        [Parameter(Mandatory)]
        [scriptblock]$StartDesktopAction
    )

    return & $StartDesktopAction $DesktopExecutablePath $RemoteEndpoint
}

function Initialize-CodexDesktopSplitTokenNative {
    [CmdletBinding()]
    param()

    if ($null -ne ('CodexLocalRemote.SplitTokenNative' -as [type])) {
        return
    }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace CodexLocalRemote
{
    public static class SplitTokenNative
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct STARTUPINFO
        {
            public Int32 cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public Int32 dwX;
            public Int32 dwY;
            public Int32 dwXSize;
            public Int32 dwYSize;
            public Int32 dwXCountChars;
            public Int32 dwYCountChars;
            public Int32 dwFillAttribute;
            public Int32 dwFlags;
            public Int16 wShowWindow;
            public Int16 cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public Int32 dwProcessId;
            public Int32 dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TOKEN_MANDATORY_LABEL
        {
            internal IntPtr LabelSid;
            internal Int32 Attributes;
        }

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool OpenProcessToken(
            IntPtr processHandle,
            UInt32 desiredAccess,
            out IntPtr tokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool DuplicateTokenEx(
            IntPtr existingToken,
            UInt32 desiredAccess,
            IntPtr tokenAttributes,
            Int32 impersonationLevel,
            Int32 tokenType,
            out IntPtr newToken);

        [DllImport(
            "advapi32.dll",
            CharSet = CharSet.Unicode,
            SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CreateProcessWithTokenW(
            IntPtr token,
            UInt32 logonFlags,
            string applicationName,
            StringBuilder commandLine,
            UInt32 creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFO startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetTokenInformation(
            IntPtr tokenHandle,
            Int32 tokenInformationClass,
            IntPtr tokenInformation,
            Int32 tokenInformationLength,
            out Int32 returnLength);

        [DllImport("kernel32.dll")]
        public static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("userenv.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CreateEnvironmentBlock(
            out IntPtr environment,
            IntPtr token,
            [MarshalAs(UnmanagedType.Bool)] bool inherit);

        [DllImport("userenv.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool DestroyEnvironmentBlock(
            IntPtr environment);

        [DllImport("advapi32.dll")]
        private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

        [DllImport("advapi32.dll")]
        private static extern IntPtr GetSidSubAuthority(
            IntPtr sid,
            UInt32 subAuthority);

        public static IntPtr SecureZeroMemory(
            IntPtr destination,
            UIntPtr length)
        {
            UInt64 byteCount = length.ToUInt64();
            for (UInt64 offset = 0; offset < byteCount; offset++)
            {
                Marshal.WriteByte(
                    destination,
                    checked((Int32)offset),
                    0);
            }
            return destination;
        }

        public static bool IsTokenElevated(IntPtr tokenHandle)
        {
            IntPtr buffer = Marshal.AllocHGlobal(sizeof(Int32));
            try
            {
                Int32 returnLength;
                if (!GetTokenInformation(
                    tokenHandle,
                    20,
                    buffer,
                    sizeof(Int32),
                    out returnLength))
                {
                    throw new System.ComponentModel.Win32Exception(
                        Marshal.GetLastWin32Error());
                }
                return Marshal.ReadInt32(buffer) != 0;
            }
            finally
            {
                SecureZeroMemory(buffer, (UIntPtr)sizeof(Int32));
                Marshal.FreeHGlobal(buffer);
            }
        }

        public static UInt32 GetTokenIntegrityRid(IntPtr tokenHandle)
        {
            Int32 requiredLength;
            GetTokenInformation(
                tokenHandle,
                25,
                IntPtr.Zero,
                0,
                out requiredLength);
            if (requiredLength <= 0)
            {
                throw new System.ComponentModel.Win32Exception(
                    Marshal.GetLastWin32Error());
            }
            IntPtr buffer = Marshal.AllocHGlobal(requiredLength);
            try
            {
                if (!GetTokenInformation(
                    tokenHandle,
                    25,
                    buffer,
                    requiredLength,
                    out requiredLength))
                {
                    throw new System.ComponentModel.Win32Exception(
                        Marshal.GetLastWin32Error());
                }
                TOKEN_MANDATORY_LABEL label =
                    Marshal.PtrToStructure<TOKEN_MANDATORY_LABEL>(buffer);
                Int32 count = Marshal.ReadByte(
                    GetSidSubAuthorityCount(label.LabelSid));
                if (count < 1)
                {
                    throw new InvalidOperationException(
                        "The token integrity SID is malformed.");
                }
                return unchecked((UInt32)Marshal.ReadInt32(
                    GetSidSubAuthority(label.LabelSid, (UInt32)(count - 1))));
            }
            finally
            {
                SecureZeroMemory(buffer, (UIntPtr)requiredLength);
                Marshal.FreeHGlobal(buffer);
            }
        }
    }
}
'@
}

function Test-CodexCurrentProcessElevated {
    [CmdletBinding()]
    param()

    Initialize-CodexDesktopSplitTokenNative
    $tokenHandle = [IntPtr]::Zero
    try {
        if (-not [CodexLocalRemote.SplitTokenNative]::OpenProcessToken(
            [CodexLocalRemote.SplitTokenNative]::GetCurrentProcess(),
            [uint32]0x0008,
            [ref]$tokenHandle
        )) {
            throw [System.ComponentModel.Win32Exception]::new(
                [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            )
        }
        return [CodexLocalRemote.SplitTokenNative]::IsTokenElevated(
            $tokenHandle
        )
    } finally {
        if ($tokenHandle -ne [IntPtr]::Zero) {
            $null = [CodexLocalRemote.SplitTokenNative]::CloseHandle(
                $tokenHandle
            )
        }
    }
}

function Select-CodexDesktopInteractiveExplorerCandidate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$Candidates,

        [Parameter(Mandatory)]
        [ValidateRange(1, 2147483647)]
        [int]$InteractiveSessionId,

        [Parameter(Mandatory)]
        [string]$UserSid,

        [Parameter(Mandatory)]
        [string]$ExplorerExecutablePath
    )

    $expectedPath = [System.IO.Path]::GetFullPath($ExplorerExecutablePath)
    $eligible = @(
        $Candidates |
            Where-Object {
                [int]$_.SessionId -eq $InteractiveSessionId -and
                [string]$_.UserSid -ceq $UserSid -and
                -not [bool]$_.IsElevated -and
                [uint32]$_.IntegrityRid -eq [uint32]0x00002000 -and
                [string]::Equals(
                    [System.IO.Path]::GetFullPath(
                        [string]$_.ExecutablePath
                    ),
                    $expectedPath,
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            } |
            Sort-Object ProcessId
    )
    if ($eligible.Count -lt 1) {
        throw (
            'No same-user medium-integrity Windows Explorer token exists ' +
            'in the current interactive session.'
        )
    }
    return $eligible[0]
}

function Get-CodexDesktopExplorerTokenCandidates {
    [CmdletBinding()]
    param()

    Initialize-CodexDesktopSplitTokenNative
    $candidates = [System.Collections.Generic.List[object]]::new()
    foreach ($process in @(
        [System.Diagnostics.Process]::GetProcessesByName('explorer')
    )) {
        $tokenHandle = [IntPtr]::Zero
        $identity = $null
        try {
            $executablePath = [System.IO.Path]::GetFullPath(
                $process.MainModule.FileName
            )
            if (-not [CodexLocalRemote.SplitTokenNative]::OpenProcessToken(
                $process.Handle,
                [uint32]0x000A,
                [ref]$tokenHandle
            )) {
                continue
            }
            $identity = [System.Security.Principal.WindowsIdentity]::new(
                $tokenHandle
            )
            $candidates.Add([pscustomobject]@{
                ProcessId = [int]$process.Id
                SessionId = [int]$process.SessionId
                UserSid = [string]$identity.User.Value
                ExecutablePath = $executablePath
                IsElevated =
                    [CodexLocalRemote.SplitTokenNative]::IsTokenElevated(
                        $tokenHandle
                    )
                IntegrityRid =
                    [CodexLocalRemote.SplitTokenNative]::GetTokenIntegrityRid(
                        $tokenHandle
                    )
            })
        } catch {
            continue
        } finally {
            if ($null -ne $identity) {
                $identity.Dispose()
            }
            if ($tokenHandle -ne [IntPtr]::Zero) {
                $null = [CodexLocalRemote.SplitTokenNative]::CloseHandle(
                    $tokenHandle
                )
            }
            $process.Dispose()
        }
    }
    return @($candidates)
}

function Get-CodexDesktopInteractiveMediumToken {
    [CmdletBinding()]
    param()

    Initialize-CodexDesktopSplitTokenNative
    $currentProcess = [System.Diagnostics.Process]::GetCurrentProcess()
    $currentIdentity =
        [System.Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $interactiveSessionId = [int]$currentProcess.SessionId
        if ($interactiveSessionId -lt 1) {
            throw 'The launcher is not running in an interactive Windows session.'
        }
        $currentUserSid = [string]$currentIdentity.User.Value
    } finally {
        $currentIdentity.Dispose()
        $currentProcess.Dispose()
    }
    $windowsDirectory = Split-Path `
        -Parent `
        ([System.Environment]::SystemDirectory)
    $explorerPath = [System.IO.Path]::GetFullPath(
        (Join-Path $windowsDirectory 'explorer.exe')
    )
    $selected = Select-CodexDesktopInteractiveExplorerCandidate `
        -Candidates @(Get-CodexDesktopExplorerTokenCandidates) `
        -InteractiveSessionId $interactiveSessionId `
        -UserSid $currentUserSid `
        -ExplorerExecutablePath $explorerPath

    $sourceProcess = $null
    $sourceToken = [IntPtr]::Zero
    $sourceIdentity = $null
    $primaryToken = [IntPtr]::Zero
    $primaryTokenTransferred = $false
    try {
        $sourceProcess = [System.Diagnostics.Process]::GetProcessById(
            [int]$selected.ProcessId
        )
        $sourcePath = [System.IO.Path]::GetFullPath(
            $sourceProcess.MainModule.FileName
        )
        if ([int]$sourceProcess.SessionId -ne $interactiveSessionId -or
            -not [string]::Equals(
                $sourcePath,
                $explorerPath,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -or
            -not [CodexLocalRemote.SplitTokenNative]::OpenProcessToken(
                $sourceProcess.Handle,
                [uint32]0x000B,
                [ref]$sourceToken
            )) {
            throw 'The selected Windows Explorer token could not be reopened.'
        }
        $sourceIdentity =
            [System.Security.Principal.WindowsIdentity]::new($sourceToken)
        if ([string]$sourceIdentity.User.Value -cne $currentUserSid -or
            [CodexLocalRemote.SplitTokenNative]::IsTokenElevated(
                $sourceToken
            ) -or
            [CodexLocalRemote.SplitTokenNative]::GetTokenIntegrityRid(
                $sourceToken
            ) -ne [uint32]0x00002000) {
            throw 'The selected Windows Explorer token changed before duplication.'
        }
        if (-not [CodexLocalRemote.SplitTokenNative]::DuplicateTokenEx(
            $sourceToken,
            [uint32]0x0000018B,
            [IntPtr]::Zero,
            2,
            1,
            [ref]$primaryToken
        )) {
            throw [System.ComponentModel.Win32Exception]::new(
                [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            )
        }
        $primaryTokenTransferred = $true
        return $primaryToken
    } finally {
        if ($null -ne $sourceIdentity) {
            $sourceIdentity.Dispose()
        }
        if ($sourceToken -ne [IntPtr]::Zero) {
            $null = [CodexLocalRemote.SplitTokenNative]::CloseHandle(
                $sourceToken
            )
        }
        if ($null -ne $sourceProcess) {
            $sourceProcess.Dispose()
        }
        if (-not $primaryTokenTransferred -and
            $primaryToken -ne [IntPtr]::Zero) {
            $null = [CodexLocalRemote.SplitTokenNative]::CloseHandle(
                $primaryToken
            )
        }
    }
}

function New-CodexDesktopEnvironmentBlock {
    [CmdletBinding()]
    param(
        [IntPtr]$PrimaryToken = [IntPtr]::Zero,

        [AllowNull()]
        [string]$RemoteEndpoint,

        [Parameter(DontShow)]
        [AllowNull()]
        [char[]]$SourceEnvironmentCharacters
    )

    Initialize-CodexDesktopSplitTokenNative
    $sourcePointer = [IntPtr]::Zero
    $sourceByteLength = 0
    $sourceCharacters = $null
    try {
        if ($null -ne $SourceEnvironmentCharacters) {
            $sourceCharacters = $SourceEnvironmentCharacters
        } else {
            if ($PrimaryToken -eq [IntPtr]::Zero) {
                throw 'A primary token is required for the user environment.'
            }
            if (-not [CodexLocalRemote.SplitTokenNative]::CreateEnvironmentBlock(
                [ref]$sourcePointer,
                $PrimaryToken,
                $false
            )) {
                throw [System.ComponentModel.Win32Exception]::new(
                    [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
                )
            }
            $maximumCharacters = 4 * 1024 * 1024
            $characterCount = 0
            $previousWasNull = $false
            while ($characterCount -lt $maximumCharacters) {
                $character = [char](
                    [int](
                        [System.Runtime.InteropServices.Marshal]::ReadInt16(
                            $sourcePointer,
                            $characterCount * 2
                        )
                    ) -band 0xFFFF
                )
                $characterCount++
                if ($character -eq [char]0) {
                    if ($previousWasNull) {
                        break
                    }
                    $previousWasNull = $true
                } else {
                    $previousWasNull = $false
                }
            }
            if (-not $previousWasNull -or $characterCount -lt 2) {
                throw 'The token user environment block is malformed or oversized.'
            }
            $sourceByteLength = $characterCount * 2
            $sourceCharacters = [char[]]::new($characterCount)
            [System.Runtime.InteropServices.Marshal]::Copy(
                $sourcePointer,
                $sourceCharacters,
                0,
                $characterCount
            )
        }
    } finally {
        if ($sourcePointer -ne [IntPtr]::Zero) {
            try {
                if ($sourceByteLength -gt 0) {
                    $null =
                        [CodexLocalRemote.SplitTokenNative]::SecureZeroMemory(
                            $sourcePointer,
                            [UIntPtr]([uint64]$sourceByteLength)
                        )
                }
            } finally {
                if (-not [CodexLocalRemote.SplitTokenNative]::DestroyEnvironmentBlock(
                    $sourcePointer
                )) {
                    throw [System.ComponentModel.Win32Exception]::new(
                        [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
                    )
                }
            }
        }
    }
    if ($null -eq $sourceCharacters -or
        $sourceCharacters.Length -lt 2 -or
        $sourceCharacters[-1] -ne [char]0 -or
        $sourceCharacters[-2] -ne [char]0) {
        if ($null -ne $sourceCharacters) {
            [Array]::Clear(
                $sourceCharacters,
                0,
                $sourceCharacters.Length
            )
        }
        throw 'The token user environment block is not double-NUL terminated.'
    }

    $endpointName = 'CODEX_APP_SERVER_WS_URL'
    $segments = [System.Collections.Generic.List[object]]::new()
    $sourceOffset = 0
    $pointer = [IntPtr]::Zero
    $characters = $null
    try {
        while ($sourceOffset -lt $sourceCharacters.Length - 1 -and
            $sourceCharacters[$sourceOffset] -ne [char]0) {
            $entryStart = $sourceOffset
            while ($sourceOffset -lt $sourceCharacters.Length -and
                $sourceCharacters[$sourceOffset] -ne [char]0) {
                $sourceOffset++
            }
            if ($sourceOffset -ge $sourceCharacters.Length) {
                throw 'The token user environment contains an unterminated entry.'
            }
            $entryLength = $sourceOffset - $entryStart
            $separatorOffset = if (
                $sourceCharacters[$entryStart] -eq '='
            ) {
                $entryStart + 1
            } else {
                $entryStart
            }
            while ($separatorOffset -lt $sourceOffset -and
                $sourceCharacters[$separatorOffset] -ne '=') {
                $separatorOffset++
            }
            if ($separatorOffset -ge $sourceOffset) {
                throw 'The token user environment contains an invalid entry.'
            }
            $nameLength = $separatorOffset - $entryStart
            $nameMatches = $nameLength -eq $endpointName.Length
            if ($nameMatches) {
                for ($index = 0; $index -lt $nameLength; $index++) {
                    if ([char]::ToUpperInvariant(
                        $sourceCharacters[$entryStart + $index]
                    ) -cne [char]::ToUpperInvariant($endpointName[$index])) {
                        $nameMatches = $false
                        break
                    }
                }
            }
            if (-not $nameMatches) {
                $segments.Add([pscustomobject]@{
                    Start = $entryStart
                    Length = $entryLength
                    NameLength = $nameLength
                })
            }
            $sourceOffset++
        }

        $includeEndpoint =
            -not [string]::IsNullOrWhiteSpace($RemoteEndpoint)
        $characterCount = 1
        foreach ($segment in $segments) {
            $characterCount += [int]$segment.Length + 1
        }
        if ($includeEndpoint) {
            $characterCount +=
                $endpointName.Length + 1 + $RemoteEndpoint.Length + 1
        }
        if ($characterCount -eq 1) {
            $characterCount = 2
        }
        $characters = [char[]]::new($characterCount)
        $offset = 0
        $endpointInserted = -not $includeEndpoint
        foreach ($segment in $segments) {
            if (-not $endpointInserted) {
                $comparisonLength = [Math]::Min(
                    [int]$segment.NameLength,
                    $endpointName.Length
                )
                $comparison = 0
                for ($index = 0;
                    $index -lt $comparisonLength;
                    $index++) {
                    $comparison = [char]::ToUpperInvariant(
                        $sourceCharacters[
                            ([int]$segment.Start) + $index
                        ]
                    ).CompareTo(
                        [char]::ToUpperInvariant($endpointName[$index])
                    )
                    if ($comparison -ne 0) {
                        break
                    }
                }
                if ($comparison -eq 0) {
                    $comparison =
                        [int]$segment.NameLength - $endpointName.Length
                }
                if ($comparison -gt 0) {
                    foreach ($character in $endpointName.ToCharArray()) {
                        $characters[$offset++] = $character
                    }
                    $characters[$offset++] = '='
                    foreach ($character in $RemoteEndpoint.ToCharArray()) {
                        $characters[$offset++] = $character
                    }
                    $characters[$offset++] = [char]0
                    $endpointInserted = $true
                }
            }
            [Array]::Copy(
                $sourceCharacters,
                [int]$segment.Start,
                $characters,
                $offset,
                [int]$segment.Length
            )
            $offset += [int]$segment.Length
            $characters[$offset++] = [char]0
        }
        if (-not $endpointInserted) {
            foreach ($character in $endpointName.ToCharArray()) {
                $characters[$offset++] = $character
            }
            $characters[$offset++] = '='
            foreach ($character in $RemoteEndpoint.ToCharArray()) {
                $characters[$offset++] = $character
            }
            $characters[$offset++] = [char]0
        }
        $characters[$offset] = [char]0
        $byteLength = [int]($characters.Length * 2)
        $pointer =
            [System.Runtime.InteropServices.Marshal]::AllocHGlobal($byteLength)
        [System.Runtime.InteropServices.Marshal]::Copy(
            $characters,
            0,
            $pointer,
            $characters.Length
        )
        return [pscustomobject]@{
            Pointer = $pointer
            ByteLength = $byteLength
            Characters = $characters
        }
    } catch {
        if ($null -ne $characters) {
            [Array]::Clear($characters, 0, $characters.Length)
        }
        if ($pointer -ne [IntPtr]::Zero) {
            $null =
                [CodexLocalRemote.SplitTokenNative]::SecureZeroMemory(
                    $pointer,
                    [UIntPtr]([uint64]($characters.Length * 2))
                )
            [System.Runtime.InteropServices.Marshal]::FreeHGlobal($pointer)
        }
        throw
    } finally {
        [Array]::Clear(
            $sourceCharacters,
            0,
            $sourceCharacters.Length
        )
    }
}

function Clear-CodexDesktopEnvironmentBlock {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$EnvironmentBlock
    )

    if ($null -eq $EnvironmentBlock) {
        return
    }
    if ($null -ne $EnvironmentBlock.Characters) {
        [Array]::Clear(
            $EnvironmentBlock.Characters,
            0,
            $EnvironmentBlock.Characters.Length
        )
    }
    if ($EnvironmentBlock.Pointer -ne [IntPtr]::Zero) {
        $null = [CodexLocalRemote.SplitTokenNative]::SecureZeroMemory(
            $EnvironmentBlock.Pointer,
            [UIntPtr]([uint64]$EnvironmentBlock.ByteLength)
        )
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal(
            $EnvironmentBlock.Pointer
        )
        $EnvironmentBlock.Pointer = [IntPtr]::Zero
        $EnvironmentBlock.ByteLength = 0
    }
}

function ConvertTo-CodexWindowsCommandLineArgument {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Value
    )

    if ($Value -notmatch '[\s"]' -and $Value.Length -gt 0) {
        return $Value
    }
    $builder = [System.Text.StringBuilder]::new()
    $null = $builder.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes++
            continue
        }
        if ($character -eq '"') {
            $null = $builder.Append('\' * (($backslashes * 2) + 1))
            $null = $builder.Append('"')
        } else {
            if ($backslashes -gt 0) {
                $null = $builder.Append('\' * $backslashes)
            }
            $null = $builder.Append($character)
        }
        $backslashes = 0
    }
    if ($backslashes -gt 0) {
        $null = $builder.Append('\' * ($backslashes * 2))
    }
    $null = $builder.Append('"')
    return $builder.ToString()
}

function Start-CodexDesktopProcessWithInteractiveToken {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DesktopExecutablePath,

        [AllowNull()]
        [string]$RemoteEndpoint,

        [AllowEmptyCollection()]
        [string[]]$ArgumentList = @()
    )

    Initialize-CodexDesktopSplitTokenNative
    $executablePath = [System.IO.Path]::GetFullPath($DesktopExecutablePath)
    $workingDirectory = Split-Path -Parent $executablePath
    $commandLine = [System.Text.StringBuilder]::new()
    $null = $commandLine.Append(
        (ConvertTo-CodexWindowsCommandLineArgument -Value $executablePath)
    )
    foreach ($argument in $ArgumentList) {
        $null = $commandLine.Append(' ')
        $null = $commandLine.Append(
            (ConvertTo-CodexWindowsCommandLineArgument -Value $argument)
        )
    }

    $primaryToken = [IntPtr]::Zero
    $environmentBlock = $null
    $processInformation =
        [CodexLocalRemote.SplitTokenNative+PROCESS_INFORMATION]::new()
    $managedProcess = $null
    try {
        $primaryToken = Get-CodexDesktopInteractiveMediumToken
        $environmentBlock = New-CodexDesktopEnvironmentBlock `
            -PrimaryToken $primaryToken `
            -RemoteEndpoint $RemoteEndpoint
        $startupInfo = [CodexLocalRemote.SplitTokenNative+STARTUPINFO]::new()
        $startupInfo.cb = [System.Runtime.InteropServices.Marshal]::SizeOf(
            [type][CodexLocalRemote.SplitTokenNative+STARTUPINFO]
        )
        if (-not [CodexLocalRemote.SplitTokenNative]::CreateProcessWithTokenW(
            $primaryToken,
            [uint32]1,
            $executablePath,
            $commandLine,
            [uint32]0x00000400,
            $environmentBlock.Pointer,
            $workingDirectory,
            [ref]$startupInfo,
            [ref]$processInformation
        )) {
            throw [System.ComponentModel.Win32Exception]::new(
                [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            )
        }
        $managedProcess = [System.Diagnostics.Process]::GetProcessById(
            $processInformation.dwProcessId
        )
        return $managedProcess
    } catch {
        if ($null -ne $managedProcess) {
            $managedProcess.Dispose()
        }
        throw
    } finally {
        Clear-CodexDesktopEnvironmentBlock `
            -EnvironmentBlock $environmentBlock
        if ($processInformation.hThread -ne [IntPtr]::Zero) {
            $null = [CodexLocalRemote.SplitTokenNative]::CloseHandle(
                $processInformation.hThread
            )
        }
        if ($processInformation.hProcess -ne [IntPtr]::Zero) {
            $null = [CodexLocalRemote.SplitTokenNative]::CloseHandle(
                $processInformation.hProcess
            )
        }
        if ($primaryToken -ne [IntPtr]::Zero) {
            $null = [CodexLocalRemote.SplitTokenNative]::CloseHandle(
                $primaryToken
            )
        }
    }
}

function Start-CodexDesktopProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DesktopExecutablePath,

        [AllowNull()]
        [string]$RemoteEndpoint,

        [AllowEmptyCollection()]
        [string[]]$ArgumentList = @(),

        [switch]$RedirectStandardOutput,

        [Parameter(DontShow)]
        [scriptblock]$TestElevatedAction = {
            Test-CodexCurrentProcessElevated
        },

        [Parameter(DontShow)]
        [scriptblock]$StartWithInteractiveTokenAction = {
            param(
                [string]$ExecutablePath,
                [AllowNull()]
                [string]$Endpoint,
                [string[]]$Arguments
            )
            Start-CodexDesktopProcessWithInteractiveToken `
                -DesktopExecutablePath $ExecutablePath `
                -RemoteEndpoint $Endpoint `
                -ArgumentList $Arguments
        }
    )

    if ([bool](& $TestElevatedAction)) {
        if ($RedirectStandardOutput) {
            throw (
                'Standard-output redirection is unavailable for the ' +
                'interactive medium-token Desktop launch.'
            )
        }
        return & $StartWithInteractiveTokenAction `
            $DesktopExecutablePath `
            $RemoteEndpoint `
            $ArgumentList
    }

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = [System.IO.Path]::GetFullPath(
        $DesktopExecutablePath
    )
    $startInfo.WorkingDirectory = Split-Path `
        -Parent `
        $startInfo.FileName
    # Windows PowerShell's Start-Process may delegate through ShellExecute for
    # packaged applications. That path can create the real Electron process
    # outside the launcher's environment, silently dropping the scoped Broker
    # endpoint. CreateProcess semantics keep the endpoint on the exact child.
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $false
    $startInfo.RedirectStandardOutput = [bool]$RedirectStandardOutput
    foreach ($argument in $ArgumentList) {
        $startInfo.ArgumentList.Add($argument)
    }
    $null = $startInfo.Environment.Remove('CODEX_APP_SERVER_WS_URL')
    if (-not [string]::IsNullOrWhiteSpace($RemoteEndpoint)) {
        $startInfo.Environment['CODEX_APP_SERVER_WS_URL'] = $RemoteEndpoint
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            throw 'Codex Desktop process creation returned false.'
        }
        return $process
    } catch {
        $process.Dispose()
        throw
    }
}

function Write-CodexDesktopLaunchReceipt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [object]$Result
    )

    $allowedStatuses = @(
        'already-running',
        'launched-native',
        'launched-remote',
        'remote-launch-unverified'
    )
    $allowedDecisions = @(
        'broker-reports-desktop-connected',
        'created-desktop-identity-unavailable',
        'created-desktop-identity-unverified',
        'existing-desktop-preserved',
        'existing-desktop-takeover-identity-unverified',
        'existing-desktop-takeover-runtime-unverified',
        'existing-desktop-takeover-state-drifted',
        'existing-native-desktop-relaunched-remote',
        'remote-attach-failed-process-preserved',
        'remote-attached',
        'remote-attached-root-process-set-unverified',
        'remote-attached-then-unverified-process-preserved',
        'remote-broker-lost-before-attach',
        'remote-desktop-exited-before-attach',
        'remote-desktop-exited-before-identity',
        'remote-desktop-launch-failed',
        'remote-endpoint-unavailable',
        'remote-health-check-failed',
        'remote-not-ready',
        'remote-ready',
        'remote-start-failed'
    )
    $status = if ($Result.Status -is [string] -and
        $allowedStatuses -ccontains [string]$Result.Status) {
        [string]$Result.Status
    } else {
        'remote-launch-unverified'
    }
    $remoteEnabled = if ($Result.RemoteEnabled -is [bool]) {
        [bool]$Result.RemoteEnabled
    } else {
        $null
    }
    $remoteDecision = if ($Result.RemoteDecision -is [string] -and
        $allowedDecisions -ccontains [string]$Result.RemoteDecision) {
        [string]$Result.RemoteDecision
    } else {
        'remote-start-failed'
    }
    $remoteFallbackAttempts = if (
        (Test-NonNegativeInteger -Value $Result.RemoteFallbackAttempts) -and
        [decimal]$Result.RemoteFallbackAttempts -le [int]::MaxValue
    ) {
        [int]$Result.RemoteFallbackAttempts
    } else {
        0
    }
    $remoteStopAttempts = if (
        (Test-NonNegativeInteger -Value $Result.RemoteStopAttempts) -and
        [decimal]$Result.RemoteStopAttempts -le [int]::MaxValue
    ) {
        [int]$Result.RemoteStopAttempts
    } else {
        0
    }
    $desktopProcessId = if (
        (Test-NonNegativeInteger -Value $Result.DesktopProcessId) -and
        [decimal]$Result.DesktopProcessId -gt 0 -and
        [decimal]$Result.DesktopProcessId -le [int]::MaxValue
    ) {
        [int]$Result.DesktopProcessId
    } else {
        $null
    }
    $allowedFailureStages = @(
        'remote-health-check',
        'runtime-handoff',
        'remote-readiness',
        'remote-endpoint',
        'desktop-start',
        'desktop-attach',
        'desktop-cleanup',
        'unexpected'
    )
    $allowedFailureCodes = @(
        'health-check-failed',
        'runtime-generation-unverified',
        'desktop-running',
        'handoff-request-invalid',
        'handoff-launch-denied',
        'handoff-launch-failed',
        'handoff-timeout',
        'handoff-result-invalid',
        'handoff-result-mismatch',
        'runtime-handoff-failed',
        'readiness-timeout',
        'endpoint-invalid',
        'desktop-start-failed',
        'desktop-attach-failed',
        'desktop-cleanup-failed',
        'unexpected'
    )
    $remoteFailureStage = $null
    $remoteFailureCode = $null
    $candidateStage = $Result.RemoteFailureStage
    $candidateCode = $Result.RemoteFailureCode
    if ($null -ne $candidateStage -or $null -ne $candidateCode) {
        if ($candidateStage -is [string] -and
            $candidateCode -is [string] -and
            $allowedFailureStages -ccontains [string]$candidateStage -and
            $allowedFailureCodes -ccontains [string]$candidateCode) {
            $remoteFailureStage = [string]$candidateStage
            $remoteFailureCode = [string]$candidateCode
        } else {
            $remoteFailureStage = 'unexpected'
            $remoteFailureCode = 'unexpected'
        }
    }
    $correlationId = if ($Result.CorrelationId -is [string] -and
        [string]$Result.CorrelationId -cmatch '^[0-9a-f]{32}$') {
        [string]$Result.CorrelationId
    } else {
        $null
    }
    $allowedFeedbackStatuses = @(
        'pending',
        'rendered',
        'render-failed',
        'suppressed',
        'filtered'
    )
    $feedbackStatus = if ($Result.FeedbackStatus -is [string] -and
        $allowedFeedbackStatuses -ccontains
            [string]$Result.FeedbackStatus) {
        [string]$Result.FeedbackStatus
    } else {
        'render-failed'
    }
    $feedbackFailureCode = if ($feedbackStatus -ceq 'render-failed') {
        'feedback-render-failed'
    } else {
        $null
    }
    $receipt = [pscustomobject][ordered]@{
        Signature = 'codex-local-remote/desktop-launch/v2'
        Version = 2
        Status = $status
        RemoteEnabled = $remoteEnabled
        RemoteDecision = $remoteDecision
        RemoteFallbackAttempts = $remoteFallbackAttempts
        RemoteStopAttempts = $remoteStopAttempts
        DesktopProcessId = $desktopProcessId
        RemoteFailureStage = $remoteFailureStage
        RemoteFailureCode = $remoteFailureCode
        CorrelationId = $correlationId
        FeedbackStatus = $feedbackStatus
        FeedbackFailureCode = $feedbackFailureCode
        RecordedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    Write-AtomicJsonFile `
        -Path (Join-Path $DataDir 'desktop-launch-last.json') `
        -Value $receipt
}

function Get-CodexDesktopLaunchIdentity {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Process
    )

    if ($null -eq $Process) {
        return $null
    }
    $idProperty = if ($null -ne $Process.PSObject.Properties['Id']) {
        $Process.PSObject.Properties['Id']
    } else {
        $Process.PSObject.Properties['ProcessId']
    }
    if ($null -eq $idProperty -or [int]$idProperty.Value -lt 1) {
        return $null
    }
    $startTimeUtcTicks = if (
        $null -ne $Process.PSObject.Properties['StartTimeUtcTicks']
    ) {
        [long]$Process.StartTimeUtcTicks
    } elseif ($null -ne $Process.PSObject.Properties['CreationDate']) {
        $creationDateUtcTicks = [long](
            Get-ProcessCreationIdentity -CreationDate $Process.CreationDate
        ).CreationDateUtcTicks
        $identityProcess = Get-Process `
            -Id ([int]$idProperty.Value) `
            -ErrorAction SilentlyContinue
        if ($null -eq $identityProcess) {
            return $null
        }
        try {
            $actualStartTimeUtcTicks =
                $identityProcess.StartTime.ToUniversalTime().Ticks
            if ([Math]::Abs(
                $actualStartTimeUtcTicks - $creationDateUtcTicks
            ) -gt [TimeSpan]::FromSeconds(2).Ticks) {
                return $null
            }
            [long]$actualStartTimeUtcTicks
        } catch {
            return $null
        } finally {
            $identityProcess.Dispose()
        }
    } elseif ($null -ne $Process.PSObject.Properties['StartTime']) {
        ([datetime]$Process.StartTime).ToUniversalTime().Ticks
    } else {
        0
    }
    if ($startTimeUtcTicks -le 0) {
        return $null
    }
    $executablePath = if (
        $null -ne $Process.PSObject.Properties['ExecutablePath']
    ) {
        [string]$Process.ExecutablePath
    } elseif ($null -ne $Process.PSObject.Properties['Path']) {
        [string]$Process.Path
    } else {
        ''
    }
    if (-not [string]::IsNullOrWhiteSpace($executablePath)) {
        try {
            $executablePath = [System.IO.Path]::GetFullPath($executablePath)
        } catch {
            $executablePath = ''
        }
    }
    return [pscustomobject]@{
        ProcessId = [int]$idProperty.Value
        StartTimeUtcTicks = $startTimeUtcTicks
        ExecutablePath = $executablePath
    }
}

function Test-CodexDesktopLaunchIdentityMatch {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Expected,

        [AllowNull()]
        [object]$Actual
    )

    if ($null -eq $Expected -or $null -eq $Actual) {
        return $false
    }
    if ([int]$Expected.ProcessId -ne [int]$Actual.ProcessId -or
        [long]$Expected.StartTimeUtcTicks -ne
            [long]$Actual.StartTimeUtcTicks) {
        return $false
    }
    if ([string]::IsNullOrWhiteSpace([string]$Expected.ExecutablePath) -or
        [string]::IsNullOrWhiteSpace([string]$Actual.ExecutablePath)) {
        return $false
    }
    try {
        $expectedPath = [System.IO.Path]::GetFullPath(
            [string]$Expected.ExecutablePath
        )
        $actualPath = [System.IO.Path]::GetFullPath(
            [string]$Actual.ExecutablePath
        )
    } catch {
        return $false
    }
    return [string]::Equals(
        $expectedPath,
        $actualPath,
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Get-CodexDesktopLaunchIdentityWithRetry {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Process,

        [ValidateRange(1, 10)]
        [int]$Attempts = 3,

        [ValidateRange(0, 1000)]
        [int]$DelayMilliseconds = 25
    )

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            $identity = Get-CodexDesktopLaunchIdentity -Process $Process
        } catch {
            $identity = $null
        }
        if ($null -ne $identity) {
            return $identity
        }
        if ($attempt -lt $Attempts -and $DelayMilliseconds -gt 0) {
            Start-Sleep -Milliseconds $DelayMilliseconds
        }
    }
    return $null
}

function New-CodexDesktopLaunchNonce {
    [CmdletBinding()]
    param()

    do {
        $bytes = [byte[]]::new(32)
        $generator =
            [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $generator.GetBytes($bytes)
        } finally {
            $generator.Dispose()
        }
        $nonce = [Convert]::ToBase64String($bytes).
            TrimEnd('=').
            Replace('+', '-').
            Replace('/', '_')
    } while (@($nonce.ToCharArray() | Select-Object -Unique).Count -lt 12)
    return $nonce
}

function Get-CodexDesktopLaunchNonceDigest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Nonce
    )

    if ($Nonce -cnotmatch '^[A-Za-z0-9_-]{43,256}$' -or
        @($Nonce.ToCharArray() | Select-Object -Unique).Count -lt 12) {
        throw 'The Desktop launch nonce is not a high-entropy base64url value.'
    }
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digestBytes = $sha256.ComputeHash(
            [System.Text.Encoding]::UTF8.GetBytes($Nonce)
        )
        return -join @(
            $digestBytes |
                ForEach-Object {
                    $_.ToString('x2')
                }
        )
    } finally {
        $sha256.Dispose()
    }
}

function Add-CodexDesktopLaunchNonceToEndpoint {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$RemoteEndpoint,

        [Parameter(Mandatory)]
        [string]$LaunchNonce
    )

    if ($RemoteEndpoint -cnotmatch
        '^ws://127\.0\.0\.1:\d+/ws/[A-Za-z0-9_-]{32,}$') {
        throw 'The managed Broker capability endpoint is invalid.'
    }
    $null = Get-CodexDesktopLaunchNonceDigest -Nonce $LaunchNonce
    return (
        "$RemoteEndpoint" +
        "?desktopLaunchNonce=$LaunchNonce"
    )
}

function Test-CodexDesktopRemoteReadinessSnapshot {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Readiness
    )

    return (
        $script:WindowsModuleAvailable -and
        (Test-CodexDesktopNonceReadinessSnapshot -Readiness $Readiness)
    )
}

function Test-CodexDesktopTakeoverSafetySnapshot {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Readiness
    )

    return (
        (Test-CodexDesktopRemoteReadinessSnapshot `
            -Readiness $Readiness)
    )
}

function Test-CodexDesktopLaunchAttachedSnapshot {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Readiness,

        [Parameter(Mandatory)]
        [string]$ExpectedLaunchNonceDigest
    )

    if ($ExpectedLaunchNonceDigest -cnotmatch '^[0-9a-f]{64}$' -or
        -not (
            Test-CodexDesktopRemoteReadinessSnapshot `
                -Readiness $Readiness
        )) {
        return $false
    }
    $connectionCount = [int]$Readiness.desktopConnectionCount
    $digests = @($Readiness.desktopLaunchNonceDigests)
    if ($connectionCount -lt 1 -or
        $digests.Count -ne $connectionCount) {
        return $false
    }
    foreach ($digest in $digests) {
        if ([string]$digest -cne $ExpectedLaunchNonceDigest) {
            return $false
        }
    }
    return $true
}

function Get-CodexExistingRemoteDesktopProof {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Readiness,

        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$RootCandidates,

        [Parameter(Mandatory)]
        [string]$ExpectedExecutablePath,

        [AllowNull()]
        [object]$PersistedOwnerProof
    )

    if (-not (
        Test-CodexDesktopRemoteReadinessSnapshot -Readiness $Readiness
    ) -or
        -not [bool]$Readiness.desktopConnected -or
        $null -eq $PersistedOwnerProof -or
        $RootCandidates.Count -ne 1) {
        return $null
    }
    $identity = Get-CodexDesktopLaunchIdentity -Process $RootCandidates[0]
    if ($null -eq $identity -or
        [string]::IsNullOrWhiteSpace([string]$identity.ExecutablePath)) {
        return $null
    }
    try {
        $expectedPath = [System.IO.Path]::GetFullPath(
            $ExpectedExecutablePath
        )
        $actualPath = [System.IO.Path]::GetFullPath(
            [string]$identity.ExecutablePath
        )
    } catch {
        return $null
    }
    if (-not [string]::Equals(
        $expectedPath,
        $actualPath,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        return $null
    }
    $rootIdentityKey = Get-CodexDesktopOwnerRootIdentityKey `
        -ProcessId ([int]$identity.ProcessId) `
        -StartTimeUtcTicks ([long]$identity.StartTimeUtcTicks) `
        -ExecutablePath ([string]$identity.ExecutablePath)
    if (-not (Test-CodexDesktopOwnerConnectionProof `
        -Readiness $Readiness `
        -Proof $PersistedOwnerProof `
        -ExpectedRuntimeInvocationId (
            [string]$Readiness.runtimeInvocationId
        ) `
        -RootIdentityKey $rootIdentityKey)) {
        return $null
    }
    return $identity
}

function Get-CodexDesktopCreatedProcessHandleState {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Process
    )

    if ($null -eq $Process) {
        return 'identity-unverified'
    }
    try {
        $Process.Refresh()
        if ($Process.HasExited) {
            return 'exited'
        }
        return 'running'
    } catch {
        return 'identity-unverified'
    }
}

function Get-CodexDesktopCreatedProcessState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateRange(1, 2147483647)]
        [int]$ProcessId,

        [Parameter(Mandatory)]
        [long]$StartTimeUtcTicks
    )

    $process = Get-Process `
        -Id $ProcessId `
        -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return 'exited'
    }
    try {
        $process.Refresh()
        if ($process.HasExited) {
            return 'exited'
        }
        if ($process.StartTime.ToUniversalTime().Ticks -ne
            $StartTimeUtcTicks) {
            return 'identity-mismatch'
        }
        return 'running'
    } catch {
        return 'identity-unverified'
    } finally {
        $process.Dispose()
    }
}

function Stop-CodexDesktopCreatedProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateRange(1, 2147483647)]
        [int]$ProcessId,

        [Parameter(Mandatory)]
        [long]$StartTimeUtcTicks,

        [Parameter(Mandatory)]
        [string]$ExpectedExecutablePath
    )

    try {
        $identity = Open-ProcessIdentityHandle `
            -ProcessId $ProcessId `
            -ExpectedCreationDateUtcTicks $StartTimeUtcTicks `
            -ExpectedStartTimeUtcTicks $StartTimeUtcTicks
    } catch {
        if ($null -eq (
            Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        )) {
            return 'already-exited'
        }
        return 'identity-unverified'
    }
    try {
        try {
            $actualExecutablePath = [System.IO.Path]::GetFullPath(
                [string]$identity.Process.Path
            )
            $resolvedExpectedExecutablePath = [System.IO.Path]::GetFullPath(
                $ExpectedExecutablePath
            )
        } catch {
            return 'identity-unverified'
        }
        if (-not [string]::Equals(
            $actualExecutablePath,
            $resolvedExpectedExecutablePath,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            return 'identity-unverified'
        }
        $stopped = Stop-ProcessIdentityHandle `
            -IdentityHandle $identity `
            -TimeoutMilliseconds 5000
        if ($stopped) {
            return 'stopped'
        }
        return 'already-exited'
    } catch {
        return 'identity-unverified'
    } finally {
        $identity.Process.Dispose()
    }
}

function ConvertFrom-UnicodeCharacterCodes {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [int[]]$CodePoints
    )

    return (($CodePoints | ForEach-Object { [char]$_ }) -join '')
}

function Get-CodexRemoteLaunchFeedback {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Result
    )

    $startedTitle = ConvertFrom-UnicodeCharacterCodes -CodePoints @(
        0x0043, 0x0068, 0x0061, 0x0074, 0x0047, 0x0050, 0x0054,
        0x0020, 0x5DF2, 0x542F, 0x52A8
    )
    $remoteFailedTitle = ConvertFrom-UnicodeCharacterCodes -CodePoints @(
        0x8FDC, 0x7A0B, 0x542F, 0x52A8, 0x5931, 0x8D25
    )
    if ($Result.RemoteEnabled -eq $true) {
        return [pscustomobject][ordered]@{
            Kind = 'connected'
            Title = $startedTitle
            Message = ConvertFrom-UnicodeCharacterCodes -CodePoints @(
                0x8FDC, 0x7A0B, 0x5DF2, 0x8FDE, 0x63A5, 0xFF0C,
                0x53EF, 0x4EE5, 0x4ECE, 0x624B, 0x673A, 0x7EE7,
                0x7EED, 0x4F7F, 0x7528, 0x3002
            )
            Icon = 'Info'
        }
    }
    if ([string]$Result.Status -ceq 'already-running') {
        return [pscustomobject][ordered]@{
            Kind = 'already-running'
            Title = ConvertFrom-UnicodeCharacterCodes -CodePoints @(
                0x0043, 0x0068, 0x0061, 0x0074, 0x0047, 0x0050,
                0x0054, 0x0020, 0x5DF2, 0x5728, 0x8FD0, 0x884C
            )
            Message = ConvertFrom-UnicodeCharacterCodes -CodePoints @(
                0x8FDC, 0x7A0B, 0x72B6, 0x6001, 0x672A, 0x786E,
                0x8BA4, 0xFF1B, 0x8BF7, 0x5148, 0x9000, 0x51FA,
                0x0020, 0x0043, 0x0068, 0x0061, 0x0074, 0x0047,
                0x0050, 0x0054, 0xFF0C, 0x518D, 0x4F7F, 0x7528,
                0x6B64, 0x5FEB, 0x6377, 0x65B9, 0x5F0F, 0x3002
            )
            Icon = 'Warning'
        }
    }
    return [pscustomobject][ordered]@{
        Kind = 'degraded'
        Title = $remoteFailedTitle
        Message = ConvertFrom-UnicodeCharacterCodes -CodePoints @(
            0x8FDC, 0x7A0B, 0x672A, 0x8FDE, 0x63A5, 0xFF0C,
            0x0043, 0x0068, 0x0061, 0x0074, 0x0047, 0x0050,
            0x0054, 0x0020, 0x5DF2, 0x6309, 0x539F, 0x751F,
            0x6A21, 0x5F0F, 0x542F, 0x52A8, 0x3002
        )
        Icon = 'Warning'
    }
}

function Show-CodexRemoteLaunchFeedback {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Feedback,

        [ValidateRange(250, 15000)]
        [int]$DisplayMilliseconds = 4200,

        [string]$IconPath
    )

    $form = $null
    $formIcon = $null
    $formIconBitmap = $null
    $feedbackStatus = 'render-failed'
    $feedbackFailureCode = 'feedback-render-failed'
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        if ($null -eq ('CodexLocalRemote.WindowApi' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace CodexLocalRemote {
    public static class WindowApi {
        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr windowHandle, int command);
    }
}
'@ -ErrorAction Stop
        }

        $connected = [string]$Feedback.Icon -ceq 'Info'
        $accentColor = if ($connected) {
            [System.Drawing.Color]::FromArgb(16, 124, 65)
        } else {
            [System.Drawing.Color]::FromArgb(180, 83, 9)
        }

        $form = [System.Windows.Forms.Form]::new()
        $form.Text = [string]$Feedback.Title
        $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedSingle
        $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
        $form.ShowInTaskbar = $false
        $form.TopMost = $true
        $form.ControlBox = $false
        $form.MaximizeBox = $false
        $form.MinimizeBox = $false
        $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi
        $form.ClientSize = [System.Drawing.Size]::new(420, 104)
        $form.BackColor = [System.Drawing.Color]::White
        $form.AccessibleName = [string]$Feedback.Title

        $contentLeft = 26
        if (-not [string]::IsNullOrWhiteSpace($IconPath) -and
            (Test-Path -LiteralPath $IconPath -PathType Leaf)) {
            try {
                $formIcon = [System.Drawing.Icon]::new(
                    [System.IO.Path]::GetFullPath($IconPath)
                )
                $form.Icon = $formIcon
                $formIconBitmap = $formIcon.ToBitmap()
                $picture = [System.Windows.Forms.PictureBox]::new()
                $picture.Location = [System.Drawing.Point]::new(24, 22)
                $picture.Size = [System.Drawing.Size]::new(30, 30)
                $picture.SizeMode =
                    [System.Windows.Forms.PictureBoxSizeMode]::Zoom
                $picture.Image = $formIconBitmap
                $picture.AccessibleName = 'ChatGPT'
                $form.Controls.Add($picture)
                $contentLeft = 66
            } catch {
                if ($null -ne $formIconBitmap) {
                    $formIconBitmap.Dispose()
                    $formIconBitmap = $null
                }
                if ($null -ne $formIcon) {
                    $formIcon.Dispose()
                    $formIcon = $null
                }
            }
        }

        $accent = [System.Windows.Forms.Panel]::new()
        $accent.BackColor = $accentColor
        $accent.Dock = [System.Windows.Forms.DockStyle]::Left
        $accent.Width = 6

        $title = [System.Windows.Forms.Label]::new()
        $title.AutoSize = $false
        $title.Location = [System.Drawing.Point]::new($contentLeft, 18)
        $title.Size = [System.Drawing.Size]::new(396 - $contentLeft, 28)
        $title.Font = [System.Drawing.Font]::new(
            'Segoe UI',
            11,
            [System.Drawing.FontStyle]::Bold
        )
        $title.ForeColor = [System.Drawing.Color]::FromArgb(24, 32, 28)
        $title.Text = [string]$Feedback.Title

        $message = [System.Windows.Forms.Label]::new()
        $message.AutoSize = $false
        $message.Location = [System.Drawing.Point]::new($contentLeft, 51)
        $message.Size = [System.Drawing.Size]::new(396 - $contentLeft, 36)
        $message.Font = [System.Drawing.Font]::new('Segoe UI', 9.5)
        $message.ForeColor = [System.Drawing.Color]::FromArgb(83, 99, 90)
        $message.Text = [string]$Feedback.Message

        $form.Controls.Add($message)
        $form.Controls.Add($title)
        $form.Controls.Add($accent)

        $workingArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        $form.Location = [System.Drawing.Point]::new(
            [Math]::Max(0, $workingArea.Right - $form.Width - 18),
            [Math]::Max(0, $workingArea.Bottom - $form.Height - 18)
        )

        $form.Show()
        # SW_SHOWNOACTIVATE keeps the receipt visible without stealing the user's focus.
        $null = [CodexLocalRemote.WindowApi]::ShowWindow($form.Handle, 4)
        $deadline = [DateTime]::UtcNow.AddMilliseconds($DisplayMilliseconds)
        while (-not $form.IsDisposed -and [DateTime]::UtcNow -lt $deadline) {
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 50
        }
        $feedbackStatus = 'rendered'
        $feedbackFailureCode = $null
    } catch {
        # Feedback rendering must never block ChatGPT startup.
    } finally {
        if ($null -ne $form) {
            if (-not $form.IsDisposed) {
                $form.Close()
            }
            $form.Dispose()
        }
        if ($null -ne $formIconBitmap) {
            $formIconBitmap.Dispose()
        }
        if ($null -ne $formIcon) {
            $formIcon.Dispose()
        }
    }
    return [pscustomobject]@{
        Status = $feedbackStatus
        FailureCode = $feedbackFailureCode
    }
}

function Invoke-CodexDesktopFailOpenLaunchCore {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [scriptblock]$GetRunningDesktopAction,

        [Parameter(Mandatory)]
        [scriptblock]$ResolveDesktopRuntimeAction,

        [Parameter(Mandatory)]
        [scriptblock]$GetRemoteReadinessAction,

        [Parameter(Mandatory)]
        [scriptblock]$StartRemoteAction,

        [Parameter(Mandatory)]
        [scriptblock]$GetRemoteEndpointAction,

        [Parameter(Mandatory)]
        [scriptblock]$StartDesktopAction,

        [Parameter(Mandatory)]
        [scriptblock]$GetCreatedDesktopStateAction,

        [Parameter(Mandatory)]
        [scriptblock]$GetCreatedDesktopProcessHandleStateAction,

        [Parameter(Mandatory)]
        [scriptblock]$StopCreatedDesktopAction,

        [AllowNull()]
        [object]$ExistingDesktopOwnerProof,

        [switch]$TakeOverExistingNativeDesktop,

        [ValidateRange(0, 60000)]
        [int]$RemoteStartupTimeoutMilliseconds = 30000,

        [ValidateRange(0, 60000)]
        [int]$RemoteAttachTimeoutMilliseconds = 15000,

        [ValidateRange(1, 5)]
        [int]$RemoteAttachRequiredObservations = 2,

        [ValidateRange(1, 1000)]
        [int]$RemotePollMilliseconds = 100
    )

    $running = @(& $GetRunningDesktopAction)
    $takeoverCandidates = @(
        $running |
            Where-Object {
                $commandLineProperty =
                    $_.PSObject.Properties['CommandLine']
                $null -eq $commandLineProperty -or
                [string]$commandLineProperty.Value -notmatch
                    '(?i)(?:^|\s)--type='
            }
    )
    if ($running.Count -gt 0 -and -not $TakeOverExistingNativeDesktop) {
        return [pscustomobject][ordered]@{
            Status = 'already-running'
            RemoteEnabled = $null
            RemoteDecision = 'existing-desktop-preserved'
            RemoteFallbackAttempts = 0
            RemoteStopAttempts = 0
            DesktopProcessId = if ($null -ne $running[0].PSObject.Properties['ProcessId']) {
                [int]$running[0].ProcessId
            } else {
                $null
            }
        }
    }

    try {
        $runtime = & $ResolveDesktopRuntimeAction
    } catch {
        if ($running.Count -gt 0) {
            $preserved = if ($takeoverCandidates.Count -gt 0) {
                $takeoverCandidates[0]
            } else {
                $running[0]
            }
            return [pscustomobject][ordered]@{
                Status = 'already-running'
                RemoteEnabled = $false
                RemoteDecision = 'existing-desktop-takeover-runtime-unverified'
                RemoteFallbackAttempts = 0
                RemoteStopAttempts = 0
                DesktopProcessId = if (
                    $null -ne $preserved.PSObject.Properties['ProcessId']
                ) {
                    [int]$preserved.ProcessId
                } else {
                    $null
                }
            }
        }
        throw
    }
    if ($null -eq $runtime -or
        [string]::IsNullOrWhiteSpace([string]$runtime.DesktopExecutablePath)) {
        throw 'The current Codex Desktop executable could not be resolved.'
    }
    $desktopExecutablePath = [System.IO.Path]::GetFullPath(
        [string]$runtime.DesktopExecutablePath
    )

    $remoteReady = $false
    $remoteDecision = 'remote-not-ready'
    $remoteReadiness = $null
    try {
        $remoteReadiness = & $GetRemoteReadinessAction
        $remoteReady = Test-CodexDesktopRemoteReadinessSnapshot `
            -Readiness $remoteReadiness
    } catch {
        $remoteDecision = 'remote-health-check-failed'
    }

    $existingRemoteProof = if ($remoteReady) {
        Get-CodexExistingRemoteDesktopProof `
            -Readiness $remoteReadiness `
            -RootCandidates $takeoverCandidates `
            -ExpectedExecutablePath $desktopExecutablePath `
            -PersistedOwnerProof $ExistingDesktopOwnerProof
    } else {
        $null
    }
    if ($null -ne $existingRemoteProof) {
        return [pscustomobject][ordered]@{
            Status = 'already-running'
            RemoteEnabled = $true
            RemoteDecision = 'broker-reports-desktop-connected'
            RemoteFallbackAttempts = 0
            RemoteStopAttempts = 0
            DesktopProcessId = [int]$existingRemoteProof.ProcessId
            DesktopOwnerConnectionProof = $ExistingDesktopOwnerProof
        }
    }

    if (-not $remoteReady) {
        $remoteStartFailed = $false
        try {
            & $StartRemoteAction
        } catch {
            $remoteStartFailed = $true
            $remoteDecision = 'remote-start-failed'
        }

        if (-not $remoteStartFailed) {
            $deadline = [DateTime]::UtcNow.AddMilliseconds(
                $RemoteStartupTimeoutMilliseconds
            )
            do {
                try {
                    $remoteReadiness = & $GetRemoteReadinessAction
                    $remoteReady =
                        Test-CodexDesktopRemoteReadinessSnapshot `
                            -Readiness $remoteReadiness
                } catch {
                    $remoteDecision = 'remote-health-check-failed'
                    $remoteReady = $false
                }
                if ($remoteReady) {
                    break
                }
                if ([DateTime]::UtcNow -ge $deadline) {
                    break
                }
                Start-Sleep -Milliseconds $RemotePollMilliseconds
            } while ($true)
        }
    }

    $existingRemoteProof = $null
    if ($remoteReady) {
        $latestRunningForProof = @(& $GetRunningDesktopAction)
        $latestRootCandidatesForProof = @(
            $latestRunningForProof |
                Where-Object {
                    $commandLineProperty =
                        $_.PSObject.Properties['CommandLine']
                    $null -eq $commandLineProperty -or
                    [string]$commandLineProperty.Value -notmatch
                        '(?i)(?:^|\s)--type='
                }
        )
        $existingRemoteProof = Get-CodexExistingRemoteDesktopProof `
            -Readiness $remoteReadiness `
            -RootCandidates $latestRootCandidatesForProof `
            -ExpectedExecutablePath $desktopExecutablePath `
            -PersistedOwnerProof $ExistingDesktopOwnerProof
    }
    if ($null -ne $existingRemoteProof) {
        return [pscustomobject][ordered]@{
            Status = 'already-running'
            RemoteEnabled = $true
            RemoteDecision = 'broker-reports-desktop-connected'
            RemoteFallbackAttempts = 0
            RemoteStopAttempts = 0
            DesktopProcessId = [int]$existingRemoteProof.ProcessId
            DesktopOwnerConnectionProof = $ExistingDesktopOwnerProof
        }
    }

    $remoteEndpoint = $null
    if ($remoteReady) {
        try {
            $candidateEndpoint = [string](& $GetRemoteEndpointAction)
            $null = Assert-LoopbackWebSocketUrl `
                -WebSocketUrl ($candidateEndpoint -replace '/ws/[A-Za-z0-9_-]+$', '')
            if ($candidateEndpoint -cnotmatch
                "^ws://127\.0\.0\.1:\d+/ws/[A-Za-z0-9_-]{32,}$") {
                throw 'The managed Broker capability endpoint is invalid.'
            }
            $remoteEndpoint = $candidateEndpoint
            $remoteDecision = 'remote-ready'
        } catch {
            $remoteReady = $false
            $remoteDecision = 'remote-endpoint-unavailable'
        }
    }

    if (-not $remoteReady) {
        if ($running.Count -gt 0) {
            $preserved = if ($takeoverCandidates.Count -gt 0) {
                $takeoverCandidates[0]
            } else {
                $running[0]
            }
            return [pscustomobject][ordered]@{
                Status = 'already-running'
                RemoteEnabled = $false
                RemoteDecision = $remoteDecision
                RemoteFallbackAttempts = 0
                RemoteStopAttempts = 0
                DesktopExecutablePath = $desktopExecutablePath
                DesktopProcessId = if (
                    $null -ne $preserved.PSObject.Properties['ProcessId']
                ) {
                    [int]$preserved.ProcessId
                } else {
                    $null
                }
            }
        }
        $desktopProcess = Invoke-CodexDesktopScopedProcessStart `
            -DesktopExecutablePath $desktopExecutablePath `
            -RemoteEndpoint $null `
            -StartDesktopAction $StartDesktopAction
        $desktopIdentity = Get-CodexDesktopLaunchIdentity `
            -Process $desktopProcess
        return [pscustomobject][ordered]@{
            Status = 'launched-native'
            RemoteEnabled = $false
            RemoteDecision = $remoteDecision
            RemoteFallbackAttempts = 0
            RemoteStopAttempts = 0
            DesktopExecutablePath = $desktopExecutablePath
            DesktopProcessId = if ($null -eq $desktopIdentity) {
                $null
            } else {
                [int]$desktopIdentity.ProcessId
            }
        }
    }

    $preexistingDesktopStopped = $false
    if ($running.Count -gt 0) {
        if ($takeoverCandidates.Count -ne 1) {
            return [pscustomobject][ordered]@{
                Status = 'already-running'
                RemoteEnabled = $false
                RemoteDecision = 'existing-desktop-takeover-identity-unverified'
                RemoteFallbackAttempts = 0
                RemoteStopAttempts = 0
                DesktopExecutablePath = $desktopExecutablePath
                DesktopProcessId = $null
            }
        }
        $runningIdentity = Get-CodexDesktopLaunchIdentity `
            -Process $takeoverCandidates[0]
        if ($null -eq $runningIdentity -or
            [string]::IsNullOrWhiteSpace(
                [string]$runningIdentity.ExecutablePath
            ) -or
            -not [string]::Equals(
                [string]$runningIdentity.ExecutablePath,
                $desktopExecutablePath,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
            return [pscustomobject][ordered]@{
                Status = 'already-running'
                RemoteEnabled = $false
                RemoteDecision = 'existing-desktop-takeover-identity-unverified'
                RemoteFallbackAttempts = 0
                RemoteStopAttempts = 0
                DesktopExecutablePath = $desktopExecutablePath
                DesktopProcessId = if ($null -eq $runningIdentity) {
                    $null
                } else {
                    [int]$runningIdentity.ProcessId
                }
            }
        }
        $latestReadiness = $null
        $latestTakeoverCandidates = @()
        try {
            $latestReadiness = & $GetRemoteReadinessAction
            $latestRunning = @(& $GetRunningDesktopAction)
            $latestTakeoverCandidates = @(
                $latestRunning |
                    Where-Object {
                        $commandLineProperty =
                            $_.PSObject.Properties['CommandLine']
                        $null -eq $commandLineProperty -or
                        [string]$commandLineProperty.Value -notmatch
                            '(?i)(?:^|\s)--type='
                    }
            )
        } catch {
            $latestReadiness = $null
            $latestTakeoverCandidates = @()
        }
        $latestRunningIdentity = if ($latestTakeoverCandidates.Count -eq 1) {
            Get-CodexDesktopLaunchIdentity `
                -Process $latestTakeoverCandidates[0]
        } else {
            $null
        }
        $latestBoundRemoteProof =
            Get-CodexExistingRemoteDesktopProof `
                -Readiness $latestReadiness `
                -RootCandidates $latestTakeoverCandidates `
                -ExpectedExecutablePath $desktopExecutablePath `
                -PersistedOwnerProof $ExistingDesktopOwnerProof
        if (-not (
            (Test-CodexDesktopTakeoverSafetySnapshot `
                -Readiness $latestReadiness) -and
            (Test-CodexLocalRemoteSameGeneration `
                -Before $remoteReadiness `
                -After $latestReadiness) -and
            $null -eq $latestBoundRemoteProof -and
            $latestTakeoverCandidates.Count -eq 1 -and
            (Test-CodexDesktopLaunchIdentityMatch `
                -Expected $runningIdentity `
                -Actual $latestRunningIdentity)
        )) {
            return [pscustomobject][ordered]@{
                Status = 'already-running'
                RemoteEnabled = $false
                RemoteDecision =
                    'existing-desktop-takeover-state-drifted'
                RemoteFallbackAttempts = 0
                RemoteStopAttempts = 0
                DesktopExecutablePath = $desktopExecutablePath
                DesktopProcessId = [int]$runningIdentity.ProcessId
            }
        }
        $runningIdentity = $latestRunningIdentity
        $existingStopResult = [string](
            & $StopCreatedDesktopAction `
                ([int]$runningIdentity.ProcessId) `
                ([long]$runningIdentity.StartTimeUtcTicks) `
                ([string]$runningIdentity.ExecutablePath)
        )
        if ($existingStopResult -cnotin @('stopped', 'already-exited')) {
            return [pscustomobject][ordered]@{
                Status = 'already-running'
                RemoteEnabled = $false
                RemoteDecision = 'existing-desktop-takeover-identity-unverified'
                RemoteFallbackAttempts = 0
                RemoteStopAttempts = 1
                DesktopExecutablePath = $desktopExecutablePath
                DesktopProcessId = [int]$runningIdentity.ProcessId
            }
        }
        $preexistingDesktopStopped = $true
    }

    $desktopLaunchNonceDigest = $null
    try {
        $desktopLaunchNonce = New-CodexDesktopLaunchNonce
        $desktopLaunchNonceDigest =
            Get-CodexDesktopLaunchNonceDigest `
                -Nonce $desktopLaunchNonce
        $remoteLaunchEndpoint =
            Add-CodexDesktopLaunchNonceToEndpoint `
                -RemoteEndpoint $remoteEndpoint `
                -LaunchNonce $desktopLaunchNonce
        $desktopProcess = Invoke-CodexDesktopScopedProcessStart `
            -DesktopExecutablePath $desktopExecutablePath `
            -RemoteEndpoint $remoteLaunchEndpoint `
            -StartDesktopAction $StartDesktopAction
    } catch {
        $fallbackProcess = Invoke-CodexDesktopScopedProcessStart `
            -DesktopExecutablePath $desktopExecutablePath `
            -RemoteEndpoint $null `
            -StartDesktopAction $StartDesktopAction
        $fallbackIdentity = Get-CodexDesktopLaunchIdentity `
            -Process $fallbackProcess
        return [pscustomobject][ordered]@{
            Status = 'launched-native'
            RemoteEnabled = $false
            RemoteDecision = 'remote-desktop-launch-failed'
            RemoteFallbackAttempts = 1
            RemoteStopAttempts = if ($preexistingDesktopStopped) { 1 } else { 0 }
            DesktopExecutablePath = $desktopExecutablePath
            DesktopProcessId = if ($null -eq $fallbackIdentity) {
                $null
            } else {
                [int]$fallbackIdentity.ProcessId
            }
        }
    }

    $preexistingStopAttempts = if ($preexistingDesktopStopped) { 1 } else { 0 }
    $desktopIdentity = Get-CodexDesktopLaunchIdentityWithRetry `
        -Process $desktopProcess
    if ($null -eq $desktopIdentity) {
        try {
            $createdProcessHandleState = [string](
                & $GetCreatedDesktopProcessHandleStateAction $desktopProcess
            )
        } catch {
            $createdProcessHandleState = 'identity-unverified'
        }
        if ($createdProcessHandleState -ceq 'exited') {
            $fallbackProcess = Invoke-CodexDesktopScopedProcessStart `
                -DesktopExecutablePath $desktopExecutablePath `
                -RemoteEndpoint $null `
                -StartDesktopAction $StartDesktopAction
            $fallbackIdentity = Get-CodexDesktopLaunchIdentityWithRetry `
                -Process $fallbackProcess
            return [pscustomobject][ordered]@{
                Status = 'launched-native'
                RemoteEnabled = $false
                RemoteDecision = 'remote-desktop-exited-before-identity'
                RemoteFallbackAttempts = 1
                RemoteStopAttempts = $preexistingStopAttempts
                DesktopExecutablePath = $desktopExecutablePath
                DesktopProcessId = if ($null -eq $fallbackIdentity) {
                    $null
                } else {
                    [int]$fallbackIdentity.ProcessId
                }
            }
        }
        return [pscustomobject][ordered]@{
            Status = 'remote-launch-unverified'
            RemoteEnabled = $false
            RemoteDecision = 'created-desktop-identity-unavailable'
            RemoteFallbackAttempts = 0
            RemoteStopAttempts = $preexistingStopAttempts
            DesktopExecutablePath = $desktopExecutablePath
            DesktopProcessId = $null
        }
    }

    $attachDeadline = [DateTime]::UtcNow.AddMilliseconds(
        $RemoteAttachTimeoutMilliseconds
    )
    $attachObservations = 0
    $everAttached = $false
    $createdProcessState = 'running'
    do {
        $createdProcessState = [string](
            & $GetCreatedDesktopStateAction `
                ([int]$desktopIdentity.ProcessId) `
                ([long]$desktopIdentity.StartTimeUtcTicks)
        )
        if ($createdProcessState -ceq 'exited') {
            break
        }
        if ($createdProcessState -cne 'running') {
            $retriedDesktopIdentity =
                Get-CodexDesktopLaunchIdentityWithRetry `
                    -Process $desktopProcess
            if (Test-CodexDesktopLaunchIdentityMatch `
                -Expected $desktopIdentity `
                -Actual $retriedDesktopIdentity) {
                $createdProcessState = [string](
                    & $GetCreatedDesktopStateAction `
                        ([int]$retriedDesktopIdentity.ProcessId) `
                        ([long]$retriedDesktopIdentity.StartTimeUtcTicks)
                )
                if ($createdProcessState -ceq 'running') {
                    $desktopIdentity = $retriedDesktopIdentity
                } elseif ($createdProcessState -ceq 'exited') {
                    break
                }
            }
        }
        if ($createdProcessState -cne 'running') {
            try {
                $createdProcessHandleState = [string](
                    & $GetCreatedDesktopProcessHandleStateAction $desktopProcess
                )
            } catch {
                $createdProcessHandleState = 'identity-unverified'
            }
            if ($createdProcessHandleState -ceq 'exited') {
                $createdProcessState = 'exited'
                break
            }
            return [pscustomobject][ordered]@{
                Status = 'remote-launch-unverified'
                RemoteEnabled = $false
                RemoteDecision = 'created-desktop-identity-unverified'
                RemoteFallbackAttempts = 0
                RemoteStopAttempts = $preexistingStopAttempts
                DesktopExecutablePath = $desktopExecutablePath
                DesktopProcessId = [int]$desktopIdentity.ProcessId
            }
        }

        $afterLaunchReadiness = $null
        try {
            $afterLaunchReadiness = & $GetRemoteReadinessAction
        } catch {
            $afterLaunchReadiness = $null
        }
        if ((Test-CodexLocalRemoteSameGeneration `
                -Before $remoteReadiness `
                -After $afterLaunchReadiness) -and
            (Test-CodexDesktopLaunchAttachedSnapshot `
                -Readiness $afterLaunchReadiness `
                -ExpectedLaunchNonceDigest $desktopLaunchNonceDigest)) {
            try {
                $attachedRunning = @(& $GetRunningDesktopAction)
                $attachedRootProcesses = @(
                    $attachedRunning |
                        Where-Object {
                            $commandLineProperty =
                                $_.PSObject.Properties['CommandLine']
                            $null -eq $commandLineProperty -or
                            [string]$commandLineProperty.Value -notmatch
                                '(?i)(?:^|\s)--type='
                        }
                )
                $attachedRootIdentity = if (
                    $attachedRootProcesses.Count -eq 1
                ) {
                    Get-CodexDesktopLaunchIdentity `
                        -Process $attachedRootProcesses[0]
                } else {
                    $null
                }
            } catch {
                $attachedRootProcesses = @()
                $attachedRootIdentity = $null
            }
            if ($attachedRootProcesses.Count -ne 1 -or
                -not (Test-CodexDesktopLaunchIdentityMatch `
                    -Expected $desktopIdentity `
                    -Actual $attachedRootIdentity)) {
                return [pscustomobject][ordered]@{
                    Status = 'remote-launch-unverified'
                    RemoteEnabled = $false
                    RemoteDecision =
                        'remote-attached-root-process-set-unverified'
                    RemoteFallbackAttempts = 0
                    RemoteStopAttempts = $preexistingStopAttempts
                    DesktopExecutablePath = $desktopExecutablePath
                    DesktopProcessId = [int]$desktopIdentity.ProcessId
                }
            }
            $everAttached = $true
            $attachObservations++
            if ($attachObservations -ge
                $RemoteAttachRequiredObservations) {
                return [pscustomobject][ordered]@{
                    Status = 'launched-remote'
                    RemoteEnabled = $true
                    RemoteDecision = if ($preexistingDesktopStopped) {
                        'existing-native-desktop-relaunched-remote'
                    } else {
                        'remote-attached'
                    }
                    RemoteFallbackAttempts = 0
                    RemoteStopAttempts = if ($preexistingDesktopStopped) {
                        1
                    } else {
                        0
                    }
                    DesktopExecutablePath = $desktopExecutablePath
                    DesktopProcessId = [int]$desktopIdentity.ProcessId
                    DesktopOwnerConnectionProof = [pscustomobject]@{
                        RuntimeInvocationId =
                            [string]$afterLaunchReadiness.runtimeInvocationId
                        ProcessId = [int]$attachedRootIdentity.ProcessId
                        StartTimeUtcTicks =
                            [long]$attachedRootIdentity.StartTimeUtcTicks
                        ExecutablePath =
                            [string]$attachedRootIdentity.ExecutablePath
                        LaunchNonceDigest = $desktopLaunchNonceDigest
                    }
                }
            }
        } else {
            $attachObservations = 0
        }

        if ([DateTime]::UtcNow -ge $attachDeadline) {
            break
        }
        Start-Sleep -Milliseconds $RemotePollMilliseconds
    } while ($true)

    if ($createdProcessState -ceq 'exited') {
        $fallbackProcess = Invoke-CodexDesktopScopedProcessStart `
            -DesktopExecutablePath $desktopExecutablePath `
            -RemoteEndpoint $null `
            -StartDesktopAction $StartDesktopAction
        $fallbackIdentity = Get-CodexDesktopLaunchIdentity `
            -Process $fallbackProcess
        return [pscustomobject][ordered]@{
            Status = 'launched-native'
            RemoteEnabled = $false
            RemoteDecision = 'remote-desktop-exited-before-attach'
            RemoteFallbackAttempts = 1
            RemoteStopAttempts = $preexistingStopAttempts
            DesktopExecutablePath = $desktopExecutablePath
            DesktopProcessId = if ($null -eq $fallbackIdentity) {
                $null
            } else {
                [int]$fallbackIdentity.ProcessId
            }
        }
    }

    if ($everAttached) {
        return [pscustomobject][ordered]@{
            Status = 'remote-launch-unverified'
            RemoteEnabled = $false
            RemoteDecision = 'remote-attached-then-unverified-process-preserved'
            RemoteFallbackAttempts = 0
            RemoteStopAttempts = $preexistingStopAttempts
            DesktopExecutablePath = $desktopExecutablePath
            DesktopProcessId = [int]$desktopIdentity.ProcessId
        }
    }

    $stopResult = [string](
        & $StopCreatedDesktopAction `
            ([int]$desktopIdentity.ProcessId) `
            ([long]$desktopIdentity.StartTimeUtcTicks) `
            $desktopExecutablePath
    )
    if ($stopResult -cnotin @('stopped', 'already-exited')) {
        return [pscustomobject][ordered]@{
            Status = 'remote-launch-unverified'
            RemoteEnabled = $false
            RemoteDecision = 'remote-attach-failed-process-preserved'
            RemoteFallbackAttempts = 0
            RemoteStopAttempts = $preexistingStopAttempts + 1
            DesktopExecutablePath = $desktopExecutablePath
            DesktopProcessId = [int]$desktopIdentity.ProcessId
        }
    }

    $fallbackProcess = Invoke-CodexDesktopScopedProcessStart `
        -DesktopExecutablePath $desktopExecutablePath `
        -RemoteEndpoint $null `
        -StartDesktopAction $StartDesktopAction
    $fallbackIdentity = Get-CodexDesktopLaunchIdentity `
        -Process $fallbackProcess
    return [pscustomobject][ordered]@{
        Status = 'launched-native'
        RemoteEnabled = $false
        RemoteDecision = 'remote-broker-lost-before-attach'
        RemoteFallbackAttempts = 1
        RemoteStopAttempts = $preexistingStopAttempts + 1
        DesktopExecutablePath = $desktopExecutablePath
        DesktopProcessId = if ($null -eq $fallbackIdentity) {
            $null
        } else {
            [int]$fallbackIdentity.ProcessId
        }
    }
}

function Invoke-CodexDesktopFailOpenLaunch {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [scriptblock]$GetRunningDesktopAction,

        [Parameter(Mandatory)]
        [scriptblock]$ResolveDesktopRuntimeAction,

        [Parameter(Mandatory)]
        [scriptblock]$GetRemoteReadinessAction,

        [Parameter(Mandatory)]
        [scriptblock]$StartRemoteAction,

        [Parameter(Mandatory)]
        [scriptblock]$GetRemoteEndpointAction,

        [Parameter(Mandatory)]
        [scriptblock]$StartDesktopAction,

        [Parameter(Mandatory)]
        [scriptblock]$GetCreatedDesktopStateAction,

        [Parameter(Mandatory)]
        [scriptblock]$GetCreatedDesktopProcessHandleStateAction,

        [Parameter(Mandatory)]
        [scriptblock]$StopCreatedDesktopAction,

        [AllowNull()]
        [object]$ExistingDesktopOwnerProof,

        [switch]$TakeOverExistingNativeDesktop,

        [ValidateRange(0, 60000)]
        [int]$RemoteStartupTimeoutMilliseconds = 30000,

        [ValidateRange(0, 60000)]
        [int]$RemoteAttachTimeoutMilliseconds = 15000,

        [ValidateRange(1, 5)]
        [int]$RemoteAttachRequiredObservations = 2,

        [ValidateRange(1, 1000)]
        [int]$RemotePollMilliseconds = 100,

        [AllowEmptyString()]
        [ValidatePattern('^(?:|[0-9a-f]{32})$')]
        [string]$LaunchCorrelationId = ''
    )

    $failure = [pscustomobject]@{
        Stage = $null
        Code = $null
    }
    $correlationId = if (-not [string]::IsNullOrWhiteSpace(
        $LaunchCorrelationId
    )) {
        $LaunchCorrelationId
    } else {
        New-CodexRemoteCorrelationId
    }
    $originalStartRemoteAction = $StartRemoteAction
    $wrappedStartRemoteAction = {
        try {
            & $originalStartRemoteAction
        } catch {
            $diagnostic = Get-CodexRemoteFailureDiagnostic `
                -ErrorRecord $_ `
                -DefaultStage 'unexpected' `
                -DefaultCode 'unexpected'
            $failure.Stage = [string]$diagnostic.Stage
            $failure.Code = [string]$diagnostic.Code
            throw
        }
    }.GetNewClosure()
    $result = Invoke-CodexDesktopFailOpenLaunchCore `
        -GetRunningDesktopAction $GetRunningDesktopAction `
        -ResolveDesktopRuntimeAction $ResolveDesktopRuntimeAction `
        -GetRemoteReadinessAction $GetRemoteReadinessAction `
        -StartRemoteAction $wrappedStartRemoteAction `
        -GetRemoteEndpointAction $GetRemoteEndpointAction `
        -StartDesktopAction $StartDesktopAction `
        -GetCreatedDesktopStateAction $GetCreatedDesktopStateAction `
        -GetCreatedDesktopProcessHandleStateAction (
            $GetCreatedDesktopProcessHandleStateAction
        ) `
        -StopCreatedDesktopAction $StopCreatedDesktopAction `
        -ExistingDesktopOwnerProof $ExistingDesktopOwnerProof `
        -TakeOverExistingNativeDesktop:$TakeOverExistingNativeDesktop `
        -RemoteStartupTimeoutMilliseconds (
            $RemoteStartupTimeoutMilliseconds
        ) `
        -RemoteAttachTimeoutMilliseconds $RemoteAttachTimeoutMilliseconds `
        -RemoteAttachRequiredObservations (
            $RemoteAttachRequiredObservations
        ) `
        -RemotePollMilliseconds $RemotePollMilliseconds
    $result | Add-Member `
        -NotePropertyName 'RemoteFailureStage' `
        -NotePropertyValue $failure.Stage
    $result | Add-Member `
        -NotePropertyName 'RemoteFailureCode' `
        -NotePropertyValue $failure.Code
    $result | Add-Member `
        -NotePropertyName 'CorrelationId' `
        -NotePropertyValue $correlationId
    $result | Add-Member `
        -NotePropertyName 'FeedbackStatus' `
        -NotePropertyValue 'pending'
    $result | Add-Member `
        -NotePropertyName 'FeedbackFailureCode' `
        -NotePropertyValue $null
    return $result
}

function Test-CodexDesktopRootPresent {
    return @(
        Get-CodexRequesterFailOpenDesktopProcesses |
            Where-Object {
                [string]$_.CommandLine -notmatch '(?i)(?:^|\s)--type='
            }
    ).Count -gt 0
}

function Get-CodexRequesterFailOpenDesktopProcesses {
    [CmdletBinding()]
    param()

    try {
        return @(Get-CodexDesktopHandoffProcesses)
    } catch {
        throw (New-CodexRemoteFailureException `
            -Stage 'runtime-handoff' `
            -Code 'runtime-generation-unverified')
    }
}

function Wait-CodexDesktopOwnerHandoffDrain {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$ManagedBrokerPort,

        [ValidateRange(1, 30)]
        [int]$TimeoutSeconds = 8,

        [ValidateRange(1, 1000)]
        [int]$PollMilliseconds = 100,

        [ValidateRange(1, 5)]
        [int]$RequiredEmptyObservations = 2
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $emptyObservations = 0
    do {
        try {
            $desktopProcessCount = @(
                Get-CodexDesktopHandoffProcesses
            ).Count
            $readiness = Get-CodexLocalRemoteReadinessSnapshot `
                -Port $ManagedBrokerPort
            $brokerDisconnected = (
                $null -ne $readiness -and
                $null -ne $readiness.PSObject.Properties[
                    'desktopConnected'
                ] -and
                $readiness.desktopConnected -is [bool] -and
                -not [bool]$readiness.desktopConnected
            )
        } catch {
            $desktopProcessCount = -1
            $brokerDisconnected = $false
        }
        if ($desktopProcessCount -eq 0 -and $brokerDisconnected) {
            $emptyObservations += 1
            if ($emptyObservations -ge $RequiredEmptyObservations) {
                return $true
            }
        } else {
            $emptyObservations = 0
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            return $false
        }
        Start-Sleep -Milliseconds $PollMilliseconds
    } while ($true)
}

function Invoke-CodexDesktopOwnerRequestWithDrainRetry {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [scriptblock]$RequestOwnerAction,

        [Parameter(Mandatory)]
        [scriptblock]$WaitForDesktopDrainAction
    )

    $firstFailure = $null
    try {
        return & $RequestOwnerAction
    } catch {
        $diagnostic = Get-CodexRemoteFailureDiagnostic `
            -ErrorRecord $_ `
            -DefaultStage 'unexpected' `
            -DefaultCode 'unexpected'
        if ([string]$diagnostic.Stage -cne 'runtime-handoff' -or
            [string]$diagnostic.Code -cne 'desktop-running') {
            throw
        }
        $firstFailure = $_
    }

    try {
        $drained = & $WaitForDesktopDrainAction
    } catch {
        $drained = $false
    }
    if ($drained -isnot [bool] -or -not [bool]$drained) {
        throw $firstFailure.Exception
    }
    return & $RequestOwnerAction
}

function Get-CodexDesktopRootIdentityKeys {
    return @(
        Get-RunningCodexDesktopProcesses |
            Where-Object {
                [string]$_.CommandLine -notmatch '(?i)(?:^|\s)--type='
            } |
            ForEach-Object {
                $identity = Get-CodexDesktopLaunchIdentity -Process $_
                if ($null -ne $identity) {
                    Get-CodexDesktopOwnerRootIdentityKey `
                        -ProcessId ([int]$identity.ProcessId) `
                        -StartTimeUtcTicks (
                            [long]$identity.StartTimeUtcTicks
                        ) `
                        -ExecutablePath (
                            [string]$identity.ExecutablePath
                        )
                }
            }
    )
}

function Test-CodexDesktopOwnerRequestAcknowledged {
    param(
        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [string]$IntentId,

        [AllowEmptyCollection()]
        [string[]]$BaselineRootIdentityKeys = @()
    )

    $currentRootIdentityKeys = @(Get-CodexDesktopRootIdentityKeys)
    if (@(
        $currentRootIdentityKeys |
            Where-Object { $_ -cnotin $BaselineRootIdentityKeys }
    ).Count -gt 0) {
        return $true
    }
    $receiptPath = Join-Path `
        ([System.IO.Path]::GetFullPath($ManagedDataDir)) `
        'desktop-owner-intent-last.json'
    try {
        if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
            return $false
        }
        $item = Get-Item -LiteralPath $receiptPath -Force -ErrorAction Stop
        if ($item.PSIsContainer -or
            ($item.Attributes -band
                [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            [long]$item.Length -lt 32 -or
            [long]$item.Length -gt 8192) {
            return $false
        }
        $rawBefore = Get-Content -LiteralPath $receiptPath -Raw -Encoding utf8
        $receipt = $rawBefore |
            ConvertFrom-Json -Depth 8 -DateKind String -ErrorAction Stop
        $rawAfter = Get-Content -LiteralPath $receiptPath -Raw -Encoding utf8
        return (
            $rawBefore -ceq $rawAfter -and
            [string]$receipt.Signature -ceq
                'codex-local-remote/desktop-owner-intent-receipt/v1' -and
            [int]$receipt.Version -eq 1 -and
            [string]$receipt.IntentId -ceq $IntentId
        )
    } catch {
        return $false
    }
}

function Wait-CodexDesktopOwnerRequestAcknowledgement {
    param(
        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [string]$IntentId,

        [AllowEmptyCollection()]
        [string[]]$BaselineRootIdentityKeys = @(),

        [ValidateRange(1, 30)]
        [int]$TimeoutSeconds
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (Test-CodexDesktopOwnerRequestAcknowledged `
            -ManagedDataDir $ManagedDataDir `
            -IntentId $IntentId `
            -BaselineRootIdentityKeys $BaselineRootIdentityKeys) {
            return $true
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            return $false
        }
        Start-Sleep -Milliseconds 100
    } while ($true)
}

function New-CodexRequesterOwnerUnresolvedResult {
    return [pscustomobject][ordered]@{
        Status = 'remote-launch-unverified'
        RemoteEnabled = $false
        RemoteDecision = 'existing-desktop-takeover-state-drifted'
        RemoteFallbackAttempts = 0
        RemoteStopAttempts = 0
        DesktopProcessId = $null
        RemoteFailureStage = 'runtime-handoff'
        RemoteFailureCode = 'handoff-timeout'
        CorrelationId = New-CodexRemoteCorrelationId
        FeedbackStatus = 'pending'
        FeedbackFailureCode = $null
    }
}

function Get-CodexRequesterDesktopOwnerMutexName {
    param(
        [Parameter(Mandatory)]
        [string]$ManagedDataDir
    )

    $identity = [System.IO.Path]::GetFullPath(
        $ManagedDataDir
    ).ToUpperInvariant()
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = [Convert]::ToHexString(
            $sha256.ComputeHash(
                [System.Text.Encoding]::UTF8.GetBytes($identity)
            )
        ).ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
    return "Global\CodexLocalRemote.DesktopOwner.$digest"
}

function Invoke-WithCodexRequesterDesktopOwnerMutex {
    param(
        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [Parameter(Mandatory)]
        [scriptblock]$Action,

        [ValidateRange(1, 120)]
        [int]$TimeoutSeconds = 30
    )

    $mutex = [System.Threading.Mutex]::new(
        $false,
        (Get-CodexRequesterDesktopOwnerMutexName `
            -ManagedDataDir $ManagedDataDir)
    )
    $lockTaken = $false
    try {
        try {
            $lockTaken = $mutex.WaitOne(
                [TimeSpan]::FromSeconds($TimeoutSeconds)
            )
        } catch [System.Threading.AbandonedMutexException] {
            $lockTaken = $true
        }
        if (-not $lockTaken) {
            throw 'Timed out waiting for the single Desktop owner.'
        }
        return & $Action
    } finally {
        if ($lockTaken) {
            try {
                $mutex.ReleaseMutex()
            } catch [System.ApplicationException] {
                # An abandoned owner is still safe to dispose.
            }
        }
        $mutex.Dispose()
    }
}

function Test-CodexFreshDesktopOwnerIntentFile {
    param(
        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow
    )

    $intentPath = Join-Path `
        ([System.IO.Path]::GetFullPath($ManagedDataDir)) `
        'desktop-owner-intent.json'
    try {
        if (-not (Test-Path -LiteralPath $intentPath -PathType Leaf)) {
            return $false
        }
        $item = Get-Item -LiteralPath $intentPath -Force -ErrorAction Stop
        if ($item.PSIsContainer -or
            ($item.Attributes -band
                [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            [long]$item.Length -lt 32 -or
            [long]$item.Length -gt 8192) {
            return $false
        }
        $rawBefore = Get-Content -LiteralPath $intentPath -Raw -Encoding utf8
        $intent = $rawBefore |
            ConvertFrom-Json -Depth 8 -DateKind String -ErrorAction Stop
        $rawAfter = Get-Content -LiteralPath $intentPath -Raw -Encoding utf8
        $actualProperties = @($intent.PSObject.Properties.Name | Sort-Object)
        $expectedProperties = @(
            'IntentId',
            'RequestedAtUtc',
            'Signature',
            'TargetRuntimeRoot',
            'TargetRuntimeVersionId',
            'Version'
        )
        if ($rawBefore -cne $rawAfter -or
            ($actualProperties -join "`n") -cne
                (($expectedProperties | Sort-Object) -join "`n") -or
            [string]$intent.Signature -cne
                'codex-local-remote/desktop-owner-intent/v1' -or
            [int]$intent.Version -ne 1 -or
            [string]$intent.IntentId -cnotmatch '^[0-9a-f]{32}$' -or
            [string]$intent.TargetRuntimeVersionId -cnotmatch
                '^[0-9a-f]{64}$') {
            return $false
        }
        $null = [System.IO.Path]::GetFullPath(
            [string]$intent.TargetRuntimeRoot
        )
        $requestedAt = [DateTimeOffset]::Parse(
            [string]$intent.RequestedAtUtc,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
        return (
            $requestedAt.Offset -eq [TimeSpan]::Zero -and
            $requestedAt -le $NowUtc.ToUniversalTime().AddSeconds(5) -and
            $requestedAt -ge $NowUtc.ToUniversalTime().AddSeconds(-120)
        )
    } catch {
        return $false
    }
}

function Invoke-CodexRequesterNativeFailOpen {
    $script:RemoteRuntimeVerifiedForLaunch = $false
    $script:ResolvedDesktopRuntimeForLaunch = $null
    return Invoke-CodexDesktopFailOpenLaunch `
        -GetRunningDesktopAction {
            Get-CodexRequesterFailOpenDesktopProcesses
        } `
        -ResolveDesktopRuntimeAction {
            Resolve-NativeCodexDesktopRuntime
        } `
        -GetRemoteReadinessAction { $null } `
        -StartRemoteAction {
            throw 'Desktop owner request path is unavailable.'
        } `
        -GetRemoteEndpointAction {
            throw 'Remote endpoint is disabled for requester fail-open.'
        } `
        -StartDesktopAction {
            param(
                [string]$DesktopExecutablePath,
                [AllowNull()][string]$RemoteEndpoint
            )
            if (-not [string]::IsNullOrWhiteSpace($RemoteEndpoint)) {
                throw 'Requester fail-open cannot inject a Remote endpoint.'
            }
            Start-CodexDesktopProcess `
                -DesktopExecutablePath $DesktopExecutablePath `
                -RemoteEndpoint $null
        } `
        -GetCreatedDesktopStateAction {
            param([int]$ProcessId, [long]$StartTimeUtcTicks)
            Get-CodexDesktopCreatedProcessState `
                -ProcessId $ProcessId `
                -StartTimeUtcTicks $StartTimeUtcTicks
        } `
        -GetCreatedDesktopProcessHandleStateAction {
            param([object]$Process)
            Get-CodexDesktopCreatedProcessHandleState -Process $Process
        } `
        -StopCreatedDesktopAction {
            throw 'Requester fail-open never stops a Desktop process.'
        } `
        -RemoteStartupTimeoutMilliseconds 0 `
        -RemoteAttachTimeoutMilliseconds 0
}

function Invoke-CodexRequesterFailOpenAfterOwnerFailure {
    param(
        [Parameter(Mandatory)]
        [string]$ManagedDataDir,

        [AllowNull()]
        [object]$RequestFailure,

        [ValidateRange(1, 120)]
        [int]$MutexTimeoutSeconds = 30
    )

    try {
        $result = Invoke-WithCodexRequesterDesktopOwnerMutex `
            -ManagedDataDir $ManagedDataDir `
            -TimeoutSeconds $MutexTimeoutSeconds `
            -Action {
                if (Test-CodexDesktopRootPresent) {
                    return New-CodexRequesterOwnerUnresolvedResult
                }
                if (Test-CodexFreshDesktopOwnerIntentFile `
                    -ManagedDataDir $ManagedDataDir) {
                    return New-CodexRequesterOwnerUnresolvedResult
                }
                try {
                    return Invoke-CodexRequesterNativeFailOpen
                } catch {
                    $nativeFailureDiagnostic =
                        Get-CodexRemoteFailureDiagnostic `
                            -ErrorRecord $_ `
                            -DefaultStage 'unexpected' `
                            -DefaultCode 'unexpected'
                    if ([string]$nativeFailureDiagnostic.Stage -ceq
                        'runtime-handoff') {
                        return New-CodexRequesterOwnerUnresolvedResult
                    }
                    return [pscustomobject][ordered]@{
                        Status = 'remote-launch-unverified'
                        RemoteEnabled = $false
                        RemoteDecision =
                            'created-desktop-identity-unavailable'
                        RemoteFallbackAttempts = 0
                        RemoteStopAttempts = 0
                        DesktopProcessId = $null
                        RemoteFailureStage = 'desktop-start'
                        RemoteFailureCode = 'desktop-start-failed'
                        CorrelationId = New-CodexRemoteCorrelationId
                        FeedbackStatus = 'pending'
                        FeedbackFailureCode = $null
                    }
                }
            }
    } catch {
        $result = New-CodexRequesterOwnerUnresolvedResult
    }
    if ($null -ne $RequestFailure -and
        [string]$result.RemoteFailureCode -cne
            'desktop-start-failed') {
        $requestDiagnostic = Get-CodexRemoteFailureDiagnostic `
            -ErrorRecord $RequestFailure `
            -DefaultStage 'unexpected' `
            -DefaultCode 'unexpected'
        $result | Add-Member `
            -NotePropertyName 'RemoteFailureStage' `
            -NotePropertyValue ([string]$requestDiagnostic.Stage) `
            -Force
        $result | Add-Member `
            -NotePropertyName 'RemoteFailureCode' `
            -NotePropertyValue ([string]$requestDiagnostic.Code) `
            -Force
    }
    return $result
}

if (-not $DefinitionOnly) {
    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
    if ($RequestDesktopLaunch -and $DesktopOwnerExecution) {
        throw 'A Desktop launch cannot be both requested and owner-executed.'
    }
    if (-not $DesktopOwnerExecution -and
        (
            -not $RequestDesktopLaunch -or
            [string]::IsNullOrWhiteSpace(
                $ExpectedSelectedRuntimeVersionId
            ) -or
            [string]::IsNullOrWhiteSpace(
                $ExpectedSelectedRuntimeRoot
            )
        )) {
        # Old installed shortcuts were bound directly to this immutable
        # launcher and carried only -RequestDesktopLaunch. They must not
        # bypass the new explicit Open dispatcher or revive Remote after an
        # update/reboot. Without one runtime-bound internal request, fail open
        # to the ordinary vendor Desktop and do not start the task or publish
        # an owner intent.
        Invoke-CodexRequesterNativeFailOpen
        return
    }
    if (-not $DesktopOwnerExecution) {
        $requestFailure = $null
        $intent = $null
        $selectedRuntime = $null
        $baselineRootIdentityKeys = @()
        try {
            if (-not $script:WindowsModuleAvailable) {
                throw 'The Desktop owner coordination module is unavailable.'
            }
            $baselineRootIdentityKeys = @(
                Get-CodexDesktopRootIdentityKeys
            )
            $requestOwnerAction = {
                Invoke-WithCodexDesktopOwnerMutex `
                    -DataDir $resolvedDataDir `
                    -Action {
                        $runtimeBeforeTaskStart =
                            Assert-CodexExpectedSelectedRuntime `
                                -ManagedDataDir $resolvedDataDir `
                                -ExpectedVersionId (
                                    $ExpectedSelectedRuntimeVersionId
                                ) `
                                -ExpectedRoot (
                                    $ExpectedSelectedRuntimeRoot
                                )
                        $boundExpectedVersionId =
                            [string]$runtimeBeforeTaskStart.CurrentVersionId
                        $boundExpectedRoot =
                            [string]$runtimeBeforeTaskStart.CurrentRoot
                        $null = Start-CodexLocalRemoteRegisteredTask `
                            -Name $TaskName `
                            -ManagedDataDir $resolvedDataDir `
                            -ManagedSidecarPort $SidecarPort `
                            -ManagedBrokerPort $BrokerPort `
                            -ManagedBrokerUpstreamPort $BrokerUpstreamPort `
                            -ManagedBasePath $BasePath
                        $runtime = Assert-CodexExpectedSelectedRuntime `
                            -ManagedDataDir $resolvedDataDir `
                            -ExpectedVersionId $boundExpectedVersionId `
                            -ExpectedRoot $boundExpectedRoot
                        $publishedIntent =
                            New-CodexDesktopOwnerIntentUnderOwnerLock `
                                -DataDir $resolvedDataDir `
                                -TargetRuntimeVersionId (
                                    [string]$runtime.CurrentVersionId
                                ) `
                                -TargetRuntimeRoot (
                                    [string]$runtime.CurrentRoot
                                )
                        return [pscustomobject]@{
                            Runtime = $runtime
                            Intent = $publishedIntent
                        }
                    }
            }.GetNewClosure()
            $requestTransaction =
                Invoke-CodexDesktopOwnerRequestWithDrainRetry `
                    -RequestOwnerAction $requestOwnerAction `
                    -WaitForDesktopDrainAction {
                        Wait-CodexDesktopOwnerHandoffDrain `
                            -ManagedBrokerPort $BrokerPort `
                            -TimeoutSeconds (
                                $DesktopExitDrainTimeoutSeconds
                            )
                    }
            $selectedRuntime = $requestTransaction.Runtime
            $intent = $requestTransaction.Intent
            $acknowledged =
                Wait-CodexDesktopOwnerRequestAcknowledgement `
                    -ManagedDataDir $resolvedDataDir `
                    -IntentId ([string]$intent.IntentId) `
                    -BaselineRootIdentityKeys $baselineRootIdentityKeys `
                    -TimeoutSeconds (
                        $DesktopOwnerRequestAckTimeoutSeconds
                    )
            if (-not $acknowledged) {
                $cancelled = Invoke-WithCodexDesktopOwnerMutex `
                    -DataDir $resolvedDataDir `
                    -TimeoutSeconds 30 `
                    -Action {
                        $currentIntent = Read-CodexDesktopOwnerIntent `
                            -DataDir $resolvedDataDir `
                            -ExpectedRuntimeVersionId (
                                [string]$selectedRuntime.CurrentVersionId
                            ) `
                            -ExpectedRuntimeRoot (
                                [string]$selectedRuntime.CurrentRoot
                            )
                        if ($null -ne $currentIntent -and
                            [string]$currentIntent.IntentId -ceq
                                [string]$intent.IntentId) {
                            Complete-CodexDesktopOwnerIntent `
                                -DataDir $resolvedDataDir `
                                -Intent $currentIntent `
                                -RuntimeInvocationId ('0' * 32) `
                                -Outcome 'requester-timeout-cancelled'
                            return $true
                        }
                        return $false
                    }
                if (-not (Test-CodexDesktopRootPresent)) {
                    throw "The Desktop owner request was not acknowledged; pending intent cancelled=$cancelled."
                }
            }
        } catch {
            $requestFailure = $_
        }
        if ($null -eq $requestFailure) {
            [pscustomobject][ordered]@{
                Status = 'desktop-owner-requested'
                RemoteEnabled = $null
                RemoteDecision = 'coordinator-intent-acknowledged'
                IntentId = [string]$intent.IntentId
                TargetRuntimeVersionId =
                    [string]$intent.TargetRuntimeVersionId
            }
            return
        }
        $requestDiagnostic = Get-CodexRemoteFailureDiagnostic `
            -ErrorRecord $requestFailure `
            -DefaultStage 'unexpected' `
            -DefaultCode 'unexpected'
        $boundRequestMustRemainUnresolved = (
            (-not [string]::IsNullOrWhiteSpace(
                $ExpectedSelectedRuntimeVersionId
            ) -or
                -not [string]::IsNullOrWhiteSpace(
                    $ExpectedSelectedRuntimeRoot
                )) -and
            [string]$requestDiagnostic.Stage -ceq 'runtime-handoff' -and
            [string]$requestDiagnostic.Code -cin @(
                'handoff-request-invalid',
                'handoff-result-mismatch',
                'runtime-generation-unverified'
            )
        )
        if ($boundRequestMustRemainUnresolved) {
            $requestFailOpenResult =
                New-CodexRequesterOwnerUnresolvedResult
            $requestFailOpenResult | Add-Member `
                -NotePropertyName 'RemoteFailureStage' `
                -NotePropertyValue ([string]$requestDiagnostic.Stage) `
                -Force
            $requestFailOpenResult | Add-Member `
                -NotePropertyName 'RemoteFailureCode' `
                -NotePropertyValue ([string]$requestDiagnostic.Code) `
                -Force
        } else {
            $requestFailOpenResult =
                Invoke-CodexRequesterFailOpenAfterOwnerFailure `
                    -ManagedDataDir $resolvedDataDir `
                    -RequestFailure $requestFailure
        }
        $requestFeedback =
            Get-CodexRemoteLaunchFeedback `
                -Result $requestFailOpenResult
        if ($SuppressNotification) {
            $requestFailOpenResult.FeedbackStatus = 'suppressed'
        } else {
            $requestFeedbackResult = Show-CodexRemoteLaunchFeedback `
                -Feedback $requestFeedback `
                -IconPath (
                    Join-Path $resolvedDataDir 'managed-chatgpt.ico'
                )
            $requestFailOpenResult.FeedbackStatus =
                [string]$requestFeedbackResult.Status
            $requestFailOpenResult.FeedbackFailureCode =
                $requestFeedbackResult.FailureCode
        }
        if ($script:WindowsModuleAvailable) {
            try {
                Write-CodexDesktopLaunchReceipt `
                    -DataDir $resolvedDataDir `
                    -Result $requestFailOpenResult
            } catch {
                # Native availability is independent from diagnostic storage.
            }
        }
        $requestFailOpenResult
        return
    }
    $script:RemoteRuntimeVerifiedForLaunch = $false
    if (-not [string]::IsNullOrWhiteSpace(
        $ExpectedSelectedRuntimeVersionId
    ) -or -not [string]::IsNullOrWhiteSpace(
        $ExpectedSelectedRuntimeRoot
    )) {
        $null = Assert-CodexExpectedSelectedRuntime `
            -ManagedDataDir $resolvedDataDir `
            -ExpectedVersionId $ExpectedSelectedRuntimeVersionId `
            -ExpectedRoot $ExpectedSelectedRuntimeRoot
    }
    $existingDesktopOwnerProof = if ($script:WindowsModuleAvailable) {
        Read-CodexDesktopOwnerConnectionProof -DataDir $resolvedDataDir
    } else {
        $null
    }
    $launchResult = Invoke-CodexDesktopFailOpenLaunch `
        -GetRunningDesktopAction {
            Get-CodexDesktopHandoffProcesses
        } `
        -ResolveDesktopRuntimeAction {
            if ($script:WindowsModuleAvailable) {
                try {
                    $verifiedRuntime = Resolve-CodexDesktopRuntime `
                        -RuntimeCachePath (
                            Join-Path `
                                $resolvedDataDir `
                                'desktop-runtime-cache.json'
                        )
                    $script:RemoteRuntimeVerifiedForLaunch = $true
                    $script:ResolvedDesktopRuntimeForLaunch = $verifiedRuntime
                    return $verifiedRuntime
                } catch {
                    $script:RemoteRuntimeVerifiedForLaunch = $false
                    $script:ResolvedDesktopRuntimeForLaunch = $null
                }
            }
            Resolve-NativeCodexDesktopRuntime
        } `
        -GetRemoteReadinessAction {
            if (-not $script:RemoteRuntimeVerifiedForLaunch) {
                return $null
            }
            $generation = Get-CodexLocalRemoteRuntimeGenerationStatus `
                -ManagedDataDir $resolvedDataDir
            if ([string]$generation.Status -cne 'current' -or
                $null -eq $script:ResolvedDesktopRuntimeForLaunch) {
                return $null
            }
            $activeCodexRuntime =
                Get-CodexLocalRemoteActiveCodexRuntimeStatus `
                    -ManagedDataDir $resolvedDataDir `
                    -Generation $generation `
                    -CurrentRuntime (
                        $script:ResolvedDesktopRuntimeForLaunch
                    )
            if ([string]$activeCodexRuntime.Status -cne 'current') {
                return $null
            }
            $readiness = Get-CodexLocalRemoteReadinessSnapshot `
                -Port $BrokerPort
            if ($null -eq $readiness -or
                $null -eq $generation.Receipt) {
                return $null
            }
            $readiness | Add-Member `
                -NotePropertyName 'runtimeReceiptInvocationId' `
                -NotePropertyValue (
                    [string]$generation.Receipt.RuntimeInvocationId
                )
            $readiness | Add-Member `
                -NotePropertyName 'runtimeReceiptBrokerProcessId' `
                -NotePropertyValue (
                    $generation.Receipt.ProcessId
                )
            $readiness | Add-Member `
                -NotePropertyName 'runtimeReceiptUpstreamProcessId' `
                -NotePropertyValue (
                    $generation.Receipt.Upstream.ProcessId
                )
            return $readiness
        } `
        -StartRemoteAction {
            Start-CodexLocalRemoteRegisteredTask `
                -Name $TaskName `
                -ManagedDataDir $resolvedDataDir `
                -ManagedSidecarPort $SidecarPort `
                -ManagedBrokerPort $BrokerPort `
                -ManagedBrokerUpstreamPort $BrokerUpstreamPort `
                -ManagedBasePath $BasePath `
                -ExpectedTakeoverRootIdentityKey (
                    $ExpectedTakeoverRootIdentityKey
                )
        } `
        -GetRemoteEndpointAction {
            Get-BrokerCapabilityWebSocketUrl `
                -Port $BrokerPort `
                -TokenPath (
                    Get-BrokerCapabilityTokenPath -DataDir $resolvedDataDir
                )
        } `
        -StartDesktopAction {
            param(
                [string]$DesktopExecutablePath,
                [AllowNull()]
                [string]$RemoteEndpoint
            )
            if (-not [string]::IsNullOrWhiteSpace(
                $ExpectedSelectedRuntimeVersionId
            ) -or -not [string]::IsNullOrWhiteSpace(
                $ExpectedSelectedRuntimeRoot
            )) {
                $null = Assert-CodexExpectedSelectedRuntime `
                    -ManagedDataDir $resolvedDataDir `
                    -ExpectedVersionId (
                        $ExpectedSelectedRuntimeVersionId
                    ) `
                    -ExpectedRoot $ExpectedSelectedRuntimeRoot
            }
            Start-CodexDesktopProcess `
                -DesktopExecutablePath $DesktopExecutablePath `
                -RemoteEndpoint $RemoteEndpoint
        } `
        -GetCreatedDesktopStateAction {
            param(
                [int]$ProcessId,
                [long]$StartTimeUtcTicks
            )
            Get-CodexDesktopCreatedProcessState `
                -ProcessId $ProcessId `
                -StartTimeUtcTicks $StartTimeUtcTicks
        } `
        -GetCreatedDesktopProcessHandleStateAction {
            param([object]$Process)

            Get-CodexDesktopCreatedProcessHandleState -Process $Process
        } `
        -StopCreatedDesktopAction {
            param(
                [int]$ProcessId,
                [long]$StartTimeUtcTicks,
                [string]$ExpectedExecutablePath
            )
            Stop-CodexDesktopCreatedProcess `
                -ProcessId $ProcessId `
                -StartTimeUtcTicks $StartTimeUtcTicks `
                -ExpectedExecutablePath $ExpectedExecutablePath
        } `
        -ExistingDesktopOwnerProof $existingDesktopOwnerProof `
        -TakeOverExistingNativeDesktop:$TakeOverExistingNativeDesktop `
        -RemoteStartupTimeoutMilliseconds (
            $InfrastructureStartupTimeoutSeconds * 1000
        ) `
        -RemoteAttachTimeoutMilliseconds (
            $DesktopAttachTimeoutSeconds * 1000
        ) `
        -LaunchCorrelationId $LaunchCorrelationId
    if ($script:WindowsModuleAvailable) {
        $connectionProofProperty =
            $launchResult.PSObject.Properties[
                'DesktopOwnerConnectionProof'
            ]
        if ($null -ne $connectionProofProperty -and
            $null -ne $connectionProofProperty.Value -and
            [bool]$launchResult.RemoteEnabled) {
            try {
                $connectionProof = $connectionProofProperty.Value
                $null = Write-CodexDesktopOwnerConnectionProof `
                    -DataDir $resolvedDataDir `
                    -RuntimeInvocationId (
                        [string]$connectionProof.RuntimeInvocationId
                    ) `
                    -ProcessId ([int]$connectionProof.ProcessId) `
                    -StartTimeUtcTicks (
                        [long]$connectionProof.StartTimeUtcTicks
                    ) `
                    -ExecutablePath (
                        [string]$connectionProof.ExecutablePath
                    ) `
                    -LaunchNonceDigest (
                        [string]$connectionProof.LaunchNonceDigest
                    )
            } catch {
                $launchResult.Status = 'remote-launch-unverified'
                $launchResult.RemoteEnabled = $false
                $launchResult.RemoteDecision =
                    'remote-owner-proof-write-failed'
            }
        }
        if (-not [bool]$launchResult.RemoteEnabled) {
            try {
                Remove-CodexDesktopOwnerConnectionProof `
                    -DataDir $resolvedDataDir
            } catch {
                # A stale proof can only keep formal readiness false after
                # its exact process/runtime binding no longer matches.
            }
        }
        if ($null -ne $connectionProofProperty) {
            $launchResult.PSObject.Properties.Remove(
                'DesktopOwnerConnectionProof'
            )
        }
    }
    if ($script:WindowsModuleAvailable) {
        try {
            Write-CodexDesktopLaunchReceipt `
                -DataDir $resolvedDataDir `
                -Result $launchResult
        } catch {
            # Receipt failure must never block Desktop startup.
        }
    }
    $launchFeedback = Get-CodexRemoteLaunchFeedback -Result $launchResult
    if ($SuppressNotification) {
        $launchResult.FeedbackStatus = 'suppressed'
    } elseif ($NotifyOnRemoteSuccessOnly -and
        [string]$launchResult.Status -cne 'launched-remote') {
        $launchResult.FeedbackStatus = 'filtered'
    } else {
        $feedbackResult = Show-CodexRemoteLaunchFeedback `
            -Feedback $launchFeedback `
            -IconPath (Join-Path $resolvedDataDir 'managed-chatgpt.ico')
        $launchResult.FeedbackStatus = [string]$feedbackResult.Status
        $launchResult.FeedbackFailureCode = $feedbackResult.FailureCode
    }
    if ($script:WindowsModuleAvailable) {
        try {
            Write-CodexDesktopLaunchReceipt `
                -DataDir $resolvedDataDir `
                -Result $launchResult
        } catch {
            # Final feedback receipt failure must never block Desktop startup.
        }
    }
    $launchResult
}
