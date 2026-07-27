[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 18790,

    [string]$BasePath = '/codex-remote',

    [ValidateRange(1, 65535)]
    [int]$BrokerPort = 18791,

    [ValidateRange(1, 65535)]
    [int]$BrokerUpstreamPort = 18792,

    [ValidateSet(443, 8443, 10000)]
    [int]$HttpsPort = 443,

    [string]$TaskName = 'Codex Local Remote',

    [string]$CodexPath,

    [string]$NodePath,

    [string]$PwshPath,

    [string]$InstallRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,

    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexLocalRemote'),

    [Parameter(DontShow)]
    [string]$LauncherShortcutPath,

    [Parameter(DontShow)]
    [string]$UserEnvironmentFixturePath,

    [switch]$Json
)

$ProgressPreference = 'SilentlyContinue'
Import-Module (Join-Path $PSScriptRoot 'CodexLocalRemote.Windows.psm1') -Force
Assert-CanonicalBasePath -BasePath $BasePath
if (-not [string]::IsNullOrWhiteSpace($LauncherShortcutPath) -and
    $env:CODEX_REMOTE_TEST_FIXTURE -cne '1') {
    throw 'LauncherShortcutPath is reserved for the isolated test fixture.'
}
if (-not [string]::IsNullOrWhiteSpace($UserEnvironmentFixturePath) -and
    $env:CODEX_REMOTE_TEST_FIXTURE -cne '1') {
    throw 'UserEnvironmentFixturePath is reserved for the isolated test fixture.'
}
$desktopRuntimeStatus = 'unavailable'
$desktopRuntimeError = ''
$desktopRuntime = $null
$activeDesktopRuntime = $null
if (-not [string]::IsNullOrWhiteSpace($CodexPath)) {
    if ($env:CODEX_REMOTE_TEST_FIXTURE -cne '1') {
        throw 'A fixed -CodexPath status override is not supported.'
    }
    $CodexPath = [System.IO.Path]::GetFullPath($CodexPath)
    $desktopRuntimeStatus = 'test-fixture'
}
if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $NodePath = (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1).Source
}
if ([string]::IsNullOrWhiteSpace($PwshPath)) {
    $PwshPath = (Get-Command pwsh.exe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1).Source
}
$brokerCli = [System.IO.Path]::GetFullPath(
    (Join-Path ([System.IO.Path]::GetFullPath($InstallRoot)) 'apps\broker\dist\cli.js')
)
$sidecarCli = [System.IO.Path]::GetFullPath(
    (Join-Path ([System.IO.Path]::GetFullPath($InstallRoot)) 'apps\sidecar\dist\cli.js')
)
$resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
$capabilityTokenPath = Get-BrokerCapabilityTokenPath -DataDir $resolvedDataDir
$upstreamTokenPath = [System.IO.Path]::GetFullPath(
    (Join-Path $resolvedDataDir 'app-server-upstream.token')
)

function Test-StatusOrdinaryFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [ValidateRange(0, 1048576)][long]$MinimumBytes = 1,
        [ValidateRange(1, 1048576)][long]$MaximumBytes = 65536
    )

    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            return $false
        }
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        return (
            -not $item.PSIsContainer -and
            ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0 -and
            [long]$item.Length -ge $MinimumBytes -and
            [long]$item.Length -le $MaximumBytes
        )
    } catch {
        return $false
    }
}

function Read-StatusJsonText {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-StatusOrdinaryFile -Path $Path -MinimumBytes 2 -MaximumBytes 65536)) {
        throw "Status receipt '$Path' is not an ordinary bounded file."
    }
    return Get-Content -LiteralPath $Path -Raw -Encoding utf8 -ErrorAction Stop
}

function Get-StatusUserEnvironmentValueState {
    if ([string]::IsNullOrWhiteSpace($UserEnvironmentFixturePath)) {
        return Get-UserEnvironmentValueState -Name 'CODEX_APP_SERVER_WS_URL'
    }
    $fixture = Read-StatusJsonText -Path $UserEnvironmentFixturePath |
        ConvertFrom-Json -Depth 5 -ErrorAction Stop
    $properties = @($fixture.PSObject.Properties.Name | Sort-Object)
    if (($properties -join "`0") -cne "Exists`0Value" -or
        $fixture.Exists -isnot [bool] -or
        ([bool]$fixture.Exists -and $fixture.Value -isnot [string]) -or
        (-not [bool]$fixture.Exists -and $null -ne $fixture.Value)) {
        throw 'The isolated user-environment fixture is not exact.'
    }
    return [pscustomobject]@{
        Exists = [bool]$fixture.Exists
        Value = if ([bool]$fixture.Exists) { [string]$fixture.Value } else { $null }
    }
}

function Test-StatusExactProperties {
    param(
        [AllowNull()][object]$Value,
        [Parameter(Mandatory)][string[]]$Names
    )

    if ($null -eq $Value) {
        return $false
    }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expected = @($Names | Sort-Object)
    return (
        $actual.Count -eq $expected.Count -and
        (($actual -join "`0") -ceq ($expected -join "`0"))
    )
}

function Test-StatusPositiveInteger {
    param([AllowNull()][object]$Value)

    return (
        (Test-NonNegativeInteger -Value $Value) -and
        [int64]$Value -gt 0
    )
}

function Test-StatusPathEqual {
    param(
        [AllowNull()][object]$Actual,
        [Parameter(Mandatory)][string]$Expected
    )

    try {
        return [string]::Equals(
            [System.IO.Path]::GetFullPath([string]$Actual),
            [System.IO.Path]::GetFullPath($Expected),
            [System.StringComparison]::OrdinalIgnoreCase
        )
    } catch {
        return $false
    }
}

function Get-StatusLauncherShortcutDefinition {
    $resolvedInstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
    $launcher = [System.IO.Path]::GetFullPath(
        (Join-Path $resolvedInstallRoot 'scripts\windows\Launch-CodexWithRemote.ps1')
    )
    $safeLaunchName = 'Codex Remote (' +
        (([char[]]@(0x5B89, 0x5168, 0x542F, 0x52A8)) -join '') +
        ')'
    $shortcut = if ([string]::IsNullOrWhiteSpace($LauncherShortcutPath)) {
        Join-Path `
            ([Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)) `
            "$safeLaunchName.lnk"
    } else {
        [System.IO.Path]::GetFullPath($LauncherShortcutPath)
    }
    if ([System.IO.Path]::GetExtension($shortcut) -cne '.lnk') {
        throw "Managed launcher shortcut '$shortcut' must use the .lnk extension."
    }
    $argumentValues = @(
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $launcher,
        '-DataDir',
        $resolvedDataDir,
        '-BrokerPort',
        [string]$BrokerPort,
        '-TaskName',
        $TaskName
    )
    return [pscustomobject]@{
        LauncherPath = $launcher
        ShortcutPath = [System.IO.Path]::GetFullPath($shortcut)
        TargetPath = [System.IO.Path]::GetFullPath($PwshPath)
        Arguments = (
            $argumentValues |
                ForEach-Object {
                    ConvertTo-WindowsCommandLineArgument -Value ([string]$_)
                }
        ) -join ' '
        WorkingDirectory = $resolvedInstallRoot
        Description = "$safeLaunchName - Uses Remote when ready and otherwise starts Codex Desktop natively."
    }
}

function Test-StatusLauncherShortcut {
    param([Parameter(Mandatory)][object]$Definition)

    if (-not (Test-StatusOrdinaryFile `
        -Path ([string]$Definition.ShortcutPath) `
        -MinimumBytes 1 `
        -MaximumBytes 1048576)) {
        return $false
    }
    $shell = $null
    $shortcut = $null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut([string]$Definition.ShortcutPath)
        return (
            (Test-StatusPathEqual `
                -Actual $shortcut.TargetPath `
                -Expected ([string]$Definition.TargetPath)) -and
            [string]$shortcut.Arguments -ceq [string]$Definition.Arguments -and
            (Test-StatusPathEqual `
                -Actual $shortcut.WorkingDirectory `
                -Expected ([string]$Definition.WorkingDirectory)) -and
            [string]$shortcut.Description -ceq [string]$Definition.Description
        )
    } catch {
        return $false
    } finally {
        if ($null -ne $shortcut) {
            $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
        }
        if ($null -ne $shell) {
            $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
        }
    }
}

function Test-DesktopRuntimeIdentityCurrent {
    param(
        [AllowNull()][object]$ActiveRuntime,
        [AllowNull()][object]$CurrentRuntime
    )

    if ($null -eq $ActiveRuntime -or $null -eq $CurrentRuntime) {
        return $false
    }
    return (
        [string]$ActiveRuntime.Signature -ceq
            'codex-local-remote/codex-desktop-runtime/v1' -and
        [string]$CurrentRuntime.Signature -ceq
            'codex-local-remote/codex-desktop-runtime/v1' -and
        [int]$ActiveRuntime.Version -eq 1 -and
        [int]$CurrentRuntime.Version -eq 1 -and
        [string]$ActiveRuntime.PackageName -ceq
            [string]$CurrentRuntime.PackageName -and
        [string]$ActiveRuntime.PackageFamilyName -ceq
            [string]$CurrentRuntime.PackageFamilyName -and
        [string]$ActiveRuntime.PackageFullName -ceq
            [string]$CurrentRuntime.PackageFullName -and
        [string]$ActiveRuntime.PackageVersion -ceq
            [string]$CurrentRuntime.PackageVersion -and
        (Test-StatusPathEqual `
            -Actual $ActiveRuntime.PackageInstallLocation `
            -Expected ([string]$CurrentRuntime.PackageInstallLocation)) -and
        (Test-StatusPathEqual `
            -Actual $ActiveRuntime.DesktopExecutablePath `
            -Expected ([string]$CurrentRuntime.DesktopExecutablePath)) -and
        [string]$ActiveRuntime.DesktopExecutableSha256 -ceq
            [string]$CurrentRuntime.DesktopExecutableSha256 -and
        (Test-StatusPathEqual `
            -Actual $ActiveRuntime.BundledCodexPath `
            -Expected ([string]$CurrentRuntime.BundledCodexPath)) -and
        [string]$ActiveRuntime.BundledCodexSha256 -ceq
            [string]$CurrentRuntime.BundledCodexSha256 -and
        (Test-StatusPathEqual `
            -Actual $ActiveRuntime.CodexPath `
            -Expected ([string]$CurrentRuntime.CodexPath)) -and
        [string]$ActiveRuntime.CodexSha256 -ceq
            [string]$CurrentRuntime.CodexSha256
    )
}

function Test-DesktopPackageStatusIdentityCurrent {
    param(
        [AllowNull()][object]$ActiveRuntime,
        [AllowNull()][object]$CurrentPackage
    )

    if ($null -eq $ActiveRuntime -or $null -eq $CurrentPackage) {
        return $false
    }
    return (
        [string]$ActiveRuntime.Signature -ceq
            'codex-local-remote/codex-desktop-runtime/v1' -and
        [int]$ActiveRuntime.Version -eq 1 -and
        [string]$CurrentPackage.Signature -ceq
            'codex-local-remote/codex-desktop-package-status/v1' -and
        [int]$CurrentPackage.Version -eq 1 -and
        [string]$ActiveRuntime.PackageName -ceq
            [string]$CurrentPackage.PackageName -and
        [string]$ActiveRuntime.PackageFamilyName -ceq
            [string]$CurrentPackage.PackageFamilyName -and
        [string]$ActiveRuntime.PackageFullName -ceq
            [string]$CurrentPackage.PackageFullName -and
        [string]$ActiveRuntime.PackageVersion -ceq
            [string]$CurrentPackage.PackageVersion -and
        (Test-StatusPathEqual `
            -Actual $ActiveRuntime.PackageInstallLocation `
            -Expected ([string]$CurrentPackage.PackageInstallLocation)) -and
        (Test-StatusPathEqual `
            -Actual $ActiveRuntime.DesktopExecutablePath `
            -Expected ([string]$CurrentPackage.DesktopExecutablePath)) -and
        (Test-StatusPathEqual `
            -Actual $ActiveRuntime.BundledCodexPath `
            -Expected ([string]$CurrentPackage.BundledCodexPath))
    )
}

function Test-StatusRecordedAtUtc {
    param([AllowNull()][object]$Value)

    if ($Value -is [datetime]) {
        return ([datetime]$Value).Kind -eq [DateTimeKind]::Utc
    }
    if ($Value -is [datetimeoffset]) {
        return ([datetimeoffset]$Value).Offset -eq [TimeSpan]::Zero
    }
    $parsed = [DateTimeOffset]::MinValue
    return (
        [DateTimeOffset]::TryParse(
        [string]$Value,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$parsed
        ) -and
        $parsed.Offset -eq [TimeSpan]::Zero
    )
}

if ([string]::IsNullOrWhiteSpace($CodexPath)) {
    try {
        $activeBrokerStatePath = Join-Path $resolvedDataDir 'app-server-broker.json'
        $activeBrokerState = Read-StatusJsonText -Path $activeBrokerStatePath |
            ConvertFrom-Json -Depth 20 -ErrorAction Stop
        if ([string]$activeBrokerState.Signature -cne
                'codex-local-remote/app-server-broker/v3' -or
            [int]$activeBrokerState.Version -ne 3 -or
            [string]::IsNullOrWhiteSpace([string]$activeBrokerState.CodexPath)) {
            throw 'The active Broker receipt does not contain an exact runtime identity.'
        }
        $CodexPath = [System.IO.Path]::GetFullPath(
            [string]$activeBrokerState.CodexPath
        )
        $desktopRuntimeStatus = 'active-receipt'
    } catch {
        $CodexPath = $null
        $desktopRuntimeStatus = 'active-receipt-unavailable'
        $desktopRuntimeError = [string]$_.Exception.Message
    }
}

function Test-RuntimeProcessReceiptShape {
    param(
        [AllowNull()][object]$Receipt,
        [Parameter(Mandatory)][string]$RuntimeInvocationId
    )

    if (-not (Test-StatusExactProperties `
        -Value $Receipt `
        -Names @(
            'RuntimeInvocationId',
            'ProcessId',
            'CreationDate',
            'CreationDateUtcTicks',
            'ProcessStartTimeUtcTicks'
        )) -or
        [string]$Receipt.RuntimeInvocationId -cne $RuntimeInvocationId -or
        -not (Test-StatusPositiveInteger -Value $Receipt.ProcessId) -or
        [string]::IsNullOrWhiteSpace([string]$Receipt.CreationDate) -or
        -not (Test-StatusPositiveInteger -Value $Receipt.CreationDateUtcTicks) -or
        -not (Test-StatusPositiveInteger -Value $Receipt.ProcessStartTimeUtcTicks)) {
        return $false
    }
    try {
        $creation = Get-ProcessCreationIdentity -CreationDate $Receipt.CreationDate
        return (
            [long]$creation.CreationDateUtcTicks -eq
                [long]$Receipt.CreationDateUtcTicks -and
            [Math]::Abs(
                [long]$Receipt.ProcessStartTimeUtcTicks -
                    [long]$Receipt.CreationDateUtcTicks
            ) -le [TimeSpan]::FromSeconds(2).Ticks
        )
    } catch {
        return $false
    }
}

function Get-StatusListenerSnapshot {
    param([Parameter(Mandatory)][int[]]$LocalPorts)

    $connections = if ($env:CODEX_REMOTE_TEST_FIXTURE -ceq '1') {
        @(
            foreach ($localPort in $LocalPorts) {
                Get-NetTCPConnection `
                    -State Listen `
                    -LocalPort $localPort `
                    -ErrorAction SilentlyContinue |
                    ForEach-Object {
                        [pscustomobject]@{
                            LocalAddress = [string]$_.LocalAddress
                            LocalPort = $localPort
                            OwningProcess = [int]$_.OwningProcess
                        }
                    }
            }
        )
    } else {
        @(
            Get-NetTCPConnection `
                -State Listen `
                -LocalPort $LocalPorts `
                -ErrorAction SilentlyContinue |
                ForEach-Object {
                    [pscustomobject]@{
                        LocalAddress = [string]$_.LocalAddress
                        LocalPort = [int]$_.LocalPort
                        OwningProcess = [int]$_.OwningProcess
                    }
                }
        )
    }
    return @($connections | Sort-Object LocalPort, LocalAddress, OwningProcess)
}

function Get-StatusListenerIdentity {
    param(
        [Parameter(Mandatory)][int]$LocalPort,
        [Parameter(Mandatory)][object[]]$Snapshot
    )

    return @(
        $Snapshot |
            Where-Object { [int]$_.LocalPort -eq $LocalPort } |
            Sort-Object LocalAddress, OwningProcess
    )
}

function Test-ReceiptListenerIdentity {
    param(
        [Parameter(Mandatory)][object[]]$Listeners,
        [Parameter(Mandatory)][object]$Receipt
    )

    return (
        $Listeners.Count -eq 1 -and
        [string]$Listeners[0].LocalAddress -ceq '127.0.0.1' -and
        [int]$Listeners[0].OwningProcess -eq [int]$Receipt.ProcessId
    )
}

function Test-RuntimeProcessReceiptEqual {
    param(
        [AllowNull()][object]$Left,
        [AllowNull()][object]$Right
    )

    return (
        $null -ne $Left -and
        $null -ne $Right -and
        [string]$Left.RuntimeInvocationId -ceq [string]$Right.RuntimeInvocationId -and
        [int]$Left.ProcessId -eq [int]$Right.ProcessId -and
        [string]$Left.CreationDate -ceq [string]$Right.CreationDate -and
        [long]$Left.CreationDateUtcTicks -eq [long]$Right.CreationDateUtcTicks -and
        [long]$Left.ProcessStartTimeUtcTicks -eq
            [long]$Right.ProcessStartTimeUtcTicks
    )
}

function Test-StatusListenerIdentityEqual {
    param(
        [Parameter(Mandatory)][object[]]$Left,
        [Parameter(Mandatory)][object[]]$Right
    )

    if ($Left.Count -ne $Right.Count) {
        return $false
    }
    for ($index = 0; $index -lt $Left.Count; $index++) {
        if ([string]$Left[$index].LocalAddress -cne
                [string]$Right[$index].LocalAddress -or
            [int]$Left[$index].LocalPort -ne [int]$Right[$index].LocalPort -or
            [int]$Left[$index].OwningProcess -ne
                [int]$Right[$index].OwningProcess) {
            return $false
        }
    }
    return $true
}

function Test-LiveRuntimeReceiptProcess {
    param(
        [Parameter(Mandatory)][object]$Receipt,
        [Parameter(Mandatory)]
        [ValidateSet('Bootstrap', 'Broker', 'Sidecar', 'Upstream')]
        [string]$Kind
    )

    try {
        $process = Get-CimInstance `
            Win32_Process `
            -Filter "ProcessId = $([int]$Receipt.ProcessId)" `
            -ErrorAction Stop
        if ($null -eq $process -or [int]$process.ProcessId -ne [int]$Receipt.ProcessId) {
            return $false
        }
        $creation = Get-ProcessCreationIdentity -CreationDate $process.CreationDate
        if ([long]$creation.CreationDateUtcTicks -ne
            [long]$Receipt.CreationDateUtcTicks) {
            return $false
        }
        $nativeProcess = Get-Process -Id ([int]$Receipt.ProcessId) -ErrorAction Stop
        try {
            if ($nativeProcess.StartTime.ToUniversalTime().Ticks -ne
                [long]$Receipt.ProcessStartTimeUtcTicks) {
                return $false
            }
        } finally {
            if ($null -ne $nativeProcess -and
                $null -ne $nativeProcess.PSObject.Methods['Dispose']) {
                $nativeProcess.Dispose()
            }
        }

        $ownership = switch ($Kind) {
            'Bootstrap' {
                Test-ManagedBootstrapProcess `
                    -CommandLine ([string]$process.CommandLine) `
                    -ExecutablePath ([string]$process.ExecutablePath) `
                    -TaskName $TaskName `
                    -NodePath $NodePath `
                    -PwshPath $PwshPath `
                    -InstallRoot $InstallRoot `
                    -DataDir $resolvedDataDir `
                    -Port $Port `
                    -BrokerPort $BrokerPort `
                    -BrokerUpstreamPort $BrokerUpstreamPort `
                    -BasePath $BasePath
            }
            'Broker' {
                Test-ManagedBrokerProcess `
                    -CommandLine ([string]$process.CommandLine) `
                    -ExecutablePath ([string]$process.ExecutablePath) `
                    -ExpectedNodePath $NodePath `
                    -ExpectedBrokerCliPath $brokerCli `
                    -BrokerPort $BrokerPort `
                    -UpstreamPort $BrokerUpstreamPort `
                    -ExpectedCodexPath $CodexPath `
                    -DataDir $resolvedDataDir `
                    -CapabilityTokenFilePath $capabilityTokenPath
            }
            'Sidecar' {
                Test-ManagedSidecarProcess `
                    -CommandLine ([string]$process.CommandLine) `
                    -ExecutablePath ([string]$process.ExecutablePath) `
                    -ExpectedNodePath $NodePath `
                    -ExpectedSidecarCliPath $sidecarCli `
                    -Port $Port `
                    -BasePath $BasePath `
                    -DataDir $resolvedDataDir
            }
            'Upstream' {
                Test-ManagedAppServerProcess `
                    -CommandLine ([string]$process.CommandLine) `
                    -ExecutablePath ([string]$process.ExecutablePath) `
                    -ExpectedCodexPath $CodexPath `
                    -WebSocketUrl (Get-BrokerWebSocketUrl -Port $BrokerUpstreamPort) `
                    -TokenFilePath $upstreamTokenPath
            }
        }
        return [bool]$ownership.IsManaged
    } catch {
        return $false
    }
}

$task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
$taskState = if ($null -eq $task) { 'not-registered' } else { $task.State.ToString() }
$taskRunning = $taskState -ceq 'Running'
$taskOwned = $false
$taskRuntimeBinding = 'unknown'
$lastTaskResult = $null
if ($null -ne $task) {
    $taskInfo = Get-ScheduledTaskInfo `
        -TaskName $TaskName `
        -TaskPath '\' `
        -ErrorAction SilentlyContinue
    if ($null -ne $taskInfo) {
        $lastTaskResult = $taskInfo.LastTaskResult
    }

    if (-not [string]::IsNullOrWhiteSpace($NodePath) -and
        -not [string]::IsNullOrWhiteSpace($PwshPath)) {
        try {
            $expectedTask = Get-StartupTaskDefinition `
                -TaskName $TaskName `
                -NodePath $NodePath `
                -PwshPath $PwshPath `
                -InstallRoot $InstallRoot `
                -DataDir $DataDir `
                -Port $Port `
                -BrokerPort $BrokerPort `
                -BrokerUpstreamPort $BrokerUpstreamPort `
                -BasePath $BasePath
            $taskOwnership = Test-ManagedStartupTask -Task $task -Expected $expectedTask
            $taskOwned = [bool]$taskOwnership.IsManaged
            if ($taskOwned) {
                $taskRuntimeBinding = 'dynamic-v3'
            } else {
                $actions = @($task.Actions)
                if ($actions.Count -eq 1) {
                    $arguments = @(
                        ConvertFrom-WindowsCommandLine `
                            -CommandLine ([string]$actions[0].Arguments)
                    )
                    $codexSwitchIndexes = @(
                        for ($index = 0; $index -lt $arguments.Count; $index++) {
                            if ([string]$arguments[$index] -ceq '-CodexPath') {
                                $index
                            }
                        }
                    )
                    if ($codexSwitchIndexes.Count -eq 1 -and
                        $codexSwitchIndexes[0] + 1 -lt $arguments.Count) {
                        $pinnedExpected = Get-PinnedStartupTaskDefinitionV2 `
                            -TaskName $TaskName `
                            -NodePath $NodePath `
                            -CodexPath (
                                [string]$arguments[$codexSwitchIndexes[0] + 1]
                            ) `
                            -PwshPath $PwshPath `
                            -InstallRoot $InstallRoot `
                            -DataDir $DataDir `
                            -Port $Port `
                            -BrokerPort $BrokerPort `
                            -BrokerUpstreamPort $BrokerUpstreamPort `
                            -BasePath $BasePath
                        $pinnedOwnership = Test-ManagedStartupTask `
                            -Task $task `
                            -Expected $pinnedExpected
                        if ($pinnedOwnership.IsManaged) {
                            $taskOwned = $true
                            $taskRuntimeBinding = 'pinned-v2-update-required'
                        }
                    }
                }
            }
        } catch {
            $taskOwned = $false
            $taskRuntimeBinding = 'invalid'
        }
    }
}
$taskReady = $taskOwned -and $taskRunning
$listenerPorts = @($Port, $BrokerPort, $BrokerUpstreamPort)
$listenerSnapshotInitial = @(Get-StatusListenerSnapshot -LocalPorts $listenerPorts)
$sidecarListeners = @(
    $listenerSnapshotInitial | Where-Object { [int]$_.LocalPort -eq $Port }
)
$sidecarIpv4Listeners = @(Get-ManagedIpv4Listeners -Listeners $sidecarListeners)
$sidecarLoopbackOnly = (
    $sidecarIpv4Listeners.Count -gt 0 -and
    @(
        $sidecarListeners |
            Where-Object {
                -not (Test-IsLoopbackListenerAddress -Address $_.LocalAddress)
            }
    ).Count -eq 0
)
$sidecarPids = @(
    $sidecarIpv4Listeners |
        Select-Object -ExpandProperty OwningProcess -Unique
)
$sidecarPid = if ($sidecarPids.Count -eq 1) { [int]$sidecarPids[0] } else { $null }
$sidecarListenerReady = (
    $sidecarIpv4Listeners.Count -eq 1 -and
    $sidecarLoopbackOnly -and
    $sidecarPids.Count -eq 1
)
$sidecarOwned = $false
if ($null -ne $sidecarPid -and -not [string]::IsNullOrWhiteSpace($NodePath)) {
    $sidecarProcess = Get-CimInstance `
        Win32_Process `
        -Filter "ProcessId = $sidecarPid" `
        -ErrorAction SilentlyContinue
    if ($null -ne $sidecarProcess) {
        $sidecarOwnership = Test-ManagedSidecarProcess `
            -CommandLine ([string]$sidecarProcess.CommandLine) `
            -ExecutablePath ([string]$sidecarProcess.ExecutablePath) `
            -ExpectedNodePath $NodePath `
            -ExpectedSidecarCliPath $sidecarCli `
            -Port $Port `
            -BasePath $BasePath `
            -DataDir $resolvedDataDir
        $sidecarOwned = [bool]$sidecarOwnership.IsManaged
    }
}
$sidecarReady = $sidecarListenerReady -and $sidecarOwned

$brokerListeners = @(
    $listenerSnapshotInitial | Where-Object { [int]$_.LocalPort -eq $BrokerPort }
)
$brokerIpv4Listeners = @(Get-ManagedIpv4Listeners -Listeners $brokerListeners)
$brokerLoopbackOnly = (
    $brokerIpv4Listeners.Count -gt 0 -and
    @(
        $brokerListeners |
            Where-Object {
                -not (Test-IsLoopbackListenerAddress -Address $_.LocalAddress)
            }
    ).Count -eq 0
)
$brokerPids = @(
    $brokerIpv4Listeners |
        Select-Object -ExpandProperty OwningProcess -Unique
)
$brokerPid = if ($brokerPids.Count -eq 1) { [int]$brokerPids[0] } else { $null }
$brokerOwned = $false
if ($null -ne $brokerPid -and
    -not [string]::IsNullOrWhiteSpace($NodePath) -and
    -not [string]::IsNullOrWhiteSpace($CodexPath)) {
    $brokerProcess = Get-CimInstance `
        Win32_Process `
        -Filter "ProcessId = $brokerPid" `
        -ErrorAction SilentlyContinue
    if ($null -ne $brokerProcess) {
        $brokerOwnership = Test-ManagedBrokerProcess `
            -CommandLine ([string]$brokerProcess.CommandLine) `
            -ExecutablePath ([string]$brokerProcess.ExecutablePath) `
            -ExpectedNodePath $NodePath `
            -ExpectedBrokerCliPath $brokerCli `
            -BrokerPort $BrokerPort `
            -UpstreamPort $BrokerUpstreamPort `
            -ExpectedCodexPath $CodexPath `
            -DataDir $resolvedDataDir `
            -CapabilityTokenFilePath $capabilityTokenPath
        $brokerOwned = [bool]$brokerOwnership.IsManaged
    }
}
$brokerProxyReady = $brokerLoopbackOnly -and $brokerOwned
$brokerHealthReady = $false
$desktopConnected = $false
$sidecarConnected = $false
$degraded = $true
$unknownCount = $null
try {
    $brokerHealth = Invoke-RestMethod `
        -Method Get `
        -Uri "http://127.0.0.1:$BrokerPort/ready" `
        -TimeoutSec 2
    $brokerHealthReady = (
        $brokerHealth.appServerReady -ceq $true -and
        $brokerHealth.desktopConnected -is [bool] -and
        $brokerHealth.sidecarConnected -is [bool] -and
        $brokerHealth.degraded -is [bool] -and
        (Test-NonNegativeInteger -Value $brokerHealth.unknownCount)
    )
    if ($brokerHealthReady) {
        $desktopConnected = [bool]$brokerHealth.desktopConnected
        $sidecarConnected = [bool]$brokerHealth.sidecarConnected
        $degraded = [bool]$brokerHealth.degraded
        $unknownCount = $brokerHealth.unknownCount
    }
} catch {
    $brokerHealthReady = $false
}

$upstreamUrl = Get-BrokerWebSocketUrl -Port $BrokerUpstreamPort
$upstreamListeners = @(
    $listenerSnapshotInitial | Where-Object { [int]$_.LocalPort -eq $BrokerUpstreamPort }
)
$upstreamIpv4Listeners = @(Get-ManagedIpv4Listeners -Listeners $upstreamListeners)
$upstreamLoopbackOnly = (
    $upstreamIpv4Listeners.Count -gt 0 -and
    @(
        $upstreamListeners |
            Where-Object {
                -not (Test-IsLoopbackListenerAddress -Address $_.LocalAddress)
            }
    ).Count -eq 0
)
$upstreamPids = @(
    $upstreamIpv4Listeners |
        Select-Object -ExpandProperty OwningProcess -Unique
)
$upstreamPid = if ($upstreamPids.Count -eq 1) { [int]$upstreamPids[0] } else { $null }
$upstreamOwned = $false
if ($null -ne $upstreamPid -and -not [string]::IsNullOrWhiteSpace($CodexPath)) {
    $upstreamProcess = Get-CimInstance `
        Win32_Process `
        -Filter "ProcessId = $upstreamPid" `
        -ErrorAction SilentlyContinue
    if ($null -ne $upstreamProcess) {
        $upstreamOwnership = Test-ManagedAppServerProcess `
            -CommandLine ([string]$upstreamProcess.CommandLine) `
            -ExecutablePath ([string]$upstreamProcess.ExecutablePath) `
            -ExpectedCodexPath $CodexPath `
            -WebSocketUrl $upstreamUrl `
            -TokenFilePath $upstreamTokenPath
        $upstreamOwned = [bool]$upstreamOwnership.IsManaged
    }
}
$brokerUpstreamReady = $upstreamLoopbackOnly -and $upstreamOwned
$brokerReady = $brokerProxyReady -and $brokerHealthReady -and $brokerUpstreamReady

$bootstrapIdentityReady = $false
$brokerIdentityReady = $false
$sidecarIdentityReady = $false
$upstreamIdentityReady = $false
$startupInvocationReady = $false
$runtimeReceiptReady = $false
$brokerStatePath = Join-Path $resolvedDataDir 'app-server-broker.json'
$startupStatusPath = Join-Path $resolvedDataDir 'startup-last.json'
try {
    $startupRawBefore = Read-StatusJsonText -Path $startupStatusPath
    $brokerRawBefore = Read-StatusJsonText -Path $brokerStatePath
    $startupReceipt = $startupRawBefore |
        ConvertFrom-Json -Depth 20 -ErrorAction Stop
    $brokerReceipt = $brokerRawBefore |
        ConvertFrom-Json -Depth 20 -ErrorAction Stop

    $startupCommonSchemaReady = (
        [string]$startupReceipt.Status -ceq 'ready' -and
        [string]$startupReceipt.Stage -ceq 'supervising' -and
        $startupReceipt.Message -is [string] -and
        [string]$startupReceipt.BootstrapInvocationId -cmatch '^[0-9a-f]{32}$' -and
        [string]$startupReceipt.RuntimeInvocationId -cmatch '^[0-9a-f]{32}$' -and
        (Test-StatusRecordedAtUtc -Value $startupReceipt.RecordedAtUtc)
    )
    $startupV2SchemaReady = (
        (Test-StatusExactProperties `
            -Value $startupReceipt `
            -Names @(
                'Signature',
                'Version',
                'Status',
                'Stage',
                'Message',
                'BootstrapInvocationId',
                'RuntimeInvocationId',
                'Bootstrap',
                'RecordedAtUtc'
            )) -and
        [string]$startupReceipt.Signature -ceq
            'codex-local-remote/startup-status/v2' -and
        (Test-NonNegativeInteger -Value $startupReceipt.Version) -and
        [int]$startupReceipt.Version -eq 2
    )
    $startupV3SchemaReady = (
        (Test-StatusExactProperties `
            -Value $startupReceipt `
            -Names @(
                'Signature',
                'Version',
                'Status',
                'Stage',
                'Message',
                'BootstrapInvocationId',
                'RuntimeInvocationId',
                'Bootstrap',
                'Runtime',
                'RecordedAtUtc'
            )) -and
        [string]$startupReceipt.Signature -ceq
            'codex-local-remote/startup-status/v3' -and
        (Test-NonNegativeInteger -Value $startupReceipt.Version) -and
        [int]$startupReceipt.Version -eq 3 -and
        (Test-StatusExactProperties `
            -Value $startupReceipt.Runtime `
            -Names @(
                'Signature',
                'Version',
                'PackageName',
                'PackageFamilyName',
                'PackageFullName',
                'PackageVersion',
                'PackageInstallLocation',
                'DesktopExecutablePath',
                'DesktopExecutableSha256',
                'BundledCodexPath',
                'BundledCodexSha256',
                'CodexPath',
                'CodexSha256',
                'Source',
                'RunningDesktopObserved',
                'DiscoveredAtUtc'
            )) -and
        [string]$startupReceipt.Runtime.Signature -ceq
            'codex-local-remote/codex-desktop-runtime/v1' -and
        (Test-NonNegativeInteger -Value $startupReceipt.Runtime.Version) -and
        [int]$startupReceipt.Runtime.Version -eq 1 -and
        [string]$startupReceipt.Runtime.CodexSha256 -cmatch '^[0-9A-F]{64}$' -and
        [string]$startupReceipt.Runtime.BundledCodexSha256 -ceq
            [string]$startupReceipt.Runtime.CodexSha256 -and
        [string]$startupReceipt.Runtime.DesktopExecutableSha256 -cmatch
            '^[0-9A-F]{64}$' -and
        (Test-StatusPathEqual `
            -Actual $startupReceipt.Runtime.CodexPath `
            -Expected $CodexPath) -and
        $startupReceipt.Runtime.RunningDesktopObserved -is [bool] -and
        (Test-StatusRecordedAtUtc `
            -Value $startupReceipt.Runtime.DiscoveredAtUtc)
    )
    $startupSchemaReady = (
        $startupCommonSchemaReady -and
        ($startupV2SchemaReady -or $startupV3SchemaReady)
    )
    if ($startupV3SchemaReady) {
        $activeDesktopRuntime = $startupReceipt.Runtime
    }
    $brokerSchemaReady = (
        (Test-StatusExactProperties `
            -Value $brokerReceipt `
            -Names @(
                'Signature',
                'Version',
                'Status',
                'RuntimeInvocationId',
                'Bootstrap',
                'Broker',
                'Sidecar',
                'Upstream',
                'ProcessId',
                'CreationDate',
                'CreationDateUtcTicks',
                'ProcessStartTimeUtcTicks',
                'NodePath',
                'BrokerCliPath',
                'CodexPath',
                'StartedByThisInvocation',
                'RecordedAtUtc'
            )) -and
        [string]$brokerReceipt.Signature -ceq
            'codex-local-remote/app-server-broker/v3' -and
        (Test-NonNegativeInteger -Value $brokerReceipt.Version) -and
        [int]$brokerReceipt.Version -eq 3 -and
        [string]$brokerReceipt.Status -ceq 'ready' -and
        [string]$brokerReceipt.RuntimeInvocationId -cmatch '^[0-9a-f]{32}$' -and
        $brokerReceipt.StartedByThisInvocation -is [bool] -and
        (Test-StatusRecordedAtUtc -Value $brokerReceipt.RecordedAtUtc) -and
        (Test-StatusPathEqual -Actual $brokerReceipt.NodePath -Expected $NodePath) -and
        (Test-StatusPathEqual -Actual $brokerReceipt.BrokerCliPath -Expected $brokerCli) -and
        (Test-StatusPathEqual -Actual $brokerReceipt.CodexPath -Expected $CodexPath)
    )
    if (-not $startupSchemaReady -or -not $brokerSchemaReady) {
        throw 'Runtime receipt schema is not exact.'
    }

    $runtimeInvocationId = [string]$brokerReceipt.RuntimeInvocationId
    $bootstrapShapeReady = Test-RuntimeProcessReceiptShape `
        -Receipt $brokerReceipt.Bootstrap `
        -RuntimeInvocationId $runtimeInvocationId
    $brokerShapeReady = Test-RuntimeProcessReceiptShape `
        -Receipt $brokerReceipt.Broker `
        -RuntimeInvocationId $runtimeInvocationId
    $sidecarShapeReady = Test-RuntimeProcessReceiptShape `
        -Receipt $brokerReceipt.Sidecar `
        -RuntimeInvocationId $runtimeInvocationId
    $upstreamShapeReady = Test-RuntimeProcessReceiptShape `
        -Receipt $brokerReceipt.Upstream `
        -RuntimeInvocationId $runtimeInvocationId
    $startupBootstrapShapeReady = Test-RuntimeProcessReceiptShape `
        -Receipt $startupReceipt.Bootstrap `
        -RuntimeInvocationId ([string]$startupReceipt.RuntimeInvocationId)
    if (-not $bootstrapShapeReady -or
        -not $brokerShapeReady -or
        -not $sidecarShapeReady -or
        -not $upstreamShapeReady -or
        -not $startupBootstrapShapeReady) {
        throw 'Runtime receipt process identity shape is not exact.'
    }

    $brokerTopLevelIdentityReady = (
        [int]$brokerReceipt.ProcessId -eq [int]$brokerReceipt.Broker.ProcessId -and
        [string]$brokerReceipt.CreationDate -ceq
            [string]$brokerReceipt.Broker.CreationDate -and
        [long]$brokerReceipt.CreationDateUtcTicks -eq
            [long]$brokerReceipt.Broker.CreationDateUtcTicks -and
        [long]$brokerReceipt.ProcessStartTimeUtcTicks -eq
            [long]$brokerReceipt.Broker.ProcessStartTimeUtcTicks
    )
    $startupInvocationReady = (
        [string]$startupReceipt.RuntimeInvocationId -ceq $runtimeInvocationId -and
        (Test-RuntimeProcessReceiptEqual `
            -Left $startupReceipt.Bootstrap `
            -Right $brokerReceipt.Bootstrap)
    )
    if (-not $brokerTopLevelIdentityReady -or -not $startupInvocationReady) {
        throw 'Startup and Broker receipts do not describe one runtime generation.'
    }

    $listenerSnapshotBefore = if ($env:CODEX_REMOTE_TEST_FIXTURE -ceq '1') {
        @(Get-StatusListenerSnapshot -LocalPorts $listenerPorts)
    } else {
        $listenerSnapshotInitial
    }
    $sidecarListenersBefore = @(
        Get-StatusListenerIdentity -LocalPort $Port -Snapshot $listenerSnapshotBefore
    )
    $brokerListenersBefore = @(
        Get-StatusListenerIdentity -LocalPort $BrokerPort -Snapshot $listenerSnapshotBefore
    )
    $upstreamListenersBefore = @(
        Get-StatusListenerIdentity `
            -LocalPort $BrokerUpstreamPort `
            -Snapshot $listenerSnapshotBefore
    )
    $bootstrapLiveReady = Test-LiveRuntimeReceiptProcess `
        -Receipt $brokerReceipt.Bootstrap `
        -Kind Bootstrap
    $brokerLiveReady = (
        (Test-ReceiptListenerIdentity `
            -Listeners $brokerListenersBefore `
            -Receipt $brokerReceipt.Broker) -and
        (Test-LiveRuntimeReceiptProcess `
            -Receipt $brokerReceipt.Broker `
            -Kind Broker)
    )
    $sidecarLiveReady = (
        (Test-ReceiptListenerIdentity `
            -Listeners $sidecarListenersBefore `
            -Receipt $brokerReceipt.Sidecar) -and
        (Test-LiveRuntimeReceiptProcess `
            -Receipt $brokerReceipt.Sidecar `
            -Kind Sidecar)
    )
    $upstreamLiveReady = (
        (Test-ReceiptListenerIdentity `
            -Listeners $upstreamListenersBefore `
            -Receipt $brokerReceipt.Upstream) -and
        (Test-LiveRuntimeReceiptProcess `
            -Receipt $brokerReceipt.Upstream `
            -Kind Upstream)
    )

    $receiptHealth = Invoke-RestMethod `
        -Method Get `
        -Uri "http://127.0.0.1:$BrokerPort/ready" `
        -TimeoutSec 2
    $healthIdentityReady = (
        [string]$receiptHealth.runtimeInvocationId -ceq $runtimeInvocationId -and
        (Test-StatusPositiveInteger -Value $receiptHealth.brokerProcessId) -and
        [int]$receiptHealth.brokerProcessId -eq [int]$brokerReceipt.Broker.ProcessId -and
        (Test-StatusPositiveInteger -Value $receiptHealth.upstreamProcessId) -and
        [int]$receiptHealth.upstreamProcessId -eq
            [int]$brokerReceipt.Upstream.ProcessId
    )

    $listenerSnapshotAfter = @(Get-StatusListenerSnapshot -LocalPorts $listenerPorts)
    $sidecarListenersAfter = @(
        Get-StatusListenerIdentity -LocalPort $Port -Snapshot $listenerSnapshotAfter
    )
    $brokerListenersAfter = @(
        Get-StatusListenerIdentity -LocalPort $BrokerPort -Snapshot $listenerSnapshotAfter
    )
    $upstreamListenersAfter = @(
        Get-StatusListenerIdentity `
            -LocalPort $BrokerUpstreamPort `
            -Snapshot $listenerSnapshotAfter
    )
    $startupRawAfter = Read-StatusJsonText -Path $startupStatusPath
    $brokerRawAfter = Read-StatusJsonText -Path $brokerStatePath
    $listenerIdentityUnchanged = (
        (Test-StatusListenerIdentityEqual `
            -Left $sidecarListenersBefore `
            -Right $sidecarListenersAfter) -and
        (Test-StatusListenerIdentityEqual `
            -Left $brokerListenersBefore `
            -Right $brokerListenersAfter) -and
        (Test-StatusListenerIdentityEqual `
            -Left $upstreamListenersBefore `
            -Right $upstreamListenersAfter)
    )
    $receiptFilesUnchanged = (
        $startupRawBefore -ceq $startupRawAfter -and
        $brokerRawBefore -ceq $brokerRawAfter
    )

    $bootstrapIdentityReady = $bootstrapLiveReady -and $receiptFilesUnchanged
    $brokerIdentityReady = (
        $brokerLiveReady -and
        $listenerIdentityUnchanged -and
        $receiptFilesUnchanged
    )
    $sidecarIdentityReady = (
        $sidecarLiveReady -and
        $listenerIdentityUnchanged -and
        $receiptFilesUnchanged
    )
    $upstreamIdentityReady = (
        $upstreamLiveReady -and
        $listenerIdentityUnchanged -and
        $receiptFilesUnchanged
    )
    $runtimeReceiptReady = (
        $bootstrapIdentityReady -and
        $brokerIdentityReady -and
        $sidecarIdentityReady -and
        $upstreamIdentityReady -and
        $startupInvocationReady -and
        $healthIdentityReady
    )
} catch {
    $bootstrapIdentityReady = $false
    $brokerIdentityReady = $false
    $sidecarIdentityReady = $false
    $upstreamIdentityReady = $false
    $startupInvocationReady = $false
    $runtimeReceiptReady = $false
}

$desktopStdioPids = [System.Collections.Generic.List[int]]::new()
foreach ($candidate in @(
    Get-CimInstance Win32_Process -Filter "Name = 'codex.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            [string]$_.CommandLine -match '(?:^|\s)app-server(?:\s|$)' -and
            [string]$_.CommandLine -notmatch '(?:^|\s)--listen(?:\s|$)'
        }
)) {
    $parent = Get-CimInstance `
        Win32_Process `
        -Filter "ProcessId = $([int]$candidate.ParentProcessId)" `
        -ErrorAction SilentlyContinue
    if (Test-IndependentDesktopAppServer `
        -CommandLine ([string]$candidate.CommandLine) `
        -ParentProcessName ([string]$parent.Name)) {
        $desktopStdioPids.Add([int]$candidate.ProcessId)
    }
}

$forceCliScopes = [System.Collections.Generic.List[string]]::new()
foreach ($scope in @(
    [System.EnvironmentVariableTarget]::Process,
    [System.EnvironmentVariableTarget]::User,
    [System.EnvironmentVariableTarget]::Machine
)) {
    $value = [System.Environment]::GetEnvironmentVariable(
        'CODEX_APP_SERVER_FORCE_CLI',
        $scope
    )
    if (-not [string]::IsNullOrWhiteSpace($value) -and $value.Trim() -ceq '1') {
        $forceCliScopes.Add($scope.ToString().ToLowerInvariant())
    }
}
$capabilityTokenReady = $false
$launcherScriptReady = $false
$launcherShortcutReady = $false
$launcherConfigured = $false
$legacyPersistentOverrideBlocked = $false
$legacyEnvironmentState = 'none'
try {
    # Status deliberately verifies token-file metadata only. It never reads
    # the token payload or emits a capability-bearing endpoint.
    $capabilityTokenReady = Test-StatusOrdinaryFile `
        -Path $capabilityTokenPath `
        -MinimumBytes 43 `
        -MaximumBytes 512
} catch {
    $capabilityTokenReady = $false
}
try {
    $launcherDefinition = Get-StatusLauncherShortcutDefinition
    $launcherScriptReady = Test-StatusOrdinaryFile `
        -Path ([string]$launcherDefinition.LauncherPath) `
        -MinimumBytes 128 `
        -MaximumBytes 1048576
    $launcherShortcutReady = Test-StatusLauncherShortcut `
        -Definition $launcherDefinition
    $launcherConfigured = $launcherScriptReady -and $launcherShortcutReady
} catch {
    $launcherScriptReady = $false
    $launcherShortcutReady = $false
    $launcherConfigured = $false
}
try {
    $currentPersistentOverride = Get-StatusUserEnvironmentValueState
    $legacyPersistentOverrideBlocked = [bool]$currentPersistentOverride.Exists
} catch {
    # An unreadable user environment is unsafe because fail-open cannot be
    # proved. Report it through the same P0 blocker instead of guessing.
    $legacyPersistentOverrideBlocked = $true
    $legacyEnvironmentState = 'unreadable'
}
try {
    $environmentStatePath = Join-Path $resolvedDataDir 'windows-broker-environment.json'
    if (Test-StatusOrdinaryFile -Path $environmentStatePath -MaximumBytes 65536) {
        $environmentState = Read-StatusJsonText -Path $environmentStatePath |
            ConvertFrom-Json -Depth 20 -ErrorAction Stop
        $stateProperties = @($environmentState.PSObject.Properties.Name | Sort-Object)
        $expectedStateProperties = @(
            'AppliedValueSha256',
            'PreviousUserValue',
            'PreviousUserValueExists',
            'Signature',
            'Version'
        ) | Sort-Object
        $stateReady = (
            $stateProperties.Count -eq $expectedStateProperties.Count -and
            (($stateProperties -join "`0") -ceq
                ($expectedStateProperties -join "`0")) -and
            $environmentState.Signature -ceq 'codex-local-remote/user-environment/v2' -and
            (Test-NonNegativeInteger -Value $environmentState.Version) -and
            [int]$environmentState.Version -eq 2 -and
            [string]$environmentState.AppliedValueSha256 -cmatch '^[a-f0-9]{64}$' -and
            $environmentState.PreviousUserValueExists -is [bool]
        )
        $legacyEnvironmentState = if (-not $stateReady) {
            'invalid'
        } elseif ($legacyPersistentOverrideBlocked) {
            'active-with-managed-state'
        } else {
            'stale-managed-state'
        }
    } elseif ($legacyPersistentOverrideBlocked) {
        $legacyEnvironmentState = 'active-without-managed-state'
    }
} catch {
    $legacyEnvironmentState = 'invalid'
}
$launchMode = if ($legacyPersistentOverrideBlocked) {
    'blocked-persistent-user-override'
} elseif ($launcherConfigured) {
    'process-scoped-fail-open'
} else {
    'native-only'
}

$localUrl = Join-BasePathUrl -Origin "http://127.0.0.1:$Port" -BasePath $BasePath
$bootstrap = $null
$localError = $null
$sidecarRequestReady = $false
try {
    $requestReady = Invoke-RestMethod `
        -Method Get `
        -Uri "${localUrl}api/v1/ready" `
        -TimeoutSec 3
    $sidecarRequestReady = [string]$requestReady.status -ceq 'ready'
} catch {
    $localError = $_.Exception.Message
}
try {
    $bootstrap = Invoke-RestMethod `
        -Method Get `
        -Uri "${localUrl}api/v1/bootstrap" `
        -TimeoutSec 3
} catch {
    $localError = $_.Exception.Message
}

$publicUrl = $null
$routeMatches = $false
try {
    $tailscale = Get-Command tailscale -ErrorAction Stop
    $funnel = (& $tailscale.Source funnel status --json) | ConvertFrom-Json -Depth 20
    $webKey = @($funnel.Web.PSObject.Properties.Name |
        Where-Object { $_ -like "*:$HttpsPort" } |
        Select-Object -First 1)
    if ($webKey.Count -gt 0) {
        $routeProperty = $funnel.Web.$($webKey[0]).Handlers.PSObject.Properties[$BasePath]
        $expectedProxy = "http://127.0.0.1:$Port$BasePath"
        $routeMatches = $null -ne $routeProperty -and
            $routeProperty.Value.Proxy -ceq $expectedProxy
        if ($routeMatches) {
            $publicUrl = Join-BasePathUrl `
                -Origin "https://$($webKey[0].Split(':')[0])" `
                -BasePath $BasePath
        }
    }
} catch {
    # Tailscale is an optional exposure layer; local diagnostics remain useful.
}

if ($env:CODEX_REMOTE_TEST_FIXTURE -cne '1' -or
    $env:CODEX_REMOTE_TEST_RUNTIME_DISCOVERY -ceq '1') {
    try {
        $fullRuntimeDiscovery = $env:CODEX_REMOTE_TEST_RUNTIME_DISCOVERY -ceq '1'
        $desktopRuntime = if ($fullRuntimeDiscovery) {
            Resolve-CodexDesktopRuntime
        } else {
            Resolve-CodexDesktopPackageStatusIdentity
        }
        if ($null -eq $activeDesktopRuntime) {
            $desktopRuntimeStatus = 'blocked'
            $desktopRuntimeError = 'The active Broker has no complete Desktop package and runtime hash receipt.'
        } elseif (
            $fullRuntimeDiscovery -and
            (Test-DesktopRuntimeIdentityCurrent `
                -ActiveRuntime $activeDesktopRuntime `
                -CurrentRuntime $desktopRuntime)
        ) {
            $desktopRuntimeStatus = 'current'
        } elseif (
            -not $fullRuntimeDiscovery -and
            (Test-DesktopPackageStatusIdentityCurrent `
                -ActiveRuntime $activeDesktopRuntime `
                -CurrentPackage $desktopRuntime)
        ) {
            $desktopRuntimeStatus = 'current'
        } else {
            $desktopRuntimeStatus = 'update-pending'
        }
    } catch {
        $desktopRuntimeStatus = 'blocked'
        $desktopRuntimeError = [string]$_.Exception.Message
    }
}
$desktopRuntimeDegraded = $desktopRuntimeStatus -cne 'current'

$status = [pscustomobject]@{
    Ready = (
        $taskReady -and
        $sidecarReady -and
        $sidecarRequestReady -and
        $bootstrap.productName -eq 'Codex Local Remote' -and
        $routeMatches -and
        $brokerReady -and
        $runtimeReceiptReady -and
        $desktopConnected -and
        $sidecarConnected -and
        -not $degraded -and
        $unknownCount -eq 0 -and
        $capabilityTokenReady -and
        $launcherConfigured -and
        -not $legacyPersistentOverrideBlocked -and
        $forceCliScopes.Count -eq 0 -and
        $desktopStdioPids.Count -eq 0 -and
        $desktopRuntimeStatus -ceq 'current'
    )
    TaskState = $taskState
    LastTaskResult = $lastTaskResult
    TaskOwned = $taskOwned
    TaskRunning = $taskRunning
    TaskReady = $taskReady
    TaskRuntimeBinding = $taskRuntimeBinding
    LoopbackListener = $sidecarListenerReady
    SidecarListenerReady = $sidecarListenerReady
    SidecarOwned = $sidecarOwned
    SidecarPid = $sidecarPid
    SidecarLoopbackOnly = $sidecarLoopbackOnly
    SidecarRequestReady = $sidecarRequestReady
    BrokerReady = $brokerReady
    BrokerProxyReady = $brokerProxyReady
    BrokerHealthReady = $brokerHealthReady
    BrokerPid = $brokerPid
    BrokerLoopbackOnly = $brokerLoopbackOnly
    BrokerOwned = $brokerOwned
    BrokerUpstreamReady = $brokerUpstreamReady
    BrokerUpstreamPid = $upstreamPid
    BrokerUpstreamLoopbackOnly = $upstreamLoopbackOnly
    BootstrapIdentityReady = $bootstrapIdentityReady
    BrokerIdentityReady = $brokerIdentityReady
    SidecarIdentityReady = $sidecarIdentityReady
    UpstreamIdentityReady = $upstreamIdentityReady
    StartupInvocationReady = $startupInvocationReady
    RuntimeReceiptReady = $runtimeReceiptReady
    CapabilityTokenReady = $capabilityTokenReady
    LauncherScriptReady = $launcherScriptReady
    LauncherShortcutReady = $launcherShortcutReady
    LauncherConfigured = $launcherConfigured
    LaunchMode = $launchMode
    LegacyPersistentOverrideBlocked = $legacyPersistentOverrideBlocked
    LegacyEnvironmentState = $legacyEnvironmentState
    DesktopConnected = $desktopConnected
    SidecarConnected = $sidecarConnected
    Degraded = ($degraded -or $desktopRuntimeDegraded)
    UnknownCount = $unknownCount
    ForceCliBlocked = ($forceCliScopes.Count -gt 0)
    ForceCliScopes = @($forceCliScopes)
    DesktopIndependentStdioAppServer = ($desktopStdioPids.Count -gt 0)
    DesktopIndependentStdioAppServerPids = @($desktopStdioPids)
    Product = $bootstrap.productName
    Configured = $bootstrap.configured
    Authenticated = $bootstrap.authenticated
    LocalUrl = $localUrl
    PublicRoute = if ($routeMatches) { 'configured' } else { 'not-configured' }
    PublicUrl = $publicUrl
    LocalError = $localError
    DesktopRuntimeStatus = $desktopRuntimeStatus
    DesktopRuntimeError = $desktopRuntimeError
    DesktopRuntimeSource = if ($null -eq $desktopRuntime) {
        $null
    } else {
        [string]$desktopRuntime.Source
    }
    DesktopRuntimePackage = if ($null -eq $desktopRuntime) {
        $null
    } else {
        [string]$desktopRuntime.PackageFullName
    }
    DesktopRuntimeCodexSha256 = if ($null -eq $desktopRuntime) {
        $null
    } else {
        [string]$desktopRuntime.CodexSha256
    }
}

if ($Json) {
    $status | ConvertTo-Json -Compress -Depth 20
} else {
    $status
}
