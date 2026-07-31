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
    throw 'The on-demand script did not parse.'
}
$functionAst = $ast.FindAll(
    {
        param($node)
        $node -is
            [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -ceq 'Stop-OnDemandDesktopProcessGroup'
    },
    $true
) | Select-Object -First 1
if ($null -eq $functionAst) {
    throw 'Stop-OnDemandDesktopProcessGroup was not found.'
}
Invoke-Expression ([string]$functionAst.Extent.Text)

$DesktopExitTimeoutSeconds = 1
$desktopPath = 'C:\fixture\Codex\app\ChatGPT.exe'
$appServerPath = 'C:\fixture\Codex\app\resources\codex.exe'
$script:stoppedProcessIds = [System.Collections.Generic.List[int]]::new()
$script:disposedProcessIds = [System.Collections.Generic.List[int]]::new()
$script:fixtureProcesses = @(
    [pscustomobject]@{
        ProcessId = 100
        ParentProcessId = 1
        Name = 'ChatGPT.exe'
        ExecutablePath = $desktopPath
        CreationDate = 1000
    },
    [pscustomobject]@{
        ProcessId = 101
        ParentProcessId = 100
        Name = 'ChatGPT.exe'
        ExecutablePath = $desktopPath
        CreationDate = 1010
    },
    [pscustomobject]@{
        ProcessId = 102
        ParentProcessId = 100
        Name = 'codex.exe'
        ExecutablePath = $appServerPath
        CreationDate = 1020
    },
    [pscustomobject]@{
        ProcessId = 103
        ParentProcessId = 100
        Name = 'pwsh.exe'
        ExecutablePath = 'C:\Program Files\PowerShell\7\pwsh.exe'
        CreationDate = 1030
    },
    [pscustomobject]@{
        ProcessId = 200
        ParentProcessId = 102
        Name = 'codex.exe'
        ExecutablePath = 'C:\fixture\current-task\codex.exe'
        CreationDate = 2000
    }
)

function Get-CimInstance {
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)]
        [string]$ClassName
    )
    $null = $ClassName
    return $script:fixtureProcesses
}

function Assert-OnDemandDesktopRootExecutable {
    param(
        [object]$DesktopRoot,
        [string]$ExpectedDesktopPath
    )
    if ([int]$DesktopRoot.ProcessId -ne 100 -or
        -not [string]::Equals(
            [System.IO.Path]::GetFullPath(
                [string]$DesktopRoot.ExecutablePath
            ),
            [System.IO.Path]::GetFullPath($ExpectedDesktopPath),
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'Fixture root mismatch.'
    }
}

function Get-ProcessCreationIdentity {
    param([object]$CreationDate)
    return [pscustomobject]@{
        CreationDateUtcTicks = [long]$CreationDate
    }
}

function Open-ProcessIdentityHandle {
    param(
        [int]$ProcessId,
        [long]$ExpectedCreationDateUtcTicks
    )
    if ($ExpectedCreationDateUtcTicks -ne ($ProcessId * 10)) {
        throw "Fixture creation identity mismatch for PID $ProcessId."
    }
    $process = [pscustomobject]@{
        Id = $ProcessId
        HasExited = $false
    }
    $process | Add-Member ScriptMethod CloseMainWindow {
        return $true
    }
    $process | Add-Member ScriptMethod WaitForExit {
        param($TimeoutMilliseconds)
        $null = $TimeoutMilliseconds
        return $false
    }
    $process | Add-Member ScriptMethod Refresh { return }
    $process | Add-Member ScriptMethod Dispose {
        $script:disposedProcessIds.Add([int]$this.Id)
    }
    return [pscustomobject]@{
        Process = $process
        ProcessId = $ProcessId
        StartTimeUtcTicks = [long]$ExpectedCreationDateUtcTicks
    }
}

function Stop-ProcessIdentityHandle {
    param(
        [object]$IdentityHandle,
        [int]$TimeoutMilliseconds
    )
    $null = $TimeoutMilliseconds
    $script:stoppedProcessIds.Add(
        [int]$IdentityHandle.ProcessId
    )
    $IdentityHandle.Process.HasExited = $true
    return $true
}

$preparation = [pscustomobject]@{
    DesktopRootProcessId = 100
    DesktopRootStartTimeUtcTicks = 1000
    DesktopAppServerProcessId = 102
    DesktopAppServerStartTimeUtcTicks = 1020
    DesktopAppServerExecutablePath = $appServerPath
}
Stop-OnDemandDesktopProcessGroup `
    -Preparation $preparation `
    -ExpectedDesktopPath $desktopPath

[pscustomobject]@{
    StoppedProcessIds = @($script:stoppedProcessIds | Sort-Object)
    DisposedProcessIds = @($script:disposedProcessIds | Sort-Object)
    PreservedUnrelatedDirectChild =
        -not $script:stoppedProcessIds.Contains(103)
    PreservedNestedTaskProcess =
        -not $script:stoppedProcessIds.Contains(200)
} | ConvertTo-Json -Depth 8 -Compress
