[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ModulePath,

    [Parameter(Mandatory)]
    [ValidateSet(
        'startup-definition',
        'add-everyone-rule',
        'validate-url',
        'classify-process',
        'classify-bootstrap-contract',
        'classify-sidecar',
        'process-command-line',
        'classify-desktop',
        'assert-force-cli',
        'environment-backup',
        'ensure-token',
        'inspect-data-dir-acl',
        'protect-data-dir',
        'remove-token',
        'token-metadata',
        'validate-data-dir-path',
        'write-state',
        'classify-app-server',
        'validate-unknown-count',
        'sidecar-readiness-decision',
        'runtime-supervision-decision'
    )]
    [string]$Operation,

    [string]$InstallRoot,

    [string]$DataDir,

    [string]$NodePath,

    [string]$CodexPath,

    [string]$PwshPath,

    [string]$WebSocketUrl,

    [string]$CommandLine,

    [string]$ExecutablePath,

    [string]$MaintenanceTokenFilePath,

    [ValidateSet('true', 'false')]
    [string]$PreviousValueExists = 'false',

    [AllowNull()]
    [string]$PreviousValue,

    [string]$ParentProcessName,

    [string]$StartScriptPath,

    [ValidateSet(
        'missing-readiness',
        'missing-upstream',
        'identity-mismatch',
        'ready'
    )]
    [string]$Scenario = 'ready',

    [ValidateSet('Infrastructure', 'SidecarHandshake', 'RuntimeTransition', 'StrictRuntime')]
    [string]$Phase = 'Infrastructure'
)

$ErrorActionPreference = 'Stop'
Import-Module $ModulePath -Force

switch ($Operation) {
    'add-everyone-rule' {
        $acl = Get-Acl -LiteralPath $DataDir
        $acl.AddAccessRule(
            [System.Security.AccessControl.FileSystemAccessRule]::new(
                [System.Security.Principal.SecurityIdentifier]::new(
                    [System.Security.Principal.WellKnownSidType]::WorldSid,
                    $null
                ),
                [System.Security.AccessControl.FileSystemRights]::FullControl,
                [System.Security.AccessControl.AccessControlType]::Allow
            )
        )
        Set-Acl -LiteralPath $DataDir -AclObject $acl
        [pscustomobject]@{ Status = 'widened' } | ConvertTo-Json -Compress
    }
    'startup-definition' {
        Get-StartupTaskDefinition `
            -TaskName 'Codex Local Remote' `
            -NodePath $NodePath `
            -CodexPath $CodexPath `
            -PwshPath $PwshPath `
            -InstallRoot $InstallRoot `
            -DataDir $DataDir `
            -Port 18790 `
            -BrokerPort 18791 `
            -BrokerUpstreamPort 18792 `
            -BasePath '/codex-remote' |
            ConvertTo-Json -Compress -Depth 20
    }
    'validate-url' {
        Assert-LoopbackWebSocketUrl -WebSocketUrl $WebSocketUrl |
            ForEach-Object { $_.AbsoluteUri }
    }
    'classify-process' {
        Test-ManagedBrokerProcess `
            -CommandLine $CommandLine `
            -ExecutablePath $ExecutablePath `
            -ExpectedNodePath $NodePath `
            -ExpectedBrokerCliPath $CodexPath `
            -BrokerPort 18791 `
            -UpstreamPort 18792 `
            -ExpectedCodexPath $PwshPath `
            -DataDir $DataDir `
            -CapabilityTokenFilePath $WebSocketUrl |
            ConvertTo-Json -Compress -Depth 20
    }
    'classify-bootstrap-contract' {
        Get-ManagedBootstrapProcessContract `
            -CommandLine $CommandLine `
            -ExecutablePath $ExecutablePath `
            -TaskName 'Codex Local Remote' `
            -NodePath $NodePath `
            -PwshPath $PwshPath `
            -InstallRoot $InstallRoot `
            -DataDir $DataDir `
            -Port 18790 `
            -BrokerPort 18791 `
            -BrokerUpstreamPort 18792 `
            -BasePath '/codex-remote' |
            ConvertTo-Json -Compress -Depth 20
    }
    'classify-sidecar' {
        $parameters = @{
            CommandLine = $CommandLine
            ExecutablePath = $ExecutablePath
            ExpectedNodePath = $NodePath
            ExpectedSidecarCliPath = $CodexPath
            Port = 18790
            BasePath = '/codex-remote'
            DataDir = $DataDir
        }
        if ($PSBoundParameters.ContainsKey('MaintenanceTokenFilePath')) {
            $parameters.MaintenanceTokenFilePath = $MaintenanceTokenFilePath
        }
        Test-ManagedSidecarProcess @parameters |
            ConvertTo-Json -Compress -Depth 20
    }
    'process-command-line' {
        [pscustomobject]@{
            CommandLine = Get-CodexLocalRemoteProcessCommandLine -ProcessId $PID
        } | ConvertTo-Json -Compress -Depth 5
    }
    'assert-force-cli' {
        Assert-ForceCliDisabled
        [pscustomobject]@{ Allowed = $true } | ConvertTo-Json -Compress
    }
    'classify-desktop' {
        Test-IndependentDesktopAppServer `
            -CommandLine $CommandLine `
            -ParentProcessName $ParentProcessName |
            ConvertTo-Json -Compress
    }
    'environment-backup' {
        New-BrokerEnvironmentBackupState `
            -AppliedValue $WebSocketUrl `
            -PreviousValueExists ([bool]::Parse($PreviousValueExists)) `
            -PreviousValue $PreviousValue |
            ConvertTo-Json -Compress -Depth 20
    }
    'ensure-token' {
        Install-BrokerCapabilityToken -DataDir $DataDir |
            ConvertTo-Json -Compress -Depth 20
    }
    'inspect-data-dir-acl' {
        $acl = Get-Acl -LiteralPath $DataDir
        [pscustomobject]@{
            AreAccessRulesProtected = $acl.AreAccessRulesProtected
            CurrentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
            Rules = @(
                $acl.GetAccessRules(
                    $true,
                    $true,
                    [System.Security.Principal.SecurityIdentifier]
                ) | ForEach-Object {
                    [pscustomobject]@{
                        Sid = $_.IdentityReference.Value
                        AccessControlType = [string]$_.AccessControlType
                        FileSystemRights = [string]$_.FileSystemRights
                        InheritanceFlags = [string]$_.InheritanceFlags
                        PropagationFlags = [string]$_.PropagationFlags
                        IsInherited = $_.IsInherited
                    }
                }
            )
        } | ConvertTo-Json -Compress -Depth 20
    }
    'protect-data-dir' {
        Protect-CodexLocalRemoteDataDirectory -DataDir $DataDir |
            ConvertTo-Json -Compress -Depth 20
    }
    'remove-token' {
        Remove-BrokerCapabilityToken -DataDir $DataDir |
            ConvertTo-Json -Compress -Depth 20
    }
    'token-metadata' {
        $tokenPath = Join-Path $DataDir 'broker-capability.token'
        $item = Get-Item -LiteralPath $tokenPath
        [pscustomobject]@{
            Length = $item.Length
            Sha256 = (Get-FileHash -LiteralPath $tokenPath -Algorithm SHA256).Hash.ToLowerInvariant()
        } | ConvertTo-Json -Compress
    }
    'validate-data-dir-path' {
        Assert-CodexLocalRemoteDataDirectoryPath -DataDir $DataDir
    }
    'write-state' {
        $statePath = Join-Path $DataDir 'test-runtime-state.json'
        Write-AtomicJsonFile -Path $statePath -Value ([ordered]@{
            Signature = 'codex-local-remote/test-state/v1'
        })
        [pscustomobject]@{ StatePath = [System.IO.Path]::GetFullPath($statePath) } |
            ConvertTo-Json -Compress
    }
    'classify-app-server' {
        Test-ManagedAppServerProcess `
            -CommandLine $CommandLine `
            -ExecutablePath $ExecutablePath `
            -ExpectedCodexPath $CodexPath `
            -WebSocketUrl 'ws://127.0.0.1:18792' `
            -TokenFilePath $WebSocketUrl |
            ConvertTo-Json -Compress -Depth 20
    }
    'validate-unknown-count' {
        $parsed = $WebSocketUrl | ConvertFrom-Json
        Test-NonNegativeInteger -Value $parsed |
            ConvertTo-Json -Compress
    }
    'sidecar-readiness-decision' {
        $readiness = $WebSocketUrl | ConvertFrom-Json
        Get-BrokerReadinessDecision `
            -Readiness $readiness `
            -Phase $Phase |
            ConvertTo-Json -Compress -Depth 20
    }
    'runtime-supervision-decision' {
        $tokens = $null
        $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile(
            $StartScriptPath,
            [ref]$tokens,
            [ref]$errors
        )
        if ($errors.Count -gt 0) {
            throw 'The startup script could not be parsed.'
        }
        $functionAst = @(
            $ast.FindAll({
                param($node)
                $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                    $node.Name -ceq 'Get-SharedRuntimeDecision'
            }, $true)
        )
        if ($functionAst.Count -ne 1) {
            throw 'Expected exactly one Get-SharedRuntimeDecision function.'
        }
        Invoke-Expression ([string]$functionAst[0].Extent.Text)

        $script:testReadiness = if ($Scenario -ceq 'missing-readiness') {
            $null
        } else {
            [pscustomobject]@{
                runtimeInvocationId = '0123456789abcdef0123456789abcdef'
                brokerProcessId = 17
                upstreamProcessId = 19
                appServerReady = $true
                desktopConnected = $true
                sidecarConnected = $true
                degraded = $false
                unknownCount = 0
            }
        }
        function Get-BrokerReadinessSnapshot {
            return $script:testReadiness
        }
        function Get-VerifiedManagedUpstream {
            if ($Scenario -ceq 'missing-readiness') {
                throw 'Upstream verification must not run without readiness.'
            }
            if ($Scenario -ceq 'missing-upstream') {
                return $null
            }
            return [pscustomobject]@{ ProcessId = 19 }
        }
        function Test-BrokerReadinessRuntimeIdentity {
            return $Scenario -cne 'identity-mismatch'
        }
        $brokerPid = 17
        $runtimeInvocationId = '0123456789abcdef0123456789abcdef'

        Get-SharedRuntimeDecision | ConvertTo-Json -Compress
    }
}
