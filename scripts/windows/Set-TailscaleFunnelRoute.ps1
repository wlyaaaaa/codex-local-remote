[CmdletBinding(SupportsShouldProcess)]
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
        $status = $text | ConvertFrom-Json -Depth 50
    } catch {
        throw "Tailscale returned invalid Funnel JSON: $($_.Exception.Message)"
    }
    return [pscustomobject]@{ Text = $text; Status = $status }
}

function Invoke-FunnelSetPath {
    param(
        [Parameter(Mandatory)]
        [string]$Target
    )

    $null = & $tailscale.Source funnel --bg "--https=$HttpsPort" "--set-path=$BasePath" --yes $Target
    if ($LASTEXITCODE -ne 0) {
        throw "Tailscale rejected the incremental Funnel route for '$BasePath'."
    }
}

function Invoke-FunnelRemovePath {
    $null = & $tailscale.Source funnel "--https=$HttpsPort" "--set-path=$BasePath" off --yes
    if ($LASTEXITCODE -ne 0) {
        throw "Tailscale could not remove Funnel path '$BasePath'."
    }
}

# This is the complete, read-only pre-image and must precede every write.
$beforeSnapshot = Get-FunnelStatusSnapshot
$statusBefore = $beforeSnapshot.Status
$entriesBefore = @(Get-FunnelHandlerEntries -Status $statusBefore)
$webKeyBefore = Get-FunnelWebKey -Status $statusBefore -HttpsPort $HttpsPort
$existingRouteProperty = if ($null -ne $webKeyBefore) {
    $statusBefore.Web.PSObject.Properties[$webKeyBefore].Value.Handlers.PSObject.Properties[$BasePath]
} else {
    $null
}

$loopbackOrigin = "http://127.0.0.1:$Port"
# Tailscale strips --set-path from the public request before proxying it.
# Keep the sidecar's configured BasePath in the target URL so the backend sees
# the same prefixed path that it serves locally.
$expectedProxy = "$loopbackOrigin$BasePath"
$legacyProxy = $loopbackOrigin
$existingProxy = if ($null -ne $existingRouteProperty) {
    [string]$existingRouteProperty.Value.Proxy
} else {
    $null
}
$isLegacyUpgrade = $null -ne $existingRouteProperty -and
    $existingProxy -ceq $legacyProxy
if ($null -ne $existingRouteProperty -and
    $existingProxy -cne $expectedProxy -and
    -not $isLegacyUpgrade) {
    throw "Funnel path '$BasePath' is already owned by another target."
}

$bootstrapUri = Join-BasePathUrl `
    -Origin $loopbackOrigin `
    -BasePath $BasePath `
    -Suffix 'api/v1/bootstrap'
try {
    $bootstrap = Invoke-RestMethod -Method Get -Uri $bootstrapUri -TimeoutSec 5
} catch {
    throw "Sidecar health check failed at $bootstrapUri. Start it before exposing Funnel."
}
if ([string]$bootstrap.productName -cne 'Codex Local Remote') {
    throw 'The target port does not identify itself as Codex Local Remote.'
}

if ($null -ne $existingRouteProperty -and -not $isLegacyUpgrade) {
    [pscustomobject]@{
        Status = 'already-configured'
        PublicUrl = Join-BasePathUrl `
            -Origin "https://$($webKeyBefore.Split(':')[0])" `
            -BasePath $BasePath
        LocalTarget = $expectedProxy
        Backup = $null
    }
    return
}

if (-not $PSCmdlet.ShouldProcess(
    "HTTPS $HttpsPort $BasePath",
    "Add an incremental Funnel proxy to $expectedProxy"
)) {
    [pscustomobject]@{
        Status = 'what-if'
        LocalTarget = $expectedProxy
        Backup = $null
    }
    return
}

$backupRoot = Join-Path $env:LOCALAPPDATA 'CodexLocalRemote\funnel-backups'
$null = New-Item -ItemType Directory -Force -Path $backupRoot
$backupFile = Join-Path $backupRoot (
    "funnel-{0:yyyyMMdd-HHmmss-fff}-{1}.json" -f (Get-Date), ([guid]::NewGuid().ToString('N'))
)
[System.IO.File]::WriteAllText(
    $backupFile,
    $beforeSnapshot.Text,
    [System.Text.UTF8Encoding]::new($false)
)

$mutationAttempted = $false
$writtenHandlerJson = $null
try {
    # ShouldProcess can be followed by an arbitrarily long human or scheduler
    # delay. Re-read immediately before the mutation so a concurrent Funnel
    # writer cannot be overwritten using a stale pre-image.
    $preWriteSnapshot = Get-FunnelStatusSnapshot
    $preWriteEntries = @(Get-FunnelHandlerEntries -Status $preWriteSnapshot.Status)
    if (-not (Test-FunnelHandlerEntriesEqual -Left $entriesBefore -Right $preWriteEntries)) {
        throw 'Funnel configuration changed concurrently before the project route was written.'
    }

    $mutationAttempted = $true
    Invoke-FunnelSetPath -Target $expectedProxy

    $afterSnapshot = Get-FunnelStatusSnapshot
    $statusAfter = $afterSnapshot.Status
    $webKeyAfter = Get-FunnelWebKey -Status $statusAfter -HttpsPort $HttpsPort
    if ($null -eq $webKeyAfter) {
        throw 'Funnel did not report an HTTPS handler after configuration.'
    }

    $routeAfterProperty = $statusAfter.Web.PSObject.Properties[$webKeyAfter].Value.Handlers.PSObject.Properties[$BasePath]
    if ($null -ne $routeAfterProperty) {
        $writtenHandlerJson = ConvertTo-CanonicalJson $routeAfterProperty.Value
    }
    if ($null -eq $routeAfterProperty -or
        [string]$routeAfterProperty.Value.Proxy -cne $expectedProxy) {
        throw "Funnel route verification failed for '$BasePath'."
    }

    $entriesAfter = @(Get-FunnelHandlerEntries -Status $statusAfter)
    $otherBefore = @($entriesBefore | Where-Object {
        -not ($_.WebKey -ceq $webKeyBefore -and $_.Path -ceq $BasePath)
    })
    $otherAfter = @($entriesAfter | Where-Object {
        -not ($_.WebKey -ceq $webKeyAfter -and $_.Path -ceq $BasePath)
    })
    if (-not (Test-FunnelHandlerEntriesEqual -Left $otherBefore -Right $otherAfter)) {
        throw 'An existing Funnel handler changed during the incremental update.'
    }
    if ($null -ne $existingRouteProperty -and
        -not $isLegacyUpgrade -and
        (ConvertTo-CanonicalJson $existingRouteProperty.Value) -cne
        (ConvertTo-CanonicalJson $routeAfterProperty.Value)) {
        throw 'The pre-existing project route changed during the incremental update.'
    }
} catch {
    $failure = $_
    if ($mutationAttempted) {
        $rollbackError = $null
        try {
            # Never remove or overwrite a handler that another process changed
            # after our write. Rollback is allowed only while the live project
            # handler still has the exact identity observed after our mutation.
            $rollbackGuardSnapshot = Get-FunnelStatusSnapshot
            $rollbackGuardStatus = $rollbackGuardSnapshot.Status
            $rollbackGuardWebKey = Get-FunnelWebKey -Status $rollbackGuardStatus -HttpsPort $HttpsPort
            $rollbackGuardProperty = if ($null -ne $rollbackGuardWebKey) {
                $rollbackGuardStatus.Web.PSObject.Properties[$rollbackGuardWebKey].Value.Handlers.PSObject.Properties[$BasePath]
            } else {
                $null
            }
            $rollbackGuardJson = if ($null -ne $rollbackGuardProperty) {
                ConvertTo-CanonicalJson $rollbackGuardProperty.Value
            } else {
                $null
            }
            if ($null -eq $writtenHandlerJson -or
                $null -eq $rollbackGuardJson -or
                $rollbackGuardJson -cne $writtenHandlerJson) {
                throw 'Concurrent Funnel conflict: the project handler no longer matches this script write; automatic rollback was not attempted.'
            }
            if ($isLegacyUpgrade) {
                Invoke-FunnelSetPath -Target $legacyProxy
            } else {
                Invoke-FunnelRemovePath
            }
            $rollbackSnapshot = Get-FunnelStatusSnapshot
            $rollbackEntries = @(Get-FunnelHandlerEntries -Status $rollbackSnapshot.Status)
            if (-not (Test-FunnelHandlerEntriesEqual -Left $entriesBefore -Right $rollbackEntries)) {
                throw 'The Funnel handler set does not match the pre-change snapshot.'
            }
        } catch {
            $rollbackError = $_.Exception.Message
        }

        if ($null -ne $rollbackError) {
            throw "$($failure.Exception.Message) Automatic rollback was incomplete: $rollbackError"
        }
        throw "$($failure.Exception.Message) The project route was rolled back to its exact pre-change handler state."
    }
    throw
}

[pscustomobject]@{
    Status = 'configured'
    PublicUrl = Join-BasePathUrl `
        -Origin "https://$($webKeyAfter.Split(':')[0])" `
        -BasePath $BasePath
    LocalTarget = $expectedProxy
    PreservedHandlerCount = $otherBefore.Count
    Backup = $backupFile
}
