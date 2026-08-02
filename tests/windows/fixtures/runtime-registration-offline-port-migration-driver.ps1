[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$RegistrationPath,

    [Parameter(Mandatory)]
    [ValidateSet(
        'success',
        'config-sidecar-drift',
        'config-broker-drift',
        'config-base-path-drift',
        'config-task-name-drift',
        'task-port-drift',
        'task-version-drift',
        'task-root-drift',
        'task-hash-drift',
        'occupied-sidecar',
        'occupied-broker',
        'occupied-upstream',
        'pointer-drift-after-read',
        'config-drift-after-read',
        'task-drift-after-read',
        'listener-drift-after-read'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
$Port = 18789
$BrokerPort = 18790
$BrokerUpstreamPort = 18792
$MigrateOfflineBrokerUpstreamPortFrom = 18795
$BasePath = '/codex'
$TaskName = 'Codex Local Remote'
$NodePath = 'C:\Program Files\nodejs\node.exe'
$PwshPath = 'C:\Program Files\PowerShell\7\pwsh.exe'
$offlineBrokerUpstreamPortMigrationRequested = $true
$runtimeVersionId = 'c' * 64
$previousVersionId = 'b' * 64
$runtimeRoot = 'C:\runtime\selected'
$pointerPath = 'C:\runtime\runtime-current.json'
$expected = [pscustomobject]@{ DataDir = 'C:\runtime' }

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

$taskXml = @"
<Task><Actions><Exec><Arguments>--install-root &quot;$runtimeRoot&quot;</Arguments></Exec></Actions></Task>
"@
$taskXmlSha256 = Get-StringSha256 -Value $taskXml
$script:task = [pscustomobject]@{
    ActualBrokerUpstreamPort = $MigrateOfflineBrokerUpstreamPortFrom
    ActualRuntimeRoot = $runtimeRoot
}
if ($Mode -ceq 'task-port-drift') {
    $script:task.ActualBrokerUpstreamPort = 18794
}
$script:pointer = [pscustomobject]@{
    Signature = 'codex-local-remote/runtime-current/v1'
    Version = 1
    CurrentVersionId = $runtimeVersionId
    CurrentRoot = $runtimeRoot
    CurrentManifestSha256 = $runtimeVersionId
    PreviousVersionId = $previousVersionId
    PreviousRoot = 'C:\runtime\previous'
    PreviousManifestSha256 = $previousVersionId
    HasPreviousTaskPreImage = $false
    PreviousTaskPreImageSha256 = $null
    PreviousTaskPreImageTaskName = $null
    PreviousTaskPreImageRuntimeVersionId = $null
    PreviousTaskPreImageRuntimeRoot = $null
    HasCurrentTaskDefinition = $true
    CurrentTaskDefinitionSha256 = $taskXmlSha256
    CurrentTaskDefinitionTaskName = $TaskName
    CurrentTaskDefinitionRuntimeVersionId = $runtimeVersionId
    CurrentTaskDefinitionRuntimeRoot = $runtimeRoot
    PointerPath = $pointerPath
}
switch ($Mode) {
    'task-version-drift' {
        $script:pointer.CurrentTaskDefinitionRuntimeVersionId = 'd' * 64
    }
    'task-root-drift' {
        $script:pointer.CurrentTaskDefinitionRuntimeRoot = 'C:\runtime\other'
    }
    'task-hash-drift' {
        $script:pointer.CurrentTaskDefinitionSha256 = 'e' * 64
    }
}
$script:configuration = [pscustomobject]@{
    SidecarPort = $Port
    BrokerPort = $BrokerPort
    BrokerUpstreamPort = $MigrateOfflineBrokerUpstreamPortFrom
    BasePath = $BasePath
    TaskName = $TaskName
}
switch ($Mode) {
    'config-sidecar-drift' { $script:configuration.SidecarPort++ }
    'config-broker-drift' { $script:configuration.BrokerPort++ }
    'config-base-path-drift' { $script:configuration.BasePath = '/other' }
    'config-task-name-drift' { $script:configuration.TaskName = 'Other Task' }
}

$script:configurationReads = 0
$script:pointerReads = 0
$script:taskReads = 0
$script:listenerReads = 0
$script:expectedBrokerUpstreamPorts =
    [System.Collections.Generic.List[int]]::new()
$script:requestedPortSets =
    [System.Collections.Generic.List[object]]::new()

function Copy-FixtureObject {
    param([Parameter(Mandatory)][object]$InputObject)

    return $InputObject | ConvertTo-Json -Depth 20 | ConvertFrom-Json
}

function Get-CodexLocalRemoteManagedConfiguration {
    param([string]$DataDir)

    $null = $DataDir
    $script:configurationReads++
    $result = Copy-FixtureObject -InputObject $script:configuration
    if ($Mode -ceq 'config-drift-after-read' -and
        $script:configurationReads -ge 2) {
        $result.TaskName = 'Drifted Task'
    }
    return $result
}

function Get-RegistrationRepairTaskSnapshot {
    $script:taskReads++
    $xml = $taskXml
    if ($Mode -ceq 'task-drift-after-read' -and $script:taskReads -ge 2) {
        $xml = $taskXml.Replace('</Task>', '<Drift /></Task>')
    }
    return [pscustomobject]@{
        Task = $script:task
        State = 'Ready'
        Xml = $xml
        XmlSha256 = Get-StringSha256 -Value $xml
    }
}

function Get-StartupTaskDefinition {
    param(
        [string]$TaskName,
        [string]$NodePath,
        [string]$PwshPath,
        [string]$InstallRoot,
        [string]$DataDir,
        [int]$Port,
        [int]$BrokerPort,
        [int]$BrokerUpstreamPort,
        [string]$BasePath
    )

    $null = $TaskName
    $null = $NodePath
    $null = $PwshPath
    $null = $DataDir
    $null = $Port
    $null = $BrokerPort
    $null = $BasePath
    $script:expectedBrokerUpstreamPorts.Add($BrokerUpstreamPort)
    return [pscustomobject]@{
        InstallRoot = $InstallRoot
        BrokerUpstreamPort = $BrokerUpstreamPort
    }
}

function Test-ManagedStartupTask {
    param(
        [object]$Task,
        [object]$Expected
    )

    return [pscustomobject]@{
        IsManaged = (
            [int]$Task.ActualBrokerUpstreamPort -eq
                [int]$Expected.BrokerUpstreamPort -and
            [string]$Task.ActualRuntimeRoot -ceq
                [string]$Expected.InstallRoot
        )
    }
}

function Get-CodexLocalRemoteCurrentRuntime {
    param([string]$DataDir)

    $null = $DataDir
    $script:pointerReads++
    $result = Copy-FixtureObject -InputObject $script:pointer
    if ($Mode -ceq 'pointer-drift-after-read' -and
        $script:pointerReads -ge 1) {
        $result.CurrentManifestSha256 = 'f' * 64
    }
    return $result
}

function Get-CodexLocalRemoteTcpListenerSnapshot {
    param([int[]]$LocalPorts)

    $script:listenerReads++
    $script:requestedPortSets.Add([int[]]$LocalPorts)
    $occupiedPort = switch ($Mode) {
        'occupied-sidecar' { $Port }
        'occupied-broker' { $BrokerPort }
        'occupied-upstream' { $BrokerUpstreamPort }
        'listener-drift-after-read' {
            if ($script:listenerReads -ge 2) { $BrokerUpstreamPort }
        }
    }
    if ($null -ne $occupiedPort) {
        return [pscustomobject]@{ LocalPort = [int]$occupiedPort }
    }
}

function Start-Sleep {
    param([int]$Milliseconds)

    $null = $Milliseconds
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
    'Test-RegistrationTaskXmlRuntimeRoot',
    'Test-RegistrationOptionalPathEqual',
    'Test-RegistrationRuntimePointerSnapshot',
    'Get-RegistrationRepairTaskEvidence',
    'Assert-RegistrationOfflineBrokerUpstreamPortMigration'
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
$definition = $null
try {
    $definition = Assert-RegistrationOfflineBrokerUpstreamPortMigration `
        -SelectedPointer (Copy-FixtureObject -InputObject $script:pointer)
    $succeeded = $true
} catch {
    $failure = $_.Exception.Message
}

[pscustomobject]@{
    Mode = $Mode
    Succeeded = $succeeded
    Failure = $failure
    ReturnedBrokerUpstreamPort = if ($null -eq $definition) {
        $null
    } else {
        [int]$definition.BrokerUpstreamPort
    }
    ExpectedBrokerUpstreamPorts = [int[]]$script:expectedBrokerUpstreamPorts
    RequestedPortSets = [object[]]$script:requestedPortSets
    ConfigurationReads = $script:configurationReads
    PointerReads = $script:pointerReads
    TaskReads = $script:taskReads
    ListenerReads = $script:listenerReads
} | ConvertTo-Json -Depth 20 -Compress
