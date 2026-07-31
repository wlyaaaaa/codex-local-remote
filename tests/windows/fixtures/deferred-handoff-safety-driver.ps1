[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptPath,

    [Parameter(Mandatory)]
    [ValidateSet('cim-error', 'desktop-remains')]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
. $ScriptPath -DefinitionOnly

$result = if ($Mode -ceq 'cim-error') {
    function Get-CimInstance {
        [CmdletBinding()]
        param(
            [Parameter(Position = 0)]
            [string]$ClassName,

            [string]$Filter
        )

        Write-Error 'simulated CIM enumeration failure'
    }

    try {
        $count = @(Get-DeferredHandoffDesktopProcesses).Count
        [pscustomobject]@{
            threw = $false
            count = $count
            error = ''
            launchCalls = 0
        }
    } catch {
        [pscustomobject]@{
            threw = $true
            count = -1
            error = $_.Exception.Message
            launchCalls = 0
        }
    }
} else {
    $launchCalls = 0

    function Get-DeferredHandoffDesktopProcesses {
        return @(
            [pscustomobject]@{
                ProcessId = 4242
                ExecutablePath = 'C:\Program Files\WindowsApps\OpenAI.Codex_test\app\ChatGPT.exe'
            }
        )
    }

    function Start-Process {
        [CmdletBinding()]
        param(
            [Parameter(Mandatory)]
            [string]$FilePath
        )

        $script:launchCalls++
    }

    try {
        Assert-DeferredHandoffDesktopStopped
        Start-Process -FilePath 'C:\unused\Codex Remote.lnk'
        [pscustomobject]@{
            threw = $false
            count = 1
            error = ''
            launchCalls = $launchCalls
        }
    } catch {
        [pscustomobject]@{
            threw = $true
            count = 1
            error = $_.Exception.Message
            launchCalls = $launchCalls
        }
    }
}

$result | ConvertTo-Json -Compress
