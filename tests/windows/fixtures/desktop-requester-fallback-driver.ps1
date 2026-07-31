[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LauncherPath,

    [Parameter(Mandatory)]
    [ValidateSet(
        'module-missing-owner-mutex-held',
        'root-appears-before-fallback'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
. $LauncherPath -DefinitionOnly

$fixtureRoot = Join-Path `
    ([System.IO.Path]::GetTempPath()) `
    "codex-local-remote-requester-$([Guid]::NewGuid().ToString('N'))"
$null = New-Item -ItemType Directory -Path $fixtureRoot -Force
$script:nativeLaunchCalls = 0
$script:rootChecks = 0
$script:WindowsModuleAvailable = $false

function Invoke-CodexRequesterNativeFailOpen {
    $script:nativeLaunchCalls += 1
    return [pscustomobject][ordered]@{
        Status = 'launched-native'
        RemoteEnabled = $false
        RemoteDecision = 'remote-not-ready'
        RemoteFallbackAttempts = 0
        RemoteStopAttempts = 0
        DesktopProcessId = 42002
        RemoteFailureStage = 'runtime-handoff'
        RemoteFailureCode = 'handoff-timeout'
        CorrelationId = '0123456789abcdef0123456789abcdef'
        FeedbackStatus = 'pending'
        FeedbackFailureCode = $null
    }
}

function Test-CodexDesktopRootPresent {
    $script:rootChecks += 1
    return $Mode -ceq 'root-appears-before-fallback'
}

$holder = $null
try {
    $localMutexName = Get-CodexRequesterDesktopOwnerMutexName `
        -ManagedDataDir $fixtureRoot
    $windowsModule = Get-Module -Name 'CodexLocalRemote.Windows'
    $moduleMutexName = & $windowsModule {
        param([string]$DataDir)
        Get-CodexDesktopOwnerMutexName -DataDir $DataDir
    } $fixtureRoot
    if ($Mode -ceq 'module-missing-owner-mutex-held') {
        $readyPath = Join-Path $fixtureRoot 'holder.ready'
        $holderPath = Join-Path $PSScriptRoot 'desktop-owner-mutex-holder.ps1'
        $holder = Start-Process `
            -FilePath 'pwsh' `
            -ArgumentList @(
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-File',
                $holderPath,
                '-MutexName',
                $localMutexName,
                '-ReadyPath',
                $readyPath,
                '-HoldSeconds',
                '10'
            ) `
            -PassThru `
            -WindowStyle Hidden
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        while (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) {
            if ($holder.HasExited) {
                throw 'The Desktop owner mutex holder exited before readiness.'
            }
            if ([DateTime]::UtcNow -ge $deadline) {
                throw 'Timed out waiting for the Desktop owner mutex holder.'
            }
            Start-Sleep -Milliseconds 25
            $holder.Refresh()
        }
    }

    $result = Invoke-CodexRequesterFailOpenAfterOwnerFailure `
        -ManagedDataDir $fixtureRoot `
        -MutexTimeoutSeconds 1
    [pscustomobject][ordered]@{
        Result = $result
        NativeLaunchCalls = $script:nativeLaunchCalls
        RootChecks = $script:rootChecks
        MutexNameMatchesModule = $localMutexName -ceq $moduleMutexName
    } | ConvertTo-Json -Depth 8
} finally {
    if ($null -ne $holder -and -not $holder.HasExited) {
        Stop-Process -Id $holder.Id -Force -ErrorAction SilentlyContinue
        $null = $holder.WaitForExit(5000)
    }
    Remove-Item -LiteralPath $fixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
}
