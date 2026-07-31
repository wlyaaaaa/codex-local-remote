[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$RegistrationPath,

    [Parameter(Mandatory)]
    [ValidateSet(
        'pending-new',
        'pending-same',
        'damaged-repair',
        'stable-new',
        'no-active-pending-new',
        'no-active-current-only-new',
        'repair-without-active'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
$a = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
$b = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
$c = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
$d = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
$case = switch ($Mode) {
    'pending-new' {
        @{
            Active = $a
            Current = $b
            Previous = $a
            Candidate = $c
            Repair = $null
        }
    }
    'pending-same' {
        @{
            Active = $a
            Current = $b
            Previous = $a
            Candidate = $b
            Repair = $null
        }
    }
    'damaged-repair' {
        @{
            Active = $a
            Current = $c
            Previous = $b
            Candidate = $d
            Repair = $a
        }
    }
    'stable-new' {
        @{
            Active = $c
            Current = $c
            Previous = $b
            Candidate = $d
            Repair = $null
        }
    }
    'no-active-pending-new' {
        @{
            Active = $null
            Current = $b
            Previous = $a
            Candidate = $c
            Repair = $null
        }
    }
    'no-active-current-only-new' {
        @{
            Active = $null
            Current = $b
            Previous = $null
            Candidate = $c
            Repair = $null
        }
    }
    default {
        @{
            Active = $null
            Current = $c
            Previous = $b
            Candidate = $d
            Repair = $a
        }
    }
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
$functionAst = @(
    $registrationAst.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        [string]$node.Name -ceq 'Resolve-RegistrationPendingRuntimeAction'
    }, $true)
)
if ($functionAst.Count -ne 1) {
    throw "fixture expected exactly one 'Resolve-RegistrationPendingRuntimeAction' function"
}
Invoke-Expression ([string]$functionAst[0].Extent.Text)

$result = Resolve-RegistrationPendingRuntimeAction `
    -ActiveVersionId $case.Active `
    -CurrentVersionId $case.Current `
    -PreviousVersionId $case.Previous `
    -CandidateVersionId $case.Candidate `
    -RepairActiveVersionId $case.Repair

[pscustomobject]@{
    Mode = $Mode
    Action = [string]$result.Action
    Reason = [string]$result.Reason
} | ConvertTo-Json -Depth 10 -Compress
