[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$LauncherPath
)

$ErrorActionPreference = 'Stop'
. $LauncherPath -DefinitionOnly

$userSid = 'S-1-5-21-111-222-333-1001'
$explorerPath = 'C:\Windows\explorer.exe'
$candidates = @(
    [pscustomobject]@{
        ProcessId = 601
        SessionId = 8
        UserSid = $userSid
        ExecutablePath = $explorerPath
        IsElevated = $false
        IntegrityRid = [uint32]0x00002000
    },
    [pscustomobject]@{
        ProcessId = 602
        SessionId = 7
        UserSid = 'S-1-5-21-999-888-777-1001'
        ExecutablePath = $explorerPath
        IsElevated = $false
        IntegrityRid = [uint32]0x00002000
    },
    [pscustomobject]@{
        ProcessId = 603
        SessionId = 7
        UserSid = $userSid
        ExecutablePath = $explorerPath
        IsElevated = $true
        IntegrityRid = [uint32]0x00002000
    },
    [pscustomobject]@{
        ProcessId = 604
        SessionId = 7
        UserSid = $userSid
        ExecutablePath = $explorerPath
        IsElevated = $false
        IntegrityRid = [uint32]0x00001000
    },
    [pscustomobject]@{
        ProcessId = 605
        SessionId = 7
        UserSid = $userSid
        ExecutablePath = 'C:\fixture\explorer.exe'
        IsElevated = $false
        IntegrityRid = [uint32]0x00002000
    },
    [pscustomobject]@{
        ProcessId = 606
        SessionId = 7
        UserSid = $userSid
        ExecutablePath = $explorerPath
        IsElevated = $false
        IntegrityRid = [uint32]0x00002000
    }
)
$selected = Select-CodexDesktopInteractiveExplorerCandidate `
    -Candidates $candidates `
    -InteractiveSessionId 7 `
    -UserSid $userSid `
    -ExplorerExecutablePath $explorerPath

function Get-CharacterSequenceCount {
    param(
        [Parameter(Mandatory)]
        [char[]]$Characters,

        [Parameter(Mandatory)]
        [string]$Sequence
    )

    $count = 0
    for ($offset = 0; $offset -le
        $Characters.Length - $Sequence.Length; $offset++) {
        $match = $true
        for ($index = 0; $index -lt $Sequence.Length; $index++) {
            if ($Characters[$offset + $index] -cne $Sequence[$index]) {
                $match = $false
                break
            }
        }
        if ($match) {
            $count++
        }
    }
    return $count
}

$staleEndpoint = 'ws://127.0.0.1:49999/ws/stale-parent-endpoint'
$remoteEndpoint = 'ws://127.0.0.1:18791/ws/fixture-endpoint'
function New-FixtureEnvironmentCharacters {
    return (
        "CODEX_APP_SERVER_WS_URL=$staleEndpoint" +
        "`0Path=C:\fixture\bin" +
        "`0TEMP=C:\fixture\temp" +
        "`0`0"
    ).ToCharArray()
}
$originalOverride = [string]$env:CODEX_APP_SERVER_WS_URL
$remoteBlock = $null
$nativeBlock = $null
try {
    $env:CODEX_APP_SERVER_WS_URL = $staleEndpoint
    $remoteBlock = New-CodexDesktopEnvironmentBlock `
        -RemoteEndpoint $remoteEndpoint `
        -SourceEnvironmentCharacters (
            New-FixtureEnvironmentCharacters
        )
    $remoteExactCount = Get-CharacterSequenceCount `
        -Characters $remoteBlock.Characters `
        -Sequence "CODEX_APP_SERVER_WS_URL=$remoteEndpoint"
    $remoteStaleCount = Get-CharacterSequenceCount `
        -Characters $remoteBlock.Characters `
        -Sequence $staleEndpoint
    $remotePathCount = Get-CharacterSequenceCount `
        -Characters $remoteBlock.Characters `
        -Sequence 'Path=C:\fixture\bin'
    Clear-CodexDesktopEnvironmentBlock -EnvironmentBlock $remoteBlock
    $remoteCleared = (
        $remoteBlock.Pointer -eq [IntPtr]::Zero -and
        @($remoteBlock.Characters | Where-Object { $_ -ne [char]0 }).Count -eq 0
    )

    $nativeBlock = New-CodexDesktopEnvironmentBlock `
        -RemoteEndpoint $null `
        -SourceEnvironmentCharacters (
            New-FixtureEnvironmentCharacters
        )
    $nativeOverrideCount = Get-CharacterSequenceCount `
        -Characters $nativeBlock.Characters `
        -Sequence 'CODEX_APP_SERVER_WS_URL='
    Clear-CodexDesktopEnvironmentBlock -EnvironmentBlock $nativeBlock
    $nativeCleared = (
        $nativeBlock.Pointer -eq [IntPtr]::Zero -and
        @($nativeBlock.Characters | Where-Object { $_ -ne [char]0 }).Count -eq 0
    )
} finally {
    Clear-CodexDesktopEnvironmentBlock -EnvironmentBlock $remoteBlock
    Clear-CodexDesktopEnvironmentBlock -EnvironmentBlock $nativeBlock
    if ([string]::IsNullOrEmpty($originalOverride)) {
        Remove-Item Env:CODEX_APP_SERVER_WS_URL -ErrorAction SilentlyContinue
    } else {
        $env:CODEX_APP_SERVER_WS_URL = $originalOverride
    }
}

$malformedSource = "Path=C:\fixture`0BROKEN`0`0".ToCharArray()
$malformedFailedClosed = $false
try {
    $null = New-CodexDesktopEnvironmentBlock `
        -RemoteEndpoint $remoteEndpoint `
        -SourceEnvironmentCharacters $malformedSource
} catch {
    $malformedFailedClosed = (
        $_.Exception.Message -ceq
            'The token user environment contains an invalid entry.'
    )
}
$malformedSourceCleared = (
    @($malformedSource | Where-Object { $_ -ne [char]0 }).Count -eq 0
)

$splitTokenCalls = [System.Collections.Generic.List[object]]::new()
$splitTokenStart = {
    param(
        [string]$ExecutablePath,
        [AllowNull()]
        [string]$Endpoint,
        [string[]]$Arguments
    )
    $splitTokenCalls.Add([pscustomobject]@{
        ExecutablePath = $ExecutablePath
        Endpoint = $Endpoint
        ArgumentCount = $Arguments.Count
    })
    return [pscustomobject]@{ Id = 42000 + $splitTokenCalls.Count }
}.GetNewClosure()
$null = Start-CodexDesktopProcess `
    -DesktopExecutablePath 'C:\fixture\ChatGPT.exe' `
    -RemoteEndpoint $remoteEndpoint `
    -TestElevatedAction { $true } `
    -StartWithInteractiveTokenAction $splitTokenStart
$null = Start-CodexDesktopProcess `
    -DesktopExecutablePath 'C:\fixture\ChatGPT.exe' `
    -RemoteEndpoint $null `
    -TestElevatedAction { $true } `
    -StartWithInteractiveTokenAction $splitTokenStart

[pscustomobject]@{
    SelectedProcessId = [int]$selected.ProcessId
    RemoteExactCount = $remoteExactCount
    RemoteStaleCount = $remoteStaleCount
    RemotePathCount = $remotePathCount
    NativeOverrideCount = $nativeOverrideCount
    RemoteCleared = $remoteCleared
    NativeCleared = $nativeCleared
    MalformedFailedClosed = $malformedFailedClosed
    MalformedSourceCleared = $malformedSourceCleared
    SplitTokenCalls = @($splitTokenCalls)
} | ConvertTo-Json -Compress -Depth 5
