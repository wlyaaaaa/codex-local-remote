[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ModulePath
)

$ErrorActionPreference = 'Stop'
$listener = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    0
)
$global:CodexLocalRemoteLegacyTcpQueryCalls = 0

function global:Get-NetTCPConnection {
    $global:CodexLocalRemoteLegacyTcpQueryCalls += 1
    throw 'The legacy NetTCPIP provider must not be called.'
}

try {
    $listener.Start()
    $port = [int](
        [System.Net.IPEndPoint]$listener.LocalEndpoint
    ).Port
    Import-Module -Name $ModulePath -Force
    $snapshot = @(
        Get-CodexLocalRemoteTcpListenerSnapshot -LocalPorts @($port)
    )
    [pscustomobject][ordered]@{
        Count = $snapshot.Count
        LocalAddress = if ($snapshot.Count -eq 1) {
            [string]$snapshot[0].LocalAddress
        } else {
            $null
        }
        LocalPort = if ($snapshot.Count -eq 1) {
            [int]$snapshot[0].LocalPort
        } else {
            $null
        }
        OwningProcess = if ($snapshot.Count -eq 1) {
            [int]$snapshot[0].OwningProcess
        } else {
            $null
        }
        ExpectedPort = $port
        ExpectedProcess = $PID
        LegacyTcpQueryCalls =
            $global:CodexLocalRemoteLegacyTcpQueryCalls
    } | ConvertTo-Json -Compress
} finally {
    Remove-Module CodexLocalRemote.Windows -Force -ErrorAction SilentlyContinue
    $listener.Stop()
    Remove-Item Function:\Get-NetTCPConnection -Force -ErrorAction SilentlyContinue
    Remove-Variable `
        -Name CodexLocalRemoteLegacyTcpQueryCalls `
        -Scope Global `
        -ErrorAction SilentlyContinue
}
