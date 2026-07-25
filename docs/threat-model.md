# 威胁模型

## 1. 保护对象

- 本机 Codex/ChatGPT 登录状态；
- 项目源码、文档和生成结果；
- Codex 对话、工具输出与审批；
- 执行本机命令和修改文件的能力；
- Sidecar 密码、会话和审计元数据。

## 2. 信任边界

```text
不可信公网与浏览器内容
        │
        ▼
Tailscale Funnel / HTTPS
        │
        ▼
Sidecar 认证与授权边界
        │
        ├─ Codex app-server
        └─ 已注册项目根
```

Funnel 提供传输与公网入口，不替代应用认证。

## 3. 主要威胁与缓解

### 暴力登录

- 强密码哈希与随机盐；
- 单因素密码至少 15 个 Unicode 字符，鼓励使用长口令短语；
- 单来源、账户全局双重限速；
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
- 根目录包含判断使用路径分段而非字符串前缀；
- 拒绝 UNC、设备路径、ADS 和保留名称；
- 每一次目录下降与文件打开都相对原 canonical root 重新验证，下载还会核对
  已打开 handle 与最终路径的文件身份；
- 测试 junction/symlink、大小写、长路径与竞态。

### 公网 RCE

- 不暴露 app-server WebSocket；
- 不提供 shellCommand/process/spawn HTTP 端点；
- 审批保留明确的人类动作；
- 不提供永久全部批准；
- 文件网关只读；
- Sidecar 以当前用户而非 LocalSystem 运行。

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
- 在公网开放原始 app-server；
- 用字符串 `startsWith` 作为唯一目录 containment；
- 允许浏览器指定任意绝对路径；
- 在 Service Worker 中缓存对话或文件响应；
- 用 `dangerouslySetInnerHTML` 渲染模型内容；
- 为方便而默认自动批准全部工具。

## 5. 发布门槛

- 登录、CSRF、Origin、会话、XSS 和路径测试通过；
- 真实 Funnel 入口未认证返回登录页而非数据；
- 未授权 API 返回统一 401/403；
- 公开仓库 secret scan 无发现；
- 运行目录位于仓库外；
- README 清楚说明公网执行风险和边界。
