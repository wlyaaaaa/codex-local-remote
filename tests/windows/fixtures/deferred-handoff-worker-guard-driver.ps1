[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptPath,

    [Parameter(Mandatory)]
    [ValidateSet(
        'wrong-generation',
        'mutex-busy',
        'foreign-fresh-receipt',
        'matching-intent-receipt',
        'matching-desired-intent',
        'native-desired-intent',
        'superseded-desired-intent',
        'wrong-desired-runtime'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
. $ScriptPath -DefinitionOnly

if ($Mode -ceq 'mutex-busy') {
    $fixtureId = [guid]::NewGuid().ToString('N')
    $dataDir = Join-Path `
        $env:TEMP `
        "deferred-handoff-mutex-fixture-$fixtureId"
    $mutexName = Get-DeferredHandoffWorkerMutexName -DataDir $dataDir
    $readyPath = Join-Path `
        $env:TEMP `
        "deferred-handoff-mutex-$fixtureId.ready"
    $stdoutPath = Join-Path `
        $env:TEMP `
        "deferred-handoff-mutex-$fixtureId.stdout.log"
    $stderrPath = Join-Path `
        $env:TEMP `
        "deferred-handoff-mutex-$fixtureId.stderr.log"
    $holderPath = Join-Path $PSScriptRoot 'desktop-owner-mutex-holder.ps1'
    $holder = $null
    $holderProcessId = 0
    $holderStartTimeUtcTicks = 0
    $readyState = ''
    function Read-MutexHolderDiagnostic {
        param([string]$Path)

        try {
            if (Test-Path -LiteralPath $Path -PathType Leaf) {
                return [System.IO.File]::ReadAllText($Path)
            }
        } catch {
            return "<unavailable: $($_.Exception.Message)>"
        }
        return ''
    }
    try {
        $holder = Start-Process `
            -FilePath 'pwsh' `
            -ArgumentList @(
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-File',
                $holderPath,
                '-MutexName',
                $mutexName,
                '-ReadyPath',
                $readyPath,
                '-HoldSeconds',
                '30'
            ) `
            -PassThru `
            -WindowStyle Hidden `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath
        $holderProcessId = [int]$holder.Id
        $holderStartTimeUtcTicks =
            [long]$holder.StartTime.ToUniversalTime().Ticks
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        while (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) {
            $holder.Refresh()
            if ($holder.HasExited) {
                $childStdout = Read-MutexHolderDiagnostic -Path $stdoutPath
                $childStderr = Read-MutexHolderDiagnostic -Path $stderrPath
                throw (
                    'The mutex holder fixture exited before readiness ' +
                    "(pid=$holderProcessId; " +
                    "startTicks=$holderStartTimeUtcTicks; " +
                    "exitCode=$($holder.ExitCode); " +
                    "stdout='$childStdout'; stderr='$childStderr')."
                )
            }
            if ([DateTime]::UtcNow -ge $deadline) {
                $childStdout = Read-MutexHolderDiagnostic -Path $stdoutPath
                $childStderr = Read-MutexHolderDiagnostic -Path $stderrPath
                throw (
                    'Timed out waiting for the mutex holder fixture ' +
                    "(pid=$holderProcessId; " +
                    "startTicks=$holderStartTimeUtcTicks; " +
                    "stdout='$childStdout'; stderr='$childStderr')."
                )
            }
            Start-Sleep -Milliseconds 50
        }
        $readyState = [System.IO.File]::ReadAllText($readyPath)
        $holder.Refresh()
        if ($readyState -cne 'ready' -or $holder.HasExited -or
            [int]$holder.Id -ne $holderProcessId -or
            [long]$holder.StartTime.ToUniversalTime().Ticks -ne
                $holderStartTimeUtcTicks) {
            throw (
                'The mutex holder readiness did not belong to the expected ' +
                "live process (pid=$holderProcessId; " +
                "startTicks=$holderStartTimeUtcTicks; ready='$readyState')."
            )
        }
        try {
            $mutex = Enter-DeferredHandoffWorkerMutex `
                -DataDir $dataDir `
                -TimeoutMilliseconds 10
            $mutex.ReleaseMutex()
            $mutex.Dispose()
            $result = [pscustomobject]@{
                IsValid = $true
                Reason = 'unexpectedly-acquired'
                MutexName = $mutexName
                HolderProcessId = $holderProcessId
                HolderStartTimeUtcTicks = $holderStartTimeUtcTicks
                ReadyState = $readyState
            }
        } catch {
            $result = [pscustomobject]@{
                IsValid = $false
                Reason = $_.Exception.Message
                MutexName = $mutexName
                HolderProcessId = $holderProcessId
                HolderStartTimeUtcTicks = $holderStartTimeUtcTicks
                ReadyState = $readyState
            }
        }
    } finally {
        if ($null -ne $holder) {
            $holder.Refresh()
            if (-not $holder.HasExited) {
                try {
                    $holder.Kill($true)
                    $null = $holder.WaitForExit(5000)
                } catch {
                    # The exact fixture child may have exited during cleanup.
                }
            }
            $holder.Dispose()
        }
        foreach ($path in @($readyPath, $stdoutPath, $stderrPath)) {
            Remove-Item `
                -LiteralPath $path `
                -Force `
                -ErrorAction SilentlyContinue
        }
    }
} elseif ($Mode -in @(
    'matching-desired-intent',
    'native-desired-intent',
    'superseded-desired-intent',
    'wrong-desired-runtime'
)) {
    $expectedVersionId = 'a' * 64
    $expectedRoot = 'C:\Runtime\expected'
    $expectedIntentId = '1' * 32
    $desiredMode = [pscustomobject]@{
        Mode = if ($Mode -ceq 'native-desired-intent') {
            'Native'
        } else {
            'Remote'
        }
        IntentId = if ($Mode -ceq 'superseded-desired-intent') {
            '2' * 32
        } else {
            $expectedIntentId
        }
        RuntimeVersionId = if ($Mode -ceq 'wrong-desired-runtime') {
            'b' * 64
        } else {
            $expectedVersionId
        }
        RuntimeRoot = $expectedRoot
    }
    $result = [pscustomobject]@{
        IsValid = Test-DeferredHandoffDesiredModeIntent `
            -DesiredMode $desiredMode `
            -ExpectedIntentId $expectedIntentId `
            -ExpectedVersionId $expectedVersionId `
            -ExpectedRoot $expectedRoot
        Reason = $Mode
    }
} else {
    $expectedVersionId = 'a' * 64
    $expectedRoot = 'C:\Runtime\expected'
    $baselineTime = [DateTimeOffset]::UtcNow.AddMinutes(-2)
    $launchStartedAt = [DateTimeOffset]::UtcNow.AddMinutes(-1)
    $baselineCorrelationId = '1' * 32
    $expectedCorrelationId = '2' * 32
    $newCorrelationId = if ($Mode -ceq 'foreign-fresh-receipt') {
        '3' * 32
    } else {
        $expectedCorrelationId
    }
    $currentVersionId = if ($Mode -ceq 'wrong-generation') {
        'b' * 64
    } else {
        $expectedVersionId
    }
    $result = Test-DeferredHandoffVerificationCandidate `
        -CurrentRuntime ([pscustomobject]@{
            CurrentVersionId = $currentVersionId
            CurrentRoot = $expectedRoot
        }) `
        -BrokerReceipt ([pscustomobject]@{
            BrokerCliPath = Join-Path `
                $expectedRoot `
                'apps\broker\dist\cli.js'
        }) `
        -LaunchReceipt ([pscustomobject]@{
            Signature = 'codex-local-remote/desktop-launch/v2'
            Version = 2
            RemoteEnabled = $true
            CorrelationId = $newCorrelationId
            RecordedAtUtc = $launchStartedAt.AddSeconds(1).ToString('o')
        }) `
        -ExpectedVersionId $expectedVersionId `
        -ExpectedRoot $expectedRoot `
        -LaunchStartedAt $launchStartedAt `
        -ExpectedCorrelationId $expectedCorrelationId `
        -Baseline ([pscustomobject]@{
            IsValid = $true
            CorrelationId = $baselineCorrelationId
            RecordedAtUtc = $baselineTime
        })
}

$result | ConvertTo-Json -Compress
