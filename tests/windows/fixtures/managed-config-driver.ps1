[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ModulePath,

    [Parameter(Mandatory)]
    [string]$DataDir,

    [ValidateSet(
        'round-trip',
        'duplicate-port',
        'compare-and-swap',
        'write-verification-rollback'
    )]
    [string]$Mode = 'round-trip'
)

$ErrorActionPreference = 'Stop'
Import-Module $ModulePath -Force

function Get-TestFileSha256 {
    param([Parameter(Mandatory)][string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).
        Hash.ToLowerInvariant()
}

if ($Mode -ceq 'compare-and-swap') {
    $configurationPath = Join-Path $DataDir 'managed-config.json'
    $desiredModePath = Join-Path $DataDir 'remote-mode.json'
    $runtimeA = Join-Path $DataDir 'runtime-a'
    $runtimeB = Join-Path $DataDir 'runtime-b'
    $runtimeC = Join-Path $DataDir 'runtime-c'
    $configCommand = Get-Command Set-CodexLocalRemoteManagedConfiguration
    $desiredCommand = Get-Command Set-CodexLocalRemoteDesiredMode
    $configContractAvailable = (
        $configCommand.Parameters.ContainsKey('ExpectedCurrentSha256') -and
        $configCommand.Parameters.ContainsKey('PassThruMutationReceipt')
    )
    $desiredContractAvailable = (
        $desiredCommand.Parameters.ContainsKey('ExpectedCurrentSha256') -and
        $desiredCommand.Parameters.ContainsKey('PassThruMutationReceipt')
    )

    $null = Set-CodexLocalRemoteManagedConfiguration `
        -DataDir $DataDir `
        -SidecarPort 18790 `
        -BrokerPort 18791 `
        -BrokerUpstreamPort 18795 `
        -BasePath '/baseline' `
        -TaskName 'Baseline Task'
    $configBaselineSha256 = Get-TestFileSha256 -Path $configurationPath
    $null = Set-CodexLocalRemoteManagedConfiguration `
        -DataDir $DataDir `
        -SidecarPort 18890 `
        -BrokerPort 18891 `
        -BrokerUpstreamPort 18895 `
        -BasePath '/concurrent' `
        -TaskName 'Concurrent Task'
    $configConcurrentSha256 = Get-TestFileSha256 -Path $configurationPath
    $configStaleRejected = $false
    if ($configContractAvailable) {
        try {
            $null = Set-CodexLocalRemoteManagedConfiguration `
                -DataDir $DataDir `
                -SidecarPort 18990 `
                -BrokerPort 18991 `
                -BrokerUpstreamPort 18995 `
                -BasePath '/candidate' `
                -TaskName 'Candidate Task' `
                -ExpectedCurrentSha256 $configBaselineSha256 `
                -PassThruMutationReceipt
        } catch {
            $configStaleRejected = $true
        }
    }
    $configAfterStale =
        Get-CodexLocalRemoteManagedConfiguration -DataDir $DataDir
    $configReceipt = $null
    if ($configContractAvailable) {
        $configReceipt = Set-CodexLocalRemoteManagedConfiguration `
            -DataDir $DataDir `
            -SidecarPort 18990 `
            -BrokerPort 18991 `
            -BrokerUpstreamPort 18995 `
            -BasePath '/candidate' `
            -TaskName 'Candidate Task' `
            -ExpectedCurrentSha256 $configConcurrentSha256 `
            -PassThruMutationReceipt
    }
    $configWrittenSha256 = if ($null -ne $configReceipt.MutationReceipt) {
        [string]$configReceipt.MutationReceipt.WrittenSha256
    } else {
        [string]$configReceipt.WrittenSha256
    }

    $null = Set-CodexLocalRemoteDesiredMode `
        -DataDir $DataDir `
        -Mode Native `
        -RuntimeVersionId ('a' * 64) `
        -RuntimeRoot $runtimeA
    $desiredBaselineSha256 = Get-TestFileSha256 -Path $desiredModePath
    $null = Set-CodexLocalRemoteDesiredMode `
        -DataDir $DataDir `
        -Mode Remote `
        -RuntimeVersionId ('b' * 64) `
        -RuntimeRoot $runtimeB
    $desiredConcurrentSha256 = Get-TestFileSha256 -Path $desiredModePath
    $desiredStaleRejected = $false
    if ($desiredContractAvailable) {
        try {
            $null = Set-CodexLocalRemoteDesiredMode `
                -DataDir $DataDir `
                -Mode Native `
                -RuntimeVersionId ('c' * 64) `
                -RuntimeRoot $runtimeC `
                -ExpectedCurrentSha256 $desiredBaselineSha256 `
                -PassThruMutationReceipt
        } catch {
            $desiredStaleRejected = $true
        }
    }
    $desiredAfterStale = Get-CodexLocalRemoteDesiredMode -DataDir $DataDir
    $desiredReceipt = $null
    if ($desiredContractAvailable) {
        $desiredReceipt = Set-CodexLocalRemoteDesiredMode `
            -DataDir $DataDir `
            -Mode Native `
            -RuntimeVersionId ('c' * 64) `
            -RuntimeRoot $runtimeC `
            -ExpectedCurrentSha256 $desiredConcurrentSha256 `
            -PassThruMutationReceipt
    }
    $desiredWrittenSha256 = if ($null -ne $desiredReceipt.MutationReceipt) {
        [string]$desiredReceipt.MutationReceipt.WrittenSha256
    } else {
        [string]$desiredReceipt.WrittenSha256
    }

    [pscustomobject]@{
        ConfigContractAvailable = $configContractAvailable
        ConfigStaleRejected = $configStaleRejected
        ConfigConcurrentPreserved = (
            [string]$configAfterStale.BasePath -ceq '/concurrent' -and
            [string]$configAfterStale.TaskName -ceq 'Concurrent Task'
        )
        ConfigReceiptMatches = (
            $null -ne $configReceipt -and
            $configWrittenSha256 -cmatch '^[a-f0-9]{64}$' -and
            (Get-TestFileSha256 -Path $configurationPath) -ceq
                $configWrittenSha256
        )
        DesiredContractAvailable = $desiredContractAvailable
        DesiredStaleRejected = $desiredStaleRejected
        DesiredConcurrentPreserved = (
            [string]$desiredAfterStale.Mode -ceq 'Remote' -and
            [string]$desiredAfterStale.RuntimeVersionId -ceq ('b' * 64)
        )
        DesiredReceiptMatches = (
            $null -ne $desiredReceipt -and
            $desiredWrittenSha256 -cmatch '^[a-f0-9]{64}$' -and
            (Get-TestFileSha256 -Path $desiredModePath) -ceq
                $desiredWrittenSha256
        )
    } | ConvertTo-Json -Compress
    exit 0
}

if ($Mode -ceq 'write-verification-rollback') {
    $atomicPath = Join-Path $DataDir 'atomic-fixture.json'
    $atomicCommand = Get-Command Write-AtomicJsonFile
    $contractAvailable = (
        $atomicCommand.Parameters.ContainsKey('ExpectedCurrentSha256') -and
        $atomicCommand.Parameters.ContainsKey('VerifyWrittenValue') -and
        $atomicCommand.Parameters.ContainsKey('PassThru')
    )
    Write-AtomicJsonFile `
        -Path $atomicPath `
        -Value ([ordered]@{ State = 'baseline'; Generation = 1 })
    $baselineBytes = [System.IO.File]::ReadAllBytes($atomicPath)
    $baselineSha256 = Get-TestFileSha256 -Path $atomicPath
    $global:AtomicVerificationCalled = $false
    $global:AtomicReplacementObserved = $false
    $global:AtomicFixturePath = $atomicPath
    $failure = $null
    if ($contractAvailable) {
        try {
            $null = Write-AtomicJsonFile `
                -Path $atomicPath `
                -Value ([ordered]@{
                    State = 'candidate'
                    Generation = 2
                }) `
                -ExpectedCurrentSha256 $baselineSha256 `
                -VerifyWrittenValue {
                    $global:AtomicVerificationCalled = $true
                    $observed = Get-Content `
                        -LiteralPath $global:AtomicFixturePath `
                        -Raw `
                        -Encoding utf8 | ConvertFrom-Json
                    $global:AtomicReplacementObserved =
                        [string]$observed.State -ceq 'candidate'
                    throw 'fixture read-back failed after atomic replacement'
                } `
                -PassThru
        } catch {
            $failure = $_.Exception.Message
        }
    }
    $finalBytes = [System.IO.File]::ReadAllBytes($atomicPath)
    [pscustomobject]@{
        ContractAvailable = $contractAvailable
        VerificationCalled = $global:AtomicVerificationCalled
        ReplacementObserved = $global:AtomicReplacementObserved
        Failure = $failure
        ExactPreImageRestored = (
            [Convert]::ToBase64String($finalBytes) -ceq
                [Convert]::ToBase64String($baselineBytes) -and
            (Get-TestFileSha256 -Path $atomicPath) -ceq $baselineSha256
        )
    } | ConvertTo-Json -Compress
    exit 0
}

if ($Mode -ceq 'duplicate-port') {
    try {
        $null = Set-CodexLocalRemoteManagedConfiguration `
            -DataDir $DataDir `
            -SidecarPort 18790 `
            -BrokerPort 18791 `
            -BrokerUpstreamPort 18791 `
            -BasePath '/codex-remote' `
            -TaskName 'Codex Local Remote'
        throw 'duplicate ports were accepted'
    } catch {
        [pscustomobject]@{
            Rejected = $_.Exception.Message -match 'distinct'
        } | ConvertTo-Json -Compress
        exit 0
    }
}

$written = Set-CodexLocalRemoteManagedConfiguration `
    -DataDir $DataDir `
    -SidecarPort 18790 `
    -BrokerPort 18791 `
    -BrokerUpstreamPort 18795 `
    -BasePath '/codex-remote' `
    -TaskName 'Codex Local Remote'
$reopened = Get-CodexLocalRemoteManagedConfiguration -DataDir $DataDir

[pscustomobject]@{
    Written = $written
    Reopened = $reopened
} | ConvertTo-Json -Compress -Depth 10
