# 交给 AI 安装与维护

把本文件和仓库根目录交给本机 AI 即可。AI 应按下面的短合约工作。

## 一段提示词自动接入

把仓库克隆到 Windows 电脑后，在 ChatGPT / Codex Desktop 中打开仓库，并
直接发送下面这段提示词：

> 请读取本仓库 `AGENTS.md`、`README.md`、`docs/ai-maintenance.md` 和
> `docs/windows-install.md`，在保留现有改动的前提下自动安装或升级
> ChatGPT / Codex Local Remote。先只读检查 Windows、当前 Desktop 随附
> app-server、端口、现有 Broker/Sidecar、Tailscale 与项目配置，再运行
> `pnpm check`；不要使用独立 CLI 会话冒充 Desktop，不要永久设置
> `CODEX_APP_SERVER_WS_URL`，不要打印或记录密码/token。需要密码、项目目录、
> 公网 Funnel 或显式 Open 证明必须执行一次 Desktop 交接时停下向我说明；其余
> 安全、可逆步骤自主完成。普通 vendor 启动、Codex 更新、Windows 重启和睡眠
> 恢复必须保持原生；Remote 只通过固定 dispatcher 的显式 Open 启动。最后报告
> 本地状态与公网入口，亲自在 Desktop、本机 Web、真实公网和手机等效视口完成
> 关键路径点击并保存证据；如果我已明确授权公开发布，则通过自动发布门后继续
> 提交、推送和发布，发布后再接收我的持续反馈。

## 开始

1. 读取仓库根目录 `AGENTS.md`。
2. 只读运行 `git status --short` 和
   `.\scripts\windows\Get-CodexLocalRemoteStatus.ps1 -Json`。
3. 保留用户已有改动；公开内容不得包含主机名、密码、token、Cookie、真实
   对话、私人路径或截图。
4. 修改前先写失败回归，完成后至少运行 `pnpm check`。

例行状态命令为了保持有界，只比较当前 Desktop package generation 元数据与
Broker 启动时已经完成完整 hash 校验的运行时回执，并批量读取 3 个受管端口。
真正启动或切换 Broker 时仍重新校验完整二进制 hash；不要把快速只读状态路径
复制到启动安全门禁。

## 运行边界

- 只允许一个回环 Broker 拥有一个 Codex app-server。
- Desktop 和 Sidecar 必须连接同一 Broker；不能用独立 CLI 后台冒充同步。
- 不得持久设置 `CODEX_APP_SERVER_WS_URL`。Desktop 只能从计划任务中的
  coordinator 获得进程级变量。
- 固定 DataDir dispatcher 是 Open/Close/Status 的唯一实现。`Status` 直接
  只读；Open/Close 在调用前判断 token，管理员直接执行，非管理员通过已启用
  Windows `sudo` 一次执行。dispatcher 不自行派生第二个 `RunAs` 进程。
- 受管快捷方式保留 `RunAs`，但只作为固定 dispatcher 的可选
  `Open -AllowDesktopRestart` 别名，不是 Desktop 或运行代入口。
- coordinator 必须从同一用户、同一交互会话的 `explorer.exe` 取得非 elevated
  medium-integrity primary token，并用它创建精确 attached Desktop；Desktop
  不能继承管理员 token。
- Desktop 显式环境从该 primary token 构造，先移除继承的 override，再按本次
  结果加入一次性 endpoint。用真实子进程环境回读验证 endpoint 只存在于远程
  子进程，并保留无 token 启动回执。
- `Interactive` / `Highest` 计划任务中的 Desktop Owner Coordinator 必须是
  唯一受管进程 owner，同时监督 Broker、app-server、Sidecar 与文件权限。任务
  没有登录触发器、missed-trigger catch-up 或自动重启。
- 普通 ChatGPT / Codex vendor 入口、Codex 更新、Windows reboot 和
  sleep/resume 始终原生，不能发布 intent 或成为 takeover cause。
- 显式 Open 已 ready 时零重启；Sidecar/Web 缺失或存在兼容更新时只滚动公网
  层；只有一个 native Desktop 且不能热注入时先返回 `restart-required`，
  `Open -AllowDesktopRestart` 才能关闭精确根并启动任务一次。
- 若已验证的上一运行代仍在线服务活动 turn，未授权的 Open 返回
  `restart-required`；授权后的 Open 只登记一个隐藏 worker 并返回
  `restart-deferred`。这里的 deferred 只表示把控制移出即将关闭的 Desktop 宿主；
  worker 会立即经稳定 dispatcher 重新校验 selected runtime 与原始 intent，并在
  活动 turn 尚未结束时完成至多一次已授权交接；
  只复用 intent、运行代、路径和存活进程声明完全一致的 worker；`Close` 或更新的
  intent 会让旧 worker 主动取消并释放单例，后续 Open 不会复用已撤销的等待任务。
- Open 失败只执行一次有界补偿：未产生安全任务时停止本次启动的任务并恢复
  native Desktop；期间出现受管活动任务时保留 Broker 并发布一次恢复 intent。
  禁止失败后循环、重复 intent 或重复 Desktop root。
- 冷启动必须允许 Broker 与 Sidecar 在 Desktop 接入前以传输就绪、执行禁用
  的状态持续运行；不要把请求级 `/ready` 当作启动 Desktop 的前置条件。
- 包/启动回执的 `runtime-check-blocked` 不能单独推翻一个精确、实时且核心探针
  已通过的 Broker 租约；缺失/无效回执、真实连接丢失或核心探针失败仍失败关闭。
- Desktop 包周期复核使用单调时钟；不能让系统时间回拨无限延后下一次健康检查。
- Desktop 已连接、Sidecar 已连接或 Broker 仍有 active/pending/unknown
  任务时，不得停止 Broker。
- `-NoStart` 只登记不可变候选，不能启停现有 Desktop/Broker/Sidecar。
- Web/Sidecar 更新在 compatibility id 与 selected/Broker/upstream/Desktop
  不变量全部通过、未知连接为零且旧 Sidecar 已完成写请求排空时热切换并可回滚；
  active task 继续由 Broker/app-server 持有，不再阻塞公网层更新。Broker、
  app-server 或不兼容代必须等待新的显式 Open 决策。
- “打开远程”本身只授权必要时至多一次 Desktop 受控交接；普通管理员授权、
  安装、更新、重启或后台维护都不构成这项授权。

## 自动安装

```powershell
pnpm install --frozen-lockfile
pnpm check
node apps/sidecar/dist/cli.js setup-password
# 以下注册命令必须由管理员 PowerShell 或 Windows sudo/UAC 执行。
.\scripts\windows\Register-CodexLocalRemoteStartup.ps1 -NoStart
```

密码必须由真人在本机交互输入。项目登记也必须使用真人明确给出的目录。
Funnel 公网发布与显式 Open 所需的一次 Desktop 交接仍是授权边界。

## 验收

自动验收应覆盖：

- 本地和公网 Web 登录；
- Desktop/Web 两个浏览器客户端的同一线程与轮次 ID；
- 项目对话与无项目对话都在 Desktop 侧栏可见；
- 实时文字、命令、文件变更、子智能体、审批、结构化提问、引导、排队和停止；
- 动态模型、思考、速度、权限、审批与计划选项；
- 额度刷新、UTC+8 重置时间、上下文、对话 ID 和额度不足提示；
- 长对话输入与滚动；
- Sidecar 失联不影响 Desktop，Broker 停止保护不打断 Desktop 或运行任务；
- Codex 更新漂移只报告 `update-pending` 或兼容性错误，不静默改用 CLI。

自动项全部通过后，保持服务运行，在真实公网候选版本完成 412×915 与宽屏
关键路径点击并保存可复核证据；主任务还必须亲自打开并点击真实 Desktop 与
本机 Web。没有实际操作能力时保持 BLOCK，不能用协议测试、demo、HTTP 200、
截图或子任务报告替代。已有明确公开发布授权时，自动发布门通过后直接发布；
用户在发布后持续反馈真实设备和触控问题。
