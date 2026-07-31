[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ScriptPath
)

$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $ScriptPath,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    throw 'The on-demand handoff script did not parse.'
}
$functionAst = $ast.FindAll(
    {
        param($node)
        $node -is
            [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -ceq 'Get-OnDemandHandoffDecision'
    },
    $true
) | Select-Object -First 1
if ($null -eq $functionAst) {
    throw 'The on-demand handoff decision helper was not found.'
}
Invoke-Expression ([string]$functionAst.Extent.Text)

$cases = [ordered]@{
    AlreadyRunning = Get-OnDemandHandoffDecision `
        -TaskState 'Running' `
        -RemoteState 'ready' `
        -DesktopRootCount 1 `
        -IndependentStdioCount 0 `
        -AllowDesktopRestart:$false
    Queued = Get-OnDemandHandoffDecision `
        -TaskState 'Queued' `
        -RemoteState 'unverified' `
        -DesktopRootCount 0 `
        -IndependentStdioCount 0 `
        -AllowDesktopRestart:$true
    DetachedNative = Get-OnDemandHandoffDecision `
        -TaskState 'Running' `
        -RemoteState 'desktop-detached' `
        -DesktopRootCount 1 `
        -IndependentStdioCount 0 `
        -AllowDesktopRestart:$true
    DetachedNativeWithoutAuthority = Get-OnDemandHandoffDecision `
        -TaskState 'Running' `
        -RemoteState 'desktop-detached' `
        -DesktopRootCount 1 `
        -IndependentStdioCount 0 `
        -AllowDesktopRestart:$false
    BackgroundRepair = Get-OnDemandHandoffDecision `
        -TaskState 'Running' `
        -RemoteState 'background-repairable' `
        -DesktopRootCount 1 `
        -IndependentStdioCount 0 `
        -AllowDesktopRestart:$false
    BackgroundNativeWithoutAuthority = Get-OnDemandHandoffDecision `
        -TaskState 'Running' `
        -RemoteState 'background-repairable' `
        -DesktopRootCount 1 `
        -IndependentStdioCount 1 `
        -AllowDesktopRestart:$false `
        -DesiredMode Native
    BackgroundNativeWithAuthority = Get-OnDemandHandoffDecision `
        -TaskState 'Running' `
        -RemoteState 'background-repairable' `
        -DesktopRootCount 1 `
        -IndependentStdioCount 1 `
        -AllowDesktopRestart:$true `
        -DesiredMode Native
    BackgroundNativeHeadless = Get-OnDemandHandoffDecision `
        -TaskState 'Running' `
        -RemoteState 'background-repairable' `
        -DesktopRootCount 0 `
        -IndependentStdioCount 0 `
        -AllowDesktopRestart:$false `
        -DesiredMode Native
    BackgroundNativeOrphanStdio = Get-OnDemandHandoffDecision `
        -TaskState 'Running' `
        -RemoteState 'background-repairable' `
        -DesktopRootCount 0 `
        -IndependentStdioCount 1 `
        -AllowDesktopRestart:$true `
        -DesiredMode Native
    RunningUnverified = Get-OnDemandHandoffDecision `
        -TaskState 'Running' `
        -RemoteState 'unverified' `
        -DesktopRootCount 1 `
        -IndependentStdioCount 1 `
        -AllowDesktopRestart:$true
    TransitionNativeWithoutAuthority = Get-OnDemandHandoffDecision `
        -TaskState 'Running' `
        -RemoteState 'runtime-transition' `
        -DesktopRootCount 1 `
        -IndependentStdioCount 1 `
        -AllowDesktopRestart:$false
    TransitionNativeWithAuthority = Get-OnDemandHandoffDecision `
        -TaskState 'Running' `
        -RemoteState 'runtime-transition' `
        -DesktopRootCount 1 `
        -IndependentStdioCount 1 `
        -AllowDesktopRestart:$true
    BusyTransitionWithoutAuthority = Get-OnDemandHandoffDecision `
        -TaskState 'Running' `
        -RemoteState 'runtime-transition-busy' `
        -DesktopRootCount 1 `
        -IndependentStdioCount 0 `
        -AllowDesktopRestart:$false
    BusyTransitionWithAuthority = Get-OnDemandHandoffDecision `
        -TaskState 'Running' `
        -RemoteState 'runtime-transition-busy' `
        -DesktopRootCount 1 `
        -IndependentStdioCount 0 `
        -AllowDesktopRestart:$true
    BusyTransitionHeadlessWithAuthority = Get-OnDemandHandoffDecision `
        -TaskState 'Running' `
        -RemoteState 'runtime-transition-busy' `
        -DesktopRootCount 0 `
        -IndependentStdioCount 0 `
        -AllowDesktopRestart:$true
    TransitionHeadless = Get-OnDemandHandoffDecision `
        -TaskState 'Running' `
        -RemoteState 'runtime-transition' `
        -DesktopRootCount 0 `
        -IndependentStdioCount 0 `
        -AllowDesktopRestart:$false
    TransitionAmbiguousRoots = Get-OnDemandHandoffDecision `
        -TaskState 'Running' `
        -RemoteState 'runtime-transition' `
        -DesktopRootCount 2 `
        -IndependentStdioCount 0 `
        -AllowDesktopRestart:$true
    TransitionOrphanStdio = Get-OnDemandHandoffDecision `
        -TaskState 'Running' `
        -RemoteState 'runtime-transition' `
        -DesktopRootCount 0 `
        -IndependentStdioCount 1 `
        -AllowDesktopRestart:$true
    BackgroundOnly = Get-OnDemandHandoffDecision `
        -TaskState 'Ready' `
        -RemoteState 'inactive' `
        -DesktopRootCount 0 `
        -IndependentStdioCount 0 `
        -AllowDesktopRestart:$false
    RestartRequired = Get-OnDemandHandoffDecision `
        -TaskState 'Ready' `
        -RemoteState 'inactive' `
        -DesktopRootCount 1 `
        -IndependentStdioCount 0 `
        -AllowDesktopRestart:$false
    RestartAuthorized = Get-OnDemandHandoffDecision `
        -TaskState 'Ready' `
        -RemoteState 'inactive' `
        -DesktopRootCount 1 `
        -IndependentStdioCount 0 `
        -AllowDesktopRestart:$true
    AmbiguousRoots = Get-OnDemandHandoffDecision `
        -TaskState 'Ready' `
        -RemoteState 'inactive' `
        -DesktopRootCount 2 `
        -IndependentStdioCount 0 `
        -AllowDesktopRestart:$true
    OrphanStdio = Get-OnDemandHandoffDecision `
        -TaskState 'Ready' `
        -RemoteState 'inactive' `
        -DesktopRootCount 0 `
        -IndependentStdioCount 1 `
        -AllowDesktopRestart:$true
    DisabledTask = Get-OnDemandHandoffDecision `
        -TaskState 'Disabled' `
        -RemoteState 'inactive' `
        -DesktopRootCount 0 `
        -IndependentStdioCount 0 `
        -AllowDesktopRestart:$true
}

[pscustomobject]$cases | ConvertTo-Json -Compress
