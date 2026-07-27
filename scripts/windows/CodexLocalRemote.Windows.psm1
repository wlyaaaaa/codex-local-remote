Set-StrictMode -Version Latest

$script:StartupTaskSignature = 'codex-local-remote/startup-task/v3'
$script:StartupTaskDescription = "$script:StartupTaskSignature - Starts the loopback app-server broker before the local-only Codex Local Remote sidecar at user sign-in."
$script:PinnedStartupTaskV2Description = 'codex-local-remote/startup-task/v2 - Starts the loopback app-server broker before the local-only Codex Local Remote sidecar at user sign-in.'
$script:BrokerStateSignature = 'codex-local-remote/app-server-broker/v3'
$script:EnvironmentStateSignature = 'codex-local-remote/user-environment/v2'
$script:BrokerCapabilityTokenName = 'broker-capability.token'
$script:DataDirectoryOwnerSignature = 'codex-local-remote/data-directory-owner/v1'
$script:DataDirectoryOwnerMarkerName = '.codex-local-remote-data-owner.json'
$script:DataDirectoryOwnerMarkerMaxBytes = 4096
$script:CodexDesktopPackageName = 'OpenAI.Codex'
$script:CodexDesktopPublisherId = '2p2nqsd0c76g0'
$script:LegacyDataDirectoryFiles = @(
    'state.json',
    'startup-last.json',
    'app-server-broker.json',
    'windows-broker-environment.json',
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

    $runtimePath = $bundledCodexPath
    $runtimeSource = 'package-bundled'
    $cacheRoot = [System.IO.Path]::GetFullPath(
        (Join-Path $LocalAppDataPath 'OpenAI\Codex\bin')
    )
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
        CodexPath = $runtimePath
        CodexSha256 = $runtimeSha256
        Source = $runtimeSource
        RunningDesktopObserved = ($codexPackageProcessPaths.Count -gt 0)
        DiscoveredAtUtc = [DateTime]::UtcNow.ToString('O')
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
    $fsutilPath = Join-Path $env:SystemRoot 'System32\fsutil.exe'
    if (-not (Test-Path -LiteralPath $fsutilPath -PathType Leaf)) {
        throw "Data directory owner marker '$markerPath' hard-link count cannot be verified."
    }
    $hardLinks = @(
        & $fsutilPath hardlink list $markerPath 2>$null |
            Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
    )
    if ($LASTEXITCODE -ne 0) {
        throw "Data directory owner marker '$markerPath' hard-link count cannot be verified."
    }
    if ($hardLinks.Count -ne 1) {
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
        $itemAcl = Get-Acl -LiteralPath $item.FullName
        if (-not (Test-CodexLocalRemoteDataAcl `
            -Acl $itemAcl `
            -AllowedSidValues $AclContext.AllowedSidValues `
            -Inherited)) {
            return $false
        }
    }
    return $true
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

function Protect-CodexLocalRemoteDataDirectory {
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
    param(
        [Parameter(Mandatory)]
        [string]$DataDir
    )

    $plan = Get-CodexLocalRemoteDataDirectoryOwnershipPlan -DataDir $DataDir
    $resolvedDataDir = $plan.DataDir
    $aclContext = Get-CodexLocalRemoteDataAclContext
    if ($plan.Action -ceq 'owned') {
        try {
            if (Test-CodexLocalRemoteDataAclTree `
                -DataDir $resolvedDataDir `
                -AclContext $aclContext) {
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

function Write-AtomicJsonFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter(Mandatory)]
        [object]$Value
    )

    $parent = [System.IO.Path]::GetFullPath((Split-Path -Parent $Path))
    $null = Protect-CodexLocalRemoteDataDirectory -DataDir $parent
    $temporary = Join-Path $parent ".$([System.IO.Path]::GetFileName($Path)).$([guid]::NewGuid().ToString('N')).tmp"
    try {
        $Value |
            ConvertTo-Json -Depth 20 |
            Set-Content -LiteralPath $temporary -Encoding utf8NoBOM
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
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
        PrincipalRunLevel = 'Limited'
        TriggerClass = 'MSFT_TaskLogonTrigger'
        TriggerUserSid = $identity.User.Value
        TriggerEnabled = $true
        Settings = [pscustomobject]@{
            DisallowStartIfOnBatteries = $false
            StopIfGoingOnBatteries = $false
            ExecutionTimeLimit = 'P3650D'
            MultipleInstances = 'IgnoreNew'
            RestartCount = 3
            RestartInterval = 'PT1M'
            StartWhenAvailable = $true
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

    return Add-StartupTaskFingerprint -Definition ([pscustomobject]@{
        TaskName = $TaskName
        TaskPath = '\'
        Description = 'codex-local-remote/startup-task/v1 - Starts the local-only Codex Local Remote sidecar at user sign-in.'
        Execute = $resolvedNode
        Arguments = $arguments
        WorkingDirectory = $resolvedRoot
        Cli = $cli
        DataDir = $resolvedDataDir
    })
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
    $cli = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot 'apps\sidecar\dist\cli.js'))
    $brokerCli = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot 'apps\broker\dist\cli.js'))
    $bootstrap = [System.IO.Path]::GetFullPath((Join-Path $resolvedRoot 'scripts\windows\Start-CodexLocalRemote.ps1'))
    $arguments = @(
        '-NoLogo'
        '-NoProfile'
        '-NonInteractive'
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
    ) -join ' '

    Add-StartupTaskFingerprint -Definition ([pscustomobject]@{
        TaskName = $TaskName
        TaskPath = '\'
        Description = $script:StartupTaskDescription
        Execute = $resolvedPwsh
        Arguments = $arguments
        WorkingDirectory = $resolvedRoot
        Bootstrap = $bootstrap
        Cli = $cli
        BrokerCli = $brokerCli
        Node = $resolvedNode
        DataDir = $resolvedDataDir
    })
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

    return Add-StartupTaskFingerprint -Definition ([pscustomobject]@{
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
        foreach ($actionSpec in @(
            @{ Name = 'Execute'; Expected = [string]$Expected.Execute; Mismatch = 'action executable' },
            @{ Name = 'Arguments'; Expected = [string]$Expected.Arguments; Mismatch = 'action arguments' },
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
    $triggers = @(
        if ($triggersProperty.Exists) {
            $triggersProperty.Value
        }
    )
    if ($triggers.Count -ne 1) {
        $mismatches.Add('logon trigger count')
    } else {
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
    'Assert-CodexLocalRemoteDataDirectoryPath',
    'Get-CodexLocalRemoteDataDirectoryOwnershipPlan',
    'Protect-CodexLocalRemoteDataDirectory',
    'Test-BrokerCapabilityToken',
    'Read-BrokerCapabilityToken',
    'Install-BrokerCapabilityToken',
    'Remove-BrokerCapabilityToken',
    'Get-BrokerCapabilityWebSocketUrl',
    'Get-StringSha256',
    'Test-NonNegativeInteger',
    'Test-ActiveCodexRuntimeMatchesCurrentDiscovery',
    'Get-BrokerReadinessDecision',
    'Assert-LoopbackWebSocketUrl',
    'Test-IsLoopbackListenerAddress',
    'Get-ManagedIpv4Listeners',
    'Get-ProcessCreationIdentity',
    'Open-ProcessIdentityHandle',
    'Stop-ProcessIdentityHandle',
    'Test-ManagedAppServerProcess',
    'Test-ManagedBrokerProcess',
    'Test-ManagedSidecarProcess',
    'Test-ManagedBootstrapProcess',
    'Test-IndependentDesktopAppServer',
    'Assert-ForceCliDisabled',
    'Write-AtomicJsonFile',
    'Get-UserEnvironmentValueState',
    'New-BrokerEnvironmentBackupState',
    'Set-UserEnvironmentValue',
    'Install-BrokerUserEnvironment',
    'Assert-BrokerUserEnvironmentRestorable',
    'Restore-BrokerUserEnvironment',
    'Get-LegacyStartupTaskDefinition',
    'Get-StartupTaskDefinition',
    'Get-PinnedStartupTaskDefinitionV2',
    'Test-ManagedStartupTask',
    'ConvertTo-CanonicalJson',
    'Get-FunnelHandlerEntries',
    'Get-FunnelWebKey',
    'Test-FunnelHandlerEntriesEqual'
)
