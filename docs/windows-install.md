# Windows 安装与公网入口

手机端不需要安装 App、扩展或 Tailscale。电脑端需要运行 Sidecar，并由
Tailscale Funnel 把一个独立路径转发给它。

## 前置条件

- Windows 11；
- 已登录的 Codex 桌面端；
- Node.js 24 或更高版本；
- pnpm 11；
- 已连接并获准使用 Funnel 的 Tailscale。

Sidecar 必须以正在使用 Codex 桌面端的 Windows 用户运行，不要改成
`LocalSystem` 服务。

## 本地构建

```powershell
pnpm install --frozen-lockfile
pnpm check
```

构建完成后，以交互方式设置密码。密码只从终端输入读取，不允许作为命令行
参数或环境变量传入。由于这是可以触发本机 Codex 操作的公网单因素入口，
密码或长口令短语至少需要 15 个字符：

```powershell
node apps/sidecar/dist/cli.js setup-password
node apps/sidecar/dist/cli.js serve
```

Windows 默认会在远程新任务首轮落盘后让 Codex Desktop 载入同一个任务。
如只希望使用浏览器而不自动切换 Desktop，可给 `serve` 增加
`--no-desktop-sync`，或设置 `CODEX_REMOTE_DESKTOP_SYNC=false`。

也可以先启动服务，再从电脑本机浏览器打开
`http://127.0.0.1:18790/codex-remote/` 完成首次设置。首次设置接口只接受
loopback 请求。

项目必须通过电脑本机命令显式登记。授权会绑定登记当时的真实目录身份；若
项目根被移动、删除后重建或替换为 junction，手机端文件访问与新任务会停止，
需要在电脑本机重新登记，系统不会自动信任新目标。

```powershell
node apps/sidecar/dist/cli.js register-project --id my-project --name "我的项目" --root "C:\Projects\my-project"
```

设置完成后可注册“当前用户登录时启动”的计划任务；脚本不会申请
`LocalSystem` 或管理员运行级别。任务带有项目签名，并固定 Node 命令、
参数和工作目录；如果同名任务不是完全匹配的本项目任务，脚本会拒绝覆盖：

```powershell
.\scripts\windows\Register-CodexLocalRemoteStartup.ps1
```

移除启动项不会删除密码哈希、项目设置或其他运行数据。卸载脚本同样会校验
任务签名、名称、Action、命令和工作目录，拒绝停止或删除同名外来任务。
如果注册时使用了非默认参数，卸载时要传入完全相同的参数：

```powershell
.\scripts\windows\Unregister-CodexLocalRemoteStartup.ps1
```

两个脚本都支持 `-WhatIf`。预演不会创建数据目录、注册、启动、停止或删除
计划任务。

## 增量添加 Funnel 路径

确认本地页面可用后运行：

```powershell
.\scripts\windows\Set-TailscaleFunnelRoute.ps1
```

脚本会：

1. 只接受规范路径（例如 `/codex-remote`），拒绝 `//`、`/./`、`/../` 和
   非根路径的尾斜杠；
2. 先只读取得完整 Funnel JSON 快照；
3. 检查 `/codex-remote` 是否已被其他服务占用；
4. 验证本机目标确实是 Codex Local Remote；
5. 在实际修改前备份完整快照，再用 `--set-path` 精确增量添加路径；由于
   Tailscale 会在转发前剥离该外部路径，proxy target 会显式保留同一个
   BasePath，例如
   `http://127.0.0.1:18790/codex-remote`，避免请求落到 sidecar 根路径；
6. 验证所有既有 handler 完全未变且新路径指向本项目；任何命令或验证失败
   都会自动把本项目路径回滚到修改前状态。

早期版本若已把同一 BasePath 精确指向同一 loopback 端口但遗漏 target
BasePath，脚本会在确认该端口确实运行 Codex Local Remote 后原地升级；
验证失败会恢复旧 handler。其他 target 仍视为外部占用并拒绝覆盖。

可以先做零写入预演；它不会创建备份目录或备份文件：

```powershell
.\scripts\windows\Set-TailscaleFunnelRoute.ps1 -WhatIf
```

关闭时只移除本项目路径：

```powershell
.\scripts\windows\Remove-TailscaleFunnelRoute.ps1
```

删除脚本会先确认路由目标为预期 loopback 端口和 BasePath，并实时验证该
目标仍标识为 Codex Local Remote；目标不匹配、服务无法验证或路由属于其他
应用时一律拒绝删除。删除后还会验证其他 handler 未变，失败时自动恢复本
项目路径。

不要使用 `tailscale funnel reset`，它会清空同一台机器上的其他 Funnel
处理器。

随时可以读取本机、计划任务和 Funnel 的分层状态；这个命令不会打印密码、
Cookie、提示词或文件内容：

```powershell
.\scripts\windows\Get-CodexLocalRemoteStatus.ps1
```

## 浏览器

手机打开脚本返回的 HTTPS 地址，输入密码即可使用。PWA“添加到主屏幕”是
可选项，不影响完整功能。若公网网络阻断 Funnel 域名，应用本身无法绕过
运营商或网络策略；可另行配置同等安全的 HTTPS 反向代理。
