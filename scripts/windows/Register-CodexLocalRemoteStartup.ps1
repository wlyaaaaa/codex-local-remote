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

    [Parameter(DontShow)]
    [switch]$SkipEnvironmentConfiguration,

    [Parameter(DontShow)]
    [string]$LauncherShortcutPath
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'CodexLocalRemote.Windows.psm1') -Force
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
$legacyExpected = Get-LegacyStartupTaskDefinition `
    -TaskName $TaskName `
    -NodePath $NodePath `
    -InstallRoot $sourceInstallRoot `
    -DataDir $DataDir `
    -Port $Port `
    -BasePath $BasePath
function Test-ExistingTaskOwnership {
    param([AllowNull()][object]$Task)

    if ($null -eq $Task) {
        return [pscustomobject]@{ IsManaged = $true; Kind = 'none'; Mismatches = @() }
    }
    $current = Test-ManagedStartupTask -Task $Task -Expected $expected
    if ($current.IsManaged) {
        return [pscustomobject]@{ IsManaged = $true; Kind = 'current'; Mismatches = @() }
    }
    $mutableV3 = Test-ManagedStartupTask -Task $Task -Expected $sourceExpected
    if ($mutableV3.IsManaged) {
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
                        $versioned = Test-ManagedStartupTask `
                            -Task $Task `
                            -Expected $versionedExpected
                        if ($versioned.IsManaged) {
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
    $launcher = [System.IO.Path]::GetFullPath(
        (Join-Path $resolvedRuntimeRoot 'scripts\windows\Launch-CodexWithRemote.ps1')
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
        $expected.DataDir,
        '-BrokerPort',
        [string]$BrokerPort,
        '-TaskName',
        $TaskName
    )
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
        WorkingDirectory = $resolvedRuntimeRoot
        Description = "$safeLaunchName - Uses Remote when ready and otherwise starts Codex Desktop natively."
    }
}

function Test-ManagedLauncherShortcut {
    param(
        [Parameter(Mandatory)][object]$Definition,
        [string]$Path = ([string]$Definition.ShortcutPath)
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
    return Test-ManagedLauncherShortcut `
        -Definition ([pscustomobject]@{
            ShortcutPath = [string]$Definition.ShortcutPath
            TargetPath = [string]$Definition.TargetPath
            Arguments = $legacyArguments
            WorkingDirectory = [string]$Definition.WorkingDirectory
            Description = [string]$Definition.Description
        }) `
        -Path $Path
}

function Install-ManagedLauncherShortcut {
    param(
        [Parameter(Mandatory)][object]$Definition,
        [AllowNull()][object]$PreviousDefinition
    )

    $upgradeExisting = $false
    if (Test-Path -LiteralPath $Definition.ShortcutPath) {
        if (Test-ManagedLauncherShortcut -Definition $Definition) {
            return [pscustomobject]@{
                Status = 'reused'
                ShortcutPath = [string]$Definition.ShortcutPath
            }
        }
        $previousManaged = (
            $null -ne $PreviousDefinition -and
            (Test-ManagedLauncherShortcut -Definition $PreviousDefinition)
        )
        if (-not $previousManaged -and
            -not (Test-LegacyVisibleManagedLauncherShortcut `
                -Definition $Definition)) {
            throw "Launcher shortcut '$($Definition.ShortcutPath)' exists but is not the exact managed Codex Remote entry; refusing to overwrite it."
        }
        $upgradeExisting = $true
    }
    $parent = Split-Path -Parent ([string]$Definition.ShortcutPath)
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
        $shortcut.WindowStyle = 7
        $shortcut.Save()
    } finally {
        if ($null -ne $shortcut) {
            $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
        }
        if ($null -ne $shell) {
            $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
        }
    }
    try {
        if (-not (Test-ManagedLauncherShortcut -Definition $Definition -Path $temporary)) {
            throw 'The newly created Codex Remote launcher shortcut failed exact verification.'
        }
        Move-Item `
            -LiteralPath $temporary `
            -Destination ([string]$Definition.ShortcutPath) `
            -Force
    } finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
    return [pscustomobject]@{
        Status = if ($upgradeExisting) { 'upgraded' } else { 'created' }
        ShortcutPath = [string]$Definition.ShortcutPath
    }
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
        -not $NoStart) {
        throw "Upgrading the running pinned V2 task requires -NoStart so registration cannot request another task instance."
    }
}

$launcherDefinition = Get-ManagedLauncherShortcutDefinition
$previousLauncherDefinition = if ($null -ne $activeRuntimeBefore) {
    Get-ManagedLauncherShortcutDefinition -RuntimeRoot $activeRuntimeBefore.CurrentRoot
} else {
    Get-ManagedLauncherShortcutDefinition -RuntimeRoot $sourceInstallRoot
}
$requiredRuntimes = @(
    @{ Name = 'PowerShell'; Path = $sourceExpected.Execute },
    @{ Name = 'Node'; Path = $sourceExpected.Node },
    @{ Name = 'startup bootstrap'; Path = $sourceExpected.Bootstrap },
    @{ Name = 'built shared broker'; Path = $sourceExpected.BrokerCli },
    @{ Name = 'built sidecar'; Path = $sourceExpected.Cli }
)
if (-not $SkipEnvironmentConfiguration) {
    $requiredRuntimes += @{
        Name = 'fail-open Desktop launcher'
        Path = (Join-Path $sourceInstallRoot 'scripts\windows\Launch-CodexWithRemote.ps1')
    }
}
foreach ($runtime in $requiredRuntimes) {
    if (-not (Test-Path -LiteralPath $runtime.Path -PathType Leaf)) {
        throw "$($runtime.Name) not found at '$($runtime.Path)'. Run pnpm build first when applicable."
    }
}

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction `
    -Execute $expected.Execute `
    -Argument $expected.Arguments `
    -WorkingDirectory $expected.WorkingDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $expected.TriggerUserSid
$principal = New-ScheduledTaskPrincipal `
    -UserId $expected.PrincipalUserSid `
    -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -DisallowDemandStart:$false `
    -RunOnlyIfIdle:$false `
    -RunOnlyIfNetworkAvailable:$false `
    -Disable:$false

$legacyOverrideStatus = 'not-applied'
$launcherStatus = 'not-applied'
$tokenStatus = 'not-applied'
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

if ($ownership.Kind -cin @('current', 'pinned-v2', 'mutable-v3', 'versioned-v3')) {
    if ($PSCmdlet.ShouldProcess(
        $TaskName,
        "Install and activate the immutable runtime for the managed startup task"
    )) {
        $null = Protect-CodexLocalRemoteDataDirectory -DataDir $expected.DataDir
        $token = $null
        $launcher = $null
        $runtime = $null
        try {
            if ($SkipEnvironmentConfiguration) {
                $legacyOverrideStatus = 'fixture-skipped'
                $launcherStatus = 'fixture-skipped'
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
                $launcher = Install-ManagedLauncherShortcut `
                    -Definition $launcherDefinition `
                    -PreviousDefinition $previousLauncherDefinition
                $launcherStatus = $launcher.Status
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
                Register-ScheduledTask `
                    -TaskName $TaskName `
                    -TaskPath '\' `
                    -Action $action `
                    -Trigger $trigger `
                    -Principal $principal `
                    -Settings $settings `
                    -Description $expected.Description `
                    -Force | Out-Null
                $upgradedTask = Get-ScheduledTask `
                    -TaskName $TaskName `
                    -TaskPath '\' `
                    -ErrorAction SilentlyContinue
                $upgradedOwnership = Test-ExistingTaskOwnership -Task $upgradedTask
                if ($null -eq $upgradedTask -or
                    -not $upgradedOwnership.IsManaged -or
                    [string]$upgradedOwnership.Kind -cne 'current') {
                    throw "Scheduled task '$TaskName' did not converge to the dynamic-runtime V3 definition."
                }
                if ([string]$previousTask.State -ceq 'Running' -and
                    [string]$upgradedTask.State -cne 'Running') {
                    throw 'The running managed task did not remain Running after its definition-only immutable-runtime upgrade.'
                }
                $resultStatus = "upgraded-$($ownership.Kind)-to-versioned-v3"
            }

            if ($useImmutableRuntime) {
                $null = Set-CodexLocalRemoteCurrentRuntime `
                    -DataDir $expected.DataDir `
                    -Runtime $runtime
            }

            if (-not $NoStart) {
                $freshTask = Get-ScheduledTask `
                    -TaskName $TaskName `
                    -TaskPath '\' `
                    -ErrorAction SilentlyContinue
                $freshOwnership = Test-ExistingTaskOwnership -Task $freshTask
                if ($null -eq $freshTask -or
                    -not $freshOwnership.IsManaged -or
                    [string]$freshOwnership.Kind -cne 'current') {
                    throw "Scheduled task '$TaskName' changed before startup; refusing to start anything but the exact V2 task."
                }
                Start-ScheduledTask -TaskName $TaskName -TaskPath '\'
            }
        } catch {
            if ($null -ne $launcher -and $launcher.Status -ceq 'created') {
                Remove-Item `
                    -LiteralPath ([string]$launcher.ShortcutPath) `
                    -Force `
                    -ErrorAction SilentlyContinue
            }
            if ($null -ne $token -and $token.Status -ceq 'created') {
                $null = Remove-BrokerCapabilityToken -DataDir $expected.DataDir
            }
            throw
        }
    }
} elseif ($PSCmdlet.ShouldProcess(
    $TaskName,
    "Register current-user startup task for $currentUser"
)) {
    # A missing task is created without -Force. Re-check immediately before
    # ancillary writes; a later same-name task remains a scheduler collision.
    $current = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
    if ($null -ne $current) {
        $currentOwnership = Test-ExistingTaskOwnership -Task $current
        throw "Scheduled task '$TaskName' appeared before registration as '$($currentOwnership.Kind)'; refusing the collision without overwrite."
    }

    $null = Protect-CodexLocalRemoteDataDirectory -DataDir $expected.DataDir
    $token = $null
    $launcher = $null
    $runtime = $null
    try {
        if ($SkipEnvironmentConfiguration) {
            $legacyOverrideStatus = 'fixture-skipped'
            $launcherStatus = 'fixture-skipped'
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
            $launcher = Install-ManagedLauncherShortcut `
                -Definition $launcherDefinition `
                -PreviousDefinition $previousLauncherDefinition
            $launcherStatus = $launcher.Status
        }
        Register-ScheduledTask `
            -TaskName $TaskName `
            -TaskPath '\' `
            -Action $action `
            -Trigger $trigger `
            -Principal $principal `
            -Settings $settings `
            -Description $expected.Description | Out-Null
        $resultStatus = 'registered'
        if ($useImmutableRuntime) {
            $null = Set-CodexLocalRemoteCurrentRuntime `
                -DataDir $expected.DataDir `
                -Runtime $runtime
        }
    } catch {
        if ($null -ne $launcher -and $launcher.Status -ceq 'created') {
            Remove-Item `
                -LiteralPath ([string]$launcher.ShortcutPath) `
                -Force `
                -ErrorAction SilentlyContinue
        }
        if ($null -ne $token -and $token.Status -ceq 'created') {
            $null = Remove-BrokerCapabilityToken -DataDir $expected.DataDir
        }
        throw
    }

    if (-not $NoStart) {
        $freshTask = Get-ScheduledTask `
            -TaskName $TaskName `
            -TaskPath '\' `
            -ErrorAction SilentlyContinue
        $freshOwnership = Test-ExistingTaskOwnership -Task $freshTask
        if ($null -eq $freshTask -or
            -not $freshOwnership.IsManaged -or
            [string]$freshOwnership.Kind -cne 'current') {
            throw "Scheduled task '$TaskName' is not the exact V2 task immediately before startup; refusing to start it."
        }
        Start-ScheduledTask -TaskName $TaskName -TaskPath '\'
    }
}

[pscustomobject]@{
    Status = $resultStatus
    TaskName = $TaskName
    User = $currentUser
    LocalUrl = Join-BasePathUrl -Origin "http://127.0.0.1:$Port" -BasePath $BasePath
    LaunchMode = 'process-scoped-fail-open'
    LauncherShortcut = $launcherStatus
    LegacyPersistentOverride = $legacyOverrideStatus
    BrokerCapabilityToken = $tokenStatus
    RuntimePackage = $runtimePackageStatus
    RuntimeVersionId = $runtimeVersionId
    RuntimeRoot = [string]$expected.WorkingDirectory
    DataDirectoryAction = [string]$dataDirectoryPlan.Action
    DataDir = [string]$dataDirectoryPlan.DataDir
}
