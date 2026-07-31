[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$TargetScript,

    [Parameter(Mandatory)]
    [ValidateSet(
        'valid',
        'legacy-v2',
        'path-case',
        'id',
        'pid',
        'creation',
        'start',
        'argv',
        'bootstrap-argv',
        'schema',
        'version',
        'status',
        'missing',
        'mixed',
        'tail-replacement',
        'listener-replacement',
        'health-id',
        'health-pid',
        'proof-missing',
        'proof-digest-mismatch',
        'proof-runtime-mismatch',
        'proof-root-mismatch',
        'proof-unknown-client',
        'runtime-package-drift',
        'runtime-hash-drift',
        'runtime-blocked'
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
    [string]$PwshPath
)

$ErrorActionPreference = 'Stop'
$modulePath = Join-Path (Split-Path -Parent $TargetScript) 'CodexLocalRemote.Windows.psm1'
Import-Module $modulePath -Force

$runtimeId = '0123456789abcdef0123456789abcdef'
$otherRuntimeId = 'fedcba9876543210fedcba9876543210'
$bootstrapInvocationId = '00112233445566778899aabbccddeeff'
$taskName = 'Codex Local Remote'
$resolvedRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
$resolvedNode = [System.IO.Path]::GetFullPath($NodePath)
$resolvedCodex = [System.IO.Path]::GetFullPath($CodexPath)
$resolvedPwsh = [System.IO.Path]::GetFullPath($PwshPath)
$brokerCli = [System.IO.Path]::GetFullPath(
    (Join-Path $resolvedRoot 'apps\broker\dist\cli.js')
)
$sidecarCli = [System.IO.Path]::GetFullPath(
    (Join-Path $resolvedRoot 'apps\sidecar\dist\cli.js')
)
$capabilityTokenPath = [System.IO.Path]::GetFullPath(
    (Join-Path $resolvedDataDir 'broker-capability.token')
)
$upstreamTokenPath = [System.IO.Path]::GetFullPath(
    (Join-Path $resolvedDataDir 'app-server-upstream.token')
)
$startupPath = Join-Path $resolvedDataDir 'startup-last.json'
$brokerStatePath = Join-Path $resolvedDataDir 'app-server-broker.json'
$tokenSentinel = 'TOKEN_SENTINEL_SHOULD_NOT_BE_READ_0123456789abcdef'
$desktopLaunchNonceDigest = 'c' * 64

$null = New-Item -ItemType Directory -Path $resolvedDataDir -Force
$null = Protect-CodexLocalRemoteDataDirectory -DataDir $resolvedDataDir
[System.IO.File]::WriteAllText($capabilityTokenPath, $tokenSentinel)
[System.IO.File]::WriteAllText($upstreamTokenPath, $tokenSentinel)

$expectedTask = Get-StartupTaskDefinition `
    -TaskName $taskName `
    -NodePath $resolvedNode `
    -CodexPath $resolvedCodex `
    -PwshPath $resolvedPwsh `
    -InstallRoot $resolvedRoot `
    -DataDir $resolvedDataDir `
    -Port 18790 `
    -BrokerPort 18791 `
    -BrokerUpstreamPort 18792 `
    -BasePath '/codex-remote'
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$task = [pscustomobject]@{
    TaskName = $taskName
    TaskPath = '\'
    Description = $expectedTask.Description
    State = 'Running'
    Actions = @(
        [pscustomobject]@{
            Execute = $expectedTask.TaskExecute
            Arguments = $expectedTask.TaskArguments
            WorkingDirectory = $expectedTask.WorkingDirectory
        }
    )
    Principal = [pscustomobject]@{
        UserId = $currentSid
        LogonType = 'Interactive'
        RunLevel = 'Limited'
    }
    Triggers = @(
        [pscustomobject]@{
            CimClassName = 'MSFT_TaskLogonTrigger'
            UserId = $currentSid
            Enabled = $true
        }
    )
    Settings = $expectedTask.Settings
}

function New-Receipt {
    param(
        [Parameter(Mandatory)][int]$ProcessId,
        [Parameter(Mandatory)][datetime]$StartTime
    )

    return [ordered]@{
        RuntimeInvocationId = $runtimeId
        ProcessId = $ProcessId
        CreationDate = $StartTime.ToUniversalTime().ToString('O')
        CreationDateUtcTicks = $StartTime.ToUniversalTime().Ticks
        ProcessStartTimeUtcTicks = $StartTime.ToUniversalTime().Ticks
    }
}

$baseTime = [datetime]::SpecifyKind(
    [datetime]'2026-07-26T00:00:00',
    [DateTimeKind]::Utc
)
$bootstrapReceipt = New-Receipt -ProcessId 4100 -StartTime $baseTime
$brokerProcessReceipt = New-Receipt -ProcessId 4200 -StartTime $baseTime.AddSeconds(1)
$sidecarProcessReceipt = New-Receipt -ProcessId 4300 -StartTime $baseTime.AddSeconds(2)
$upstreamProcessReceipt = New-Receipt -ProcessId 4400 -StartTime $baseTime.AddSeconds(3)

$startupReceipt = [ordered]@{
    Signature = 'codex-local-remote/startup-status/v3'
    Version = 3
    Status = 'ready'
    Stage = 'supervising'
    Message = ''
    BootstrapInvocationId = $bootstrapInvocationId
    RuntimeInvocationId = $runtimeId
    Bootstrap = $bootstrapReceipt
    Runtime = [ordered]@{
        Signature = 'codex-local-remote/codex-desktop-runtime/v1'
        Version = 1
        PackageName = 'fixture'
        PackageFamilyName = 'fixture'
        PackageFullName = 'fixture'
        PackageVersion = '0'
        PackageInstallLocation = (Split-Path -Parent $resolvedCodex)
        DesktopExecutablePath = $resolvedCodex
        DesktopExecutableSha256 = ('A' * 64)
        BundledCodexPath = $resolvedCodex
        BundledCodexSha256 = ('B' * 64)
        CodexPath = $resolvedCodex
        CodexSha256 = ('B' * 64)
        Source = 'test-fixture'
        RunningDesktopObserved = $false
        DiscoveredAtUtc = '2026-07-26T00:00:05.0000000Z'
    }
    RecordedAtUtc = '2026-07-26T00:00:10.0000000Z'
}
$brokerReceipt = [ordered]@{
    Signature = 'codex-local-remote/app-server-broker/v3'
    Version = 3
    Status = 'ready'
    RuntimeInvocationId = $runtimeId
    Bootstrap = $bootstrapReceipt
    Broker = $brokerProcessReceipt
    Sidecar = $sidecarProcessReceipt
    Upstream = $upstreamProcessReceipt
    ProcessId = $brokerProcessReceipt.ProcessId
    CreationDate = $brokerProcessReceipt.CreationDate
    CreationDateUtcTicks = $brokerProcessReceipt.CreationDateUtcTicks
    ProcessStartTimeUtcTicks = $brokerProcessReceipt.ProcessStartTimeUtcTicks
    NodePath = $resolvedNode
    BrokerCliPath = $brokerCli
    CodexPath = $resolvedCodex
    StartedByThisInvocation = $true
    RecordedAtUtc = '2026-07-26T00:00:09.0000000Z'
}

$bootstrapCommand = (
    (ConvertTo-WindowsCommandLineArgument -Value $expectedTask.Execute) +
    ' ' +
    $expectedTask.Arguments
)
$brokerCommand = @(
    (ConvertTo-WindowsCommandLineArgument -Value $resolvedNode)
    (ConvertTo-WindowsCommandLineArgument -Value $brokerCli)
    'serve'
    '--host'
    '127.0.0.1'
    '--port'
    '18791'
    '--upstream-port'
    '18792'
    '--codex-path'
    (ConvertTo-WindowsCommandLineArgument -Value $resolvedCodex)
    '--data-dir'
    (ConvertTo-WindowsCommandLineArgument -Value $resolvedDataDir)
    '--capability-token-file'
    (ConvertTo-WindowsCommandLineArgument -Value $capabilityTokenPath)
) -join ' '
$sidecarCommand = @(
    (ConvertTo-WindowsCommandLineArgument -Value $resolvedNode)
    (ConvertTo-WindowsCommandLineArgument -Value $sidecarCli)
    'serve'
    '--host'
    '127.0.0.1'
    '--port'
    '18790'
    '--base-path'
    '/codex-remote'
    '--data-dir'
    (ConvertTo-WindowsCommandLineArgument -Value $resolvedDataDir)
) -join ' '
$upstreamCommand = @(
    (ConvertTo-WindowsCommandLineArgument -Value $resolvedCodex)
    '-c'
    'features.code_mode_host=true'
    'app-server'
    '--listen'
    'ws://127.0.0.1:18792'
    '--ws-auth'
    'capability-token'
    '--ws-token-file'
    (ConvertTo-WindowsCommandLineArgument -Value $upstreamTokenPath)
) -join ' '

if ($Mode -ceq 'path-case') {
    foreach ($path in @(
        $expectedTask.Execute,
        $expectedTask.Bootstrap,
        $expectedTask.Node,
        $expectedTask.WorkingDirectory,
        $expectedTask.DataDir
    )) {
        $bootstrapCommand = $bootstrapCommand.Replace(
            [string]$path,
            ([string]$path).ToUpperInvariant()
        )
    }
}

$processes = @{
    4100 = [pscustomobject]@{
        ProcessId = 4100
        ParentProcessId = 1
        Name = 'pwsh.exe'
        ExecutablePath = if ($Mode -ceq 'path-case') {
            $resolvedPwsh.ToUpperInvariant()
        } else {
            $resolvedPwsh
        }
        CommandLine = $bootstrapCommand
        CreationDate = $bootstrapReceipt.CreationDate
    }
    4200 = [pscustomobject]@{
        ProcessId = 4200
        ParentProcessId = 4100
        Name = 'node.exe'
        ExecutablePath = $resolvedNode
        CommandLine = $brokerCommand
        CreationDate = $brokerProcessReceipt.CreationDate
    }
    4300 = [pscustomobject]@{
        ProcessId = 4300
        ParentProcessId = 4100
        Name = 'node.exe'
        ExecutablePath = $resolvedNode
        CommandLine = $sidecarCommand
        CreationDate = $sidecarProcessReceipt.CreationDate
    }
    4400 = [pscustomobject]@{
        ProcessId = 4400
        ParentProcessId = 4200
        Name = 'codex.exe'
        ExecutablePath = $resolvedCodex
        CommandLine = $upstreamCommand
        CreationDate = $upstreamProcessReceipt.CreationDate
    }
    4500 = [pscustomobject]@{
        ProcessId = 4500
        ParentProcessId = 1
        Name = 'ChatGPT.exe'
        ExecutablePath = $resolvedCodex
        CommandLine = (ConvertTo-WindowsCommandLineArgument -Value $resolvedCodex)
        CreationDate = $baseTime.AddSeconds(4).ToString('O')
    }
}
$startTimes = @{
    4100 = $baseTime
    4200 = $baseTime.AddSeconds(1)
    4300 = $baseTime.AddSeconds(2)
    4400 = $baseTime.AddSeconds(3)
    4500 = $baseTime.AddSeconds(4)
}

switch ($Mode) {
    'legacy-v2' {
        $startupReceipt.Signature = 'codex-local-remote/startup-status/v2'
        $startupReceipt.Version = 2
        $startupReceipt.Remove('Runtime')
    }
    'id' {
        $brokerReceipt.Sidecar.RuntimeInvocationId = $otherRuntimeId
    }
    'pid' {
        $brokerReceipt.Broker.ProcessId = 4201
    }
    'creation' {
        $brokerReceipt.Upstream.CreationDateUtcTicks =
            [long]$brokerReceipt.Upstream.CreationDateUtcTicks + 1
    }
    'start' {
        $brokerReceipt.Bootstrap.ProcessStartTimeUtcTicks =
            [long]$brokerReceipt.Bootstrap.ProcessStartTimeUtcTicks +
            [TimeSpan]::FromSeconds(3).Ticks
        $startupReceipt.Bootstrap.ProcessStartTimeUtcTicks =
            $brokerReceipt.Bootstrap.ProcessStartTimeUtcTicks
    }
    'argv' {
        $processes[4300].CommandLine = "$sidecarCommand --foreign true"
    }
    'bootstrap-argv' {
        $processes[4100].CommandLine = "$bootstrapCommand -Foreign true"
    }
    'schema' {
        $brokerReceipt['Extra'] = 'foreign'
    }
    'version' {
        $startupReceipt.Version = 1
    }
    'status' {
        $brokerReceipt.Status = 'broker-ready'
    }
    'missing' {
        $brokerReceipt.Remove('Sidecar')
    }
    'mixed' {
        $startupReceipt.RuntimeInvocationId = $otherRuntimeId
        $startupReceipt.Bootstrap = [ordered]@{
            RuntimeInvocationId = $otherRuntimeId
            ProcessId = $bootstrapReceipt.ProcessId
            CreationDate = $bootstrapReceipt.CreationDate
            CreationDateUtcTicks = $bootstrapReceipt.CreationDateUtcTicks
            ProcessStartTimeUtcTicks = $bootstrapReceipt.ProcessStartTimeUtcTicks
        }
    }
}

$startupReceipt | ConvertTo-Json -Depth 20 |
    Set-Content -LiteralPath $startupPath -Encoding utf8NoBOM
$brokerReceipt | ConvertTo-Json -Depth 20 |
    Set-Content -LiteralPath $brokerStatePath -Encoding utf8NoBOM

if ($Mode -cne 'proof-missing') {
    $null = Write-CodexDesktopOwnerConnectionProof `
        -DataDir $resolvedDataDir `
        -RuntimeInvocationId $(if ($Mode -ceq 'proof-runtime-mismatch') {
            $otherRuntimeId
        } else {
            $runtimeId
        }) `
        -ProcessId $(if ($Mode -ceq 'proof-root-mismatch') { 4501 } else { 4500 }) `
        -StartTimeUtcTicks $baseTime.AddSeconds(4).Ticks `
        -ExecutablePath $resolvedCodex `
        -LaunchNonceDigest $(if ($Mode -ceq 'proof-digest-mismatch') {
            'd' * 64
        } else {
            $desktopLaunchNonceDigest
        })
}

$global:CodexRemoteTokenReadCount = 0
$global:CodexRemoteStatusReadCount = @{}
$global:CodexRemoteListenerReadCount = @{}

# The target imports the same already-loaded module with -Force. Prevent that
# test-only re-import from resolving through the command mocks below.
function Import-Module {
    param([Parameter(ValueFromRemainingArguments)][object[]]$Arguments)
}

function Get-Content {
    param(
        [string]$LiteralPath,
        [switch]$Raw,
        [object]$Encoding,
        [object]$ErrorAction
    )
    if ([System.IO.Path]::GetExtension($LiteralPath) -ceq '.token') {
        $global:CodexRemoteTokenReadCount++
        throw 'token sentinel read'
    }
    $count = 1 + [int]$global:CodexRemoteStatusReadCount[$LiteralPath]
    $global:CodexRemoteStatusReadCount[$LiteralPath] = $count
    $text = Microsoft.PowerShell.Management\Get-Content `
        -LiteralPath $LiteralPath `
        -Raw `
        -Encoding utf8
    if ($Mode -ceq 'tail-replacement' -and
        $LiteralPath -ceq $brokerStatePath -and
        $count -ge 2) {
        return "$text "
    }
    return $text
}

function Get-ScheduledTask {
    param([string]$TaskName, [string]$TaskPath, [object]$ErrorAction)
    return $task
}

function Get-ScheduledTaskInfo {
    param([string]$TaskName, [string]$TaskPath, [object]$ErrorAction)
    return [pscustomobject]@{ LastTaskResult = 267009 }
}

function Get-NetTCPConnection {
    param([object]$State, [int]$LocalPort, [object]$ErrorAction)
    $count = 1 + [int]$global:CodexRemoteListenerReadCount[$LocalPort]
    $global:CodexRemoteListenerReadCount[$LocalPort] = $count
    $ownerProcessId = switch ($LocalPort) {
        18790 { 4300 }
        18791 { 4200 }
        18792 { 4400 }
        default { return @() }
    }
    if ($Mode -ceq 'listener-replacement' -and $count -ge 3) {
        $ownerProcessId++
    }
    return @(
        [pscustomobject]@{
            LocalAddress = '127.0.0.1'
            LocalPort = $LocalPort
            OwningProcess = $ownerProcessId
        }
    )
}

function Get-CimInstance {
    param(
        [string]$ClassName,
        [string]$Filter,
        [object]$ErrorAction
    )
    if ($ClassName -cne 'Win32_Process') {
        return @()
    }
    if ($Filter -match '^ProcessId = ([0-9]+)$') {
        return $processes[[int]$Matches[1]]
    }
    if ($Filter -ceq "Name = 'ChatGPT.exe'") {
        return $processes[4500]
    }
    return @()
}

function Get-Process {
    param([int]$Id, [object]$ErrorAction)
    if (-not $startTimes.ContainsKey($Id)) {
        throw "mock PID $Id missing"
    }
    $result = [pscustomobject]@{
        Id = $Id
        StartTime = $startTimes[$Id]
    }
    $result | Add-Member -MemberType ScriptMethod -Name Dispose -Value {}
    return $result
}

function Invoke-RestMethod {
    param(
        [object]$Method,
        [string]$Uri,
        [int]$TimeoutSec
    )
    if ($Uri -like '*/api/v1/ready') {
        return [pscustomobject]@{
            status = 'ready'
        }
    }
    if ($Uri -ceq 'http://127.0.0.1:18791/ready') {
        return [pscustomobject]@{
            appServerReady = $true
            desktopConnected = $true
            sidecarConnected = $true
            degraded = $false
            unknownCount = if ($Mode -ceq 'proof-unknown-client') { 1 } else { 0 }
            runtimeInvocationId = if ($Mode -ceq 'health-id') {
                $otherRuntimeId
            } else {
                $runtimeId
            }
            brokerProcessId = if ($Mode -ceq 'health-pid') { 4201 } else { 4200 }
            upstreamProcessId = 4400
            desktopConnectionCount = 1
            desktopLaunchNonceDigests = @($desktopLaunchNonceDigest)
        }
    }
    if ($Uri -like '*/api/v1/bootstrap') {
        return [pscustomobject]@{
            productName = 'Codex Local Remote'
            configured = $true
            authenticated = $true
        }
    }
    throw "unexpected mock URI '$Uri'"
}

function Get-Command {
    throw 'mock command unavailable'
}

function Resolve-CodexDesktopRuntime {
    if ($Mode -ceq 'runtime-blocked') {
        throw 'fixture package discovery blocked'
    }
    return [pscustomobject][ordered]@{
        Signature = 'codex-local-remote/codex-desktop-runtime/v1'
        Version = 1
        PackageName = 'fixture'
        PackageFamilyName = 'fixture'
        PackageFullName = if ($Mode -ceq 'runtime-package-drift') {
            'fixture-new-generation'
        } else {
            'fixture'
        }
        PackageVersion = if ($Mode -ceq 'runtime-package-drift') { '1' } else { '0' }
        PackageInstallLocation = (Split-Path -Parent $resolvedCodex)
        DesktopExecutablePath = $resolvedCodex
        DesktopExecutableSha256 = ('A' * 64)
        BundledCodexPath = $resolvedCodex
        BundledCodexSha256 = if ($Mode -ceq 'runtime-hash-drift') {
            ('C' * 64)
        } else {
            ('B' * 64)
        }
        CodexPath = $resolvedCodex
        CodexSha256 = if ($Mode -ceq 'runtime-hash-drift') {
            ('C' * 64)
        } else {
            ('B' * 64)
        }
        Source = 'test-fixture-current-desktop'
        RunningDesktopObserved = $false
        DiscoveredAtUtc = '2026-07-26T00:00:11.0000000Z'
    }
}

try {
    $env:CODEX_REMOTE_TEST_FIXTURE = '1'
    $env:CODEX_REMOTE_TEST_RUNTIME_DISCOVERY = '1'
    $statusJson = & $TargetScript `
        -InstallRoot $resolvedRoot `
        -DataDir $resolvedDataDir `
        -NodePath $resolvedNode `
        -CodexPath $resolvedCodex `
        -PwshPath $resolvedPwsh `
        -Json
} finally {
    Remove-Item Env:\CODEX_REMOTE_TEST_FIXTURE -ErrorAction SilentlyContinue
    Remove-Item Env:\CODEX_REMOTE_TEST_RUNTIME_DISCOVERY -ErrorAction SilentlyContinue
}
$status = ($statusJson -join [Environment]::NewLine) | ConvertFrom-Json -Depth 30
[pscustomobject]@{
    Status = $status
    TokenReadCount = $global:CodexRemoteTokenReadCount
    OutputContainsTokenSentinel = (
        ($statusJson -join [Environment]::NewLine).Contains($tokenSentinel)
    )
} | ConvertTo-Json -Compress -Depth 30
