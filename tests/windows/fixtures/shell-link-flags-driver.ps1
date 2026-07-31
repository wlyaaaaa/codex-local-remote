[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$RegistrationPath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot
)

$ErrorActionPreference = 'Stop'
$null = New-Item -ItemType Directory -Path $SandboxRoot -Force
$fakePath = Join-Path $SandboxRoot 'fake-header.lnk'
$bytes = [byte[]]::new(76)
[BitConverter]::GetBytes([uint32]76).CopyTo($bytes, 0)
[BitConverter]::GetBytes([uint32]0).CopyTo($bytes, 20)
[System.IO.File]::WriteAllBytes($fakePath, $bytes)
$beforeHash = (
    Get-FileHash -LiteralPath $fakePath -Algorithm SHA256
).Hash

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
    'Get-ManagedLauncherShortcutLinkFlags',
    'Set-ManagedLauncherShortcutRunAsUser'
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

$getFailure = $null
try {
    $null = Get-ManagedLauncherShortcutLinkFlags -Path $fakePath
} catch {
    $getFailure = $_.Exception.Message
}
$setFailure = $null
try {
    Set-ManagedLauncherShortcutRunAsUser -Path $fakePath
} catch {
    $setFailure = $_.Exception.Message
}
$afterHash = (
    Get-FileHash -LiteralPath $fakePath -Algorithm SHA256
).Hash

[pscustomobject]@{
    GetFailure = $getFailure
    SetFailure = $setFailure
    HashUnchanged = $beforeHash -ceq $afterHash
    Flags = [BitConverter]::ToUInt32(
        [System.IO.File]::ReadAllBytes($fakePath),
        20
    )
} | ConvertTo-Json -Depth 10 -Compress
