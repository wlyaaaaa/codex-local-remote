import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import type {
  ApprovalRequest,
  AuthSession,
  CollaborationModeOption,
  DiagnosticSnapshot,
  FileEntry,
  FileListing,
  ModelOption,
  PermissionMode,
  ProductCapabilities,
  ProjectSummary,
  PublicBootstrap,
  ReasoningEffort,
  RemoteEvent,
  RunState,
  SubagentSummary,
  ThreadDetail,
  ThreadSummary,
  UsageCredits,
  UsageSnapshot,
} from "@codex-local-remote/contracts";
import {
  Button,
  Card,
  EmptyState,
  Icon,
  Progress,
  Sheet,
  Skeleton,
  StatusPill,
  type IconName,
  type StatusTone,
} from "@codex-local-remote/ui";
import { ApiRequestError, createApiClient, type ApiClient } from "./api";
import { authenticatedBootstrap, loggedOutBootstrap } from "./auth-state";
import {
  OTHER_ANSWER,
  approvalInputType,
  buildApprovalResolution,
  choiceRequiresAnswers,
  isApprovalQuestionAnswered,
  type ApprovalAnswerDrafts,
} from "./approval";
import { canDirectlyCompose } from "./permissions";
import { PaginationFooter } from "./PaginationFooter";
import { registeredProjects } from "./project-access";
import { WORKSPACE_REFRESH_MS, canRefreshDocument, threadRefreshDelay } from "./refresh";
import { mergeCursorItems, nextCursorAfterRefresh, type CursorPage } from "./pagination";
import { threadRuntimeSummary } from "./thread-runtime";
import {
  defaultReasoningEffortForModel,
  normalizeReasoningEffort,
  normalizeReasoningEffortForModel,
} from "./model-effort";
import { fileChangeStatusLabel, toolFallbackSummary } from "./terminal-display";
import {
  applyThreadRemoteEvents,
  applyUsageRemoteEvents,
  detailFromThreadSummary,
} from "./live-thread";
import {
  creditBalanceLabel,
  remainingFromUsedPercent,
  remainingPercentLabel,
  usedPercentLabel,
} from "./usage-display";

const api = createApiClient();

type LoadState = "loading" | "ready" | "error";
type MoreState = "idle" | "loading" | "error";
type DeferredLoadState = "idle" | LoadState;

type LiveEventEnvelope = {
  deliveryId: number;
  event: RemoteEvent;
  replayed: boolean;
};

const MAX_LIVE_EVENTS = 2_048;

type WorkspaceData = {
  projects: ProjectSummary[];
  models: ModelOption[];
  collaborationModes: CollaborationModeOption[];
  threads: ThreadSummary[];
  usage: UsageSnapshot | undefined;
  diagnostics: DiagnosticSnapshot | undefined;
  approvals: ApprovalRequest[];
};

const emptyWorkspace: WorkspaceData = {
  projects: [],
  models: [],
  collaborationModes: [],
  threads: [],
  usage: undefined,
  diagnostics: undefined,
  approvals: [],
};

const runLabels: Record<RunState, string> = {
  idle: "可继续",
  running: "运行中",
  "waiting-for-approval": "等待审批",
  failed: "失败",
  complete: "已完成",
};

const runTones: Record<RunState, StatusTone> = {
  idle: "neutral",
  running: "success",
  "waiting-for-approval": "warning",
  failed: "danger",
  complete: "neutral",
};

const effortLabels: Readonly<Record<string, string>> = {
  none: "无",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  ultra: "Ultra（最高）",
};

function effortLabel(effort: ReasoningEffort): string {
  return effortLabels[effort] ?? effort;
}

const permissionOptions: Array<{
  id: PermissionMode;
  title: string;
  description: string;
  icon: IconName;
}> = [
  { id: "ask", title: "按需询问", description: "敏感操作先向你确认", icon: "shield" },
  { id: "workspace-write", title: "可编辑项目", description: "允许修改当前项目文件", icon: "code" },
  { id: "read-only", title: "只读", description: "仅检查和回答，不改文件", icon: "file" },
];

function errorMessage(error: unknown) {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return "发生了未知错误，请稍后重试。";
}

function timeAgo(value?: string) {
  if (!value) return "时间未知";
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function absoluteTime(value?: string) {
  if (!value) return "暂时无法读取";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
  }).format(new Date(value));
}

function number(value?: number) {
  if (value === undefined) return "—";
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

function capabilityLabel(value: keyof ProductCapabilities) {
  const labels: Record<keyof ProductCapabilities, string> = {
    appServer: "Codex 服务",
    desktopSnapshots: "桌面快照",
    fileBrowser: "项目文件",
    liveEvents: "托管任务实时事件",
    subagents: "子智能体",
    usage: "额度信息",
  };
  return labels[value];
}

function capabilityTone(value: ProductCapabilities[keyof ProductCapabilities]): StatusTone {
  if (value === "available") return "success";
  if (value === "degraded") return "warning";
  return "danger";
}

function capabilityState(value: ProductCapabilities[keyof ProductCapabilities]) {
  if (value === "available") return "正常";
  if (value === "degraded") return "有限可用";
  return "不可用";
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="wordmark">
      <span className="wordmark__mark">
        <Icon name="terminal" size={compact ? 18 : 20} />
      </span>
      {compact ? null : (
        <span>
          <strong>Local Remote</strong>
          <small>桌面 AI 控制台</small>
        </span>
      )}
    </div>
  );
}

function Markdown({ children, compact = false }: { children: string; compact?: boolean }) {
  return (
    <div className={compact ? "markdown markdown--compact" : "markdown"}>
      <ReactMarkdown
        rehypePlugins={[rehypeSanitize]}
        skipHtml
        components={{
          a: ({ children: linkChildren, ...props }) => (
            <a {...props} rel="noreferrer" target="_blank">
              {linkChildren}
            </a>
          ),
          img: () => <span className="unsafe-content-note">图片链接已隐藏</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function LoadingPage() {
  return (
    <div aria-label="正在加载" className="page page--loading">
      <div className="page-heading">
        <Skeleton width="42%" />
        <Skeleton width="68%" />
      </div>
      <div className="loading-grid">
        <Card>
          <Skeleton />
          <Skeleton width="62%" />
        </Card>
        <Card>
          <Skeleton />
          <Skeleton width="76%" />
        </Card>
        <Card>
          <Skeleton />
          <Skeleton width="48%" />
        </Card>
      </div>
    </div>
  );
}

function Notice({
  tone = "info",
  icon,
  title,
  children,
  action,
}: {
  tone?: StatusTone;
  icon: IconName;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`notice notice--${tone}`}>
      <Icon name={icon} size={20} />
      <div>
        <strong>{title}</strong>
        <div>{children}</div>
      </div>
      {action ? <span className="notice__action">{action}</span> : null}
    </div>
  );
}

function AuthGate({
  bootstrap,
  onAuthenticated,
}: {
  bootstrap: PublicBootstrap;
  onAuthenticated: (session: AuthSession) => void;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isSetup = !bootstrap.configured;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (password.length < 15) {
      setError("访问密码至少需要 15 个字符，建议使用容易记住的长口令。");
      return;
    }
    if (isSetup && password !== confirmation) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    try {
      const session = isSetup ? await api.setup(password, confirmation) : await api.login(password);
      onAuthenticated(session);
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <div className="auth-panel">
        <Wordmark />
        <div className="auth-copy">
          <StatusPill tone="success">{isSetup ? "仅限本机首次设置" : "安全连接"}</StatusPill>
          <h1>{isSetup ? "设置访问密码" : "回到你的电脑"}</h1>
          <p>
            {isSetup
              ? "创建一个只用于这个控制台的密码。设置完成后，手机登录只需要它。"
              : "输入访问密码，查看项目、对话和需要你处理的审批。"}
          </p>
        </div>
        <form
          className="auth-form"
          data-testid="login-form"
          onSubmit={(event) => void submit(event)}
        >
          <label>
            <span>访问密码</span>
            <input
              autoComplete={isSetup ? "new-password" : "current-password"}
              autoFocus
              data-testid="login-password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="输入访问密码"
              type="password"
              value={password}
            />
            {isSetup ? (
              <small className="field-hint">至少 15 个字符；无需强行混合大小写或符号</small>
            ) : null}
          </label>
          {isSetup ? (
            <label>
              <span>再次输入</span>
              <input
                autoComplete="new-password"
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder="确认访问密码"
                type="password"
                value={confirmation}
              />
            </label>
          ) : null}
          {error ? (
            <div aria-live="polite" className="form-error">
              <Icon name="alert" size={18} />
              {error}
            </div>
          ) : null}
          <Button data-testid="login-submit" disabled={busy} type="submit" variant="primary">
            {busy ? "正在验证…" : isSetup ? "完成设置" : "登录"}
          </Button>
        </form>
        <p className="auth-footnote">
          <Icon name="shield" size={16} />
          密码不会发送给任何云服务
        </p>
      </div>
      <div aria-hidden="true" className="auth-visual">
        <div className="auth-orbit auth-orbit--one" />
        <div className="auth-orbit auth-orbit--two" />
        <div className="auth-visual__card">
          <Icon name="spark" size={28} />
          <span>本机入口已就绪</span>
          <strong>连接后继续你的任务</strong>
        </div>
      </div>
    </main>
  );
}

function ConnectionError({ onRetry }: { onRetry: () => void }) {
  function enableDemo() {
    window.localStorage.setItem("local-remote-demo", "1");
    window.location.reload();
  }

  return (
    <main className="center-state">
      <span className="center-state__icon center-state__icon--danger">
        <Icon name="wifi-off" size={28} />
      </span>
      <h1>暂时连不上电脑</h1>
      <p>确认电脑未休眠且公网入口正常，然后重新连接。已显示的离线页面仍可继续查看。</p>
      <div className="button-row">
        <Button icon="refresh" onClick={onRetry} variant="primary">
          重新连接
        </Button>
        <Button onClick={enableDemo}>打开演示界面</Button>
      </div>
    </main>
  );
}

function ThreadRow({ thread, compact = false }: { thread: ThreadSummary; compact?: boolean }) {
  return (
    <NavLink
      className={({ isActive }) => `thread-row ${isActive ? "is-active" : ""}`}
      data-testid={thread.id === "unsafe-content-thread" ? "unsafe-content-thread" : undefined}
      to={`/threads/${thread.id}`}
    >
      <span className={`thread-row__state thread-row__state--${thread.state}`} />
      <span className="thread-row__body">
        <strong>{thread.title}</strong>
        <span>
          {thread.mode === "desktop-snapshot" ? "桌面快照" : (thread.cwdLabel ?? "未关联项目")}
          {!compact ? ` · ${timeAgo(thread.updatedAt)}` : ""}
        </span>
      </span>
      {thread.state === "waiting-for-approval" ? <Icon name="alert" size={17} /> : null}
    </NavLink>
  );
}

const navItems: Array<{ to: string; label: string; icon: IconName; end?: boolean }> = [
  { to: "/", label: "首页", icon: "home", end: true },
  { to: "/threads", label: "对话", icon: "message" },
  { to: "/files", label: "文件", icon: "folder" },
  { to: "/settings", label: "设置", icon: "settings" },
];

function DesktopRail({ threads }: { threads: ThreadSummary[] }) {
  return (
    <aside className="desktop-rail">
      <div className="desktop-rail__brand">
        <Wordmark />
        <Button
          aria-label="新建对话"
          icon="plus"
          size="icon"
          variant="primary"
          onClick={() => {
            window.location.hash = "#/new";
          }}
        />
      </div>
      <nav aria-label="主导航" className="rail-nav" data-testid="primary-navigation">
        {navItems.map((item) => (
          <NavLink
            className={({ isActive }) => (isActive ? "is-active" : "")}
            data-testid={item.to === "/files" ? "files-open" : undefined}
            data-touch-target="primary"
            {...(item.end ? { end: true } : {})}
            key={item.to}
            to={item.to}
          >
            <Icon name={item.icon} size={19} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="rail-section-heading">
        <span>最近对话</span>
        <NavLink to="/threads">查看全部</NavLink>
      </div>
      <div className="rail-threads">
        {threads.slice(0, 6).map((thread) => (
          <ThreadRow compact key={thread.id} thread={thread} />
        ))}
      </div>
      <div className="rail-footer">
        <span className="connection-dot" />
        <span>已连接到电脑</span>
      </div>
    </aside>
  );
}

function MobileHeader({
  title,
  back,
  action,
}: {
  title: string;
  back?: boolean;
  action?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <header className="mobile-header">
      {back ? (
        <Button
          aria-label="返回"
          icon="arrow-left"
          onClick={() => navigate(-1)}
          size="icon"
          variant="ghost"
        />
      ) : (
        <Wordmark compact />
      )}
      <strong>{title}</strong>
      <span className="mobile-header__action">{action ?? <span />}</span>
    </header>
  );
}

function MobileNav({ approvalCount }: { approvalCount: number }) {
  return (
    <nav aria-label="主导航" className="mobile-nav" data-testid="primary-navigation">
      {navItems.map((item) => (
        <NavLink
          className={({ isActive }) => (isActive ? "is-active" : "")}
          data-testid={item.to === "/files" ? "files-open" : undefined}
          data-touch-target="primary"
          {...(item.end ? { end: true } : {})}
          key={item.to}
          to={item.to}
        >
          <span className="mobile-nav__icon">
            <Icon name={item.icon} size={21} />
            {item.to === "/threads" && approvalCount > 0 ? <b>{approvalCount}</b> : null}
          </span>
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

function ConnectionBanner({ online, demo }: { online: boolean; demo: boolean }) {
  if (demo) {
    return (
      <div className="demo-banner">
        <Icon name="spark" size={15} />
        演示数据
        <button
          onClick={() => {
            window.localStorage.removeItem("local-remote-demo");
            window.location.reload();
          }}
        >
          返回真实连接
        </button>
      </div>
    );
  }
  if (online) return null;
  return (
    <div aria-live="polite" className="offline-banner">
      <Icon name="wifi-off" size={16} />
      连接已中断，正在自动重连。实时操作暂不可用。
    </div>
  );
}

function UsageMini({ usage }: { usage: UsageSnapshot | undefined }) {
  const window = usage?.windows[0];
  if (!window) {
    return (
      <div className="usage-mini">
        <div className="mini-empty">时间窗口额度暂时无法读取</div>
        <CreditsList compact credits={usage?.credits} />
      </div>
    );
  }
  const used = window.usedPercent;
  return (
    <div className="usage-mini" data-testid="usage-window">
      <div>
        <strong>{window.label}</strong>
        <span>{usedPercentLabel(used)}</span>
      </div>
      <Progress
        label={`${window.label}使用量`}
        tone={(used ?? 0) > 85 ? "danger" : (used ?? 0) > 65 ? "warning" : "success"}
        value={used}
      />
      <small>
        {remainingPercentLabel(window.remainingPercent)}
        {" · "}
        {window.resetsAt ? `${absoluteTime(window.resetsAt)} 重置` : "重置时间暂时无法读取"}
      </small>
      <CreditsList compact credits={usage?.credits} />
    </div>
  );
}

function CreditsList({
  credits,
  compact = false,
}: {
  credits: UsageCredits[] | undefined;
  compact?: boolean;
}) {
  if (!credits?.length) {
    return <div className="mini-empty">Credits 暂时无法读取</div>;
  }
  return (
    <div className={`credits-list ${compact ? "credits-list--compact" : ""}`}>
      {credits.map((credit) => (
        <div className="credit-row" key={credit.id}>
          <strong>{credit.label}</strong>
          <span>{creditBalanceLabel(credit)}</span>
        </div>
      ))}
    </div>
  );
}

function RightInspector({
  usage,
  threadUsage,
  approvals,
  currentThread,
  subagents,
  onOpenApproval,
}: {
  usage: UsageSnapshot | undefined;
  threadUsage: UsageSnapshot | undefined;
  approvals: ApprovalRequest[];
  currentThread: ThreadDetail | undefined;
  subagents: SubagentSummary[];
  onOpenApproval: (approval: ApprovalRequest) => void;
}) {
  return (
    <aside className="right-inspector">
      {approvals.length > 0 ? (
        <section className="inspector-section inspector-approval">
          <div className="inspector-title">
            <span>需要处理</span>
            <StatusPill tone="warning">{approvals.length} 项</StatusPill>
          </div>
          {approvals.slice(0, 2).map((approval) => (
            <button key={approval.id} onClick={() => onOpenApproval(approval)}>
              <Icon name="shield" size={18} />
              <span>
                <strong>{approval.title}</strong>
                <small>点击查看影响范围</small>
              </span>
              <Icon name="chevron-right" size={17} />
            </button>
          ))}
        </section>
      ) : null}
      <section className="inspector-section">
        <div className="inspector-title">
          <span>额度</span>
          <NavLink to="/settings">详情</NavLink>
        </div>
        <UsageMini usage={usage} />
      </section>
      {currentThread ? (
        <>
          <section className="inspector-section">
            <div className="inspector-title">
              <span>当前上下文</span>
            </div>
            <div className="context-stat">
              <div>
                {threadUsage?.context?.usedTokens !== undefined &&
                threadUsage.context.limitTokens !== undefined ? (
                  <>
                    <strong>{number(threadUsage.context.usedTokens)}</strong>
                    <span> / {number(threadUsage.context.limitTokens)} tokens</span>
                  </>
                ) : (
                  <strong className="context-stat__unavailable">暂时无法读取</strong>
                )}
              </div>
              <Progress
                label="上下文使用量"
                tone={(threadUsage?.context?.usedPercent ?? 0) > 80 ? "warning" : "success"}
                value={threadUsage?.context?.usedPercent}
              />
              <small>
                {usedPercentLabel(threadUsage?.context?.usedPercent)}
                {" · "}
                {remainingPercentLabel(remainingFromUsedPercent(threadUsage?.context?.usedPercent))}
              </small>
            </div>
          </section>
          <section className="inspector-section">
            <div className="inspector-title">
              <span>子智能体</span>
              <span>{subagents.length}</span>
            </div>
            {subagents.length ? (
              <div className="subagent-list subagent-list--compact">
                {subagents.map((agent) => (
                  <SubagentRow agent={agent} key={agent.threadId} />
                ))}
              </div>
            ) : (
              <div className="mini-empty">当前没有子智能体</div>
            )}
          </section>
        </>
      ) : null}
    </aside>
  );
}

function HomePage({
  data,
  online,
  onOpenApproval,
}: {
  data: WorkspaceData;
  online: boolean;
  onOpenApproval: (approval: ApprovalRequest) => void;
}) {
  const navigate = useNavigate();
  const active = data.threads.filter(
    (thread) =>
      thread.mode === "managed" && ["running", "waiting-for-approval"].includes(thread.state),
  );
  const recentProjects = [...data.projects].sort(
    (a, b) => new Date(b.lastUsedAt ?? 0).getTime() - new Date(a.lastUsedAt ?? 0).getTime(),
  );
  const caps = data.diagnostics?.capabilities;

  return (
    <>
      <MobileHeader
        action={
          <Button
            aria-label="新建对话"
            icon="plus"
            onClick={() => navigate("/new")}
            size="icon"
            variant="primary"
          />
        }
        title="首页"
      />
      <div className="page home-page">
        <section className="hero">
          <div>
            <span data-testid="current-host-status">
              <StatusPill tone={online ? "success" : "danger"}>
                {online ? "电脑在线" : "连接中断"}
              </StatusPill>
            </span>
            <h1>继续推进你的项目</h1>
            <p>
              {active.length
                ? `${active.length} 个任务正在工作，${data.approvals.length} 项需要你处理。`
                : "目前没有运行中的任务，可以开始一段新对话。"}
            </p>
          </div>
          <Button
            data-testid="new-thread"
            icon="plus"
            onClick={() => navigate("/new")}
            variant="primary"
          >
            新建对话
          </Button>
        </section>

        {data.approvals.length > 0 ? (
          <button className="approval-callout" onClick={() => onOpenApproval(data.approvals[0]!)}>
            <span className="approval-callout__icon">
              <Icon name="shield" size={21} />
            </span>
            <span>
              <strong>{data.approvals.length} 项操作等待你的决定</strong>
              <small>查看影响范围后允许或拒绝</small>
            </span>
            <Icon name="chevron-right" size={20} />
          </button>
        ) : null}

        <div className="section-heading">
          <div>
            <h2>正在进行</h2>
            <span>托管对话可在手机上继续控制</span>
          </div>
          <NavLink to="/threads">全部对话</NavLink>
        </div>
        {active.length ? (
          <div className="active-grid">
            {active.slice(0, 3).map((thread) => (
              <NavLink className="active-card" key={thread.id} to={`/threads/${thread.id}`}>
                <div className="active-card__top">
                  <StatusPill tone={runTones[thread.state]}>{runLabels[thread.state]}</StatusPill>
                  <span>{timeAgo(thread.updatedAt)}</span>
                </div>
                <h3>{thread.title}</h3>
                <p>
                  <Icon name="folder" size={15} />
                  {thread.cwdLabel ?? "未关联项目"}
                </p>
                <div className="active-card__footer">
                  <span>{threadRuntimeSummary(thread)}</span>
                  {thread.childCount ? (
                    <span>
                      <Icon name="layers" size={15} />
                      {thread.childCount} 个子智能体
                    </span>
                  ) : null}
                </div>
              </NavLink>
            ))}
          </div>
        ) : (
          <Card>
            <EmptyState
              action={
                <Button onClick={() => navigate("/new")} variant="primary">
                  开始新任务
                </Button>
              }
              description="选择一个项目并说明要完成的工作。"
              title="等待你的新任务"
            />
          </Card>
        )}

        <div className="home-columns">
          <section>
            <div className="section-heading section-heading--tight">
              <div>
                <h2>最近项目</h2>
                <span>快速从上次的位置继续</span>
              </div>
            </div>
            <Card className="project-list">
              {recentProjects.slice(0, 4).map((project) => (
                <button
                  key={project.id}
                  onClick={() => navigate(`/new?project=${encodeURIComponent(project.id)}`)}
                >
                  <span className="project-icon">
                    <Icon name="folder" size={20} />
                  </span>
                  <span className="project-copy">
                    <strong>{project.name}</strong>
                    <small>{project.rootLabel}</small>
                  </span>
                  <span className="project-time">{timeAgo(project.lastUsedAt)}</span>
                  <Icon name="chevron-right" size={18} />
                </button>
              ))}
            </Card>
          </section>
          <section>
            <div className="section-heading section-heading--tight">
              <div>
                <h2>连接状态</h2>
                <span>从公网入口到本机服务</span>
              </div>
            </div>
            <Card className="health-card">
              <div className="health-row">
                <span>
                  <Icon name="wifi-off" size={18} />
                  <strong>公网入口</strong>
                </span>
                <StatusPill tone={online ? "success" : "danger"}>
                  {online ? "已连接" : "断线"}
                </StatusPill>
              </div>
              {caps ? (
                (Object.keys(caps) as Array<keyof ProductCapabilities>).slice(0, 3).map((key) => (
                  <div className="health-row" key={key}>
                    <span>
                      <Icon
                        name={
                          key === "fileBrowser"
                            ? "folder"
                            : key === "appServer"
                              ? "spark"
                              : "activity"
                        }
                        size={18}
                      />
                      <strong>{capabilityLabel(key)}</strong>
                    </span>
                    <StatusPill tone={capabilityTone(caps[key])}>
                      {capabilityState(caps[key])}
                    </StatusPill>
                  </div>
                ))
              ) : (
                <div className="mini-empty">诊断信息暂时无法读取</div>
              )}
            </Card>
          </section>
        </div>
      </div>
    </>
  );
}

function ThreadsPage({
  threads,
  nextCursor,
  moreState,
  moreError,
  onLoadMore,
  archivedThreads,
  archivedNextCursor,
  archivedState,
  archivedError,
  onLoadArchived,
  onLoadMoreArchived,
}: {
  threads: ThreadSummary[];
  nextCursor: string | undefined;
  moreState: MoreState;
  moreError: string;
  onLoadMore: () => void;
  archivedThreads: ThreadSummary[];
  archivedNextCursor: string | undefined;
  archivedState: DeferredLoadState;
  archivedError: string;
  onLoadArchived: () => void;
  onLoadMoreArchived: () => void;
}) {
  const [query, setQuery] = useState("");
  const [archiveScope, setArchiveScope] = useState<"current" | "archived">("current");
  const [filter, setFilter] = useState<"all" | "active" | "snapshot">("all");
  const visibleThreads = archiveScope === "archived" ? archivedThreads : threads;
  const visibleNextCursor = archiveScope === "archived" ? archivedNextCursor : nextCursor;
  const visibleMoreState = archiveScope === "archived" ? archivedState : moreState;
  const visibleError = archiveScope === "archived" ? archivedError : moreError;
  const visibleLoadMore = archiveScope === "archived" ? onLoadMoreArchived : onLoadMore;
  const filtered = visibleThreads.filter((thread) => {
    const matchesQuery = `${thread.title} ${thread.cwdLabel ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase());
    const matchesFilter =
      filter === "all" ||
      (filter === "active" && thread.mode === "managed" && thread.state !== "complete") ||
      (filter === "snapshot" && thread.mode === "desktop-snapshot");
    return matchesQuery && matchesFilter;
  });

  function selectArchiveScope(scope: "current" | "archived") {
    setArchiveScope(scope);
    setFilter("all");
    if (scope === "archived" && archivedState === "idle") onLoadArchived();
  }

  return (
    <>
      <MobileHeader title="对话" />
      <div className="page list-page">
        <div className="page-heading page-heading--action">
          <div>
            <h1>对话</h1>
            <p>托管对话可控制，桌面快照仅供查看。</p>
          </div>
          <NavLink
            className="desktop-only-button ui-button ui-button--primary ui-button--regular"
            to="/new"
          >
            <Icon name="plus" size={18} />
            新建对话
          </NavLink>
        </div>
        <div aria-label="对话归档范围" className="archive-tabs" role="tablist">
          <button
            aria-selected={archiveScope === "current"}
            onClick={() => selectArchiveScope("current")}
            role="tab"
          >
            当前
          </button>
          <button
            aria-selected={archiveScope === "archived"}
            onClick={() => selectArchiveScope("archived")}
            role="tab"
          >
            已归档
          </button>
        </div>
        <div className="search-field">
          <Icon name="search" size={19} />
          <input
            aria-label="搜索对话"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={archiveScope === "archived" ? "搜索已归档对话" : "搜索当前对话"}
            value={query}
          />
          {query ? (
            <button aria-label="清空搜索" onClick={() => setQuery("")}>
              <Icon name="close" size={17} />
            </button>
          ) : null}
        </div>
        <div className="filter-tabs" role="tablist">
          {(archiveScope === "archived"
            ? ([
                ["all", "全部类型"],
                ["snapshot", "桌面快照"],
              ] as const)
            : ([
                ["all", "全部类型"],
                ["active", "进行中"],
                ["snapshot", "桌面快照"],
              ] as const)
          ).map(([id, label]) => (
            <button aria-selected={filter === id} key={id} onClick={() => setFilter(id)} role="tab">
              {label}
            </button>
          ))}
        </div>
        {archiveScope === "archived" &&
        archivedState === "loading" &&
        archivedThreads.length === 0 ? (
          <Card className="thread-list-card thread-list-card--loading">
            <Skeleton />
            <Skeleton width="72%" />
            <Skeleton width="48%" />
          </Card>
        ) : archiveScope === "archived" &&
          archivedState === "error" &&
          archivedThreads.length === 0 ? (
          <Card>
            <EmptyState
              action={
                <Button icon="refresh" onClick={onLoadArchived}>
                  重试加载
                </Button>
              }
              description={archivedError}
              icon="alert"
              title="归档对话加载失败"
            />
          </Card>
        ) : filtered.length ? (
          <>
            <Card className="thread-list-card">
              {filtered.map((thread) => (
                <NavLink className="thread-list-item" key={thread.id} to={`/threads/${thread.id}`}>
                  <span
                    className={`thread-list-item__icon thread-list-item__icon--${thread.state}`}
                  >
                    <Icon
                      name={
                        thread.mode === "desktop-snapshot"
                          ? "clock"
                          : thread.state === "running"
                            ? "activity"
                            : "message"
                      }
                      size={20}
                    />
                  </span>
                  <span className="thread-list-item__copy">
                    <span>
                      <strong>{thread.title}</strong>
                      <time>{timeAgo(thread.updatedAt)}</time>
                    </span>
                    <small>{thread.cwdLabel ?? "未关联项目"}</small>
                    <span className="thread-list-item__meta">
                      <StatusPill
                        tone={thread.mode === "desktop-snapshot" ? "info" : runTones[thread.state]}
                      >
                        {thread.mode === "desktop-snapshot" ? "只读快照" : runLabels[thread.state]}
                      </StatusPill>
                      {thread.model ? <span>{thread.model}</span> : null}
                      {thread.childCount ? <span>{thread.childCount} 个子智能体</span> : null}
                    </span>
                  </span>
                  <Icon name="chevron-right" size={19} />
                </NavLink>
              ))}
            </Card>
            <PaginationFooter
              completeLabel={
                archiveScope === "archived" ? "已显示全部归档对话" : "已显示全部当前对话"
              }
              error={visibleError}
              hasMore={visibleNextCursor !== undefined}
              label={archiveScope === "archived" ? "加载更早的归档对话" : "加载更早的当前对话"}
              loading={visibleMoreState === "loading"}
              onLoadMore={visibleLoadMore}
            />
          </>
        ) : (
          <>
            <Card>
              <EmptyState
                description={
                  query || filter !== "all"
                    ? "换一个关键词或筛选条件试试。"
                    : archiveScope === "archived"
                      ? "归档后的对话会保留在这里，随时可以回来查看。"
                      : "开始新任务后，对话会显示在这里。"
                }
                icon={query || filter !== "all" ? "search" : "message"}
                title={
                  query || filter !== "all"
                    ? "没有找到对话"
                    : archiveScope === "archived"
                      ? "还没有归档对话"
                      : "当前没有对话"
                }
              />
            </Card>
            <PaginationFooter
              completeLabel={
                archiveScope === "archived" ? "已显示全部归档对话" : "已显示全部当前对话"
              }
              error={visibleError}
              hasMore={visibleNextCursor !== undefined}
              label={archiveScope === "archived" ? "加载更早的归档对话" : "加载更早的当前对话"}
              loading={visibleMoreState === "loading"}
              onLoadMore={visibleLoadMore}
            />
          </>
        )}
      </div>
    </>
  );
}

function MessageItem({ item }: { item: ThreadDetail["items"][number] }) {
  if (item.kind === "user-message") {
    return (
      <article className="message message--user">
        <div className="message__meta">
          <span>你</span>
          {item.createdAt ? <time>{timeAgo(item.createdAt)}</time> : null}
        </div>
        <div className="message__bubble">
          <Markdown>{item.text}</Markdown>
        </div>
      </article>
    );
  }
  if (item.kind === "assistant-message") {
    return (
      <article className="message message--assistant">
        <div className="message__avatar">
          <Icon name="spark" size={18} />
        </div>
        <div
          className="message__content"
          data-testid={item.id === "unsafe-content-message" ? "unsafe-content-message" : undefined}
        >
          <div className="message__meta">
            <span>智能体</span>
            {item.createdAt ? <time>{timeAgo(item.createdAt)}</time> : null}
          </div>
          <Markdown>{item.text}</Markdown>
        </div>
      </article>
    );
  }
  if (item.kind === "reasoning-summary") {
    return (
      <details className="reasoning-item" open>
        <summary>
          <span>
            <Icon name="spark" size={17} />
            工作思路
          </span>
          <Icon name="chevron-down" size={17} />
        </summary>
        <Markdown compact>{item.text}</Markdown>
      </details>
    );
  }
  if (item.kind === "tool") {
    return (
      <details className={`tool-item tool-item--${item.status}`}>
        <summary>
          <span className="tool-item__icon">
            <Icon
              name={
                item.status === "running"
                  ? "activity"
                  : item.status === "failed"
                    ? "alert"
                    : "check"
              }
              size={17}
            />
          </span>
          <span className="tool-item__copy">
            <strong>{item.title}</strong>
            <small>{item.summary ?? toolFallbackSummary(item.status)}</small>
          </span>
          {item.occurrences && item.occurrences > 1 ? (
            <span className="occurrence-badge">{item.occurrences} 次</span>
          ) : null}
          {item.detail ? <Icon name="chevron-down" size={17} /> : null}
        </summary>
        {item.detail ? <pre>{item.detail}</pre> : null}
      </details>
    );
  }
  if (item.kind !== "file-change") return null;
  const status = item.status ?? "completed";
  const summary = (
    <>
      <span className="file-change__status">{fileChangeStatusLabel(item.change, status)}</span>
      <span className="file-change__paths">
        <code>{item.path}</code>
        {item.targetPath ? (
          <>
            <Icon name="chevron-right" size={14} />
            <code>{item.targetPath}</code>
          </>
        ) : null}
      </span>
      <span className="file-change__stats">
        {item.additions !== undefined ? <b>+{item.additions}</b> : null}
        {item.deletions !== undefined ? <i>-{item.deletions}</i> : null}
      </span>
      {item.diff ? <Icon name="chevron-down" size={16} /> : null}
    </>
  );
  if (item.diff) {
    return (
      <details className={`file-change file-change--${item.change} file-change--${status}`}>
        <summary>{summary}</summary>
        <pre aria-label="文件差异">{item.diff}</pre>
      </details>
    );
  }
  return (
    <div className={`file-change file-change--${item.change} file-change--${status}`}>
      {summary}
    </div>
  );
}

function SubagentRow({ agent, onNavigate }: { agent: SubagentSummary; onNavigate?: () => void }) {
  const navigate = useNavigate();
  return (
    <button
      className="subagent-row"
      data-testid="subagent-node"
      onClick={() => {
        onNavigate?.();
        void navigate(`/threads/${agent.threadId}`);
      }}
      style={{ paddingLeft: `${12 + Math.min(agent.depth, 3) * 14}px` }}
    >
      <span className={`subagent-row__line subagent-row__line--${agent.state}`} />
      <span>
        <strong>{agent.title}</strong>
        <small>
          {runLabels[agent.state]} · {timeAgo(agent.updatedAt)}
        </small>
      </span>
      <Icon name="chevron-right" size={17} />
    </button>
  );
}

function ModelControls({
  models,
  model,
  effort,
  disabled,
  modelTestId,
  effortTestId,
  ariaContext,
  onModel,
  onEffort,
}: {
  models: ModelOption[];
  model: string;
  effort: ReasoningEffort;
  disabled?: boolean;
  modelTestId?: string;
  effortTestId?: string;
  ariaContext: "新建对话" | "下一轮";
  onModel: (value: string) => void;
  onEffort: (value: ReasoningEffort) => void;
}) {
  const selected = models.find((option) => option.id === model) ?? models[0];
  const selectedEffort = normalizeReasoningEffortForModel(selected, effort);
  return (
    <div className="model-controls">
      <label>
        <span>模型</span>
        <select
          aria-label={`${ariaContext}模型`}
          data-testid={modelTestId}
          disabled={disabled}
          onChange={(event) => {
            const nextModel = models.find((option) => option.id === event.target.value);
            onModel(event.target.value);
            onEffort(normalizeReasoningEffortForModel(nextModel, effort));
          }}
          value={model}
        >
          {models.map((option) => (
            <option key={option.id} value={option.id}>
              {option.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>思考</span>
        <select
          aria-label={`${ariaContext}思考等级`}
          data-testid={effortTestId}
          disabled={disabled}
          onChange={(event) => onEffort(event.target.value)}
          value={selectedEffort}
        >
          {(selected?.supportedReasoningEfforts ?? ["medium"]).map((option) => (
            <option key={option} value={option}>
              {effortLabel(option)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function ConversationPage({
  apiClient,
  liveEvents,
  models,
  online,
  onThreadLoaded,
  onSubagentsLoaded,
  onUsageLoaded,
  threadSummaries,
}: {
  apiClient: ApiClient;
  liveEvents: LiveEventEnvelope[];
  models: ModelOption[];
  online: boolean;
  onThreadLoaded: (thread?: ThreadDetail) => void;
  onSubagentsLoaded: (agents: SubagentSummary[]) => void;
  onUsageLoaded: (usage?: UsageSnapshot) => void;
  threadSummaries: ThreadSummary[];
}) {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const summary = threadSummaries.find((candidate) => candidate.id === id);
  const [thread, setThread] = useState<ThreadDetail | undefined>(() =>
    summary ? detailFromThreadSummary(summary) : undefined,
  );
  const [subagents, setSubagents] = useState<SubagentSummary[]>([]);
  const [subagentsNextCursor, setSubagentsNextCursor] = useState<string>();
  const [subagentsMoreState, setSubagentsMoreState] = useState<MoreState>("idle");
  const [subagentsError, setSubagentsError] = useState("");
  const [threadUsage, setThreadUsage] = useState<UsageSnapshot>();
  const [state, setState] = useState<LoadState>(summary ? "ready" : "loading");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(() => window.localStorage.getItem(`draft:${id}`) ?? "");
  const [model, setModel] = useState(
    models.find((item) => item.isDefault)?.id ?? models[0]?.id ?? "",
  );
  const [effort, setEffort] = useState<ReasoningEffort>("medium");
  const [sending, setSending] = useState(false);
  const [showAgents, setShowAgents] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [actionError, setActionError] = useState("");
  const [actionStatus, setActionStatus] = useState<"steer-accepted" | "turn-interrupted" | "">("");
  const endRef = useRef<HTMLDivElement>(null);
  const handledLiveDelivery = useRef(0);
  const currentIdRef = useRef(id);
  const summaryRef = useRef(summary);
  const loadInFlight = useRef<{ id: string; promise: Promise<void> } | undefined>(undefined);
  const subagentsRef = useRef<SubagentSummary[]>([]);
  const subagentsNextCursorRef = useRef<string | undefined>(undefined);
  const subagentsExtendedRef = useRef(false);
  const subagentsMoreInFlightRef = useRef<{ id: string } | undefined>(undefined);
  currentIdRef.current = id;
  summaryRef.current = summary;

  const load = useCallback(
    (silent = false) => {
      if (loadInFlight.current?.id === id) return loadInFlight.current.promise;
      if (!silent) setState("loading");
      const promise = (async () => {
        try {
          const [detail, agentsResult, usageSnapshot] = await Promise.all([
            apiClient.thread(id),
            apiClient
              .subagents(id)
              .then((page) => ({ page, error: "" }))
              .catch((agentsError: unknown) => ({
                page: { items: [] } as CursorPage<SubagentSummary>,
                error: errorMessage(agentsError),
              })),
            apiClient.usage(id).catch(() => undefined),
          ]);
          if (currentIdRef.current !== id) return;
          const agents = silent
            ? mergeCursorItems(
                subagentsRef.current,
                agentsResult.page.items,
                (agent) => agent.threadId,
              )
            : agentsResult.page.items;
          const nextCursor = agentsResult.error
            ? subagentsNextCursorRef.current
            : nextCursorAfterRefresh(
                subagentsNextCursorRef.current,
                agentsResult.page.nextCursor,
                silent &&
                  (subagentsExtendedRef.current || subagentsMoreInFlightRef.current?.id === id),
              );
          setThread(detail);
          subagentsRef.current = agents;
          setSubagents(agents);
          subagentsNextCursorRef.current = nextCursor;
          setSubagentsNextCursor(nextCursor);
          setSubagentsError(agentsResult.error);
          setThreadUsage(usageSnapshot);
          onThreadLoaded(detail);
          onSubagentsLoaded(agents);
          onUsageLoaded(usageSnapshot);
          if (detail.model && models.some((option) => option.id === detail.model))
            setModel(detail.model);
          if (detail.reasoningEffort) setEffort(detail.reasoningEffort);
          setState("ready");
          setError("");
        } catch (loadError) {
          if (currentIdRef.current !== id || silent) return;
          setError(errorMessage(loadError));
          setState("error");
          onThreadLoaded(undefined);
          onSubagentsLoaded([]);
        }
      })();
      const request = { id, promise };
      loadInFlight.current = request;
      void promise.finally(() => {
        if (loadInFlight.current === request) loadInFlight.current = undefined;
      });
      return promise;
    },
    [apiClient, id, models, onSubagentsLoaded, onThreadLoaded, onUsageLoaded],
  );

  useEffect(() => {
    handledLiveDelivery.current = 0;
    subagentsRef.current = [];
    subagentsNextCursorRef.current = undefined;
    subagentsExtendedRef.current = false;
    setSubagents([]);
    setSubagentsNextCursor(undefined);
    setSubagentsMoreState("idle");
    setSubagentsError("");
    const fallback = summaryRef.current;
    if (fallback) {
      setThread(detailFromThreadSummary(fallback));
      setState("ready");
      setError("");
    } else {
      setThread(undefined);
      setThreadUsage(undefined);
    }
  }, [id]);

  useEffect(() => {
    void load(Boolean(summaryRef.current));
  }, [load]);

  useEffect(() => {
    return () => {
      onThreadLoaded(undefined);
      onSubagentsLoaded([]);
      onUsageLoaded(undefined);
    };
  }, [onSubagentsLoaded, onThreadLoaded, onUsageLoaded]);

  useEffect(() => {
    if (thread) {
      onThreadLoaded(thread);
    }
  }, [onThreadLoaded, thread]);

  useEffect(() => {
    if (threadUsage) {
      onUsageLoaded(threadUsage);
    }
  }, [onUsageLoaded, threadUsage]);

  async function loadSubagentsPage(cursor?: string) {
    if (subagentsMoreInFlightRef.current?.id === id) return;
    const request = { id };
    subagentsMoreInFlightRef.current = request;
    setSubagentsMoreState("loading");
    setSubagentsError("");
    try {
      const page = await apiClient.subagents(id, cursor);
      if (currentIdRef.current !== id) return;
      const agents = mergeCursorItems(
        subagentsRef.current,
        page.items,
        (agent) => agent.threadId,
        cursor ? "append" : "prepend",
      );
      subagentsRef.current = agents;
      const nextCursor =
        !cursor && subagentsExtendedRef.current ? subagentsNextCursorRef.current : page.nextCursor;
      if (cursor) subagentsExtendedRef.current = true;
      subagentsNextCursorRef.current = nextCursor;
      setSubagents(agents);
      setSubagentsNextCursor(nextCursor);
      onSubagentsLoaded(agents);
      setSubagentsMoreState("idle");
    } catch (loadError) {
      if (currentIdRef.current !== id) return;
      setSubagentsError(errorMessage(loadError));
      setSubagentsMoreState("error");
    } finally {
      if (subagentsMoreInFlightRef.current === request) {
        subagentsMoreInFlightRef.current = undefined;
      }
    }
  }

  useEffect(() => {
    if (state !== "ready" || !thread || thread.id !== id) {
      return;
    }
    const pending = liveEvents.filter(
      (envelope) => envelope.deliveryId > handledLiveDelivery.current,
    );
    if (pending.length === 0) {
      return;
    }
    const firstDelivery = pending[0]?.deliveryId;
    const missedBufferedEvents =
      handledLiveDelivery.current > 0 &&
      firstDelivery !== undefined &&
      firstDelivery > handledLiveDelivery.current + 1;
    handledLiveDelivery.current = pending.at(-1)?.deliveryId ?? handledLiveDelivery.current;

    const relevant = pending.filter(({ event }) => !event.threadId || event.threadId === id);
    const relevantEvents = relevant.map(({ event }) => event);
    if (relevant.length > 0) {
      setThread((current) => {
        if (!current) return current;
        let projected = current;
        let group: RemoteEvent[] = [];
        let replayed = relevant[0]?.replayed ?? false;
        const flush = () => {
          if (group.length === 0) return;
          projected = applyThreadRemoteEvents(projected, group, { replayed });
          group = [];
        };
        for (const envelope of relevant) {
          if (envelope.replayed !== replayed) {
            flush();
            replayed = envelope.replayed;
          }
          group.push(envelope.event);
        }
        flush();
        return projected;
      });
      setThreadUsage((current) => applyUsageRemoteEvents(current, id, relevantEvents));
    }

    const resetRequested = relevantEvents.some((event) => event.type === "connection.reset");
    const turnFinished = relevantEvents.some((event) => {
      if (event.type !== "turn.state") return false;
      const payload =
        typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : {};
      return payload.state === "idle" || payload.state === "complete" || payload.state === "failed";
    });
    if (missedBufferedEvents || resetRequested || turnFinished) {
      void load(true);
    }
  }, [id, liveEvents, load, state, thread]);

  useEffect(() => {
    let timer: number | undefined;
    let disposed = false;
    const delay = threadRefreshDelay(thread?.state);
    const clear = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      clear();
      if (disposed || !canRefreshDocument(document.visibilityState)) return;
      timer = window.setTimeout(() => {
        void load(true).finally(schedule);
      }, delay);
    };
    const onVisibility = () => {
      clear();
      if (canRefreshDocument(document.visibilityState)) {
        void load(true).finally(schedule);
      }
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      clear();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, thread?.state]);

  useEffect(() => {
    window.localStorage.setItem(`draft:${id}`, draft);
  }, [draft, id]);

  async function submit() {
    if (!thread || !draft.trim() || !online) return;
    setSending(true);
    setActionError("");
    try {
      if (thread.activeTurnId && thread.availableActions.steer) {
        await apiClient.steer(thread.id, thread.activeTurnId, { prompt: draft.trim() });
        setThread({
          ...thread,
          items: [
            ...thread.items,
            {
              id: `pending-${Date.now()}`,
              kind: "user-message",
              text: `补充要求：${draft.trim()}`,
            },
          ],
        });
        setActionStatus("steer-accepted");
      } else {
        const updated = await apiClient.sendTurn(thread.id, {
          prompt: draft.trim(),
          model,
          reasoningEffort: normalizeReasoningEffort(models, model, effort),
        });
        setThread(updated);
        onThreadLoaded(updated);
      }
      setDraft("");
      window.localStorage.removeItem(`draft:${id}`);
      window.setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 20);
    } catch (submitError) {
      setActionError(errorMessage(submitError));
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    if (!thread?.activeTurnId || !online) return;
    setSending(true);
    setActionError("");
    try {
      await apiClient.interrupt(thread.id, thread.activeTurnId);
      const { activeTurnId: _activeTurnId, ...threadWithoutActiveTurn } = thread;
      const updated: ThreadDetail = {
        ...threadWithoutActiveTurn,
        state: "idle",
        availableActions: {
          ...thread.availableActions,
          interrupt: false,
          reply: true,
          steer: false,
        },
      };
      setThread(updated);
      onThreadLoaded(updated);
      setActionStatus("turn-interrupted");
    } catch (stopError) {
      setActionError(errorMessage(stopError));
    } finally {
      setSending(false);
    }
  }

  if (state === "loading")
    return (
      <>
        <MobileHeader back title="对话" />
        <LoadingPage />
      </>
    );
  if (state === "error" || !thread) {
    return (
      <>
        <MobileHeader back title="对话" />
        <div className="page">
          <Card>
            <EmptyState
              action={
                <Button icon="refresh" onClick={() => void load()}>
                  重新加载
                </Button>
              }
              description={error}
              icon="alert"
              title="对话加载失败"
            />
          </Card>
        </div>
      </>
    );
  }

  const isSnapshot = thread.mode === "desktop-snapshot";
  const running = !isSnapshot && Boolean(thread.activeTurnId);
  const canCompose = canDirectlyCompose(thread);
  return (
    <div className="conversation-page" data-testid="thread-view">
      {thread.parentThreadId ? (
        <span className="sr-only" data-testid="subagent-thread">
          子智能体对话
        </span>
      ) : null}
      <MobileHeader back title="对话" />
      <header className="conversation-header">
        <div className="conversation-header__main">
          <Button
            aria-label="返回对话列表"
            className="desktop-back"
            icon="arrow-left"
            onClick={() => navigate("/threads")}
            size="icon"
            variant="ghost"
          />
          <div>
            <h1>{thread.title}</h1>
            <span>
              {thread.cwdLabel ?? "未关联项目"} · {timeAgo(thread.updatedAt)}
            </span>
          </div>
        </div>
        <div className="conversation-header__badges">
          {subagents.length || subagentsError || subagentsNextCursor ? (
            <button
              className="subagents-trigger"
              data-testid="subagents-open"
              onClick={() => setShowAgents(true)}
            >
              <Icon name="layers" size={15} />
              <span>{subagents.length}</span>
            </button>
          ) : null}
          <button
            className="usage-trigger"
            data-testid="usage-open"
            onClick={() => setShowUsage((value) => !value)}
          >
            <Icon name="activity" size={15} />
            额度
          </button>
          <StatusPill tone={isSnapshot ? "info" : runTones[thread.state]}>
            {isSnapshot ? "只读快照" : runLabels[thread.state]}
          </StatusPill>
          {running ? (
            <span className="streaming-label">
              <i />
              实时更新
            </span>
          ) : null}
        </div>
      </header>
      {showUsage ? (
        <section className="conversation-usage-panel" data-testid="usage-panel">
          <div>
            <strong>额度与上下文</strong>
            <button aria-label="关闭额度面板" onClick={() => setShowUsage(false)}>
              <Icon name="close" size={16} />
            </button>
          </div>
          {threadUsage ? (
            <div className="conversation-usage-windows" data-testid="usage-window">
              {threadUsage.windows.map((window) => (
                <div className="conversation-usage-window" key={window.id}>
                  <span>{window.label}</span>
                  <Progress
                    label={`${window.label}使用量`}
                    tone={
                      (window.usedPercent ?? 0) > 85
                        ? "danger"
                        : (window.usedPercent ?? 0) > 65
                          ? "warning"
                          : "success"
                    }
                    value={window.usedPercent}
                  />
                  <small>
                    {usedPercentLabel(window.usedPercent)}
                    {" · "}
                    {remainingPercentLabel(window.remainingPercent)}
                    {" · "}
                    {window.resetsAt
                      ? `${absoluteTime(window.resetsAt)} 重置`
                      : "重置时间暂时无法读取"}
                  </small>
                </div>
              ))}
              <div className="conversation-usage-window conversation-usage-window--context">
                <span>当前上下文</span>
                <Progress
                  label="当前线程上下文使用量"
                  tone={(threadUsage.context?.usedPercent ?? 0) > 80 ? "warning" : "success"}
                  value={threadUsage.context?.usedPercent}
                />
                <small>
                  {threadUsage.context?.usedTokens !== undefined &&
                  threadUsage.context.limitTokens !== undefined
                    ? `${number(threadUsage.context.usedTokens)} / ${number(threadUsage.context.limitTokens)} tokens`
                    : "token 用量暂时无法读取"}
                  {" · "}
                  {usedPercentLabel(threadUsage.context?.usedPercent)}
                  {" · "}
                  {remainingPercentLabel(
                    remainingFromUsedPercent(threadUsage.context?.usedPercent),
                  )}
                </small>
              </div>
            </div>
          ) : (
            <div className="mini-empty" data-testid="usage-unavailable">
              额度暂时无法读取
            </div>
          )}
        </section>
      ) : null}
      {isSnapshot ? (
        <Notice icon="clock" title="这是桌面快照" tone="info">
          内容可能延迟{thread.snapshotDelaySeconds ? `约 ${thread.snapshotDelaySeconds} 秒` : ""}
          ，无法实时跟随、追加要求或停止 Desktop 当前回复。只有托管任务支持实时控制。
        </Notice>
      ) : null}
      {thread.parentThreadId ? (
        <button
          className="parent-thread-back"
          data-testid="parent-thread-back"
          onClick={() => navigate(`/threads/${thread.parentThreadId}`)}
        >
          <Icon name="arrow-left" size={17} />
          返回父对话
        </button>
      ) : null}
      {!online ? (
        <Notice icon="wifi-off" title="连接已中断" tone="danger">
          你仍可查看已加载内容；恢复连接前不能发送、停止或审批。
        </Notice>
      ) : null}
      <div className="conversation-scroll">
        <div className="conversation-stream">
          {thread.items.map((item) => (
            <MessageItem item={item} key={item.id} />
          ))}
          {!isSnapshot && thread.state === "running" ? (
            <div
              aria-label="智能体正在工作"
              className="working-indicator"
              data-testid="turn-running"
            >
              <span />
              <span />
              <span />
              <em>正在继续工作</em>
            </div>
          ) : null}
          {thread.state === "failed" ? (
            <Notice
              action={
                <Button
                  onClick={() => setDraft("请检查失败原因并从安全的位置继续。")}
                  size="compact"
                >
                  准备恢复指令
                </Button>
              }
              icon="alert"
              title="这一轮没有完成"
              tone="danger"
            >
              查看上方失败步骤，补充要求后可以开始新一轮。
            </Notice>
          ) : null}
          <div ref={endRef} />
        </div>
      </div>
      {!isSnapshot && canCompose ? (
        <div className="composer-shell">
          {actionStatus ? (
            <div aria-live="polite" className="action-status" data-testid={actionStatus}>
              <Icon name="check" size={15} />
              {actionStatus === "steer-accepted" ? "补充要求已转交" : "已发送停止请求"}
            </div>
          ) : null}
          {actionError ? (
            <div className="composer-error">
              <Icon name="alert" size={16} />
              {actionError}
            </div>
          ) : null}
          <div className="composer">
            <textarea
              aria-label={running ? "追加要求" : "回复"}
              data-testid="turn-composer"
              disabled={!online}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void submit();
              }}
              placeholder={running ? "追加要求，不会中断当前工作" : "说明接下来要做什么…"}
              rows={2}
              value={draft}
            />
            <div className="composer__footer">
              <span className="next-turn-badge">下一轮</span>
              <ModelControls
                ariaContext="下一轮"
                disabled={!thread.availableActions.changeModelNextTurn}
                effort={effort}
                effortTestId="next-turn-effort"
                model={model}
                modelTestId="next-turn-model"
                models={models}
                onEffort={setEffort}
                onModel={setModel}
              />
              <div className="composer__actions">
                {running && thread.availableActions.interrupt ? (
                  <Button
                    aria-label="停止当前工作"
                    data-testid="turn-interrupt"
                    disabled={!online || sending}
                    icon="stop"
                    onClick={() => void stop()}
                    size="compact"
                    variant="danger"
                  >
                    停止
                  </Button>
                ) : null}
                <Button
                  aria-label={running ? "发送补充要求" : "发送"}
                  data-testid={running ? "turn-steer-submit" : "turn-reply-submit"}
                  disabled={!draft.trim() || !online || sending}
                  icon="send"
                  onClick={() => void submit()}
                  size="icon"
                  variant="primary"
                />
              </div>
            </div>
          </div>
          <small className="next-turn-hint" data-testid="next-turn-model-notice">
            {running
              ? "模型和思考等级的选择将在下一轮生效"
              : "当前选择只应用于下一轮 · Ctrl + Enter 发送"}
          </small>
        </div>
      ) : !isSnapshot && thread.parentThreadId ? (
        <div className="read-only-handoff">
          <Icon name="layers" size={19} />
          <span>
            <strong>这个子智能体不能直接接收要求</strong>
            <small>返回父对话后补充要求，父智能体会负责转交。</small>
          </span>
          <Button onClick={() => void navigate(`/threads/${thread.parentThreadId}`)} size="compact">
            返回父对话
          </Button>
        </div>
      ) : null}
      <Sheet
        description="已完成的子智能体也会保留在这里。进入后可查看它的消息、工具与文件变更。"
        onClose={() => setShowAgents(false)}
        open={showAgents}
        title={`子智能体 · ${subagents.length}`}
      >
        {subagents.length ? (
          <div className="subagent-list" data-testid="subagent-tree">
            {subagents.map((agent) => (
              <SubagentRow
                agent={agent}
                key={agent.threadId}
                onNavigate={() => setShowAgents(false)}
              />
            ))}
          </div>
        ) : (
          <div className="mini-empty">当前没有子智能体</div>
        )}
        <PaginationFooter
          completeLabel="已显示全部子智能体"
          error={subagentsError}
          hasMore={subagentsNextCursor !== undefined}
          label="加载更多子智能体"
          loading={subagentsMoreState === "loading"}
          onLoadMore={() => void loadSubagentsPage(subagentsNextCursorRef.current)}
        />
      </Sheet>
    </div>
  );
}

function NewThreadPage({
  projects,
  models,
  collaborationModes,
  apiClient,
}: {
  projects: ProjectSummary[];
  models: ModelOption[];
  collaborationModes: CollaborationModeOption[];
  apiClient: ApiClient;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const selectableProjects = registeredProjects(projects);
  const requestedProject = new URLSearchParams(location.search).get("project");
  const initialProject =
    selectableProjects.find((project) => project.id === requestedProject)?.id ??
    selectableProjects[0]?.id ??
    "";
  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  const [projectId, setProjectId] = useState(initialProject);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(defaultModel?.id ?? "");
  const [effort, setEffort] = useState<ReasoningEffort>(
    defaultReasoningEffortForModel(defaultModel),
  );
  const [permission, setPermission] = useState<PermissionMode>("ask");
  const [collaboration, setCollaboration] = useState(
    collaborationModes.find((mode) => mode.id === "auto" && mode.available)?.id ??
      collaborationModes.find((mode) => mode.available)?.id ??
      "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!projectId || !prompt.trim()) return;
    setBusy(true);
    setError("");
    try {
      const created = await apiClient.createThread({
        projectId,
        prompt: prompt.trim(),
        reasoningEffort: normalizeReasoningEffort(models, model, effort),
        permissionMode: permission,
        ...(model ? { model } : {}),
        ...(collaboration ? { collaborationMode: collaboration } : {}),
      });
      void navigate(`/threads/${created.id}`, { replace: true });
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <MobileHeader back title="新建对话" />
      <div className="page new-thread-page">
        <div className="page-heading">
          <h1>开始新任务</h1>
          <p>选择本机已登记的项目，再说明你希望完成什么。</p>
        </div>
        <form data-testid="new-thread-form" onSubmit={(event) => void submit(event)}>
          <section className="form-section">
            <div className="form-section__title">
              <span>1</span>
              <div>
                <h2>选择项目</h2>
                <p>远程端不能添加任意目录</p>
              </div>
            </div>
            {selectableProjects.length ? (
              <div className="project-choice-grid">
                {selectableProjects.map((project) => (
                  <label
                    className={projectId === project.id ? "is-selected" : ""}
                    data-testid="project-option"
                    key={project.id}
                  >
                    <input
                      checked={projectId === project.id}
                      name="project"
                      onChange={() => setProjectId(project.id)}
                      type="radio"
                    />
                    <span className="project-icon">
                      <Icon name="folder" size={20} />
                    </span>
                    <span>
                      <strong>{project.name}</strong>
                      <small>{project.rootLabel}</small>
                    </span>
                    <Icon name="check" size={18} />
                  </label>
                ))}
              </div>
            ) : (
              <Notice icon="folder" title="还没有可用项目" tone="warning">
                请先在电脑本机登记项目目录。
              </Notice>
            )}
          </section>
          <section className="form-section">
            <div className="form-section__title">
              <span>2</span>
              <div>
                <h2>说明任务</h2>
                <p>目标、范围和验收方式越清楚越好</p>
              </div>
            </div>
            <textarea
              autoFocus
              className="prompt-input"
              data-testid="new-thread-prompt"
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="例如：检查登录页在手机上的布局，修复按钮遮挡并运行前端测试…"
              rows={6}
              value={prompt}
            />
            <span className="character-count">{prompt.length} 字</span>
          </section>
          <section className="form-section">
            <div className="form-section__title">
              <span>3</span>
              <div>
                <h2>工作方式</h2>
                <p>开始后可为下一轮调整模型与思考等级</p>
              </div>
            </div>
            <ModelControls
              ariaContext="新建对话"
              effort={effort}
              effortTestId="new-thread-effort"
              model={model}
              modelTestId="new-thread-model"
              models={models}
              onEffort={setEffort}
              onModel={setModel}
            />
            <fieldset className="permission-fieldset">
              <legend>文件权限</legend>
              <div className="option-grid">
                {permissionOptions.map((option) => (
                  <label className={permission === option.id ? "is-selected" : ""} key={option.id}>
                    <input
                      checked={permission === option.id}
                      name="permission"
                      onChange={() => setPermission(option.id)}
                      type="radio"
                    />
                    <Icon name={option.icon} size={20} />
                    <span>
                      <strong>{option.title}</strong>
                      <small>{option.description}</small>
                    </span>
                    <i>
                      <Icon name="check" size={14} />
                    </i>
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="select-label">
              <span>协作模式</span>
              <select
                disabled={!collaborationModes.some((mode) => mode.available)}
                onChange={(event) => setCollaboration(event.target.value)}
                value={collaboration}
              >
                {collaborationModes.map((mode) => (
                  <option disabled={!mode.available} key={mode.id} value={mode.id}>
                    {mode.displayName}
                    {mode.available ? "" : "（不可用）"}
                  </option>
                ))}
              </select>
              <small>
                {collaborationModes.find((mode) => mode.id === collaboration)?.description ??
                  "当前服务未提供协作模式"}
              </small>
            </label>
          </section>
          {error ? (
            <div className="form-error">
              <Icon name="alert" size={18} />
              {error}
            </div>
          ) : null}
          <div className="form-submit">
            <Button onClick={() => navigate(-1)} type="button">
              取消
            </Button>
            <Button
              data-testid="new-thread-submit"
              disabled={busy || !projectId || !prompt.trim()}
              icon="play"
              type="submit"
              variant="primary"
            >
              {busy ? "正在开始…" : "开始任务"}
            </Button>
          </div>
        </form>
      </div>
    </>
  );
}

function FilePreview({
  entry,
  projectId,
  apiClient,
  onClose,
}: {
  entry: FileEntry;
  projectId: string;
  apiClient: ApiClient;
  onClose: () => void;
}) {
  const [state, setState] = useState<LoadState>("loading");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [contentType, setContentType] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    setState("loading");
    void apiClient
      .preview(projectId, entry.relativePath)
      .then(async (result) => {
        if (!active) return;
        setContentType(result.contentType);
        if (
          result.contentType.startsWith("text/") ||
          /\.(md|txt|json|ya?ml|tsx?|jsx?|css|html)$/i.test(entry.name)
        ) {
          setText(await result.blob.text());
        } else if (
          result.contentType.startsWith("image/") ||
          result.contentType === "application/pdf"
        ) {
          objectUrl = URL.createObjectURL(result.blob);
          setUrl(objectUrl);
        }
        setState("ready");
      })
      .catch((previewError: unknown) => {
        if (!active) return;
        setError(errorMessage(previewError));
        setState("error");
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [apiClient, entry.name, entry.relativePath, projectId]);

  const isMarkdown = /\.md$/i.test(entry.name) || contentType === "text/markdown";
  return (
    <section className="file-preview">
      <header>
        <div>
          <strong>{entry.name}</strong>
          <span>
            {entry.size === undefined ? "大小未知" : `${number(entry.size)}B`} ·{" "}
            {entry.relativePath}
          </span>
        </div>
        <Button aria-label="关闭预览" icon="close" onClick={onClose} size="icon" variant="ghost" />
      </header>
      <div className="file-preview__body">
        {state === "loading" ? (
          <div className="preview-loading">
            <Skeleton />
            <Skeleton width="83%" />
            <Skeleton width="64%" />
          </div>
        ) : null}
        {state === "error" ? (
          <EmptyState description={error} icon="alert" title="无法预览文件" />
        ) : null}
        {state === "ready" && text ? (
          isMarkdown ? (
            <Markdown>{text}</Markdown>
          ) : (
            <pre className="code-preview">{text}</pre>
          )
        ) : null}
        {state === "ready" && url && contentType.startsWith("image/") ? (
          <img alt={entry.name} src={url} />
        ) : null}
        {state === "ready" && url && contentType === "application/pdf" ? (
          <iframe src={url} title={entry.name} />
        ) : null}
        {state === "ready" && !text && !url ? (
          <EmptyState
            description="此文件类型不支持浏览器内预览，可以下载到设备后打开。"
            icon="file"
            title="仅提供下载"
          />
        ) : null}
      </div>
      <footer>
        <a
          className="ui-button ui-button--primary ui-button--regular"
          data-testid="file-download"
          data-touch-target="primary"
          download={entry.name}
          href={apiClient.downloadUrl(projectId, entry.relativePath)}
        >
          <Icon name="download" size={18} />
          下载文件
        </a>
      </footer>
    </section>
  );
}

function FileBrowserPage({
  projects,
  apiClient,
  online,
}: {
  projects: ProjectSummary[];
  apiClient: ApiClient;
  online: boolean;
}) {
  const selectableProjects = registeredProjects(projects);
  const [projectId, setProjectId] = useState(selectableProjects[0]?.id ?? "");
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<FileListing>();
  const [selected, setSelected] = useState<FileEntry>();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!projectId) {
      setState("ready");
      return;
    }
    setState("loading");
    setError("");
    try {
      setListing(await apiClient.files(projectId, path));
      setState("ready");
    } catch (loadError) {
      setError(errorMessage(loadError));
      setState("error");
    }
  }, [apiClient, path, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const parts = path.split("/").filter(Boolean);
  const visible = (listing?.entries ?? []).filter((entry) =>
    entry.name.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <>
      <MobileHeader title="文件" />
      <div
        className={`page files-page ${selected ? "has-preview" : ""}`}
        data-testid="file-browser"
      >
        <div className="files-browser">
          <div className="page-heading">
            <h1>项目文件</h1>
            <p>只读浏览已在电脑本机登记的项目。</p>
          </div>
          <label className="select-label project-select">
            <span>当前项目</span>
            <select
              onChange={(event) => {
                setProjectId(event.target.value);
                setPath("");
                setSelected(undefined);
              }}
              value={projectId}
            >
              {selectableProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name} · {project.rootLabel}
                </option>
              ))}
            </select>
          </label>
          {!online ? (
            <Notice icon="wifi-off" title="离线时不能读取新文件" tone="danger">
              已打开的内容可能仍保留在浏览器中。
            </Notice>
          ) : null}
          <div className="file-toolbar">
            <div aria-label="当前路径" className="breadcrumbs">
              <button onClick={() => setPath("")}>
                <Icon name="folder" size={17} />
                <span>
                  {selectableProjects.find((project) => project.id === projectId)?.name ?? "项目"}
                </span>
              </button>
              {parts.map((part, index) => (
                <Fragment key={`${part}-${index}`}>
                  <Icon name="chevron-right" size={15} />
                  <button onClick={() => setPath(parts.slice(0, index + 1).join("/"))}>
                    {part}
                  </button>
                </Fragment>
              ))}
            </div>
            <div className="search-field search-field--compact">
              <Icon name="search" size={18} />
              <input
                aria-label="筛选当前文件夹"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="筛选"
                value={query}
              />
            </div>
          </div>
          {state === "loading" ? (
            <Card className="file-list loading-files">
              <Skeleton />
              <Skeleton />
              <Skeleton width="74%" />
            </Card>
          ) : state === "error" ? (
            <Card>
              <EmptyState
                action={
                  <Button icon="refresh" onClick={() => void load()}>
                    重新加载
                  </Button>
                }
                description={error}
                icon="alert"
                title="文件夹加载失败"
              />
            </Card>
          ) : visible.length ? (
            <Card className="file-list">
              {path ? (
                <button onClick={() => setPath(parts.slice(0, -1).join("/"))}>
                  <span className="file-icon file-icon--folder">
                    <Icon name="arrow-left" size={19} />
                  </span>
                  <span>
                    <strong>返回上一级</strong>
                    <small>目录</small>
                  </span>
                </button>
              ) : null}
              {visible.map((entry) => (
                <div
                  className={`file-entry-row ${selected?.relativePath === entry.relativePath ? "is-selected" : ""}`}
                  data-testid="file-entry"
                  key={entry.relativePath}
                >
                  <button
                    className="file-entry-main"
                    onClick={() =>
                      entry.kind === "directory"
                        ? (setPath(entry.relativePath), setSelected(undefined))
                        : setSelected(entry)
                    }
                  >
                    <span className={`file-icon file-icon--${entry.kind}`}>
                      <Icon name={entry.kind === "directory" ? "folder" : "file"} size={19} />
                    </span>
                    <span>
                      <strong>{entry.name}</strong>
                      <small>
                        {entry.kind === "directory"
                          ? "文件夹"
                          : `${entry.size === undefined ? "大小未知" : `${number(entry.size)}B`} · ${timeAgo(entry.modifiedAt)}`}
                      </small>
                    </span>
                    {entry.kind === "directory" ? <Icon name="chevron-right" size={18} /> : null}
                  </button>
                  {entry.kind === "file" && entry.downloadable ? (
                    <a
                      aria-label={`下载 ${entry.name}`}
                      data-testid="file-download"
                      data-touch-target="primary"
                      download={entry.name}
                      href={apiClient.downloadUrl(projectId, entry.relativePath)}
                    >
                      <Icon name="download" size={18} />
                    </a>
                  ) : null}
                </div>
              ))}
            </Card>
          ) : (
            <Card>
              <EmptyState
                description={query ? "当前文件夹没有匹配项。" : "这个文件夹没有可显示的内容。"}
                icon="folder"
                title={query ? "没有找到文件" : "空文件夹"}
              />
            </Card>
          )}
        </div>
        {selected ? (
          <FilePreview
            apiClient={apiClient}
            entry={selected}
            onClose={() => setSelected(undefined)}
            projectId={projectId}
          />
        ) : (
          <aside className="file-preview-placeholder">
            <Icon name="file" size={26} />
            <strong>选择文件以预览</strong>
            <span>支持文本、Markdown、图片和 PDF</span>
          </aside>
        )}
      </div>
    </>
  );
}

function SettingsPage({
  data,
  session,
  online,
  onLogout,
  onRefresh,
}: {
  data: WorkspaceData;
  session: AuthSession;
  online: boolean;
  onLogout: () => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const diagnostics = data.diagnostics;
  const caps = diagnostics?.capabilities;

  return (
    <>
      <MobileHeader title="设置" />
      <div className="page settings-page">
        <div className="page-heading">
          <h1>设置与诊断</h1>
          <p>查看连接、额度、会话和当前服务能力。</p>
        </div>
        <div className="settings-grid" data-testid="usage-panel">
          <section>
            <h2>连接</h2>
            <Card className="settings-card">
              <div className="settings-row">
                <span className="settings-row__icon">
                  <Icon name="activity" size={19} />
                </span>
                <span>
                  <strong>公网入口</strong>
                  <small>{online ? "托管任务实时事件连接正常" : "正在尝试重新连接"}</small>
                </span>
                <StatusPill tone={online ? "success" : "danger"}>
                  {online ? "正常" : "断线"}
                </StatusPill>
              </div>
              <div className="settings-row">
                <span className="settings-row__icon">
                  <Icon name="spark" size={19} />
                </span>
                <span>
                  <strong>Sidecar</strong>
                  <small>版本 {diagnostics?.version ?? "暂时无法读取"}</small>
                </span>
                <StatusPill tone={diagnostics ? "success" : "warning"}>
                  {diagnostics ? "正常" : "未知"}
                </StatusPill>
              </div>
              <div className="settings-row">
                <span className="settings-row__icon">
                  <Icon name="code" size={19} />
                </span>
                <span>
                  <strong>Codex 服务</strong>
                  <small>
                    {diagnostics?.appServerVersion
                      ? `版本 ${diagnostics.appServerVersion}`
                      : "版本暂时无法读取"}
                  </small>
                </span>
                <StatusPill tone={caps ? capabilityTone(caps.appServer) : "warning"}>
                  {caps ? capabilityState(caps.appServer) : "未知"}
                </StatusPill>
              </div>
              <Button
                disabled={busy}
                icon="refresh"
                onClick={() => {
                  setBusy(true);
                  void onRefresh().finally(() => setBusy(false));
                }}
              >
                {busy ? "正在刷新…" : "刷新诊断"}
              </Button>
            </Card>
          </section>

          <section>
            <h2>额度与上下文</h2>
            <Card className="settings-card usage-settings">
              {data.usage?.windows.length ? (
                data.usage.windows.map((window) => (
                  <div className="usage-window" data-testid="usage-window" key={window.id}>
                    <div>
                      <strong>{window.label}</strong>
                      <span>{usedPercentLabel(window.usedPercent)}</span>
                    </div>
                    <Progress
                      label={`${window.label}使用量`}
                      tone={
                        (window.usedPercent ?? 0) > 85
                          ? "danger"
                          : (window.usedPercent ?? 0) > 65
                            ? "warning"
                            : "success"
                      }
                      value={window.usedPercent}
                    />
                    <small>
                      {remainingPercentLabel(window.remainingPercent)}
                      {" · "}
                      {window.resetsAt
                        ? `${absoluteTime(window.resetsAt)} 重置`
                        : "重置时间暂时无法读取"}
                    </small>
                  </div>
                ))
              ) : (
                <div className="mini-empty" data-testid="usage-unavailable">
                  额度暂时无法读取
                </div>
              )}
              <div className="usage-subsection">
                <h3>Credits</h3>
                <CreditsList credits={data.usage?.credits} />
              </div>
              <details className="account-usage-details">
                <summary>
                  <span>
                    <strong>账户使用统计</strong>
                    <small>累计、峰值与最近每日用量</small>
                  </span>
                  <Icon name="chevron-down" size={17} />
                </summary>
                <div className="account-usage-stats">
                  <div>
                    <span>累计 tokens</span>
                    <strong>
                      {data.usage?.tokenUsageSummary?.lifetimeTokens ?? "暂时无法读取"}
                    </strong>
                  </div>
                  <div>
                    <span>单日峰值</span>
                    <strong>
                      {data.usage?.tokenUsageSummary?.peakDailyTokens ?? "暂时无法读取"}
                    </strong>
                  </div>
                  <div>
                    <span>最长运行</span>
                    <strong>
                      {data.usage?.tokenUsageSummary?.longestRunningTurnSec === undefined
                        ? "暂时无法读取"
                        : `${data.usage.tokenUsageSummary.longestRunningTurnSec} 秒`}
                    </strong>
                  </div>
                  <div>
                    <span>当前连续使用</span>
                    <strong>
                      {data.usage?.tokenUsageSummary?.currentStreakDays === undefined
                        ? "暂时无法读取"
                        : `${data.usage.tokenUsageSummary.currentStreakDays} 天`}
                    </strong>
                  </div>
                  <div>
                    <span>最长连续使用</span>
                    <strong>
                      {data.usage?.tokenUsageSummary?.longestStreakDays === undefined
                        ? "暂时无法读取"
                        : `${data.usage.tokenUsageSummary.longestStreakDays} 天`}
                    </strong>
                  </div>
                </div>
                {data.usage?.dailyUsageBuckets?.length ? (
                  <div className="daily-usage-list">
                    <strong>最近每日用量</strong>
                    {data.usage.dailyUsageBuckets.slice(-7).map((bucket) => (
                      <div key={bucket.startDate}>
                        <time dateTime={bucket.startDate}>{shortDate(bucket.startDate)}</time>
                        <span>{bucket.tokens} tokens</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mini-empty">每日用量暂时无法读取</div>
                )}
              </details>
            </Card>
          </section>

          <section>
            <h2>会话</h2>
            <Card className="settings-card">
              <div className="settings-row">
                <span className="settings-row__icon">
                  <Icon name="user" size={19} />
                </span>
                <span>
                  <strong>当前浏览器</strong>
                  <small>闲置到期：{absoluteTime(session.idleExpiresAt)}</small>
                </span>
                <StatusPill tone="success">已登录</StatusPill>
              </div>
              <Notice icon="shield" title="会话保护" tone="info">
                Cookie 仅限安全连接，修改密码后旧会话会全部失效。
              </Notice>
              <Button
                onClick={() => {
                  setBusy(true);
                  void onLogout().finally(() => setBusy(false));
                }}
                variant="danger"
              >
                退出当前会话
              </Button>
            </Card>
          </section>

          <section>
            <h2>服务能力</h2>
            <Card className="settings-card capability-list">
              {caps ? (
                (Object.keys(caps) as Array<keyof ProductCapabilities>).map((key) => (
                  <div className="settings-row" key={key}>
                    <span>
                      <strong>{capabilityLabel(key)}</strong>
                      <small>
                        {caps[key] === "degraded"
                          ? "部分功能可能受限"
                          : caps[key] === "unavailable"
                            ? "当前服务未提供"
                            : "功能可用"}
                      </small>
                    </span>
                    <StatusPill tone={capabilityTone(caps[key])}>
                      {capabilityState(caps[key])}
                    </StatusPill>
                  </div>
                ))
              ) : (
                <div className="mini-empty">诊断信息暂时无法读取</div>
              )}
              {diagnostics?.warnings.map((warning) => (
                <Notice icon="alert" key={warning} title="需要注意" tone="warning">
                  {warning}
                </Notice>
              ))}
            </Card>
          </section>
        </div>
        <p className="settings-footer">非官方开源 companion · 不隶属于 OpenAI</p>
      </div>
    </>
  );
}

function ApprovalSheet({
  approval,
  online,
  apiClient,
  onClose,
  onResolved,
}: {
  approval: ApprovalRequest | undefined;
  online: boolean;
  apiClient: ApiClient;
  onClose: () => void;
  onResolved: (id: string) => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState<ApprovalAnswerDrafts>({});

  useEffect(() => {
    setAnswers({});
    setError("");
    setBusy("");
  }, [approval?.id]);

  if (!approval) return null;

  async function resolve(choiceId: string) {
    const requiresAnswers = choiceRequiresAnswers(approval!, choiceId);
    if (
      requiresAnswers &&
      approval!.questions?.some(
        (question) => !isApprovalQuestionAnswered(question, answers[question.id]),
      )
    ) {
      setError("请先回答所有问题；拒绝或取消不要求填写。");
      return;
    }
    setBusy(choiceId);
    setError("");
    try {
      await apiClient.resolveApproval(
        approval!.id,
        requiresAnswers
          ? buildApprovalResolution(choiceId, approval!.questions, answers)
          : { choiceId },
      );
      onResolved(approval!.id);
      onClose();
    } catch (resolveError) {
      setError(errorMessage(resolveError));
    } finally {
      setBusy("");
    }
  }

  return (
    <Sheet
      description={approval.explanation}
      footer={
        <>
          {approval.choices.map((choice) => (
            <Button
              disabled={!online || Boolean(busy)}
              key={choice.id}
              onClick={() => void resolve(choice.id)}
              variant={
                choice.tone === "primary"
                  ? "primary"
                  : choice.tone === "danger"
                    ? "danger"
                    : "secondary"
              }
            >
              {busy === choice.id ? "正在处理…" : choice.label}
            </Button>
          ))}
        </>
      }
      onClose={onClose}
      open
      title={approval.title}
    >
      <div className="approval-detail">
        {approval.command ? (
          <div>
            <span>将执行</span>
            <code>{approval.command}</code>
          </div>
        ) : null}
        {approval.paths?.length ? (
          <div>
            <span>影响范围</span>
            <ul>
              {approval.paths.map((path) => (
                <li key={path}>
                  <Icon name="file" size={16} />
                  <span>{path}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {approval.questions?.length ? (
          <div className="approval-questions">
            <span>需要你的回答</span>
            {approval.questions.map((question) => {
              const draft = answers[question.id];
              const update = (next: { selected?: string; text?: string }) => {
                setAnswers((current) => ({
                  ...current,
                  [question.id]: { ...current[question.id], ...next },
                }));
              };
              return (
                <fieldset className="approval-question" disabled={Boolean(busy)} key={question.id}>
                  <legend>{question.header}</legend>
                  <p>{question.question}</p>
                  {question.options?.length ? (
                    <div className="approval-options">
                      {question.options.map((option) => (
                        <label key={option.label}>
                          <input
                            checked={draft?.selected === option.label}
                            name={`approval-${approval.id}-${question.id}`}
                            onChange={() => update({ selected: option.label })}
                            type="radio"
                            value={option.label}
                          />
                          <span>
                            <strong>{option.label}</strong>
                            <small>{option.description}</small>
                          </span>
                        </label>
                      ))}
                      {question.isOther ? (
                        <label>
                          <input
                            checked={draft?.selected === OTHER_ANSWER}
                            name={`approval-${approval.id}-${question.id}`}
                            onChange={() => update({ selected: OTHER_ANSWER })}
                            type="radio"
                            value={OTHER_ANSWER}
                          />
                          <span>
                            <strong>其他</strong>
                            <small>输入一个自定义回答</small>
                          </span>
                        </label>
                      ) : null}
                      {question.isOther && draft?.selected === OTHER_ANSWER ? (
                        <input
                          aria-label={`${question.header}的其他回答`}
                          autoComplete="off"
                          onChange={(event) => update({ text: event.target.value })}
                          placeholder={question.isSecret ? "输入内容（不会显示）" : "输入其他回答"}
                          type={approvalInputType(question.isSecret)}
                          value={draft.text ?? ""}
                        />
                      ) : null}
                    </div>
                  ) : question.isSecret ? (
                    <input
                      aria-label={question.header}
                      autoComplete="off"
                      onChange={(event) => update({ text: event.target.value })}
                      placeholder="输入内容（不会显示）"
                      type={approvalInputType(question.isSecret)}
                      value={draft?.text ?? ""}
                    />
                  ) : (
                    <textarea
                      aria-label={question.header}
                      onChange={(event) => update({ text: event.target.value })}
                      placeholder="输入回答"
                      rows={3}
                      value={draft?.text ?? ""}
                    />
                  )}
                </fieldset>
              );
            })}
            <small className="approval-questions__hint">
              回答只随本次审批提交；拒绝或取消时不会发送。
            </small>
          </div>
        ) : null}
        {approval.expiresAt ? (
          <p>
            <Icon name="clock" size={16} />
            请在 {absoluteTime(approval.expiresAt)} 前处理
          </p>
        ) : null}
        {!online ? (
          <Notice icon="wifi-off" title="连接恢复后才能处理" tone="danger">
            审批不会在离线时提交。
          </Notice>
        ) : null}
        {error ? (
          <div className="form-error">
            <Icon name="alert" size={17} />
            {error}
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

function Workspace({ session, onLoggedOut }: { session: AuthSession; onLoggedOut: () => void }) {
  const [data, setData] = useState<WorkspaceData>(emptyWorkspace);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [online, setOnline] = useState(true);
  const [liveEvents, setLiveEvents] = useState<LiveEventEnvelope[]>([]);
  const [currentThread, setCurrentThread] = useState<ThreadDetail>();
  const [currentThreadUsage, setCurrentThreadUsage] = useState<UsageSnapshot>();
  const [subagents, setSubagents] = useState<SubagentSummary[]>([]);
  const [threadsNextCursor, setThreadsNextCursor] = useState<string>();
  const [threadsMoreState, setThreadsMoreState] = useState<MoreState>("idle");
  const [threadsMoreError, setThreadsMoreError] = useState("");
  const [archivedThreads, setArchivedThreads] = useState<ThreadSummary[]>([]);
  const [archivedNextCursor, setArchivedNextCursor] = useState<string>();
  const [archivedState, setArchivedState] = useState<DeferredLoadState>("idle");
  const [archivedError, setArchivedError] = useState("");
  const [selectedApproval, setSelectedApproval] = useState<ApprovalRequest>();
  const refreshTimer = useRef<number | undefined>(undefined);
  const loadInFlight = useRef<Promise<void> | undefined>(undefined);
  const initialReplayComplete = useRef(false);
  const liveDeliverySequence = useRef(0);
  const threadsRef = useRef<ThreadSummary[]>([]);
  const threadsNextCursorRef = useRef<string | undefined>(undefined);
  const threadsExtendedRef = useRef(false);
  const workspaceReadyRef = useRef(false);
  const threadsMoreInFlightRef = useRef(false);
  const archivedThreadsRef = useRef<ThreadSummary[]>([]);
  const archivedNextCursorRef = useRef<string | undefined>(undefined);
  const archivedInFlightRef = useRef(false);
  const isDesktop = useMediaQuery("(min-width: 1100px)");

  const load = useCallback(() => {
    if (loadInFlight.current !== undefined) return loadInFlight.current;
    const promise = (async () => {
      try {
        const [projects, models, collaborationModes, threadsPage, usage, diagnostics, approvals] =
          await Promise.all([
            api.projects(),
            api.models(),
            api.collaborationModes().catch(() => [] as CollaborationModeOption[]),
            api.threads({ archived: false }),
            api.usage().catch(() => undefined),
            api.diagnostics().catch(() => undefined),
            api.approvals().catch(() => [] as ApprovalRequest[]),
          ]);
        const threads = workspaceReadyRef.current
          ? mergeCursorItems(threadsRef.current, threadsPage.items, (thread) => thread.id)
          : threadsPage.items;
        const nextCursor = nextCursorAfterRefresh(
          threadsNextCursorRef.current,
          threadsPage.nextCursor,
          threadsExtendedRef.current || threadsMoreInFlightRef.current,
        );
        threadsRef.current = threads;
        threadsNextCursorRef.current = nextCursor;
        setThreadsNextCursor(nextCursor);
        setData({ projects, models, collaborationModes, threads, usage, diagnostics, approvals });
        workspaceReadyRef.current = true;
        setState("ready");
        setError("");
      } catch (loadError) {
        setError(errorMessage(loadError));
        setState((current) => (current === "loading" ? "error" : current));
      }
    })();
    loadInFlight.current = promise;
    void promise.finally(() => {
      if (loadInFlight.current === promise) loadInFlight.current = undefined;
    });
    return promise;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMoreThreads() {
    const cursor = threadsNextCursorRef.current;
    if (!cursor || threadsMoreInFlightRef.current) return;
    threadsMoreInFlightRef.current = true;
    setThreadsMoreState("loading");
    setThreadsMoreError("");
    try {
      const page = await api.threads({ archived: false, cursor });
      const threads = mergeCursorItems(
        threadsRef.current,
        page.items,
        (thread) => thread.id,
        "append",
      );
      threadsRef.current = threads;
      threadsExtendedRef.current = true;
      threadsNextCursorRef.current = page.nextCursor;
      setThreadsNextCursor(page.nextCursor);
      setData((current) => ({ ...current, threads }));
      setThreadsMoreState("idle");
    } catch (loadError) {
      setThreadsMoreError(errorMessage(loadError));
      setThreadsMoreState("error");
    } finally {
      threadsMoreInFlightRef.current = false;
    }
  }

  async function loadArchivedPage(cursor?: string) {
    if (archivedInFlightRef.current) return;
    archivedInFlightRef.current = true;
    setArchivedState("loading");
    setArchivedError("");
    try {
      const page = await api.threads({
        archived: true,
        ...(cursor ? { cursor } : {}),
      });
      const threads = cursor
        ? mergeCursorItems(archivedThreadsRef.current, page.items, (thread) => thread.id, "append")
        : page.items;
      archivedThreadsRef.current = threads;
      archivedNextCursorRef.current = page.nextCursor;
      setArchivedThreads(threads);
      setArchivedNextCursor(page.nextCursor);
      setArchivedState("ready");
    } catch (loadError) {
      setArchivedError(errorMessage(loadError));
      setArchivedState("error");
    } finally {
      archivedInFlightRef.current = false;
    }
  }

  useEffect(() => {
    let timer: number | undefined;
    let disposed = false;
    const clear = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      clear();
      if (disposed || !canRefreshDocument(document.visibilityState)) return;
      timer = window.setTimeout(() => {
        void load().finally(schedule);
      }, WORKSPACE_REFRESH_MS);
    };
    const onVisibility = () => {
      clear();
      if (canRefreshDocument(document.visibilityState)) {
        void load().finally(schedule);
      }
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      clear();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  useEffect(() => {
    const unsubscribe = api.subscribe((event) => {
      const envelope = {
        deliveryId: ++liveDeliverySequence.current,
        event,
        replayed: !initialReplayComplete.current && event.type !== "connection.ready",
      };
      if (event.type === "connection.ready") {
        initialReplayComplete.current = true;
      }
      setLiveEvents((current) => {
        const next = [...current, envelope];
        return next.length > MAX_LIVE_EVENTS ? next.slice(next.length - MAX_LIVE_EVENTS) : next;
      });
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => void load(), 500);
    }, setOnline);
    return () => {
      unsubscribe();
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, [load]);

  async function logout() {
    await api.logout();
    onLoggedOut();
  }

  function resolvedApproval(id: string) {
    setData((current) => ({
      ...current,
      approvals: current.approvals.filter((approval) => approval.id !== id),
    }));
  }

  if (state === "loading") {
    return (
      <div className="workspace-loading">
        <Wordmark />
        <span className="spinner" />
        <p>正在连接你的电脑…</p>
      </div>
    );
  }
  if (state === "error") {
    return (
      <main className="center-state">
        <span className="center-state__icon center-state__icon--danger">
          <Icon name="alert" size={28} />
        </span>
        <h1>工作区加载失败</h1>
        <p>{error}</p>
        <Button icon="refresh" onClick={() => void load()} variant="primary">
          重新加载
        </Button>
      </main>
    );
  }

  return (
    <div className="workspace" data-testid="app-shell">
      <ConnectionBanner demo={api.demo} online={online} />
      {isDesktop ? <DesktopRail threads={data.threads} /> : null}
      <main className="workspace-main">
        <Routes>
          <Route
            element={<HomePage data={data} online={online} onOpenApproval={setSelectedApproval} />}
            path="/"
          />
          <Route
            element={
              <ThreadsPage
                archivedError={archivedError}
                archivedNextCursor={archivedNextCursor}
                archivedState={archivedState}
                archivedThreads={archivedThreads}
                moreError={threadsMoreError}
                moreState={threadsMoreState}
                nextCursor={threadsNextCursor}
                onLoadArchived={() => void loadArchivedPage()}
                onLoadMore={() => void loadMoreThreads()}
                onLoadMoreArchived={() => void loadArchivedPage(archivedNextCursorRef.current)}
                threads={data.threads}
              />
            }
            path="/threads"
          />
          <Route
            element={
              <ConversationPage
                apiClient={api}
                liveEvents={liveEvents}
                models={data.models}
                onSubagentsLoaded={setSubagents}
                onThreadLoaded={setCurrentThread}
                onUsageLoaded={setCurrentThreadUsage}
                online={online}
                threadSummaries={data.threads}
              />
            }
            path="/threads/:id"
          />
          <Route
            element={
              <NewThreadPage
                apiClient={api}
                collaborationModes={data.collaborationModes}
                models={data.models}
                projects={data.projects}
              />
            }
            path="/new"
          />
          <Route
            element={<FileBrowserPage apiClient={api} online={online} projects={data.projects} />}
            path="/files"
          />
          <Route
            element={
              <SettingsPage
                data={data}
                onLogout={logout}
                onRefresh={load}
                online={online}
                session={session}
              />
            }
            path="/settings"
          />
          <Route element={<Navigate replace to="/" />} path="*" />
        </Routes>
      </main>
      {isDesktop ? (
        <RightInspector
          approvals={data.approvals}
          currentThread={currentThread}
          onOpenApproval={setSelectedApproval}
          subagents={subagents}
          threadUsage={currentThreadUsage}
          usage={data.usage}
        />
      ) : (
        <MobileNav approvalCount={data.approvals.length} />
      )}
      <ApprovalSheet
        apiClient={api}
        approval={selectedApproval}
        onClose={() => setSelectedApproval(undefined)}
        onResolved={resolvedApproval}
        online={online}
      />
    </div>
  );
}

export function App() {
  const [bootstrap, setBootstrap] = useState<PublicBootstrap>();
  const [session, setSession] = useState<AuthSession>();
  const [state, setState] = useState<LoadState>("loading");

  const initialize = useCallback(async () => {
    setState("loading");
    try {
      const result = await api.bootstrap();
      setBootstrap(result);
      if (result.authenticated) {
        setSession(await api.session());
      }
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  if (state === "loading") {
    return (
      <div className="workspace-loading">
        <Wordmark />
        <span className="spinner" />
        <p>正在安全连接…</p>
      </div>
    );
  }
  if (state === "error" || !bootstrap) return <ConnectionError onRetry={() => void initialize()} />;
  if (!session) {
    return (
      <AuthGate
        bootstrap={bootstrap}
        onAuthenticated={(authenticatedSession) => {
          setSession(authenticatedSession);
          setBootstrap(authenticatedBootstrap(bootstrap));
        }}
      />
    );
  }
  return (
    <Workspace
      onLoggedOut={() => {
        setSession(undefined);
        setBootstrap(loggedOutBootstrap(bootstrap));
      }}
      session={session}
    />
  );
}
