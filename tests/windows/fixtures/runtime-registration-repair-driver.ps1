[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$RegistrationPath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot,

    [Parameter(Mandatory)]
    [ValidateSet(
        'success',
        'success-running',
        'invalid-active',
        'active-drift-after-running',
        'active-drift-before-pointer-running',
        'active-drift-after-pointer-running',
        'task-state-drop-after-running',
        'pointer-after-effect',
        'pointer-after-effect-running',
        'rollback-task-before-effect-running',
        'rollback-task-after-effect-running',
        'rollback-pointer-before-effect-running',
        'rollback-pointer-after-effect-running',
        'register-active-after-effect-restore-before-running',
        'register-unbound-after-effect-restore-before-running'
    )]
    [string]$Mode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$TaskName = 'Codex Local Remote'
$NodePath = Join-Path $SandboxRoot 'node.exe'
$PwshPath = Join-Path $SandboxRoot 'pwsh.exe'
$Port = 18790
$BrokerPort = 18791
$BrokerUpstreamPort = 18792
$BasePath = '/codex-remote'
$NoStart = $true
$dataDir = Join-Path $SandboxRoot 'Data'
$versionsRoot = Join-Path $dataDir 'RuntimeVersions'
$a = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
$b = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
$c = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
$activeRoot = Join-Path $versionsRoot $a
$selectedRoot = Join-Path $versionsRoot $c
$pointerPath = Join-Path $dataDir 'runtime-current.json'
$expected = [pscustomobject]@{ DataDir = $dataDir }
$null = New-Item -ItemType Directory -Path $activeRoot -Force
$null = New-Item -ItemType Directory -Path $selectedRoot -Force

function Get-StringSha256 {
    param([Parameter(Mandatory)][string]$Value)

    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    try {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        return [Convert]::ToHexString(
            $sha256.ComputeHash($bytes)
        ).ToLowerInvariant()
    } finally {
        if ($null -ne $sha256) {
            $sha256.Dispose()
        }
    }
}

$selectedXml = "<Task><Root>$selectedRoot</Root><Kind>selected</Kind></Task>"
$activeXml = "<Task><Root>$activeRoot</Root><Kind>active</Kind></Task>"
$unboundActiveXml =
    "<Task><Root>$activeRoot</Root><Kind>unbound-active</Kind></Task>"
$selectedHash = Get-StringSha256 -Value $selectedXml
$activeHash = Get-StringSha256 -Value $activeXml

function New-Pointer {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('selected', 'active')]
        [string]$Kind
    )

    $isSelected = $Kind -ceq 'selected'
    $previousId = if ($isSelected) { $b } else { $c }
    return [pscustomobject]@{
        Signature = 'codex-local-remote/runtime-current/v1'
        Version = 1
        CurrentVersionId = if ($isSelected) { $c } else { $a }
        CurrentRoot = if ($isSelected) { $selectedRoot } else { $activeRoot }
        CurrentManifestSha256 = if ($isSelected) { $c } else { $a }
        PreviousVersionId = $previousId
        PreviousRoot = Join-Path $versionsRoot $previousId
        PreviousManifestSha256 = $previousId
        HasPreviousTaskPreImage = -not $isSelected
        PreviousTaskPreImageSha256 =
            if ($isSelected) { $null } else { $selectedHash }
        PreviousTaskPreImageTaskName =
            if ($isSelected) { $null } else { $TaskName }
        PreviousTaskPreImageRuntimeVersionId =
            if ($isSelected) { $null } else { $c }
        PreviousTaskPreImageRuntimeRoot =
            if ($isSelected) { $null } else { $selectedRoot }
        HasCurrentTaskDefinition = $true
        CurrentTaskDefinitionSha256 =
            if ($isSelected) { $selectedHash } else { $activeHash }
        CurrentTaskDefinitionTaskName = $TaskName
        CurrentTaskDefinitionRuntimeVersionId =
            if ($isSelected) { $c } else { $a }
        CurrentTaskDefinitionRuntimeRoot =
            if ($isSelected) { $selectedRoot } else { $activeRoot }
        PointerPath = $pointerPath
    }
}

$script:pointer = New-Pointer -Kind selected
$script:taskKind = 'selected'
$script:taskState = if ($Mode -clike '*-running') {
    'Running'
} else {
    'Ready'
}
$script:operations = [System.Collections.Generic.List[string]]::new()
$script:activeEvidenceReads = 0
$script:pointerWritesWithoutBinding = 0
$pointerPreImage = [ordered]@{
    Signature = 'codex-local-remote/runtime-current/v1'
    Version = 1
    CurrentVersionId = $c
    CurrentRoot = $selectedRoot
    CurrentManifestSha256 = $c
    PreviousVersionId = $b
    PreviousRoot = (Join-Path $versionsRoot $b)
    PreviousManifestSha256 = $b
    PreviousTaskPreImage = $null
    CurrentTaskDefinition = [ordered]@{
        Signature = 'codex-local-remote/runtime-task-binding/v1'
        Version = 1
        TaskName = $TaskName
        RuntimeVersionId = $c
        RuntimeRoot = $selectedRoot
        XmlSha256 = $selectedHash
        BoundAtUtc = '2026-07-29T00:00:00.0000000Z'
    }
    UpdatedAtUtc = '2026-07-29T00:00:00.0000000Z'
}
$null = New-Item -ItemType Directory -Path $dataDir -Force
$pointerPreImage | ConvertTo-Json -Depth 20 |
    Set-Content -LiteralPath $pointerPath -Encoding utf8NoBOM

function Get-ScheduledTask {
    [pscustomobject]@{
        TaskName = $TaskName
        TaskPath = '\'
        State = $script:taskState
        Kind = $script:taskKind
    }
}

function Export-ScheduledTask {
    if ($script:taskKind -ceq 'selected') {
        return $selectedXml
    }
    if ($script:taskKind -ceq 'active') {
        return $activeXml
    }
    if ($script:taskKind -ceq 'unbound-active') {
        return $unboundActiveXml
    }
    return '<Task><Kind>foreign</Kind></Task>'
}

function Get-StartupTaskDefinition {
    param([string]$InstallRoot)

    [pscustomobject]@{
        RuntimeRoot = [System.IO.Path]::GetFullPath($InstallRoot)
        TaskExecute = 'conhost.exe'
        TaskArguments = '--headless pwsh.exe'
        WorkingDirectory = [System.IO.Path]::GetFullPath($InstallRoot)
        TriggerUserSid = 'S-1-5-21-fixture'
        PrincipalUserSid = 'S-1-5-21-fixture'
        Description = 'managed fixture'
    }
}

function Test-ManagedStartupTask {
    param([object]$Task, [object]$Expected)

    $kind = if ([string]::Equals(
        [string]$Expected.RuntimeRoot,
        $activeRoot,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        'active'
    } else {
        'selected'
    }
    [pscustomobject]@{
        IsManaged = [string]$Task.Kind -ceq $kind
        Mismatches = @()
    }
}

function Test-RegistrationTaskXmlRuntimeRoot {
    param([string]$Xml, [string]$ExpectedRoot, [string]$ForbiddenRoot)

    return (
        $Xml.Contains($ExpectedRoot) -and
        ([string]::IsNullOrWhiteSpace($ForbiddenRoot) -or
            -not $Xml.Contains($ForbiddenRoot))
    )
}

function Test-RegistrationOptionalPathEqual {
    param([string]$Left, [string]$Right)

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

function Get-RegistrationActiveRuntimeEvidence {
    $script:activeEvidenceReads += 1
    if ($Mode -ceq 'invalid-active') {
        throw 'fixture active receipt is invalid'
    }
    $exactDriftRead = switch ($Mode) {
        'active-drift-before-pointer-running' { 3 }
        'active-drift-after-pointer-running' { 4 }
        default { 0 }
    }
    [pscustomobject]@{
        VersionId = $a
        RuntimeRoot = $activeRoot
        ManifestSha256 = $a
        RuntimeInvocationId = if (
            ($Mode -ceq 'active-drift-after-running' -and
                $script:activeEvidenceReads -ge 3) -or
            ($exactDriftRead -gt 0 -and
                $script:activeEvidenceReads -eq $exactDriftRead)
        ) {
            '2' * 32
        } else {
            '1' * 32
        }
        BrokerProcessId = 42
        BrokerCreationDateUtcTicks = 638000000000000000
    }
}

function Get-CodexLocalRemoteCurrentRuntime {
    return $script:pointer
}

function New-ScheduledTaskAction { [pscustomobject]@{ Kind = 'active' } }
function New-ScheduledTaskTrigger { [pscustomobject]@{} }
function New-ScheduledTaskPrincipal { [pscustomobject]@{} }
function New-ScheduledTaskSettingsSet { [pscustomobject]@{} }

function Register-ScheduledTask {
    param([string]$Xml, [object]$Action)

    if (-not [string]::IsNullOrWhiteSpace($Xml)) {
        if ($Mode -ceq 'rollback-task-before-effect-running' -or
            $Mode -cin @(
                'register-active-after-effect-restore-before-running',
                'register-unbound-after-effect-restore-before-running'
            )) {
            $script:operations.Add('restore-task-before-effect')
            throw 'fixture task rollback failed before effect'
        }
        $script:taskKind = 'selected'
        if ($Mode -ceq 'rollback-task-after-effect-running') {
            $script:operations.Add('restore-task-after-effect')
            throw 'fixture task rollback failed after effect'
        }
        $script:operations.Add('restore-task')
    } elseif ($null -ne $Action) {
        $script:taskKind = 'active'
        if ($Mode -ceq 'task-state-drop-after-running') {
            $script:taskState = 'Ready'
        }
        if ($Mode -ceq
            'register-active-after-effect-restore-before-running') {
            $script:operations.Add('register-active-task-after-effect')
            throw 'fixture active task registration failed after effect'
        }
        if ($Mode -ceq
            'register-unbound-after-effect-restore-before-running') {
            $script:taskKind = 'unbound-active'
            $script:operations.Add('register-unbound-task-after-effect')
            throw 'fixture unbound task registration failed after effect'
        }
        $script:operations.Add('register-active-task')
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
    $null = $Runtime
    $null = $PreviousTaskPreImage
    if ($null -eq $CurrentTaskDefinition -or
        [string]$CurrentTaskDefinition.RuntimeVersionId -cne $a -or
        [string]$CurrentTaskDefinition.XmlSha256 -cne $activeHash) {
        $script:pointerWritesWithoutBinding += 1
        $script:operations.Add('write-active-pointer-without-binding')
        throw 'fixture refuses an active pointer without its exact task binding'
    }
    $script:pointer = New-Pointer -Kind active
    $script:operations.Add('write-active-pointer')
    if ($Mode -clike 'pointer-after-effect*' -or
        $Mode -clike 'rollback-*-running') {
        throw 'fixture pointer write failed after effect'
    }
    return $script:pointer
}

function Write-AtomicJsonFile {
    if ($Mode -ceq 'rollback-pointer-before-effect-running') {
        $script:operations.Add('restore-pointer-before-effect')
        throw 'fixture pointer rollback failed before effect'
    }
    $script:pointer = New-Pointer -Kind selected
    if ($Mode -ceq 'rollback-pointer-after-effect-running') {
        $script:operations.Add('restore-pointer-after-effect')
        throw 'fixture pointer rollback failed after effect'
    }
    $script:operations.Add('restore-pointer')
    $pointerPreImage | ConvertTo-Json -Depth 20 |
        Set-Content -LiteralPath $pointerPath -Encoding utf8NoBOM
}

$tokens = $null
$parseErrors = $null
$registrationAst = [Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $RegistrationPath),
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) {
    throw 'fixture could not parse registration script'
}
foreach ($functionName in @(
    'Test-RegistrationRuntimePointerSnapshot',
    'Test-RegistrationActiveRuntimeSnapshot',
    'New-RegistrationRepairActivePointerSnapshot',
    'Get-RegistrationRepairTaskSnapshot',
    'Get-RegistrationRepairTaskEvidence',
    'Repair-RegistrationPendingRuntimeFromActive'
)) {
    $functionAst = @(
        $registrationAst.FindAll({
            param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            [string]$node.Name -ceq $functionName
        }, $true)
    )
    if ($functionAst.Count -ne 1) {
        throw "fixture expected exactly one '$functionName' function"
    }
    Invoke-Expression ([string]$functionAst[0].Extent.Text)
}

$succeeded = $false
$failure = $null
try {
    $null = Repair-RegistrationPendingRuntimeFromActive `
        -ActiveRuntime (
            Get-RegistrationActiveRuntimeEvidence
        ) `
        -SelectedPointer $script:pointer
    $succeeded = $true
} catch {
    $failure = $_.Exception.Message
}

[pscustomobject]@{
    Mode = $Mode
    Succeeded = $succeeded
    Failure = $failure
    FinalTask = $script:taskKind
    FinalTaskState = $script:taskState
    FinalCurrent = [string]$script:pointer.CurrentVersionId
    FinalPrevious = [string]$script:pointer.PreviousVersionId
    FinalPair = if (
        $script:taskKind -ceq 'selected' -and
        [string]$script:pointer.CurrentVersionId -ceq $c
    ) {
        'selected'
    } elseif (
        $script:taskKind -ceq 'active' -and
        [string]$script:pointer.CurrentVersionId -ceq $a
    ) {
        'active'
    } else {
        'mixed'
    }
    ActiveEvidenceReads = $script:activeEvidenceReads
    PointerWritesWithoutBinding = $script:pointerWritesWithoutBinding
    FinalPointerHasExactActiveBinding = (
        [string]$script:pointer.CurrentVersionId -ceq $a -and
        [bool]$script:pointer.HasCurrentTaskDefinition -and
        [string]$script:pointer.CurrentTaskDefinitionRuntimeVersionId -ceq
            $a -and
        [string]$script:pointer.CurrentTaskDefinitionSha256 -ceq
            $activeHash
    )
    Operations = [object[]]$script:operations
} | ConvertTo-Json -Depth 20 -Compress
