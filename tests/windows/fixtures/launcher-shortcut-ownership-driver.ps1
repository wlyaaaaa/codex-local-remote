[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$RegistrationPath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot,

    [Parameter(Mandatory)]
    [ValidateSet('candidate', 'previous')]
    [string]$RootKind,

    [Parameter(Mandatory)]
    [ValidateSet(
        'exact',
        'minimized',
        'non-elevated',
        'visible',
        'pre-takeover',
        'visible-pre-takeover',
        'localized-description',
        'codepage-description',
        'codepage-non-elevated',
        'codepage-minimized',
        'codepage-foreign-drift',
        'foreign-drift'
    )]
    [string]$Shape,

    [switch]$IconDrift,

    [ValidateSet('file', 'directory', 'dangling-reparse', 'missing')]
    [string]$PathKind = 'file',

    [ValidateSet('preflight', 'install', 'rollback')]
    [string]$Operation = 'preflight',

    [ValidateSet(
        'none',
        'foreign-before-preimage',
        'target-created-after-preimage',
        'foreign-before-rollback',
        'foreign-during-complete'
    )]
    [string]$RaceMode = 'none'
)

$ErrorActionPreference = 'Stop'
$shortcutPath = Join-Path $SandboxRoot 'Codex Remote safe launch.lnk'
$candidateRoot = Join-Path $SandboxRoot 'RuntimeVersions\candidate'
$previousRoot = Join-Path $SandboxRoot 'RuntimeVersions\previous'
$dataDir = Join-Path $SandboxRoot 'data'
$null = New-Item -ItemType Directory -Path $candidateRoot -Force
$null = New-Item -ItemType Directory -Path $previousRoot -Force
$null = New-Item -ItemType Directory -Path $dataDir -Force
$targetPath =
    (Get-Command pwsh.exe -CommandType Application -ErrorAction Stop |
        Select-Object -First 1).Source

function New-TestDefinition {
    param([Parameter(Mandatory)][string]$RuntimeRoot)

    $launcherPath =
        Join-Path $RuntimeRoot 'scripts\windows\Launch-CodexWithRemote.ps1'
    return [pscustomobject]@{
        ShortcutPath = $shortcutPath
        TargetPath = $targetPath
        Arguments = (
            '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden ' +
            '-ExecutionPolicy Bypass ' +
            "-File `"$launcherPath`" " +
            "-DataDir `"$dataDir`" -BrokerPort 18791 " +
            '-TaskName "Codex Local Remote" ' +
            '-RequestDesktopLaunch'
        )
        WorkingDirectory = $RuntimeRoot
        Description = 'Codex Remote - exact managed fixture'
        IconLocation = "$(Join-Path $dataDir 'managed.ico'),0"
        WindowStyle = 1
        RunAsUser = $true
    }
}

function Set-TestShortcut {
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter(Mandatory)]
        [object]$Definition,

        [Parameter(Mandatory)]
        [string]$Arguments,

        [Parameter(Mandatory)]
        [string]$IconLocation,

        [string]$Description = ([string]$Definition.Description),

        [int]$WindowStyle = ([int]$Definition.WindowStyle),

        [bool]$RunAsUser = ([bool]$Definition.RunAsUser)
    )

    $shell = $null
    $shortcut = $null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($Path)
        $shortcut.TargetPath = [string]$Definition.TargetPath
        $shortcut.Arguments = $Arguments
        $shortcut.WorkingDirectory =
            [string]$Definition.WorkingDirectory
        $shortcut.Description = $Description
        $shortcut.IconLocation = $IconLocation
        $shortcut.WindowStyle = $WindowStyle
        $shortcut.Save()
    } finally {
        if ($null -ne $shortcut) {
            $null =
                [Runtime.InteropServices.Marshal]::FinalReleaseComObject(
                    $shortcut
                )
        }
        if ($null -ne $shell) {
            $null =
                [Runtime.InteropServices.Marshal]::FinalReleaseComObject(
                    $shell
                )
        }
    }
    if ($RunAsUser) {
        $bytes = [System.IO.File]::ReadAllBytes($Path)
        $flags = [uint32](
            [BitConverter]::ToUInt32($bytes, 20) -bor 0x00002000
        )
        [BitConverter]::GetBytes($flags).CopyTo($bytes, 20)
        [System.IO.File]::WriteAllBytes($Path, $bytes)
    }
}

$candidateDefinition = New-TestDefinition -RuntimeRoot $candidateRoot
$previousDefinition = New-TestDefinition -RuntimeRoot $previousRoot
$sourceDefinition = if ($RootKind -ceq 'candidate') {
    $candidateDefinition
} else {
    $previousDefinition
}
$actualArguments = [string]$sourceDefinition.Arguments
$actualWindowStyle = if ($Shape -cin @(
        'minimized',
        'codepage-minimized'
    )) {
    7
} else {
    [int]$sourceDefinition.WindowStyle
}
$actualRunAsUser = $Shape -cnotin @(
    'non-elevated',
    'codepage-non-elevated'
)
$actualDescription = if ($Shape -cin @(
        'localized-description',
        'codepage-description',
        'codepage-non-elevated',
        'codepage-minimized',
        'codepage-foreign-drift'
    )) {
    $historicalPrefix = 'Codex Remote (' +
        $(if ($Shape -clike 'codepage-*') {
            '????'
        } else {
            (([char[]]@(0x5B89, 0x5168, 0x542F, 0x52A8)) -join '')
        }) +
        ')'
    $historicalPrefix +
        ([string]$sourceDefinition.Description).Substring(
            'Codex Remote'.Length
        )
} else {
    [string]$sourceDefinition.Description
}
if ($Shape -cin @('visible', 'visible-pre-takeover')) {
    $actualArguments = $actualArguments.Replace(
        ' -WindowStyle Hidden ',
        ' '
    )
}
if ($Shape -cin @(
    'pre-takeover',
    'visible-pre-takeover',
    'foreign-drift'
)) {
    $actualArguments = $actualArguments.Replace(
        ' -RequestDesktopLaunch',
        ' -TakeOverExistingNativeDesktop'
    )
}
if ($Shape -cin @('foreign-drift', 'codepage-foreign-drift')) {
    $actualArguments = $actualArguments.Replace(
        '-BrokerPort 18791',
        '-BrokerPort 19999'
    )
}
$actualIcon = if ($IconDrift) {
    "$(Join-Path $dataDir 'historical.ico'),0"
} else {
    [string]$sourceDefinition.IconLocation
}

if ($PathKind -ceq 'directory') {
    $null = New-Item -ItemType Directory -Path $shortcutPath -Force
} elseif ($PathKind -ceq 'dangling-reparse') {
    $null = New-Item `
        -ItemType SymbolicLink `
        -Path $shortcutPath `
        -Target (Join-Path $SandboxRoot 'missing-target.lnk')
} elseif ($PathKind -cne 'missing') {
    Set-TestShortcut `
        -Path $shortcutPath `
        -Definition $sourceDefinition `
        -Arguments $actualArguments `
        -IconLocation $actualIcon `
        -Description $actualDescription `
        -WindowStyle $actualWindowStyle `
        -RunAsUser $actualRunAsUser
}

$functionNames = @(
    'Get-ManagedLauncherShortcutLinkFlags',
    'Set-ManagedLauncherShortcutRunAsUser',
    'Test-ManagedLauncherShortcut',
    'Get-LegacyLocalizedManagedLauncherShortcutDefinition',
    'Get-LegacyCodePageManagedLauncherShortcutDefinition',
    'Test-LegacyNonElevatedManagedLauncherShortcut',
    'Test-LegacyMinimizedManagedLauncherShortcut',
    'Test-LegacyVisibleManagedLauncherShortcut',
    'Test-LegacyPreTakeoverManagedLauncherShortcut',
    'Test-LegacyVisiblePreTakeoverManagedLauncherShortcut',
    'Get-ManagedLauncherShortcutPathState',
    'Assert-ManagedLauncherShortcutOwnership',
    'Install-ManagedLauncherShortcut',
    'Get-ManagedLauncherShortcutSha256',
    'Test-ManagedLauncherShortcutReceiptFile',
    'Remove-ManagedLauncherShortcutReceiptFile',
    'Complete-ManagedLauncherShortcutTransaction',
    'Undo-ManagedLauncherShortcutTransaction'
)
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
foreach ($functionName in $functionNames) {
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

function Get-TestItemHash {
    param([AllowNull()][object]$Item)

    if ($null -eq $Item -or
        $Item.PSIsContainer -or
        ($Item.Attributes -band
            [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        return $null
    }
    return (Get-FileHash `
        -LiteralPath ([string]$Item.FullName) `
        -Algorithm SHA256).Hash
}

function Get-TestShortcutArguments {
    param([Parameter(Mandatory)][string]$Path)

    $item = Get-Item `
        -LiteralPath $Path `
        -Force `
        -ErrorAction SilentlyContinue
    if ($null -eq $item -or
        $item.PSIsContainer -or
        ($item.Attributes -band
            [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        return $null
    }
    $shell = $null
    $shortcut = $null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($Path)
        return [string]$shortcut.Arguments
    } finally {
        if ($null -ne $shortcut) {
            $null =
                [Runtime.InteropServices.Marshal]::FinalReleaseComObject(
                    $shortcut
                )
        }
        if ($null -ne $shell) {
            $null =
                [Runtime.InteropServices.Marshal]::FinalReleaseComObject(
                    $shell
                )
        }
    }
}

function Get-TestShortcutWindowStyle {
    param([Parameter(Mandatory)][string]$Path)

    $item = Get-Item `
        -LiteralPath $Path `
        -Force `
        -ErrorAction SilentlyContinue
    if ($null -eq $item -or
        $item.PSIsContainer -or
        ($item.Attributes -band
            [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        return $null
    }
    $shell = $null
    $shortcut = $null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($Path)
        return [int]$shortcut.WindowStyle
    } finally {
        if ($null -ne $shortcut) {
            $null =
                [Runtime.InteropServices.Marshal]::FinalReleaseComObject(
                    $shortcut
                )
        }
        if ($null -ne $shell) {
            $null =
                [Runtime.InteropServices.Marshal]::FinalReleaseComObject(
                    $shell
                )
        }
    }
}

function Get-TestShortcutRunAsUser {
    param([Parameter(Mandatory)][string]$Path)

    $item = Get-Item `
        -LiteralPath $Path `
        -Force `
        -ErrorAction SilentlyContinue
    if ($null -eq $item -or
        $item.PSIsContainer -or
        ($item.Attributes -band
            [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        return $null
    }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    return (
        ([BitConverter]::ToUInt32($bytes, 20) -band 0x00002000) -ne 0
    )
}

$racerPreservedPath = Join-Path $SandboxRoot 'racer-preserved.lnk'
$foreignArguments = ([string]$candidateDefinition.Arguments).Replace(
    '-BrokerPort 18791',
    '-BrokerPort 19999'
)
$script:moveCalls = 0
function Move-ManagedLauncherShortcutNoOverwrite {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )

    $script:moveCalls++
    if ($RaceMode -ceq 'foreign-before-preimage' -and
        $script:moveCalls -eq 1) {
        [System.IO.File]::Move($shortcutPath, $racerPreservedPath)
        Set-TestShortcut `
            -Path $shortcutPath `
            -Definition $candidateDefinition `
            -Arguments $foreignArguments `
            -IconLocation ([string]$candidateDefinition.IconLocation)
    } elseif ($RaceMode -ceq 'target-created-after-preimage' -and
        $script:moveCalls -eq 2) {
        Set-TestShortcut `
            -Path $shortcutPath `
            -Definition $candidateDefinition `
            -Arguments $foreignArguments `
            -IconLocation ([string]$candidateDefinition.IconLocation)
    }
    [System.IO.File]::Move(
        [System.IO.Path]::GetFullPath($Source),
        [System.IO.Path]::GetFullPath($Destination)
    )
}

$script:receiptTestImplementation =
    (Get-Command Test-ManagedLauncherShortcutReceiptFile).ScriptBlock
$script:completeRaceArmed = $false
function Test-ManagedLauncherShortcutReceiptFile {
    param(
        [Parameter(Mandatory)][object]$Definition,
        [AllowNull()][object]$PreviousDefinition,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$ExpectedSha256,
        [switch]$AllowManagedVariants
    )

    if ($script:completeRaceArmed -and
        $RaceMode -ceq 'foreign-during-complete' -and
        $AllowManagedVariants -and
        [System.IO.Path]::GetFileName($Path) -like '.*.preimage.lnk') {
        $script:completeRaceArmed = $false
        [System.IO.File]::Move($shortcutPath, $racerPreservedPath)
        Set-TestShortcut `
            -Path $shortcutPath `
            -Definition $candidateDefinition `
            -Arguments $foreignArguments `
            -IconLocation ([string]$candidateDefinition.IconLocation)
    }
    return & $script:receiptTestImplementation @PSBoundParameters
}

$authoritySawReparse = $false
try {
    $authorityAttributes =
        [System.IO.File]::GetAttributes($shortcutPath)
    $authoritySawReparse = (
        ($authorityAttributes -band
            [System.IO.FileAttributes]::ReparsePoint) -ne 0
    )
} catch [System.IO.FileNotFoundException] {
    $authoritySawReparse = $false
} catch [System.IO.DirectoryNotFoundException] {
    $authoritySawReparse = $false
}
$beforeItem = Get-Item `
    -LiteralPath $shortcutPath `
    -Force `
    -ErrorAction SilentlyContinue
$beforeHash = Get-TestItemHash -Item $beforeItem
$accepted = $true
$failure = $null
$installStatus = $null
$rollbackStatus = $null
try {
    if ($Operation -cin @('install', 'rollback')) {
        $installResult = Install-ManagedLauncherShortcut `
            -Definition $candidateDefinition `
            -PreviousDefinition $previousDefinition
        $installStatus = [string]$installResult.Status
        if ($Operation -ceq 'rollback') {
            if ($RaceMode -ceq 'foreign-before-rollback') {
                [System.IO.File]::Move(
                    $shortcutPath,
                    $racerPreservedPath
                )
                Set-TestShortcut `
                    -Path $shortcutPath `
                    -Definition $candidateDefinition `
                    -Arguments $foreignArguments `
                    -IconLocation (
                        [string]$candidateDefinition.IconLocation
                    )
            }
            $rollbackResult =
                Undo-ManagedLauncherShortcutTransaction `
                    -Receipt $installResult `
                    -Definition $candidateDefinition `
                    -PreviousDefinition $previousDefinition
            $rollbackStatus = [string]$rollbackResult.Status
        } else {
            $script:completeRaceArmed = (
                $RaceMode -ceq 'foreign-during-complete'
            )
            $null =
                Complete-ManagedLauncherShortcutTransaction `
                    -Receipt $installResult `
                    -Definition $candidateDefinition `
                    -PreviousDefinition $previousDefinition
        }
    } else {
        Assert-ManagedLauncherShortcutOwnership `
            -Definition $candidateDefinition `
            -PreviousDefinition $previousDefinition
    }
} catch {
    $accepted = $false
    $failure = $_.Exception.Message
}
$afterItem = Get-Item `
    -LiteralPath $shortcutPath `
    -Force `
    -ErrorAction SilentlyContinue
$afterHash = Get-TestItemHash -Item $afterItem
$preImageItems = @(
    Get-ChildItem -LiteralPath $SandboxRoot -Force |
        Where-Object { $_.Name -like '.*.preimage.lnk' }
)
$preImageManaged = $false
if ($preImageItems.Count -eq 1) {
    try {
        Assert-ManagedLauncherShortcutOwnership `
            -Definition $candidateDefinition `
            -PreviousDefinition $previousDefinition `
            -Path ([string]$preImageItems[0].FullName)
        $preImageManaged = $true
    } catch {
        $preImageManaged = $false
    }
}
$racerPreservedManaged = $false
if (Test-Path -LiteralPath $racerPreservedPath -PathType Leaf) {
    try {
        Assert-ManagedLauncherShortcutOwnership `
            -Definition $candidateDefinition `
            -PreviousDefinition $previousDefinition `
            -Path $racerPreservedPath
        $racerPreservedManaged = $true
    } catch {
        $racerPreservedManaged = $false
    }
}
$targetArguments = Get-TestShortcutArguments -Path $shortcutPath
$targetWindowStyle = Get-TestShortcutWindowStyle -Path $shortcutPath
$targetRunAsUser = Get-TestShortcutRunAsUser -Path $shortcutPath
$temporaryItems = @(
    Get-ChildItem -LiteralPath $SandboxRoot -Force |
        Where-Object {
            $_.Name -like '.*.lnk' -and
            $_.Name -notlike '.*.preimage.lnk'
        }
)

[pscustomobject]@{
    Operation = $Operation
    RaceMode = $RaceMode
    RootKind = $RootKind
    Shape = $Shape
    IconDrift = [bool]$IconDrift
    PathKind = $PathKind
    AuthoritySawReparse = $authoritySawReparse
    Accepted = $accepted
    Failure = $failure
    InstallStatus = $installStatus
    RollbackStatus = $rollbackStatus
    HashUnchanged = $beforeHash -ceq $afterHash
    LengthUnchanged = (
        $null -ne $afterItem -and
        [long]$beforeItem.Length -eq [long]$afterItem.Length
    )
    LastWriteTimeUnchanged =
        $null -ne $afterItem -and
        $beforeItem.LastWriteTimeUtc -eq $afterItem.LastWriteTimeUtc
    ItemKindUnchanged = (
        $null -ne $afterItem -and
        [bool]$beforeItem.PSIsContainer -eq
            [bool]$afterItem.PSIsContainer
    )
    TargetForeign = (
        $null -ne $targetArguments -and
        $targetArguments.Contains(
            '-BrokerPort 19999',
            [System.StringComparison]::Ordinal
        )
    )
    PreImageCount = $preImageItems.Count
    PreImageManaged = $preImageManaged
    RacerPreservedManaged = $racerPreservedManaged
    TemporaryCount = $temporaryItems.Count
    MoveCalls = $script:moveCalls
    TargetWindowStyle = $targetWindowStyle
    TargetRunAsUser = $targetRunAsUser
} | ConvertTo-Json -Depth 10 -Compress
