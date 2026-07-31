[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$MutexName,

    [Parameter(Mandatory)]
    [string]$ReadyPath,

    [ValidateRange(1, 30)]
    [int]$HoldSeconds = 5
)

$ErrorActionPreference = 'Stop'
$mutex = [System.Threading.Mutex]::new($false, $MutexName)
$lockTaken = $false
try {
    try {
        $lockTaken = $mutex.WaitOne([TimeSpan]::FromSeconds(5))
    } catch [System.Threading.AbandonedMutexException] {
        $lockTaken = $true
    }
    if (-not $lockTaken) {
        throw 'Fixture could not acquire the Desktop owner mutex.'
    }
    [System.IO.File]::WriteAllText($ReadyPath, 'ready')
    Start-Sleep -Seconds $HoldSeconds
} finally {
    if ($lockTaken) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
