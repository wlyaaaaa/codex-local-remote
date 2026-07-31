[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$StartPath,

    [Parameter(Mandatory)]
    [ValidateSet(
        'safe',
        'active-managed-turns',
        'cim-unknown',
        'unsafe-final',
        'reconnect-final',
        'runtime-drift-final',
        'unsafe-late',
        'reconnect-late'
    )]
    [string]$Mode,

    [ValidateRange(2, 5)]
    [int]$RequiredObservations = 2,

    [ValidateRange(1, 1000)]
    [int]$GraceMilliseconds = 150
)

$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $StartPath,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    throw 'The startup script did not parse.'
}
foreach ($name in @(
    'Test-CodexDesktopOwnerRuntimePathEqual',
    'Assert-CodexDesktopOwnerTakeoverSafetyWindow'
)) {
    $functionAst = $ast.FindAll(
        {
            param($node)
            $node -is
                [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -ceq $name
        },
        $true
    ) | Select-Object -First 1
    if ($null -eq $functionAst) {
        throw "The startup safety helper '$name' was not found."
    }
    Invoke-Expression ([string]$functionAst.Extent.Text)
}

$script:observations = 0
$script:launchCalls = 0
$script:stopCalls = 0
$script:sleepCalls = 0
$script:sleepMilliseconds = 0
$resolvedDataDir = 'C:\Data'
$expectedRootIdentityKey = '42001|638899999999999999|' + ('a' * 64)
$expectedVersionId = 'b' * 64
$expectedRuntimeRoot = 'C:\Runtime\expected'
$expectedRuntimeInvocationId = 'c' * 32

function Get-CodexDesktopOwnerHandoffRootProcesses {
    $script:observations += 1
    if ($Mode -ceq 'cim-unknown') {
        throw 'fixture strict CIM enumeration failed'
    }
    return [pscustomobject]@{
        ProcessId = 42001
    }
}

function Get-UniqueCodexDesktopRootIdentityKey {
    param([object[]]$Processes)
    if (@($Processes).Count -ne 1) {
        return $null
    }
    return $expectedRootIdentityKey
}

function Get-CodexLocalRemoteCurrentRuntime {
    param([string]$DataDir)
    $null = $DataDir
    return [pscustomobject]@{
        CurrentVersionId = if (
            $Mode -ceq 'runtime-drift-final' -and
            $script:observations -ge 2
        ) {
            'd' * 64
        } else {
            $expectedVersionId
        }
        CurrentRoot = $expectedRuntimeRoot
    }
}

function Get-VerifiedBrokerRuntimeSnapshot {
    param([int]$ExpectedBrokerProcessId)
    $null = $ExpectedBrokerProcessId
    return [pscustomobject]@{
        RuntimeInvocationId = $expectedRuntimeInvocationId
        Readiness = [pscustomobject]@{
            desktopConnected = (
                ($Mode -ceq 'reconnect-final' -and
                    $script:observations -ge 2) -or
                ($Mode -ceq 'reconnect-late' -and
                    $script:observations -ge 4)
            )
            unsafeThreadCount = if (
                $Mode -ceq 'active-managed-turns'
            ) {
                10
            } elseif (
                ($Mode -ceq 'unsafe-final' -and
                    $script:observations -ge 2) -or
                ($Mode -ceq 'unsafe-late' -and
                    $script:observations -ge 4)
            ) {
                1
            } else {
                0
            }
        }
    }
}

function Test-NonNegativeInteger {
    param([object]$Value)
    return $Value -is [int] -and [int]$Value -ge 0
}

function Start-Sleep {
    param([int]$Milliseconds)
    $script:sleepCalls += 1
    $script:sleepMilliseconds += $Milliseconds
}

$errorMessage = ''
try {
    Assert-CodexDesktopOwnerTakeoverSafetyWindow `
        -ExpectedRootIdentityKey $expectedRootIdentityKey `
        -ExpectedRuntimeVersionId $expectedVersionId `
        -ExpectedRuntimeRoot $expectedRuntimeRoot `
        -ExpectedRuntimeInvocationId $expectedRuntimeInvocationId `
        -ExpectedBrokerProcessId 41001 `
        -RequiredObservations $RequiredObservations `
        -GraceMilliseconds $GraceMilliseconds
    $script:stopCalls += 1
    $script:launchCalls += 1
} catch {
    $errorMessage = $_.Exception.Message
}

[pscustomobject][ordered]@{
    Succeeded = [string]::IsNullOrWhiteSpace($errorMessage)
    Error = $errorMessage
    Observations = $script:observations
    StopCalls = $script:stopCalls
    LaunchCalls = $script:launchCalls
    SleepCalls = $script:sleepCalls
    SleepMilliseconds = $script:sleepMilliseconds
} | ConvertTo-Json -Compress
