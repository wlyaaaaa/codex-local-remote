[CmdletBinding()]
param(
    [string]$InstallRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [Parameter(Mandatory)][string]$RollbackRoot,
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexLocalRemote'),
    [string]$TaskName = 'Codex Local Remote',
    [string]$DesktopAumid = 'OpenAI.Codex_2p2nqsd0c76g0!App',
    [string]$NodePath,
    [string]$CodexPath,
    [string]$RuntimeCodexPath,
    [string]$PwshPath,
    [string]$TailscalePath,
    [int]$SidecarPort = 18790,
    [int]$BrokerPort = 18791,
    [int]$UpstreamPort = 18792,
    [string]$BasePath = '/codex-remote',
    [switch]$PreflightOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$resolvedMigrationRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$mutexBytes = [System.Text.Encoding]::UTF8.GetBytes(
    $resolvedMigrationRoot.ToUpperInvariant()
)
try {
    $mutexSuffix = [Convert]::ToHexString(
        [System.Security.Cryptography.SHA256]::HashData($mutexBytes)
    ).Substring(0, 24)
} finally {
    [Array]::Clear($mutexBytes, 0, $mutexBytes.Length)
}
$script:migrationMutex = [System.Threading.Mutex]::new(
    $false,
    "Local\CodexLocalRemoteMigration-$mutexSuffix"
)
$script:migrationMutexAcquired = $false
try {
    $script:migrationMutexAcquired = $script:migrationMutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
    $script:migrationMutexAcquired = $true
}
if (-not $script:migrationMutexAcquired) {
    $script:migrationMutex.Dispose()
    throw "Another migration already owns the exclusive lock for '$resolvedMigrationRoot'."
}

function Exit-MigrationMutex {
    if ($script:migrationMutexAcquired) {
        $script:migrationMutex.ReleaseMutex()
        $script:migrationMutexAcquired = $false
    }
    if ($null -ne $script:migrationMutex) {
        $script:migrationMutex.Dispose()
        $script:migrationMutex = $null
    }
}

$runId = (
    [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') +
    "-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
)
$evidenceDir = Join-Path $InstallRoot ".local\migration-$runId"
$logPath = Join-Path $evidenceDir 'migration.log'
$resultPath = Join-Path $InstallRoot '.local\migration-result.json'
$null = New-Item -ItemType Directory -Path $evidenceDir -Force
[System.IO.File]::WriteAllText(
    $resultPath,
    (([ordered]@{
        Status = 'in-progress'
        RunId = $runId
        EvidenceDir = $evidenceDir
        RecordedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    } | ConvertTo-Json -Depth 10) + [Environment]::NewLine),
    [System.Text.UTF8Encoding]::new($false)
)
$v2StartupNotBeforeUtc = [DateTimeOffset]::MinValue

function Protect-LogText {
    param([AllowNull()][object]$Value)
    $text = [string]$Value
    $text = [regex]::Replace($text, '/ws/[A-Za-z0-9_-]+', '/ws/<redacted>')
    $text = [regex]::Replace(
        $text,
        '(?i)([?&](?:access_)?token=)[^&\s]+',
        '$1<redacted>'
    )
    return [regex]::Replace(
        $text,
        '(?i)\bBearer\s+[A-Za-z0-9._~-]+',
        'Bearer <redacted>'
    )
}

function ConvertTo-RedactedEvidenceObject {
    param(
        [AllowNull()][object]$Value,
        [AllowEmptyString()][string]$PropertyName = ''
    )
    if ($null -eq $Value) {
        return $null
    }
    if ($Value -is [bool] -or
        $Value -is [byte] -or
        $Value -is [sbyte] -or
        $Value -is [int16] -or
        $Value -is [uint16] -or
        $Value -is [int32] -or
        $Value -is [uint32] -or
        $Value -is [int64] -or
        $Value -is [uint64] -or
        $Value -is [single] -or
        $Value -is [double] -or
        $Value -is [decimal] -or
        $Value -is [datetime] -or
        $Value -is [datetimeoffset] -or
        $Value -is [guid] -or
        $Value.GetType().IsEnum) {
        return $Value
    }
    if ($Value -is [string]) {
        if ($PropertyName -match '(?i)(endpoint|token|secret|password|credential|authorization|cookie)') {
            return '<redacted>'
        }
        return Protect-LogText $Value
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $result = [ordered]@{}
        foreach ($key in $Value.Keys) {
            $name = [string]$key
            $result[$name] = ConvertTo-RedactedEvidenceObject `
                -Value $Value[$key] `
                -PropertyName $name
        }
        return $result
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        return @(
            foreach ($item in $Value) {
                ConvertTo-RedactedEvidenceObject -Value $item
            }
        )
    }

    $result = [ordered]@{}
    foreach ($property in $Value.PSObject.Properties) {
        $result[$property.Name] = ConvertTo-RedactedEvidenceObject `
            -Value $property.Value `
            -PropertyName $property.Name
    }
    return $result
}

function Write-Step {
    param([Parameter(Mandatory)][string]$Message)
    $line = "[$([DateTimeOffset]::UtcNow.ToString('o'))] $(Protect-LogText $Message)"
    Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][object]$Value
    )
    $json = $Value | ConvertTo-Json -Depth 30
    [System.IO.File]::WriteAllText(
        $Path,
        $json + [Environment]::NewLine,
        [System.Text.UTF8Encoding]::new($false)
    )
}

function Wait-Until {
    param(
        [Parameter(Mandatory)][scriptblock]$Condition,
        [Parameter(Mandatory)][int]$TimeoutSeconds,
        [string]$FailureMessage = 'Timed out waiting for the expected state.'
    )
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 500
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw $FailureMessage
}

function Resolve-ExecutablePath {
    param(
        [AllowEmptyString()][string]$ProvidedPath,
        [Parameter(Mandatory)][string]$CommandName
    )
    if (-not [string]::IsNullOrWhiteSpace($ProvidedPath)) {
        if (-not (Test-Path -LiteralPath $ProvidedPath -PathType Leaf)) {
            throw "Executable path does not exist: $ProvidedPath"
        }
        return (Resolve-Path -LiteralPath $ProvidedPath).Path
    }
    return (Get-Command $CommandName -CommandType Application -ErrorAction Stop |
        Select-Object -First 1).Source
}

function Get-Listener {
    param([Parameter(Mandatory)][int]$Port)
    return @(
        Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    )
}

function Stop-ExactKnownSidecar {
    param(
        [ValidateRange(1, 100)][int]$MaximumSnapshots = 20,
        [ValidateRange(0, 5000)][int]$RetryDelayMilliseconds = 100,
        [scriptblock]$GetListenerAction = {
            param([int]$Port)
            return @(Get-Listener -Port $Port)
        },
        [scriptblock]$GetProcessAction = {
            param([int]$OwnerProcessId)
            return @(
                Get-CimInstance `
                    Win32_Process `
                    -Filter "ProcessId = $OwnerProcessId" `
                    -ErrorAction SilentlyContinue
            )
        },
        [scriptblock]$SleepAction = {
            param([int]$Milliseconds)
            Start-Sleep -Milliseconds $Milliseconds
        },
        [scriptblock]$StopKnownSidecarAction = {
            param(
                [string]$ExpectedSidecarCliPath,
                [int]$OwnerProcessId
            )
            return & (Join-Path $InstallRoot 'scripts\windows\Stop-CodexLocalRemoteSidecar.ps1') `
                -NodePath $nodePath `
                -ExpectedSidecarCliPath $ExpectedSidecarCliPath `
                -DataDir $DataDir `
                -Port $SidecarPort `
                -BasePath $BasePath `
                -ExpectedProcessId $OwnerProcessId `
                -Confirm:$false
        }
    )

    $lastObservation = 'no listener snapshot captured'
    for ($snapshotNumber = 1; $snapshotNumber -le $MaximumSnapshots; $snapshotNumber++) {
        $listeners = @(& $GetListenerAction $SidecarPort)
        $addresses = @($listeners | Select-Object -ExpandProperty LocalAddress -Unique)
        $ownerProcessIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
        $lastObservation = (
            "snapshot=$snapshotNumber; listenerCount=$($listeners.Count); " +
            "addresses=$($addresses -join ','); ownerPids=$($ownerProcessIds -join ',')"
        )

        if ($listeners.Count -eq 0) {
            return
        }
        if ($listeners.Count -ne 1 -or
            $addresses.Count -ne 1 -or
            [string]$addresses[0] -cne '127.0.0.1' -or
            $ownerProcessIds.Count -ne 1) {
            throw (
                "TCP port $SidecarPort failed the exclusive loopback listener gate " +
                "($lastObservation); refusing migration cleanup."
            )
        }

        $ownerProcessId = [int]$ownerProcessIds[0]
        $processes = @(
            & $GetProcessAction $ownerProcessId |
                Where-Object { $null -ne $_ }
        )
        if ($processes.Count -eq 0) {
            $lastObservation += '; ownerProcessState=disappeared'
            if ($snapshotNumber -lt $MaximumSnapshots) {
                Write-Step (
                    "TCP port $SidecarPort listener owner PID $ownerProcessId disappeared " +
                    "after snapshot $snapshotNumber; retrying from a fresh listener snapshot."
                )
                & $SleepAction $RetryDelayMilliseconds
            } else {
                Write-Step (
                    "TCP port $SidecarPort listener owner PID $ownerProcessId disappeared " +
                    "after final snapshot $snapshotNumber; retry budget exhausted."
                )
            }
            continue
        }
        if ($processes.Count -ne 1 -or
            [int]$processes[0].ProcessId -ne $ownerProcessId) {
            throw (
                "TCP port $SidecarPort process lookup did not return exactly PID " +
                "$ownerProcessId ($lastObservation); refusing migration cleanup."
            )
        }
        $process = $processes[0]

        $matches = [System.Collections.Generic.List[string]]::new()
        foreach ($root in @($InstallRoot, $RollbackRoot)) {
            $candidateCli = [System.IO.Path]::GetFullPath(
                (Join-Path $root 'apps\sidecar\dist\cli.js')
            )
            $ownership = Test-ManagedSidecarProcess `
                -CommandLine ([string]$process.CommandLine) `
                -ExecutablePath ([string]$process.ExecutablePath) `
                -ExpectedNodePath $nodePath `
                -ExpectedSidecarCliPath $candidateCli `
                -Port $SidecarPort `
                -BasePath $BasePath `
                -DataDir $DataDir
            if ($ownership.IsManaged) {
                $matches.Add($candidateCli)
            }
        }
        if ($matches.Count -ne 1) {
            throw (
                "TCP port $SidecarPort owner PID $ownerProcessId is not exactly one " +
                "known V1/V2 Sidecar (knownMatches=$($matches.Count); $lastObservation); " +
                'refusing migration cleanup.'
            )
        }

        Write-Step "Stopping exact known Sidecar PID $ownerProcessId before migration."
        $stopResults = @(& $StopKnownSidecarAction $matches[0] $ownerProcessId)
        $stopResult = @($stopResults | Select-Object -Last 1)
        $acceptedStopStatuses = @('stopped', 'not-found', 'already-stopped')
        if ($stopResult.Count -ne 1 -or
            [string]$stopResult[0].Status -notin $acceptedStopStatuses) {
            $status = if ($stopResult.Count -eq 1) {
                [string]$stopResult[0].Status
            } else {
                'missing'
            }
            throw "Exact known Sidecar cleanup returned status '$status'."
        }

        if ($snapshotNumber -lt $MaximumSnapshots) {
            & $SleepAction $RetryDelayMilliseconds
        }
    }

    throw (
        "TCP port $SidecarPort did not reach a verified empty state after " +
        "$MaximumSnapshots fresh snapshots (last: $lastObservation); " +
        'refusing migration cleanup.'
    )
}

function Get-FunnelSnapshot {
    $snapshot = (& $tailscalePath funnel status --json) | ConvertFrom-Json -Depth 30
    $webProperty = @($snapshot.Web.PSObject.Properties)
    if ($webProperty.Count -ne 1) {
        throw 'Expected exactly one Tailscale Funnel web host.'
    }
    $handlers = $webProperty[0].Value.Handlers
    $rootHandler = $handlers.PSObject.Properties['/']
    $remoteHandler = $handlers.PSObject.Properties[$BasePath]
    if ($null -eq $rootHandler -or $null -eq $remoteHandler) {
        throw 'Expected both bounded Funnel handlers before migration.'
    }
    return [pscustomobject]@{
        Host = [string]$webProperty[0].Name
        RootProxy = [string]$rootHandler.Value.Proxy
        RemoteProxy = [string]$remoteHandler.Value.Proxy
        CanonicalWeb = ConvertTo-CanonicalJson -InputObject $snapshot.Web
    }
}

function Get-ProcessFingerprint {
    param([Parameter(Mandatory)][int]$ProcessId)
    $processes = @(
        Get-CimInstance `
            Win32_Process `
            -Filter "ProcessId = $ProcessId" `
            -ErrorAction SilentlyContinue
    )
    if ($processes.Count -ne 1) {
        throw "Expected one process metadata record for PID $ProcessId."
    }
    return [pscustomobject]@{
        ProcessId = $ProcessId
        CreationDate = [string]$processes[0].CreationDate
        ExecutablePathSha256 = Get-StringSha256 -Value ([string]$processes[0].ExecutablePath)
        CommandLineSha256 = Get-StringSha256 -Value ([string]$processes[0].CommandLine)
    }
}

function Get-CodexDesktopProcesses {
    return @(
        Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" -ErrorAction SilentlyContinue |
            Where-Object { [string]$_.CommandLine -match '\\WindowsApps\\OpenAI\.Codex_' }
    )
}

function Get-IndependentDesktopAppServers {
    $result = [System.Collections.Generic.List[object]]::new()
    foreach ($candidate in @(
        Get-CimInstance Win32_Process -Filter "Name = 'codex.exe'" -ErrorAction SilentlyContinue
    )) {
        $parent = Get-CimInstance `
            Win32_Process `
            -Filter "ProcessId = $([int]$candidate.ParentProcessId)" `
            -ErrorAction SilentlyContinue
        if (Test-IndependentDesktopAppServer `
            -CommandLine ([string]$candidate.CommandLine) `
            -ParentProcessName ([string]$parent.Name)) {
            $result.Add($candidate)
        }
    }
    return @($result)
}

function Get-ProcessTreeSnapshot {
    param([Parameter(Mandatory)][int]$RootProcessId)
    if ($RootProcessId -le 0) { return @() }
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $pending = [System.Collections.Generic.Queue[int]]::new()
    $pending.Enqueue($RootProcessId)
    $seen = [System.Collections.Generic.HashSet[int]]::new()
    $result = [System.Collections.Generic.List[object]]::new()
    while ($pending.Count -gt 0) {
        $processId = $pending.Dequeue()
        if (-not $seen.Add($processId)) { continue }
        $process = @($all | Where-Object { [int]$_.ProcessId -eq $processId } | Select-Object -First 1)
        if ($process.Count -eq 1) {
            $result.Add([pscustomobject]@{
                ProcessId = [int]$process[0].ProcessId
                CreationDate = [string]$process[0].CreationDate
                Name = [string]$process[0].Name
                CommandLine = [string]$process[0].CommandLine
            })
        }
        foreach ($child in @($all | Where-Object { [int]$_.ParentProcessId -eq $processId })) {
            $pending.Enqueue([int]$child.ProcessId)
        }
    }
    return @($result)
}

function Test-SnapshotProcessAlive {
    param([Parameter(Mandatory)][object]$Snapshot)
    $current = @(Get-CimInstance Win32_Process `
        -Filter "ProcessId = $([int]$Snapshot.ProcessId)" `
        -ErrorAction SilentlyContinue)
    return (
        $current.Count -eq 1 -and
        [string]$current[0].CreationDate -ceq [string]$Snapshot.CreationDate -and
        [string]$current[0].Name -ceq [string]$Snapshot.Name -and
        [string]$current[0].CommandLine -ceq [string]$Snapshot.CommandLine
    )
}

function Stop-CodexDesktopExact {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
    $quietSince = $null
    do {
        $independent = @(Get-IndependentDesktopAppServers)
        $processes = @(Get-CodexDesktopProcesses)
        if ($independent.Count -gt 0 -or $processes.Count -gt 0) {
            Write-Step "Closing $($processes.Count) exact Codex Desktop process(es) and $($independent.Count) independent app-server(s)."
            foreach ($process in $independent) {
                Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
            }
            foreach ($process in $processes) {
                Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
            }
            $quietSince = $null
        } elseif ($null -eq $quietSince) {
            $quietSince = [DateTimeOffset]::UtcNow
        } elseif (([DateTimeOffset]::UtcNow - $quietSince).TotalSeconds -ge 7) {
            return
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw 'Codex Desktop did not remain stopped for a seven-second quiet period.'
}

function Start-CodexDesktop {
    param([switch]$SharedBroker)
    if (-not $SharedBroker) {
        Write-Step 'Launching Codex Desktop through its AUMID.'
        Start-Process -FilePath explorer.exe -ArgumentList "shell:AppsFolder\$DesktopAumid"
        return
    }

    Write-Step 'Launching Codex Desktop directly with the shared Broker environment.'
    $previousEndpoint = $env:CODEX_APP_SERVER_WS_URL
    $capabilityTokenPath = Get-BrokerCapabilityTokenPath -DataDir $DataDir
    $env:CODEX_APP_SERVER_WS_URL = Get-BrokerCapabilityWebSocketUrl `
        -Port $BrokerPort `
        -TokenPath $capabilityTokenPath
    try {
        Start-Process -FilePath $desktopExecutablePath
    } finally {
        if ($null -eq $previousEndpoint) {
            Remove-Item Env:CODEX_APP_SERVER_WS_URL -ErrorAction SilentlyContinue
        } else {
            $env:CODEX_APP_SERVER_WS_URL = $previousEndpoint
        }
    }
}

function Get-BrokerHealth {
    try {
        return Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:$BrokerPort/ready" -TimeoutSec 2
    } catch {
        return $null
    }
}

function Test-StartupDiagnosticFresh {
    param(
        [AllowNull()][object]$Status,
        [Parameter(Mandatory)][DateTimeOffset]$NotBeforeUtc
    )
    if ($null -eq $Status -or
        [string]$Status.Signature -cne 'codex-local-remote/startup-status/v3' -or
        [int]$Status.Version -ne 3 -or
        [string]$Status.BootstrapInvocationId -cnotmatch '^[a-f0-9]{32}$' -or
        ($null -ne $Status.RuntimeInvocationId -and
            [string]$Status.RuntimeInvocationId -cnotmatch '^[a-f0-9]{32}$')) {
        return $false
    }
    $recordedAt = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse(
        [string]$Status.RecordedAtUtc,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$recordedAt
    )) {
        return $false
    }
    return $recordedAt -ge $NotBeforeUtc
}

function Get-FreshStartupDiagnostic {
    $path = Join-Path $DataDir 'startup-last.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return $null
    }
    $status = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -Depth 10
    if (-not (Test-StartupDiagnosticFresh `
        -Status $status `
        -NotBeforeUtc $script:v2StartupNotBeforeUtc)) {
        return $null
    }
    return $status
}

function Get-StartupDiagnosticSummary {
    try {
        $status = Get-FreshStartupDiagnostic
        if ($null -eq $status) {
            return 'fresh startup diagnostic unavailable'
        }
        return "stage=$([string]$status.Stage); status=$([string]$status.Status); message=$([string]$status.Message)"
    } catch {
        return 'fresh startup diagnostic unreadable'
    }
}

function Copy-StartupDiagnosticEvidence {
    $path = Join-Path $DataDir 'startup-last.json'
    $status = Get-FreshStartupDiagnostic
    if ($null -ne $status) {
        Copy-Item -LiteralPath $path -Destination (Join-Path $evidenceDir 'startup-last.json') -Force
    }
}

function Assert-FunnelUnchanged {
    param(
        [Parameter(Mandatory)][object]$Before,
        [Parameter(Mandatory)][object]$RootOwnerFingerprint
    )
    $after = Get-FunnelSnapshot
    if ($after.Host -cne $Before.Host -or
        $after.CanonicalWeb -cne $Before.CanonicalWeb) {
        throw 'Tailscale Funnel handlers changed during migration.'
    }
    $rootListeners = @(Get-Listener -Port 18789)
    if ($rootListeners.Count -ne 1 -or
        [int]$rootListeners[0].OwningProcess -ne [int]$RootOwnerFingerprint.ProcessId -or
        [string]$rootListeners[0].LocalAddress -cne '127.0.0.1') {
        throw 'The unrelated root listener on 18789 changed during migration.'
    }
    $afterFingerprint = Get-ProcessFingerprint `
        -ProcessId ([int]$RootOwnerFingerprint.ProcessId)
    if ($afterFingerprint.CreationDate -cne $RootOwnerFingerprint.CreationDate -or
        $afterFingerprint.ExecutablePathSha256 -cne $RootOwnerFingerprint.ExecutablePathSha256 -or
        $afterFingerprint.CommandLineSha256 -cne $RootOwnerFingerprint.CommandLineSha256) {
        throw 'The unrelated root listener process identity changed during migration.'
    }
}

function Invoke-RegisterV2 {
    & $pwshPath -NoProfile -File (Join-Path $InstallRoot 'scripts\windows\Register-CodexLocalRemoteStartup.ps1') `
        -InstallRoot $InstallRoot `
        -DataDir $DataDir `
        -NodePath $nodePath `
        -PwshPath $pwshPath `
        -Port $SidecarPort `
        -BrokerPort $BrokerPort `
        -BrokerUpstreamPort $UpstreamPort `
        -BasePath $BasePath `
        -TaskName $TaskName `
        -NoStart | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "V2 registration failed with exit code $LASTEXITCODE." }
}

function Invoke-UnregisterV2 {
    & $pwshPath -NoProfile -File (Join-Path $InstallRoot 'scripts\windows\Unregister-CodexLocalRemoteStartup.ps1') `
        -InstallRoot $InstallRoot `
        -DataDir $DataDir `
        -NodePath $nodePath `
        -PwshPath $pwshPath `
        -Port $SidecarPort `
        -BrokerPort $BrokerPort `
        -BrokerUpstreamPort $UpstreamPort `
        -BasePath $BasePath `
        -TaskName $TaskName `
        -Confirm:$false | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "V2 removal failed with exit code $LASTEXITCODE." }
}

function Get-TaskXmlSha256 {
    param([Parameter(Mandatory)][string]$Xml)
    $document = [System.Xml.XmlDocument]::new()
    $document.PreserveWhitespace = $false
    $document.LoadXml($Xml)
    return Get-StringSha256 -Value $document.OuterXml
}

function Get-LegacyTaskDefinitionForRoot {
    param([Parameter(Mandatory)][string]$Root)
    return Get-LegacyStartupTaskDefinition `
        -TaskName $TaskName `
        -NodePath $nodePath `
        -InstallRoot $Root `
        -DataDir $DataDir `
        -Port $SidecarPort `
        -BasePath $BasePath
}

function Assert-ExactLegacyTask {
    $task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        throw "The exact legacy task '$TaskName' is missing."
    }
    foreach ($root in @($InstallRoot, $RollbackRoot)) {
        $expected = Get-LegacyTaskDefinitionForRoot -Root $root
        $ownership = Test-ManagedStartupTask -Task $task -Expected $expected
        if ($ownership.IsManaged) {
            return [pscustomobject]@{
                Task = $task
                Root = $root
            }
        }
    }
    throw "The task '$TaskName' is not either exact legacy task; refusing migration."
}

function Start-OrRestoreOriginalV1Task {
    param(
        [scriptblock]$GetTaskAction = {
            Get-ScheduledTask `
                -TaskName $TaskName `
                -TaskPath '\' `
                -ErrorAction SilentlyContinue
        },
        [scriptblock]$RegisterTaskXmlAction = {
            param([string]$Xml)
            Register-ScheduledTask `
                -TaskName $TaskName `
                -TaskPath '\' `
                -Xml $Xml `
                -ErrorAction Stop | Out-Null
        },
        [scriptblock]$AssertLegacyTaskAction = {
            Assert-ExactLegacyTask
        },
        [scriptblock]$ExportTaskXmlAction = {
            Export-ScheduledTask `
                -TaskName $TaskName `
                -TaskPath '\' `
                -ErrorAction Stop
        },
        [scriptblock]$StartTaskAction = {
            Start-ScheduledTask -TaskName $TaskName -TaskPath '\'
        }
    )

    $task = & $GetTaskAction
    if ($null -eq $task) {
        & $RegisterTaskXmlAction $script:originalTaskXml
    }

    $restored = & $AssertLegacyTaskAction
    if ([string]$restored.Root -cne [string]$script:originalLegacyRoot) {
        throw "The task '$TaskName' does not use the original legacy root after rollback."
    }
    $restoredXml = & $ExportTaskXmlAction
    if ((Get-TaskXmlSha256 -Xml $restoredXml) -cne $script:originalTaskXmlSha256) {
        throw "The task '$TaskName' was not restored to the exact original XML definition."
    }
    & $StartTaskAction
}

function Test-ExactOriginalV1Runtime {
    try {
        $listeners = @(Get-Listener -Port $SidecarPort)
        if ($listeners.Count -ne 1 -or
            [string]$listeners[0].LocalAddress -cne '127.0.0.1') {
            return $false
        }
        $processes = @(
            Get-CimInstance `
                Win32_Process `
                -Filter "ProcessId = $([int]$listeners[0].OwningProcess)" `
                -ErrorAction SilentlyContinue
        )
        if ($processes.Count -ne 1) {
            return $false
        }
        $expectedCli = Join-Path $script:originalLegacyRoot 'apps\sidecar\dist\cli.js'
        $ownership = Test-ManagedSidecarProcess `
            -CommandLine ([string]$processes[0].CommandLine) `
            -ExecutablePath ([string]$processes[0].ExecutablePath) `
            -ExpectedNodePath $nodePath `
            -ExpectedSidecarCliPath $expectedCli `
            -Port $SidecarPort `
            -BasePath $BasePath `
            -DataDir $DataDir
        return [bool]$ownership.IsManaged
    } catch {
        return $false
    }
}

function Get-V2Status {
    $statusJson = & $pwshPath -NoProfile -File (Join-Path $InstallRoot 'scripts\windows\Get-CodexLocalRemoteStatus.ps1') `
        -InstallRoot $InstallRoot `
        -DataDir $DataDir `
        -NodePath $nodePath `
        -PwshPath $pwshPath `
        -Port $SidecarPort `
        -BrokerPort $BrokerPort `
        -BrokerUpstreamPort $UpstreamPort `
        -BasePath $BasePath `
        -TaskName $TaskName `
        -Json
    if ($LASTEXITCODE -ne 0) { throw "V2 status failed with exit code $LASTEXITCODE." }
    return (($statusJson -join [Environment]::NewLine) | ConvertFrom-Json -Depth 30)
}

function Wait-V2ReadyStatus {
    param(
        [ValidateRange(0, 300)][int]$TimeoutSeconds = 30,
        [ValidateRange(0, 5000)][int]$PollMilliseconds = 500,
        [scriptblock]$GetStatusAction = {
            return Get-V2Status
        },
        [scriptblock]$SleepAction = {
            param([int]$Milliseconds)
            Start-Sleep -Milliseconds $Milliseconds
        }
    )

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $lastStatus = & $GetStatusAction
        if ($null -eq $lastStatus) {
            throw 'V2 status polling returned no status object.'
        }
        if ($lastStatus.Ready -ceq $true -and
            $lastStatus.RuntimeReceiptReady -ceq $true -and
            $lastStatus.LauncherScriptReady -ceq $true -and
            $lastStatus.LauncherShortcutReady -ceq $true -and
            $lastStatus.LauncherConfigured -ceq $true -and
            $lastStatus.LaunchMode -ceq 'process-scoped-fail-open' -and
            $lastStatus.LegacyPersistentOverrideBlocked -cne $true -and
            $lastStatus.LegacyEnvironmentState -ceq 'none') {
            return $lastStatus
        }
        if ([DateTimeOffset]::UtcNow -ge $deadline) {
            return $lastStatus
        }
        & $SleepAction $PollMilliseconds
    } while ($true)
}

function Get-V2ReadyGateSummary {
    param([Parameter(Mandatory)][object]$Status)

    $gates = [ordered]@{
        ready = ([bool]$Status.Ready)
        taskOwned = ([bool]$Status.TaskOwned)
        taskRunning = ([bool]$Status.TaskRunning)
        taskReady = ([bool]$Status.TaskReady)
        loopbackListener = ([bool]$Status.LoopbackListener)
        productMatch = ([string]$Status.Product -ceq 'Codex Local Remote')
        publicRouteConfigured = ([string]$Status.PublicRoute -ceq 'configured')
        brokerReady = ([bool]$Status.BrokerReady)
        runtimeReceiptReady = ([bool]$Status.RuntimeReceiptReady)
        sidecarListenerReady = ([bool]$Status.SidecarListenerReady)
        sidecarOwned = ([bool]$Status.SidecarOwned)
        desktopConnected = ([bool]$Status.DesktopConnected)
        sidecarConnected = ([bool]$Status.SidecarConnected)
        degraded = ([bool]$Status.Degraded)
        unknownCount = [int]$Status.UnknownCount
        launcherScriptReady = ([bool]$Status.LauncherScriptReady)
        launcherShortcutReady = ([bool]$Status.LauncherShortcutReady)
        launcherConfigured = ([bool]$Status.LauncherConfigured)
        launchMode = [string]$Status.LaunchMode
        legacyPersistentOverrideBlocked = (
            [bool]$Status.LegacyPersistentOverrideBlocked
        )
        legacyEnvironmentState = [string]$Status.LegacyEnvironmentState
        forceCliBlocked = ([bool]$Status.ForceCliBlocked)
        desktopIndependentStdioAppServer = ([bool]$Status.DesktopIndependentStdioAppServer)
    }
    return (@(
        foreach ($gate in $gates.GetEnumerator()) {
            "$($gate.Key)=$($gate.Value)"
        }
    ) -join '; ')
}

$managedPorts = @($SidecarPort, $BrokerPort, $UpstreamPort)
if (@($managedPorts | Sort-Object -Unique).Count -ne $managedPorts.Count -or
    $managedPorts -contains 18789) {
    throw 'Sidecar, Broker, and upstream ports must be distinct and must not use reserved port 18789.'
}

Write-Step 'Migration preflight started.'
Import-Module (Join-Path $InstallRoot 'scripts\windows\CodexLocalRemote.Windows.psm1') -Force
$nodePath = Resolve-ExecutablePath -ProvidedPath $NodePath -CommandName 'node.exe'
if ($env:CODEX_REMOTE_TEST_FIXTURE -ceq '1' -and
    -not [string]::IsNullOrWhiteSpace($CodexPath) -and
    -not [string]::IsNullOrWhiteSpace($RuntimeCodexPath)) {
    $codexPath = Resolve-ExecutablePath -ProvidedPath $CodexPath -CommandName 'codex.exe'
    $runtimeCodexPath = Resolve-ExecutablePath `
        -ProvidedPath $RuntimeCodexPath `
        -CommandName 'codex.exe'
    $desktopExecutablePath = Join-Path (
        Split-Path -Parent (Split-Path -Parent $codexPath)
    ) 'ChatGPT.exe'
    $runtimeDiscovery = $null
} else {
    $runtimeDiscovery = Resolve-CodexDesktopRuntime
    $codexPath = [string]$runtimeDiscovery.BundledCodexPath
    $runtimeCodexPath = [string]$runtimeDiscovery.CodexPath
    $desktopExecutablePath = [string]$runtimeDiscovery.DesktopExecutablePath
}
$pwshPath = Resolve-ExecutablePath -ProvidedPath $PwshPath -CommandName 'pwsh.exe'
$tailscalePath = Resolve-ExecutablePath -ProvidedPath $TailscalePath -CommandName 'tailscale.exe'
$dataDirectoryPlan = Get-CodexLocalRemoteDataDirectoryOwnershipPlan -DataDir $DataDir

foreach ($required in @(
    $nodePath,
    $codexPath,
    $runtimeCodexPath,
    $pwshPath,
    $tailscalePath,
    $desktopExecutablePath,
    (Join-Path $InstallRoot 'apps\broker\dist\cli.js'),
    (Join-Path $InstallRoot 'apps\sidecar\dist\cli.js'),
    (Join-Path $RollbackRoot 'apps\sidecar\dist\cli.js')
)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required migration file is missing: $required"
    }
}
$desktopCodexHash = (Get-FileHash -LiteralPath $codexPath -Algorithm SHA256).Hash
$runtimeCodexHash = (Get-FileHash -LiteralPath $runtimeCodexPath -Algorithm SHA256).Hash
if ($desktopCodexHash -cne $runtimeCodexHash) {
    throw 'The executable Desktop-managed Codex runtime does not hash-match the installed Desktop binary.'
}

$funnelBefore = Get-FunnelSnapshot
if ($funnelBefore.RootProxy -cne 'http://127.0.0.1:18789' -or
    $funnelBefore.RemoteProxy -cne "http://127.0.0.1:$SidecarPort$BasePath") {
    throw 'Current Funnel routes do not match the bounded migration contract.'
}
$rootListenersBefore = @(Get-Listener -Port 18789)
if ($rootListenersBefore.Count -ne 1 -or
    [string]$rootListenersBefore[0].LocalAddress -cne '127.0.0.1') {
    throw 'Expected one loopback-only unrelated root listener on 18789.'
}
$rootOwnerPid = [int]$rootListenersBefore[0].OwningProcess
$rootOwnerFingerprint = Get-ProcessFingerprint -ProcessId $rootOwnerPid
$legacyMatch = Assert-ExactLegacyTask
$script:originalLegacyRoot = [string]$legacyMatch.Root

$script:originalTaskXml = Export-ScheduledTask `
    -TaskName $TaskName `
    -TaskPath '\' `
    -ErrorAction Stop
$script:originalTaskXmlSha256 = Get-TaskXmlSha256 -Xml $script:originalTaskXml
[System.IO.File]::WriteAllText(
    (Join-Path $evidenceDir 'task-before.xml'),
    $script:originalTaskXml,
    [System.Text.UTF8Encoding]::new($false)
)
Write-JsonFile -Path (Join-Path $evidenceDir 'funnel-before.json') -Value $funnelBefore

$preflight = [pscustomobject]@{
    Status = 'preflight-pass'
    RunId = $runId
    InstallRoot = $InstallRoot
    RollbackRoot = $RollbackRoot
    NodePath = $nodePath
    DesktopCodexPath = $codexPath
    RuntimeCodexPath = $runtimeCodexPath
    RuntimeCodexHashMatch = $true
    RuntimeDiscoverySource = if ($null -eq $runtimeDiscovery) {
        'test-fixture'
    } else {
        [string]$runtimeDiscovery.Source
    }
    RuntimePackageFullName = if ($null -eq $runtimeDiscovery) {
        'test-fixture'
    } else {
        [string]$runtimeDiscovery.PackageFullName
    }
    PwshPath = $pwshPath
    TailscalePath = $tailscalePath
    DesktopExecutablePath = $desktopExecutablePath
    DataDirectoryAction = [string]$dataDirectoryPlan.Action
    DataDirectoryPath = [string]$dataDirectoryPlan.DataDir
    RootOwnerPid = $rootOwnerPid
    LegacyTaskRoot = [string]$legacyMatch.Root
}
if ($PreflightOnly) {
    Write-JsonFile -Path $resultPath -Value $preflight
    Write-Step 'Preflight-only run completed.'
    Exit-MigrationMutex
    $preflight
    return
}

$v2RegistrationAttempted = $false
$desktopStopped = $false
try {
    Stop-CodexDesktopExact
    $desktopStopped = $true

    Write-Step 'Stopping the legacy scheduled task.'
    $legacyMatch = Assert-ExactLegacyTask
    Stop-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
    Stop-ExactKnownSidecar
    Wait-Until -TimeoutSeconds 10 -FailureMessage 'Exact known Sidecar did not release port 18790.' -Condition {
        @(Get-Listener -Port $SidecarPort).Count -eq 0
    }

    # The public registrar never overwrites an existing task. Re-prove the
    # exact stopped original task and its complete XML, then remove it so V2
    # registration is a collision-failing create rather than a force update.
    $deleteMatch = Assert-ExactLegacyTask
    if ([string]$deleteMatch.Root -cne [string]$script:originalLegacyRoot -or
        [string]$deleteMatch.Task.State -ceq 'Running') {
        throw 'The exact original legacy task changed or remained running before cleanup.'
    }
    $deleteXml = Export-ScheduledTask `
        -TaskName $TaskName `
        -TaskPath '\' `
        -ErrorAction Stop
    if ((Get-TaskXmlSha256 -Xml $deleteXml) -cne $script:originalTaskXmlSha256) {
        throw 'The original legacy task XML changed before cleanup; refusing migration.'
    }
    Write-Step 'Removing the exact stopped original V1 task before V2 registration.'
    Unregister-ScheduledTask `
        -TaskName $TaskName `
        -TaskPath '\' `
        -Confirm:$false `
        -ErrorAction Stop
    if ($null -ne (Get-ScheduledTask `
        -TaskName $TaskName `
        -TaskPath '\' `
        -ErrorAction SilentlyContinue)) {
        throw 'The original legacy task still exists after exact cleanup.'
    }

    Write-Step 'Registering the shared-owner V2 task without starting it.'
    $v2RegistrationAttempted = $true
    Invoke-RegisterV2

    # Full-trust packaged apps may be restarted by Windows several seconds after
    # a forced close. Quiesce that exact app again after registration so its old
    # environment cannot race the shared owner during task startup.
    Stop-CodexDesktopExact

    Write-Step 'Starting the shared Broker, owned app-server, and Sidecar.'
    $startupStatusPath = Join-Path $DataDir 'startup-last.json'
    if (Test-Path -LiteralPath $startupStatusPath -PathType Leaf) {
        Remove-Item -LiteralPath $startupStatusPath -Force
    }
    $v2StartupNotBeforeUtc = [DateTimeOffset]::UtcNow
    $v2PreviousRunTime = (Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath '\').LastRunTime
    Start-ScheduledTask -TaskName $TaskName -TaskPath '\'
    Wait-Until -TimeoutSeconds 45 -FailureMessage 'Shared infrastructure did not become ready before Desktop launch.' -Condition {
        $v2Task = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
        $v2TaskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath '\' -ErrorAction Stop
        if ($v2Task.State -eq 'Ready' -and $v2TaskInfo.LastRunTime -gt $v2PreviousRunTime) {
            throw "Shared startup task exited before readiness (result=$($v2TaskInfo.LastTaskResult); $(Get-StartupDiagnosticSummary))."
        }
        $health = Get-BrokerHealth
        $null -ne $health -and
        $health.appServerReady -ceq $true -and
        $health.sidecarConnected -ceq $true -and
        $health.degraded -ceq $false
    }

    Assert-FunnelUnchanged `
        -Before $funnelBefore `
        -RootOwnerFingerprint $rootOwnerFingerprint
    # Remove any late package auto-restart, then launch the full-trust desktop
    # executable from a process that already carries the capability endpoint.
    Stop-CodexDesktopExact
    Start-CodexDesktop -SharedBroker

    Wait-Until -TimeoutSeconds 75 -FailureMessage 'Codex Desktop did not attach to the shared Broker.' -Condition {
        $health = Get-BrokerHealth
        $null -ne $health -and
        $health.appServerReady -ceq $true -and
        $health.desktopConnected -ceq $true -and
        $health.sidecarConnected -ceq $true -and
        $health.degraded -ceq $false
    }

    $status = Wait-V2ReadyStatus -TimeoutSeconds 30 -PollMilliseconds 500
    $statusEvidence = ConvertTo-RedactedEvidenceObject -Value $status
    Write-JsonFile `
        -Path (Join-Path $evidenceDir 'v2-final-status.json') `
        -Value $statusEvidence
    if ($status.Ready -cne $true -or
        $status.RuntimeReceiptReady -cne $true -or
        $status.LauncherScriptReady -cne $true -or
        $status.LauncherShortcutReady -cne $true -or
        $status.LauncherConfigured -cne $true -or
        $status.LaunchMode -cne 'process-scoped-fail-open' -or
        $status.LegacyPersistentOverrideBlocked -ceq $true -or
        $status.LegacyEnvironmentState -cne 'none') {
        throw (
            'The final V2 status did not reach Ready within 30 seconds; ' +
            "gates: $(Get-V2ReadyGateSummary -Status $status)."
        )
    }
    Assert-FunnelUnchanged `
        -Before $funnelBefore `
        -RootOwnerFingerprint $rootOwnerFingerprint

    $result = [pscustomobject]@{
        Status = 'success'
        RunId = $runId
        Ready = [bool]$status.Ready
        RuntimeReceiptReady = [bool]$status.RuntimeReceiptReady
        TaskReady = [bool]$status.TaskReady
        LauncherScriptReady = [bool]$status.LauncherScriptReady
        LauncherShortcutReady = [bool]$status.LauncherShortcutReady
        LauncherConfigured = [bool]$status.LauncherConfigured
        LaunchMode = [string]$status.LaunchMode
        LegacyPersistentOverrideBlocked = [bool]$status.LegacyPersistentOverrideBlocked
        LegacyEnvironmentState = [string]$status.LegacyEnvironmentState
        DesktopConnected = [bool]$status.DesktopConnected
        SidecarConnected = [bool]$status.SidecarConnected
        Degraded = [bool]$status.Degraded
        DesktopIndependentStdioAppServer = [bool]$status.DesktopIndependentStdioAppServer
        PublicUrl = [string]$status.PublicUrl
        RootOwnerPid = $rootOwnerPid
        BrokerPid = $status.BrokerPid
        BrokerUpstreamPid = $status.BrokerUpstreamPid
        EvidenceDir = $evidenceDir
    }
    Copy-StartupDiagnosticEvidence
    Write-JsonFile -Path $resultPath -Value $result
    Write-Step 'Migration completed successfully; opening the public human gate.'
    Start-Process -FilePath ([string]$status.PublicUrl)
    $result
} catch {
    $failure = Protect-LogText $_.Exception.Message
    Write-Step "Migration failed: $failure"
    try { Copy-StartupDiagnosticEvidence } catch { Write-Step "Startup diagnostic copy warning: $(Protect-LogText $_.Exception.Message)" }
    try { Stop-CodexDesktopExact } catch { Write-Step "Desktop rollback stop warning: $(Protect-LogText $_.Exception.Message)" }

    $v2CleanupSafe = $true
    if ($v2RegistrationAttempted) {
        try {
            Write-Step 'Removing V2 and retiring only exact legacy persistent-override residue.'
            Invoke-UnregisterV2
        } catch {
            $v2CleanupSafe = $false
            Write-Step "V2 exact cleanup failed; preserving the task for manual recovery: $(Protect-LogText $_.Exception.Message)"
        }
    }

    if ($v2CleanupSafe) {
        try {
            Write-Step 'Restoring or restarting the exact original V1 task XML.'
            Start-OrRestoreOriginalV1Task
            Wait-Until -TimeoutSeconds 30 -FailureMessage 'V1 rollback listener did not recover.' -Condition {
                Test-ExactOriginalV1Runtime
            }
            Assert-FunnelUnchanged `
                -Before $funnelBefore `
                -RootOwnerFingerprint $rootOwnerFingerprint
            Start-CodexDesktop
            $rollback = 'restored-v1'
        } catch {
            $rollback = "manual-recovery-required: $(Protect-LogText $_.Exception.Message)"
            Write-Step $rollback
        }
    } else {
        $rollback = 'manual-recovery-required: exact V2 cleanup did not complete; same-name task was preserved'
        Write-Step $rollback
    }

    $result = [pscustomobject]@{
        Status = 'failed'
        RunId = $runId
        Error = $failure
        Rollback = $rollback
        EvidenceDir = $evidenceDir
    }
    Write-JsonFile -Path $resultPath -Value $result
    throw $failure
} finally {
    Exit-MigrationMutex
}
