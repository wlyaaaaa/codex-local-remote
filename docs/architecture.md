# 架构设计

## 1. 总体结构

Codex Local Remote 使用 TypeScript monorepo：

```text
apps/
  sidecar/             当前用户级本机进程、HTTP/SSE、生命周期
  web/                 React/Vite PWA
packages/
  app-server-client/   stdio JSON-RPC、版本与能力适配
  contracts/           浏览器与 Sidecar 之间的领域 DTO
  domain/              线程、turn、审批和事件投影
  security/            密码、会话、Origin/CSRF、路径策略
  ui/                  设计系统和通用组件
tests/
  protocol/
  security/
  e2e/
```

React 不得导入 app-server 原始类型。协议适配器将原始通知转换成稳定、带
版本的领域事件。

## 2. 进程

### Sidecar

- 以当前 Windows 用户身份运行；
- 默认监听 `127.0.0.1`；
- 发现 Codex 桌面安装中的 `codex.exe`；
- 通过 stdio 启动一个受监督的 app-server 子进程；
- 提供认证后的 REST 与 SSE；
- 托管构建后的 PWA 静态资源。

默认不注册 `LocalSystem` 服务。发行版使用当前用户登录时启动的计划任务，
从而继承桌面 Codex 的凭据、配置、映射盘与 DPAPI 上下文。

### app-server

- 只使用默认 JSONL/stdio 传输；
- 不向局域网或公网开放 WebSocket；
- 启动后执行 initialize/initialized；
- 版本探测失败时进入可诊断的降级状态；
- Sidecar 退出时一并终止。

## 3. 协议分层

### 稳定核心

- thread/start、resume、read、list、name/set；
- turn/start，以及仅对 Sidecar 自己拥有的托管 turn 使用 steer、interrupt；
- turn/item/agent/tool/file-change 通知；
- model/list；
- account/read、rateLimits/read、usage/read；
- 审批与结构化输入 server request。

### 实验增强

- thread/turns/list、thread/items/list；
- parentThreadId、ancestorThreadId；
- collaborationMode/list；
- 子智能体树和分页历史。

实验增强必须有能力探测、运行时校验和扁平降级。

### 禁止暴露

- app-server 原始公网传输；
- thread/shellCommand 和 process/spawn；
- 任意 config 写入；
- 通用文件写入、删除或任意根目录；
- 桌面私有 IPC。

## 4. 事件模型

每个浏览器事件包含：

```ts
type RemoteEvent = {
  schemaVersion: 1;
  seq: number;
  type: string;
  emittedAt: string;
  threadId?: string;
  turnId?: string;
  payload: unknown;
};
```

Sidecar 为每个宿主维持有界 ring buffer。浏览器携带
`Last-Event-ID` 重连。事件已淘汰时，返回重置事件，浏览器重新读取线程
快照。

所有可重试的命令携带 idempotency key 和可选预期 revision。

## 5. 数据持久化

本机状态文件采用原子替换写入，仅保存：

- 密码哈希参数；
- 会话哈希、创建/到期/最后活动时间；
- 电脑本机显式登记的项目白名单、显示元数据，以及绑定注册目录所需的
  canonical path 与 device/file identity；
- 本地设置；
- 不含正文的审计事件。

对话正文、工具输出和文件内容仍由 Codex 与项目自身持有，不复制到
Sidecar 状态文件。

## 6. 两种线程模式

### 托管线程

由本 Sidecar 的 app-server 创建。支持实时事件、steer、interrupt、审批、
模型、思考等级、上下文与子智能体增强。

### 桌面快照

由另一个桌面 app-server 进程拥有。Sidecar 只能通过公开 thread/list/read
读取已经持久化的内容并定期刷新，不能订阅或控制 Desktop 当前正在运行的
turn。UI 必须显示只读与可能延迟状态。

## 7. 项目发现

app-server 没有稳定的桌面 project/list。项目来源按优先级合并：

1. 本机显式注册的根目录；
2. thread/list 中存在且可访问的 cwd；
3. 可选的桌面状态导入适配器。

后两类来源只用于历史对话归类和展示，不写入项目白名单，也不能成为
新任务 cwd 或文件网关根。只有第一类来源授予这两项能力并持久化。

移动端不能添加任意路径。添加或扩大根目录只能在本机设置界面完成。

## 8. 文件网关

文件请求携带 project id 和项目内相对路径。服务器：

1. 拒绝绝对路径、UNC、设备路径和 `..`；
2. 计算候选路径；
3. 解析真实路径；
4. 验证真实路径仍位于注册根；
5. 检查规范化注册根和目标路径的全部段，拒绝敏感目录与保留名称；
6. 应用大小、类型和并发限制；
7. 以安全 Content-Type 与 `nosniff` 返回。

目录列表本身也执行真实路径与 junction/symlink 越界检查。

## 9. 认证

用户交互只有一个密码。首次本机设置时生成随机盐并保存 scrypt/Argon2id
等级的强哈希。登录成功后签发随机会话，状态文件只保存会话摘要。

浏览器 Cookie：

- Secure；
- HttpOnly；
- SameSite=Strict；
- 有界 Path；
- 空闲与绝对过期。

写请求还需要可信 Origin、Fetch Metadata 和 CSRF token。连续登录失败按
来源和全局双重限速，达到阈值后临时锁定。

## 10. 反向代理

推荐：

```text
Funnel HTTPS 443 /codex-remote/ → http://127.0.0.1:<sidecar-port>/codex-remote
```

Sidecar 支持路径前缀，生成的资源、SSE、下载和 Cookie 路径均不能假设
部署在 `/`。Tailscale 的 `--set-path` 会剥离外部前缀，因此 target URL
必须再次带上规范 BasePath，后端才能继续按相同前缀提供资源和 API。

部署脚本必须采用增量路径配置，不能覆盖现有 Funnel 根处理器。
示例配置使用 `18790` 作为本机端口；实际安装会先检查占用并拒绝覆盖已有
监听器。
