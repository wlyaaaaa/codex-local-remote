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

注册当前 Windows 用户的启动任务：

```powershell
.\scripts\windows\Register-CodexLocalRemoteStartup.ps1 -NoStart
```

注册器会把当前构建安装到内容寻址的不可变版本目录；计划任务和开始菜单入口
不会直接绑定可变 Git 工作树。状态命令中的 `RuntimeVersionId` 可用于确认
实际登记版本。

首次接入共享运行时需要一次人工门禁：完成手头任务，完全退出 Codex
Desktop，启动 `Codex Local Remote` 计划任务，再从开始菜单打开
“Codex Remote（安全启动）”。以后日常都使用这个入口；Remote 未就绪时它会
自动打开不带重定向的原生 Desktop，不会让登录依赖一个失联端口。

冷启动时 Broker 与 Sidecar 会先进入“等待 Desktop”的安全降级态并保持
运行，随后由安全启动入口让 Desktop 接入同一运行时。此阶段手机可看到明确
离线/等待状态，但不能发送执行请求；它不会因为 Desktop 还没接入就在后台
自杀重启。

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
- 文件页只允许预览或下载本机已经登记的项目。

## 更新

普通源码更新先运行 `pnpm check`，再执行
`Register-CodexLocalRemoteStartup.ps1 -NoStart` 登记新的不可变版本。正在
使用 Desktop 时不要停止 Broker，也不要设置用户级
`CODEX_APP_SERVER_WS_URL`；当前运行代继续工作，下一次自然启动才切换。需要
撤回下一次启动版本时运行 `Rollback-CodexLocalRemoteRuntime.ps1`。状态为
`update-pending` 表示旧链被安全保留，不代表要立刻强制重启。

遇到问题先运行：

```powershell
.\scripts\windows\Get-CodexLocalRemoteStatus.ps1 -Json
```

状态输出不包含密码、Cookie、提示词、对话正文或能力 token。
