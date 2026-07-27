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
> 首次 Desktop 切换、公网 Funnel 或重启 Desktop 时停下向我说明；其余安全、
> 可逆步骤自主完成。最后保持 Desktop 可原生启动，报告本地状态与公网入口，
> 在真实公网页面自动完成手机等效视口和宽屏关键路径验收，并保存证据；如果我
> 已明确授权公开发布，则通过自动发布门后继续提交、推送和发布，发布后再接收
> 我的持续反馈。

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
- 不得持久设置 `CODEX_APP_SERVER_WS_URL`。Desktop 只能从受管 fail-open
  启动器获得进程级变量。
- 冷启动必须允许 Broker 与 Sidecar 在 Desktop 接入前以传输就绪、执行禁用
  的状态持续运行；不要把请求级 `/ready` 当作启动 Desktop 的前置条件。
- Desktop 已连接、Sidecar 已连接或 Broker 仍有 active/pending/unknown
  任务时，不得停止 Broker。
- Web/Sidecar 更新优先热切换；Broker 与 Codex 新安装代等待自然重启窗口。
- 如果确实需要退出或重启 Codex Desktop，先停下并让真人确认；不要把一次
  管理员授权解释成自动重启授权。

## 自动安装

```powershell
pnpm install --frozen-lockfile
pnpm check
node apps/sidecar/dist/cli.js setup-password
.\scripts\windows\Register-CodexLocalRemoteStartup.ps1 -NoStart
```

密码必须由真人在本机交互输入。项目登记也必须使用真人明确给出的目录。
首次 Desktop 切换、Funnel 公网发布与 Desktop 重启仍是显式授权边界；产品
验收可由代理在真实页面自动完成，不再要求发布前真人重复点击。

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
关键路径点击并保存可复核证据。没有实际操作 Desktop 的能力时，必须把
Desktop 项标成有界替代证据而不是伪称点击通过。已有明确公开发布授权时，
自动发布门通过后直接发布；用户在发布后持续反馈真实设备和触控问题。
