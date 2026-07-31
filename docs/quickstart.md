# 五分钟使用指南

## 第一次安装

在仓库根目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm check
node apps/sidecar/dist/cli.js setup-password
```

密码只在本机交互输入，不要写进命令、配置、截图或公开仓库。

登记允许从手机选择的项目：

```powershell
node apps/sidecar/dist/cli.js register-project `
  --id my-project `
  --name "我的项目" `
  --root "C:\Projects\my-project"
```

从管理员 PowerShell（或 Windows `sudo` / UAC）登记当前 Windows 用户的
`Interactive` / `Highest` 按需任务：

```powershell
.\scripts\windows\Register-CodexLocalRemoteStartup.ps1 -NoStart
```

注册器会把当前构建安装到内容寻址的不可变版本目录，并在 DataDir 安装稳定的
`control-dispatcher/v1`。计划任务和 dispatcher 都不会直接绑定可变 Git
工作树；dispatcher 每次先验证 `runtime-current.json`、manifest、文件大小和
SHA-256，再调用所选不可变运行代。

普通 ChatGPT / Codex Desktop 启动、Codex 更新、Windows 重启和睡眠恢复都保持
原生，不会自动打开 Remote。显式控制入口为：

```powershell
$control = Join-Path $env:LOCALAPPDATA `
  'CodexLocalRemote\control\CodexLocalRemote.Control.ps1'
& $control -Operation Status
& $control -Operation Open
& $control -Operation Close
```

`Status` 只读；`Open` 幂等，已健康时零重启返回，可补齐的公网组件优先不重启
Desktop。只有原生 Desktop 无法安全接入时，`Open` 才会报告需要重开；获得明确
授权后才可追加 `-AllowDesktopRestart`，并且最多执行一次受控 Desktop 交接。
`Close` 清除公网 intent 并停止 Sidecar，但不重开 Desktop；已连接的
Broker/app-server/Desktop owner 自然退出，下一次普通启动回到原生。

若安装本机全局 AI control skill，它会把“打开远程 / 关闭远程 / 远程状态”路由到这个
dispatcher；Open/Close 在非管理员 token 下通过已启用的 Windows `sudo` 一次
执行。注册器仍维护一个受管“安全启动”快捷方式作为
`Open -AllowDesktopRestart` 的可选兼容别名并显示短暂结果，但日常控制不依赖
用户点击它。

显式租约内，普通 Sidecar 崩溃可由受管 supervisor 在保持
Broker/app-server/Desktop 不动时安全恢复。Broker 或 app-server 丢失会失败关闭，
必须由新的显式 `Open` 重新判断，不能伪装成普通公网重启。更新、Windows
reboot/resume 和普通 vendor 启动都不会因此获得接管或 Desktop 重启权限。

## 公网入口

本地状态通过后，再增量添加 Tailscale Funnel 路径：

```powershell
.\scripts\windows\Get-CodexLocalRemoteStatus.ps1 -Json
.\scripts\windows\Set-TailscaleFunnelRoute.ps1
```

手机直接打开返回的 HTTPS 地址并输入密码。Android 浏览器不需要安装扩展、
Tailscale 或本项目 App；“添加到主屏幕”只是可选快捷方式。

## 日常使用

- 首页查看全部运行任务和待审批项；
- 对话页可引导当前回复、排队下一轮、停止、审批和回答计划问题；
- 模型、思考、速度、权限与审批选项都来自当前 Codex 运行时；
- 右上角绿色圆环只表示当前任务的上下文占用；点一下可查看上下文、对话 ID，
  并在独立区域刷新账号额度与 UTC+8 重置时间；
- “+”中可设置目标、计划模式和压缩上下文；
- “电脑文件”页由当前登录用户的管理员后台任务管理全部已检测磁盘：上传、
  新建、编辑、重命名、复制、移动、预览、下载和删除。删除默认进入回收站；
  永久删除与覆盖需要明确确认。登录密码一旦泄露，应视为该用户的管理员文件
  权限一并泄露。

## 更新

普通源码更新先运行 `pnpm check`，再执行
`Register-CodexLocalRemoteStartup.ps1 -NoStart` 登记新的不可变版本。正在
使用 Desktop 时不要停止 Broker，也不要设置用户级
`CODEX_APP_SERVER_WS_URL`；当前运行代继续工作。登记不会自动切换、接管或
重启 Desktop。需要撤回待采用版本时运行
`Rollback-CodexLocalRemoteRuntime.ps1`。

需要采用新运行代时显式执行 dispatcher 的 `Open`。它会动态发现当前 Codex 包、
随附 app-server 和能力目录，不固定 WindowsApps 版本路径，并优先选择不重启
Desktop 的路径。只有返回需要 Desktop 重开且当前已明确授权时，才使用
`-AllowDesktopRestart`。状态未知、运行代不匹配、存在活动/未知任务或进程枚举
失败时保持失败关闭。

符合当前 Broker 兼容门的 Web/Sidecar 修复可以在现有显式租约内有界采用；
普通 Sidecar crash recovery 也只恢复同一精确租约。Broker、app-server 和
Desktop 均保持不动。Broker/app-server 丢失则失败关闭，不能从“公网可更新”
推导出 Broker 或 Desktop 重启授权。Codex 更新与 Windows 睡眠/唤醒只触发
重新发现或连接探测，不自动接管原生 Desktop。

Broker 会分别检查 Desktop 与 app-server 两端的 heartbeat。系统 timer 出现
睡眠间隔时会清空睡眠前的 miss 并重新探测，不把 resume 当成普通 crash，也不在
唤醒时自动停止或重开 Desktop。当前候选仍需真实睡眠/唤醒验收，自动化不能
替代实机证据。

遇到问题先运行：

```powershell
& $control -Operation Status
```

`Status` 不启动、不停止、不修复、不采用运行代，也不输出密码、Cookie、提示词、
对话正文或能力 token。当前已打开的原生 Desktop 若不能安全热接入，必须由
`Open` 明确报告并等待单独的重开授权。
