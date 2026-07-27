[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$TargetScript,

    [Parameter(Mandatory)]
    [ValidateSet(
        'valid-running',
        'valid-running-sid',
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
        'persistent-user-override'
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
            Execute = $expected.Execute
            Arguments = $expected.Arguments
            WorkingDirectory = $expected.WorkingDirectory
        }
    )
    Principal = [pscustomobject]@{
        UserId = $currentUser
        LogonType = 'Interactive'
        RunLevel = 'Limited'
    }
    Triggers = @(
        [pscustomobject]@{
            CimClassName = 'MSFT_TaskLogonTrigger'
            UserId = $currentUserSid
            Enabled = $true
        }
    )
    Settings = [pscustomobject]@{
        DisallowStartIfOnBatteries = $false
        StopIfGoingOnBatteries = $false
        ExecutionTimeLimit = 'P3650D'
        MultipleInstances = 'IgnoreNew'
        RestartCount = 3
        RestartInterval = 'PT1M'
        StartWhenAvailable = $true
        Enabled = $true
        AllowDemandStart = $true
        RunOnlyIfIdle = $false
        RunOnlyIfNetworkAvailable = $false
    }
}

switch ($Mode) {
    'valid-running-sid' {
        $task.Principal.UserId = $currentUserSid
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
        $task.Principal.RunLevel = 'Highest'
    }
    'missing-principal-user' {
        $task.Principal.PSObject.Properties.Remove('UserId')
    }
    'foreign-trigger-class' {
        $task.Triggers[0].CimClassName = 'MSFT_TaskTimeTrigger'
    }
    'foreign-trigger-user' {
        $task.Triggers[0].UserId = 'unresolvable-foreign-user'
    }
    'foreign-trigger-disabled' {
        $task.Triggers[0].Enabled = $false
    }
    'foreign-trigger-extra' {
        $task.Triggers = @($task.Triggers[0], $task.Triggers[0].PSObject.Copy())
    }
    'missing-trigger-user' {
        $task.Triggers[0].PSObject.Properties.Remove('UserId')
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
$launcherPath = [System.IO.Path]::GetFullPath(
    (Join-Path $InstallRoot 'scripts\windows\Launch-CodexWithRemote.ps1')
)
$safeLaunchName = 'Codex Remote (' +
    (([char[]]@(0x5B89, 0x5168, 0x542F, 0x52A8)) -join '') +
    ')'
$launcherShortcutPath = Join-Path $resolvedDataDir 'status-launcher.lnk'
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
$launcherArguments = @(
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $launcherPath,
    '-DataDir',
    $resolvedDataDir,
    '-BrokerPort',
    '18791',
    '-TaskName',
    $taskName
) | ForEach-Object {
    ConvertTo-WindowsCommandLineArgument -Value ([string]$_)
}
$shell = New-Object -ComObject WScript.Shell
$launcherShortcut = $shell.CreateShortcut($launcherShortcutPath)
try {
    $launcherShortcut.TargetPath = [System.IO.Path]::GetFullPath($PwshPath)
    $launcherShortcut.Arguments = $launcherArguments -join ' '
    $launcherShortcut.WorkingDirectory = [System.IO.Path]::GetFullPath($InstallRoot)
    $launcherShortcut.Description =
        "$safeLaunchName - Uses Remote when ready and otherwise starts Codex Desktop natively."
    $launcherShortcut.Save()
} finally {
    $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject(
        $launcherShortcut
    )
    $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
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
