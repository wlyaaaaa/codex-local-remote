[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptPath,

    [Parameter(Mandatory)]
    [ValidateSet(
        'success',
        'cim-error',
        'process-reappears',
        'broker-busy',
        'broker-rebusy'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
. $ScriptPath -DefinitionOnly

$script:observationCount = 0
$script:brokerObservationCount = 0
$script:launchCalls = 0

if ($Mode -ceq 'cim-error') {
    function Get-CimInstance {
        [CmdletBinding()]
        param(
            [Parameter(Position = 0)]
            [string]$ClassName,

            [string]$Filter
        )

        Write-Error 'simulated CIM enumeration failure'
    }
} else {
    function Get-DeferredHandoffDesktopProcesses {
        $script:observationCount++
        $count = switch ($Mode) {
            'success' {
                if ($script:observationCount -eq 1) {
                    1
                } else {
                    0
                }
            }
            'process-reappears' {
                if ($script:observationCount -eq 1) {
                    0
                } else {
                    1
                }
            }
            default {
                0
            }
        }
        if ($count -eq 0) {
            return @()
        }
        return @(
            [pscustomobject]@{
                ProcessId = 4242
                ExecutablePath = (
                    'C:\Program Files\WindowsApps\' +
                    'OpenAI.Codex_test\app\ChatGPT.exe'
                )
            }
        )
    }
}

function Get-DeferredHandoffBrokerSnapshot {
    param(
        [int]$Port
    )

    $script:brokerObservationCount++
    $unsafeThreadCount = if ($Mode -ceq 'broker-busy' -or
        ($Mode -ceq 'broker-rebusy' -and
        $script:brokerObservationCount -ge 3)) {
        1
    } else {
        0
    }
    return [pscustomobject]@{
        BrokerReachable = $true
        DesktopConnected = $Mode -ceq 'process-reappears'
        SidecarConnected = $true
        UnsafeThreadCount = $unsafeThreadCount
    }
}

function Start-Process {
    param(
        [string]$FilePath
    )

    $script:launchCalls++
}

try {
    $null = Wait-DeferredHandoffNaturalDesktopExit `
        -Port 18791 `
        -Deadline ([DateTime]::UtcNow.AddMilliseconds(500)) `
        -PollIntervalMilliseconds 1
    Assert-DeferredHandoffNaturalLaunchBarrier -Port 18791
    Start-Process -FilePath 'C:\unused\Codex Remote.lnk'
    $result = [pscustomobject]@{
        succeeded = $true
        error = ''
        launchCalls = $script:launchCalls
        observationCount = $script:observationCount
    }
} catch {
    $result = [pscustomobject]@{
        succeeded = $false
        error = $_.Exception.Message
        launchCalls = $script:launchCalls
        observationCount = $script:observationCount
    }
}

$result | ConvertTo-Json -Compress
