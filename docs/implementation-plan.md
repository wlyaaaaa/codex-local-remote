# 实施计划

## 阶段 0：协议与仓库基线

- 建立 TypeScript/pnpm monorepo；
- 生成并固定当前 Codex app-server schema；
- 实现 stdio JSON-RPC 客户端、超时、取消、重启和 fixture；
- 能力探测与领域 DTO；
- 建立 CI、lint、typecheck、unit 和 Playwright 基线。

验收：在没有真实 Codex 时 fixture 测试通过；有 Codex 时可初始化、读取
模型和额度。

## 阶段 1：安全 Sidecar

- 本机交互式设置密码；
- scrypt/Argon2id 等级哈希；
- 登录、会话、CSRF、Origin、限速与日志最小化；
- 本机项目授权注册，以及仅供历史归类的 thread cwd 发现；
- 安全文件网关；
- 静态 PWA 与 SSE。

验收：安全负面测试全部通过，未认证访问不能读取任何项目或线程数据。

## 阶段 2：完整托管对话

- 线程列表/read/start/resume；
- turn start/steer/interrupt；
- 实时消息、思考摘要、工具聚合、文件变更；
- 审批和结构化输入；
- 模型、思考等级、额度与上下文；
- 断线补偿和快照恢复。

验收：手机视口在托管任务中完成新建、引导、停止、审批和恢复流程；桌面
快照不出现伪实时或伪控制入口。

## 阶段 3：子智能体与桌面快照

- 子智能体扁平列表；
- 实验性树/祖先增强与自动降级；
- 运行中/完成后详情导航；
- 父对话滚动恢复；
- 桌面原生线程只读快照与延迟标记。

验收：三层合成树和真实子智能体任务均可导航；不支持实验 API 时核心
对话仍工作。

## 阶段 4：产品化与发行

- 白底绿色设计系统；
- Android Chrome、小米级旗舰尺寸、微信/系统浏览器基础兼容；
- PWA 可选安装；
- 当前用户 `Interactive` / `Highest` 按需任务、隐藏运行、单实例与诊断；
- 普通 vendor 启动、Codex 更新、Windows 重启和睡眠恢复永远原生；固定
  DataDir dispatcher 承接显式 Open/Close/Status；
- 提供不带常驻控制台的可选“ChatGPT 远程”兼容入口；它只调用固定 dispatcher
  的显式 Open，不绑定 Desktop、源码目录或不可变运行代；
- `Interactive` / `Highest` 计划任务中的 coordinator 独占受管 Desktop
  process ownership，并从同会话 Explorer 的 medium-integrity primary token
  创建 attached Desktop；只有显式 Open 授权时才允许至多一次受控交接；
- 每次显式 Open 动态发现当前 Desktop/app-server；已 ready 时零重启，可兼容的
  Web/Sidecar 更新只滚动公网层，不兼容更新明确报警并 fail-closed；
- `-NoStart` 只登记内容寻址运行代；任务无登录触发、无 catch-up、无自动重启，
  登记不得改变活动 Desktop/Broker/Sidecar；
- Store 更新只更新发现结果，不接管普通 vendor 根；下次显式 Open 重新核对
  package path/hash/generation 与 Broker receipt；
- 诊断命令硬超时，单个状态源不可读时返回局部 unknown，不阻塞整体结果；
- Tailscale Funnel 增量路径安装；
- 公开安全复核、GitHub Actions、版本与升级说明。

验收：自动视觉矩阵、人工浏览器走查、本机端到端和公网 HTTPS 冒烟通过。

## 完成定义

- 需求矩阵中所有“可实现”项有代码、测试或真实运行证据；
- 不可实现项在 UI 与文档中没有误导性按钮；
- 浏览器不是日志面板，关键动作不依赖技术术语；
- 公开仓库无真实密码、主机、路径、对话和凭据；
- 现有 Funnel 根路由未被覆盖；
- 新任务首轮、更新后首次启动、启动通知、三端实时同步均有独立证据，不能用
  “进程存在”或“HTTP 200”互相替代；
- GitHub 仓库、CI 与本机部署状态均有可复核结果。
