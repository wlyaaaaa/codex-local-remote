# Windows 安装与公网入口

手机端不需要安装 App、扩展或 Tailscale。电脑端需要运行 Sidecar，并由
Tailscale Funnel 把一个独立路径转发给它。

## 前置条件

- Windows 11；
- 已登录的 Codex 桌面端；
- Node.js 24 或更高版本；
- pnpm 11；
- 已连接并获准使用 Funnel 的 Tailscale。

共享 AppServer Broker 和 Sidecar 必须以正在使用 Codex 桌面端的 Windows
用户运行，不要改成 `LocalSystem` 服务。两者职责不同：

- Broker Proxy 只监听 `127.0.0.1:18791`；安装程序在
  `<DataDir>\broker-capability.token` 原子生成至少 32 字节随机能力凭据，
  Codex Desktop 和 Sidecar 只能通过带该能力路径的 WebSocket endpoint
  连接；
- Broker Proxy 独占启动内部
  `codex app-server --listen ws://127.0.0.1:18792`，并通过固定
  `<DataDir>\app-server-upstream.token` 使用官方 WebSocket capability-token
  认证；外部客户端不得直接连接 18792；
- Sidecar 仍只监听 `127.0.0.1:18790`，负责密码、权限和浏览器产品层；
- Funnel 只转发到 18790，绝不直接暴露 18791 或 18792。

安装前应通过本机的端口治理工具确认 18791 可用。启动脚本还会在绑定前重新
检查；若端口已被外来进程、非 loopback listener 或多个 PID 占用，会直接
失败，不会停止或接管它们。

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

上面的直接 `serve` 仅适合首次设置和诊断。要让 Desktop 与手机连接同一个
运行时，日常 Remote 基础设施必须使用下文的 Windows 计划任务；它会先启动
共享 Broker，再启动 Sidecar。Desktop 则从受管 fail-open 快捷方式打开。
不要同时保留另一个手工启动的 `codex app-server`。

也可以先启动服务，再从电脑本机浏览器打开
`http://127.0.0.1:18790/codex-remote/` 完成首次设置。首次设置接口只接受
loopback 请求。

项目必须通过电脑本机命令显式登记。授权会绑定登记当时的真实目录身份；若
项目根被移动、删除后重建或替换为 junction，手机端文件访问与新任务会停止，
需要在电脑本机重新登记，系统不会自动信任新目标。

```powershell
node apps/sidecar/dist/cli.js register-project --id my-project --name "我的项目" --root "C:\Projects\my-project"
```

设置完成后注册“当前用户登录时启动”的计划任务；脚本不会申请
`LocalSystem` 或管理员运行级别。任务带有项目签名，并固定 PowerShell
bootstrap、Node、参数和工作目录；Codex Desktop 与随附 `codex.exe` 每次
动态发现，不固定版本或 WindowsApps 路径。bootstrap 严格按以下次序运行：

1. 阻断任何作用域中的 `CODEX_APP_SERVER_FORCE_CLI=1`，避免 Desktop
   静默创建第二个 owner；
2. 清除 bootstrap 进程继承的 Desktop override，并从固定 token 文件构造
   Sidecar 专用 endpoint；绝不把 token 写入命令输出、状态 JSON 或进程参数；
3. 验证或启动 18791 Broker Proxy；启动参数只传 token 文件路径，Proxy 再
   独占经过认证的 18792 app-server；
4. 写入不含对话、endpoint token 和凭据的 Broker Proxy PID owner state；
5. 把 `127.0.0.1:18790` Sidecar 作为受监控子进程启动。Broker 或
   app-server 退出/失去精确 owner/健康状态时，bootstrap 只停止自己启动的
   Sidecar 并非零退出，使计划任务的三次重启策略真正生效。

冷启动握手分成两层：Sidecar 只要已经以受管身份连接同一 Broker，transport
层就完成并保持进程存活；在 Desktop 尚未接入时，请求级 `/ready` 仍保持
degraded，所有执行入口继续禁用。fail-open 启动器据此先确认稳定基础设施，
再向本次 Desktop 子进程注入 endpoint。不能反过来要求请求级 `/ready`
先通过，否则会形成“等 Desktop 才 Ready、等 Ready 才启动 Desktop”的
循环等待。

任务所有权还会核对当前用户 SID、`Interactive`/`Limited` principal、唯一且
启用的同 SID 登录触发器，以及电池、执行时限、单实例、重启、可用性、按需
启动、空闲和网络等完整 settings。缺字段或 SID 无法解析都视为不匹配。任务
不存在时注册器不使用 `-Force`，因此同名创建竞态会失败而不会覆盖；精确 V2
重复注册返回 `already-registered`，精确 V1 必须改用
`Migrate-CodexLocalRemoteSharedOwner.ps1`。

Windows 任务对象的任务级 ACL/安全描述符会受目标机器、域和 Task Scheduler
服务规范化影响，不能在不同机器间作稳定的逐字节精确验证。本产品因此把同一
Windows 用户、`SYSTEM`、内置管理员和 Windows Task Scheduler 服务共同列入
本地可信边界；任务定义指纹用于防止误认和无意覆盖，不声称隔离这些主体。

注册脚本不会设置用户或机器级 `CODEX_APP_SERVER_WS_URL`。正式共享入口是
`Launch-CodexWithRemote.ps1` 及注册器创建的受管快捷方式：启动器每次动态
解析当前 Desktop，在受管 Broker 基础就绪时只向本次 Desktop 子进程注入
带高熵能力路径的 loopback endpoint；任何检查失败、超时或 Remote 未运行
都会清除继承值并打开无 override 的原生 Desktop。重复安装会验证并复用
同一个 token。冷启动会给动态版本发现、Broker 与 Sidecar 最多 30 秒完成
基础握手，避免在服务仍正常启动时过早回退。历史安装若留下本项目可证明的持久 override，升级时只做一次
精确恢复/清理；第三方值或无法证明的状态绝不覆盖。

在任何 token、环境备份、运行状态或递归 ACL 写入前，脚本必须先证明
`<DataDir>` 归本项目所有。首次安全创建/接管会以 `CreateNew` 临时文件和
不覆盖 rename 原子发布
`<DataDir>\.codex-local-remote-data-owner.json`；marker 精确绑定规范路径、
当前用户 SID、版本、签名和实例 GUID。损坏、错签名/版本/路径/SID 的
marker，以及 marker 自身是 reparse point、hard link 或异常大文件时都会
失败关闭，绝不覆盖。

不存在的目录和不位于 Git 仓库/系统广义目录的空自定义目录可以首次 claim。
非空自定义目录没有 marker 时默认拒绝。只有精确的默认
`%LOCALAPPDATA%\CodexLocalRemote` 可以自动接管旧安装，而且根目录只接受
已知状态/token 文件、`RemoteConversations`、`funnel-backups` 和源码真实
产生的精确临时文件名；未知项、类型错误或任意后代 reparse point 都会在
marker/ACL 变化前拒绝。

所有权证明通过后，脚本才把 `<DataDir>` 修复为受保护 ACL：禁用从父目录
继承，只允许当前用户、`SYSTEM` 和内置 `Administrators` 完全控制，并让
规则继承到子文件和子目录；已有子项的显式宽松规则会被重置。每次 ACL
写入前重新验证 marker、目录和全部现存 ancestor。`-WhatIf` 只返回
`would-create`、`would-adopt` 或 `would-repair` 计划，目录、marker 和 ACL
均零写；有效 marker 且整棵 ACL 已合规则返回 `already-protected`。

```powershell
.\scripts\windows\Register-CodexLocalRemoteStartup.ps1
```

注册器不会让计划任务直接执行 Git 工作树。它先把 `package.json`、Broker/
Sidecar 独立 bundle、Web `dist` 和 Windows 脚本复制到
`%LOCALAPPDATA%\CodexLocalRemote\RuntimeVersions\<content-sha256>`，写入并
回读 `runtime-manifest.json`。manifest 记录源码 commit、dirty 状态以及每个
文件的大小和 SHA-256；任务与安全启动快捷方式只在验证通过后指向该不可变目录。
`runtime-current.json` 原子保留当前和上一版的目录与 manifest hash。

如果 Codex Desktop 当前仍开着，首次迁移仍需等当前工作结束后再进入一次
受控关闭/打开门禁，避免短暂出现两个 app-server owner：

```powershell
.\scripts\windows\Register-CodexLocalRemoteStartup.ps1 -NoStart
# 现在由用户完全退出 Codex Desktop（包括托盘/后台进程）
Start-ScheduledTask -TaskName 'Codex Local Remote'
# BrokerReady 后通过受管 fail-open 快捷方式重新打开 Codex Desktop
```

上面的“退出再打开 Desktop”仅适用于从 V1 单 owner 迁入共享 Broker。不要对
已经运行共享 Broker 的 pinned V2 任务再次使用
`Migrate-CodexLocalRemoteSharedOwner.ps1`；该迁移器会按 V1 合约停止并重新
启动 Desktop。

最终构建完成后的普通更新只登记下一次启动版本，无需退出或重启 Codex
Desktop，也不得停止 Broker：

```powershell
# 构建、验证并把任务定义切到新的不可变目录；当前运行代保持不动。
pnpm build
.\scripts\windows\Register-CodexLocalRemoteStartup.ps1 -NoStart
```

当前正在运行的 bootstrap/Broker/Desktop/Sidecar 不会因“登记更新”被替换；
下一次注销、重启或自然受控的运行代切换才执行新版。需要撤回下一次启动版本时：

```powershell
.\scripts\windows\Rollback-CodexLocalRemoteRuntime.ps1
```

回滚同样只更新任务定义和 current/previous 指针，不终止当前 Desktop。切换后
用 `Get-CodexLocalRemoteStatus.ps1 -Json` 验证 `ImmutableRuntimeReady=true`、
`RuntimeVersionId`、`RuntimeRoot` 和 `PreviousRuntimeVersionId`。

V3 bootstrap 复用旧 Broker 时不会只凭旧版本号放行。它先核对精确 Broker
和 upstream 身份，再要求 Desktop 已连接，并将活跃 app-server 的规范路径与
新鲜 SHA-256 和当前动态发现结果逐项比较；完全一致才把旧回执提升为 current。
如果 Desktop 在切换瞬间短暂断开，bootstrap 保持 degraded 并在监督循环中
重试同一验证，重连后可自动恢复；路径或 hash 漂移则持续
`update-pending`，不会伪装成功。

启动 bootstrap 若发现 Desktop 仍拥有独立 stdio app-server，会直接失败，
不会静默并行启动第二 owner。安装脚本不会强杀 Desktop；受管启动器只处理
自己刚创建、尚未承载用户工作的精确进程。通过共享入口重新打开后，用状态
命令确认 Desktop 已不再拥有独立 stdio app-server。

移除启动项不会删除密码哈希、项目设置、不可变运行版本或其他运行数据，便于
恢复和取证。卸载脚本在第一次 mutation 前先证明 Desktop 已断开、活动/未知
轮次为零，并校验 Broker listener、PID、命令行、state 与 `/ready` 一致；
任一条件失败时不会先停止任务、Sidecar 或 Broker。随后它会校验任务
签名、名称、Action、命令和工作目录；只会依据 PID state 停止路径、命令行
和 loopback listener 都精确匹配的 Broker。即使 Broker 已强制退出或 state
缺失，也只检查固定 18792 端口，并仅停止命令、Codex 路径、官方认证参数和
固定 upstream token 文件都精确匹配的 orphan。它绝不停止 Desktop 的独立
stdio 进程、18789、其他 Codex 进程或其他 Funnel。随后删除受管 fail-open
快捷方式与固定 `broker-capability.token`。新安装没有持久 Desktop 环境
需要恢复；对于历史安装，仅当环境备份、当前值与受管 endpoint 能形成完整
证明链时才精确恢复。若用户变量已被其他程序改写，卸载会拒绝覆盖新值并
报告冲突。

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

随时可以读取本机、计划任务、Broker、Desktop owner 和 Funnel 的分层状态；
这个命令不会打印密码、Cookie、提示词、能力 token、带 token 的 endpoint
或文件内容：

```powershell
.\scripts\windows\Get-CodexLocalRemoteStatus.ps1
```

跨进程脚本或自动化应使用 `-Json`，以获得单个可解析的机器状态对象，避免把
PowerShell 的格式化文本误当成对象：

```powershell
.\scripts\windows\Get-CodexLocalRemoteStatus.ps1 -Json
```

关键字段：

- `TaskOwned`：计划任务是否精确匹配动态 V3 签名、PowerShell bootstrap action、
  参数、工作目录，以及当前用户 SID、`Interactive` logon type 和 `Limited`
  run level；
- `TaskRunning`：计划任务的当前 `TaskState` 是否为 `Running`；
- `TaskReady`：`TaskOwned` 与 `TaskRunning` 是否同时成立。`LastTaskResult`
  仅用于诊断，不参与此门；运行中任务常见的 `267009`（`0x41301`）不会
  阻断 `TaskReady`；
- `SidecarListenerReady`：18790 必须恰好存在一个 listener，且只绑定
  `127.0.0.1` 并由单一 PID 拥有；
- `SidecarOwned` / `SidecarPid`：该 PID 的 CIM 进程必须精确匹配受管
  Node、Sidecar CLI、`DataDir`、`BasePath`、host 和 port；
- `SidecarLoopbackOnly`：18790 的所有 listener 是否都严格绑定
  `127.0.0.1`；仅存在 `::1`、非 loopback 地址或混合地址均不通过；
- `BrokerReady`：18791 Broker Proxy 与 18792 内部 app-server 是否都只由
  精确匹配的 loopback PID 拥有；
- `RuntimeReceiptReady`：计划任务 bootstrap、Broker、Sidecar 和内部
  app-server 的回执必须属于同一个 Broker 生成的
  `RuntimeInvocationId`，并同时匹配 PID、创建时间、进程句柄启动时间、
  完整命令行、监听器 owner 与 `/ready` 回显；旧回执或两次启动的混合状态
  不能拼成健康结果；
- `CapabilityTokenReady`：固定 token 文件是否存在且格式有效；
- `LauncherScriptReady` / `LauncherShortcutReady`：fail-open 启动脚本与
  “Codex Remote（安全启动）”入口是否存在且精确匹配当前安装；
- `LauncherConfigured` / `LaunchMode`：聚合入口是否可用，正式模式必须为
  `process-scoped-fail-open`；
- `LegacyPersistentOverrideBlocked` / `LegacyEnvironmentState`：任何持久
  `CODEX_APP_SERVER_WS_URL` 都会阻断 Ready；旧受管状态必须精确退休为
  `none`，不能让 Desktop 启动依赖本地端口；
- `DesktopConnected` / `SidecarConnected`：Broker 的无敏感 `/ready`
  状态是否确认两个产品客户端已连接；
- `SidecarRequestReady`：Sidecar 不只占用了端口，而且已完成模型目录、任务
  列表及 Broker/Desktop 实时连接探针；计划任务启动握手也使用同一门禁；
- `Degraded`：Broker 是否报告内部降级，或当前 Desktop runtime 已
  `update-pending`/`blocked`；
- `UnknownCount`：Broker 发现的未识别客户端数量；必须是非负整数，且
  `Ready=true` 时必须为 `0`。启动 bootstrap 也会拒绝复用存在未知客户端的
  Broker；
- `ForceCliBlocked`：是否发现会产生第二 owner 的强制 CLI 配置；
- `DesktopIndependentStdioAppServer`：Desktop 是否仍在运行自己的 stdio
  app-server。完成 Desktop 重启后应为 `false`；
- `DesktopRuntimeStatus`：`current` 表示当前 Broker 使用的运行时与已安装
  Desktop 一致；`update-pending` 表示 Codex 已更新，但现有共享任务仍由
  启动时验证过的旧进程承载；`blocked` 表示无法安全解析新运行时；
- `Ready`：计划任务 `TaskReady`、精确 Sidecar listener/进程 owner gate、
  Funnel、Broker、认证 upstream、Desktop、Sidecar、安全 fail-open 入口和
  Desktop 单 owner 边界是否同时通过且未降级。

例行状态查询会复用启动时已经通过完整二进制 hash 校验的运行时回执，只读取
当前 Desktop package generation 元数据，并在一次
`Get-NetTCPConnection` 中批量核对 18790/18791/18792，避免诊断命令自身阻塞
启动或值守。真正启动新 Broker、切换安装代和严格测试 fixture 仍执行完整 hash
发现；快速状态路径不能替代启动安全门禁。

## Codex Desktop 高频更新

计划任务不保存 Codex 版本号、WindowsApps 安装目录或固定 `codex.exe`
路径。每次 bootstrap 真正启动新 Broker 时都会重新查询唯一健康的
`OpenAI.Codex` 包，校验发布者、普通文件、包内 hash，并选择与当前包
`codex.exe` 完全同 hash 的 Desktop 本地缓存；找不到时失败关闭，不回退
到 PATH 或 Codex CLI。

更新发生在共享任务运行期间时不会热替换 app-server，也不会强杀或重启
Desktop、Broker 或 Sidecar。bootstrap 每 30 秒重新发现当前 Desktop package
generation 和二进制 hash；发现漂移后把 `startup-last.json` 写为
`degraded`/`update-pending`，但保留全部活跃进程。状态命令也会独立重新发现
并报告 `DesktopRuntimeStatus=update-pending`、`Degraded=true`、
`Ready=false`，表示新安装代尚未完成严格切换验收。只要旧的已验证运行进程
仍在、Desktop/Broker 身份一致，并且模型和任务协议的实时能力探针继续通过，
Sidecar 仍可服务请求并在 Web 显示更新待切换提示；不会仅因版本/hash 改变
就让手机端停摆。下一次受管栈启动会自动采用新运行时。解析或校验失败则报告
`blocked` 并停止新执行。若新 Desktop 不再接受
`CODEX_APP_SERVER_WS_URL`，或协议
能力探测失败，远程端必须显示兼容性降级并拒绝新执行，而不是建立第二个
手机专属 owner。此隐藏入口本身不是官方稳定合约，因此“自动发现”不能
等价为“保证未来每个版本都兼容”。

Sidecar 另以 5 秒周期读取有界普通文件形式的 V3 启动/Broker 回执，并向
Broker 的回环 `/ready` 复核运行代号、Broker/upstream PID、
`DesktopConnected`、`SidecarConnected` 和未知客户端数。任何不一致或
Desktop 断线都会把 app-server 能力设为 degraded、触发 Web 实时刷新并暂停
新执行；启动回执缺失也不会被当作 Ready。

## 浏览器

手机打开脚本返回的 HTTPS 地址，输入密码即可使用。PWA“添加到主屏幕”是
可选项，不影响完整功能。若公网网络阻断 Funnel 域名，应用本身无法绕过
运营商或网络策略；可另行配置同等安全的 HTTPS 反向代理。
