import type {
  ApprovalRequest,
  AuthSession,
  CollaborationModeOption,
  DiagnosticSnapshot,
  FileListing,
  ModelOption,
  ProductCapabilities,
  ProjectSummary,
  PublicBootstrap,
  SubagentSummary,
  ThreadDetail,
  ThreadSummary,
  UsageSnapshot,
} from "@codex-local-remote/contracts";

const now = Date.now();
const isoAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

export const demoBootstrap: PublicBootstrap = {
  schemaVersion: 1,
  productName: "Local Remote",
  basePath: "/codex-remote",
  configured: true,
  authenticated: true,
};

export const demoSession: AuthSession = {
  authenticated: true,
  csrfToken: "demo-csrf-token",
  expiresAt: new Date(now + 7 * 86_400_000).toISOString(),
  idleExpiresAt: new Date(now + 55 * 60_000).toISOString(),
};

export const demoCapabilities: ProductCapabilities = {
  appServer: "available",
  desktopSnapshots: "available",
  fileBrowser: "available",
  liveEvents: "available",
  subagents: "available",
  usage: "available",
};

export const demoProjects: ProjectSummary[] = [
  {
    id: "project-console",
    name: "mobile-console",
    rootLabel: "…/Projects/mobile-console",
    source: "registered",
    lastUsedAt: isoAgo(2),
  },
  {
    id: "project-notes",
    name: "research-notes",
    rootLabel: "…/Projects/research-notes",
    source: "registered",
    lastUsedAt: isoAgo(180),
  },
  {
    id: "project-site",
    name: "portfolio-site",
    rootLabel: "…/Projects/portfolio-site",
    source: "thread",
    lastUsedAt: isoAgo(1440),
  },
];

export const demoModels: ModelOption[] = [
  {
    id: "gpt-5.4",
    displayName: "GPT-5.4",
    description: "复杂开发与长程任务",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "ultra"],
    defaultReasoningEffort: "high",
    isDefault: true,
  },
  {
    id: "gpt-5.4-mini",
    displayName: "GPT-5.4 mini",
    description: "快速修改与日常问答",
    supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
    defaultReasoningEffort: "low",
    isDefault: false,
  },
];

export const demoCollaborationModes: CollaborationModeOption[] = [
  {
    id: "auto",
    displayName: "自动协作",
    description: "需要时自动安排子智能体",
    available: true,
  },
  {
    id: "single",
    displayName: "单智能体",
    description: "当前任务只由主智能体完成",
    available: true,
  },
  {
    id: "parallel",
    displayName: "并行协作",
    description: "适合可拆分的大型任务",
    available: true,
  },
];

export const demoThreads: ThreadSummary[] = [
  {
    id: "thread-active",
    title: "完成移动端控制台并验证响应式布局",
    projectId: "project-console",
    cwdLabel: "…/mobile-console",
    mode: "managed",
    state: "running",
    updatedAt: isoAgo(1),
    model: "GPT-5.4",
    reasoningEffort: "high",
    childCount: 3,
  },
  {
    id: "thread-approval",
    title: "升级依赖并修复构建警告",
    projectId: "project-console",
    cwdLabel: "…/mobile-console",
    mode: "managed",
    state: "waiting-for-approval",
    updatedAt: isoAgo(18),
    model: "GPT-5.4",
    reasoningEffort: "medium",
    childCount: 1,
  },
  {
    id: "thread-done",
    title: "梳理首页信息架构",
    projectId: "project-console",
    cwdLabel: "…/mobile-console",
    mode: "managed",
    state: "complete",
    updatedAt: isoAgo(245),
    model: "GPT-5.4",
    reasoningEffort: "high",
  },
  {
    id: "thread-snapshot",
    title: "桌面端历史：检查项目结构",
    projectId: "project-notes",
    cwdLabel: "…/research-notes",
    mode: "desktop-snapshot",
    state: "idle",
    updatedAt: isoAgo(320),
    model: "GPT-5.4",
    snapshotDelaySeconds: 42,
  },
  {
    id: "thread-snapshot-running",
    title: "Desktop 报告运行中：只读快照验收",
    projectId: "project-notes",
    cwdLabel: "…/research-notes",
    mode: "desktop-snapshot",
    state: "running",
    updatedAt: isoAgo(2),
    model: "GPT-5.4",
    snapshotDelaySeconds: 18,
  },
  {
    id: "thread-archived",
    title: "已归档：整理旧版远程控制方案",
    archived: true,
    projectId: "project-console",
    cwdLabel: "…/mobile-console",
    mode: "managed",
    state: "complete",
    updatedAt: isoAgo(2_880),
    model: "GPT-5.4",
    reasoningEffort: "medium",
  },
  {
    id: "unsafe-content-thread",
    title: "合成内容安全验收",
    projectId: "project-console",
    cwdLabel: "…/mobile-console",
    mode: "desktop-snapshot",
    state: "complete",
    updatedAt: isoAgo(360),
    model: "GPT-5.4",
  },
];

export const demoUnsafeThreadDetail: ThreadDetail = {
  ...demoThreads.find((thread) => thread.id === "unsafe-content-thread")!,
  items: [
    {
      id: "unsafe-content-message",
      kind: "assistant-message",
      text: [
        "# 合成不可信内容",
        "<script>window.__codexRemoteXssProbe = true</script>",
        '<iframe src="javascript:window.__codexRemoteXssProbe=true"></iframe>',
        '<svg onload="window.__codexRemoteXssProbe=true"></svg>',
        '<img src=x onerror="window.__codexRemoteXssProbe=true">',
        "[危险链接](javascript:window.__codexRemoteXssProbe=true)",
        "![远程图片](https://example.invalid/tracker.png)",
        "普通 **Markdown** 仍应显示。",
      ].join("\n\n"),
    },
  ],
  availableActions: {
    changeModelNextTurn: false,
    interrupt: false,
    reply: false,
    steer: false,
  },
};

export const demoThreadDetail: ThreadDetail = {
  ...demoThreads[0]!,
  activeTurnId: "turn-current",
  availableActions: {
    steer: true,
    interrupt: true,
    reply: false,
    changeModelNextTurn: true,
  },
  items: [
    {
      id: "u-1",
      kind: "user-message",
      text: "把移动端首页和对话页做完整。重点检查 **412×915** 下的操作体验，并保留桌面三栏布局。",
      createdAt: isoAgo(34),
    },
    {
      id: "r-1",
      kind: "reasoning-summary",
      text: "我会先核对契约和页面结构，再搭建设计系统。移动端优先保证底部导航、固定输入区和审批抽屉不互相遮挡。",
      createdAt: isoAgo(33),
    },
    {
      id: "t-1",
      kind: "tool",
      title: "检查项目结构",
      status: "complete",
      summary: "读取了设计文档、契约和 18 个前端文件",
      occurrences: 4,
      createdAt: isoAgo(31),
    },
    {
      id: "t-2",
      kind: "tool",
      title: "更新界面组件",
      status: "complete",
      summary: "新增响应式布局、状态组件和安全 Markdown 渲染",
      occurrences: 12,
      createdAt: isoAgo(14),
    },
    {
      id: "f-1",
      kind: "file-change",
      path: "apps/web/src/App.tsx",
      change: "modified",
      status: "completed",
      diff: "@@ -24,2 +24,3 @@\n import { App } from './App';\n+import './styles.css';",
      additions: 248,
      deletions: 37,
      createdAt: isoAgo(12),
    },
    {
      id: "f-2",
      kind: "file-change",
      path: "packages/ui/src/styles.css",
      change: "added",
      status: "inProgress",
      additions: 326,
      deletions: 0,
      createdAt: isoAgo(11),
    },
    {
      id: "a-1",
      kind: "assistant-message",
      text: "首页、对话页和响应式骨架已经完成。现在正在补齐文件预览与断线恢复状态，随后会运行类型检查和构建。",
      createdAt: isoAgo(3),
    },
    {
      id: "t-3",
      kind: "tool",
      title: "验证前端构建",
      status: "running",
      summary: "正在执行类型检查与生产构建",
      occurrences: 2,
      createdAt: isoAgo(1),
    },
  ],
};

export const demoSubagents: SubagentSummary[] = [
  {
    threadId: "sub-ui",
    parentThreadId: "thread-active",
    title: "首页与导航",
    depth: 1,
    state: "complete",
    updatedAt: isoAgo(9),
    isDirectlyControllable: false,
  },
  {
    threadId: "sub-files",
    parentThreadId: "thread-active",
    title: "文件浏览与预览",
    depth: 1,
    state: "running",
    updatedAt: isoAgo(2),
    isDirectlyControllable: false,
  },
  {
    threadId: "sub-files-preview",
    parentThreadId: "sub-files",
    title: "安全预览策略",
    depth: 2,
    state: "waiting-for-approval",
    updatedAt: isoAgo(4),
    isDirectlyControllable: false,
  },
];

export const demoUsage: UsageSnapshot = {
  updatedAt: isoAgo(2),
  plan: "个人计划",
  windows: [
    {
      id: "five-hour",
      label: "5 小时额度",
      usedPercent: 38,
      remainingPercent: 62,
      resetsAt: new Date(now + 2.3 * 3_600_000).toISOString(),
    },
    {
      id: "weekly",
      label: "每周额度",
      usedPercent: 71,
      remainingPercent: 29,
      resetsAt: new Date(now + 3.4 * 86_400_000).toISOString(),
    },
  ],
  credits: [
    {
      id: "codex-credits",
      label: "Codex Credits",
      hasCredits: true,
      unlimited: false,
      balance: "18.50",
    },
  ],
  tokenUsageSummary: {
    lifetimeTokens: "128450320",
    peakDailyTokens: "4832100",
    longestRunningTurnSec: 1_842,
    currentStreakDays: 9,
    longestStreakDays: 24,
  },
  dailyUsageBuckets: [
    { startDate: new Date(now - 2 * 86_400_000).toISOString(), tokens: "1842000" },
    { startDate: new Date(now - 86_400_000).toISOString(), tokens: "2654000" },
    { startDate: new Date(now).toISOString(), tokens: "931000" },
  ],
  context: {
    usedTokens: 87_420,
    limitTokens: 200_000,
    usedPercent: 44,
  },
};

export const demoApprovals: ApprovalRequest[] = [
  {
    id: "approval-install",
    threadId: "thread-approval",
    turnId: "turn-install",
    title: "允许安装项目依赖？",
    explanation: "将联网下载锁文件中声明的依赖，只修改当前项目的依赖目录。",
    command: "pnpm install --frozen-lockfile",
    paths: ["package.json", "pnpm-lock.yaml"],
    choices: [
      { id: "allow", label: "允许这一次", tone: "primary" },
      { id: "deny", label: "拒绝", tone: "neutral" },
    ],
    questions: [
      {
        id: "install-scope",
        header: "安装范围",
        question: "这次允许安装哪些依赖？",
        isOther: true,
        isSecret: false,
        options: [
          { label: "仅安装锁文件中的依赖", description: "不主动升级版本" },
          { label: "先检查变更再安装", description: "发现锁文件漂移时停止" },
        ],
      },
      {
        id: "note",
        header: "补充要求",
        question: "还有需要智能体注意的内容吗？",
        isOther: false,
        isSecret: false,
      },
    ],
  },
];

export const demoFiles: Record<string, FileListing> = {
  "": {
    projectId: "project-console",
    relativePath: "",
    entries: [
      {
        name: "apps",
        relativePath: "apps",
        kind: "directory",
        modifiedAt: isoAgo(8),
        downloadable: false,
      },
      {
        name: "packages",
        relativePath: "packages",
        kind: "directory",
        modifiedAt: isoAgo(8),
        downloadable: false,
      },
      {
        name: "README.md",
        relativePath: "README.md",
        kind: "file",
        size: 4382,
        modifiedAt: isoAgo(74),
        downloadable: true,
      },
      {
        name: "package.json",
        relativePath: "package.json",
        kind: "file",
        size: 1260,
        modifiedAt: isoAgo(8),
        downloadable: true,
      },
    ],
  },
  apps: {
    projectId: "project-console",
    relativePath: "apps",
    entries: [
      {
        name: "web",
        relativePath: "apps/web",
        kind: "directory",
        modifiedAt: isoAgo(4),
        downloadable: false,
      },
      {
        name: "sidecar",
        relativePath: "apps/sidecar",
        kind: "directory",
        modifiedAt: isoAgo(6),
        downloadable: false,
      },
    ],
  },
  "apps/web": {
    projectId: "project-console",
    relativePath: "apps/web",
    entries: [
      {
        name: "src",
        relativePath: "apps/web/src",
        kind: "directory",
        modifiedAt: isoAgo(4),
        downloadable: false,
      },
      {
        name: "index.html",
        relativePath: "apps/web/index.html",
        kind: "file",
        size: 612,
        modifiedAt: isoAgo(5),
        downloadable: true,
      },
    ],
  },
};

export const demoDiagnostics: DiagnosticSnapshot = {
  generatedAt: new Date(now).toISOString(),
  version: "0.1.0",
  appServerVersion: "0.78.0",
  capabilities: demoCapabilities,
  listener: {
    host: "127.0.0.1",
    port: 39393,
    basePath: "/codex-remote",
  },
  warnings: [],
};

export const demoFileText = `# Local Remote

一个专注于移动浏览器体验的本机 AI 编程控制台。

## 设计原则

- 白色留出呼吸感，绿色只强调当前选择和主要行动。
- 运行、审批、失败与断线状态同时使用文字和图标表达。
- 所有主要触控目标至少为 44 × 44 CSS 像素。
`;
