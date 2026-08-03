[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptPath
)

$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $ScriptPath,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    throw 'The deferred handoff worker did not parse.'
}
foreach ($functionName in @(
    'Test-DeferredHandoffPathEqual',
    'Test-DeferredHandoffDetachedWorkerTaskIdentity',
    'Remove-DeferredHandoffDetachedWorkerTask'
)) {
    $functionAst = $ast.FindAll(
        {
            param($node)
            $node -is
                [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -ceq $functionName
        },
        $true
    ) | Select-Object -First 1
    if ($null -eq $functionAst) {
        throw "The detached task helper '$functionName' was not found."
    }
    Invoke-Expression ([string]$functionAst.Extent.Text)
}

$runtimeVersionId = 'a' * 64
$runtimeRoot = 'C:\fixture\runtime'
$taskName = 'Codex Local Remote Handoff ' +
    $runtimeVersionId.Substring(0, 12) + ' 1234abcd'
$expectedArguments = 'fixture exact arguments'
$script:Task = $null
$script:UnregisterFailures = 0
$script:UnregisterCalls = 0

function New-FixtureTask {
    param([switch]$Foreign)
    return [pscustomobject]@{
        TaskName = $taskName
        TaskPath = '\'
        Description = if ($Foreign) {
            'foreign task'
        } else {
            'codex-local-remote/deferred-handoff-task/v1 - one ' +
                'explicitly authorized, runtime-bound Desktop handoff'
        }
        Triggers = @()
        Actions = @([pscustomobject]@{
            Execute = Join-Path $PSHOME 'pwsh.exe'
            Arguments = $expectedArguments
            WorkingDirectory = $runtimeRoot
        })
        Principal = [pscustomobject]@{
            UserId = (
                [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
            )
            LogonType = 'Interactive'
            RunLevel = 'Highest'
        }
    }
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
    return $script:Task
}

function Unregister-ScheduledTask {
    param(
        [string]$TaskName,
        [string]$TaskPath,
        [switch]$Confirm,
        [object]$ErrorAction
    )
    $null = $TaskName
    $null = $TaskPath
    $null = $Confirm
    $null = $ErrorAction
    $script:UnregisterCalls++
    if ($script:UnregisterFailures -gt 0) {
        $script:UnregisterFailures--
        throw 'fixture transient unregister failure'
    }
    $script:Task = $null
}

function Invoke-FixtureCleanup {
    $result = Remove-DeferredHandoffDetachedWorkerTask `
        -TaskName $taskName `
        -RuntimeVersionId $runtimeVersionId `
        -RuntimeRoot $runtimeRoot `
        -ExpectedArguments $expectedArguments `
        -MaximumAttempts 3
    return [ordered]@{
        Status = [string]$result.Status
        Attempts = [int]$result.Attempts
        UnregisterCalls = $script:UnregisterCalls
        TaskPreserved = $null -ne $script:Task
    }
}

$script:Task = $null
$script:UnregisterFailures = 0
$script:UnregisterCalls = 0
$absent = Invoke-FixtureCleanup

$script:Task = New-FixtureTask
$script:UnregisterFailures = 0
$script:UnregisterCalls = 0
$exact = Invoke-FixtureCleanup

$script:Task = New-FixtureTask
$script:UnregisterFailures = 1
$script:UnregisterCalls = 0
$retry = Invoke-FixtureCleanup

$script:Task = New-FixtureTask -Foreign
$script:UnregisterFailures = 0
$script:UnregisterCalls = 0
$foreign = Invoke-FixtureCleanup

[pscustomobject]@{
    Absent = $absent
    Exact = $exact
    Retry = $retry
    Foreign = $foreign
} | ConvertTo-Json -Compress -Depth 5
