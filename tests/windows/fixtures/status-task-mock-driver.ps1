[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$TargetScript,

    [Parameter(Mandatory)]
    [ValidateSet(
        'valid-running',
        'valid-running-null-triggers',
        'valid-running-sid',
        'legacy-headless-v4',
        'legacy-no-desktop-launch',
        'legacy-pre-headless',
        'valid-ready',
        'foreign-action',
        'foreign-working-directory',
        'missing-action-property',
        'foreign-principal-user',
        'foreign-principal-logon',
        'foreign-principal-run-level',
        'missing-principal-user',
        'foreign-trigger-class',
        'foreign-trigger-user',
        'foreign-trigger-disabled',
        'foreign-trigger-extra',
        'missing-trigger-user',
        'foreign-setting',
        'missing-setting-property',
        'missing-principal',
        'missing-triggers',
        'missing-settings',
        'sidecar-nonloopback',
        'sidecar-ipv6-loopback-neighbor',
        'sidecar-multiple',
        'sidecar-foreign',
        'persistent-user-override',
        'launcher-legacy-takeover',
        'launcher-non-elevated',
        'launcher-minimized',
        'launcher-codepage-description',
        'launcher-codepage-non-elevated',
        'launcher-codepage-minimized',
        'launcher-codepage-foreign-arguments',
        'valid-launch-receipt',
        'invalid-launch-receipt',
        'valid-launch-receipt-v2',
        'valid-launch-receipt-v2-success',
        'invalid-launch-receipt-v2-extra',
        'invalid-launch-receipt-v2-stage',
        'invalid-launch-receipt-v2-code',
        'invalid-launch-receipt-v2-decision',
        'invalid-launch-receipt-v2-correlation',
        'invalid-launch-receipt-v2-feedback-status',
        'invalid-launch-receipt-v2-feedback',
        'invalid-launch-receipt-v2-failure-pair'
    )]
    [string]$Mode,

    [Parameter(Mandatory)]
    [string]$InstallRoot,

    [Parameter(Mandatory)]
    [string]$DataDir,

    [Parameter(Mandatory)]
    [string]$NodePath,

    [Parameter(Mandatory)]
    [string]$CodexPath,

    [Parameter(Mandatory)]
    [string]$PwshPath,

    [int]$LastTaskResult = 267009
)

$ErrorActionPreference = 'Stop'
$global:CodexRemoteMockLastTaskResult = $LastTaskResult
$modulePath = Join-Path (Split-Path -Parent $TargetScript) 'CodexLocalRemote.Windows.psm1'
Import-Module $modulePath -Force

$taskName = 'Codex Local Remote'
$expected = Get-StartupTaskDefinition `
    -TaskName $taskName `
    -NodePath $NodePath `
    -CodexPath $CodexPath `
    -PwshPath $PwshPath `
    -InstallRoot $InstallRoot `
    -DataDir $DataDir `
    -Port 18790 `
    -BrokerPort 18791 `
    -BrokerUpstreamPort 18792 `
    -BasePath '/codex-remote'
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sidecarCli = [System.IO.Path]::GetFullPath(
    (Join-Path ([System.IO.Path]::GetFullPath($InstallRoot)) 'apps\sidecar\dist\cli.js')
)
$resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
$managedSidecarCommandLine = (
    "`"$NodePath`" `"$sidecarCli`" serve" +
    " --host 127.0.0.1 --port 18790" +
    " --base-path /codex-remote --data-dir `"$resolvedDataDir`""
)
$task = [pscustomobject]@{
    TaskName = $taskName
    TaskPath = '\'
    Description = $expected.Description
    State = $(if ($Mode -ceq 'valid-ready') { 'Ready' } else { 'Running' })
    Actions = @(
        [pscustomobject]@{
            Execute = $expected.TaskExecute
            Arguments = $expected.TaskArguments
            WorkingDirectory = $expected.WorkingDirectory
        }
    )
    Principal = [pscustomobject]@{
        UserId = $currentUser
        LogonType = 'Interactive'
        RunLevel = 'Highest'
    }
    Triggers = @()
    Settings = [pscustomobject]@{
        DisallowStartIfOnBatteries = $false
        StopIfGoingOnBatteries = $false
        ExecutionTimeLimit = 'P3650D'
        MultipleInstances = 'IgnoreNew'
        RestartCount = 0
        RestartInterval = ''
        StartWhenAvailable = $false
        Enabled = $true
        AllowDemandStart = $true
        RunOnlyIfIdle = $false
        RunOnlyIfNetworkAvailable = $false
    }
}

switch ($Mode) {
    'valid-running-null-triggers' {
        $task.Triggers = $null
    }
    'valid-running-sid' {
        $task.Principal.UserId = $currentUserSid
    }
    { $_ -cin @('legacy-no-desktop-launch', 'legacy-pre-headless') } {
        $task.Triggers = @(
            [pscustomobject]@{
                CimClassName = 'MSFT_TaskLogonTrigger'
                UserId = $currentUserSid
                Enabled = $true
            }
        )
        $task.Settings.RestartCount = 3
        $task.Settings.RestartInterval = 'PT1M'
        $task.Settings.StartWhenAvailable = $true
        $legacyDefinition =
            Get-LegacyDesktopOwningStartupTaskDefinitionV3 `
                -Definition $expected
        $task.Description = [string]$legacyDefinition.Description
        if ($Mode -ceq 'legacy-pre-headless') {
            $task.Actions[0].Execute = [string]$legacyDefinition.Execute
            $task.Actions[0].Arguments = [string]$legacyDefinition.Arguments
        } else {
            $task.Actions[0].Arguments =
                [string]$legacyDefinition.TaskArguments
        }
    }
    'legacy-headless-v4' {
        $task.Triggers = @(
            [pscustomobject]@{
                CimClassName = 'MSFT_TaskLogonTrigger'
                UserId = $currentUserSid
                Enabled = $true
            }
        )
        $task.Settings.RestartCount = 3
        $task.Settings.RestartInterval = 'PT1M'
        $task.Settings.StartWhenAvailable = $true
        $legacyDefinition =
            Get-LegacyHeadlessStartupTaskDefinitionV4 `
                -Definition $expected
        $task.Description = [string]$legacyDefinition.Description
        $task.Actions[0].Execute = [string]$legacyDefinition.TaskExecute
        $task.Actions[0].Arguments =
            [string]$legacyDefinition.TaskArguments
        $task.Actions[0].WorkingDirectory =
            [string]$legacyDefinition.WorkingDirectory
    }
    'foreign-action' {
        $task.Actions[0].Arguments = "$($task.Actions[0].Arguments) --foreign"
    }
    'foreign-working-directory' {
        $task.Actions[0].WorkingDirectory = Split-Path -Parent $expected.WorkingDirectory
    }
    'missing-action-property' {
        $task.Actions[0].PSObject.Properties.Remove('Arguments')
    }
    'foreign-principal-user' {
        $task.Principal.UserId = "$currentUser-foreign"
    }
    'foreign-principal-logon' {
        $task.Principal.LogonType = 'ServiceAccount'
    }
    'foreign-principal-run-level' {
        $task.Principal.RunLevel = 'Limited'
    }
    'missing-principal-user' {
        $task.Principal.PSObject.Properties.Remove('UserId')
    }
    'foreign-trigger-class' {
        $task.Triggers = @([pscustomobject]@{
            CimClassName = 'MSFT_TaskTimeTrigger'
            UserId = $currentUserSid
            Enabled = $true
        })
    }
    'foreign-trigger-user' {
        $task.Triggers = @([pscustomobject]@{
            CimClassName = 'MSFT_TaskLogonTrigger'
            UserId = 'unresolvable-foreign-user'
            Enabled = $true
        })
    }
    'foreign-trigger-disabled' {
        $task.Triggers = @([pscustomobject]@{
            CimClassName = 'MSFT_TaskLogonTrigger'
            UserId = $currentUserSid
            Enabled = $false
        })
    }
    'foreign-trigger-extra' {
        $task.Triggers = @(
            [pscustomobject]@{
                CimClassName = 'MSFT_TaskLogonTrigger'
                UserId = $currentUserSid
                Enabled = $true
            },
            [pscustomobject]@{
                CimClassName = 'MSFT_TaskLogonTrigger'
                UserId = $currentUserSid
                Enabled = $true
            }
        )
    }
    'missing-trigger-user' {
        $task.Triggers = @([pscustomobject]@{
            CimClassName = 'MSFT_TaskLogonTrigger'
            Enabled = $true
        })
    }
    'foreign-setting' {
        $task.Settings.RestartCount = 4
    }
    'missing-setting-property' {
        $task.Settings.PSObject.Properties.Remove('AllowDemandStart')
    }
    'missing-principal' {
        $task.PSObject.Properties.Remove('Principal')
    }
    'missing-triggers' {
        $task.PSObject.Properties.Remove('Triggers')
    }
    'missing-settings' {
        $task.PSObject.Properties.Remove('Settings')
    }
}

function Get-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath,
        [object]$ErrorAction
    )
    return $task
}

function Get-ScheduledTaskInfo {
    param(
        [string]$TaskName,
        [string]$TaskPath,
        [object]$ErrorAction
    )
    return [pscustomobject]@{
        LastTaskResult = $global:CodexRemoteMockLastTaskResult
    }
}

function Get-NetTCPConnection {
    param(
        [object]$State,
        [int]$LocalPort,
        [object]$ErrorAction
    )
    if ($LocalPort -ne 18790) {
        return @()
    }
    if ($Mode -ceq 'sidecar-nonloopback') {
        return @(
            [pscustomobject]@{
                LocalAddress = '0.0.0.0'
                OwningProcess = 4242
            }
        )
    }
    if ($Mode -ceq 'sidecar-multiple') {
        return @(
            [pscustomobject]@{
                LocalAddress = '127.0.0.1'
                OwningProcess = 4242
            },
            [pscustomobject]@{
                LocalAddress = '127.0.0.1'
                OwningProcess = 4243
            }
        )
    }
    if ($Mode -ceq 'sidecar-ipv6-loopback-neighbor') {
        return @(
            [pscustomobject]@{
                LocalAddress = '127.0.0.1'
                OwningProcess = 4242
            },
            [pscustomobject]@{
                LocalAddress = '::1'
                OwningProcess = 5252
            }
        )
    }
    return @(
        [pscustomobject]@{
            LocalAddress = '127.0.0.1'
            OwningProcess = 4242
        }
    )
}

function Get-CimInstance {
    param(
        [string]$ClassName,
        [string]$Filter,
        [object]$ErrorAction
    )
    if ($ClassName -ceq 'Win32_Process' -and $Filter -ceq 'ProcessId = 4242') {
        return [pscustomobject]@{
            ProcessId = 4242
            ParentProcessId = 1
            Name = 'node.exe'
            ExecutablePath = $NodePath
            CommandLine = if ($Mode -ceq 'sidecar-foreign') {
                "$managedSidecarCommandLine --foreign"
            } else {
                $managedSidecarCommandLine
            }
        }
    }
    return @()
}

function Invoke-RestMethod {
    throw 'mock endpoint unavailable'
}

$null = [System.IO.Directory]::CreateDirectory($resolvedDataDir)
$capabilityTokenPath = Get-BrokerCapabilityTokenPath -DataDir $resolvedDataDir
[System.IO.File]::WriteAllText(
    $capabilityTokenPath,
    ('A' * 43),
    [System.Text.UTF8Encoding]::new($false)
)
$legacyLauncherPath = [System.IO.Path]::GetFullPath(
    (Join-Path $InstallRoot 'scripts\windows\Launch-CodexWithRemote.ps1')
)
$launcherPath =
    Get-CodexLocalRemoteControlDispatcherPath -DataDir $resolvedDataDir
$null = [System.IO.Directory]::CreateDirectory(
    (Split-Path -Parent $launcherPath)
)
[System.IO.File]::Copy(
    (Join-Path `
        (Split-Path -Parent $TargetScript) `
        'CodexLocalRemote.Control.ps1'),
    $launcherPath,
    $true
)
$safeLaunchName = 'Codex Remote (' +
    (([char[]]@(0x5B89, 0x5168, 0x542F, 0x52A8)) -join '') +
    ')'
$launcherShortcutPath = Join-Path $resolvedDataDir 'status-launcher.lnk'
$fixtureIconSource = Join-Path $PSHOME 'pwsh.exe'
$managedIcon = Install-CodexLocalRemoteManagedDesktopIcon `
    -DataDir $resolvedDataDir `
    -DesktopExecutablePath $fixtureIconSource
$userEnvironmentFixturePath = Join-Path $resolvedDataDir 'user-environment.json'
$userEnvironmentFixture = if ($Mode -ceq 'persistent-user-override') {
    [ordered]@{
        Exists = $true
        Value = 'ws://127.0.0.1:65530/ws/fixture'
    }
} else {
    [ordered]@{
        Exists = $false
        Value = $null
    }
}
$userEnvironmentFixture |
    ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath $userEnvironmentFixturePath -Encoding utf8NoBOM
$desktopLaunchReceiptPath = Join-Path $resolvedDataDir 'desktop-launch-last.json'
if ($Mode -cin @(
    'valid-launch-receipt',
    'invalid-launch-receipt'
)) {
    $desktopLaunchReceipt = [ordered]@{
        Signature = 'codex-local-remote/desktop-launch/v1'
        Version = 1
        Status = 'launched-remote'
        RemoteEnabled = $true
        RemoteDecision = 'remote-ready'
        RemoteFallbackAttempts = 0
        RemoteStopAttempts = 0
        DesktopProcessId = 42424
        RecordedAtUtc = '2026-07-27T12:34:56.0000000Z'
    }
    if ($Mode -ceq 'invalid-launch-receipt') {
        $desktopLaunchReceipt.Unexpected = 'not-allowed'
    }
    $desktopLaunchReceipt |
        ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath $desktopLaunchReceiptPath -Encoding utf8NoBOM
} elseif ($Mode -like '*launch-receipt-v2*') {
    $desktopLaunchReceipt = [ordered]@{
        Signature = 'codex-local-remote/desktop-launch/v2'
        Version = 2
        Status = 'launched-native'
        RemoteEnabled = $false
        RemoteDecision = 'remote-start-failed'
        RemoteFallbackAttempts = 1
        RemoteStopAttempts = 0
        DesktopProcessId = 42424
        RemoteFailureStage = 'runtime-handoff'
        RemoteFailureCode = 'runtime-handoff-failed'
        CorrelationId = '0123456789abcdef0123456789abcdef'
        FeedbackStatus = 'render-failed'
        FeedbackFailureCode = 'feedback-render-failed'
        RecordedAtUtc = '2026-07-29T23:45:56.0000000Z'
    }
    switch ($Mode) {
        'valid-launch-receipt-v2-success' {
            $desktopLaunchReceipt.Status = 'launched-remote'
            $desktopLaunchReceipt.RemoteEnabled = $true
            $desktopLaunchReceipt.RemoteDecision = 'remote-attached'
            $desktopLaunchReceipt.RemoteFallbackAttempts = 0
            $desktopLaunchReceipt.RemoteFailureStage = $null
            $desktopLaunchReceipt.RemoteFailureCode = $null
            $desktopLaunchReceipt.CorrelationId = $null
            $desktopLaunchReceipt.FeedbackStatus = 'rendered'
            $desktopLaunchReceipt.FeedbackFailureCode = $null
        }
        'invalid-launch-receipt-v2-extra' {
            $desktopLaunchReceipt.RawException =
                'PRIVATE_FAILURE_SENTINEL C:\private\path at hidden stack'
        }
        'invalid-launch-receipt-v2-stage' {
            $desktopLaunchReceipt.RemoteFailureStage = 7
        }
        'invalid-launch-receipt-v2-code' {
            $desktopLaunchReceipt.RemoteFailureCode =
                'PRIVATE_FAILURE_SENTINEL C:\private\path'
        }
        'invalid-launch-receipt-v2-decision' {
            $desktopLaunchReceipt.RemoteDecision =
                'PRIVATE_FAILURE_SENTINEL raw-exception'
        }
        'invalid-launch-receipt-v2-correlation' {
            $desktopLaunchReceipt.CorrelationId =
                'PRIVATE_FAILURE_SENTINEL-not-a-correlation-id'
        }
        'invalid-launch-receipt-v2-feedback-status' {
            $desktopLaunchReceipt.FeedbackStatus =
                'PRIVATE_FAILURE_SENTINEL raw-feedback-error'
            $desktopLaunchReceipt.FeedbackFailureCode = $null
        }
        'invalid-launch-receipt-v2-feedback' {
            $desktopLaunchReceipt.FeedbackStatus = 'rendered'
        }
        'invalid-launch-receipt-v2-failure-pair' {
            $desktopLaunchReceipt.RemoteFailureStage = $null
        }
    }
    $desktopLaunchReceipt |
        ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath $desktopLaunchReceiptPath -Encoding utf8NoBOM
}
$launcherIsLegacy = $Mode -ceq 'launcher-legacy-takeover'
$launcherArguments = if ($launcherIsLegacy) {
    @(
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $legacyLauncherPath,
        '-DataDir',
        $resolvedDataDir,
        '-BrokerPort',
        '18791',
        '-TaskName',
        $taskName,
        '-TakeOverExistingNativeDesktop'
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
    $launcherPath,
    '-Operation',
    'Open',
        '-DataDir',
        $resolvedDataDir,
        '-AllowDesktopRestart',
        '-InteractiveShortcutFeedback'
    )
}
$launcherArguments = $launcherArguments | ForEach-Object {
    ConvertTo-WindowsCommandLineArgument -Value ([string]$_)
}
$shell = New-Object -ComObject WScript.Shell
$launcherShortcut = $shell.CreateShortcut($launcherShortcutPath)
try {
    $launcherShortcut.TargetPath = [System.IO.Path]::GetFullPath($PwshPath)
    $launcherShortcut.Arguments = $launcherArguments -join ' '
    $launcherShortcut.WorkingDirectory = if ($launcherIsLegacy) {
        [System.IO.Path]::GetFullPath($InstallRoot)
    } else {
        $resolvedDataDir
    }
    $launcherShortcut.Description = if ($launcherIsLegacy) {
        'Codex Remote - Uses Remote when ready and otherwise starts Codex Desktop natively.'
    } else {
        'Codex Remote - Explicitly opens Remote through the stable control dispatcher.'
    }
    if ($Mode -clike 'launcher-codepage-*') {
        $launcherShortcut.Description =
            'Codex Remote (????)' +
            $launcherShortcut.Description.Substring('Codex Remote'.Length)
    }
    if ($Mode -ceq 'launcher-codepage-foreign-arguments') {
        $launcherShortcut.Arguments =
            $launcherShortcut.Arguments.Replace(
                '-Operation Open',
                '-Operation Close'
            )
    }
    $launcherShortcut.IconLocation = "$($managedIcon.IconPath),0"
    $launcherShortcut.WindowStyle = if ($Mode -cin @(
            'launcher-minimized',
            'launcher-codepage-minimized'
        )) {
        7
    } else {
        1
    }
    $launcherShortcut.Save()
} finally {
    $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject(
        $launcherShortcut
    )
    $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
}
if ($Mode -cnotin @(
        'launcher-non-elevated',
        'launcher-codepage-non-elevated'
    )) {
    $stream = [System.IO.File]::Open(
        $launcherShortcutPath,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
    try {
        $header = [byte[]]::new(24)
        if ($stream.Read($header, 0, $header.Length) -ne $header.Length -or
            [BitConverter]::ToUInt32($header, 0) -ne 76) {
            throw 'fixture launcher shell link header is invalid'
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
}

try {
    $env:CODEX_REMOTE_TEST_FIXTURE = '1'
    & $TargetScript `
        -InstallRoot $InstallRoot `
        -DataDir $DataDir `
        -NodePath $NodePath `
        -CodexPath $CodexPath `
        -PwshPath $PwshPath `
        -LauncherShortcutPath $launcherShortcutPath `
        -UserEnvironmentFixturePath $userEnvironmentFixturePath `
        -Json
} finally {
    Remove-Item Env:\CODEX_REMOTE_TEST_FIXTURE -ErrorAction SilentlyContinue
}
