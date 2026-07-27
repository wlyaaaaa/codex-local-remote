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
unavailable.

Build the repository, run its targeted checks, configure one local password and the HTTPS route,
verify the local and public readiness endpoints, then verify that the same task is visible in
Desktop and the browser. Stop only when I must choose a password or project, approve public Funnel
exposure, complete an interactive login, or restart Desktop.
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
密码与 token。Remote 不可用时必须保持原生 Desktop 可正常启动。

构建项目并运行定向检查，配置一个本机密码和 HTTPS 路由，验证本机与公网 readiness，
再验证 Desktop 与浏览器能看见同一个任务。只有必须由我选择密码或项目、批准 Funnel
公网暴露、完成交互登录，或确实需要重启 Desktop 时才停下来。
```

The complete maintenance and upgrade contract is in
[ai-maintenance.md](ai-maintenance.md).
