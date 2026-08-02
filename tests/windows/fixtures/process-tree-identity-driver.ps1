[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ModulePath,

    [Parameter(Mandatory)]
    [string]$ScenarioFile,

    [Parameter(Mandatory)]
    [ValidateSet(
        'exports',
        'native-image-query',
        'root-exits-after-open',
        'root-creation-drift',
        'child-predates-parent'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
$global:CodexRemoteProcessTreeScenario =
    Get-Content -LiteralPath $ScenarioFile -Raw |
        ConvertFrom-Json -Depth 20
$global:CodexRemoteProcessTreeHandles = @{}
$global:CodexRemoteProcessTreeOpenIds =
    [System.Collections.Generic.List[int]]::new()
$global:CodexRemoteProcessTreeStopIds =
    [System.Collections.Generic.List[int]]::new()
$global:CodexRemoteProcessTreeStopTreeFlags =
    [System.Collections.Generic.List[bool]]::new()
$global:CodexRemoteProcessTreeDisposeIds =
    [System.Collections.Generic.List[int]]::new()

function Get-CimInstance {
    param(
        [string]$ClassName,
        [string]$Filter,
        [object]$ErrorAction
    )

    if ($ClassName -cne 'Win32_Process' -or
        -not [string]::IsNullOrWhiteSpace($Filter)) {
        throw "Unexpected process-tree query '$ClassName' / '$Filter'."
    }
    return @($global:CodexRemoteProcessTreeScenario.Processes)
}

function Get-Process {
    param(
        [int]$Id,
        [object]$ErrorAction
    )

    $key = [string]$Id
    if ($global:CodexRemoteProcessTreeHandles.ContainsKey($key)) {
        return $global:CodexRemoteProcessTreeHandles[$key]
    }
    $snapshot = @(
        @($global:CodexRemoteProcessTreeScenario.Processes) |
            Where-Object { [int]$_.ProcessId -eq $Id }
    )
    if ($snapshot.Count -ne 1) {
        throw "Mock process identity PID $Id is unavailable or ambiguous."
    }
    $startTime =
        [System.Management.ManagementDateTimeConverter]::ToDateTime(
            [string]$snapshot[0].CreationDate
        ).ToUniversalTime()
    $handle = [pscustomobject]@{
        Id = $Id
        StartTime = $startTime.ToLocalTime()
        HasExited = $false
    }
    $handle | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
    $handle | Add-Member -MemberType ScriptMethod -Name Kill -Value {
        param([bool]$EntireProcessTree = $false)
        $global:CodexRemoteProcessTreeStopIds.Add([int]$this.Id)
        $global:CodexRemoteProcessTreeStopTreeFlags.Add(
            [bool]$EntireProcessTree
        )
        $this.HasExited = $true
    }
    $handle | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
        param([int]$TimeoutMilliseconds)
        return $true
    }
    $handle | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
        $global:CodexRemoteProcessTreeDisposeIds.Add([int]$this.Id)
    }
    $global:CodexRemoteProcessTreeHandles[$key] = $handle
    $global:CodexRemoteProcessTreeOpenIds.Add($Id)
    return $handle
}

$module = Import-Module $ModulePath -Force -PassThru
if ($Mode -ceq 'native-image-query') {
    $imagePath = Get-CodexLocalRemoteProcessImagePath -ProcessId $PID
    [pscustomobject]@{
        Succeeded = -not [string]::IsNullOrWhiteSpace($imagePath)
        Error = $null
        Members = @()
        OpenIds = @()
        StopIds = @()
        StopTreeFlags = @()
        DisposeIds = @()
        ImagePath = $imagePath
    } | ConvertTo-Json -Compress -Depth 20
    Remove-Module $module -Force -ErrorAction SilentlyContinue
    exit 0
}
if ($Mode -ceq 'exports') {
    $requiredCommands = @(
        'Close-ProcessTreeIdentitySnapshot',
        'Get-CodexLocalRemoteProcessImagePath',
        'Open-ProcessTreeIdentitySnapshot',
        'Stop-ProcessTreeIdentitySnapshot'
    )
    $exportedCommands = @(
        @($module.ExportedCommands.Keys) |
            Where-Object { $requiredCommands -contains $_ } |
            Sort-Object
    )
    $missingCommands = @(
        $requiredCommands |
            Where-Object { $exportedCommands -notcontains $_ }
    )
    [pscustomobject]@{
        Succeeded = $missingCommands.Count -eq 0
        Error = if ($missingCommands.Count -eq 0) {
            $null
        } else {
            "Missing exported commands: $($missingCommands -join ', ')."
        }
        Members = @()
        OpenIds = @()
        StopIds = @()
        StopTreeFlags = @()
        DisposeIds = @()
        ExportedCommands = @($exportedCommands)
    } | ConvertTo-Json -Compress -Depth 20
    Remove-Module $module -Force -ErrorAction SilentlyContinue
    if ($missingCommands.Count -ne 0) {
        exit 1
    }
    exit 0
}
$snapshot = $null
$resultMembers = @()
$succeeded = $true
$errorMessage = $null
try {
    $root = @(
        @($global:CodexRemoteProcessTreeScenario.Processes) |
            Where-Object {
                [int]$_.ProcessId -eq
                    [int]$global:CodexRemoteProcessTreeScenario.RootProcessId
            }
    )[0]
    $rootCreation =
        [System.Management.ManagementDateTimeConverter]::ToDateTime(
            [string]$root.CreationDate
        ).ToUniversalTime()
    $expectedCreationTicks = $rootCreation.Ticks
    if ($Mode -ceq 'root-creation-drift') {
        $expectedCreationTicks += [TimeSpan]::FromSeconds(1).Ticks
    }

    $snapshot = & $module {
        param(
            [int]$RootProcessId,
            [long]$ExpectedCreationTicks,
            [long]$ExpectedStartTicks
        )
        Open-ProcessTreeIdentitySnapshot `
            -RootProcessId $RootProcessId `
            -ExpectedRootCreationDateUtcTicks $ExpectedCreationTicks `
            -ExpectedRootStartTimeUtcTicks $ExpectedStartTicks
    } `
        ([int]$global:CodexRemoteProcessTreeScenario.RootProcessId) `
        $expectedCreationTicks `
        $rootCreation.Ticks

    $resultMembers = @(
        @($snapshot.Members) |
            ForEach-Object {
                [pscustomobject]@{
                    ProcessId = [int]$_.ProcessId
                    ParentProcessId = [int]$_.ParentProcessId
                    Depth = [int]$_.Depth
                }
            }
    )
    if ($Mode -ceq 'root-exits-after-open') {
        $rootHandle =
            $global:CodexRemoteProcessTreeHandles[
                [string][int]$snapshot.RootProcessId
            ]
        $rootHandle.HasExited = $true
        & $module {
            param([object]$IdentitySnapshot)
            Stop-ProcessTreeIdentitySnapshot -Snapshot $IdentitySnapshot
        } $snapshot
    }
} catch {
    $succeeded = $false
    $errorMessage = $_.Exception.Message
} finally {
    if ($null -ne $snapshot) {
        & $module {
            param([object]$IdentitySnapshot)
            Close-ProcessTreeIdentitySnapshot -Snapshot $IdentitySnapshot
        } $snapshot
    }
    Remove-Module $module -Force -ErrorAction SilentlyContinue
}

[pscustomobject]@{
    Succeeded = $succeeded
    Error = $errorMessage
    Members = @($resultMembers)
    OpenIds = @($global:CodexRemoteProcessTreeOpenIds)
    StopIds = @($global:CodexRemoteProcessTreeStopIds)
    StopTreeFlags = @($global:CodexRemoteProcessTreeStopTreeFlags)
    DisposeIds = @($global:CodexRemoteProcessTreeDisposeIds)
} | ConvertTo-Json -Compress -Depth 20

if (-not $succeeded) {
    exit 1
}
