[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ControlPath
)

$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path -LiteralPath $ControlPath),
    [ref]$tokens,
    [ref]$errors
)
if ($errors.Count -gt 0) {
    throw 'Control dispatcher did not parse.'
}
$functionAst = @(
    $ast.FindAll(
        {
            param($candidate)
            $candidate -is
                [Management.Automation.Language.FunctionDefinitionAst] -and
            $candidate.Name -ceq 'Show-ControlNotification'
        },
        $true
    )
)
if ($functionAst.Count -ne 1) {
    throw 'Feedback function was not found exactly once.'
}
Invoke-Expression $functionAst[0].Extent.Text
$InteractiveShortcutFeedback = $true
$messages = [System.Collections.Generic.List[object]]::new()
$adapter = {
    param([string]$Title, [string]$Message)
    $messages.Add([pscustomobject]@{
        Title = $Title
        Message = $Message
    })
}
Show-ControlNotification `
    -RequestedOperation Open `
    -Result ([pscustomobject]@{ Status = 'repaired' }) `
    -Adapter $adapter
Show-ControlNotification `
    -RequestedOperation Open `
    -Result ([pscustomobject]@{ Status = 'pending' }) `
    -Adapter $adapter
Show-ControlNotification `
    -RequestedOperation Open `
    -Result ([pscustomobject]@{ Status = 'restart-required' }) `
    -Adapter $adapter
Show-ControlNotification `
    -RequestedOperation Open `
    -Result ([pscustomobject]@{ Status = 'native-fallback' }) `
    -Adapter $adapter
Show-ControlNotification `
    -RequestedOperation Open `
    -Failed `
    -Adapter $adapter
Show-ControlNotification `
    -RequestedOperation Close `
    -Result ([pscustomobject]@{ Status = 'native' }) `
    -Adapter $adapter
Show-ControlNotification `
    -RequestedOperation Close `
    -Result ([pscustomobject]@{ Status = 'already-native' }) `
    -Adapter $adapter
Show-ControlNotification `
    -RequestedOperation Close `
    -Result ([pscustomobject]@{
        Status = 'native-pending-desktop-exit'
    }) `
    -Adapter $adapter

[pscustomobject]@{
    Count = $messages.Count
    RepairedExact = (
        [string]$messages[0].Title -ceq 'Codex Remote' -and
        [string]$messages[0].Message -ceq
            '远程已连接，可继续在公网端验收。'
    )
    PendingExact = (
        [string]$messages[1].Title -ceq 'Codex Remote 正在处理' -and
        [string]$messages[1].Message -ceq
            '远程尚未 ready；后台正在处理，当前不会显示为已连接。'
    )
    RestartRequiredExact = (
        [string]$messages[2].Title -ceq 'Codex Remote 需要交接' -and
        [string]$messages[2].Message -ceq
            '远程尚未连接；需要一次已授权的 ChatGPT 外部交接。'
    )
    NativeFallbackExact = (
        [string]$messages[3].Title -ceq 'Codex Remote 未连接' -and
        [string]$messages[3].Message -ceq
            '远程未连接；ChatGPT 保持原生安全模式，可让 AI 继续诊断。'
    )
    FailedExact = (
        [string]$messages[4].Title -ceq 'Codex Remote 未连接' -and
        [string]$messages[4].Message -ceq
            '远程未连接；ChatGPT 保持原生安全模式，可让 AI 继续诊断。'
    )
    NativeExact = (
        [string]$messages[5].Message -ceq
            '远程已关闭；ChatGPT 保持原生模式。'
    )
    AlreadyNativeExact = (
        [string]$messages[6].Message -ceq
            '远程本来就是关闭状态；ChatGPT 保持原生模式。'
    )
    NativePendingDesktopExitExact = (
        [string]$messages[7].Message -ceq (
            '公网远程已关闭；当前 ChatGPT 保持不动，' +
            '自然退出后完全恢复原生模式。'
        )
    )
} | ConvertTo-Json -Compress
