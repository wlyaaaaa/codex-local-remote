import {
  createContext,
  Fragment,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
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
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type {
  ApprovalPolicyOption,
  ApprovalRequest,
  ApprovalReviewerOption,
  AuthSession,
  CollaborationModeOption,
  ConversationAttachment,
  DiagnosticSnapshot,
  FileEntry,
  FileListing,
  FileRoot,
  ResolvedFileEntry,
  LocalInputReference,
  ModelOption,
  PermissionProfileOption,
  ProductCapabilities,
  ProjectSummary,
  PublicBootstrap,
  QueuedTurnItem,
  ReasoningEffort,
  RemoteEvent,
  RunState,
  SubagentHistoryIntegrity,
  SubagentSummary,
  ThreadDetail,
  ThreadGoal,
  ThreadSettingsInput,
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
import { ApiRequestError, createApiClient, type ApiClient, type SubagentCursorPage } from "./api";
import { authenticatedBootstrap, loggedOutBootstrap } from "./auth-state";
import { browserAttentionTitle } from "./browser-attention";
import {
  OTHER_ANSWER,
  approvalInputType,
  buildApprovalResolution,
  choiceRequiresAnswers,
  isApprovalQuestionAnswered,
  type ApprovalAnswerDrafts,
} from "./approval";
import {
  approvalPolicyDescription,
  approvalPolicyLabel,
  chooseApprovalPolicy,
} from "./approval-policies";
import {
  approvalReviewerDescription,
  approvalReviewerLabel,
  chooseApprovalReviewer,
} from "./approval-reviewers";
import { canDirectlyCompose } from "./permissions";
import {
  applyContextCompactionEvents,
  beginContextCompactionRequest,
  canRequestContextCompaction,
  contextCompactionItemsForDisplay,
  contextCompactionAttemptFromThread,
  markContextCompactionRecoveryRequired,
  reconcileContextCompactionSnapshot,
  type ContextCompactionAttempt,
  type ContextCompactionRequestFlight,
  type ContextCompactionRequestState,
  type ContextCompactionResolution,
} from "./context-compaction";
import { PaginationFooter } from "./PaginationFooter";
import { registeredProjects } from "./project-access";
import {
  WORKSPACE_REFRESH_MS,
  approvalForCurrentThread,
  canRefreshDocument,
  isTextEntryElement,
  reconcileFetchedApprovals,
  resolvedApprovalId,
  threadRefreshDelay,
  workspaceEventNeedsRefresh,
} from "./refresh";
import {
  mergeCursorItems,
  mergeRefreshedFirstPage,
  nextCursorAfterRefresh,
  type CursorPage,
} from "./pagination";
import { defaultReasoningEffortForModel, normalizeReasoningEffortForModel } from "./model-effort";
import {
  chooseCollaborationMode,
  choosePermissionProfileId,
  chooseServiceTier,
  newThreadRuntimeSettings,
} from "./new-thread-settings";
import {
  clearNewThreadDraft,
  initialNewThreadProject,
  readNewThreadDraft,
  writeNewThreadDraft,
} from "./new-thread-draft";
import {
  activeWorkLogSegmentIndex,
  activitySummary,
  assistantPhaseForDisplay,
  conversationContentItems,
  currentLivePhase,
  groupConversationItems,
  latestPlanProgress,
  subagentActivityStatusForDisplay,
  workLogSegmentBelongsToActiveTurn,
  workLogHeadline,
  workLogSummary,
} from "./conversation-presentation";
import { fileChangeStatusLabel, toolFallbackSummary } from "./terminal-display";
import { DiffView } from "./DiffView";
import { encodeLocalFileHrefForMarkdown, localFileReferenceFromHref } from "./file-link";
import {
  localeCopy,
  readUiLocale,
  writeUiLocale,
  type UiLocale,
  type UiLocaleCopy,
} from "./locale";
import { homeActivityThreads, isHomeActivityThread } from "./home-activity";
import {
  applyThreadRemoteEvents,
  applyUsageRemoteEvents,
  cancelSubmittedTurnUserAlias,
  consumeNextTurnSettingsDraft,
  createThreadRemoteEventProjectionState,
  detailFromThreadSummary,
  nextTurnSettingsInput,
  nextTurnSettingsDraft,
  rememberSubmittedTurnUserAlias,
  reserveSubmittedTurnUserAlias,
  reconcileThreadSnapshotLists,
  reconcileNextTurnSettingsDraft,
  synchronizeThreadRemoteEventProjection,
  threadControlSnapshotIsCurrent,
  threadSummaryFromSnapshotEvent,
  updateNextTurnSettingsDraft,
} from "./live-thread";
import {
  compactThreadNavigationState,
  findCreationPromptLiveAliasItemId,
  mergeAuthoritativeThreadControl,
  mergeThreadRefresh,
  persistedCreationPromptItemId,
  readThreadNavigationCache,
  reconcileLiveCreationPromptAlias,
  sortThreadsForDisplay,
  threadInitialPromptFromNavigationState,
  threadNavigationState,
  threadSeedFromNavigationState,
  writeThreadNavigationCache,
} from "./thread-navigation";
import { threadLocationLabelForDisplay, threadTitleForDisplay } from "./thread-title";
import { UserMessageText } from "./UserMessageText";
import {
  ComposerSettingsButton,
  ComposerSettingsSheet,
  ComposerToolsSheet,
  DeliveryModeSwitch,
  GoalSheet,
  InlineDecisionStack,
  PermissionButton,
  PlanProgressControl,
  PlanModeSheet,
  QueueShelf,
  type ComposerDestination,
} from "./ComposerControls";
import {
  collaborationModeSetting,
  CODEX_DEFAULT_SERVICE_TIER,
  composerCapabilityState,
  composerDeliveryDecision,
  composerFeatureSupported,
  filterThreadApprovals,
  moveQueueItem,
  serviceTierDisplayLabel,
  serviceTierSetting,
  serviceTierOptions,
  type ComposerCapabilities,
} from "./composer-product";
import {
  contextPresentation,
  contextUsageOrbLabel,
  creditBalanceLabel,
  formatUtc8Time,
  quotaPresentation,
  remainingContextPercentLabel,
  remainingFromUsedPercent,
  remainingPercentLabel,
  usageWindowForDisplay,
  usedPercentLabel,
} from "./usage-display";
import {
  INITIAL_CONVERSATION_ITEM_LIMIT,
  hiddenConversationItemCount,
  nextConversationItemLimit,
  visibleConversationItems,
} from "./conversation-window";
import { reduceRuntimeNotice, type RuntimeNotice } from "./runtime-notice";
import { dismissNotice, noticeDismissalKey, readNoticeDismissal } from "./notice-dismissal";
import { workspaceLoadFailurePolicy } from "./workspace-recovery";
import { copyPlainText } from "./clipboard";
import {
  rejectedApprovalReviewerId,
  threadSettingsReadbackMismatches,
} from "./thread-settings-readback";

const api = createApiClient();

const UiLocaleContext = createContext<{
  copy: UiLocaleCopy;
  locale: UiLocale;
  setLocale: (locale: UiLocale) => void;
}>({
  copy: localeCopy("zh"),
  locale: "zh",
  setLocale: () => undefined,
});

function useUiLocale() {
  return useContext(UiLocaleContext);
}

type LoadState = "loading" | "ready" | "error";
type MoreState = "idle" | "loading" | "error";
type DeferredLoadState = "idle" | LoadState;
type ThreadActionMenuMode = "closed" | "menu" | "rename";
type ThreadListMutation = { kind: "rename"; name: string } | { kind: "archive"; archived: boolean };
type ThreadActionFeedback = {
  kind: "busy" | "success" | "warning" | "error";
  message: string;
  threadId: string;
};
type ThreadMutationReceipt = {
  mutation: ThreadListMutation;
  threadId: string;
};

type ThreadListReadback = CursorPage<ThreadSummary> & {
  firstPageItemCount?: number;
};

type AuthoritativeThreadLists = {
  current: ThreadListReadback;
  archived: ThreadListReadback;
};

const THREAD_LIST_READBACK_MAX_PAGES = 100;

async function readThreadListThroughTarget(
  apiClient: Pick<ApiClient, "threads">,
  archived: boolean,
  targetThreadId: string,
  maxPages: number,
): Promise<ThreadListReadback> {
  let cursor: string | undefined;
  let firstPageItemCount = 0;
  let items: ThreadSummary[] = [];
  const seenCursors = new Set<string>();

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await apiClient.threads({
      archived,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (pageIndex === 0) firstPageItemCount = page.items.length;
    items = mergeCursorItems(items, page.items, (thread) => thread.id, "append");
    const nextCursor = page.nextCursor;
    if (items.some((thread) => thread.id === targetThreadId) || nextCursor === undefined) {
      return {
        firstPageItemCount,
        items,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error("电脑端对话列表分页游标重复，无法确认操作结果");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return {
    firstPageItemCount,
    items,
    ...(cursor === undefined ? {} : { nextCursor: cursor }),
  };
}

export async function readAuthoritativeThreadLists(
  apiClient: Pick<ApiClient, "threads">,
  targetThreadId: string,
  maxPages = THREAD_LIST_READBACK_MAX_PAGES,
): Promise<AuthoritativeThreadLists> {
  const [current, archived] = await Promise.all([
    readThreadListThroughTarget(apiClient, false, targetThreadId, maxPages),
    readThreadListThroughTarget(apiClient, true, targetThreadId, maxPages),
  ]);
  return { current, archived };
}

type ThreadListRefreshResult = { kind: "converged" } | { kind: "failed"; error: unknown };
type ThreadListMutationResult =
  | { kind: "converged" }
  | { kind: "committed-refreshing"; refresh: Promise<ThreadListRefreshResult> };

const THREAD_LIST_CONVERGENCE_RETRY_DELAYS_MS = [400, 1_200, 2_500] as const;
const THREAD_MUTATION_RECEIPTS_STORAGE_KEY = "codex-remote:thread-mutation-receipts:v1";

function waitForThreadListRefresh(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

function browserSessionStorage(): Storage | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

function isThreadMutationReceipt(value: unknown): value is ThreadMutationReceipt {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    mutation?: { archived?: unknown; kind?: unknown; name?: unknown };
    threadId?: unknown;
  };
  if (typeof candidate.threadId !== "string" || !candidate.threadId) return false;
  if (candidate.mutation?.kind === "rename") {
    return typeof candidate.mutation.name === "string" && candidate.mutation.name.length > 0;
  }
  return candidate.mutation?.kind === "archive" && typeof candidate.mutation.archived === "boolean";
}

export function readThreadMutationReceipts(
  storage = browserSessionStorage(),
): Map<string, ThreadMutationReceipt> {
  if (!storage) return new Map();
  try {
    const parsed: unknown = JSON.parse(
      storage.getItem(THREAD_MUTATION_RECEIPTS_STORAGE_KEY) ?? "[]",
    );
    if (!Array.isArray(parsed)) return new Map();
    return new Map(
      parsed.filter(isThreadMutationReceipt).map((receipt) => [receipt.threadId, receipt] as const),
    );
  } catch {
    return new Map();
  }
}

export function writeThreadMutationReceipts(
  receipts: ReadonlyMap<string, ThreadMutationReceipt>,
  storage = browserSessionStorage(),
): void {
  if (!storage) return;
  try {
    if (receipts.size === 0) {
      storage.removeItem(THREAD_MUTATION_RECEIPTS_STORAGE_KEY);
    } else {
      storage.setItem(THREAD_MUTATION_RECEIPTS_STORAGE_KEY, JSON.stringify([...receipts.values()]));
    }
  } catch {
    // A private or storage-constrained browser still keeps the in-memory gate.
  }
}

export function threadMutationMatchesAuthoritativeLists(
  lists: AuthoritativeThreadLists,
  receipt: ThreadMutationReceipt,
): boolean {
  const current = lists.current.items.find((thread) => thread.id === receipt.threadId);
  const archived = lists.archived.items.find((thread) => thread.id === receipt.threadId);
  const currentAbsenceVerified = current === undefined && lists.current.nextCursor === undefined;
  const archivedAbsenceVerified = archived === undefined && lists.archived.nextCursor === undefined;
  if (receipt.mutation.kind === "rename") {
    return (
      ((current !== undefined && archivedAbsenceVerified) ||
        (archived !== undefined && currentAbsenceVerified)) &&
      (current ?? archived)?.title === receipt.mutation.name
    );
  }
  return receipt.mutation.archived
    ? currentAbsenceVerified && archived !== undefined
    : current !== undefined && archivedAbsenceVerified;
}

export function mergeThreadListReadback(
  current: readonly ThreadSummary[],
  currentNextCursor: string | undefined,
  loadedTailIds: ReadonlySet<string>,
  readback: ThreadListReadback,
): {
  items: ThreadSummary[];
  loadedTailIds: ReadonlySet<string>;
  nextCursor: string | undefined;
} {
  const firstPageItemCount = Math.min(
    readback.firstPageItemCount ?? readback.items.length,
    readback.items.length,
  );
  const incomingIds = new Set(readback.items.map((thread) => thread.id));
  const preservedTail =
    readback.nextCursor === undefined
      ? []
      : current.filter((thread) => loadedTailIds.has(thread.id) && !incomingIds.has(thread.id));
  const items = [...readback.items, ...preservedTail];
  const nextLoadedTailIds = new Set([
    ...readback.items.slice(firstPageItemCount).map((thread) => thread.id),
    ...preservedTail.map((thread) => thread.id),
  ]);
  return {
    items,
    loadedTailIds: nextLoadedTailIds,
    nextCursor:
      readback.nextCursor === undefined
        ? undefined
        : loadedTailIds.size > 0
          ? currentNextCursor
          : readback.nextCursor,
  };
}

export async function convergeThreadLists({
  apply,
  initialError,
  read,
  retryDelaysMs = THREAD_LIST_CONVERGENCE_RETRY_DELAYS_MS,
  wait = waitForThreadListRefresh,
}: {
  apply: (lists: AuthoritativeThreadLists) => void;
  initialError?: unknown;
  read: () => Promise<AuthoritativeThreadLists>;
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
}): Promise<ThreadListRefreshResult> {
  let lastError = initialError;
  if (initialError === undefined) {
    try {
      apply(await read());
      return { kind: "converged" };
    } catch (readError) {
      lastError = readError;
    }
  }
  for (const delayMs of retryDelaysMs) {
    try {
      await wait(delayMs);
      apply(await read());
      return { kind: "converged" };
    } catch (refreshError) {
      lastError = refreshError;
    }
  }
  return { error: lastError, kind: "failed" };
}

export async function commitThenConvergeThreadLists({
  apply,
  commit,
  onCommitted,
  read,
  retryDelaysMs = THREAD_LIST_CONVERGENCE_RETRY_DELAYS_MS,
  wait = waitForThreadListRefresh,
}: {
  apply: (lists: AuthoritativeThreadLists) => void;
  commit: () => Promise<void>;
  onCommitted?: () => void;
  read: () => Promise<AuthoritativeThreadLists>;
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
}): Promise<ThreadListMutationResult> {
  await commit();
  onCommitted?.();

  try {
    apply(await read());
    return { kind: "converged" };
  } catch (initialError) {
    const refresh = convergeThreadLists({
      apply,
      initialError,
      read,
      retryDelaysMs,
      wait,
    });
    return { kind: "committed-refreshing", refresh };
  }
}

type ThreadActionMenuPosition = { left: number; top: number };
type FloatingRect = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
};

export function anchoredThreadActionMenuPosition({
  anchor,
  bottomBoundary,
  floating,
  margin = 12,
  viewportWidth,
}: {
  anchor: FloatingRect;
  bottomBoundary: number;
  floating: Pick<FloatingRect, "height" | "width">;
  margin?: number;
  viewportWidth: number;
}): ThreadActionMenuPosition {
  const gap = 6;
  const belowTop = anchor.bottom + gap;
  const aboveTop = anchor.top - gap - floating.height;
  const top =
    belowTop + floating.height <= bottomBoundary
      ? belowTop
      : aboveTop >= margin
        ? aboveTop
        : Math.max(margin, bottomBoundary - floating.height);
  const left = Math.min(
    Math.max(margin, anchor.right - floating.width),
    Math.max(margin, viewportWidth - margin - floating.width),
  );
  return { left, top };
}

type LiveEventEnvelope = {
  deliveryId: number;
  event: RemoteEvent;
  replayed: boolean;
};

export function partitionLiveDeliveriesAtReset<T extends { event: { type: string } }>(
  pending: readonly T[],
): { beforeReset: T[]; reset?: T; afterReset: T[] } {
  let resetIndex = -1;
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (pending[index]?.event.type === "connection.reset") {
      resetIndex = index;
      break;
    }
  }
  if (resetIndex < 0) {
    return { beforeReset: [...pending], afterReset: [] };
  }
  return {
    beforeReset: pending.slice(0, resetIndex),
    reset: pending[resetIndex]!,
    afterReset: pending.slice(resetIndex + 1),
  };
}

export function isReplayDelivery(
  envelope: Pick<LiveEventEnvelope, "deliveryId" | "replayed">,
  retainedReplayThrough: number,
): boolean {
  return envelope.replayed || envelope.deliveryId <= retainedReplayThrough;
}

export function threadIdFromConversationPath(pathname: string): string | undefined {
  const match = /^\/threads\/([^/]+)$/u.exec(pathname);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

export type WorkspaceSnapshotEventCursor = {
  cursor: string;
  threadId: string;
};

export function retainWorkspaceSnapshotEventCursor(
  current: WorkspaceSnapshotEventCursor | undefined,
  activeThreadId: string | undefined,
  observed: WorkspaceSnapshotEventCursor,
): WorkspaceSnapshotEventCursor | undefined {
  if (observed.threadId !== activeThreadId) return current;
  return current?.threadId === observed.threadId ? current : observed;
}

export function retainWorkspaceSnapshotEventCursorForCurrentRoute(
  current: WorkspaceSnapshotEventCursor | undefined,
  activeThreadIdRef: Readonly<{ current: string | undefined }>,
  observed: WorkspaceSnapshotEventCursor,
): WorkspaceSnapshotEventCursor | undefined {
  return retainWorkspaceSnapshotEventCursor(current, activeThreadIdRef.current, observed);
}

export function workspaceBootstrapEventCursor(
  current: WorkspaceSnapshotEventCursor | undefined,
  activeThreadId: string | undefined,
): string | undefined {
  return current !== undefined && current.threadId === activeThreadId ? current.cursor : undefined;
}

export function subscribeWorkspaceEventStream(
  apiClient: Pick<ApiClient, "subscribe">,
  onEvent: (event: RemoteEvent) => void,
  onConnection: (online: boolean) => void,
  threadId: string | undefined,
  cursor: string | undefined,
): () => void {
  return apiClient.subscribe(
    onEvent,
    onConnection,
    threadId
      ? {
          threadId,
          ...(cursor === undefined ? {} : { cursor }),
        }
      : undefined,
  );
}

type FilePreviewDerivedState = {
  generation: number;
  requestKey: string;
  state: LoadState;
  text: string;
  url: string;
  contentType: string;
  error: string;
};

type FilePreviewRequest = Pick<FilePreviewDerivedState, "generation" | "requestKey">;

export function filePreviewRequestKey(projectId: string | undefined, relativePath: string): string {
  return JSON.stringify([projectId, relativePath]);
}

function loadingFilePreviewState(request: FilePreviewRequest): FilePreviewDerivedState {
  return {
    ...request,
    state: "loading",
    text: "",
    url: "",
    contentType: "",
    error: "",
  };
}

export function visibleFilePreviewState(
  state: FilePreviewDerivedState,
  requestKey: string,
  generation: number,
): FilePreviewDerivedState {
  return state.requestKey === requestKey && state.generation === generation
    ? state
    : loadingFilePreviewState({ requestKey, generation });
}

export function isCurrentFilePreviewRequest(
  current: FilePreviewRequest,
  candidate: FilePreviewRequest,
): boolean {
  return current.generation === candidate.generation && current.requestKey === candidate.requestKey;
}

type LatestRequestController = {
  begin: (requestKey: string) => FilePreviewRequest;
  cancel: () => void;
  isCurrent: (candidate: FilePreviewRequest) => boolean;
};

export function createLatestRequestController(): LatestRequestController {
  let current: FilePreviewRequest = { generation: 0, requestKey: "" };
  return {
    begin(requestKey) {
      current = { generation: current.generation + 1, requestKey };
      return current;
    },
    cancel() {
      current = { generation: current.generation + 1, requestKey: "" };
    },
    isCurrent(candidate) {
      return isCurrentFilePreviewRequest(current, candidate);
    },
  };
}

function useLatestRequestController(): LatestRequestController {
  const controller = useRef<LatestRequestController | undefined>(undefined);
  if (controller.current === undefined) {
    controller.current = createLatestRequestController();
  }
  useEffect(
    () => () => {
      controller.current?.cancel();
    },
    [],
  );
  return controller.current;
}

type InterruptTerminalPollOptions = {
  attempts?: number;
  intervalMs?: number;
  wait?: (delayMs: number) => Promise<void>;
};

export async function pollInterruptTerminal(
  requestedTurnId: string,
  readActiveTurnId: () => Promise<string | undefined>,
  options: InterruptTerminalPollOptions = {},
): Promise<{ state: "terminal" } | { state: "still-active"; lastError?: unknown }> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 8));
  const intervalMs = Math.max(0, options.intervalMs ?? 250);
  const wait =
    options.wait ??
    ((delayMs: number) => new Promise<void>((resolve) => window.setTimeout(resolve, delayMs)));
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const activeTurnId = await readActiveTurnId();
      lastError = undefined;
      if (activeTurnId !== requestedTurnId) {
        return { state: "terminal" };
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts - 1) {
      await wait(intervalMs);
    }
  }

  return lastError === undefined ? { state: "still-active" } : { state: "still-active", lastError };
}

const MAX_LIVE_EVENTS = 2_048;
const markdownSanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [
      ...(defaultSchema.protocols?.href ?? []),
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
      "file",
    ],
  },
};

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
  idle: "空闲",
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

function runtimeOptionLabel(id: string): string {
  const compact = id.replace(/[_-]+/gu, " ").trim();
  if (!compact) return "Codex 动态选项";
  return compact.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function permissionProfileLabel(id: string): string {
  const labels: Readonly<Record<string, string>> = {
    ":danger-full-access": "完全访问",
    ":read-only": "只读",
    ":workspace": "工作区",
  };
  return labels[id] ?? runtimeOptionLabel(id);
}

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
    approvalPolicies: "审批策略",
    approvalReviewers: "审批方式",
    collaborationModes: "协作模式",
    compact: "上下文压缩",
    desktopSnapshots: "Desktop 同步",
    fileBrowser: "项目文件",
    goals: "任务目标",
    inlineApprovals: "线程内审批",
    liveEvents: "共享任务实时事件",
    permissionProfiles: "动态权限",
    queue: "下一轮队列",
    serviceTiers: "速度档位",
    settingsUpdate: "下一轮设置同步",
    subagents: "子智能体",
    usage: "额度信息",
  };
  return labels[value];
}

function capabilityTone(
  value: ProductCapabilities[keyof ProductCapabilities] | undefined,
): StatusTone {
  if (value === "available") return "success";
  if (value === "degraded") return "warning";
  return "danger";
}

function capabilityState(value: ProductCapabilities[keyof ProductCapabilities] | undefined) {
  if (value === "available") return "正常";
  if (value === "degraded") return "有限可用";
  return "不可用";
}

export function appServerReady(capabilities: ComposerCapabilities | undefined): boolean {
  return (capabilities as Record<string, unknown> | undefined)?.appServer === "available";
}

export function hostStatus(
  online: boolean,
  capabilities: ComposerCapabilities | undefined,
): { label: string; ready: boolean; tone: StatusTone } {
  const ready = online && appServerReady(capabilities);
  return {
    label: ready ? "电脑在线" : online ? "兼容性待确认" : "连接中断",
    ready,
    tone: ready ? "success" : online ? "warning" : "danger",
  };
}

export function conversationControlState(
  online: boolean,
  capabilities: ComposerCapabilities | undefined,
  snapshot: boolean,
): { available: boolean; reason: string } {
  if (!online) {
    return { available: false, reason: "与电脑的实时连接已中断" };
  }
  if (!appServerReady(capabilities)) {
    return { available: false, reason: "Codex 运行时兼容性待确认" };
  }
  if (snapshot) {
    return { available: false, reason: "先把这项历史任务接入 Desktop，才能继续操作" };
  }
  return { available: true, reason: "" };
}

export function canShowThreadComposer(
  thread: Pick<
    ThreadDetail,
    "activeTurnId" | "availableActions" | "mode" | "parentThreadId" | "state"
  >,
  _controlAvailable: boolean,
): boolean {
  if (thread.mode === "desktop-snapshot" || thread.parentThreadId) {
    return false;
  }
  // A managed task keeps its local draft surface while the live control channel
  // reconnects. Only the mutating actions are disabled while offline.
  if (thread.mode === "managed") return true;
  const running =
    Boolean(thread.activeTurnId) ||
    thread.state === "running" ||
    thread.state === "waiting-for-approval";
  return canDirectlyCompose(thread) || (thread.mode === "managed" && running);
}

export function composerDraftReadOnly(composerExpanded: boolean, _online: boolean): boolean {
  return !composerExpanded;
}

export function desktopSnapshotPresentation(
  parentThreadId: string | undefined,
  snapshotDelaySeconds: number | undefined,
): {
  description: string;
  resumable: boolean;
  statusLabel: string;
  title: string;
} {
  if (parentThreadId) {
    return {
      description:
        "这里会完整显示子智能体的进度与结果。子智能体由父任务控制；需要补充要求时，请返回父对话。",
      resumable: false,
      statusLabel: "子智能体",
      title: "子智能体记录",
    };
  }
  return {
    description: `当前显示的是电脑上的历史记录，内容可能延迟${
      snapshotDelaySeconds ? `约 ${snapshotDelaySeconds} 秒` : ""
    }。接入后会把同一任务同步到 Desktop、Web 和手机；不需要先在电脑里手动打开。`,
    resumable: true,
    statusLabel: "历史记录",
    title: "这是一项历史任务",
  };
}

export function shouldSeedThreadFromLateSummary(
  currentThreadId: string | undefined,
  routeSeedId: string | undefined,
  summaryId: string | undefined,
): boolean {
  return currentThreadId === undefined && routeSeedId === undefined && summaryId !== undefined;
}

export function shouldCommitThreadGoalLoad(
  goalLoaded: boolean,
  goalResult: { goal: ThreadGoal | null } | undefined,
): goalResult is { goal: ThreadGoal | null } {
  return !goalLoaded && goalResult !== undefined;
}

export function shouldReadThreadGoal(capabilities: ComposerCapabilities | undefined): boolean {
  return composerCapabilityState(capabilities, "goal") !== "unavailable";
}

export function shouldShowConversationLoading(
  detailProjectionReady: boolean,
  _visibleItemCount: number,
): boolean {
  return !detailProjectionReady;
}

export function initialConversationScrollTop(scrollHeight: number, clientHeight: number): number {
  if (!Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) return 0;
  return Math.max(0, scrollHeight - clientHeight);
}

export function conversationHistoryAnchorTop(
  previousScrollTop: number,
  previousScrollHeight: number,
  nextScrollHeight: number,
): number {
  if (
    !Number.isFinite(previousScrollTop) ||
    !Number.isFinite(previousScrollHeight) ||
    !Number.isFinite(nextScrollHeight)
  ) {
    return 0;
  }
  return Math.max(0, previousScrollTop + Math.max(0, nextScrollHeight - previousScrollHeight));
}

export function conversationAwayFromBottom(
  scrollHeight: number,
  clientHeight: number,
  scrollTop: number,
  threshold = 24,
): boolean {
  return scrollHeight - clientHeight - scrollTop > threshold;
}

export function conversationAwayAfterScroll(
  currentAway: boolean,
  previousScrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  scrollTop: number,
  threshold = 24,
): boolean {
  const awayFromBottom = conversationAwayFromBottom(
    scrollHeight,
    clientHeight,
    scrollTop,
    threshold,
  );
  const movedUp = scrollTop < previousScrollTop - 1;
  const movedDown = scrollTop > previousScrollTop + 1;
  if (currentAway) {
    return !(movedDown && !awayFromBottom);
  }
  return movedUp && awayFromBottom;
}

export function conversationScrollWasUserDriven(
  lastIntentAt: number,
  now: number,
  intentWindowMs = 800,
): boolean {
  return (
    Number.isFinite(lastIntentAt) &&
    Number.isFinite(now) &&
    lastIntentAt > 0 &&
    now >= lastIntentAt &&
    now - lastIntentAt <= intentWindowMs
  );
}

export type ComposerExpansionIntent =
  | "blur"
  | "conversation-scroll"
  | "focus"
  | "submit"
  | "thread-change";

export function composerExpandedAfterIntent(intent: ComposerExpansionIntent): boolean {
  return intent === "focus";
}

export function collapsedComposerText(text: string, maxLength = 36): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  if (characters.length === 0) return "";
  const hidesStructure = normalized !== text.trim();
  if (characters.length <= maxLength) return hidesStructure ? `${normalized}…` : normalized;
  if (maxLength <= 1) return "…";
  return `${characters.slice(0, maxLength - 1).join("")}…`;
}

export function focusComposerControlAtEnd(
  control: Pick<
    HTMLTextAreaElement,
    "focus" | "scrollHeight" | "scrollTop" | "setSelectionRange" | "value"
  >,
): void {
  control.focus({ preventScroll: true });
  const end = control.value.length;
  control.setSelectionRange(end, end);
  control.scrollTop = control.scrollHeight;
}

export function prependConversationHistory(
  current: ThreadDetail,
  olderPage: ThreadDetail,
): { added: number; detail: ThreadDetail } {
  const currentIds = new Set(current.items.map((item) => item.id));
  const olderItems = olderPage.items.filter((item) => !currentIds.has(item.id));
  const { historyNextCursor: _previousCursor, ...currentWithoutCursor } = current;
  return {
    added: olderItems.length,
    detail: {
      ...currentWithoutCursor,
      ...(olderPage.historyNextCursor === undefined
        ? {}
        : { historyNextCursor: olderPage.historyNextCursor }),
      items: [...olderItems, ...current.items],
    },
  };
}

export async function readThreadControlBeforeSubmit(
  client: Pick<ApiClient, "threadShell">,
  threadId: string,
): Promise<ThreadDetail> {
  return client.threadShell(threadId);
}

export async function readThreadRefreshSnapshots(
  client: Pick<ApiClient, "thread" | "threadShell">,
  threadId: string,
  current?: Pick<ThreadDetail, "activeTurnId" | "state">,
): Promise<{ control?: ThreadDetail; detail: ThreadDetail }> {
  const detail = await client.thread(threadId);
  const needsFreshControl = [current, detail].some(
    (candidate) =>
      candidate?.activeTurnId !== undefined ||
      candidate?.state === "running" ||
      candidate?.state === "waiting-for-approval",
  );
  if (!needsFreshControl) {
    return { detail };
  }
  try {
    return {
      control: await client.threadShell(threadId),
      detail,
    };
  } catch {
    // The bounded transcript snapshot and live event stream remain usable if a
    // lightweight control read races a transient app-server reconnect.
    return { detail };
  }
}

export function appendOptimisticUserMessage(
  thread: ThreadDetail,
  prompt: string,
  itemId: string,
  turnId?: string,
): ThreadDetail {
  return {
    ...thread,
    items: [
      ...thread.items,
      {
        id: itemId,
        kind: "user-message",
        text: prompt,
        ...(turnId === undefined ? {} : { turnId }),
      },
    ],
  };
}

export function removeOptimisticConversationItem(
  thread: ThreadDetail,
  itemId: string,
): ThreadDetail {
  return {
    ...thread,
    items: thread.items.filter((item) => item.id !== itemId),
  };
}

export function mergeQueuedThreadRefresh(
  current: ThreadDetail,
  incoming: ThreadDetail,
): ThreadDetail {
  return mergeThreadRefresh(current, incoming);
}

export function composerActionVisibility(
  running: boolean,
  canInterrupt: boolean,
  hasDraft: boolean,
  interruptAccepted = false,
  controlAvailable = true,
): { showInterrupt: boolean; showSubmit: boolean } {
  const waitingForTerminalRefresh = running && interruptAccepted;
  return {
    showInterrupt: running && canInterrupt && controlAvailable && !waitingForTerminalRefresh,
    showSubmit: !running || waitingForTerminalRefresh || hasDraft,
  };
}

export function readConversationAttachments(
  storage: Pick<Storage, "getItem">,
  threadId: string,
): LocalInputReference[] {
  try {
    const raw = storage.getItem(`conversation-attachments:${encodeURIComponent(threadId)}`);
    if (raw === null) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > 20) return [];
    const attachments: LocalInputReference[] = [];
    for (const candidate of value) {
      if (typeof candidate !== "object" || candidate === null) return [];
      const reference = candidate as Record<string, unknown>;
      const projectId =
        typeof reference.projectId === "string" && reference.projectId.length <= 512
          ? reference.projectId
          : undefined;
      const uploadId =
        typeof reference.uploadId === "string" && reference.uploadId.length <= 512
          ? reference.uploadId
          : undefined;
      if (
        (projectId === undefined) === (uploadId === undefined) ||
        (reference.kind !== "file" && reference.kind !== "directory") ||
        (uploadId !== undefined && reference.kind !== "file") ||
        typeof reference.relativePath !== "string" ||
        !reference.relativePath ||
        reference.relativePath.length > 32_768 ||
        reference.relativePath.includes("\0")
      ) {
        return [];
      }
      attachments.push({
        kind: reference.kind,
        relativePath: reference.relativePath,
        ...(projectId === undefined ? {} : { projectId }),
        ...(uploadId === undefined ? {} : { uploadId }),
      });
    }
    return attachments;
  } catch {
    return [];
  }
}

export function writeConversationAttachments(
  storage: Pick<Storage, "removeItem" | "setItem">,
  threadId: string,
  attachments: readonly LocalInputReference[],
): void {
  const key = `conversation-attachments:${encodeURIComponent(threadId)}`;
  try {
    if (attachments.length === 0) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, JSON.stringify(attachments.slice(0, 20)));
  } catch {
    // Attachment references are best-effort drafts and must never block task control.
  }
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

function LanguageToggle({ className = "" }: { className?: string }) {
  const { copy, locale, setLocale } = useUiLocale();
  return (
    <button
      aria-label={copy.languageLabel}
      className={`language-toggle ${className}`.trim()}
      data-testid="language-toggle"
      onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
      type="button"
    >
      <span>{copy.languageChoice}</span>
    </button>
  );
}

function localizedThreadLocation(thread: ThreadSummary, copy: UiLocaleCopy): string {
  const location = threadLocationLabelForDisplay(thread);
  return location === "无项目" ? copy.unprojected : location;
}

function Wordmark() {
  const { copy } = useUiLocale();
  return (
    <div className="wordmark">
      <span className="wordmark__mark">
        <Icon name="terminal" size={20} />
      </span>
      <span>
        <strong>Local Remote</strong>
        <small>{copy.brandSubtitle}</small>
      </span>
    </div>
  );
}

function MarkdownLocalImage({
  alt,
  apiClient,
  online,
  projectId,
  source,
}: {
  alt?: string;
  apiClient: ApiClient;
  online: boolean;
  projectId?: string;
  source: string;
}) {
  const [entry, setEntry] = useState<ResolvedFileEntry>();
  const [state, setState] = useState<"loading" | "ready" | "error">(online ? "loading" : "error");
  const [error, setError] = useState(online ? "" : "电脑当前离线");
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (!online) {
      setState("error");
      setError("电脑当前离线");
      return;
    }
    let active = true;
    let objectUrl = "";
    setState("loading");
    setError("");
    setEntry(undefined);
    setUrl("");
    void apiClient
      .resolveFile(projectId, source)
      .then(async (resolved) => {
        const result = await apiClient.preview(resolved.projectId, resolved.relativePath);
        if (!result.contentType.startsWith("image/")) {
          throw new Error("这个引用不是可预览的图片");
        }
        objectUrl = URL.createObjectURL(result.blob);
        if (!active) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = "";
          return;
        }
        setEntry(resolved);
        setUrl(objectUrl);
        setState("ready");
      })
      .catch((imageError: unknown) => {
        if (!active) return;
        setError(errorMessage(imageError));
        setState("error");
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [apiClient, online, projectId, source]);

  return (
    <figure className="markdown-local-image">
      {state === "loading" ? (
        <div className="markdown-local-image__loading">
          <Skeleton />
        </div>
      ) : state === "ready" && url && entry ? (
        <>
          <a href={url} rel="noreferrer" target="_blank" title="打开原图">
            <img alt={alt || entry.name} loading="lazy" src={url} />
          </a>
          <figcaption>
            <span>{alt || entry.name}</span>
            <a
              download={entry.name}
              href={apiClient.downloadUrl(entry.projectId, entry.relativePath)}
            >
              <Icon name="download" size={14} />
              下载
            </a>
          </figcaption>
        </>
      ) : (
        <span className="unsafe-content-note">图片暂时不可用：{error}</span>
      )}
    </figure>
  );
}

function Markdown({
  apiClient,
  children,
  compact = false,
  online = false,
  projectId,
}: {
  apiClient?: ApiClient;
  children: string;
  compact?: boolean;
  online?: boolean;
  projectId?: string;
}) {
  const [linkedFile, setLinkedFile] = useState<FileEntry>();
  const [linkedFileProjectId, setLinkedFileProjectId] = useState<string>();
  const [linkedFileLine, setLinkedFileLine] = useState<number>();
  const [linkedFileError, setLinkedFileError] = useState("");
  const [linkedFileLoading, setLinkedFileLoading] = useState(false);
  const linkedFileRequests = useLatestRequestController();

  function closeLinkedFile() {
    linkedFileRequests.cancel();
    setLinkedFile(undefined);
    setLinkedFileProjectId(undefined);
    setLinkedFileLine(undefined);
    setLinkedFileError("");
    setLinkedFileLoading(false);
  }

  return (
    <>
      <div className={compact ? "markdown markdown--compact" : "markdown"}>
        <ReactMarkdown
          rehypePlugins={[[rehypeSanitize, markdownSanitizeSchema]]}
          skipHtml
          urlTransform={(value) =>
            encodeLocalFileHrefForMarkdown(value) ?? defaultUrlTransform(value)
          }
          components={{
            a: ({ children: linkChildren, href, ...props }) => {
              const localReference = localFileReferenceFromHref(href);
              return localReference ? (
                <a
                  {...props}
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    const request = linkedFileRequests.begin(
                      filePreviewRequestKey(projectId, localReference.path),
                    );
                    setLinkedFile(undefined);
                    setLinkedFileProjectId(undefined);
                    setLinkedFileLine(localReference.line);
                    setLinkedFileError("");
                    if (!online || !apiClient) {
                      setLinkedFileError("电脑当前离线，恢复连接后才能打开这个文件。");
                      setLinkedFileLoading(false);
                      return;
                    }
                    setLinkedFileLoading(true);
                    void apiClient
                      .resolveFile(projectId, localReference.path)
                      .then((entry) => {
                        if (!linkedFileRequests.isCurrent(request)) return;
                        setLinkedFile(entry);
                        setLinkedFileProjectId(entry.projectId);
                      })
                      .catch((error: unknown) => {
                        if (linkedFileRequests.isCurrent(request)) {
                          setLinkedFileError(errorMessage(error));
                        }
                      })
                      .finally(() => {
                        if (linkedFileRequests.isCurrent(request)) setLinkedFileLoading(false);
                      });
                  }}
                >
                  {linkChildren}
                </a>
              ) : (
                <a {...props} href={href} rel="noreferrer" target="_blank">
                  {linkChildren}
                </a>
              );
            },
            img: ({ alt, src }) => {
              const localReference = localFileReferenceFromHref(src);
              if (localReference && apiClient) {
                return (
                  <MarkdownLocalImage
                    {...(alt === undefined ? {} : { alt })}
                    apiClient={apiClient}
                    online={online}
                    {...(projectId === undefined ? {} : { projectId })}
                    source={localReference.path}
                  />
                );
              }
              if (src && /^https?:/i.test(src)) {
                return (
                  <a href={src} rel="noreferrer" target="_blank" title="打开原图">
                    <img alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" src={src} />
                  </a>
                );
              }
              return <span className="unsafe-content-note">图片链接不可用</span>;
            },
          }}
        >
          {children}
        </ReactMarkdown>
      </div>
      <Sheet
        onClose={closeLinkedFile}
        open={linkedFileLoading || linkedFile !== undefined || Boolean(linkedFileError)}
        title={linkedFile?.name ?? (linkedFileLoading ? "正在打开文件" : "无法打开文件")}
      >
        {linkedFileLoading ? (
          <div className="activity-detail__loading">
            <Skeleton />
            <Skeleton width="72%" />
          </div>
        ) : linkedFileError ? (
          <EmptyState description={linkedFileError} icon="alert" title="文件不可用" />
        ) : linkedFile && apiClient && linkedFileProjectId ? (
          linkedFile.kind === "file" ? (
            <FilePreview
              apiClient={apiClient}
              embedded
              entry={linkedFile}
              downloadLabel="下载最新源文件"
              {...(linkedFileLine !== undefined ? { focusLine: linkedFileLine } : {})}
              online={online}
              projectId={linkedFileProjectId}
            />
          ) : (
            <EmptyState
              description="这是一个文件夹。请从输入框的“文件和文件夹”入口添加，或前往文件页浏览。"
              icon="folder"
              title="已定位文件夹"
            />
          )
        ) : null}
      </Sheet>
    </>
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

function noticeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(noticeText).join(" ");
  if (isValidElement<{ children?: ReactNode }>(node)) return noticeText(node.props.children);
  return "";
}

export function Notice({
  tone = "info",
  icon,
  title,
  children,
  action,
  dismissKey,
  dismissible = true,
}: {
  tone?: StatusTone;
  icon: IconName;
  title: string;
  children: ReactNode;
  action?: ReactNode;
  dismissKey?: string;
  dismissible?: boolean;
}) {
  const key =
    dismissKey ??
    noticeDismissalKey(
      window.location.hash || window.location.pathname,
      title,
      noticeText(children),
    );
  const [dismissed, setDismissed] = useState(
    () => dismissible && readNoticeDismissal(window.localStorage, key),
  );

  useEffect(() => {
    setDismissed(dismissible && readNoticeDismissal(window.localStorage, key));
  }, [dismissible, key]);

  if (dismissed) return null;

  return (
    <div className={`notice notice--${tone}`}>
      <Icon name={icon} size={20} />
      <div>
        <strong>{title}</strong>
        <div>{children}</div>
      </div>
      {action ? <span className="notice__action">{action}</span> : null}
      {dismissible ? (
        <button
          aria-label={`关闭提示：${title}`}
          className="notice__dismiss"
          onClick={() => {
            dismissNotice(window.localStorage, key);
            setDismissed(true);
          }}
          title="关闭，刷新后不再显示"
          type="button"
        >
          <Icon name="close" size={15} />
        </button>
      ) : null}
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
  const { copy } = useUiLocale();
  return (
    <NavLink
      className={({ isActive }) => `thread-row ${isActive ? "is-active" : ""}`}
      data-testid={thread.id === "unsafe-content-thread" ? "unsafe-content-thread" : undefined}
      to={`/threads/${thread.id}`}
    >
      <span className={`thread-row__state thread-row__state--${thread.state}`} />
      <span className="thread-row__body">
        <strong>{threadTitleForDisplay(thread.title)}</strong>
        <span>
          {thread.pinnedRank === undefined ? "" : `${copy.pinned} · `}
          {thread.mode === "desktop-snapshot"
            ? copy.history
            : localizedThreadLocation(thread, copy)}
          {!compact ? ` · ${timeAgo(thread.updatedAt)}` : ""}
        </span>
      </span>
      {thread.pinnedRank === undefined ? null : (
        <span aria-label="已置顶" className="thread-row__pin">
          <Icon name="pin" size={15} />
        </span>
      )}
      {thread.state === "waiting-for-approval" ? <Icon name="alert" size={17} /> : null}
    </NavLink>
  );
}

function navItems(copy: UiLocaleCopy): Array<{
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
}> {
  return [
    { to: "/", label: copy.nav[0], icon: "message", end: true },
    { to: "/files", label: copy.nav[1], icon: "folder" },
    { to: "/settings", label: copy.nav[2], icon: "settings" },
  ];
}

function DesktopRail({ threads }: { threads: ThreadSummary[] }) {
  const { copy } = useUiLocale();
  const sorted = sortThreadsForDisplay(threads);
  const pinned = sorted.filter((thread) => thread.pinnedRank !== undefined).slice(0, 3);
  const recent = sorted.filter((thread) => thread.pinnedRank === undefined).slice(0, 3);
  return (
    <aside className="desktop-rail">
      <div className="desktop-rail__brand">
        <Wordmark />
        <Button
          aria-label={copy.newTask}
          icon="plus"
          variant="primary"
          onClick={() => {
            window.location.hash = "#/new";
          }}
          size="compact"
        >
          {copy.newShort}
        </Button>
      </div>
      <nav aria-label="主导航" className="rail-nav" data-testid="primary-navigation">
        {navItems(copy).map((item) => (
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
      {pinned.length > 0 ? (
        <>
          <div className="rail-section-heading">
            <span>{copy.pinned}</span>
            <NavLink to="/">{copy.viewAll}</NavLink>
          </div>
          <div className="rail-threads">
            {pinned.map((thread) => (
              <ThreadRow compact key={thread.id} thread={thread} />
            ))}
          </div>
        </>
      ) : null}
      <div className="rail-section-heading">
        <span>{copy.recent}</span>
        {pinned.length === 0 ? <NavLink to="/">{copy.viewAll}</NavLink> : null}
      </div>
      <div className="rail-threads">
        {recent.map((thread) => (
          <ThreadRow compact key={thread.id} thread={thread} />
        ))}
      </div>
      <div className="rail-footer">
        <span className="connection-dot" />
        <span>{copy.connected}</span>
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
  const { copy } = useUiLocale();
  return (
    <header className="mobile-header">
      {back ? (
        <Button
          aria-label={copy.back}
          icon="arrow-left"
          onClick={() => navigate(-1)}
          size="icon"
          variant="ghost"
        />
      ) : (
        <span aria-hidden="true" className="mobile-header__spacer" />
      )}
      <strong>{title}</strong>
      <span className="mobile-header__action">{action ?? <span />}</span>
    </header>
  );
}

function MobileNav({ approvalCount }: { approvalCount: number }) {
  const { copy } = useUiLocale();
  return (
    <nav aria-label="主导航" className="mobile-nav" data-testid="primary-navigation">
      {navItems(copy).map((item) => (
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
            {item.to === "/" && approvalCount > 0 ? <b>{approvalCount}</b> : null}
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

function UsageOrb({
  usage,
  refreshing,
  open,
  buttonRef,
  onClick,
}: {
  usage: UsageSnapshot | undefined;
  refreshing: boolean;
  open: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  const presentation = contextPresentation(usage);
  const usedPercent = presentation.usedPercent;
  const ringPercent = Math.max(0, Math.min(100, usedPercent ?? 0));
  return (
    <button
      aria-label={contextUsageOrbLabel(presentation, refreshing)}
      aria-controls="conversation-usage-panel"
      aria-expanded={open}
      className={`usage-orb usage-orb--${presentation.state}`}
      data-testid="usage-open"
      onClick={onClick}
      ref={buttonRef}
      title={contextUsageOrbLabel(presentation, false)}
      type="button"
    >
      <span
        aria-hidden="true"
        className="usage-orb__ring"
        style={{
          background: `conic-gradient(var(--usage-orb-color) ${ringPercent}%, var(--usage-orb-track) 0)`,
        }}
      >
        <span>
          {refreshing ? (
            <Icon name="activity" size={14} />
          ) : usedPercent === undefined ? (
            "—"
          ) : (
            Math.round(usedPercent)
          )}
        </span>
      </span>
    </button>
  );
}

function UsageMini({
  usage,
  preferredModel,
}: {
  usage: UsageSnapshot | undefined;
  preferredModel?: string;
}) {
  const window = usageWindowForDisplay(usage?.windows, preferredModel);
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
        {window.resetsAt ? `${formatUtc8Time(window.resetsAt)} 重置` : "重置时间暂时无法读取"}
      </small>
      {(usage?.windows.length ?? 0) > 1 ? (
        <small>另有 {(usage?.windows.length ?? 1) - 1} 个额度窗口，可在详情查看</small>
      ) : null}
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
        <UsageMini
          {...(currentThread?.model ? { preferredModel: currentThread.model } : {})}
          usage={usage}
        />
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
                {remainingContextPercentLabel(
                  remainingFromUsedPercent(threadUsage?.context?.usedPercent),
                )}
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

export function ThreadActionMenuView({
  archived,
  busy,
  feedback,
  menuPosition,
  menuRef,
  mode,
  onArchiveChange,
  onCopy,
  onRename,
  onRenameValueChange,
  onRequestClose,
  onRequestRename,
  onRetryConvergence,
  online,
  pendingConvergence = false,
  renameValue,
  thread,
  triggerRef,
}: {
  archived: boolean;
  busy: boolean;
  feedback: string;
  menuPosition?: ThreadActionMenuPosition | undefined;
  menuRef?: RefObject<HTMLDivElement | null>;
  mode: ThreadActionMenuMode;
  onArchiveChange: (archived: boolean) => void;
  onCopy: () => void;
  onRename: () => void;
  onRenameValueChange?: (value: string) => void;
  onRequestClose: () => void;
  onRequestRename: () => void;
  onRetryConvergence?: () => void;
  online: boolean;
  pendingConvergence?: boolean;
  renameValue: string;
  thread: ThreadSummary;
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const menuId = `thread-actions-menu-${thread.id.replaceAll(/[^A-Za-z0-9_-]/gu, "-")}`;
  const offlineReasonId = `${menuId}-offline-reason`;
  const activeReasonId = `${menuId}-active-reason`;
  const busyReasonId = `${menuId}-busy-reason`;
  const pendingReasonId = `${menuId}-pending-reason`;
  const archiveBlockedByActiveTurn =
    !archived && (thread.state === "running" || thread.state === "waiting-for-approval");
  const mutationBlocked = busy || !online || pendingConvergence;
  const mutationReasonIds = [
    busy ? busyReasonId : undefined,
    !online ? offlineReasonId : undefined,
    pendingConvergence ? pendingReasonId : undefined,
  ].filter((value): value is string => value !== undefined);
  const archiveReasonIds = [
    ...mutationReasonIds,
    archiveBlockedByActiveTurn ? activeReasonId : undefined,
  ].filter((value): value is string => value !== undefined);
  return (
    <>
      <button
        aria-controls={menuId}
        aria-expanded={mode !== "closed"}
        aria-haspopup="dialog"
        aria-label={`管理对话：${threadTitleForDisplay(thread.title)}`}
        className="thread-actions__trigger"
        data-testid={`thread-actions-${thread.id}`}
        onClick={mode === "closed" ? onRequestRename : onRequestClose}
        ref={triggerRef}
        type="button"
      >
        <Icon name="more" size={20} />
      </button>
      {mode === "closed" ? null : (
        <div
          aria-label={`对话操作：${threadTitleForDisplay(thread.title)}`}
          className="thread-actions__menu"
          data-positioned={menuPosition !== undefined}
          data-testid={`thread-actions-menu-${thread.id}`}
          id={menuId}
          ref={menuRef}
          role="dialog"
          style={menuPosition}
        >
          {mode === "rename" ? (
            <form
              className="thread-actions__rename"
              onSubmit={(event) => {
                event.preventDefault();
                onRename();
              }}
            >
              <label>
                <span>新对话名称</span>
                <input
                  autoFocus
                  disabled={mutationBlocked}
                  maxLength={200}
                  onChange={(event) => onRenameValueChange?.(event.target.value)}
                  value={renameValue}
                />
              </label>
              <div>
                <button
                  aria-describedby={
                    mutationReasonIds.length ? mutationReasonIds.join(" ") : undefined
                  }
                  disabled={mutationBlocked || renameValue.trim().length === 0}
                  type="submit"
                >
                  {busy ? "保存中…" : "保存"}
                </button>
                <button onClick={onRequestClose} type="button">
                  取消
                </button>
              </div>
            </form>
          ) : (
            <div className="thread-actions__list">
              <button
                aria-describedby={
                  mutationReasonIds.length ? mutationReasonIds.join(" ") : undefined
                }
                aria-disabled={mutationBlocked}
                onClick={() => {
                  if (!mutationBlocked) onRequestRename();
                }}
                type="button"
              >
                <Icon name="edit" size={17} />
                重命名
              </button>
              <button onClick={onCopy} type="button">
                <Icon name="copy" size={17} />
                复制对话 ID
              </button>
              <button
                aria-describedby={archiveReasonIds.length ? archiveReasonIds.join(" ") : undefined}
                aria-disabled={mutationBlocked || archiveBlockedByActiveTurn}
                onClick={() => {
                  if (!mutationBlocked && !archiveBlockedByActiveTurn) {
                    onArchiveChange(!archived);
                  }
                }}
                type="button"
              >
                <Icon name={archived ? "arrow-up" : "arrow-down"} size={17} />
                {archived ? "恢复对话" : "归档"}
              </button>
              {pendingConvergence ? (
                <button
                  aria-describedby={!online ? offlineReasonId : undefined}
                  aria-disabled={busy || !online}
                  onClick={() => {
                    if (!busy && online) onRetryConvergence?.();
                  }}
                  type="button"
                >
                  <Icon name="refresh" size={17} />
                  重新同步
                </button>
              ) : null}
              <small>
                <Icon name="pin" size={14} />
                置顶请在 Desktop 管理
              </small>
            </div>
          )}
          <div className="thread-actions__reasons">
            {archiveBlockedByActiveTurn ? (
              <small id={activeReasonId}>请先停止正在运行的任务再归档</small>
            ) : null}
            {pendingConvergence ? (
              <small id={pendingReasonId}>上次操作已提交；请先重新同步，避免重复或冲突操作</small>
            ) : null}
            {!online ? <small id={offlineReasonId}>连接恢复后才能修改对话</small> : null}
            {busy ? <small id={busyReasonId}>正在处理此对话，请稍候</small> : null}
          </div>
          {feedback ? (
            <p aria-live="polite" className="thread-actions__feedback">
              {feedback}
            </p>
          ) : null}
        </div>
      )}
    </>
  );
}

function ThreadActionsMenu({
  archived,
  busy,
  busyLabel,
  onArchiveChange,
  onRename,
  onRetryConvergence,
  online,
  pendingConvergence,
  thread,
}: {
  archived: boolean;
  busy: boolean;
  busyLabel: string;
  onArchiveChange: (archived: boolean) => Promise<void>;
  onRename: (name: string) => Promise<void>;
  onRetryConvergence: () => Promise<void>;
  online: boolean;
  pendingConvergence: boolean;
  thread: ThreadSummary;
}) {
  const [mode, setMode] = useState<ThreadActionMenuMode>("closed");
  const [renameValue, setRenameValue] = useState(threadTitleForDisplay(thread.title));
  const [copyFeedback, setCopyFeedback] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const previousModeRef = useRef<ThreadActionMenuMode>("closed");
  const [menuPosition, setMenuPosition] = useState<ThreadActionMenuPosition>();

  useEffect(() => {
    if (mode === "closed") return;
    const closeForOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setMode("closed");
      }
    };
    const closeForEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMode("closed");
    };
    document.addEventListener("pointerdown", closeForOutsidePointer);
    document.addEventListener("keydown", closeForEscape);
    return () => {
      document.removeEventListener("pointerdown", closeForOutsidePointer);
      document.removeEventListener("keydown", closeForEscape);
    };
  }, [mode]);

  useLayoutEffect(() => {
    const previousMode = previousModeRef.current;
    previousModeRef.current = mode;
    if (mode === "closed") {
      setMenuPosition(undefined);
      if (previousMode !== "closed" && triggerRef.current?.isConnected) {
        triggerRef.current.focus();
      }
      return;
    }
    const target =
      mode === "rename"
        ? menuRef.current?.querySelector<HTMLInputElement>("input")
        : menuRef.current?.querySelector<HTMLButtonElement>(
            "button:not([disabled]):not([aria-disabled='true'])",
          );
    const frame = window.requestAnimationFrame(() => target?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [mode]);

  useLayoutEffect(() => {
    if (mode === "closed") return;
    const position = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const obstructionTops = [
        ...document.querySelectorAll<HTMLElement>(".mobile-nav, .mobile-approval-bar"),
      ]
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.height > 0 && rect.top < viewportHeight)
        .map((rect) => rect.top);
      const bottomBoundary = Math.min(viewportHeight - 12, ...obstructionTops);
      setMenuPosition(
        anchoredThreadActionMenuPosition({
          anchor: trigger.getBoundingClientRect(),
          bottomBoundary,
          floating: menu.getBoundingClientRect(),
          viewportWidth: window.innerWidth,
        }),
      );
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [busy, busyLabel, copyFeedback, mode, online, pendingConvergence]);

  useEffect(() => {
    setRenameValue(threadTitleForDisplay(thread.title));
  }, [thread.title]);

  async function copyId() {
    try {
      await copyPlainText(thread.id);
      setCopyFeedback("已复制对话 ID");
    } catch {
      setCopyFeedback("复制失败，请重试");
    }
  }

  return (
    <div className="thread-actions" ref={rootRef}>
      <ThreadActionMenuView
        archived={archived}
        busy={busy}
        feedback={copyFeedback || (busy ? busyLabel : "")}
        menuPosition={menuPosition}
        menuRef={menuRef}
        mode={mode}
        onArchiveChange={(nextArchived) => {
          void onArchiveChange(nextArchived)
            .then(() => setMode("closed"))
            .catch(() => undefined);
        }}
        onCopy={() => void copyId()}
        onRename={() => {
          const name = renameValue.trim();
          if (!name) return;
          void onRename(name)
            .then(() => setMode("closed"))
            .catch(() => undefined);
        }}
        onRenameValueChange={setRenameValue}
        onRequestClose={() => setMode("closed")}
        onRequestRename={() => {
          setCopyFeedback("");
          setMode((current) => (current === "closed" ? "menu" : "rename"));
        }}
        onRetryConvergence={() => {
          void onRetryConvergence().catch(() => undefined);
        }}
        online={online}
        pendingConvergence={pendingConvergence}
        renameValue={renameValue}
        thread={thread}
        triggerRef={triggerRef}
      />
    </div>
  );
}

function ThreadsPage({
  data,
  online,
  onOpenApproval,
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
  onThreadMutation,
  onThreadConvergenceRetry,
}: {
  data: WorkspaceData;
  online: boolean;
  onOpenApproval: (approval: ApprovalRequest) => void;
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
  onThreadMutation: (
    thread: ThreadSummary,
    mutation: ThreadListMutation,
    onCommitted: () => void,
  ) => Promise<ThreadListMutationResult>;
  onThreadConvergenceRetry: (
    thread: ThreadSummary,
    mutation: ThreadListMutation,
  ) => Promise<ThreadListRefreshResult>;
}) {
  const navigate = useNavigate();
  const { copy, locale } = useUiLocale();
  const threads = data.threads;
  const active = homeActivityThreads(threads);
  const runtime = hostStatus(online, data.diagnostics?.capabilities);
  const [query, setQuery] = useState("");
  const [archiveScope, setArchiveScope] = useState<"current" | "archived">("current");
  const [filter, setFilter] = useState<"all" | "active" | "snapshot">("all");
  const [busyThreadIds, setBusyThreadIds] = useState<ReadonlySet<string>>(() => new Set());
  const [threadActionFeedback, setThreadActionFeedback] = useState<ThreadActionFeedback>();
  const [threadMutationReceipts, setThreadMutationReceipts] = useState<
    ReadonlyMap<string, ThreadMutationReceipt>
  >(() => readThreadMutationReceipts());
  const threadMutationInFlightRef = useRef(new Set<string>());
  const threadMutationReceiptsRef = useRef(new Map(threadMutationReceipts));
  const visibleThreads = archiveScope === "archived" ? archivedThreads : threads;
  const visibleNextCursor = archiveScope === "archived" ? archivedNextCursor : nextCursor;
  const visibleMoreState = archiveScope === "archived" ? archivedState : moreState;
  const visibleError = archiveScope === "archived" ? archivedError : moreError;
  const visibleLoadMore = archiveScope === "archived" ? onLoadMoreArchived : onLoadMore;
  const filterOptions: ReadonlyArray<readonly ["all" | "active" | "snapshot", string]> = [
    ["all", copy.allTypes],
    ...(archiveScope === "current" ? ([["active", copy.running]] as const) : []),
    ...(visibleThreads.some((thread) => thread.mode === "desktop-snapshot")
      ? ([["snapshot", copy.archivedHistory]] as const)
      : []),
  ];
  const filtered = sortThreadsForDisplay(visibleThreads).filter((thread) => {
    const matchesQuery = `${threadTitleForDisplay(thread.title)} ${thread.cwdLabel ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase());
    const matchesFilter =
      filter === "all" ||
      (filter === "active" && isHomeActivityThread(thread)) ||
      (filter === "snapshot" && thread.mode === "desktop-snapshot");
    return matchesQuery && matchesFilter;
  });

  function setThreadBusy(threadId: string, busy: boolean) {
    setBusyThreadIds((current) => {
      const next = new Set(current);
      if (busy) {
        next.add(threadId);
      } else {
        next.delete(threadId);
      }
      return next;
    });
  }

  function updateThreadMutationReceipt(
    threadId: string,
    receipt: ThreadMutationReceipt | undefined,
  ) {
    const next = new Map(threadMutationReceiptsRef.current);
    if (receipt) {
      next.set(threadId, receipt);
    } else {
      next.delete(threadId);
    }
    threadMutationReceiptsRef.current = next;
    writeThreadMutationReceipts(next);
    setThreadMutationReceipts(next);
  }

  useEffect(() => {
    for (const receipt of threadMutationReceiptsRef.current.values()) {
      const current = threads.find((thread) => thread.id === receipt.threadId);
      const archived = archivedThreads.find((thread) => thread.id === receipt.threadId);
      const matched =
        archivedState === "ready" &&
        (receipt.mutation.kind === "rename"
          ? (current === undefined) !== (archived === undefined) &&
            (current ?? archived)?.title === receipt.mutation.name
          : receipt.mutation.archived
            ? current === undefined && archived !== undefined
            : current !== undefined && archived === undefined);
      if (matched) updateThreadMutationReceipt(receipt.threadId, undefined);
    }
  }, [archivedState, archivedThreads, threads]);

  function selectArchiveScope(scope: "current" | "archived") {
    setArchiveScope(scope);
    setFilter("all");
    if (scope === "archived" && archivedState === "idle") onLoadArchived();
  }

  async function performThreadMutation(thread: ThreadSummary, mutation: ThreadListMutation) {
    if (
      threadMutationInFlightRef.current.has(thread.id) ||
      threadMutationReceiptsRef.current.has(thread.id) ||
      !online
    ) {
      return;
    }
    threadMutationInFlightRef.current.add(thread.id);
    setThreadBusy(thread.id, true);
    const verb = mutation.kind === "rename" ? "重命名" : mutation.archived ? "归档" : "恢复";
    const successMessage =
      mutation.kind === "rename"
        ? `已重命名为“${mutation.name}”`
        : mutation.archived
          ? `已归档“${threadTitleForDisplay(thread.title)}”`
          : `已恢复“${threadTitleForDisplay(thread.title)}”`;
    let refreshContinues = false;
    setThreadActionFeedback({ kind: "busy", message: `正在${verb}…`, threadId: thread.id });
    try {
      const result = await onThreadMutation(thread, mutation, () => {
        updateThreadMutationReceipt(thread.id, { mutation, threadId: thread.id });
      });
      if (result.kind === "converged") {
        updateThreadMutationReceipt(thread.id, undefined);
        setThreadActionFeedback({ kind: "success", message: successMessage, threadId: thread.id });
      } else {
        refreshContinues = true;
        setThreadActionFeedback({
          kind: "busy",
          message: `${verb}操作已完成，但列表刷新失败，正在重试…`,
          threadId: thread.id,
        });
        void result.refresh
          .then((refreshResult) => {
            if (refreshResult.kind === "converged") {
              updateThreadMutationReceipt(thread.id, undefined);
              setThreadActionFeedback({
                kind: "success",
                message: `${successMessage}，列表已刷新`,
                threadId: thread.id,
              });
            } else {
              setThreadActionFeedback({
                kind: "warning",
                message: `${verb}操作已完成，但列表仍未同步；请重新同步后再修改此对话`,
                threadId: thread.id,
              });
            }
          })
          .catch(() => {
            setThreadActionFeedback({
              kind: "warning",
              message: `${verb}操作已完成，但列表仍未同步；请重新同步后再修改此对话`,
              threadId: thread.id,
            });
          })
          .finally(() => {
            threadMutationInFlightRef.current.delete(thread.id);
            setThreadBusy(thread.id, false);
          });
      }
    } catch (mutationError) {
      setThreadActionFeedback({
        kind: "error",
        message: `${verb}失败：${errorMessage(mutationError)}`,
        threadId: thread.id,
      });
      throw mutationError;
    } finally {
      if (!refreshContinues) {
        threadMutationInFlightRef.current.delete(thread.id);
        setThreadBusy(thread.id, false);
      }
    }
  }

  async function retryThreadConvergence(thread: ThreadSummary) {
    const receipt = threadMutationReceiptsRef.current.get(thread.id);
    if (!receipt || !online || threadMutationInFlightRef.current.has(thread.id)) return;
    threadMutationInFlightRef.current.add(thread.id);
    setThreadBusy(thread.id, true);
    setThreadActionFeedback({
      kind: "busy",
      message: "正在重新同步电脑端列表…",
      threadId: thread.id,
    });
    try {
      const result = await onThreadConvergenceRetry(thread, receipt.mutation);
      if (result.kind === "converged") {
        updateThreadMutationReceipt(thread.id, undefined);
        setThreadActionFeedback({
          kind: "success",
          message: "列表已同步，可以继续操作此对话",
          threadId: thread.id,
        });
      } else {
        setThreadActionFeedback({
          kind: "warning",
          message: "列表仍未同步；已继续阻止重复或冲突操作，请稍后重试",
          threadId: thread.id,
        });
      }
    } catch (retryError) {
      setThreadActionFeedback({
        kind: "warning",
        message: `列表仍未同步：${errorMessage(retryError)}`,
        threadId: thread.id,
      });
    } finally {
      threadMutationInFlightRef.current.delete(thread.id);
      setThreadBusy(thread.id, false);
    }
  }

  return (
    <>
      <MobileHeader
        action={
          <span className="mobile-header__controls">
            <LanguageToggle className="language-toggle--header" />
            <Button
              aria-label={copy.newTask}
              data-testid="new-thread"
              disabled={!runtime.ready}
              icon="plus"
              onClick={() => navigate("/new")}
              size="compact"
              variant="primary"
            >
              {copy.newShort}
            </Button>
          </span>
        }
        title={copy.tasks}
      />
      <div className="page list-page">
        <section className="task-overview">
          <span data-testid="current-host-status">
            <StatusPill tone={runtime.tone}>{runtime.label}</StatusPill>
          </span>
          <div>
            <strong>{active.length ? copy.tasksWorking(active.length) : copy.computerReady}</strong>
            <small>
              {data.approvals.length
                ? copy.approvalsWaiting(data.approvals.length)
                : copy.sharedTaskList}
            </small>
          </div>
        </section>
        {online && !runtime.ready ? (
          <Notice icon="alert" title={copy.runtimeDegraded}>
            {copy.runtimeDegradedBody}
          </Notice>
        ) : null}
        {data.approvals.length > 0 ? (
          <button
            className="approval-callout"
            data-testid="approval-open"
            onClick={() => onOpenApproval(data.approvals[0]!)}
          >
            <span className="approval-callout__icon">
              <Icon name="shield" size={21} />
            </span>
            <span>
              <strong>{copy.approvalsWaiting(data.approvals.length)}</strong>
              <small>
                {locale === "zh"
                  ? "查看影响范围后允许或拒绝"
                  : "Review the impact, then allow or deny"}
              </small>
            </span>
            <Icon name="chevron-right" size={20} />
          </button>
        ) : null}
        <div className="page-heading page-heading--action">
          <div>
            <h1>{copy.tasks}</h1>
            <p>{copy.taskPageDescription}</p>
          </div>
          <div className="desktop-page-actions">
            <LanguageToggle />
            <NavLink
              className="desktop-only-button ui-button ui-button--primary ui-button--regular"
              data-testid="new-thread"
              to="/new"
            >
              <Icon name="plus" size={18} />
              {copy.newTask}
            </NavLink>
          </div>
        </div>
        <div aria-label={copy.archiveScopeLabel} className="archive-tabs" role="tablist">
          <button
            aria-selected={archiveScope === "current"}
            onClick={() => selectArchiveScope("current")}
            role="tab"
          >
            {copy.current}
          </button>
          <button
            aria-selected={archiveScope === "archived"}
            onClick={() => selectArchiveScope("archived")}
            role="tab"
          >
            {copy.archived}
          </button>
        </div>
        {threadActionFeedback ? (
          <div
            aria-live="polite"
            className={`thread-action-feedback thread-action-feedback--${threadActionFeedback.kind}`}
            data-testid="thread-action-feedback"
            role={threadActionFeedback.kind === "error" ? "alert" : "status"}
          >
            <Icon
              name={
                threadActionFeedback.kind === "busy"
                  ? "activity"
                  : threadActionFeedback.kind === "success"
                    ? "check"
                    : "alert"
              }
              size={16}
            />
            <span>{threadActionFeedback.message}</span>
            {threadActionFeedback.kind === "busy" ? null : (
              <>
                {threadMutationReceipts.has(threadActionFeedback.threadId) ? (
                  <button
                    aria-label="重新同步对话列表"
                    disabled={!online || busyThreadIds.has(threadActionFeedback.threadId)}
                    onClick={() => {
                      const thread = [...threads, ...archivedThreads].find(
                        (candidate) => candidate.id === threadActionFeedback.threadId,
                      );
                      if (thread) void retryThreadConvergence(thread);
                    }}
                    type="button"
                  >
                    <Icon name="refresh" size={16} />
                  </button>
                ) : null}
                <button
                  aria-label="关闭对话操作状态"
                  onClick={() => setThreadActionFeedback(undefined)}
                  type="button"
                >
                  <Icon name="close" size={16} />
                </button>
              </>
            )}
          </div>
        ) : null}
        <div className="search-field">
          <Icon name="search" size={19} />
          <input
            aria-label={copy.searchTasks}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={archiveScope === "archived" ? copy.searchArchivedTasks : copy.searchTasks}
            value={query}
          />
          {query ? (
            <button aria-label={copy.clearSearch} onClick={() => setQuery("")}>
              <Icon name="close" size={17} />
            </button>
          ) : null}
        </div>
        <div className="filter-tabs" role="tablist">
          {filterOptions.map(([id, label]) => (
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
              {filtered.map((thread, index) => {
                const previous = filtered[index - 1];
                const startsPinnedGroup =
                  thread.pinnedRank !== undefined && previous?.pinnedRank === undefined;
                const startsRecentGroup =
                  thread.pinnedRank === undefined &&
                  (index === 0 || previous?.pinnedRank !== undefined);
                return (
                  <Fragment key={thread.id}>
                    {startsPinnedGroup ? (
                      <div className="thread-list-section-label" data-testid="pinned-threads-group">
                        <Icon name="pin" size={15} />
                        {copy.pinned}
                      </div>
                    ) : null}
                    {startsRecentGroup ? (
                      <div className="thread-list-section-label" data-testid="recent-threads-group">
                        {copy.recent}
                      </div>
                    ) : null}
                    <div className="thread-list-row">
                      <NavLink className="thread-list-item" to={`/threads/${thread.id}`}>
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
                            <strong>{threadTitleForDisplay(thread.title)}</strong>
                            <time>{timeAgo(thread.updatedAt)}</time>
                          </span>
                          <small>{localizedThreadLocation(thread, copy)}</small>
                          <span className="thread-list-item__meta">
                            <StatusPill
                              tone={
                                thread.mode === "desktop-snapshot" ? "info" : runTones[thread.state]
                              }
                            >
                              {thread.mode === "desktop-snapshot"
                                ? copy.history
                                : runLabels[thread.state]}
                            </StatusPill>
                            {thread.pinnedRank === undefined ? null : (
                              <span className="thread-list-item__pin">
                                <Icon name="pin" size={14} />
                                {copy.pinned}
                              </span>
                            )}
                            {thread.model ? <span>{thread.model}</span> : null}
                            {thread.childCount ? <span>{thread.childCount} 个子智能体</span> : null}
                          </span>
                        </span>
                        <Icon name="chevron-right" size={19} />
                      </NavLink>
                      <ThreadActionsMenu
                        archived={archiveScope === "archived"}
                        busy={busyThreadIds.has(thread.id)}
                        busyLabel={
                          threadActionFeedback?.threadId === thread.id
                            ? threadActionFeedback.message
                            : "正在处理此对话…"
                        }
                        onArchiveChange={async (archived) => {
                          await performThreadMutation(thread, { kind: "archive", archived });
                        }}
                        onRename={async (name) => {
                          await performThreadMutation(thread, { kind: "rename", name });
                        }}
                        onRetryConvergence={async () => {
                          await retryThreadConvergence(thread);
                        }}
                        online={online}
                        pendingConvergence={threadMutationReceipts.has(thread.id)}
                        thread={thread}
                      />
                    </div>
                  </Fragment>
                );
              })}
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
                    ? copy.noMatchingDescription
                    : archiveScope === "archived"
                      ? copy.noArchivedDescription
                      : copy.noTasksDescription
                }
                icon={query || filter !== "all" ? "search" : "message"}
                title={
                  query || filter !== "all"
                    ? copy.noMatchingTasks
                    : archiveScope === "archived"
                      ? copy.noArchivedTasks
                      : copy.noTasks
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

function AttachmentThumbnail({
  apiClient,
  attachment,
  online,
  onOpen,
  projectId,
}: {
  apiClient: ApiClient;
  attachment: ConversationAttachment;
  online: boolean;
  onOpen: () => void;
  projectId?: string;
}) {
  const [state, setState] = useState<"loading" | "ready" | "fallback">(
    online ? "loading" : "fallback",
  );
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (!online) {
      setState("fallback");
      return;
    }
    let active = true;
    let objectUrl = "";
    setState("loading");
    setUrl("");
    void apiClient
      .resolveFile(projectId, attachment.path)
      .then(async (entry) => {
        const result = await apiClient.preview(entry.projectId, entry.relativePath);
        if (!result.contentType.startsWith("image/")) {
          throw new Error("不是图片");
        }
        objectUrl = URL.createObjectURL(result.blob);
        if (!active) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = "";
          return;
        }
        setUrl(objectUrl);
        setState("ready");
      })
      .catch(() => {
        if (active) setState("fallback");
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [apiClient, attachment.path, online, projectId]);

  return (
    <button
      aria-label={`预览 ${attachment.name}`}
      className="message-image-thumb"
      onClick={onOpen}
      type="button"
    >
      {state === "ready" && url ? (
        <img alt={attachment.name} loading="lazy" src={url} />
      ) : state === "loading" ? (
        <Skeleton />
      ) : (
        <span>
          <Icon name="file" size={20} />
          {attachment.name}
        </span>
      )}
    </button>
  );
}

function MessageImageGallery({
  apiClient,
  attachments,
  collapsible = false,
  label,
  online,
  onOpen,
  projectId,
}: {
  apiClient: ApiClient;
  attachments: ConversationAttachment[];
  collapsible?: boolean;
  label: string;
  online: boolean;
  onOpen: (attachment: ConversationAttachment) => void;
  projectId?: string;
}) {
  const [expanded, setExpanded] = useState(!collapsible);
  const gallery = expanded ? (
    <div className="message-image-grid">
      {attachments.map((attachment, index) => (
        <AttachmentThumbnail
          apiClient={apiClient}
          attachment={attachment}
          key={`${attachment.path}-${index}`}
          online={online}
          onOpen={() => onOpen(attachment)}
          {...(projectId === undefined ? {} : { projectId })}
        />
      ))}
    </div>
  ) : null;
  if (!collapsible) {
    return (
      <section aria-label={label} className="message-images">
        {gallery}
      </section>
    );
  }
  return (
    <section className="message-images message-images--collapsible">
      <button
        aria-expanded={expanded}
        className="message-images__toggle"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <Icon name="file" size={15} />
        <span>{label}</span>
        <Icon name={expanded ? "chevron-down" : "chevron-right"} size={15} />
      </button>
      {gallery}
    </section>
  );
}

const MessageItem = memo(function MessageItem({
  apiClient,
  item,
  items,
  online,
  projectId,
}: {
  apiClient: ApiClient;
  item: ThreadDetail["items"][number];
  items: ReadonlyArray<ThreadDetail["items"][number]>;
  online: boolean;
  projectId?: string;
}) {
  const [attachmentEntry, setAttachmentEntry] = useState<ResolvedFileEntry>();
  const [attachmentError, setAttachmentError] = useState("");
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const [attachmentSelection, setAttachmentSelection] = useState<ConversationAttachment>();
  const attachmentRequests = useLatestRequestController();
  const phase = assistantPhaseForDisplay(item, items);

  function closeAttachment() {
    attachmentRequests.cancel();
    setAttachmentEntry(undefined);
    setAttachmentError("");
    setAttachmentLoading(false);
    setAttachmentSelection(undefined);
  }

  function openAttachment(attachment: ConversationAttachment) {
    const request = attachmentRequests.begin(filePreviewRequestKey(projectId, attachment.path));
    setAttachmentSelection(attachment);
    setAttachmentEntry(undefined);
    setAttachmentError("");
    if (!online) {
      setAttachmentError("电脑当前离线；附件仍保留在消息中，恢复连接后可预览或下载。");
      setAttachmentLoading(false);
      return;
    }
    setAttachmentLoading(true);
    void apiClient
      .resolveFile(projectId, attachment.path)
      .then((entry) => {
        if (attachmentRequests.isCurrent(request)) setAttachmentEntry(entry);
      })
      .catch((error: unknown) => {
        if (attachmentRequests.isCurrent(request)) setAttachmentError(errorMessage(error));
      })
      .finally(() => {
        if (attachmentRequests.isCurrent(request)) setAttachmentLoading(false);
      });
  }

  const attachmentSheet = (
    <Sheet
      onClose={closeAttachment}
      open={
        attachmentLoading ||
        attachmentSelection !== undefined ||
        attachmentEntry !== undefined ||
        Boolean(attachmentError)
      }
      title={
        attachmentEntry?.name ??
        attachmentSelection?.name ??
        (attachmentLoading ? "正在打开附件" : "附件")
      }
    >
      {attachmentLoading ? (
        <div className="activity-detail__loading">
          <Skeleton />
          <Skeleton width="72%" />
        </div>
      ) : attachmentError ? (
        <EmptyState description={attachmentError} icon="alert" title="附件暂时不可用" />
      ) : attachmentEntry ? (
        <FilePreview
          apiClient={apiClient}
          embedded
          entry={attachmentEntry}
          online={online}
          projectId={attachmentEntry.projectId}
        />
      ) : null}
    </Sheet>
  );

  if (item.kind === "user-message") {
    const imageAttachments =
      item.attachments?.filter((attachment) => attachment.kind === "image") ?? [];
    const fileAttachments =
      item.attachments?.filter((attachment) => attachment.kind !== "image") ?? [];
    return (
      <>
        <article className="message message--user">
          <div className="message__meta">
            <span>你</span>
            {item.createdAt ? <time>{timeAgo(item.createdAt)}</time> : null}
            {item.text ? <CopyMessageButton label="复制你的消息" text={item.text} /> : null}
          </div>
          <div className="message__bubble">
            {item.text ? <UserMessageText>{item.text}</UserMessageText> : null}
            {fileAttachments.length ? (
              <div aria-label="本条消息的附件" className="message__attachments">
                {fileAttachments.map((attachment, index) => (
                  <button
                    key={`${attachment.path}-${index}`}
                    onClick={() => openAttachment(attachment)}
                    type="button"
                  >
                    <Icon name="file" size={15} />
                    <span>{attachment.name}</span>
                    <Icon name="chevron-right" size={15} />
                  </button>
                ))}
              </div>
            ) : null}
            {imageAttachments.length ? (
              <MessageImageGallery
                apiClient={apiClient}
                attachments={imageAttachments}
                label={`本条消息的 ${imageAttachments.length} 张图片`}
                online={online}
                onOpen={openAttachment}
                {...(projectId === undefined ? {} : { projectId })}
              />
            ) : null}
          </div>
        </article>
        {attachmentSheet}
      </>
    );
  }
  if (item.kind === "image-activity") {
    const label =
      item.action === "viewed"
        ? (item.summary ?? `已查看 ${item.attachments.length} 张图像`)
        : (item.summary ?? "AI 生成的图片");
    return (
      <>
        <article className={`image-activity image-activity--${item.action}`}>
          <header>
            <span>
              <Icon name={item.action === "viewed" ? "file" : "spark"} size={15} />
              {label}
            </span>
            {item.status === "failed" ? <small>生成失败</small> : null}
          </header>
          {item.attachments.length ? (
            <MessageImageGallery
              apiClient={apiClient}
              attachments={item.attachments}
              collapsible={item.action === "viewed"}
              label={item.action === "viewed" ? label : "AI 生成的图片"}
              online={online}
              onOpen={openAttachment}
              {...(projectId === undefined ? {} : { projectId })}
            />
          ) : null}
        </article>
        {attachmentSheet}
      </>
    );
  }
  if (item.kind === "assistant-message") {
    return (
      <article className={`message message--assistant message--${phase ?? "answer"}`}>
        <div
          className="message__content"
          data-testid={item.id === "unsafe-content-message" ? "unsafe-content-message" : undefined}
        >
          <div className="message__stage">
            <span>{phase === "commentary" ? "思考" : "回答"}</span>
            {item.createdAt ? <time>{timeAgo(item.createdAt)}</time> : null}
            {phase === "final_answer" ? (
              <CopyMessageButton label="复制最终回答" text={item.text} />
            ) : null}
          </div>
          <Markdown
            apiClient={apiClient}
            online={online}
            {...(projectId === undefined ? {} : { projectId })}
          >
            {item.text}
          </Markdown>
        </div>
      </article>
    );
  }
  if (item.kind === "reasoning-summary") {
    return (
      <article className="message message--assistant message--reasoning">
        <div className="message__content">
          <div className="message__stage">
            <span>思考</span>
            {item.createdAt ? <time>{timeAgo(item.createdAt)}</time> : null}
          </div>
          <Markdown
            apiClient={apiClient}
            online={online}
            {...(projectId === undefined ? {} : { projectId })}
          >
            {item.text}
          </Markdown>
        </div>
      </article>
    );
  }
  if (item.kind === "formal-plan") {
    return (
      <article className="formal-plan">
        <header className="formal-plan__header">
          <span>
            <Icon name="target" size={15} />
            计划
          </span>
          {item.createdAt ? <time>{timeAgo(item.createdAt)}</time> : null}
          <CopyMessageButton label="复制计划" text={item.text} />
        </header>
        <Markdown
          apiClient={apiClient}
          online={online}
          {...(projectId === undefined ? {} : { projectId })}
        >
          {item.text}
        </Markdown>
      </article>
    );
  }
  if (item.kind === "interaction-record") {
    return (
      <article className="interaction-record">
        <header className="interaction-record__header">
          <span>
            <Icon name="message" size={15} />
            {item.title}
          </span>
          <small>{item.status === "answered" ? "已回答" : "已跳过"}</small>
        </header>
        <div className="interaction-record__questions">
          {item.questions.map((question) => {
            const selected = new Set(question.answers ?? []);
            const optionLabels = new Set(question.options?.map((option) => option.label) ?? []);
            const freeAnswers = (question.answers ?? []).filter(
              (answer) => !optionLabels.has(answer),
            );
            return (
              <section className="interaction-record__question" key={question.id}>
                <small>{question.header}</small>
                <strong>{question.question}</strong>
                {question.options?.length ? (
                  <ul className="interaction-record__options">
                    {question.options.map((option) => (
                      <li
                        data-selected={selected.has(option.label) || undefined}
                        key={option.label}
                      >
                        <span>{option.label}</span>
                        <small>{option.description}</small>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {question.isSecret && item.status === "answered" ? (
                  <p className="interaction-record__answer">已提交（内容已隐藏）</p>
                ) : freeAnswers.length ? (
                  <p className="interaction-record__answer">{freeAnswers.join("；")}</p>
                ) : item.status === "skipped" ? (
                  <p className="interaction-record__answer">未提供答案</p>
                ) : null}
              </section>
            );
          })}
        </div>
      </article>
    );
  }
  return null;
});

function CopyMessageButton({ label, text }: { label: string; text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  return (
    <button
      aria-label={label}
      className="message-copy"
      data-copy-state={state}
      onClick={() => {
        void copyPlainText(text)
          .then(() => setState("copied"))
          .catch(() => setState("error"));
      }}
      title={state === "copied" ? "已复制" : state === "error" ? "复制失败" : label}
      type="button"
    >
      <Icon name={state === "copied" ? "check" : "copy"} size={14} />
    </button>
  );
}

function CopyTextButton({ label, text }: { label: string; text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  return (
    <button
      className="ui-button ui-button--secondary ui-button--regular"
      data-copy-state={state}
      data-touch-target="primary"
      onClick={() => {
        void copyPlainText(text)
          .then(() => setState("copied"))
          .catch(() => setState("error"));
      }}
      type="button"
    >
      <Icon name={state === "copied" ? "check" : "copy"} size={18} />
      {state === "copied" ? "已复制" : state === "error" ? "复制失败" : label}
    </button>
  );
}

type ActivityItem = Extract<ThreadDetail["items"][number], { kind: "tool" | "file-change" }>;

export function selectedActivityItem(
  items: ReadonlyArray<ThreadDetail["items"][number]>,
  selectedId: string | undefined,
): ActivityItem | undefined {
  if (selectedId === undefined) return undefined;
  const selected = items.find((item) => item.id === selectedId);
  return selected?.kind === "tool" || selected?.kind === "file-change" ? selected : undefined;
}

function ActivityRow({ item, onOpen }: { item: ActivityItem; onOpen: () => void }) {
  if (item.kind === "tool") {
    const canOpen =
      Boolean(item.detail) ||
      (item.title === "运行命令" && Boolean(item.summary)) ||
      (item.occurrences ?? 0) > 1 ||
      Boolean(item.occurrenceDetails?.length);
    const content = (
      <>
        <span className={`activity-row__state activity-row__state--${item.status}`}>
          <Icon
            name={
              item.status === "running" ? "activity" : item.status === "failed" ? "alert" : "check"
            }
            size={14}
          />
        </span>
        <span className="activity-row__copy">
          <strong>{item.title}</strong>
          <small>{item.summary ?? toolFallbackSummary(item.status)}</small>
        </span>
        {item.occurrences && item.occurrences > 1 ? (
          <span className="occurrence-badge">{item.occurrences} 次</span>
        ) : null}
        {canOpen ? <Icon name="chevron-right" size={15} /> : null}
      </>
    );
    return canOpen ? (
      <button className="activity-row activity-row--button" onClick={onOpen} type="button">
        {content}
      </button>
    ) : (
      <div className="activity-row">{content}</div>
    );
  }
  if (item.kind !== "file-change") return null;
  const status = item.status ?? "completed";
  const content = (
    <>
      <span className={`activity-row__state activity-row__state--${status}`}>
        <Icon
          name={status === "failed" ? "alert" : status === "inProgress" ? "activity" : "file"}
          size={14}
        />
      </span>
      <span className="activity-row__copy">
        <strong>{fileChangeStatusLabel(item.change, status)}</strong>
        <code>{item.path}</code>
        {item.targetPath ? (
          <small>
            移至 <code>{item.targetPath}</code>
          </small>
        ) : null}
      </span>
      <span className="activity-row__stats">
        {item.additions !== undefined ? <b>+{item.additions}</b> : null}
        {item.deletions !== undefined ? <i>-{item.deletions}</i> : null}
      </span>
      <Icon name="chevron-right" size={15} />
    </>
  );
  return (
    <button
      className="activity-row activity-row--button activity-row--file"
      onClick={onOpen}
      type="button"
    >
      {content}
    </button>
  );
}

function ActivityDetailSheet({
  apiClient,
  item,
  online,
  projectId,
  onClose,
}: {
  apiClient: ApiClient;
  item: ActivityItem | undefined;
  online: boolean;
  projectId?: string;
  onClose: () => void;
}) {
  const isFile = item?.kind === "file-change";
  const [view, setView] = useState<"diff" | "file">("diff");
  const [resolvedEntry, setResolvedEntry] = useState<ResolvedFileEntry>();
  const [resolveError, setResolveError] = useState("");
  const [resolving, setResolving] = useState(false);
  const resolveRequests = useLatestRequestController();

  useEffect(() => {
    setView(item?.kind === "file-change" && !item.diff ? "file" : "diff");
    setResolvedEntry(undefined);
    setResolveError("");
  }, [item]);

  useEffect(() => {
    if (!isFile || !item || !online || view !== "file") {
      resolveRequests.cancel();
      setResolving(false);
      return;
    }
    const request = resolveRequests.begin(filePreviewRequestKey(projectId, item.path));
    setResolving(true);
    setResolveError("");
    void apiClient
      .resolveFile(projectId, item.path)
      .then((entry) => {
        if (!resolveRequests.isCurrent(request)) return;
        setResolvedEntry(entry);
      })
      .catch((error: unknown) => {
        if (!resolveRequests.isCurrent(request)) return;
        setResolveError(errorMessage(error));
      })
      .finally(() => {
        if (resolveRequests.isCurrent(request)) setResolving(false);
      });
    return () => {
      resolveRequests.cancel();
    };
  }, [apiClient, isFile, item, online, projectId, resolveRequests, view]);

  const description =
    item?.kind === "file-change"
      ? item.path
      : item?.kind === "tool"
        ? item.title === "运行命令"
          ? "命令与输出"
          : (item.summary ?? toolFallbackSummary(item.status))
        : undefined;

  return (
    <Sheet
      description={description}
      onClose={onClose}
      open={item !== undefined}
      title={
        item?.kind === "file-change"
          ? fileChangeStatusLabel(item.change, item.status ?? "completed")
          : (item?.title ?? "运行详情")
      }
    >
      {item?.kind === "tool" ? (
        <div className="activity-detail">
          <div className="activity-detail__status">
            <StatusPill
              tone={
                item.status === "failed" ? "danger" : item.status === "running" ? "info" : "success"
              }
            >
              {item.status === "failed" ? "失败" : item.status === "running" ? "运行中" : "已完成"}
            </StatusPill>
            {item.occurrences && item.occurrences > 1 ? (
              <span>{item.occurrences} 次调用</span>
            ) : null}
          </div>
          {item.occurrences && item.occurrences > 1 ? (
            <ol className="activity-detail__occurrences">
              {(item.occurrenceDetails ?? []).map((occurrence, index) => (
                <li key={occurrence.id}>
                  <details>
                    <summary>
                      <span
                        className={`activity-row__state activity-row__state--${occurrence.status}`}
                      >
                        <Icon
                          name={
                            occurrence.status === "running"
                              ? "activity"
                              : occurrence.status === "failed"
                                ? "alert"
                                : "check"
                          }
                          size={13}
                        />
                      </span>
                      <span>
                        <strong>第 {index + 1} 次</strong>
                        <small>
                          {occurrence.summary ?? toolFallbackSummary(occurrence.status)}
                        </small>
                      </span>
                      {occurrence.detail ? <Icon name="chevron-down" size={14} /> : null}
                    </summary>
                    <div className="activity-detail__occurrence-body">
                      {occurrence.summary ? (
                        <CopyableDetail
                          label={item.title === "运行命令" ? "命令" : "摘要"}
                          text={occurrence.summary}
                        />
                      ) : null}
                      {occurrence.detail ? (
                        <CopyableDetail
                          label={item.title === "运行命令" ? "输出" : "详情"}
                          text={occurrence.detail}
                        />
                      ) : null}
                    </div>
                  </details>
                </li>
              ))}
            </ol>
          ) : (
            <>
              {item.title === "运行命令" && item.summary ? (
                <CopyableDetail label="命令" text={item.summary} />
              ) : null}
              {item.detail ? (
                <CopyableDetail
                  label={item.title === "运行命令" ? "输出" : "详情"}
                  text={item.detail}
                />
              ) : null}
            </>
          )}
          {(item.occurrences ?? 0) > (item.occurrenceDetails?.length ?? 0) &&
          (item.occurrenceDetails?.length ?? 0) > 0 ? (
            <p className="activity-detail__note">
              已显示 {item.occurrenceDetails?.length} 项；更早的逐项明细未保留在当前快照中。
            </p>
          ) : null}
          {(item.occurrences ?? 0) > 1 && !item.occurrenceDetails?.length ? (
            <p className="activity-detail__note">当前历史快照只有合并计数，没有逐项明细。</p>
          ) : null}
        </div>
      ) : null}
      {item?.kind === "file-change" ? (
        <div className="activity-detail activity-detail--file">
          <div className="activity-detail__file-head">
            <span>
              <Icon name="file" size={18} />
            </span>
            <div>
              <strong>{item.path.split(/[\\/]/).pop() || item.path}</strong>
              <small>{item.path}</small>
            </div>
            <span className="activity-row__stats">
              {item.additions !== undefined ? <b>+{item.additions}</b> : null}
              {item.deletions !== undefined ? <i>-{item.deletions}</i> : null}
            </span>
          </div>
          {item.diff ? (
            <div aria-label="文件详情视图" className="activity-detail__tabs" role="tablist">
              <button
                aria-selected={view === "diff"}
                onClick={() => setView("diff")}
                role="tab"
                type="button"
              >
                修改内容
              </button>
              <button
                aria-selected={view === "file"}
                onClick={() => setView("file")}
                role="tab"
                type="button"
              >
                最新文件
              </button>
            </div>
          ) : null}
          {view === "diff" && item.diff ? <DiffView diff={item.diff} /> : null}
          {view === "file" ? (
            resolving ? (
              <div className="activity-detail__loading">
                <Skeleton />
                <Skeleton width="76%" />
              </div>
            ) : resolveError ? (
              <EmptyState description={resolveError} icon="alert" title="无法读取最新文件" />
            ) : resolvedEntry ? (
              <FilePreview
                apiClient={apiClient}
                embedded
                entry={resolvedEntry}
                online={online}
                projectId={resolvedEntry.projectId}
              />
            ) : null
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}

function CopyableDetail({ label, text }: { label: string; text: string }) {
  const testId =
    label === "命令"
      ? "activity-detail-command"
      : label === "输出"
        ? "activity-detail-output"
        : undefined;
  return (
    <section className="activity-detail__code-block">
      <header>
        <strong>{label}</strong>
        <CopyMessageButton label={`复制${label}`} text={text} />
      </header>
      <pre aria-label={label} className="activity-detail__code" data-testid={testId} tabIndex={0}>
        {text}
      </pre>
    </section>
  );
}

function ActivityGroup({
  apiClient,
  items,
  online,
  projectId,
}: {
  apiClient: ApiClient;
  items: ReadonlyArray<ThreadDetail["items"][number]>;
  online: boolean;
  projectId?: string;
}) {
  const running = items.some(
    (item) =>
      (item.kind === "tool" && item.status === "running") ||
      (item.kind === "file-change" && item.status === "inProgress"),
  );
  const [open, setOpen] = useState(running);
  const [selectedId, setSelectedId] = useState<string>();
  const selected = selectedActivityItem(items, selectedId);

  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

  useEffect(() => {
    if (selectedId !== undefined && selected === undefined) {
      setSelectedId(undefined);
    }
  }, [selected, selectedId]);

  return (
    <>
      <details
        className="activity-record"
        onToggle={(event) => setOpen(event.currentTarget.open)}
        open={open}
      >
        <summary>
          <span>
            <Icon name={running ? "activity" : "check"} size={15} />
            {activitySummary(items)}
          </span>
          <Icon name="chevron-down" size={15} />
        </summary>
        {open ? (
          <div className="activity-record__items">
            {items.map((item) =>
              item.kind === "tool" || item.kind === "file-change" ? (
                <ActivityRow item={item} key={item.id} onOpen={() => setSelectedId(item.id)} />
              ) : null,
            )}
          </div>
        ) : null}
      </details>
      <ActivityDetailSheet
        apiClient={apiClient}
        item={selected}
        online={online}
        {...(projectId === undefined ? {} : { projectId })}
        onClose={() => setSelectedId(undefined)}
      />
    </>
  );
}

function SubagentActivityGroup({
  active,
  items,
  subagents,
}: {
  active: boolean;
  items: ReadonlyArray<ThreadDetail["items"][number]>;
  subagents: readonly SubagentSummary[];
}) {
  const navigate = useNavigate();
  const agentById = new Map(subagents.map((agent) => [agent.threadId, agent]));
  const latestById = new Map<
    string,
    { label: string; status: "running" | "complete" | "failed" | "unknown" }
  >();
  for (const item of items) {
    if (item.kind !== "subagent-activity") continue;
    for (const agent of item.agents) {
      latestById.set(agent.threadId, {
        label: agent.label ?? agentById.get(agent.threadId)?.title ?? "子智能体",
        status: subagentActivityStatusForDisplay(item.status, active, item.action),
      });
    }
  }
  const latestActivity = [...items].reverse().find((item) => item.kind === "subagent-activity");
  const latestStatus =
    latestActivity?.kind === "subagent-activity"
      ? subagentActivityStatusForDisplay(latestActivity.status, active, latestActivity.action)
      : undefined;
  const activityLabel =
    latestActivity?.kind === "subagent-activity"
      ? latestStatus === "unknown"
        ? "状态未确认"
        : {
            spawn: "已开始工作",
            update: "已更新",
            resume: "已继续工作",
            wait: active ? "正在等待" : "已等待",
            close: "已完成",
            activity: latestStatus === "running" ? "正在工作" : "已更新",
          }[latestActivity.action]
      : "";
  return (
    <div className="subagent-activity" aria-label="子智能体活动">
      <div className="subagent-activity__chips">
        {[...latestById].map(([threadId, agent]) => (
          <button
            className={`subagent-chip subagent-chip--${agent.status}`}
            key={threadId}
            onClick={() => navigate(`/threads/${threadId}`)}
            type="button"
          >
            <span aria-hidden="true">
              <Icon name="layers" size={13} />
            </span>
            <strong>{agent.label}</strong>
            {agent.status === "unknown" ? <small>状态未确认</small> : null}
          </button>
        ))}
      </div>
      {activityLabel ? <span>{activityLabel}</span> : null}
    </div>
  );
}

function ContextCompactionRecord({
  item,
}: {
  item: Extract<ThreadDetail["items"][number], { kind: "tool" }>;
}) {
  const running = item.status === "running";
  return (
    <div
      aria-label={running ? "正在压缩上下文" : "上下文压缩记录"}
      className={`context-compaction-record context-compaction-record--${item.status}`}
      data-testid="context-compaction-record"
    >
      <Icon name={running ? "activity" : item.status === "failed" ? "alert" : "check"} size={15} />
      <span>
        <strong>
          {running
            ? "正在压缩上下文"
            : item.status === "failed"
              ? "上下文压缩失败"
              : "上下文已压缩"}
        </strong>
        {!running && item.status !== "failed" ? <small>后续内容已使用新的上下文继续</small> : null}
      </span>
    </div>
  );
}

type WorkLogSection =
  | { kind: "content"; item: ThreadDetail["items"][number] }
  | { kind: "activity"; items: Array<ThreadDetail["items"][number]> }
  | { kind: "subagents"; items: Array<ThreadDetail["items"][number]> };

function groupWorkLogSections(
  items: ReadonlyArray<ThreadDetail["items"][number]>,
): WorkLogSection[] {
  const sections: WorkLogSection[] = [];
  for (const item of items) {
    const kind =
      item.kind === "tool" || item.kind === "file-change"
        ? "activity"
        : item.kind === "subagent-activity"
          ? "subagents"
          : "content";
    if (kind === "content") {
      sections.push({ kind, item });
      continue;
    }
    const previous = sections.at(-1);
    if (previous?.kind === kind) {
      previous.items.push(item);
    } else {
      sections.push({ kind, items: [item] });
    }
  }
  return sections;
}

export function workLogOpenAfterItemsChange({
  activeHeader,
  currentOpen,
  itemCount,
  manuallyToggled,
}: {
  activeHeader: boolean;
  currentOpen: boolean;
  itemCount: number;
  manuallyToggled: boolean;
}): boolean {
  return manuallyToggled ? currentOpen : activeHeader || itemCount <= 6;
}

export function conversationPresentationIdentity(
  threadId: string,
  resetGeneration: number,
): string {
  return `${threadId}:${resetGeneration}`;
}

function WorkLogGroup({
  activeHeader,
  apiClient,
  belongsToActiveTurn,
  items,
  online,
  projectId,
  subagents,
}: {
  activeHeader: boolean;
  apiClient: ApiClient;
  belongsToActiveTurn: boolean;
  items: ReadonlyArray<ThreadDetail["items"][number]>;
  online: boolean;
  projectId?: string;
  subagents: readonly SubagentSummary[];
}) {
  const automaticallyCompact = items.length > 6;
  const [open, setOpen] = useState(() =>
    workLogOpenAfterItemsChange({
      activeHeader,
      currentOpen: false,
      itemCount: items.length,
      manuallyToggled: false,
    }),
  );
  const manuallyToggled = useRef(false);
  const headline = workLogHeadline(items);

  useEffect(() => {
    setOpen((currentOpen) =>
      workLogOpenAfterItemsChange({
        activeHeader,
        currentOpen,
        itemCount: items.length,
        manuallyToggled: manuallyToggled.current,
      }),
    );
  }, [activeHeader, automaticallyCompact, items.length]);

  return (
    <section className={`work-log${open ? " work-log--open" : ""}`}>
      <button
        aria-expanded={open}
        className="work-log__toggle"
        onClick={() => {
          manuallyToggled.current = true;
          setOpen((current) => !current);
        }}
        type="button"
      >
        <Icon name={activeHeader ? "activity" : "check"} size={15} />
        <span className="work-log__label">
          <strong>{activeHeader ? "正在工作" : "工作记录"}</strong>
          {!open && headline ? <span>{headline}</span> : null}
        </span>
        <small>{workLogSummary(items)}</small>
        <Icon name="chevron-down" size={15} />
      </button>
      {open ? (
        <div className="work-log__items">
          {groupWorkLogSections(items).map((section, index) =>
            section.kind === "content" ? (
              <MessageItem
                apiClient={apiClient}
                item={section.item}
                items={items}
                key={section.item.id}
                online={online}
                {...(projectId === undefined ? {} : { projectId })}
              />
            ) : section.kind === "activity" ? (
              <ActivityGroup
                apiClient={apiClient}
                items={section.items}
                key={`work-activity-${section.items[0]?.id ?? index}`}
                online={online}
                {...(projectId === undefined ? {} : { projectId })}
              />
            ) : (
              <SubagentActivityGroup
                active={belongsToActiveTurn}
                items={section.items}
                key={`work-subagents-${section.items[0]?.id ?? index}`}
                subagents={subagents}
              />
            ),
          )}
        </div>
      ) : null}
    </section>
  );
}

const ConversationItems = memo(function ConversationItems({
  apiClient,
  items,
  activeTurnId,
  presentationIdentity,
  online,
  projectId,
  showLivePhase,
  subagents,
}: {
  apiClient: ApiClient;
  items: ReadonlyArray<ThreadDetail["items"][number]>;
  activeTurnId?: string;
  presentationIdentity: string;
  online: boolean;
  projectId?: string;
  showLivePhase: boolean;
  subagents: readonly SubagentSummary[];
}) {
  const segments = groupConversationItems(conversationContentItems(items, activeTurnId));
  const activeWorkSegmentIndex = activeWorkLogSegmentIndex(segments, activeTurnId);
  const livePhase = showLivePhase ? currentLivePhase(items, activeTurnId) : undefined;
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "content" ? (
          <MessageItem
            apiClient={apiClient}
            item={segment.item}
            items={items}
            key={`${presentationIdentity}:content:${segment.item.id}`}
            online={online}
            {...(projectId === undefined ? {} : { projectId })}
          />
        ) : segment.kind === "work" ? (
          <WorkLogGroup
            activeHeader={index === activeWorkSegmentIndex}
            apiClient={apiClient}
            belongsToActiveTurn={workLogSegmentBelongsToActiveTurn(segments, index, activeTurnId)}
            items={segment.items}
            key={`${presentationIdentity}:work-${segment.items[0]?.id ?? index}`}
            online={online}
            {...(projectId === undefined ? {} : { projectId })}
            subagents={subagents}
          />
        ) : segment.kind === "compaction" ? (
          <ContextCompactionRecord
            item={segment.item}
            key={`${presentationIdentity}:compaction-${segment.item.id}`}
          />
        ) : null,
      )}
      {livePhase ? (
        <p
          aria-label={livePhase.kind === "reasoning" ? "当前思考" : "当前操作"}
          aria-live="polite"
          className={`live-phase live-phase--${livePhase.kind}`}
          data-testid="turn-running"
        >
          {livePhase.text}
        </p>
      ) : null}
    </>
  );
});

function SubagentRow({ agent, onNavigate }: { agent: SubagentSummary; onNavigate?: () => void }) {
  return (
    <NavLink
      className="subagent-row"
      data-testid="subagent-node"
      onClick={onNavigate}
      style={{ paddingLeft: `${12 + Math.min(agent.depth, 3) * 14}px` }}
      to={`/threads/${agent.threadId}`}
    >
      <span className={`subagent-row__line subagent-row__line--${agent.state}`} />
      <span>
        <strong>{agent.title}</strong>
        <small>
          {runLabels[agent.state]} · {timeAgo(agent.updatedAt)}
        </small>
      </span>
      <Icon name="chevron-right" size={17} />
    </NavLink>
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
  effort: ReasoningEffort | undefined;
  disabled?: boolean;
  modelTestId?: string;
  effortTestId?: string;
  ariaContext: "新建对话" | "下一轮";
  onModel: (value: string) => void;
  onEffort: (value: ReasoningEffort | undefined) => void;
}) {
  const selected = models.find((option) => option.id === model) ?? models[0];
  const selectedEffort = normalizeReasoningEffortForModel(selected, effort);
  const efforts = selected?.supportedReasoningEfforts ?? [];
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
      {efforts.length > 0 && selectedEffort ? (
        <label>
          <span>思考</span>
          <select
            aria-label={`${ariaContext}思考等级`}
            data-testid={effortTestId}
            disabled={disabled}
            onChange={(event) => onEffort(event.target.value)}
            value={selectedEffort}
          >
            {efforts.map((option) => (
              <option key={option} value={option}>
                {effortLabel(option)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <div className="model-controls__unavailable" data-testid="reasoning-effort-unavailable">
          <span>思考</span>
          <small>此模型未公开可选等级</small>
        </div>
      )}
    </div>
  );
}

function AccessAndReviewerSheet({
  approvalPolicy,
  approvalPolicies,
  approvalReviewer,
  approvalReviewers,
  busy,
  onApply,
  onApprovalPolicy,
  onApprovalReviewer,
  onClose,
  onPermission,
  open,
  permissionProfileId,
  permissionProfiles,
}: {
  approvalPolicy: string;
  approvalPolicies: ApprovalPolicyOption[];
  approvalReviewer: string;
  approvalReviewers: ApprovalReviewerOption[];
  busy: boolean;
  onApply: () => void;
  onApprovalPolicy: (id: string) => void;
  onApprovalReviewer: (id: string) => void;
  onClose: () => void;
  onPermission: (id: string) => void;
  open: boolean;
  permissionProfileId: string;
  permissionProfiles: PermissionProfileOption[];
}) {
  return (
    <Sheet
      description="这里只显示当前 Codex 运行时声明的选项，并在下一轮生效。"
      footer={
        <Button disabled={busy} onClick={onApply} variant="primary">
          {busy ? "正在应用…" : "应用到下一轮"}
        </Button>
      }
      onClose={onClose}
      open={open}
      title="权限与审批"
    >
      {permissionProfiles.length > 0 ? (
        <section className="composer-sheet-section">
          <h3>文件与命令权限</h3>
          <div className="composer-option-list">
            {permissionProfiles.map((profile) => (
              <button
                className={`composer-option ${
                  profile.id === permissionProfileId ? "is-selected" : ""
                }`}
                data-testid={`permission-profile-${profile.id}`}
                disabled={!profile.allowed || busy}
                key={profile.id}
                onClick={() => onPermission(profile.id)}
                type="button"
              >
                <span>
                  <strong>{permissionProfileLabel(profile.id)}</strong>
                  <small>
                    {profile.description ??
                      `${profile.id} · ` +
                        (profile.allowed ? "Codex 当前允许使用" : "Codex 当前不允许使用")}
                  </small>
                </span>
                {profile.id === permissionProfileId ? <Icon name="check" size={17} /> : null}
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {approvalPolicies.length > 0 ? (
        <section className="composer-sheet-section">
          <h3>何时请求你确认</h3>
          <div className="composer-option-list">
            {approvalPolicies.map((policy) => (
              <button
                className={`composer-option ${policy.id === approvalPolicy ? "is-selected" : ""}`}
                data-testid={`approval-policy-${policy.id}`}
                disabled={busy}
                key={policy.id}
                onClick={() => onApprovalPolicy(policy.id)}
                type="button"
              >
                <span>
                  <strong>{approvalPolicyLabel(policy.id)}</strong>
                  <small>{approvalPolicyDescription(policy.id)}</small>
                </span>
                {policy.id === approvalPolicy ? <Icon name="check" size={17} /> : null}
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {approvalReviewers.length > 0 ? (
        <section className="composer-sheet-section">
          <h3>审批方式</h3>
          <div className="composer-option-list">
            {approvalReviewers.map((reviewer) => (
              <button
                className={`composer-option ${
                  reviewer.id === approvalReviewer ? "is-selected" : ""
                }`}
                data-testid={`approval-reviewer-${reviewer.id}`}
                disabled={busy}
                key={reviewer.id}
                onClick={() => onApprovalReviewer(reviewer.id)}
                type="button"
              >
                <span>
                  <strong>{approvalReviewerLabel(reviewer.id)}</strong>
                  <small>{approvalReviewerDescription(reviewer.id)}</small>
                </span>
                {reviewer.id === approvalReviewer ? <Icon name="check" size={17} /> : null}
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </Sheet>
  );
}

type ConversationPageProps = {
  apiClient: ApiClient;
  approvals: ApprovalRequest[];
  capabilities: ProductCapabilities | undefined;
  collaborationModes: CollaborationModeOption[];
  liveEvents: LiveEventEnvelope[];
  models: ModelOption[];
  online: boolean;
  onOpenApproval: (approval: ApprovalRequest) => void;
  onSnapshotEventCursor: (threadId: string, cursor: string) => void;
  onThreadLoaded: (thread?: ThreadDetail) => void;
  onSubagentsLoaded: (agents: SubagentSummary[]) => void;
  onUsageLoaded: (usage?: UsageSnapshot) => void;
  threadSummaries: ThreadSummary[];
};

function ConversationPage(props: ConversationPageProps) {
  const { id = "" } = useParams();
  return <ConversationPageInstance key={id} {...props} id={id} />;
}

const subagentIntegrityRisk: Record<SubagentHistoryIntegrity["status"], number> = {
  complete: 0,
  unknown: 1,
  partial: 2,
  failed: 3,
};

const subagentStreamRisk: Record<SubagentHistoryIntegrity["streams"]["current"]["status"], number> =
  {
    exhausted: 0,
    "not-requested": 0,
    "more-available": 1,
    failed: 2,
  };

function mergeSubagentHistoryStreams(
  previous: SubagentHistoryIntegrity["streams"] | undefined,
  incoming: SubagentHistoryIntegrity["streams"],
  continuing: boolean,
): SubagentHistoryIntegrity["streams"] {
  if (!previous) return incoming;
  const mergeStream = (
    prior: SubagentHistoryIntegrity["streams"]["current"],
    next: SubagentHistoryIntegrity["streams"]["current"],
  ): SubagentHistoryIntegrity["streams"]["current"] => {
    const status =
      prior.status === "failed" || next.status === "failed"
        ? "failed"
        : continuing
          ? next.status === "not-requested"
            ? prior.status
            : next.status
          : subagentStreamRisk[next.status] > subagentStreamRisk[prior.status]
            ? next.status
            : prior.status;
    return {
      observedCount: continuing
        ? prior.observedCount + next.observedCount
        : Math.max(prior.observedCount, next.observedCount),
      status,
    };
  };
  return {
    current: mergeStream(previous.current, incoming.current),
    archived: mergeStream(previous.archived, incoming.archived),
  };
}

export function accumulateSubagentHistoryIntegrity({
  accumulatedCount,
  continuing,
  incoming,
  nextCursor,
  preserveExpandedHistory = false,
  previous,
}: {
  accumulatedCount: number;
  continuing: boolean;
  incoming?: SubagentHistoryIntegrity | undefined;
  nextCursor?: string | undefined;
  preserveExpandedHistory?: boolean;
  previous?: SubagentHistoryIntegrity | undefined;
}): SubagentHistoryIntegrity | undefined {
  const observedCount = Math.max(
    accumulatedCount,
    incoming?.observedCount ?? 0,
    previous?.observedCount ?? 0,
  );
  const cumulativePrevious = continuing || preserveExpandedHistory ? previous : undefined;
  if (!incoming) {
    if (!cumulativePrevious) return undefined;
    if (!continuing) {
      return { ...cumulativePrevious, observedCount };
    }
    return {
      ...cumulativePrevious,
      status: "unknown",
      reason: "continuation-unverified",
      observedCount,
    };
  }

  const streams = mergeSubagentHistoryStreams(
    cumulativePrevious?.streams,
    incoming.streams,
    continuing,
  );
  const normalizedIncoming: SubagentHistoryIntegrity =
    incoming.status === "complete" && nextCursor !== undefined
      ? {
          ...incoming,
          status: "partial",
          reason: "pagination-pending",
          observedCount,
          streams,
        }
      : { ...incoming, observedCount, streams };

  if (!cumulativePrevious) {
    if (continuing && normalizedIncoming.status === "complete") {
      return {
        ...normalizedIncoming,
        status: "unknown",
        reason: "continuation-unverified",
      };
    }
    return normalizedIncoming;
  }

  // pagination-pending is a transient gap only the contiguous next page can
  // close; durable failed/partial/unknown evidence must survive later pages.
  if (continuing && cumulativePrevious.reason === "pagination-pending") {
    return normalizedIncoming;
  }

  const selected =
    subagentIntegrityRisk[normalizedIncoming.status] >
    subagentIntegrityRisk[cumulativePrevious.status]
      ? normalizedIncoming
      : cumulativePrevious;
  return { ...selected, observedCount, streams };
}

export function subagentHistoryIntegrityNotice(
  integrity: SubagentHistoryIntegrity | undefined,
): string {
  if (!integrity || integrity.status === "complete") return "";
  const observed = `当前已获取 ${integrity.observedCount} 条记录`;
  if (integrity.status === "partial") {
    return `${observed}；较早的子智能体记录可能尚未完整载入。`;
  }
  if (integrity.status === "failed") {
    return `${observed}；子智能体历史读取失败，列表可能不完整。`;
  }
  return `${observed}；目前无法确认子智能体历史是否完整。`;
}

export function subagentHistoryPaginationCompleteLabel(
  integrity: SubagentHistoryIntegrity | undefined,
): string {
  return integrity?.status === "complete" ? "已显示全部子智能体" : "子智能体历史尚未确认完整";
}

const persistedHistoryStatuses = new Set(["complete", "partial", "failed"]);
const persistedHistoryScopes = new Set(["complete", "recent"]);
const persistedHistoryReasons = new Set([
  "verified-complete",
  "recent-window",
  "invalid-json",
  "unterminated-line",
  "overlong-line",
  "projection-limit",
  "read-failed",
  "unstable-file",
  "diagnostic-unavailable",
]);

function isPersistedHistoryIntegrity(
  value: unknown,
): value is NonNullable<ThreadDetail["persistedHistoryIntegrity"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.status === "string" &&
    persistedHistoryStatuses.has(candidate.status) &&
    typeof candidate.scope === "string" &&
    persistedHistoryScopes.has(candidate.scope) &&
    typeof candidate.reason === "string" &&
    persistedHistoryReasons.has(candidate.reason) &&
    typeof candidate.observedCount === "number" &&
    Number.isInteger(candidate.observedCount) &&
    candidate.observedCount >= 0
  );
}

export function persistedConversationHistoryNotice({
  historyNextCursor,
  persistedHistoryIntegrity,
}: {
  historyNextCursor?: string | undefined;
  persistedHistoryIntegrity?: unknown;
}): string {
  const hasEarlierPage = Boolean(historyNextCursor);
  if (persistedHistoryIntegrity === undefined) {
    return hasEarlierPage ? "可向上加载更早记录；当前历史尚未确认完整。" : "";
  }
  if (!isPersistedHistoryIntegrity(persistedHistoryIntegrity)) {
    return `历史完整性元数据无法确认；当前仅显示已验证记录，历史尚未确认完整。${
      hasEarlierPage ? " 可向上加载更早记录。" : ""
    }`;
  }
  if (
    persistedHistoryIntegrity.status === "complete" &&
    persistedHistoryIntegrity.scope === "complete" &&
    persistedHistoryIntegrity.reason === "verified-complete"
  ) {
    return "";
  }
  if (persistedHistoryIntegrity.status === "failed") {
    return `持久历史读取失败；当前仅显示已验证记录，历史不完整。${
      hasEarlierPage ? " 可向上加载更早记录。" : ""
    }`;
  }
  if (
    persistedHistoryIntegrity.scope === "recent" ||
    persistedHistoryIntegrity.reason === "recent-window"
  ) {
    return `当前仅显示最近窗口内的已验证记录；${
      hasEarlierPage ? "可向上加载更早记录，历史尚未确认完整。" : "持久历史尚未确认完整。"
    }`;
  }
  return `持久历史不完整；当前仅显示已验证记录。${hasEarlierPage ? " 可向上加载更早记录。" : ""}`;
}

function ConversationPageInstance({
  apiClient,
  approvals,
  capabilities,
  collaborationModes,
  liveEvents,
  models,
  online,
  onOpenApproval,
  onSnapshotEventCursor,
  onThreadLoaded,
  onSubagentsLoaded,
  onUsageLoaded,
  threadSummaries,
  id,
}: ConversationPageProps & { id: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const summary = threadSummaries.find((candidate) => candidate.id === id);
  const cachedNavigationState = useMemo(
    () => readThreadNavigationCache(window.sessionStorage, id),
    [id],
  );
  const routeSeed =
    threadSeedFromNavigationState(location.state, id) ?? cachedNavigationState?.threadSeed;
  const routeInitialPrompt =
    threadInitialPromptFromNavigationState(location.state, id) ??
    cachedNavigationState?.initialPrompt;
  const initialThread = routeSeed ?? (summary ? detailFromThreadSummary(summary) : undefined);
  const [thread, setThread] = useState<ThreadDetail | undefined>(initialThread);
  const [subagents, setSubagents] = useState<SubagentSummary[]>([]);
  const [subagentHistoryIntegrity, setSubagentHistoryIntegrity] =
    useState<SubagentHistoryIntegrity>();
  const [subagentsNextCursor, setSubagentsNextCursor] = useState<string>();
  const [subagentsMoreState, setSubagentsMoreState] = useState<MoreState>("idle");
  const [subagentsError, setSubagentsError] = useState("");
  const [threadUsage, setThreadUsage] = useState<UsageSnapshot>();
  const [state, setState] = useState<LoadState>(summary ? "ready" : "loading");
  const [detailProjectionReady, setDetailProjectionReady] = useState(Boolean(routeSeed));
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(() => window.localStorage.getItem(`draft:${id}`) ?? "");
  const [attachments, setAttachments] = useState<LocalInputReference[]>(() =>
    readConversationAttachments(window.localStorage, id),
  );
  const [nextTurnSettings, setNextTurnSettings] = useState(() =>
    nextTurnSettingsDraft(models, initialThread),
  );
  const [serviceTier, setServiceTier] = useState<string | null>(
    initialThread?.serviceTier ??
      models.find((model) => model.id === initialThread?.model)?.defaultServiceTier ??
      models.find((model) => model.isDefault)?.defaultServiceTier ??
      null,
  );
  const [permissionProfileId, setPermissionProfileId] = useState(
    initialThread?.permissionProfileId ?? "",
  );
  const [approvalPolicy, setApprovalPolicy] = useState(initialThread?.approvalPolicy ?? "");
  const [approvalReviewer, setApprovalReviewer] = useState(initialThread?.approvalsReviewer ?? "");
  const [collaborationMode, setCollaborationMode] = useState(
    chooseCollaborationMode(collaborationModes, initialThread?.collaborationMode) ?? "",
  );
  const [permissionProfiles, setPermissionProfiles] = useState<PermissionProfileOption[]>([]);
  const [approvalPolicies, setApprovalPolicies] = useState<ApprovalPolicyOption[]>([]);
  const [approvalReviewers, setApprovalReviewers] = useState<ApprovalReviewerOption[]>([]);
  const [deliveryMode, setDeliveryMode] = useState<ComposerDestination>("steer");
  const [queue, setQueue] = useState<QueuedTurnItem[]>([]);
  const [queueRevision, setQueueRevision] = useState(0);
  const [queueBusyId, setQueueBusyId] = useState("");
  const [queueError, setQueueError] = useState("");
  const [composerSheet, setComposerSheet] = useState<
    "" | "settings" | "permission" | "tools" | "goal" | "plan" | "attachments"
  >("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [goalDraft, setGoalDraft] = useState("");
  const [threadGoal, setThreadGoal] = useState<ThreadGoal>();
  const [goalBusy, setGoalBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [interruptRequestedTurnId, setInterruptRequestedTurnId] = useState("");
  const [showAgents, setShowAgents] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [usageRefreshState, setUsageRefreshState] = useState<"idle" | "refreshing" | "error">(
    "idle",
  );
  const [usageRefreshError, setUsageRefreshError] = useState("");
  const [threadIdCopyState, setThreadIdCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [draftCopyState, setDraftCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [runtimeNotice, setRuntimeNotice] = useState<RuntimeNotice>();
  const [visibleItemLimit, setVisibleItemLimit] = useState(INITIAL_CONVERSATION_ITEM_LIMIT);
  const [conversationAway, setConversationAway] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const composerExpandedRef = useRef(false);
  const [historyNextCursor, setHistoryNextCursor] = useState<string>();
  const [historyMoreState, setHistoryMoreState] = useState<MoreState>("idle");
  const [actionError, setActionError] = useState("");
  const [actionStatus, setActionStatus] = useState<
    | "steer-accepted"
    | "turn-interrupted"
    | "turn-queued"
    | "settings-applied"
    | "goal-saved"
    | "goal-paused"
    | "goal-resumed"
    | ""
  >("");
  const [compactionRequestState, setCompactionRequestState] =
    useState<ContextCompactionRequestState>("idle");
  const [compactionNotice, setCompactionNotice] = useState("");
  const [compactionError, setCompactionError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const composerShellRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const composerCollapseTimerRef = useRef<number | undefined>(undefined);
  const composerPointerActiveRef = useRef(false);
  const conversationScrollRef = useRef<HTMLDivElement>(null);
  const conversationStreamRef = useRef<HTMLDivElement>(null);
  const conversationAwayRef = useRef(false);
  const lastConversationScrollTopRef = useRef(0);
  const conversationUserScrollIntentAtRef = useRef(0);
  const historyExtendedRef = useRef(false);
  const historyLoadInFlightRef = useRef<Promise<void> | undefined>(undefined);
  const historyRevealScheduledRef = useRef(false);
  const initialScrollThreadRef = useRef("");
  const handledLiveDelivery = useRef(0);
  const latestLiveDeliveryRef = useRef(liveEvents.at(-1)?.deliveryId ?? 0);
  const retainedReplayThroughRef = useRef(0);
  const currentIdRef = useRef(id);
  const threadRef = useRef(initialThread);
  const routeSeedRef = useRef(routeSeed);
  const routeInitialPromptRef = useRef(routeInitialPrompt);
  const modelsRef = useRef(models);
  const creationPromptLiveAliasItemIdRef = useRef<string | undefined>(undefined);
  const creationPromptPersistedItemIdRef = useRef<string | undefined>(undefined);
  const summaryRef = useRef(summary);
  const loadInFlight = useRef<
    { id: string; featureKey: string; promise: Promise<void> } | undefined
  >(undefined);
  const subagentsRef = useRef<SubagentSummary[]>([]);
  const subagentHistoryIntegrityRef = useRef<SubagentHistoryIntegrity | undefined>(undefined);
  const subagentsNextCursorRef = useRef<string | undefined>(undefined);
  const subagentsExtendedRef = useRef(false);
  const subagentsMoreInFlightRef = useRef<{ id: string } | undefined>(undefined);
  const compactionAttemptRef = useRef<ContextCompactionAttempt | undefined>(undefined);
  const compactionRequestFlightRef = useRef<ContextCompactionRequestFlight | undefined>(undefined);
  const navigationSeedSignatureRef = useRef("");
  const usageRefreshInFlightRef = useRef<Promise<void> | undefined>(undefined);
  const usageButtonRef = useRef<HTMLButtonElement>(null);
  const usagePanelRef = useRef<HTMLElement>(null);
  const goalLoadedRef = useRef(false);
  const productSettingsDirtyRef = useRef(false);
  const productSettingsGenerationRef = useRef(0);
  const collaborationModeDirtyRef = useRef(false);
  const remoteProjectionRef = useRef(createThreadRemoteEventProjectionState());
  const queueSupported = composerFeatureSupported(capabilities, "queue");
  const goalReadable = shouldReadThreadGoal(capabilities);
  const settingsUpdateSupported = composerFeatureSupported(capabilities, "settings");
  const serviceTiersSupported = composerFeatureSupported(capabilities, "serviceTiers");
  const compactSupported = composerFeatureSupported(capabilities, "compact");
  const permissionProfilesCapability = composerFeatureSupported(capabilities, "permissionProfiles");
  const permissionProfilesSupported = permissionProfiles.length > 0 && permissionProfilesCapability;
  const approvalPoliciesCapability = capabilities?.approvalPolicies === "available";
  const approvalPoliciesSupported = approvalPoliciesCapability && approvalPolicies.length > 0;
  const approvalReviewersCapability = capabilities?.approvalReviewers === "available";
  const approvalReviewersSupported = approvalReviewersCapability && approvalReviewers.length > 0;
  const runtimeControlAvailable = online && appServerReady(capabilities);
  const loadFeatureKey = [
    queueSupported,
    goalReadable,
    permissionProfilesCapability,
    approvalPoliciesCapability,
    approvalReviewersCapability,
  ]
    .map((available) => (available ? "1" : "0"))
    .join("");
  currentIdRef.current = id;
  conversationAwayRef.current = conversationAway;
  latestLiveDeliveryRef.current = liveEvents.at(-1)?.deliveryId ?? 0;
  routeSeedRef.current = routeSeed;
  routeInitialPromptRef.current = routeInitialPrompt;
  modelsRef.current = models;
  summaryRef.current = summary;
  const presentationItems = useMemo(
    () => (thread ? contextCompactionItemsForDisplay(thread) : []),
    [thread],
  );
  const visibleItems = useMemo(
    () =>
      visibleConversationItems(presentationItems, visibleItemLimit, (item) => {
        if (
          item.kind === "user-message" ||
          item.kind === "assistant-message" ||
          item.kind === "image-activity" ||
          item.kind === "plan-progress" ||
          item.kind === "subagent-activity"
        ) {
          return true;
        }
        return item.kind === "tool" && item.operation === "context-compaction";
      }),
    [presentationItems, visibleItemLimit],
  );
  const presentationIdentity = conversationPresentationIdentity(
    id,
    remoteProjectionRef.current.generation,
  );
  const composerPlan = useMemo(() => latestPlanProgress(thread?.items ?? []), [thread?.items]);
  const hiddenItemCount = hiddenConversationItemCount(
    thread?.items.length ?? 0,
    visibleItems.length,
  );

  const finishContextCompaction = useCallback(
    (attemptKey: string, resolution: Exclude<ContextCompactionResolution, "pending">) => {
      if (compactionAttemptRef.current?.idempotencyKey !== attemptKey) return;
      compactionAttemptRef.current = undefined;
      setCompactionRequestState("idle");
      if (resolution === "succeeded") {
        setCompactionNotice("上下文已压缩，使用量正在刷新");
        setCompactionError("");
      } else {
        setCompactionNotice("");
        setCompactionError("上下文压缩没有完成，请查看上方状态后重试");
      }
    },
    [],
  );

  const load = useCallback(
    (silent = false) => {
      if (loadInFlight.current?.id === id && loadInFlight.current.featureKey === loadFeatureKey) {
        return loadInFlight.current.promise;
      }
      if (!silent) setState("loading");
      const projectionGeneration = remoteProjectionRef.current.generation;
      const productSettingsGeneration = productSettingsGenerationRef.current;
      if (!silent && !threadRef.current) {
        void apiClient
          .threadShell(id)
          .then((shell) => {
            if (currentIdRef.current !== id || threadRef.current) return;
            threadRef.current = shell;
            setThread(shell);
            setState("ready");
            onThreadLoaded(shell);
            setNextTurnSettings((current) =>
              reconcileNextTurnSettingsDraft(current, models, shell),
            );
            if (
              !productSettingsDirtyRef.current &&
              productSettingsGenerationRef.current === productSettingsGeneration
            ) {
              setServiceTier(shell.serviceTier ?? null);
              if (shell.permissionProfileId) {
                setPermissionProfileId(shell.permissionProfileId);
              }
              if (shell.collaborationMode) {
                setCollaborationMode(shell.collaborationMode);
              }
            }
          })
          .catch(() => {
            // The full detail request remains authoritative and owns the visible
            // error state. A shell failure must not turn one recoverable load
            // into two competing error messages.
          });
      }
      const promise = (async () => {
        try {
          const agentsResultPromise = apiClient
            .subagents(id)
            .then((page) => ({ page, error: "" }))
            .catch((agentsError: unknown) => ({
              page: { items: [] } as SubagentCursorPage,
              error: errorMessage(agentsError),
            }));
          const usageSnapshotPromise = apiClient.usage(id).catch(() => undefined);
          const queuedResultPromise = queueSupported
            ? apiClient
                .queue(id)
                .then((snapshot) => ({ snapshot, error: "" }))
                .catch((queueLoadError: unknown) => ({
                  snapshot: undefined,
                  error: errorMessage(queueLoadError),
                }))
            : Promise.resolve({
                snapshot: { threadId: id, revision: 0, items: [] as QueuedTurnItem[] },
                error: "",
              });
          const goalResultPromise = goalReadable
            ? apiClient.threadGoal(id).catch(() => undefined)
            : Promise.resolve(undefined);
          const permissionProfileResultPromise = permissionProfilesCapability
            ? apiClient.permissionProfiles({ threadId: id }).catch(() => [])
            : Promise.resolve([] as PermissionProfileOption[]);
          const approvalPolicyResultPromise = approvalPoliciesCapability
            ? apiClient.approvalPolicies().catch(() => [])
            : Promise.resolve([] as ApprovalPolicyOption[]);
          const approvalReviewerResultPromise = approvalReviewersCapability
            ? apiClient.approvalReviewers().catch(() => [])
            : Promise.resolve([] as ApprovalReviewerOption[]);
          const refreshSnapshots = await readThreadRefreshSnapshots(
            apiClient,
            id,
            threadRef.current,
          );
          const { control, detail } = refreshSnapshots;
          if (currentIdRef.current !== id) return;
          if (detail.snapshotEventCursor) {
            onSnapshotEventCursor(detail.id, detail.snapshotEventCursor);
          }
          const persistedPromptItemId = persistedCreationPromptItemId(
            detail,
            routeInitialPromptRef.current,
          );
          synchronizeThreadRemoteEventProjection(
            remoteProjectionRef.current,
            detail,
            projectionGeneration,
          );
          const projectionGenerationIsCurrent =
            remoteProjectionRef.current.generation === projectionGeneration;
          if (persistedPromptItemId) {
            creationPromptPersistedItemIdRef.current = persistedPromptItemId;
          }
          const creationContext = routeSeedRef.current
            ? {
                creationSeed: routeSeedRef.current,
                ...(routeInitialPromptRef.current === undefined
                  ? {}
                  : { initialPrompt: routeInitialPromptRef.current }),
                ...(creationPromptLiveAliasItemIdRef.current === undefined
                  ? {}
                  : { liveAliasItemId: creationPromptLiveAliasItemIdRef.current }),
              }
            : undefined;
          let mergedDetail = mergeThreadRefresh(threadRef.current, detail, creationContext);
          if (
            control &&
            threadControlSnapshotIsCurrent(
              remoteProjectionRef.current,
              control,
              projectionGeneration,
            )
          ) {
            mergedDetail = mergeAuthoritativeThreadControl(mergedDetail, control, creationContext);
          }
          if (!historyExtendedRef.current) {
            setHistoryNextCursor(detail.historyNextCursor);
          }
          threadRef.current = mergedDetail;
          setThread(mergedDetail);
          onThreadLoaded(mergedDetail);
          const compactionAttempt = compactionAttemptRef.current;
          if (compactionAttempt?.threadId === detail.id) {
            const progress = reconcileContextCompactionSnapshot(compactionAttempt, detail);
            compactionAttemptRef.current = progress.attempt;
            if (progress.resolution !== "pending") {
              finishContextCompaction(progress.attempt.idempotencyKey, progress.resolution);
            }
          }
          setNextTurnSettings((current) =>
            reconcileNextTurnSettingsDraft(current, models, mergedDetail),
          );
          if (
            !productSettingsDirtyRef.current &&
            productSettingsGenerationRef.current === productSettingsGeneration
          ) {
            setServiceTier(mergedDetail.serviceTier ?? null);
            if (mergedDetail.permissionProfileId) {
              setPermissionProfileId(mergedDetail.permissionProfileId);
            }
            if (mergedDetail.collaborationMode) {
              setCollaborationMode(mergedDetail.collaborationMode);
            }
          }
          if (projectionGenerationIsCurrent) {
            retainedReplayThroughRef.current = latestLiveDeliveryRef.current;
            setDetailProjectionReady(true);
          }
          setState("ready");
          setError("");

          const [
            agentsResult,
            usageSnapshot,
            queuedResult,
            goalResult,
            permissionProfileResult,
            approvalPolicyResult,
            approvalReviewerResult,
          ] = await Promise.all([
            agentsResultPromise,
            usageSnapshotPromise,
            queuedResultPromise,
            goalResultPromise,
            permissionProfileResultPromise,
            approvalPolicyResultPromise,
            approvalReviewerResultPromise,
          ]);
          if (currentIdRef.current !== id) return;
          const agents = silent
            ? mergeCursorItems(
                subagentsRef.current,
                agentsResult.page.items,
                (agent) => agent.threadId,
              )
            : agentsResult.page.items;
          const preserveExpandedHistory =
            silent && (subagentsExtendedRef.current || subagentsMoreInFlightRef.current?.id === id);
          const nextCursor = agentsResult.error
            ? subagentsNextCursorRef.current
            : nextCursorAfterRefresh(
                subagentsNextCursorRef.current,
                agentsResult.page.nextCursor,
                preserveExpandedHistory,
              );
          subagentsRef.current = agents;
          setSubagents(agents);
          if (!agentsResult.error) {
            const integrity = accumulateSubagentHistoryIntegrity({
              accumulatedCount: agents.length,
              continuing: false,
              incoming: agentsResult.page.historyIntegrity,
              nextCursor: agentsResult.page.nextCursor,
              preserveExpandedHistory,
              previous: subagentHistoryIntegrityRef.current,
            });
            subagentHistoryIntegrityRef.current = integrity;
            setSubagentHistoryIntegrity(integrity);
          } else if (!silent) {
            subagentHistoryIntegrityRef.current = undefined;
            setSubagentHistoryIntegrity(undefined);
          }
          subagentsNextCursorRef.current = nextCursor;
          setSubagentsNextCursor(nextCursor);
          setSubagentsError(agentsResult.error);
          setThreadUsage(usageSnapshot);
          if (queuedResult.snapshot) {
            setQueue(queuedResult.snapshot.items);
            setQueueRevision(queuedResult.snapshot.revision);
          }
          setQueueError(queuedResult.error);
          setPermissionProfiles(permissionProfileResult);
          if (!permissionProfileId && permissionProfileResult.some((profile) => profile.allowed)) {
            setPermissionProfileId(
              permissionProfileResult.find((profile) => profile.allowed)?.id ?? "",
            );
          }
          setApprovalPolicies(approvalPolicyResult);
          setApprovalReviewers(approvalReviewerResult);
          if (shouldCommitThreadGoalLoad(goalLoadedRef.current, goalResult)) {
            setGoalDraft(goalResult?.goal?.objective ?? "");
            setThreadGoal(goalResult?.goal ?? undefined);
            goalLoadedRef.current = true;
          }
          onSubagentsLoaded(agents);
          onUsageLoaded(usageSnapshot);
          if (
            !productSettingsDirtyRef.current &&
            productSettingsGenerationRef.current === productSettingsGeneration
          ) {
            setApprovalPolicy((current) =>
              chooseApprovalPolicy(approvalPolicyResult, mergedDetail.approvalPolicy ?? current),
            );
            setApprovalReviewer((current) =>
              chooseApprovalReviewer(
                approvalReviewerResult,
                mergedDetail.approvalsReviewer ?? current,
              ),
            );
          }
        } catch (loadError) {
          if (currentIdRef.current !== id || silent) return;
          setError(errorMessage(loadError));
          setState("error");
          onThreadLoaded(undefined);
          onSubagentsLoaded([]);
        }
      })();
      const request = { id, featureKey: loadFeatureKey, promise };
      loadInFlight.current = request;
      void promise.finally(() => {
        if (loadInFlight.current === request) loadInFlight.current = undefined;
      });
      return promise;
    },
    [
      apiClient,
      finishContextCompaction,
      goalReadable,
      id,
      models,
      onSubagentsLoaded,
      onSnapshotEventCursor,
      onThreadLoaded,
      onUsageLoaded,
      approvalReviewersCapability,
      approvalPoliciesCapability,
      permissionProfilesCapability,
      permissionProfileId,
      queueSupported,
      loadFeatureKey,
    ],
  );

  useEffect(() => {
    handledLiveDelivery.current = 0;
    subagentsRef.current = [];
    subagentHistoryIntegrityRef.current = undefined;
    subagentsNextCursorRef.current = undefined;
    subagentsExtendedRef.current = false;
    setSubagents([]);
    setSubagentHistoryIntegrity(undefined);
    setSubagentsNextCursor(undefined);
    setSubagentsMoreState("idle");
    setSubagentsError("");
    setCompactionRequestState("idle");
    setCompactionNotice("");
    setCompactionError("");
    setQueue([]);
    setQueueRevision(0);
    setQueueBusyId("");
    setQueueError("");
    setPermissionProfiles([]);
    setApprovalPolicies([]);
    setApprovalPolicy("");
    setApprovalReviewers([]);
    setApprovalReviewer("");
    setDeliveryMode("steer");
    setComposerSheet("");
    setShowUsage(false);
    setUsageRefreshState("idle");
    setUsageRefreshError("");
    setThreadIdCopyState("idle");
    setRuntimeNotice(undefined);
    setVisibleItemLimit(INITIAL_CONVERSATION_ITEM_LIMIT);
    setHistoryNextCursor(undefined);
    setHistoryMoreState("idle");
    historyExtendedRef.current = false;
    historyLoadInFlightRef.current = undefined;
    historyRevealScheduledRef.current = false;
    conversationAwayRef.current = false;
    lastConversationScrollTopRef.current = 0;
    conversationUserScrollIntentAtRef.current = 0;
    setConversationAway(false);
    setGoalDraft("");
    setThreadGoal(undefined);
    setActionError("");
    setActionStatus("");
    setResumeBusy(false);
    setSending(false);
    setInterrupting(false);
    setInterruptRequestedTurnId("");
    goalLoadedRef.current = false;
    productSettingsGenerationRef.current += 1;
    productSettingsDirtyRef.current = false;
    collaborationModeDirtyRef.current = false;
    compactionAttemptRef.current = undefined;
    compactionRequestFlightRef.current = undefined;
    creationPromptLiveAliasItemIdRef.current = undefined;
    creationPromptPersistedItemIdRef.current = undefined;
    retainedReplayThroughRef.current = 0;
    setDetailProjectionReady(Boolean(routeSeedRef.current));
    const fallback =
      routeSeedRef.current ??
      (summaryRef.current ? detailFromThreadSummary(summaryRef.current) : undefined);
    if (fallback) {
      threadRef.current = fallback;
      setThread(fallback);
      setNextTurnSettings(nextTurnSettingsDraft(modelsRef.current, fallback));
      setServiceTier(
        fallback.serviceTier ??
          modelsRef.current.find((model) => model.id === fallback.model)?.defaultServiceTier ??
          null,
      );
      setPermissionProfileId(fallback.permissionProfileId ?? "");
      setApprovalPolicy(fallback.approvalPolicy ?? "");
      setApprovalReviewer(fallback.approvalsReviewer ?? "");
      setCollaborationMode(
        chooseCollaborationMode(collaborationModes, fallback.collaborationMode) ?? "",
      );
      setState("ready");
      setError("");
    } else {
      threadRef.current = undefined;
      setThread(undefined);
      setThreadUsage(undefined);
      setNextTurnSettings(nextTurnSettingsDraft(modelsRef.current, undefined));
      setServiceTier(
        modelsRef.current.find((model) => model.isDefault)?.defaultServiceTier ?? null,
      );
    }
  }, [id]);

  useEffect(() => {
    if (
      !shouldSeedThreadFromLateSummary(
        threadRef.current?.id,
        routeSeedRef.current?.id,
        summary?.id,
      ) ||
      !summary
    ) {
      return;
    }
    const fallback = detailFromThreadSummary(summary);
    threadRef.current = fallback;
    setThread(fallback);
    setNextTurnSettings(nextTurnSettingsDraft(models, fallback));
    setServiceTier(
      fallback.serviceTier ??
        models.find((model) => model.id === fallback.model)?.defaultServiceTier ??
        null,
    );
    setPermissionProfileId(fallback.permissionProfileId ?? "");
    setApprovalPolicy(fallback.approvalPolicy ?? "");
    setApprovalReviewer(fallback.approvalsReviewer ?? "");
    setState("ready");
    setError("");
  }, [models, summary]);

  useEffect(() => {
    if (!thread || thread.id !== id || !detailProjectionReady) return;
    const nextState = compactThreadNavigationState(thread, routeInitialPromptRef.current);
    const signature = JSON.stringify(nextState);
    if (navigationSeedSignatureRef.current === signature) return;
    navigationSeedSignatureRef.current = signature;
    writeThreadNavigationCache(window.sessionStorage, nextState);
    void navigate(`/threads/${id}`, {
      replace: true,
      state: nextState,
    });
  }, [detailProjectionReady, id, navigate, thread]);

  useEffect(() => {
    if (!showUsage) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setShowUsage(false);
    }

    function closeOutsideUsage(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (usageButtonRef.current?.contains(target) || usagePanelRef.current?.contains(target))
        return;
      setShowUsage(false);
    }

    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOutsideUsage);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOutsideUsage);
    };
  }, [showUsage]);

  useEffect(() => {
    void load(Boolean(routeSeedRef.current ?? summaryRef.current));
  }, [load]);

  useEffect(() => {
    return () => {
      if (composerCollapseTimerRef.current !== undefined) {
        window.clearTimeout(composerCollapseTimerRef.current);
      }
      onThreadLoaded(undefined);
      onSubagentsLoaded([]);
      onUsageLoaded(undefined);
    };
  }, [onSubagentsLoaded, onThreadLoaded, onUsageLoaded]);

  useEffect(() => {
    if (interruptRequestedTurnId && thread?.activeTurnId !== interruptRequestedTurnId) {
      setInterruptRequestedTurnId("");
    }
  }, [interruptRequestedTurnId, thread?.activeTurnId]);

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
      const preserveExpandedHistory = cursor === undefined && subagentsExtendedRef.current;
      const nextCursor = preserveExpandedHistory ? subagentsNextCursorRef.current : page.nextCursor;
      if (cursor !== undefined) subagentsExtendedRef.current = true;
      subagentsNextCursorRef.current = nextCursor;
      const integrity = accumulateSubagentHistoryIntegrity({
        accumulatedCount: agents.length,
        continuing: cursor !== undefined,
        incoming: page.historyIntegrity,
        nextCursor: page.nextCursor,
        preserveExpandedHistory,
        previous: subagentHistoryIntegrityRef.current,
      });
      subagentHistoryIntegrityRef.current = integrity;
      setSubagents(agents);
      setSubagentHistoryIntegrity(integrity);
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
    const resetPartition = partitionLiveDeliveriesAtReset(pending);
    if (resetPartition.reset) {
      handledLiveDelivery.current = resetPartition.reset.deliveryId;
      const current = threadRef.current;
      if (current) {
        applyThreadRemoteEvents(current, [resetPartition.reset.event], {
          projection: remoteProjectionRef.current,
        });
      }
      retainedReplayThroughRef.current = 0;
      setDetailProjectionReady(false);
      const pendingCompactionAttempt = compactionAttemptRef.current;
      if (pendingCompactionAttempt) {
        compactionAttemptRef.current =
          markContextCompactionRecoveryRequired(pendingCompactionAttempt);
      }
      const collidedWithExistingLoad = loadInFlight.current?.id === id;
      const recovery = load(true);
      if (collidedWithExistingLoad) {
        void recovery.finally(() => {
          if (currentIdRef.current === id) void load(true);
        });
      }
      return;
    }
    if (!detailProjectionReady) {
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
      const current = threadRef.current;
      if (current) {
        const creationContext = routeSeedRef.current
          ? {
              creationSeed: routeSeedRef.current,
              ...(routeInitialPromptRef.current === undefined
                ? {}
                : { initialPrompt: routeInitialPromptRef.current }),
              ...(creationPromptLiveAliasItemIdRef.current === undefined
                ? {}
                : { liveAliasItemId: creationPromptLiveAliasItemIdRef.current }),
            }
          : undefined;
        const liveAliasItemId = findCreationPromptLiveAliasItemId(relevantEvents, creationContext);
        if (liveAliasItemId) {
          creationPromptLiveAliasItemIdRef.current = liveAliasItemId;
        }
        const liveCreationContext =
          creationContext && liveAliasItemId
            ? { ...creationContext, liveAliasItemId }
            : creationContext;
        let projected = current;
        let group: RemoteEvent[] = [];
        let replayed = relevant[0]
          ? isReplayDelivery(relevant[0], retainedReplayThroughRef.current)
          : false;
        const flush = () => {
          if (group.length === 0) return;
          projected = applyThreadRemoteEvents(projected, group, {
            projection: remoteProjectionRef.current,
            replayed,
          });
          group = [];
        };
        for (const envelope of relevant) {
          const envelopeReplayed = isReplayDelivery(envelope, retainedReplayThroughRef.current);
          if (envelopeReplayed !== replayed) {
            flush();
            replayed = envelopeReplayed;
          }
          group.push(envelope.event);
        }
        flush();
        projected = reconcileLiveCreationPromptAlias(
          projected,
          liveCreationContext,
          creationPromptPersistedItemIdRef.current,
        );
        threadRef.current = projected;
        setThread(projected);
        if (!productSettingsDirtyRef.current) {
          setServiceTier(projected.serviceTier ?? null);
          if (projected.permissionProfileId) {
            setPermissionProfileId(projected.permissionProfileId);
          }
          if (
            projected.approvalPolicy &&
            approvalPolicies.some((policy) => policy.id === projected.approvalPolicy)
          ) {
            setApprovalPolicy(projected.approvalPolicy);
          }
          if (
            projected.approvalsReviewer &&
            approvalReviewers.some((reviewer) => reviewer.id === projected.approvalsReviewer)
          ) {
            setApprovalReviewer(projected.approvalsReviewer);
          }
          if (projected.collaborationMode) {
            setCollaborationMode(projected.collaborationMode);
          }
        }
      }
      setThreadUsage((current) => applyUsageRemoteEvents(current, id, relevantEvents));
      setRuntimeNotice((current) => reduceRuntimeNotice(current, relevantEvents));
      if (queueSupported && relevantEvents.some((event) => event.type === "queue.updated")) {
        void apiClient
          .queue(id)
          .then((snapshot) => {
            if (currentIdRef.current !== id) return;
            setQueue(snapshot.items);
            setQueueRevision(snapshot.revision);
            setQueueError("");
          })
          .catch((queueRefreshError: unknown) => setQueueError(errorMessage(queueRefreshError)));
      }
    }

    const compactionAttempt = compactionAttemptRef.current;
    if (compactionAttempt) {
      const progress = applyContextCompactionEvents(compactionAttempt, relevantEvents);
      compactionAttemptRef.current = progress.attempt;
      if (progress.resolution !== "pending") {
        finishContextCompaction(progress.attempt.idempotencyKey, progress.resolution);
      }
    }

    const turnFinished = relevantEvents.some((event) => {
      if (event.type !== "turn.state") return false;
      const payload =
        typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : {};
      return payload.state === "idle" || payload.state === "complete" || payload.state === "failed";
    });
    const pendingCompactionAttempt = compactionAttemptRef.current;
    if (pendingCompactionAttempt && missedBufferedEvents) {
      compactionAttemptRef.current =
        markContextCompactionRecoveryRequired(pendingCompactionAttempt);
    }
    if (missedBufferedEvents || turnFinished) {
      void load(true);
    }
  }, [
    apiClient,
    approvalPolicies,
    approvalReviewers,
    detailProjectionReady,
    finishContextCompaction,
    id,
    liveEvents,
    load,
    queueSupported,
    state,
    thread,
  ]);

  useEffect(() => {
    let timer: number | undefined;
    let disposed = false;
    const delay = threadRefreshDelay(
      thread?.state,
      compactionRequestState === "accepted" || Boolean(interruptRequestedTurnId),
    );
    const clear = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      clear();
      if (disposed || !canRefreshDocument(document.visibilityState)) return;
      timer = window.setTimeout(() => {
        if (isTextEntryElement(document.activeElement)) {
          schedule();
          return;
        }
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
  }, [compactionRequestState, interruptRequestedTurnId, load, thread?.state]);

  useEffect(() => {
    window.localStorage.setItem(`draft:${id}`, draft);
  }, [draft, id]);

  useEffect(() => {
    if (!actionStatus) return;
    const timer = window.setTimeout(() => setActionStatus(""), 4_000);
    return () => window.clearTimeout(timer);
  }, [actionStatus]);

  useEffect(() => {
    writeConversationAttachments(window.localStorage, id, attachments);
  }, [attachments, id]);

  useEffect(() => {
    initialScrollThreadRef.current = "";
    setDraftCopyState("idle");
    setComposerExpansion(composerExpandedAfterIntent("thread-change"));
    setAttachments(readConversationAttachments(window.localStorage, id));
  }, [id]);

  useEffect(() => {
    const collapseOutsideComposer = (event: PointerEvent) => {
      if (!composerExpandedRef.current) return;
      const target = event.target;
      if (target instanceof Node && composerShellRef.current?.contains(target)) return;
      composerExpandedRef.current = false;
      setComposerExpanded(false);
    };
    document.addEventListener("pointerdown", collapseOutsideComposer);
    return () => document.removeEventListener("pointerdown", collapseOutsideComposer);
  }, []);

  useLayoutEffect(() => {
    if (state !== "ready" || !detailProjectionReady || initialScrollThreadRef.current === id) {
      return;
    }
    initialScrollThreadRef.current = id;
    const element = conversationScrollRef.current;
    if (!element) return;
    element.scrollTop = initialConversationScrollTop(element.scrollHeight, element.clientHeight);
    lastConversationScrollTopRef.current = element.scrollTop;
    conversationAwayRef.current = false;
    setConversationAway(false);
  }, [detailProjectionReady, id, state]);

  useLayoutEffect(() => {
    const scroll = conversationScrollRef.current;
    if (!scroll || state !== "ready" || !detailProjectionReady || conversationAwayRef.current) {
      return;
    }
    scroll.scrollTop = initialConversationScrollTop(scroll.scrollHeight, scroll.clientHeight);
    lastConversationScrollTopRef.current = scroll.scrollTop;
  }, [detailProjectionReady, state, visibleItems.length]);

  useEffect(() => {
    const scroll = conversationScrollRef.current;
    const stream = conversationStreamRef.current;
    if (!scroll || !stream || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (conversationAwayRef.current) return;
      scroll.scrollTop = initialConversationScrollTop(scroll.scrollHeight, scroll.clientHeight);
      lastConversationScrollTopRef.current = scroll.scrollTop;
    });
    observer.observe(stream);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [id]);

  function updateConversationPosition() {
    const element = conversationScrollRef.current;
    if (!element) return;
    const previousScrollTop = lastConversationScrollTopRef.current;
    const movedUp = element.scrollTop < previousScrollTop - 1;
    const userDriven = conversationScrollWasUserDriven(
      conversationUserScrollIntentAtRef.current,
      Date.now(),
    );
    const nextAway = conversationAwayAfterScroll(
      conversationAwayRef.current,
      previousScrollTop,
      element.scrollHeight,
      element.clientHeight,
      element.scrollTop,
    );
    lastConversationScrollTopRef.current = element.scrollTop;
    if (!userDriven) return;
    if (movedUp && element.scrollTop <= 96) {
      revealEarlierConversationItems();
    }
    if (nextAway === conversationAwayRef.current) return;
    conversationAwayRef.current = nextAway;
    setConversationAway(nextAway);
  }

  function markConversationUserScrollIntent() {
    conversationUserScrollIntentAtRef.current = Date.now();
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeElement.closest(".composer-shell")) {
      activeElement.blur();
    }
    setComposerExpansion(composerExpandedAfterIntent("conversation-scroll"));
  }

  function refreshUsageDetails() {
    setShowUsage(true);
    if (usageRefreshInFlightRef.current) return usageRefreshInFlightRef.current;
    setUsageRefreshState("refreshing");
    setUsageRefreshError("");
    const requestedThreadId = id;
    const flight = apiClient
      .usage(requestedThreadId)
      .then((snapshot) => {
        if (currentIdRef.current !== requestedThreadId) return;
        setThreadUsage(snapshot);
        onUsageLoaded(snapshot);
        setUsageRefreshState("idle");
      })
      .catch((usageError: unknown) => {
        if (currentIdRef.current !== requestedThreadId) return;
        setUsageRefreshState("error");
        setUsageRefreshError(errorMessage(usageError));
      });
    usageRefreshInFlightRef.current = flight;
    void flight.finally(() => {
      if (usageRefreshInFlightRef.current === flight) {
        usageRefreshInFlightRef.current = undefined;
      }
    });
    return flight;
  }

  function toggleUsageDetails() {
    if (showUsage) {
      setShowUsage(false);
      return;
    }
    void refreshUsageDetails();
  }

  async function copyThreadId() {
    try {
      await copyPlainText(id);
      if (currentIdRef.current === id) setThreadIdCopyState("copied");
    } catch {
      if (currentIdRef.current === id) setThreadIdCopyState("error");
    }
  }

  async function copyDraft() {
    if (!draft) return;
    setDraftCopyState("copied");
    try {
      await copyPlainText(draft);
    } catch {
      if (currentIdRef.current === id) setDraftCopyState("error");
    }
  }

  function revealEarlierConversationItems() {
    if (hiddenItemCount <= 0) {
      void loadEarlierConversationHistory();
      return;
    }
    if (historyRevealScheduledRef.current) return;
    historyRevealScheduledRef.current = true;
    const scroll = conversationScrollRef.current;
    const previousHeight = scroll?.scrollHeight ?? 0;
    const previousTop = scroll?.scrollTop ?? 0;
    conversationAwayRef.current = true;
    setConversationAway(true);
    setVisibleItemLimit((current) =>
      nextConversationItemLimit(current, threadRef.current?.items.length ?? current),
    );
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        historyRevealScheduledRef.current = false;
        if (!scroll) return;
        scroll.scrollTop = conversationHistoryAnchorTop(
          previousTop,
          previousHeight,
          scroll.scrollHeight,
        );
        lastConversationScrollTopRef.current = scroll.scrollTop;
      });
    });
  }

  function loadEarlierConversationHistory() {
    if (!historyNextCursor || historyLoadInFlightRef.current) {
      return historyLoadInFlightRef.current;
    }
    const requestedThreadId = id;
    const cursor = historyNextCursor;
    const scroll = conversationScrollRef.current;
    const previousHeight = scroll?.scrollHeight ?? 0;
    const previousTop = scroll?.scrollTop ?? 0;
    conversationAwayRef.current = true;
    setConversationAway(true);
    setHistoryMoreState("loading");
    const flight = apiClient
      .thread(id, cursor)
      .then((olderPage) => {
        if (currentIdRef.current !== requestedThreadId || !threadRef.current) return;
        const merged = prependConversationHistory(threadRef.current, olderPage);
        historyExtendedRef.current = true;
        threadRef.current = merged.detail;
        setThread(merged.detail);
        setHistoryNextCursor(olderPage.historyNextCursor);
        if (merged.added > 0) {
          setVisibleItemLimit((current) => current + merged.added);
        }
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            if (!scroll) return;
            scroll.scrollTop = conversationHistoryAnchorTop(
              previousTop,
              previousHeight,
              scroll.scrollHeight,
            );
            lastConversationScrollTopRef.current = scroll.scrollTop;
          });
        });
        setHistoryMoreState("idle");
      })
      .catch(() => {
        if (currentIdRef.current === requestedThreadId) setHistoryMoreState("error");
      });
    historyLoadInFlightRef.current = flight;
    void flight.finally(() => {
      if (historyLoadInFlightRef.current === flight) {
        historyLoadInFlightRef.current = undefined;
      }
    });
    return flight;
  }

  function nextTurnProductSettings(
    overrides: {
      serviceTier?: string | null;
      permissionProfileId?: string;
      approvalPolicy?: string;
      approvalsReviewer?: string;
      collaborationMode?: string;
    } = {},
  ) {
    const base = nextTurnSettingsInput(nextTurnSettings, models);
    const selectedServiceTier =
      overrides.serviceTier === undefined ? serviceTier : overrides.serviceTier;
    const selectedPermission =
      overrides.permissionProfileId === undefined
        ? permissionProfileId
        : overrides.permissionProfileId;
    const selectedApprovalReviewer =
      overrides.approvalsReviewer === undefined ? approvalReviewer : overrides.approvalsReviewer;
    const selectedApprovalPolicy =
      overrides.approvalPolicy === undefined ? approvalPolicy : overrides.approvalPolicy;
    const selectedCollaboration =
      overrides.collaborationMode === undefined ? collaborationMode : overrides.collaborationMode;
    return {
      ...base,
      ...serviceTierSetting(
        capabilities,
        selectedServiceTier === null ? undefined : selectedServiceTier,
      ),
      ...(permissionProfilesSupported && selectedPermission
        ? { permissionProfileId: selectedPermission }
        : {}),
      ...(approvalPoliciesSupported && selectedApprovalPolicy
        ? { approvalPolicy: selectedApprovalPolicy }
        : {}),
      ...(approvalReviewersSupported && selectedApprovalReviewer
        ? { approvalsReviewer: selectedApprovalReviewer }
        : {}),
      ...collaborationModeSetting(capabilities, collaborationModes, selectedCollaboration, {
        includeDefault:
          overrides.collaborationMode !== undefined || collaborationModeDirtyRef.current,
      }),
    };
  }

  async function submit() {
    if (
      !thread ||
      thread.mode === "desktop-snapshot" ||
      !draft.trim() ||
      !runtimeControlAvailable
    ) {
      return;
    }
    setSending(true);
    setActionError("");
    try {
      const prompt = draft.trim();
      let currentThread = threadRef.current ?? thread;
      let decision = composerDeliveryDecision(currentThread, deliveryMode, queueSupported);
      const decisionBeforeRefresh = decision;
      if (decision === "start" || decision === "synchronize") {
        const authoritative = await readThreadControlBeforeSubmit(apiClient, currentThread.id);
        if (currentIdRef.current !== id) return;
        const creationContext = routeSeedRef.current
          ? {
              creationSeed: routeSeedRef.current,
              ...(routeInitialPromptRef.current === undefined
                ? {}
                : { initialPrompt: routeInitialPromptRef.current }),
              ...(creationPromptLiveAliasItemIdRef.current === undefined
                ? {}
                : { liveAliasItemId: creationPromptLiveAliasItemIdRef.current }),
            }
          : undefined;
        const synchronized = mergeAuthoritativeThreadControl(
          threadRef.current,
          authoritative,
          creationContext,
        );
        threadRef.current = synchronized;
        setThread(synchronized);
        onThreadLoaded(synchronized);
        currentThread = authoritative;
        decision = composerDeliveryDecision(authoritative, deliveryMode, queueSupported);
        if (decisionBeforeRefresh === "start" && decision !== "start") {
          setActionError(
            "电脑端刚开始或仍在执行回复，状态已同步；请选择“引导”或“排队”后再次发送，文字已保留。",
          );
          return;
        }
        if (decisionBeforeRefresh === "synchronize" && decision === "start") {
          setActionError("刚才的回复已经结束，状态已同步；再次发送会开始下一轮，文字已保留。");
          return;
        }
      }
      if (decision === "synchronize") {
        setActionError("正在同步当前回复的控制状态；也可以切换为“排队”，文字已保留。");
        return;
      }
      if (decision === "queue") {
        const snapshot = await apiClient.enqueue(currentThread.id, {
          prompt,
          ...(attachments.length ? { attachments } : {}),
          ...nextTurnProductSettings(),
        });
        setQueue(snapshot.items);
        setQueueRevision(snapshot.revision);
        collaborationModeDirtyRef.current = false;
        setActionStatus("turn-queued");
      } else if (decision === "steer" && currentThread.activeTurnId) {
        reserveSubmittedTurnUserAlias(remoteProjectionRef.current, currentThread.id, prompt);
        const optimisticId = `pending-steer-${Date.now()}`;
        const latestThread = threadRef.current ?? currentThread;
        const optimistic = appendOptimisticUserMessage(
          latestThread,
          prompt,
          optimisticId,
          currentThread.activeTurnId,
        );
        threadRef.current = optimistic;
        setThread(optimistic);
        try {
          await apiClient.steer(currentThread.id, currentThread.activeTurnId, {
            prompt,
            ...(attachments.length ? { attachments } : {}),
          });
        } catch (steerError) {
          cancelSubmittedTurnUserAlias(remoteProjectionRef.current, currentThread.id, prompt);
          const latestAfterFailure = threadRef.current ?? optimistic;
          const rolledBack = removeOptimisticConversationItem(latestAfterFailure, optimisticId);
          threadRef.current = rolledBack;
          setThread(rolledBack);
          throw steerError;
        }
        const accepted = threadRef.current ?? optimistic;
        rememberSubmittedTurnUserAlias(remoteProjectionRef.current, accepted, prompt);
        setActionStatus("steer-accepted");
      } else {
        reserveSubmittedTurnUserAlias(remoteProjectionRef.current, currentThread.id, prompt);
        const optimisticId = `pending-send-${Date.now()}`;
        const latestThread = threadRef.current ?? currentThread;
        const optimistic = appendOptimisticUserMessage(latestThread, prompt, optimisticId);
        threadRef.current = optimistic;
        setThread(optimistic);
        let authoritative: ThreadDetail;
        try {
          authoritative = await apiClient.sendTurn(currentThread.id, {
            prompt,
            ...(attachments.length ? { attachments } : {}),
            ...nextTurnProductSettings(),
          });
        } catch (sendError) {
          cancelSubmittedTurnUserAlias(remoteProjectionRef.current, currentThread.id, prompt);
          const latestAfterFailure = threadRef.current ?? optimistic;
          const rolledBack = removeOptimisticConversationItem(latestAfterFailure, optimisticId);
          threadRef.current = rolledBack;
          setThread(rolledBack);
          throw sendError;
        }
        const updated = mergeAuthoritativeThreadControl(
          threadRef.current ?? optimistic,
          authoritative,
        );
        rememberSubmittedTurnUserAlias(remoteProjectionRef.current, updated, prompt);
        threadRef.current = updated;
        setThread(updated);
        setNextTurnSettings((current) => consumeNextTurnSettingsDraft(current, models, updated));
        productSettingsGenerationRef.current += 1;
        productSettingsDirtyRef.current = false;
        collaborationModeDirtyRef.current = false;
        setServiceTier(updated.serviceTier ?? serviceTier);
        if (updated.permissionProfileId) setPermissionProfileId(updated.permissionProfileId);
        if (
          updated.approvalPolicy &&
          approvalPolicies.some((policy) => policy.id === updated.approvalPolicy)
        ) {
          setApprovalPolicy(updated.approvalPolicy);
        }
        if (
          updated.approvalsReviewer &&
          approvalReviewers.some((reviewer) => reviewer.id === updated.approvalsReviewer)
        ) {
          setApprovalReviewer(updated.approvalsReviewer);
        }
        if (updated.collaborationMode) setCollaborationMode(updated.collaborationMode);
        onThreadLoaded(updated);
      }
      setDraft("");
      setAttachments([]);
      setComposerExpansion(composerExpandedAfterIntent("submit"));
      window.localStorage.removeItem(`draft:${id}`);
      window.localStorage.removeItem(`conversation-attachments:${encodeURIComponent(id)}`);
      window.setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), 20);
    } catch (submitError) {
      if (submitError instanceof ApiRequestError && submitError.code === "TURN_MISMATCH") {
        setActionError(`${submitError.message}；状态正在刷新，文字已保留。`);
        void load(true);
      } else {
        setActionError(errorMessage(submitError));
      }
    } finally {
      setSending(false);
    }
  }

  async function persistNextTurnSettings(
    overrides: {
      serviceTier?: string | null;
      permissionProfileId?: string;
      approvalPolicy?: string;
      approvalsReviewer?: string;
      collaborationMode?: string;
    } = {},
  ) {
    if (!thread || settingsBusy || !runtimeControlAvailable) return;
    setSettingsBusy(true);
    setActionError("");
    try {
      if (settingsUpdateSupported && thread.availableActions.updateSettings !== false) {
        const requested: ThreadSettingsInput = {
          ...nextTurnProductSettings(overrides),
          ...(overrides.serviceTier === null ? serviceTierSetting(capabilities, null) : {}),
        };
        await apiClient.updateThreadSettings(thread.id, requested);
        const authoritative = await apiClient.thread(thread.id);
        if (currentIdRef.current !== thread.id) return;
        const mismatches = threadSettingsReadbackMismatches(requested, authoritative);
        const rejectedApprovalReviewer = rejectedApprovalReviewerId(requested, authoritative);
        const authoritativeApprovalReviewers = rejectedApprovalReviewer
          ? approvalReviewers.filter((reviewer) => reviewer.id !== rejectedApprovalReviewer)
          : approvalReviewers;
        if (rejectedApprovalReviewer) {
          setApprovalReviewers(authoritativeApprovalReviewers);
        }
        const synchronized = mergeAuthoritativeThreadControl(threadRef.current, authoritative);
        threadRef.current = synchronized;
        setThread(synchronized);
        onThreadLoaded(synchronized);
        setNextTurnSettings((current) =>
          reconcileNextTurnSettingsDraft(current, models, authoritative),
        );
        setServiceTier(authoritative.serviceTier ?? null);
        setPermissionProfileId(
          choosePermissionProfileId(permissionProfiles, authoritative.permissionProfileId) ?? "",
        );
        setApprovalPolicy(chooseApprovalPolicy(approvalPolicies, authoritative.approvalPolicy));
        setApprovalReviewer(
          chooseApprovalReviewer(authoritativeApprovalReviewers, authoritative.approvalsReviewer),
        );
        setCollaborationMode(
          chooseCollaborationMode(collaborationModes, authoritative.collaborationMode) ?? "",
        );
        if (mismatches.length > 0) {
          setComposerSheet("");
          setActionError(
            `Codex 没有接受这些下一轮设置：${mismatches.join("、")}。已恢复为电脑端实际值。`,
          );
          return;
        }
        productSettingsGenerationRef.current += 1;
        productSettingsDirtyRef.current = false;
        collaborationModeDirtyRef.current = false;
      }
      setActionStatus("settings-applied");
      setComposerSheet("");
    } catch (settingsError) {
      setActionError(errorMessage(settingsError));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function updateQueuedPrompt(item: QueuedTurnItem, prompt: string) {
    if (!thread) return;
    setQueueBusyId(item.id);
    setQueueError("");
    try {
      const snapshot = await apiClient.updateQueued(thread.id, item.id, {
        expectedRevision: queueRevision,
        prompt,
        ...(item.attachments ? { attachments: item.attachments } : {}),
        ...(item.approvalPolicy ? { approvalPolicy: item.approvalPolicy } : {}),
        ...(item.approvalsReviewer ? { approvalsReviewer: item.approvalsReviewer } : {}),
        ...(item.collaborationMode ? { collaborationMode: item.collaborationMode } : {}),
        ...(item.model ? { model: item.model } : {}),
        ...(item.permissionProfileId ? { permissionProfileId: item.permissionProfileId } : {}),
        ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}),
        ...(item.serviceTier ? { serviceTier: item.serviceTier } : {}),
      });
      setQueue(snapshot.items);
      setQueueRevision(snapshot.revision);
    } catch (queueActionError) {
      setQueueError(errorMessage(queueActionError));
    } finally {
      setQueueBusyId("");
    }
  }

  async function deleteQueued(item: QueuedTurnItem) {
    if (!thread) return;
    setQueueBusyId(item.id);
    setQueueError("");
    try {
      const snapshot = await apiClient.deleteQueued(thread.id, item.id, queueRevision);
      setQueue(snapshot.items);
      setQueueRevision(snapshot.revision);
    } catch (queueActionError) {
      setQueueError(errorMessage(queueActionError));
    } finally {
      setQueueBusyId("");
    }
  }

  async function moveQueued(item: QueuedTurnItem, offset: -1 | 1) {
    if (!thread) return;
    const previous = queue;
    const moved = moveQueueItem(queue, item.id, offset);
    setQueue(moved);
    setQueueBusyId(item.id);
    setQueueError("");
    try {
      const authoritative = await apiClient.reorderQueue(thread.id, {
        expectedRevision: queueRevision,
        queueIds: moved.map((candidate) => candidate.id),
      });
      setQueue(authoritative.items);
      setQueueRevision(authoritative.revision);
    } catch (queueActionError) {
      setQueue(previous);
      setQueueError(errorMessage(queueActionError));
    } finally {
      setQueueBusyId("");
    }
  }

  async function dispatchQueued(item: QueuedTurnItem) {
    if (!thread || thread.activeTurnId) return;
    setQueueBusyId(item.id);
    setQueueError("");
    try {
      const snapshot = await apiClient.dispatchQueued(thread.id, item.id, {
        expectedRevision: queueRevision,
        ...(item.state === "ambiguous" ? { retryAmbiguous: true } : {}),
      });
      setQueue(snapshot.items);
      setQueueRevision(snapshot.revision);
      const updated = await apiClient.thread(thread.id);
      const merged = mergeQueuedThreadRefresh(threadRef.current ?? thread, updated);
      threadRef.current = merged;
      setThread(merged);
      onThreadLoaded(merged);
    } catch (queueActionError) {
      setQueueError(errorMessage(queueActionError));
    } finally {
      setQueueBusyId("");
    }
  }

  async function steerQueued(item: QueuedTurnItem) {
    if (!thread?.activeTurnId || !thread.availableActions.steer) return;
    const prompt = item.prompt?.trim();
    const optimisticId = prompt ? `pending-steer-${Date.now()}` : undefined;
    const optimistic =
      prompt && optimisticId
        ? appendOptimisticUserMessage(
            threadRef.current ?? thread,
            prompt,
            optimisticId,
            thread.activeTurnId,
          )
        : (threadRef.current ?? thread);
    if (prompt) {
      reserveSubmittedTurnUserAlias(remoteProjectionRef.current, thread.id, prompt);
      threadRef.current = optimistic;
      setThread(optimistic);
    }
    setQueueBusyId(item.id);
    setQueueError("");
    let accepted = false;
    try {
      const snapshot = await apiClient.steerQueued(thread.id, item.id, {
        expectedRevision: queueRevision,
        turnId: thread.activeTurnId,
      });
      accepted = true;
      setQueue(snapshot.items);
      setQueueRevision(snapshot.revision);
      setActionStatus("steer-accepted");
      const updated = await apiClient.thread(thread.id);
      const merged = mergeQueuedThreadRefresh(threadRef.current ?? optimistic, updated);
      if (prompt) {
        rememberSubmittedTurnUserAlias(remoteProjectionRef.current, merged, prompt);
      }
      threadRef.current = merged;
      setThread(merged);
      onThreadLoaded(merged);
    } catch (queueActionError) {
      if (accepted && prompt) {
        rememberSubmittedTurnUserAlias(
          remoteProjectionRef.current,
          threadRef.current ?? optimistic,
          prompt,
        );
      } else if (!accepted && prompt && optimisticId) {
        cancelSubmittedTurnUserAlias(remoteProjectionRef.current, thread.id, prompt);
        const rolledBack = removeOptimisticConversationItem(
          threadRef.current ?? optimistic,
          optimisticId,
        );
        threadRef.current = rolledBack;
        setThread(rolledBack);
      }
      setQueueError(errorMessage(queueActionError));
    } finally {
      setQueueBusyId("");
    }
  }

  async function saveGoal() {
    if (!thread || !goalDraft.trim() || goalBusy) return;
    setGoalBusy(true);
    setActionError("");
    try {
      await apiClient.setThreadGoal(thread.id, { objective: goalDraft.trim() });
      const result = await apiClient.threadGoal(thread.id);
      setThreadGoal(result.goal ?? undefined);
      setGoalDraft(result.goal?.objective ?? goalDraft.trim());
      setActionStatus("goal-saved");
      setComposerSheet("");
    } catch (goalError) {
      setActionError(errorMessage(goalError));
    } finally {
      setGoalBusy(false);
    }
  }

  async function clearGoal() {
    if (!thread || goalBusy) return;
    setGoalBusy(true);
    setActionError("");
    try {
      await apiClient.clearThreadGoal(thread.id);
      setGoalDraft("");
      setThreadGoal(undefined);
      setActionStatus("goal-saved");
      setComposerSheet("");
    } catch (goalError) {
      setActionError(errorMessage(goalError));
    } finally {
      setGoalBusy(false);
    }
  }

  async function setGoalStatus(status: "active" | "paused") {
    if (!thread || !threadGoal || goalBusy) return;
    setGoalBusy(true);
    setActionError("");
    try {
      await apiClient.setThreadGoal(thread.id, { status });
      const result = await apiClient.threadGoal(thread.id);
      setThreadGoal(result.goal ?? undefined);
      setGoalDraft(result.goal?.objective ?? goalDraft);
      setActionStatus(status === "paused" ? "goal-paused" : "goal-resumed");
      setComposerSheet("");
    } catch (goalError) {
      setActionError(errorMessage(goalError));
    } finally {
      setGoalBusy(false);
    }
  }

  async function resumeHistoryThread() {
    if (!thread || thread.mode !== "desktop-snapshot" || !runtimeControlAvailable || resumeBusy) {
      return;
    }
    setResumeBusy(true);
    setActionError("");
    try {
      const restored = await apiClient.resumeThread(thread.id, crypto.randomUUID());
      threadRef.current = restored;
      setThread(restored);
      setDetailProjectionReady(true);
      onThreadLoaded(restored);
      await load(true);
    } catch (resumeError) {
      setActionError(errorMessage(resumeError));
    } finally {
      setResumeBusy(false);
    }
  }

  async function stop() {
    if (!thread?.activeTurnId || !runtimeControlAvailable || interrupting) return;
    const threadId = thread.id;
    const turnId = thread.activeTurnId;
    setInterrupting(true);
    setActionError("");
    try {
      await apiClient.interrupt(threadId, turnId);
      setInterruptRequestedTurnId(turnId);
      setActionStatus("turn-interrupted");
      const result = await pollInterruptTerminal(turnId, async () => {
        const projectionGeneration = remoteProjectionRef.current.generation;
        const control = await apiClient.threadShell(threadId);
        if (currentIdRef.current !== threadId) return undefined;
        const current = threadRef.current ?? thread;
        const confirmed = threadControlSnapshotIsCurrent(
          remoteProjectionRef.current,
          control,
          projectionGeneration,
        )
          ? mergeAuthoritativeThreadControl(current, control)
          : current;
        if (confirmed !== current) {
          threadRef.current = confirmed;
          setThread(confirmed);
          onThreadLoaded(confirmed);
        }
        return confirmed.activeTurnId;
      });
      if (currentIdRef.current !== threadId) return;
      setInterruptRequestedTurnId("");
      if (result.state === "still-active") {
        setActionError(
          result.lastError === undefined
            ? "停止请求已受理，但当前回复仍在运行；可再次停止，状态会继续自动同步。"
            : `停止请求已受理，但状态确认失败；可再次停止，状态会继续自动同步：${errorMessage(result.lastError)}`,
        );
      }
    } catch (stopError) {
      setInterruptRequestedTurnId("");
      setActionError(errorMessage(stopError));
    } finally {
      setInterrupting(false);
    }
  }

  async function compactContext() {
    if (compactionAttemptRef.current || compactionRequestFlightRef.current) {
      await compactionRequestFlightRef.current?.promise.catch(() => undefined);
      return;
    }
    const currentThread = threadRef.current;
    if (
      !currentThread ||
      !compactSupported ||
      !canRequestContextCompaction(currentThread, online, compactionRequestState)
    ) {
      return;
    }
    const idempotencyKey = crypto.randomUUID();
    const attempt = contextCompactionAttemptFromThread(currentThread, idempotencyKey);
    compactionAttemptRef.current = attempt;
    setCompactionRequestState("requesting");
    setCompactionNotice("");
    setCompactionError("");
    let flight: ContextCompactionRequestFlight | undefined;
    try {
      flight = beginContextCompactionRequest(
        compactionRequestFlightRef.current,
        (requestKey) => apiClient.compact(currentThread.id, requestKey),
        () => idempotencyKey,
      );
      compactionRequestFlightRef.current = flight;
      await flight.promise;
      if (compactionAttemptRef.current?.idempotencyKey !== idempotencyKey) return;
      setCompactionRequestState("accepted");
      setCompactionNotice("压缩请求已受理，正在等待 Codex 完成");
      void load(true);
    } catch (compactError) {
      const activeAttempt = compactionAttemptRef.current;
      if (activeAttempt?.idempotencyKey !== idempotencyKey) return;
      if (activeAttempt.started) {
        compactionAttemptRef.current = markContextCompactionRecoveryRequired(activeAttempt);
        setCompactionRequestState("accepted");
        setCompactionNotice("连接中断，正在核对 Codex 的压缩状态");
        void load(true);
      } else {
        compactionAttemptRef.current = undefined;
        setCompactionRequestState("idle");
        setCompactionError(errorMessage(compactError));
      }
    } finally {
      if (flight && compactionRequestFlightRef.current === flight) {
        compactionRequestFlightRef.current = undefined;
      }
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
  const running =
    !isSnapshot &&
    (Boolean(thread.activeTurnId) ||
      thread.state === "running" ||
      thread.state === "waiting-for-approval");
  const control = conversationControlState(online, capabilities, isSnapshot);
  const canCompose = canShowThreadComposer(thread, control.available);
  const currentApprovals = filterThreadApprovals(approvals, thread.id, thread.activeTurnId);
  const composerActions = composerActionVisibility(
    Boolean(thread.activeTurnId),
    thread.availableActions.interrupt,
    Boolean(draft.trim()),
    Boolean(thread.activeTurnId && interruptRequestedTurnId === thread.activeTurnId),
    control.available,
  );
  const canCompactNow =
    compactSupported &&
    queue.length === 0 &&
    thread.availableActions.compact !== false &&
    canRequestContextCompaction(thread, online, compactionRequestState);
  const hasComposerTools =
    Boolean(thread.projectId) ||
    composerFeatureSupported(capabilities, "goal") ||
    composerFeatureSupported(capabilities, "plan") ||
    compactSupported;
  const selectedPermission =
    permissionProfiles.find((profile) => profile.id === permissionProfileId) ??
    permissionProfiles[0];
  const selectedPermissionLabel = selectedPermission
    ? permissionProfileLabel(selectedPermission.id)
    : "权限";
  const selectedApprovalPolicyLabel = approvalPolicy
    ? approvalPolicyLabel(approvalPolicy)
    : "沿用设置";
  const selectedReviewerLabel = approvalReviewer ? approvalReviewerLabel(approvalReviewer) : "";
  const selectedCollaborationMode = collaborationModes.find(
    (mode) => mode.id === collaborationMode,
  );
  const selectedCollaborationModeLabel =
    selectedCollaborationMode?.displayName ??
    (collaborationMode ? runtimeOptionLabel(collaborationMode) : "标准");
  const collaborationModeSupported = collaborationModes.some((mode) => mode.available);
  const quota = quotaPresentation(threadUsage, thread.model);
  const currentRuntimeDetails = [
    thread.model ?? "模型由 Codex 决定",
    thread.reasoningEffort ? effortLabel(thread.reasoningEffort) : undefined,
    thread.serviceTier ? serviceTierDisplayLabel(thread.serviceTier) : undefined,
  ].filter(Boolean);
  const currentControlDetails = [
    thread.permissionProfileId ? permissionProfileLabel(thread.permissionProfileId) : undefined,
    thread.approvalPolicy ? approvalPolicyLabel(thread.approvalPolicy) : undefined,
    thread.approvalsReviewer ? approvalReviewerLabel(thread.approvalsReviewer) : undefined,
    thread.collaborationMode
      ? (collaborationModes.find((mode) => mode.id === thread.collaborationMode)?.displayName ??
        runtimeOptionLabel(thread.collaborationMode))
      : undefined,
  ].filter(Boolean);
  const actionStatusCopy = {
    "steer-accepted": "引导已发送到当前回复",
    "turn-interrupted": "停止请求已发送",
    "turn-queued": "已加入下一轮队列",
    "settings-applied":
      settingsUpdateSupported && thread.availableActions.updateSettings !== false
        ? "下一轮设置已同步"
        : "下一轮设置已保存，将在发送时应用",
    "goal-saved": goalDraft.trim() ? "任务目标已保存" : "任务目标已清除",
    "goal-paused": "任务目标已暂停",
    "goal-resumed": "任务目标已继续",
  } as const;
  const snapshotPresentation = desktopSnapshotPresentation(
    thread.parentThreadId,
    thread.snapshotDelaySeconds,
  );
  const composerPlaceholder =
    running && deliveryMode === "queue"
      ? "写下当前回复结束后要做的事…"
      : running
        ? thread.activeTurnId
          ? "引导正在运行的回复…"
          : "正在同步当前回复；文字会保留，也可先排队…"
        : "说明接下来要做什么…";

  function setComposerExpansion(expanded: boolean) {
    composerExpandedRef.current = expanded;
    setComposerExpanded(expanded);
  }

  function expandComposerToEnd() {
    if (composerCollapseTimerRef.current !== undefined) {
      window.clearTimeout(composerCollapseTimerRef.current);
      composerCollapseTimerRef.current = undefined;
    }
    setComposerExpansion(true);
    window.requestAnimationFrame(() => {
      const control = composerTextareaRef.current;
      if (control) focusComposerControlAtEnd(control);
    });
  }

  function collapseComposerAfterBlur(container: HTMLElement) {
    if (composerCollapseTimerRef.current !== undefined) {
      window.clearTimeout(composerCollapseTimerRef.current);
    }
    composerCollapseTimerRef.current = window.setTimeout(() => {
      composerCollapseTimerRef.current = undefined;
      if (!container.contains(document.activeElement)) {
        setComposerExpansion(false);
      }
    }, 0);
  }

  function selectNextModel(modelId: string) {
    const selectedModel = models.find((model) => model.id === modelId);
    setNextTurnSettings((current) =>
      updateNextTurnSettingsDraft(current, {
        model: modelId,
        effort: normalizeReasoningEffortForModel(selectedModel, current.effort),
      }),
    );
    productSettingsGenerationRef.current += 1;
    productSettingsDirtyRef.current = true;
    setServiceTier(null);
  }

  const subagentHistoryNotice = subagentHistoryIntegrityNotice(subagentHistoryIntegrity);
  const persistedHistoryNotice = persistedConversationHistoryNotice({
    historyNextCursor,
    persistedHistoryIntegrity: thread.persistedHistoryIntegrity,
  });

  return (
    <div className="conversation-page" data-testid="thread-view">
      {!appServerReady(capabilities) ? (
        <Notice icon="alert" title="Codex 运行时兼容性待确认">
          对话仍可查看；当前连接不再标记为完全可用。请留意操作报错，系统不会回退到另一套 CLI 后台。
        </Notice>
      ) : null}
      {thread.parentThreadId ? (
        <span className="sr-only" data-testid="subagent-thread">
          子智能体对话
        </span>
      ) : null}
      <header className="conversation-header">
        <div className="conversation-header__main">
          <Button
            aria-label="返回对话列表"
            className="conversation-back"
            icon="arrow-left"
            onClick={() => navigate("/threads")}
            size="icon"
            variant="ghost"
          />
          <div>
            <h1>{threadTitleForDisplay(thread.title)}</h1>
            <span>
              {threadLocationLabelForDisplay(thread)} · {timeAgo(thread.updatedAt)}
            </span>
          </div>
        </div>
        <div className="conversation-header__badges">
          {subagents.length || subagentsError || subagentsNextCursor || subagentHistoryNotice ? (
            <button
              className="subagents-trigger"
              data-testid="subagents-open"
              onClick={() => setShowAgents(true)}
            >
              <Icon name="layers" size={15} />
              <span>{subagents.length}</span>
            </button>
          ) : null}
          <UsageOrb
            buttonRef={usageButtonRef}
            onClick={toggleUsageDetails}
            open={showUsage}
            refreshing={usageRefreshState === "refreshing"}
            usage={threadUsage}
          />
          <StatusPill tone={isSnapshot ? "info" : runTones[thread.state]}>
            {isSnapshot ? snapshotPresentation.statusLabel : runLabels[thread.state]}
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
        <section
          aria-label="额度、上下文与当前运行参数"
          className="conversation-usage-panel"
          data-testid="usage-panel"
          id="conversation-usage-panel"
          ref={usagePanelRef}
        >
          <div className="conversation-usage-panel__header">
            <div>
              <strong>额度与上下文</strong>
              <small>数据来自当前 Codex 运行时</small>
            </div>
            <div className="conversation-usage-panel__actions">
              <button
                aria-label="立即刷新额度"
                disabled={usageRefreshState === "refreshing"}
                onClick={() => void refreshUsageDetails()}
                type="button"
              >
                <Icon
                  name={usageRefreshState === "refreshing" ? "activity" : "refresh"}
                  size={16}
                />
              </button>
              <button aria-label="关闭额度面板" onClick={() => setShowUsage(false)} type="button">
                <Icon name="close" size={16} />
              </button>
            </div>
          </div>
          {usageRefreshError ? (
            <div className="conversation-usage-error" role="alert">
              <Icon name="alert" size={15} />
              刷新失败：{usageRefreshError}
            </div>
          ) : null}
          {quota.message && quota.state !== "unknown" ? (
            <div
              className={`conversation-quota-state conversation-quota-state--${quota.state}`}
              role={quota.state === "exhausted" ? "alert" : "status"}
            >
              <Icon name={quota.state === "exhausted" ? "alert" : "activity"} size={15} />
              {quota.message}
            </div>
          ) : null}
          <dl className="conversation-usage-meta">
            <div>
              <dt>实时刷新</dt>
              <dd>
                {threadUsage?.updatedAt
                  ? formatUtc8Time(threadUsage.updatedAt)
                  : "尚未取得额度快照"}
              </dd>
            </div>
            <div>
              <dt>对话 ID</dt>
              <dd>
                <code data-testid="thread-id">{thread.id}</code>
                <button aria-label="复制对话 ID" onClick={() => void copyThreadId()} type="button">
                  <Icon name={threadIdCopyState === "copied" ? "check" : "copy"} size={14} />
                  {threadIdCopyState === "copied"
                    ? "已复制"
                    : threadIdCopyState === "error"
                      ? "复制失败"
                      : "复制"}
                </button>
              </dd>
            </div>
            <div>
              <dt>当前模型</dt>
              <dd>{currentRuntimeDetails.join(" · ")}</dd>
            </div>
            <div>
              <dt>权限与模式</dt>
              <dd>{currentControlDetails.join(" · ") || "沿用 Codex 当前设置"}</dd>
            </div>
          </dl>
          <div className="conversation-usage-windows" data-testid="usage-window">
            {threadUsage ? (
              threadUsage.windows.map((window) => (
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
                      ? `${formatUtc8Time(window.resetsAt)} 重置`
                      : "重置时间暂时无法读取"}
                  </small>
                </div>
              ))
            ) : (
              <div className="mini-empty" data-testid="usage-unavailable">
                额度暂时无法读取
              </div>
            )}
            <div className="conversation-usage-window conversation-usage-window--context">
              <span>当前上下文</span>
              <Progress
                label="当前线程上下文使用量"
                tone={(threadUsage?.context?.usedPercent ?? 0) > 80 ? "warning" : "success"}
                value={threadUsage?.context?.usedPercent}
              />
              <small>
                {threadUsage?.context?.usedTokens !== undefined &&
                threadUsage.context.limitTokens !== undefined
                  ? `${number(threadUsage.context.usedTokens)} / ${number(threadUsage.context.limitTokens)} tokens`
                  : "token 用量暂时无法读取"}
                {" · "}
                {usedPercentLabel(threadUsage?.context?.usedPercent)}
                {" · "}
                {remainingContextPercentLabel(
                  remainingFromUsedPercent(threadUsage?.context?.usedPercent),
                )}
              </small>
              {compactSupported && thread.mode === "managed" && !thread.parentThreadId ? (
                <div className="context-compaction-actions">
                  <button
                    className="context-compaction-button"
                    data-testid="context-compact"
                    disabled={!canRequestContextCompaction(thread, online, compactionRequestState)}
                    onClick={() => void compactContext()}
                    type="button"
                  >
                    <Icon
                      name={compactionRequestState === "idle" ? "spark" : "activity"}
                      size={16}
                    />
                    {compactionRequestState === "requesting"
                      ? "正在发送…"
                      : compactionRequestState === "accepted"
                        ? "正在压缩…"
                        : "压缩上下文"}
                  </button>
                  {compactionNotice ? (
                    <small aria-live="polite" data-testid="context-compact-status">
                      {compactionNotice}
                    </small>
                  ) : null}
                  {compactionError ? (
                    <small
                      aria-live="assertive"
                      className="context-compaction-error"
                      data-testid="context-compact-error"
                    >
                      {compactionError}
                    </small>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="conversation-usage-window conversation-usage-window--credits">
              <span>{threadUsage?.plan ? `套餐 · ${threadUsage.plan}` : "账户额度"}</span>
              <CreditsList compact credits={threadUsage?.credits} />
            </div>
          </div>
        </section>
      ) : null}
      {isSnapshot ? (
        <Notice
          action={
            snapshotPresentation.resumable ? (
              <Button
                data-testid="resume-desktop-thread"
                disabled={!runtimeControlAvailable || resumeBusy}
                onClick={() => void resumeHistoryThread()}
                size="compact"
                variant="primary"
              >
                {resumeBusy ? "正在接入…" : "接入 Desktop 并继续"}
              </Button>
            ) : undefined
          }
          icon={thread.parentThreadId ? "layers" : "clock"}
          title={snapshotPresentation.title}
          tone="info"
        >
          {snapshotPresentation.description}
          {snapshotPresentation.resumable && !runtimeControlAvailable
            ? ` ${conversationControlState(online, capabilities, false).reason}。`
            : ""}
        </Notice>
      ) : null}
      {isSnapshot && actionError ? (
        <Notice icon="alert" title="未能接入 Desktop" tone="danger">
          {actionError}
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
      {runtimeNotice ? (
        <Notice
          icon={runtimeNotice.category === "quota" ? "alert" : "activity"}
          title={runtimeNotice.category === "quota" ? "额度不足" : "Codex 运行提示"}
          tone={runtimeNotice.tone}
        >
          {runtimeNotice.message}
        </Notice>
      ) : null}
      <InlineDecisionStack approvals={currentApprovals} onOpen={onOpenApproval} />
      <div
        className="conversation-scroll"
        onKeyDown={(event) => {
          if (
            event.key === "ArrowDown" ||
            event.key === "ArrowUp" ||
            event.key === "End" ||
            event.key === "Home" ||
            event.key === "PageDown" ||
            event.key === "PageUp" ||
            event.key === " "
          ) {
            markConversationUserScrollIntent();
          }
        }}
        onPointerDown={markConversationUserScrollIntent}
        onScroll={updateConversationPosition}
        onTouchMove={markConversationUserScrollIntent}
        onWheel={markConversationUserScrollIntent}
        ref={conversationScrollRef}
      >
        <div className="conversation-stream" ref={conversationStreamRef}>
          {shouldShowConversationLoading(detailProjectionReady, visibleItems.length) ? (
            <div
              aria-live="polite"
              className="conversation-loading"
              data-testid="conversation-loading"
              role="status"
            >
              <Icon name="activity" size={17} />
              <div>
                <strong>正在加载最近对话</strong>
                <span>输入框已经可用；较长的历史任务会继续在后台载入。</span>
              </div>
            </div>
          ) : null}
          {persistedHistoryNotice ? (
            <div
              aria-label="对话历史完整性"
              aria-live="polite"
              className="mini-empty"
              data-testid="persisted-history-integrity"
              role="status"
            >
              {persistedHistoryNotice}
            </div>
          ) : null}
          {hiddenItemCount > 0 || historyNextCursor ? (
            <button
              className="conversation-history-more"
              data-testid="conversation-history-more"
              disabled={historyMoreState === "loading"}
              onClick={revealEarlierConversationItems}
              type="button"
            >
              <Icon name="clock" size={16} />
              {historyMoreState === "loading"
                ? "正在向上加载更早记录…"
                : historyMoreState === "error"
                  ? "加载失败，点此重试"
                  : hiddenItemCount > 0
                    ? `显示更早内容（还有 ${hiddenItemCount} 项）`
                    : "向上加载更早记录"}
            </button>
          ) : null}
          <ConversationItems
            {...(thread.activeTurnId === undefined ? {} : { activeTurnId: thread.activeTurnId })}
            apiClient={apiClient}
            items={visibleItems}
            key={presentationIdentity}
            online={online}
            presentationIdentity={presentationIdentity}
            {...(thread.projectId === undefined ? {} : { projectId: thread.projectId })}
            showLivePhase={!isSnapshot && thread.state === "running"}
            subagents={subagents}
          />
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
        <div
          className={`composer-shell${composerExpanded ? "" : " composer-shell--collapsed"}${
            composerActions.showInterrupt ? " composer-shell--primary-interrupt" : ""
          }${online ? "" : " composer-shell--offline"}`}
          onBlurCapture={(event) => {
            collapseComposerAfterBlur(event.currentTarget);
          }}
          ref={composerShellRef}
        >
          <QueueShelf
            busyId={queueBusyId}
            canSteer={Boolean(running && thread.activeTurnId && thread.availableActions.steer)}
            items={queue}
            onDelete={(item) => void deleteQueued(item)}
            onDispatch={(item) => void dispatchQueued(item)}
            onMove={(item, offset) => void moveQueued(item, offset)}
            onSteer={(item) => void steerQueued(item)}
            onUpdate={(item, prompt) => void updateQueuedPrompt(item, prompt)}
            running={running}
          />
          {queueError ? (
            <div className="composer-error" role="alert">
              <Icon name="alert" size={16} />
              {queueError}
            </div>
          ) : null}
          {actionStatus ? (
            <div aria-live="polite" className="action-status" data-testid={actionStatus}>
              <Icon name="check" size={15} />
              {actionStatusCopy[actionStatus]}
            </div>
          ) : null}
          {actionError ? (
            <div className="composer-error">
              <Icon name="alert" size={16} />
              {actionError}
            </div>
          ) : null}
          <div className="composer">
            {running || composerPlan || collaborationModeSupported || threadGoal ? (
              <div className="composer__context-bar">
                {running ? (
                  <DeliveryModeSwitch
                    mode={deliveryMode}
                    onChange={setDeliveryMode}
                    queueSupported={queueSupported}
                  />
                ) : null}
                {collaborationModeSupported ? (
                  <button
                    className="composer-mode-button"
                    data-testid="composer-mode-open"
                    onClick={() => setComposerSheet("plan")}
                    type="button"
                  >
                    <Icon name="target" size={15} />
                    <span>{selectedCollaborationModeLabel}</span>
                    <Icon name="chevron-right" size={14} />
                  </button>
                ) : null}
                {threadGoal ? (
                  <button
                    className="composer-goal-button"
                    data-testid="composer-goal-open"
                    onClick={() => setComposerSheet("goal")}
                    title={threadGoal.objective}
                    type="button"
                  >
                    <Icon name="target" size={15} />
                    <span>{threadGoal.objective}</span>
                    <small>
                      {threadGoal.status === "active"
                        ? "进行中"
                        : runtimeOptionLabel(threadGoal.status)}
                    </small>
                  </button>
                ) : null}
                {composerPlan ? <PlanProgressControl plan={composerPlan} /> : null}
              </div>
            ) : null}
            <textarea
              aria-label={
                running && deliveryMode === "queue" ? "排队到下一轮" : running ? "追加要求" : "回复"
              }
              data-testid="turn-composer"
              onFocus={() => {
                if (!composerExpandedRef.current && !composerPointerActiveRef.current) {
                  expandComposerToEnd();
                }
              }}
              onClick={() => {
                if (!composerExpandedRef.current) expandComposerToEnd();
              }}
              onChange={(event) => {
                setDraftCopyState("idle");
                setDraft(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void submit();
              }}
              onPointerDown={() => {
                composerPointerActiveRef.current = true;
              }}
              onPointerUp={() => {
                composerPointerActiveRef.current = false;
              }}
              onPointerCancel={() => {
                composerPointerActiveRef.current = false;
              }}
              placeholder={composerPlaceholder}
              readOnly={composerDraftReadOnly(composerExpanded, online)}
              ref={composerTextareaRef}
              rows={2}
              value={composerExpanded ? draft : collapsedComposerText(draft)}
            />
            <AttachmentChips
              attachments={attachments}
              onRemove={(reference) =>
                setAttachments((current) =>
                  current.filter(
                    (item) => attachmentReferenceKey(item) !== attachmentReferenceKey(reference),
                  ),
                )
              }
            />
            <div className="composer__footer">
              {hasComposerTools ? (
                <Button
                  aria-label="打开对话工具"
                  data-testid="composer-tools-open"
                  icon="plus"
                  onClick={() => setComposerSheet("tools")}
                  size="icon"
                  variant="ghost"
                />
              ) : null}
              <Button
                aria-label={
                  draftCopyState === "copied"
                    ? "输入框内容已复制"
                    : draftCopyState === "error"
                      ? "输入框内容复制失败"
                      : "复制输入框内容"
                }
                data-copy-state={draftCopyState}
                data-testid="draft-copy"
                disabled={!draft}
                icon={draftCopyState === "copied" ? "check" : "copy"}
                onClick={() => void copyDraft()}
                size="icon"
                title={
                  draftCopyState === "copied"
                    ? "已复制"
                    : draftCopyState === "error"
                      ? "复制失败"
                      : "复制输入框内容"
                }
                variant="ghost"
              />
              <ComposerSettingsButton
                disabled={
                  !thread.availableActions.changeModelNextTurn &&
                  !(settingsUpdateSupported && thread.availableActions.updateSettings !== false)
                }
                effort={nextTurnSettings.effort}
                model={nextTurnSettings.model}
                models={models}
                onEffort={(effort) =>
                  setNextTurnSettings((current) => updateNextTurnSettingsDraft(current, { effort }))
                }
                onModel={selectNextModel}
                onOpen={() => setComposerSheet("settings")}
                serviceTier={serviceTiersSupported ? serviceTier : null}
                serviceTiersSupported={serviceTiersSupported}
              />
              {permissionProfilesSupported ||
              approvalPoliciesSupported ||
              approvalReviewersSupported ? (
                <PermissionButton
                  label={[
                    selectedPermissionLabel,
                    selectedApprovalPolicyLabel,
                    selectedReviewerLabel,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  onOpen={() => setComposerSheet("permission")}
                />
              ) : null}
              <div className="composer__actions">
                {composerActions.showInterrupt ? (
                  <Button
                    aria-label="停止当前工作"
                    data-testid="turn-interrupt"
                    disabled={!online || interrupting}
                    icon="stop"
                    onClick={() => void stop()}
                    size="icon"
                    variant="danger"
                  />
                ) : null}
                {composerActions.showSubmit ? (
                  <Button
                    aria-label={
                      running && deliveryMode === "queue"
                        ? "加入下一轮队列"
                        : running
                          ? thread.activeTurnId
                            ? "发送补充要求"
                            : "同步状态并发送"
                          : "发送"
                    }
                    data-testid={running ? "turn-steer-submit" : "turn-reply-submit"}
                    disabled={
                      !draft.trim() || !online || !control.available || sending || interrupting
                    }
                    icon="send"
                    onClick={() => void submit()}
                    size="icon"
                    variant="primary"
                  />
                ) : null}
              </div>
            </div>
          </div>
          {running && deliveryMode !== "queue" && !thread.activeTurnId ? null : (
            <small className="next-turn-hint" data-testid="next-turn-model-notice">
              {running
                ? deliveryMode === "queue"
                  ? "这条消息会进入网页下一轮队列；Desktop 会在真正发送后显示，模型、思考、速度与权限随消息保存"
                  : "正在引导当前回复；设置按钮中的选择只会在下一轮生效"
                : "模型、思考、速度与权限只应用于下一轮 · Ctrl + Enter 发送"}
            </small>
          )}
        </div>
      ) : !isSnapshot && !thread.parentThreadId && !control.available ? (
        <div className="read-only-handoff" data-testid="runtime-control-unavailable">
          <Icon name={online ? "alert" : "wifi-off"} size={19} />
          <span>
            <strong>当前只能查看</strong>
            <small>{control.reason}。恢复后输入、停止和设置会自动重新出现。</small>
          </span>
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
      <ComposerSettingsSheet
        busy={settingsBusy}
        demo={apiClient.demo}
        effort={nextTurnSettings.effort}
        model={nextTurnSettings.model}
        models={models}
        onApply={() =>
          void persistNextTurnSettings({
            ...(serviceTiersSupported ? { serviceTier } : {}),
          })
        }
        onClose={() => setComposerSheet("")}
        onEffort={(effort) =>
          setNextTurnSettings((current) => updateNextTurnSettingsDraft(current, { effort }))
        }
        onModel={selectNextModel}
        onServiceTier={(tier) => {
          productSettingsGenerationRef.current += 1;
          productSettingsDirtyRef.current = true;
          setServiceTier(tier);
        }}
        open={composerSheet === "settings"}
        serviceTier={serviceTiersSupported ? serviceTier : null}
        serviceTiersSupported={serviceTiersSupported}
      />
      <AccessAndReviewerSheet
        approvalPolicy={approvalPolicy}
        approvalPolicies={approvalPoliciesSupported ? approvalPolicies : []}
        approvalReviewer={approvalReviewer}
        approvalReviewers={approvalReviewersSupported ? approvalReviewers : []}
        busy={settingsBusy}
        onApply={() =>
          void persistNextTurnSettings({
            ...(permissionProfilesSupported ? { permissionProfileId } : {}),
            ...(approvalPoliciesSupported ? { approvalPolicy } : {}),
            ...(approvalReviewersSupported ? { approvalsReviewer: approvalReviewer } : {}),
          })
        }
        onApprovalPolicy={(policy) => {
          productSettingsGenerationRef.current += 1;
          productSettingsDirtyRef.current = true;
          setApprovalPolicy(policy);
        }}
        onApprovalReviewer={(reviewer) => {
          productSettingsGenerationRef.current += 1;
          productSettingsDirtyRef.current = true;
          setApprovalReviewer(reviewer);
        }}
        onClose={() => setComposerSheet("")}
        onPermission={(profileId) => {
          productSettingsGenerationRef.current += 1;
          productSettingsDirtyRef.current = true;
          setPermissionProfileId(profileId);
        }}
        open={composerSheet === "permission"}
        permissionProfileId={permissionProfileId}
        permissionProfiles={permissionProfilesSupported ? permissionProfiles : []}
      />
      <ComposerToolsSheet
        canAttach
        canCompact={canCompactNow}
        capabilities={capabilities as ComposerCapabilities}
        collaborationModes={collaborationModes}
        onClose={() => setComposerSheet("")}
        onAttach={() => setComposerSheet("attachments")}
        onCompact={() => {
          setComposerSheet("");
          void compactContext();
        }}
        onGoal={() => setComposerSheet("goal")}
        onPlan={() => setComposerSheet("plan")}
        open={composerSheet === "tools"}
      />
      <AttachmentPickerSheet
        apiClient={apiClient}
        onApply={setAttachments}
        onClose={() => setComposerSheet("")}
        online={online}
        open={composerSheet === "attachments"}
        projectId={thread.projectId ?? ""}
        selected={attachments}
      />
      <GoalSheet
        busy={goalBusy}
        hasGoal={Boolean(threadGoal)}
        onChange={setGoalDraft}
        onClear={() => void clearGoal()}
        onClose={() => setComposerSheet("")}
        onSave={() => void saveGoal()}
        onStatusChange={(status) => void setGoalStatus(status)}
        open={composerSheet === "goal"}
        {...(threadGoal?.status === undefined ? {} : { status: threadGoal.status })}
        value={goalDraft}
      />
      <PlanModeSheet
        modes={collaborationModes}
        onChange={(mode) => {
          productSettingsGenerationRef.current += 1;
          productSettingsDirtyRef.current = true;
          collaborationModeDirtyRef.current = true;
          setCollaborationMode(mode);
          void persistNextTurnSettings({ collaborationMode: mode });
        }}
        onClose={() => setComposerSheet("")}
        open={composerSheet === "plan"}
        value={collaborationMode}
      />
      <Sheet
        description="已完成的子智能体也会保留在这里。进入后可查看它的消息、工具与文件变更。"
        onClose={() => setShowAgents(false)}
        open={showAgents}
        title={`子智能体 · ${subagents.length}`}
      >
        {subagentHistoryNotice ? (
          <div className="mini-empty" data-testid="subagent-history-integrity" role="status">
            {subagentHistoryNotice}
          </div>
        ) : null}
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
          completeLabel={subagentHistoryPaginationCompleteLabel(subagentHistoryIntegrity)}
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
  capabilities,
  apiClient,
  online,
}: {
  projects: ProjectSummary[];
  models: ModelOption[];
  collaborationModes: CollaborationModeOption[];
  capabilities: ComposerCapabilities | undefined;
  apiClient: ApiClient;
  online: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { copy } = useUiLocale();
  const selectableProjects = registeredProjects(projects);
  const requestedProject = new URLSearchParams(location.search).get("project");
  const recoveredDraft = readNewThreadDraft(window.localStorage);
  const initialProject = initialNewThreadProject(
    selectableProjects.map((project) => project.id),
    requestedProject,
    recoveredDraft?.projectId,
  );
  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  const [projectId, setProjectId] = useState(initialProject);
  const [prompt, setPrompt] = useState(recoveredDraft?.prompt ?? "");
  const [attachments, setAttachments] = useState<LocalInputReference[]>([]);
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
  const [draftPersistence, setDraftPersistence] = useState<"saved" | "unavailable">("saved");
  const [model, setModel] = useState(defaultModel?.id ?? "");
  const [effort, setEffort] = useState<ReasoningEffort | undefined>(
    defaultReasoningEffortForModel(defaultModel),
  );
  const permissionProfilesAvailable = composerFeatureSupported(capabilities, "permissionProfiles");
  const approvalPoliciesAvailable = capabilities?.approvalPolicies === "available";
  const approvalReviewersAvailable = capabilities?.approvalReviewers === "available";
  const serviceTiersAvailable = composerFeatureSupported(capabilities, "serviceTiers");
  const runtimeAvailable = appServerReady(capabilities);
  const [permissionProfiles, setPermissionProfiles] = useState<PermissionProfileOption[]>([]);
  const [permissionProfileId, setPermissionProfileId] = useState<string>();
  const [permissionState, setPermissionState] = useState<
    "unavailable" | "loading" | "ready" | "error"
  >(permissionProfilesAvailable ? "loading" : "unavailable");
  const [permissionError, setPermissionError] = useState("");
  const [approvalPolicies, setApprovalPolicies] = useState<ApprovalPolicyOption[]>([]);
  const [approvalPolicy, setApprovalPolicy] = useState("");
  const [approvalPolicyState, setApprovalPolicyState] = useState<
    "unavailable" | "loading" | "ready" | "error"
  >(approvalPoliciesAvailable ? "loading" : "unavailable");
  const [approvalReviewers, setApprovalReviewers] = useState<ApprovalReviewerOption[]>([]);
  const [approvalReviewer, setApprovalReviewer] = useState("");
  const [approvalReviewerState, setApprovalReviewerState] = useState<
    "unavailable" | "loading" | "ready" | "error"
  >(approvalReviewersAvailable ? "loading" : "unavailable");
  const [serviceTier, setServiceTier] = useState<string | undefined>(
    serviceTiersAvailable ? chooseServiceTier(defaultModel) : undefined,
  );
  const [collaboration, setCollaboration] = useState(
    chooseCollaborationMode(collaborationModes) ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedModel = models.find((option) => option.id === model) ?? models[0];
  const tierOptions = serviceTiersAvailable ? serviceTierOptions(selectedModel) : [];
  const permissionReady =
    !permissionProfilesAvailable ||
    (permissionState === "ready" &&
      permissionProfiles.some((profile) => profile.id === permissionProfileId && profile.allowed));

  useEffect(() => {
    setDraftPersistence(
      writeNewThreadDraft(window.localStorage, { prompt, projectId }) ? "saved" : "unavailable",
    );
  }, [projectId, prompt]);

  useEffect(() => {
    if (!permissionProfilesAvailable) {
      setPermissionProfiles([]);
      setPermissionProfileId(undefined);
      setPermissionState("unavailable");
      setPermissionError("");
      return;
    }

    let cancelled = false;
    setPermissionState("loading");
    setPermissionError("");
    void apiClient
      .permissionProfiles(projectId ? { projectId } : {})
      .then((profiles) => {
        if (cancelled) return;
        const nextProfileId = choosePermissionProfileId(profiles);
        setPermissionProfiles(profiles);
        setPermissionProfileId(nextProfileId);
        if (!nextProfileId) {
          setPermissionState("error");
          setPermissionError("Codex 当前没有返回可用的权限配置，已阻止用猜测值开始任务。");
          return;
        }
        setPermissionState("ready");
      })
      .catch((profileError) => {
        if (cancelled) return;
        setPermissionProfiles([]);
        setPermissionProfileId(undefined);
        setPermissionState("error");
        setPermissionError(`无法读取 Codex 的权限配置：${errorMessage(profileError)}`);
      });

    return () => {
      cancelled = true;
    };
  }, [apiClient, permissionProfilesAvailable, projectId]);

  useEffect(() => {
    if (!approvalPoliciesAvailable) {
      setApprovalPolicies([]);
      setApprovalPolicy("");
      setApprovalPolicyState("unavailable");
      return;
    }
    let cancelled = false;
    setApprovalPolicyState("loading");
    void apiClient
      .approvalPolicies()
      .then((policies) => {
        if (cancelled) return;
        const selected = chooseApprovalPolicy(policies);
        setApprovalPolicies(policies);
        setApprovalPolicy(selected);
        setApprovalPolicyState(selected ? "ready" : "error");
      })
      .catch(() => {
        if (cancelled) return;
        setApprovalPolicies([]);
        setApprovalPolicy("");
        setApprovalPolicyState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, approvalPoliciesAvailable]);

  useEffect(() => {
    if (!approvalReviewersAvailable) {
      setApprovalReviewers([]);
      setApprovalReviewer("");
      setApprovalReviewerState("unavailable");
      return;
    }
    let cancelled = false;
    setApprovalReviewerState("loading");
    void apiClient
      .approvalReviewers()
      .then((reviewers) => {
        if (cancelled) return;
        const selected = chooseApprovalReviewer(reviewers);
        setApprovalReviewers(reviewers);
        setApprovalReviewer(selected);
        setApprovalReviewerState(selected ? "ready" : "error");
      })
      .catch(() => {
        if (cancelled) return;
        setApprovalReviewers([]);
        setApprovalReviewer("");
        setApprovalReviewerState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, approvalReviewersAvailable]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || !permissionReady || !runtimeAvailable) return;
    setBusy(true);
    setError("");
    try {
      const runtimeSettings = newThreadRuntimeSettings({
        models,
        modelId: model,
        reasoningEffort: effort,
        permissionProfilesAvailable,
        permissionProfiles,
        permissionProfileId,
        serviceTiersAvailable,
        serviceTier,
        collaborationModes,
        collaborationMode: collaboration,
      });
      const created = await apiClient.createThread({
        prompt: prompt.trim(),
        ...(projectId ? { projectId } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...runtimeSettings,
        ...(approvalPolicyState === "ready" && approvalPolicy ? { approvalPolicy } : {}),
        ...(approvalReviewerState === "ready" && approvalReviewer
          ? { approvalsReviewer: approvalReviewer }
          : {}),
      });
      clearNewThreadDraft(window.localStorage);
      void navigate(`/threads/${created.id}`, {
        replace: true,
        state: threadNavigationState(created, prompt.trim()),
      });
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <MobileHeader back title={copy.newConversation} />
      <div className="page new-thread-page">
        <div className="page-heading">
          <h1>{copy.startNewTask}</h1>
          <p>{copy.startNewTaskDescription}</p>
        </div>
        {!runtimeAvailable ? (
          <Notice icon="alert" title="暂时不能开始新任务">
            Codex Desktop
            运行时正在启动、刚刚更新，或兼容性状态无法确认。现有对话不会被中断；完成热更新确认后这里会自动恢复。
          </Notice>
        ) : null}
        <form data-testid="new-thread-form" onSubmit={(event) => void submit(event)}>
          <section className="form-section">
            <div className="form-section__title">
              <span>1</span>
              <div>
                <h2>{copy.chooseLocation}</h2>
                <p>{copy.fixedProjectBoundary}</p>
              </div>
            </div>
            <div className="project-choice-grid">
              <label
                className={`project-choice--general ${projectId === "" ? "is-selected" : ""}`}
                data-testid="general-conversation-option"
              >
                <input
                  checked={projectId === ""}
                  name="project"
                  onChange={() => {
                    setProjectId("");
                    setAttachments([]);
                  }}
                  type="radio"
                />
                <span className="project-icon">
                  <Icon name="message" size={20} />
                </span>
                <span>
                  <strong>{copy.noProject}</strong>
                  <small>{copy.noProjectDescription}</small>
                </span>
                <Icon name="check" size={18} />
              </label>
              {selectableProjects.map((project) => (
                <label
                  className={projectId === project.id ? "is-selected" : ""}
                  data-testid="project-option"
                  key={project.id}
                >
                  <input
                    checked={projectId === project.id}
                    name="project"
                    onChange={() => {
                      setProjectId(project.id);
                      setAttachments([]);
                    }}
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
            {selectableProjects.length === 0 ? (
              <Notice icon="folder" title="还没有已登记项目">
                仍可开始无项目对话；项目目录只能在电脑本机登记。
              </Notice>
            ) : null}
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
            <div className="prompt-attachments">
              <Button
                icon="paperclip"
                onClick={() => setAttachmentPickerOpen(true)}
                size="compact"
                type="button"
                variant="ghost"
              >
                添加文件
              </Button>
              <AttachmentChips
                attachments={attachments}
                onRemove={(reference) =>
                  setAttachments((current) =>
                    current.filter(
                      (item) => attachmentReferenceKey(item) !== attachmentReferenceKey(reference),
                    ),
                  )
                }
              />
            </div>
            <span className="character-count" data-testid="new-thread-draft-status">
              {prompt.length} 字
              {prompt
                ? draftPersistence === "saved"
                  ? " · 草稿已自动保存"
                  : " · 此浏览器无法保存草稿"
                : ""}
            </span>
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
              onModel={(nextModelId) => {
                setModel(nextModelId);
                setServiceTier(undefined);
              }}
            />
            {serviceTiersAvailable ? (
              <label className="select-label">
                <span>速度</span>
                <select
                  aria-label="新建对话速度"
                  data-testid="new-thread-service-tier"
                  onChange={(event) => setServiceTier(event.target.value || undefined)}
                  value={chooseServiceTier(selectedModel, serviceTier) ?? ""}
                >
                  <option value="">{CODEX_DEFAULT_SERVICE_TIER.label}</option>
                  {tierOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <small>
                  {serviceTier
                    ? (tierOptions.find((option) => option.id === serviceTier)?.description ??
                      "使用 Codex 当前提供的额外速度档")
                    : CODEX_DEFAULT_SERVICE_TIER.description}
                </small>
              </label>
            ) : null}
            {permissionProfilesAvailable ? (
              <fieldset className="permission-fieldset">
                <legend>文件与命令权限</legend>
                {permissionState === "loading" ? (
                  <div className="dynamic-options-status">正在读取 Codex 的可用权限…</div>
                ) : null}
                {permissionState === "error" ? (
                  <Notice icon="alert" title="权限配置不可用">
                    {permissionError}
                  </Notice>
                ) : null}
                {permissionState === "ready" ? (
                  <div className="option-grid">
                    {permissionProfiles.map((profile) => (
                      <label
                        className={permissionProfileId === profile.id ? "is-selected" : ""}
                        key={profile.id}
                      >
                        <input
                          checked={permissionProfileId === profile.id}
                          disabled={!profile.allowed}
                          name="permission-profile"
                          onChange={() => setPermissionProfileId(profile.id)}
                          type="radio"
                        />
                        <Icon name="shield" size={20} />
                        <span>
                          <strong>{permissionProfileLabel(profile.id)}</strong>
                          <small>
                            {profile.description ??
                              (profile.allowed ? "Codex 当前允许使用" : "Codex 当前不允许使用")}
                          </small>
                        </span>
                        <i>
                          <Icon name="check" size={14} />
                        </i>
                      </label>
                    ))}
                  </div>
                ) : null}
              </fieldset>
            ) : (
              <Notice icon="shield" title="当前运行时未公开权限配置">
                不发送任何猜测的权限值，由 Codex 使用它自己的安全默认值。
              </Notice>
            )}
            {approvalPoliciesAvailable ? (
              approvalPolicyState === "ready" ? (
                <label className="select-label">
                  <span>何时询问我</span>
                  <select
                    data-testid="new-thread-approval-policy"
                    onChange={(event) => setApprovalPolicy(event.target.value)}
                    value={approvalPolicy}
                  >
                    {approvalPolicies.map((policy) => (
                      <option key={policy.id} value={policy.id}>
                        {approvalPolicyLabel(policy.id)}
                      </option>
                    ))}
                  </select>
                  <small>{approvalPolicyDescription(approvalPolicy)}</small>
                </label>
              ) : (
                <Notice icon="shield" title="确认策略暂不可选">
                  {approvalPolicyState === "loading"
                    ? "正在读取当前 Codex 的确认策略…"
                    : "Codex 没有返回可安全发送的策略，将沿用它自己的当前设置。"}
                </Notice>
              )
            ) : null}
            {approvalReviewersAvailable ? (
              approvalReviewerState === "ready" ? (
                <label className="select-label">
                  <span>谁来确认</span>
                  <select
                    data-testid="new-thread-approval-reviewer"
                    onChange={(event) => setApprovalReviewer(event.target.value)}
                    value={approvalReviewer}
                  >
                    {approvalReviewers.map((reviewer) => (
                      <option key={reviewer.id} value={reviewer.id}>
                        {approvalReviewerLabel(reviewer.id)}
                      </option>
                    ))}
                  </select>
                  <small>{approvalReviewerDescription(approvalReviewer)}</small>
                </label>
              ) : (
                <Notice icon="shield" title="审批方式暂不可选">
                  {approvalReviewerState === "loading"
                    ? "正在读取 Codex 的可用审批方式…"
                    : "Codex 没有返回可选目录，将沿用它自己的当前设置。"}
                </Notice>
              )
            ) : null}
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
                  (collaborationModes.some((mode) => mode.available)
                    ? "选项来自当前 Codex 运行时"
                    : "当前服务未提供协作模式")}
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
              disabled={busy || !prompt.trim() || !permissionReady || !runtimeAvailable}
              icon="play"
              type="submit"
              variant="primary"
            >
              {busy ? "正在开始…" : "开始任务"}
            </Button>
          </div>
        </form>
        <AttachmentPickerSheet
          apiClient={apiClient}
          onApply={setAttachments}
          onClose={() => setAttachmentPickerOpen(false)}
          online={online}
          open={attachmentPickerOpen}
          projectId={projectId}
          selected={attachments}
        />
      </div>
    </>
  );
}

function attachmentReferenceKey(reference: LocalInputReference): string {
  return `${reference.projectId ?? reference.uploadId}:${reference.kind}:${reference.relativePath.toLocaleLowerCase("en-US")}`;
}

function attachmentName(reference: LocalInputReference): string {
  return reference.relativePath.split("/").filter(Boolean).at(-1) ?? reference.relativePath;
}

function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: readonly LocalInputReference[];
  onRemove: (reference: LocalInputReference) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="attachment-chips" aria-label="已添加的文件和文件夹">
      {attachments.map((reference) => (
        <span className="attachment-chip" key={attachmentReferenceKey(reference)}>
          <Icon name={reference.kind === "directory" ? "folder" : "file"} size={14} />
          <span>{attachmentName(reference)}</span>
          <button
            aria-label={`移除 ${attachmentName(reference)}`}
            onClick={() => onRemove(reference)}
            type="button"
          >
            <Icon name="close" size={13} />
          </button>
        </span>
      ))}
    </div>
  );
}

function AttachmentPickerSheet({
  apiClient,
  onApply,
  onClose,
  online,
  open,
  projectId,
  selected,
}: {
  apiClient: ApiClient;
  onApply: (attachments: LocalInputReference[]) => void;
  onClose: () => void;
  online: boolean;
  open: boolean;
  projectId: string;
  selected: readonly LocalInputReference[];
}) {
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<FileListing>();
  const [draft, setDraft] = useState<LocalInputReference[]>([]);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number }>();

  useEffect(() => {
    if (!open) return;
    setPath("");
    setQuery("");
    setDraft(
      selected.filter(
        (reference) => reference.uploadId !== undefined || reference.projectId === projectId,
      ),
    );
    setUploadProgress(undefined);
  }, [open, projectId, selected]);

  useEffect(() => {
    if (!open || !online || !projectId) return;
    let active = true;
    setState("loading");
    setError("");
    void apiClient
      .files(projectId, path)
      .then((next) => {
        if (!active) return;
        setListing(next);
        setState("ready");
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setState("error");
        setError(errorMessage(loadError));
      });
    return () => {
      active = false;
    };
  }, [apiClient, online, open, path, projectId]);

  const parts = path.split("/").filter(Boolean);
  const visibleEntries = (listing?.entries ?? []).filter((entry) =>
    entry.name.toLocaleLowerCase("zh-CN").includes(query.toLocaleLowerCase("zh-CN")),
  );
  const selectedKeys = new Set(draft.map(attachmentReferenceKey));

  function referenceFor(entry: FileEntry): LocalInputReference {
    return {
      kind: entry.kind,
      projectId,
      relativePath: entry.relativePath,
    };
  }

  function toggle(entry: FileEntry) {
    const reference = referenceFor(entry);
    const key = attachmentReferenceKey(reference);
    if (selectedKeys.has(key)) {
      setDraft((current) => current.filter((item) => attachmentReferenceKey(item) !== key));
      return;
    }
    if (draft.length >= 20) {
      setError("一次最多添加 20 个文件或文件夹");
      return;
    }
    setDraft((current) => [...current, reference]);
    setError("");
  }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    if (!online) {
      setError("连接已中断，恢复后再上传。");
      return;
    }
    const incoming = Array.from(files);
    if (draft.length + incoming.length > 20) {
      setError(`一次最多添加 20 项；当前已选 ${draft.length} 项。`);
      return;
    }
    const next = [...draft];
    setError("");
    try {
      for (const [index, file] of incoming.entries()) {
        setUploadProgress({ current: index + 1, total: incoming.length });
        const reference = await apiClient.upload(file, file.webkitRelativePath || file.name);
        if (
          !next.some(
            (candidate) => attachmentReferenceKey(candidate) === attachmentReferenceKey(reference),
          )
        ) {
          next.push(reference);
          setDraft([...next]);
        }
      }
    } catch (uploadError) {
      setError(errorMessage(uploadError));
    } finally {
      setUploadProgress(undefined);
    }
  }

  const currentFolder: FileEntry | undefined = path
    ? {
        downloadable: false,
        kind: "directory",
        name: parts.at(-1) ?? path,
        relativePath: path,
      }
    : undefined;

  return (
    <Sheet
      description="设备文件会经加密公网连接上传到电脑；电脑已有文件只建立引用，不重复上传。"
      footer={
        <>
          <Button
            disabled={draft.length === 0 || uploadProgress !== undefined}
            onClick={() => {
              onApply(draft);
              onClose();
            }}
            variant="primary"
          >
            添加{draft.length ? ` ${draft.length} 项` : ""}
          </Button>
          <Button onClick={onClose} variant="ghost">
            取消
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      title="添加文件"
    >
      {!online ? (
        <Notice icon="wifi-off" title="连接已中断" tone="danger">
          恢复连接后才能上传或浏览文件。
        </Notice>
      ) : (
        <div className="attachment-picker">
          <section className="attachment-picker__device" aria-labelledby="device-upload-title">
            <div className="attachment-picker__section-heading">
              <span>
                <strong id="device-upload-title">从此设备上传</strong>
                <small>从手机或当前浏览器发送到电脑，再交给 Codex</small>
              </span>
              {uploadProgress ? (
                <span className="attachment-picker__progress" role="status">
                  {uploadProgress.current}/{uploadProgress.total}
                </span>
              ) : null}
            </div>
            <div className="attachment-picker__upload-actions">
              <label className="attachment-picker__upload-button">
                <Icon name="file" size={18} />
                <span>
                  <strong>选择文件</strong>
                  <small>单个文件最大 50 MB</small>
                </span>
                <input
                  aria-label="从此设备选择文件"
                  disabled={uploadProgress !== undefined}
                  multiple
                  onChange={(event) => {
                    const input = event.currentTarget;
                    void uploadFiles(input.files).finally(() => {
                      input.value = "";
                    });
                  }}
                  type="file"
                />
              </label>
              <label className="attachment-picker__upload-button">
                <Icon name="folder" size={18} />
                <span>
                  <strong>选择文件夹</strong>
                  <small>保留文件夹内相对路径</small>
                </span>
                <input
                  aria-label="从此设备选择文件夹"
                  disabled={uploadProgress !== undefined}
                  multiple
                  onChange={(event) => {
                    const input = event.currentTarget;
                    void uploadFiles(input.files).finally(() => {
                      input.value = "";
                    });
                  }}
                  ref={(input) => {
                    input?.setAttribute("webkitdirectory", "");
                    input?.setAttribute("directory", "");
                  }}
                  type="file"
                />
              </label>
            </div>
          </section>
          <AttachmentChips
            attachments={draft}
            onRemove={(reference) =>
              setDraft((current) =>
                current.filter(
                  (item) => attachmentReferenceKey(item) !== attachmentReferenceKey(reference),
                ),
              )
            }
          />
          {projectId ? (
            <>
              <div className="attachment-picker__section-heading">
                <span>
                  <strong>选择电脑文件</strong>
                  <small>引用电脑项目中已经存在的文件或文件夹，不会重复上传</small>
                </span>
              </div>
              <div className="attachment-picker__toolbar">
                <div className="breadcrumbs" aria-label="当前附件路径">
                  <button onClick={() => setPath("")} type="button">
                    <Icon name="folder" size={16} />
                    项目
                  </button>
                  {parts.map((part, index) => (
                    <Fragment key={`${part}-${index}`}>
                      <Icon name="chevron-right" size={14} />
                      <button
                        onClick={() => setPath(parts.slice(0, index + 1).join("/"))}
                        type="button"
                      >
                        {part}
                      </button>
                    </Fragment>
                  ))}
                </div>
                <label className="attachment-picker__search">
                  <Icon name="search" size={16} />
                  <input
                    aria-label="筛选文件和文件夹"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="筛选当前文件夹"
                    value={query}
                  />
                </label>
              </div>
              {currentFolder ? (
                <button
                  aria-pressed={selectedKeys.has(
                    attachmentReferenceKey(referenceFor(currentFolder)),
                  )}
                  className="attachment-picker__current"
                  onClick={() => toggle(currentFolder)}
                  type="button"
                >
                  <Icon name="paperclip" size={17} />
                  <span>
                    <strong>
                      {selectedKeys.has(attachmentReferenceKey(referenceFor(currentFolder)))
                        ? "已添加当前文件夹"
                        : "添加当前文件夹"}
                    </strong>
                    <small>{currentFolder.relativePath}</small>
                  </span>
                  <Icon
                    name={
                      selectedKeys.has(attachmentReferenceKey(referenceFor(currentFolder)))
                        ? "check"
                        : "plus"
                    }
                    size={17}
                  />
                </button>
              ) : null}
              {state === "loading" ? (
                <div className="attachment-picker__loading">
                  <Skeleton />
                  <Skeleton />
                  <Skeleton width="72%" />
                </div>
              ) : state === "error" ? (
                <Notice icon="alert" title="无法读取文件夹" tone="danger">
                  {error}
                </Notice>
              ) : visibleEntries.length ? (
                <div className="attachment-picker__list">
                  {path ? (
                    <button
                      className="attachment-picker__entry"
                      onClick={() => setPath(parts.slice(0, -1).join("/"))}
                      type="button"
                    >
                      <span className="attachment-picker__icon">
                        <Icon name="arrow-left" size={17} />
                      </span>
                      <span>
                        <strong>返回上一级</strong>
                        <small>文件夹</small>
                      </span>
                    </button>
                  ) : null}
                  {visibleEntries.map((entry) => {
                    const reference = referenceFor(entry);
                    const checked = selectedKeys.has(attachmentReferenceKey(reference));
                    return (
                      <div className="attachment-picker__entry" key={entry.relativePath}>
                        <button
                          className="attachment-picker__entry-main"
                          onClick={() =>
                            entry.kind === "directory" ? setPath(entry.relativePath) : toggle(entry)
                          }
                          type="button"
                        >
                          <span className="attachment-picker__icon">
                            <Icon name={entry.kind === "directory" ? "folder" : "file"} size={17} />
                          </span>
                          <span>
                            <strong>{entry.name}</strong>
                            <small>
                              {entry.kind === "directory"
                                ? "打开文件夹"
                                : entry.size === undefined
                                  ? "文件"
                                  : `${number(entry.size)}B`}
                            </small>
                          </span>
                          {entry.kind === "directory" ? (
                            <Icon name="chevron-right" size={16} />
                          ) : null}
                        </button>
                        <button
                          aria-label={`${checked ? "移除" : "添加"} ${entry.name}`}
                          aria-pressed={checked}
                          className="attachment-picker__select"
                          onClick={() => toggle(entry)}
                          type="button"
                        >
                          <Icon name={checked ? "check" : "plus"} size={16} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="mini-empty">{query ? "没有匹配项" : "这个文件夹为空"}</div>
              )}
            </>
          ) : (
            <Notice icon="folder" title="当前对话没有关联项目">
              仍可从手机或当前浏览器上传文件；只有“选择电脑文件”需要先关联已登记项目。
            </Notice>
          )}
          {error && state !== "error" ? (
            <div className="composer-error" role="alert">
              <Icon name="alert" size={15} />
              {error}
            </div>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}

function FilePreview({
  entry,
  projectId,
  apiClient,
  onClose,
  onEdit,
  online,
  embedded = false,
  downloadLabel = "下载文件",
  focusLine,
}: {
  entry: FileEntry;
  projectId: string;
  apiClient: ApiClient;
  onClose?: () => void;
  onEdit?: (content: string) => void;
  online: boolean;
  embedded?: boolean;
  downloadLabel?: string;
  focusLine?: number;
}) {
  const requestKey = filePreviewRequestKey(projectId, entry.relativePath);
  const requestRef = useRef<FilePreviewRequest>({ generation: 1, requestKey });
  if (requestRef.current.requestKey !== requestKey) {
    requestRef.current = {
      generation: requestRef.current.generation + 1,
      requestKey,
    };
  }
  const request = requestRef.current;
  const [preview, setPreview] = useState<FilePreviewDerivedState>(() =>
    loadingFilePreviewState(request),
  );
  const visiblePreview = visibleFilePreviewState(preview, request.requestKey, request.generation);
  const { contentType, error, state, text, url } = visiblePreview;

  useEffect(() => {
    if (!online) return;
    let active = true;
    let objectUrl = "";
    const effectRequest = requestRef.current;
    setPreview(loadingFilePreviewState(effectRequest));
    void apiClient
      .preview(projectId, entry.relativePath)
      .then(async (result) => {
        let nextText = "";
        if (
          result.contentType.startsWith("text/") ||
          /\.(md|txt|json|xml|ya?ml|tsx?|jsx?|css|html)$/i.test(entry.name)
        ) {
          nextText = await result.blob.text();
        } else if (
          result.contentType.startsWith("image/") ||
          result.contentType === "application/pdf"
        ) {
          if (!active || !isCurrentFilePreviewRequest(requestRef.current, effectRequest)) {
            return;
          }
          objectUrl = URL.createObjectURL(result.blob);
        }
        if (!active || !isCurrentFilePreviewRequest(requestRef.current, effectRequest)) {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = "";
          return;
        }
        setPreview({
          ...effectRequest,
          state: "ready",
          text: nextText,
          url: objectUrl,
          contentType: result.contentType,
          error: "",
        });
      })
      .catch((previewError: unknown) => {
        if (!active || !isCurrentFilePreviewRequest(requestRef.current, effectRequest)) return;
        setPreview({
          ...loadingFilePreviewState(effectRequest),
          state: "error",
          error: errorMessage(previewError),
        });
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [apiClient, entry.name, entry.relativePath, online, projectId]);

  const isMarkdown = /\.md$/i.test(entry.name) || contentType === "text/markdown";
  return (
    <section className={`file-preview${embedded ? " file-preview--embedded" : ""}`}>
      <header>
        <div>
          <strong>{entry.name}</strong>
          <span>
            {entry.size === undefined ? "大小未知" : `${number(entry.size)}B`} ·{" "}
            {entry.relativePath}
          </span>
        </div>
        {onClose ? (
          <Button
            aria-label="关闭预览"
            icon="close"
            onClick={onClose}
            size="icon"
            variant="ghost"
          />
        ) : null}
      </header>
      <div className="file-preview__body">
        {focusLine ? (
          <div className="file-preview__location" data-testid="file-preview-location">
            <Icon name="target" size={15} />
            源文件第 {focusLine} 行
          </div>
        ) : null}
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
            <Markdown apiClient={apiClient} online={online} projectId={projectId}>
              {text}
            </Markdown>
          ) : (
            <pre className="code-preview">{text}</pre>
          )
        ) : null}
        {state === "ready" && url && contentType.startsWith("image/") ? (
          <a className="file-preview__image-link" href={url} rel="noreferrer" target="_blank">
            <img alt={entry.name} src={url} />
          </a>
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
        {state === "ready" && text && onEdit ? (
          <Button icon="edit" onClick={() => onEdit(text)}>
            编辑文件
          </Button>
        ) : null}
        {state === "ready" && text ? <CopyTextButton label="复制完整内容" text={text} /> : null}
        {online ? (
          <a
            className="ui-button ui-button--primary ui-button--regular"
            data-testid="file-download"
            data-touch-target="primary"
            download={entry.name}
            href={apiClient.downloadUrl(projectId, entry.relativePath)}
          >
            <Icon name="download" size={18} />
            {downloadLabel}
          </a>
        ) : (
          <Button disabled icon="wifi-off">
            恢复连接后下载
          </Button>
        )}
      </footer>
    </section>
  );
}

type FileManagerOperation =
  | { kind: "create-directory"; name: string }
  | { kind: "create-file"; content: string; name: string }
  | { kind: "edit-file"; content: string; entry: FileEntry }
  | { kind: "rename"; entry: FileEntry; name: string }
  | {
      kind: "copy" | "move";
      entry: FileEntry;
      overwrite: boolean;
      targetPath: string;
      targetProjectId: string;
    }
  | { kind: "delete"; entry: FileEntry; permanent: boolean }
  | {
      kind: "overwrite-upload";
      file: File;
      remaining: File[];
      targetPath: string;
      targetProjectId: string;
    };

function fileManagerJoinPath(parent: string, name: string): string {
  return [parent.replaceAll("\\", "/").replace(/\/+$/u, ""), name.replace(/^[/\\]+/u, "")]
    .filter(Boolean)
    .join("/");
}

function FileManagerOperationSheet({
  busy,
  error,
  hostRoots,
  onChange,
  onClose,
  onSubmit,
  operation,
}: {
  busy: boolean;
  error: string;
  hostRoots: FileRoot[];
  onChange: (operation: FileManagerOperation) => void;
  onClose: () => void;
  onSubmit: () => void;
  operation: FileManagerOperation | undefined;
}) {
  if (!operation) return null;
  const title =
    operation.kind === "create-directory"
      ? "新建文件夹"
      : operation.kind === "create-file"
        ? "新建文本文件"
        : operation.kind === "edit-file"
          ? "编辑文件"
          : operation.kind === "rename"
            ? "重命名"
            : operation.kind === "copy"
              ? "复制到"
              : operation.kind === "move"
                ? "移动到"
                : operation.kind === "delete"
                  ? "删除确认"
                  : "覆盖同名文件";
  const submitLabel =
    operation.kind === "delete"
      ? operation.permanent
        ? "永久删除"
        : "移到回收站"
      : operation.kind === "overwrite-upload"
        ? "覆盖上传"
        : title;
  return (
    <Sheet
      description="操作由当前电脑的受管管理员文件服务执行；Windows 会回报实际结果。"
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            disabled={busy}
            onClick={onSubmit}
            variant={operation.kind === "delete" && operation.permanent ? "danger" : "primary"}
          >
            {busy ? "处理中…" : submitLabel}
          </Button>
        </>
      }
      onClose={onClose}
      open
      title={title}
    >
      <div className="file-operation-form">
        {operation.kind === "create-directory" ||
        operation.kind === "create-file" ||
        operation.kind === "rename" ? (
          <label className="select-label">
            <span>{operation.kind === "rename" ? "新名称" : "名称"}</span>
            <input
              autoFocus
              onChange={(event) => onChange({ ...operation, name: event.target.value })}
              placeholder={operation.kind === "create-directory" ? "新文件夹" : "文件名"}
              value={operation.name}
            />
          </label>
        ) : null}
        {operation.kind === "create-file" || operation.kind === "edit-file" ? (
          <label className="select-label">
            <span>{operation.kind === "edit-file" ? operation.entry.name : "初始内容"}</span>
            <textarea
              onChange={(event) => onChange({ ...operation, content: event.target.value })}
              placeholder={operation.kind === "edit-file" ? "文件内容" : "可以留空，稍后再编辑"}
              rows={12}
              value={operation.content}
            />
          </label>
        ) : null}
        {operation.kind === "copy" || operation.kind === "move" ? (
          <>
            <label className="select-label">
              <span>目标磁盘</span>
              <select
                onChange={(event) =>
                  onChange({ ...operation, targetProjectId: event.target.value })
                }
                value={operation.targetProjectId}
              >
                {hostRoots.map((root) => (
                  <option key={root.id} value={root.id}>
                    {root.name} · {root.rootLabel}
                  </option>
                ))}
              </select>
            </label>
            <label className="select-label">
              <span>目标路径（包含名称）</span>
              <input
                onChange={(event) => onChange({ ...operation, targetPath: event.target.value })}
                placeholder="例如 Users/name/Documents/file.txt"
                value={operation.targetPath}
              />
            </label>
            <label className="file-operation-check">
              <input
                checked={operation.overwrite}
                onChange={(event) => onChange({ ...operation, overwrite: event.target.checked })}
                type="checkbox"
              />
              <span>目标存在时覆盖</span>
            </label>
          </>
        ) : null}
        {operation.kind === "delete" ? (
          <div className="file-delete-options">
            <button
              className={!operation.permanent ? "is-selected" : ""}
              onClick={() => onChange({ ...operation, permanent: false })}
              type="button"
            >
              <Icon name="trash" size={18} />
              <span>
                <strong>移到回收站</strong>
                <small>默认选择，可从 Windows 回收站恢复</small>
              </span>
              {!operation.permanent ? <Icon name="check" size={17} /> : null}
            </button>
            <button
              className={operation.permanent ? "is-selected is-danger" : ""}
              onClick={() => onChange({ ...operation, permanent: true })}
              type="button"
            >
              <Icon name="alert" size={18} />
              <span>
                <strong>永久删除</strong>
                <small>无法从回收站恢复；仅在明确需要时使用</small>
              </span>
              {operation.permanent ? <Icon name="check" size={17} /> : null}
            </button>
            <p>
              即将删除：<strong>{operation.entry.name}</strong>
            </p>
          </div>
        ) : null}
        {operation.kind === "overwrite-upload" ? (
          <Notice icon="alert" title="目标位置已有同名文件" tone="warning">
            覆盖后原内容将被新上传的“{operation.file.name}”替换。
          </Notice>
        ) : null}
        {error ? (
          <div className="form-error" role="alert">
            <Icon name="alert" size={16} />
            {error}
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

function FileBrowserPage({
  projects: _projects,
  apiClient,
  online,
}: {
  projects: ProjectSummary[];
  apiClient: ApiClient;
  online: boolean;
}) {
  const { copy } = useUiLocale();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [hostRoots, setHostRoots] = useState<FileRoot[]>([]);
  const [rootsLoaded, setRootsLoaded] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<FileListing>();
  const [selected, setSelected] = useState<FileEntry>();
  const [actionEntry, setActionEntry] = useState<FileEntry>();
  const [operation, setOperation] = useState<FileManagerOperation>();
  const [operationBusy, setOperationBusy] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [query, setQuery] = useState("");
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!online) {
      setRootsLoaded(true);
      return;
    }
    let active = true;
    void apiClient
      .fileRoots()
      .then((roots) => {
        if (active) setHostRoots(roots.filter((root) => root.kind === "host"));
      })
      .catch(() => {
        if (active) setHostRoots([]);
      })
      .finally(() => {
        if (active) setRootsLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [apiClient, online]);

  const roots = hostRoots;
  const rootsKey = roots.map((root) => root.id).join("|");
  useEffect(() => {
    if (!rootsLoaded) return;
    setProjectId((current) =>
      current && roots.some((root) => root.id === current) ? current : (roots[0]?.id ?? ""),
    );
  }, [rootsKey, rootsLoaded]);

  const currentRoot = roots.find((root) => root.id === projectId);
  const canMutate = online && currentRoot !== undefined;
  const load = useCallback(async () => {
    if (!online) {
      setState((current) => (current === "loading" ? "ready" : current));
      return;
    }
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
  }, [apiClient, online, path, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function processUploads(
    files: File[],
    targetProjectId = projectId,
    targetFolder = path,
  ): Promise<void> {
    if (!files.length || !targetProjectId) return;
    setOperationBusy(true);
    setOperationError("");
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]!;
      const targetPath = fileManagerJoinPath(targetFolder, file.name);
      try {
        await apiClient.writeHostFile(targetProjectId, targetPath, file);
      } catch (uploadError) {
        if (uploadError instanceof ApiRequestError && uploadError.code === "FILE_ALREADY_EXISTS") {
          setOperation({
            kind: "overwrite-upload",
            file,
            remaining: files.slice(index + 1),
            targetPath,
            targetProjectId,
          });
          setOperationBusy(false);
          await load();
          return;
        }
        setOperationError(errorMessage(uploadError));
        setOperationBusy(false);
        await load();
        return;
      }
    }
    setOperationBusy(false);
    await load();
  }

  async function submitOperation() {
    if (!operation || !projectId) return;
    setOperationBusy(true);
    setOperationError("");
    let remainingUploads: File[] = [];
    try {
      switch (operation.kind) {
        case "create-directory":
          await apiClient.createFolder(projectId, fileManagerJoinPath(path, operation.name));
          break;
        case "create-file": {
          const target = fileManagerJoinPath(path, operation.name);
          await apiClient.writeHostFile(
            projectId,
            target,
            new File([operation.content], operation.name, { type: "text/plain" }),
          );
          break;
        }
        case "edit-file":
          await apiClient.writeHostFile(
            projectId,
            operation.entry.relativePath,
            new File([operation.content], operation.entry.name, { type: "text/plain" }),
            true,
          );
          break;
        case "rename":
          await apiClient.renameHostFile(projectId, operation.entry.relativePath, operation.name);
          setSelected(undefined);
          break;
        case "copy":
          await apiClient.copyHostFile({
            overwrite: operation.overwrite,
            sourcePath: operation.entry.relativePath,
            sourceProjectId: projectId,
            targetPath: operation.targetPath,
            targetProjectId: operation.targetProjectId,
          });
          break;
        case "move":
          await apiClient.moveHostFile({
            overwrite: operation.overwrite,
            sourcePath: operation.entry.relativePath,
            sourceProjectId: projectId,
            targetPath: operation.targetPath,
            targetProjectId: operation.targetProjectId,
          });
          setSelected(undefined);
          break;
        case "delete":
          await apiClient.deleteHostFile(
            projectId,
            operation.entry.relativePath,
            operation.permanent,
          );
          setSelected(undefined);
          break;
        case "overwrite-upload":
          await apiClient.writeHostFile(
            operation.targetProjectId,
            operation.targetPath,
            operation.file,
            true,
          );
          remainingUploads = operation.remaining;
          break;
      }
      setOperation(undefined);
      await load();
    } catch (operationFailure) {
      setOperationError(errorMessage(operationFailure));
      setOperationBusy(false);
      return;
    }
    setOperationBusy(false);
    if (remainingUploads.length) {
      await processUploads(remainingUploads);
    }
  }

  const parts = path.split("/").filter(Boolean);
  const visible = (listing?.entries ?? []).filter((entry) =>
    entry.name.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <>
      <MobileHeader title={copy.files} />
      <div
        className={`page files-page ${selected ? "has-preview" : ""}`}
        data-testid="file-browser"
      >
        <div className="files-browser">
          <div className="page-heading">
            <h1>电脑文件</h1>
            <p>浏览和管理这台电脑上的磁盘与文件；删除默认进入回收站。</p>
          </div>
          <label className="select-label project-select">
            <span>位置</span>
            <select
              disabled={!online || !rootsLoaded}
              onChange={(event) => {
                setProjectId(event.target.value);
                setPath("");
                setSelected(undefined);
                setActionEntry(undefined);
                setOperation(undefined);
              }}
              value={projectId}
            >
              {hostRoots.length ? (
                <optgroup label="这台电脑">
                  {hostRoots.map((root) => (
                    <option key={root.id} value={root.id}>
                      {root.name} · {root.rootLabel}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </label>
          {!online ? (
            <Notice icon="wifi-off" title="离线时不能读取或修改电脑文件" tone="danger">
              已打开的内容仍可查看和复制；恢复连接后操作按钮会自动可用。
            </Notice>
          ) : null}
          <div className="file-manager-actions" aria-label="文件操作">
            <Button
              disabled={!canMutate || operationBusy}
              icon="paperclip"
              onClick={() => uploadInputRef.current?.click()}
              size="compact"
            >
              上传
            </Button>
            <Button
              disabled={!canMutate || operationBusy}
              icon="folder"
              onClick={() => {
                setOperationError("");
                setOperation({ kind: "create-directory", name: "" });
              }}
              size="compact"
            >
              新建文件夹
            </Button>
            <Button
              disabled={!canMutate || operationBusy}
              icon="edit"
              onClick={() => {
                setOperationError("");
                setOperation({ kind: "create-file", content: "", name: "" });
              }}
              size="compact"
            >
              新建文件
            </Button>
            <Button
              aria-label="刷新"
              disabled={!online || operationBusy}
              icon="refresh"
              onClick={() => void load()}
              size="icon"
              variant="ghost"
            />
            <input
              hidden
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                void processUploads(files);
              }}
              ref={uploadInputRef}
              type="file"
            />
          </div>
          <div className="file-toolbar">
            <div aria-label="当前路径" className="breadcrumbs">
              <button disabled={!online} onClick={() => setPath("")}>
                <Icon name="folder" size={17} />
                <span>{currentRoot?.name ?? "电脑"}</span>
              </button>
              {parts.map((part, index) => (
                <Fragment key={`${part}-${index}`}>
                  <Icon name="chevron-right" size={15} />
                  <button
                    disabled={!online}
                    onClick={() => setPath(parts.slice(0, index + 1).join("/"))}
                  >
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
                placeholder={copy.filterFiles}
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
                  <Button disabled={!online} icon="refresh" onClick={() => void load()}>
                    重新加载
                  </Button>
                }
                description={error}
                icon="alert"
                title="文件夹加载失败"
              />
            </Card>
          ) : visible.length || path ? (
            <Card className="file-list">
              {path ? (
                <button disabled={!online} onClick={() => setPath(parts.slice(0, -1).join("/"))}>
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
                    disabled={!online}
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
                  {online && entry.kind === "file" && entry.downloadable ? (
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
                  {canMutate ? (
                    <button
                      aria-label={`管理 ${entry.name}`}
                      className="file-entry-action"
                      onClick={() => setActionEntry(entry)}
                      type="button"
                    >
                      <Icon name="more" size={18} />
                    </button>
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
            {...(canMutate
              ? {
                  onEdit: (content: string) => {
                    setOperationError("");
                    setOperation({ content, entry: selected, kind: "edit-file" });
                  },
                }
              : {})}
            online={online}
            projectId={projectId}
          />
        ) : (
          <aside className="file-preview-placeholder">
            <Icon name="file" size={26} />
            <strong>选择文件以预览</strong>
            <span>支持完整文本复制、图片与 PDF 预览，以及原文件下载</span>
          </aside>
        )}
      </div>
      <Sheet
        description="这些操作由当前电脑的受管管理员文件服务执行。"
        onClose={() => setActionEntry(undefined)}
        open={actionEntry !== undefined}
        title={actionEntry?.name ?? "文件操作"}
      >
        {actionEntry ? (
          <div className="file-action-list">
            {actionEntry.kind === "file" ? (
              <Button
                icon="file"
                onClick={() => {
                  setSelected(actionEntry);
                  setActionEntry(undefined);
                }}
              >
                预览
              </Button>
            ) : null}
            <Button
              icon="edit"
              onClick={() => {
                setOperationError("");
                setOperation({ entry: actionEntry, kind: "rename", name: actionEntry.name });
                setActionEntry(undefined);
              }}
            >
              重命名
            </Button>
            <Button
              icon="copy"
              onClick={() => {
                setOperationError("");
                setOperation({
                  entry: actionEntry,
                  kind: "copy",
                  overwrite: false,
                  targetPath: actionEntry.relativePath,
                  targetProjectId: projectId,
                });
                setActionEntry(undefined);
              }}
            >
              复制到…
            </Button>
            <Button
              icon="chevron-right"
              onClick={() => {
                setOperationError("");
                setOperation({
                  entry: actionEntry,
                  kind: "move",
                  overwrite: false,
                  targetPath: actionEntry.relativePath,
                  targetProjectId: projectId,
                });
                setActionEntry(undefined);
              }}
            >
              移动到…
            </Button>
            <Button
              icon="trash"
              onClick={() => {
                setOperationError("");
                setOperation({ entry: actionEntry, kind: "delete", permanent: false });
                setActionEntry(undefined);
              }}
              variant="danger"
            >
              删除…
            </Button>
          </div>
        ) : null}
      </Sheet>
      <FileManagerOperationSheet
        busy={operationBusy}
        error={operationError}
        hostRoots={hostRoots}
        onChange={setOperation}
        onClose={() => {
          if (!operationBusy) {
            setOperation(undefined);
            setOperationError("");
          }
        }}
        onSubmit={() => void submitOperation()}
        operation={operation}
      />
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
  const { copy } = useUiLocale();
  const [busy, setBusy] = useState(false);
  const diagnostics = data.diagnostics;
  const caps = diagnostics?.capabilities;

  return (
    <>
      <MobileHeader title={copy.settings} />
      <div className="page settings-page">
        <div className="page-heading">
          <h1>{copy.settingsAndDiagnostics}</h1>
          <p>{copy.settingsDescription}</p>
        </div>
        <div className="settings-grid" data-testid="usage-panel">
          <section>
            <h2>{copy.connection}</h2>
            <Card className="settings-card">
              <div className="settings-row">
                <span className="settings-row__icon">
                  <Icon name="activity" size={19} />
                </span>
                <span>
                  <strong>{copy.publicEntry}</strong>
                  <small>{online ? copy.liveConnected : copy.reconnecting}</small>
                </span>
                <StatusPill tone={online ? "success" : "danger"}>
                  {online ? copy.healthy : copy.disconnected}
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
                {busy
                  ? copy.languageChoice === "EN"
                    ? "正在刷新…"
                    : "Refreshing…"
                  : copy.refreshDiagnostics}
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
                        ? `${formatUtc8Time(window.resetsAt)} 重置`
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
        approval.choices.length > 0 ? (
          <>
            {approval.choices.map((choice) => (
              <Button
                data-testid={`approval-choice-${choice.id}`}
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
        ) : undefined
      }
      onClose={onClose}
      open
      title={approval.title}
    >
      <div className="approval-detail">
        {approval.limitation ? (
          <Notice icon="alert" title="当前请求不能安全地从手机审批">
            {approval.limitation}
          </Notice>
        ) : null}
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
  const location = useLocation();
  const eventThreadId = threadIdFromConversationPath(location.pathname);
  const [data, setData] = useState<WorkspaceData>(emptyWorkspace);
  const [state, setState] = useState<LoadState>(eventThreadId ? "ready" : "loading");
  const [error, setError] = useState("");
  const [online, setOnline] = useState(true);
  const [liveEvents, setLiveEvents] = useState<LiveEventEnvelope[]>([]);
  const [eventSnapshotCursor, setEventSnapshotCursor] = useState<WorkspaceSnapshotEventCursor>();
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
  const recoveryTimer = useRef<number | undefined>(undefined);
  const loadInFlight = useRef<Promise<void> | undefined>(undefined);
  const initialReplayComplete = useRef(false);
  const liveDeliverySequence = useRef(0);
  const threadsRef = useRef<ThreadSummary[]>([]);
  const threadsNextCursorRef = useRef<string | undefined>(undefined);
  const threadsExtendedRef = useRef(false);
  const threadTailIdsRef = useRef(new Set<string>());
  const workspaceReadyRef = useRef(false);
  const threadsMoreInFlightRef = useRef(false);
  const archivedThreadsRef = useRef<ThreadSummary[]>([]);
  const archivedNextCursorRef = useRef<string | undefined>(undefined);
  const archivedTailIdsRef = useRef(new Set<string>());
  const archivedLoadedRef = useRef(false);
  const archivedInFlightRef = useRef(false);
  const locallyResolvedApprovalIdsRef = useRef(new Set<string>());
  const dismissedApprovalIdsRef = useRef(new Set<string>());
  const isDesktop = useMediaQuery("(min-width: 1100px)");
  const runningThreadCount = data.threads.filter((thread) => thread.state === "running").length;
  const eventThreadIdRef = useRef(eventThreadId);
  eventThreadIdRef.current = eventThreadId;
  const bootstrapEventCursor = workspaceBootstrapEventCursor(eventSnapshotCursor, eventThreadId);
  const rememberSnapshotEventCursor = useCallback((threadId: string, cursor: string) => {
    setEventSnapshotCursor((current) =>
      retainWorkspaceSnapshotEventCursorForCurrentRoute(current, eventThreadIdRef, {
        cursor,
        threadId,
      }),
    );
  }, []);

  useEffect(() => {
    setSelectedApproval((current) =>
      approvalForCurrentThread(
        current,
        data.approvals,
        eventThreadId,
        dismissedApprovalIdsRef.current,
      ),
    );
  }, [data.approvals, eventThreadId]);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = browserAttentionTitle({
      approvalCount: data.approvals.length,
      ...(currentThread?.state === undefined ? {} : { currentState: currentThread.state }),
      ...(currentThread?.title === undefined ? {} : { currentTitle: currentThread.title }),
      online,
      runningCount: runningThreadCount,
    });
    return () => {
      document.title = previousTitle;
    };
  }, [
    currentThread?.state,
    currentThread?.title,
    data.approvals.length,
    online,
    runningThreadCount,
  ]);

  const load = useCallback(
    function loadWorkspace() {
      if (loadInFlight.current !== undefined) return loadInFlight.current;
      const promise = (async () => {
        try {
          const modelsPromise = api.models();
          const collaborationModesPromise = api
            .collaborationModes()
            .catch(() => [] as CollaborationModeOption[]);
          const threadsPagePromise = api.threads({ archived: false });
          const projectsPromise = api.projects();
          const usagePromise = api.usage().catch(() => undefined);
          const diagnosticsPromise = api.diagnostics().catch(() => undefined);
          const approvalsPromise = api.approvals().catch(() => [] as ApprovalRequest[]);
          const archivedPagePromise: Promise<CursorPage<ThreadSummary> | undefined> =
            archivedLoadedRef.current
              ? api.threads({ archived: true }).catch((loadError: unknown) => {
                  setArchivedError(errorMessage(loadError));
                  setArchivedState("error");
                  return undefined;
                })
              : Promise.resolve(undefined);

          const threadsPage = await threadsPagePromise;
          let threads = workspaceReadyRef.current
            ? mergeRefreshedFirstPage(
                threadsRef.current,
                threadsPage.items,
                (thread) => thread.id,
                threadTailIdsRef.current,
              )
            : threadsPage.items;
          if (!workspaceReadyRef.current) {
            threadTailIdsRef.current.clear();
          }
          const nextCursor = nextCursorAfterRefresh(
            threadsNextCursorRef.current,
            threadsPage.nextCursor,
            threadsExtendedRef.current || threadsMoreInFlightRef.current,
          );
          threadsRef.current = threads;
          threadsNextCursorRef.current = nextCursor;
          setThreadsNextCursor(nextCursor);
          setData((current) => ({ ...current, threads }));
          workspaceReadyRef.current = true;
          setState("ready");
          setError("");

          const [
            models,
            collaborationModes,
            projects,
            usage,
            diagnostics,
            approvals,
            archivedPage,
          ] = await Promise.all([
            modelsPromise,
            collaborationModesPromise,
            projectsPromise,
            usagePromise,
            diagnosticsPromise,
            approvalsPromise,
            archivedPagePromise,
          ]);
          const approvalReconciliation = reconcileFetchedApprovals(
            approvals,
            locallyResolvedApprovalIdsRef.current,
          );
          locallyResolvedApprovalIdsRef.current = approvalReconciliation.remainingResolvedIds;
          threads = threadsRef.current;
          if (archivedPage !== undefined) {
            let archived = mergeRefreshedFirstPage(
              archivedThreadsRef.current,
              archivedPage.items,
              (thread) => thread.id,
              archivedTailIdsRef.current,
            );
            const currentFirstPageIds = new Set(threadsPage.items.map((thread) => thread.id));
            const archivedFirstPageIds = new Set(archivedPage.items.map((thread) => thread.id));
            threads = threads.filter((thread) => !archivedFirstPageIds.has(thread.id));
            archived = archived.filter((thread) => !currentFirstPageIds.has(thread.id));
            const archivedNextCursor = nextCursorAfterRefresh(
              archivedNextCursorRef.current,
              archivedPage.nextCursor,
              archivedTailIdsRef.current.size > 0 || archivedInFlightRef.current,
            );
            archivedThreadsRef.current = archived;
            archivedNextCursorRef.current = archivedNextCursor;
            setArchivedThreads(archived);
            setArchivedNextCursor(archivedNextCursor);
            setArchivedError("");
            setArchivedState("ready");
          }
          threadsRef.current = threads;
          setData({
            projects,
            models,
            collaborationModes,
            threads,
            usage,
            diagnostics,
            approvals: approvalReconciliation.approvals,
          });
          workspaceReadyRef.current = true;
          setState("ready");
          setError("");
          if (recoveryTimer.current !== undefined) {
            window.clearTimeout(recoveryTimer.current);
            recoveryTimer.current = undefined;
          }
        } catch (loadError) {
          const policy = workspaceLoadFailurePolicy(loadError, workspaceReadyRef.current);
          if (policy.kind === "authentication") {
            onLoggedOut();
            return;
          }
          setError(errorMessage(loadError));
          if (!policy.preserveSnapshot) {
            setState("error");
          }
          if (policy.retryAfterMs !== undefined && recoveryTimer.current === undefined) {
            recoveryTimer.current = window.setTimeout(() => {
              recoveryTimer.current = undefined;
              void loadWorkspace();
            }, policy.retryAfterMs);
          }
        }
      })();
      loadInFlight.current = promise;
      void promise.finally(() => {
        if (loadInFlight.current === promise) loadInFlight.current = undefined;
      });
      return promise;
    },
    [onLoggedOut],
  );

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
      for (const thread of page.items) {
        threadTailIdsRef.current.add(thread.id);
      }
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
      if (cursor) {
        for (const thread of page.items) {
          archivedTailIdsRef.current.add(thread.id);
        }
      } else {
        archivedTailIdsRef.current.clear();
      }
      archivedLoadedRef.current = true;
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

  function applyAuthoritativeThreadLists(authoritative: AuthoritativeThreadLists) {
    const currentReadback = mergeThreadListReadback(
      threadsRef.current,
      threadsNextCursorRef.current,
      threadTailIdsRef.current,
      authoritative.current,
    );
    const archivedReadback = mergeThreadListReadback(
      archivedThreadsRef.current,
      archivedNextCursorRef.current,
      archivedTailIdsRef.current,
      authoritative.archived,
    );
    const currentIds = new Set(currentReadback.items.map((item) => item.id));
    const archivedIds = new Set(archivedReadback.items.map((item) => item.id));
    const current = currentReadback.items.filter((item) => !archivedIds.has(item.id));
    const archived = archivedReadback.items.filter((item) => !currentIds.has(item.id));

    threadTailIdsRef.current = new Set(
      [...currentReadback.loadedTailIds].filter((threadId) =>
        current.some((thread) => thread.id === threadId),
      ),
    );
    archivedTailIdsRef.current = new Set(
      [...archivedReadback.loadedTailIds].filter((threadId) =>
        archived.some((thread) => thread.id === threadId),
      ),
    );
    threadsExtendedRef.current = threadTailIdsRef.current.size > 0;
    archivedLoadedRef.current = true;
    threadsRef.current = current;
    archivedThreadsRef.current = archived;
    threadsNextCursorRef.current = currentReadback.nextCursor;
    archivedNextCursorRef.current = archivedReadback.nextCursor;
    setData((workspace) => ({ ...workspace, threads: current }));
    setArchivedThreads(archived);
    setThreadsNextCursor(currentReadback.nextCursor);
    setArchivedNextCursor(archivedReadback.nextCursor);
    setThreadsMoreError("");
    setThreadsMoreState("idle");
    setArchivedError("");
    setArchivedState("ready");
  }

  async function readConvergedThreadLists(
    thread: ThreadSummary,
    mutation: ThreadListMutation,
  ): Promise<AuthoritativeThreadLists> {
    const authoritative = await readAuthoritativeThreadLists(api, thread.id);
    if (
      !threadMutationMatchesAuthoritativeLists(authoritative, {
        mutation,
        threadId: thread.id,
      })
    ) {
      throw new Error("电脑端列表尚未反映已提交的操作");
    }
    return authoritative;
  }

  async function mutateThreadList(
    thread: ThreadSummary,
    mutation: ThreadListMutation,
    onCommitted: () => void,
  ) {
    return commitThenConvergeThreadLists({
      apply: applyAuthoritativeThreadLists,
      commit: async () => {
        if (mutation.kind === "rename") {
          await api.setThreadName(thread.id, mutation.name);
        } else {
          await api.setThreadArchived(thread.id, mutation.archived);
        }
      },
      onCommitted,
      read: () => readConvergedThreadLists(thread, mutation),
    });
  }

  async function retryThreadListConvergence(
    thread: ThreadSummary,
    mutation: ThreadListMutation,
  ): Promise<ThreadListRefreshResult> {
    return convergeThreadLists({
      apply: applyAuthoritativeThreadLists,
      read: () => readConvergedThreadLists(thread, mutation),
    });
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
    initialReplayComplete.current = false;
    const unsubscribe = subscribeWorkspaceEventStream(
      api,
      (event) => {
        const envelope = {
          deliveryId: ++liveDeliverySequence.current,
          event,
          replayed: !initialReplayComplete.current && event.type !== "connection.ready",
        };
        if (event.type === "connection.ready") {
          initialReplayComplete.current = true;
        }
        if (event.type === "connection.reset") {
          locallyResolvedApprovalIdsRef.current.clear();
        }
        const remotelyResolvedApprovalId = resolvedApprovalId(event);
        if (remotelyResolvedApprovalId !== undefined) {
          locallyResolvedApprovalIdsRef.current.add(remotelyResolvedApprovalId);
          setData((current) => ({
            ...current,
            approvals: current.approvals.filter(
              (approval) => approval.id !== remotelyResolvedApprovalId,
            ),
          }));
        }
        const threadSnapshot = threadSummaryFromSnapshotEvent(event);
        if (threadSnapshot) {
          const reconciled = reconcileThreadSnapshotLists(
            threadsRef.current,
            archivedThreadsRef.current,
            threadSnapshot,
          );
          threadsRef.current = reconciled.current;
          archivedThreadsRef.current = reconciled.archived;
          if (threadSnapshot.archived) {
            threadTailIdsRef.current.delete(threadSnapshot.id);
          } else {
            archivedTailIdsRef.current.delete(threadSnapshot.id);
          }
          setData((current) => ({ ...current, threads: reconciled.current }));
          setArchivedThreads(reconciled.archived);
        }
        setLiveEvents((current) => {
          if (event.type === "connection.reset") return [envelope];
          const next = [...current, envelope];
          return next.length > MAX_LIVE_EVENTS ? next.slice(next.length - MAX_LIVE_EVENTS) : next;
        });
        if (workspaceEventNeedsRefresh(event)) {
          if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
          refreshTimer.current = window.setTimeout(() => void load(), 500);
        }
      },
      setOnline,
      eventThreadId,
      bootstrapEventCursor,
    );
    return () => {
      unsubscribe();
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      if (recoveryTimer.current !== undefined) {
        window.clearTimeout(recoveryTimer.current);
        recoveryTimer.current = undefined;
      }
    };
  }, [bootstrapEventCursor, eventThreadId, load]);

  async function logout() {
    await api.logout();
    onLoggedOut();
  }

  function resolvedApproval(id: string) {
    locallyResolvedApprovalIdsRef.current.add(id);
    setData((current) => ({
      ...current,
      approvals: current.approvals.filter((approval) => approval.id !== id),
    }));
  }

  function openApproval(approval: ApprovalRequest) {
    dismissedApprovalIdsRef.current.delete(approval.id);
    setSelectedApproval(approval);
  }

  function closeApproval() {
    if (selectedApproval) dismissedApprovalIdsRef.current.add(selectedApproval.id);
    setSelectedApproval(undefined);
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
            element={
              <ThreadsPage
                archivedError={archivedError}
                archivedNextCursor={archivedNextCursor}
                archivedState={archivedState}
                archivedThreads={archivedThreads}
                data={data}
                moreError={threadsMoreError}
                moreState={threadsMoreState}
                nextCursor={threadsNextCursor}
                online={online}
                onOpenApproval={openApproval}
                onLoadArchived={() => void loadArchivedPage()}
                onLoadMore={() => void loadMoreThreads()}
                onLoadMoreArchived={() => void loadArchivedPage(archivedNextCursorRef.current)}
                onThreadConvergenceRetry={retryThreadListConvergence}
                onThreadMutation={mutateThreadList}
              />
            }
            path="/"
          />
          <Route element={<Navigate replace to="/" />} path="/threads" />
          <Route
            element={
              <ConversationPage
                apiClient={api}
                approvals={data.approvals}
                capabilities={data.diagnostics?.capabilities}
                collaborationModes={data.collaborationModes}
                liveEvents={liveEvents}
                models={data.models}
                onOpenApproval={openApproval}
                onSnapshotEventCursor={rememberSnapshotEventCursor}
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
                capabilities={data.diagnostics?.capabilities}
                collaborationModes={data.collaborationModes}
                models={data.models}
                online={online}
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
          onOpenApproval={openApproval}
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
        onClose={closeApproval}
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
  const [locale, setLocaleState] = useState<UiLocale>(() => readUiLocale(window.localStorage));
  const recoveryTimer = useRef<number | undefined>(undefined);
  const localeContext = useMemo(
    () => ({
      copy: localeCopy(locale),
      locale,
      setLocale(nextLocale: UiLocale) {
        setLocaleState(nextLocale);
        writeUiLocale(window.localStorage, nextLocale);
      },
    }),
    [locale],
  );

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);

  const initialize = useCallback(async function initializeApp() {
    if (recoveryTimer.current !== undefined) {
      window.clearTimeout(recoveryTimer.current);
      recoveryTimer.current = undefined;
    }
    setState("loading");
    try {
      const result = await api.bootstrap();
      setBootstrap(result);
      if (result.authenticated) {
        try {
          setSession(await api.session());
        } catch (sessionError) {
          const policy = workspaceLoadFailurePolicy(sessionError, false);
          if (policy.kind === "authentication") {
            setSession(undefined);
            setBootstrap(loggedOutBootstrap(result));
            setState("ready");
            return;
          }
          throw sessionError;
        }
      } else {
        setSession(undefined);
      }
      setState("ready");
    } catch (initializationError) {
      setState("error");
      const policy = workspaceLoadFailurePolicy(initializationError, false);
      if (policy.retryAfterMs !== undefined && recoveryTimer.current === undefined) {
        recoveryTimer.current = window.setTimeout(() => {
          recoveryTimer.current = undefined;
          void initializeApp();
        }, policy.retryAfterMs);
      }
    }
  }, []);

  useEffect(() => {
    void initialize();
    return () => {
      if (recoveryTimer.current !== undefined) {
        window.clearTimeout(recoveryTimer.current);
        recoveryTimer.current = undefined;
      }
    };
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
    <UiLocaleContext.Provider value={localeContext}>
      <Workspace
        onLoggedOut={() => {
          setSession(undefined);
          setBootstrap(loggedOutBootstrap(bootstrap));
        }}
        session={session}
      />
    </UiLocaleContext.Provider>
  );
}
