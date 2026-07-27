[CmdletBinding()]
param(
    [string]$SourcePath = (
        Join-Path $PSScriptRoot '..\..\..\scripts\windows\Migrate-CodexLocalRemoteSharedOwner.ps1'
    )
)

$ErrorActionPreference = 'Stop'

function Assert-Equal {
    param(
        [Parameter(Mandatory)][object]$Expected,
        [Parameter(Mandatory)][object]$Actual,
        [Parameter(Mandatory)][string]$Message
    )
    if ($Expected -cne $Actual) {
        throw "$Message Expected='$Expected' Actual='$Actual'."
    }
}

function Assert-True {
    param(
        [Parameter(Mandatory)][bool]$Condition,
        [Parameter(Mandatory)][string]$Message
    )
    if (-not $Condition) {
        throw $Message
    }
}

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $SourcePath,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) {
    throw "Source parse failed: $($parseErrors[0].Message)"
}

foreach ($name in @(
    'Protect-LogText',
    'Stop-ExactKnownSidecar',
    'Wait-V2ReadyStatus',
    'Get-V2ReadyGateSummary',
    'ConvertTo-RedactedEvidenceObject',
    'Test-StartupDiagnosticFresh',
    'Get-TaskXmlSha256',
    'Start-OrRestoreOriginalV1Task'
)) {
    $definition = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -ceq $name
    }, $true)
    if ($null -eq $definition) {
        throw "Expected source function '$name' was not found."
    }
    . ([scriptblock]::Create($definition.Extent.Text))
}

$script:InstallRoot = 'C:\simulation\v2'
$script:RollbackRoot = 'C:\simulation\v1'
$script:DataDir = 'C:\simulation\data'
$script:SidecarPort = 18790
$script:BasePath = '/codex-remote'
$script:nodePath = 'C:\simulation\node.exe'
$script:logMessages = [System.Collections.Generic.List[string]]::new()
$script:managedRoot = $script:InstallRoot

function Get-StringSha256 {
    param([Parameter(Mandatory)][string]$Value)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    try {
        return [Convert]::ToHexString(
            [System.Security.Cryptography.SHA256]::HashData($bytes)
        ).ToLowerInvariant()
    } finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function Write-Step {
    param([Parameter(Mandatory)][string]$Message)
    $script:logMessages.Add($Message)
}

function Test-ManagedSidecarProcess {
    param(
        [string]$CommandLine,
        [string]$ExecutablePath,
        [string]$ExpectedNodePath,
        [string]$ExpectedSidecarCliPath,
        [int]$Port,
        [string]$BasePath,
        [string]$DataDir
    )
    $managedCli = Join-Path $script:managedRoot 'apps\sidecar\dist\cli.js'
    return [pscustomobject]@{
        IsManaged = (
            [System.IO.Path]::GetFullPath($ExpectedSidecarCliPath) -ceq
            [System.IO.Path]::GetFullPath($managedCli)
        )
    }
}

# Regression: the listener owner exits between the listener and process
# snapshots. A fresh listener snapshot is empty, so cleanup succeeds without
# invoking any stop script.
$script:listenerCalls = 0
$script:processCalls = 0
$script:sleepCalls = 0
$script:stopCalls = 0
$listenerThenGone = {
    param([int]$Port)
    $script:listenerCalls++
    if ($script:listenerCalls -eq 1) {
        return [pscustomobject]@{
            LocalAddress = '127.0.0.1'
            OwningProcess = 41001
        }
    }
    return @()
}
$missingProcess = {
    param([int]$ProcessId)
    $script:processCalls++
    return $null
}
$recordSleep = {
    param([int]$Milliseconds)
    $script:sleepCalls++
}
$recordStop = {
    param([string]$ExpectedSidecarCliPath, [int]$OwnerProcessId)
    $script:stopCalls++
    return [pscustomobject]@{ Status = 'stopped' }
}
Stop-ExactKnownSidecar `
    -GetListenerAction $listenerThenGone `
    -GetProcessAction $missingProcess `
    -SleepAction $recordSleep `
    -StopKnownSidecarAction $recordStop
Assert-Equal 2 $script:listenerCalls 'Cleanup must refresh the listener snapshot.'
Assert-Equal 1 $script:processCalls 'Cleanup should inspect the stale owner once.'
Assert-Equal 1 $script:sleepCalls 'A disappeared owner should trigger one short retry.'
Assert-Equal 0 $script:stopCalls 'A disappeared owner must never reach a stop script.'
Assert-True `
    ($script:logMessages -join "`n" -match 'disappeared.*retry') `
    'The race retry must be recorded in migration evidence.'

# A foreign owner appearing after the stale snapshot is never accepted and is
# never passed to the exact-known stop action.
$script:listenerCalls = 0
$script:processCalls = 0
$script:sleepCalls = 0
$script:stopCalls = 0
$script:managedRoot = 'C:\simulation\neither-known-root'
$staleThenForeign = {
    param([int]$Port)
    $script:listenerCalls++
    if ($script:listenerCalls -eq 1) {
        return [pscustomobject]@{
            LocalAddress = '127.0.0.1'
            OwningProcess = 42001
        }
    }
    return [pscustomobject]@{
        LocalAddress = '127.0.0.1'
        OwningProcess = 42002
    }
}
$firstMissingThenForeignProcess = {
    param([int]$ProcessId)
    $script:processCalls++
    if ($ProcessId -eq 42001) {
        return $null
    }
    return [pscustomobject]@{
        ProcessId = $ProcessId
        CommandLine = 'foreign-sidecar'
        ExecutablePath = 'C:\foreign\node.exe'
    }
}
$foreignError = $null
try {
    Stop-ExactKnownSidecar `
        -GetListenerAction $staleThenForeign `
        -GetProcessAction $firstMissingThenForeignProcess `
        -SleepAction $recordSleep `
        -StopKnownSidecarAction $recordStop
} catch {
    $foreignError = $_.Exception.Message
}
Assert-True ($null -ne $foreignError) 'A foreign replacement owner must fail closed.'
Assert-True `
    ($foreignError -match 'not exactly one known V1/V2') `
    'The foreign-owner failure must identify the exact ownership gate.'
Assert-Equal 0 $script:stopCalls 'A foreign replacement owner must never be stopped.'

# Repeated stale snapshots are bounded and report the last observed ownership
# state instead of looping forever or treating disappearance as ownership.
$script:listenerCalls = 0
$script:processCalls = 0
$script:sleepCalls = 0
$script:stopCalls = 0
$alwaysStaleListener = {
    param([int]$Port)
    $script:listenerCalls++
    return [pscustomobject]@{
        LocalAddress = '127.0.0.1'
        OwningProcess = 42501
    }
}
$exhaustedError = $null
try {
    Stop-ExactKnownSidecar `
        -MaximumSnapshots 3 `
        -GetListenerAction $alwaysStaleListener `
        -GetProcessAction $missingProcess `
        -SleepAction $recordSleep `
        -StopKnownSidecarAction $recordStop
} catch {
    $exhaustedError = $_.Exception.Message
}
Assert-True ($null -ne $exhaustedError) 'Repeated stale snapshots must fail closed.'
Assert-True `
    ($exhaustedError -match '3 fresh snapshots') `
    'Retry exhaustion evidence must include the snapshot bound.'
Assert-True `
    ($exhaustedError -match 'ownerProcessState=disappeared') `
    'Retry exhaustion evidence must identify the last process state.'
Assert-Equal 3 $script:listenerCalls 'Retry exhaustion must honor the snapshot bound.'
Assert-Equal 2 $script:sleepCalls 'The final exhausted snapshot must not sleep again.'
Assert-Equal 0 $script:stopCalls 'A stale snapshot must never reach a stop script.'

# An exact known owner may call the stop action, after which a new listener
# snapshot must prove that the port is empty.
$script:listenerCalls = 0
$script:processCalls = 0
$script:sleepCalls = 0
$script:stopCalls = 0
$script:managedRoot = $script:InstallRoot
$knownThenGone = {
    param([int]$Port)
    $script:listenerCalls++
    if ($script:listenerCalls -eq 1) {
        return [pscustomobject]@{
            LocalAddress = '127.0.0.1'
            OwningProcess = 43001
        }
    }
    return @()
}
$knownProcess = {
    param([int]$ProcessId)
    $script:processCalls++
    return [pscustomobject]@{
        ProcessId = $ProcessId
        CommandLine = 'known-sidecar'
        ExecutablePath = $script:nodePath
    }
}
Stop-ExactKnownSidecar `
    -GetListenerAction $knownThenGone `
    -GetProcessAction $knownProcess `
    -SleepAction $recordSleep `
    -StopKnownSidecarAction $recordStop
Assert-Equal 2 $script:listenerCalls 'Known-owner cleanup must prove the final empty port.'
Assert-Equal 1 $script:stopCalls 'Exactly one known owner should be stopped once.'

# The inner stop script can legitimately observe that the exact owner exited
# after the outer ownership proof. That idempotent result is accepted only
# because the next fresh listener snapshot proves the port is empty.
$script:listenerCalls = 0
$script:processCalls = 0
$script:sleepCalls = 0
$script:stopCalls = 0
$innerAlreadyGone = {
    param([string]$ExpectedSidecarCliPath, [int]$OwnerProcessId)
    $script:stopCalls++
    return [pscustomobject]@{ Status = 'not-found' }
}
Stop-ExactKnownSidecar `
    -GetListenerAction $knownThenGone `
    -GetProcessAction $knownProcess `
    -SleepAction $recordSleep `
    -StopKnownSidecarAction $innerAlreadyGone
Assert-Equal 2 $script:listenerCalls 'An idempotent inner result still requires a fresh empty-port proof.'
Assert-Equal 1 $script:stopCalls 'The inner race path must invoke the exact stop action only once.'

# Final Ready is polled instead of being judged from one transient status.
$script:statusCalls = 0
$script:statusSleeps = 0
$eventuallyReady = {
    $script:statusCalls++
    return [pscustomobject]@{
        Ready = $true
        RuntimeReceiptReady = $true
        LauncherScriptReady = $true
        LauncherShortcutReady = $true
        LauncherConfigured = ($script:statusCalls -ge 2)
        LaunchMode = if ($script:statusCalls -ge 2) {
            'process-scoped-fail-open'
        } else {
            'native-only'
        }
        LegacyPersistentOverrideBlocked = $false
        LegacyEnvironmentState = 'none'
    }
}
$statusNoWait = {
    param([int]$Milliseconds)
    $script:statusSleeps++
}
$readyStatus = Wait-V2ReadyStatus `
    -TimeoutSeconds 30 `
    -GetStatusAction $eventuallyReady `
    -SleepAction $statusNoWait
Assert-True ([bool]$readyStatus.Ready) 'Final status polling must return the later Ready status.'
Assert-True ([bool]$readyStatus.LauncherConfigured) 'Final status polling must require the safe launcher.'
Assert-Equal 2 $script:statusCalls 'Final status polling must skip a nominally Ready status without the safe launcher.'
Assert-Equal 1 $script:statusSleeps 'Final status polling should wait between snapshots.'

# An exact legacy recovery-state file is compatible input to registration, but
# migration is not complete until the registrar has retired it.
$script:statusCalls = 0
$script:statusSleeps = 0
$eventuallyRetired = {
    $script:statusCalls++
    return [pscustomobject]@{
        Ready = $true
        RuntimeReceiptReady = $true
        LauncherScriptReady = $true
        LauncherShortcutReady = $true
        LauncherConfigured = $true
        LaunchMode = if ($script:statusCalls -eq 1) {
            'blocked-persistent-user-override'
        } else {
            'process-scoped-fail-open'
        }
        LegacyPersistentOverrideBlocked = ($script:statusCalls -eq 1)
        LegacyEnvironmentState = switch ($script:statusCalls) {
            1 { 'active-with-managed-state' }
            2 { 'stale-managed-state' }
            default { 'none' }
        }
    }
}
$retiredStatus = Wait-V2ReadyStatus `
    -TimeoutSeconds 30 `
    -GetStatusAction $eventuallyRetired `
    -SleepAction $statusNoWait
Assert-Equal 'none' $retiredStatus.LegacyEnvironmentState 'Final status must prove exact legacy state retirement.'
Assert-Equal 3 $script:statusCalls 'Final status polling must block the override, then wait for exact state retirement.'
Assert-Equal 2 $script:statusSleeps 'Persistent override cleanup and state retirement should each be polled.'

# Timeout returns the last full status for evidence instead of discarding it.
$script:statusCalls = 0
$neverReady = {
    $script:statusCalls++
    return [pscustomobject]@{
        Ready = $false
        RuntimeReceiptReady = $false
        DesktopConnected = $true
        SidecarConnected = $false
        Degraded = $true
    }
}
$lastStatus = Wait-V2ReadyStatus `
    -TimeoutSeconds 0 `
    -GetStatusAction $neverReady `
    -SleepAction $statusNoWait
Assert-Equal 1 $script:statusCalls 'A zero-second timeout still captures one final status.'
Assert-True (-not [bool]$lastStatus.Ready) 'Timeout must return the last non-Ready status.'

$gateStatus = [pscustomobject]@{
    Ready = $false
    RuntimeReceiptReady = $false
    TaskOwned = $true
    TaskRunning = $false
    TaskReady = $false
    LoopbackListener = $true
    SidecarListenerReady = $true
    SidecarOwned = $true
    BrokerReady = $true
    DesktopConnected = $true
    SidecarConnected = $false
    Degraded = $true
    UnknownCount = 2
    LauncherScriptReady = $true
    LauncherShortcutReady = $false
    LauncherConfigured = $false
    LaunchMode = 'blocked-persistent-user-override'
    LegacyPersistentOverrideBlocked = $true
    LegacyEnvironmentState = 'active-with-managed-state'
    ForceCliBlocked = $false
    DesktopIndependentStdioAppServer = $false
    Product = 'Codex Local Remote'
    PublicRoute = 'configured'
    CapabilityEndpoint = 'ws://127.0.0.1:18791/ws/secret-endpoint-token'
    Token = 'secret-token'
    LocalError = 'failed at ws://127.0.0.1:18791/ws/secret-endpoint-token?token=secret-token'
}
$summary = Get-V2ReadyGateSummary -Status $gateStatus
Assert-True ($summary -match 'taskReady=False') 'Failure summary must include the task readiness gate.'
Assert-True ($summary -match 'runtimeReceiptReady=False') 'Failure summary must include the runtime receipt gate.'
Assert-True ($summary -match 'sidecarConnected=False') 'Failure summary must include gate values.'
Assert-True ($summary -match 'unknownCount=2') 'Failure summary must include count gates.'
Assert-True ($summary -match 'launcherConfigured=False') 'Failure summary must include the safe launcher gate.'
Assert-True `
    ($summary -match 'launchMode=blocked-persistent-user-override') `
    'Failure summary must include the fail-open launch mode.'
Assert-True `
    ($summary -match 'legacyPersistentOverrideBlocked=True') `
    'Failure summary must identify any persistent user override as a blocker.'
Assert-True `
    ($summary -match 'legacyEnvironmentState=active-with-managed-state') `
    'Failure summary must retain the exact legacy-state retirement evidence.'
Assert-True `
    ($summary -notmatch 'desktopEnvironmentConfigured') `
    'Failure summary must not require the retired persistent-environment gate.'
Assert-True ($summary -notmatch '(?i)endpoint|token|secret') 'Failure summary must omit endpoints and tokens.'

$redacted = ConvertTo-RedactedEvidenceObject -Value $gateStatus
$redactedJson = $redacted | ConvertTo-Json -Depth 20 -Compress
Assert-True ($redactedJson -notmatch 'secret-endpoint-token|secret-token') 'Evidence must remove secret values.'
Assert-True ($redactedJson -match '"CapabilityEndpoint":"<redacted>"') 'Evidence must retain redacted property shape.'
Assert-True ($redactedJson -match '"SidecarConnected":false') 'Evidence must retain non-sensitive gates.'

$freshBoundary = [DateTimeOffset]::Parse(
    '2026-07-26T00:30:00Z',
    [System.Globalization.CultureInfo]::InvariantCulture,
    [System.Globalization.DateTimeStyles]::RoundtripKind
)
$freshStartup = [pscustomobject]@{
    Signature = 'codex-local-remote/startup-status/v3'
    Version = 3
    BootstrapInvocationId = '0123456789abcdef0123456789abcdef'
    RuntimeInvocationId = 'fedcba9876543210fedcba9876543210'
    RecordedAtUtc = '2026-07-26T00:30:01Z'
}
Assert-True `
    (Test-StartupDiagnosticFresh -Status $freshStartup -NotBeforeUtc $freshBoundary) `
    'A new invocation recorded after the boundary must be accepted.'
$freshStartup.RecordedAtUtc = '2026-07-26T00:29:59Z'
Assert-True `
    (-not (Test-StartupDiagnosticFresh -Status $freshStartup -NotBeforeUtc $freshBoundary)) `
    'A stale invocation recorded before the boundary must be rejected.'
$freshStartup.RecordedAtUtc = '2026-07-26T00:30:01Z'
$freshStartup.BootstrapInvocationId = ''
Assert-True `
    (-not (Test-StartupDiagnosticFresh -Status $freshStartup -NotBeforeUtc $freshBoundary)) `
    'A legacy status without this invocation identity must be rejected.'
$freshStartup.BootstrapInvocationId = '0123456789abcdef0123456789abcdef'
$freshStartup.RecordedAtUtc = 'not-a-timestamp'
Assert-True `
    (-not (Test-StartupDiagnosticFresh -Status $freshStartup -NotBeforeUtc $freshBoundary)) `
    'An unparseable status timestamp must be rejected.'
$sourceText = Get-Content -LiteralPath $SourcePath -Raw
Assert-True `
    ($sourceText -match '(?s)Remove-Item\s+-LiteralPath\s+\$startupStatusPath\s+-Force.*\$v2StartupNotBeforeUtc\s*=\s*\[DateTimeOffset\]::UtcNow.*Start-ScheduledTask') `
    'Migration must remove stale startup evidence and set a freshness boundary before task start.'
Assert-True `
    ($sourceText -match 'Local\\CodexLocalRemoteMigration-\$mutexSuffix') `
    'Migration must use an install-root-scoped named mutex.'
Assert-True `
    ($sourceText -match '\.WaitOne\(0\)') `
    'Migration must fail fast instead of waiting behind another mutating run.'
Assert-True `
    ($sourceText -match "Status\s*=\s*'in-progress'") `
    'Migration must overwrite any stale result at the beginning of a run.'
Assert-True `
    ($sourceText -match 'CanonicalWeb\s*=\s*ConvertTo-CanonicalJson') `
    'Migration must retain a canonical snapshot of the complete Funnel web configuration.'
Assert-True `
    ($sourceText -match '\$after\.CanonicalWeb\s+-cne\s+\$Before\.CanonicalWeb') `
    'Migration must reject any complete Funnel configuration drift.'
Assert-True `
    ($sourceText -match 'function\s+Get-ProcessFingerprint') `
    'Migration must retain a creation-time and command identity fingerprint for port 18789.'
Assert-True `
    ($sourceText -match '(?s)&\s+\$RegisterTaskXmlAction\s+\$script:originalTaskXml.*Get-TaskXmlSha256') `
    'Rollback must restore and verify the original task XML instead of rebuilding defaults.'
Assert-True `
    ($sourceText -match 'function\s+Test-ExactOriginalV1Runtime') `
    'Rollback must verify the exact original V1 Sidecar process, not just any listener.'
Assert-True `
    ($sourceText -match 'ports must be distinct and must not use reserved port 18789') `
    'Migration must reserve 18789 and require distinct managed ports.'
$preflightStart = $sourceText.IndexOf("Write-Step 'Migration preflight started.'")
$dataDirectoryPlanCall = $sourceText.IndexOf(
    '$dataDirectoryPlan = Get-CodexLocalRemoteDataDirectoryOwnershipPlan',
    $preflightStart
)
$preflightResultStart = $sourceText.IndexOf(
    '$preflight = [pscustomobject]@{',
    $dataDirectoryPlanCall
)
$desktopStopCall = $sourceText.IndexOf(
    '    Stop-CodexDesktopExact',
    $dataDirectoryPlanCall
)
Assert-True `
    ($preflightStart -ge 0 -and
        $dataDirectoryPlanCall -gt $preflightStart -and
        $dataDirectoryPlanCall -lt $preflightResultStart -and
        $dataDirectoryPlanCall -lt $desktopStopCall) `
    'DataDir ownership planning must run in common preflight before Desktop stop.'
Assert-True `
    ($sourceText -match 'DataDirectoryAction\s*=\s*\[string\]\$dataDirectoryPlan\.Action') `
    'Preflight results must record the non-sensitive DataDir plan action.'
Assert-True `
    ($sourceText -match 'DataDirectoryPath\s*=\s*\[string\]\$dataDirectoryPlan\.DataDir') `
    'Preflight results must record the canonical DataDir path.'
Assert-True `
    ($sourceText -match '(?s)\$lastStatus\.Ready\s+-ceq\s+\$true.*\$lastStatus\.LauncherConfigured\s+-ceq\s+\$true.*\$lastStatus\.LaunchMode\s+-ceq\s+''process-scoped-fail-open''.*\$lastStatus\.LegacyPersistentOverrideBlocked\s+-cne\s+\$true.*\$lastStatus\.LegacyEnvironmentState\s+-ceq\s+''none''') `
    'Migration readiness polling must directly require the fail-open launcher and block persistent overrides.'
Assert-True `
    ($sourceText -notmatch 'DesktopEnvironmentConfigured') `
    'Migration must not depend on the retired persistent Desktop environment status.'
Assert-True `
    ($sourceText -notmatch 'Install-BrokerUserEnvironment|EnvironmentVariableTarget\]::User|(?i)\bsetx(?:\.exe)?\b') `
    'Migration must never install a persistent Desktop endpoint override.'

$script:originalTaskXml = '<Task><Settings><Enabled>true</Enabled></Settings></Task>'
$script:originalTaskXmlSha256 = Get-TaskXmlSha256 -Xml $script:originalTaskXml
$script:originalLegacyRoot = $script:RollbackRoot
$script:restoreRegisterCalls = 0
$script:restoreStartCalls = 0
$registeredXml = [System.Collections.Generic.List[string]]::new()
Start-OrRestoreOriginalV1Task `
    -GetTaskAction { return $null } `
    -RegisterTaskXmlAction {
        param([string]$Xml)
        $script:restoreRegisterCalls++
        $registeredXml.Add($Xml)
    } `
    -AssertLegacyTaskAction {
        return [pscustomobject]@{ Root = $script:originalLegacyRoot }
    } `
    -ExportTaskXmlAction { return $script:originalTaskXml } `
    -StartTaskAction { $script:restoreStartCalls++ }
Assert-Equal 1 $script:restoreRegisterCalls 'A missing rollback task must be restored exactly once from XML.'
Assert-Equal $script:originalTaskXml $registeredXml[0] 'Rollback must pass the exact original XML.'
Assert-Equal 1 $script:restoreStartCalls 'An exactly restored task must be started once.'

$script:restoreStartCalls = 0
$mismatchedXmlError = $null
try {
    Start-OrRestoreOriginalV1Task `
        -GetTaskAction { return [pscustomobject]@{ TaskName = 'existing' } } `
        -AssertLegacyTaskAction {
            return [pscustomobject]@{ Root = $script:originalLegacyRoot }
        } `
        -ExportTaskXmlAction {
            return '<Task><Settings><Enabled>false</Enabled></Settings></Task>'
        } `
        -StartTaskAction { $script:restoreStartCalls++ }
} catch {
    $mismatchedXmlError = $_.Exception.Message
}
Assert-True ($null -ne $mismatchedXmlError) 'Rollback must reject a task whose XML changed.'
Assert-Equal 0 $script:restoreStartCalls 'A task with mismatched XML must never be started.'

[pscustomobject]@{
    Status = 'pass'
    Tests = 40
    Source = $SourcePath
} | ConvertTo-Json -Compress
