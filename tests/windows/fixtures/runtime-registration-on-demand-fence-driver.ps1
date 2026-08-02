[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$RegistrationPath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot,

    [switch]$Probe
)

$ErrorActionPreference = 'Stop'
$resolvedDataDir = [System.IO.Path]::GetFullPath($SandboxRoot)

function Get-FixtureMutexName {
    param([Parameter(Mandatory)][string]$DataDir)

    $identity = [System.IO.Path]::GetFullPath($DataDir).ToUpperInvariant()
    $digest = [Convert]::ToHexString(
        [System.Security.Cryptography.SHA256]::HashData(
            [System.Text.Encoding]::UTF8.GetBytes($identity)
        )
    ).ToLowerInvariant()
    return "Global\CodexLocalRemote.OnDemandControl.$digest"
}

if ($Probe) {
    $mutex = [System.Threading.Mutex]::new(
        $false,
        (Get-FixtureMutexName -DataDir $resolvedDataDir)
    )
    $taken = $false
    try {
        try {
            $taken = $mutex.WaitOne([TimeSpan]::FromMilliseconds(250))
        } catch [System.Threading.AbandonedMutexException] {
            $taken = $true
        }
        [pscustomobject]@{ Acquired = $taken } |
            ConvertTo-Json -Compress
    } finally {
        if ($taken) {
            $mutex.ReleaseMutex()
        }
        $mutex.Dispose()
    }
    exit 0
}

$offlineBrokerUpstreamPortMigrationRequested = $true
$expected = [pscustomobject]@{ DataDir = $resolvedDataDir }

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
foreach ($functionName in @(
    'Enter-RegistrationOnDemandControlFence',
    'Exit-RegistrationOnDemandControlFence'
)) {
    $functionAst = @(
        $registrationAst.FindAll({
            param($node)
            $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            [string]$node.Name -ceq $functionName
        }, $true)
    )
    if ($functionAst.Count -ne 1) {
        throw "fixture expected exactly one '$functionName' function"
    }
    Invoke-Expression ([string]$functionAst[0].Extent.Text)
}

function Invoke-FenceProbe {
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $process.StartInfo.FileName = (Get-Command pwsh).Source
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    foreach ($argument in @(
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        $PSCommandPath,
        '-RegistrationPath',
        $RegistrationPath,
        '-SandboxRoot',
        $resolvedDataDir,
        '-Probe'
    )) {
        $process.StartInfo.ArgumentList.Add($argument)
    }
    try {
        if (-not $process.Start()) {
            throw 'fixture probe did not start'
        }
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            throw "fixture probe failed: $stderr"
        }
        return $stdout | ConvertFrom-Json
    } finally {
        $process.Dispose()
    }
}

$fence = Enter-RegistrationOnDemandControlFence
$heldProbe = $null
$releasedProbe = $null
try {
    $heldProbe = Invoke-FenceProbe
} finally {
    Exit-RegistrationOnDemandControlFence -Fence $fence
}
$releasedProbe = Invoke-FenceProbe

[pscustomobject]@{
    BlockedWhileHeld = -not [bool]$heldProbe.Acquired
    AcquiredAfterRelease = [bool]$releasedProbe.Acquired
    MutexName = Get-FixtureMutexName -DataDir $resolvedDataDir
} | ConvertTo-Json -Compress
