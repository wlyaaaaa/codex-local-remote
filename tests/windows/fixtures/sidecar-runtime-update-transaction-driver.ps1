[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ModulePath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot,

    [Parameter(Mandatory)]
    [ValidateSet(
        'success',
        'new-start-fails',
        'invariant-drifts',
        'selected-runtime-drifts',
        'selected-runtime-persists',
        'compatibility-mismatch',
        'active-turns',
        'active-new-start-fails',
        'unknown-connection',
        'invalid-active-count',
        'drain-fails',
        'drain-receipt-mismatch',
        'rollback-owner-drifts',
        'rollback-unknown-connection',
        'rollback-fails'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
Import-Module $ModulePath -Force
$script:captureCount = 0
$script:events = [System.Collections.Generic.List[string]]::new()
$updateId = 'd' * 32
$oldSidecarBinding = [pscustomobject]@{
    VersionId = 'a' * 64
    RuntimeRoot = 'C:\\managed\\runtime-a'
    BrokerSidecarCompatibilityId =
        'codex-local-remote/broker-sidecar/v1'
}

function New-Invariant {
    $script:captureCount++
    if ($Mode -cin @(
            'selected-runtime-persists',
            'rollback-owner-drifts',
            'rollback-unknown-connection'
        ) -and
        $script:captureCount -ge 2) {
        throw 'Selected runtime drifted during the Sidecar-only update.'
    }
    $brokerProcessId = if (
        $Mode -ceq 'invariant-drifts' -and
        $script:captureCount -eq 2
    ) {
        901
    } else {
        900
    }
    $selectedRuntimeDrifted =
        $Mode -ceq 'selected-runtime-drifts' -and
        $script:captureCount -eq 2
    $selectedVersionId = if ($selectedRuntimeDrifted) {
        'c' * 64
    } else {
        'b' * 64
    }
    return [pscustomobject]@{
        SelectedVersionId = $selectedVersionId
        SelectedRoot = if ($selectedRuntimeDrifted) {
            'C:\managed\runtime-c'
        } else {
            'C:\managed\runtime-b'
        }
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
        UnsafeThreadCount = if ($Mode -cin @(
            'active-turns',
            'active-new-start-fails'
        )) {
            $script:captureCount
        } elseif ($Mode -ceq 'invalid-active-count') {
            -1
        } else {
            0
        }
        UnknownCount = if ($Mode -ceq 'unknown-connection') {
            1
        } else {
            0
        }
        DesktopConnected = $true
    }
}

function New-RollbackInvariant {
    return [pscustomobject]@{
        BrokerProcessId = if ($Mode -ceq 'rollback-owner-drifts') {
            901
        } else {
            900
        }
        BrokerStartTimeUtcTicks = 100
        RuntimeInvocationId = 'a' * 32
        UpstreamProcessId = 902
        UpstreamStartTimeUtcTicks = 101
        DesktopRootIdentityKey = 'desktop|ticks|hash'
        BrokerSidecarCompatibilityId =
            'codex-local-remote/broker-sidecar/v1'
        UnknownCount = if ($Mode -ceq 'rollback-unknown-connection') {
            1
        } else {
            0
        }
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
            -CaptureRollbackInvariant {
                New-RollbackInvariant
            } `
            -OldSidecarBinding $oldSidecarBinding `
            -UpdateId $updateId `
            -PrepareOldSidecar {
                param($requestedUpdateId)
                $script:events.Add("drain-old-$requestedUpdateId")
                if ($Mode -ceq 'drain-fails') {
                    throw 'injected old Sidecar drain failure'
                }
                [pscustomobject]@{
                    status = 'drained'
                    updateId = if (
                        $Mode -ceq 'drain-receipt-mismatch'
                    ) {
                        'e' * 32
                    } else {
                        $requestedUpdateId
                    }
                    activeMutations = 0
                }
            } `
            -StopOldSidecar {
                $script:events.Add('stop-old')
            } `
            -StartNewSidecar {
                $script:events.Add('start-new')
                if ($Mode -cin @(
                    'new-start-fails',
                    'active-new-start-fails',
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
