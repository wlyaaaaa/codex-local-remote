[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ModulePath,

    [Parameter(Mandatory)]
    [ValidateSet(
        'success',
        'new-start-fails',
        'invariant-drifts',
        'selected-runtime-drifts',
        'compatibility-mismatch',
        'active-turns',
        'rollback-fails'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
Import-Module $ModulePath -Force
$script:captureCount = 0
$script:events = [System.Collections.Generic.List[string]]::new()

function New-Invariant {
    $script:captureCount++
    $brokerProcessId = if (
        $Mode -ceq 'invariant-drifts' -and
        $script:captureCount -eq 2
    ) {
        901
    } else {
        900
    }
    $selectedVersionId = if (
        $Mode -ceq 'selected-runtime-drifts' -and
        $script:captureCount -eq 2
    ) {
        'c' * 64
    } else {
        'b' * 64
    }
    return [pscustomobject]@{
        SelectedVersionId = $selectedVersionId
        SelectedRoot = 'C:\managed\runtime-b'
        BrokerProcessId = $brokerProcessId
        BrokerStartTimeUtcTicks = 100
        RuntimeInvocationId = 'a' * 32
        UpstreamProcessId = 902
        UpstreamStartTimeUtcTicks = 101
        DesktopRootIdentityKey = 'desktop|ticks|hash'
        BrokerSidecarCompatibilityId =
            'codex-local-remote/broker-sidecar/v1'
        CandidateSidecarCompatibilityId = if (
            $Mode -ceq 'compatibility-mismatch'
        ) {
            'codex-local-remote/broker-sidecar/v2'
        } else {
            'codex-local-remote/broker-sidecar/v1'
        }
        UnsafeThreadCount = if ($Mode -ceq 'active-turns') {
            1
        } else {
            0
        }
        UnknownCount = 0
        DesktopConnected = $true
    }
}

$result = $null
$errorMessage = $null
try {
    $result =
        Invoke-CodexLocalRemoteSidecarUpdateTransaction `
            -CaptureInvariant {
                New-Invariant
            } `
            -StopOldSidecar {
                $script:events.Add('stop-old')
            } `
            -StartNewSidecar {
                $script:events.Add('start-new')
                if ($Mode -cin @(
                    'new-start-fails',
                    'rollback-fails'
                )) {
                    throw 'injected new Sidecar failure'
                }
                [pscustomobject]@{ ProcessId = 200 }
            } `
            -VerifyNewSidecar {
                param($sidecar)
                $script:events.Add("verify-new-$($sidecar.ProcessId)")
                [pscustomobject]@{ ProcessId = 902 }
            } `
            -StopNewSidecar {
                param($sidecar)
                $script:events.Add("stop-new-$($sidecar.ProcessId)")
            } `
            -StartOldSidecar {
                $script:events.Add('start-old')
                if ($Mode -ceq 'rollback-fails') {
                    throw 'injected old Sidecar rollback failure'
                }
                [pscustomobject]@{ ProcessId = 100 }
            } `
            -VerifyOldSidecar {
                param($sidecar)
                $script:events.Add("verify-old-$($sidecar.ProcessId)")
                [pscustomobject]@{ ProcessId = 902 }
            }
} catch {
    $errorMessage = $_.Exception.Message
}

[pscustomobject]@{
    Status = if ($null -eq $result) {
        'failed'
    } else {
        [string]$result.Status
    }
    SidecarProcessId = if ($null -eq $result) {
        0
    } else {
        [int]$result.Sidecar.ProcessId
    }
    Failure = if ($null -eq $result) {
        $errorMessage
    } else {
        [string]$result.Failure
    }
    Events = [string[]]$script:events.ToArray()
} | ConvertTo-Json -Depth 5 -Compress
