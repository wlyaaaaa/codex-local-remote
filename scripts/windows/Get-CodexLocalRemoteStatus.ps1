[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 18790,

    [string]$BasePath = '/codex-remote',

    [ValidateSet(443, 8443, 10000)]
    [int]$HttpsPort = 443,

    [string]$TaskName = 'Codex Local Remote'
)

$ProgressPreference = 'SilentlyContinue'
Import-Module (Join-Path $PSScriptRoot 'CodexLocalRemote.Windows.psm1') -Force
Assert-CanonicalBasePath -BasePath $BasePath

$task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
$listener = Get-NetTCPConnection `
    -State Listen `
    -LocalPort $Port `
    -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') } |
    Select-Object -First 1

$localUrl = Join-BasePathUrl -Origin "http://127.0.0.1:$Port" -BasePath $BasePath
$bootstrap = $null
$localError = $null
try {
    $bootstrap = Invoke-RestMethod `
        -Method Get `
        -Uri "${localUrl}api/v1/bootstrap" `
        -TimeoutSec 3
} catch {
    $localError = $_.Exception.Message
}

$publicUrl = $null
$routeMatches = $false
try {
    $tailscale = Get-Command tailscale -ErrorAction Stop
    $funnel = (& $tailscale.Source funnel status --json) | ConvertFrom-Json -Depth 20
    $webKey = @($funnel.Web.PSObject.Properties.Name |
        Where-Object { $_ -like "*:$HttpsPort" } |
        Select-Object -First 1)
    if ($webKey.Count -gt 0) {
        $routeProperty = $funnel.Web.$($webKey[0]).Handlers.PSObject.Properties[$BasePath]
        $expectedProxy = "http://127.0.0.1:$Port$BasePath"
        $routeMatches = $null -ne $routeProperty -and
            $routeProperty.Value.Proxy -ceq $expectedProxy
        if ($routeMatches) {
            $publicUrl = Join-BasePathUrl `
                -Origin "https://$($webKey[0].Split(':')[0])" `
                -BasePath $BasePath
        }
    }
} catch {
    # Tailscale is an optional exposure layer; local diagnostics remain useful.
}

[pscustomobject]@{
    Ready = (
        $null -ne $listener -and
        $bootstrap.productName -eq 'Codex Local Remote' -and
        $routeMatches
    )
    TaskState = if ($null -eq $task) { 'not-registered' } else { $task.State.ToString() }
    LoopbackListener = ($null -ne $listener)
    Product = $bootstrap.productName
    Configured = $bootstrap.configured
    Authenticated = $bootstrap.authenticated
    LocalUrl = $localUrl
    PublicRoute = if ($routeMatches) { 'configured' } else { 'not-configured' }
    PublicUrl = $publicUrl
    LocalError = $localError
}
