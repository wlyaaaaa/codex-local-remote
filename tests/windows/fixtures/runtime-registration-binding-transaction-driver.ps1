[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$RegistrationPath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot,

    [Parameter(Mandatory)]
    [ValidateSet('fresh', 'current', 'current-absent-pointer', 'upgrade')]
    [string]$Baseline,

    [Parameter(Mandatory)]
    [ValidateSet(
        'before-once',
        'after-effect',
        'persistent-before',
        'prepare-after-effect'
    )]
    [string]$Fault
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Codex Local Remote'
$dataDir = Join-Path $SandboxRoot 'Data'
$runtimeRoot = Join-Path $dataDir 'RuntimeVersions\selected'
$pointerPath = Join-Path $dataDir 'runtime-current.json'
$versionId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
$expected = [pscustomobject]@{ DataDir = $dataDir }
$null = New-Item -ItemType Directory -Path $runtimeRoot -Force

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

function New-TestTaskXml {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('old', 'selected')]
        [string]$Kind
    )

    $document = [xml]@'
<Task>
  <RegistrationInfo><Description /></RegistrationInfo>
  <Triggers><LogonTrigger><Delay /></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings><Priority /></Settings>
  <Actions Context="Author">
    <Exec>
      <Command>conhost.exe</Command>
      <Arguments />
      <WorkingDirectory />
    </Exec>
  </Actions>
</Task>
'@
    $isOld = $Kind -ceq 'old'
    $document.Task.RegistrationInfo.Description = if ($isOld) {
        'old managed task'
    } else {
        'selected managed task'
    }
    $document.Task.Triggers.LogonTrigger.Delay = if ($isOld) {
        'PT17S'
    } else {
        'PT1S'
    }
    $document.Task.Settings.Priority = if ($isOld) { '6' } else { '4' }
    $document.Task.Actions.Exec.Arguments =
        "--headless pwsh.exe -InstallRoot `"$runtimeRoot`""
    $document.Task.Actions.Exec.WorkingDirectory = $runtimeRoot
    return $document.OuterXml
}

$oldTaskXml = New-TestTaskXml -Kind old
$selectedTaskXml = New-TestTaskXml -Kind selected
$oldTaskHash = Get-StringSha256 -Value $oldTaskXml
$selectedTaskHash = Get-StringSha256 -Value $selectedTaskXml
$script:taskXml = switch ($Baseline) {
    'fresh' { $null }
    'current' { $selectedTaskXml }
    'current-absent-pointer' { $selectedTaskXml }
    'upgrade' { $oldTaskXml }
}
$script:pointer = $null
$script:setAttempts = 0
$script:registerAttempts = 0
$script:syncAttempts = 0
$script:unregisterAttempts = 0
$script:stopAttempts = 0
$script:operations = [System.Collections.Generic.List[string]]::new()

function Set-TestPointer {
    param(
        [AllowNull()]
        [object]$Binding
    )

    $script:pointer = [pscustomobject]@{
        Signature = 'codex-local-remote/runtime-current/v1'
        Version = 1
        CurrentVersionId = $versionId
        CurrentRoot = $runtimeRoot
        CurrentManifestSha256 = $versionId
        PreviousVersionId = $null
        PreviousRoot = $null
        PreviousManifestSha256 = $null
        HasPreviousTaskPreImage = $false
        PreviousTaskPreImageSha256 = $null
        PreviousTaskPreImageTaskName = $null
        PreviousTaskPreImageRuntimeVersionId = $null
        PreviousTaskPreImageRuntimeRoot = $null
        HasCurrentTaskDefinition = $null -ne $Binding
        CurrentTaskDefinitionSha256 = if ($null -eq $Binding) {
            $null
        } else {
            [string]$Binding.XmlSha256
        }
        CurrentTaskDefinitionTaskName = if ($null -eq $Binding) {
            $null
        } else {
            [string]$Binding.TaskName
        }
        CurrentTaskDefinitionRuntimeVersionId = if ($null -eq $Binding) {
            $null
        } else {
            [string]$Binding.RuntimeVersionId
        }
        CurrentTaskDefinitionRuntimeRoot = if ($null -eq $Binding) {
            $null
        } else {
            [string]$Binding.RuntimeRoot
        }
        PointerPath = $pointerPath
    }
    Set-Content -LiteralPath $pointerPath -Value '{}' -Encoding utf8NoBOM
}

if ($Baseline -ceq 'current') {
    Set-TestPointer -Binding $null
} elseif ($Baseline -ceq 'upgrade') {
    Set-TestPointer -Binding ([pscustomobject]@{
        TaskName = $TaskName
        RuntimeVersionId = $versionId
        RuntimeRoot = $runtimeRoot
        XmlSha256 = $oldTaskHash
    })
}

function Get-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath,
        [object]$ErrorAction
    )

    $null = $TaskName
    $null = $TaskPath
    $null = $ErrorAction
    if ($null -eq $script:taskXml) {
        return $null
    }
    return [pscustomobject]@{
        TaskName = $TaskName
        TaskPath = '\'
        State = 'Ready'
    }
}

function Export-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath,
        [object]$ErrorAction
    )

    $null = $TaskName
    $null = $TaskPath
    $null = $ErrorAction
    if ($null -eq $script:taskXml) {
        throw 'fixture task is absent'
    }
    return $script:taskXml
}

function Register-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath,
        [string]$Xml,
        [switch]$Force
    )

    $null = $TaskName
    $null = $TaskPath
    $null = $Force
    $script:registerAttempts++
    $script:operations.Add('register')
    $script:taskXml = $Xml
    if ($Fault -ceq 'prepare-after-effect' -and
        $script:registerAttempts -eq 1 -and
        (Get-StringSha256 -Value $Xml) -ceq $selectedTaskHash) {
        $script:operations.Add('register-after-effect')
        throw 'fixture registration failed after effect'
    }
}

function Unregister-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath,
        [bool]$Confirm
    )

    $null = $TaskName
    $null = $TaskPath
    $null = $Confirm
    $script:unregisterAttempts++
    $script:operations.Add('unregister')
    $script:taskXml = $null
}

function Stop-ScheduledTask {
    $script:stopAttempts++
    $script:operations.Add('stop')
}

function Sync-CodexLocalRemoteCurrentRuntime {
    param(
        [string]$DataDir,
        [string]$InstallRoot
    )

    $null = $DataDir
    $null = $InstallRoot
    $script:syncAttempts++
    Set-TestPointer -Binding $null
    $script:operations.Add('sync-pointer-create')
    if ($Fault -ceq 'prepare-after-effect' -and
        $script:syncAttempts -eq 1) {
        $script:operations.Add('sync-after-effect')
        throw 'fixture current-runtime sync failed after effect'
    }
    return [pscustomobject]@{ Status = 'repaired' }
}

function Test-ExistingTaskOwnership {
    param([AllowNull()][object]$Task)

    if ($null -eq $Task) {
        return [pscustomobject]@{
            IsManaged = $true
            Kind = 'none'
        }
    }
    $hash = Get-StringSha256 -Value $script:taskXml
    return [pscustomobject]@{
        IsManaged = $hash -cin @($oldTaskHash, $selectedTaskHash)
        Kind = if ($hash -ceq $selectedTaskHash) {
            'current'
        } elseif ($hash -ceq $oldTaskHash) {
            'legacy'
        } else {
            'foreign'
        }
    }
}

function Get-CodexLocalRemoteCurrentRuntime {
    param([string]$DataDir)

    $null = $DataDir
    if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) {
        return $null
    }
    return $script:pointer
}

function Set-CodexLocalRemoteCurrentRuntime {
    param(
        [string]$DataDir,
        [object]$Runtime,
        [AllowNull()]
        [object]$CurrentTaskDefinition
    )

    $null = $DataDir
    $null = $Runtime
    $script:setAttempts++
    $isSelectedBinding = (
        $null -ne $CurrentTaskDefinition -and
        [string]$CurrentTaskDefinition.XmlSha256 -ceq $selectedTaskHash
    )
    if ($isSelectedBinding -and
        ($Fault -ceq 'persistent-before' -or
            ($Fault -ceq 'before-once' -and
                $script:setAttempts -eq 1))) {
        $script:operations.Add('pointer-before-failure')
        throw 'fixture pointer write failed before effect'
    }
    Set-TestPointer -Binding $CurrentTaskDefinition
    $script:operations.Add('pointer-write')
    if ($isSelectedBinding -and
        $Fault -ceq 'after-effect' -and
        $script:setAttempts -eq 1) {
        throw 'fixture pointer write failed after effect'
    }
    return $script:pointer
}

$functionNames = @(
    'Test-RegistrationTaskXmlRuntimeRoot',
    'Set-RegistrationSelectedRuntimeTaskBinding',
    'Test-RegistrationOptionalPathEqual',
    'Get-RegistrationRuntimeBindingBaseline',
    'Get-RegistrationSelectedRuntimeBindingState',
    'Test-RegistrationCreatedRuntimePointer',
    'Test-RegistrationRuntimeBindingBaselineState',
    'Restore-RegistrationRuntimeBindingBaseline',
    'Complete-RegistrationRuntimeBindingTransaction'
)
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
foreach ($functionName in $functionNames) {
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

$expectedTaskState = if ($Baseline -ceq 'fresh') {
    'absent'
} else {
    'managed'
}
$capturedBaseline =
    Get-RegistrationRuntimeBindingBaseline `
        -ExpectedTaskState $expectedTaskState
$prepareSelectedState = if ($Baseline -ceq 'current-absent-pointer') {
    {
        Sync-CodexLocalRemoteCurrentRuntime `
            -DataDir $dataDir `
            -InstallRoot $runtimeRoot
    }
} elseif ($Baseline -cin @('fresh', 'upgrade')) {
    {
        Register-ScheduledTask `
            -TaskName $TaskName `
            -TaskPath '\' `
            -Xml $selectedTaskXml `
            -Force
    }
} else {
    $null
}
$transactionSucceeded = $false
$transactionError = $null
$transactionResult = $null
try {
    $transactionResult =
        Complete-RegistrationRuntimeBindingTransaction `
            -SelectedRuntime ([pscustomobject]@{
                VersionId = $versionId
                RuntimeRoot = $runtimeRoot
            }) `
            -Baseline $capturedBaseline `
            -PrepareSelectedState $prepareSelectedState
    $transactionSucceeded = $true
} catch {
    $transactionError = $_.Exception.Message
}

$selectedState =
    Get-RegistrationSelectedRuntimeBindingState `
        -SelectedRuntime ([pscustomobject]@{
            VersionId = $versionId
            RuntimeRoot = $runtimeRoot
        })
$baselineState =
    Test-RegistrationRuntimeBindingBaselineState `
        -Baseline $capturedBaseline
$finalKind = if ([string]$selectedState.Kind -ceq 'selected') {
    'selected'
} elseif ($baselineState.IsExact) {
    if (-not $capturedBaseline.TaskPresent -and
        -not $capturedBaseline.PointerPresent) {
        'absent'
    } else {
        'old'
    }
} else {
    'mixed'
}

[pscustomobject]@{
    Baseline = $Baseline
    Fault = $Fault
    TransactionSucceeded = $transactionSucceeded
    TransactionError = $transactionError
    TransactionFailure = if ($null -eq $transactionResult) {
        $null
    } else {
        [string]$transactionResult.Failure
    }
    FinalKind = $finalKind
    SelectedVerified = [string]$selectedState.Kind -ceq 'selected'
    BaselineVerified = [bool]$baselineState.IsExact
    ExactOldTask = (
        $null -ne $script:taskXml -and
        (Get-StringSha256 -Value $script:taskXml) -ceq $oldTaskHash
    )
    TaskAbsent = $null -eq $script:taskXml
    PointerAbsent =
        -not (Test-Path -LiteralPath $pointerPath -PathType Leaf)
    SetAttempts = $script:setAttempts
    RegisterAttempts = $script:registerAttempts
    SyncAttempts = $script:syncAttempts
    UnregisterAttempts = $script:unregisterAttempts
    StopAttempts = $script:stopAttempts
    Operations = [object[]]$script:operations
} | ConvertTo-Json -Depth 20 -Compress
