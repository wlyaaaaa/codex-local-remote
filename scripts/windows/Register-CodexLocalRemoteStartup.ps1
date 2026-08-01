[CmdletBinding(SupportsShouldProcess)]
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

    [switch]$NoStart,

    [switch]$StartRemoteNow,

    [Parameter(DontShow)]
    [ValidatePattern('^[a-f0-9]{64}$')]
    [string]$RepairPendingRuntimeFromActiveVersionId,

    [Parameter(DontShow)]
    [ValidatePattern('^[a-f0-9]{64}$')]
    [string]$SupersedeOfflineSelectedRuntimeVersionId,

    [Parameter(DontShow)]
    [switch]$SkipEnvironmentConfiguration,

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
if (-not [string]::IsNullOrWhiteSpace($LauncherShortcutPath) -and
    $env:CODEX_REMOTE_TEST_FIXTURE -cne '1') {
    throw 'LauncherShortcutPath is reserved for the isolated test fixture.'
}
if (-not [string]::IsNullOrWhiteSpace(
        $RepairPendingRuntimeFromActiveVersionId
    ) -and $StartRemoteNow) {
    throw 'RepairPendingRuntimeFromActiveVersionId cannot start Remote.'
}
if (-not [string]::IsNullOrWhiteSpace(
        $RepairPendingRuntimeFromActiveVersionId
    ) -and -not [string]::IsNullOrWhiteSpace(
        $SupersedeOfflineSelectedRuntimeVersionId
    )) {
    throw (
        'RepairPendingRuntimeFromActiveVersionId and ' +
        'SupersedeOfflineSelectedRuntimeVersionId are mutually exclusive.'
    )
}
if (-not [string]::IsNullOrWhiteSpace(
        $SupersedeOfflineSelectedRuntimeVersionId
    ) -and $StartRemoteNow) {
    throw 'SupersedeOfflineSelectedRuntimeVersionId cannot start Remote.'
}
if (-not [string]::IsNullOrWhiteSpace(
        $SupersedeOfflineSelectedRuntimeVersionId
    ) -and -not $NoStart) {
    throw 'SupersedeOfflineSelectedRuntimeVersionId requires NoStart.'
}
if ($NoStart -and $StartRemoteNow) {
    throw 'NoStart and StartRemoteNow are mutually exclusive.'
}
$startAfterRegistration = [bool]$StartRemoteNow -and -not [bool]$NoStart
Assert-ForceCliDisabled

$sourceInstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$useImmutableRuntime = (
    -not $SkipEnvironmentConfiguration -and
    $env:CODEX_REMOTE_TEST_FIXTURE -cne '1'
)
$runtimePlan = $null
$effectiveInstallRoot = $sourceInstallRoot
$activeRuntimeBefore = $null
if ($useImmutableRuntime) {
    $activeRuntimeBefore = Get-CodexLocalRemoteCurrentRuntime -DataDir $DataDir
    $runtimePlan = Get-CodexLocalRemoteRuntimeVersionPlan `
        -SourceRoot $sourceInstallRoot `
        -DataDir $DataDir
    $effectiveInstallRoot = [string]$runtimePlan.RuntimeRoot
}
$sourceExpected = Get-StartupTaskDefinition `
    -TaskName $TaskName `
    -NodePath $NodePath `
    -PwshPath $PwshPath `
    -InstallRoot $sourceInstallRoot `
    -DataDir $DataDir `
    -Port $Port `
    -BrokerPort $BrokerPort `
    -BrokerUpstreamPort $BrokerUpstreamPort `
    -BasePath $BasePath
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
$dataDirectoryPlan = Get-CodexLocalRemoteDataDirectoryOwnershipPlan `
    -DataDir $expected.DataDir
$controlDispatcherPath =
    Get-CodexLocalRemoteControlDispatcherPath -DataDir $expected.DataDir
$controlDispatcherPreflight = if ($SkipEnvironmentConfiguration) {
    [pscustomobject]@{ Status = 'fixture-skipped' }
} else {
    Get-CodexLocalRemoteControlDispatcherState `
        -DataDir $expected.DataDir
}
$desiredModePreflight = if ($SkipEnvironmentConfiguration) {
    [pscustomobject]@{
        Mode = if ($startAfterRegistration) { 'Remote' } else { 'Native' }
        Status = 'fixture-skipped'
    }
} else {
    Get-CodexLocalRemoteDesiredMode `
        -DataDir $expected.DataDir
}
$legacyExpected = Get-LegacyStartupTaskDefinition `
    -TaskName $TaskName `
    -NodePath $NodePath `
    -InstallRoot $sourceInstallRoot `
    -DataDir $DataDir `
    -Port $Port `
    -BasePath $BasePath
function Get-PreHiddenWindowStartupTaskDefinition {
    param([Parameter(Mandatory)][object]$Definition)

    $properties = [ordered]@{}
    foreach ($property in $Definition.PSObject.Properties) {
        $properties[[string]$property.Name] = $property.Value
    }
    $properties.Arguments = ([string]$Definition.Arguments).Replace(
        '-NonInteractive -WindowStyle Hidden -ExecutionPolicy',
        '-NonInteractive -ExecutionPolicy'
    )
    if ($null -ne $Definition.PSObject.Properties['TaskArguments']) {
        $properties.TaskArguments = ([string]$Definition.TaskArguments).Replace(
            '-NonInteractive -WindowStyle Hidden -ExecutionPolicy',
            '-NonInteractive -ExecutionPolicy'
        )
    }
    return [pscustomobject]$properties
}

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

function Get-LimitedRunLevelStartupTaskDefinition {
    param([Parameter(Mandatory)][object]$Definition)

    $properties = [ordered]@{}
    foreach ($property in $Definition.PSObject.Properties) {
        $properties[[string]$property.Name] = $property.Value
    }
    $properties.PrincipalRunLevel = 'Limited'
    return [pscustomobject]$properties
}

function Test-ManagedStartupTaskWithLegacyRunLevel {
    param(
        [Parameter(Mandatory)][object]$Task,
        [Parameter(Mandatory)][object]$Expected
    )

    $current = Test-ManagedStartupTask -Task $Task -Expected $Expected
    if ($current.IsManaged) {
        return $current
    }
    return Test-ManagedStartupTask `
        -Task $Task `
        -Expected (Get-LimitedRunLevelStartupTaskDefinition -Definition $Expected)
}

function Assert-HighestRunLevelRegistrationAllowed {
    if ($env:CODEX_REMOTE_TEST_FIXTURE -ceq '1') {
        return
    }

    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole(
        [System.Security.Principal.WindowsBuiltInRole]::Administrator
    )) {
        throw (
            'Registering the managed owner task at Highest run level requires ' +
            'an elevated PowerShell process. Re-run this script from an ' +
            'Administrator terminal or through Windows sudo/UAC.'
        )
    }
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
            Definition = $expected
        }
    }
    $legacyHeadlessExpected =
        Get-LegacyHeadlessStartupTaskDefinitionV4 -Definition $expected
    $legacyHeadlessV4 = Test-ManagedStartupTask `
        -Task $Task `
        -Expected $legacyHeadlessExpected
    if ($legacyHeadlessV4.IsManaged) {
        return [pscustomobject]@{
            IsManaged = $true
            Kind = 'legacy-headless-v4'
            Mismatches = @()
            Definition = $expected
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
            Definition = $expected
        }
    }
    $limitedCurrent = Test-ManagedStartupTask `
        -Task $Task `
        -Expected (
            Get-LimitedRunLevelStartupTaskDefinition `
                -Definition $legacyDesktopOwnerExpected
        )
    if ($limitedCurrent.IsManaged) {
        return [pscustomobject]@{
            IsManaged = $true
            Kind = 'limited-v3'
            Mismatches = @()
            Definition = $expected
        }
    }
    $preTakeoverCurrent = Test-ManagedStartupTaskWithLegacyRunLevel `
        -Task $Task `
        -Expected (
            Get-PreTakeoverStartupTaskDefinition `
                -Definition $legacyDesktopOwnerExpected
        )
    if ($preTakeoverCurrent.IsManaged) {
        return [pscustomobject]@{
            IsManaged = $true
            Kind = 'pre-takeover-v3'
            Mismatches = @()
            Definition = $expected
        }
    }
    $mutableV5 = Test-ManagedStartupTask `
        -Task $Task `
        -Expected $sourceExpected
    if ($mutableV5.IsManaged) {
        return [pscustomobject]@{
            IsManaged = $true
            Kind = 'mutable-v5'
            Mismatches = @()
            Definition = $sourceExpected
        }
    }
    $legacyAutoStartMutableExpected =
        Get-LegacyAutoStartStartupTaskDefinitionV5 `
            -Definition $sourceExpected
    $legacyAutoStartMutableV5 = Test-ManagedStartupTask `
        -Task $Task `
        -Expected $legacyAutoStartMutableExpected
    if ($legacyAutoStartMutableV5.IsManaged) {
        return [pscustomobject]@{
            IsManaged = $true
            Kind = 'mutable-auto-start-v5'
            Mismatches = @()
            Definition = $sourceExpected
        }
    }
    $legacyHeadlessMutableExpected =
        Get-LegacyHeadlessStartupTaskDefinitionV4 -Definition $sourceExpected
    $legacyHeadlessMutableV4 = Test-ManagedStartupTask `
        -Task $Task `
        -Expected $legacyHeadlessMutableExpected
    if ($legacyHeadlessMutableV4.IsManaged) {
        return [pscustomobject]@{
            IsManaged = $true
            Kind = 'mutable-v4'
            Mismatches = @()
            Definition = $sourceExpected
        }
    }
    $legacyDesktopOwnerMutableExpected =
        Get-LegacyDesktopOwningStartupTaskDefinitionV3 `
            -Definition $sourceExpected
    $legacyDesktopOwnerMutableV3 =
        Test-ManagedStartupTaskWithLegacyRunLevel `
        -Task $Task `
        -Expected $legacyDesktopOwnerMutableExpected
    if ($legacyDesktopOwnerMutableV3.IsManaged) {
        return [pscustomobject]@{
            IsManaged = $true
            Kind = 'mutable-v3'
            Mismatches = @()
            Definition = $sourceExpected
        }
    }
    $preTakeoverMutableV3 = Test-ManagedStartupTaskWithLegacyRunLevel `
        -Task $Task `
        -Expected (
            Get-PreTakeoverStartupTaskDefinition `
                -Definition $legacyDesktopOwnerMutableExpected
        )
    if ($preTakeoverMutableV3.IsManaged) {
        return [pscustomobject]@{
            IsManaged = $true
            Kind = 'mutable-v3'
            Mismatches = @()
            Definition = $sourceExpected
        }
    }
    $preHeadlessMutableDefinition =
        Get-PreHeadlessConsoleStartupTaskDefinition `
            -Definition $legacyDesktopOwnerMutableExpected
    $preHeadlessMutableV3 = Test-ManagedStartupTaskWithLegacyRunLevel `
        -Task $Task `
        -Expected $preHeadlessMutableDefinition
    if ($preHeadlessMutableV3.IsManaged) {
        return [pscustomobject]@{
            IsManaged = $true
            Kind = 'mutable-v3'
            Mismatches = @()
            Definition = $sourceExpected
        }
    }
    $preHiddenMutableV3 = Test-ManagedStartupTaskWithLegacyRunLevel `
        -Task $Task `
        -Expected (
            Get-PreHiddenWindowStartupTaskDefinition `
                -Definition $legacyDesktopOwnerMutableExpected
        )
    if ($preHiddenMutableV3.IsManaged) {
        return [pscustomobject]@{
            IsManaged = $true
            Kind = 'mutable-v3'
            Mismatches = @()
            Definition = $sourceExpected
        }
    }
    $preHeadlessPreHiddenMutableV3 = Test-ManagedStartupTaskWithLegacyRunLevel `
        -Task $Task `
        -Expected (
            Get-PreHiddenWindowStartupTaskDefinition `
                -Definition $preHeadlessMutableDefinition
        )
    if ($preHeadlessPreHiddenMutableV3.IsManaged) {
        return [pscustomobject]@{
            IsManaged = $true
            Kind = 'mutable-v3'
            Mismatches = @()
            Definition = $sourceExpected
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
                    -InstallRoot $InstallRoot `
                    -DataDir $DataDir `
                    -Port $Port `
                    -BrokerPort $BrokerPort `
                    -BrokerUpstreamPort $BrokerUpstreamPort `
                    -BasePath $BasePath
                $pinned = Test-ManagedStartupTaskWithLegacyRunLevel `
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
            $installRootSwitchIndexes = @(
                for ($index = 0; $index -lt $arguments.Count; $index++) {
                    if ([string]$arguments[$index] -ceq '-InstallRoot') {
                        $index
                    }
                }
            )
            if ($installRootSwitchIndexes.Count -eq 1 -and
                $installRootSwitchIndexes[0] + 1 -lt $arguments.Count) {
                $taskInstallRoot = [System.IO.Path]::GetFullPath(
                    [string]$arguments[$installRootSwitchIndexes[0] + 1]
                )
                $versionsRoot = [System.IO.Path]::GetFullPath(
                    (Join-Path $expected.DataDir 'RuntimeVersions')
                ).TrimEnd('\') + '\'
                if ($taskInstallRoot.StartsWith(
                    $versionsRoot,
                    [System.StringComparison]::OrdinalIgnoreCase
                )) {
                    $runtimeValidation = Test-CodexLocalRemoteRuntimeVersion `
                        -RuntimeRoot $taskInstallRoot
                    if ($runtimeValidation.IsValid) {
                        $versionedExpected = Get-StartupTaskDefinition `
                            -TaskName $TaskName `
                            -NodePath $NodePath `
                            -PwshPath $PwshPath `
                            -InstallRoot $taskInstallRoot `
                            -DataDir $DataDir `
                            -Port $Port `
                            -BrokerPort $BrokerPort `
                            -BrokerUpstreamPort $BrokerUpstreamPort `
                            -BasePath $BasePath
                        $versionedV5 = Test-ManagedStartupTask `
                            -Task $Task `
                            -Expected $versionedExpected
                        $legacyAutoStartVersionedExpected =
                            Get-LegacyAutoStartStartupTaskDefinitionV5 `
                                -Definition $versionedExpected
                        $legacyAutoStartVersionedV5 =
                            Test-ManagedStartupTask `
                                -Task $Task `
                                -Expected $legacyAutoStartVersionedExpected
                        $legacyHeadlessVersionedExpected =
                            Get-LegacyHeadlessStartupTaskDefinitionV4 `
                                -Definition $versionedExpected
                        $legacyHeadlessVersionedV4 =
                            Test-ManagedStartupTask `
                                -Task $Task `
                                -Expected $legacyHeadlessVersionedExpected
                        $legacyDesktopOwnerVersionedExpected =
                            Get-LegacyDesktopOwningStartupTaskDefinitionV3 `
                                -Definition $versionedExpected
                        $legacyDesktopOwnerVersionedV3 =
                            Test-ManagedStartupTaskWithLegacyRunLevel `
                                -Task $Task `
                                -Expected $legacyDesktopOwnerVersionedExpected
                        $preTakeoverVersionedDefinition =
                            Get-PreTakeoverStartupTaskDefinition `
                                -Definition $legacyDesktopOwnerVersionedExpected
                        $preTakeoverVersioned =
                            Test-ManagedStartupTaskWithLegacyRunLevel `
                                -Task $Task `
                                -Expected $preTakeoverVersionedDefinition
                        $preTakeoverPreHiddenVersioned =
                            Test-ManagedStartupTaskWithLegacyRunLevel `
                                -Task $Task `
                                -Expected (
                                    Get-PreHiddenWindowStartupTaskDefinition `
                                        -Definition (
                                            $preTakeoverVersionedDefinition
                                        )
                                )
                        $preTakeoverPreHeadlessVersionedDefinition =
                            Get-PreHeadlessConsoleStartupTaskDefinition `
                                -Definition $preTakeoverVersionedDefinition
                        $preTakeoverPreHeadlessVersioned =
                            Test-ManagedStartupTaskWithLegacyRunLevel `
                                -Task $Task `
                                -Expected (
                                    $preTakeoverPreHeadlessVersionedDefinition
                                )
                        $preTakeoverPreHeadlessPreHiddenVersioned =
                            Test-ManagedStartupTaskWithLegacyRunLevel `
                                -Task $Task `
                                -Expected (
                                    Get-PreHiddenWindowStartupTaskDefinition `
                                        -Definition (
                                            $preTakeoverPreHeadlessVersionedDefinition
                                        )
                                )
                        $preHiddenVersioned = Test-ManagedStartupTaskWithLegacyRunLevel `
                            -Task $Task `
                            -Expected (
                                    Get-PreHiddenWindowStartupTaskDefinition `
                                        -Definition (
                                            $legacyDesktopOwnerVersionedExpected
                                        )
                            )
                        $preHeadlessVersionedDefinition =
                            Get-PreHeadlessConsoleStartupTaskDefinition `
                                -Definition $legacyDesktopOwnerVersionedExpected
                        $preHeadlessVersioned = Test-ManagedStartupTaskWithLegacyRunLevel `
                            -Task $Task `
                            -Expected $preHeadlessVersionedDefinition
                        $preHeadlessPreHiddenVersioned = Test-ManagedStartupTaskWithLegacyRunLevel `
                            -Task $Task `
                            -Expected (
                                Get-PreHiddenWindowStartupTaskDefinition `
                                    -Definition $preHeadlessVersionedDefinition
                            )
                        if ($legacyDesktopOwnerVersionedV3.IsManaged) {
                            return [pscustomobject]@{
                                IsManaged = $true
                                Kind = 'versioned-v3'
                                Mismatches = @()
                                Definition = $versionedExpected
                            }
                        }
                        if ($versionedV5.IsManaged) {
                            return [pscustomobject]@{
                                IsManaged = $true
                                Kind = 'versioned-v5'
                                Mismatches = @()
                                Definition = $versionedExpected
                            }
                        }
                        if ($legacyAutoStartVersionedV5.IsManaged) {
                            return [pscustomobject]@{
                                IsManaged = $true
                                Kind = 'versioned-auto-start-v5'
                                Mismatches = @()
                                Definition = $versionedExpected
                            }
                        }
                        if ($legacyHeadlessVersionedV4.IsManaged) {
                            return [pscustomobject]@{
                                IsManaged = $true
                                Kind = 'versioned-v4'
                                Mismatches = @()
                                Definition = $versionedExpected
                            }
                        }
                        if ($preTakeoverVersioned.IsManaged -or
                            $preTakeoverPreHiddenVersioned.IsManaged -or
                            $preTakeoverPreHeadlessVersioned.IsManaged -or
                            $preTakeoverPreHeadlessPreHiddenVersioned.IsManaged -or
                            $preHiddenVersioned.IsManaged -or
                            $preHeadlessVersioned.IsManaged -or
                            $preHeadlessPreHiddenVersioned.IsManaged) {
                            return [pscustomobject]@{
                                IsManaged = $true
                                Kind = 'versioned-v3'
                                Mismatches = @()
                                Definition = $versionedExpected
                            }
                        }
                    }
                }
            }
        } catch {
            # Continue to exact legacy/foreign classification.
        }
    }
    $legacy = Test-ManagedStartupTaskWithLegacyRunLevel `
        -Task $Task `
        -Expected $legacyExpected
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
            throw 'P0 blocked: persistent user CODEX_APP_SERVER_WS_URL exists without an exact managed recovery state. Remove or recover it explicitly before registration.'
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
        [Parameter(Mandatory)][string]$ManagedDataDir,
        [Parameter(Mandatory)][int]$ManagedBrokerPort
    )

    $plan = Get-LegacyPersistentOverridePlan `
        -ManagedDataDir $ManagedDataDir `
        -ManagedBrokerPort $ManagedBrokerPort
    $result = switch ([string]$plan.Action) {
        'restore-managed' {
            Restore-BrokerUserEnvironment `
                -DataDir $ManagedDataDir `
                -WebSocketUrl ([string]$plan.WebSocketUrl)
        }
        'remove-stale-state' {
            Remove-Item -LiteralPath ([string]$plan.StatePath) -Force
            [pscustomobject]@{ Status = 'stale-state-removed' }
        }
        default {
            [pscustomobject]@{ Status = 'not-found' }
        }
    }
    $remaining = Get-UserEnvironmentValueState -Name 'CODEX_APP_SERVER_WS_URL'
    if ($remaining.Exists) {
        throw 'P0 blocked: a persistent user CODEX_APP_SERVER_WS_URL remains after exact legacy cleanup. Registration will not make Codex Desktop depend on a local port.'
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

function Set-ManagedLauncherShortcutRunAsUser {
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
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
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
        $flags = [uint32](
            [BitConverter]::ToUInt32($header, 20) -bor 0x00002000
        )
        $flagBytes = [BitConverter]::GetBytes($flags)
        $null = $stream.Seek(20, [System.IO.SeekOrigin]::Begin)
        $stream.Write($flagBytes, 0, $flagBytes.Length)
        $stream.Flush($true)
    } finally {
        $stream.Dispose()
    }
    $readBack = Get-ManagedLauncherShortcutLinkFlags -Path $fullPath
    if (($readBack -band 0x00002000) -eq 0) {
        throw 'The managed launcher shell link RunAsUser flag did not persist.'
    }
}

function Test-ManagedLauncherShortcut {
    param(
        [Parameter(Mandatory)][object]$Definition,
        [string]$Path = ([string]$Definition.ShortcutPath),
        [switch]$IgnoreIcon
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    $shell = $null
    $shortcut = $null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($Path)
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
                    (Get-ManagedLauncherShortcutLinkFlags -Path $Path) `
                        -band 0x00002000
                ) -ne 0
            ) -eq [bool]$Definition.RunAsUser -and
            (
                $IgnoreIcon -or
                [string]::Equals(
                    [string]$shortcut.IconLocation,
                    [string]$Definition.IconLocation,
                    [System.StringComparison]::OrdinalIgnoreCase
                )
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

function Test-LegacyNonElevatedManagedLauncherShortcut {
    param(
        [Parameter(Mandatory)][object]$Definition,
        [string]$Path = ([string]$Definition.ShortcutPath)
    )

    if (-not [bool]$Definition.RunAsUser) {
        return $false
    }
    $properties = [ordered]@{}
    foreach ($property in $Definition.PSObject.Properties) {
        $properties[[string]$property.Name] = $property.Value
    }
    $properties.RunAsUser = $false
    return Test-ManagedLauncherShortcut `
        -Definition ([pscustomobject]$properties) `
        -Path $Path `
        -IgnoreIcon
}

function Test-LegacyMinimizedManagedLauncherShortcut {
    param(
        [Parameter(Mandatory)][object]$Definition,
        [string]$Path = ([string]$Definition.ShortcutPath)
    )

    if ([int]$Definition.WindowStyle -eq 7) {
        return $false
    }
    foreach ($runAsUser in @([bool]$Definition.RunAsUser, $false)) {
        $properties = [ordered]@{}
        foreach ($property in $Definition.PSObject.Properties) {
            $properties[[string]$property.Name] = $property.Value
        }
        $properties.WindowStyle = 7
        $properties.RunAsUser = $runAsUser
        if (Test-ManagedLauncherShortcut `
            -Definition ([pscustomobject]$properties) `
            -Path $Path `
            -IgnoreIcon) {
            return $true
        }
    }
    return $false
}

function Test-LegacyVisibleManagedLauncherShortcut {
    param(
        [Parameter(Mandatory)][object]$Definition,
        [string]$Path = ([string]$Definition.ShortcutPath)
    )

    $legacyArguments = [string]$Definition.Arguments
    $legacyArguments = $legacyArguments.Replace(
        ' -WindowStyle Hidden ',
        ' '
    )
    if ($legacyArguments -ceq [string]$Definition.Arguments) {
        return $false
    }
    foreach ($windowStyle in @([int]$Definition.WindowStyle, 7)) {
        foreach ($runAsUser in @([bool]$Definition.RunAsUser, $false)) {
            if (Test-ManagedLauncherShortcut `
                -Definition ([pscustomobject]@{
                    ShortcutPath = [string]$Definition.ShortcutPath
                    TargetPath = [string]$Definition.TargetPath
                    Arguments = $legacyArguments
                    WorkingDirectory = [string]$Definition.WorkingDirectory
                    Description = [string]$Definition.Description
                    IconLocation = [string]$Definition.IconLocation
                    WindowStyle = $windowStyle
                    RunAsUser = $runAsUser
                }) `
                -Path $Path `
                -IgnoreIcon) {
                return $true
            }
        }
    }
    return $false
}

function Test-LegacyPreTakeoverManagedLauncherShortcut {
    param(
        [Parameter(Mandatory)][object]$Definition,
        [string]$Path = ([string]$Definition.ShortcutPath)
    )

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
                if (Test-ManagedLauncherShortcut `
                    -Definition ([pscustomobject]@{
                        ShortcutPath = [string]$Definition.ShortcutPath
                        TargetPath = [string]$Definition.TargetPath
                        Arguments = [string]$arguments
                        WorkingDirectory = [string]$Definition.WorkingDirectory
                        Description = [string]$Definition.Description
                        IconLocation = [string]$Definition.IconLocation
                        WindowStyle = $windowStyle
                        RunAsUser = $runAsUser
                    }) `
                    -Path $Path `
                    -IgnoreIcon) {
                    return $true
                }
            }
        }
    }
    return $false
}

function Test-LegacyVisiblePreTakeoverManagedLauncherShortcut {
    param(
        [Parameter(Mandatory)][object]$Definition,
        [string]$Path = ([string]$Definition.ShortcutPath)
    )

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
        $visibleArguments.Replace(
            ' -RequestDesktopLaunch',
            ''
        )
    ) | Select-Object -Unique
    if ($legacyArguments.Count -eq 1 -and
        [string]$legacyArguments[0] -ceq $visibleArguments) {
        return $false
    }
    foreach ($arguments in $legacyArguments) {
        foreach ($windowStyle in @([int]$Definition.WindowStyle, 7)) {
            foreach ($runAsUser in @([bool]$Definition.RunAsUser, $false)) {
                if (Test-ManagedLauncherShortcut `
                    -Definition ([pscustomobject]@{
                        ShortcutPath = [string]$Definition.ShortcutPath
                        TargetPath = [string]$Definition.TargetPath
                        Arguments = [string]$arguments
                        WorkingDirectory = [string]$Definition.WorkingDirectory
                        Description = [string]$Definition.Description
                        IconLocation = [string]$Definition.IconLocation
                        WindowStyle = $windowStyle
                        RunAsUser = $runAsUser
                    }) `
                    -Path $Path `
                    -IgnoreIcon) {
                    return $true
                }
            }
        }
    }
    return $false
}

function Get-ManagedLauncherShortcutPathState {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    try {
        $attributes = [System.IO.File]::GetAttributes($fullPath)
    } catch [System.IO.FileNotFoundException] {
        return [pscustomobject]@{
            Exists = $false
            Path = $fullPath
            Attributes = [System.IO.FileAttributes]::Normal
        }
    } catch [System.IO.DirectoryNotFoundException] {
        return [pscustomobject]@{
            Exists = $false
            Path = $fullPath
            Attributes = [System.IO.FileAttributes]::Normal
        }
    }
    return [pscustomobject]@{
        Exists = $true
        Path = $fullPath
        Attributes = $attributes
    }
}

function Assert-ManagedLauncherShortcutOwnership {
    param(
        [Parameter(Mandatory)][object]$Definition,
        [AllowNull()][object]$PreviousDefinition,
        [string]$Path = ([string]$Definition.ShortcutPath)
    )

    $shortcutState =
        Get-ManagedLauncherShortcutPathState -Path $Path
    $shortcutPath = [string]$shortcutState.Path
    if (-not $shortcutState.Exists) {
        return
    }
    $ownershipFailure =
        "Launcher shortcut '$shortcutPath' exists but is not the exact " +
        'managed Codex Remote entry; refusing to overwrite it.'
    if (($shortcutState.Attributes -band
            [System.IO.FileAttributes]::Directory) -ne 0 -or
        ($shortcutState.Attributes -band
            [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw $ownershipFailure
    }
    $definitions = @(
        $Definition
        if ($null -ne $PreviousDefinition) {
            $PreviousDefinition
        }
    )
    foreach ($candidate in $definitions) {
        if ((Test-ManagedLauncherShortcut `
                -Definition $candidate `
                -Path $shortcutPath) -or
            (Test-ManagedLauncherShortcut `
                -Definition $candidate `
                -Path $shortcutPath `
                -IgnoreIcon) -or
            (Test-LegacyNonElevatedManagedLauncherShortcut `
                -Definition $candidate `
                -Path $shortcutPath) -or
            (Test-LegacyMinimizedManagedLauncherShortcut `
                -Definition $candidate `
                -Path $shortcutPath) -or
            (Test-LegacyVisibleManagedLauncherShortcut `
                -Definition $candidate `
                -Path $shortcutPath) -or
            (Test-LegacyPreTakeoverManagedLauncherShortcut `
                -Definition $candidate `
                -Path $shortcutPath) -or
            (Test-LegacyVisiblePreTakeoverManagedLauncherShortcut `
                -Definition $candidate `
                -Path $shortcutPath)) {
            return
        }
    }
    throw $ownershipFailure
}

function Move-ManagedLauncherShortcutNoOverwrite {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )

    $sourcePath = [System.IO.Path]::GetFullPath($Source)
    $destinationPath = [System.IO.Path]::GetFullPath($Destination)
    $sourceParent = [System.IO.Path]::GetFullPath(
        [System.IO.Path]::GetDirectoryName($sourcePath)
    ).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    $destinationParent = [System.IO.Path]::GetFullPath(
        [System.IO.Path]::GetDirectoryName($destinationPath)
    ).TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    if (-not [string]::Equals(
        $sourceParent,
        $destinationParent,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'Managed launcher moves must remain within the same directory.'
    }
    [System.IO.File]::Move($sourcePath, $destinationPath, $false)
}

function Get-ManagedLauncherShortcutSha256 {
    param(
        [Parameter(Mandatory)][string]$Path
    )

    $state = Get-ManagedLauncherShortcutPathState -Path $Path
    if (-not $state.Exists -or
        ($state.Attributes -band
            [System.IO.FileAttributes]::Directory) -ne 0 -or
        ($state.Attributes -band
            [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Launcher shortcut '$([string]$state.Path)' is not an ordinary file."
    }
    return [string](
        Get-FileHash `
            -LiteralPath ([string]$state.Path) `
            -Algorithm SHA256 `
            -ErrorAction Stop
    ).Hash
}

function Test-ManagedLauncherShortcutReceiptFile {
    param(
        [Parameter(Mandatory)][object]$Definition,
        [AllowNull()][object]$PreviousDefinition,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$ExpectedSha256,
        [switch]$AllowManagedVariants
    )

    try {
        $state = Get-ManagedLauncherShortcutPathState -Path $Path
        if (-not $state.Exists -or
            ($state.Attributes -band
                [System.IO.FileAttributes]::Directory) -ne 0 -or
            ($state.Attributes -band
                [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            return $false
        }
        if ($AllowManagedVariants) {
            Assert-ManagedLauncherShortcutOwnership `
                -Definition $Definition `
                -PreviousDefinition $PreviousDefinition `
                -Path ([string]$state.Path)
        } elseif (-not (Test-ManagedLauncherShortcut `
            -Definition $Definition `
            -Path ([string]$state.Path))) {
            return $false
        }
        $actualSha256 =
            Get-ManagedLauncherShortcutSha256 -Path ([string]$state.Path)
        return [string]::Equals(
            $actualSha256,
            $ExpectedSha256,
            [System.StringComparison]::OrdinalIgnoreCase
        )
    } catch {
        return $false
    }
}

function Remove-ManagedLauncherShortcutReceiptFile {
    param(
        [Parameter(Mandatory)][object]$Definition,
        [AllowNull()][object]$PreviousDefinition,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$ExpectedSha256,
        [switch]$AllowManagedVariants
    )

    if (-not (Test-ManagedLauncherShortcutReceiptFile `
        -Definition $Definition `
        -PreviousDefinition $PreviousDefinition `
        -Path $Path `
        -ExpectedSha256 $ExpectedSha256 `
        -AllowManagedVariants:$AllowManagedVariants)) {
        throw "Refusing to delete unverified launcher receipt '$Path'."
    }
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $discardPath =
        Join-Path (
            [System.IO.Path]::GetDirectoryName($fullPath)
        ) ".$([guid]::NewGuid().ToString('N')).discard.lnk"
    Move-ManagedLauncherShortcutNoOverwrite `
        -Source $fullPath `
        -Destination $discardPath
    if (-not (Test-ManagedLauncherShortcutReceiptFile `
        -Definition $Definition `
        -PreviousDefinition $PreviousDefinition `
        -Path $discardPath `
        -ExpectedSha256 $ExpectedSha256 `
        -AllowManagedVariants:$AllowManagedVariants)) {
        try {
            Move-ManagedLauncherShortcutNoOverwrite `
                -Source $discardPath `
                -Destination $fullPath
        } catch {
            throw (
                "Launcher receipt changed during verified deletion; it remains " +
                "at '$discardPath', and recovery did not overwrite '$fullPath'."
            )
        }
        throw (
            'Launcher receipt changed during verified deletion and was restored ' +
            "without overwrite to '$fullPath'."
        )
    }
    [System.IO.File]::Delete($discardPath)
}

function Complete-ManagedLauncherShortcutTransaction {
    param(
        [AllowNull()][object]$Receipt,
        [Parameter(Mandatory)][object]$Definition,
        [AllowNull()][object]$PreviousDefinition
    )

    if ($null -eq $Receipt -or
        [string]$Receipt.Status -ceq 'reused') {
        return [pscustomobject]@{ Status = 'not-needed' }
    }
    $targetPath = [string]$Receipt.ShortcutPath
    if (-not (Test-ManagedLauncherShortcutReceiptFile `
        -Definition $Definition `
        -PreviousDefinition $PreviousDefinition `
        -Path $targetPath `
        -ExpectedSha256 ([string]$Receipt.InstalledSha256))) {
        throw (
            "Installed launcher '$targetPath' changed before transaction " +
            'completion; refusing to delete any rollback material.'
        )
    }
    if ([string]$Receipt.Status -ceq 'upgraded') {
        $preImagePath = [string]$Receipt.PreImagePath
        if (-not (Test-ManagedLauncherShortcutReceiptFile `
            -Definition $Definition `
            -PreviousDefinition $PreviousDefinition `
            -Path $preImagePath `
            -ExpectedSha256 ([string]$Receipt.PreImageSha256) `
            -AllowManagedVariants)) {
            throw (
                "Launcher pre-image '$preImagePath' changed before transaction " +
                'completion; refusing to delete it.'
            )
        }
        if (-not (Test-ManagedLauncherShortcutReceiptFile `
            -Definition $Definition `
            -PreviousDefinition $PreviousDefinition `
            -Path $targetPath `
            -ExpectedSha256 ([string]$Receipt.InstalledSha256))) {
            throw (
                "Installed launcher '$targetPath' changed before transaction " +
                'completion; refusing to delete any rollback material.'
            )
        }
        Remove-ManagedLauncherShortcutReceiptFile `
            -Definition $Definition `
            -PreviousDefinition $PreviousDefinition `
            -Path $preImagePath `
            -ExpectedSha256 ([string]$Receipt.PreImageSha256) `
            -AllowManagedVariants
    }
    return [pscustomobject]@{ Status = 'committed' }
}

function Undo-ManagedLauncherShortcutTransaction {
    param(
        [AllowNull()][object]$Receipt,
        [Parameter(Mandatory)][object]$Definition,
        [AllowNull()][object]$PreviousDefinition
    )

    if ($null -eq $Receipt -or
        [string]$Receipt.Status -ceq 'reused') {
        return [pscustomobject]@{ Status = 'not-needed' }
    }
    $targetPath = [System.IO.Path]::GetFullPath(
        [string]$Receipt.ShortcutPath
    )
    $parent = [System.IO.Path]::GetDirectoryName($targetPath)
    $isUpgrade = [string]$Receipt.Status -ceq 'upgraded'
    $preImagePath = if ($isUpgrade) {
        [System.IO.Path]::GetFullPath([string]$Receipt.PreImagePath)
    } else {
        $null
    }
    if ($isUpgrade -and
        -not (Test-ManagedLauncherShortcutReceiptFile `
            -Definition $Definition `
            -PreviousDefinition $PreviousDefinition `
            -Path $preImagePath `
            -ExpectedSha256 ([string]$Receipt.PreImageSha256) `
            -AllowManagedVariants)) {
        throw (
            "Launcher rollback cannot verify the old pre-image at " +
            "'$preImagePath'; no target was overwritten or deleted."
        )
    }

    $targetState =
        Get-ManagedLauncherShortcutPathState -Path $targetPath
    if ($targetState.Exists) {
        $rollbackCapture =
            Join-Path $parent (
                ".$([guid]::NewGuid().ToString('N')).rollback.lnk"
            )
        try {
            Move-ManagedLauncherShortcutNoOverwrite `
                -Source $targetPath `
                -Destination $rollbackCapture
        } catch {
            $suffix = if ($isUpgrade) {
                " The old pre-image was preserved at '$preImagePath'."
            } else {
                ''
            }
            throw (
                "Launcher rollback could not capture '$targetPath' without " +
                "overwrite: $($_.Exception.Message).$suffix"
            )
        }
        if (Test-ManagedLauncherShortcutReceiptFile `
            -Definition $Definition `
            -PreviousDefinition $PreviousDefinition `
            -Path $rollbackCapture `
            -ExpectedSha256 ([string]$Receipt.InstalledSha256)) {
            Remove-ManagedLauncherShortcutReceiptFile `
                -Definition $Definition `
                -PreviousDefinition $PreviousDefinition `
                -Path $rollbackCapture `
                -ExpectedSha256 ([string]$Receipt.InstalledSha256)
        } else {
            try {
                Move-ManagedLauncherShortcutNoOverwrite `
                    -Source $rollbackCapture `
                    -Destination $targetPath
            } catch {
                $upgradeSuffix = if ($isUpgrade) {
                    " The old pre-image was preserved at '$preImagePath'."
                } else {
                    ''
                }
                throw (
                    'Launcher rollback preserved a competing target and the ' +
                    "captured foreign item at '$rollbackCapture'; recovery " +
                    "did not overwrite either item.$upgradeSuffix"
                )
            }
            $foreignSuffix = if ($isUpgrade) {
                " The old pre-image was preserved at '$preImagePath'."
            } else {
                ''
            }
            throw (
                'Launcher rollback found a foreign target; the foreign target ' +
                "was restored without overwrite.$foreignSuffix"
            )
        }
    }

    if ($isUpgrade) {
        try {
            Move-ManagedLauncherShortcutNoOverwrite `
                -Source $preImagePath `
                -Destination $targetPath
        } catch {
            throw (
                'Launcher rollback did not overwrite a competing target; ' +
                "the old pre-image was preserved at '$preImagePath'."
            )
        }
        if (-not (Test-ManagedLauncherShortcutReceiptFile `
            -Definition $Definition `
            -PreviousDefinition $PreviousDefinition `
            -Path $targetPath `
            -ExpectedSha256 ([string]$Receipt.PreImageSha256) `
            -AllowManagedVariants)) {
            throw (
                "Launcher rollback moved the old pre-image to '$targetPath' " +
                'but exact read-back verification failed.'
            )
        }
        return [pscustomobject]@{ Status = 'restored-upgrade' }
    }
    return [pscustomobject]@{ Status = 'removed-created' }
}

function Install-ManagedLauncherShortcut {
    param(
        [Parameter(Mandatory)][object]$Definition,
        [AllowNull()][object]$PreviousDefinition
    )

    $targetPath = [System.IO.Path]::GetFullPath(
        [string]$Definition.ShortcutPath
    )
    $upgradeExisting = $false
    $targetState =
        Get-ManagedLauncherShortcutPathState -Path $targetPath
    if ($targetState.Exists) {
        Assert-ManagedLauncherShortcutOwnership `
            -Definition $Definition `
            -PreviousDefinition $PreviousDefinition `
            -Path $targetPath
        if (Test-ManagedLauncherShortcut `
            -Definition $Definition `
            -Path $targetPath) {
            return [pscustomobject]@{
                Status = 'reused'
                ShortcutPath = $targetPath
            }
        }
        $upgradeExisting = $true
    }
    $parent = [System.IO.Path]::GetDirectoryName($targetPath)
    $null = [System.IO.Directory]::CreateDirectory($parent)
    $temporary = Join-Path $parent ".$([guid]::NewGuid().ToString('N')).lnk"
    $shell = $null
    $shortcut = $null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($temporary)
        $shortcut.TargetPath = [string]$Definition.TargetPath
        $shortcut.Arguments = [string]$Definition.Arguments
        $shortcut.WorkingDirectory = [string]$Definition.WorkingDirectory
        $shortcut.Description = [string]$Definition.Description
        $shortcut.IconLocation = [string]$Definition.IconLocation
        $shortcut.WindowStyle = [int]$Definition.WindowStyle
        $shortcut.Save()
    } finally {
        if ($null -ne $shortcut) {
            $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
        }
        if ($null -ne $shell) {
            $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
        }
    }
    if ([bool]$Definition.RunAsUser) {
        Set-ManagedLauncherShortcutRunAsUser -Path $temporary
    }
    $preImage = $null
    $preImageSha256 = $null
    $preImageCaptured = $false
    $temporarySha256 = $null
    try {
        if (-not (Test-ManagedLauncherShortcut `
            -Definition $Definition `
            -Path $temporary)) {
            throw 'The newly created Codex Remote launcher shortcut failed exact verification.'
        }
        $temporarySha256 =
            Get-ManagedLauncherShortcutSha256 -Path $temporary
        if (-not (Test-ManagedLauncherShortcutReceiptFile `
            -Definition $Definition `
            -PreviousDefinition $PreviousDefinition `
            -Path $temporary `
            -ExpectedSha256 $temporarySha256)) {
            throw 'The newly created launcher receipt failed exact verification.'
        }

        if ($upgradeExisting) {
            Assert-ManagedLauncherShortcutOwnership `
                -Definition $Definition `
                -PreviousDefinition $PreviousDefinition `
                -Path $targetPath
            if (Test-ManagedLauncherShortcut `
                -Definition $Definition `
                -Path $targetPath) {
                return [pscustomobject]@{
                    Status = 'reused'
                    ShortcutPath = $targetPath
                }
            }

            $preImage =
                Join-Path $parent (
                    ".$([guid]::NewGuid().ToString('N')).preimage.lnk"
                )
            Move-ManagedLauncherShortcutNoOverwrite `
                -Source $targetPath `
                -Destination $preImage
            $preImageCaptured = $true
            try {
                Assert-ManagedLauncherShortcutOwnership `
                    -Definition $Definition `
                    -PreviousDefinition $PreviousDefinition `
                    -Path $preImage
                $preImageSha256 =
                    Get-ManagedLauncherShortcutSha256 -Path $preImage
                if (-not (Test-ManagedLauncherShortcutReceiptFile `
                    -Definition $Definition `
                    -PreviousDefinition $PreviousDefinition `
                    -Path $preImage `
                    -ExpectedSha256 $preImageSha256 `
                    -AllowManagedVariants)) {
                    throw 'captured pre-image did not remain exact'
                }
            } catch {
                throw (
                    'Launcher shortcut changed during managed upgrade; ' +
                    "the captured item is at '$preImage'."
                )
            }
        }

        Move-ManagedLauncherShortcutNoOverwrite `
            -Source $temporary `
            -Destination $targetPath
        if (-not (Test-ManagedLauncherShortcut `
            -Definition $Definition `
            -Path $targetPath)) {
            throw 'The installed Codex Remote launcher shortcut failed exact verification.'
        }
        $installedSha256 =
            Get-ManagedLauncherShortcutSha256 -Path $targetPath
        if (-not (Test-ManagedLauncherShortcutReceiptFile `
                -Definition $Definition `
                -PreviousDefinition $PreviousDefinition `
                -Path $targetPath `
                -ExpectedSha256 $installedSha256)) {
            throw 'The installed Codex Remote launcher receipt failed exact verification.'
        }
        return [pscustomobject]@{
            Status = if ($upgradeExisting) { 'upgraded' } else { 'created' }
            ShortcutPath = $targetPath
            InstalledSha256 = $installedSha256
            PreImagePath = $preImage
            PreImageSha256 = $preImageSha256
        }
    } catch {
        $transactionFailure = $_.Exception.Message
        if ($preImageCaptured) {
            $preImageState =
                Get-ManagedLauncherShortcutPathState -Path $preImage
            $currentTargetState =
                Get-ManagedLauncherShortcutPathState -Path $targetPath
            if ($preImageState.Exists -and
                -not $currentTargetState.Exists) {
                try {
                    Move-ManagedLauncherShortcutNoOverwrite `
                        -Source $preImage `
                        -Destination $targetPath
                    $preImageCaptured = $false
                    $transactionFailure +=
                        ' The captured item was restored without overwrite.'
                } catch {
                    $transactionFailure += (
                        ' Recovery did not overwrite a competing target; ' +
                        "the pre-image was preserved at '$preImage'."
                    )
                }
            } elseif ($preImageState.Exists) {
                $transactionFailure += (
                    ' A competing target was preserved and the pre-image was ' +
                    "preserved at '$preImage'."
                )
            } else {
                $transactionFailure +=
                    ' The captured pre-image is no longer present.'
            }
        }
        throw $transactionFailure
    } finally {
        if (-not [string]::IsNullOrWhiteSpace($temporarySha256) -and
            (Test-ManagedLauncherShortcutReceiptFile `
                -Definition $Definition `
                -PreviousDefinition $PreviousDefinition `
                -Path $temporary `
                -ExpectedSha256 $temporarySha256)) {
            Remove-ManagedLauncherShortcutReceiptFile `
                -Definition $Definition `
                -PreviousDefinition $PreviousDefinition `
                -Path $temporary `
                -ExpectedSha256 $temporarySha256
        }
    }
}

function Test-RegistrationTaskXmlRuntimeRoot {
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

function Get-RegistrationRuntimeTaskPairState {
    param(
        [Parameter(Mandatory)]
        [object]$OldRuntime,

        [Parameter(Mandatory)]
        [string]$OldTaskXmlSha256,

        [Parameter(Mandatory)]
        [object]$SelectedRuntime
    )

    try {
        $task = Get-ScheduledTask `
            -TaskName $TaskName `
            -TaskPath '\' `
            -ErrorAction Stop
        $taskXml = [string](
            Export-ScheduledTask `
                -TaskName $TaskName `
                -TaskPath '\' `
                -ErrorAction Stop
        )
        $pointer = Get-CodexLocalRemoteCurrentRuntime `
            -DataDir $expected.DataDir
        if ($null -eq $pointer) {
            throw 'runtime pointer is absent'
        }
        $taskOwnership = Test-ExistingTaskOwnership -Task $task
        $taskXmlSha256 = Get-StringSha256 -Value $taskXml
        $taskMatchesOld = (
            $taskXmlSha256 -ceq $OldTaskXmlSha256 -and
            (Test-RegistrationTaskXmlRuntimeRoot `
                -Xml $taskXml `
                -ExpectedRoot ([string]$OldRuntime.RuntimeRoot) `
                -ForbiddenRoot ([string]$SelectedRuntime.RuntimeRoot))
        )
        $taskMatchesSelected = (
            $taskOwnership.IsManaged -and
            [string]$taskOwnership.Kind -ceq 'current' -and
            (Test-RegistrationTaskXmlRuntimeRoot `
                -Xml $taskXml `
                -ExpectedRoot ([string]$SelectedRuntime.RuntimeRoot) `
                -ForbiddenRoot ([string]$OldRuntime.RuntimeRoot))
        )
        $pointerRuntimeMatchesOld = (
            [string]$pointer.CurrentVersionId -ceq
                [string]$OldRuntime.VersionId -and
            [string]::Equals(
                [System.IO.Path]::GetFullPath(
                    [string]$pointer.CurrentRoot
                ),
                [System.IO.Path]::GetFullPath(
                    [string]$OldRuntime.RuntimeRoot
                ),
                [System.StringComparison]::OrdinalIgnoreCase
            )
        )
        $pointerBindingMatchesOld = (
            [bool]$pointer.HasCurrentTaskDefinition -and
            [string]$pointer.CurrentTaskDefinitionTaskName -ceq
                $TaskName -and
            [string]$pointer.CurrentTaskDefinitionRuntimeVersionId -ceq
                [string]$OldRuntime.VersionId -and
            [string]::Equals(
                [System.IO.Path]::GetFullPath(
                    [string]$pointer.CurrentTaskDefinitionRuntimeRoot
                ),
                [System.IO.Path]::GetFullPath(
                    [string]$OldRuntime.RuntimeRoot
                ),
                [System.StringComparison]::OrdinalIgnoreCase
            ) -and
            [string]$pointer.CurrentTaskDefinitionSha256 -ceq
                $OldTaskXmlSha256
        )
        $pointerMatchesOld = (
            $pointerRuntimeMatchesOld -and
            $pointerBindingMatchesOld
        )
        $pointerRuntimeMatchesSelected = (
            [string]$pointer.CurrentVersionId -ceq
                [string]$SelectedRuntime.VersionId -and
            [string]::Equals(
                [System.IO.Path]::GetFullPath(
                    [string]$pointer.CurrentRoot
                ),
                [System.IO.Path]::GetFullPath(
                    [string]$SelectedRuntime.RuntimeRoot
                ),
                [System.StringComparison]::OrdinalIgnoreCase
            )
        )
        $pointerBindingMatchesSelected = (
            [bool]$pointer.HasCurrentTaskDefinition -and
            [string]$pointer.CurrentTaskDefinitionTaskName -ceq
                $TaskName -and
            [string]$pointer.CurrentTaskDefinitionRuntimeVersionId -ceq
                [string]$SelectedRuntime.VersionId -and
            [string]::Equals(
                [System.IO.Path]::GetFullPath(
                    [string]$pointer.CurrentTaskDefinitionRuntimeRoot
                ),
                [System.IO.Path]::GetFullPath(
                    [string]$SelectedRuntime.RuntimeRoot
                ),
                [System.StringComparison]::OrdinalIgnoreCase
            ) -and
            [string]$pointer.CurrentTaskDefinitionSha256 -ceq
                $taskXmlSha256
        )
        $pointerMatchesSelected = (
            $pointerRuntimeMatchesSelected -and
            $pointerBindingMatchesSelected
        )
        return [pscustomobject]@{
            Kind = if ($taskMatchesOld -and $pointerMatchesOld) {
                'old'
            } elseif ($taskMatchesSelected -and
                $pointerMatchesSelected) {
                'selected'
            } else {
                'mixed'
            }
            TaskMatchesOld = $taskMatchesOld
            TaskMatchesSelected = $taskMatchesSelected
            PointerMatchesOld = $pointerMatchesOld
            PointerRuntimeMatchesOld = $pointerRuntimeMatchesOld
            PointerBindingMatchesOld = $pointerBindingMatchesOld
            PointerMatchesSelected = $pointerMatchesSelected
            PointerRuntimeMatchesSelected =
                $pointerRuntimeMatchesSelected
            PointerBindingMatchesSelected =
                $pointerBindingMatchesSelected
            TaskXmlSha256 = $taskXmlSha256
            Failure = $null
        }
    } catch {
        return [pscustomobject]@{
            Kind = 'invalid'
            TaskMatchesOld = $false
            TaskMatchesSelected = $false
            PointerMatchesOld = $false
            PointerRuntimeMatchesOld = $false
            PointerBindingMatchesOld = $false
            PointerMatchesSelected = $false
            PointerRuntimeMatchesSelected = $false
            PointerBindingMatchesSelected = $false
            TaskXmlSha256 = $null
            Failure = $_.Exception.Message
        }
    }
}

function Set-RegistrationSelectedRuntimeTaskBinding {
    param(
        [Parameter(Mandatory)]
        [object]$SelectedRuntime,

        [AllowNull()]
        [object]$TaskPreImage
    )

    $task = Get-ScheduledTask `
        -TaskName $TaskName `
        -TaskPath '\' `
        -ErrorAction Stop
    $taskOwnership = Test-ExistingTaskOwnership -Task $task
    $taskXml = [string](
        Export-ScheduledTask `
            -TaskName $TaskName `
            -TaskPath '\' `
            -ErrorAction Stop
    )
    $forbiddenRoot = if ($null -eq $TaskPreImage) {
        $null
    } else {
        [string]$TaskPreImage.RuntimeRoot
    }
    if (-not $taskOwnership.IsManaged -or
        [string]$taskOwnership.Kind -cne 'current' -or
        -not (Test-RegistrationTaskXmlRuntimeRoot `
            -Xml $taskXml `
            -ExpectedRoot ([string]$SelectedRuntime.RuntimeRoot) `
            -ForbiddenRoot $forbiddenRoot)) {
        throw 'The selected scheduled task failed exact managed-definition verification before binding.'
    }
    $binding = [pscustomobject]@{
        TaskName = $TaskName
        RuntimeVersionId = [string]$SelectedRuntime.VersionId
        RuntimeRoot = [string]$SelectedRuntime.RuntimeRoot
        XmlSha256 = Get-StringSha256 -Value $taskXml
    }
    $pointer = Get-CodexLocalRemoteCurrentRuntime `
        -DataDir $expected.DataDir
    if ($null -ne $pointer -and
        [string]$pointer.CurrentVersionId -ceq
            [string]$SelectedRuntime.VersionId) {
        return Set-CodexLocalRemoteCurrentRuntime `
            -DataDir $expected.DataDir `
            -Runtime $SelectedRuntime `
            -CurrentTaskDefinition $binding
    }
    if ($null -eq $TaskPreImage -and
        $null -ne $pointer) {
        throw 'Changing runtime identity requires an exact prior task pre-image.'
    }
    return Set-CodexLocalRemoteCurrentRuntime `
        -DataDir $expected.DataDir `
        -Runtime $SelectedRuntime `
        -PreviousTaskPreImage $TaskPreImage `
        -CurrentTaskDefinition $binding
}

function Test-RegistrationOptionalPathEqual {
    param(
        [AllowNull()]
        [string]$Left,

        [AllowNull()]
        [string]$Right
    )

    if ([string]::IsNullOrWhiteSpace($Left) -or
        [string]::IsNullOrWhiteSpace($Right)) {
        return (
            [string]::IsNullOrWhiteSpace($Left) -and
            [string]::IsNullOrWhiteSpace($Right)
        )
    }
    return [string]::Equals(
        [System.IO.Path]::GetFullPath($Left),
        [System.IO.Path]::GetFullPath($Right),
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Get-RegistrationRuntimeBindingBaseline {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('absent', 'managed')]
        [string]$ExpectedTaskState
    )

    $task = Get-ScheduledTask `
        -TaskName $TaskName `
        -TaskPath '\' `
        -ErrorAction SilentlyContinue
    if ($ExpectedTaskState -ceq 'absent' -and $null -ne $task) {
        throw "Scheduled task '$TaskName' appeared before its registration transaction."
    }
    if ($ExpectedTaskState -ceq 'managed') {
        $ownership = Test-ExistingTaskOwnership -Task $task
        if ($null -eq $task -or -not $ownership.IsManaged) {
            throw "Scheduled task '$TaskName' changed before its binding transaction."
        }
    }
    $taskXml = if ($null -eq $task) {
        $null
    } else {
        [string](
            Export-ScheduledTask `
                -TaskName $TaskName `
                -TaskPath '\' `
                -ErrorAction Stop
        )
    }
    $pointer = Get-CodexLocalRemoteCurrentRuntime `
        -DataDir $expected.DataDir
    return [pscustomobject]@{
        TaskPresent = $null -ne $task
        TaskXml = $taskXml
        TaskXmlSha256 = if ($null -eq $task) {
            $null
        } else {
            Get-StringSha256 -Value $taskXml
        }
        PointerPresent = $null -ne $pointer
        Pointer = $pointer
    }
}

function Get-RegistrationSelectedRuntimeBindingState {
    param(
        [Parameter(Mandatory)]
        [object]$SelectedRuntime
    )

    try {
        $task = Get-ScheduledTask `
            -TaskName $TaskName `
            -TaskPath '\' `
            -ErrorAction SilentlyContinue
        $pointer = Get-CodexLocalRemoteCurrentRuntime `
            -DataDir $expected.DataDir
        $taskXml = if ($null -eq $task) {
            $null
        } else {
            [string](
                Export-ScheduledTask `
                    -TaskName $TaskName `
                    -TaskPath '\' `
                    -ErrorAction Stop
            )
        }
        $taskXmlSha256 = if ($null -eq $task) {
            $null
        } else {
            Get-StringSha256 -Value $taskXml
        }
        $ownership = Test-ExistingTaskOwnership -Task $task
        $taskMatchesSelected = (
            $null -ne $task -and
            $ownership.IsManaged -and
            [string]$ownership.Kind -ceq 'current' -and
            (Test-RegistrationTaskXmlRuntimeRoot `
                -Xml $taskXml `
                -ExpectedRoot ([string]$SelectedRuntime.RuntimeRoot) `
                -ForbiddenRoot $null)
        )
        $pointerMatchesSelected = (
            $null -ne $pointer -and
            [string]$pointer.CurrentVersionId -ceq
                [string]$SelectedRuntime.VersionId -and
            (Test-RegistrationOptionalPathEqual `
                -Left ([string]$pointer.CurrentRoot) `
                -Right ([string]$SelectedRuntime.RuntimeRoot)) -and
            [bool]$pointer.HasCurrentTaskDefinition -and
            [string]$pointer.CurrentTaskDefinitionTaskName -ceq
                $TaskName -and
            [string]$pointer.CurrentTaskDefinitionRuntimeVersionId -ceq
                [string]$SelectedRuntime.VersionId -and
            (Test-RegistrationOptionalPathEqual `
                -Left (
                    [string]$pointer.CurrentTaskDefinitionRuntimeRoot
                ) `
                -Right ([string]$SelectedRuntime.RuntimeRoot)) -and
            [string]$pointer.CurrentTaskDefinitionSha256 -ceq
                $taskXmlSha256
        )
        return [pscustomobject]@{
            Kind = if ($taskMatchesSelected -and
                $pointerMatchesSelected) {
                'selected'
            } elseif ($null -eq $task -and $null -eq $pointer) {
                'absent'
            } else {
                'mixed'
            }
            Task = $task
            TaskXml = $taskXml
            TaskXmlSha256 = $taskXmlSha256
            TaskMatchesSelected = $taskMatchesSelected
            Pointer = $pointer
            PointerMatchesSelected = $pointerMatchesSelected
            Failure = $null
        }
    } catch {
        return [pscustomobject]@{
            Kind = 'invalid'
            Task = $null
            TaskXml = $null
            TaskXmlSha256 = $null
            TaskMatchesSelected = $false
            Pointer = $null
            PointerMatchesSelected = $false
            Failure = $_.Exception.Message
        }
    }
}

function Test-RegistrationCreatedRuntimePointer {
    param(
        [AllowNull()]
        [object]$Pointer,

        [Parameter(Mandatory)]
        [object]$SelectedRuntime,

        [Parameter(Mandatory)]
        [string]$SelectedTaskXmlSha256
    )

    if ($null -eq $Pointer -or
        [string]$Pointer.CurrentVersionId -cne
            [string]$SelectedRuntime.VersionId -or
        -not (Test-RegistrationOptionalPathEqual `
            -Left ([string]$Pointer.CurrentRoot) `
            -Right ([string]$SelectedRuntime.RuntimeRoot)) -or
        $null -ne $Pointer.PreviousVersionId -or
        [bool]$Pointer.HasPreviousTaskPreImage) {
        return $false
    }
    if (-not [bool]$Pointer.HasCurrentTaskDefinition) {
        return $true
    }
    return (
        [string]$Pointer.CurrentTaskDefinitionTaskName -ceq $TaskName -and
        [string]$Pointer.CurrentTaskDefinitionRuntimeVersionId -ceq
            [string]$SelectedRuntime.VersionId -and
        (Test-RegistrationOptionalPathEqual `
            -Left ([string]$Pointer.CurrentTaskDefinitionRuntimeRoot) `
            -Right ([string]$SelectedRuntime.RuntimeRoot)) -and
        [string]$Pointer.CurrentTaskDefinitionSha256 -ceq
            $SelectedTaskXmlSha256
    )
}

function Test-RegistrationRuntimeBindingBaselineState {
    param(
        [Parameter(Mandatory)]
        [object]$Baseline
    )

    try {
        $task = Get-ScheduledTask `
            -TaskName $TaskName `
            -TaskPath '\' `
            -ErrorAction SilentlyContinue
        $taskMatches = if ([bool]$Baseline.TaskPresent) {
            if ($null -eq $task) {
                $false
            } else {
                $taskXml = [string](
                    Export-ScheduledTask `
                        -TaskName $TaskName `
                        -TaskPath '\' `
                        -ErrorAction Stop
                )
                $taskXml -ceq [string]$Baseline.TaskXml -and
                (Get-StringSha256 -Value $taskXml) -ceq
                    [string]$Baseline.TaskXmlSha256
            }
        } else {
            $null -eq $task
        }
        $pointer = Get-CodexLocalRemoteCurrentRuntime `
            -DataDir $expected.DataDir
        $pointerMatches = if ([bool]$Baseline.PointerPresent) {
            $baselinePointer = $Baseline.Pointer
            $null -ne $pointer -and
            [string]$pointer.Signature -ceq
                [string]$baselinePointer.Signature -and
            [int]$pointer.Version -eq
                [int]$baselinePointer.Version -and
            [string]$pointer.CurrentVersionId -ceq
                [string]$baselinePointer.CurrentVersionId -and
            (Test-RegistrationOptionalPathEqual `
                -Left ([string]$pointer.CurrentRoot) `
                -Right ([string]$baselinePointer.CurrentRoot)) -and
            [string]$pointer.CurrentManifestSha256 -ceq
                [string]$baselinePointer.CurrentManifestSha256 -and
            [string]$pointer.PreviousVersionId -ceq
                [string]$baselinePointer.PreviousVersionId -and
            (Test-RegistrationOptionalPathEqual `
                -Left ([string]$pointer.PreviousRoot) `
                -Right ([string]$baselinePointer.PreviousRoot)) -and
            [string]$pointer.PreviousManifestSha256 -ceq
                [string]$baselinePointer.PreviousManifestSha256 -and
            [bool]$pointer.HasPreviousTaskPreImage -eq
                [bool]$baselinePointer.HasPreviousTaskPreImage -and
            [string]$pointer.PreviousTaskPreImageSha256 -ceq
                [string]$baselinePointer.PreviousTaskPreImageSha256 -and
            [string]$pointer.PreviousTaskPreImageTaskName -ceq
                [string]$baselinePointer.PreviousTaskPreImageTaskName -and
            [string]$pointer.PreviousTaskPreImageRuntimeVersionId -ceq
                [string](
                    $baselinePointer.PreviousTaskPreImageRuntimeVersionId
                ) -and
            (Test-RegistrationOptionalPathEqual `
                -Left (
                    [string]$pointer.PreviousTaskPreImageRuntimeRoot
                ) `
                -Right (
                    [string]$baselinePointer.PreviousTaskPreImageRuntimeRoot
                )) -and
            [bool]$pointer.HasCurrentTaskDefinition -eq
                [bool]$baselinePointer.HasCurrentTaskDefinition -and
            [string]$pointer.CurrentTaskDefinitionTaskName -ceq
                [string]$baselinePointer.CurrentTaskDefinitionTaskName -and
            [string]$pointer.CurrentTaskDefinitionRuntimeVersionId -ceq
                [string]$baselinePointer.CurrentTaskDefinitionRuntimeVersionId -and
            (Test-RegistrationOptionalPathEqual `
                -Left (
                    [string]$pointer.CurrentTaskDefinitionRuntimeRoot
                ) `
                -Right (
                    [string]$baselinePointer.CurrentTaskDefinitionRuntimeRoot
                )) -and
            [string]$pointer.CurrentTaskDefinitionSha256 -ceq
                [string]$baselinePointer.CurrentTaskDefinitionSha256
        } else {
            $null -eq $pointer
        }
        return [pscustomobject]@{
            IsExact = $taskMatches -and $pointerMatches
            TaskMatches = $taskMatches
            PointerMatches = $pointerMatches
            Failure = $null
        }
    } catch {
        return [pscustomobject]@{
            IsExact = $false
            TaskMatches = $false
            PointerMatches = $false
            Failure = $_.Exception.Message
        }
    }
}

function Restore-RegistrationRuntimeBindingBaseline {
    param(
        [Parameter(Mandatory)]
        [object]$Baseline,

        [Parameter(Mandatory)]
        [object]$SelectedRuntime
    )

    $selectedState =
        Get-RegistrationSelectedRuntimeBindingState `
            -SelectedRuntime $SelectedRuntime
    $selectedTaskXmlSha256 = [string]$selectedState.TaskXmlSha256
    $baselineState =
        Test-RegistrationRuntimeBindingBaselineState `
            -Baseline $Baseline
    if (-not $baselineState.TaskMatches) {
        if ([bool]$Baseline.TaskPresent) {
            if ($null -ne $selectedState.Task -and
                -not $selectedState.TaskMatchesSelected) {
                throw 'The scheduled task changed before exact baseline restoration.'
            }
            Register-ScheduledTask `
                -TaskName $TaskName `
                -TaskPath '\' `
                -Xml ([string]$Baseline.TaskXml) `
                -Force | Out-Null
        } else {
            if (-not $selectedState.TaskMatchesSelected) {
                throw 'The newly created scheduled task is no longer exact; refusing to remove it.'
            }
            Unregister-ScheduledTask `
                -TaskName $TaskName `
                -TaskPath '\' `
                -Confirm:$false
        }
    }

    $baselineState =
        Test-RegistrationRuntimeBindingBaselineState `
            -Baseline $Baseline
    if (-not $baselineState.PointerMatches) {
        if ([bool]$Baseline.PointerPresent) {
            $baselinePointer = $Baseline.Pointer
            $binding = if (
                [bool]$baselinePointer.HasCurrentTaskDefinition
            ) {
                [pscustomobject]@{
                    TaskName =
                        [string]$baselinePointer.CurrentTaskDefinitionTaskName
                    RuntimeVersionId =
                        [string]$baselinePointer.CurrentTaskDefinitionRuntimeVersionId
                    RuntimeRoot =
                        [string]$baselinePointer.CurrentTaskDefinitionRuntimeRoot
                    XmlSha256 =
                        [string]$baselinePointer.CurrentTaskDefinitionSha256
                }
            } else {
                $null
            }
            $null = Set-CodexLocalRemoteCurrentRuntime `
                -DataDir $expected.DataDir `
                -Runtime ([pscustomobject]@{
                    VersionId = [string]$baselinePointer.CurrentVersionId
                    RuntimeRoot = [string]$baselinePointer.CurrentRoot
                }) `
                -CurrentTaskDefinition $binding
        } else {
            $selectedState =
                Get-RegistrationSelectedRuntimeBindingState `
                    -SelectedRuntime $SelectedRuntime
            if (-not (Test-RegistrationCreatedRuntimePointer `
                -Pointer $selectedState.Pointer `
                -SelectedRuntime $SelectedRuntime `
                -SelectedTaskXmlSha256 $selectedTaskXmlSha256)) {
                throw 'The newly created runtime pointer is no longer exact; refusing to remove it.'
            }
            $expectedPointerPath = [System.IO.Path]::GetFullPath(
                (Join-Path $expected.DataDir 'runtime-current.json')
            )
            $pointerPath = [System.IO.Path]::GetFullPath(
                [string]$selectedState.Pointer.PointerPath
            )
            $pointerItem =
                Get-Item -LiteralPath $pointerPath -Force -ErrorAction Stop
            if (-not [string]::Equals(
                    $pointerPath,
                    $expectedPointerPath,
                    [System.StringComparison]::OrdinalIgnoreCase
                ) -or
                ($pointerItem.Attributes -band
                    [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'The newly created runtime pointer path is not exact.'
            }
            $selectedState =
                Get-RegistrationSelectedRuntimeBindingState `
                    -SelectedRuntime $SelectedRuntime
            if (-not (Test-RegistrationCreatedRuntimePointer `
                -Pointer $selectedState.Pointer `
                -SelectedRuntime $SelectedRuntime `
                -SelectedTaskXmlSha256 $selectedTaskXmlSha256)) {
                throw 'The newly created runtime pointer changed before removal.'
            }
            Remove-Item -LiteralPath $pointerPath -Force
        }
    }
}

function Complete-RegistrationRuntimeBindingTransaction {
    param(
        [Parameter(Mandatory)]
        [object]$SelectedRuntime,

        [Parameter(Mandatory)]
        [object]$Baseline,

        [AllowNull()]
        [scriptblock]$PrepareSelectedState
    )

    $failures = [System.Collections.Generic.List[string]]::new()
    $preparationResult = $null
    $selectedState =
        Get-RegistrationSelectedRuntimeBindingState `
            -SelectedRuntime $SelectedRuntime
    if ($null -ne $PrepareSelectedState) {
        foreach ($attempt in 1..2) {
            try {
                $preparationResult = & $PrepareSelectedState
            } catch {
                $failures.Add(
                    "selected preparation attempt $attempt failed: $($_.Exception.Message)"
                )
            }
            $selectedState =
                Get-RegistrationSelectedRuntimeBindingState `
                    -SelectedRuntime $SelectedRuntime
            if ([string]$selectedState.Kind -ceq 'selected') {
                return [pscustomobject]@{
                    Kind = 'selected'
                    Failure = if ($failures.Count -eq 0) {
                        $null
                    } else {
                        $failures -join '; '
                    }
                    PreparationResult = $preparationResult
                }
            }
            if ($selectedState.TaskMatchesSelected) {
                break
            }
        }
    }

    if ($selectedState.TaskMatchesSelected) {
        foreach ($attempt in 1..2) {
            try {
                $null =
                    Set-RegistrationSelectedRuntimeTaskBinding `
                        -SelectedRuntime $SelectedRuntime `
                        -TaskPreImage $null
            } catch {
                $failures.Add(
                    "selected binding attempt $attempt failed: $($_.Exception.Message)"
                )
            }
            $selectedState =
                Get-RegistrationSelectedRuntimeBindingState `
                    -SelectedRuntime $SelectedRuntime
            if ([string]$selectedState.Kind -ceq 'selected') {
                return [pscustomobject]@{
                    Kind = 'selected'
                    Failure = if ($failures.Count -eq 0) {
                        $null
                    } else {
                        $failures -join '; '
                    }
                    PreparationResult = $preparationResult
                }
            }
        }
    }

    try {
        Restore-RegistrationRuntimeBindingBaseline `
            -Baseline $Baseline `
            -SelectedRuntime $SelectedRuntime
    } catch {
        $failures.Add(
            "exact baseline restoration failed: $($_.Exception.Message)"
        )
    }
    $baselineState =
        Test-RegistrationRuntimeBindingBaselineState `
            -Baseline $Baseline
    if ($baselineState.IsExact) {
        $baselineKind = if (-not $Baseline.TaskPresent -and
            -not $Baseline.PointerPresent) {
            'absent'
        } else {
            'old'
        }
        throw (
            "Selected runtime task binding failed; the exact $baselineKind " +
            "registration baseline was preserved or restored " +
            "('$($failures -join '; ')')."
        )
    }
    $selectedState =
        Get-RegistrationSelectedRuntimeBindingState `
            -SelectedRuntime $SelectedRuntime
    if ([string]$selectedState.Kind -ceq 'selected') {
        return [pscustomobject]@{
            Kind = 'selected'
            Failure = $failures -join '; '
            PreparationResult = $preparationResult
        }
    }
    throw (
        'Selected runtime task binding failed; neither the exact baseline ' +
        "nor selected task/pointer pair was verified " +
        "('$($failures -join '; ')'; '$([string]$baselineState.Failure)')."
    )
}

function Resolve-RegistrationPendingRuntimeAction {
    param(
        [AllowNull()]
        [string]$ActiveVersionId,

        [AllowNull()]
        [string]$CurrentVersionId,

        [AllowNull()]
        [string]$PreviousVersionId,

        [Parameter(Mandatory)]
        [string]$CandidateVersionId,

        [AllowNull()]
        [string]$RepairActiveVersionId,

        [AllowNull()]
        [string]$SupersedeOfflineSelectedVersionId
    )

    if (-not [string]::IsNullOrWhiteSpace($RepairActiveVersionId) -and
        -not [string]::IsNullOrWhiteSpace(
            $SupersedeOfflineSelectedVersionId
        )) {
        return [pscustomobject]@{
            Action = 'block'
            Reason = 'repair and offline supersession are mutually exclusive'
        }
    }
    if ([string]::IsNullOrWhiteSpace($CurrentVersionId)) {
        if (-not [string]::IsNullOrWhiteSpace($RepairActiveVersionId)) {
            return [pscustomobject]@{
                Action = 'block'
                Reason = 'repair requires an existing selected runtime pointer'
            }
        }
        if (-not [string]::IsNullOrWhiteSpace(
            $SupersedeOfflineSelectedVersionId
        )) {
            return [pscustomobject]@{
                Action = 'block'
                Reason = 'offline supersession requires an existing selected runtime pointer'
            }
        }
        return [pscustomobject]@{
            Action = 'continue'
            Reason = 'no selected runtime pointer exists'
        }
    }
    if ([string]::IsNullOrWhiteSpace($ActiveVersionId)) {
        if (-not [string]::IsNullOrWhiteSpace($RepairActiveVersionId)) {
            return [pscustomobject]@{
                Action = 'block'
                Reason = 'repair requires one live exact active runtime'
            }
        }
        if (-not [string]::IsNullOrWhiteSpace(
            $SupersedeOfflineSelectedVersionId
        )) {
            if ($SupersedeOfflineSelectedVersionId -cne $CurrentVersionId) {
                return [pscustomobject]@{
                    Action = 'block'
                    Reason = 'requested offline supersession runtime does not match the selected runtime'
                }
            }
            if ($CandidateVersionId -ceq $CurrentVersionId) {
                return [pscustomobject]@{
                    Action = 'block'
                    Reason = 'offline supersession requires a different candidate runtime'
                }
            }
            if ([string]::IsNullOrWhiteSpace($PreviousVersionId)) {
                return [pscustomobject]@{
                    Action = 'block'
                    Reason = 'offline supersession requires a rollback ancestor'
                }
            }
            return [pscustomobject]@{
                Action = 'supersede-offline-selected'
                Reason = 'supersede the exact offline selected runtime while preserving its rollback ancestor'
            }
        }
        if ($CandidateVersionId -ceq $CurrentVersionId) {
            return [pscustomobject]@{
                Action = 'same-selected'
                Reason = 'the same selected runtime may converge without a live generation'
            }
        }
        return [pscustomobject]@{
            Action = 'block'
            Reason = if ([string]::IsNullOrWhiteSpace($PreviousVersionId)) {
                'an offline selected runtime is not proven active'
            } else {
                'an offline selected runtime with a rollback ancestor may still be pending'
            }
        }
    }
    if (-not [string]::IsNullOrWhiteSpace(
        $SupersedeOfflineSelectedVersionId
    )) {
        return [pscustomobject]@{
            Action = 'block'
            Reason = 'offline supersession requires no live active runtime'
        }
    }
    if ($ActiveVersionId -ceq $CurrentVersionId) {
        if (-not [string]::IsNullOrWhiteSpace($RepairActiveVersionId)) {
            return [pscustomobject]@{
                Action = 'block'
                Reason = 'repair was requested but the selected runtime is already active'
            }
        }
        return [pscustomobject]@{
            Action = 'continue'
            Reason = 'selected runtime is active'
        }
    }
    if ($CandidateVersionId -ceq $CurrentVersionId -and
        [string]::IsNullOrWhiteSpace($RepairActiveVersionId)) {
        return [pscustomobject]@{
            Action = 'same-selected'
            Reason = 'the same pending runtime may converge idempotently'
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($RepairActiveVersionId)) {
        if ($RepairActiveVersionId -cne $ActiveVersionId) {
            return [pscustomobject]@{
                Action = 'block'
                Reason = 'requested repair runtime does not match the live active runtime'
            }
        }
        return [pscustomobject]@{
            Action = 'repair-active'
            Reason = 'repair the selected pointer to the proven active runtime'
        }
    }
    $relationship = if ($PreviousVersionId -ceq $ActiveVersionId) {
        'the selected runtime is pending over its active rollback ancestor'
    } else {
        'the live active runtime is outside the selected rollback pair'
    }
    return [pscustomobject]@{
        Action = 'block'
        Reason = $relationship
    }
}

function Get-RegistrationActiveRuntimeEvidence {
    $listeners = @(
        if ($env:CODEX_REMOTE_TEST_FIXTURE -ceq '1') {
            Get-NetTCPConnection `
                -State Listen `
                -LocalPort $BrokerPort `
                -ErrorAction SilentlyContinue
        } else {
            Get-CodexLocalRemoteTcpListenerSnapshot `
                -LocalPorts @($BrokerPort)
        }
    )
    $nonLoopback = @(
        $listeners |
            Where-Object {
                -not (Test-IsLoopbackListenerAddress -Address $_.LocalAddress)
            }
    )
    if ($nonLoopback.Count -gt 0) {
        throw 'Pending runtime admission found a non-loopback Broker listener.'
    }
    $managedListeners = @(Get-ManagedIpv4Listeners -Listeners $listeners)
    $listenerPids = @(
        $managedListeners |
            Select-Object -ExpandProperty OwningProcess -Unique
    )
    if ($managedListeners.Count -eq 0) {
        return $null
    }
    if ($managedListeners.Count -ne 1 -or $listenerPids.Count -ne 1) {
        throw 'Pending runtime admission found ambiguous Broker listener ownership.'
    }

    $receiptPath = Join-Path $expected.DataDir 'app-server-broker.json'
    if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
        throw 'A live Broker listener has no managed runtime receipt.'
    }
    $item = Get-Item -LiteralPath $receiptPath -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [long]$item.Length -lt 32 -or
        [long]$item.Length -gt 65536) {
        throw 'The active Broker runtime receipt is not an ordinary bounded file.'
    }
    $rawBefore = Get-Content -LiteralPath $receiptPath -Raw -Encoding utf8
    $receipt = $rawBefore |
        ConvertFrom-Json -Depth 20 -DateKind String -ErrorAction Stop
    $runtimeInvocationId = [string]$receipt.RuntimeInvocationId
    $brokerReceipt = $receipt.Broker
    $bootstrapReceipt = $receipt.Bootstrap
    if ([string]$receipt.Signature -cne
            'codex-local-remote/app-server-broker/v3' -or
        [int]$receipt.Version -ne 3 -or
        [string]$receipt.Status -cnotin @('broker-ready', 'ready') -or
        $runtimeInvocationId -cnotmatch '^[0-9a-f]{32}$' -or
        $null -eq $brokerReceipt -or
        $null -eq $bootstrapReceipt -or
        [string]$brokerReceipt.RuntimeInvocationId -cne
            $runtimeInvocationId -or
        [string]$bootstrapReceipt.RuntimeInvocationId -cne
            $runtimeInvocationId -or
        [int]$receipt.ProcessId -ne [int]$brokerReceipt.ProcessId -or
        [int]$brokerReceipt.ProcessId -ne [int]$listenerPids[0] -or
        [long]$brokerReceipt.CreationDateUtcTicks -le 0 -or
        [long]$receipt.CreationDateUtcTicks -ne
            [long]$brokerReceipt.CreationDateUtcTicks) {
        throw 'The active Broker runtime receipt has an invalid identity shape.'
    }

    $resolvedNode = [System.IO.Path]::GetFullPath($NodePath)
    if (-not [string]::Equals(
        [System.IO.Path]::GetFullPath([string]$receipt.NodePath),
        $resolvedNode,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'The active Broker receipt names a different Node runtime.'
    }
    $brokerCli = [System.IO.Path]::GetFullPath(
        [string]$receipt.BrokerCliPath
    )
    $activeRoot = $brokerCli
    foreach ($level in 1..4) {
        $null = $level
        $activeRoot = Split-Path -Parent $activeRoot
    }
    $activeRoot = [System.IO.Path]::GetFullPath($activeRoot)
    $activeVersionId = Split-Path -Leaf $activeRoot
    if ($activeVersionId -cnotmatch '^[a-f0-9]{64}$') {
        throw 'The active Broker receipt is outside an immutable runtime version.'
    }
    $expectedActiveRoot = [System.IO.Path]::GetFullPath(
        (Join-Path (
            Join-Path ([System.IO.Path]::GetFullPath($expected.DataDir)) (
                'RuntimeVersions'
            )
        ) $activeVersionId)
    )
    if (-not [string]::Equals(
        $activeRoot,
        $expectedActiveRoot,
        [System.StringComparison]::OrdinalIgnoreCase
    ) -or
        -not [string]::Equals(
            $brokerCli,
            [System.IO.Path]::GetFullPath(
                (Join-Path $activeRoot 'apps\broker\dist\cli.js')
            ),
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'The active Broker receipt has an inconsistent immutable runtime root.'
    }
    $runtimeValidation = Test-CodexLocalRemoteRuntimeVersion `
        -RuntimeRoot $activeRoot `
        -ExpectedVersionId $activeVersionId
    if (-not $runtimeValidation.IsValid) {
        throw (
            'The active Broker immutable runtime failed exact verification: ' +
            [string]$runtimeValidation.Reason
        )
    }

    $process = Get-CimInstance `
        Win32_Process `
        -Filter "ProcessId = $([int]$brokerReceipt.ProcessId)" `
        -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        throw 'The active Broker receipt process is no longer live.'
    }
    if ([string]::IsNullOrWhiteSpace([string]$process.ExecutablePath) -or
        [string]::IsNullOrWhiteSpace([string]$process.CommandLine)) {
        throw (
            'The active Broker process details are unavailable. Re-run this ' +
            'script from an Administrator terminal or through Windows ' +
            'sudo/UAC so the Highest-owned process can be verified.'
        )
    }
    $creation = Get-ProcessCreationIdentity `
        -CreationDate $process.CreationDate
    if ([long]$creation.CreationDateUtcTicks -ne
        [long]$brokerReceipt.CreationDateUtcTicks) {
        throw 'The active Broker receipt process creation identity changed.'
    }
    $ownership = Test-ManagedBrokerProcess `
        -CommandLine ([string]$process.CommandLine) `
        -ExecutablePath ([string]$process.ExecutablePath) `
        -ExpectedNodePath $resolvedNode `
        -ExpectedBrokerCliPath $brokerCli `
        -BrokerPort $BrokerPort `
        -UpstreamPort $BrokerUpstreamPort `
        -ExpectedCodexPath (
            [System.IO.Path]::GetFullPath([string]$receipt.CodexPath)
        ) `
        -DataDir ([System.IO.Path]::GetFullPath($expected.DataDir)) `
        -CapabilityTokenFilePath (
            Get-BrokerCapabilityTokenPath -DataDir $expected.DataDir
        )
    if (-not $ownership.IsManaged) {
        throw (
            'The active Broker process failed exact ownership verification (' +
            [string]$ownership.Reason + ').'
        )
    }
    $rawAfter = Get-Content -LiteralPath $receiptPath -Raw -Encoding utf8
    if ($rawBefore -cne $rawAfter) {
        throw 'The active Broker runtime receipt changed during admission.'
    }
    return [pscustomobject]@{
        VersionId = $activeVersionId
        RuntimeRoot = $activeRoot
        ManifestSha256 = [string]$runtimeValidation.ManifestSha256
        RuntimeInvocationId = $runtimeInvocationId
        BrokerProcessId = [int]$brokerReceipt.ProcessId
        BrokerCreationDateUtcTicks =
            [long]$brokerReceipt.CreationDateUtcTicks
    }
}

function Test-RegistrationRuntimePointerSnapshot {
    param(
        [AllowNull()]
        [object]$Actual,

        [AllowNull()]
        [object]$Expected
    )

    if ($null -eq $Actual -or $null -eq $Expected) {
        return $null -eq $Actual -and $null -eq $Expected
    }
    foreach ($property in @(
        'Signature',
        'Version',
        'CurrentVersionId',
        'CurrentManifestSha256',
        'PreviousVersionId',
        'PreviousManifestSha256',
        'HasPreviousTaskPreImage',
        'PreviousTaskPreImageSha256',
        'PreviousTaskPreImageTaskName',
        'PreviousTaskPreImageRuntimeVersionId',
        'HasCurrentTaskDefinition',
        'CurrentTaskDefinitionSha256',
        'CurrentTaskDefinitionTaskName',
        'CurrentTaskDefinitionRuntimeVersionId'
    )) {
        if ([string]$Actual.$property -cne [string]$Expected.$property) {
            return $false
        }
    }
    foreach ($property in @(
        'CurrentRoot',
        'PreviousRoot',
        'PreviousTaskPreImageRuntimeRoot',
        'CurrentTaskDefinitionRuntimeRoot',
        'PointerPath'
    )) {
        if (-not (Test-RegistrationOptionalPathEqual `
            -Left ([string]$Actual.$property) `
            -Right ([string]$Expected.$property))) {
            return $false
        }
    }
    return $true
}

function Test-RegistrationActiveRuntimeSnapshot {
    param(
        [AllowNull()]
        [object]$Actual,

        [Parameter(Mandatory)]
        [object]$Expected
    )

    return (
        $null -ne $Actual -and
        [string]$Actual.VersionId -ceq [string]$Expected.VersionId -and
        (Test-RegistrationOptionalPathEqual `
            -Left ([string]$Actual.RuntimeRoot) `
            -Right ([string]$Expected.RuntimeRoot)) -and
        [string]$Actual.ManifestSha256 -ceq
            [string]$Expected.ManifestSha256 -and
        [string]$Actual.RuntimeInvocationId -ceq
            [string]$Expected.RuntimeInvocationId -and
        [int]$Actual.BrokerProcessId -eq
            [int]$Expected.BrokerProcessId -and
        [long]$Actual.BrokerCreationDateUtcTicks -eq
            [long]$Expected.BrokerCreationDateUtcTicks
    )
}

function New-RegistrationRepairActivePointerSnapshot {
    param(
        [Parameter(Mandatory)]
        [object]$ActiveRuntime,

        [Parameter(Mandatory)]
        [object]$SelectedPointer,

        [Parameter(Mandatory)]
        [string]$SelectedTaskXmlSha256,

        [Parameter(Mandatory)]
        [string]$ActiveTaskXmlSha256,

        [Parameter(Mandatory)]
        [string]$PointerPath
    )

    return [pscustomobject]@{
        Signature = [string]$SelectedPointer.Signature
        Version = [int]$SelectedPointer.Version
        CurrentVersionId = [string]$ActiveRuntime.VersionId
        CurrentRoot = [string]$ActiveRuntime.RuntimeRoot
        CurrentManifestSha256 = [string]$ActiveRuntime.ManifestSha256
        PreviousVersionId = [string]$SelectedPointer.CurrentVersionId
        PreviousRoot = [string]$SelectedPointer.CurrentRoot
        PreviousManifestSha256 =
            [string]$SelectedPointer.CurrentManifestSha256
        HasPreviousTaskPreImage = $true
        PreviousTaskPreImageSha256 = $SelectedTaskXmlSha256
        PreviousTaskPreImageTaskName = $TaskName
        PreviousTaskPreImageRuntimeVersionId =
            [string]$SelectedPointer.CurrentVersionId
        PreviousTaskPreImageRuntimeRoot =
            [string]$SelectedPointer.CurrentRoot
        HasCurrentTaskDefinition = $true
        CurrentTaskDefinitionSha256 = $ActiveTaskXmlSha256
        CurrentTaskDefinitionTaskName = $TaskName
        CurrentTaskDefinitionRuntimeVersionId =
            [string]$ActiveRuntime.VersionId
        CurrentTaskDefinitionRuntimeRoot =
            [string]$ActiveRuntime.RuntimeRoot
        PointerPath = $PointerPath
    }
}

function Get-RegistrationRepairTaskSnapshot {
    $task = Get-ScheduledTask `
        -TaskName $TaskName `
        -TaskPath '\' `
        -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        throw 'Pending runtime repair requires the selected managed task.'
    }
    $taskXml = [string](
        Export-ScheduledTask `
            -TaskName $TaskName `
            -TaskPath '\' `
            -ErrorAction Stop
    )
    return [pscustomobject]@{
        Task = $task
        State = [string]$task.State
        Xml = $taskXml
        XmlSha256 = Get-StringSha256 -Value $taskXml
    }
}

function Get-RegistrationRepairTaskEvidence {
    param(
        [Parameter(Mandatory)]
        [object]$Pointer
    )

    $snapshot = Get-RegistrationRepairTaskSnapshot
    $task = $snapshot.Task
    $definition = Get-StartupTaskDefinition `
        -TaskName $TaskName `
        -NodePath $NodePath `
        -PwshPath $PwshPath `
        -InstallRoot ([string]$Pointer.CurrentRoot) `
        -DataDir $expected.DataDir `
        -Port $Port `
        -BrokerPort $BrokerPort `
        -BrokerUpstreamPort $BrokerUpstreamPort `
        -BasePath $BasePath
    $ownership = Test-ManagedStartupTask `
        -Task $task `
        -Expected $definition
    $taskXml = [string]$snapshot.Xml
    $taskXmlSha256 = [string]$snapshot.XmlSha256
    if (-not $ownership.IsManaged -or
        -not [bool]$Pointer.HasCurrentTaskDefinition -or
        [string]$Pointer.CurrentTaskDefinitionTaskName -cne $TaskName -or
        [string]$Pointer.CurrentTaskDefinitionRuntimeVersionId -cne
            [string]$Pointer.CurrentVersionId -or
        -not (Test-RegistrationOptionalPathEqual `
            -Left (
                [string]$Pointer.CurrentTaskDefinitionRuntimeRoot
            ) `
            -Right ([string]$Pointer.CurrentRoot)) -or
        [string]$Pointer.CurrentTaskDefinitionSha256 -cne
            $taskXmlSha256 -or
        -not (Test-RegistrationTaskXmlRuntimeRoot `
            -Xml $taskXml `
            -ExpectedRoot ([string]$Pointer.CurrentRoot) `
            -ForbiddenRoot $null)) {
        throw 'The selected task and runtime pointer are not one exact managed binding.'
    }
    return [pscustomobject]@{
        Task = $task
        State = [string]$snapshot.State
        Definition = $definition
        Xml = $taskXml
        XmlSha256 = $taskXmlSha256
    }
}

function Assert-RegistrationOfflineSelectedSupersession {
    param(
        [Parameter(Mandatory)]
        [object]$SelectedPointer,

        [Parameter(Mandatory)]
        [ValidatePattern('^[a-f0-9]{64}$')]
        [string]$ExpectedVersionId
    )

    if ([string]$SelectedPointer.CurrentVersionId -cne $ExpectedVersionId -or
        [string]$SelectedPointer.PreviousVersionId -cnotmatch
            '^[a-f0-9]{64}$' -or
        [string]$SelectedPointer.PreviousVersionId -ceq $ExpectedVersionId) {
        throw (
            'Offline selected runtime supersession requires the exact ' +
            'selected runtime and one distinct rollback ancestor.'
        )
    }
    if ($null -ne (Get-RegistrationActiveRuntimeEvidence)) {
        throw 'Offline selected runtime supersession requires no live active runtime.'
    }
    $desiredMode = Get-CodexLocalRemoteDesiredMode `
        -DataDir $expected.DataDir
    if ([string]$desiredMode.Mode -cne 'Native') {
        throw 'Offline selected runtime supersession requires Native desired mode.'
    }
    $taskEvidence = Get-RegistrationRepairTaskEvidence `
        -Pointer $SelectedPointer
    if ([string]$taskEvidence.State -cne 'Ready') {
        throw 'Offline selected runtime supersession requires the selected task to be Ready.'
    }

    $freshPointer = Get-CodexLocalRemoteCurrentRuntime `
        -DataDir $expected.DataDir
    if (-not (Test-RegistrationRuntimePointerSnapshot `
        -Actual $freshPointer `
        -Expected $SelectedPointer)) {
        throw 'The selected runtime pointer changed during offline supersession admission.'
    }
    $freshTaskEvidence = Get-RegistrationRepairTaskEvidence `
        -Pointer $freshPointer
    if ([string]$freshTaskEvidence.State -cne 'Ready' -or
        [string]$freshTaskEvidence.XmlSha256 -cne
            [string]$taskEvidence.XmlSha256) {
        throw 'The selected task changed during offline supersession admission.'
    }
    $freshDesiredMode = Get-CodexLocalRemoteDesiredMode `
        -DataDir $expected.DataDir
    if ([string]$freshDesiredMode.Mode -cne 'Native') {
        throw 'Native desired mode changed during offline supersession admission.'
    }
    if ($null -ne (Get-RegistrationActiveRuntimeEvidence)) {
        throw 'A live active runtime appeared during offline supersession admission.'
    }
    return $freshPointer
}

function Repair-RegistrationPendingRuntimeFromActive {
    param(
        [Parameter(Mandatory)]
        [object]$ActiveRuntime,

        [Parameter(Mandatory)]
        [object]$SelectedPointer
    )

    if ([string]$ActiveRuntime.VersionId -cnotmatch '^[a-f0-9]{64}$' -or
        [string]$SelectedPointer.CurrentVersionId -ceq
            [string]$ActiveRuntime.VersionId -or
        [string]$SelectedPointer.CurrentVersionId -cnotmatch
            '^[a-f0-9]{64}$') {
        throw 'Pending runtime repair identities are invalid or already converged.'
    }
    $pointerPath = [System.IO.Path]::GetFullPath(
        [string]$SelectedPointer.PointerPath
    )
    $expectedPointerPath = [System.IO.Path]::GetFullPath(
        (Join-Path $expected.DataDir 'runtime-current.json')
    )
    $pointerItem = Get-Item `
        -LiteralPath $pointerPath `
        -Force `
        -ErrorAction Stop
    if (-not [string]::Equals(
        $pointerPath,
        $expectedPointerPath,
        [System.StringComparison]::OrdinalIgnoreCase
    ) -or
        $pointerItem.PSIsContainer -or
        ($pointerItem.Attributes -band
            [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [long]$pointerItem.Length -lt 32 -or
        [long]$pointerItem.Length -gt 262144) {
        throw 'Pending runtime repair pointer is not the exact ordinary managed file.'
    }
    $pointerRaw = Get-Content `
        -LiteralPath $pointerPath `
        -Raw `
        -Encoding utf8
    $pointerPreImage = $pointerRaw |
        ConvertFrom-Json -Depth 20 -DateKind String -ErrorAction Stop
    $selectedTask = Get-RegistrationRepairTaskEvidence `
        -Pointer $SelectedPointer
    $initialTaskState = [string]$selectedTask.State
    if ($initialTaskState -cnotin @('Ready', 'Running')) {
        throw "Pending runtime repair refuses selected task state '$initialTaskState'."
    }
    $selectedTaskWasRunning = $initialTaskState -ceq 'Running'

    $freshActive = Get-RegistrationActiveRuntimeEvidence
    if (-not (Test-RegistrationActiveRuntimeSnapshot `
        -Actual $freshActive `
        -Expected $ActiveRuntime)) {
        throw 'The active runtime changed before pending repair.'
    }
    $freshPointer = Get-CodexLocalRemoteCurrentRuntime `
        -DataDir $expected.DataDir
    if (-not (Test-RegistrationRuntimePointerSnapshot `
        -Actual $freshPointer `
        -Expected $SelectedPointer)) {
        throw 'The selected runtime pointer changed before pending repair.'
    }
    $freshTask = Get-RegistrationRepairTaskEvidence `
        -Pointer $freshPointer
    if ([string]$freshTask.XmlSha256 -cne
        [string]$selectedTask.XmlSha256 -or
        [string]$freshTask.State -cne $initialTaskState -or
        (Get-Content -LiteralPath $pointerPath -Raw -Encoding utf8) -cne
            $pointerRaw) {
        throw 'The selected task or pointer file changed before pending repair.'
    }

    $activeDefinition = Get-StartupTaskDefinition `
        -TaskName $TaskName `
        -NodePath $NodePath `
        -PwshPath $PwshPath `
        -InstallRoot ([string]$ActiveRuntime.RuntimeRoot) `
        -DataDir $expected.DataDir `
        -Port $Port `
        -BrokerPort $BrokerPort `
        -BrokerUpstreamPort $BrokerUpstreamPort `
        -BasePath $BasePath
    $activeAction = New-ScheduledTaskAction `
        -Execute $activeDefinition.TaskExecute `
        -Argument $activeDefinition.TaskArguments `
        -WorkingDirectory $activeDefinition.WorkingDirectory
    $activePrincipal = New-ScheduledTaskPrincipal `
        -UserId $activeDefinition.PrincipalUserSid `
        -LogonType Interactive `
        -RunLevel Highest
    $activeSettings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
        -MultipleInstances IgnoreNew `
        -StartWhenAvailable:$false `
        -DisallowDemandStart:$false `
        -RunOnlyIfIdle:$false `
        -RunOnlyIfNetworkAvailable:$false `
        -Disable:$false
    $activeTaskXmlSha256 = $null
    $activePointerExpected = $null
    $activeBinding = $null
    $selectedPreImage = [pscustomobject]@{
        TaskName = $TaskName
        RuntimeVersionId =
            [string]$SelectedPointer.CurrentVersionId
        RuntimeRoot = [string]$SelectedPointer.CurrentRoot
        Xml = [string]$selectedTask.Xml
        XmlSha256 = [string]$selectedTask.XmlSha256
    }
    $repairFailure = $null
    try {
        Register-ScheduledTask `
            -TaskName $TaskName `
            -TaskPath '\' `
            -Action $activeAction `
            -Principal $activePrincipal `
            -Settings $activeSettings `
            -Description $activeDefinition.Description `
            -Force | Out-Null
        $activeTask = Get-ScheduledTask `
            -TaskName $TaskName `
            -TaskPath '\' `
            -ErrorAction Stop
        $activeOwnership = Test-ManagedStartupTask `
            -Task $activeTask `
            -Expected $activeDefinition
        $activeTaskXml = [string](
            Export-ScheduledTask `
                -TaskName $TaskName `
                -TaskPath '\' `
                -ErrorAction Stop
        )
        $activeTaskXmlSha256 =
            Get-StringSha256 -Value $activeTaskXml
        if (-not $activeOwnership.IsManaged -or
            [string]$activeTask.State -cne $initialTaskState -or
            -not (Test-RegistrationTaskXmlRuntimeRoot `
                -Xml $activeTaskXml `
                -ExpectedRoot ([string]$ActiveRuntime.RuntimeRoot) `
                -ForbiddenRoot ([string]$SelectedPointer.CurrentRoot))) {
            throw 'The active task failed exact verification after repair registration.'
        }
        $activeBinding = [pscustomobject]@{
            TaskName = $TaskName
            RuntimeVersionId = [string]$ActiveRuntime.VersionId
            RuntimeRoot = [string]$ActiveRuntime.RuntimeRoot
            XmlSha256 = $activeTaskXmlSha256
        }
        $activePointerExpected =
            New-RegistrationRepairActivePointerSnapshot `
                -ActiveRuntime $ActiveRuntime `
                -SelectedPointer $SelectedPointer `
                -SelectedTaskXmlSha256 ([string]$selectedTask.XmlSha256) `
                -ActiveTaskXmlSha256 $activeTaskXmlSha256 `
                -PointerPath $pointerPath
        $prePointerActive = Get-RegistrationActiveRuntimeEvidence
        if (-not (Test-RegistrationActiveRuntimeSnapshot `
            -Actual $prePointerActive `
            -Expected $ActiveRuntime)) {
            throw 'The active runtime changed before the repaired pointer could be published.'
        }
        $null = Set-CodexLocalRemoteCurrentRuntime `
            -DataDir $expected.DataDir `
            -Runtime $ActiveRuntime `
            -PreviousTaskPreImage $selectedPreImage `
            -CurrentTaskDefinition $activeBinding
        $readBack = Get-CodexLocalRemoteCurrentRuntime `
            -DataDir $expected.DataDir
        if (-not (Test-RegistrationRuntimePointerSnapshot `
            -Actual $readBack `
            -Expected $activePointerExpected)) {
            throw 'Pending runtime repair failed exact active read-back verification.'
        }
        $postRepairActive = Get-RegistrationActiveRuntimeEvidence
        $postRepairTask = Get-RegistrationRepairTaskEvidence `
            -Pointer $readBack
        if (-not (Test-RegistrationActiveRuntimeSnapshot `
                -Actual $postRepairActive `
                -Expected $ActiveRuntime) -or
            [string]$postRepairTask.State -cne $initialTaskState) {
            throw 'The active runtime or running task changed during pending repair.'
        }
        return $readBack
    } catch {
        $repairFailure = $_.Exception.Message
    }

    $rollbackNotes = [System.Collections.Generic.List[string]]::new()
    $currentTaskSnapshot = $null
    try {
        $currentTaskSnapshot = Get-RegistrationRepairTaskSnapshot
    } catch {
        $rollbackNotes.Add(
            "task audit failed: $($_.Exception.Message)"
        )
    }
    if ($null -ne $currentTaskSnapshot -and
        [string]::IsNullOrWhiteSpace($activeTaskXmlSha256) -and
        [string]$currentTaskSnapshot.XmlSha256 -cne
            [string]$selectedTask.XmlSha256) {
        $observedActiveOwnership = Test-ManagedStartupTask `
            -Task $currentTaskSnapshot.Task `
            -Expected $activeDefinition
        if ($observedActiveOwnership.IsManaged -and
            (Test-RegistrationTaskXmlRuntimeRoot `
                -Xml ([string]$currentTaskSnapshot.Xml) `
                -ExpectedRoot ([string]$ActiveRuntime.RuntimeRoot) `
                -ForbiddenRoot ([string]$SelectedPointer.CurrentRoot))) {
            $activeTaskXmlSha256 =
                [string]$currentTaskSnapshot.XmlSha256
            $activeBinding = [pscustomobject]@{
                TaskName = $TaskName
                RuntimeVersionId = [string]$ActiveRuntime.VersionId
                RuntimeRoot = [string]$ActiveRuntime.RuntimeRoot
                XmlSha256 = $activeTaskXmlSha256
            }
            $activePointerExpected =
                New-RegistrationRepairActivePointerSnapshot `
                    -ActiveRuntime $ActiveRuntime `
                    -SelectedPointer $SelectedPointer `
                    -SelectedTaskXmlSha256 (
                        [string]$selectedTask.XmlSha256
                    ) `
                    -ActiveTaskXmlSha256 $activeTaskXmlSha256 `
                    -PointerPath $pointerPath
        }
    }
    $getTaskBindingKind = {
        param([AllowNull()][object]$Snapshot)

        if ($null -eq $Snapshot) {
            return 'unknown'
        }
        if ([string]$Snapshot.XmlSha256 -ceq
            [string]$selectedTask.XmlSha256) {
            return 'selected'
        }
        if (-not [string]::IsNullOrWhiteSpace(
                $activeTaskXmlSha256
            ) -and
            [string]$Snapshot.XmlSha256 -ceq
                $activeTaskXmlSha256) {
            return 'active'
        }
        return 'unknown'
    }
    $getPointerBindingKind = {
        param([AllowNull()][object]$Pointer)

        if (Test-RegistrationRuntimePointerSnapshot `
            -Actual $Pointer `
            -Expected $SelectedPointer) {
            return 'selected'
        }
        if ($null -ne $activePointerExpected -and
            (Test-RegistrationRuntimePointerSnapshot `
                -Actual $Pointer `
                -Expected $activePointerExpected)) {
            return 'active'
        }
        return 'unknown'
    }

    $currentTaskKind = & $getTaskBindingKind $currentTaskSnapshot
    if ($currentTaskKind -ceq 'active') {
        try {
            Register-ScheduledTask `
                -TaskName $TaskName `
                -TaskPath '\' `
                -Xml ([string]$selectedTask.Xml) `
                -Force | Out-Null
        } catch {
            $rollbackNotes.Add(
                "selected task restore reported: $($_.Exception.Message)"
            )
        }
        try {
            $currentTaskSnapshot =
                Get-RegistrationRepairTaskSnapshot
        } catch {
            $currentTaskSnapshot = $null
            $rollbackNotes.Add(
                "selected task read-back failed: $($_.Exception.Message)"
            )
        }
        $currentTaskKind = & $getTaskBindingKind $currentTaskSnapshot
    }

    $currentPointer = $null
    try {
        $currentPointer = Get-CodexLocalRemoteCurrentRuntime `
            -DataDir $expected.DataDir
    } catch {
        $rollbackNotes.Add(
            "pointer audit failed: $($_.Exception.Message)"
        )
    }
    $currentPointerKind = & $getPointerBindingKind $currentPointer

    if ($currentTaskKind -ceq 'selected' -and
        $currentPointerKind -ceq 'active') {
        try {
            Write-AtomicJsonFile `
                -Path $pointerPath `
                -Value $pointerPreImage
        } catch {
            $rollbackNotes.Add(
                "selected pointer restore reported: $($_.Exception.Message)"
            )
        }
        try {
            $currentPointer = Get-CodexLocalRemoteCurrentRuntime `
                -DataDir $expected.DataDir
        } catch {
            $currentPointer = $null
            $rollbackNotes.Add(
                "selected pointer read-back failed: $($_.Exception.Message)"
            )
        }
        $currentPointerKind = & $getPointerBindingKind $currentPointer
        if ($currentPointerKind -ceq 'active') {
            try {
                Register-ScheduledTask `
                    -TaskName $TaskName `
                    -TaskPath '\' `
                    -Action $activeAction `
                    -Principal $activePrincipal `
                    -Settings $activeSettings `
                    -Description $activeDefinition.Description `
                    -Force | Out-Null
            } catch {
                $rollbackNotes.Add(
                    "active task convergence reported: $($_.Exception.Message)"
                )
            }
        }
    } elseif ($currentTaskKind -ceq 'active' -and
        $currentPointerKind -ceq 'selected') {
        if ($null -eq $activeBinding -or
            $null -eq $activePointerExpected) {
            $rollbackNotes.Add(
                'active pointer convergence was skipped because its exact binding was unavailable'
            )
        } else {
            try {
                $null = Set-CodexLocalRemoteCurrentRuntime `
                    -DataDir $expected.DataDir `
                    -Runtime $ActiveRuntime `
                    -PreviousTaskPreImage $selectedPreImage `
                    -CurrentTaskDefinition $activeBinding
            } catch {
                $rollbackNotes.Add(
                    "active pointer convergence reported: $($_.Exception.Message)"
                )
            }
        }
        try {
            $currentPointer = Get-CodexLocalRemoteCurrentRuntime `
                -DataDir $expected.DataDir
        } catch {
            $currentPointer = $null
            $rollbackNotes.Add(
                "active pointer read-back failed: $($_.Exception.Message)"
            )
        }
        $currentPointerKind = & $getPointerBindingKind $currentPointer
        if ($currentPointerKind -ceq 'selected') {
            try {
                Register-ScheduledTask `
                    -TaskName $TaskName `
                    -TaskPath '\' `
                    -Xml ([string]$selectedTask.Xml) `
                    -Force | Out-Null
            } catch {
                $rollbackNotes.Add(
                    "selected task convergence reported: $($_.Exception.Message)"
                )
            }
        }
    }

    $finalTaskSnapshot = $null
    $finalPointer = $null
    $finalActive = $null
    try {
        $finalTaskSnapshot = Get-RegistrationRepairTaskSnapshot
    } catch {
        $rollbackNotes.Add(
            "final task audit failed: $($_.Exception.Message)"
        )
    }
    try {
        $finalPointer = Get-CodexLocalRemoteCurrentRuntime `
            -DataDir $expected.DataDir
    } catch {
        $rollbackNotes.Add(
            "final pointer audit failed: $($_.Exception.Message)"
        )
    }
    try {
        $finalActive = Get-RegistrationActiveRuntimeEvidence
    } catch {
        $rollbackNotes.Add(
            "live continuity audit failed: $($_.Exception.Message)"
        )
    }
    $finalTaskKind = & $getTaskBindingKind $finalTaskSnapshot
    $finalPointerKind = & $getPointerBindingKind $finalPointer
    $finalPairKind = if ($finalTaskKind -ceq $finalPointerKind -and
        $finalTaskKind -cin @('selected', 'active')) {
        $finalTaskKind
    } else {
        'mixed-or-unknown'
    }
    $taskStatePreserved = (
        $null -ne $finalTaskSnapshot -and
        [string]$finalTaskSnapshot.State -ceq $initialTaskState
    )
    $liveContinuityPreserved =
        Test-RegistrationActiveRuntimeSnapshot `
            -Actual $finalActive `
            -Expected $ActiveRuntime
    if ($finalPairKind -cin @('selected', 'active') -and
        $taskStatePreserved -and
        $liveContinuityPreserved) {
        $noteSuffix = if ($rollbackNotes.Count -eq 0) {
            ''
        } else {
            " Recovery notes: $($rollbackNotes -join '; ')."
        }
        throw (
            "Pending runtime repair failed ('$repairFailure'); the exact " +
            "$finalPairKind task/pointer pair and live runtime were " +
            "preserved.$noteSuffix"
        )
    }
    $incomplete = [System.Collections.Generic.List[string]]::new()
    if ($finalPairKind -eq 'mixed-or-unknown') {
        $incomplete.Add(
            "configuration pair is task=$finalTaskKind pointer=$finalPointerKind"
        )
    }
    if (-not $taskStatePreserved) {
        $observedState = if ($null -eq $finalTaskSnapshot) {
            'missing'
        } else {
            [string]$finalTaskSnapshot.State
        }
        $incomplete.Add(
            "task state is '$observedState', expected '$initialTaskState'"
        )
    }
    if (-not $liveContinuityPreserved) {
        $incomplete.Add('live runtime continuity verification failed')
    }
    foreach ($note in $rollbackNotes) {
        $incomplete.Add($note)
    }
    throw (
        "Pending runtime repair failed ('$repairFailure'); rollback was " +
        "incomplete ('$($incomplete -join '; ')')."
    )
}

function Invoke-RegistrationPendingRuntimeGate {
    param(
        [Parameter(Mandatory)]
        [object]$CandidateRuntime,

        [AllowNull()]
        [string]$RepairActiveVersionId,

        [AllowNull()]
        [string]$SupersedeOfflineSelectedVersionId
    )

    $pointer = Get-CodexLocalRemoteCurrentRuntime `
        -DataDir $expected.DataDir
    $active = Get-RegistrationActiveRuntimeEvidence
    $action = Resolve-RegistrationPendingRuntimeAction `
        -ActiveVersionId $(if ($null -eq $active) {
            $null
        } else {
            [string]$active.VersionId
        }) `
        -CurrentVersionId $(if ($null -eq $pointer) {
            $null
        } else {
            [string]$pointer.CurrentVersionId
        }) `
        -PreviousVersionId $(if ($null -eq $pointer) {
            $null
        } else {
            [string]$pointer.PreviousVersionId
        }) `
        -CandidateVersionId ([string]$CandidateRuntime.VersionId) `
        -RepairActiveVersionId $RepairActiveVersionId `
        -SupersedeOfflineSelectedVersionId (
            $SupersedeOfflineSelectedVersionId
        )
    if ([string]$action.Action -ceq 'block') {
        throw (
            'Pending immutable runtime admission blocked before mutation: ' +
            [string]$action.Reason + '.'
        )
    }
    if ([string]$action.Action -ceq 'supersede-offline-selected') {
        $pointer = Assert-RegistrationOfflineSelectedSupersession `
            -SelectedPointer $pointer `
            -ExpectedVersionId $SupersedeOfflineSelectedVersionId
    }
    return [pscustomobject]@{
        Action = [string]$action.Action
        ActiveRuntime = $active
        Pointer = $pointer
    }
}

# Real registration must cross the elevation boundary before inspecting any
# Highest-owned live process. Otherwise WMI can redact ExecutablePath and
# CommandLine, turning "process details unavailable" into a misleading
# executable-mismatch. WhatIf remains read-only and reports unavailable live
# details explicitly when the caller cannot inspect the Highest-owned process.
if (-not $WhatIfPreference) {
    Assert-HighestRunLevelRegistrationAllowed
}

$registrationPendingGate = $null
if ($useImmutableRuntime) {
    $registrationPendingGate = Invoke-RegistrationPendingRuntimeGate `
        -CandidateRuntime $runtimePlan `
        -RepairActiveVersionId (
            $RepairPendingRuntimeFromActiveVersionId
        ) `
        -SupersedeOfflineSelectedVersionId (
            $SupersedeOfflineSelectedRuntimeVersionId
        )
    if ([string]$registrationPendingGate.Action -ceq 'repair-active') {
        if (-not $PSCmdlet.ShouldProcess(
            $TaskName,
            'Repair the pending immutable runtime pointer to the proven active generation'
        )) {
            return [pscustomobject]@{
                Status = 'what-if-pending-runtime-repair'
                TaskName = $TaskName
                RuntimeVersionId = [string]$runtimePlan.VersionId
                DataDir = [string]$expected.DataDir
            }
        }
        Assert-HighestRunLevelRegistrationAllowed
        $repairActiveSnapshot = $registrationPendingGate.ActiveRuntime
        $repairedPointer = Repair-RegistrationPendingRuntimeFromActive `
            -ActiveRuntime $registrationPendingGate.ActiveRuntime `
            -SelectedPointer $registrationPendingGate.Pointer
        $activeRuntimeBefore = $repairedPointer
        $registrationPendingGate = Invoke-RegistrationPendingRuntimeGate `
            -CandidateRuntime $runtimePlan `
            -RepairActiveVersionId $null `
            -SupersedeOfflineSelectedVersionId $null
        if ([string]$registrationPendingGate.Action -cne 'continue' -or
            -not (Test-RegistrationActiveRuntimeSnapshot `
                -Actual $registrationPendingGate.ActiveRuntime `
                -Expected $repairActiveSnapshot) -or
            -not (Test-RegistrationRuntimePointerSnapshot `
                -Actual $registrationPendingGate.Pointer `
                -Expected $repairedPointer)) {
            throw 'Pending runtime repair did not converge to one exact active generation.'
        }
    }
} elseif (-not [string]::IsNullOrWhiteSpace(
        $RepairPendingRuntimeFromActiveVersionId
    ) -or -not [string]::IsNullOrWhiteSpace(
        $SupersedeOfflineSelectedRuntimeVersionId
    )) {
    throw 'Pending runtime recovery requires immutable runtime registration.'
}

$existing = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
$ownership = [pscustomobject]@{ IsManaged = $true; Kind = 'none'; Mismatches = @() }
if ($null -ne $existing) {
    $ownership = Test-ExistingTaskOwnership -Task $existing
    if (-not $ownership.IsManaged) {
        throw "Scheduled task '$TaskName' exists but is not the exact managed task ($($ownership.Mismatches -join ', ')); refusing to overwrite it."
    }
    if ($ownership.Kind -ceq 'legacy-v1') {
        throw "Scheduled task '$TaskName' is the exact V1 task. Use Migrate-CodexLocalRemoteSharedOwner.ps1; refusing an in-place registration overwrite."
    }
    if ($ownership.Kind -ceq 'pinned-v2' -and
        [string]$existing.State -ceq 'Running' -and
        $startAfterRegistration) {
        throw "Upgrading the running pinned V2 task cannot request another task instance."
    }
}

$launcherDefinition = Get-ManagedLauncherShortcutDefinition
$previousLauncherDefinitions =
    [System.Collections.Generic.List[object]]::new()
if ($null -ne $activeRuntimeBefore) {
    $previousLauncherDefinitions.Add(
        (Get-ManagedLauncherShortcutDefinition `
            -RuntimeRoot $activeRuntimeBefore.CurrentRoot)
    )
    if (-not [string]::IsNullOrWhiteSpace(
        [string]$activeRuntimeBefore.PreviousRoot
    )) {
        $previousLauncherDefinitions.Add(
            (Get-ManagedLauncherShortcutDefinition `
                -RuntimeRoot $activeRuntimeBefore.PreviousRoot)
        )
    }
} else {
    $previousLauncherDefinitions.Add(
        (Get-ManagedLauncherShortcutDefinition `
            -RuntimeRoot $sourceInstallRoot)
    )
}
if ($null -ne $registrationPendingGate -and
    [string]$registrationPendingGate.Action -ceq 'repair-active' -and
    $null -ne $registrationPendingGate.Pointer -and
    -not [string]::IsNullOrWhiteSpace(
        [string]$registrationPendingGate.Pointer.CurrentRoot
    )) {
    $repairedSelectedDefinition =
        Get-ManagedLauncherShortcutDefinition `
            -RuntimeRoot (
                [string]$registrationPendingGate.Pointer.CurrentRoot
            )
    if (-not (
        $previousLauncherDefinitions |
            Where-Object {
                [string]::Equals(
                    [string]$_.WorkingDirectory,
                    [string]$repairedSelectedDefinition.WorkingDirectory,
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            }
    )) {
        $previousLauncherDefinitions.Add($repairedSelectedDefinition)
    }
}
$previousLauncherDefinition = @($previousLauncherDefinitions)
$requiredRuntimes = @(
    @{ Name = 'PowerShell'; Path = $sourceExpected.Execute },
    @{ Name = 'headless console host'; Path = $sourceExpected.TaskExecute },
    @{ Name = 'Node'; Path = $sourceExpected.Node },
    @{ Name = 'startup bootstrap'; Path = $sourceExpected.Bootstrap },
    @{ Name = 'built shared broker'; Path = $sourceExpected.BrokerCli },
    @{ Name = 'built sidecar'; Path = $sourceExpected.Cli }
)
$launcherIconSourcePath = $null
if (-not $SkipEnvironmentConfiguration) {
    $requiredRuntimes += @{
        Name = 'fail-open Desktop launcher'
        Path = (Join-Path $sourceInstallRoot 'scripts\windows\Launch-CodexWithRemote.ps1')
    }
    $requiredRuntimes += @{
        Name = 'stable Remote control dispatcher'
        Path = (
            Join-Path `
                $sourceInstallRoot `
                'scripts\windows\CodexLocalRemote.Control.ps1'
        )
    }
}
foreach ($runtime in $requiredRuntimes) {
    if (-not (Test-Path -LiteralPath $runtime.Path -PathType Leaf)) {
        throw "$($runtime.Name) not found at '$($runtime.Path)'. Run pnpm build first when applicable."
    }
}

function Install-RegistrationControlDispatcher {
    $controlRuntime =
        Get-CodexLocalRemoteCurrentRuntime -DataDir $expected.DataDir
    if ($null -eq $controlRuntime) {
        throw (
            'Cannot install the control dispatcher without one selected ' +
            'immutable runtime.'
        )
    }
    $controlSourcePath = Join-Path `
        ([string]$controlRuntime.CurrentRoot) `
        'scripts\windows\CodexLocalRemote.Control.ps1'
    return Install-CodexLocalRemoteControlDispatcher `
        -SourcePath $controlSourcePath `
        -DataDir $expected.DataDir
}

function Get-RegistrationOrdinaryFilePreImage {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolvedPath)) {
        return [pscustomobject]@{
            Path = $resolvedPath
            Present = $false
            Bytes = $null
            Sha256 = $null
        }
    }
    $item = Get-Item -LiteralPath $resolvedPath -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        ($item.Attributes -band
            [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [long]$item.Length -gt 1048576) {
        throw 'A registration pre-image is not one ordinary bounded file.'
    }
    return [pscustomobject]@{
        Path = $resolvedPath
        Present = $true
        Bytes = [System.IO.File]::ReadAllBytes($resolvedPath)
        Sha256 = (
            Get-FileHash `
                -LiteralPath $resolvedPath `
                -Algorithm SHA256 `
                -ErrorAction Stop
        ).Hash.ToLowerInvariant()
    }
}

function Restore-RegistrationOrdinaryFilePreImage {
    param(
        [Parameter(Mandatory)]
        [object]$PreImage,

        [Parameter(Mandatory)]
        [ValidatePattern('^[a-f0-9]{64}$')]
        [string]$ExpectedCurrentSha256
    )

    $path = [string]$PreImage.Path
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw 'A registration-owned file disappeared before rollback.'
    }
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        ($item.Attributes -band
            [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'A registration-owned file changed shape before rollback.'
    }
    $currentSha256 = (
        Get-FileHash `
            -LiteralPath $path `
            -Algorithm SHA256 `
            -ErrorAction Stop
    ).Hash.ToLowerInvariant()
    if ($currentSha256 -cne $ExpectedCurrentSha256) {
        throw 'A registration-owned file changed before rollback.'
    }
    if ([bool]$PreImage.Present) {
        $temporaryPath =
            $path + '.rollback.' + [Guid]::NewGuid().ToString('N')
        try {
            [System.IO.File]::WriteAllBytes(
                $temporaryPath,
                [byte[]]$PreImage.Bytes
            )
            [System.IO.File]::Move($temporaryPath, $path, $true)
        } finally {
            Remove-Item `
                -LiteralPath $temporaryPath `
                -Force `
                -ErrorAction SilentlyContinue
        }
        $restoredSha256 = (
            Get-FileHash `
                -LiteralPath $path `
                -Algorithm SHA256 `
                -ErrorAction Stop
        ).Hash.ToLowerInvariant()
        if ($restoredSha256 -cne [string]$PreImage.Sha256) {
            throw 'A registration file pre-image did not verify.'
        }
    } else {
        Remove-Item -LiteralPath $path -Force -ErrorAction Stop
        if (Test-Path -LiteralPath $path) {
            throw 'A newly created registration file was not removed.'
        }
    }
}

$managedConfigurationPreImage =
    Get-RegistrationOrdinaryFilePreImage `
        -Path (Join-Path $expected.DataDir 'managed-config.json')
$desiredModePreImage = if ($SkipEnvironmentConfiguration) {
    $null
} else {
    Get-RegistrationOrdinaryFilePreImage `
        -Path (Get-CodexLocalRemoteDesiredModePath `
            -DataDir $expected.DataDir)
}
$controlDispatcherTargetPreImage = if ($SkipEnvironmentConfiguration) {
    $null
} else {
    Get-RegistrationOrdinaryFilePreImage `
        -Path ([string]$controlDispatcherPreflight.Path)
}
$controlDispatcherReceiptPreImage = if ($SkipEnvironmentConfiguration) {
    $null
} else {
    Get-RegistrationOrdinaryFilePreImage `
        -Path ([string]$controlDispatcherPreflight.ReceiptPath)
}

function Restore-RegistrationAncillaryPreImages {
    param(
        [AllowNull()]
        [string]$ManagedConfigurationSha256,

        [AllowNull()]
        [string]$DesiredModeSha256,

        [AllowNull()]
        [string]$ControlDispatcherSha256
    )

    $failures = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($ManagedConfigurationSha256)) {
        try {
            Restore-RegistrationOrdinaryFilePreImage `
                -PreImage $managedConfigurationPreImage `
                -ExpectedCurrentSha256 $ManagedConfigurationSha256
        } catch {
            $failures.Add('managed configuration')
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($DesiredModeSha256)) {
        try {
            Restore-RegistrationOrdinaryFilePreImage `
                -PreImage $desiredModePreImage `
                -ExpectedCurrentSha256 $DesiredModeSha256
        } catch {
            $failures.Add('desired mode')
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($ControlDispatcherSha256)) {
        try {
            $null =
                Invoke-WithCodexLocalRemoteControlDispatcherMutex `
                    -DataDir $expected.DataDir `
                    -Action {
                        $currentDispatcher =
                            Get-CodexLocalRemoteControlDispatcherState `
                                -DataDir $expected.DataDir
                        if ([string]$currentDispatcher.Status -cne
                                'managed' -or
                            [string]$currentDispatcher.Sha256 -cne
                                $ControlDispatcherSha256) {
                            throw 'The control dispatcher changed before rollback.'
                        }
                        Restore-RegistrationOrdinaryFilePreImage `
                            -PreImage $controlDispatcherTargetPreImage `
                            -ExpectedCurrentSha256 (
                                [string]$currentDispatcher.Sha256
                            )
                        $currentReceiptSha256 = (
                            Get-FileHash `
                                -LiteralPath (
                                    [string]$currentDispatcher.ReceiptPath
                                ) `
                                -Algorithm SHA256 `
                                -ErrorAction Stop
                        ).Hash.ToLowerInvariant()
                        Restore-RegistrationOrdinaryFilePreImage `
                            -PreImage $controlDispatcherReceiptPreImage `
                            -ExpectedCurrentSha256 $currentReceiptSha256
                    }
        } catch {
            $failures.Add('control dispatcher')
        }
    }
    return @($failures)
}

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction `
    -Execute $expected.TaskExecute `
    -Argument $expected.TaskArguments `
    -WorkingDirectory $expected.WorkingDirectory
$principal = New-ScheduledTaskPrincipal `
    -UserId $expected.PrincipalUserSid `
    -LogonType Interactive `
    -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable:$false `
    -DisallowDemandStart:$false `
    -RunOnlyIfIdle:$false `
    -RunOnlyIfNetworkAvailable:$false `
    -Disable:$false

$legacyOverrideStatus = 'not-applied'
$launcherStatus = 'not-applied'
$launcherIconStatus = 'not-applied'
$tokenStatus = 'not-applied'
$controlDispatcherStatus = if ($SkipEnvironmentConfiguration) {
    'fixture-skipped'
} elseif ($WhatIfPreference) {
    'what-if'
} else {
    'not-applied'
}
$startupActivationStatus = 'not-required'
$runtimePackageStatus = if (-not $useImmutableRuntime) {
    'fixture-skipped'
} else {
    'not-applied'
}
$runtimeVersionId = if ($null -eq $runtimePlan) {
    $null
} else {
    [string]$runtimePlan.VersionId
}
$resultStatus = if ($ownership.Kind -ceq 'current') {
    'already-registered'
} else {
    'what-if'
}

if ($ownership.Kind -cin @(
    'current',
    'legacy-auto-start-v5',
    'legacy-headless-v4',
    'legacy-desktop-owner-v3',
    'pre-takeover-v3',
    'limited-v3',
    'pinned-v2',
    'mutable-v5',
    'mutable-auto-start-v5',
    'mutable-v4',
    'mutable-v3',
    'versioned-v5',
    'versioned-auto-start-v5',
    'versioned-v4',
    'versioned-v3'
)) {
    if ($PSCmdlet.ShouldProcess(
        $TaskName,
        "Install and activate the immutable runtime for the managed startup task"
    )) {
        if ($ownership.Kind -cne 'current') {
            Assert-HighestRunLevelRegistrationAllowed
        }
        $runtimeBindingBaseline = if ($useImmutableRuntime) {
            Get-RegistrationRuntimeBindingBaseline `
                -ExpectedTaskState 'managed'
        } else {
            $null
        }
        if ($useImmutableRuntime -and
            $null -ne $registrationPendingGate -and
            [string]$registrationPendingGate.Action -ceq
                'supersede-offline-selected') {
            $authorizedPointer =
                Assert-RegistrationOfflineSelectedSupersession `
                    -SelectedPointer $registrationPendingGate.Pointer `
                    -ExpectedVersionId (
                        $SupersedeOfflineSelectedRuntimeVersionId
                    )
            if (-not [bool]$runtimeBindingBaseline.PointerPresent -or
                -not (Test-RegistrationRuntimePointerSnapshot `
                    -Actual $runtimeBindingBaseline.Pointer `
                    -Expected $authorizedPointer) -or
                [string]$runtimeBindingBaseline.TaskXmlSha256 -cne
                    [string]$authorizedPointer.CurrentTaskDefinitionSha256) {
                throw (
                    'The task and selected runtime binding changed before ' +
                    'offline supersession transaction admission.'
                )
            }
            $registrationPendingGate.Pointer = $authorizedPointer
        }
        if (-not $SkipEnvironmentConfiguration) {
            Assert-ManagedLauncherShortcutOwnership `
                -Definition $launcherDefinition `
                -PreviousDefinition $previousLauncherDefinition
        }
        $null = Protect-CodexLocalRemoteDataDirectory -DataDir $expected.DataDir
        if (-not $SkipEnvironmentConfiguration) {
            $launcherIconSourcePath =
                if ($env:CODEX_REMOTE_TEST_FIXTURE -ceq '1') {
                    [string]$sourceExpected.Execute
                } else {
                    [string](
                        Resolve-CodexDesktopRuntime `
                            -RuntimeCachePath (
                                Join-Path $expected.DataDir (
                                    'desktop-runtime-cache.json'
                                )
                            )
                    ).DesktopExecutablePath
                }
        }
        $token = $null
        $launcher = $null
        $launcherIcon = $null
        $runtime = $null
        $prepareSelectedRuntimeState = $null
        $registrationCommitted = $false
        $managedConfigurationMutationSha256 = $null
        $desiredModeMutationSha256 = $null
        $controlDispatcherMutationSha256 = $null
        try {
            if ($SkipEnvironmentConfiguration) {
                $legacyOverrideStatus = 'fixture-skipped'
                $launcherStatus = 'fixture-skipped'
                $launcherIconStatus = 'fixture-skipped'
                $tokenStatus = 'fixture-skipped'
            } else {
                if ($useImmutableRuntime) {
                    $runtime = Install-CodexLocalRemoteRuntimeVersion -Plan $runtimePlan
                    $runtimePackageStatus = [string]$runtime.Status
                }
                $legacyOverride = Remove-LegacyPersistentOverride `
                    -ManagedDataDir $expected.DataDir `
                    -ManagedBrokerPort $BrokerPort
                $legacyOverrideStatus = $legacyOverride.Status
                $token = Install-BrokerCapabilityToken -DataDir $expected.DataDir
                $tokenStatus = $token.Status
                $launcherIcon = Install-CodexLocalRemoteManagedDesktopIcon `
                    -DataDir $expected.DataDir `
                    -DesktopExecutablePath $launcherIconSourcePath
                $launcherIconStatus = $launcherIcon.Status
                $launcher = Install-ManagedLauncherShortcut `
                    -Definition $launcherDefinition `
                    -PreviousDefinition $previousLauncherDefinition
                $launcherStatus = $launcher.Status
            }

            $runtimePointerCommitted = $false
            if ($useImmutableRuntime -and
                $ownership.Kind -ceq 'current') {
                $prepareSelectedRuntimeState = {
                    Sync-CodexLocalRemoteCurrentRuntime `
                        -DataDir $expected.DataDir `
                        -InstallRoot $effectiveInstallRoot
                }
            }
            if ($ownership.Kind -cne 'current') {
                $previousTask = Get-ScheduledTask `
                    -TaskName $TaskName `
                    -TaskPath '\' `
                    -ErrorAction SilentlyContinue
                $previousOwnership = Test-ExistingTaskOwnership -Task $previousTask
                if ($null -eq $previousTask -or
                    -not $previousOwnership.IsManaged -or
                    [string]$previousOwnership.Kind -cne [string]$ownership.Kind) {
                    throw "Scheduled task '$TaskName' changed before its immutable-runtime upgrade."
                }
                $runtimeTransitionRequired = (
                    $useImmutableRuntime -and
                    $null -ne $activeRuntimeBefore -and
                    [string]$activeRuntimeBefore.CurrentVersionId -cne
                        [string]$runtime.VersionId
                )
                if ($runtimeTransitionRequired) {
                    $oldRuntime = [pscustomobject]@{
                        VersionId =
                            [string]$activeRuntimeBefore.CurrentVersionId
                        RuntimeRoot =
                            [string]$activeRuntimeBefore.CurrentRoot
                    }
                    $oldTaskXml = [string](
                        Export-ScheduledTask `
                            -TaskName $TaskName `
                            -TaskPath '\' `
                            -ErrorAction Stop
                    )
                    $oldTaskXmlSha256 =
                        Get-StringSha256 -Value $oldTaskXml
                    if (-not (Test-RegistrationTaskXmlRuntimeRoot `
                        -Xml $oldTaskXml `
                        -ExpectedRoot ([string]$oldRuntime.RuntimeRoot) `
                        -ForbiddenRoot ([string]$runtime.RuntimeRoot))) {
                        throw 'The existing scheduled task is not an exact pre-image of the active immutable runtime.'
                    }
                    $taskPreImage = [pscustomobject]@{
                        TaskName = $TaskName
                        RuntimeVersionId =
                            [string]$oldRuntime.VersionId
                        RuntimeRoot =
                            [string]$oldRuntime.RuntimeRoot
                        Xml = $oldTaskXml
                        XmlSha256 = $oldTaskXmlSha256
                    }
                    $transactionFailure = $null
                    try {
                        $null = Set-CodexLocalRemoteCurrentRuntime `
                            -DataDir $expected.DataDir `
                            -Runtime $runtime `
                            -PreviousTaskPreImage $taskPreImage
                        Register-ScheduledTask `
                            -TaskName $TaskName `
                            -TaskPath '\' `
                            -Action $action `
                            -Principal $principal `
                            -Settings $settings `
                            -Description $expected.Description `
                            -Force | Out-Null
                        $null =
                            Set-RegistrationSelectedRuntimeTaskBinding `
                                -SelectedRuntime $runtime `
                                -TaskPreImage $taskPreImage
                    } catch {
                        $transactionFailure = $_.Exception.Message
                    }

                    $pair = Get-RegistrationRuntimeTaskPairState `
                        -OldRuntime $oldRuntime `
                        -OldTaskXmlSha256 $oldTaskXmlSha256 `
                        -SelectedRuntime $runtime
                    if ([string]$pair.Kind -cne 'selected' -and
                        $pair.PointerRuntimeMatchesSelected -and
                        -not $pair.TaskMatchesSelected) {
                        try {
                            Register-ScheduledTask `
                                -TaskName $TaskName `
                                -TaskPath '\' `
                                -Action $action `
                                -Principal $principal `
                                -Settings $settings `
                                -Description $expected.Description `
                                -Force | Out-Null
                            $null =
                                Set-RegistrationSelectedRuntimeTaskBinding `
                                    -SelectedRuntime $runtime `
                                    -TaskPreImage $taskPreImage
                        } catch {
                            if ([string]::IsNullOrWhiteSpace(
                                $transactionFailure
                            )) {
                                $transactionFailure =
                                    $_.Exception.Message
                            }
                        }
                        $pair = Get-RegistrationRuntimeTaskPairState `
                            -OldRuntime $oldRuntime `
                            -OldTaskXmlSha256 $oldTaskXmlSha256 `
                            -SelectedRuntime $runtime
                    }
                    if ([string]$pair.Kind -cne 'selected' -and
                        $pair.TaskMatchesSelected -and
                        -not $pair.PointerMatchesSelected) {
                        try {
                            $null =
                                Set-RegistrationSelectedRuntimeTaskBinding `
                                    -SelectedRuntime $runtime `
                                    -TaskPreImage $taskPreImage
                        } catch {
                            if ([string]::IsNullOrWhiteSpace(
                                $transactionFailure
                            )) {
                                $transactionFailure =
                                    $_.Exception.Message
                            }
                        }
                        $pair = Get-RegistrationRuntimeTaskPairState `
                            -OldRuntime $oldRuntime `
                            -OldTaskXmlSha256 $oldTaskXmlSha256 `
                            -SelectedRuntime $runtime
                    }

                    if ([string]$pair.Kind -cne 'selected') {
                        if (-not $pair.TaskMatchesOld) {
                            try {
                                Register-ScheduledTask `
                                    -TaskName $TaskName `
                                    -TaskPath '\' `
                                    -Xml $oldTaskXml `
                                    -Force | Out-Null
                            } catch {
                                if ([string]::IsNullOrWhiteSpace(
                                    $transactionFailure
                                )) {
                                    $transactionFailure =
                                        $_.Exception.Message
                                }
                            }
                            $pair =
                                Get-RegistrationRuntimeTaskPairState `
                                    -OldRuntime $oldRuntime `
                                    -OldTaskXmlSha256 $oldTaskXmlSha256 `
                                    -SelectedRuntime $runtime
                        }
                        if ($pair.TaskMatchesOld -and
                            -not $pair.PointerMatchesOld) {
                            try {
                                $null =
                                    Set-CodexLocalRemoteCurrentRuntime `
                                        -DataDir $expected.DataDir `
                                        -Runtime $oldRuntime `
                                        -CurrentTaskDefinition $taskPreImage
                            } catch {
                                if ([string]::IsNullOrWhiteSpace(
                                    $transactionFailure
                                )) {
                                    $transactionFailure =
                                        $_.Exception.Message
                                }
                            }
                            $pair =
                                Get-RegistrationRuntimeTaskPairState `
                                    -OldRuntime $oldRuntime `
                                    -OldTaskXmlSha256 $oldTaskXmlSha256 `
                                    -SelectedRuntime $runtime
                        }
                    }

                    if ([string]$pair.Kind -ceq 'old') {
                        throw (
                            "Selected runtime registration failed " +
                            "('$transactionFailure'); the exact prior " +
                            "runtime pointer/task pair was restored and verified."
                        )
                    }
                    if ([string]$pair.Kind -cne 'selected') {
                        throw (
                            "Selected runtime registration failed " +
                            "('$transactionFailure'); neither the exact " +
                            "prior nor selected runtime pointer/task pair " +
                            "was verified ('$([string]$pair.Failure)')."
                        )
                    }
                    $runtimePointerCommitted = $true
                } else {
                    if ($useImmutableRuntime) {
                        $prepareSelectedRuntimeState = {
                            Register-ScheduledTask `
                                -TaskName $TaskName `
                                -TaskPath '\' `
                                -Action $action `
                                -Principal $principal `
                                -Settings $settings `
                                -Description $expected.Description `
                                -Force | Out-Null
                        }
                    } else {
                        Register-ScheduledTask `
                            -TaskName $TaskName `
                            -TaskPath '\' `
                            -Action $action `
                            -Principal $principal `
                            -Settings $settings `
                            -Description $expected.Description `
                            -Force | Out-Null
                    }
                }
            }

            if ($useImmutableRuntime -and
                -not $runtimePointerCommitted) {
                $runtimeBindingTransaction =
                    Complete-RegistrationRuntimeBindingTransaction `
                        -SelectedRuntime $runtime `
                        -Baseline $runtimeBindingBaseline `
                        -PrepareSelectedState $prepareSelectedRuntimeState
                if ($ownership.Kind -ceq 'current' -and
                    ([string](
                        $runtimeBindingTransaction.PreparationResult.Status
                    ) -ceq 'repaired' -or
                    -not [bool]$runtimeBindingBaseline.PointerPresent)) {
                    $resultStatus = 'recovered-current-runtime-pointer'
                }
            }
            if ($ownership.Kind -cne 'current') {
                $upgradedTask = Get-ScheduledTask `
                    -TaskName $TaskName `
                    -TaskPath '\' `
                    -ErrorAction SilentlyContinue
                $upgradedOwnership = Test-ExistingTaskOwnership `
                    -Task $upgradedTask
                if ($null -eq $upgradedTask -or
                    -not $upgradedOwnership.IsManaged -or
                    [string]$upgradedOwnership.Kind -cne 'current') {
                    throw "Scheduled task '$TaskName' did not converge to the dynamic-runtime V5 definition."
                }
                if ([string]$previousTask.State -ceq 'Running' -and
                    [string]$upgradedTask.State -cne 'Running') {
                    throw 'The running managed task did not remain Running after its definition-only immutable-runtime upgrade.'
                }
                if ([string]$previousTask.State -ceq 'Running' -and
                    -not $startAfterRegistration) {
                    $startupActivationStatus =
                        'pending-live-bootstrap-restart'
                }
                $resultStatus =
                    "upgraded-$($ownership.Kind)-to-versioned-v5"
            }
            $null = Set-CodexLocalRemoteManagedConfiguration `
                -DataDir $expected.DataDir `
                -SidecarPort $Port `
                -BrokerPort $BrokerPort `
                -BrokerUpstreamPort $BrokerUpstreamPort `
                -BasePath $BasePath `
                -TaskName $TaskName
            if (-not $SkipEnvironmentConfiguration -and
                $useImmutableRuntime) {
                $managedConfigurationMutationSha256 = (
                    Get-FileHash `
                        -LiteralPath (
                            Join-Path $expected.DataDir 'managed-config.json'
                        ) `
                        -Algorithm SHA256 `
                        -ErrorAction Stop
                ).Hash.ToLowerInvariant()
            }

            if (-not $SkipEnvironmentConfiguration -and
                $useImmutableRuntime) {
                $desiredRuntime =
                    Get-CodexLocalRemoteCurrentRuntime `
                        -DataDir $expected.DataDir
                $null = Set-CodexLocalRemoteDesiredMode `
                    -DataDir $expected.DataDir `
                    -Mode $(if ($startAfterRegistration) {
                        'Remote'
                    } else {
                        [string]$desiredModePreflight.Mode
                    }) `
                    -RuntimeVersionId (
                        [string]$desiredRuntime.CurrentVersionId
                    ) `
                    -RuntimeRoot (
                        [string]$desiredRuntime.CurrentRoot
                    )
                $desiredModeMutationSha256 = (
                    Get-FileHash `
                        -LiteralPath (
                            Get-CodexLocalRemoteDesiredModePath `
                                -DataDir $expected.DataDir
                        ) `
                        -Algorithm SHA256 `
                        -ErrorAction Stop
                ).Hash.ToLowerInvariant()
            }
            if (-not $SkipEnvironmentConfiguration -and
                $useImmutableRuntime) {
                $controlDispatcher =
                    Install-RegistrationControlDispatcher
                $controlDispatcherStatus =
                    [string]$controlDispatcher.Status
                $controlDispatcherMutationSha256 =
                    [string]$controlDispatcher.Sha256
            }
            $null =
                Complete-ManagedLauncherShortcutTransaction `
                    -Receipt $launcher `
                    -Definition $launcherDefinition `
                    -PreviousDefinition $previousLauncherDefinition
            $registrationCommitted = $true
            if ($startAfterRegistration) {
                $freshTask = Get-ScheduledTask `
                    -TaskName $TaskName `
                    -TaskPath '\' `
                    -ErrorAction SilentlyContinue
                $freshOwnership = Test-ExistingTaskOwnership -Task $freshTask
                if ($null -eq $freshTask -or
                    -not $freshOwnership.IsManaged -or
                    [string]$freshOwnership.Kind -cne 'current') {
                    throw "Scheduled task '$TaskName' changed before startup; refusing to start anything but the exact V5 task."
                }
                Start-ScheduledTask -TaskName $TaskName -TaskPath '\'
            }
        } catch {
            $registrationError = $_
            if ($registrationCommitted) {
                throw $registrationError
            }
            $registrationRollbackFailures =
                [System.Collections.Generic.List[string]]::new()
            if ($useImmutableRuntime -and
                $null -ne $runtimeBindingBaseline -and
                $null -ne $runtime) {
                try {
                    Restore-RegistrationRuntimeBindingBaseline `
                        -Baseline $runtimeBindingBaseline `
                        -SelectedRuntime $runtime
                    $runtimeBaselineState =
                        Test-RegistrationRuntimeBindingBaselineState `
                            -Baseline $runtimeBindingBaseline
                    if (-not $runtimeBaselineState.IsExact) {
                        throw 'runtime binding baseline did not verify'
                    }
                } catch {
                    $registrationRollbackFailures.Add('task/runtime pointer')
                }
            }
            foreach ($failureArea in @(
                Restore-RegistrationAncillaryPreImages `
                    -ManagedConfigurationSha256 (
                        $managedConfigurationMutationSha256
                    ) `
                    -DesiredModeSha256 $desiredModeMutationSha256 `
                    -ControlDispatcherSha256 (
                        $controlDispatcherMutationSha256
                    )
            )) {
                $registrationRollbackFailures.Add($failureArea)
            }
            $launcherRollbackFailure = $null
            try {
                $null =
                    Undo-ManagedLauncherShortcutTransaction `
                        -Receipt $launcher `
                        -Definition $launcherDefinition `
                        -PreviousDefinition $previousLauncherDefinition
            } catch {
                $launcherRollbackFailure = $_.Exception.Message
            }
            if ($null -ne $launcherIcon -and $launcherIcon.Status -ceq 'created') {
                $null = Remove-CodexLocalRemoteManagedDesktopIcon `
                    -DataDir $expected.DataDir
            }
            if ($null -ne $token -and $token.Status -ceq 'created') {
                $null = Remove-BrokerCapabilityToken -DataDir $expected.DataDir
            }
            if (-not [string]::IsNullOrWhiteSpace(
                $launcherRollbackFailure
            )) {
                $registrationRollbackFailures.Add('launcher shortcut')
            }
            if ($registrationRollbackFailures.Count -gt 0) {
                throw (
                    "$($registrationError.Exception.Message) Registration " +
                    "rollback was incomplete: " +
                    ($registrationRollbackFailures -join ', ')
                )
            }
            throw $registrationError
        }
    }
} elseif ($PSCmdlet.ShouldProcess(
    $TaskName,
    "Register current-user startup task for $currentUser"
)) {
    Assert-HighestRunLevelRegistrationAllowed
    # A missing task is created without -Force. Re-check immediately before
    # ancillary writes; a later same-name task remains a scheduler collision.
    $current = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
    if ($null -ne $current) {
        $currentOwnership = Test-ExistingTaskOwnership -Task $current
        throw "Scheduled task '$TaskName' appeared before registration as '$($currentOwnership.Kind)'; refusing the collision without overwrite."
    }

    $runtimeBindingBaseline = if ($useImmutableRuntime) {
        Get-RegistrationRuntimeBindingBaseline `
            -ExpectedTaskState 'absent'
    } else {
        $null
    }
    if (-not $SkipEnvironmentConfiguration) {
        Assert-ManagedLauncherShortcutOwnership `
            -Definition $launcherDefinition `
            -PreviousDefinition $previousLauncherDefinition
    }
    $null = Protect-CodexLocalRemoteDataDirectory -DataDir $expected.DataDir
    if (-not $SkipEnvironmentConfiguration) {
        $launcherIconSourcePath =
            if ($env:CODEX_REMOTE_TEST_FIXTURE -ceq '1') {
                [string]$sourceExpected.Execute
            } else {
                [string](
                    Resolve-CodexDesktopRuntime `
                        -RuntimeCachePath (
                            Join-Path $expected.DataDir (
                                'desktop-runtime-cache.json'
                            )
                        )
                ).DesktopExecutablePath
            }
    }
    $token = $null
    $launcher = $null
    $launcherIcon = $null
    $runtime = $null
    $prepareSelectedRuntimeState = $null
    $registrationCommitted = $false
    $managedConfigurationMutationSha256 = $null
    $desiredModeMutationSha256 = $null
    $controlDispatcherMutationSha256 = $null
    try {
        if ($SkipEnvironmentConfiguration) {
            $legacyOverrideStatus = 'fixture-skipped'
            $launcherStatus = 'fixture-skipped'
            $launcherIconStatus = 'fixture-skipped'
            $tokenStatus = 'fixture-skipped'
        } else {
            if ($useImmutableRuntime) {
                $runtime = Install-CodexLocalRemoteRuntimeVersion -Plan $runtimePlan
                $runtimePackageStatus = [string]$runtime.Status
            }
            $legacyOverride = Remove-LegacyPersistentOverride `
                -ManagedDataDir $expected.DataDir `
                -ManagedBrokerPort $BrokerPort
            $legacyOverrideStatus = $legacyOverride.Status
            $token = Install-BrokerCapabilityToken -DataDir $expected.DataDir
            $tokenStatus = $token.Status
            $launcherIcon = Install-CodexLocalRemoteManagedDesktopIcon `
                -DataDir $expected.DataDir `
                -DesktopExecutablePath $launcherIconSourcePath
            $launcherIconStatus = $launcherIcon.Status
            $launcher = Install-ManagedLauncherShortcut `
                -Definition $launcherDefinition `
                -PreviousDefinition $previousLauncherDefinition
            $launcherStatus = $launcher.Status
        }
        if ($useImmutableRuntime) {
            $prepareSelectedRuntimeState = {
                Register-ScheduledTask `
                    -TaskName $TaskName `
                    -TaskPath '\' `
                    -Action $action `
                    -Principal $principal `
                    -Settings $settings `
                    -Description $expected.Description | Out-Null
            }
        } else {
            Register-ScheduledTask `
                -TaskName $TaskName `
                -TaskPath '\' `
                -Action $action `
                -Principal $principal `
                -Settings $settings `
                -Description $expected.Description | Out-Null
        }
        $resultStatus = 'registered'
        if ($useImmutableRuntime) {
            $null =
                Complete-RegistrationRuntimeBindingTransaction `
                    -SelectedRuntime $runtime `
                    -Baseline $runtimeBindingBaseline `
                    -PrepareSelectedState $prepareSelectedRuntimeState
        }
        $null = Set-CodexLocalRemoteManagedConfiguration `
            -DataDir $expected.DataDir `
            -SidecarPort $Port `
            -BrokerPort $BrokerPort `
            -BrokerUpstreamPort $BrokerUpstreamPort `
            -BasePath $BasePath `
            -TaskName $TaskName
        if (-not $SkipEnvironmentConfiguration -and
            $useImmutableRuntime) {
            $managedConfigurationMutationSha256 = (
                Get-FileHash `
                    -LiteralPath (
                        Join-Path $expected.DataDir 'managed-config.json'
                    ) `
                    -Algorithm SHA256 `
                    -ErrorAction Stop
            ).Hash.ToLowerInvariant()
        }
        if (-not $SkipEnvironmentConfiguration -and
            $useImmutableRuntime) {
            $desiredRuntime =
                Get-CodexLocalRemoteCurrentRuntime `
                    -DataDir $expected.DataDir
            $null = Set-CodexLocalRemoteDesiredMode `
                -DataDir $expected.DataDir `
                -Mode $(if ($startAfterRegistration) {
                    'Remote'
                } else {
                    [string]$desiredModePreflight.Mode
                }) `
                -RuntimeVersionId (
                    [string]$desiredRuntime.CurrentVersionId
                ) `
                -RuntimeRoot (
                    [string]$desiredRuntime.CurrentRoot
                )
            $desiredModeMutationSha256 = (
                Get-FileHash `
                    -LiteralPath (
                        Get-CodexLocalRemoteDesiredModePath `
                            -DataDir $expected.DataDir
                    ) `
                    -Algorithm SHA256 `
                    -ErrorAction Stop
            ).Hash.ToLowerInvariant()
        }
        if (-not $SkipEnvironmentConfiguration -and
            $useImmutableRuntime) {
            $controlDispatcher =
                Install-RegistrationControlDispatcher
            $controlDispatcherStatus =
                [string]$controlDispatcher.Status
            $controlDispatcherMutationSha256 =
                [string]$controlDispatcher.Sha256
        }
        $null =
            Complete-ManagedLauncherShortcutTransaction `
                -Receipt $launcher `
                -Definition $launcherDefinition `
                -PreviousDefinition $previousLauncherDefinition
        $registrationCommitted = $true
        if ($startAfterRegistration) {
            $freshTask = Get-ScheduledTask `
                -TaskName $TaskName `
                -TaskPath '\' `
                -ErrorAction SilentlyContinue
            $freshOwnership = Test-ExistingTaskOwnership -Task $freshTask
            if ($null -eq $freshTask -or
                -not $freshOwnership.IsManaged -or
                [string]$freshOwnership.Kind -cne 'current') {
                throw "Scheduled task '$TaskName' is not the exact V5 task immediately before startup; refusing to start it."
            }
            Start-ScheduledTask -TaskName $TaskName -TaskPath '\'
        }
    } catch {
        $registrationError = $_
        if ($registrationCommitted) {
            throw $registrationError
        }
        $registrationRollbackFailures =
            [System.Collections.Generic.List[string]]::new()
        if ($useImmutableRuntime -and
            $null -ne $runtimeBindingBaseline -and
            $null -ne $runtime) {
            try {
                Restore-RegistrationRuntimeBindingBaseline `
                    -Baseline $runtimeBindingBaseline `
                    -SelectedRuntime $runtime
                $runtimeBaselineState =
                    Test-RegistrationRuntimeBindingBaselineState `
                        -Baseline $runtimeBindingBaseline
                if (-not $runtimeBaselineState.IsExact) {
                    throw 'runtime binding baseline did not verify'
                }
            } catch {
                $registrationRollbackFailures.Add('task/runtime pointer')
            }
        }
        foreach ($failureArea in @(
            Restore-RegistrationAncillaryPreImages `
                -ManagedConfigurationSha256 (
                    $managedConfigurationMutationSha256
                ) `
                -DesiredModeSha256 $desiredModeMutationSha256 `
                -ControlDispatcherSha256 (
                    $controlDispatcherMutationSha256
                )
        )) {
            $registrationRollbackFailures.Add($failureArea)
        }
        $launcherRollbackFailure = $null
        try {
            $null =
                Undo-ManagedLauncherShortcutTransaction `
                    -Receipt $launcher `
                    -Definition $launcherDefinition `
                    -PreviousDefinition $previousLauncherDefinition
        } catch {
            $launcherRollbackFailure = $_.Exception.Message
        }
        if ($null -ne $launcherIcon -and $launcherIcon.Status -ceq 'created') {
            $null = Remove-CodexLocalRemoteManagedDesktopIcon `
                -DataDir $expected.DataDir
        }
        if ($null -ne $token -and $token.Status -ceq 'created') {
            $null = Remove-BrokerCapabilityToken -DataDir $expected.DataDir
        }
        if (-not [string]::IsNullOrWhiteSpace(
            $launcherRollbackFailure
        )) {
            $registrationRollbackFailures.Add('launcher shortcut')
        }
        if ($registrationRollbackFailures.Count -gt 0) {
            throw (
                "$($registrationError.Exception.Message) Registration " +
                "rollback was incomplete: " +
                ($registrationRollbackFailures -join ', ')
            )
        }
        throw $registrationError
    }
}

[pscustomobject]@{
    Status = $resultStatus
    TaskName = $TaskName
    User = $currentUser
    LocalUrl = Join-BasePathUrl -Origin "http://127.0.0.1:$Port" -BasePath $BasePath
    LaunchMode = 'native-default-on-demand-remote'
    LauncherShortcut = $launcherStatus
    LauncherIcon = $launcherIconStatus
    LegacyPersistentOverride = $legacyOverrideStatus
    BrokerCapabilityToken = $tokenStatus
    StartupActivation = $startupActivationStatus
    RuntimePackage = $runtimePackageStatus
    RuntimeVersionId = $runtimeVersionId
    RuntimeRoot = [string]$expected.WorkingDirectory
    ControlDispatcher = $controlDispatcherStatus
    ControlDispatcherPath = $controlDispatcherPath
    DataDirectoryAction = [string]$dataDirectoryPlan.Action
    DataDir = [string]$dataDirectoryPlan.DataDir
}
