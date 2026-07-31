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
        'no-active-pending-supersede',
        'no-active-pending-supersede-mismatch',
        'no-active-current-only-supersede',
        'no-active-same-supersede',
        'active-pending-supersede',
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
            Supersede = $null
        }
    }
    'pending-same' {
        @{
            Active = $a
            Current = $b
            Previous = $a
            Candidate = $b
            Repair = $null
            Supersede = $null
        }
    }
    'damaged-repair' {
        @{
            Active = $a
            Current = $c
            Previous = $b
            Candidate = $d
            Repair = $a
            Supersede = $null
        }
    }
    'stable-new' {
        @{
            Active = $c
            Current = $c
            Previous = $b
            Candidate = $d
            Repair = $null
            Supersede = $null
        }
    }
    'no-active-pending-new' {
        @{
            Active = $null
            Current = $b
            Previous = $a
            Candidate = $c
            Repair = $null
            Supersede = $null
        }
    }
    'no-active-pending-supersede' {
        @{
            Active = $null
            Current = $b
            Previous = $a
            Candidate = $c
            Repair = $null
            Supersede = $b
        }
    }
    'no-active-pending-supersede-mismatch' {
        @{
            Active = $null
            Current = $b
            Previous = $a
            Candidate = $c
            Repair = $null
            Supersede = $a
        }
    }
    'no-active-current-only-supersede' {
        @{
            Active = $null
            Current = $b
            Previous = $null
            Candidate = $c
            Repair = $null
            Supersede = $b
        }
    }
    'no-active-same-supersede' {
        @{
            Active = $null
            Current = $b
            Previous = $a
            Candidate = $b
            Repair = $null
            Supersede = $b
        }
    }
    'active-pending-supersede' {
        @{
            Active = $a
            Current = $b
            Previous = $a
            Candidate = $c
            Repair = $null
            Supersede = $b
        }
    }
    'no-active-current-only-new' {
        @{
            Active = $null
            Current = $b
            Previous = $null
            Candidate = $c
            Repair = $null
            Supersede = $null
        }
    }
    default {
        @{
            Active = $null
            Current = $c
            Previous = $b
            Candidate = $d
            Repair = $a
            Supersede = $null
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
    -RepairActiveVersionId $case.Repair `
    -SupersedeOfflineSelectedVersionId $case.Supersede

[pscustomobject]@{
    Mode = $Mode
    Action = [string]$result.Action
    Reason = [string]$result.Reason
} | ConvertTo-Json -Depth 10 -Compress
