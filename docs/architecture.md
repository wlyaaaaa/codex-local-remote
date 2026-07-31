# 架构设计

## 1. 总体结构

Codex Local Remote 使用 TypeScript monorepo：

```text
apps/
  broker/              loopback WebSocket、多连接订阅屏障、app-server 生命周期
  sidecar/             当前用户级本机进程、HTTP/SSE、远程产品 API
  web/                 React/Vite PWA
packages/
  app-server-client/   WebSocket JSON-RPC、重连、版本与能力适配
  contracts/           浏览器与 Sidecar 之间的领域 DTO
  domain/              线程、turn、审批和事件投影
  security/            密码、会话、Origin/CSRF、路径策略
  ui/                  设计系统和通用组件
tests/
  protocol/
  security/
  e2e/
```

React 不得导入 app-server 原始类型。Sidecar 协议适配器将原始通知转换成
稳定、带版本的领域事件；Broker 只处理连接、RPC 关联与订阅屏障，不承担
产品投影。

## 2. 进程

### Broker

- 以当前 Windows 用户身份运行，并发现 Codex Desktop 随附的 `codex.exe`；
- 启动并独占一个受监督的 app-server；
- Broker 与 app-server 的两个 WebSocket 监听器都只绑定回环地址；
- 为 Desktop 和 Sidecar 分别建立上游连接，保留 app-server 的按连接订阅
  语义；
- 识别 Desktop peer 与 Sidecar，维护每个连接的已订阅任务集合；
- 拦截自己注入的隐藏 RPC 响应，不将实现细节泄露给任何产品客户端；
- app-server 退出时关闭全部连接并进入不可用状态；只有 Broker 的受管停止
  流程可以终止它。

### Codex Desktop

- 通过 fail-open Windows 启动器按进程注入的
  `CODEX_APP_SERVER_WS_URL` 连接 Broker；
- 始终由同一用户、同一交互会话的 medium-integrity Explorer primary token
  创建，不继承安全入口或计划任务的 elevated token；
- 与 Sidecar 使用同一个 app-server，但保持独立连接和订阅集合；
- Sidecar 不在线时仍可独立创建和继续任务；
- Broker 未就绪时，启动器不注入 override，Desktop 仍从原生入口正常启动；
- Desktop 或随附 Codex 升级后，必须重新验收隐藏 WebSocket override。

### Sidecar

- 在显式 Remote 租约内以当前 Windows 用户的 `Highest` 运行级别运行；
- 默认监听 `127.0.0.1`，提供认证后的 REST、SSE 和 PWA 静态资源；
- 作为单独的 WebSocket 客户端连接 Broker，不拥有或终止 app-server；
- 将 app-server 通知投影为浏览器领域事件；
- 提供经过应用认证的所有者文件管理器，以后台受管任务的管理员令牌枚举和
  管理已检测磁盘。

默认不注册 `LocalSystem` 服务。发行版使用当前用户的 `Interactive` /
`Highest` 按需计划任务；任务没有登录触发器、missed-trigger catch-up 或自动
重启。普通 vendor 启动、Codex 更新、Windows 重启和睡眠恢复都不会启动
Remote。显式租约内的 Desktop Owner Coordinator 独占受管 Desktop process
ownership，先启动 Broker 和 Sidecar，再从同一用户、同一交互会话的 Explorer
复制 medium-integrity primary token 创建 attached Desktop。这样既保留用户
凭据、配置、映射盘和 DPAPI 上下文，也让文件管理能力使用后台任务的管理员
令牌。Desktop 和后台控制面均不使用 `LocalSystem`。

## 3. 协议分层

### 稳定核心

- thread/start、resume、read、list、name/set；
- turn/start、steer、interrupt；
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
- Broker 原始公网传输；
- thread/shellCommand 和 process/spawn；
- 任意 config 写入；
- 未经应用认证的裸文件代理；
- 桌面私有 IPC。

### 连接与订阅

`thread/started` 是广播通知，但后续 turn/item 事件只发送给订阅该任务的
连接。Broker 因此不能把“看见任务 id”误判成“已经实时订阅”。

新任务的首轮按以下顺序执行：

1. Sidecar 发送 `thread/start`，只得到一个空任务壳；
2. Broker 尝试让其他已初始化连接执行隐藏的
   `thread/resume { excludeTurns: true }`；
3. 若 rollout 尚未出现，Broker 通过创建连接发送一次隐藏
   `thread/name/set`，用首条用户文本派生的有界标题触发持久化；
4. Broker 重试 Desktop 的 `thread/resume`；
5. 只有所有目标连接都通过订阅屏障，才向 app-server 转发
   `turn/start`；
6. app-server 接受第一轮后，Sidecar 才以 best-effort deep link 让
   Desktop 选中该任务。导航失败不影响同一连接已经收到的实时事件，但
   绝不能在空任务壳尚未持久化时提前导航。

隐藏 RPC 使用 Broker 保留的请求 id 前缀；客户端伪造该前缀会被拒绝。
Desktop 未连接、持久化失败、订阅超时或连接在屏障期间断开时，手机的
新建或首轮请求失败关闭，不产生一个只在手机可见的活动任务。

Desktop 创建的任务通过 `thread/started` 被 Sidecar 发现，Broker 同样为
Sidecar 补做 `thread/resume`。客户端初始化或重连时，还会对 app-server
报告的已加载任务做有界补订阅。

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
`Last-Event-ID` 重连。SSE 的传输 id 使用
`<sidecar-instance-id>:<seq>`，其中实例 id 每次 Sidecar 进程启动重新生成；
实例不匹配或事件已淘汰时，返回重置事件，浏览器重新读取线程快照。任务
详情响应同时携带绑定该次响应的
`snapshotEventCursor=<sidecar-instance-id>:<seq>`；收到详情的浏览器把这个
游标原样用于第一次 thread-scoped SSE，后续断线则改用自己最后收到的
`Last-Event-ID`。游标不依赖服务端按任务缓存，因此多个浏览器并发读取和其他
任务驱逐缓存都不能替换旧响应的水位。路由切换时，旧任务迟到的详情回调也
不能覆盖当前任务已经绑定的游标。这样页面切换、网络重连和 Sidecar 重启都
不会重复拼接旧正文，也不会漏掉详情请求与订阅之间的新事件。

所有可重试的命令携带 idempotency key 和可选预期 revision。

## 5. 数据持久化

本机状态文件采用原子替换写入，仅保存：

- 密码哈希参数；
- 会话哈希、创建/到期/最后活动时间；
- 电脑本机显式登记的项目白名单、显示元数据，以及绑定注册目录所需的
  canonical path、物理 realpath 与 device/file identity；
- 已知共享任务 id、客户端恢复所需的有界运行元数据；
- 下一轮队列的有界元数据、修订号和由 Windows 当前用户 DPAPI 加密的提示词；
- “无项目”对话所用隔离根的配置引用；
- 本地设置；
- 不含正文的审计事件。

已发送的对话正文、工具输出和文件内容仍由 Codex 与项目自身持有，不复制到
Sidecar 状态文件。唯一例外是尚未派发的下一轮队列正文：它只以 DPAPI 密文
写入原子 outbox，SSE 和日志只携带不含正文的摘要。隔离临时目录也不作为
可浏览项目公开。

Desktop 的任务置顶不属于 app-server 协议，而是 Electron host 的本地私有
状态。Sidecar 从 `initialize.codexHome` 派生
`.codex-global-state.json`，通过同一只读文件句柄限定最多 2 MiB，再从
解析结果中只提取最多 100 个有界、去重且保序的
`pinned-thread-ids`；主文件原子替换期间优先保留上一次有效快照，首次读取
时才回退 Desktop 自己维护的 `.bak`，旧备份不能覆盖较新的缓存。适配器不
写入文件、不记录内容，也不返回其他键。首屏列表之外的置顶任务只用
`thread/read { includeTurns: false }` 补元数据；项目筛选、搜索和后续游标
不会注入无关置顶任务。

## 6. 共享任务所有权

Desktop 与 Sidecar 是同一 app-server 的两个连接，不是两个任务 owner。
任何一端创建的任务都会被另一端订阅，并使用同一 `threadId`、`turnId` 和
rollout。实时事件、steer、interrupt、审批、模型、思考等级、上下文压缩与
子智能体都通过这条共享路径工作。

Broker 只协调连接与订阅，不代替 app-server 执行任务。Sidecar 断开不会
终止 Broker 或 app-server，Desktop 可以继续工作；Sidecar 重连后通过
loaded-thread 补订阅恢复共享视图。Broker 或 app-server 不健康时，Sidecar
明确降级并拒绝新的执行请求，不创建独立 stdio app-server 作为静默回退。
Sidecar 还会周期性严格核对受管启动回执、Broker 运行代号、Broker/upstream
进程身份和 `/ready` 中的 Desktop/Sidecar 连接状态；变化会发布诊断事件，
促使已登录浏览器即时刷新。任一回执缺失、身份不一致或 Desktop 断开都不能
维持“电脑在线”或放行新任务。

Broker 将每个已初始化 Desktop/Sidecar 连接的 `thread/loaded/list` 合并为
一个运行时并集，并把未知活动子线程补齐到顶层祖先。Sidecar 的第一页历史
列表始终并入这个活动并集；活动任务不受历史分页、来源模式或首页展示数量
限制。生命周期事件发布完整顶层 `thread.snapshot`，浏览器用它增删和更新
运行卡片，而不是靠定时轮询猜测。

模型和思考等级是下一轮参数。运行中的 turn 不会因 UI 选择变化而热切换。
界面将实际运行设置与“下一轮”草稿分开保存；后台刷新不会覆盖用户草稿，
只有成功启动下一轮后才消费它。若 app-server 没有提供可靠的实际模型或
思考等级，界面明确显示“未知”，且用户未主动选择时不会静默发送默认值。
界面只显示 app-server 公开提供的工作/推理摘要，不声称展示隐藏思维链。

### 下一轮队列

Desktop 的未发送输入属于 Electron 客户端私有状态，app-server 没有公开
队列 API。远程队列因此由 Sidecar 单独拥有：

- 每个任务使用 FIFO、单调 revision 和串行 claim；
- `turn/start` 携带稳定的 `clientUserMessageId`；
- 成功事件确认后删除已开始项；
- 进程在发送边界崩溃时先读取任务并按 client id 对账；
- 无法证明“已接收”或“未接收”时标记 ambiguous，停止自动重试；
- 非正常 turn 结束会暂停后续队列，避免错误后连续消耗。

这提供的是 at-most-once 偏好的故障边界，不声称网络分区下的数学
exactly-once。待发送项只在已登录 Web/手机之间实时可见；Desktop 会在真正
派发后通过同一 app-server 看到对应消息。

## 7. 项目与非项目对话

app-server 没有稳定的桌面 project/list。项目来源按优先级合并：

1. 本机显式注册的根目录；
2. thread/list 中存在且可访问的 cwd；
3. 可选的桌面状态导入适配器。

后两类来源只用于历史对话归类和展示，不写入项目白名单，也不能成为
新任务 cwd。只有第一类来源可作为手机新建项目任务的 cwd 并持久化。

移动端不能添加任意路径。添加或扩大根目录只能在本机设置界面完成。

用户也可以创建“不关联项目”的“无项目”对话。此类任务使用安装时配置的
隔离根作为 cwd，不伪装成已注册项目。缺少安全隔离根时，无项目新建请求
失败关闭。独立的文件管理器不从任务 cwd 推导权限。

## 8. 文件网关

文件页启动时并行探测本机盘符，将每个当前可访问的卷规范化为一个不透明
root id。文件请求携带 root id 和该磁盘内的相对路径。服务器：

1. 拒绝客户端提交的绝对、UNC、设备路径、ADS、保留名称和 `..`；
2. 在选定卷根内计算候选路径，并交给 Windows 以 Sidecar 的当前高完整性
   进程身份执行；
3. 不增加项目、隐藏文件、敏感目录、扩展名或 junction denylist；Windows
   ACL、文件占用和设备状态是唯一权限边界；
4. 对预览与下载应用类型、大小和并发限制，以安全 Content-Type 与
   `nosniff` 返回；
5. 对上传、新建、编辑、重命名、复制、移动和删除统一执行登录、同源、
   Fetch Metadata、CSRF 与幂等校验；
6. 同名目标默认返回冲突，覆盖必须显式选择；删除默认调用 Windows 回收站，
   永久删除必须显式选择并再次确认。

任务输出中的绝对文件路径不直接变成公网 URL。Sidecar 在确认文件存在后
生成当前进程内、短时、不可预测的不透明授权；预览/下载仍要求当前登录会话。
磁盘移除、网络卷断开或授权过期只让对应操作失败，不拖垮其他卷。

这是一项单所有者设计：拿到有效 Web 会话就等同拿到当前用户的管理员文件
操作能力。它不提供多用户 ACL 或浏览器级沙箱，也不把 Broker/app-server
的原始接口暴露出去。管理员令牌仍不能绕过未解锁 BitLocker、离线卷、未挂载
网络凭据或另一个 Windows 账号的加密边界。

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
来源和全局双重限速，达到阈值后临时锁定；并发额度在异步密码验证前原子
预留，验证取消或完成后再结算，不能通过同时发起大量 scrypt 绕过。

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

反向代理只指向 Sidecar HTTP 入口。Broker 和 app-server WebSocket 没有
公网路由，也不接受非回环客户端；Funnel 认证不能替代这一隔离。

## 11. Windows Desktop 兼容层

当前 Windows Desktop 会在启动时读取隐藏的
`CODEX_APP_SERVER_WS_URL` override。它只能进入由受管 coordinator 创建的单个
Desktop 子进程；安装流程不会把该变量写入 HKCU 或机器环境。普通 vendor
Desktop 没有 override，始终使用原生 app-server。

固定在 DataDir 的 control dispatcher 是唯一 Open/Close/Status 实现。它在
执行前验证 `runtime-current.json`、manifest hash、目标脚本大小/hash 和精确
计划任务绑定，再把 selected identity 带入同一个全局 operation mutex 内复核。
dispatcher 不自行派生 `RunAs` 第二进程：可选的个人 AI control skill 对 `Status`
直接只读，对 `Open`/`Close` 在调用前判断 token，管理员直接执行，非管理员
通过已启用的 Windows `sudo` 一次执行。因此输出、退出码、mutex 与 intent
只有一个执行体，提权也不扩大 Desktop 重开授权。

`Open` 的决策顺序固定：

1. Broker、Desktop 和 Sidecar 已在同一精确租约时幂等返回，零重启；
2. Broker/app-server/Desktop 身份稳定且只有 Sidecar/Web 缺失或存在兼容候选
   时，执行 Sidecar-only 事务，Broker 和 Desktop 不动；
3. 没有 Desktop 且按需任务为 `Ready` 时，启动 selected Remote owner；
4. 只有一个原生 Desktop 且无法热注入时，先返回 `restart-required`；仅
   `Open -AllowDesktopRestart` 才可关闭精确 PID/start identity、等待 Desktop
   与独立 stdio 完全排空，再启动任务一次。

计划任务没有任何触发器，`StartWhenAvailable=false`、`RestartCount=0`。
普通 vendor 启动、Codex 更新、Windows reboot 和 sleep/resume 不写 Remote
intent，也不会被 coordinator 观察为 takeover cause。Open 失败不会循环：
若它已经关闭 native Desktop，则有界停止由本次调用启动且尚无安全任务的任务，
恢复一个原生 Desktop；若期间出现受管活动任务，则保留同一 Broker 并只发布
一次恢复 intent。结构化失败状态不持久化异常文本、路径、endpoint 或 token。

`Close` 原子写入 Native desired mode 并停止公共 Sidecar，不停止或重开
Desktop。当前 attached Desktop 与 Broker 可以保持到 Desktop 自然退出；
supervisor 随后结束 Broker。下一次普通 vendor 启动仍为原生。

注册器保留“Codex Remote（安全启动）”名称作为兼容入口，使用
MS-SHLLINK `RunAsUser` 标志并指向固定 DataDir dispatcher 的
`Open -AllowDesktopRestart`。它不是 Desktop 入口，也不指向源码目录或某个
不可变运行代；日常控制不依赖用户点击它。只有能精确证明为本项目旧入口时
才事务升级或删除，foreign shortcut 始终失败关闭。

这个 override 不是稳定的公开 Desktop 合约。每次 Desktop 或随附
`codex.exe` 升级后，都必须在真实 Windows 会话中验证：

- 普通 vendor 启动仍为原生，显式 Open 以零次或至多一次已授权交接建立租约；
- Desktop 与 Sidecar 均连接同一个 Broker，且没有独立 stdio app-server；
- 项目对话和无项目对话都立即出现在 Desktop；
- 两端收到同一轮的实时事件，任务与轮次 id 一致；
- Desktop 缺席时手机新建失败关闭；
- Sidecar 缺席时 Desktop 仍能独立创建并完成任务。

未完成这些检查的版本只能标记为“可用但有限制”，不得凭协议单测推断兼容。
运行时每次动态发现当前包、随附 app-server 与能力目录并比较普通文件路径和
SHA-256，不保存 WindowsApps 版本目录，也不回退到 PATH 中的 CLI。

Remote 构建产物与 Windows 脚本安装到内容寻址的不可变
`RuntimeVersions/<sha256>`。原子 current/previous 指针保存 manifest hash；
受保护 managed config 保存端口、BasePath 和任务名。`-NoStart` 注册把
dispatcher、快捷方式、任务、pointer 与 desired mode 作为可补偿事务安装，
但不启停 Desktop、Broker 或 Sidecar。模糊 task/pointer/receipt lineage
失败关闭。

显式租约内可在严格 compatibility id 相等时执行 Sidecar-only 更新。事务前后
必须保持 selected root、Broker PID/start、invocation、upstream PID/start、
Desktop root identity 和连接状态不变，且 `unsafeThreadCount=0`、
`unknownCount=0`；失败时恢复旧 Sidecar 并复核同一不变量。Broker、app-server
或不兼容运行代需要一次新的显式 Open 决策，不能伪装成公网层更新。
