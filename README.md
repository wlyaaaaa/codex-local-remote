# Codex Local Remote

> 在手机或任意现代浏览器中使用本机 Codex 桌面工作区的非官方、自托管远程客户端。

Codex Local Remote 由一个仅监听本机的 Sidecar 和一个移动优先的 PWA
组成。它通过 Codex 官方公开的 app-server 协议创建和托管对话，再由
Tailscale Serve/Funnel 或其他反向代理提供 HTTPS 入口。

Sidecar 启动 Codex Desktop 随附的独立 app-server；它与 Desktop 共享已
持久化的任务历史。远程创建任务的首轮落盘后，Sidecar 会让 Desktop 载入
同一个任务，避免先弹出没有内容的线程壳。实时事件、追加
要求和停止只适用于由 Sidecar 托管的 turn；Desktop 自身正在运行的 turn
只能作为可能滞后的只读快照查看。

项目以中文体验为先，界面采用白底绿色视觉。它不是远程桌面，也不是把
JSON-RPC 日志原样铺进网页。

## 可以做什么

- 从手机选择已注册的桌面项目并创建新对话；
- 查看全部已持久化历史；在托管对话中实时查看当前回复、思考摘要、工具
  活动、文件变更和审批；
- 在托管对话运行中追加要求、停止任务，并在下一轮更换模型或思考等级；
- 查看运行中或已完成的子智能体，进入详情后返回父对话；
- 查看 ChatGPT/Codex 额度窗口、重置时间、使用统计和线程上下文；
- 显示 Codex 自动或手动触发的上下文压缩状态；空闲托管对话还可手动发起，
  并按真实事件区分“已受理”和“已完成”；
- 浏览、预览和下载已注册项目内的文件；
- 查看 Desktop 原生对话已持久化的只读快照，明确提示可能延迟且不可控制
  当前 turn；
- 使用一个本地设置的密码登录，手机无需安装应用、扩展或 Tailscale；
- 在断线后恢复事件流、草稿、滚动位置和子智能体导航状态。

## 明确不能做什么

- 不能通过受支持接口控制桌面 App 进程中已经运行的当前回复；
- 不能在同一轮生成中热切换模型或思考等级；
- 不能显示模型隐藏的完整思维链；
- 不能保证所有中国大陆网络都能稳定访问某一个公网入口；
- 不提供任意磁盘、任意命令或 app-server 原始接口的公网代理。

## 架构

```text
手机/电脑浏览器
      │ HTTPS + SSE
      ▼
Tailscale Serve / Funnel
      │
      ▼
本机 Sidecar ── JSONL/stdio ── Codex app-server
      │
      ├─ 单密码登录、会话、限速、Origin/CSRF
      ├─ 项目白名单、文件只读网关
      ├─ 领域事件投影与重连
      └─ 最小化审计元数据
```

使用 Funnel 子路径时，配置 target 必须包含同一个 BasePath（默认是
`http://127.0.0.1:18790/codex-remote`）；Tailscale 会先剥离公网前缀，
这样 sidecar 最终仍能收到它所服务的前缀路径。

Sidecar 使用 Codex 桌面安装中可发现的 `codex.exe`，不要求用户使用
Codex CLI。开发环境可以用 PATH 中的 `codex` 作为兼容回退。

## 当前状态

首个公开版本可用，仍在持续补充跨版本兼容性。完整边界与验收标准见：

- [产品设计](docs/product-design.md)
- [架构设计](docs/architecture.md)
- [威胁模型](docs/threat-model.md)
- [功能边界矩阵](docs/feature-matrix.md)
- [实施计划](docs/implementation-plan.md)
- [Windows 安装与 Funnel](docs/windows-install.md)

## 安全原则

这是一个能够触发本机 Codex 操作的公网入口。默认实现遵循以下原则：

- app-server 永远不直接监听公网；
- 密码只以带随机盐的强哈希保存在本机运行目录；
- 浏览器使用 `Secure`、`HttpOnly`、`SameSite=Strict` 会话 Cookie；
- 登录失败会限速和临时锁定；
- 项目授权绑定注册时的 canonical path 与目录身份；根被移动、替换或改成
  junction 后，文件访问和新任务都会拒绝，直到电脑本机重新登记；
- 对话正文、文件内容和 Codex 登录凭据不复制到 Sidecar 数据库；
- Markdown、工具输出和文件名全部按不可信输入处理；
- 公开仓库只包含示例配置，不包含真实主机、密码或历史记录。

## 免责声明

本项目为社区非官方项目，与 OpenAI 或 Tailscale 无隶属、背书或合作关系。
Codex、OpenAI 和 Tailscale 是其各自权利人的商标。
