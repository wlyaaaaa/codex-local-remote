Set-StrictMode -Version Latest

$script:StartupTaskSignature = 'codex-local-remote/startup-task/v5'
$script:StartupTaskDescription = "$script:StartupTaskSignature - Starts the loopback app-server broker and local-only Codex Local Remote sidecar only on an explicit demand start."
$script:LegacyAutoStartStartupTaskV5Description = 'codex-local-remote/startup-task/v5 - Starts the loopback app-server broker before the local-only Codex Local Remote sidecar at user sign-in.'
$script:LegacyHeadlessStartupTaskV4Description = 'codex-local-remote/startup-task/v4 - Starts the loopback app-server broker before the local-only Codex Local Remote sidecar at user sign-in.'
$script:LegacyDesktopOwningStartupTaskV3Description = 'codex-local-remote/startup-task/v3 - Starts the loopback app-server broker before the local-only Codex Local Remote sidecar at user sign-in.'
$script:PinnedStartupTaskV2Description = 'codex-local-remote/startup-task/v2 - Starts the loopback app-server broker before the local-only Codex Local Remote sidecar at user sign-in.'
$script:BrokerStateSignature = 'codex-local-remote/app-server-broker/v3'
$script:EnvironmentStateSignature = 'codex-local-remote/user-environment/v2'
$script:BrokerCapabilityTokenName = 'broker-capability.token'
$script:DataDirectoryOwnerSignature = 'codex-local-remote/data-directory-owner/v1'
$script:DataDirectoryOwnerMarkerName = '.codex-local-remote-data-owner.json'
$script:DataDirectoryOwnerMarkerMaxBytes = 4096
$script:DataDirectoryProtectionCache = @{}
$script:CodexDesktopPackageName = 'OpenAI.Codex'
$script:CodexDesktopPublisherId = '2p2nqsd0c76g0'
$script:LegacyDataDirectoryFiles = @(
    'state.json',
    'startup-last.json',
    'app-server-broker.json',
    'windows-broker-environment.json',
    'managed-config.json',
    'desktop-owner-intent.json',
    'desktop-owner-intent-last.json',
    'desktop-owner-proof.json',
    'desktop-package-refresh-intent.json',
    'desktop-package-refresh-last.json',
    'desktop-owner-fallback-suppression.json',
    'broker-capability.token',
    'app-server-upstream.token'
)
$script:LegacyDataDirectoryDirectories = @(
    'RemoteConversations',
    'funnel-backups'
)

function Assert-CanonicalBasePath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$BasePath,

        [switch]$DisallowRoot
    )

    if ($BasePath.Length -eq 0 -or
        $BasePath -notmatch '^/(?:[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*)?$') {
        throw "BasePath '$BasePath' is not canonical. Use one leading slash, non-empty path segments, and no trailing slash."
    }

    $segments = @($BasePath.Split('/', [System.StringSplitOptions]::RemoveEmptyEntries))
    if ($segments | Where-Object { $_ -in @('.', '..') }) {
        throw "BasePath '$BasePath' is not canonical. Dot segments are not allowed."
    }

    if ($DisallowRoot -and $BasePath -eq '/') {
        throw 'The Funnel root route is not a valid project path.'
    }
}

function Join-BasePathUrl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Origin,

        [Parameter(Mandatory)]
        [string]$BasePath,

        [string]$Suffix = ''
    )

    Assert-CanonicalBasePath -BasePath $BasePath
    $path = if ($BasePath -eq '/') { '' } else { $BasePath }
    return "$($Origin.TrimEnd('/'))$path/$($Suffix.TrimStart('/'))"
}

function ConvertTo-WindowsCommandLineArgument {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [Parameter(Mandatory)]
        [string]$Value
    )

    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
        return $Value
    }

    $builder = [System.Text.StringBuilder]::new()
    $null = $builder.Append('"')
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashes++
            continue
        }

        if ($character -eq '"') {
            $null = $builder.Append(('\' * (($backslashes * 2) + 1)))
            $null = $builder.Append('"')
            $backslashes = 0
            continue
        }

        if ($backslashes -gt 0) {
            $null = $builder.Append(('\' * $backslashes))
            $backslashes = 0
        }
        $null = $builder.Append($character)
    }

    if ($backslashes -gt 0) {
        $null = $builder.Append(('\' * ($backslashes * 2)))
    }
    $null = $builder.Append('"')
    return $builder.ToString()
}

function Get-BrokerWebSocketUrl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$Port
    )

    return "ws://127.0.0.1:$Port"
}

function Get-BrokerCapabilityTokenPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    return [System.IO.Path]::GetFullPath(
        (Join-Path ([System.IO.Path]::GetFullPath($DataDir)) $script:BrokerCapabilityTokenName)
    )
}

function Test-CodexDesktopRuntimeOrdinaryFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            return $false
        }
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        return (
            -not $item.PSIsContainer -and
            ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0 -and
            [long]$item.Length -gt 0
        )
    } catch {
        return $false
    }
}

function Test-CodexDesktopRuntimePathInsideRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter(Mandatory)]
        [string]$Root
    )

    try {
        $resolvedPath = [System.IO.Path]::GetFullPath($Path)
        $resolvedRoot = [System.IO.Path]::TrimEndingDirectorySeparator(
            [System.IO.Path]::GetFullPath($Root)
        )
        return $resolvedPath.StartsWith(
            "$resolvedRoot$([System.IO.Path]::DirectorySeparatorChar)",
            [System.StringComparison]::OrdinalIgnoreCase
        )
    } catch {
        return $false
    }
}

function Get-CodexDesktopRuntimeCachePath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$LocalAppDataPath,

        [string]$RuntimeCachePath
    )

    if (-not [string]::IsNullOrWhiteSpace($RuntimeCachePath)) {
        return [System.IO.Path]::GetFullPath($RuntimeCachePath)
    }
    return [System.IO.Path]::GetFullPath(
        (Join-Path $LocalAppDataPath 'CodexLocalRemote\desktop-runtime-cache.json')
    )
}

function Read-CodexDesktopRuntimeCache {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter(Mandatory)]
        [object]$Package,

        [Parameter(Mandatory)]
        [string]$PackageRoot,

        [Parameter(Mandatory)]
        [string]$DesktopExecutablePath,

        [Parameter(Mandatory)]
        [string]$DesktopExecutableSha256,

        [Parameter(Mandatory)]
        [string]$BundledCodexPath,

        [Parameter(Mandatory)]
        [string]$BundledCodexSha256,

        [Parameter(Mandatory)]
        [string]$CodexCacheRoot
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Codex Desktop runtime cache receipt '$Path' is not an ordinary file."
    }
    if ([long]$item.Length -lt 2 -or [long]$item.Length -gt 32768) {
        return $null
    }
    try {
        $rawBefore = Get-Content -LiteralPath $Path -Raw -Encoding utf8
        $cache = $rawBefore | ConvertFrom-Json -Depth 10 -ErrorAction Stop
        $rawAfter = Get-Content -LiteralPath $Path -Raw -Encoding utf8
    } catch {
        return $null
    }
    try {
        if ($rawBefore -cne $rawAfter -or
            [string]$cache.Signature -cne
                'codex-local-remote/codex-desktop-runtime-cache/v1' -or
            [int]$cache.Version -ne 1 -or
            [string]$cache.PackageName -cne [string]$Package.Name -or
            [string]$cache.PackageFamilyName -cne
                [string]$Package.PackageFamilyName -or
            [string]$cache.PackageFullName -cne
                [string]$Package.PackageFullName -or
            [string]$cache.PackageVersion -cne [string]$Package.Version -or
            -not [string]::Equals(
                [string]$cache.PackageInstallLocation,
                $PackageRoot,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -or
            -not [string]::Equals(
                [string]$cache.DesktopExecutablePath,
                $DesktopExecutablePath,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -or
            -not [string]::Equals(
                [string]$cache.BundledCodexPath,
                $BundledCodexPath,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -or
            [string]$cache.DesktopExecutableSha256 -cne
                $DesktopExecutableSha256 -or
            [string]$cache.BundledCodexSha256 -cne $BundledCodexSha256 -or
            [string]$cache.CodexSha256 -cnotmatch '^[0-9A-F]{64}$') {
            return $null
        }
        $cachedCodexPath = [System.IO.Path]::GetFullPath(
            [string]$cache.CodexPath
        )
    } catch {
        return $null
    }
    if (-not (
        (Test-CodexDesktopRuntimePathInsideRoot `
            -Path $cachedCodexPath `
            -Root $PackageRoot) -or
        (Test-CodexDesktopRuntimePathInsideRoot `
            -Path $cachedCodexPath `
            -Root $CodexCacheRoot)
    ) -or
        -not (Test-CodexDesktopRuntimeOrdinaryFile -Path $cachedCodexPath)) {
        return $null
    }
    try {
        $cachedCodexSha256 = if ([string]::Equals(
            $cachedCodexPath,
            $BundledCodexPath,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            $BundledCodexSha256
        } else {
            (
                Get-FileHash `
                    -LiteralPath $cachedCodexPath `
                    -Algorithm SHA256 `
                    -ErrorAction Stop
            ).Hash.ToUpperInvariant()
        }
    } catch {
        return $null
    }
    if ($cachedCodexSha256 -cne [string]$cache.CodexSha256 -or
        $cachedCodexSha256 -cne $BundledCodexSha256) {
        return $null
    }

    return [pscustomobject][ordered]@{
        CodexPath = $cachedCodexPath
        CodexSha256 = $cachedCodexSha256
        Source = 'persistent-runtime-cache-hash-verified'
    }
}

function Write-CodexDesktopRuntimeCache {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter(Mandatory)]
        [object]$Runtime
    )

    Write-AtomicJsonFile -Path $Path -Value ([ordered]@{
        Signature = 'codex-local-remote/codex-desktop-runtime-cache/v1'
        Version = 1
        PackageName = [string]$Runtime.PackageName
        PackageFamilyName = [string]$Runtime.PackageFamilyName
        PackageFullName = [string]$Runtime.PackageFullName
        PackageVersion = [string]$Runtime.PackageVersion
        PackageInstallLocation = [string]$Runtime.PackageInstallLocation
        DesktopExecutablePath = [string]$Runtime.DesktopExecutablePath
        DesktopExecutableSha256 = [string]$Runtime.DesktopExecutableSha256
        BundledCodexPath = [string]$Runtime.BundledCodexPath
        BundledCodexSha256 = [string]$Runtime.BundledCodexSha256
        CodexPath = [string]$Runtime.CodexPath
        CodexSha256 = [string]$Runtime.CodexSha256
        RuntimeSource = [string]$Runtime.Source
        RecordedAtUtc = [DateTime]::UtcNow.ToString('O')
    })
}

function Resolve-CodexDesktopPackageStatusIdentity {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object[]]$PackageCandidates,

        [string]$PackageName = $script:CodexDesktopPackageName,

        [string]$PublisherId = $script:CodexDesktopPublisherId
    )

    if (-not $PSBoundParameters.ContainsKey('PackageCandidates')) {
        $PackageCandidates = @(
            Get-AppxPackage -Name $PackageName -ErrorAction Stop
        )
    }
    $expectedFamilyName = "${PackageName}_$PublisherId"
    $packages = @(
        $PackageCandidates |
            Where-Object { $null -ne $_ } |
            Where-Object {
                [string]$_.Name -ceq $PackageName -and
                [string]$_.PackageFamilyName -ceq $expectedFamilyName -and
                [string]$_.Status -ceq 'Ok' -and
                -not [string]::IsNullOrWhiteSpace([string]$_.InstallLocation)
            }
    )
    if ($packages.Count -ne 1) {
        throw "Expected exactly one healthy '$expectedFamilyName' Codex Desktop package, found $($packages.Count). Remote status cannot confirm update compatibility; Codex Desktop itself was not changed."
    }

    $package = $packages[0]
    $packageRoot = [System.IO.Path]::TrimEndingDirectorySeparator(
        [System.IO.Path]::GetFullPath([string]$package.InstallLocation)
    )
    $packageItem = Get-Item -LiteralPath $packageRoot -Force -ErrorAction Stop
    if (-not $packageItem.PSIsContainer -or
        ($packageItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Codex Desktop package root '$packageRoot' is not an ordinary directory."
    }
    $bundledCodexPath = [System.IO.Path]::GetFullPath(
        (Join-Path $packageRoot 'app\resources\codex.exe')
    )
    $desktopExecutablePath = [System.IO.Path]::GetFullPath(
        (Join-Path $packageRoot 'app\ChatGPT.exe')
    )
    foreach ($required in @($bundledCodexPath, $desktopExecutablePath)) {
        if (-not (Test-CodexDesktopRuntimePathInsideRoot -Path $required -Root $packageRoot) -or
            -not (Test-CodexDesktopRuntimeOrdinaryFile -Path $required)) {
            throw "Codex Desktop package runtime file is missing or unsafe: '$required'."
        }
    }

    return [pscustomobject][ordered]@{
        Signature = 'codex-local-remote/codex-desktop-package-status/v1'
        Version = 1
        PackageName = [string]$package.Name
        PackageFamilyName = [string]$package.PackageFamilyName
        PackageFullName = [string]$package.PackageFullName
        PackageVersion = [string]$package.Version
        PackageInstallLocation = $packageRoot
        DesktopExecutablePath = $desktopExecutablePath
        BundledCodexPath = $bundledCodexPath
        CodexSha256 = $null
        Source = 'package-metadata'
        DiscoveredAtUtc = [DateTime]::UtcNow.ToString('O')
    }
}

function Resolve-CodexDesktopRuntime {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object[]]$PackageCandidates,

        [AllowNull()]
        [object[]]$DesktopProcessCandidates,

        [string]$LocalAppDataPath = $env:LOCALAPPDATA,

        [string]$RuntimeCachePath,

        [string]$PackageName = $script:CodexDesktopPackageName,

        [string]$PublisherId = $script:CodexDesktopPublisherId
    )

    if ([string]::IsNullOrWhiteSpace($LocalAppDataPath)) {
        throw 'LOCALAPPDATA is unavailable; the Codex Desktop runtime cache cannot be resolved.'
    }
    if (-not $PSBoundParameters.ContainsKey('PackageCandidates')) {
        $PackageCandidates = @(
            Get-AppxPackage -Name $PackageName -ErrorAction Stop
        )
    }
    $expectedFamilyName = "${PackageName}_$PublisherId"
    $packages = @(
        $PackageCandidates |
            Where-Object { $null -ne $_ } |
            Where-Object {
                [string]$_.Name -ceq $PackageName -and
                [string]$_.PackageFamilyName -ceq $expectedFamilyName -and
                [string]$_.Status -ceq 'Ok' -and
                -not [string]::IsNullOrWhiteSpace([string]$_.InstallLocation)
            }
    )
    if ($packages.Count -ne 1) {
        throw "Expected exactly one healthy '$expectedFamilyName' Codex Desktop package, found $($packages.Count). Remote startup is disabled; Codex Desktop itself was not changed."
    }

    $package = $packages[0]
    $packageRoot = [System.IO.Path]::TrimEndingDirectorySeparator(
        [System.IO.Path]::GetFullPath([string]$package.InstallLocation)
    )
    $packageItem = Get-Item -LiteralPath $packageRoot -Force -ErrorAction Stop
    if (-not $packageItem.PSIsContainer -or
        ($packageItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Codex Desktop package root '$packageRoot' is not an ordinary directory."
    }
    $bundledCodexPath = [System.IO.Path]::GetFullPath(
        (Join-Path $packageRoot 'app\resources\codex.exe')
    )
    $desktopExecutablePath = [System.IO.Path]::GetFullPath(
        (Join-Path $packageRoot 'app\ChatGPT.exe')
    )
    foreach ($required in @($bundledCodexPath, $desktopExecutablePath)) {
        if (-not (Test-CodexDesktopRuntimePathInsideRoot -Path $required -Root $packageRoot) -or
            -not (Test-CodexDesktopRuntimeOrdinaryFile -Path $required)) {
            throw "Codex Desktop package runtime file is missing or unsafe: '$required'."
        }
    }

    $bundledCodexSha256 = (
        Get-FileHash -LiteralPath $bundledCodexPath -Algorithm SHA256 -ErrorAction Stop
    ).Hash.ToUpperInvariant()
    $desktopExecutableSha256 = (
        Get-FileHash -LiteralPath $desktopExecutablePath -Algorithm SHA256 -ErrorAction Stop
    ).Hash.ToUpperInvariant()
    if ($bundledCodexSha256 -cnotmatch '^[0-9A-F]{64}$' -or
        $desktopExecutableSha256 -cnotmatch '^[0-9A-F]{64}$') {
        throw 'Codex Desktop package runtime hashing returned an invalid SHA-256 fingerprint.'
    }
    $cacheRoot = [System.IO.Path]::GetFullPath(
        (Join-Path $LocalAppDataPath 'OpenAI\Codex\bin')
    )
    $resolvedRuntimeCachePath = Get-CodexDesktopRuntimeCachePath `
        -LocalAppDataPath $LocalAppDataPath `
        -RuntimeCachePath $RuntimeCachePath

    if (-not $PSBoundParameters.ContainsKey('DesktopProcessCandidates')) {
        $DesktopProcessCandidates = @(
            Get-CimInstance `
                Win32_Process `
                -Filter "Name = 'ChatGPT.exe'" `
                -ErrorAction SilentlyContinue
        )
    }
    $codexPackageProcessPaths = @(
        $DesktopProcessCandidates |
            Where-Object { $null -ne $_ } |
            ForEach-Object {
                $candidatePath = [string]$_.ExecutablePath
                if (-not [string]::IsNullOrWhiteSpace($candidatePath) -and
                    $candidatePath -match
                        '(?i)\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$') {
                    try {
                        [System.IO.Path]::GetFullPath($candidatePath)
                    } catch {
                        $null
                    }
                }
            } |
            Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } |
            Sort-Object -Unique
    )
    $foreignDesktopPaths = @(
        $codexPackageProcessPaths |
            Where-Object {
                -not [string]::Equals(
                    [string]$_,
                    $desktopExecutablePath,
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            }
    )
    if ($foreignDesktopPaths.Count -gt 0) {
        throw 'A running Codex Desktop process belongs to a different package generation. Remote startup is disabled until the Desktop update/restart converges; the Desktop process was left untouched.'
    }

    $cachedRuntime = Read-CodexDesktopRuntimeCache `
        -Path $resolvedRuntimeCachePath `
        -Package $package `
        -PackageRoot $packageRoot `
        -DesktopExecutablePath $desktopExecutablePath `
        -DesktopExecutableSha256 $desktopExecutableSha256 `
        -BundledCodexPath $bundledCodexPath `
        -BundledCodexSha256 $bundledCodexSha256 `
        -CodexCacheRoot $cacheRoot
    if ($null -ne $cachedRuntime) {
        return [pscustomobject][ordered]@{
            Signature = 'codex-local-remote/codex-desktop-runtime/v1'
            Version = 1
            PackageName = [string]$package.Name
            PackageFamilyName = [string]$package.PackageFamilyName
            PackageFullName = [string]$package.PackageFullName
            PackageVersion = [string]$package.Version
            PackageInstallLocation = $packageRoot
            DesktopExecutablePath = $desktopExecutablePath
            DesktopExecutableSha256 = $desktopExecutableSha256
            BundledCodexPath = $bundledCodexPath
            BundledCodexSha256 = $bundledCodexSha256
            CodexPath = [string]$cachedRuntime.CodexPath
            CodexSha256 = [string]$cachedRuntime.CodexSha256
            Source = [string]$cachedRuntime.Source
            RunningDesktopObserved = ($codexPackageProcessPaths.Count -gt 0)
            DiscoveredAtUtc = [DateTime]::UtcNow.ToString('O')
        }
    }

    $runtimePath = $bundledCodexPath
    $runtimeSource = 'package-bundled'
    $matchingCacheFiles = @()
    if (Test-Path -LiteralPath $cacheRoot -PathType Container) {
        $cacheRootItem = Get-Item -LiteralPath $cacheRoot -Force -ErrorAction Stop
        if (($cacheRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Codex Desktop runtime cache root '$cacheRoot' is a reparse point."
        }
        $matchingCacheFiles = @(
            Get-ChildItem -LiteralPath $cacheRoot -Directory -Force -ErrorAction Stop |
                Where-Object {
                    ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0
                } |
                ForEach-Object {
                    $candidate = [System.IO.Path]::GetFullPath(
                        (Join-Path $_.FullName 'codex.exe')
                    )
                    if ((Test-CodexDesktopRuntimePathInsideRoot -Path $candidate -Root $cacheRoot) -and
                        (Test-CodexDesktopRuntimeOrdinaryFile -Path $candidate)) {
                        $candidateHash = (
                            Get-FileHash `
                                -LiteralPath $candidate `
                                -Algorithm SHA256 `
                                -ErrorAction Stop
                        ).Hash.ToUpperInvariant()
                        if ($candidateHash -ceq $bundledCodexSha256) {
                            Get-Item -LiteralPath $candidate -Force
                        }
                    }
                } |
                Sort-Object `
                    @{ Expression = { $_.LastWriteTimeUtc }; Descending = $true },
                    @{ Expression = { $_.FullName }; Descending = $false }
        )
    }
    if ($matchingCacheFiles.Count -gt 0) {
        $runtimePath = [System.IO.Path]::GetFullPath(
            [string]$matchingCacheFiles[0].FullName
        )
        $runtimeSource = 'desktop-cache-hash-match'
    }
    $runtimeSha256 = (
        Get-FileHash -LiteralPath $runtimePath -Algorithm SHA256 -ErrorAction Stop
    ).Hash.ToUpperInvariant()
    if ($runtimeSha256 -cne $bundledCodexSha256) {
        throw 'The selected Codex Desktop runtime changed during discovery and no longer hash-matches the installed package.'
    }

    $runtime = [pscustomobject][ordered]@{
        Signature = 'codex-local-remote/codex-desktop-runtime/v1'
        Version = 1
        PackageName = [string]$package.Name
        PackageFamilyName = [string]$package.PackageFamilyName
        PackageFullName = [string]$package.PackageFullName
        PackageVersion = [string]$package.Version
        PackageInstallLocation = $packageRoot
        DesktopExecutablePath = $desktopExecutablePath
        DesktopExecutableSha256 = $desktopExecutableSha256
        BundledCodexPath = $bundledCodexPath
        BundledCodexSha256 = $bundledCodexSha256
        CodexPath = $runtimePath
        CodexSha256 = $runtimeSha256
        Source = $runtimeSource
        RunningDesktopObserved = ($codexPackageProcessPaths.Count -gt 0)
        DiscoveredAtUtc = [DateTime]::UtcNow.ToString('O')
    }
    try {
        Write-CodexDesktopRuntimeCache `
            -Path $resolvedRuntimeCachePath `
            -Runtime $runtime
    } catch {
        # Discovery remains correct without the optimization; a later managed
        # startup can rebuild the bounded, hash-verified receipt.
    }
    return $runtime
}

function Get-CodexLocalRemoteManagedDesktopIconPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $resolvedDataDir = Assert-CodexLocalRemoteDataDirectoryPath -DataDir $DataDir
    return [System.IO.Path]::GetFullPath(
        (Join-Path $resolvedDataDir 'managed-chatgpt.ico')
    )
}

function Test-CodexLocalRemoteManagedDesktopIcon {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
        return $false
    }
    try {
        $item = Get-Item -LiteralPath $resolvedPath -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            $item.Length -lt 128 -or
            $item.Length -gt 4194304) {
            return $false
        }
        $stream = [System.IO.File]::Open(
            $resolvedPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        try {
            $header = [byte[]]::new(6)
            if ($stream.Read($header, 0, $header.Length) -ne $header.Length) {
                return $false
            }
            return (
                $header[0] -eq 0 -and
                $header[1] -eq 0 -and
                $header[2] -eq 1 -and
                $header[3] -eq 0 -and
                ($header[4] -ne 0 -or $header[5] -ne 0)
            )
        } finally {
            $stream.Dispose()
        }
    } catch {
        return $false
    }
}

function Install-CodexLocalRemoteManagedDesktopIcon {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [string]$DesktopExecutablePath
    )

    $resolvedDataDir = Assert-CodexLocalRemoteDataDirectoryPath -DataDir $DataDir
    $resolvedExecutable = [System.IO.Path]::GetFullPath($DesktopExecutablePath)
    if (-not (Test-CodexDesktopRuntimeOrdinaryFile -Path $resolvedExecutable)) {
        throw "ChatGPT Desktop executable is missing or unsafe: '$resolvedExecutable'."
    }
    $null = [System.IO.Directory]::CreateDirectory($resolvedDataDir)
    $iconPath = Get-CodexLocalRemoteManagedDesktopIconPath -DataDir $resolvedDataDir
    $temporaryPath = Join-Path (
        Split-Path -Parent $iconPath
    ) ".$([guid]::NewGuid().ToString('N')).ico"
    $icon = $null
    $stream = $null
    try {
        Add-Type -AssemblyName System.Drawing -ErrorAction Stop
        $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($resolvedExecutable)
        if ($null -eq $icon) {
            throw "ChatGPT Desktop does not expose an associated icon: '$resolvedExecutable'."
        }
        $stream = [System.IO.File]::Open(
            $temporaryPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $icon.Save($stream)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        if (-not (Test-CodexLocalRemoteManagedDesktopIcon -Path $temporaryPath)) {
            throw 'The extracted ChatGPT Desktop icon failed ICO validation.'
        }
        $newHash = (
            Get-FileHash -LiteralPath $temporaryPath -Algorithm SHA256 -ErrorAction Stop
        ).Hash
        if ((Test-CodexLocalRemoteManagedDesktopIcon -Path $iconPath) -and
            (Get-FileHash -LiteralPath $iconPath -Algorithm SHA256 -ErrorAction Stop).Hash -ceq
                $newHash) {
            return [pscustomobject]@{
                Status = 'reused'
                IconPath = $iconPath
            }
        }
        $status = if (Test-Path -LiteralPath $iconPath) {
            'refreshed'
        } else {
            'created'
        }
        Move-Item -LiteralPath $temporaryPath -Destination $iconPath -Force
        if (-not (Test-CodexLocalRemoteManagedDesktopIcon -Path $iconPath)) {
            throw 'The installed ChatGPT Desktop icon failed exact verification.'
        }
        return [pscustomobject]@{
            Status = $status
            IconPath = $iconPath
        }
    } finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
        if ($null -ne $icon) {
            $icon.Dispose()
        }
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
}

function Remove-CodexLocalRemoteManagedDesktopIcon {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $iconPath = Get-CodexLocalRemoteManagedDesktopIconPath -DataDir $DataDir
    if (-not (Test-Path -LiteralPath $iconPath)) {
        return [pscustomobject]@{
            Status = 'not-found'
            IconPath = $iconPath
        }
    }
    if (-not (Test-CodexLocalRemoteManagedDesktopIcon -Path $iconPath)) {
        throw "Managed ChatGPT icon '$iconPath' is not an exact ordinary ICO file; refusing to remove it."
    }
    Remove-Item -LiteralPath $iconPath -Force
    return [pscustomobject]@{
        Status = 'removed'
        IconPath = $iconPath
    }
}

function Assert-CodexLocalRemoteDataDirectoryPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    if ([string]::IsNullOrWhiteSpace($DataDir)) {
        throw 'Managed data directory path is empty.'
    }
    $resolvedDataDir = [System.IO.Path]::TrimEndingDirectorySeparator(
        [System.IO.Path]::GetFullPath($DataDir)
    )
    $filesystemRoot = [System.IO.Path]::GetPathRoot($resolvedDataDir)
    if ([string]::IsNullOrWhiteSpace($filesystemRoot) -or
        [string]::Equals(
            $resolvedDataDir,
            [System.IO.Path]::TrimEndingDirectorySeparator(
                [System.IO.Path]::GetFullPath($filesystemRoot)
            ),
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw "Managed data directory '$resolvedDataDir' is a filesystem root; refusing any ACL change or recursive enumeration."
    }
    return $resolvedDataDir
}

function Assert-CodexLocalRemoteDataDirectoryAncestors {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $currentPath = [System.IO.Path]::GetFullPath($DataDir)
    while (-not [string]::IsNullOrWhiteSpace($currentPath)) {
        if (Test-Path -LiteralPath $currentPath) {
            $item = Get-Item -LiteralPath $currentPath -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Managed data directory path crosses ancestor reparse point '$currentPath'; refusing any write or ACL change."
            }
        }
        $parent = [System.IO.Directory]::GetParent($currentPath)
        if ($null -eq $parent -or
            [string]::Equals(
                $parent.FullName,
                $currentPath,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
            break
        }
        $currentPath = $parent.FullName
    }
}

function Assert-CodexLocalRemoteManagedDataItemPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [string]$ItemPath
    )

    $resolvedDataDir = Assert-CodexLocalRemoteDataDirectoryPath -DataDir $DataDir
    $resolvedItemPath = [System.IO.Path]::GetFullPath($ItemPath)
    $requiredPrefix = "$resolvedDataDir$([System.IO.Path]::DirectorySeparatorChar)"
    if (-not $resolvedItemPath.StartsWith(
        $requiredPrefix,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Managed data item '$resolvedItemPath' is outside '$resolvedDataDir'."
    }
    $currentPath = $resolvedItemPath
    while (-not [string]::Equals(
        $currentPath,
        $resolvedDataDir,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        $item = Get-Item -LiteralPath $currentPath -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Managed data item path crosses reparse point '$currentPath'."
        }
        $parent = [System.IO.Directory]::GetParent($currentPath)
        if ($null -eq $parent) {
            throw "Managed data item '$resolvedItemPath' has no verified data-directory ancestor."
        }
        $currentPath = $parent.FullName
    }
    Assert-CodexLocalRemoteDataDirectoryAncestors -DataDir $resolvedDataDir
    return $resolvedItemPath
}

function Get-CodexLocalRemoteCurrentUserSid {
    [CmdletBinding()]
    param()

    $currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($null -eq $currentUserSid -or
        [string]::IsNullOrWhiteSpace($currentUserSid.Value)) {
        throw 'The current Windows identity has no security identifier; refusing to claim or protect managed state.'
    }
    return $currentUserSid
}

function Test-CodexLocalRemoteManagedEphemeralFileName {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name
    )

    return (
        $Name -cmatch '^\..+\.[0-9a-f]{32}\.tmp$' -or
        $Name -cmatch '^\.(?:state|turn-outbox)-[1-9][0-9]*-[0-9a-f]{12}\.tmp$' -or
        $Name -cmatch '^app-server-upstream\.token\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$'
    )
}

function Get-CodexLocalRemoteManagedDataItemAcl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [string]$ItemPath
    )

    try {
        $currentPath = Assert-CodexLocalRemoteManagedDataItemPath `
            -DataDir $DataDir `
            -ItemPath $ItemPath
        $currentItem = Get-Item -LiteralPath $currentPath -Force -ErrorAction Stop
        if (($currentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Managed data directory contains reparse point '$currentPath'."
        }
        return [pscustomobject]@{
            Item = $currentItem
            Acl = Get-Acl -LiteralPath $currentPath -ErrorAction Stop
        }
    } catch [System.Management.Automation.ItemNotFoundException] {
        return $null
    } catch [System.IO.FileNotFoundException] {
        return $null
    } catch [System.IO.DirectoryNotFoundException] {
        return $null
    }
}

function Get-CodexLocalRemoteDataDirectoryItems {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $resolvedDataDir = Assert-CodexLocalRemoteDataDirectoryPath -DataDir $DataDir
    Assert-CodexLocalRemoteDataDirectoryAncestors -DataDir $resolvedDataDir
    $root = Get-Item -LiteralPath $resolvedDataDir -Force
    if (-not $root.PSIsContainer) {
        throw "Managed data directory path '$resolvedDataDir' is not a directory."
    }
    if (($root.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Managed data directory '$resolvedDataDir' is a reparse point; refusing to inspect or write protected state through it."
    }

    $items = [System.Collections.Generic.List[object]]::new()
    $pending = [System.Collections.Generic.Queue[string]]::new()
    $pending.Enqueue($resolvedDataDir)
    while ($pending.Count -gt 0) {
        $directoryPath = $pending.Dequeue()
        if ([string]::Equals(
            $directoryPath,
            $resolvedDataDir,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            Assert-CodexLocalRemoteDataDirectoryAncestors -DataDir $resolvedDataDir
        } else {
            $null = Assert-CodexLocalRemoteManagedDataItemPath `
                -DataDir $resolvedDataDir `
                -ItemPath $directoryPath
        }
        $directory = Get-Item -LiteralPath $directoryPath -Force
        if (-not $directory.PSIsContainer -or
            ($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Managed data directory contains reparse point or non-directory ancestor '$directoryPath'."
        }
        foreach ($item in @(Get-ChildItem -LiteralPath $directoryPath -Force)) {
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Managed data directory contains reparse point '$($item.FullName)'."
            }
            if (-not $item.PSIsContainer -and
                (Test-CodexLocalRemoteManagedEphemeralFileName -Name $item.Name)) {
                continue
            }
            $items.Add($item)
            if ($item.PSIsContainer) {
                $pending.Enqueue($item.FullName)
            }
        }
    }
    return @($items)
}

function Test-CodexLocalRemoteBroadKnownFolder {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $knownFolders = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $candidates = [System.Collections.Generic.List[string]]::new()
    foreach ($environmentPath in @(
        $env:USERPROFILE,
        $env:LOCALAPPDATA,
        $env:APPDATA,
        $env:PROGRAMDATA,
        $env:TEMP,
        $env:TMP,
        $env:SystemRoot,
        $env:ProgramFiles,
        ${env:ProgramFiles(x86)},
        $env:OneDrive
    )) {
        if (-not [string]::IsNullOrWhiteSpace($environmentPath)) {
            $candidates.Add($environmentPath)
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($env:HOMEDRIVE) -and
        -not [string]::IsNullOrWhiteSpace($env:HOMEPATH)) {
        $candidates.Add("$env:HOMEDRIVE$env:HOMEPATH")
    }
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        foreach ($child in @(
            'Desktop',
            'Documents',
            'Downloads',
            'Music',
            'Pictures',
            'Videos'
        )) {
            $candidates.Add((Join-Path $env:USERPROFILE $child))
        }
    }
    foreach ($specialFolder in @(
        [System.Environment+SpecialFolder]::UserProfile,
        [System.Environment+SpecialFolder]::Desktop,
        [System.Environment+SpecialFolder]::MyDocuments,
        [System.Environment+SpecialFolder]::MyMusic,
        [System.Environment+SpecialFolder]::MyPictures,
        [System.Environment+SpecialFolder]::MyVideos,
        [System.Environment+SpecialFolder]::LocalApplicationData,
        [System.Environment+SpecialFolder]::ApplicationData,
        [System.Environment+SpecialFolder]::CommonApplicationData,
        [System.Environment+SpecialFolder]::ProgramFiles,
        [System.Environment+SpecialFolder]::ProgramFilesX86,
        [System.Environment+SpecialFolder]::Windows,
        [System.Environment+SpecialFolder]::System
    )) {
        $candidate = [System.Environment]::GetFolderPath($specialFolder)
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            $candidates.Add($candidate)
        }
    }

    foreach ($candidate in $candidates) {
        try {
            $canonicalCandidate = [System.IO.Path]::TrimEndingDirectorySeparator(
                [System.IO.Path]::GetFullPath($candidate)
            )
            $null = $knownFolders.Add($canonicalCandidate)
        } catch {
            # An unusable environment candidate cannot own the requested path.
        }
    }
    return $knownFolders.Contains(
        (Assert-CodexLocalRemoteDataDirectoryPath -DataDir $DataDir)
    )
}

function Test-CodexLocalRemotePathInsideGitRepository {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $resolvedDataDir = Assert-CodexLocalRemoteDataDirectoryPath -DataDir $DataDir
    $current = if (Test-Path -LiteralPath $resolvedDataDir -PathType Container) {
        $resolvedDataDir
    } else {
        [System.IO.Directory]::GetParent($resolvedDataDir).FullName
    }
    while (-not [string]::IsNullOrWhiteSpace($current)) {
        $dotGit = Join-Path $current '.git'
        if (Test-Path -LiteralPath $dotGit) {
            return $true
        }
        if ((Test-Path -LiteralPath (Join-Path $current 'HEAD') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $current 'config') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $current 'objects') -PathType Container) -and
            (
                (Test-Path -LiteralPath (Join-Path $current 'refs') -PathType Container) -or
                (Test-Path -LiteralPath (Join-Path $current 'packed-refs') -PathType Leaf)
            )) {
            return $true
        }
        $parent = [System.IO.Directory]::GetParent($current)
        if ($null -eq $parent -or
            [string]::Equals(
                $parent.FullName,
                $current,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
            break
        }
        $current = $parent.FullName
    }
    return $false
}

function Get-CodexLocalRemoteFileHardLinkCount {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    if (-not ('CodexLocalRemote.FileIdentityNativeMethods' -as [type])) {
        $typeDefinition = @'
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace CodexLocalRemote
{
    [StructLayout(LayoutKind.Sequential)]
    public struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    public static class FileIdentityNativeMethods
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetFileInformationByHandle(
            SafeFileHandle fileHandle,
            out ByHandleFileInformation fileInformation
        );
    }
}
'@
        $null = Add-Type -TypeDefinition $typeDefinition -Language CSharp -ErrorAction Stop
    }

    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    $stream = $null
    try {
        $stream = [System.IO.File]::Open(
            $resolvedPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        $information = [CodexLocalRemote.ByHandleFileInformation]::new()
        if (-not [CodexLocalRemote.FileIdentityNativeMethods]::GetFileInformationByHandle(
                $stream.SafeFileHandle,
                [ref]$information
            )) {
            $win32Error = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw "Windows rejected the file identity query (Win32 error $win32Error)."
        }
        return [uint32]$information.NumberOfLinks
    } catch {
        throw "Unable to verify the data directory owner marker file identity: $($_.Exception.Message)"
    } finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
    }
}

function Assert-CodexLocalRemoteDataDirectoryOwnerMarker {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $resolvedDataDir = Assert-CodexLocalRemoteDataDirectoryPath -DataDir $DataDir
    $markerPath = Join-Path $resolvedDataDir $script:DataDirectoryOwnerMarkerName
    if (-not (Test-Path -LiteralPath $markerPath)) {
        throw "Data directory owner marker '$markerPath' is missing."
    }
    $item = Get-Item -LiteralPath $markerPath -Force
    if ($item.PSIsContainer -or
        ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Data directory owner marker '$markerPath' is not an ordinary file."
    }
    if ($item.Length -le 0 -or
        $item.Length -gt $script:DataDirectoryOwnerMarkerMaxBytes) {
        throw "Data directory owner marker '$markerPath' is not a small managed file."
    }
    $linkTypeProperty = $item.PSObject.Properties['LinkType']
    if ($null -ne $linkTypeProperty -and
        [string]$linkTypeProperty.Value -ceq 'HardLink') {
        throw "Data directory owner marker '$markerPath' is a hard link."
    }
    $hardLinkCount = Get-CodexLocalRemoteFileHardLinkCount -Path $markerPath
    if ($hardLinkCount -ne 1) {
        throw "Data directory owner marker '$markerPath' is a hard link with multiple names."
    }

    try {
        $rawMarker = [System.IO.File]::ReadAllText(
            $markerPath,
            [System.Text.UTF8Encoding]::new($false, $true)
        )
        $jsonOptions = [System.Text.Json.JsonDocumentOptions]::new()
        $jsonOptions.AllowTrailingCommas = $false
        $jsonOptions.CommentHandling = [System.Text.Json.JsonCommentHandling]::Disallow
        $jsonOptions.MaxDepth = 8
        $document = [System.Text.Json.JsonDocument]::Parse(
            $rawMarker,
            $jsonOptions
        )
    } catch {
        throw "Data directory owner marker '$markerPath' is damaged or invalid JSON."
    }
    try {
        if ($document.RootElement.ValueKind -ne
            [System.Text.Json.JsonValueKind]::Object) {
            throw "Data directory owner marker '$markerPath' does not have the exact managed fields."
        }
        $properties = [System.Collections.Generic.Dictionary[
            string,
            System.Text.Json.JsonElement
        ]]::new([System.StringComparer]::Ordinal)
        foreach ($property in $document.RootElement.EnumerateObject()) {
            if (-not $properties.TryAdd($property.Name, $property.Value.Clone())) {
                throw "Data directory owner marker '$markerPath' has a duplicate managed field."
            }
        }
        $expectedProperties = @(
            'Signature',
            'Version',
            'CanonicalPath',
            'OwnerSid',
            'InstanceId'
        )
        if ($properties.Count -ne $expectedProperties.Count -or
            @($expectedProperties | Where-Object {
                -not $properties.ContainsKey($_)
            }).Count -gt 0) {
            throw "Data directory owner marker '$markerPath' does not have the exact managed fields."
        }

        $signatureElement = $properties['Signature']
        if ($signatureElement.ValueKind -ne
            [System.Text.Json.JsonValueKind]::String -or
            $signatureElement.GetString() -cne $script:DataDirectoryOwnerSignature) {
            throw "Data directory owner marker '$markerPath' has the wrong signature."
        }
        $version = 0
        $versionElement = $properties['Version']
        if ($versionElement.ValueKind -ne
            [System.Text.Json.JsonValueKind]::Number -or
            -not $versionElement.TryGetInt32([ref]$version) -or
            $version -ne 1) {
            throw "Data directory owner marker '$markerPath' has the wrong version."
        }
        $canonicalPathElement = $properties['CanonicalPath']
        $canonicalPath = if ($canonicalPathElement.ValueKind -eq
            [System.Text.Json.JsonValueKind]::String) {
            $canonicalPathElement.GetString()
        } else {
            $null
        }
        if ([string]::IsNullOrWhiteSpace($canonicalPath) -or
            -not [string]::Equals(
                $canonicalPath,
                $resolvedDataDir,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
            throw "Data directory owner marker '$markerPath' belongs to a different canonical path."
        }
        $ownerSidElement = $properties['OwnerSid']
        $ownerSid = if ($ownerSidElement.ValueKind -eq
            [System.Text.Json.JsonValueKind]::String) {
            $ownerSidElement.GetString()
        } else {
            $null
        }
        $currentUserSid = Get-CodexLocalRemoteCurrentUserSid
        if ($ownerSid -cne $currentUserSid.Value) {
            throw "Data directory owner marker '$markerPath' belongs to a different Windows SID."
        }
        $instanceIdElement = $properties['InstanceId']
        $instanceIdText = if ($instanceIdElement.ValueKind -eq
            [System.Text.Json.JsonValueKind]::String) {
            $instanceIdElement.GetString()
        } else {
            $null
        }
        $instanceId = [guid]::Empty
        if ([string]::IsNullOrWhiteSpace($instanceIdText) -or
            -not [guid]::TryParseExact(
                $instanceIdText,
                'D',
                [ref]$instanceId
            )) {
            throw "Data directory owner marker '$markerPath' has an invalid instance id."
        }
    } finally {
        $document.Dispose()
    }
    return [pscustomobject]@{
        MarkerPath = $markerPath
        InstanceId = $instanceId.ToString('D')
        OwnerSid = $currentUserSid.Value
    }
}

function Test-CodexLocalRemoteLegacyTemporaryFileName {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name
    )

    return (
        $Name -cmatch '^\.(?:startup-last\.json|app-server-broker\.json|windows-broker-environment\.json)\.[0-9a-f]{32}\.tmp$' -or
        $Name -cmatch '^\.broker-capability\.token\.[0-9a-f]{32}\.tmp$' -or
        $Name -cmatch '^\.state-[1-9][0-9]*-[0-9a-f]{12}\.tmp$' -or
        $Name -cmatch '^app-server-upstream\.token\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$' -or
        $Name -cmatch '^\.\.codex-local-remote-data-owner\.json\.[0-9a-f]{32}\.tmp$'
    )
}

function Assert-CodexLocalRemoteLegacyDataDirectoryContents {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $resolvedDataDir = Assert-CodexLocalRemoteDataDirectoryPath -DataDir $DataDir
    $null = Get-CodexLocalRemoteDataDirectoryItems -DataDir $resolvedDataDir
    foreach ($item in @(Get-ChildItem -LiteralPath $resolvedDataDir -Force)) {
        if ($item.Name -iin $script:LegacyDataDirectoryFiles) {
            if ($item.PSIsContainer) {
                throw "Legacy managed data entry '$($item.FullName)' has the wrong type; expected a file."
            }
            continue
        }
        if ($item.Name -iin $script:LegacyDataDirectoryDirectories) {
            if (-not $item.PSIsContainer) {
                throw "Legacy managed data entry '$($item.FullName)' has the wrong type; expected a directory."
            }
            continue
        }
        if (-not $item.PSIsContainer -and
            (Test-CodexLocalRemoteLegacyTemporaryFileName -Name $item.Name)) {
            continue
        }
        throw "Legacy managed data directory contains unknown entry '$($item.FullName)'."
    }
}

function Get-CodexLocalRemoteDataDirectoryOwnershipPlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $resolvedDataDir = Assert-CodexLocalRemoteDataDirectoryPath -DataDir $DataDir
    Assert-CodexLocalRemoteDataDirectoryAncestors -DataDir $resolvedDataDir
    if (Test-CodexLocalRemoteBroadKnownFolder -DataDir $resolvedDataDir) {
        throw "Managed data directory '$resolvedDataDir' is a broad known folder; refusing to claim it."
    }
    if (Test-CodexLocalRemotePathInsideGitRepository -DataDir $resolvedDataDir) {
        throw "Managed data directory '$resolvedDataDir' is inside a Git worktree or bare repository; refusing to claim or modify it."
    }
    if (-not (Test-Path -LiteralPath $resolvedDataDir)) {
        return [pscustomobject]@{
            Action = 'create'
            DataDir = $resolvedDataDir
            MarkerPath = Join-Path $resolvedDataDir $script:DataDirectoryOwnerMarkerName
        }
    }
    if (-not (Test-Path -LiteralPath $resolvedDataDir -PathType Container)) {
        throw "Managed data directory path '$resolvedDataDir' is not a directory."
    }
    $root = Get-Item -LiteralPath $resolvedDataDir -Force
    if (($root.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Managed data directory '$resolvedDataDir' is a reparse point; refusing to claim or protect it."
    }
    $items = @(Get-ChildItem -LiteralPath $resolvedDataDir -Force)
    foreach ($item in $items) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Managed data directory contains reparse point '$($item.FullName)'."
        }
    }
    $markerPath = Join-Path $resolvedDataDir $script:DataDirectoryOwnerMarkerName
    if (Test-Path -LiteralPath $markerPath) {
        $marker = Assert-CodexLocalRemoteDataDirectoryOwnerMarker -DataDir $resolvedDataDir
        $null = Get-CodexLocalRemoteDataDirectoryItems -DataDir $resolvedDataDir
        return [pscustomobject]@{
            Action = 'owned'
            DataDir = $resolvedDataDir
            MarkerPath = $marker.MarkerPath
            InstanceId = $marker.InstanceId
        }
    }
    if ($items.Count -eq 0) {
        return [pscustomobject]@{
            Action = 'claim'
            DataDir = $resolvedDataDir
            MarkerPath = $markerPath
        }
    }

    $defaultDataDir = if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $null
    } else {
        Assert-CodexLocalRemoteDataDirectoryPath -DataDir (
            Join-Path $env:LOCALAPPDATA 'CodexLocalRemote'
        )
    }
    if ($null -eq $defaultDataDir -or
        -not [string]::Equals(
            $resolvedDataDir,
            $defaultDataDir,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw "Custom managed data directory '$resolvedDataDir' is non-empty and has no valid owner marker; refusing legacy adoption."
    }
    Assert-CodexLocalRemoteLegacyDataDirectoryContents -DataDir $resolvedDataDir
    return [pscustomobject]@{
        Action = 'adopt'
        DataDir = $resolvedDataDir
        MarkerPath = $markerPath
    }
}

function Test-CodexLocalRemoteDataAcl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [System.Security.AccessControl.FileSystemSecurity]$Acl,

        [Parameter(Mandatory)]
        [string[]]$AllowedSidValues,

        [switch]$Inherited
    )

    $rules = @($Acl.GetAccessRules(
        $true,
        $true,
        [System.Security.Principal.SecurityIdentifier]
    ))
    if ($rules.Count -ne $AllowedSidValues.Count) {
        return $false
    }
    $appliedSidValues = @($rules | ForEach-Object { $_.IdentityReference.Value })
    if (@($AllowedSidValues | Where-Object { $_ -notin $appliedSidValues }).Count -gt 0) {
        return $false
    }

    if ($Inherited) {
        if ($Acl.AreAccessRulesProtected) {
            return $false
        }
        return @(
            $rules | Where-Object {
                $_.IdentityReference.Value -notin $AllowedSidValues -or
                $_.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
                $_.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
                -not $_.IsInherited
            }
        ).Count -eq 0
    }

    if (-not $Acl.AreAccessRulesProtected) {
        return $false
    }
    $requiredInheritance = (
        [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    )
    return @(
        $rules | Where-Object {
            $_.IdentityReference.Value -notin $AllowedSidValues -or
            $_.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
            $_.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
            $_.InheritanceFlags -ne $requiredInheritance -or
            $_.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None -or
            $_.IsInherited
        }
    ).Count -eq 0
}

function Get-CodexLocalRemoteDataAclContext {
    [CmdletBinding()]
    param()

    $currentUserSid = Get-CodexLocalRemoteCurrentUserSid
    $allowedSids = @(
        $currentUserSid,
        [System.Security.Principal.SecurityIdentifier]::new(
            [System.Security.Principal.WellKnownSidType]::LocalSystemSid,
            $null
        ),
        [System.Security.Principal.SecurityIdentifier]::new(
            [System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid,
            $null
        )
    )
    return [pscustomobject]@{
        AllowedSids = $allowedSids
        AllowedSidValues = @($allowedSids | ForEach-Object { $_.Value })
    }
}

function Test-CodexLocalRemoteDataAclTree {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [object]$AclContext
    )

    $resolvedDataDir = Assert-CodexLocalRemoteDataDirectoryPath -DataDir $DataDir
    $null = Assert-CodexLocalRemoteDataDirectoryOwnerMarker -DataDir $resolvedDataDir
    $items = @(Get-CodexLocalRemoteDataDirectoryItems -DataDir $resolvedDataDir)
    $rootAcl = Get-Acl -LiteralPath $resolvedDataDir
    if (-not (Test-CodexLocalRemoteDataAcl `
        -Acl $rootAcl `
        -AllowedSidValues $AclContext.AllowedSidValues)) {
        return $false
    }
    foreach ($item in $items) {
        $itemState = Get-CodexLocalRemoteManagedDataItemAcl `
            -DataDir $resolvedDataDir `
            -ItemPath $item.FullName
        if ($null -eq $itemState) {
            continue
        }
        $itemAcl = $itemState.Acl
        if (-not (Test-CodexLocalRemoteDataAcl `
            -Acl $itemAcl `
            -AllowedSidValues $AclContext.AllowedSidValues `
            -Inherited)) {
            return $false
        }
    }
    return $true
}

function Assert-CodexLocalRemoteDataDirectoryStartupProtection {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    # Startup and atomic state writes must not recursively walk immutable
    # runtime packages. Registration performs the full descendant ACL repair;
    # this bounded gate revalidates the exact owner, root ACL and immediate
    # path boundary before the Broker is allowed to start or state is written.
    $resolvedDataDir = Assert-CodexLocalRemoteDataDirectoryPath -DataDir $DataDir
    Assert-CodexLocalRemoteDataDirectoryAncestors -DataDir $resolvedDataDir
    if (Test-CodexLocalRemoteBroadKnownFolder -DataDir $resolvedDataDir) {
        throw "Managed data directory '$resolvedDataDir' is a broad known folder."
    }
    if (Test-CodexLocalRemotePathInsideGitRepository -DataDir $resolvedDataDir) {
        throw "Managed data directory '$resolvedDataDir' is inside a Git repository."
    }
    if (-not (Test-Path -LiteralPath $resolvedDataDir -PathType Container)) {
        throw "Managed data directory '$resolvedDataDir' is unavailable."
    }
    $root = Get-Item -LiteralPath $resolvedDataDir -Force
    if (($root.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Managed data directory '$resolvedDataDir' is a reparse point."
    }
    foreach ($item in @(Get-ChildItem -LiteralPath $resolvedDataDir -Force)) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Managed data directory contains immediate reparse point '$($item.FullName)'."
        }
    }

    $marker = Assert-CodexLocalRemoteDataDirectoryOwnerMarker `
        -DataDir $resolvedDataDir
    $aclContext = Get-CodexLocalRemoteDataAclContext
    $rootAcl = Get-Acl -LiteralPath $resolvedDataDir
    if (-not (Test-CodexLocalRemoteDataAcl `
        -Acl $rootAcl `
        -AllowedSidValues $aclContext.AllowedSidValues)) {
        throw "Managed data directory '$resolvedDataDir' no longer has the required protected root ACL."
    }

    return [pscustomobject]@{
        Status = 'startup-protected'
        DataDir = $resolvedDataDir
        MarkerPath = $marker.MarkerPath
        InstanceId = $marker.InstanceId
    }
}

function New-CodexLocalRemoteDataDirectoryOwnerMarker {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $resolvedDataDir = Assert-CodexLocalRemoteDataDirectoryPath -DataDir $DataDir
    Assert-CodexLocalRemoteDataDirectoryAncestors -DataDir $resolvedDataDir
    $root = Get-Item -LiteralPath $resolvedDataDir -Force
    if (-not $root.PSIsContainer -or
        ($root.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Managed data directory '$resolvedDataDir' changed before owner marker creation."
    }
    $markerPath = Join-Path $resolvedDataDir $script:DataDirectoryOwnerMarkerName
    if (Test-Path -LiteralPath $markerPath) {
        throw "Data directory owner marker '$markerPath' already exists; refusing to overwrite it."
    }
    $currentUserSid = Get-CodexLocalRemoteCurrentUserSid
    $instanceId = [guid]::NewGuid().ToString('D')
    $json = [ordered]@{
        Signature = $script:DataDirectoryOwnerSignature
        Version = 1
        CanonicalPath = $resolvedDataDir
        OwnerSid = $currentUserSid.Value
        InstanceId = $instanceId
    } | ConvertTo-Json -Compress
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json)
    if ($bytes.Length -gt $script:DataDirectoryOwnerMarkerMaxBytes) {
        throw 'Generated data directory owner marker unexpectedly exceeds the size limit.'
    }
    $temporaryPath = Join-Path $resolvedDataDir (
        ".$script:DataDirectoryOwnerMarkerName.$([guid]::NewGuid().ToString('N')).tmp"
    )
    try {
        Assert-CodexLocalRemoteDataDirectoryAncestors -DataDir $resolvedDataDir
        $null = Get-CodexLocalRemoteDataDirectoryItems -DataDir $resolvedDataDir
        $root = Get-Item -LiteralPath $resolvedDataDir -Force
        if (($root.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Managed data directory '$resolvedDataDir' changed before owner marker creation."
        }
        $stream = [System.IO.FileStream]::new(
            $temporaryPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        } finally {
            $stream.Dispose()
        }

        Assert-CodexLocalRemoteDataDirectoryAncestors -DataDir $resolvedDataDir
        $null = Get-CodexLocalRemoteDataDirectoryItems -DataDir $resolvedDataDir
        $root = Get-Item -LiteralPath $resolvedDataDir -Force
        if (($root.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Managed data directory '$resolvedDataDir' changed before owner marker publication."
        }
        if (Test-Path -LiteralPath $markerPath) {
            throw "Data directory owner marker '$markerPath' appeared during claim; refusing to overwrite it."
        }
        [System.IO.File]::Move($temporaryPath, $markerPath)
        return Assert-CodexLocalRemoteDataDirectoryOwnerMarker -DataDir $resolvedDataDir
    } finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
        try {
            Assert-CodexLocalRemoteDataDirectoryAncestors -DataDir $resolvedDataDir
            if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
                $temporaryItem = Get-Item -LiteralPath $temporaryPath -Force
                if (($temporaryItem.Attributes -band
                    [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
                    Remove-Item -LiteralPath $temporaryPath -Force
                }
            }
        } catch {
            # A leftover uniquely named temp file is safer than deleting through drift.
        }
    }
}

function Repair-CodexLocalRemoteDataDirectoryAcl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [object]$AclContext
    )

    $resolvedDataDir = Assert-CodexLocalRemoteDataDirectoryPath -DataDir $DataDir
    $null = Assert-CodexLocalRemoteDataDirectoryOwnerMarker -DataDir $resolvedDataDir
    $null = Get-CodexLocalRemoteDataDirectoryItems -DataDir $resolvedDataDir

    $rootAcl = Get-Acl -LiteralPath $resolvedDataDir
    if (-not (Test-CodexLocalRemoteDataAcl `
        -Acl $rootAcl `
        -AllowedSidValues $AclContext.AllowedSidValues)) {
        $rootAcl.SetAccessRuleProtection($true, $false)
        foreach ($rule in @($rootAcl.GetAccessRules(
            $true,
            $true,
            [System.Security.Principal.SecurityIdentifier]
        ))) {
            $rootAcl.RemoveAccessRuleSpecific($rule)
        }
        foreach ($sid in $AclContext.AllowedSids) {
            $rootAcl.AddAccessRule(
                [System.Security.AccessControl.FileSystemAccessRule]::new(
                    $sid,
                    [System.Security.AccessControl.FileSystemRights]::FullControl,
                    (
                        [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
                        [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
                    ),
                    [System.Security.AccessControl.PropagationFlags]::None,
                    [System.Security.AccessControl.AccessControlType]::Allow
                )
            )
        }
        $null = Assert-CodexLocalRemoteDataDirectoryOwnerMarker -DataDir $resolvedDataDir
        Assert-CodexLocalRemoteDataDirectoryAncestors -DataDir $resolvedDataDir
        $null = Get-CodexLocalRemoteDataDirectoryItems -DataDir $resolvedDataDir
        [System.IO.FileSystemAclExtensions]::SetAccessControl(
            [System.IO.DirectoryInfo]::new($resolvedDataDir),
            $rootAcl
        )
        $rootAcl = Get-Acl -LiteralPath $resolvedDataDir
        if (-not (Test-CodexLocalRemoteDataAcl `
            -Acl $rootAcl `
            -AllowedSidValues $AclContext.AllowedSidValues)) {
            throw "Managed data directory '$resolvedDataDir' did not retain the required protected ACL."
        }
    }

    foreach ($item in @(Get-CodexLocalRemoteDataDirectoryItems -DataDir $resolvedDataDir)) {
        $itemAcl = Get-Acl -LiteralPath $item.FullName
        if (Test-CodexLocalRemoteDataAcl `
            -Acl $itemAcl `
            -AllowedSidValues $AclContext.AllowedSidValues `
            -Inherited) {
            continue
        }
        foreach ($rule in @($itemAcl.GetAccessRules(
            $true,
            $false,
            [System.Security.Principal.SecurityIdentifier]
        ))) {
            $itemAcl.RemoveAccessRuleSpecific($rule)
        }
        $itemAcl.SetAccessRuleProtection($false, $false)
        $null = Assert-CodexLocalRemoteDataDirectoryOwnerMarker -DataDir $resolvedDataDir
        $currentItemPath = Assert-CodexLocalRemoteManagedDataItemPath `
            -DataDir $resolvedDataDir `
            -ItemPath $item.FullName
        $currentItem = Get-Item -LiteralPath $currentItemPath -Force
        if ($currentItem.PSIsContainer) {
            [System.IO.FileSystemAclExtensions]::SetAccessControl(
                [System.IO.DirectoryInfo]::new($item.FullName),
                $itemAcl
            )
        } else {
            [System.IO.FileSystemAclExtensions]::SetAccessControl(
                [System.IO.FileInfo]::new($item.FullName),
                $itemAcl
            )
        }
        $itemAcl = Get-Acl -LiteralPath $item.FullName
        if (-not (Test-CodexLocalRemoteDataAcl `
            -Acl $itemAcl `
            -AllowedSidValues $AclContext.AllowedSidValues `
            -Inherited)) {
            throw "Existing managed data item '$($item.FullName)' did not inherit the required protected ACL."
        }
    }
}

function Set-CodexLocalRemoteDataDirectoryProtectionCache {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [string]$InstanceId
    )

    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
    $script:DataDirectoryProtectionCache[
        $resolvedDataDir.ToUpperInvariant()
    ] = [pscustomobject]@{
        InstanceId = $InstanceId
    }
}

function Test-CodexLocalRemoteDataDirectoryProtectionCache {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [string]$ExpectedInstanceId
    )

    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
    $cacheKey = $resolvedDataDir.ToUpperInvariant()
    if (-not $script:DataDirectoryProtectionCache.ContainsKey($cacheKey)) {
        return $false
    }
    $cached = $script:DataDirectoryProtectionCache[$cacheKey]
    if ([string]$cached.InstanceId -cne $ExpectedInstanceId) {
        $script:DataDirectoryProtectionCache.Remove($cacheKey)
        return $false
    }
    try {
        $bounded =
            Assert-CodexLocalRemoteDataDirectoryStartupProtection `
                -DataDir $resolvedDataDir
        if ([string]$bounded.InstanceId -cne $ExpectedInstanceId) {
            $script:DataDirectoryProtectionCache.Remove($cacheKey)
            return $false
        }
    } catch {
        $script:DataDirectoryProtectionCache.Remove($cacheKey)
        return $false
    }
    return $true
}

function Protect-CodexLocalRemoteDataDirectory {
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $plan = Get-CodexLocalRemoteDataDirectoryOwnershipPlan -DataDir $DataDir
    $resolvedDataDir = $plan.DataDir
    $aclContext = $null
    if ($plan.Action -ceq 'owned') {
        if (Test-CodexLocalRemoteDataDirectoryProtectionCache `
            -DataDir $resolvedDataDir `
            -ExpectedInstanceId ([string]$plan.InstanceId)) {
            return [pscustomobject]@{
                Status = 'already-protected'
                DataDir = $resolvedDataDir
                MarkerPath = $plan.MarkerPath
                InstanceId = $plan.InstanceId
            }
        }
        $aclContext = Get-CodexLocalRemoteDataAclContext
        try {
            if (Test-CodexLocalRemoteDataAclTree `
                -DataDir $resolvedDataDir `
                -AclContext $aclContext) {
                Set-CodexLocalRemoteDataDirectoryProtectionCache `
                    -DataDir $resolvedDataDir `
                    -InstanceId ([string]$plan.InstanceId)
                return [pscustomobject]@{
                    Status = 'already-protected'
                    DataDir = $resolvedDataDir
                    MarkerPath = $plan.MarkerPath
                    InstanceId = $plan.InstanceId
                }
            }
        } catch {
            throw "Failed to verify protected managed data directory '$resolvedDataDir'. $($_.Exception.Message)"
        }
        if ($WhatIfPreference) {
            return [pscustomobject]@{
                Status = 'would-repair'
                DataDir = $resolvedDataDir
                MarkerPath = $plan.MarkerPath
                InstanceId = $plan.InstanceId
            }
        }
    } elseif ($WhatIfPreference) {
        $previewStatus = if ($plan.Action -ceq 'adopt') {
            'would-adopt'
        } else {
            'would-create'
        }
        return [pscustomobject]@{
            Status = $previewStatus
            DataDir = $resolvedDataDir
            MarkerPath = $plan.MarkerPath
        }
    }

    if ($null -eq $aclContext) {
        $aclContext = Get-CodexLocalRemoteDataAclContext
    }

    if (-not $PSCmdlet.ShouldProcess(
        $resolvedDataDir,
        'Claim the exact managed data directory and apply its protected ACL'
    )) {
        return [pscustomobject]@{
            Status = 'not-protected'
            DataDir = $resolvedDataDir
            MarkerPath = $plan.MarkerPath
        }
    }

    $resultStatus = 'repaired'
    $marker = $null
    try {
        if ($plan.Action -ne 'owned') {
            if ($plan.Action -ceq 'create') {
                Assert-CodexLocalRemoteDataDirectoryAncestors -DataDir $resolvedDataDir
                $null = [System.IO.Directory]::CreateDirectory($resolvedDataDir)
                $postCreatePlan = Get-CodexLocalRemoteDataDirectoryOwnershipPlan `
                    -DataDir $resolvedDataDir
                if ($postCreatePlan.Action -cne 'claim') {
                    throw "New managed data directory '$resolvedDataDir' changed before it could be claimed."
                }
                $resultStatus = 'created'
            } elseif ($plan.Action -ceq 'claim') {
                $resultStatus = 'claimed'
            } else {
                $resultStatus = 'adopted'
            }
            $expectedAction = if ($plan.Action -ceq 'create') {
                'claim'
            } else {
                $plan.Action
            }
            $freshPlan = Get-CodexLocalRemoteDataDirectoryOwnershipPlan `
                -DataDir $resolvedDataDir
            if ($freshPlan.Action -cne $expectedAction) {
                throw "Managed data directory '$resolvedDataDir' changed before its owner marker could be published."
            }
            Assert-CodexLocalRemoteDataDirectoryAncestors -DataDir $resolvedDataDir
            $marker = New-CodexLocalRemoteDataDirectoryOwnerMarker `
                -DataDir $resolvedDataDir
        } else {
            $marker = Assert-CodexLocalRemoteDataDirectoryOwnerMarker `
                -DataDir $resolvedDataDir
        }
        Repair-CodexLocalRemoteDataDirectoryAcl `
            -DataDir $resolvedDataDir `
            -AclContext $aclContext
        Set-CodexLocalRemoteDataDirectoryProtectionCache `
            -DataDir $resolvedDataDir `
            -InstanceId ([string]$marker.InstanceId)
    } catch {
        throw "Failed to protect managed data directory '$resolvedDataDir'; refusing to write token, environment, or runtime state. $($_.Exception.Message)"
    }

    return [pscustomobject]@{
        Status = $resultStatus
        DataDir = $resolvedDataDir
        MarkerPath = $marker.MarkerPath
        InstanceId = $marker.InstanceId
    }
}

function Test-BrokerCapabilityToken {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [Parameter(Mandatory)]
        [string]$Token
    )

    return $Token.Length -ge 43 -and $Token -cmatch '^[A-Za-z0-9_-]+$'
}

function Read-BrokerCapabilityToken {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$TokenPath
    )

    $resolvedPath = [System.IO.Path]::GetFullPath($TokenPath)
    if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
        throw "Managed broker capability token file is missing at '$resolvedPath'."
    }
    $token = [System.IO.File]::ReadAllText($resolvedPath)
    if (-not (Test-BrokerCapabilityToken -Token $token)) {
        throw "The file '$resolvedPath' is not a valid managed capability token; refusing to replace or expose it."
    }
    return $token
}

function Install-BrokerCapabilityToken {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
    $null = Protect-CodexLocalRemoteDataDirectory -DataDir $resolvedDataDir
    $tokenPath = Get-BrokerCapabilityTokenPath -DataDir $resolvedDataDir
    if (Test-Path -LiteralPath $tokenPath) {
        if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
            throw "Managed broker capability token path '$tokenPath' is not a file."
        }
        $token = Read-BrokerCapabilityToken -TokenPath $tokenPath
        return [pscustomobject]@{
            Status = 'reused'
            TokenPath = $tokenPath
            TokenLength = $token.Length
        }
    }

    $randomBytes = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($randomBytes)
    $token = [Convert]::ToBase64String($randomBytes).
        TrimEnd('=').
        Replace('+', '-').
        Replace('/', '_')
    $temporary = Join-Path $resolvedDataDir ".$script:BrokerCapabilityTokenName.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [System.IO.File]::WriteAllText(
            $temporary,
            $token,
            [System.Text.UTF8Encoding]::new($false)
        )
        Move-Item -LiteralPath $temporary -Destination $tokenPath
    } finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        [Array]::Clear($randomBytes, 0, $randomBytes.Length)
    }
    return [pscustomobject]@{
        Status = 'created'
        TokenPath = $tokenPath
        TokenLength = $token.Length
    }
}

function Remove-BrokerCapabilityToken {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $tokenPath = Get-BrokerCapabilityTokenPath -DataDir $DataDir
    if (-not (Test-Path -LiteralPath $tokenPath)) {
        return [pscustomobject]@{ Status = 'not-found'; TokenPath = $tokenPath }
    }
    if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
        throw "Managed broker capability token path '$tokenPath' is not a file; refusing to remove it."
    }
    Remove-Item -LiteralPath $tokenPath -Force
    return [pscustomobject]@{ Status = 'removed'; TokenPath = $tokenPath }
}

function Get-BrokerCapabilityWebSocketUrl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$Port,

        [Parameter(Mandatory)]
        [string]$TokenPath
    )

    $token = Read-BrokerCapabilityToken -TokenPath $TokenPath
    return "ws://127.0.0.1:$Port/ws/$token"
}

function Get-StringSha256 {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [Parameter(Mandatory)]
        [string]$Value
    )

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    try {
        return [Convert]::ToHexString(
            [System.Security.Cryptography.SHA256]::HashData($bytes)
        ).ToLowerInvariant()
    } finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function Test-NonNegativeInteger {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [Parameter(Mandatory)]
        [object]$Value
    )

    if ($null -eq $Value) {
        return $false
    }
    $typeCode = [System.Type]::GetTypeCode($Value.GetType())
    if ($typeCode -notin @(
        [System.TypeCode]::Byte,
        [System.TypeCode]::UInt16,
        [System.TypeCode]::UInt32,
        [System.TypeCode]::UInt64,
        [System.TypeCode]::SByte,
        [System.TypeCode]::Int16,
        [System.TypeCode]::Int32,
        [System.TypeCode]::Int64
    )) {
        return $false
    }
    return [decimal]$Value -ge 0
}

function Test-CodexDesktopLaunchReceiptExactProperties {
    param(
        [AllowNull()]
        [object]$Value
    )

    if ($null -eq $Value) {
        return $false
    }
    $expected = @(
        'CorrelationId',
        'DesktopProcessId',
        'FeedbackFailureCode',
        'FeedbackStatus',
        'RecordedAtUtc',
        'RemoteDecision',
        'RemoteEnabled',
        'RemoteFailureCode',
        'RemoteFailureStage',
        'RemoteFallbackAttempts',
        'RemoteStopAttempts',
        'Signature',
        'Status',
        'Version'
    ) | Sort-Object
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    return (
        $actual.Count -eq $expected.Count -and
        (($actual -join "`0") -ceq ($expected -join "`0"))
    )
}

function Read-CodexDesktopLaunchReceipt {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    try {
        $path = Join-Path `
            ([System.IO.Path]::GetFullPath($DataDir)) `
            'desktop-launch-last.json'
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            return $null
        }
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or
            ($item.Attributes -band
                [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            [long]$item.Length -lt 2 -or
            [long]$item.Length -gt 65536) {
            return $null
        }
        $rawBefore = Get-Content `
            -LiteralPath $path `
            -Raw `
            -Encoding utf8 `
            -ErrorAction Stop
        $receipt = $rawBefore |
            ConvertFrom-Json -Depth 10 -DateKind String -ErrorAction Stop
        $rawAfter = Get-Content `
            -LiteralPath $path `
            -Raw `
            -Encoding utf8 `
            -ErrorAction Stop
        if ($rawBefore -cne $rawAfter -or
            -not (Test-CodexDesktopLaunchReceiptExactProperties `
                -Value $receipt)) {
            return $null
        }

        $recordedAtUtc = [DateTimeOffset]::MinValue
        $recordedAtReady = [DateTimeOffset]::TryParse(
            [string]$receipt.RecordedAtUtc,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind,
            [ref]$recordedAtUtc
        ) -and $recordedAtUtc.Offset -eq [TimeSpan]::Zero
        $failureStageReady = (
            $null -eq $receipt.RemoteFailureStage -or (
                $receipt.RemoteFailureStage -is [string] -and
                [string]$receipt.RemoteFailureStage -cin @(
                    'remote-health-check',
                    'runtime-handoff',
                    'remote-readiness',
                    'remote-endpoint',
                    'desktop-start',
                    'desktop-attach',
                    'desktop-cleanup',
                    'unexpected'
                )
            )
        )
        $failureCodeReady = (
            $null -eq $receipt.RemoteFailureCode -or (
                $receipt.RemoteFailureCode -is [string] -and
                [string]$receipt.RemoteFailureCode -cin @(
                    'health-check-failed',
                    'runtime-generation-unverified',
                    'desktop-running',
                    'handoff-request-invalid',
                    'handoff-launch-denied',
                    'handoff-launch-failed',
                    'handoff-timeout',
                    'handoff-result-invalid',
                    'handoff-result-mismatch',
                    'runtime-handoff-failed',
                    'readiness-timeout',
                    'endpoint-invalid',
                    'desktop-start-failed',
                    'desktop-attach-failed',
                    'desktop-cleanup-failed',
                    'unexpected'
                )
            )
        )
        $feedbackReady = (
            $receipt.FeedbackStatus -is [string] -and
            [string]$receipt.FeedbackStatus -cin @(
                'pending',
                'rendered',
                'render-failed',
                'suppressed',
                'filtered'
            ) -and
            ($null -eq $receipt.FeedbackFailureCode -or (
                $receipt.FeedbackFailureCode -is [string] -and
                [string]$receipt.FeedbackFailureCode -ceq
                    'feedback-render-failed'
            )) -and (
                ([string]$receipt.FeedbackStatus -ceq 'render-failed' -and
                    [string]$receipt.FeedbackFailureCode -ceq
                        'feedback-render-failed') -or
                ([string]$receipt.FeedbackStatus -cne 'render-failed' -and
                    $null -eq $receipt.FeedbackFailureCode)
            )
        )
        if ([string]$receipt.Signature -cne
                'codex-local-remote/desktop-launch/v2' -or
            -not (Test-NonNegativeInteger -Value $receipt.Version) -or
            [int]$receipt.Version -ne 2 -or
            $receipt.Status -isnot [string] -or
            [string]$receipt.Status -cnotin @(
                'already-running',
                'launched-native',
                'launched-remote',
                'remote-launch-unverified'
            ) -or
            ($receipt.RemoteEnabled -isnot [bool] -and
                $null -ne $receipt.RemoteEnabled) -or
            -not (Test-NonNegativeInteger `
                -Value $receipt.RemoteFallbackAttempts) -or
            -not (Test-NonNegativeInteger `
                -Value $receipt.RemoteStopAttempts) -or
            ($null -ne $receipt.DesktopProcessId -and (
                -not (Test-NonNegativeInteger `
                    -Value $receipt.DesktopProcessId) -or
                [int64]$receipt.DesktopProcessId -le 0
            )) -or
            $receipt.RemoteDecision -isnot [string] -or
            [string]$receipt.RemoteDecision -cnotin @(
                'broker-reports-desktop-connected',
                'created-desktop-identity-unavailable',
                'created-desktop-identity-unverified',
                'existing-desktop-preserved',
                'existing-desktop-takeover-identity-unverified',
                'existing-desktop-takeover-runtime-unverified',
                'existing-desktop-takeover-state-drifted',
                'existing-native-desktop-relaunched-remote',
                'remote-attach-failed-process-preserved',
                'remote-attached',
                'remote-attached-root-process-set-unverified',
                'remote-attached-then-unverified-process-preserved',
                'remote-broker-lost-before-attach',
                'remote-desktop-exited-before-attach',
                'remote-desktop-exited-before-identity',
                'remote-desktop-launch-failed',
                'remote-endpoint-unavailable',
                'remote-health-check-failed',
                'remote-not-ready',
                'remote-ready',
                'remote-start-failed'
            ) -or
            -not $recordedAtReady -or
            -not $failureStageReady -or
            -not $failureCodeReady -or
            (($null -eq $receipt.RemoteFailureStage) -ne
                ($null -eq $receipt.RemoteFailureCode)) -or
            ($null -ne $receipt.CorrelationId -and (
                $receipt.CorrelationId -isnot [string] -or
                [string]$receipt.CorrelationId -cnotmatch
                    '^[0-9a-f]{32}$'
            )) -or
            -not $feedbackReady) {
            return $null
        }
        return $receipt
    } catch {
        return $null
    }
}

function Test-ActiveCodexRuntimeMatchesCurrentDiscovery {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$ActiveRuntime,

        [AllowNull()]
        [object]$CurrentRuntime
    )

    if ($null -eq $ActiveRuntime -or $null -eq $CurrentRuntime) {
        return $false
    }
    if ([string]$ActiveRuntime.Signature -cne
            'codex-local-remote/codex-desktop-runtime/v1' -or
        [string]$CurrentRuntime.Signature -cne
            'codex-local-remote/codex-desktop-runtime/v1' -or
        [int]$ActiveRuntime.Version -ne 1 -or
        [int]$CurrentRuntime.Version -ne 1) {
        return $false
    }

    $activePath = $null
    $currentPath = $null
    try {
        $activePath = [System.IO.Path]::GetFullPath(
            [string]$ActiveRuntime.CodexPath
        )
        $currentPath = [System.IO.Path]::GetFullPath(
            [string]$CurrentRuntime.CodexPath
        )
    } catch {
        return $false
    }
    $activeHash = [string]$ActiveRuntime.CodexSha256
    $currentHash = [string]$CurrentRuntime.CodexSha256
    return (
        [string]::Equals(
            $activePath,
            $currentPath,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -and
        $activeHash -cmatch '^[A-F0-9]{64}$' -and
        $currentHash -cmatch '^[A-F0-9]{64}$' -and
        $activeHash -ceq $currentHash
    )
}

function Get-BrokerReadinessDecision {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [Parameter(Mandatory)]
        [object]$Readiness,

        [Parameter(Mandatory)]
        [ValidateSet('Infrastructure', 'SidecarHandshake', 'RuntimeTransition', 'StrictRuntime')]
        [string]$Phase
    )

    if ($null -eq $Readiness) {
        return 'Wait'
    }
    $appServerProperty = $Readiness.PSObject.Properties['appServerReady']
    $desktopProperty = $Readiness.PSObject.Properties['desktopConnected']
    $sidecarProperty = $Readiness.PSObject.Properties['sidecarConnected']
    $degradedProperty = $Readiness.PSObject.Properties['degraded']
    $unknownProperty = $Readiness.PSObject.Properties['unknownCount']
    if ($null -eq $appServerProperty -or
        $null -eq $desktopProperty -or
        $null -eq $sidecarProperty -or
        $null -eq $degradedProperty -or
        $null -eq $unknownProperty -or
        $appServerProperty.Value -isnot [bool] -or
        $desktopProperty.Value -isnot [bool] -or
        $sidecarProperty.Value -isnot [bool] -or
        $degradedProperty.Value -isnot [bool] -or
        -not (Test-NonNegativeInteger -Value $unknownProperty.Value)) {
        return 'Reject'
    }
    $appServerReady = [bool]$appServerProperty.Value
    $degraded = [bool]$degradedProperty.Value
    $sidecarConnected = [bool]$sidecarProperty.Value
    $unknownCount = [decimal]$unknownProperty.Value
    switch ($Phase) {
        'Infrastructure' {
            if ($appServerReady -ceq $false) { return 'Wait' }
            # Infrastructure identity is verified independently against the
            # exact Broker/upstream processes. Application backfill
            # degradation and client handshakes must not make a managed
            # Broker look foreign or trigger destructive recovery.
            return 'Ready'
        }
        'SidecarHandshake' {
            if ($appServerReady -ceq $false) { return 'Reject' }
            if ($unknownCount -gt 1) { return 'Reject' }
            if ($degraded) { return 'Wait' }
            if ($sidecarConnected -ceq $true) {
                if ($unknownCount -eq 0) { return 'Ready' }
                return 'Reject'
            }
            return 'Wait'
        }
        'RuntimeTransition' {
            # A live managed app-server can briefly report unavailable while
            # Desktop reconnects, resumes from sleep, or finishes an update.
            # Runtime identity is verified independently before this decision,
            # so keep the Sidecar alive and let the recovery loop retry.
            if ($appServerReady -ceq $false) { return 'Wait' }
            if ($unknownCount -gt 1) { return 'Reject' }
            if ($sidecarConnected -ceq $true -and $unknownCount -eq 0) {
                if ($degraded) { return 'Degraded' }
                return 'Ready'
            }
            return 'Wait'
        }
        'StrictRuntime' {
            if ($appServerReady -ceq $true -and
                $degraded -ceq $false -and
                $sidecarConnected -ceq $true -and
                $unknownCount -eq 0) {
                return 'Ready'
            }
            return 'Reject'
        }
    }
}

function Assert-LoopbackWebSocketUrl {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$WebSocketUrl
    )

    $uri = $null
    $created = [System.Uri]::TryCreate(
        $WebSocketUrl,
        [System.UriKind]::Absolute,
        [ref]$uri
    )
    $invalid = -not $created
    if ($created) {
        $invalid = (
            $uri.Scheme -cne 'ws' -or
        $uri.Host -cne '127.0.0.1' -or
            ($uri.Port -lt 1 -or $uri.Port -gt 65535) -or
            $WebSocketUrl -cne "ws://127.0.0.1:$($uri.Port)" -or
        $uri.AbsolutePath -cne '/' -or
        -not [string]::IsNullOrEmpty($uri.Query) -or
        -not [string]::IsNullOrEmpty($uri.Fragment) -or
            -not [string]::IsNullOrEmpty($uri.UserInfo)
        )
    }
    if ($invalid) {
        throw "App-server broker URL '$WebSocketUrl' is not an exact loopback WebSocket origin such as ws://127.0.0.1:18791."
    }

    return $uri
}

function Test-IsLoopbackListenerAddress {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Address
    )

    $text = [string]$Address
    return $text -ceq '127.0.0.1' -or $text -ceq '::1'
}

function Get-CodexLocalRemoteTcpListenerSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateNotNullOrEmpty()]
        [int[]]$LocalPorts,

        [ValidateRange(1, 30)]
        [int]$TimeoutSeconds = 5
    )

    $ports = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($localPort in $LocalPorts) {
        if ($localPort -lt 1 -or $localPort -gt 65535) {
            throw "TCP listener snapshot port '$localPort' is outside 1-65535."
        }
        $null = $ports.Add([int]$localPort)
    }
    if ($ports.Count -eq 0) {
        throw 'TCP listener snapshot requires at least one local port.'
    }

    $netstatPath = Join-Path $env:SystemRoot 'System32\netstat.exe'
    if (-not (Test-Path -LiteralPath $netstatPath -PathType Leaf)) {
        throw 'The Windows TCP listener snapshot executable is unavailable.'
    }
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $netstatPath
    foreach ($argument in @('-a', '-n', '-o', '-p', 'tcp')) {
        $startInfo.ArgumentList.Add($argument)
    }
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            throw 'The Windows TCP listener snapshot process did not start.'
        }
        $standardOutputTask = $process.StandardOutput.ReadToEndAsync()
        $standardErrorTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try {
                $process.Kill($true)
                $process.WaitForExit()
            } catch {
                # Preserve the bounded snapshot timeout as the owning failure.
            }
            throw (
                'The Windows TCP listener snapshot exceeded ' +
                "$TimeoutSeconds seconds."
            )
        }
        $standardOutput = $standardOutputTask.GetAwaiter().GetResult()
        $null = $standardErrorTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) {
            throw (
                'The Windows TCP listener snapshot exited with code ' +
                "$($process.ExitCode)."
            )
        }
    } finally {
        $process.Dispose()
    }

    function ConvertFrom-CodexLocalRemoteNetstatEndpoint {
        param([Parameter(Mandatory)][string]$Endpoint)

        $match = if ($Endpoint.StartsWith('[')) {
            [regex]::Match(
                $Endpoint,
                '^\[(?<address>[^\]]+)\]:(?<port>[0-9]+)$',
                [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
            )
        } else {
            [regex]::Match(
                $Endpoint,
                '^(?<address>[^:]+):(?<port>[0-9]+)$',
                [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
            )
        }
        if (-not $match.Success) {
            return $null
        }
        $port = 0
        if (-not [int]::TryParse(
            $match.Groups['port'].Value,
            [Globalization.NumberStyles]::None,
            [Globalization.CultureInfo]::InvariantCulture,
            [ref]$port
        ) -or $port -lt 0 -or $port -gt 65535) {
            return $null
        }
        $address = $null
        if (-not [System.Net.IPAddress]::TryParse(
            $match.Groups['address'].Value,
            [ref]$address
        )) {
            return $null
        }
        return [pscustomobject]@{
            Address = $address.ToString()
            Port = $port
        }
    }

    $listeners = [System.Collections.Generic.List[object]]::new()
    foreach ($line in @($standardOutput -split "`r?`n")) {
        $match = [regex]::Match(
            $line,
            '^\s*TCP\s+(?<local>\S+)\s+(?<remote>\S+)\s+\S+\s+(?<pid>[0-9]+)\s*$',
            [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
        )
        if (-not $match.Success) {
            continue
        }
        $local = ConvertFrom-CodexLocalRemoteNetstatEndpoint `
            -Endpoint $match.Groups['local'].Value
        $remote = ConvertFrom-CodexLocalRemoteNetstatEndpoint `
            -Endpoint $match.Groups['remote'].Value
        $owningProcess = 0
        if ($null -eq $local -or
            $null -eq $remote -or
            [int]$remote.Port -ne 0 -or
            -not $ports.Contains([int]$local.Port) -or
            -not [int]::TryParse(
                $match.Groups['pid'].Value,
                [Globalization.NumberStyles]::None,
                [Globalization.CultureInfo]::InvariantCulture,
                [ref]$owningProcess
            ) -or
            $owningProcess -lt 1) {
            continue
        }
        $listeners.Add([pscustomobject]@{
            LocalAddress = [string]$local.Address
            LocalPort = [int]$local.Port
            OwningProcess = $owningProcess
        })
    }
    return @(
        $listeners |
            Sort-Object LocalPort, LocalAddress, OwningProcess -Unique
    )
}

function Get-ManagedIpv4Listeners {
    [CmdletBinding()]
    param(
        [AllowEmptyCollection()]
        [Parameter(Mandatory)]
        [object[]]$Listeners
    )

    return @(
        $Listeners |
            Where-Object { [string]$_.LocalAddress -ceq '127.0.0.1' }
    )
}

function ConvertFrom-WindowsCommandLine {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [Parameter(Mandatory)]
        [string]$CommandLine
    )

    $arguments = [System.Collections.Generic.List[string]]::new()
    $length = $CommandLine.Length
    $index = 0
    while ($index -lt $length) {
        while ($index -lt $length -and
            ($CommandLine[$index] -eq ' ' -or $CommandLine[$index] -eq "`t")) {
            $index++
        }
        if ($index -ge $length) {
            break
        }

        $argument = [System.Text.StringBuilder]::new()
        $inQuotes = $false
        while ($index -lt $length) {
            $backslashCount = 0
            while ($index -lt $length -and $CommandLine[$index] -eq '\') {
                $backslashCount++
                $index++
            }

            if ($index -lt $length -and $CommandLine[$index] -eq '"') {
                $null = $argument.Append('\' * [Math]::Floor($backslashCount / 2))
                if (($backslashCount % 2) -eq 1) {
                    $null = $argument.Append('"')
                } elseif ($inQuotes -and
                    ($index + 1) -lt $length -and
                    $CommandLine[$index + 1] -eq '"') {
                    $null = $argument.Append('"')
                    $index++
                } else {
                    $inQuotes = -not $inQuotes
                }
                $index++
                continue
            }

            if ($backslashCount -gt 0) {
                $null = $argument.Append('\' * $backslashCount)
            }
            if ($index -ge $length -or
                (-not $inQuotes -and
                    ($CommandLine[$index] -eq ' ' -or $CommandLine[$index] -eq "`t"))) {
                break
            }
            $null = $argument.Append($CommandLine[$index])
            $index++
        }
        $arguments.Add($argument.ToString())
    }

    return $arguments.ToArray()
}

function Test-ExactWindowsCommandLine {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [Parameter(Mandatory)]
        [string]$CommandLine,

        [Parameter(Mandatory)]
        [string[]]$ExpectedArguments,

        [int[]]$PathArgumentIndexes = @()
    )

    $actualArguments = @(ConvertFrom-WindowsCommandLine -CommandLine $CommandLine)
    if ($actualArguments.Count -ne $ExpectedArguments.Count) {
        return $false
    }
    for ($index = 0; $index -lt $ExpectedArguments.Count; $index++) {
        if ($index -in $PathArgumentIndexes) {
            try {
                $actualPath = [System.IO.Path]::GetFullPath($actualArguments[$index])
                $expectedPath = [System.IO.Path]::GetFullPath($ExpectedArguments[$index])
            } catch {
                return $false
            }
            if (-not [string]::Equals(
                $actualPath,
                $expectedPath,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
                return $false
            }
        } elseif (-not [string]::Equals(
            $actualArguments[$index],
            $ExpectedArguments[$index],
            [System.StringComparison]::Ordinal
        )) {
            return $false
        }
    }
    return $true
}

function Get-ProcessCreationIdentity {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [Parameter(Mandatory)]
        [object]$CreationDate
    )

    if ($null -eq $CreationDate) {
        throw 'Process CreationDate is missing.'
    }
    if ($CreationDate -is [datetime]) {
        $date = ([datetime]$CreationDate).ToUniversalTime()
        return [pscustomobject]@{
            CreationDate = $date.ToString('O')
            CreationDateUtcTicks = $date.Ticks
        }
    }

    $raw = [string]$CreationDate
    if ([string]::IsNullOrWhiteSpace($raw)) {
        throw 'Process CreationDate is empty.'
    }
    $roundTripDate = [datetimeoffset]::MinValue
    if ([datetimeoffset]::TryParse(
        $raw,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$roundTripDate
    )) {
        $date = $roundTripDate.UtcDateTime
    } else {
        try {
            $date = [System.Management.ManagementDateTimeConverter]::ToDateTime($raw).
                ToUniversalTime()
        } catch {
            throw "Process CreationDate '$raw' is not a valid CIM timestamp."
        }
    }
    return [pscustomobject]@{
        CreationDate = $raw
        CreationDateUtcTicks = $date.Ticks
    }
}

function Open-ProcessIdentityHandle {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateRange(1, 2147483647)]
        [int]$ProcessId,

        [Parameter(Mandatory)]
        [long]$ExpectedCreationDateUtcTicks,

        [long]$ExpectedStartTimeUtcTicks = 0
    )

    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        $startTimeUtcTicks = $process.StartTime.ToUniversalTime().Ticks
    } catch {
        throw "PID $ProcessId could not be opened as a stable process handle."
    }
    if ([Math]::Abs($startTimeUtcTicks - $ExpectedCreationDateUtcTicks) -gt
        [TimeSpan]::FromSeconds(2).Ticks) {
        $process.Dispose()
        throw "PID $ProcessId process handle start time does not match its CIM CreationDate."
    }
    if ($ExpectedStartTimeUtcTicks -gt 0 -and
        $startTimeUtcTicks -ne $ExpectedStartTimeUtcTicks) {
        $process.Dispose()
        throw "PID $ProcessId process handle start time does not match recorded startup identity."
    }

    return [pscustomobject]@{
        Process = $process
        ProcessId = $ProcessId
        StartTimeUtcTicks = $startTimeUtcTicks
    }
}

function Stop-ProcessIdentityHandle {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$IdentityHandle,

        [ValidateRange(1, 60000)]
        [int]$TimeoutMilliseconds = 10000
    )

    $process = $IdentityHandle.Process
    $process.Refresh()
    if ($process.HasExited) {
        return $false
    }
    if ($process.Id -ne [int]$IdentityHandle.ProcessId -or
        $process.StartTime.ToUniversalTime().Ticks -ne
            [long]$IdentityHandle.StartTimeUtcTicks) {
        throw "Held process handle no longer matches PID $($IdentityHandle.ProcessId) startup identity."
    }
    $process.Kill()
    $null = $process.WaitForExit($TimeoutMilliseconds)
    return $true
}

function Test-ManagedAppServerProcess {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [Parameter(Mandatory)]
        [string]$CommandLine,

        [AllowEmptyString()]
        [Parameter(Mandatory)]
        [string]$ExecutablePath,

        [Parameter(Mandatory)]
        [string]$ExpectedCodexPath,

        [Parameter(Mandatory)]
        [string]$WebSocketUrl,

        [Parameter(Mandatory)]
        [string]$TokenFilePath
    )

    $null = Assert-LoopbackWebSocketUrl -WebSocketUrl $WebSocketUrl
    $resolvedExpected = [System.IO.Path]::GetFullPath($ExpectedCodexPath)
    $resolvedActual = if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
        ''
    } else {
        [System.IO.Path]::GetFullPath($ExecutablePath)
    }
    if ($resolvedActual -cne $resolvedExpected) {
        return [pscustomobject]@{
            IsManaged = $false
            Reason = 'executable-mismatch'
        }
    }

    $managed = Test-ExactWindowsCommandLine `
        -CommandLine $CommandLine `
        -ExpectedArguments @(
            $resolvedExpected
            '-c'
            'features.code_mode_host=true'
            'app-server'
            '--listen'
            $WebSocketUrl
            '--ws-auth'
            'capability-token'
            '--ws-token-file'
            ([System.IO.Path]::GetFullPath($TokenFilePath))
        ) `
        -PathArgumentIndexes @(0, 9)
    if (-not $managed) {
        return [pscustomobject]@{
            IsManaged = $false
            Reason = 'command-line-mismatch'
        }
    }

    return [pscustomobject]@{
        IsManaged = $true
        Reason = 'exact-managed-command'
    }
}

function Test-ManagedBrokerProcess {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [Parameter(Mandatory)]
        [string]$CommandLine,

        [AllowEmptyString()]
        [Parameter(Mandatory)]
        [string]$ExecutablePath,

        [Parameter(Mandatory)]
        [string]$ExpectedNodePath,

        [Parameter(Mandatory)]
        [string]$ExpectedBrokerCliPath,

        [Parameter(Mandatory)]
        [int]$BrokerPort,

        [Parameter(Mandatory)]
        [int]$UpstreamPort,

        [Parameter(Mandatory)]
        [string]$ExpectedCodexPath,

        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [string]$CapabilityTokenFilePath
    )

    $resolvedExpectedNode = [System.IO.Path]::GetFullPath($ExpectedNodePath)
    $resolvedActual = if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
        ''
    } else {
        [System.IO.Path]::GetFullPath($ExecutablePath)
    }
    if ($resolvedActual -cne $resolvedExpectedNode) {
        return [pscustomobject]@{
            IsManaged = $false
            Reason = 'executable-mismatch'
        }
    }

    $managed = Test-ExactWindowsCommandLine `
        -CommandLine $CommandLine `
        -ExpectedArguments @(
            $resolvedExpectedNode
            ([System.IO.Path]::GetFullPath($ExpectedBrokerCliPath))
            'serve'
            '--host'
            '127.0.0.1'
            '--port'
            $BrokerPort.ToString([System.Globalization.CultureInfo]::InvariantCulture)
            '--upstream-port'
            $UpstreamPort.ToString([System.Globalization.CultureInfo]::InvariantCulture)
            '--codex-path'
            ([System.IO.Path]::GetFullPath($ExpectedCodexPath))
            '--data-dir'
            ([System.IO.Path]::GetFullPath($DataDir))
            '--capability-token-file'
            ([System.IO.Path]::GetFullPath($CapabilityTokenFilePath))
        ) `
        -PathArgumentIndexes @(0, 1, 10, 12, 14)
    if (-not $managed) {
        return [pscustomobject]@{
            IsManaged = $false
            Reason = 'command-line-mismatch'
        }
    }
    return [pscustomobject]@{
        IsManaged = $true
        Reason = 'exact-managed-command'
    }
}

function Test-ManagedSidecarProcess {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [Parameter(Mandatory)]
        [string]$CommandLine,

        [AllowEmptyString()]
        [Parameter(Mandatory)]
        [string]$ExecutablePath,

        [Parameter(Mandatory)]
        [string]$ExpectedNodePath,

        [Parameter(Mandatory)]
        [string]$ExpectedSidecarCliPath,

        [Parameter(Mandatory)]
        [int]$Port,

        [Parameter(Mandatory)]
        [string]$BasePath,

        [Parameter(Mandatory)]
        [string]$DataDir
    )

    Assert-CanonicalBasePath -BasePath $BasePath
    $resolvedExpectedNode = [System.IO.Path]::GetFullPath($ExpectedNodePath)
    $resolvedActual = if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
        ''
    } else {
        [System.IO.Path]::GetFullPath($ExecutablePath)
    }
    if ($resolvedActual -cne $resolvedExpectedNode) {
        return [pscustomobject]@{
            IsManaged = $false
            Reason = 'executable-mismatch'
        }
    }

    $node = [regex]::Escape($resolvedExpectedNode)
    $cli = [regex]::Escape([System.IO.Path]::GetFullPath($ExpectedSidecarCliPath))
    $base = [regex]::Escape($BasePath)
    $data = [regex]::Escape([System.IO.Path]::GetFullPath($DataDir))
    # The Sidecar receives the freshly rediscovered Codex executable only to
    # inspect the current protocol schema. It is not the app-server owner, so
    # accepting this one bounded absolute-path argument preserves exact process
    # ownership while remaining compatible with Codex's frequently changing
    # versioned install directory.
    $codexSchemaSource = '(?:\s+--codex-path\s+(?:"[A-Za-z]:\\[^"]+"|[A-Za-z]:\\\S+))?'
    $pattern = (
        "^(?:`"$node`"|$node)\s+" +
        "(?:`"$cli`"|$cli)\s+serve" +
        "\s+--host\s+127\.0\.0\.1" +
        "\s+--port\s+$Port" +
        "\s+--base-path\s+(?:`"$base`"|$base)" +
        $codexSchemaSource +
        "\s+--data-dir\s+(?:`"$data`"|$data)\s*$"
    )
    if ($CommandLine -notmatch $pattern) {
        return [pscustomobject]@{
            IsManaged = $false
            Reason = 'command-line-mismatch'
        }
    }
    return [pscustomobject]@{
        IsManaged = $true
        Reason = 'exact-managed-command'
    }
}

function Test-ManagedBootstrapProcess {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [Parameter(Mandatory)]
        [string]$CommandLine,

        [AllowEmptyString()]
        [Parameter(Mandatory)]
        [string]$ExecutablePath,

        [Parameter(Mandatory)]
        [string]$TaskName,

        [Parameter(Mandatory)]
        [string]$NodePath,

        [Parameter(Mandatory)]
        [string]$PwshPath,

        [Parameter(Mandatory)]
        [string]$InstallRoot,

        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [int]$Port,

        [Parameter(Mandatory)]
        [int]$BrokerPort,

        [Parameter(Mandatory)]
        [int]$BrokerUpstreamPort,

        [Parameter(Mandatory)]
        [string]$BasePath
    )

    $expected = Get-StartupTaskDefinition `
        -TaskName $TaskName `
        -NodePath $NodePath `
        -PwshPath $PwshPath `
        -InstallRoot $InstallRoot `
        -DataDir $DataDir `
        -Port $Port `
        -BrokerPort $BrokerPort `
        -BrokerUpstreamPort $BrokerUpstreamPort `
        -BasePath $BasePath
    $resolvedActual = try {
        if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
            ''
        } else {
            [System.IO.Path]::GetFullPath($ExecutablePath)
        }
    } catch {
        ''
    }
    if (-not [string]::Equals(
        $resolvedActual,
        [string]$expected.Execute,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        return [pscustomobject]@{
            IsManaged = $false
            Reason = 'executable-mismatch'
        }
    }

    $expectedArguments = [System.Collections.Generic.List[string]]::new()
    $expectedArguments.Add([string]$expected.Execute)
    foreach ($argument in @(ConvertFrom-WindowsCommandLine -CommandLine $expected.Arguments)) {
        $expectedArguments.Add([string]$argument)
    }
    $pathIndexes = [System.Collections.Generic.List[int]]::new()
    $pathIndexes.Add(0)
    foreach ($pathSwitch in @('-File', '-NodePath', '-InstallRoot', '-DataDir')) {
        $switchIndex = $expectedArguments.IndexOf($pathSwitch)
        if ($switchIndex -lt 0 -or $switchIndex + 1 -ge $expectedArguments.Count) {
            return [pscustomobject]@{
                IsManaged = $false
                Reason = 'invalid-canonical-definition'
            }
        }
        $pathIndexes.Add($switchIndex + 1)
    }

    if (Test-ExactWindowsCommandLine `
        -CommandLine $CommandLine `
        -ExpectedArguments $expectedArguments.ToArray() `
        -PathArgumentIndexes $pathIndexes.ToArray()) {
        return [pscustomobject]@{
            IsManaged = $true
            Reason = 'exact-managed-command'
        }
    }

    $actualArguments = @(
        ConvertFrom-WindowsCommandLine -CommandLine $CommandLine
    )
    $codexSwitchIndexes = @(
        for ($index = 0; $index -lt $actualArguments.Count; $index++) {
            if ([string]$actualArguments[$index] -ceq '-CodexPath') {
                $index
            }
        }
    )
    if ($codexSwitchIndexes.Count -eq 1 -and
        $codexSwitchIndexes[0] + 1 -lt $actualArguments.Count) {
        try {
            $pinnedExpected = Get-PinnedStartupTaskDefinitionV2 `
                -TaskName $TaskName `
                -NodePath $NodePath `
                -CodexPath ([string]$actualArguments[$codexSwitchIndexes[0] + 1]) `
                -PwshPath $PwshPath `
                -InstallRoot $InstallRoot `
                -DataDir $DataDir `
                -Port $Port `
                -BrokerPort $BrokerPort `
                -BrokerUpstreamPort $BrokerUpstreamPort `
                -BasePath $BasePath
            $pinnedArguments = [System.Collections.Generic.List[string]]::new()
            $pinnedArguments.Add([string]$pinnedExpected.Execute)
            foreach ($argument in @(
                ConvertFrom-WindowsCommandLine `
                    -CommandLine $pinnedExpected.Arguments
            )) {
                $pinnedArguments.Add([string]$argument)
            }
            $pinnedPathIndexes = [System.Collections.Generic.List[int]]::new()
            $pinnedPathIndexes.Add(0)
            foreach ($pathSwitch in @(
                '-File',
                '-CodexPath',
                '-NodePath',
                '-InstallRoot',
                '-DataDir'
            )) {
                $switchIndex = $pinnedArguments.IndexOf($pathSwitch)
                if ($switchIndex -lt 0 -or
                    $switchIndex + 1 -ge $pinnedArguments.Count) {
                    throw 'invalid pinned V2 definition'
                }
                $pinnedPathIndexes.Add($switchIndex + 1)
            }
            if (Test-ExactWindowsCommandLine `
                -CommandLine $CommandLine `
                -ExpectedArguments $pinnedArguments.ToArray() `
                -PathArgumentIndexes $pinnedPathIndexes.ToArray()) {
                return [pscustomobject]@{
                    IsManaged = $true
                    Reason = 'exact-managed-pinned-v2-command'
                }
            }
        } catch {
            # Fall through to the common mismatch result.
        }
    }
    return [pscustomobject]@{
        IsManaged = $false
        Reason = 'command-line-mismatch'
    }
}

function Test-BootstrapProcessDefinitionCommandLine {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [Parameter(Mandatory)]
        [string]$CommandLine,

        [AllowEmptyString()]
        [Parameter(Mandatory)]
        [string]$ExecutablePath,

        [Parameter(Mandatory)]
        [object]$Definition
    )

    $resolvedActual = try {
        if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
            ''
        } else {
            [System.IO.Path]::GetFullPath($ExecutablePath)
        }
    } catch {
        ''
    }
    if (-not [string]::Equals(
        $resolvedActual,
        [string]$Definition.Execute,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        return $false
    }

    $expectedArguments = [System.Collections.Generic.List[string]]::new()
    $expectedArguments.Add([string]$Definition.Execute)
    foreach ($argument in @(
        ConvertFrom-WindowsCommandLine `
            -CommandLine ([string]$Definition.Arguments)
    )) {
        $expectedArguments.Add([string]$argument)
    }
    $pathIndexes = [System.Collections.Generic.List[int]]::new()
    $pathIndexes.Add(0)
    foreach ($pathSwitch in @(
        '-File',
        '-NodePath',
        '-InstallRoot',
        '-DataDir'
    )) {
        $switchIndex = $expectedArguments.IndexOf($pathSwitch)
        if ($switchIndex -lt 0 -or
            $switchIndex + 1 -ge $expectedArguments.Count) {
            return $false
        }
        $pathIndexes.Add($switchIndex + 1)
    }
    return Test-ExactWindowsCommandLine `
        -CommandLine $CommandLine `
        -ExpectedArguments $expectedArguments.ToArray() `
        -PathArgumentIndexes $pathIndexes.ToArray()
}

function Get-ManagedBootstrapProcessContract {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [Parameter(Mandatory)]
        [string]$CommandLine,

        [AllowEmptyString()]
        [Parameter(Mandatory)]
        [string]$ExecutablePath,

        [Parameter(Mandatory)]
        [string]$TaskName,

        [Parameter(Mandatory)]
        [string]$NodePath,

        [Parameter(Mandatory)]
        [string]$PwshPath,

        [Parameter(Mandatory)]
        [string]$InstallRoot,

        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [int]$Port,

        [Parameter(Mandatory)]
        [int]$BrokerPort,

        [Parameter(Mandatory)]
        [int]$BrokerUpstreamPort,

        [Parameter(Mandatory)]
        [string]$BasePath
    )

    $current = Get-StartupTaskDefinition `
        -TaskName $TaskName `
        -NodePath $NodePath `
        -PwshPath $PwshPath `
        -InstallRoot $InstallRoot `
        -DataDir $DataDir `
        -Port $Port `
        -BrokerPort $BrokerPort `
        -BrokerUpstreamPort $BrokerUpstreamPort `
        -BasePath $BasePath
    if (Test-BootstrapProcessDefinitionCommandLine `
        -CommandLine $CommandLine `
        -ExecutablePath $ExecutablePath `
        -Definition $current) {
        return [pscustomobject]@{
            IsManaged = $true
            Contract = 'desktop-owner-v5'
            Reason = 'exact-managed-desktop-owner-v5-command'
        }
    }

    $legacyHeadlessV4 = Get-LegacyHeadlessStartupTaskDefinitionV4 `
        -Definition $current
    if (Test-BootstrapProcessDefinitionCommandLine `
        -CommandLine $CommandLine `
        -ExecutablePath $ExecutablePath `
        -Definition $legacyHeadlessV4) {
        return [pscustomobject]@{
            IsManaged = $true
            Contract = 'headless-v4'
            Reason = 'exact-managed-headless-v4-command'
        }
    }

    $legacy = Get-LegacyDesktopOwningStartupTaskDefinitionV3 `
        -Definition $current
    if (Test-BootstrapProcessDefinitionCommandLine `
        -CommandLine $CommandLine `
        -ExecutablePath $ExecutablePath `
        -Definition $legacy) {
        return [pscustomobject]@{
            IsManaged = $true
            Contract = 'desktop-owner-v3'
            Reason = 'exact-managed-desktop-owner-v3-command'
        }
    }

    return [pscustomobject]@{
        IsManaged = $false
        Contract = 'unverified'
        Reason = 'command-line-mismatch'
    }
}

function Test-IndependentDesktopAppServer {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [Parameter(Mandatory)]
        [string]$CommandLine,

        [AllowEmptyString()]
        [Parameter(Mandatory)]
        [string]$ParentProcessName
    )

    return (
        $CommandLine -match '(?:^|\s)app-server(?:\s|$)' -and
        $CommandLine -notmatch '(?:^|\s)--listen(?:\s|$)' -and
        (
            $ParentProcessName -ieq 'ChatGPT.exe' -or
            $CommandLine -match '(?:^|\s)--analytics-default-enabled(?:\s|$)'
        )
    )
}

function Get-CodexLocalRemoteDesktopHandoffPreparationPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    return [System.IO.Path]::GetFullPath(
        (Join-Path `
            ([System.IO.Path]::GetFullPath($DataDir)) `
            'desktop-handoff-preparation.json')
    )
}

function Select-CodexLocalRemoteNativeDesktopRootCandidates {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [AllowEmptyCollection()]
        [object[]]$Candidates,

        [Parameter(Mandatory)]
        [string]$DesktopExecutablePath
    )

    $expectedDesktopPath =
        [System.IO.Path]::GetFullPath($DesktopExecutablePath)
    $exactRootProcessIds =
        [Collections.Generic.HashSet[int]]::new()
    foreach ($candidate in $Candidates) {
        $commandLine = [string]$candidate.CommandLine
        $executablePath = [string]$candidate.ExecutablePath
        if ([string]::IsNullOrWhiteSpace($commandLine) -or
            $commandLine -match '(?i)(?:^|\s)--type=' -or
            [string]::IsNullOrWhiteSpace($executablePath)) {
            continue
        }
        try {
            $resolvedExecutablePath =
                [System.IO.Path]::GetFullPath($executablePath)
        } catch {
            continue
        }
        if ([string]::Equals(
            $resolvedExecutablePath,
            $expectedDesktopPath,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            $null = $exactRootProcessIds.Add(
                [int]$candidate.ProcessId
            )
        }
    }

    foreach ($candidate in $Candidates) {
        $commandLine = [string]$candidate.CommandLine
        if ($commandLine -match '(?i)(?:^|\s)--type=') {
            continue
        }
        $isMetadataEmptyChildOfExactRoot = (
            [string]::IsNullOrWhiteSpace($commandLine) -and
            [string]::IsNullOrWhiteSpace(
                [string]$candidate.ExecutablePath
            ) -and
            $exactRootProcessIds.Contains(
                [int]$candidate.ParentProcessId
            )
        )
        if ($isMetadataEmptyChildOfExactRoot) {
            continue
        }
        $candidate
    }
}

function Get-CodexLocalRemoteNativeDesktopRootCandidates {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DesktopExecutablePath
    )

    $candidates = @(
        Get-CimInstance `
            Win32_Process `
            -Filter "Name = 'ChatGPT.exe'" `
            -ErrorAction Stop
    )
    return @(
        Select-CodexLocalRemoteNativeDesktopRootCandidates `
            -Candidates $candidates `
            -DesktopExecutablePath $DesktopExecutablePath
    )
}

function Get-CodexLocalRemoteNativeDesktopOwnershipSnapshot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DesktopExecutablePath
    )

    $expectedDesktopPath =
        [System.IO.Path]::GetFullPath($DesktopExecutablePath)
    $expectedAppServerPath = [System.IO.Path]::GetFullPath(
        (Join-Path `
            (Split-Path -Parent $expectedDesktopPath) `
            'resources\codex.exe')
    )
    $allDesktopRoots = @(
        Get-CodexLocalRemoteNativeDesktopRootCandidates `
            -DesktopExecutablePath $expectedDesktopPath
    )
    if ($allDesktopRoots.Count -ne 1) {
        throw (
            'Desktop handoff preparation requires one unique native ' +
            "Desktop root, found $($allDesktopRoots.Count)."
        )
    }
    $desktopRoots = @(
        $allDesktopRoots |
            Where-Object {
                -not [string]::IsNullOrWhiteSpace(
                    [string]$_.ExecutablePath
                ) -and
                [string]::Equals(
                    [System.IO.Path]::GetFullPath(
                        [string]$_.ExecutablePath
                    ),
                    $expectedDesktopPath,
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            }
    )
    if ($desktopRoots.Count -ne 1) {
        throw (
            'Desktop handoff preparation requires one exact native ' +
            "Desktop root, found $($desktopRoots.Count)."
        )
    }
    $desktopRoot = $desktopRoots[0]
    $appServers = @(
        foreach ($candidate in @(
            Get-CimInstance `
                Win32_Process `
                -Filter "Name = 'codex.exe'" `
                -ErrorAction Stop
        )) {
            if ([int]$candidate.ParentProcessId -ne
                [int]$desktopRoot.ProcessId) {
                continue
            }
            if (-not (Test-IndependentDesktopAppServer `
                -CommandLine ([string]$candidate.CommandLine) `
                -ParentProcessName 'ChatGPT.exe')) {
                continue
            }
            if ([string]::IsNullOrWhiteSpace(
                [string]$candidate.ExecutablePath
            ) -or -not [string]::Equals(
                [System.IO.Path]::GetFullPath(
                    [string]$candidate.ExecutablePath
                ),
                $expectedAppServerPath,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
                continue
            }
            $candidate
        }
    )
    if ($appServers.Count -ne 1) {
        throw (
            'Desktop handoff preparation requires one exact native ' +
            "stdio app-server, found $($appServers.Count)."
        )
    }
    $appServer = $appServers[0]
    $rootCreation = Get-ProcessCreationIdentity `
        -CreationDate $desktopRoot.CreationDate
    $appServerCreation = Get-ProcessCreationIdentity `
        -CreationDate $appServer.CreationDate
    $rootHandle = Open-ProcessIdentityHandle `
        -ProcessId ([int]$desktopRoot.ProcessId) `
        -ExpectedCreationDateUtcTicks (
            [long]$rootCreation.CreationDateUtcTicks
        )
    $appServerHandle = $null
    try {
        $appServerHandle = Open-ProcessIdentityHandle `
            -ProcessId ([int]$appServer.ProcessId) `
            -ExpectedCreationDateUtcTicks (
                [long]$appServerCreation.CreationDateUtcTicks
            )
        return [pscustomobject]@{
            DesktopRoot = $desktopRoot
            DesktopRootProcessId = [int]$desktopRoot.ProcessId
            DesktopRootStartTimeUtcTicks =
                [long]$rootHandle.StartTimeUtcTicks
            DesktopExecutablePath = $expectedDesktopPath
            DesktopRootIdentityKey =
                Get-CodexDesktopOwnerRootIdentityKey `
                    -ProcessId ([int]$desktopRoot.ProcessId) `
                    -StartTimeUtcTicks (
                        [long]$rootHandle.StartTimeUtcTicks
                    ) `
                    -ExecutablePath $expectedDesktopPath
            DesktopAppServer = $appServer
            DesktopAppServerProcessId = [int]$appServer.ProcessId
            DesktopAppServerStartTimeUtcTicks =
                [long]$appServerHandle.StartTimeUtcTicks
            DesktopAppServerExecutablePath = $expectedAppServerPath
            DesktopAppServerIdentityKey =
                Get-CodexDesktopOwnerRootIdentityKey `
                    -ProcessId ([int]$appServer.ProcessId) `
                    -StartTimeUtcTicks (
                        [long]$appServerHandle.StartTimeUtcTicks
                    ) `
                    -ExecutablePath $expectedAppServerPath
        }
    } finally {
        if ($null -ne $appServerHandle) {
            $appServerHandle.Process.Dispose()
        }
        $rootHandle.Process.Dispose()
    }
}

function Read-CodexLocalRemoteDesktopHandoffPreparation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [ValidatePattern('^[a-f0-9]{64}$')]
        [string]$ExpectedRuntimeVersionId,

        [Parameter(Mandatory)]
        [string]$ExpectedRuntimeRoot,

        [Parameter(Mandatory)]
        [ValidatePattern('^[a-f0-9]{64}$')]
        [string]$ExpectedManifestSha256,

        [ValidateRange(1, 7200)]
        [int]$MaximumAgeSeconds = 3600,

        [switch]$RequireLiveOwnership
    )

    $path =
        Get-CodexLocalRemoteDesktopHandoffPreparationPath `
            -DataDir $DataDir
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return $null
    }
    try {
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or
            ($item.Attributes -band
                [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            [long]$item.Length -lt 128 -or
            [long]$item.Length -gt 32768) {
            return $null
        }
        $rawBefore =
            Get-Content -LiteralPath $path -Raw -Encoding utf8
        $preparation = $rawBefore |
            ConvertFrom-Json -Depth 12 -DateKind String -ErrorAction Stop
        $rawAfter =
            Get-Content -LiteralPath $path -Raw -Encoding utf8
        $runtimeRoot = [System.IO.Path]::GetFullPath(
            [string]$preparation.RuntimeRoot
        )
        $desktopPath = [System.IO.Path]::GetFullPath(
            [string]$preparation.DesktopExecutablePath
        )
        $appServerPath = [System.IO.Path]::GetFullPath(
            [string]$preparation.DesktopAppServerExecutablePath
        )
    } catch {
        return $null
    }
    $expectedProperties = @(
        'Signature',
        'Version',
        'PreparationId',
        'Phase',
        'RuntimeVersionId',
        'RuntimeRoot',
        'ManifestSha256',
        'DesktopRootProcessId',
        'DesktopRootStartTimeUtcTicks',
        'DesktopExecutablePath',
        'DesktopRootIdentityKey',
        'DesktopAppServerProcessId',
        'DesktopAppServerStartTimeUtcTicks',
        'DesktopAppServerExecutablePath',
        'DesktopAppServerIdentityKey',
        'RequestedAtUtc',
        'ReadyAtUtc',
        'AttachStartedAtUtc',
        'RuntimeInvocationId',
        'BrokerProcessId',
        'UpstreamProcessId',
        'SidecarProcessId'
    )
    $actualProperties =
        @($preparation.PSObject.Properties.Name | Sort-Object)
    if ($rawBefore -cne $rawAfter -or
        (ConvertTo-CanonicalJson $actualProperties) -cne
            (ConvertTo-CanonicalJson @(
                $expectedProperties | Sort-Object
            )) -or
        [string]$preparation.Signature -cne
            'codex-local-remote/desktop-handoff-preparation/v1' -or
        [int]$preparation.Version -ne 1 -or
        [string]$preparation.PreparationId -cnotmatch
            '^[a-f0-9]{32}$' -or
        [string]$preparation.Phase -cnotin @(
            'requested',
            'ready',
            'attaching'
        ) -or
        [string]$preparation.RuntimeVersionId -cne
            $ExpectedRuntimeVersionId -or
        [string]$preparation.ManifestSha256 -cne
            $ExpectedManifestSha256 -or
        -not [string]::Equals(
            $runtimeRoot,
            [System.IO.Path]::GetFullPath(
                $ExpectedRuntimeRoot
            ),
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        -not (Test-NonNegativeInteger `
            -Value $preparation.DesktopRootProcessId) -or
        [decimal]$preparation.DesktopRootProcessId -le 0 -or
        -not (Test-NonNegativeInteger `
            -Value $preparation.DesktopRootStartTimeUtcTicks) -or
        [decimal]$preparation.DesktopRootStartTimeUtcTicks -le 0 -or
        -not (Test-NonNegativeInteger `
            -Value $preparation.DesktopAppServerProcessId) -or
        [decimal]$preparation.DesktopAppServerProcessId -le 0 -or
        -not (Test-NonNegativeInteger `
            -Value $preparation.DesktopAppServerStartTimeUtcTicks) -or
        [decimal]$preparation.DesktopAppServerStartTimeUtcTicks -le 0) {
        return $null
    }
    $expectedRootKey = Get-CodexDesktopOwnerRootIdentityKey `
        -ProcessId ([int]$preparation.DesktopRootProcessId) `
        -StartTimeUtcTicks (
            [long]$preparation.DesktopRootStartTimeUtcTicks
        ) `
        -ExecutablePath $desktopPath
    $expectedAppServerKey =
        Get-CodexDesktopOwnerRootIdentityKey `
            -ProcessId (
                [int]$preparation.DesktopAppServerProcessId
            ) `
            -StartTimeUtcTicks (
                [long]$preparation.DesktopAppServerStartTimeUtcTicks
            ) `
            -ExecutablePath $appServerPath
    if ([string]$preparation.DesktopRootIdentityKey -cne
            $expectedRootKey -or
        [string]$preparation.DesktopAppServerIdentityKey -cne
            $expectedAppServerKey) {
        return $null
    }
    $readyFieldsAreNull = (
        $null -eq $preparation.ReadyAtUtc -and
        $null -eq $preparation.AttachStartedAtUtc -and
        $null -eq $preparation.RuntimeInvocationId -and
        $null -eq $preparation.BrokerProcessId -and
        $null -eq $preparation.UpstreamProcessId -and
        $null -eq $preparation.SidecarProcessId
    )
    if ([string]$preparation.Phase -ceq 'requested') {
        if (-not $readyFieldsAreNull) {
            return $null
        }
    } else {
        try {
            $readyAt = [DateTimeOffset]::Parse(
                [string]$preparation.ReadyAtUtc,
                [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind
            )
            $attachStartedAt = if (
                [string]$preparation.Phase -ceq 'attaching'
            ) {
                [DateTimeOffset]::Parse(
                    [string]$preparation.AttachStartedAtUtc,
                    [Globalization.CultureInfo]::InvariantCulture,
                    [Globalization.DateTimeStyles]::RoundtripKind
                )
            } else {
                $null
            }
        } catch {
            return $null
        }
        if ($readyAt.Offset -ne [TimeSpan]::Zero -or
            ([string]$preparation.Phase -ceq 'ready' -and
                $null -ne $preparation.AttachStartedAtUtc) -or
            ([string]$preparation.Phase -ceq 'attaching' -and
                ($null -eq $attachStartedAt -or
                    $attachStartedAt.Offset -ne [TimeSpan]::Zero)) -or
            [string]$preparation.RuntimeInvocationId -cnotmatch
                '^[a-f0-9]{32}$' -or
            -not (Test-NonNegativeInteger `
                -Value $preparation.BrokerProcessId) -or
            [decimal]$preparation.BrokerProcessId -le 0 -or
            -not (Test-NonNegativeInteger `
                -Value $preparation.UpstreamProcessId) -or
            [decimal]$preparation.UpstreamProcessId -le 0 -or
            -not (Test-NonNegativeInteger `
                -Value $preparation.SidecarProcessId) -or
            [decimal]$preparation.SidecarProcessId -le 0) {
            return $null
        }
    }
    $freshness = Get-CodexDesktopOwnerIntentFreshnessDecision `
        -RequestedAtUtc ([string]$preparation.RequestedAtUtc) `
        -MaximumAgeSeconds $MaximumAgeSeconds
    if ($freshness -cne 'fresh') {
        return $null
    }
    if ($RequireLiveOwnership) {
        try {
            $ownership =
                Get-CodexLocalRemoteNativeDesktopOwnershipSnapshot `
                    -DesktopExecutablePath $desktopPath
        } catch {
            return $null
        }
        if ([string]$ownership.DesktopRootIdentityKey -cne
                [string]$preparation.DesktopRootIdentityKey -or
            [string]$ownership.DesktopAppServerIdentityKey -cne
                [string]$preparation.DesktopAppServerIdentityKey) {
            return $null
        }
    }
    $preparation | Add-Member `
        -NotePropertyName 'Path' `
        -NotePropertyValue $path
    $preparation | Add-Member `
        -NotePropertyName 'DesktopExecutablePathResolved' `
        -NotePropertyValue $desktopPath
    $preparation | Add-Member `
        -NotePropertyName 'DesktopAppServerExecutablePathResolved' `
        -NotePropertyValue $appServerPath
    return $preparation
}

function New-CodexLocalRemoteDesktopHandoffPreparation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [ValidatePattern('^[a-f0-9]{64}$')]
        [string]$RuntimeVersionId,

        [Parameter(Mandatory)]
        [string]$RuntimeRoot,

        [Parameter(Mandatory)]
        [ValidatePattern('^[a-f0-9]{64}$')]
        [string]$ManifestSha256,

        [Parameter(Mandatory)]
        [object]$Ownership
    )

    $resolvedRuntimeRoot =
        [System.IO.Path]::GetFullPath($RuntimeRoot)
    $path =
        Get-CodexLocalRemoteDesktopHandoffPreparationPath `
            -DataDir $DataDir
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        $existing =
            Read-CodexLocalRemoteDesktopHandoffPreparation `
                -DataDir $DataDir `
                -ExpectedRuntimeVersionId $RuntimeVersionId `
                -ExpectedRuntimeRoot $resolvedRuntimeRoot `
                -ExpectedManifestSha256 $ManifestSha256 `
                -RequireLiveOwnership
        if ($null -eq $existing) {
            try {
                $existingItem =
                    Get-Item -LiteralPath $path -Force -ErrorAction Stop
                $existingRaw =
                    Get-Content -LiteralPath $path -Raw -Encoding utf8
                $existingUnverified = $existingRaw |
                    ConvertFrom-Json `
                        -Depth 12 `
                        -DateKind String `
                        -ErrorAction Stop
            } catch {
                throw (
                    'An existing Desktop handoff preparation could not be ' +
                    'safely inspected.'
                )
            }
            if ($existingItem.PSIsContainer -or
                ($existingItem.Attributes -band
                    [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
                [long]$existingItem.Length -lt 128 -or
                [long]$existingItem.Length -gt 32768 -or
                [string]$existingUnverified.Signature -cne
                    'codex-local-remote/desktop-handoff-preparation/v1' -or
                [int]$existingUnverified.Version -ne 1) {
                throw (
                    'An existing Desktop handoff preparation is foreign or ' +
                    'has unsafe filesystem identity.'
                )
            }
            $existingSelf = $null
            try {
                if ([string]$existingUnverified.RuntimeVersionId -cmatch
                        '^[a-f0-9]{64}$' -and
                    [string]$existingUnverified.ManifestSha256 -cmatch
                        '^[a-f0-9]{64}$' -and
                    -not [string]::IsNullOrWhiteSpace(
                        [string]$existingUnverified.RuntimeRoot
                    )) {
                    $existingSelf =
                        Read-CodexLocalRemoteDesktopHandoffPreparation `
                            -DataDir $DataDir `
                            -ExpectedRuntimeVersionId (
                                [string](
                                    $existingUnverified.RuntimeVersionId
                                )
                            ) `
                            -ExpectedRuntimeRoot (
                                [string]$existingUnverified.RuntimeRoot
                            ) `
                            -ExpectedManifestSha256 (
                                [string](
                                    $existingUnverified.ManifestSha256
                                )
                            ) `
                            -RequireLiveOwnership
                }
            } catch {
                $existingSelf = $null
            }
            if ($null -ne $existingSelf) {
                throw (
                    'A different fresh Desktop handoff preparation already ' +
                    'exists.'
                )
            }
            Remove-Item `
                -LiteralPath $path `
                -Force `
                -ErrorAction Stop
            $existing = $null
        }
        if ($null -ne $existing -and
            [string]$existing.DesktopRootIdentityKey -ceq
                [string]$Ownership.DesktopRootIdentityKey -and
            [string]$existing.DesktopAppServerIdentityKey -ceq
                [string]$Ownership.DesktopAppServerIdentityKey -and
            [string]$existing.Phase -cin @(
                'requested',
                'ready'
            )) {
            return $existing
        }
        if ($null -ne $existing) {
            throw (
                'A different live Desktop handoff preparation already exists.'
            )
        }
    }
    $preparation = [ordered]@{
        Signature =
            'codex-local-remote/desktop-handoff-preparation/v1'
        Version = 1
        PreparationId = [Guid]::NewGuid().ToString('N')
        Phase = 'requested'
        RuntimeVersionId = $RuntimeVersionId
        RuntimeRoot = $resolvedRuntimeRoot
        ManifestSha256 = $ManifestSha256
        DesktopRootProcessId =
            [int]$Ownership.DesktopRootProcessId
        DesktopRootStartTimeUtcTicks =
            [long]$Ownership.DesktopRootStartTimeUtcTicks
        DesktopExecutablePath =
            [System.IO.Path]::GetFullPath(
                [string]$Ownership.DesktopExecutablePath
            )
        DesktopRootIdentityKey =
            [string]$Ownership.DesktopRootIdentityKey
        DesktopAppServerProcessId =
            [int]$Ownership.DesktopAppServerProcessId
        DesktopAppServerStartTimeUtcTicks =
            [long]$Ownership.DesktopAppServerStartTimeUtcTicks
        DesktopAppServerExecutablePath =
            [System.IO.Path]::GetFullPath(
                [string]$Ownership.DesktopAppServerExecutablePath
            )
        DesktopAppServerIdentityKey =
            [string]$Ownership.DesktopAppServerIdentityKey
        RequestedAtUtc = [DateTime]::UtcNow.ToString('O')
        ReadyAtUtc = $null
        AttachStartedAtUtc = $null
        RuntimeInvocationId = $null
        BrokerProcessId = $null
        UpstreamProcessId = $null
        SidecarProcessId = $null
    }
    Write-AtomicJsonFile -Path $path -Value $preparation
    $readBack =
        Read-CodexLocalRemoteDesktopHandoffPreparation `
            -DataDir $DataDir `
            -ExpectedRuntimeVersionId $RuntimeVersionId `
            -ExpectedRuntimeRoot $resolvedRuntimeRoot `
            -ExpectedManifestSha256 $ManifestSha256 `
            -RequireLiveOwnership
    if ($null -eq $readBack -or
        [string]$readBack.PreparationId -cne
            [string]$preparation.PreparationId) {
        throw (
            'Desktop handoff preparation failed exact read-back ' +
            'verification.'
        )
    }
    return $readBack
}

function Set-CodexLocalRemoteDesktopHandoffPreparationReady {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [object]$Preparation,

        [Parameter(Mandatory)]
        [object]$Readiness,

        [Parameter(Mandatory)]
        [ValidateRange(1, 2147483647)]
        [int]$SidecarProcessId
    )

    if ([string]$Readiness.status -cne 'ready' -or
        -not [bool]$Readiness.appServerReady -or
        [bool]$Readiness.desktopConnected -or
        -not [bool]$Readiness.sidecarConnected -or
        [bool]$Readiness.degraded -or
        -not (Test-NonNegativeInteger `
            -Value $Readiness.unknownCount) -or
        [int]$Readiness.unknownCount -ne 0 -or
        -not (Test-NonNegativeInteger `
            -Value $Readiness.unsafeThreadCount) -or
        [int]$Readiness.unsafeThreadCount -ne 0 -or
        [string]$Readiness.runtimeInvocationId -cnotmatch
            '^[a-f0-9]{32}$' -or
        -not (Test-NonNegativeInteger `
            -Value $Readiness.brokerProcessId) -or
        [int]$Readiness.brokerProcessId -le 0 -or
        -not (Test-NonNegativeInteger `
            -Value $Readiness.upstreamProcessId) -or
        [int]$Readiness.upstreamProcessId -le 0) {
        throw (
            'Desktop handoff preparation cannot become ready from an ' +
            'unverified transport snapshot.'
        )
    }
    $current =
        Read-CodexLocalRemoteDesktopHandoffPreparation `
            -DataDir $DataDir `
            -ExpectedRuntimeVersionId (
                [string]$Preparation.RuntimeVersionId
            ) `
            -ExpectedRuntimeRoot (
                [string]$Preparation.RuntimeRoot
            ) `
            -ExpectedManifestSha256 (
                [string]$Preparation.ManifestSha256
            ) `
            -RequireLiveOwnership
    if ($null -eq $current -or
        [string]$current.PreparationId -cne
            [string]$Preparation.PreparationId -or
        [string]$current.Phase -cnotin @('requested', 'ready')) {
        throw (
            'Desktop handoff preparation changed before transport ' +
            'readiness was committed.'
        )
    }
    if ([string]$current.Phase -ceq 'ready') {
        if ([string]$current.RuntimeInvocationId -ceq
                [string]$Readiness.runtimeInvocationId -and
            [int]$current.BrokerProcessId -eq
                [int]$Readiness.brokerProcessId -and
            [int]$current.UpstreamProcessId -eq
                [int]$Readiness.upstreamProcessId -and
            [int]$current.SidecarProcessId -eq $SidecarProcessId) {
            return $current
        }
        throw (
            'Desktop handoff preparation readiness identity changed.'
        )
    }
    $ready = [ordered]@{}
    foreach ($property in @(
        'Signature',
        'Version',
        'PreparationId',
        'RuntimeVersionId',
        'RuntimeRoot',
        'ManifestSha256',
        'DesktopRootProcessId',
        'DesktopRootStartTimeUtcTicks',
        'DesktopExecutablePath',
        'DesktopRootIdentityKey',
        'DesktopAppServerProcessId',
        'DesktopAppServerStartTimeUtcTicks',
        'DesktopAppServerExecutablePath',
        'DesktopAppServerIdentityKey',
        'RequestedAtUtc'
    )) {
        $ready[$property] = $current.$property
    }
    $ready.Phase = 'ready'
    $ready.ReadyAtUtc = [DateTime]::UtcNow.ToString('O')
    $ready.AttachStartedAtUtc = $null
    $ready.RuntimeInvocationId =
        [string]$Readiness.runtimeInvocationId
    $ready.BrokerProcessId = [int]$Readiness.brokerProcessId
    $ready.UpstreamProcessId = [int]$Readiness.upstreamProcessId
    $ready.SidecarProcessId = $SidecarProcessId
    Write-AtomicJsonFile -Path ([string]$current.Path) -Value $ready
    $readBack =
        Read-CodexLocalRemoteDesktopHandoffPreparation `
            -DataDir $DataDir `
            -ExpectedRuntimeVersionId (
                [string]$current.RuntimeVersionId
            ) `
            -ExpectedRuntimeRoot ([string]$current.RuntimeRoot) `
            -ExpectedManifestSha256 (
                [string]$current.ManifestSha256
            ) `
            -RequireLiveOwnership
    if ($null -eq $readBack -or
        [string]$readBack.PreparationId -cne
            [string]$current.PreparationId -or
        [string]$readBack.Phase -cne 'ready') {
        throw (
            'Desktop handoff ready preparation failed exact read-back ' +
            'verification.'
        )
    }
    return $readBack
}

function Set-CodexLocalRemoteDesktopHandoffPreparationAttaching {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [object]$Preparation
    )

    $current =
        Read-CodexLocalRemoteDesktopHandoffPreparation `
            -DataDir $DataDir `
            -ExpectedRuntimeVersionId (
                [string]$Preparation.RuntimeVersionId
            ) `
            -ExpectedRuntimeRoot (
                [string]$Preparation.RuntimeRoot
            ) `
            -ExpectedManifestSha256 (
                [string]$Preparation.ManifestSha256
            ) `
            -RequireLiveOwnership
    if ($null -eq $current -or
        [string]$current.PreparationId -cne
            [string]$Preparation.PreparationId -or
        [string]$current.Phase -cnotin @('ready', 'attaching')) {
        throw (
            'Desktop handoff preparation is not ready for attach.'
        )
    }
    if ([string]$current.Phase -ceq 'attaching') {
        return $current
    }
    $attaching = [ordered]@{}
    foreach ($property in @(
        'Signature',
        'Version',
        'PreparationId',
        'RuntimeVersionId',
        'RuntimeRoot',
        'ManifestSha256',
        'DesktopRootProcessId',
        'DesktopRootStartTimeUtcTicks',
        'DesktopExecutablePath',
        'DesktopRootIdentityKey',
        'DesktopAppServerProcessId',
        'DesktopAppServerStartTimeUtcTicks',
        'DesktopAppServerExecutablePath',
        'DesktopAppServerIdentityKey',
        'RequestedAtUtc',
        'ReadyAtUtc',
        'RuntimeInvocationId',
        'BrokerProcessId',
        'UpstreamProcessId',
        'SidecarProcessId'
    )) {
        $attaching[$property] = $current.$property
    }
    $attaching.Phase = 'attaching'
    $attaching.AttachStartedAtUtc = [DateTime]::UtcNow.ToString('O')
    Write-AtomicJsonFile `
        -Path ([string]$current.Path) `
        -Value $attaching
    $readBack =
        Read-CodexLocalRemoteDesktopHandoffPreparation `
            -DataDir $DataDir `
            -ExpectedRuntimeVersionId (
                [string]$current.RuntimeVersionId
            ) `
            -ExpectedRuntimeRoot ([string]$current.RuntimeRoot) `
            -ExpectedManifestSha256 (
                [string]$current.ManifestSha256
            )
    if ($null -eq $readBack -or
        [string]$readBack.PreparationId -cne
            [string]$current.PreparationId -or
        [string]$readBack.Phase -cne 'attaching') {
        throw (
            'Desktop handoff attaching preparation failed exact ' +
            'read-back verification.'
        )
    }
    return $readBack
}

function Complete-CodexLocalRemoteDesktopHandoffPreparation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [object]$Preparation,

        [Parameter(Mandatory)]
        [string]$Outcome
    )

    $current =
        Read-CodexLocalRemoteDesktopHandoffPreparation `
            -DataDir $DataDir `
            -ExpectedRuntimeVersionId (
                [string]$Preparation.RuntimeVersionId
            ) `
            -ExpectedRuntimeRoot (
                [string]$Preparation.RuntimeRoot
            ) `
            -ExpectedManifestSha256 (
                [string]$Preparation.ManifestSha256
            )
    if ($null -eq $current -or
        [string]$current.PreparationId -cne
            [string]$Preparation.PreparationId) {
        return $false
    }
    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
    Write-AtomicJsonFile `
        -Path (
            Join-Path `
                $resolvedDataDir `
                'desktop-handoff-preparation-last.json'
        ) `
        -Value ([ordered]@{
            Signature =
                'codex-local-remote/desktop-handoff-preparation-receipt/v1'
            Version = 1
            PreparationId = [string]$current.PreparationId
            RuntimeVersionId = [string]$current.RuntimeVersionId
            RuntimeInvocationId = $current.RuntimeInvocationId
            Outcome = $Outcome
            RecordedAtUtc = [DateTime]::UtcNow.ToString('O')
        })
    Remove-Item `
        -LiteralPath ([string]$current.Path) `
        -Force `
        -ErrorAction Stop
    return $true
}

function Assert-ForceCliDisabled {
    [CmdletBinding()]
    param()

    $blockedScopes = [System.Collections.Generic.List[string]]::new()
    foreach ($scope in @(
        [System.EnvironmentVariableTarget]::Process,
        [System.EnvironmentVariableTarget]::User,
        [System.EnvironmentVariableTarget]::Machine
    )) {
        $value = [System.Environment]::GetEnvironmentVariable(
            'CODEX_APP_SERVER_FORCE_CLI',
            $scope
        )
        if (-not [string]::IsNullOrWhiteSpace($value) -and $value.Trim() -ceq '1') {
            $blockedScopes.Add($scope.ToString().ToLowerInvariant())
        }
    }
    if ($blockedScopes.Count -gt 0) {
        throw "CODEX_APP_SERVER_FORCE_CLI=1 is set at scope(s): $($blockedScopes -join ', '). It would create a second app-server owner, so installation/startup is blocked."
    }
}

function Get-CodexLocalRemoteAtomicWriteMutexName {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    $pathIdentity = $resolvedPath.ToUpperInvariant()
    $pathHash = Get-StringSha256 -Value $pathIdentity
    return "Global\CodexLocalRemote.AtomicJson.$pathHash"
}

function Write-AtomicJsonFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter(Mandatory)]
        [object]$Value
    )

    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    $parent = [System.IO.Path]::GetDirectoryName($resolvedPath)
    $mutexName = Get-CodexLocalRemoteAtomicWriteMutexName -Path $resolvedPath
    $writeMutex = [System.Threading.Mutex]::new($false, $mutexName)
    $lockTaken = $false
    $temporary = $null
    try {
        try {
            $lockTaken = $writeMutex.WaitOne([TimeSpan]::FromSeconds(15))
        } catch [System.Threading.AbandonedMutexException] {
            $lockTaken = $true
        }
        if (-not $lockTaken) {
            throw "Timed out waiting for the managed JSON writer lock for '$resolvedPath'."
        }

        $ownershipPlan = Get-CodexLocalRemoteDataDirectoryOwnershipPlan `
            -DataDir $parent
        if ($ownershipPlan.Action -cne 'owned') {
            $null = Protect-CodexLocalRemoteDataDirectory -DataDir $parent
        }
        $null = Assert-CodexLocalRemoteDataDirectoryStartupProtection `
            -DataDir $parent
        $temporary = Join-Path $parent ".$([System.IO.Path]::GetFileName($resolvedPath)).$([guid]::NewGuid().ToString('N')).tmp"
        $Value |
            ConvertTo-Json -Depth 20 |
            Set-Content -LiteralPath $temporary -Encoding utf8NoBOM
        [System.IO.File]::Move($temporary, $resolvedPath, $true)
    } finally {
        if (-not [string]::IsNullOrWhiteSpace($temporary)) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
        if ($lockTaken) {
            try {
                $writeMutex.ReleaseMutex()
            } catch [System.ApplicationException] {
                # The lock was abandoned or released while unwinding; disposal remains safe.
            }
        }
        $writeMutex.Dispose()
    }
}

function Get-CodexDesktopOwnerIntentPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    return [System.IO.Path]::GetFullPath(
        (Join-Path ([System.IO.Path]::GetFullPath($DataDir)) 'desktop-owner-intent.json')
    )
}

function Get-CodexDesktopOwnerConnectionProofPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    return [System.IO.Path]::GetFullPath(
        (Join-Path ([System.IO.Path]::GetFullPath($DataDir)) 'desktop-owner-proof.json')
    )
}

function Get-CodexDesktopOwnerRootIdentityKey {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateRange(1, 2147483647)]
        [int]$ProcessId,

        [Parameter(Mandatory)]
        [ValidateRange(1, [long]::MaxValue)]
        [long]$StartTimeUtcTicks,

        [Parameter(Mandatory)]
        [string]$ExecutablePath
    )

    $resolvedPath = [System.IO.Path]::GetFullPath($ExecutablePath)
    if ([string]::IsNullOrWhiteSpace($resolvedPath)) {
        throw 'The Desktop owner executable path is invalid.'
    }
    $pathDigest = Get-StringSha256 -Value $resolvedPath.ToUpperInvariant()
    return "$ProcessId|$StartTimeUtcTicks|$pathDigest"
}

function Get-CodexDesktopOwnerMutexName {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $identity = [System.IO.Path]::GetFullPath($DataDir).ToUpperInvariant()
    return "Global\CodexLocalRemote.DesktopOwner.$(Get-StringSha256 -Value $identity)"
}

function Invoke-WithCodexDesktopOwnerMutex {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [scriptblock]$Action,

        [ValidateRange(1, 120)]
        [int]$TimeoutSeconds = 30
    )

    $mutex = [System.Threading.Mutex]::new(
        $false,
        (Get-CodexDesktopOwnerMutexName -DataDir $DataDir)
    )
    $lockTaken = $false
    try {
        try {
            $lockTaken = $mutex.WaitOne(
                [TimeSpan]::FromSeconds($TimeoutSeconds)
            )
        } catch [System.Threading.AbandonedMutexException] {
            $lockTaken = $true
        }
        if (-not $lockTaken) {
            throw 'Timed out waiting for the single Desktop owner.'
        }
        return & $Action
    } finally {
        if ($lockTaken) {
            try {
                $mutex.ReleaseMutex()
            } catch [System.ApplicationException] {
                # An abandoned owner is still safe to dispose.
            }
        }
        $mutex.Dispose()
    }
}

function New-CodexDesktopOwnerIntent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [string]$TargetRuntimeVersionId,

        [Parameter(Mandatory)]
        [string]$TargetRuntimeRoot
    )

    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
    return Invoke-WithCodexDesktopOwnerMutex `
        -DataDir $resolvedDataDir `
        -Action {
            New-CodexDesktopOwnerIntentUnderOwnerLock `
                -DataDir $resolvedDataDir `
                -TargetRuntimeVersionId $TargetRuntimeVersionId `
                -TargetRuntimeRoot $TargetRuntimeRoot
        }
}

function New-CodexDesktopOwnerIntentUnderOwnerLock {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [string]$TargetRuntimeVersionId,

        [Parameter(Mandatory)]
        [string]$TargetRuntimeRoot
    )

    if ($TargetRuntimeVersionId -cnotmatch '^[0-9a-f]{64}$') {
        throw 'The Desktop owner intent runtime version is invalid.'
    }
    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
    $resolvedRuntimeRoot = [System.IO.Path]::GetFullPath($TargetRuntimeRoot)
    $existingIntent = Read-CodexDesktopOwnerIntent `
        -DataDir $resolvedDataDir `
        -ExpectedRuntimeVersionId $TargetRuntimeVersionId `
        -ExpectedRuntimeRoot $resolvedRuntimeRoot
    if ($null -ne $existingIntent -and
        [string]$existingIntent.Freshness -ceq 'fresh') {
        return $existingIntent
    }
    $intent = [ordered]@{
        Signature = 'codex-local-remote/desktop-owner-intent/v1'
        Version = 1
        IntentId = [Guid]::NewGuid().ToString('N')
        TargetRuntimeVersionId = $TargetRuntimeVersionId
        TargetRuntimeRoot = $resolvedRuntimeRoot
        RequestedAtUtc = [DateTime]::UtcNow.ToString('O')
    }
    Write-AtomicJsonFile `
        -Path (Get-CodexDesktopOwnerIntentPath -DataDir $resolvedDataDir) `
        -Value $intent
    return [pscustomobject]$intent
}

function Get-CodexDesktopOwnerIntentFreshnessDecision {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$RequestedAtUtc,

        [DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow,

        [ValidateRange(1, 3600)]
        [int]$MaximumAgeSeconds = 120,

        [ValidateRange(0, 60)]
        [int]$MaximumFutureSkewSeconds = 5
    )

    try {
        $requestedAt = [DateTimeOffset]::Parse(
            $RequestedAtUtc,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
    } catch {
        return 'invalid'
    }
    if ($requestedAt.Offset -ne [TimeSpan]::Zero) {
        return 'invalid'
    }
    if ($requestedAt -gt
        $NowUtc.ToUniversalTime().AddSeconds($MaximumFutureSkewSeconds)) {
        return 'future'
    }
    if ($requestedAt -lt
        $NowUtc.ToUniversalTime().AddSeconds(-$MaximumAgeSeconds)) {
        return 'expired'
    }
    return 'fresh'
}

function Read-CodexDesktopOwnerIntent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [string]$ExpectedRuntimeVersionId,

        [Parameter(Mandatory)]
        [string]$ExpectedRuntimeRoot,

        [ValidateRange(1, 3600)]
        [int]$MaximumAgeSeconds = 120,

        [DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow
    )

    $path = Get-CodexDesktopOwnerIntentPath -DataDir $DataDir
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return $null
    }
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [long]$item.Length -lt 32 -or
        [long]$item.Length -gt 8192) {
        return $null
    }
    try {
        $rawBefore = Get-Content -LiteralPath $path -Raw -Encoding utf8
        $intent = $rawBefore |
            ConvertFrom-Json -Depth 8 -DateKind String -ErrorAction Stop
        $rawAfter = Get-Content -LiteralPath $path -Raw -Encoding utf8
        $runtimeRoot = [System.IO.Path]::GetFullPath(
            [string]$intent.TargetRuntimeRoot
        )
    } catch {
        return $null
    }
    $expectedProperties = @(
        'Signature',
        'Version',
        'IntentId',
        'TargetRuntimeVersionId',
        'TargetRuntimeRoot',
        'RequestedAtUtc'
    )
    $actualProperties = @($intent.PSObject.Properties.Name | Sort-Object)
    if ($rawBefore -cne $rawAfter -or
        (ConvertTo-CanonicalJson $actualProperties) -cne
            (ConvertTo-CanonicalJson @($expectedProperties | Sort-Object)) -or
        [string]$intent.Signature -cne
            'codex-local-remote/desktop-owner-intent/v1' -or
        [int]$intent.Version -ne 1 -or
        [string]$intent.IntentId -cnotmatch '^[0-9a-f]{32}$' -or
        [string]$intent.TargetRuntimeVersionId -cne
            $ExpectedRuntimeVersionId -or
        -not [string]::Equals(
            $runtimeRoot,
            [System.IO.Path]::GetFullPath($ExpectedRuntimeRoot),
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        return $null
    }
    $freshness = Get-CodexDesktopOwnerIntentFreshnessDecision `
        -RequestedAtUtc ([string]$intent.RequestedAtUtc) `
        -NowUtc $NowUtc `
        -MaximumAgeSeconds $MaximumAgeSeconds
    $intent | Add-Member `
        -NotePropertyName 'Freshness' `
        -NotePropertyValue $freshness
    return $intent
}

function Write-CodexDesktopOwnerConnectionProof {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [string]$RuntimeInvocationId,

        [Parameter(Mandatory)]
        [ValidateRange(1, 2147483647)]
        [int]$ProcessId,

        [Parameter(Mandatory)]
        [ValidateRange(1, [long]::MaxValue)]
        [long]$StartTimeUtcTicks,

        [Parameter(Mandatory)]
        [string]$ExecutablePath,

        [Parameter(Mandatory)]
        [string]$LaunchNonceDigest
    )

    if ($RuntimeInvocationId -cnotmatch '^[0-9a-f]{32}$') {
        throw 'The Desktop owner proof runtime invocation is invalid.'
    }
    if ($LaunchNonceDigest -cnotmatch '^[0-9a-f]{64}$') {
        throw 'The Desktop owner proof launch nonce digest is invalid.'
    }
    $resolvedPath = [System.IO.Path]::GetFullPath($ExecutablePath)
    $rootIdentityKey = Get-CodexDesktopOwnerRootIdentityKey `
        -ProcessId $ProcessId `
        -StartTimeUtcTicks $StartTimeUtcTicks `
        -ExecutablePath $resolvedPath
    $proof = [ordered]@{
        Signature = 'codex-local-remote/desktop-owner-proof/v1'
        Version = 1
        RuntimeInvocationId = $RuntimeInvocationId
        ProcessId = $ProcessId
        StartTimeUtcTicks = $StartTimeUtcTicks
        ExecutablePath = $resolvedPath
        RootIdentityKey = $rootIdentityKey
        LaunchNonceDigest = $LaunchNonceDigest
        RecordedAtUtc = [DateTime]::UtcNow.ToString('O')
    }
    Write-AtomicJsonFile `
        -Path (Get-CodexDesktopOwnerConnectionProofPath -DataDir $DataDir) `
        -Value $proof
    return [pscustomobject]$proof
}

function Read-CodexDesktopOwnerConnectionProof {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $path = Get-CodexDesktopOwnerConnectionProofPath -DataDir $DataDir
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return $null
    }
    try {
        $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or
            ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            [long]$item.Length -lt 64 -or
            [long]$item.Length -gt 8192) {
            return $null
        }
        $rawBefore = Get-Content -LiteralPath $path -Raw -Encoding utf8
        $proof = $rawBefore |
            ConvertFrom-Json -Depth 8 -DateKind String -ErrorAction Stop
        $rawAfter = Get-Content -LiteralPath $path -Raw -Encoding utf8
        $resolvedPath = [System.IO.Path]::GetFullPath(
            [string]$proof.ExecutablePath
        )
        $recordedAt = [DateTimeOffset]::Parse(
            [string]$proof.RecordedAtUtc,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
    } catch {
        return $null
    }
    $expectedProperties = @(
        'Signature',
        'Version',
        'RuntimeInvocationId',
        'ProcessId',
        'StartTimeUtcTicks',
        'ExecutablePath',
        'RootIdentityKey',
        'LaunchNonceDigest',
        'RecordedAtUtc'
    )
    $actualProperties = @($proof.PSObject.Properties.Name | Sort-Object)
    if ($rawBefore -cne $rawAfter -or
        (ConvertTo-CanonicalJson $actualProperties) -cne
            (ConvertTo-CanonicalJson @($expectedProperties | Sort-Object)) -or
        [string]$proof.Signature -cne
            'codex-local-remote/desktop-owner-proof/v1' -or
        [int]$proof.Version -ne 1 -or
        [string]$proof.RuntimeInvocationId -cnotmatch '^[0-9a-f]{32}$' -or
        -not (Test-NonNegativeInteger -Value $proof.ProcessId) -or
        [decimal]$proof.ProcessId -le 0 -or
        [decimal]$proof.ProcessId -gt [int]::MaxValue -or
        -not (Test-NonNegativeInteger -Value $proof.StartTimeUtcTicks) -or
        [decimal]$proof.StartTimeUtcTicks -le 0 -or
        [decimal]$proof.StartTimeUtcTicks -gt [long]::MaxValue -or
        [string]$proof.LaunchNonceDigest -cnotmatch '^[0-9a-f]{64}$' -or
        $recordedAt.Offset -ne [TimeSpan]::Zero) {
        return $null
    }
    $rootIdentityKey = Get-CodexDesktopOwnerRootIdentityKey `
        -ProcessId ([int]$proof.ProcessId) `
        -StartTimeUtcTicks ([long]$proof.StartTimeUtcTicks) `
        -ExecutablePath $resolvedPath
    if ([string]$proof.RootIdentityKey -cne $rootIdentityKey) {
        return $null
    }
    return [pscustomobject]@{
        RuntimeInvocationId = [string]$proof.RuntimeInvocationId
        ProcessId = [int]$proof.ProcessId
        StartTimeUtcTicks = [long]$proof.StartTimeUtcTicks
        ExecutablePath = $resolvedPath
        RootIdentityKey = $rootIdentityKey
        LaunchNonceDigest = [string]$proof.LaunchNonceDigest
        RecordedAtUtc = [string]$proof.RecordedAtUtc
    }
}

function Remove-CodexDesktopOwnerConnectionProof {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $path = Get-CodexDesktopOwnerConnectionProofPath -DataDir $DataDir
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force -ErrorAction Stop
    }
}

function Complete-CodexDesktopOwnerIntent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [object]$Intent,

        [Parameter(Mandatory)]
        [string]$RuntimeInvocationId,

        [Parameter(Mandatory)]
        [string]$Outcome
    )

    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
    Write-AtomicJsonFile `
        -Path (Join-Path $resolvedDataDir 'desktop-owner-intent-last.json') `
        -Value ([ordered]@{
            Signature = 'codex-local-remote/desktop-owner-intent-receipt/v1'
            Version = 1
            IntentId = [string]$Intent.IntentId
            RuntimeInvocationId = $RuntimeInvocationId
            Outcome = $Outcome
            RecordedAtUtc = [DateTime]::UtcNow.ToString('O')
        })
    $path = Get-CodexDesktopOwnerIntentPath -DataDir $resolvedDataDir
    $current = Read-CodexDesktopOwnerIntent `
        -DataDir $resolvedDataDir `
        -ExpectedRuntimeVersionId ([string]$Intent.TargetRuntimeVersionId) `
        -ExpectedRuntimeRoot ([string]$Intent.TargetRuntimeRoot)
    if ($null -ne $current -and
        [string]$current.IntentId -ceq [string]$Intent.IntentId) {
        Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    }
}

function Test-CodexDesktopOwnerResumeGap {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [DateTimeOffset]$PreviousObservationUtc,

        [Parameter(Mandatory)]
        [DateTimeOffset]$CurrentObservationUtc,

        [ValidateRange(10, 3600)]
        [int]$MinimumGapSeconds = 30
    )

    $previous = $PreviousObservationUtc.ToUniversalTime()
    $current = $CurrentObservationUtc.ToUniversalTime()
    return (
        $current -ge $previous -and
        ($current - $previous).TotalSeconds -ge $MinimumGapSeconds
    )
}

function Get-CodexDesktopOwnerDecision {
    [CmdletBinding()]
    param(
        [bool]$DesktopConnected,
        [bool]$StartupIntentPending,
        [bool]$HasPendingIntent,
        [AllowNull()][string]$RootIdentityKey,
        [AllowNull()][string]$LastAttemptedRootIdentityKey,
        [AllowNull()][string]$LastVerifiedConnectedRootIdentityKey,
        [AllowNull()][string]$LastDisconnectedRecoveryRootIdentityKey,
        [bool]$AutomaticTakeoverAllowed = $false,
        [bool]$RuntimeGenerationCurrent = $true
    )

    if ($DesktopConnected) {
        return 'idle-connected'
    }
    if ($StartupIntentPending -or $HasPendingIntent) {
        return 'launch-intent'
    }
    # Observation never creates takeover authority. Root identity and runtime
    # health can constrain an explicit intent, but no root may authorize its
    # own takeover or crash recovery.
    return 'idle'
}

function Test-CodexDesktopNonceReadinessSnapshot {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Readiness
    )

    if ((Get-BrokerReadinessDecision `
        -Readiness $Readiness `
        -Phase Infrastructure) -cne 'Ready') {
        return $false
    }
    foreach ($name in @(
        'runtimeInvocationId',
        'brokerProcessId',
        'upstreamProcessId',
        'runtimeReceiptInvocationId',
        'runtimeReceiptBrokerProcessId',
        'runtimeReceiptUpstreamProcessId',
        'desktopConnectionCount',
        'desktopLaunchNonceDigests'
    )) {
        if ($null -eq $Readiness.PSObject.Properties[$name]) {
            return $false
        }
    }
    if ([string]$Readiness.runtimeInvocationId -cnotmatch
            '^[0-9a-f]{32}$' -or
        [string]$Readiness.runtimeReceiptInvocationId -cne
            [string]$Readiness.runtimeInvocationId -or
        -not (Test-NonNegativeInteger -Value $Readiness.brokerProcessId) -or
        [decimal]$Readiness.brokerProcessId -le 0 -or
        -not (Test-NonNegativeInteger -Value $Readiness.upstreamProcessId) -or
        [decimal]$Readiness.upstreamProcessId -le 0 -or
        -not (Test-NonNegativeInteger `
            -Value $Readiness.runtimeReceiptBrokerProcessId) -or
        [decimal]$Readiness.runtimeReceiptBrokerProcessId -ne
            [decimal]$Readiness.brokerProcessId -or
        -not (Test-NonNegativeInteger `
            -Value $Readiness.runtimeReceiptUpstreamProcessId) -or
        [decimal]$Readiness.runtimeReceiptUpstreamProcessId -ne
            [decimal]$Readiness.upstreamProcessId -or
        -not (Test-NonNegativeInteger `
            -Value $Readiness.desktopConnectionCount) -or
        [decimal]$Readiness.desktopConnectionCount -gt 1024 -or
        [bool]$Readiness.desktopConnected -ne
            ([decimal]$Readiness.desktopConnectionCount -gt 0)) {
        return $false
    }
    $digestProperty = $Readiness.PSObject.Properties[
        'desktopLaunchNonceDigests'
    ]
    if ($digestProperty.Value -isnot [System.Array]) {
        return $false
    }
    $digests = @($digestProperty.Value)
    if ($digests.Count -gt [decimal]$Readiness.desktopConnectionCount) {
        return $false
    }
    foreach ($digest in $digests) {
        if ([string]$digest -cnotmatch '^[0-9a-f]{64}$') {
            return $false
        }
    }
    return $true
}

function Test-CodexDesktopOwnerConnectedProof {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Readiness,

        [Parameter(Mandatory)]
        [string]$ExpectedRuntimeInvocationId,

        [Parameter(Mandatory)]
        [string]$ExpectedLaunchNonceDigest,

        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$RootIdentityKey
    )

    if ($ExpectedRuntimeInvocationId -cnotmatch '^[0-9a-f]{32}$' -or
        $ExpectedLaunchNonceDigest -cnotmatch '^[0-9a-f]{64}$' -or
        [string]::IsNullOrWhiteSpace($RootIdentityKey) -or
        -not (Test-CodexDesktopNonceReadinessSnapshot `
            -Readiness $Readiness) -or
        [string]$Readiness.runtimeInvocationId -cne
            $ExpectedRuntimeInvocationId -or
        -not [bool]$Readiness.desktopConnected -or
        [int]$Readiness.unknownCount -ne 0) {
        return $false
    }
    $connectionCount = [int]$Readiness.desktopConnectionCount
    $digests = @($Readiness.desktopLaunchNonceDigests)
    return (
        $connectionCount -gt 0 -and
        $digests.Count -eq $connectionCount -and
        @($digests | Select-Object -Unique).Count -eq 1 -and
        [string]$digests[0] -ceq $ExpectedLaunchNonceDigest
    )
}

function Test-CodexDesktopOwnerConnectionProof {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Readiness,

        [AllowNull()]
        [object]$Proof,

        [Parameter(Mandatory)]
        [string]$ExpectedRuntimeInvocationId,

        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$RootIdentityKey
    )

    if ($null -eq $Proof -or
        $null -eq $Proof.PSObject.Properties['RuntimeInvocationId'] -or
        $null -eq $Proof.PSObject.Properties['RootIdentityKey'] -or
        $null -eq $Proof.PSObject.Properties['LaunchNonceDigest'] -or
        [string]$Proof.RuntimeInvocationId -cne
            $ExpectedRuntimeInvocationId -or
        [string]$Proof.RootIdentityKey -cne $RootIdentityKey) {
        return $false
    }
    return Test-CodexDesktopOwnerConnectedProof `
        -Readiness $Readiness `
        -ExpectedRuntimeInvocationId $ExpectedRuntimeInvocationId `
        -ExpectedLaunchNonceDigest ([string]$Proof.LaunchNonceDigest) `
        -RootIdentityKey $RootIdentityKey
}

function Get-CodexLocalRemoteManagedConfiguration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
    $configurationPath = Join-Path $resolvedDataDir 'managed-config.json'
    if (-not (Test-Path -LiteralPath $configurationPath -PathType Leaf)) {
        return $null
    }
    $null = Assert-CodexLocalRemoteDataDirectoryOwnerMarker -DataDir $resolvedDataDir
    $item = Get-Item -LiteralPath $configurationPath -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [long]$item.Length -lt 64 -or
        [long]$item.Length -gt 16384) {
        throw "Managed configuration '$configurationPath' is not an ordinary bounded file."
    }
    $configuration = Get-Content -LiteralPath $configurationPath -Raw -Encoding utf8 |
        ConvertFrom-Json -Depth 10 -DateKind String -ErrorAction Stop
    $expectedProperties = @(
        'Signature',
        'Version',
        'SidecarPort',
        'BrokerPort',
        'BrokerUpstreamPort',
        'BasePath',
        'TaskName',
        'UpdatedAtUtc'
    )
    $actualProperties = @($configuration.PSObject.Properties.Name | Sort-Object)
    if ((ConvertTo-CanonicalJson $actualProperties) -cne
        (ConvertTo-CanonicalJson @($expectedProperties | Sort-Object)) -or
        [string]$configuration.Signature -cne
            'codex-local-remote/managed-config/v1' -or
        [int]$configuration.Version -ne 1) {
        throw "Managed configuration '$configurationPath' has an invalid schema."
    }
    foreach ($port in @(
        $configuration.SidecarPort,
        $configuration.BrokerPort,
        $configuration.BrokerUpstreamPort
    )) {
        if (-not (Test-NonNegativeInteger -Value $port) -or
            [decimal]$port -lt 1 -or
            [decimal]$port -gt 65535) {
            throw "Managed configuration '$configurationPath' has an invalid port."
        }
    }
    $ports = @(
        [int]$configuration.SidecarPort,
        [int]$configuration.BrokerPort,
        [int]$configuration.BrokerUpstreamPort
    )
    if (@($ports | Sort-Object -Unique).Count -ne 3) {
        throw "Managed configuration '$configurationPath' reuses a managed port."
    }
    Assert-CanonicalBasePath -BasePath ([string]$configuration.BasePath)
    $taskName = [string]$configuration.TaskName
    if ([string]::IsNullOrWhiteSpace($taskName) -or
        $taskName.Length -gt 128 -or
        $taskName -match '[\x00-\x1F]') {
        throw "Managed configuration '$configurationPath' has an invalid task name."
    }
    try {
        $updatedAt = [DateTimeOffset]::Parse(
            [string]$configuration.UpdatedAtUtc,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind
        )
    } catch {
        throw "Managed configuration '$configurationPath' has an invalid timestamp."
    }
    if ($updatedAt.Offset -ne [TimeSpan]::Zero) {
        throw "Managed configuration '$configurationPath' has an invalid timestamp."
    }
    return [pscustomobject]@{
        Signature = [string]$configuration.Signature
        Version = [int]$configuration.Version
        SidecarPort = [int]$configuration.SidecarPort
        BrokerPort = [int]$configuration.BrokerPort
        BrokerUpstreamPort = [int]$configuration.BrokerUpstreamPort
        BasePath = [string]$configuration.BasePath
        TaskName = $taskName
        UpdatedAtUtc = [string]$configuration.UpdatedAtUtc
        ConfigurationPath = $configurationPath
    }
}

function Set-CodexLocalRemoteManagedConfiguration {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$SidecarPort,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$BrokerPort,

        [Parameter(Mandatory)]
        [ValidateRange(1, 65535)]
        [int]$BrokerUpstreamPort,

        [Parameter(Mandatory)]
        [string]$BasePath,

        [Parameter(Mandatory)]
        [string]$TaskName
    )

    Assert-CanonicalBasePath -BasePath $BasePath
    if (@(@($SidecarPort, $BrokerPort, $BrokerUpstreamPort) |
            Sort-Object -Unique).Count -ne 3) {
        throw 'Sidecar, Broker, and upstream ports must be distinct.'
    }
    if ([string]::IsNullOrWhiteSpace($TaskName) -or
        $TaskName.Length -gt 128 -or
        $TaskName -match '[\x00-\x1F]') {
        throw 'TaskName is invalid.'
    }
    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
    $null = Protect-CodexLocalRemoteDataDirectory -DataDir $resolvedDataDir
    $configurationPath = Join-Path $resolvedDataDir 'managed-config.json'
    $value = [ordered]@{
        Signature = 'codex-local-remote/managed-config/v1'
        Version = 1
        SidecarPort = $SidecarPort
        BrokerPort = $BrokerPort
        BrokerUpstreamPort = $BrokerUpstreamPort
        BasePath = $BasePath
        TaskName = $TaskName
        UpdatedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    }
    Write-AtomicJsonFile -Path $configurationPath -Value $value
    $readBack = Get-CodexLocalRemoteManagedConfiguration -DataDir $resolvedDataDir
    if ($null -eq $readBack -or
        [int]$readBack.SidecarPort -ne $SidecarPort -or
        [int]$readBack.BrokerPort -ne $BrokerPort -or
        [int]$readBack.BrokerUpstreamPort -ne $BrokerUpstreamPort -or
        [string]$readBack.BasePath -cne $BasePath -or
        [string]$readBack.TaskName -cne $TaskName) {
        throw 'Managed configuration failed exact read-back verification.'
    }
    return $readBack
}

function Get-CodexLocalRemoteRuntimeVersionPlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$SourceRoot,

        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $resolvedSourceRoot = [System.IO.Path]::GetFullPath($SourceRoot)
    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
    if (-not (Test-Path -LiteralPath $resolvedSourceRoot -PathType Container)) {
        throw "Runtime source root '$resolvedSourceRoot' does not exist."
    }
    $sourceRootItem = Get-Item -LiteralPath $resolvedSourceRoot -Force -ErrorAction Stop
    if (($sourceRootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Runtime source root '$resolvedSourceRoot' is a reparse point."
    }

    $relativeFiles = [System.Collections.Generic.Dictionary[string, string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $requiredFile = Join-Path $resolvedSourceRoot 'package.json'
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Runtime package source '$requiredFile' is missing."
    }
    $relativeFiles['package.json'] = $requiredFile

    foreach ($relativeDirectory in @(
        'apps\broker\dist',
        'apps\sidecar\dist',
        'apps\web\dist',
        'scripts\windows'
    )) {
        $directoryPath = Join-Path $resolvedSourceRoot $relativeDirectory
        if (-not (Test-Path -LiteralPath $directoryPath -PathType Container)) {
            throw "Runtime package source directory '$directoryPath' is missing. Run pnpm build first."
        }
        foreach ($directory in @(
            Get-Item -LiteralPath $directoryPath -Force -ErrorAction Stop
            Get-ChildItem -LiteralPath $directoryPath -Directory -Recurse -Force -ErrorAction Stop
        )) {
            if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Runtime package source directory '$($directory.FullName)' is a reparse point."
            }
        }
        foreach ($file in @(
            Get-ChildItem -LiteralPath $directoryPath -File -Recurse -Force -ErrorAction Stop
        )) {
            if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Runtime package source file '$($file.FullName)' is a reparse point."
            }
            $relativePath = [System.IO.Path]::GetRelativePath(
                $resolvedSourceRoot,
                [string]$file.FullName
            ).Replace('\', '/')
            $relativeFiles[$relativePath] = [string]$file.FullName
        }
    }

    $copyFiles = [System.Collections.Generic.List[object]]::new()
    $manifestFiles = [System.Collections.Generic.List[object]]::new()
    foreach ($relativePath in @($relativeFiles.Keys | Sort-Object)) {
        $sourcePath = [System.IO.Path]::GetFullPath($relativeFiles[$relativePath])
        $item = Get-Item -LiteralPath $sourcePath -Force -ErrorAction Stop
        if ($item.PSIsContainer -or
            ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Runtime package source '$sourcePath' is not an ordinary file."
        }
        $sha256 = (
            Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256 -ErrorAction Stop
        ).Hash.ToLowerInvariant()
        $entry = [pscustomobject]@{
            Path = $relativePath
            Sha256 = $sha256
            Size = [long]$item.Length
        }
        $manifestFiles.Add($entry)
        $copyFiles.Add([pscustomobject]@{
            Path = $relativePath
            SourcePath = $sourcePath
            Sha256 = $sha256
            Size = [long]$item.Length
        })
    }
    if ($copyFiles.Count -lt 5) {
        throw 'The runtime package source set is unexpectedly incomplete.'
    }

    $sourceCommit = $null
    $sourceDirty = $false
    if ($null -ne (Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue)) {
        $commitOutput = @(
            & git.exe -C $resolvedSourceRoot rev-parse HEAD 2>$null
        )
        if ($LASTEXITCODE -eq 0 -and
            $commitOutput.Count -eq 1 -and
            [string]$commitOutput[0] -cmatch '^[a-f0-9]{40}$') {
            $sourceCommit = [string]$commitOutput[0]
            $statusOutput = @(
                & git.exe -C $resolvedSourceRoot status --porcelain=v1 --untracked-files=all 2>$null
            )
            if ($LASTEXITCODE -eq 0) {
                $sourceDirty = $statusOutput.Count -gt 0
            }
        }
    }

    $brokerSidecarCompatibilityId =
        'codex-local-remote/broker-sidecar/v1'
    $identity = [ordered]@{
        Signature = 'codex-local-remote/runtime-content/v1'
        BrokerSidecarCompatibilityId =
            $brokerSidecarCompatibilityId
        Files = @($manifestFiles)
    }
    $versionId = Get-StringSha256 -Value (ConvertTo-CanonicalJson $identity)
    $runtimeRoot = [System.IO.Path]::GetFullPath(
        (Join-Path (Join-Path $resolvedDataDir 'RuntimeVersions') $versionId)
    )
    $manifest = [ordered]@{
        Signature = 'codex-local-remote/runtime-manifest/v1'
        Version = 1
        VersionId = $versionId
        BrokerSidecarCompatibilityId =
            $brokerSidecarCompatibilityId
        SourceCommit = $sourceCommit
        SourceDirty = $sourceDirty
        FileCount = $manifestFiles.Count
        Files = @($manifestFiles)
    }

    return [pscustomobject]@{
        Signature = 'codex-local-remote/runtime-plan/v1'
        Version = 1
        VersionId = $versionId
        SourceRoot = $resolvedSourceRoot
        DataDir = $resolvedDataDir
        RuntimeRoot = $runtimeRoot
        ManifestPath = Join-Path $runtimeRoot 'runtime-manifest.json'
        SourceCommit = $sourceCommit
        SourceDirty = $sourceDirty
        Files = @($copyFiles)
        Manifest = $manifest
    }
}

function Test-CodexLocalRemoteRuntimeVersion {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$RuntimeRoot,

        [string]$ExpectedVersionId,

        [switch]$AllowStagingDirectory
    )

    $resolvedRuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
    function New-InvalidRuntimeResult {
        param([Parameter(Mandatory)][string]$Reason)

        return [pscustomobject]@{
            IsValid = $false
            Reason = $Reason
            VersionId = $null
            RuntimeRoot = $resolvedRuntimeRoot
            ManifestPath = Join-Path $resolvedRuntimeRoot 'runtime-manifest.json'
            ManifestSha256 = $null
            SourceCommit = $null
            SourceDirty = $null
        }
    }

    try {
        if (-not (Test-Path -LiteralPath $resolvedRuntimeRoot -PathType Container)) {
            return New-InvalidRuntimeResult "runtime root '$resolvedRuntimeRoot' is missing"
        }
        $runtimeItem = Get-Item -LiteralPath $resolvedRuntimeRoot -Force -ErrorAction Stop
        if (($runtimeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            return New-InvalidRuntimeResult "runtime root '$resolvedRuntimeRoot' is a reparse point"
        }
        foreach ($directory in @(
            Get-ChildItem -LiteralPath $resolvedRuntimeRoot -Directory -Recurse -Force -ErrorAction Stop
        )) {
            if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                return New-InvalidRuntimeResult "runtime directory '$($directory.FullName)' is a reparse point"
            }
        }

        $manifestPath = Join-Path $resolvedRuntimeRoot 'runtime-manifest.json'
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
            return New-InvalidRuntimeResult "runtime manifest '$manifestPath' is missing"
        }
        $manifestItem = Get-Item -LiteralPath $manifestPath -Force -ErrorAction Stop
        if (($manifestItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            [long]$manifestItem.Length -lt 32 -or
            [long]$manifestItem.Length -gt 16777216) {
            return New-InvalidRuntimeResult "runtime manifest '$manifestPath' is not an ordinary bounded file"
        }
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 |
            ConvertFrom-Json -Depth 50 -ErrorAction Stop
        if ([string]$manifest.Signature -cne 'codex-local-remote/runtime-manifest/v1' -or
            [int]$manifest.Version -ne 1 -or
            [string]$manifest.VersionId -cnotmatch '^[a-f0-9]{64}$') {
            return New-InvalidRuntimeResult 'runtime manifest schema is invalid'
        }
        $manifestCompatibilityId = $null
        if ($null -ne $manifest.PSObject.Properties[
            'BrokerSidecarCompatibilityId'
        ]) {
            $manifestCompatibilityId =
                [string]$manifest.BrokerSidecarCompatibilityId
            if ($manifestCompatibilityId -cnotmatch
                '^codex-local-remote/broker-sidecar/v[1-9][0-9]*$') {
                return New-InvalidRuntimeResult (
                    'runtime manifest Broker/Sidecar compatibility is invalid'
                )
            }
        }
        $versionId = [string]$manifest.VersionId
        if (-not [string]::IsNullOrWhiteSpace($ExpectedVersionId) -and
            $versionId -cne $ExpectedVersionId) {
            return New-InvalidRuntimeResult "runtime version '$versionId' does not match expected '$ExpectedVersionId'"
        }
        if (-not $AllowStagingDirectory -and
            [System.IO.Path]::GetFileName($resolvedRuntimeRoot) -cne $versionId) {
            return New-InvalidRuntimeResult 'runtime directory name does not match its version id'
        }
        $manifestFiles = @($manifest.Files)
        if ([int]$manifest.FileCount -ne $manifestFiles.Count -or
            $manifestFiles.Count -lt 5) {
            return New-InvalidRuntimeResult 'runtime manifest file count is invalid'
        }

        $seenPaths = [System.Collections.Generic.HashSet[string]]::new(
            [System.StringComparer]::OrdinalIgnoreCase
        )
        $normalizedFiles = [System.Collections.Generic.List[object]]::new()
        foreach ($file in $manifestFiles) {
            $relativePath = [string]$file.Path
            if ([string]::IsNullOrWhiteSpace($relativePath) -or
                $relativePath.Contains('\') -or
                [System.IO.Path]::IsPathRooted($relativePath) -or
                @($relativePath.Split('/')) | Where-Object { $_ -in @('', '.', '..') }) {
                return New-InvalidRuntimeResult "runtime manifest path '$relativePath' is invalid"
            }
            if (-not $seenPaths.Add($relativePath)) {
                return New-InvalidRuntimeResult "runtime manifest path '$relativePath' is duplicated"
            }
            $fileSha256 = [string]$file.Sha256
            $fileSize = [long]$file.Size
            if ($fileSha256 -cnotmatch '^[a-f0-9]{64}$' -or $fileSize -lt 0) {
                return New-InvalidRuntimeResult "runtime manifest metadata for '$relativePath' is invalid"
            }
            $filePath = [System.IO.Path]::GetFullPath(
                (Join-Path $resolvedRuntimeRoot $relativePath.Replace('/', '\'))
            )
            $runtimePrefix = $resolvedRuntimeRoot.TrimEnd('\') + '\'
            if (-not $filePath.StartsWith(
                $runtimePrefix,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
                return New-InvalidRuntimeResult "runtime manifest path '$relativePath' escapes its root"
            }
            if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
                return New-InvalidRuntimeResult "runtime file '$relativePath' is missing"
            }
            $fileItem = Get-Item -LiteralPath $filePath -Force -ErrorAction Stop
            if (($fileItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                return New-InvalidRuntimeResult "runtime file '$relativePath' is a reparse point"
            }
            if ([long]$fileItem.Length -ne $fileSize) {
                return New-InvalidRuntimeResult "runtime file '$relativePath' size does not match its manifest"
            }
            $actualSha256 = (
                Get-FileHash -LiteralPath $filePath -Algorithm SHA256 -ErrorAction Stop
            ).Hash.ToLowerInvariant()
            if ($actualSha256 -cne $fileSha256) {
                return New-InvalidRuntimeResult "runtime file '$relativePath' hash does not match its manifest"
            }
            $normalizedFiles.Add([pscustomobject]@{
                Path = $relativePath
                Sha256 = $fileSha256
                Size = $fileSize
            })
        }
        $identity = [ordered]@{
            Signature = 'codex-local-remote/runtime-content/v1'
        }
        if (-not [string]::IsNullOrWhiteSpace(
            $manifestCompatibilityId
        )) {
            $identity.BrokerSidecarCompatibilityId =
                $manifestCompatibilityId
        }
        $identity.Files = @($normalizedFiles | Sort-Object Path)
        $computedVersionId = Get-StringSha256 -Value (ConvertTo-CanonicalJson $identity)
        if ($computedVersionId -cne $versionId) {
            return New-InvalidRuntimeResult 'runtime manifest identity hash does not match its version id'
        }
        $manifestSha256 = (
            Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256 -ErrorAction Stop
        ).Hash.ToLowerInvariant()
        return [pscustomobject]@{
            IsValid = $true
            Reason = 'valid'
            VersionId = $versionId
            RuntimeRoot = $resolvedRuntimeRoot
            ManifestPath = $manifestPath
            ManifestSha256 = $manifestSha256
            BrokerSidecarCompatibilityId =
                $manifestCompatibilityId
            SourceCommit = if ($null -eq $manifest.SourceCommit) {
                $null
            } else {
                [string]$manifest.SourceCommit
            }
            SourceDirty = [bool]$manifest.SourceDirty
        }
    } catch {
        return New-InvalidRuntimeResult $_.Exception.Message
    }
}

function Invoke-CodexLocalRemoteRuntimeValidationSafe {
    param(
        [Parameter(Mandatory)]
        [string]$RuntimeRoot,

        [Parameter(Mandatory)]
        [string]$VersionId
    )

    try {
        $validation = Test-CodexLocalRemoteRuntimeVersion `
            -RuntimeRoot $RuntimeRoot `
            -ExpectedVersionId $VersionId
        if ($null -ne $validation) {
            return $validation
        }
        $reason = 'runtime validation returned no result'
    } catch {
        $reason = $_.Exception.Message
    }
    return [pscustomobject]@{
        IsValid = $false
        Reason = $reason
        VersionId = $null
        RuntimeRoot = $RuntimeRoot
        ManifestPath = $null
        ManifestSha256 = $null
        BrokerSidecarCompatibilityId = $null
        SourceCommit = $null
        SourceDirty = $null
    }
}

function New-CodexLocalRemoteBrokerPayloadRuntimeState {
    param(
        [Parameter(Mandatory)]
        [string]$RuntimeRoot,

        [Parameter(Mandatory)]
        [string]$VersionId,

        [Parameter(Mandatory)]
        [string]$ManifestSha256
    )

    return [pscustomobject]@{
        IsValid = $false
        ValidationReason = $null
        RuntimeRoot = $RuntimeRoot
        VersionId = $VersionId
        ManifestPath = $null
        ManifestSha256 = $ManifestSha256
        BrokerSidecarCompatibilityId = $null
        PayloadSha256 = $null
        PayloadFileCount = 0
        PackageJson = $null
        BrokerFiles = @()
    }
}

function Read-CodexLocalRemoteStableBrokerPayloadManifest {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('current', 'active')]
        [string]$Label,

        [Parameter(Mandatory)]
        [object]$Validation,

        [Parameter(Mandatory)]
        [string]$ExpectedVersionId,

        [Parameter(Mandatory)]
        [string]$ExpectedManifestSha256,

        [Parameter(Mandatory)]
        [object]$State
    )

    try {
        if ($ExpectedManifestSha256 -cnotmatch '^[a-f0-9]{64}$' -or
            [string]$Validation.VersionId -cne $ExpectedVersionId) {
            return [pscustomobject]@{
                Succeeded = $false
                Reason = "$Label-manifest-identity-mismatch"
                State = $State
            }
        }

        $manifestPath = [string]$Validation.ManifestPath
        $stream = [System.IO.FileStream]::new(
            $manifestPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read,
            4096,
            [System.IO.FileOptions]::SequentialScan
        )
        try {
            if ($stream.Length -lt 32 -or $stream.Length -gt 16777216) {
                throw 'runtime manifest is not a bounded file'
            }
            $bytes = [byte[]]::new([int]$stream.Length)
            $offset = 0
            while ($offset -lt $bytes.Length) {
                $read = $stream.Read(
                    $bytes,
                    $offset,
                    $bytes.Length - $offset
                )
                if ($read -le 0) {
                    throw 'runtime manifest ended before its declared length'
                }
                $offset += $read
            }
            if ($stream.ReadByte() -ne -1) {
                throw 'runtime manifest grew while it was being read'
            }
        } finally {
            $stream.Dispose()
        }

        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            $manifestSha256 = [System.BitConverter]::ToString(
                $sha256.ComputeHash($bytes)
            ).Replace('-', '').ToLowerInvariant()
        } finally {
            $sha256.Dispose()
        }
        if ($manifestSha256 -cne $ExpectedManifestSha256 -or
            $manifestSha256 -cne [string]$Validation.ManifestSha256) {
            return [pscustomobject]@{
                Succeeded = $false
                Reason = "$Label-manifest-identity-mismatch"
                State = $State
            }
        }

        $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
        $manifestText = $utf8.GetString($bytes)
        if ($manifestText.Length -gt 0 -and
            $manifestText[0] -eq [char]0xfeff) {
            $manifestText = $manifestText.Substring(1)
        }
        $manifest = $manifestText |
            ConvertFrom-Json -Depth 50 -ErrorAction Stop
        if ([string]$manifest.Signature -cne
                'codex-local-remote/runtime-manifest/v1' -or
            [int]$manifest.Version -ne 1 -or
            [string]$manifest.VersionId -cne $ExpectedVersionId -or
            [string]$manifest.BrokerSidecarCompatibilityId -cne
                [string]$Validation.BrokerSidecarCompatibilityId) {
            return [pscustomobject]@{
                Succeeded = $false
                Reason = "$Label-manifest-identity-mismatch"
                State = $State
            }
        }

        $packageEntries = @(
            @($manifest.Files) |
                Where-Object { [string]$_.Path -ceq 'package.json' }
        )
        $brokerEntries = @(
            @($manifest.Files) |
                Where-Object {
                    [string]$_.Path -clike 'apps/broker/dist/*'
                } |
                Sort-Object Path
        )
        if ($packageEntries.Count -ne 1 -or $brokerEntries.Count -lt 1) {
            return [pscustomobject]@{
                Succeeded = $false
                Reason = "$Label-broker-payload-incomplete"
                State = $State
            }
        }
        $payloadEntries = @(
            @($packageEntries + $brokerEntries) |
                ForEach-Object {
                    [pscustomobject]@{
                        Path = [string]$_.Path
                        Sha256 = [string]$_.Sha256
                        Size = [long]$_.Size
                    }
                } |
                Sort-Object Path
        )
        $payloadIdentity = [ordered]@{
            Signature = 'codex-local-remote/broker-execution-payload/v1'
            Files = $payloadEntries
        }

        $State.IsValid = $true
        $State.ValidationReason = 'valid'
        $State.RuntimeRoot = [string]$Validation.RuntimeRoot
        $State.VersionId = [string]$Validation.VersionId
        $State.ManifestPath = $manifestPath
        $State.ManifestSha256 = $manifestSha256
        $State.BrokerSidecarCompatibilityId =
            [string]$manifest.BrokerSidecarCompatibilityId
        $State.PayloadSha256 = Get-StringSha256 `
            -Value (ConvertTo-CanonicalJson $payloadIdentity)
        $State.PayloadFileCount = $payloadEntries.Count
        $State.PackageJson = $payloadEntries |
            Where-Object { [string]$_.Path -ceq 'package.json' } |
            Select-Object -First 1
        $State.BrokerFiles = @(
            $payloadEntries |
                Where-Object {
                    [string]$_.Path -clike 'apps/broker/dist/*'
                }
        )
        return [pscustomobject]@{
            Succeeded = $true
            Reason = 'valid'
            State = $State
        }
    } catch {
        $State.ValidationReason = $_.Exception.Message
        return [pscustomobject]@{
            Succeeded = $false
            Reason = "$Label-manifest-read-failed"
            State = $State
        }
    }
}

function Test-CodexLocalRemoteBrokerPayloadCompatibility {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$CurrentRuntimeRoot,

        [Parameter(Mandatory)]
        [string]$CurrentVersionId,

        [Parameter(Mandatory)]
        [string]$CurrentManifestSha256,

        [Parameter(Mandatory)]
        [string]$ActiveRuntimeRoot,

        [Parameter(Mandatory)]
        [string]$ActiveVersionId,

        [Parameter(Mandatory)]
        [string]$ActiveManifestSha256
    )

    $currentState = New-CodexLocalRemoteBrokerPayloadRuntimeState `
        -RuntimeRoot $CurrentRuntimeRoot `
        -VersionId $CurrentVersionId `
        -ManifestSha256 $CurrentManifestSha256
    $activeState = New-CodexLocalRemoteBrokerPayloadRuntimeState `
        -RuntimeRoot $ActiveRuntimeRoot `
        -VersionId $ActiveVersionId `
        -ManifestSha256 $ActiveManifestSha256
    function New-CompatibilityResult {
        param(
            [Parameter(Mandatory)]
            [bool]$IsCompatible,

            [Parameter(Mandatory)]
            [string]$Reason
        )

        return [pscustomobject]@{
            Signature =
                'codex-local-remote/broker-payload-compatibility/v1'
            IsCompatible = $IsCompatible
            Reason = $Reason
            Current = $currentState
            Active = $activeState
        }
    }

    try {
        # Validate both immutable roots before consulting either manifest for a
        # compatibility decision. The safe wrapper converts path and read
        # failures into ordinary incompatible results.
        $currentValidation = Invoke-CodexLocalRemoteRuntimeValidationSafe `
            -RuntimeRoot $CurrentRuntimeRoot `
            -VersionId $CurrentVersionId
        $activeValidation = Invoke-CodexLocalRemoteRuntimeValidationSafe `
            -RuntimeRoot $ActiveRuntimeRoot `
            -VersionId $ActiveVersionId
        $currentState.IsValid = [bool]$currentValidation.IsValid
        $activeState.IsValid = [bool]$activeValidation.IsValid
        $currentState.ValidationReason = [string]$currentValidation.Reason
        $activeState.ValidationReason = [string]$activeValidation.Reason
        if (-not [bool]$currentValidation.IsValid) {
            return New-CompatibilityResult `
                -IsCompatible $false `
                -Reason 'current-runtime-invalid'
        }
        if (-not [bool]$activeValidation.IsValid) {
            return New-CompatibilityResult `
                -IsCompatible $false `
                -Reason 'active-runtime-invalid'
        }

        $currentSnapshot =
            Read-CodexLocalRemoteStableBrokerPayloadManifest `
                -Label 'current' `
                -Validation $currentValidation `
                -ExpectedVersionId $CurrentVersionId `
                -ExpectedManifestSha256 $CurrentManifestSha256 `
                -State $currentState
        if (-not [bool]$currentSnapshot.Succeeded) {
            return New-CompatibilityResult `
                -IsCompatible $false `
                -Reason ([string]$currentSnapshot.Reason)
        }
        $activeSnapshot =
            Read-CodexLocalRemoteStableBrokerPayloadManifest `
                -Label 'active' `
                -Validation $activeValidation `
                -ExpectedVersionId $ActiveVersionId `
                -ExpectedManifestSha256 $ActiveManifestSha256 `
                -State $activeState
        if (-not [bool]$activeSnapshot.Succeeded) {
            return New-CompatibilityResult `
                -IsCompatible $false `
                -Reason ([string]$activeSnapshot.Reason)
        }

        # Re-run the full validator after both stable reads. This catches file
        # or manifest drift across the decision window instead of trusting a
        # compatibility id or a previously read manifest in isolation.
        $currentFinal = Invoke-CodexLocalRemoteRuntimeValidationSafe `
            -RuntimeRoot $CurrentRuntimeRoot `
            -VersionId $CurrentVersionId
        $activeFinal = Invoke-CodexLocalRemoteRuntimeValidationSafe `
            -RuntimeRoot $ActiveRuntimeRoot `
            -VersionId $ActiveVersionId
        if (-not [bool]$currentFinal.IsValid -or
            [string]$currentFinal.ManifestSha256 -cne
                $CurrentManifestSha256 -or
            [string]$currentFinal.BrokerSidecarCompatibilityId -cne
                [string]$currentState.BrokerSidecarCompatibilityId) {
            $currentState.IsValid = $false
            $currentState.ValidationReason =
                'runtime changed during compatibility check'
            return New-CompatibilityResult `
                -IsCompatible $false `
                -Reason 'current-runtime-changed'
        }
        if (-not [bool]$activeFinal.IsValid -or
            [string]$activeFinal.ManifestSha256 -cne
                $ActiveManifestSha256 -or
            [string]$activeFinal.BrokerSidecarCompatibilityId -cne
                [string]$activeState.BrokerSidecarCompatibilityId) {
            $activeState.IsValid = $false
            $activeState.ValidationReason =
                'runtime changed during compatibility check'
            return New-CompatibilityResult `
                -IsCompatible $false `
                -Reason 'active-runtime-changed'
        }

        if ([string]$currentState.BrokerSidecarCompatibilityId -cne
            [string]$activeState.BrokerSidecarCompatibilityId) {
            return New-CompatibilityResult `
                -IsCompatible $false `
                -Reason 'broker-sidecar-compatibility-mismatch'
        }
        if ([string]$currentState.PackageJson.Sha256 -cne
                [string]$activeState.PackageJson.Sha256 -or
            [long]$currentState.PackageJson.Size -ne
                [long]$activeState.PackageJson.Size) {
            return New-CompatibilityResult `
                -IsCompatible $false `
                -Reason 'package-json-mismatch'
        }

        $currentBrokerFiles = @($currentState.BrokerFiles)
        $activeBrokerFiles = @($activeState.BrokerFiles)
        if ($currentBrokerFiles.Count -ne $activeBrokerFiles.Count) {
            return New-CompatibilityResult `
                -IsCompatible $false `
                -Reason 'broker-payload-file-set-mismatch'
        }
        for ($index = 0; $index -lt $currentBrokerFiles.Count; $index++) {
            if ([string]$currentBrokerFiles[$index].Path -cne
                [string]$activeBrokerFiles[$index].Path) {
                return New-CompatibilityResult `
                    -IsCompatible $false `
                    -Reason 'broker-payload-file-set-mismatch'
            }
            if ([string]$currentBrokerFiles[$index].Sha256 -cne
                    [string]$activeBrokerFiles[$index].Sha256 -or
                [long]$currentBrokerFiles[$index].Size -ne
                    [long]$activeBrokerFiles[$index].Size) {
                return New-CompatibilityResult `
                    -IsCompatible $false `
                    -Reason 'broker-payload-content-mismatch'
            }
        }
        if ([string]$currentState.PayloadSha256 -cne
            [string]$activeState.PayloadSha256) {
            return New-CompatibilityResult `
                -IsCompatible $false `
                -Reason 'broker-payload-content-mismatch'
        }
        return New-CompatibilityResult `
            -IsCompatible $true `
            -Reason 'compatible'
    } catch {
        $currentState.ValidationReason = $_.Exception.Message
        return New-CompatibilityResult `
            -IsCompatible $false `
            -Reason 'compatibility-check-failed'
    }
}

function Install-CodexLocalRemoteRuntimeVersion {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Plan
    )

    if ([string]$Plan.Signature -cne 'codex-local-remote/runtime-plan/v1' -or
        [int]$Plan.Version -ne 1 -or
        [string]$Plan.VersionId -cnotmatch '^[a-f0-9]{64}$') {
        throw 'The runtime version plan is invalid.'
    }
    $dataDir = [System.IO.Path]::GetFullPath([string]$Plan.DataDir)
    $runtimeRoot = [System.IO.Path]::GetFullPath([string]$Plan.RuntimeRoot)
    $versionsRoot = [System.IO.Path]::GetFullPath((Join-Path $dataDir 'RuntimeVersions'))
    $expectedRuntimeRoot = [System.IO.Path]::GetFullPath(
        (Join-Path $versionsRoot ([string]$Plan.VersionId))
    )
    if (-not [string]::Equals(
        $runtimeRoot,
        $expectedRuntimeRoot,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'The runtime version plan target is outside the managed version directory.'
    }

    $null = Protect-CodexLocalRemoteDataDirectory -DataDir $dataDir
    $null = [System.IO.Directory]::CreateDirectory($versionsRoot)
    if (Test-Path -LiteralPath $runtimeRoot) {
        $existing = Test-CodexLocalRemoteRuntimeVersion `
            -RuntimeRoot $runtimeRoot `
            -ExpectedVersionId ([string]$Plan.VersionId)
        if (-not $existing.IsValid) {
            throw "Existing runtime version '$runtimeRoot' is invalid: $($existing.Reason)."
        }
        return [pscustomobject]@{
            Status = 'reused'
            VersionId = [string]$existing.VersionId
            RuntimeRoot = [string]$existing.RuntimeRoot
            ManifestPath = [string]$existing.ManifestPath
            ManifestSha256 = [string]$existing.ManifestSha256
            SourceCommit = $existing.SourceCommit
            SourceDirty = [bool]$existing.SourceDirty
        }
    }

    $temporaryRoot = Join-Path $versionsRoot ".$([string]$Plan.VersionId).$([guid]::NewGuid().ToString('N')).installing"
    $temporaryRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
    $createdTemporaryRoot = $false
    try {
        $null = [System.IO.Directory]::CreateDirectory($temporaryRoot)
        $createdTemporaryRoot = $true
        foreach ($file in @($Plan.Files)) {
            $sourcePath = [System.IO.Path]::GetFullPath([string]$file.SourcePath)
            $currentSource = Get-Item -LiteralPath $sourcePath -Force -ErrorAction Stop
            if ($currentSource.PSIsContainer -or
                ($currentSource.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Runtime package source '$sourcePath' is no longer an ordinary file."
            }
            $currentSha256 = (
                Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256 -ErrorAction Stop
            ).Hash.ToLowerInvariant()
            if ($currentSha256 -cne [string]$file.Sha256 -or
                [long]$currentSource.Length -ne [long]$file.Size) {
                throw "Runtime package source '$sourcePath' changed after planning."
            }
            $destination = Join-Path $temporaryRoot ([string]$file.Path).Replace('/', '\')
            $null = [System.IO.Directory]::CreateDirectory((Split-Path -Parent $destination))
            Copy-Item -LiteralPath $sourcePath -Destination $destination
        }
        $temporaryManifestPath = Join-Path $temporaryRoot 'runtime-manifest.json'
        ConvertTo-CanonicalJson $Plan.Manifest |
            Set-Content -LiteralPath $temporaryManifestPath -Encoding utf8NoBOM
        $temporaryValidation = Test-CodexLocalRemoteRuntimeVersion `
            -RuntimeRoot $temporaryRoot `
            -ExpectedVersionId ([string]$Plan.VersionId) `
            -AllowStagingDirectory
        if (-not $temporaryValidation.IsValid) {
            throw "Staged runtime version is invalid: $($temporaryValidation.Reason)."
        }
        Move-Item -LiteralPath $temporaryRoot -Destination $runtimeRoot
        $createdTemporaryRoot = $false
        $installed = Test-CodexLocalRemoteRuntimeVersion `
            -RuntimeRoot $runtimeRoot `
            -ExpectedVersionId ([string]$Plan.VersionId)
        if (-not $installed.IsValid) {
            throw "Installed runtime version is invalid: $($installed.Reason)."
        }
        return [pscustomobject]@{
            Status = 'installed'
            VersionId = [string]$installed.VersionId
            RuntimeRoot = [string]$installed.RuntimeRoot
            ManifestPath = [string]$installed.ManifestPath
            ManifestSha256 = [string]$installed.ManifestSha256
            SourceCommit = $installed.SourceCommit
            SourceDirty = [bool]$installed.SourceDirty
        }
    } finally {
        if ($createdTemporaryRoot -and
            (Test-Path -LiteralPath $temporaryRoot -PathType Container)) {
            $temporaryParent = [System.IO.Path]::GetFullPath(
                (Split-Path -Parent $temporaryRoot)
            )
            if ([string]::Equals(
                $temporaryParent,
                $versionsRoot,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -and
                [System.IO.Path]::GetFileName($temporaryRoot) -cmatch
                '^\.[a-f0-9]{64}\.[a-f0-9]{32}\.installing$') {
                Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
            }
        }
    }
}

function Test-CodexLocalRemoteTaskXmlRuntimeRoot {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Xml,

        [Parameter(Mandatory)]
        [string]$ExpectedRoot,

        [AllowNull()]
        [string]$ForbiddenRoot
    )

    try {
        $document = [xml]$Xml
    } catch {
        return $false
    }
    $foundExpected = $false
    foreach ($node in @($document.SelectNodes('//text()'))) {
        $value = [string]$node.Value
        if ($value.IndexOf(
            $ExpectedRoot,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -ge 0) {
            $foundExpected = $true
        }
        if (-not [string]::IsNullOrWhiteSpace($ForbiddenRoot) -and
            $value.IndexOf(
                $ForbiddenRoot,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -ge 0) {
            return $false
        }
    }
    return $foundExpected
}

function Read-CodexLocalRemoteRuntimePointerRecord {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
    $pointerPath = Join-Path $resolvedDataDir 'runtime-current.json'
    if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) {
        return $null
    }
    $pointerItem = Get-Item -LiteralPath $pointerPath -Force -ErrorAction Stop
    if (($pointerItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [long]$pointerItem.Length -lt 32 -or
        [long]$pointerItem.Length -gt 262144) {
        throw "Runtime pointer '$pointerPath' is not an ordinary bounded file."
    }
    $pointer = Get-Content -LiteralPath $pointerPath -Raw -Encoding utf8 |
        ConvertFrom-Json -Depth 20 -DateKind String -ErrorAction Stop
    if ([string]$pointer.Signature -cne 'codex-local-remote/runtime-current/v1' -or
        [int]$pointer.Version -ne 1 -or
        [string]$pointer.CurrentVersionId -cnotmatch '^[a-f0-9]{64}$') {
        throw "Runtime pointer '$pointerPath' has an invalid schema."
    }

    $versionsRoot = [System.IO.Path]::GetFullPath(
        (Join-Path $resolvedDataDir 'RuntimeVersions')
    )
    $currentRoot = [System.IO.Path]::GetFullPath(
        (Join-Path $versionsRoot ([string]$pointer.CurrentVersionId))
    )
    if (-not [string]::Equals(
        $currentRoot,
        [System.IO.Path]::GetFullPath([string]$pointer.CurrentRoot),
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Runtime pointer '$pointerPath' current root is inconsistent."
    }
    $currentValidation = Test-CodexLocalRemoteRuntimeVersion `
        -RuntimeRoot $currentRoot `
        -ExpectedVersionId ([string]$pointer.CurrentVersionId)
    if (-not $currentValidation.IsValid -or
        [string]$currentValidation.ManifestSha256 -cne
        [string]$pointer.CurrentManifestSha256) {
        throw "Current runtime pointer is invalid: $($currentValidation.Reason)."
    }

    $previousVersionId = $pointer.PreviousVersionId
    $previousRoot = $null
    if ($null -ne $previousVersionId) {
        if ([string]$previousVersionId -cnotmatch '^[a-f0-9]{64}$') {
            throw "Runtime pointer '$pointerPath' previous version is invalid."
        }
        $previousRoot = [System.IO.Path]::GetFullPath(
            (Join-Path $versionsRoot ([string]$previousVersionId))
        )
        if (-not [string]::Equals(
            $previousRoot,
            [System.IO.Path]::GetFullPath([string]$pointer.PreviousRoot),
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            throw "Runtime pointer '$pointerPath' previous root is inconsistent."
        }
        $previousValidation = Test-CodexLocalRemoteRuntimeVersion `
            -RuntimeRoot $previousRoot `
            -ExpectedVersionId ([string]$previousVersionId)
        if (-not $previousValidation.IsValid -or
            [string]$previousValidation.ManifestSha256 -cne
            [string]$pointer.PreviousManifestSha256) {
            throw "Previous runtime pointer is invalid: $($previousValidation.Reason)."
        }
    } elseif ($null -ne $pointer.PreviousRoot) {
        throw "Runtime pointer '$pointerPath' has a previous root without a version."
    }

    $taskPreImageProperty =
        $pointer.PSObject.Properties['PreviousTaskPreImage']
    $taskPreImage = if ($null -eq $taskPreImageProperty) {
        $null
    } else {
        $taskPreImageProperty.Value
    }
    $validatedTaskPreImage = $null
    if ($null -ne $taskPreImage) {
        $expectedProperties = @(
            'Signature',
            'Version',
            'TaskName',
            'RuntimeVersionId',
            'RuntimeRoot',
            'Xml',
            'XmlSha256',
            'CapturedAtUtc'
        )
        $actualProperties = @(
            $taskPreImage.PSObject.Properties.Name |
                Sort-Object
        )
        if ((ConvertTo-CanonicalJson $actualProperties) -cne
            (ConvertTo-CanonicalJson @($expectedProperties | Sort-Object)) -or
            [string]$taskPreImage.Signature -cne
                'codex-local-remote/runtime-task-preimage/v1' -or
            [int]$taskPreImage.Version -ne 1 -or
            $null -eq $previousVersionId) {
            throw "Runtime pointer '$pointerPath' has an invalid task pre-image schema."
        }
        $taskName = [string]$taskPreImage.TaskName
        $taskXml = [string]$taskPreImage.Xml
        $taskXmlSha256 = [string]$taskPreImage.XmlSha256
        if ([string]::IsNullOrWhiteSpace($taskName) -or
            $taskName.Length -gt 128 -or
            $taskName -match '[\x00-\x1F]' -or
            [string]$taskPreImage.RuntimeVersionId -cne
                [string]$previousVersionId -or
            -not [string]::Equals(
                [System.IO.Path]::GetFullPath(
                    [string]$taskPreImage.RuntimeRoot
                ),
                $previousRoot,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -or
            $taskXml.Length -lt 32 -or
            $taskXml.Length -gt 196608 -or
            $taskXmlSha256 -cnotmatch '^[a-f0-9]{64}$' -or
            (Get-StringSha256 -Value $taskXml) -cne $taskXmlSha256 -or
            -not (Test-CodexLocalRemoteTaskXmlRuntimeRoot `
                -Xml $taskXml `
                -ExpectedRoot $previousRoot `
                -ForbiddenRoot $currentRoot)) {
            throw "Runtime pointer '$pointerPath' has an invalid task pre-image."
        }
        try {
            $capturedAt = [DateTimeOffset]::Parse(
                [string]$taskPreImage.CapturedAtUtc,
                [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind
            )
        } catch {
            throw "Runtime pointer '$pointerPath' has an invalid task pre-image timestamp."
        }
        if ($capturedAt.Offset -ne [TimeSpan]::Zero) {
            throw "Runtime pointer '$pointerPath' has an invalid task pre-image timestamp."
        }
        $validatedTaskPreImage = [pscustomobject]@{
            Signature = [string]$taskPreImage.Signature
            Version = [int]$taskPreImage.Version
            TaskName = $taskName
            RuntimeVersionId = [string]$taskPreImage.RuntimeVersionId
            RuntimeRoot = $previousRoot
            Xml = $taskXml
            XmlSha256 = $taskXmlSha256
            CapturedAtUtc = [string]$taskPreImage.CapturedAtUtc
        }
    }

    $currentTaskDefinitionProperty =
        $pointer.PSObject.Properties['CurrentTaskDefinition']
    $currentTaskDefinition = if (
        $null -eq $currentTaskDefinitionProperty
    ) {
        $null
    } else {
        $currentTaskDefinitionProperty.Value
    }
    $validatedCurrentTaskDefinition = $null
    if ($null -ne $currentTaskDefinition) {
        $expectedProperties = @(
            'Signature',
            'Version',
            'TaskName',
            'RuntimeVersionId',
            'RuntimeRoot',
            'XmlSha256',
            'BoundAtUtc'
        )
        $actualProperties = @(
            $currentTaskDefinition.PSObject.Properties.Name |
                Sort-Object
        )
        $bindingTaskName = [string]$currentTaskDefinition.TaskName
        $bindingRuntimeRoot = [System.IO.Path]::GetFullPath(
            [string]$currentTaskDefinition.RuntimeRoot
        )
        if ((ConvertTo-CanonicalJson $actualProperties) -cne
            (ConvertTo-CanonicalJson @($expectedProperties | Sort-Object)) -or
            [string]$currentTaskDefinition.Signature -cne
                'codex-local-remote/runtime-task-binding/v1' -or
            [int]$currentTaskDefinition.Version -ne 1 -or
            [string]::IsNullOrWhiteSpace($bindingTaskName) -or
            $bindingTaskName.Length -gt 128 -or
            $bindingTaskName -match '[\x00-\x1F]' -or
            [string]$currentTaskDefinition.RuntimeVersionId -cne
                [string]$pointer.CurrentVersionId -or
            -not [string]::Equals(
                $bindingRuntimeRoot,
                $currentRoot,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -or
            [string]$currentTaskDefinition.XmlSha256 -cnotmatch
                '^[a-f0-9]{64}$') {
            throw "Runtime pointer '$pointerPath' has an invalid current task binding."
        }
        try {
            $boundAt = [DateTimeOffset]::Parse(
                [string]$currentTaskDefinition.BoundAtUtc,
                [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::RoundtripKind
            )
        } catch {
            throw "Runtime pointer '$pointerPath' has an invalid current task binding timestamp."
        }
        if ($boundAt.Offset -ne [TimeSpan]::Zero) {
            throw "Runtime pointer '$pointerPath' has an invalid current task binding timestamp."
        }
        $validatedCurrentTaskDefinition = [pscustomobject]@{
            Signature = [string]$currentTaskDefinition.Signature
            Version = [int]$currentTaskDefinition.Version
            TaskName = $bindingTaskName
            RuntimeVersionId =
                [string]$currentTaskDefinition.RuntimeVersionId
            RuntimeRoot = $bindingRuntimeRoot
            XmlSha256 = [string]$currentTaskDefinition.XmlSha256
            BoundAtUtc = [string]$currentTaskDefinition.BoundAtUtc
        }
    }

    return [pscustomobject]@{
        Signature = [string]$pointer.Signature
        Version = [int]$pointer.Version
        CurrentVersionId = [string]$pointer.CurrentVersionId
        CurrentRoot = $currentRoot
        CurrentManifestSha256 = [string]$pointer.CurrentManifestSha256
        PreviousVersionId = if ($null -eq $previousVersionId) {
            $null
        } else {
            [string]$previousVersionId
        }
        PreviousRoot = $previousRoot
        PreviousManifestSha256 = if ($null -eq $previousVersionId) {
            $null
        } else {
            [string]$pointer.PreviousManifestSha256
        }
        UpdatedAtUtc = [string]$pointer.UpdatedAtUtc
        PreviousTaskPreImage = $validatedTaskPreImage
        CurrentTaskDefinition = $validatedCurrentTaskDefinition
        PointerPath = $pointerPath
    }
}

function Get-CodexLocalRemoteCurrentRuntime {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $record = Read-CodexLocalRemoteRuntimePointerRecord -DataDir $DataDir
    if ($null -eq $record) {
        return $null
    }
    $taskPreImage = $record.PreviousTaskPreImage
    $currentTaskDefinition = $record.CurrentTaskDefinition
    return [pscustomobject]@{
        Signature = [string]$record.Signature
        Version = [int]$record.Version
        CurrentVersionId = [string]$record.CurrentVersionId
        CurrentRoot = [string]$record.CurrentRoot
        CurrentManifestSha256 = [string]$record.CurrentManifestSha256
        PreviousVersionId = $record.PreviousVersionId
        PreviousRoot = $record.PreviousRoot
        PreviousManifestSha256 = $record.PreviousManifestSha256
        UpdatedAtUtc = [string]$record.UpdatedAtUtc
        HasPreviousTaskPreImage = $null -ne $taskPreImage
        PreviousTaskPreImageSha256 = if ($null -eq $taskPreImage) {
            $null
        } else {
            [string]$taskPreImage.XmlSha256
        }
        PreviousTaskPreImageTaskName = if ($null -eq $taskPreImage) {
            $null
        } else {
            [string]$taskPreImage.TaskName
        }
        PreviousTaskPreImageRuntimeVersionId = if ($null -eq $taskPreImage) {
            $null
        } else {
            [string]$taskPreImage.RuntimeVersionId
        }
        PreviousTaskPreImageRuntimeRoot = if ($null -eq $taskPreImage) {
            $null
        } else {
            [string]$taskPreImage.RuntimeRoot
        }
        HasCurrentTaskDefinition =
            $null -ne $currentTaskDefinition
        CurrentTaskDefinitionSha256 = if (
            $null -eq $currentTaskDefinition
        ) {
            $null
        } else {
            [string]$currentTaskDefinition.XmlSha256
        }
        CurrentTaskDefinitionTaskName = if (
            $null -eq $currentTaskDefinition
        ) {
            $null
        } else {
            [string]$currentTaskDefinition.TaskName
        }
        CurrentTaskDefinitionRuntimeVersionId = if (
            $null -eq $currentTaskDefinition
        ) {
            $null
        } else {
            [string]$currentTaskDefinition.RuntimeVersionId
        }
        CurrentTaskDefinitionRuntimeRoot = if (
            $null -eq $currentTaskDefinition
        ) {
            $null
        } else {
            [string]$currentTaskDefinition.RuntimeRoot
        }
        PointerPath = [string]$record.PointerPath
    }
}

function Get-CodexLocalRemoteRuntimeTaskPreImage {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [string]$ExpectedTaskName,

        [Parameter(Mandatory)]
        [string]$ExpectedRuntimeVersionId,

        [Parameter(Mandatory)]
        [string]$ExpectedRuntimeRoot
    )

    $record = Read-CodexLocalRemoteRuntimePointerRecord -DataDir $DataDir
    if ($null -eq $record -or
        $null -eq $record.PreviousTaskPreImage) {
        throw 'The selected runtime pointer has no scheduled-task pre-image.'
    }
    $taskPreImage = $record.PreviousTaskPreImage
    if ([string]$taskPreImage.TaskName -cne $ExpectedTaskName -or
        [string]$taskPreImage.RuntimeVersionId -cne
            $ExpectedRuntimeVersionId -or
        -not [string]::Equals(
            [System.IO.Path]::GetFullPath(
                [string]$taskPreImage.RuntimeRoot
            ),
            [System.IO.Path]::GetFullPath($ExpectedRuntimeRoot),
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'The scheduled-task pre-image does not match the requested rollback identity.'
    }
    return [pscustomobject]@{
        Signature = [string]$taskPreImage.Signature
        Version = [int]$taskPreImage.Version
        TaskName = [string]$taskPreImage.TaskName
        RuntimeVersionId = [string]$taskPreImage.RuntimeVersionId
        RuntimeRoot = [string]$taskPreImage.RuntimeRoot
        Xml = [string]$taskPreImage.Xml
        XmlSha256 = [string]$taskPreImage.XmlSha256
        CapturedAtUtc = [string]$taskPreImage.CapturedAtUtc
    }
}

function Set-CodexLocalRemoteCurrentRuntime {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [object]$Runtime,

        [AllowNull()]
        [object]$PreviousTaskPreImage,

        [AllowNull()]
        [object]$CurrentTaskDefinition
    )

    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
    $runtimeRoot = [System.IO.Path]::GetFullPath([string]$Runtime.RuntimeRoot)
    $runtimeValidation = Test-CodexLocalRemoteRuntimeVersion `
        -RuntimeRoot $runtimeRoot `
        -ExpectedVersionId ([string]$Runtime.VersionId)
    if (-not $runtimeValidation.IsValid) {
        throw "Refusing to activate an invalid runtime: $($runtimeValidation.Reason)."
    }
    $expectedRoot = [System.IO.Path]::GetFullPath(
        (Join-Path (Join-Path $resolvedDataDir 'RuntimeVersions') ([string]$Runtime.VersionId))
    )
    if (-not [string]::Equals(
        $runtimeRoot,
        $expectedRoot,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'Refusing to activate a runtime outside the managed version directory.'
    }

    $previousRecord =
        Read-CodexLocalRemoteRuntimePointerRecord -DataDir $resolvedDataDir
    $previousVersionId = $null
    $previousRoot = $null
    $previousManifestSha256 = $null
    $persistedTaskPreImage = $null
    $persistedCurrentTaskDefinition = $null
    if ($null -ne $previousRecord) {
        if ([string]$previousRecord.CurrentVersionId -ceq
            [string]$Runtime.VersionId) {
            $previousVersionId = $previousRecord.PreviousVersionId
            $previousRoot = $previousRecord.PreviousRoot
            $previousManifestSha256 =
                $previousRecord.PreviousManifestSha256
            if (-not $PSBoundParameters.ContainsKey(
                'PreviousTaskPreImage'
            )) {
                $persistedTaskPreImage =
                    $previousRecord.PreviousTaskPreImage
            }
            if (-not $PSBoundParameters.ContainsKey(
                'CurrentTaskDefinition'
            )) {
                $persistedCurrentTaskDefinition =
                    $previousRecord.CurrentTaskDefinition
            }
        } else {
            $previousVersionId =
                [string]$previousRecord.CurrentVersionId
            $previousRoot = [string]$previousRecord.CurrentRoot
            $previousManifestSha256 =
                [string]$previousRecord.CurrentManifestSha256
        }
    }
    if ($PSBoundParameters.ContainsKey('PreviousTaskPreImage') -and
        $null -ne $PreviousTaskPreImage) {
        if ($null -eq $previousVersionId) {
            throw 'A scheduled-task pre-image requires a previous runtime.'
        }
        $taskName = [string]$PreviousTaskPreImage.TaskName
        $taskRuntimeVersionId =
            [string]$PreviousTaskPreImage.RuntimeVersionId
        $taskRuntimeRoot = [System.IO.Path]::GetFullPath(
            [string]$PreviousTaskPreImage.RuntimeRoot
        )
        $taskXml = [string]$PreviousTaskPreImage.Xml
        $taskXmlSha256 = [string]$PreviousTaskPreImage.XmlSha256
        if ([string]::IsNullOrWhiteSpace($taskName) -or
            $taskName.Length -gt 128 -or
            $taskName -match '[\x00-\x1F]' -or
            $taskRuntimeVersionId -cne [string]$previousVersionId -or
            -not [string]::Equals(
                $taskRuntimeRoot,
                [System.IO.Path]::GetFullPath(
                    [string]$previousRoot
                ),
                [System.StringComparison]::OrdinalIgnoreCase
            ) -or
            $taskXml.Length -lt 32 -or
            $taskXml.Length -gt 196608 -or
            $taskXmlSha256 -cnotmatch '^[a-f0-9]{64}$' -or
            (Get-StringSha256 -Value $taskXml) -cne
                $taskXmlSha256 -or
            -not (Test-CodexLocalRemoteTaskXmlRuntimeRoot `
                -Xml $taskXml `
                -ExpectedRoot $taskRuntimeRoot `
                -ForbiddenRoot $runtimeRoot)) {
            throw 'The scheduled-task pre-image is invalid for the previous runtime.'
        }
        $persistedTaskPreImage = [ordered]@{
            Signature =
                'codex-local-remote/runtime-task-preimage/v1'
            Version = 1
            TaskName = $taskName
            RuntimeVersionId = $taskRuntimeVersionId
            RuntimeRoot = $taskRuntimeRoot
            Xml = $taskXml
            XmlSha256 = $taskXmlSha256
            CapturedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        }
    } elseif ($PSBoundParameters.ContainsKey('PreviousTaskPreImage')) {
        $persistedTaskPreImage = $null
    }
    if ($PSBoundParameters.ContainsKey('CurrentTaskDefinition') -and
        $null -ne $CurrentTaskDefinition) {
        $bindingTaskName = [string]$CurrentTaskDefinition.TaskName
        $bindingRuntimeVersionId =
            [string]$CurrentTaskDefinition.RuntimeVersionId
        $bindingRuntimeRoot = [System.IO.Path]::GetFullPath(
            [string]$CurrentTaskDefinition.RuntimeRoot
        )
        $bindingXmlSha256 =
            [string]$CurrentTaskDefinition.XmlSha256
        if ([string]::IsNullOrWhiteSpace($bindingTaskName) -or
            $bindingTaskName.Length -gt 128 -or
            $bindingTaskName -match '[\x00-\x1F]' -or
            $bindingRuntimeVersionId -cne
                [string]$runtimeValidation.VersionId -or
            -not [string]::Equals(
                $bindingRuntimeRoot,
                $runtimeRoot,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -or
            $bindingXmlSha256 -cnotmatch '^[a-f0-9]{64}$') {
            throw 'The current scheduled-task binding is invalid for the selected runtime.'
        }
        $persistedCurrentTaskDefinition = [ordered]@{
            Signature =
                'codex-local-remote/runtime-task-binding/v1'
            Version = 1
            TaskName = $bindingTaskName
            RuntimeVersionId = $bindingRuntimeVersionId
            RuntimeRoot = $bindingRuntimeRoot
            XmlSha256 = $bindingXmlSha256
            BoundAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
        }
    } elseif ($PSBoundParameters.ContainsKey(
        'CurrentTaskDefinition'
    )) {
        $persistedCurrentTaskDefinition = $null
    }
    $pointer = [ordered]@{
        Signature = 'codex-local-remote/runtime-current/v1'
        Version = 1
        CurrentVersionId = [string]$runtimeValidation.VersionId
        CurrentRoot = [string]$runtimeValidation.RuntimeRoot
        CurrentManifestSha256 = [string]$runtimeValidation.ManifestSha256
        PreviousVersionId = $previousVersionId
        PreviousRoot = $previousRoot
        PreviousManifestSha256 = $previousManifestSha256
        PreviousTaskPreImage = $persistedTaskPreImage
        CurrentTaskDefinition = $persistedCurrentTaskDefinition
        UpdatedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
    $pointerPath = Join-Path $resolvedDataDir 'runtime-current.json'
    Write-AtomicJsonFile -Path $pointerPath -Value $pointer
    $readBack = Get-CodexLocalRemoteCurrentRuntime -DataDir $resolvedDataDir
    if ($null -eq $readBack -or
        [string]$readBack.CurrentVersionId -cne
            [string]$Runtime.VersionId -or
        [bool]$readBack.HasPreviousTaskPreImage -ne
            ($null -ne $persistedTaskPreImage) -or
        [bool]$readBack.HasCurrentTaskDefinition -ne
            ($null -ne $persistedCurrentTaskDefinition)) {
        throw 'The active runtime pointer failed read-back verification.'
    }
    if ($null -ne $persistedTaskPreImage) {
        $preImageReadBack =
            Get-CodexLocalRemoteRuntimeTaskPreImage `
                -DataDir $resolvedDataDir `
                -ExpectedTaskName (
                    [string]$persistedTaskPreImage.TaskName
                ) `
                -ExpectedRuntimeVersionId (
                    [string]$persistedTaskPreImage.RuntimeVersionId
                ) `
                -ExpectedRuntimeRoot (
                    [string]$persistedTaskPreImage.RuntimeRoot
                )
        if ([string]$preImageReadBack.XmlSha256 -cne
                [string]$persistedTaskPreImage.XmlSha256 -or
            [string]$preImageReadBack.Xml -cne
                [string]$persistedTaskPreImage.Xml) {
            throw 'The scheduled-task pre-image failed exact read-back verification.'
        }
    }
    if ($null -ne $persistedCurrentTaskDefinition -and
        ([string]$readBack.CurrentTaskDefinitionTaskName -cne
                [string]$persistedCurrentTaskDefinition.TaskName -or
            [string]$readBack.CurrentTaskDefinitionRuntimeVersionId -cne
                [string]$persistedCurrentTaskDefinition.RuntimeVersionId -or
            -not [string]::Equals(
                [System.IO.Path]::GetFullPath(
                    [string]$readBack.CurrentTaskDefinitionRuntimeRoot
                ),
                [System.IO.Path]::GetFullPath(
                    [string]$persistedCurrentTaskDefinition.RuntimeRoot
                ),
                [System.StringComparison]::OrdinalIgnoreCase
            ) -or
            [string]$readBack.CurrentTaskDefinitionSha256 -cne
                [string]$persistedCurrentTaskDefinition.XmlSha256)) {
        throw 'The current scheduled-task binding failed exact read-back verification.'
    }
    return $readBack
}

function Sync-CodexLocalRemoteCurrentRuntime {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [string]$InstallRoot
    )

    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
    $resolvedInstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
    $versionsRoot = [System.IO.Path]::GetFullPath(
        (Join-Path $resolvedDataDir 'RuntimeVersions')
    )
    $versionsPrefix = $versionsRoot.TrimEnd('\') + '\'
    if (-not $resolvedInstallRoot.StartsWith(
        $versionsPrefix,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        return [pscustomobject]@{
            Status = 'unmanaged-runtime'
            Current = Get-CodexLocalRemoteCurrentRuntime -DataDir $resolvedDataDir
        }
    }

    $expectedVersionId = [System.IO.Path]::GetFileName($resolvedInstallRoot)
    $validation = Test-CodexLocalRemoteRuntimeVersion `
        -RuntimeRoot $resolvedInstallRoot `
        -ExpectedVersionId $expectedVersionId
    if (-not $validation.IsValid) {
        throw "The scheduled immutable runtime is invalid: $($validation.Reason)."
    }

    $current = Get-CodexLocalRemoteCurrentRuntime -DataDir $resolvedDataDir
    if ($null -ne $current -and
        [string]$current.CurrentVersionId -ceq [string]$validation.VersionId -and
        [string]::Equals(
            [System.IO.Path]::GetFullPath([string]$current.CurrentRoot),
            $resolvedInstallRoot,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        return [pscustomobject]@{
            Status = 'already-current'
            Current = $current
        }
    }

    return [pscustomobject]@{
        Status = 'repaired'
        Current = Set-CodexLocalRemoteCurrentRuntime `
            -DataDir $resolvedDataDir `
            -Runtime $validation
    }
}

function Get-UserEnvironmentValueState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name
    )

    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
    try {
        if ($null -eq $key) {
            return [pscustomobject]@{ Exists = $false; Value = $null }
        }
        $exists = @($key.GetValueNames()) -ccontains $Name
        return [pscustomobject]@{
            Exists = $exists
            Value = if ($exists) {
                [string]$key.GetValue(
                    $Name,
                    $null,
                    [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
                )
            } else {
                $null
            }
        }
    } finally {
        if ($null -ne $key) {
            $key.Dispose()
        }
    }
}

function New-BrokerEnvironmentBackupState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$AppliedValue,

        [Parameter(Mandatory)]
        [bool]$PreviousValueExists,

        [AllowNull()]
        [string]$PreviousValue
    )

    return [ordered]@{
        Signature = $script:EnvironmentStateSignature
        Version = 2
        AppliedValueSha256 = Get-StringSha256 -Value $AppliedValue
        PreviousUserValueExists = $PreviousValueExists
        PreviousUserValue = if ($PreviousValueExists) { [string]$PreviousValue } else { $null }
    }
}

function Set-UserEnvironmentValue {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [bool]$Exists,

        [AllowNull()]
        [string]$Value
    )

    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment', $true)
    try {
        if ($Exists) {
            $key.SetValue(
                $Name,
                [string]$Value,
                [Microsoft.Win32.RegistryValueKind]::String
            )
        } else {
            $key.DeleteValue($Name, $false)
        }
    } finally {
        $key.Dispose()
    }
}

function Publish-EnvironmentChange {
    [CmdletBinding()]
    param()

    if (-not ('CodexLocalRemote.NativeMethods' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace CodexLocalRemote {
    public static class NativeMethods {
        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern IntPtr SendMessageTimeout(
            IntPtr hWnd,
            uint Msg,
            UIntPtr wParam,
            string lParam,
            uint fuFlags,
            uint uTimeout,
            out UIntPtr lpdwResult
        );
    }
}
'@
    }

    $result = [UIntPtr]::Zero
    $null = [CodexLocalRemote.NativeMethods]::SendMessageTimeout(
        [IntPtr]0xffff,
        0x001A,
        [UIntPtr]::Zero,
        'Environment',
        0x0002,
        5000,
        [ref]$result
    )
}

function Install-BrokerUserEnvironment {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [string]$WebSocketUrl
    )

    Assert-ForceCliDisabled
    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
    $null = Protect-CodexLocalRemoteDataDirectory -DataDir $resolvedDataDir
    $statePath = Join-Path $resolvedDataDir 'windows-broker-environment.json'
    $current = Get-UserEnvironmentValueState -Name 'CODEX_APP_SERVER_WS_URL'

    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -Depth 20
        if ($state.Signature -cne $script:EnvironmentStateSignature -or
            [string]$state.AppliedValueSha256 -cne (Get-StringSha256 -Value $WebSocketUrl)) {
            throw "Environment backup '$statePath' is not the exact managed broker state; refusing to overwrite it."
        }
        if (-not $current.Exists -or [string]$current.Value -cne $WebSocketUrl) {
            throw 'CODEX_APP_SERVER_WS_URL changed after installation; refusing to overwrite the newer user value.'
        }
        return [pscustomobject]@{
            Status = 'already-configured'
            StatePath = $statePath
        }
    }

    if ($current.Exists -and [string]$current.Value -ceq $WebSocketUrl) {
        throw 'CODEX_APP_SERVER_WS_URL already matches the capability endpoint but no managed backup exists; refusing to guess the previous user value.'
    }

    $state = New-BrokerEnvironmentBackupState `
        -AppliedValue $WebSocketUrl `
        -PreviousValueExists ([bool]$current.Exists) `
        -PreviousValue ([string]$current.Value)
    Write-AtomicJsonFile -Path $statePath -Value $state
    try {
        Set-UserEnvironmentValue `
            -Name 'CODEX_APP_SERVER_WS_URL' `
            -Exists $true `
            -Value $WebSocketUrl
        $env:CODEX_APP_SERVER_WS_URL = $WebSocketUrl
        Publish-EnvironmentChange
    } catch {
        $installError = $_
        try {
            Set-UserEnvironmentValue `
                -Name 'CODEX_APP_SERVER_WS_URL' `
                -Exists ([bool]$current.Exists) `
                -Value ([string]$current.Value)
            if ($current.Exists) {
                $env:CODEX_APP_SERVER_WS_URL = [string]$current.Value
            } else {
                Remove-Item Env:\CODEX_APP_SERVER_WS_URL -ErrorAction SilentlyContinue
            }
            Publish-EnvironmentChange
            Remove-Item -LiteralPath $statePath -Force
        } catch {
            throw "CODEX_APP_SERVER_WS_URL installation failed, and restoring its previous value also failed. Recovery state remains at '$statePath'. Install error: $($installError.Exception.Message). Restore error: $($_.Exception.Message)"
        }
        throw $installError
    }

    return [pscustomobject]@{
        Status = 'configured'
        StatePath = $statePath
    }
}

function Restore-BrokerUserEnvironment {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [string]$WebSocketUrl
    )

    $statePath = Join-Path ([System.IO.Path]::GetFullPath($DataDir)) 'windows-broker-environment.json'
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        return [pscustomobject]@{ Status = 'not-found'; StatePath = $statePath }
    }

    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -Depth 20
    if ($state.Signature -cne $script:EnvironmentStateSignature -or
        [string]$state.AppliedValueSha256 -cne (Get-StringSha256 -Value $WebSocketUrl)) {
        throw "Environment backup '$statePath' is not the exact managed broker state; refusing to restore from it."
    }
    $current = Get-UserEnvironmentValueState -Name 'CODEX_APP_SERVER_WS_URL'
    if (-not $current.Exists -or [string]$current.Value -cne $WebSocketUrl) {
        throw 'CODEX_APP_SERVER_WS_URL changed after installation; refusing to replace the newer user value during uninstall.'
    }

    $restoredValue = if ([bool]$state.PreviousUserValueExists) {
        [string]$state.PreviousUserValue
    } else {
        $null
    }
    Set-UserEnvironmentValue `
        -Name 'CODEX_APP_SERVER_WS_URL' `
        -Exists ([bool]$state.PreviousUserValueExists) `
        -Value $restoredValue
    if ([bool]$state.PreviousUserValueExists) {
        $env:CODEX_APP_SERVER_WS_URL = $restoredValue
    } else {
        Remove-Item Env:\CODEX_APP_SERVER_WS_URL -ErrorAction SilentlyContinue
    }
    Publish-EnvironmentChange
    Remove-Item -LiteralPath $statePath -Force

    return [pscustomobject]@{
        Status = 'restored'
        StatePath = $statePath
    }
}

function Assert-BrokerUserEnvironmentRestorable {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [string]$WebSocketUrl
    )

    $statePath = Join-Path ([System.IO.Path]::GetFullPath($DataDir)) 'windows-broker-environment.json'
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        return [pscustomobject]@{ Status = 'not-found'; StatePath = $statePath }
    }
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -Depth 20
    if ($state.Signature -cne $script:EnvironmentStateSignature -or
        [string]$state.AppliedValueSha256 -cne (Get-StringSha256 -Value $WebSocketUrl)) {
        throw "Environment backup '$statePath' is not the exact managed broker state; refusing to restore from it."
    }
    $current = Get-UserEnvironmentValueState -Name 'CODEX_APP_SERVER_WS_URL'
    if (-not $current.Exists -or [string]$current.Value -cne $WebSocketUrl) {
        throw 'CODEX_APP_SERVER_WS_URL changed after installation; refusing to replace the newer user value during uninstall.'
    }
    return [pscustomobject]@{ Status = 'restorable'; StatePath = $statePath }
}

function Get-CodexLocalRemoteControlDispatcherPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    return [System.IO.Path]::GetFullPath(
        (Join-Path `
            (Join-Path ([System.IO.Path]::GetFullPath($DataDir)) 'control') `
            'CodexLocalRemote.Control.ps1')
    )
}

function Get-CodexLocalRemoteControlDispatcherReceiptPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    return [System.IO.Path]::GetFullPath(
        (Join-Path `
            (Join-Path ([System.IO.Path]::GetFullPath($DataDir)) 'control') `
            'control-dispatcher.receipt.json')
    )
}

function Test-CodexLocalRemoteControlDispatcher {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    try {
        if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
            return $false
        }
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer -or
            ($item.Attributes -band
                [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            [long]$item.Length -lt 64 -or
            [long]$item.Length -gt 131072) {
            return $false
        }
        $reader = [System.IO.StreamReader]::new(
            $Path,
            [System.Text.UTF8Encoding]::new($false),
            $true
        )
        try {
            $firstLine = $reader.ReadLine()
        } finally {
            $reader.Dispose()
        }
        return [string]$firstLine -ceq
            '# codex-local-remote/control-dispatcher/v1'
    } catch {
        return $false
    }
}

function Get-CodexLocalRemoteControlDispatcherState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $targetPath =
        Get-CodexLocalRemoteControlDispatcherPath -DataDir $DataDir
    $receiptPath =
        Get-CodexLocalRemoteControlDispatcherReceiptPath -DataDir $DataDir
    $targetPresent = Test-Path -LiteralPath $targetPath
    $receiptPresent = Test-Path -LiteralPath $receiptPath
    if (-not $targetPresent -and -not $receiptPresent) {
        return [pscustomobject]@{
            Status = 'absent'
            Path = $targetPath
            ReceiptPath = $receiptPath
            Sha256 = $null
        }
    }
    if ($targetPresent -ne $receiptPresent) {
        throw (
            "Control dispatcher ownership is incomplete at '$targetPath'; " +
            'refusing marker-only adoption or partial-state repair.'
        )
    }
    if (-not (Test-CodexLocalRemoteControlDispatcher -Path $targetPath)) {
        throw "Control dispatcher '$targetPath' is not one recognized managed file."
    }
    $receiptItem =
        Get-Item -LiteralPath $receiptPath -Force -ErrorAction Stop
    if ($receiptItem.PSIsContainer -or
        ($receiptItem.Attributes -band
            [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [long]$receiptItem.Length -lt 2 -or
        [long]$receiptItem.Length -gt 131072) {
        throw "Control dispatcher receipt '$receiptPath' is not ordinary."
    }
    try {
        $receipt = Get-Content `
            -LiteralPath $receiptPath `
            -Raw `
            -Encoding utf8 `
            -ErrorAction Stop |
            ConvertFrom-Json -Depth 10 -DateKind String -ErrorAction Stop
    } catch {
        throw "Control dispatcher receipt '$receiptPath' is invalid JSON."
    }
    if ([string]$receipt.Signature -cne
            'codex-local-remote/control-dispatcher-receipt/v1' -or
        [int]$receipt.Version -ne 1 -or
        -not [string]::Equals(
            [string]$receipt.Path,
            $targetPath,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        [string]$receipt.Sha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw "Control dispatcher receipt '$receiptPath' is not canonical."
    }
    $targetHash = (
        Get-FileHash `
            -LiteralPath $targetPath `
            -Algorithm SHA256 `
            -ErrorAction Stop
    ).Hash.ToLowerInvariant()
    if ($targetHash -cne [string]$receipt.Sha256) {
        throw (
            "Control dispatcher '$targetPath' no longer matches its exact " +
            'installation receipt.'
        )
    }
    return [pscustomobject]@{
        Status = 'managed'
        Path = $targetPath
        ReceiptPath = $receiptPath
        Sha256 = $targetHash
    }
}

function Invoke-WithCodexLocalRemoteControlDispatcherMutex {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [scriptblock]$Action,

        [ValidateRange(1, 120)]
        [int]$TimeoutSeconds = 30
    )

    $identity =
        [System.IO.Path]::GetFullPath($DataDir).ToUpperInvariant()
    $name = (
        'Global\CodexLocalRemote.ControlDispatcher.' +
        (Get-StringSha256 -Value $identity)
    )
    $mutex = [System.Threading.Mutex]::new($false, $name)
    $lockTaken = $false
    try {
        try {
            $lockTaken =
                $mutex.WaitOne([TimeSpan]::FromSeconds($TimeoutSeconds))
        } catch [System.Threading.AbandonedMutexException] {
            $lockTaken = $true
        }
        if (-not $lockTaken) {
            throw 'Timed out waiting for the control dispatcher transaction.'
        }
        return & $Action
    } finally {
        if ($lockTaken) {
            try {
                $mutex.ReleaseMutex()
            } catch [System.ApplicationException] {
                # An abandoned owner is still safe to dispose.
            }
        }
        $mutex.Dispose()
    }
}

function Install-CodexLocalRemoteControlDispatcher {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$SourcePath,

        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $resolvedSource = [System.IO.Path]::GetFullPath($SourcePath)
    if (-not (Test-CodexLocalRemoteControlDispatcher `
        -Path $resolvedSource)) {
        throw 'The control dispatcher source is not one recognized managed file.'
    }
    $sourceHash = (
        Get-FileHash `
            -LiteralPath $resolvedSource `
            -Algorithm SHA256 `
            -ErrorAction Stop
    ).Hash.ToLowerInvariant()
    return Invoke-WithCodexLocalRemoteControlDispatcherMutex `
        -DataDir $DataDir `
        -Action {
            $baseline =
                Get-CodexLocalRemoteControlDispatcherState `
                    -DataDir $DataDir
            if ([string]$baseline.Status -ceq 'managed' -and
                [string]$baseline.Sha256 -ceq $sourceHash) {
                return [pscustomobject]@{
                    Status = 'reused'
                    Path = [string]$baseline.Path
                    ReceiptPath = [string]$baseline.ReceiptPath
                    Sha256 = $sourceHash
                }
            }

            $targetPath = [string]$baseline.Path
            $receiptPath = [string]$baseline.ReceiptPath
            $controlDirectory = Split-Path -Parent $targetPath
            $null =
                [System.IO.Directory]::CreateDirectory($controlDirectory)
            $directoryItem =
                Get-Item `
                    -LiteralPath $controlDirectory `
                    -Force `
                    -ErrorAction Stop
            if (-not $directoryItem.PSIsContainer -or
                ($directoryItem.Attributes -band
                    [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Control directory '$controlDirectory' is not ordinary."
            }
            $targetPreImage = if (
                [string]$baseline.Status -ceq 'managed'
            ) {
                [System.IO.File]::ReadAllBytes($targetPath)
            } else {
                $null
            }
            $receiptPreImage = if (
                [string]$baseline.Status -ceq 'managed'
            ) {
                [System.IO.File]::ReadAllBytes($receiptPath)
            } else {
                $null
            }
            $transactionId = [Guid]::NewGuid().ToString('N')
            $temporaryTarget =
                Join-Path $controlDirectory ".$transactionId.dispatcher.tmp"
            $temporaryReceipt =
                Join-Path $controlDirectory ".$transactionId.receipt.tmp"
            try {
                [System.IO.File]::Copy(
                    $resolvedSource,
                    $temporaryTarget,
                    $false
                )
                $temporaryHash = (
                    Get-FileHash `
                        -LiteralPath $temporaryTarget `
                        -Algorithm SHA256 `
                        -ErrorAction Stop
                ).Hash.ToLowerInvariant()
                if ($temporaryHash -cne $sourceHash -or
                    -not (Test-CodexLocalRemoteControlDispatcher `
                        -Path $temporaryTarget)) {
                    throw 'The staged control dispatcher changed content.'
                }
                $receipt = [ordered]@{
                    Signature =
                        'codex-local-remote/control-dispatcher-receipt/v1'
                    Version = 1
                    Path = $targetPath
                    Sha256 = $sourceHash
                }
                [System.IO.File]::WriteAllText(
                    $temporaryReceipt,
                    ($receipt | ConvertTo-Json -Depth 4),
                    [System.Text.UTF8Encoding]::new($false)
                )

                $freshBaseline =
                    Get-CodexLocalRemoteControlDispatcherState `
                        -DataDir $DataDir
                if ([string]$freshBaseline.Status -cne
                        [string]$baseline.Status -or
                    [string]$freshBaseline.Sha256 -cne
                        [string]$baseline.Sha256) {
                    throw 'The control dispatcher changed during installation.'
                }
                [System.IO.File]::Move(
                    $temporaryTarget,
                    $targetPath,
                    $true
                )
                [System.IO.File]::Move(
                    $temporaryReceipt,
                    $receiptPath,
                    $true
                )
                $installed =
                    Get-CodexLocalRemoteControlDispatcherState `
                        -DataDir $DataDir
                if ([string]$installed.Sha256 -cne $sourceHash) {
                    throw 'The control dispatcher installation did not verify.'
                }
                return [pscustomobject]@{
                    Status = if (
                        [string]$baseline.Status -ceq 'absent'
                    ) {
                        'created'
                    } else {
                        'updated'
                    }
                    Path = $targetPath
                    ReceiptPath = $receiptPath
                    Sha256 = $sourceHash
                }
            } catch {
                $failure = $_
                try {
                    if ([string]$baseline.Status -ceq 'managed') {
                        [System.IO.File]::WriteAllBytes(
                            $targetPath,
                            $targetPreImage
                        )
                        [System.IO.File]::WriteAllBytes(
                            $receiptPath,
                            $receiptPreImage
                        )
                        $restored =
                            Get-CodexLocalRemoteControlDispatcherState `
                                -DataDir $DataDir
                        if ([string]$restored.Sha256 -cne
                            [string]$baseline.Sha256) {
                            throw 'The dispatcher pre-image did not verify.'
                        }
                    } else {
                        Remove-Item `
                            -LiteralPath $targetPath `
                            -Force `
                            -ErrorAction SilentlyContinue
                        Remove-Item `
                            -LiteralPath $receiptPath `
                            -Force `
                            -ErrorAction SilentlyContinue
                    }
                } catch {
                    throw (
                        "$($failure.Exception.Message) Control dispatcher " +
                        "rollback was incomplete: $($_.Exception.Message)"
                    )
                }
                throw $failure
            } finally {
                Remove-Item `
                    -LiteralPath $temporaryTarget `
                    -Force `
                    -ErrorAction SilentlyContinue
                Remove-Item `
                    -LiteralPath $temporaryReceipt `
                    -Force `
                    -ErrorAction SilentlyContinue
            }
        }
}

function Remove-CodexLocalRemoteControlDispatcher {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    return Invoke-WithCodexLocalRemoteControlDispatcherMutex `
        -DataDir $DataDir `
        -Action {
            $baseline =
                Get-CodexLocalRemoteControlDispatcherState `
                    -DataDir $DataDir
            if ([string]$baseline.Status -ceq 'absent') {
                return [pscustomobject]@{
                    Status = 'not-found'
                    Path = [string]$baseline.Path
                    ReceiptPath = [string]$baseline.ReceiptPath
                }
            }
            $targetPreImage =
                [System.IO.File]::ReadAllBytes([string]$baseline.Path)
            $receiptPreImage =
                [System.IO.File]::ReadAllBytes(
                    [string]$baseline.ReceiptPath
                )
            try {
                Remove-Item `
                    -LiteralPath ([string]$baseline.ReceiptPath) `
                    -Force `
                    -ErrorAction Stop
                Remove-Item `
                    -LiteralPath ([string]$baseline.Path) `
                    -Force `
                    -ErrorAction Stop
                $removed =
                    Get-CodexLocalRemoteControlDispatcherState `
                        -DataDir $DataDir
                if ([string]$removed.Status -cne 'absent') {
                    throw 'Control dispatcher removal did not converge.'
                }
                return [pscustomobject]@{
                    Status = 'removed'
                    Path = [string]$baseline.Path
                    ReceiptPath = [string]$baseline.ReceiptPath
                }
            } catch {
                $failure = $_
                try {
                    [System.IO.File]::WriteAllBytes(
                        [string]$baseline.Path,
                        $targetPreImage
                    )
                    [System.IO.File]::WriteAllBytes(
                        [string]$baseline.ReceiptPath,
                        $receiptPreImage
                    )
                    $restored =
                        Get-CodexLocalRemoteControlDispatcherState `
                            -DataDir $DataDir
                    if ([string]$restored.Sha256 -cne
                        [string]$baseline.Sha256) {
                        throw 'The dispatcher pre-image did not verify.'
                    }
                } catch {
                    throw (
                        "$($failure.Exception.Message) Control dispatcher " +
                        "rollback was incomplete: $($_.Exception.Message)"
                    )
                }
                throw $failure
            }
        }
}

function Assert-CodexLocalRemoteSidecarUpdateInvariant {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Baseline,

        [Parameter(Mandatory)]
        [object]$Current
    )

    foreach ($required in @(
        'SelectedVersionId',
        'SelectedRoot',
        'BrokerProcessId',
        'BrokerStartTimeUtcTicks',
        'RuntimeInvocationId',
        'UpstreamProcessId',
        'UpstreamStartTimeUtcTicks',
        'DesktopRootIdentityKey',
        'BrokerSidecarCompatibilityId',
        'CandidateSidecarCompatibilityId',
        'UnsafeThreadCount',
        'UnknownCount',
        'DesktopConnected'
    )) {
        if ($null -eq $Baseline.PSObject.Properties[$required] -or
            $null -eq $Current.PSObject.Properties[$required]) {
            throw "Sidecar update invariant is missing '$required'."
        }
    }
    if ([string]$Current.SelectedVersionId -cnotmatch
            '^[a-f0-9]{64}$' -or
        [string]::IsNullOrWhiteSpace([string]$Current.SelectedRoot) -or
        [int]$Current.BrokerProcessId -le 0 -or
        [long]$Current.BrokerStartTimeUtcTicks -le 0 -or
        [string]$Current.RuntimeInvocationId -cnotmatch
            '^[a-f0-9]{32}$' -or
        [int]$Current.UpstreamProcessId -le 0 -or
        [long]$Current.UpstreamStartTimeUtcTicks -le 0 -or
        [string]::IsNullOrWhiteSpace(
            [string]$Current.DesktopRootIdentityKey
        ) -or
        [string]$Current.BrokerSidecarCompatibilityId -cnotmatch
            '^codex-local-remote/broker-sidecar/v[1-9][0-9]*$' -or
        [string]$Current.CandidateSidecarCompatibilityId -cne
            [string]$Current.BrokerSidecarCompatibilityId -or
        [int]$Current.UnsafeThreadCount -ne 0 -or
        [int]$Current.UnknownCount -ne 0 -or
        -not [bool]$Current.DesktopConnected) {
        throw 'Sidecar update invariant is not one safe connected lease.'
    }
    foreach ($property in @(
        'SelectedVersionId',
        'BrokerProcessId',
        'BrokerStartTimeUtcTicks',
        'RuntimeInvocationId',
        'UpstreamProcessId',
        'UpstreamStartTimeUtcTicks',
        'DesktopRootIdentityKey',
        'BrokerSidecarCompatibilityId',
        'CandidateSidecarCompatibilityId'
    )) {
        if ([string]$Baseline.$property -cne
            [string]$Current.$property) {
            throw "Sidecar update invariant drifted at '$property'."
        }
    }
    if (-not [string]::Equals(
        [string]$Baseline.SelectedRoot,
        [string]$Current.SelectedRoot,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Sidecar update invariant drifted at 'SelectedRoot'."
    }
    return $true
}

function Invoke-CodexLocalRemoteSidecarUpdateTransaction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [scriptblock]$CaptureInvariant,

        [Parameter(Mandatory)]
        [scriptblock]$StopOldSidecar,

        [Parameter(Mandatory)]
        [scriptblock]$StartNewSidecar,

        [Parameter(Mandatory)]
        [scriptblock]$VerifyNewSidecar,

        [Parameter(Mandatory)]
        [scriptblock]$StopNewSidecar,

        [Parameter(Mandatory)]
        [scriptblock]$StartOldSidecar,

        [Parameter(Mandatory)]
        [scriptblock]$VerifyOldSidecar
    )

    $baseline = & $CaptureInvariant
    $null = Assert-CodexLocalRemoteSidecarUpdateInvariant `
        -Baseline $baseline `
        -Current $baseline
    $newSidecar = $null
    try {
        $null = & $StopOldSidecar
        $afterStop = & $CaptureInvariant
        $null = Assert-CodexLocalRemoteSidecarUpdateInvariant `
            -Baseline $baseline `
            -Current $afterStop
        $newSidecar = & $StartNewSidecar
        $verification = & $VerifyNewSidecar $newSidecar
        $afterStart = & $CaptureInvariant
        $null = Assert-CodexLocalRemoteSidecarUpdateInvariant `
            -Baseline $baseline `
            -Current $afterStart
        return [pscustomobject]@{
            Status = 'updated'
            Sidecar = $newSidecar
            Verification = $verification
            Failure = $null
        }
    } catch {
        $primaryFailure = $_
        $rollbackSidecar = $null
        try {
            if ($null -ne $newSidecar) {
                $null = & $StopNewSidecar $newSidecar
            }
            $rollbackInvariant = & $CaptureInvariant
            $null = Assert-CodexLocalRemoteSidecarUpdateInvariant `
                -Baseline $baseline `
                -Current $rollbackInvariant
            $rollbackSidecar = & $StartOldSidecar
            $rollbackVerification =
                & $VerifyOldSidecar $rollbackSidecar
            $finalInvariant = & $CaptureInvariant
            $null = Assert-CodexLocalRemoteSidecarUpdateInvariant `
                -Baseline $baseline `
                -Current $finalInvariant
            return [pscustomobject]@{
                Status = 'rolled-back'
                Sidecar = $rollbackSidecar
                Verification = $rollbackVerification
                Failure = $primaryFailure.Exception.Message
            }
        } catch {
            throw (
                "$($primaryFailure.Exception.Message) Sidecar-only update " +
                "rollback failed without restarting Broker or Desktop: " +
                "$($_.Exception.Message)"
            )
        }
    }
}

function Get-CodexLocalRemoteDesiredModePath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    return [System.IO.Path]::GetFullPath(
        (Join-Path `
            ([System.IO.Path]::GetFullPath($DataDir)) `
            'remote-mode.json')
    )
}

function Get-CodexLocalRemoteDesiredMode {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $path = Get-CodexLocalRemoteDesiredModePath -DataDir $DataDir
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return [pscustomobject]@{
            Mode = 'Native'
            Status = 'default-native'
            Path = $path
        }
    }
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or
        ($item.Attributes -band
            [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        [long]$item.Length -lt 2 -or
        [long]$item.Length -gt 131072) {
        throw "Remote mode receipt '$path' is not ordinary."
    }
    try {
        $receipt = Get-Content `
            -LiteralPath $path `
            -Raw `
            -Encoding utf8 `
            -ErrorAction Stop |
            ConvertFrom-Json -Depth 10 -DateKind String -ErrorAction Stop
    } catch {
        throw "Remote mode receipt '$path' is invalid JSON."
    }
    if ([string]$receipt.Signature -cne
            'codex-local-remote/desired-mode/v1' -or
        [int]$receipt.Version -ne 1 -or
        [string]$receipt.Mode -cnotin @('Remote', 'Native') -or
        [string]$receipt.RuntimeVersionId -cnotmatch '^[a-f0-9]{64}$' -or
        [string]::IsNullOrWhiteSpace(
            [string]$receipt.RuntimeRoot
        ) -or
        [string]$receipt.IntentId -cnotmatch '^[a-f0-9]{32}$') {
        throw "Remote mode receipt '$path' is not canonical."
    }
    return [pscustomobject]@{
        Mode = [string]$receipt.Mode
        Status = 'explicit'
        Path = $path
        RuntimeVersionId = [string]$receipt.RuntimeVersionId
        RuntimeRoot = [System.IO.Path]::GetFullPath(
            [string]$receipt.RuntimeRoot
        )
        IntentId = [string]$receipt.IntentId
    }
}

function Set-CodexLocalRemoteDesiredMode {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [ValidateSet('Remote', 'Native')]
        [string]$Mode,

        [Parameter(Mandatory)]
        [ValidatePattern('^[a-f0-9]{64}$')]
        [string]$RuntimeVersionId,

        [Parameter(Mandatory)]
        [string]$RuntimeRoot
    )

    $resolvedRuntimeRoot =
        [System.IO.Path]::GetFullPath($RuntimeRoot)
    $receipt = [ordered]@{
        Signature = 'codex-local-remote/desired-mode/v1'
        Version = 1
        Mode = $Mode
        RuntimeVersionId = $RuntimeVersionId
        RuntimeRoot = $resolvedRuntimeRoot
        IntentId = [Guid]::NewGuid().ToString('N')
    }
    Write-AtomicJsonFile `
        -Path (
            Get-CodexLocalRemoteDesiredModePath -DataDir $DataDir
        ) `
        -Value $receipt
    $readBack = Get-CodexLocalRemoteDesiredMode -DataDir $DataDir
    if ([string]$readBack.Mode -cne $Mode -or
        [string]$readBack.RuntimeVersionId -cne $RuntimeVersionId -or
        -not [string]::Equals(
            [string]$readBack.RuntimeRoot,
            $resolvedRuntimeRoot,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -or
        [string]$readBack.IntentId -cne [string]$receipt.IntentId) {
        throw 'Remote desired mode failed exact read-back verification.'
    }
    return $readBack
}

function Remove-CodexLocalRemoteDesiredMode {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $baseline = Get-CodexLocalRemoteDesiredMode -DataDir $DataDir
    if ([string]$baseline.Status -ceq 'default-native') {
        return [pscustomobject]@{ Status = 'not-found' }
    }
    $fresh = Get-CodexLocalRemoteDesiredMode -DataDir $DataDir
    if ([string]$fresh.IntentId -cne [string]$baseline.IntentId) {
        throw 'Remote desired mode changed before exact removal.'
    }
    Remove-Item `
        -LiteralPath ([string]$baseline.Path) `
        -Force `
        -ErrorAction Stop
    $removed = Get-CodexLocalRemoteDesiredMode -DataDir $DataDir
    if ([string]$removed.Status -cne 'default-native') {
        throw 'Remote desired mode removal did not verify.'
    }
    return [pscustomobject]@{ Status = 'removed' }
}

function Get-CurrentStartupTaskFingerprint {
    [CmdletBinding()]
    param()

    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    if ($null -eq $identity.User -or [string]::IsNullOrWhiteSpace($identity.User.Value)) {
        throw 'The current Windows identity does not expose a user SID; refusing to define a startup task.'
    }

    return [pscustomobject]@{
        PrincipalUserSid = $identity.User.Value
        PrincipalLogonType = 'Interactive'
        PrincipalRunLevel = 'Highest'
        TriggerCount = 0
        TriggerClass = ''
        TriggerUserSid = ''
        TriggerEnabled = $false
        Settings = [pscustomobject]@{
            DisallowStartIfOnBatteries = $false
            StopIfGoingOnBatteries = $false
            ExecutionTimeLimit = 'P3650D'
            MultipleInstances = 'IgnoreNew'
            RestartCount = 0
            RestartInterval = ''
            StartWhenAvailable = $false
            Enabled = $true
            AllowDemandStart = $true
            RunOnlyIfIdle = $false
            RunOnlyIfNetworkAvailable = $false
        }
    }
}

function Add-StartupTaskFingerprint {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Definition
    )

    $fingerprint = Get-CurrentStartupTaskFingerprint
    foreach ($property in $fingerprint.PSObject.Properties) {
        $Definition | Add-Member `
            -NotePropertyName $property.Name `
            -NotePropertyValue $property.Value
    }
    return $Definition
}

function ConvertTo-LegacyAutoStartTaskFingerprint {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Definition
    )

    $properties = [ordered]@{}
    foreach ($property in $Definition.PSObject.Properties) {
        $properties[[string]$property.Name] = $property.Value
    }
    $legacySettings = [ordered]@{}
    foreach ($property in $Definition.Settings.PSObject.Properties) {
        $legacySettings[[string]$property.Name] = $property.Value
    }
    $legacySettings.StartWhenAvailable = $true
    $legacySettings.RestartCount = 3
    $legacySettings.RestartInterval = 'PT1M'
    $properties.TriggerCount = 1
    $properties.TriggerClass = 'MSFT_TaskLogonTrigger'
    $properties.TriggerUserSid = [string]$Definition.PrincipalUserSid
    $properties.TriggerEnabled = $true
    $properties.Settings = [pscustomobject]$legacySettings
    return [pscustomobject]$properties
}

function Resolve-ScheduledTaskIdentitySid {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$UserId
    )

    $value = [string]$UserId
    if ([string]::IsNullOrWhiteSpace($value)) {
        return $null
    }
    try {
        return ([System.Security.Principal.SecurityIdentifier]::new($value)).Value
    } catch {
        try {
            return (
                [System.Security.Principal.NTAccount]::new($value)
            ).Translate(
                [System.Security.Principal.SecurityIdentifier]
            ).Value
        } catch {
            return $null
        }
    }
}

function Get-StartupTaskObjectProperty {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$InputObject,

        [Parameter(Mandatory)]
        [string]$Name
    )

    if ($null -eq $InputObject) {
        return [pscustomobject]@{ Exists = $false; Value = $null }
    }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return [pscustomobject]@{ Exists = $false; Value = $null }
    }
    return [pscustomobject]@{ Exists = $true; Value = $property.Value }
}

function Get-LegacyStartupTaskDefinition {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$TaskName,

        [Parameter(Mandatory)]
        [string]$NodePath,

        [Parameter(Mandatory)]
        [string]$InstallRoot,

        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [int]$Port,

        [Parameter(Mandatory)]
        [string]$BasePath
    )

    Assert-CanonicalBasePath -BasePath $BasePath
    $resolvedRoot = [System.IO.Path]::GetFullPath($InstallRoot)
    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
    $resolvedNode = [System.IO.Path]::GetFullPath($NodePath)
    $cli = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot 'apps\sidecar\dist\cli.js'))
    $arguments = @(
        (ConvertTo-WindowsCommandLineArgument -Value $cli)
        'serve'
        '--host'
        '127.0.0.1'
        '--port'
        $Port.ToString([System.Globalization.CultureInfo]::InvariantCulture)
        '--base-path'
        (ConvertTo-WindowsCommandLineArgument -Value $BasePath)
        '--data-dir'
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedDataDir)
    ) -join ' '

    $definition = Add-StartupTaskFingerprint -Definition ([pscustomobject]@{
        TaskName = $TaskName
        TaskPath = '\'
        Description = 'codex-local-remote/startup-task/v1 - Starts the local-only Codex Local Remote sidecar at user sign-in.'
        Execute = $resolvedNode
        Arguments = $arguments
        WorkingDirectory = $resolvedRoot
        Cli = $cli
        DataDir = $resolvedDataDir
    })
    return ConvertTo-LegacyAutoStartTaskFingerprint `
        -Definition $definition
}

function Get-StartupTaskDefinition {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$TaskName,

        [Parameter(Mandatory)]
        [string]$NodePath,

        [string]$CodexPath,

        [Parameter(Mandatory)]
        [string]$PwshPath,

        [Parameter(Mandatory)]
        [string]$InstallRoot,

        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [int]$Port,

        [Parameter(Mandatory)]
        [int]$BrokerPort,

        [Parameter(Mandatory)]
        [int]$BrokerUpstreamPort,

        [Parameter(Mandatory)]
        [string]$BasePath
    )

    Assert-CanonicalBasePath -BasePath $BasePath
    $resolvedRoot = [System.IO.Path]::GetFullPath($InstallRoot)
    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
    $resolvedNode = [System.IO.Path]::GetFullPath($NodePath)
    $resolvedPwsh = [System.IO.Path]::GetFullPath($PwshPath)
    $windowsRoot = [Environment]::GetEnvironmentVariable('SystemRoot')
    if ([string]::IsNullOrWhiteSpace($windowsRoot)) {
        throw 'SystemRoot is unavailable; cannot resolve the headless console host.'
    }
    $taskExecute = [System.IO.Path]::GetFullPath(
        (Join-Path $windowsRoot 'System32\conhost.exe')
    )
    $cli = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot 'apps\sidecar\dist\cli.js'))
    $brokerCli = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot 'apps\broker\dist\cli.js'))
    $bootstrap = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot 'scripts\windows\Start-CodexLocalRemote.ps1'))
    $arguments = @(
        '-NoLogo'
        '-NoProfile'
        '-NonInteractive'
        '-WindowStyle'
        'Hidden'
        '-ExecutionPolicy'
        'Bypass'
        '-File'
        (ConvertTo-WindowsCommandLineArgument -Value $bootstrap)
        '-NodePath'
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedNode)
        '-InstallRoot'
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedRoot)
        '-DataDir'
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedDataDir)
        '-SidecarPort'
        $Port.ToString([System.Globalization.CultureInfo]::InvariantCulture)
        '-BrokerPort'
        $BrokerPort.ToString([System.Globalization.CultureInfo]::InvariantCulture)
        '-BrokerUpstreamPort'
        $BrokerUpstreamPort.ToString([System.Globalization.CultureInfo]::InvariantCulture)
        '-BasePath'
        (ConvertTo-WindowsCommandLineArgument -Value $BasePath)
        '-DesktopOwnerCoordinator'
        '-TakeOverExistingNativeDesktop'
    ) -join ' '
    $taskArguments = @(
        '--headless'
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedPwsh)
        $arguments
    ) -join ' '

    Add-StartupTaskFingerprint -Definition ([pscustomobject]@{
        TaskName = $TaskName
        TaskPath = '\'
        Description = $script:StartupTaskDescription
        Execute = $resolvedPwsh
        Arguments = $arguments
        TaskExecute = $taskExecute
        TaskArguments = $taskArguments
        WorkingDirectory = $resolvedRoot
        Bootstrap = $bootstrap
        Cli = $cli
        BrokerCli = $brokerCli
        Node = $resolvedNode
        DataDir = $resolvedDataDir
    })
}

function Get-LegacyAutoStartStartupTaskDefinitionV5 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Definition
    )

    $properties = [ordered]@{}
    foreach ($property in $Definition.PSObject.Properties) {
        $properties[[string]$property.Name] = $property.Value
    }
    $properties.Description =
        $script:LegacyAutoStartStartupTaskV5Description
    return ConvertTo-LegacyAutoStartTaskFingerprint `
        -Definition ([pscustomobject]$properties)
}

function Get-LegacyDesktopOwningStartupTaskDefinitionV3 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Definition
    )

    $properties = [ordered]@{}
    foreach ($property in $Definition.PSObject.Properties) {
        $properties[[string]$property.Name] = $property.Value
    }
    $properties.Description = $script:LegacyDesktopOwningStartupTaskV3Description
    $currentSuffix =
        ' -DesktopOwnerCoordinator -TakeOverExistingNativeDesktop'
    $legacySuffix = ' -TakeOverExistingNativeDesktop'
    foreach ($name in @('Arguments', 'TaskArguments')) {
        if (-not $properties.Contains($name)) {
            continue
        }
        $value = [string]$properties[$name]
        if (-not $value.EndsWith(
            $currentSuffix,
            [System.StringComparison]::Ordinal
        )) {
            throw "The current startup task definition does not end with $currentSuffix."
        }
        $properties[$name] =
            $value.Substring(0, $value.Length - $currentSuffix.Length) +
            $legacySuffix
    }
    return ConvertTo-LegacyAutoStartTaskFingerprint `
        -Definition ([pscustomobject]$properties)
}

function Get-LegacyHeadlessStartupTaskDefinitionV4 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Definition
    )

    $properties = [ordered]@{}
    foreach ($property in $Definition.PSObject.Properties) {
        $properties[[string]$property.Name] = $property.Value
    }
    $properties.Description = $script:LegacyHeadlessStartupTaskV4Description
    $currentSuffix =
        ' -DesktopOwnerCoordinator -TakeOverExistingNativeDesktop'
    $legacySuffix = ' -NoDesktopLaunch'
    foreach ($name in @('Arguments', 'TaskArguments')) {
        if (-not $properties.Contains($name)) {
            continue
        }
        $value = [string]$properties[$name]
        if (-not $value.EndsWith(
            $currentSuffix,
            [System.StringComparison]::Ordinal
        )) {
            throw "The current startup task definition does not end with $currentSuffix."
        }
        $properties[$name] =
            $value.Substring(0, $value.Length - $currentSuffix.Length) +
            $legacySuffix
    }
    return ConvertTo-LegacyAutoStartTaskFingerprint `
        -Definition ([pscustomobject]$properties)
}

function Get-PreHeadlessConsoleStartupTaskDefinition {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Definition
    )

    $properties = [ordered]@{}
    foreach ($property in $Definition.PSObject.Properties) {
        $properties[[string]$property.Name] = $property.Value
    }
    $properties.TaskExecute = [string]$Definition.Execute
    $properties.TaskArguments = [string]$Definition.Arguments
    return [pscustomobject]$properties
}

function Get-PinnedStartupTaskDefinitionV2 {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$TaskName,

        [Parameter(Mandatory)]
        [string]$NodePath,

        [Parameter(Mandatory)]
        [string]$CodexPath,

        [Parameter(Mandatory)]
        [string]$PwshPath,

        [Parameter(Mandatory)]
        [string]$InstallRoot,

        [Parameter(Mandatory)]
        [string]$DataDir,

        [Parameter(Mandatory)]
        [int]$Port,

        [Parameter(Mandatory)]
        [int]$BrokerPort,

        [Parameter(Mandatory)]
        [int]$BrokerUpstreamPort,

        [Parameter(Mandatory)]
        [string]$BasePath
    )

    Assert-CanonicalBasePath -BasePath $BasePath
    $resolvedRoot = [System.IO.Path]::GetFullPath($InstallRoot)
    $resolvedDataDir = [System.IO.Path]::GetFullPath($DataDir)
    $resolvedNode = [System.IO.Path]::GetFullPath($NodePath)
    $resolvedCodex = [System.IO.Path]::GetFullPath($CodexPath)
    $resolvedPwsh = [System.IO.Path]::GetFullPath($PwshPath)
    $cli = [System.IO.Path]::GetFullPath(
        (Join-Path $resolvedRoot 'apps\sidecar\dist\cli.js')
    )
    $brokerCli = [System.IO.Path]::GetFullPath(
        (Join-Path $resolvedRoot 'apps\broker\dist\cli.js')
    )
    $bootstrap = [System.IO.Path]::GetFullPath(
        (Join-Path $resolvedRoot 'scripts\windows\Start-CodexLocalRemote.ps1')
    )
    $arguments = @(
        '-NoLogo'
        '-NoProfile'
        '-NonInteractive'
        '-ExecutionPolicy'
        'Bypass'
        '-File'
        (ConvertTo-WindowsCommandLineArgument -Value $bootstrap)
        '-CodexPath'
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedCodex)
        '-NodePath'
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedNode)
        '-InstallRoot'
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedRoot)
        '-DataDir'
        (ConvertTo-WindowsCommandLineArgument -Value $resolvedDataDir)
        '-SidecarPort'
        $Port.ToString([System.Globalization.CultureInfo]::InvariantCulture)
        '-BrokerPort'
        $BrokerPort.ToString([System.Globalization.CultureInfo]::InvariantCulture)
        '-BrokerUpstreamPort'
        $BrokerUpstreamPort.ToString([System.Globalization.CultureInfo]::InvariantCulture)
        '-BasePath'
        (ConvertTo-WindowsCommandLineArgument -Value $BasePath)
    ) -join ' '

    $definition = Add-StartupTaskFingerprint -Definition ([pscustomobject]@{
        TaskName = $TaskName
        TaskPath = '\'
        Description = $script:PinnedStartupTaskV2Description
        Execute = $resolvedPwsh
        Arguments = $arguments
        WorkingDirectory = $resolvedRoot
        Bootstrap = $bootstrap
        Cli = $cli
        BrokerCli = $brokerCli
        Codex = $resolvedCodex
        Node = $resolvedNode
        DataDir = $resolvedDataDir
    })
    return ConvertTo-LegacyAutoStartTaskFingerprint `
        -Definition $definition
}

function Test-ManagedStartupTask {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [object]$Task,

        [Parameter(Mandatory)]
        [object]$Expected
    )

    $mismatches = [System.Collections.Generic.List[string]]::new()
    foreach ($taskSpec in @(
        @{ Name = 'TaskName'; Expected = [string]$Expected.TaskName; Mismatch = 'task name' },
        @{ Name = 'TaskPath'; Expected = [string]$Expected.TaskPath; Mismatch = 'task path' },
        @{ Name = 'Description'; Expected = [string]$Expected.Description; Mismatch = 'signature' }
    )) {
        $actual = Get-StartupTaskObjectProperty -InputObject $Task -Name $taskSpec.Name
        if (-not $actual.Exists -or
            [string]$actual.Value -cne [string]$taskSpec.Expected) {
            $mismatches.Add([string]$taskSpec.Mismatch)
        }
    }

    $actionsProperty = Get-StartupTaskObjectProperty -InputObject $Task -Name 'Actions'
    $actions = @(
        if ($actionsProperty.Exists) {
            $actionsProperty.Value
        }
    )
    if ($actions.Count -ne 1) {
        $mismatches.Add('action count')
    } else {
        $action = $actions[0]
        $expectedTaskExecute = if (
            $null -ne $Expected.PSObject.Properties['TaskExecute']
        ) {
            [string]$Expected.TaskExecute
        } else {
            [string]$Expected.Execute
        }
        $expectedTaskArguments = if (
            $null -ne $Expected.PSObject.Properties['TaskArguments']
        ) {
            [string]$Expected.TaskArguments
        } else {
            [string]$Expected.Arguments
        }
        foreach ($actionSpec in @(
            @{ Name = 'Execute'; Expected = $expectedTaskExecute; Mismatch = 'action executable' },
            @{ Name = 'Arguments'; Expected = $expectedTaskArguments; Mismatch = 'action arguments' },
            @{
                Name = 'WorkingDirectory'
                Expected = [string]$Expected.WorkingDirectory
                Mismatch = 'working directory'
            }
        )) {
            $actual = Get-StartupTaskObjectProperty -InputObject $action -Name $actionSpec.Name
            if (-not $actual.Exists -or
                [string]$actual.Value -cne [string]$actionSpec.Expected) {
                $mismatches.Add([string]$actionSpec.Mismatch)
            }
        }
    }

    $principalProperty = Get-StartupTaskObjectProperty -InputObject $Task -Name 'Principal'
    if (-not $principalProperty.Exists -or $null -eq $principalProperty.Value) {
        $mismatches.Add('principal')
    } else {
        $principalUserId = Get-StartupTaskObjectProperty `
            -InputObject $principalProperty.Value `
            -Name 'UserId'
        $principalSid = if ($principalUserId.Exists) {
            Resolve-ScheduledTaskIdentitySid -UserId $principalUserId.Value
        } else {
            $null
        }
        if ($null -eq $principalSid -or
            $principalSid -cne [string]$Expected.PrincipalUserSid) {
            $mismatches.Add('principal user SID')
        }
        foreach ($propertySpec in @(
            @{
                Name = 'LogonType'
                Expected = [string]$Expected.PrincipalLogonType
                Mismatch = 'principal logon type'
            },
            @{
                Name = 'RunLevel'
                Expected = [string]$Expected.PrincipalRunLevel
                Mismatch = 'principal run level'
            }
        )) {
            $actual = Get-StartupTaskObjectProperty `
                -InputObject $principalProperty.Value `
                -Name $propertySpec.Name
            if (-not $actual.Exists -or
                [string]$actual.Value -cne [string]$propertySpec.Expected) {
                $mismatches.Add([string]$propertySpec.Mismatch)
            }
        }
    }

    $triggersProperty = Get-StartupTaskObjectProperty -InputObject $Task -Name 'Triggers'
    $triggers = [System.Collections.Generic.List[object]]::new()
    if (
        $triggersProperty.Exists -and
        $null -ne $triggersProperty.Value
    ) {
        foreach ($triggerValue in @($triggersProperty.Value)) {
            $triggers.Add($triggerValue)
        }
    }
    $expectedTriggerCount = if (
        $null -ne $Expected.PSObject.Properties['TriggerCount']
    ) {
        [int]$Expected.TriggerCount
    } else {
        1
    }
    if (-not $triggersProperty.Exists) {
        $mismatches.Add('triggers')
    } elseif ($triggers.Count -ne $expectedTriggerCount) {
        $mismatches.Add('logon trigger count')
    } elseif ($expectedTriggerCount -eq 1) {
        $trigger = $triggers[0]
        $cimClassProperty = Get-StartupTaskObjectProperty -InputObject $trigger -Name 'CimClass'
        $triggerClass = $null
        if ($cimClassProperty.Exists -and $null -ne $cimClassProperty.Value) {
            $cimClassNameProperty = Get-StartupTaskObjectProperty `
                -InputObject $cimClassProperty.Value `
                -Name 'CimClassName'
            if ($cimClassNameProperty.Exists) {
                $triggerClass = [string]$cimClassNameProperty.Value
            }
        }
        if ([string]::IsNullOrWhiteSpace($triggerClass)) {
            $cimClassNameProperty = Get-StartupTaskObjectProperty `
                -InputObject $trigger `
                -Name 'CimClassName'
            if ($cimClassNameProperty.Exists) {
                $triggerClass = [string]$cimClassNameProperty.Value
            }
        }
        if ($triggerClass -cne [string]$Expected.TriggerClass) {
            $mismatches.Add('logon trigger class')
        }

        $triggerUserId = Get-StartupTaskObjectProperty -InputObject $trigger -Name 'UserId'
        $triggerSid = if ($triggerUserId.Exists) {
            Resolve-ScheduledTaskIdentitySid -UserId $triggerUserId.Value
        } else {
            $null
        }
        if ($null -eq $triggerSid -or
            $triggerSid -cne [string]$Expected.TriggerUserSid) {
            $mismatches.Add('logon trigger user SID')
        }

        $triggerEnabled = Get-StartupTaskObjectProperty -InputObject $trigger -Name 'Enabled'
        if (-not $triggerEnabled.Exists -or
            $triggerEnabled.Value -isnot [bool] -or
            [bool]$triggerEnabled.Value -ne [bool]$Expected.TriggerEnabled) {
            $mismatches.Add('logon trigger enabled')
        }
    }

    $settingsProperty = Get-StartupTaskObjectProperty -InputObject $Task -Name 'Settings'
    if (-not $settingsProperty.Exists -or $null -eq $settingsProperty.Value) {
        $mismatches.Add('settings')
    } else {
        foreach ($settingSpec in @(
            @{ Name = 'DisallowStartIfOnBatteries'; Kind = 'bool' },
            @{ Name = 'StopIfGoingOnBatteries'; Kind = 'bool' },
            @{ Name = 'ExecutionTimeLimit'; Kind = 'string' },
            @{ Name = 'MultipleInstances'; Kind = 'string' },
            @{ Name = 'RestartCount'; Kind = 'integer' },
            @{ Name = 'RestartInterval'; Kind = 'string' },
            @{ Name = 'StartWhenAvailable'; Kind = 'bool' },
            @{ Name = 'Enabled'; Kind = 'bool' },
            @{ Name = 'AllowDemandStart'; Kind = 'bool' },
            @{ Name = 'RunOnlyIfIdle'; Kind = 'bool' },
            @{ Name = 'RunOnlyIfNetworkAvailable'; Kind = 'bool' }
        )) {
            $actual = Get-StartupTaskObjectProperty `
                -InputObject $settingsProperty.Value `
                -Name $settingSpec.Name
            $expectedValue = $Expected.Settings.PSObject.Properties[$settingSpec.Name].Value
            $matches = $actual.Exists
            if ($matches) {
                switch ($settingSpec.Kind) {
                    'bool' {
                        $matches = (
                            $actual.Value -is [bool] -and
                            [bool]$actual.Value -eq [bool]$expectedValue
                        )
                    }
                    'integer' {
                        try {
                            $matches = [int64]$actual.Value -eq [int64]$expectedValue
                        } catch {
                            $matches = $false
                        }
                    }
                    default {
                        $matches = [string]$actual.Value -ceq [string]$expectedValue
                    }
                }
            }
            if (-not $matches) {
                $mismatches.Add("settings $($settingSpec.Name)")
            }
        }
    }

    [pscustomobject]@{
        IsManaged = ($mismatches.Count -eq 0)
        Mismatches = @($mismatches)
    }
}

function ConvertTo-CanonicalJson {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [Parameter(ValueFromPipeline)]
        [object]$InputObject
    )

    process {
        function Convert-Node {
            param([AllowNull()][object]$Value)

            if ($null -eq $Value) {
                return $null
            }
            if ($Value -is [string] -or
                $Value -is [bool] -or
                $Value.GetType().IsPrimitive -or
                $Value -is [decimal]) {
                return $Value
            }
            if ($Value -is [System.Collections.IDictionary]) {
                $ordered = [ordered]@{}
                foreach ($key in @($Value.Keys | Sort-Object)) {
                    $ordered[[string]$key] = Convert-Node $Value[$key]
                }
                return $ordered
            }
            if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
                return @($Value | ForEach-Object { Convert-Node $_ })
            }

            $ordered = [ordered]@{}
            foreach ($property in @($Value.PSObject.Properties | Sort-Object Name)) {
                $ordered[$property.Name] = Convert-Node $property.Value
            }
            return $ordered
        }

        return (Convert-Node $InputObject | ConvertTo-Json -Compress -Depth 50)
    }
}

function Get-FunnelHandlerEntries {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Status
    )

    $entries = [System.Collections.Generic.List[object]]::new()
    if ($null -eq $Status) {
        return @()
    }
    $webProperty = $Status.PSObject.Properties['Web']
    if ($null -eq $webProperty -or $null -eq $webProperty.Value) {
        return @()
    }

    foreach ($webEntry in @($webProperty.Value.PSObject.Properties | Sort-Object Name)) {
        $handlersProperty = $webEntry.Value.PSObject.Properties['Handlers']
        if ($null -eq $handlersProperty -or $null -eq $handlersProperty.Value) {
            continue
        }
        foreach ($handlerProperty in @($handlersProperty.Value.PSObject.Properties | Sort-Object Name)) {
            $entries.Add([pscustomobject]@{
                WebKey = $webEntry.Name
                Path = $handlerProperty.Name
                HandlerJson = ConvertTo-CanonicalJson $handlerProperty.Value
            })
        }
    }
    return @($entries)
}

function Get-FunnelWebKey {
    [CmdletBinding()]
    param(
        [AllowNull()]
        [object]$Status,

        [Parameter(Mandatory)]
        [int]$HttpsPort
    )

    if ($null -eq $Status) {
        return $null
    }
    $webProperty = $Status.PSObject.Properties['Web']
    if ($null -eq $webProperty -or $null -eq $webProperty.Value) {
        return $null
    }
    $matches = @($webProperty.Value.PSObject.Properties.Name |
        Where-Object { $_ -match ":$([regex]::Escape($HttpsPort.ToString()))$" })
    if ($matches.Count -gt 1) {
        throw "Multiple Funnel web handlers use HTTPS port $HttpsPort; refusing an ambiguous update."
    }
    if ($matches.Count -eq 0) {
        return $null
    }
    return $matches[0]
}

function Test-FunnelHandlerEntriesEqual {
    [CmdletBinding()]
    param(
        [AllowEmptyCollection()]
        [Parameter(Mandatory)]
        [object[]]$Left,

        [AllowEmptyCollection()]
        [Parameter(Mandatory)]
        [object[]]$Right
    )

    $leftJson = ConvertTo-CanonicalJson @($Left | Sort-Object WebKey, Path)
    $rightJson = ConvertTo-CanonicalJson @($Right | Sort-Object WebKey, Path)
    return $leftJson -ceq $rightJson
}

Export-ModuleMember -Function @(
    'Assert-CanonicalBasePath',
    'Join-BasePathUrl',
    'ConvertTo-WindowsCommandLineArgument',
    'ConvertFrom-WindowsCommandLine',
    'Get-BrokerWebSocketUrl',
    'Get-BrokerCapabilityTokenPath',
    'Resolve-CodexDesktopPackageStatusIdentity',
    'Resolve-CodexDesktopRuntime',
    'Get-CodexLocalRemoteManagedDesktopIconPath',
    'Test-CodexLocalRemoteManagedDesktopIcon',
    'Install-CodexLocalRemoteManagedDesktopIcon',
    'Remove-CodexLocalRemoteManagedDesktopIcon',
    'Assert-CodexLocalRemoteDataDirectoryPath',
    'Get-CodexLocalRemoteDataDirectoryOwnershipPlan',
    'Assert-CodexLocalRemoteDataDirectoryStartupProtection',
    'Protect-CodexLocalRemoteDataDirectory',
    'Test-BrokerCapabilityToken',
    'Read-BrokerCapabilityToken',
    'Install-BrokerCapabilityToken',
    'Remove-BrokerCapabilityToken',
    'Get-BrokerCapabilityWebSocketUrl',
    'Get-StringSha256',
    'Test-NonNegativeInteger',
    'Read-CodexDesktopLaunchReceipt',
    'Test-ActiveCodexRuntimeMatchesCurrentDiscovery',
    'Get-BrokerReadinessDecision',
    'Assert-LoopbackWebSocketUrl',
    'Test-IsLoopbackListenerAddress',
    'Get-CodexLocalRemoteTcpListenerSnapshot',
    'Get-ManagedIpv4Listeners',
    'Get-ProcessCreationIdentity',
    'Open-ProcessIdentityHandle',
    'Stop-ProcessIdentityHandle',
    'Test-ManagedAppServerProcess',
    'Test-ManagedBrokerProcess',
    'Test-ManagedSidecarProcess',
    'Test-ManagedBootstrapProcess',
    'Get-ManagedBootstrapProcessContract',
    'Test-IndependentDesktopAppServer',
    'Get-CodexLocalRemoteDesktopHandoffPreparationPath',
    'Select-CodexLocalRemoteNativeDesktopRootCandidates',
    'Get-CodexLocalRemoteNativeDesktopRootCandidates',
    'Get-CodexLocalRemoteNativeDesktopOwnershipSnapshot',
    'Read-CodexLocalRemoteDesktopHandoffPreparation',
    'New-CodexLocalRemoteDesktopHandoffPreparation',
    'Set-CodexLocalRemoteDesktopHandoffPreparationReady',
    'Set-CodexLocalRemoteDesktopHandoffPreparationAttaching',
    'Complete-CodexLocalRemoteDesktopHandoffPreparation',
    'Assert-ForceCliDisabled',
    'Write-AtomicJsonFile',
    'Get-CodexDesktopOwnerIntentPath',
    'Get-CodexDesktopOwnerConnectionProofPath',
    'Get-CodexDesktopOwnerRootIdentityKey',
    'Invoke-WithCodexDesktopOwnerMutex',
    'New-CodexDesktopOwnerIntent',
    'New-CodexDesktopOwnerIntentUnderOwnerLock',
    'Get-CodexDesktopOwnerIntentFreshnessDecision',
    'Read-CodexDesktopOwnerIntent',
    'Complete-CodexDesktopOwnerIntent',
    'Write-CodexDesktopOwnerConnectionProof',
    'Read-CodexDesktopOwnerConnectionProof',
    'Remove-CodexDesktopOwnerConnectionProof',
    'Test-CodexDesktopOwnerResumeGap',
    'Get-CodexDesktopOwnerDecision',
    'Test-CodexDesktopNonceReadinessSnapshot',
    'Test-CodexDesktopOwnerConnectedProof',
    'Test-CodexDesktopOwnerConnectionProof',
    'Get-CodexLocalRemoteManagedConfiguration',
    'Set-CodexLocalRemoteManagedConfiguration',
    'Get-CodexLocalRemoteRuntimeVersionPlan',
    'Test-CodexLocalRemoteRuntimeVersion',
    'Test-CodexLocalRemoteBrokerPayloadCompatibility',
    'Install-CodexLocalRemoteRuntimeVersion',
    'Get-CodexLocalRemoteCurrentRuntime',
    'Get-CodexLocalRemoteRuntimeTaskPreImage',
    'Set-CodexLocalRemoteCurrentRuntime',
    'Sync-CodexLocalRemoteCurrentRuntime',
    'Get-UserEnvironmentValueState',
    'New-BrokerEnvironmentBackupState',
    'Set-UserEnvironmentValue',
    'Install-BrokerUserEnvironment',
    'Assert-BrokerUserEnvironmentRestorable',
    'Restore-BrokerUserEnvironment',
    'Get-CodexLocalRemoteControlDispatcherPath',
    'Get-CodexLocalRemoteControlDispatcherReceiptPath',
    'Test-CodexLocalRemoteControlDispatcher',
    'Get-CodexLocalRemoteControlDispatcherState',
    'Invoke-WithCodexLocalRemoteControlDispatcherMutex',
    'Install-CodexLocalRemoteControlDispatcher',
    'Remove-CodexLocalRemoteControlDispatcher',
    'Assert-CodexLocalRemoteSidecarUpdateInvariant',
    'Invoke-CodexLocalRemoteSidecarUpdateTransaction',
    'Get-CodexLocalRemoteDesiredModePath',
    'Get-CodexLocalRemoteDesiredMode',
    'Set-CodexLocalRemoteDesiredMode',
    'Remove-CodexLocalRemoteDesiredMode',
    'Get-LegacyStartupTaskDefinition',
    'Get-StartupTaskDefinition',
    'Get-LegacyAutoStartStartupTaskDefinitionV5',
    'Get-LegacyHeadlessStartupTaskDefinitionV4',
    'Get-LegacyDesktopOwningStartupTaskDefinitionV3',
    'Get-PreHeadlessConsoleStartupTaskDefinition',
    'Get-PinnedStartupTaskDefinitionV2',
    'Test-ManagedStartupTask',
    'ConvertTo-CanonicalJson',
    'Get-FunnelHandlerEntries',
    'Get-FunnelWebKey',
    'Test-FunnelHandlerEntriesEqual'
)
