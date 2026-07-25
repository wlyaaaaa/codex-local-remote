Set-StrictMode -Version Latest

$script:StartupTaskSignature = 'codex-local-remote/startup-task/v1'
$script:StartupTaskDescription = "$script:StartupTaskSignature - Starts the local-only Codex Local Remote sidecar at user sign-in."

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

function Get-StartupTaskDefinition {
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

    [pscustomobject]@{
        TaskName = $TaskName
        TaskPath = '\'
        Description = $script:StartupTaskDescription
        Execute = $resolvedNode
        Arguments = $arguments
        WorkingDirectory = $resolvedRoot
        Cli = $cli
        DataDir = $resolvedDataDir
    }
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
    if ([string]$Task.TaskName -cne [string]$Expected.TaskName) {
        $mismatches.Add('task name')
    }
    if ([string]$Task.TaskPath -cne [string]$Expected.TaskPath) {
        $mismatches.Add('task path')
    }
    if ([string]$Task.Description -cne [string]$Expected.Description) {
        $mismatches.Add('signature')
    }

    $actions = @($Task.Actions)
    if ($actions.Count -ne 1) {
        $mismatches.Add('action count')
    } else {
        $action = $actions[0]
        if ([string]$action.Execute -cne [string]$Expected.Execute) {
            $mismatches.Add('action executable')
        }
        if ([string]$action.Arguments -cne [string]$Expected.Arguments) {
            $mismatches.Add('action arguments')
        }
        if ([string]$action.WorkingDirectory -cne [string]$Expected.WorkingDirectory) {
            $mismatches.Add('working directory')
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
    'Get-StartupTaskDefinition',
    'Test-ManagedStartupTask',
    'ConvertTo-CanonicalJson',
    'Get-FunnelHandlerEntries',
    'Get-FunnelWebKey',
    'Test-FunnelHandlerEntriesEqual'
)
