[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ModulePath,

    [Parameter(Mandatory)]
    [string]$SandboxRoot,

    [Parameter(Mandatory)]
    [ValidateSet(
        'exact',
        'broker-difference',
        'package-difference',
        'broker-missing',
        'broker-extra',
        'compatibility-mismatch',
        'manifest-identity-mismatch',
        'missing-runtime'
    )]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
Import-Module $ModulePath -Force

function New-RuntimeFixture {
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [string]$CompatibilityId,

        [Parameter(Mandatory)]
        [string]$PackageContent,

        [Parameter(Mandatory)]
        [hashtable]$BrokerFiles
    )

    $stagingRoot = Join-Path $SandboxRoot "$Name-staging"
    $null = New-Item -ItemType Directory -Path $stagingRoot -Force
    $files = [ordered]@{
        'package.json' = $PackageContent
        'apps/sidecar/dist/cli.js' = "sidecar::$Name"
        'apps/web/dist/index.js' = "web::$Name"
        'scripts/windows/start.ps1' = "windows::$Name"
    }
    foreach ($brokerPath in @($BrokerFiles.Keys | Sort-Object)) {
        $files["apps/broker/dist/$brokerPath"] =
            [string]$BrokerFiles[$brokerPath]
    }

    $entries = foreach ($relativePath in @($files.Keys | Sort-Object)) {
        $path = Join-Path $stagingRoot $relativePath.Replace('/', '\')
        $null = New-Item `
            -ItemType Directory `
            -Path (Split-Path -Parent $path) `
            -Force
        [System.IO.File]::WriteAllText(
            $path,
            [string]$files[$relativePath],
            [System.Text.UTF8Encoding]::new($false)
        )
        $item = Get-Item -LiteralPath $path -Force
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
        BrokerSidecarCompatibilityId = $CompatibilityId
        Files = @($entries | Sort-Object Path)
    }
    $versionId = Get-StringSha256 `
        -Value (ConvertTo-CanonicalJson $identity)
    $runtimeRoot = Join-Path $SandboxRoot $versionId
    [System.IO.Directory]::Move($stagingRoot, $runtimeRoot)
    $manifest = [ordered]@{
        Signature = 'codex-local-remote/runtime-manifest/v1'
        Version = 1
        VersionId = $versionId
        BrokerSidecarCompatibilityId = $CompatibilityId
        SourceCommit = $null
        SourceDirty = $false
        FileCount = @($entries).Count
        Files = @($entries)
    }
    [System.IO.File]::WriteAllText(
        (Join-Path $runtimeRoot 'runtime-manifest.json'),
        ($manifest | ConvertTo-Json -Depth 10),
        [System.Text.UTF8Encoding]::new($false)
    )
    $validation = Test-CodexLocalRemoteRuntimeVersion `
        -RuntimeRoot $runtimeRoot `
        -ExpectedVersionId $versionId
    if (-not $validation.IsValid) {
        throw "fixture runtime '$Name' is invalid: $($validation.Reason)"
    }
    return $validation
}

$commonPackage = '{"name":"runtime-fixture","private":true,"type":"module"}'
$commonBroker = @{
    'cli.js' = 'console.log("broker");'
    'worker.js' = 'export const worker = true;'
}
$activeBroker = @{} + $commonBroker
$currentBroker = @{} + $commonBroker
$activePackage = $commonPackage
$currentPackage = $commonPackage
$activeCompatibility = 'codex-local-remote/broker-sidecar/v1'
$currentCompatibility = $activeCompatibility

switch ($Mode) {
    'broker-difference' {
        $currentBroker['worker.js'] = 'export const worker = false;'
    }
    'package-difference' {
        $currentPackage = '{"name":"runtime-fixture","private":false,"type":"module"}'
    }
    'broker-missing' {
        $currentBroker.Remove('worker.js')
    }
    'broker-extra' {
        $currentBroker['extra.js'] = 'export const extra = true;'
    }
    'compatibility-mismatch' {
        $currentCompatibility = 'codex-local-remote/broker-sidecar/v2'
    }
}

$active = New-RuntimeFixture `
    -Name 'active' `
    -CompatibilityId $activeCompatibility `
    -PackageContent $activePackage `
    -BrokerFiles $activeBroker
$current = New-RuntimeFixture `
    -Name 'current' `
    -CompatibilityId $currentCompatibility `
    -PackageContent $currentPackage `
    -BrokerFiles $currentBroker

$currentManifestSha256 = [string]$current.ManifestSha256
$currentRoot = [string]$current.RuntimeRoot
if ($Mode -ceq 'manifest-identity-mismatch') {
    $currentManifestSha256 = 'f' * 64
} elseif ($Mode -ceq 'missing-runtime') {
    $currentRoot = Join-Path $SandboxRoot 'missing-runtime'
}

Test-CodexLocalRemoteBrokerPayloadCompatibility `
    -CurrentRuntimeRoot $currentRoot `
    -CurrentVersionId ([string]$current.VersionId) `
    -CurrentManifestSha256 $currentManifestSha256 `
    -ActiveRuntimeRoot ([string]$active.RuntimeRoot) `
    -ActiveVersionId ([string]$active.VersionId) `
    -ActiveManifestSha256 ([string]$active.ManifestSha256) |
    ConvertTo-Json -Depth 20 -Compress
