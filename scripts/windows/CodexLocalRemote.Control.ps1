# codex-local-remote/control-dispatcher/v1
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Open', 'Close', 'Status')]
    [string]$Operation,

    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'CodexLocalRemote'),

    [switch]$AllowDesktopRestart,

    [Parameter(DontShow)]
    [ValidatePattern('^[a-f0-9]{32}$')]
    [string]$ExpectedDesiredModeIntentId,

    [Parameter(DontShow)]
    [switch]$ImmediateAuthorizedDesktopRestartForOpen,

    [switch]$InteractiveShortcutFeedback
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
if ($Operation -cne 'Open' -and $AllowDesktopRestart) {
    throw 'AllowDesktopRestart is valid only for an explicit Open operation.'
}
if (-not [string]::IsNullOrWhiteSpace(
    $ExpectedDesiredModeIntentId
) -and ($Operation -cne 'Open' -or -not $AllowDesktopRestart)) {
    throw (
        'ExpectedDesiredModeIntentId is valid only for one authorized ' +
        'Open operation.'
    )
}
if ($ImmediateAuthorizedDesktopRestartForOpen -and
    ($Operation -cne 'Open' -or
        -not $AllowDesktopRestart -or
        [string]::IsNullOrWhiteSpace($ExpectedDesiredModeIntentId))) {
    throw (
        'ImmediateAuthorizedDesktopRestartForOpen is valid only for one ' +
        'authorized deferred Open operation with an exact desired-mode intent.'
    )
}

function Show-ControlNotification {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('Open', 'Close', 'Status')]
        [string]$RequestedOperation,

        [AllowNull()]
        [object]$Result,

        [switch]$Failed,

        [Parameter(DontShow)]
        [scriptblock]$Adapter
    )

    if (-not $InteractiveShortcutFeedback) {
        return
    }
    $resultStatus = [string]$Result.Status
    $title = 'Codex Remote'
    $message = if ($Failed) {
        $title = 'Codex Remote 未连接'
        '远程未连接；ChatGPT 保持原生安全模式，可让 AI 继续诊断。'
    } elseif ($RequestedOperation -ceq 'Close') {
        if ($resultStatus -ieq 'already-native') {
            '远程本来就是关闭状态；ChatGPT 保持原生模式。'
        } elseif ($resultStatus -ieq 'native') {
            '远程已关闭；ChatGPT 保持原生模式。'
        } elseif ($resultStatus -ieq 'native-pending-desktop-exit') {
            (
                '公网远程已关闭；当前 ChatGPT 保持不动，' +
                '自然退出后完全恢复原生模式。'
            )
        } else {
            $title = 'Codex Remote 关闭未确认'
            '远程关闭结果尚未确认；请让 AI 检查当前状态。'
        }
    } elseif ($RequestedOperation -ceq 'Status') {
        '远程状态检查已完成。'
    } elseif ($resultStatus -cin @(
        'ready',
        'repaired',
        'active'
    )) {
        '远程已连接，可继续在公网端验收。'
    } elseif ($resultStatus -cin @(
        'remote-lease-active',
        'already-active'
    )) {
        '当前已经是远程连接，没有重启 ChatGPT。'
    } elseif ($resultStatus -cin @(
        'pending',
        'repair-pending',
        'repairing'
    )) {
        $title = 'Codex Remote 正在处理'
        '远程尚未 ready；后台正在处理，当前不会显示为已连接。'
    } elseif ($resultStatus -ieq 'restart-required') {
        $title = 'Codex Remote 需要交接'
        '远程尚未连接；需要一次已授权的 ChatGPT 外部交接。'
    } else {
        $title = 'Codex Remote 未连接'
        '远程未连接；ChatGPT 保持原生安全模式，可让 AI 继续诊断。'
    }
    if ($null -ne $Adapter) {
        & $Adapter $title $message
        return
    }
    $shell = $null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $null = $shell.Popup($message, 4, $title, 64)
    } catch {
        # Feedback must never change the control operation result.
    } finally {
        if ($null -ne $shell) {
            $null =
                [Runtime.InteropServices.Marshal]::FinalReleaseComObject(
                    $shell
                )
        }
    }
}

function Read-BoundedOrdinaryJsonFile {
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [ValidateRange(2, 1048576)]
        [int]$MaximumBytes = 131072
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required control file is missing at '$Path'."
    }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        ($item.Attributes -band
            [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [long]$item.Length -lt 2 -or
        [long]$item.Length -gt $MaximumBytes) {
        throw "Control file '$Path' is not one ordinary bounded file."
    }
    $rawBefore = Get-Content -LiteralPath $Path -Raw -Encoding utf8
    $value = $rawBefore |
        ConvertFrom-Json -Depth 50 -DateKind String -ErrorAction Stop
    $rawAfter = Get-Content -LiteralPath $Path -Raw -Encoding utf8
    if ($rawBefore -cne $rawAfter) {
        throw "Control file '$Path' changed while it was read."
    }
    return $value
}

function Open-BoundedOrdinaryJsonFile {
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [ValidateRange(2, 1048576)]
        [int]$MaximumBytes = 131072
    )

    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
        throw "Required control file is missing at '$resolvedPath'."
    }
    $item = Get-Item -LiteralPath $resolvedPath -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        ($item.Attributes -band
            [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Control file '$resolvedPath' is not ordinary."
    }
    $stream = $null
    try {
        $stream = [System.IO.File]::Open(
            $resolvedPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        if ($stream.Length -lt 2 -or $stream.Length -gt $MaximumBytes) {
            throw "Control file '$resolvedPath' is not bounded."
        }
        $reader = [System.IO.StreamReader]::new(
            $stream,
            [System.Text.UTF8Encoding]::new($false, $true),
            $true,
            4096,
            $true
        )
        try {
            $raw = $reader.ReadToEnd()
        } finally {
            $reader.Dispose()
        }
        $value = $raw |
            ConvertFrom-Json -Depth 50 -DateKind String -ErrorAction Stop
        $stream.Position = 0
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $sha256 = [Convert]::ToHexString(
                $sha.ComputeHash($stream)
            ).ToLowerInvariant()
        } finally {
            $sha.Dispose()
        }
        $stream.Position = 0
        return [pscustomobject]@{
            Path = $resolvedPath
            Value = $value
            Sha256 = $sha256
            Lock = $stream
        }
    } catch {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        throw
    }
}

function Get-VerifiedRuntimeFile {
    param(
        [Parameter(Mandatory)]
        [object]$Manifest,

        [Parameter(Mandatory)]
        [string]$RuntimeRoot,

        [Parameter(Mandatory)]
        [string]$RelativePath
    )

    $normalizedRelativePath = $RelativePath.Replace('\', '/')
    $entries = @(
        $Manifest.Files |
            Where-Object {
                [string]$_.Path -ceq $normalizedRelativePath
            }
    )
    if ($entries.Count -ne 1 -or
        [string]$entries[0].Sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        -not (Test-Path -LiteralPath (
            Join-Path $RuntimeRoot $RelativePath
        ) -PathType Leaf)) {
        throw "Selected runtime does not manifest '$normalizedRelativePath'."
    }
    $path = [System.IO.Path]::GetFullPath(
        (Join-Path $RuntimeRoot $RelativePath)
    )
    $runtimePrefix =
        [System.IO.Path]::TrimEndingDirectorySeparator($RuntimeRoot) + '\'
    if (-not $path.StartsWith(
        $runtimePrefix,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Manifest path '$normalizedRelativePath' escaped the runtime root."
    }
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        ($item.Attributes -band
            [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [long]$item.Length -ne [long]$entries[0].Size) {
        throw "Manifest file '$normalizedRelativePath' changed shape."
    }
    $stream = $null
    try {
        $stream = [System.IO.File]::Open(
            $path,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        if ($stream.Length -ne [long]$entries[0].Size) {
            throw "Manifest file '$normalizedRelativePath' changed shape."
        }
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $sha256 = [Convert]::ToHexString(
                $sha.ComputeHash($stream)
            ).ToLowerInvariant()
        } finally {
            $sha.Dispose()
        }
        if ($sha256 -cne [string]$entries[0].Sha256) {
            throw "Manifest file '$normalizedRelativePath' changed content."
        }
        $stream.Position = 0
        return [pscustomobject]@{
            Path = $path
            Lock = $stream
        }
    } catch {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        throw
    }
}

$pointerPath = Join-Path $resolvedDataDir 'runtime-current.json'
$pointerFile = Open-BoundedOrdinaryJsonFile `
    -Path $pointerPath `
    -MaximumBytes 131072
$pointer = $pointerFile.Value
if ([string]$pointer.Signature -cne
        'codex-local-remote/runtime-current/v1' -or
    [int]$pointer.Version -ne 1 -or
    [string]$pointer.CurrentVersionId -cnotmatch '^[a-f0-9]{64}$' -or
    [string]$pointer.CurrentManifestSha256 -cnotmatch
        '^[a-f0-9]{64}$') {
    throw 'The selected runtime pointer is not canonical.'
}
$runtimeRoot = [System.IO.Path]::GetFullPath(
    [string]$pointer.CurrentRoot
)
$expectedRuntimeRoot = [System.IO.Path]::GetFullPath(
    (Join-Path `
        (Join-Path $resolvedDataDir 'RuntimeVersions') `
        ([string]$pointer.CurrentVersionId))
)
if (-not [string]::Equals(
    $runtimeRoot,
    $expectedRuntimeRoot,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw 'The selected runtime root is outside the managed version store.'
}
$runtimeItem =
    Get-Item -LiteralPath $runtimeRoot -Force -ErrorAction Stop
if (-not $runtimeItem.PSIsContainer -or
    ($runtimeItem.Attributes -band
        [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The selected runtime root is not one ordinary directory.'
}
$manifestPath = Join-Path $runtimeRoot 'runtime-manifest.json'
$manifestFile = Open-BoundedOrdinaryJsonFile `
    -Path $manifestPath `
    -MaximumBytes 1048576
$manifest = $manifestFile.Value
$manifestSha256 = [string]$manifestFile.Sha256
if ($manifestSha256 -cne [string]$pointer.CurrentManifestSha256) {
    throw 'The selected runtime manifest does not match the selected pointer.'
}
if ([string]$manifest.Signature -cne
        'codex-local-remote/runtime-manifest/v1' -or
    [int]$manifest.Version -ne 1 -or
    [string]$manifest.VersionId -cne
        [string]$pointer.CurrentVersionId -or
    @($manifest.Files).Count -ne [int]$manifest.FileCount) {
    throw 'The selected runtime manifest is not canonical.'
}

$targetRelativePath =
    'scripts\windows\Invoke-CodexLocalRemoteOnDemandHandoff.ps1'
$moduleFile = Get-VerifiedRuntimeFile `
    -Manifest $manifest `
    -RuntimeRoot $runtimeRoot `
    -RelativePath 'scripts\windows\CodexLocalRemote.Windows.psm1'
$targetFile = Get-VerifiedRuntimeFile `
    -Manifest $manifest `
    -RuntimeRoot $runtimeRoot `
    -RelativePath $targetRelativePath
$targetPath = [string]$targetFile.Path

try {
    $deferredIntentArguments = @{}
    if (-not [string]::IsNullOrWhiteSpace(
        $ExpectedDesiredModeIntentId
    )) {
        $deferredIntentArguments['ExpectedDesiredModeIntentId'] =
            $ExpectedDesiredModeIntentId
    }
    if ($ImmediateAuthorizedDesktopRestartForOpen) {
        $deferredIntentArguments[
            'ImmediateAuthorizedDesktopRestartForOpen'
        ] = $true
    }
    $operationResult = @(
    switch ($Operation) {
        'Open' {
            & $targetPath `
                -Operation Open `
                -DataDir $resolvedDataDir `
                -DispatchDelaySeconds 0 `
                -ExpectedSelectedVersionId (
                    [string]$pointer.CurrentVersionId
                ) `
                -ExpectedSelectedRuntimeRoot $runtimeRoot `
                -ExpectedSelectedManifestSha256 $manifestSha256 `
                -AllowDesktopRestart:$AllowDesktopRestart `
                @deferredIntentArguments
        }
        'Close' {
            & $targetPath `
                -Operation Close `
                -DataDir $resolvedDataDir `
                -ExpectedSelectedVersionId (
                    [string]$pointer.CurrentVersionId
                ) `
                -ExpectedSelectedRuntimeRoot $runtimeRoot `
                -ExpectedSelectedManifestSha256 $manifestSha256
        }
        'Status' {
            & $targetPath `
                -Operation Status `
                -DataDir $resolvedDataDir `
                -DispatchDelaySeconds 0 `
                -ExpectedSelectedVersionId (
                    [string]$pointer.CurrentVersionId
                ) `
                -ExpectedSelectedRuntimeRoot $runtimeRoot `
                -ExpectedSelectedManifestSha256 $manifestSha256
        }
    }
    )
    Show-ControlNotification `
        -RequestedOperation $Operation `
        -Result $operationResult
    $operationResult
} catch {
    Show-ControlNotification `
        -RequestedOperation $Operation `
        -Failed
    throw
} finally {
    foreach ($verifiedFile in @(
        $targetFile,
        $moduleFile,
        $manifestFile,
        $pointerFile
    )) {
        if ($null -ne $verifiedFile -and
            $null -ne $verifiedFile.Lock) {
            $verifiedFile.Lock.Dispose()
        }
    }
}
