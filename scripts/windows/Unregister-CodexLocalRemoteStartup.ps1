[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$InstallRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,

    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexLocalRemote'),

    [ValidateRange(1, 65535)]
    [int]$Port = 18790,

    [string]$BasePath = '/codex-remote',

    [string]$TaskName = 'Codex Local Remote',

    [string]$NodePath,

    [string]$CodexPath,

    [string]$PwshPath,

    [ValidateRange(1, 65535)]
    [int]$BrokerPort = 18791,

    [ValidateRange(1, 65535)]
    [int]$BrokerUpstreamPort = 18792,

    [Parameter(DontShow)]
    [switch]$SkipEnvironmentConfiguration,

    [Parameter(DontShow)]
    [switch]$SkipRuntimeStop,

    [Parameter(DontShow)]
    [string]$LauncherShortcutPath
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'CodexLocalRemote.Windows.psm1') -Force
$managedConfiguration = Get-CodexLocalRemoteManagedConfiguration -DataDir $DataDir
if ($null -ne $managedConfiguration) {
    if (-not $PSBoundParameters.ContainsKey('Port')) {
        $Port = [int]$managedConfiguration.SidecarPort
    }
    if (-not $PSBoundParameters.ContainsKey('BrokerPort')) {
        $BrokerPort = [int]$managedConfiguration.BrokerPort
    }
    if (-not $PSBoundParameters.ContainsKey('BrokerUpstreamPort')) {
        $BrokerUpstreamPort = [int]$managedConfiguration.BrokerUpstreamPort
    }
    if (-not $PSBoundParameters.ContainsKey('BasePath')) {
        $BasePath = [string]$managedConfiguration.BasePath
    }
    if (-not $PSBoundParameters.ContainsKey('TaskName')) {
        $TaskName = [string]$managedConfiguration.TaskName
    }
}
Assert-CanonicalBasePath -BasePath $BasePath

if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $NodePath = (Get-Command node -CommandType Application -ErrorAction Stop).Source
}
if ([string]::IsNullOrWhiteSpace($PwshPath)) {
    $PwshPath = (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop |
        Select-Object -First 1).Source
}
if ($SkipEnvironmentConfiguration -and $env:CODEX_REMOTE_TEST_FIXTURE -cne '1') {
    throw 'SkipEnvironmentConfiguration is reserved for the isolated test fixture.'
}
if ($SkipRuntimeStop -and $env:CODEX_REMOTE_TEST_FIXTURE -cne '1') {
    throw 'SkipRuntimeStop is reserved for the isolated test fixture.'
}
if (-not [string]::IsNullOrWhiteSpace($LauncherShortcutPath) -and
    $env:CODEX_REMOTE_TEST_FIXTURE -cne '1') {
    throw 'LauncherShortcutPath is reserved for the isolated test fixture.'
}
$sourceInstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$effectiveInstallRoot = $sourceInstallRoot
$currentRuntime = $null
if (-not $SkipEnvironmentConfiguration) {
    $currentRuntime = Get-CodexLocalRemoteCurrentRuntime -DataDir $DataDir
    if ($null -ne $currentRuntime) {
        $effectiveInstallRoot = [string]$currentRuntime.CurrentRoot
    }
}
$expected = Get-StartupTaskDefinition `
    -TaskName $TaskName `
    -NodePath $NodePath `
    -PwshPath $PwshPath `
    -InstallRoot $effectiveInstallRoot `
    -DataDir $DataDir `
    -Port $Port `
    -BrokerPort $BrokerPort `
    -BrokerUpstreamPort $BrokerUpstreamPort `
    -BasePath $BasePath
$legacyExpected = Get-LegacyStartupTaskDefinition `
    -TaskName $TaskName `
    -NodePath $NodePath `
    -InstallRoot $sourceInstallRoot `
    -DataDir $DataDir `
    -Port $Port `
    -BasePath $BasePath
$sidecarStopScript = Join-Path $effectiveInstallRoot 'scripts\windows\Stop-CodexLocalRemoteSidecar.ps1'
$brokerStopScript = Join-Path $effectiveInstallRoot 'scripts\windows\Stop-CodexAppServerBroker.ps1'

function Get-PreTakeoverStartupTaskDefinition {
    param([Parameter(Mandatory)][object]$Definition)

    $properties = [ordered]@{}
    foreach ($property in $Definition.PSObject.Properties) {
        $properties[[string]$property.Name] = $property.Value
    }
    $properties.Arguments = ([string]$Definition.Arguments).Replace(
        ' -TakeOverExistingNativeDesktop',
        ''
    )
    if ($null -ne $Definition.PSObject.Properties['TaskArguments']) {
        $properties.TaskArguments = (
            [string]$Definition.TaskArguments
        ).Replace(
            ' -TakeOverExistingNativeDesktop',
            ''
        )
    }
    return [pscustomobject]$properties
}

function Test-ExistingTaskOwnership {
    param([AllowNull()][object]$Task)

    if ($null -eq $Task) {
        return [pscustomobject]@{ IsManaged = $true; Kind = 'none'; Mismatches = @() }
    }
    $current = Test-ManagedStartupTask -Task $Task -Expected $expected
    if ($current.IsManaged) {
        return [pscustomobject]@{ IsManaged = $true; Kind = 'current'; Mismatches = @() }
    }
    $legacyAutoStartExpected =
        Get-LegacyAutoStartStartupTaskDefinitionV5 -Definition $expected
    $legacyAutoStartV5 = Test-ManagedStartupTask `
        -Task $Task `
        -Expected $legacyAutoStartExpected
    if ($legacyAutoStartV5.IsManaged) {
        return [pscustomobject]@{
            IsManaged = $true
            Kind = 'legacy-auto-start-v5'
            Mismatches = @()
        }
    }
    $legacyHeadlessExpected =
        Get-LegacyHeadlessStartupTaskDefinitionV4 `
            -Definition $expected
    $legacyHeadlessV4 = Test-ManagedStartupTask `
        -Task $Task `
        -Expected $legacyHeadlessExpected
    if ($legacyHeadlessV4.IsManaged) {
        return [pscustomobject]@{
            IsManaged = $true
            Kind = 'legacy-headless-v4'
            Mismatches = @()
        }
    }
    $legacyDesktopOwnerExpected =
        Get-LegacyDesktopOwningStartupTaskDefinitionV3 `
            -Definition $expected
    $legacyDesktopOwnerV3 = Test-ManagedStartupTask `
        -Task $Task `
        -Expected $legacyDesktopOwnerExpected
    if ($legacyDesktopOwnerV3.IsManaged) {
        return [pscustomobject]@{
            IsManaged = $true
            Kind = 'legacy-desktop-owner-v3'
            Mismatches = @()
        }
    }
    $preTakeover = Test-ManagedStartupTask `
        -Task $Task `
        -Expected (
            Get-PreTakeoverStartupTaskDefinition `
                -Definition $legacyDesktopOwnerExpected
        )
    if ($preTakeover.IsManaged) {
        return [pscustomobject]@{
            IsManaged = $true
            Kind = 'current'
            Mismatches = @()
        }
    }
    $preHeadlessExpected =
        Get-PreHeadlessConsoleStartupTaskDefinition `
            -Definition $legacyDesktopOwnerExpected
    $preHeadless = Test-ManagedStartupTask -Task $Task -Expected $preHeadlessExpected
    if ($preHeadless.IsManaged) {
        return [pscustomobject]@{
            IsManaged = $true
            Kind = 'current'
            Mismatches = @()
        }
    }
    $actions = @($Task.Actions)
    if ($actions.Count -eq 1) {
        try {
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
                    -CodexPath ([string]$arguments[$codexSwitchIndexes[0] + 1]) `
                    -PwshPath $PwshPath `
                    -InstallRoot $sourceInstallRoot `
                    -DataDir $DataDir `
                    -Port $Port `
                    -BrokerPort $BrokerPort `
                    -BrokerUpstreamPort $BrokerUpstreamPort `
                    -BasePath $BasePath
                $pinned = Test-ManagedStartupTask `
                    -Task $Task `
                    -Expected $pinnedExpected
                if ($pinned.IsManaged) {
                    return [pscustomobject]@{
                        IsManaged = $true
                        Kind = 'pinned-v2'
                        Mismatches = @()
                    }
                }
            }
        } catch {
            # Continue to exact legacy/foreign classification.
        }
    }
    $legacy = Test-ManagedStartupTask -Task $Task -Expected $legacyExpected
    if ($legacy.IsManaged) {
        return [pscustomobject]@{ IsManaged = $true; Kind = 'legacy-v1'; Mismatches = @() }
    }
    return [pscustomobject]@{
        IsManaged = $false
        Kind = 'foreign'
        Mismatches = @($current.Mismatches)
    }
}

function Read-ExactLegacyEnvironmentState {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [long]$item.Length -lt 2 -or
        [long]$item.Length -gt 65536) {
        throw "Legacy environment state '$Path' is not an ordinary bounded file."
    }
    $state = Get-Content -LiteralPath $Path -Raw -Encoding utf8 |
        ConvertFrom-Json -Depth 20 -ErrorAction Stop
    $actualProperties = @($state.PSObject.Properties.Name | Sort-Object)
    $expectedProperties = @(
        'AppliedValueSha256',
        'PreviousUserValue',
        'PreviousUserValueExists',
        'Signature',
        'Version'
    ) | Sort-Object
    $exactSchema = (
        $actualProperties.Count -eq $expectedProperties.Count -and
        (($actualProperties -join "`0") -ceq ($expectedProperties -join "`0")) -and
        [string]$state.Signature -ceq 'codex-local-remote/user-environment/v2' -and
        [int]$state.Version -eq 2 -and
        [string]$state.AppliedValueSha256 -cmatch '^[a-f0-9]{64}$' -and
        $state.PreviousUserValueExists -is [bool] -and
        (
            ([bool]$state.PreviousUserValueExists -and
                $state.PreviousUserValue -is [string]) -or
            (-not [bool]$state.PreviousUserValueExists -and
                $null -eq $state.PreviousUserValue)
        )
    )
    if (-not $exactSchema) {
        throw "Legacy environment state '$Path' is not the exact managed V2 schema."
    }
    return $state
}

function Get-LegacyPersistentOverridePlan {
    param(
        [Parameter(Mandatory)][string]$ManagedDataDir,
        [Parameter(Mandatory)][int]$ManagedBrokerPort
    )

    $statePath = Join-Path $ManagedDataDir 'windows-broker-environment.json'
    $state = Read-ExactLegacyEnvironmentState -Path $statePath
    $current = Get-UserEnvironmentValueState -Name 'CODEX_APP_SERVER_WS_URL'
    if ($null -eq $state) {
        if ($current.Exists) {
            throw 'P0 blocked: persistent user CODEX_APP_SERVER_WS_URL exists without an exact managed recovery state. Refusing an inexact uninstall.'
        }
        return [pscustomobject]@{
            Action = 'none'
            Status = 'not-found'
            StatePath = $statePath
            WebSocketUrl = $null
        }
    }
    if (-not $current.Exists) {
        return [pscustomobject]@{
            Action = 'remove-stale-state'
            Status = 'stale-managed-state'
            StatePath = $statePath
            WebSocketUrl = $null
        }
    }

    $tokenPath = Get-BrokerCapabilityTokenPath -DataDir $ManagedDataDir
    if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
        throw 'P0 blocked: persistent user CODEX_APP_SERVER_WS_URL and managed recovery state exist, but the capability token needed to prove ownership is missing.'
    }
    $brokerEndpoint = Get-BrokerCapabilityWebSocketUrl `
        -Port $ManagedBrokerPort `
        -TokenPath $tokenPath
    if ([string]$state.AppliedValueSha256 -cne
        (Get-StringSha256 -Value $brokerEndpoint) -or
        [string]$current.Value -cne $brokerEndpoint) {
        throw 'P0 blocked: persistent user CODEX_APP_SERVER_WS_URL is not the exact legacy value proved by the managed token and recovery state.'
    }
    return [pscustomobject]@{
        Action = 'restore-managed'
        Status = 'managed-active'
        StatePath = $statePath
        WebSocketUrl = $brokerEndpoint
    }
}

function Remove-LegacyPersistentOverride {
    param(
        [Parameter(Mandatory)][object]$Plan,
        [Parameter(Mandatory)][string]$ManagedDataDir
    )

    $result = switch ([string]$Plan.Action) {
        'restore-managed' {
            Restore-BrokerUserEnvironment `
                -DataDir $ManagedDataDir `
                -WebSocketUrl ([string]$Plan.WebSocketUrl)
        }
        'remove-stale-state' {
            Remove-Item -LiteralPath ([string]$Plan.StatePath) -Force
            [pscustomobject]@{ Status = 'stale-state-removed' }
        }
        default {
            [pscustomobject]@{ Status = 'not-found' }
        }
    }
    $remaining = Get-UserEnvironmentValueState -Name 'CODEX_APP_SERVER_WS_URL'
    if ($remaining.Exists) {
        throw 'P0 blocked: a persistent user CODEX_APP_SERVER_WS_URL remains after exact legacy cleanup.'
    }
    return $result
}

function Get-ManagedLauncherShortcutDefinition {
    param(
        [string]$RuntimeRoot = ([string]$expected.WorkingDirectory)
    )

    $resolvedRuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
    $isLegacyRuntimeLauncher =
        $PSBoundParameters.ContainsKey('RuntimeRoot')
    $launcher = if ($isLegacyRuntimeLauncher) {
        [System.IO.Path]::GetFullPath(
            (Join-Path `
                $resolvedRuntimeRoot `
                'scripts\windows\Launch-CodexWithRemote.ps1')
        )
    } else {
        [System.IO.Path]::GetFullPath(
            (Get-CodexLocalRemoteControlDispatcherPath `
                -DataDir ([string]$expected.DataDir))
        )
    }
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
    $iconPath = Get-CodexLocalRemoteManagedDesktopIconPath `
        -DataDir ([string]$expected.DataDir)
    $argumentValues = if ($isLegacyRuntimeLauncher) {
        @(
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
            $expected.DataDir,
            '-BrokerPort',
            [string]$BrokerPort,
            '-TaskName',
            $TaskName,
            '-RequestDesktopLaunch'
        )
    } else {
        @(
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-WindowStyle',
            'Hidden',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            $launcher,
            '-Operation',
            'Open',
            '-DataDir',
            $expected.DataDir,
            '-AllowDesktopRestart',
            '-InteractiveShortcutFeedback'
        )
    }
    return [pscustomobject]@{
        LauncherPath = $launcher
        ShortcutPath = [System.IO.Path]::GetFullPath($shortcut)
        TargetPath = [System.IO.Path]::GetFullPath($expected.Execute)
        Arguments = (
            $argumentValues |
                ForEach-Object {
                    ConvertTo-WindowsCommandLineArgument -Value ([string]$_)
                }
        ) -join ' '
        WorkingDirectory = if ($isLegacyRuntimeLauncher) {
            $resolvedRuntimeRoot
        } else {
            [System.IO.Path]::GetFullPath([string]$expected.DataDir)
        }
        Description = if ($isLegacyRuntimeLauncher) {
            'Codex Remote - Uses Remote when ready and otherwise starts Codex Desktop natively.'
        } else {
            'Codex Remote - Explicitly opens Remote through the stable control dispatcher.'
        }
        IconLocation = "$iconPath,0"
        WindowStyle = 1
        RunAsUser = $true
    }
}

function Get-ManagedLauncherShortcutLinkFlags {
    param([Parameter(Mandatory)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $attributes = [System.IO.File]::GetAttributes($fullPath)
    if (($attributes -band [System.IO.FileAttributes]::Directory) -ne 0 -or
        ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The managed launcher shell link is not an ordinary file.'
    }
    $stream = [System.IO.File]::Open(
        $fullPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    try {
        if ($stream.Length -lt 76 -or $stream.Length -gt 1048576) {
            throw 'The managed launcher shell link has an invalid bounded length.'
        }
        $header = [byte[]]::new(24)
        if ($stream.Read($header, 0, $header.Length) -ne $header.Length -or
            [BitConverter]::ToUInt32($header, 0) -ne 76) {
            throw 'The managed launcher shell link header is invalid.'
        }
        $expectedClsid = [Guid]'00021401-0000-0000-C000-000000000046'
        $clsidBytes = $expectedClsid.ToByteArray()
        foreach ($index in 0..15) {
            if ($header[$index + 4] -ne $clsidBytes[$index]) {
                throw 'The managed launcher shell link CLSID is invalid.'
            }
        }
        return [uint32][BitConverter]::ToUInt32($header, 20)
    } finally {
        $stream.Dispose()
    }
}

function Test-ManagedLauncherShortcut {
    param([Parameter(Mandatory)][object]$Definition)

    if (-not (Test-Path -LiteralPath $Definition.ShortcutPath -PathType Leaf)) {
        return $false
    }
    $shell = $null
    $shortcut = $null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut([string]$Definition.ShortcutPath)
        return (
            [string]::Equals(
                [System.IO.Path]::GetFullPath([string]$shortcut.TargetPath),
                [string]$Definition.TargetPath,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -and
            [string]$shortcut.Arguments -ceq [string]$Definition.Arguments -and
            [string]::Equals(
                [System.IO.Path]::GetFullPath([string]$shortcut.WorkingDirectory),
                [string]$Definition.WorkingDirectory,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -and
            [string]$shortcut.Description -ceq [string]$Definition.Description -and
            [int]$shortcut.WindowStyle -eq [int]$Definition.WindowStyle -and
            (
                (
                    (Get-ManagedLauncherShortcutLinkFlags `
                        -Path $Definition.ShortcutPath) -band 0x00002000
                ) -ne 0
            ) -eq [bool]$Definition.RunAsUser -and
            [string]::Equals(
                [string]$shortcut.IconLocation,
                [string]$Definition.IconLocation,
                [System.StringComparison]::OrdinalIgnoreCase
            )
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

function Get-LegacyLocalizedManagedLauncherShortcutDefinition {
    param([Parameter(Mandatory)][object]$Definition)

    $canonicalPrefix = 'Codex Remote'
    $description = [string]$Definition.Description
    if (-not $description.StartsWith(
            "$canonicalPrefix - ",
            [System.StringComparison]::Ordinal
        )) {
        return $null
    }

    $historicalPrefix = 'Codex Remote (' +
        (([char[]]@(0x5B89, 0x5168, 0x542F, 0x52A8)) -join '') +
        ')'
    $properties = [ordered]@{}
    foreach ($property in $Definition.PSObject.Properties) {
        $properties[[string]$property.Name] = $property.Value
    }
    $properties.Description = $historicalPrefix +
        $description.Substring($canonicalPrefix.Length)
    return [pscustomobject]$properties
}

function Test-NonElevatedManagedLauncherShortcut {
    param([Parameter(Mandatory)][object]$Definition)

    $properties = [ordered]@{}
    foreach ($property in $Definition.PSObject.Properties) {
        $properties[[string]$property.Name] = $property.Value
    }
    $properties.RunAsUser = $false
    return Test-ManagedLauncherShortcut `
        -Definition ([pscustomobject]$properties)
}

function Test-MinimizedManagedLauncherShortcut {
    param([Parameter(Mandatory)][object]$Definition)

    foreach ($runAsUser in @([bool]$Definition.RunAsUser, $false)) {
        $properties = [ordered]@{}
        foreach ($property in $Definition.PSObject.Properties) {
            $properties[[string]$property.Name] = $property.Value
        }
        $properties.WindowStyle = 7
        $properties.RunAsUser = $runAsUser
        if (Test-ManagedLauncherShortcut `
            -Definition ([pscustomobject]$properties)) {
            return $true
        }
    }
    return $false
}

function Test-PreTakeoverManagedLauncherShortcut {
    param([Parameter(Mandatory)][object]$Definition)

    $currentArguments = [string]$Definition.Arguments
    $legacyArguments = @(
        $currentArguments.Replace(
            ' -RequestDesktopLaunch',
            ' -TakeOverExistingNativeDesktop'
        )
        $currentArguments.Replace(
            ' -RequestDesktopLaunch',
            ''
        )
    ) | Select-Object -Unique
    if ($legacyArguments.Count -eq 1 -and
        [string]$legacyArguments[0] -ceq $currentArguments) {
        return $false
    }
    foreach ($arguments in $legacyArguments) {
        foreach ($windowStyle in @([int]$Definition.WindowStyle, 7)) {
            foreach ($runAsUser in @([bool]$Definition.RunAsUser, $false)) {
                if (Test-ManagedLauncherShortcut -Definition ([pscustomobject]@{
                    ShortcutPath = [string]$Definition.ShortcutPath
                    TargetPath = [string]$Definition.TargetPath
                    Arguments = [string]$arguments
                    WorkingDirectory = [string]$Definition.WorkingDirectory
                    Description = [string]$Definition.Description
                    IconLocation = [string]$Definition.IconLocation
                    WindowStyle = $windowStyle
                    RunAsUser = $runAsUser
                })) {
                    return $true
                }
            }
        }
    }
    return $false
}

function Test-VisibleManagedLauncherShortcut {
    param([Parameter(Mandatory)][object]$Definition)

    $arguments = [string]$Definition.Arguments
    $visibleArguments = $arguments.Replace(' -WindowStyle Hidden ', ' ')
    if ($visibleArguments -ceq $arguments) {
        return $false
    }
    foreach ($windowStyle in @([int]$Definition.WindowStyle, 7)) {
        foreach ($runAsUser in @([bool]$Definition.RunAsUser, $false)) {
            $properties = [ordered]@{}
            foreach ($property in $Definition.PSObject.Properties) {
                $properties[[string]$property.Name] = $property.Value
            }
            $properties.Arguments = $visibleArguments
            $properties.WindowStyle = $windowStyle
            $properties.RunAsUser = $runAsUser
            if (Test-ManagedLauncherShortcut `
                -Definition ([pscustomobject]$properties)) {
                return $true
            }
        }
    }
    return $false
}

function Test-VisiblePreTakeoverManagedLauncherShortcut {
    param([Parameter(Mandatory)][object]$Definition)

    $currentArguments = [string]$Definition.Arguments
    $visibleArguments = $currentArguments.Replace(
        ' -WindowStyle Hidden ',
        ' '
    )
    if ($visibleArguments -ceq $currentArguments) {
        return $false
    }
    $legacyArguments = @(
        $visibleArguments.Replace(
            ' -RequestDesktopLaunch',
            ' -TakeOverExistingNativeDesktop'
        )
        $visibleArguments.Replace(' -RequestDesktopLaunch', '')
    ) | Select-Object -Unique
    foreach ($arguments in $legacyArguments) {
        foreach ($windowStyle in @([int]$Definition.WindowStyle, 7)) {
            foreach ($runAsUser in @([bool]$Definition.RunAsUser, $false)) {
                $properties = [ordered]@{}
                foreach ($property in $Definition.PSObject.Properties) {
                    $properties[[string]$property.Name] = $property.Value
                }
                $properties.Arguments = [string]$arguments
                $properties.WindowStyle = $windowStyle
                $properties.RunAsUser = $runAsUser
                if (Test-ManagedLauncherShortcut `
                    -Definition ([pscustomobject]$properties)) {
                    return $true
                }
            }
        }
    }
    return $false
}

function Test-RecognizedManagedLauncherShortcut {
    param(
        [Parameter(Mandatory)]
        [object[]]$Definitions
    )

    foreach ($definition in $Definitions) {
        $recognizedDefinitions = @($definition)
        $historicalLocalized =
            Get-LegacyLocalizedManagedLauncherShortcutDefinition `
                -Definition $definition
        if ($null -ne $historicalLocalized) {
            $recognizedDefinitions += $historicalLocalized
        }
        foreach ($recognizedDefinition in $recognizedDefinitions) {
            if ((Test-ManagedLauncherShortcut `
                    -Definition $recognizedDefinition) -or
            (Test-NonElevatedManagedLauncherShortcut `
                -Definition $recognizedDefinition) -or
            (Test-MinimizedManagedLauncherShortcut `
                -Definition $recognizedDefinition) -or
            (Test-VisibleManagedLauncherShortcut `
                -Definition $recognizedDefinition) -or
            (Test-PreTakeoverManagedLauncherShortcut `
                -Definition $recognizedDefinition) -or
            (Test-VisiblePreTakeoverManagedLauncherShortcut `
                -Definition $recognizedDefinition)) {
                return $true
            }
        }
    }
    return $false
}

function Get-UninstallRuntimePreflight {
    if ($SkipEnvironmentConfiguration -or $SkipRuntimeStop) {
        return [pscustomobject]@{
            Status = 'fixture-skipped'
            BrokerProcessId = $null
            SidecarConnected = $false
        }
    }

    $listeners = if ($env:CODEX_REMOTE_TEST_FIXTURE -ceq '1') {
        @(
            Get-NetTCPConnection `
                -State Listen `
                -LocalPort $BrokerPort `
                -ErrorAction SilentlyContinue
        )
    } else {
        @(
            Get-CodexLocalRemoteTcpListenerSnapshot `
                -LocalPorts @($BrokerPort)
        )
    }
    if ($listeners.Count -eq 0) {
        return [pscustomobject]@{
            Status = 'not-running'
            BrokerProcessId = $null
            SidecarConnected = $false
        }
    }
    if (@(
        $listeners |
            Where-Object {
                -not (Test-IsLoopbackListenerAddress -Address $_.LocalAddress)
            }
    ).Count -gt 0) {
        throw "Broker port $BrokerPort has a non-loopback listener; refusing uninstall before any mutation."
    }
    $managedListeners = @(Get-ManagedIpv4Listeners -Listeners $listeners)
    $listenerPids = @(
        $managedListeners |
            Select-Object -ExpandProperty OwningProcess -Unique
    )
    if ($managedListeners.Count -eq 0 -or $listenerPids.Count -ne 1) {
        throw "Broker port $BrokerPort has ambiguous listener ownership; refusing uninstall before any mutation."
    }

    $statePath = Join-Path $expected.DataDir 'app-server-broker.json'
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        throw "Broker port $BrokerPort is live without its exact managed state; refusing uninstall before any mutation."
    }
    $state = Get-Content -LiteralPath $statePath -Raw |
        ConvertFrom-Json -Depth 20
    $brokerCli = [System.IO.Path]::GetFullPath(
        (Join-Path ([System.IO.Path]::GetFullPath($expected.WorkingDirectory)) 'apps\broker\dist\cli.js')
    )
    $processId = [int]$listenerPids[0]
    $process = Get-CimInstance `
        Win32_Process `
        -Filter "ProcessId = $processId" `
        -ErrorAction SilentlyContinue
    if ($null -eq $process -or
        [int]$state.ProcessId -ne $processId -or
        [string]$state.NodePath -cne [System.IO.Path]::GetFullPath($expected.Node) -or
        [string]$state.BrokerCliPath -cne $brokerCli) {
        throw "Broker listener and managed startup state disagree; refusing uninstall before any mutation."
    }
    $ownership = Test-ManagedBrokerProcess `
        -CommandLine ([string]$process.CommandLine) `
        -ExecutablePath ([string]$process.ExecutablePath) `
        -ExpectedNodePath $expected.Node `
        -ExpectedBrokerCliPath $brokerCli `
        -BrokerPort $BrokerPort `
        -UpstreamPort $BrokerUpstreamPort `
        -ExpectedCodexPath ([string]$state.CodexPath) `
        -DataDir $expected.DataDir `
        -CapabilityTokenFilePath (Get-BrokerCapabilityTokenPath -DataDir $expected.DataDir)
    if (-not $ownership.IsManaged) {
        throw "Broker process is not the exact managed runtime ($($ownership.Reason)); refusing uninstall before any mutation."
    }

    $readiness = try {
        Invoke-RestMethod `
            -Method Get `
            -Uri "http://127.0.0.1:$BrokerPort/ready" `
            -TimeoutSec 2
    } catch {
        $null
    }
    if ($null -eq $readiness -or
        $null -eq $readiness.PSObject.Properties['brokerProcessId'] -or
        $null -eq $readiness.PSObject.Properties['desktopConnected'] -or
        $null -eq $readiness.PSObject.Properties['sidecarConnected'] -or
        $null -eq $readiness.PSObject.Properties['unsafeThreadCount'] -or
        -not (Test-NonNegativeInteger -Value $readiness.brokerProcessId) -or
        [int]$readiness.brokerProcessId -ne $processId -or
        $readiness.desktopConnected -isnot [bool] -or
        $readiness.sidecarConnected -isnot [bool] -or
        -not (Test-NonNegativeInteger -Value $readiness.unsafeThreadCount)) {
        throw 'Unable to prove managed Broker quiescence; refusing uninstall before any mutation.'
    }
    if ([bool]$readiness.desktopConnected) {
        throw 'Codex Desktop is connected to the shared Broker. Close Desktop before uninstall; no task or process was changed.'
    }
    if ([int]$readiness.unsafeThreadCount -gt 0) {
        throw 'At least one turn lifecycle is active, pending, or unknown. Uninstall was refused before any task or process change.'
    }
    return [pscustomobject]@{
        Status = 'quiescent'
        BrokerProcessId = $processId
        SidecarConnected = [bool]$readiness.sidecarConnected
    }
}

$launcherDefinition = Get-ManagedLauncherShortcutDefinition
$launcherDefinitions =
    [System.Collections.Generic.List[object]]::new()
$launcherDefinitions.Add($launcherDefinition)
$launcherRuntimeRoots = [System.Collections.Generic.List[string]]::new()
$launcherRuntimeRoots.Add($sourceInstallRoot)
if ($null -ne $currentRuntime) {
    $launcherRuntimeRoots.Add([string]$currentRuntime.CurrentRoot)
    if (-not [string]::IsNullOrWhiteSpace(
        [string]$currentRuntime.PreviousRoot
    )) {
        $launcherRuntimeRoots.Add([string]$currentRuntime.PreviousRoot)
    }
}
foreach ($runtimeRoot in $launcherRuntimeRoots) {
    if ([string]::IsNullOrWhiteSpace([string]$runtimeRoot)) {
        continue
    }
    $candidateDefinition =
        Get-ManagedLauncherShortcutDefinition `
            -RuntimeRoot ([string]$runtimeRoot)
    if (-not @(
        $launcherDefinitions |
            Where-Object {
                [string]::Equals(
                    [string]$_.WorkingDirectory,
                    [string]$candidateDefinition.WorkingDirectory,
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            }
    )) {
        $launcherDefinitions.Add($candidateDefinition)
    }
}
$existing = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
$ownership = Test-ExistingTaskOwnership -Task $existing
if (-not $ownership.IsManaged) {
    throw "Scheduled task '$TaskName' is not the exact managed task ($($ownership.Mismatches -join ', ')); refusing to stop or remove it."
}

$tokenPath = Get-BrokerCapabilityTokenPath -DataDir $expected.DataDir
$legacyOverridePlan = if ($SkipEnvironmentConfiguration) {
    [pscustomobject]@{ Action = 'skip'; Status = 'fixture-skipped' }
} else {
    Get-LegacyPersistentOverridePlan `
        -ManagedDataDir $expected.DataDir `
        -ManagedBrokerPort $BrokerPort
}
$launcherPreflight = if ($SkipEnvironmentConfiguration) {
    [pscustomobject]@{ Status = 'fixture-skipped' }
} elseif (-not (Test-Path -LiteralPath $launcherDefinition.ShortcutPath)) {
    [pscustomobject]@{ Status = 'not-found' }
} elseif (Test-RecognizedManagedLauncherShortcut `
    -Definitions @($launcherDefinitions)) {
    [pscustomobject]@{ Status = 'removable' }
} else {
    throw "Launcher shortcut '$($launcherDefinition.ShortcutPath)' is not the exact managed Codex Remote entry; refusing to remove it."
}
$launcherIconPath = Get-CodexLocalRemoteManagedDesktopIconPath `
    -DataDir $expected.DataDir
$launcherIconPreflight = if ($SkipEnvironmentConfiguration) {
    [pscustomobject]@{ Status = 'fixture-skipped' }
} elseif (-not (Test-Path -LiteralPath $launcherIconPath)) {
    [pscustomobject]@{ Status = 'not-found' }
} elseif (Test-CodexLocalRemoteManagedDesktopIcon -Path $launcherIconPath) {
    [pscustomobject]@{ Status = 'removable' }
} else {
    throw "Managed ChatGPT icon '$launcherIconPath' is not an exact ordinary ICO file; refusing to remove it."
}
$controlDispatcherPreflight = if ($SkipEnvironmentConfiguration) {
    [pscustomobject]@{ Status = 'fixture-skipped' }
} else {
    Get-CodexLocalRemoteControlDispatcherState `
        -DataDir $expected.DataDir
}
$desiredModePreflight = if ($SkipEnvironmentConfiguration) {
    [pscustomobject]@{ Status = 'fixture-skipped' }
} else {
    Get-CodexLocalRemoteDesiredMode `
        -DataDir $expected.DataDir
}
$runtimeStopPreflight = Get-UninstallRuntimePreflight

function Get-UnregistrationOrdinaryFilePreImage {
    param([Parameter(Mandatory)][string]$Path)

    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolvedPath)) {
        return $null
    }
    $item = Get-Item -LiteralPath $resolvedPath -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        ($item.Attributes -band
            [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [long]$item.Length -gt 1048576) {
        throw 'An unregistration pre-image is not one ordinary bounded file.'
    }
    return [pscustomobject]@{
        Path = $resolvedPath
        Bytes = [System.IO.File]::ReadAllBytes($resolvedPath)
        Sha256 = (
            Get-FileHash `
                -LiteralPath $resolvedPath `
                -Algorithm SHA256 `
                -ErrorAction Stop
        ).Hash.ToLowerInvariant()
    }
}

function Restore-UnregistrationOrdinaryFilePreImages {
    param([Parameter(Mandatory)][object[]]$PreImages)

    $failures = [System.Collections.Generic.List[string]]::new()
    foreach ($preImage in @($PreImages)) {
        if ($null -eq $preImage) {
            continue
        }
        $path = [string]$preImage.Path
        try {
            if (Test-Path -LiteralPath $path) {
                throw 'A removed file path was claimed before rollback.'
            }
            $directory = Split-Path -Parent $path
            $null = [System.IO.Directory]::CreateDirectory($directory)
            $stream = [System.IO.File]::Open(
                $path,
                [System.IO.FileMode]::CreateNew,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::None
            )
            try {
                $bytes = [byte[]]$preImage.Bytes
                $stream.Write($bytes, 0, $bytes.Length)
                $stream.Flush($true)
            } finally {
                $stream.Dispose()
            }
            $restoredSha256 = (
                Get-FileHash `
                    -LiteralPath $path `
                    -Algorithm SHA256 `
                    -ErrorAction Stop
            ).Hash.ToLowerInvariant()
            if ($restoredSha256 -cne [string]$preImage.Sha256) {
                throw 'An unregistration pre-image did not verify.'
            }
        } catch {
            $failures.Add((Split-Path -Leaf $path))
        }
    }
    return @($failures)
}

if ($PSCmdlet.ShouldProcess($TaskName, 'Stop and remove the startup task')) {
    # Re-check immediately before the first mutation so a same-name replacement
    # cannot be stopped or deleted based on stale ownership evidence.
    $current = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
    $currentOwnership = Test-ExistingTaskOwnership -Task $current
    if (-not $currentOwnership.IsManaged) {
        throw "Scheduled task '$TaskName' changed before removal and is not the exact managed task; refusing to stop or remove it."
    }
    $expectedTaskKind = [string]$currentOwnership.Kind
    $runtimeStopPreflight = Get-UninstallRuntimePreflight

    if ($null -ne $current) {
        Stop-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
        $stoppedTask = Get-ScheduledTask `
            -TaskName $TaskName `
            -TaskPath '\' `
            -ErrorAction SilentlyContinue
        $stoppedOwnership = Test-ExistingTaskOwnership -Task $stoppedTask
        if ($null -eq $stoppedTask -or
            -not $stoppedOwnership.IsManaged -or
            [string]$stoppedOwnership.Kind -cne $expectedTaskKind -or
            [string]$stoppedTask.State -ceq 'Running') {
            throw "Scheduled task '$TaskName' did not stop while retaining its exact managed identity; refusing removal."
        }
    }

    if (-not $SkipEnvironmentConfiguration -and -not $SkipRuntimeStop) {
        & $sidecarStopScript `
            -NodePath $expected.Node `
            -ExpectedSidecarCliPath $expected.Cli `
            -DataDir $expected.DataDir `
            -Port $Port `
            -BasePath $BasePath `
            -Confirm:$false | Out-Null
        & $brokerStopScript `
            -NodePath $expected.Node `
            -InstallRoot $expected.WorkingDirectory `
            -DataDir $expected.DataDir `
            -BrokerPort $BrokerPort `
            -BrokerUpstreamPort $BrokerUpstreamPort `
            -Confirm:$false | Out-Null
    }

    $taskReadyForRemoval = $false
    if ($null -ne $current) {
        $finalTask = Get-ScheduledTask `
            -TaskName $TaskName `
            -TaskPath '\' `
            -ErrorAction SilentlyContinue
        $finalOwnership = Test-ExistingTaskOwnership -Task $finalTask
        if ($null -eq $finalTask -or
            -not $finalOwnership.IsManaged -or
            [string]$finalOwnership.Kind -cne $expectedTaskKind) {
            throw "Scheduled task '$TaskName' changed after process cleanup; refusing to remove it."
        }
        $taskReadyForRemoval = $true
    }
    $unregistrationPreImages =
        [System.Collections.Generic.List[object]]::new()
    if (-not $SkipEnvironmentConfiguration) {
        foreach ($ownedPath in @(
            [string]$launcherDefinition.ShortcutPath,
            [string]$launcherIconPath,
            [string]$tokenPath,
            [string]$controlDispatcherPreflight.Path,
            [string]$controlDispatcherPreflight.ReceiptPath,
            [string]$desiredModePreflight.Path,
            $(if ([string]$legacyOverridePlan.Action -ceq
                    'remove-stale-state') {
                [string]$legacyOverridePlan.StatePath
            })
        )) {
            if (-not [string]::IsNullOrWhiteSpace($ownedPath)) {
                $preImage =
                    Get-UnregistrationOrdinaryFilePreImage `
                        -Path $ownedPath
                if ($null -ne $preImage) {
                    $unregistrationPreImages.Add($preImage)
                }
            }
        }
    }
    try {
    $legacyOverride = if ($SkipEnvironmentConfiguration) {
        [pscustomobject]@{ Status = 'fixture-skipped' }
    } else {
        Remove-LegacyPersistentOverride `
            -Plan $legacyOverridePlan `
            -ManagedDataDir $expected.DataDir
    }
    $launcherRemoval = if ($SkipEnvironmentConfiguration) {
        [pscustomobject]@{ Status = 'fixture-skipped' }
    } elseif ($launcherPreflight.Status -ceq 'not-found') {
        [pscustomobject]@{ Status = 'not-found' }
    } else {
        if (-not (Test-RecognizedManagedLauncherShortcut `
            -Definitions @($launcherDefinitions))) {
            throw "Launcher shortcut '$($launcherDefinition.ShortcutPath)' changed before removal; refusing to delete it."
        }
        Remove-Item -LiteralPath $launcherDefinition.ShortcutPath -Force
        [pscustomobject]@{ Status = 'removed' }
    }
    $launcherIconRemoval = if ($SkipEnvironmentConfiguration) {
        [pscustomobject]@{ Status = 'fixture-skipped' }
    } elseif ($launcherIconPreflight.Status -ceq 'not-found') {
        [pscustomobject]@{ Status = 'not-found' }
    } else {
        Remove-CodexLocalRemoteManagedDesktopIcon -DataDir $expected.DataDir
    }
    $tokenRemoval = if ($SkipEnvironmentConfiguration) {
        [pscustomobject]@{ Status = 'fixture-skipped' }
    } else {
        Remove-BrokerCapabilityToken -DataDir $expected.DataDir
    }
    $controlDispatcherRemoval = if ($SkipEnvironmentConfiguration) {
        [pscustomobject]@{ Status = 'fixture-skipped' }
    } else {
        Remove-CodexLocalRemoteControlDispatcher `
            -DataDir $expected.DataDir
    }
    $desiredModeRemoval = if ($SkipEnvironmentConfiguration) {
        [pscustomobject]@{ Status = 'fixture-skipped' }
    } else {
        Remove-CodexLocalRemoteDesiredMode `
            -DataDir $expected.DataDir
    }
    if ($taskReadyForRemoval) {
        $finalTask = Get-ScheduledTask `
            -TaskName $TaskName `
            -TaskPath '\' `
            -ErrorAction SilentlyContinue
        $finalOwnership = Test-ExistingTaskOwnership -Task $finalTask
        if ($null -eq $finalTask -or
            -not $finalOwnership.IsManaged -or
            [string]$finalOwnership.Kind -cne $expectedTaskKind -or
            [string]$finalTask.State -ceq 'Running') {
            throw "Scheduled task '$TaskName' changed before final removal."
        }
        Unregister-ScheduledTask `
            -TaskName $TaskName `
            -TaskPath '\' `
            -Confirm:$false
        $remainingTask = Get-ScheduledTask `
            -TaskName $TaskName `
            -TaskPath '\' `
            -ErrorAction SilentlyContinue
        if ($null -ne $remainingTask) {
            throw "Scheduled task '$TaskName' remained after removal."
        }
    }
    } catch {
        $unregistrationFailure = $_
        $remainingTask = Get-ScheduledTask `
            -TaskName $TaskName `
            -TaskPath '\' `
            -ErrorAction SilentlyContinue
        if (-not ($taskReadyForRemoval -and $null -eq $remainingTask)) {
            $restoreFailures =
                Restore-UnregistrationOrdinaryFilePreImages `
                    -PreImages @($unregistrationPreImages)
            if (@($restoreFailures).Count -gt 0) {
                throw (
                    "$($unregistrationFailure.Exception.Message) " +
                    'Unregistration rollback was incomplete for: ' +
                    (@($restoreFailures) -join ', ')
                )
            }
            if ([string]$legacyOverridePlan.Action -ceq
                'restore-managed' -and
                [string]$legacyOverride.Status -cne 'not-found') {
                try {
                    $null = Install-BrokerUserEnvironment `
                        -DataDir $expected.DataDir `
                        -WebSocketUrl (
                            [string]$legacyOverridePlan.WebSocketUrl
                        )
                } catch {
                    throw (
                        "$($unregistrationFailure.Exception.Message) " +
                        'Legacy environment rollback was incomplete.'
                    )
                }
            }
            throw $unregistrationFailure
        }
    }
    [pscustomobject]@{
        Status = if ($null -eq $current) { 'residual-state-removed' } else { 'removed' }
        TaskName = $TaskName
        LaunchMode = 'native-only'
        LauncherShortcut = $launcherRemoval.Status
        LauncherIcon = $launcherIconRemoval.Status
        LegacyPersistentOverride = $legacyOverride.Status
        BrokerCapabilityToken = $tokenRemoval.Status
        ControlDispatcher = $controlDispatcherRemoval.Status
        DesiredMode = $desiredModeRemoval.Status
    }
} else {
    [pscustomobject]@{
        Status = 'what-if'
        TaskName = $TaskName
        LauncherShortcut = $launcherPreflight.Status
        LauncherIcon = $launcherIconPreflight.Status
        LegacyPersistentOverride = $legacyOverridePlan.Status
        ControlDispatcher = $controlDispatcherPreflight.Status
        DesiredMode = $desiredModePreflight.Status
    }
}
