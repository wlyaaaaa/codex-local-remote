[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ModulePath
)

$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $ModulePath),
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    throw 'The Windows module did not parse.'
}
$functionAst = @(
    $ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        [string]$node.Name -ceq
            'Select-CodexLocalRemoteNativeDesktopRootCandidates'
    }, $true)
)
if ($functionAst.Count -ne 1) {
    throw 'The native Desktop root selector was not found exactly once.'
}
Invoke-Expression ([string]$functionAst[0].Extent.Text)

$desktopPath =
    'C:\Program Files\WindowsApps\OpenAI.Codex_fixture\app\ChatGPT.exe'
$foreignPath =
    'C:\Program Files\WindowsApps\Other.Codex_fixture\app\ChatGPT.exe'

function New-Candidate {
    param(
        [int]$ProcessId,
        [int]$ParentProcessId,
        [AllowEmptyString()]
        [string]$CommandLine,
        [AllowEmptyString()]
        [string]$ExecutablePath
    )

    return [pscustomobject]@{
        ProcessId = $ProcessId
        ParentProcessId = $ParentProcessId
        CommandLine = $CommandLine
        ExecutablePath = $ExecutablePath
    }
}

$root = New-Candidate `
    -ProcessId 41001 `
    -ParentProcessId 40000 `
    -CommandLine ('"' + $desktopPath + '" --remote-debugging-port=0') `
    -ExecutablePath $desktopPath
$transientChild = New-Candidate `
    -ProcessId 41002 `
    -ParentProcessId 41001 `
    -CommandLine '' `
    -ExecutablePath ''
$renderer = New-Candidate `
    -ProcessId 41003 `
    -ParentProcessId 41001 `
    -CommandLine ('"' + $desktopPath + '" --type=renderer') `
    -ExecutablePath $desktopPath
$secondRoot = New-Candidate `
    -ProcessId 42001 `
    -ParentProcessId 40001 `
    -CommandLine ('"' + $desktopPath + '" --remote-debugging-port=0') `
    -ExecutablePath $desktopPath
$foreignRoot = New-Candidate `
    -ProcessId 43001 `
    -ParentProcessId 40002 `
    -CommandLine ('"' + $foreignPath + '"') `
    -ExecutablePath $foreignPath
$unresolvedRoot = New-Candidate `
    -ProcessId 44001 `
    -ParentProcessId 40003 `
    -CommandLine '' `
    -ExecutablePath ''

function Select-Ids {
    param([object[]]$Candidates)

    return @(
        Select-CodexLocalRemoteNativeDesktopRootCandidates `
            -Candidates $Candidates `
            -DesktopExecutablePath $desktopPath |
            ForEach-Object { [int]$_.ProcessId }
    )
}

[pscustomobject]@{
    TransientChild = @(Select-Ids -Candidates @(
        $root,
        $transientChild,
        $renderer
    ))
    TrueSecondRoot = @(Select-Ids -Candidates @($root, $secondRoot))
    ForeignRoot = @(Select-Ids -Candidates @($root, $foreignRoot))
    UnresolvedRoot = @(Select-Ids -Candidates @($root, $unresolvedRoot))
} | ConvertTo-Json -Compress
