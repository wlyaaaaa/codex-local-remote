[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LauncherPath,

    [Parameter(Mandatory)]
    [ValidateSet(
        'desktop-drains',
        'desktop-stays-running',
        'handoff-fails',
        'drain-wait-fails'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
. $LauncherPath -DefinitionOnly

$script:requestCalls = 0
$script:waitCalls = 0
$script:fallbackCalls = 0
$caughtDiagnostic = $null
$result = $null

try {
    $result = Invoke-CodexDesktopOwnerRequestWithDrainRetry `
        -RequestOwnerAction {
            $script:requestCalls += 1
            if ($Mode -ceq 'desktop-drains' -and
                $script:requestCalls -gt 1) {
                return [pscustomobject]@{
                    Status = 'desktop-owner-requested'
                }
            }
            $code = if ($Mode -ceq 'handoff-fails') {
                'runtime-handoff-failed'
            } else {
                'desktop-running'
            }
            throw (New-CodexRemoteFailureException `
                -Stage 'runtime-handoff' `
                -Code $code)
        } `
        -WaitForDesktopDrainAction {
            $script:waitCalls += 1
            if ($Mode -ceq 'drain-wait-fails') {
                throw 'The Desktop drain observation failed.'
            }
            return $Mode -ceq 'desktop-drains'
        }
} catch {
    $script:fallbackCalls += 1
    $caughtDiagnostic = Get-CodexRemoteFailureDiagnostic `
        -ErrorRecord $_ `
        -DefaultStage 'unexpected' `
        -DefaultCode 'unexpected'
}

[pscustomobject][ordered]@{
    Result = $result
    RequestCalls = $script:requestCalls
    WaitCalls = $script:waitCalls
    FallbackCalls = $script:fallbackCalls
    FailureStage = if ($null -eq $caughtDiagnostic) {
        $null
    } else {
        [string]$caughtDiagnostic.Stage
    }
    FailureCode = if ($null -eq $caughtDiagnostic) {
        $null
    } else {
        [string]$caughtDiagnostic.Code
    }
} | ConvertTo-Json -Depth 6 -Compress
