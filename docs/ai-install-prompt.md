# Install with AI

You can give this public repository directly to ChatGPT / Codex Desktop. The AI should inspect the
machine first, preserve native Desktop behavior, and make only the changes needed for this host.

## English prompt

```text
Install or upgrade https://github.com/wlyaaaaa/codex-local-remote on this Windows PC.

First read AGENTS.md, README.md, docs/quickstart.md, docs/ai-maintenance.md, and
docs/windows-install.md. Inspect the current ChatGPT / Codex Desktop package, bundled Codex
runtime, existing project directory, ports, scheduled task, Broker, Sidecar, and Tailscale state
before changing anything.

Use the current Desktop-bundled Codex runtime only. Do not substitute a separate Codex CLI, do not
persist CODEX_APP_SERVER_WS_URL, do not expose the Broker or raw app-server publicly, and never
print or commit passwords or tokens. Preserve native Desktop fail-open behavior if Remote is
unavailable. Keep the `Interactive` / `Highest` scheduled task as the single Desktop owner
coordinator, but configure it for demand start with no logon trigger, missed-trigger catch-up or
automatic restart. Normal vendor launch, Desktop updates, Windows reboot and sleep/resume must stay
native. Install the stable DataDir control dispatcher for explicit Open, Close and Status
operations. The managed `RunAs` shortcut may remain only as an optional alias for explicit
`Open -AllowDesktopRestart`; it must point to the dispatcher rather than Desktop, a source checkout
or one immutable runtime. The coordinator must create an attached Desktop from the same-user,
same-session, medium-integrity Explorer primary token. Prefer a Sidecar/Web-only repair that keeps
Broker, app-server and Desktop unchanged. Close or restart Desktop at most once, and only after an
explicit Open grants that bounded handoff.

Build the repository, run its targeted checks, configure one local password and the HTTPS route,
register the sealed runtime with `-NoStart`, and verify that registration changed no live process.
Then verify local and public readiness and personally click through the same task and turn in
Desktop, local Web, public desktop Web and a mobile viewport. Stop only when I must choose a
password or project, approve public Funnel exposure, complete an interactive login, or authorize
the one bounded Desktop handoff that an explicit Open proves necessary.
```

## 中文提示词

```text
在这台 Windows 电脑上安装或升级
https://github.com/wlyaaaaa/codex-local-remote。

先阅读 AGENTS.md、README.md、docs/quickstart.md、docs/ai-maintenance.md 和
docs/windows-install.md。修改前先检查当前 ChatGPT / Codex Desktop 包、桌面版随附的
Codex 运行时、现有项目目录、端口、计划任务、Broker、Sidecar 和 Tailscale 状态。

只使用当前 Desktop 随附的 Codex 运行时；不要用独立 Codex CLI 假装桌面同步，不要持久化
CODEX_APP_SERVER_WS_URL，不要把 Broker 或原始 app-server 暴露到公网，也不要打印或提交
密码与 token。Remote 不可用时必须保持原生 Desktop 可正常启动。`Interactive` /
`Highest` 计划任务必须是唯一 Desktop Owner Coordinator，但必须按需启动，不得设置
登录触发、missed-trigger catch-up 或自动重启。普通 vendor 启动、Codex 更新、
Windows 重启和睡眠恢复必须始终保持原生。安装固定 DataDir 控制 dispatcher，统一
承接显式 Open、Close 和 Status。受管 `RunAs` 快捷方式只能作为可选的显式
`Open -AllowDesktopRestart` 别名，不能指向 Desktop、源码目录或某个不可变运行代。
attached Desktop 由 coordinator 从同用户、同交互会话的 medium-integrity Explorer
primary token 创建。优先只修复/更新 Web 与 Sidecar，保持 Broker、app-server 和
Desktop 不动；只有显式 Open 证明无法热接入并授予一次受控交接时，才可关闭并重开
Desktop 一次。

构建项目并运行定向检查，配置一个本机密码和 HTTPS 路由，以 `-NoStart` 登记已封存
运行代，并证明登记没有改变任何活动进程。随后验证本机与公网 readiness，并亲自在
Desktop、本机 Web、公网桌面 Web 与手机视口点击同一个任务和轮次。只有必须由我选择
密码或项目、批准 Funnel 公网暴露、完成交互登录，或显式 Open 证明必须执行一次受控
Desktop 交接时才停下来。
```

The complete maintenance and upgrade contract is in
[ai-maintenance.md](ai-maintenance.md).
