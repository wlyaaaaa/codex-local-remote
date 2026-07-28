# 威胁模型

## 1. 保护对象

- 本机 Codex/ChatGPT 登录状态；
- 项目源码、文档和生成结果；
- Codex 对话、工具输出与审批；
- 执行本机命令和修改文件的能力；
- Sidecar 密码、会话和审计元数据。

本产品是单所有者工具，不是多用户协作服务。电脑浏览器与手机可以同时登录，
但两个会话具有相同权限；正常控制并发为一，互斥命令发生竞争时必须明确拒绝
后到请求。

## 2. 信任边界

```text
不可信公网与浏览器内容
        │
        ▼
Tailscale Funnel / HTTPS
        │
        ▼
Sidecar 认证与授权边界
        │ loopback WebSocket
        ▼
Desktop ── 本机 Broker ── 单一 Codex app-server
        │
        └─ 已注册项目只读文件网关
```

Funnel 提供传输与公网入口，不替代应用认证。公网只能到达 Sidecar 的产品
API；Broker 与 app-server 的原始 WebSocket 都只接受回环连接。

同一 Windows 登录用户、`SYSTEM`、本机管理员与 Windows Task Scheduler
服务属于本产品的本地可信边界。任务级 ACL/安全描述符会按机器和域被服务
规范化，无法跨机器作稳定的逐字节精确验证；计划任务的完整定义指纹用于防止
误认和覆盖，不声称隔离这些本地可信主体。
Desktop 兼容钩子的带能力回环 URL 只会短暂存在于 fail-open 启动器与它创建
的 Desktop 子进程环境中，不写入 HKCU 或机器环境。相同 Windows 用户仍能
读取受其账户保护的 token 文件或检查同用户进程，因此本项目不声称隔离同
用户恶意软件；不要让不受信任的人或服务共用这个 Windows 账号。其他本地
账号由 DataDir 的受保护 ACL 隔离。

## 3. 主要威胁与缓解

### 暴力登录

- 强密码哈希与随机盐；
- 单因素密码至少 15 个 Unicode 字符，鼓励使用长口令短语；
- 单来源、账户全局双重限速；额度在异步密码哈希开始前原子预留，验证完成或
  取消后结算，不能用并发 scrypt 请求绕过；
- 指数退避和临时锁定；
- 审计失败尝试但不记录输入值；
- 一致的失败响应，避免用户名或状态枚举。

### Cookie 或会话窃取

- Secure/HttpOnly/SameSite=Strict；
- 会话摘要落库；
- 空闲/绝对过期；
- 改密撤销全部会话；
- 严格 CSP、禁止内联脚本；
- 不缓存认证 API。

### CSRF 与跨站调用

- Origin allowlist；
- Fetch Metadata 验证；
- CSRF token；
- 所有状态变更使用非 GET；
- Funnel 路径前缀感知的 Cookie。

### XSS 与内容注入

- Markdown 禁用 raw HTML；
- 经过白名单 sanitize；
- SVG、HTML 和未知二进制不内联预览；
- 工具输出、ANSI、文件名与 diff 作为文本；
- CSP 禁止不需要的脚本、框架与对象。

### 路径穿越与 junction/symlink 逃逸

- API 只接受项目内相对路径；
- Windows 路径规范化和真实路径校验；
- 注册时持久化 canonical path 与目录的 device/file identity；每次文件访问和
  新建任务前重新核对，根被移动、替换或重绑定后立即失效；
- 最终文件物理路径还会再次检查敏感分段；指向 `.git`、`.codex`、`.ssh`、
  `.gnupg` 或 `node_modules` 的 junction/symlink 即使别名本身无敏感名称也拒绝；
- 根目录包含判断使用路径分段而非字符串前缀；
- 拒绝 UNC、设备路径、ADS 和保留名称；
- 每一次目录下降与文件打开都相对原 canonical root 重新验证，下载还会核对
  已打开 handle 与最终路径的文件身份；
- 无项目对话使用隔离、有界的 cwd，但不分配项目 id，也不进入文件
  网关；
- 测试 junction/symlink、大小写、长路径与竞态。

### 公网 RCE

- Broker 与 app-server WebSocket 只绑定回环地址，并拒绝非回环连接；
- Funnel 和其他反向代理只指向 Sidecar HTTP 入口；
- 不提供 shellCommand/process/spawn HTTP 端点；
- 审批保留明确的人类动作；
- 不提供永久全部批准；
- 文件网关只读；
- Sidecar 以当前用户而非 LocalSystem 运行。

### 订阅混淆与双 owner

- Broker 独占一个 app-server；Sidecar 断线时不启动独立 stdio 实例；
- Broker owner 租约以 data dir 的物理 `realpath` 为身份；junction/符号链接
  别名不能为同一物理目录取得第二份 owner 租约；
- Desktop 与 Sidecar 各自保持连接级订阅，不把广播的 `thread/started` 当作
  已订阅证明；
- 手机第一轮先完成隐藏 `thread/name/set` 持久化和 Desktop
  `thread/resume` 屏障，再放行 `turn/start`；
- Desktop 不在线、订阅超时或屏障期间断线时失败关闭；
- Broker 注入的 RPC id 使用保留前缀，客户端伪造会被拒绝，隐藏响应不会
  转发给产品客户端；
- 重连只补订阅已加载任务，不通过冷恢复创建第二个执行 owner。

### Desktop 兼容层漂移

- Windows 集成只在一次 Desktop 子进程范围内注入回环
  `CODEX_APP_SERVER_WS_URL`，不持久化用户或机器环境；
- 启动器先清除继承的 override；Broker 缺席、身份不匹配、超时或版本漂移
  时直接走无 override 的原生 Desktop 分支；
- 共享启动后必须等待同一 Broker 运行代的 Desktop attach 回执；预检后发生
  故障时，只能对启动器本次创建且身份仍精确一致、尚未承载用户工作的进程
  执行最多一次原生回退，绝不终止既有 Desktop；
- 升级/卸载只对能精确证明属于历史版本的持久 override 做恢复或清理，绝不
  猜测、覆盖第三方后来写入的值；
- Desktop 或随附 Codex 升级后，必须重新执行同实例、实时订阅和故障路径
  的实机验收；
- 未验收版本明确降级，不静默回退到独立 app-server。

### 安装、更新与回滚

- 注册前从当前构建生成内容寻址的不可变运行目录，目录 id 是清单中文件内容的
  SHA-256；清单另行记录源码 commit、dirty 状态、文件大小和逐文件 SHA-256；
- 计划任务和“Codex Remote（安全启动）”快捷方式只指向已完成清单回读验证的
  不可变目录，不直接执行可变 Git 工作树；
- `runtime-current.json` 原子保存当前版本、上一版本及两个 manifest hash；
  状态查询和卸载会重新验证指针与全部文件，篡改后失败关闭；
- 更新任务定义不会替换当前正在承载 Desktop 的进程；下一次自然启动才使用
  新版。`Rollback-CodexLocalRemoteRuntime.ps1` 同样只切换下一次启动版本；
- 卸载在第一次 mutation 前先验证 Desktop 已断开、活动/未知轮次为零、Broker
  listener/PID/命令/状态和 `/ready` 一致，预检失败时不先停止任何组件。

### Sidecar 或手机断线

- Broker 独立拥有 app-server 生命周期，Sidecar 退出不终止 Desktop 任务；
- 手机恢复前禁用实时变更动作，重连后按事件序号和持久化状态校正；
- Broker 或 app-server 失效时拒绝新的执行请求，不伪装成仍可用。

### 排队正文泄露或重复发送

- 待发送提示词只通过子进程 stdin 进入 Windows 当前用户 DPAPI，不出现在
  命令行参数、日志、SSE 或审计事件；落盘只保存有界密文；
- outbox 使用原子替换、每任务 FIFO、revision 冲突检查和串行 claim；
- `turn/start` 使用稳定 client id 对账；发送边界不明时标记 ambiguous，
  不自动重试，也不声称 exactly-once；
- 浏览器不能把 Sidecar 队列冒充为 Desktop 原生未发送队列。

### Desktop 本地置顶状态

- app-server 不暴露任务置顶；Sidecar 只从 `initialize.codexHome` 派生
  Desktop 全局状态文件，不接受浏览器提交路径；
- Reader 只接受本机绝对非根目录，用 `lstat`、`realpath` 和句柄的 bigint
  文件身份拒绝重解析点及换绑；同一只读句柄循环读到 EOF 或 2 MiB + 1，
  临时不可用时的 last-valid 仅保留 5 秒，再只提取最多 100 个
  `pinned-thread-ids`；限制原始数组、单个 id 和补取并发，不记录、返回或
  复制其他全局状态字段；
- Web 只读镜像置顶成员和顺序，不写 Desktop 文件，也不伪造 pin/unpin
  API；
- 补取首屏外置顶任务只请求 `includeTurns: false`，并限制数量。

### 敏感数据进入公开仓库

- `.gitignore` 排除运行状态、数据库、环境与密钥；
- CI 执行 secret scan 和 fixture 隐私检查；
- 示例只使用合成路径、主机和对话；
- 发布前审查 Git 历史和新增二进制。

### 日志泄露

- 结构化日志默认只记录 request id、路由、状态和耗时；
- 不记录请求正文、查询中的路径全文、Cookie、Authorization、提示词、
  回复、文件内容或工具输出；
- 错误栈只在本机诊断模式输出并进行裁剪。

## 4. 明确不接受的设计

- 只靠 Funnel 随机 URL；
- 把真实密码写进 `.env` 后提交；
- 在公网开放原始 Broker 或 app-server；
- 为 Desktop 与 Sidecar 各启动一个 app-server，再把持久化历史冒充实时
  同步；
- 未通过 Desktop 订阅屏障就放行手机创建任务的第一轮；
- Desktop 缺席时仍在后台创建手机专属任务；
- 用字符串 `startsWith` 作为唯一目录 containment；
- 允许浏览器指定任意绝对路径；
- 让非项目临时目录进入文件网关；
- 在 Service Worker 中缓存对话或文件响应；
- 以明文或浏览器持久存储保存下一轮队列正文；
- 在发送结果不明时自动重试并可能重复提交；
- 用 `dangerouslySetInnerHTML` 渲染模型内容；
- 为方便而默认自动批准全部工具。

## 5. 发布门槛

- 登录、CSRF、Origin、会话、XSS 和路径测试通过；
- 真实 Funnel 入口未认证返回登录页而非数据；
- 未授权 API 返回统一 401/403；
- Broker 与 app-server 只监听回环，外部接口扫描不可达；
- 真实 Desktop 与 Sidecar 共用一个 app-server 的项目和非项目任务验收
  通过；
- Desktop 缺席时手机新建失败关闭，Sidecar 缺席时 Desktop 可独立完成
  任务；
- 公开仓库 secret scan 无发现；
- 运行目录位于仓库外；
- README 清楚说明公网执行风险和边界。
