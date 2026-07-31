[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ModulePath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot
)

$ErrorActionPreference = 'Stop'
Import-Module $ModulePath -Force

function New-RuntimeFixture {
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [switch]$WithCompatibility
    )

    $staging = Join-Path $SandboxRoot "$Name-staging"
    $null = New-Item -ItemType Directory -Path $staging -Force
    $relativePaths = @(
        'package.json',
        'apps/broker/dist/cli.js',
        'apps/sidecar/dist/cli.js',
        'apps/web/dist/index.js',
        'scripts/windows/start.ps1'
    )
    $entries = foreach ($relativePath in $relativePaths) {
        $path = Join-Path $staging $relativePath.Replace('/', '\')
        $null = New-Item `
            -ItemType Directory `
            -Path (Split-Path -Parent $path) `
            -Force
        [System.IO.File]::WriteAllText(
            $path,
            "$Name::$relativePath",
            [System.Text.UTF8Encoding]::new($false)
        )
        $item = Get-Item -LiteralPath $path
        [pscustomobject]@{
            Path = $relativePath
            Sha256 = (
                Get-FileHash -LiteralPath $path -Algorithm SHA256
            ).Hash.ToLowerInvariant()
            Size = [long]$item.Length
        }
    }
    $identity = [ordered]@{
        Signature = 'codex-local-remote/runtime-content/v1'
    }
    if ($WithCompatibility) {
        $identity.BrokerSidecarCompatibilityId =
            'codex-local-remote/broker-sidecar/v1'
    }
    $identity.Files = @($entries | Sort-Object Path)
    $versionId =
        Get-StringSha256 `
            -Value (ConvertTo-CanonicalJson $identity)
    $runtimeRoot = Join-Path $SandboxRoot $versionId
    [System.IO.Directory]::Move($staging, $runtimeRoot)
    $manifest = [ordered]@{
        Signature = 'codex-local-remote/runtime-manifest/v1'
        Version = 1
        VersionId = $versionId
    }
    if ($WithCompatibility) {
        $manifest.BrokerSidecarCompatibilityId =
            'codex-local-remote/broker-sidecar/v1'
    }
    $manifest.SourceCommit = $null
    $manifest.SourceDirty = $false
    $manifest.FileCount = @($entries).Count
    $manifest.Files = @($entries)
    [System.IO.File]::WriteAllText(
        (Join-Path $runtimeRoot 'runtime-manifest.json'),
        ($manifest | ConvertTo-Json -Depth 10),
        [System.Text.UTF8Encoding]::new($false)
    )
    return Test-CodexLocalRemoteRuntimeVersion `
        -RuntimeRoot $runtimeRoot `
        -ExpectedVersionId $versionId
}

$legacy = New-RuntimeFixture -Name 'legacy'
$current = New-RuntimeFixture -Name 'current' -WithCompatibility

[pscustomobject]@{
    LegacyValid = [bool]$legacy.IsValid
    LegacyCompatibility =
        [string]$legacy.BrokerSidecarCompatibilityId
    CurrentValid = [bool]$current.IsValid
    CurrentCompatibility =
        [string]$current.BrokerSidecarCompatibilityId
} | ConvertTo-Json -Compress
