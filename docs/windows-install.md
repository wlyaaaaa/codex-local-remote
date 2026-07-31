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
运行时，Remote 基础设施使用下文的 Windows 按需计划任务，并由同一
coordinator 管理显式 Remote 租约。普通 Desktop 启动不会触发该任务。不要
同时保留另一个手工启动的 `codex app-server`。

也可以先启动服务，再从电脑本机浏览器打开
`http://127.0.0.1:18790/codex-remote/` 完成首次设置。首次设置接口只接受
loopback 请求。

项目必须通过电脑本机命令显式登记。授权会绑定登记当时的真实目录身份；若
项目根被移动、删除后重建或替换为 junction，手机端文件访问与新任务会停止，
需要在电脑本机重新登记，系统不会自动信任新目标。

```powershell
node apps/sidecar/dist/cli.js register-project --id my-project --name "我的项目" --root "C:\Projects\my-project"
```

设置完成后，从管理员 PowerShell（或 Windows `sudo` / UAC）注册当前用户的
按需计划任务。任务不设置登录触发器，也不允许 missed-trigger catch-up；
普通登录、启动、Codex 更新、Windows reboot 和 sleep/resume 都不会自动打开
Remote。任务仍绑定当前交互用户，不使用 `LocalSystem`，但 Broker、Sidecar 与
它拥有的 app-server 采用 `Highest` run level，从而让“电脑文件”与本机 AI
具有一致的管理员文件能力。

`Interactive` / `Highest` 任务中的 Desktop Owner Coordinator 是显式 Remote
租约内唯一受管 Desktop process owner；它使用同一用户、同一交互会话的
medium-integrity Explorer primary token 打开 ChatGPT / Codex Desktop，不能让
Desktop 继承管理员令牌。稳定 DataDir dispatcher 是受支持的控制入口，只接受
`Open`、`Close` 和 `Status`。`Open` 需要 Desktop 交接时，generation-bound
调用必须携带完整且实时匹配的 selected version/root；任何缺失、非法或 mismatch
都失败关闭。进程判断使用会抛错的严格 CIM 枚举，无法枚举时不能按“没有
Desktop”继续。

`Open` 幂等，先尝试零 Desktop 重启的恢复路径；只有明确返回需要重开且获得
`-AllowDesktopRestart` 授权时，才允许至多一次受控交接。`Close` 清除公网
intent 并停止 Sidecar，不重开 Desktop；已连接 owner 自然退出，下一次普通
启动回到原生。`Status` 只读。
Codex Desktop
包、随附 app-server 与能力目录每次动态发现，不固定版本或 WindowsApps 路径。
bootstrap 严格按以下次序运行：

1. 阻断任何作用域中的 `CODEX_APP_SERVER_FORCE_CLI=1`，避免 Desktop
   静默创建第二个 owner；
2. 清除 bootstrap 进程继承的 Desktop override，并从固定 token 文件构造
   Sidecar 专用 endpoint；绝不把 token 写入命令输出、状态 JSON 或进程参数；
3. 验证或启动 18791 Broker Proxy；启动参数只传 token 文件路径，Proxy 再
   独占经过认证的 18792 app-server；
4. 写入不含对话、endpoint token 和凭据的 Broker Proxy PID owner state；
5. 把 `127.0.0.1:18790` Sidecar 作为受监控子进程启动；
6. 只在同一 owner mutex 下消费显式 `Open` 发布的 fresh
   generation-bound intent；普通 vendor 根进程不会成为自动接管原因。若已明确
   授权 Desktop 重开，则从 Explorer medium token 执行最多一次受管交接。
   用户主动退出且没有新的显式 cause 时不自动重拉。Broker 或
   app-server 退出、失去精确 owner 或失去健康状态时，bootstrap 清除本次
   Remote intent、停止自己启动的 Sidecar 并失败关闭；计划任务
   `RestartCount=0`，不能自动重建 Broker/app-server。

冷启动握手分成两层：Sidecar 只要已经以受管身份连接同一 Broker，transport
层就完成并保持进程存活；在 Desktop 尚未接入时，请求级 `/ready` 仍保持
degraded，所有执行入口继续禁用。显式 `Open` 的控制器据此先确认稳定基础
设施，再向本次 Desktop 子进程注入 endpoint。不能反过来要求请求级 `/ready`
先通过，否则会形成“等 Desktop 才 Ready、等 Ready 才启动 Desktop”的
循环等待。

任务所有权还会核对当前用户 SID、`Interactive`/`Highest` principal、禁用的
触发器、`StartWhenAvailable=false`、`RestartCount=0`，以及电池、执行时限、单实例、
按需启动、空闲和网络等完整 settings。缺字段或 SID 无法解析都视为不匹配。任务
不存在时注册器不使用 `-Force`，因此同名创建竞态会失败而不会覆盖；精确 V2
到 V4 的旧受管定义只在可证明 lineage 下升级为 V5，运行中的旧定义要求
`-NoStart`，不能请求第二个任务实例；精确 V5 重复注册返回
`already-registered`。精确 V1 必须改用
`Migrate-CodexLocalRemoteSharedOwner.ps1`，外来同名任务始终拒绝覆盖。

Windows 任务对象的任务级 ACL/安全描述符会受目标机器、域和 Task Scheduler
服务规范化影响，不能在不同机器间作稳定的逐字节精确验证。本产品因此把同一
Windows 用户、`SYSTEM`、内置管理员和 Windows Task Scheduler 服务共同列入
本地可信边界；任务定义指纹用于防止误认和无意覆盖，不声称隔离这些主体。

注册脚本不会设置用户或机器级 `CODEX_APP_SERVER_WS_URL`。正式控制入口是
DataDir 下的稳定 dispatcher；计划任务中的 Desktop Owner Coordinator 只消费
显式 `Open` 发布的受管请求，不观察普通 vendor 启动来自动接管。coordinator
每次动态解析当前 Desktop，在受管 Broker 基础就绪时只向本次 Desktop
子进程注入带高熵能力路径和单次启动 nonce 的 loopback endpoint。Broker
只保留 nonce 的 SHA-256 摘要；启动器要求全部已初始化 Desktop 连接都属于
本次启动，并再次核对唯一根进程、运行代与启动回执后，才写入绑定 runtime、
精确 root identity 与 nonce digest 的 owner proof 并报告远程已连接。任何
检查失败、超时、旧连接、并发连接或 Remote 未运行都会清除继承值并保留
无 override 的原生 Desktop。重复安装会验证并复用同一个 token。显式控制
入口的 PowerShell 可以是 elevated，但 Desktop 创建必须由 coordinator 复制
同一用户、同一交互会话中 `explorer.exe` 的非 elevated medium-integrity
primary token；找不到唯一合格 token 时失败关闭，不能让 Desktop 继承 UAC
后的管理员 token。启动器从该 token 创建显式环境块，移除所有继承的
`CODEX_APP_SERVER_WS_URL`，再按本次结果加入一次性 endpoint；环境块用后清零，
父进程环境保持不变。冷启动会给动态版本发现、
Broker 与 Sidecar 最多 30 秒完成
基础握手，避免在服务仍正常启动时过早回退。历史安装若留下本项目可证明的持久 override，升级时只做一次
精确恢复/清理；第三方值或无法证明的状态绝不覆盖。

Broker 接受 Desktop 身份时还要求本次受管启动的 nonce；没有 nonce 的
Desktop-class 初始化以 WebSocket 1008 失败关闭。单独看到一个原生 Desktop
连接或施工期临时 bridge，不能将其提升为 owner proof 或正式 Ready。

按需计划任务与 dispatcher 调用的 PowerShell 都以隐藏窗口运行，不应留下
长期可见的终端。显式 `Open` 的严格结果以
`desktop-launch/v2` 白名单字段持久化到 `desktop-launch-last.json`，只包含
状态、失败阶段/代码、关联 id 与反馈状态，不保存异常正文、命令行、本机路径
或凭据。requester 的原始结构化失败阶段/代码必须贯穿受限原生补偿和最终
回执，不能被归一成 `unexpected/unexpected`。远程失败显示警告色“远程启动
失败”，不能用成功状态掩盖降级。状态页读取该回执，但历史回执不能冒充当前
就绪状态。

在任何 token、环境备份、运行状态或递归 ACL 写入前，脚本必须先证明
`<DataDir>` 归本项目所有。首次安全创建/接管会以 `CreateNew` 临时文件和
不覆盖 rename 原子发布
`<DataDir>\.codex-local-remote-data-owner.json`；marker 精确绑定规范路径、
当前用户 SID、版本、签名和实例 GUID。损坏、错签名/版本/路径/SID 的
marker，以及 marker 自身是 reparse point、hard link 或异常大文件时都会
失败关闭，绝不覆盖。

不存在的目录和不位于 Git 仓库/系统广义目录的空自定义目录可以首次 claim。
非空自定义目录没有 marker 时默认拒绝。只有精确的默认
`%LOCALAPPDATA%\CodexLocalRemote` 可以迁移认领旧安装，而且根目录只接受
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
# 在管理员 PowerShell 中执行。
.\scripts\windows\Register-CodexLocalRemoteStartup.ps1 -NoStart
```

注册器不会让计划任务直接执行 Git 工作树。它先把 `package.json`、Broker/
Sidecar 独立 bundle、Web `dist` 和 Windows 脚本复制到
`%LOCALAPPDATA%\CodexLocalRemote\RuntimeVersions\<content-sha256>`，写入并
回读 `runtime-manifest.json`。manifest 记录源码 commit、dirty 状态以及每个
文件的大小和 SHA-256；任务与稳定 dispatcher 只在验证通过后指向该不可变目录。
`runtime-current.json` 原子保留当前和上一版的目录与 manifest hash。

登记只安装并选择候选，不会启动 Remote，也不会启停 Desktop、Broker 或
Sidecar。通过稳定 dispatcher 显式查看或打开：

```powershell
$control = Join-Path $env:LOCALAPPDATA `
  'CodexLocalRemote\control\CodexLocalRemote.Control.ps1'
& $control -Operation Status
& $control -Operation Open
```

`Open` 已健康时幂等零重启返回；符合兼容门的 Web/Sidecar 缺失或候选更新
优先只滚动公网层，Broker、app-server 与 Desktop 保持不动。只有它明确返回
`restart-required`，并且本次另有 Desktop 重开授权时，才可再次调用
`Open -AllowDesktopRestart`。若上一已验证运行代正在服务活动 turn，该调用返回
`restart-deferred` 并只登记一个隐藏 worker；产品继续在线，待所有 Broker 观测
任务空闲后，worker 经固定 dispatcher 重验 selected runtime 与原始 intent，再
完成至多一次受控交接。只有 intent、运行代、路径和存活进程声明全部一致时才复用
现有 worker；`Close` 或更新 intent 会让旧 worker 主动取消并释放单例，下一次
`Open` 不会被旧等待任务吞掉。V1 单 owner
的历史迁移器只用于明确的旧安装迁移，不是日常打开或更新入口。

注册器仍维护名为“Codex Remote（安全启动）”的受管快捷方式，但它只是兼容
既有使用习惯的可选显式 `Open -AllowDesktopRestart` 别名：目标是上述固定
DataDir dispatcher，不是 Desktop、源码目录或某个不可变运行代。普通 vendor
快捷方式始终原生；远程能力不依赖用户点击受管快捷方式。

可选的全局 AI 控制 skill 不让 dispatcher 自行派生第二个 `RunAs` 进程：`Status`
始终直接只读；`Open` / `Close` 在调用前检查当前 Windows token，已经提权就
直接同步执行，否则通过本机已启用的 Windows `sudo` 只执行一次同一 dispatcher。
这保留结构化结果、退出码、mutex 与 intent 的单一边界；提权不会扩大 Desktop
重开授权。

最终构建完成后的普通更新只登记待切换版本，无需立刻退出或重启 Codex
Desktop，也不得在登记阶段停止 Broker：

```powershell
# 构建、验证并把任务定义切到新的不可变目录；当前运行代保持不动。
pnpm build
# 在管理员 PowerShell 中执行注册。
.\scripts\windows\Register-CodexLocalRemoteStartup.ps1 -NoStart
```

当前正在运行的 bootstrap/Broker/Desktop/Sidecar 不会因“登记更新”被替换。
普通 vendor 入口、Codex 更新、Windows 重启和睡眠恢复始终保持原生，也不会
采用 selected 运行代。采用必须来自显式 `Open`；如果只需兼容的 Web/Sidecar
滚动更新，不得把它升级成 Broker/app-server/Desktop 重启。需要撤回待采用
版本时：

```powershell
.\scripts\windows\Rollback-CodexLocalRemoteRuntime.ps1
```

如需等待现有 Desktop 自然退出后无人值守采用 selected 运行代，可在确认任务
空闲后运行：

```powershell
.\scripts\windows\Complete-CodexLocalRemoteDeferredHandoff.ps1 `
  -WaitForNaturalDesktopExit
```

该模式不会关闭 Desktop，也不会在等待时停止当前运行链。它必须连续观察到
严格 CIM Desktop 根进程为 0 与 Broker 已断开，才执行一次接管；超时、Broker
不可达、unsafe task 或进程枚举异常均失败关闭。自然退出 worker 使用按规范化
DataDir 派生的专用 mutex 保证单例；启动时固定 expected runtime version/root，
等待结束及启动前再次核对。最终只接受 expected Broker root，且
launcher 返回的 IntentId 会成为 exact expected CorrelationId；
`desktop-launch/v2` 必须精确匹配该 IntentId，记录时间晚于本次启动开始；另一
worker 或无关启动写入的“新鲜”回执不能通过验收。

登记运行代切换时，`runtime-current.json` 会在有界、原子写入中保存旧任务的
完整 XML 前像及 SHA-256，并严格绑定旧运行代、任务名和路径；同时把当前
selected 任务的完整导出 XML 哈希绑定到 selected 运行代和路径。普通状态读取
只返回前像/绑定是否存在及摘要，不回显 XML。受管启动器会在停止任何旧进程前
逐项验证 selected 绑定；只要 forward Start 已经发出，即使计划任务状态或新
回执尚未可见，也会先有界反复取消该任务并清理 selected 运行代 owner，随后才
恢复并复核旧任务前像和 current 指针，避免延迟启动后效应或任务/指针混合状态。
首次注册、同运行代任务升级和 current 指针修复也进入同一事务：计划任务或
指针写入即使“已生效后抛错”，也必须通过实时 selected task/pointer/binding
联合审计才算成功；否则恢复并复核登记前捕获的精确基线，既有 current 任务不会
因 binding 持久写入失败而被停止或注销。

若现场已经有 selected 不可变运行代但尚未成为 active，新的登记会在任何
任务、指针、dispatcher 或运行目录写入前失败关闭，避免覆盖 rollback 祖先。
只有显式 pending-runtime 修复才会依据严格的活动 Broker 证据事务重建原
任务/指针对；证据缺失、冲突或不唯一时保持零写入。切换停止旧任务后，
Sidecar 应当断开，因此 post-stop 屏障要求 `sidecarConnected=false`，同时
继续复核 Desktop、selected/active root、invocation、Broker/upstream 与
readiness。所选 Sidecar、Broker 或启动流程失败时，补偿路径恢复并验证旧
任务和旧指针，再有界启动精确旧运行代。

回滚同样只更新任务定义和 current/previous 指针，不终止当前 Desktop。切换后
用 `Get-CodexLocalRemoteStatus.ps1 -Json` 验证 `ImmutableRuntimeReady=true`、
`RuntimeVersionId`、`RuntimeRoot` 和 `PreviousRuntimeVersionId`。

注册器同时把实际 `SidecarPort`、`BrokerPort`、`BrokerUpstreamPort`、
`BasePath` 和任务名写入受保护的 `managed-config.json`。启动、状态、停止、
回滚和卸载在没有显式参数时都读取这份配置，因此现场使用 18795 等非默认
upstream 端口时不需要重复输入，也不会误回退到文档示例的 18792。

V5 bootstrap 复用旧 Broker 时不会只凭旧版本号放行。它先核对精确 Broker
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
缺失，也只检查 managed config 中记录的实际 upstream 端口，并仅停止命令、
Codex 路径、官方认证参数和固定 upstream token 文件都精确匹配的 orphan。
它绝不停止 Desktop 的独立
stdio 进程、18789、其他 Codex 进程或其他 Funnel。随后删除本项目受管的
legacy 快捷方式、dispatcher 与固定 `broker-capability.token`。新安装没有持久 Desktop 环境
需要恢复；对于历史安装，仅当环境备份、当前值与受管 endpoint 能形成完整
证明链时才精确恢复。若用户变量已被其他程序改写，卸载会拒绝覆盖新值并
报告冲突。

新版本会自动读取注册时保存的非默认参数；只有显式覆盖或恢复旧安装时才需要
再次传入完全相同的参数：

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

- `TaskOwned`：计划任务是否精确匹配动态 V5 签名、PowerShell bootstrap action、
  参数、工作目录，以及当前用户 SID、`Interactive` logon type 和 `Highest`
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
- 稳定 DataDir dispatcher 在每次分派前独立验证自身所有权和所选不可变
  运行代；这是 `Open`、`Close`、`Status` 的受支持入口，不能用历史 launcher
  字段替代这道验证；
- `LauncherScriptReady` / `LauncherShortcutReady`、`LauncherConfigured` /
  `LaunchMode`：仅用于识别和迁移历史 fail-open 安装，不参与当前受支持入口的
  Ready 判定；
- `DesktopLaunchReceiptReady` / `DesktopLaunchStatus` /
  `DesktopLaunchRemoteEnabled` / `DesktopLaunchDecision`：最近一次显式 `Open`
  是否留下了严格、无 token 的结果回执，以及当次是远程接入、原生补偿还是
  无有效回执；历史回执只解释最近一次启动，不冒充当前 `Ready`；
- `DesktopOwnerProofReady`：当前 active runtime、精确 Desktop root identity
  与 Broker launch nonce digest 是否匹配稳定 attach 后持久化的 owner proof；
  单独的 `DesktopConnected=true`、任意旧原生 root 或无 nonce 临时 bridge
  都不能提升为正式 Ready；
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
  Funnel、Broker、认证 upstream、Desktop、Sidecar、稳定 dispatcher 和
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
就让手机端停摆。启动任何新 Desktop 前，owner 会把活动 Broker/app-server
receipt 的 package path/hash/generation 与当前发现结果精确比较。Desktop
只有新的显式 `Open` 会在同一 V5 事务中核验并采用新基础栈；普通 vendor
入口只保持原生，不发布 intent、不调度 worker，也不接管。受控交接 worker
使用 nonce+PID/start 原子认领，只 compare-delete 自己的 IntentId；失败
suppression、受限补偿、通知/回执与任务补偿均一次性收敛。解析或校验失败则
报告 `blocked` 并停止新执行。若新 Desktop 不再接受
`CODEX_APP_SERVER_WS_URL`，或协议
能力探测失败，远程端必须显示兼容性降级并拒绝新执行，而不是建立第二个
手机专属 owner。此隐藏入口本身不是官方稳定合约，因此“自动发现”不能
等价为“保证未来每个版本都兼容”。

显式 `Open` 的 package refresh worker 在停止精确原生 Desktop 根前执行三次
安全观测，最后一次
紧贴 destructive stop。每次都要求严格 CIM 根身份不变、
`unsafeThreadCount=0`、Broker/runtime invocation 不变且 generation 为
`current`；任一观测未知、unsafe 恢复、连接恢复、根身份或运行代漂移都保持零
停止、零重启。

只有显式 `Open` 获得必要授权后的受管运行代采用才可使用 runtime restart；
它不是 Web/Sidecar 公网层恢复手段。该路径使用更晚的 post-task-stop barrier：先
`Stop-ScheduledTask` 并等待任务确实停止，再在 Sidecar/Broker stop 前重新执行
完整严格 CIM、selected/active root、runtime invocation、Broker/upstream PID、
`unsafeThreadCount=0` 与 `unknownCount=0` 联合检查。若此时状态改变，Sidecar 与
Broker stop 调用均保持 0，并启动精确 V5 任务补偿；不能因为计划任务已经停止就
继续使用过期的 pre-stop 结论。

## 睡眠与半开连接恢复

Broker 对每个配对连接的 Desktop 与 upstream 两腿分别执行 ping/pong heartbeat。
默认每 30 秒探测、每次 deadline 30 秒；必须连续两次 miss 才移除整个 half-open
pair，因此正常计时下最坏约 90 秒完成清理。Sidecar Supervisor 观察到共享
WebSocket 退出后按有界退避重连，并在新 session 重新绑定通知转发。

Windows 睡眠会造成 Node timer 长间隔。heartbeat sweep 发现超出容差的 timer gap
时不会沿用睡眠前 miss，也不会在唤醒瞬间立即关闭连接；它会清零两腿状态并马上
发起 fresh probe。唤醒本身不创建 Remote intent，也不授权停止或重开 Desktop、
Broker 或 app-server。只有既有显式租约中的 Web/Sidecar 满足约 3 秒连续兼容门，
才可滚动公网层；任何 reconnect、unsafe、Broker/app-server 丢失或运行代漂移
都失败关闭，并等待新的显式 `Open`。

上述行为已有定向自动化；发布证明仍必须绑定同一不可变候选，不能以源码测试替代
真实冷启动、公网、Desktop 同步或真实 Windows 睡眠/唤醒门。

独立终审已关闭 bound expected 与 post-task-stop barrier 两项 P1；主任务新鲜
定向 3 文件 98/98、reviewer 独立 2 文件 56/56 通过，最新终审为 PASS 且无剩余
P0/P1。最终 diff 复核补获并关闭 bound pointer 不可验证时的原生 fallback P1，
随后主任务 4 文件 118/118、reviewer 独立 1 文件 20/20 通过。这些是源码差异
证据；完整检查已单独通过，但两者都不代表上述真实运行态门已经通过。

Sidecar 另以 5 秒周期读取有界普通文件形式的 V5 启动/Broker 回执，并向
Broker 的回环 `/ready` 复核运行代号、Broker/upstream PID、
`DesktopConnected`、`SidecarConnected` 和未知客户端数。Desktop 包/启动回执
暂时无法验证时，只要精确 Broker 回执、实时三端连接与核心能力探针全部通过，
既有租约仍可发送；任何 Broker 身份不一致、真实 Desktop/Sidecar 断线、核心
探针失败或启动回执缺失/无效仍会把 app-server 设为 degraded 并暂停新执行。
Windows 监督器的包检查周期使用单调时钟，系统时间回拨不会把下一次复核卡在
未来。

## 浏览器

手机打开脚本返回的 HTTPS 地址，输入密码即可使用。PWA“添加到主屏幕”是
可选项，不影响完整功能。若公网网络阻断 Funnel 域名，应用本身无法绕过
运营商或网络策略；可另行配置同等安全的 HTTPS 反向代理。
