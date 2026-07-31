[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ModulePath,

    [Parameter(Mandatory)]
    [ValidateSet(
        'add-everyone-rule',
        'assert-startup-protection',
        'current-sid',
        'inspect-acl',
        'plan',
        'protect',
        'protect-whatif'
    )]
    [string]$Operation,

    [Parameter(Mandatory)]
    [string]$DataDir
)

$ErrorActionPreference = 'Stop'
Import-Module $ModulePath -Force

switch ($Operation) {
    'add-everyone-rule' {
        $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
        $output = & $icacls $DataDir '/grant' '*S-1-1-0:(OI)(CI)F' 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "icacls failed to introduce the test-only ACL drift: $output"
        }
        [pscustomobject]@{ Status = 'widened' } | ConvertTo-Json -Compress
    }
    'assert-startup-protection' {
        Assert-CodexLocalRemoteDataDirectoryStartupProtection `
            -DataDir $DataDir |
            ConvertTo-Json -Compress -Depth 10
    }
    'current-sid' {
        [pscustomobject]@{
            Sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        } | ConvertTo-Json -Compress
    }
    'inspect-acl' {
        $acl = Get-Acl -LiteralPath $DataDir
        [pscustomobject]@{
            Sddl = $acl.Sddl
            AreAccessRulesProtected = $acl.AreAccessRulesProtected
            Rules = @(
                $acl.GetAccessRules(
                    $true,
                    $true,
                    [System.Security.Principal.SecurityIdentifier]
                ) | ForEach-Object {
                    [pscustomobject]@{
                        Sid = $_.IdentityReference.Value
                        IsInherited = $_.IsInherited
                    }
                }
            )
        } | ConvertTo-Json -Compress -Depth 10
    }
    'plan' {
        Get-CodexLocalRemoteDataDirectoryOwnershipPlan -DataDir $DataDir |
            ConvertTo-Json -Compress -Depth 10
    }
    'protect' {
        Protect-CodexLocalRemoteDataDirectory -DataDir $DataDir |
            ConvertTo-Json -Compress -Depth 10
    }
    'protect-whatif' {
        Protect-CodexLocalRemoteDataDirectory -DataDir $DataDir -WhatIf |
            ConvertTo-Json -Compress -Depth 10
    }
}
