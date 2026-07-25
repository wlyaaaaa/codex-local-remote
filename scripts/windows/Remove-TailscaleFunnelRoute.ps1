[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 18790,

    [string]$BasePath = '/codex-remote',

    [ValidateSet(443, 8443, 10000)]
    [int]$HttpsPort = 443
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module (Join-Path $PSScriptRoot 'CodexLocalRemote.Windows.psm1') -Force
Assert-CanonicalBasePath -BasePath $BasePath -DisallowRoot

$tailscale = Get-Command tailscale -ErrorAction Stop

function Get-FunnelStatusSnapshot {
    $lines = @(& $tailscale.Source funnel status --json)
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to read the current Tailscale Funnel configuration.'
    }
    $text = $lines -join [Environment]::NewLine
    try {
        return ($text | ConvertFrom-Json -Depth 50)
    } catch {
        throw "Tailscale returned invalid Funnel JSON: $($_.Exception.Message)"
    }
}

function Invoke-FunnelSetPath {
    param([Parameter(Mandatory)][string]$Target)
    $null = & $tailscale.Source funnel --bg "--https=$HttpsPort" "--set-path=$BasePath" --yes $Target
    if ($LASTEXITCODE -ne 0) {
        throw "Tailscale could not restore Funnel path '$BasePath'."
    }
}

function Invoke-FunnelRemovePath {
    $null = & $tailscale.Source funnel "--https=$HttpsPort" "--set-path=$BasePath" off --yes
    if ($LASTEXITCODE -ne 0) {
        throw "Tailscale could not remove Funnel path '$BasePath'."
    }
}

# Removal also begins with a complete, read-only pre-image.
$statusBefore = Get-FunnelStatusSnapshot
$entriesBefore = @(Get-FunnelHandlerEntries -Status $statusBefore)
$webKeyBefore = Get-FunnelWebKey -Status $statusBefore -HttpsPort $HttpsPort
if ($null -eq $webKeyBefore) {
    [pscustomobject]@{ Status = 'not-found'; BasePath = $BasePath }
    return
}

$routeProperty = $statusBefore.Web.PSObject.Properties[$webKeyBefore].Value.Handlers.PSObject.Properties[$BasePath]
if ($null -eq $routeProperty) {
    [pscustomobject]@{ Status = 'not-found'; BasePath = $BasePath }
    return
}

$expectedProxy = "http://127.0.0.1:$Port"
if ([string]$routeProperty.Value.Proxy -cne $expectedProxy) {
    throw "Funnel path '$BasePath' targets '$($routeProperty.Value.Proxy)', not this project's expected target '$expectedProxy'; refusing to remove it."
}
$routeBeforeJson = ConvertTo-CanonicalJson $routeProperty.Value

$bootstrapUri = Join-BasePathUrl `
    -Origin $expectedProxy `
    -BasePath $BasePath `
    -Suffix 'api/v1/bootstrap'
try {
    $bootstrap = Invoke-RestMethod -Method Get -Uri $bootstrapUri -TimeoutSec 5
} catch {
    throw "Cannot verify route ownership at $bootstrapUri; refusing to remove it."
}
if ([string]$bootstrap.productName -cne 'Codex Local Remote') {
    throw "The route target does not identify itself as Codex Local Remote; refusing to remove '$BasePath'."
}

if (-not $PSCmdlet.ShouldProcess("HTTPS $HttpsPort $BasePath", 'Remove only this verified project Funnel path')) {
    [pscustomobject]@{ Status = 'what-if'; BasePath = $BasePath }
    return
}

$mutationAttempted = $false
try {
    # ShouldProcess can be followed by an arbitrarily long human or scheduler
    # delay. Re-read the complete handler set immediately before removal and
    # require the live route to retain this project's exact proxy ownership.
    $preRemoveStatus = Get-FunnelStatusSnapshot
    $preRemoveEntries = @(Get-FunnelHandlerEntries -Status $preRemoveStatus)
    if (-not (Test-FunnelHandlerEntriesEqual -Left $entriesBefore -Right $preRemoveEntries)) {
        throw 'Funnel configuration changed concurrently before the project route was removed.'
    }
    $preRemoveWebKey = Get-FunnelWebKey -Status $preRemoveStatus -HttpsPort $HttpsPort
    $preRemoveProperty = if ($null -ne $preRemoveWebKey) {
        $preRemoveStatus.Web.PSObject.Properties[$preRemoveWebKey].Value.Handlers.PSObject.Properties[$BasePath]
    } else {
        $null
    }
    if ($null -eq $preRemoveProperty -or
        [string]$preRemoveProperty.Value.Proxy -cne $expectedProxy) {
        throw 'Funnel configuration changed concurrently and the project no longer owns the live route; refusing to remove it.'
    }

    $mutationAttempted = $true
    Invoke-FunnelRemovePath

    $statusAfter = Get-FunnelStatusSnapshot
    $entriesAfter = @(Get-FunnelHandlerEntries -Status $statusAfter)
    $routeAfter = @($entriesAfter | Where-Object {
        $_.WebKey -ceq $webKeyBefore -and $_.Path -ceq $BasePath
    })
    if ($routeAfter.Count -ne 0) {
        throw "Funnel still reports '$BasePath' after removal."
    }

    $otherBefore = @($entriesBefore | Where-Object {
        -not ($_.WebKey -ceq $webKeyBefore -and $_.Path -ceq $BasePath)
    })
    if (-not (Test-FunnelHandlerEntriesEqual -Left $otherBefore -Right $entriesAfter)) {
        throw 'An unrelated Funnel handler changed during route removal.'
    }
} catch {
    $failure = $_
    if ($mutationAttempted) {
        $rollbackError = $null
        try {
            # Restore only while the path is absent. If the exact pre-image is
            # already live, no write is needed; any other handler at this path
            # may belong to a concurrent writer and must never be overwritten.
            $rollbackGuardStatus = Get-FunnelStatusSnapshot
            $rollbackGuardWebKey = Get-FunnelWebKey `
                -Status $rollbackGuardStatus `
                -HttpsPort $HttpsPort
            $rollbackGuardProperty = if ($null -ne $rollbackGuardWebKey) {
                $rollbackGuardStatus.Web.PSObject.Properties[$rollbackGuardWebKey].Value.Handlers.PSObject.Properties[$BasePath]
            } else {
                $null
            }
            if ($null -ne $rollbackGuardProperty) {
                $rollbackGuardJson = ConvertTo-CanonicalJson $rollbackGuardProperty.Value
                if ($rollbackGuardWebKey -cne $webKeyBefore -or
                    $rollbackGuardJson -cne $routeBeforeJson) {
                    throw 'Concurrent Funnel conflict: another handler now owns the removal path; automatic rollback was not attempted.'
                }
            } else {
                Invoke-FunnelSetPath -Target $expectedProxy
            }

            $rollbackStatus = Get-FunnelStatusSnapshot
            $rollbackEntries = @(Get-FunnelHandlerEntries -Status $rollbackStatus)
            if (-not (Test-FunnelHandlerEntriesEqual -Left $entriesBefore -Right $rollbackEntries)) {
                throw 'The Funnel handler set does not match the pre-removal snapshot.'
            }
        } catch {
            $rollbackError = $_.Exception.Message
        }

        if ($null -ne $rollbackError) {
            throw "$($failure.Exception.Message) Automatic rollback was incomplete: $rollbackError"
        }
        throw "$($failure.Exception.Message) The project route was restored to its exact pre-removal handler state."
    }
    throw
}

[pscustomobject]@{
    Status = 'removed'
    BasePath = $BasePath
    PreservedHandlerCount = $otherBefore.Count
}
