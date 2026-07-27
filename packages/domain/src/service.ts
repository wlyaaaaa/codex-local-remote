import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AccountTokenUsageSummary,
  ApprovalPolicyOption,
  ApprovalReviewerOption,
  CollaborationModeOption,
  CreateThreadInput,
  DailyTokenUsage,
  LocalInputReference,
  ModelOption,
  PermissionMode,
  PermissionProfileOption,
  ProjectSummary,
  ReasoningEffort,
  SetThreadGoalInput,
  SendTurnInput,
  SteerTurnInput,
  SubagentSummary,
  ThreadDetail,
  ThreadGoal,
  ThreadSettingsInput,
  ThreadSummary,
  UsageCredits,
  UsageSnapshot,
  UsageWindow,
} from "@codex-local-remote/contracts";
import { validateSafeWindowsProjectRoot } from "@codex-local-remote/security";

import type { RemoteEventBuffer } from "./events.js";
import {
  projectAppServerNotification,
  projectThreadDetail,
  projectThreadSummary,
  type AppServerNotificationLike,
} from "./projection.js";

const SUBAGENT_CURSOR_PREFIX = "clr-subagents-v1.";
const MAX_PINNED_THREAD_SUPPLEMENTS = 100;
const PINNED_THREAD_READ_CONCURRENCY = 8;
const DESKTOP_RECONCILIATION_BATCH_SIZE = 32;
const LOADED_THREAD_BACKFILL_BATCH_SIZE = 32;
const MAX_LOADED_THREAD_PAGES = 20;
const MAX_SUBAGENT_ANCESTOR_READS = 500;
const SUBAGENT_ANCESTOR_READ_CONCURRENCY = 8;
const SHARED_THREAD_RESUME_DELAYS_MS = [0, 25, 100, 250, 500, 1_000] as const;
const SHARED_INVENTORY_FAST_PATH_MS = 250;

export interface AppServerGateway {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export interface RegisteredProject {
  id: string;
  name: string;
  root: string;
  source?: ProjectSummary["source"];
}

export interface ServiceDegradation {
  code: "feature-unavailable" | "temporarily-unavailable";
  feature:
    | "approval-reviewer"
    | "approval-policy"
    | "collaboration-mode"
    | "usage"
    | "permissions"
    | "history"
    | "models";
  message: string;
}

export interface ServiceResult<T> {
  data: T;
  degradations: ServiceDegradation[];
}

export interface ThreadPage {
  data: ThreadSummary[];
  nextCursor?: string;
}

export interface TurnCommandResult {
  threadId: string;
  turnId: string;
  state: "running" | "idle";
}

export interface ResolvedLocalInputReference {
  kind: "file" | "directory";
  name: string;
  path: string;
}

export interface SubagentPage {
  data: SubagentSummary[];
  nextCursor?: string;
}

interface SubagentCursorState {
  archived?: string;
  current?: string;
}

export class DomainError extends Error {
  readonly code:
    | "INVALID_INPUT"
    | "PROJECT_NOT_AUTHORIZED"
    | "PROJECT_NOT_FOUND"
    | "FEATURE_UNAVAILABLE"
    | "THREAD_NOT_FOUND"
    | "THREAD_READ_ONLY"
    | "DIRECT_INPUT_UNAVAILABLE"
    | "TURN_CONTROL_LOST"
    | "TURN_MISMATCH";
  readonly httpStatus: number;

  constructor(code: DomainError["code"], message: string, httpStatus: number) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class ProjectRegistry {
  readonly #projects = new Map<string, Required<RegisteredProject>>();

  constructor(projects: RegisteredProject[] = []) {
    for (const project of projects) {
      this.register(project);
    }
  }

  register(project: RegisteredProject): void {
    const id = project.id.trim();
    const name = project.name.trim();
    const rootValidation = validateSafeWindowsProjectRoot(project.root);
    if (!id || !name || !rootValidation.ok) {
      throw new DomainError("INVALID_INPUT", "项目配置无效", 400);
    }
    const root = rootValidation.normalized;
    const rootKey = windowsPathKey(root);
    const existing = [...this.#projects.values()].find(
      (candidate) => windowsPathKey(candidate.root) === rootKey,
    );
    if (existing) {
      if (existing.source === "registered" || project.source !== "registered") {
        return;
      }
      this.#projects.delete(existing.id);
    }
    this.#projects.set(id, {
      id,
      name,
      root,
      source: project.source ?? "registered",
    });
  }

  list(): ProjectSummary[] {
    return [...this.#projects.values()]
      .map((project) => ({
        id: project.id,
        name: project.name,
        rootLabel: path.win32.basename(project.root),
        source: project.source,
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  requireRoot(projectId: string): string {
    const project = this.#projects.get(projectId);
    if (!project) {
      throw new DomainError("PROJECT_NOT_FOUND", "找不到这个项目", 404);
    }
    return project.root;
  }

  requireRegisteredRoot(projectId: string): string {
    const project = this.#projects.get(projectId);
    if (!project) {
      throw new DomainError("PROJECT_NOT_FOUND", "找不到这个项目", 404);
    }
    if (project.source !== "registered") {
      throw new DomainError(
        "PROJECT_NOT_AUTHORIZED",
        "这个项目尚未在电脑本机登记，当前只能查看已有对话",
        403,
      );
    }
    return project.root;
  }

  findIdByCwd(cwd: unknown): string | undefined {
    const normalized = windowsPathKey(cwd);
    if (normalized === undefined) {
      return undefined;
    }
    return [...this.#projects.values()].find(
      (project) => windowsPathKey(project.root) === normalized,
    )?.id;
  }
}

export interface CodexDomainServiceOptions {
  clearPendingDesktopNotification?: (threadId: string) => Promise<void>;
  events?: RemoteEventBuffer;
  gateway: AppServerGateway;
  generalConversationRoot?: string;
  listPinnedThreadIds?: () => Promise<readonly string[] | undefined>;
  managedThreadIds?: Iterable<string>;
  notifyManagedThreadCreated?: (threadId: string) => void | Promise<void>;
  pendingDesktopNotificationThreadIds?: Iterable<string>;
  protocolCatalog?: {
    approvalPolicies?: readonly string[];
    approvalReviewers?: readonly string[];
    clientMethods?: readonly string[];
  };
  readPersistedUsageContext?: (
    threadId: string,
    sessionPath?: string,
  ) => Promise<NonNullable<UsageSnapshot["context"]> | undefined>;
  persistManagedThread?: (
    threadId: string,
    options: { desktopNotificationPending: boolean },
  ) => Promise<void>;
  projects: ProjectRegistry;
  resolveLocalInputReference?: (
    reference: LocalInputReference,
  ) => Promise<ResolvedLocalInputReference>;
  resolveRegisteredProjectRoot: (projectId: string) => Promise<string | undefined>;
  sharedAppServer?: boolean;
  sharedResumeDelaysMs?: number[];
}

interface CompactionRuntimeState {
  itemId?: string;
  phase: "observed" | "reserving" | "requested";
  turnId?: string;
}

interface ThreadRuntimeSettingsState {
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  serviceTier?: string | null;
  permissionProfileId?: string | null;
  approvalPolicy?: string | null;
  approvalsReviewer?: string | null;
  collaborationMode?: string | null;
}

export class CodexDomainService {
  readonly #clearPendingDesktopNotification: ((threadId: string) => Promise<void>) | undefined;
  readonly #activeThreadIds = new Set<string>();
  readonly #desktopNotificationAttempts = new Map<string, Promise<void>>();
  readonly #events: RemoteEventBuffer | undefined;
  readonly #gateway: AppServerGateway;
  readonly #generalConversationRoot: string | undefined;
  readonly #listPinnedThreadIds: (() => Promise<readonly string[] | undefined>) | undefined;
  readonly #loadedThreadIds = new Set<string>();
  readonly #managedThreads = new Set<string>();
  readonly #notifyManagedThreadCreated: ((threadId: string) => void | Promise<void>) | undefined;
  readonly #persistManagedThread:
    | ((threadId: string, options: { desktopNotificationPending: boolean }) => Promise<void>)
    | undefined;
  readonly #recentlyCompletedCompactionTurns = new Map<string, string>();
  readonly #resolveLocalInputReference:
    | ((reference: LocalInputReference) => Promise<ResolvedLocalInputReference>)
    | undefined;
  readonly #resolveRegisteredProjectRoot: (projectId: string) => Promise<string | undefined>;
  readonly #sharedAppServer: boolean;
  readonly #sharedResumeDelaysMs: readonly number[];
  readonly #sharedThreadSnapshots = new Map<string, Record<string, unknown>>();
  readonly #sharedSubscribedThreads = new Set<string>();
  readonly #sharedSubscriptionPromises = new Map<string, Promise<void>>();
  readonly #publishedThreadSnapshotSignatures = new Map<string, string>();
  readonly #restoredPendingDesktopNotifications = new Set<string>();
  readonly #restoredThreadsNeedingRefresh = new Set<string>();
  readonly #activeTurns = new Map<string, string>();
  readonly #compactingThreads = new Map<string, CompactionRuntimeState>();
  readonly #directInputThreads = new Set<string>();
  readonly #orphanedActiveTurns = new Set<string>();
  readonly #pendingTurnStarts = new Set<string>();
  readonly #pinnedThreadRanks = new Map<string, number>();
  readonly #protocolApprovalPolicies: readonly string[];
  readonly #protocolApprovalReviewers: readonly string[];
  readonly #protocolClientMethods: ReadonlySet<string>;
  readonly #readPersistedUsageContext:
    | ((
        threadId: string,
        sessionPath?: string,
      ) => Promise<NonNullable<UsageSnapshot["context"]> | undefined>)
    | undefined;
  readonly #threadsAwaitingInitialTurnCompletion = new Set<string>();
  readonly #turnStartsCompletedBeforeResponse = new Map<string, Set<string>>();
  #desktopReconciliationPromise: Promise<void> | undefined;
  #sharedInventoryRefreshPromise: Promise<void> | undefined;
  readonly #threadRuntimeSettings = new Map<string, ThreadRuntimeSettingsState>();
  readonly #usageContexts = new Map<string, NonNullable<UsageSnapshot["context"]>>();
  #historyTruncated = false;
  readonly projects: ProjectRegistry;

  constructor(options: CodexDomainServiceOptions) {
    this.#clearPendingDesktopNotification = options.clearPendingDesktopNotification;
    this.#events = options.events;
    this.#gateway = options.gateway;
    this.#listPinnedThreadIds = options.listPinnedThreadIds;
    if (options.generalConversationRoot === undefined) {
      this.#generalConversationRoot = undefined;
    } else {
      const generalRoot = validateSafeWindowsProjectRoot(options.generalConversationRoot);
      if (!generalRoot.ok) {
        throw new DomainError("INVALID_INPUT", "无项目对话目录配置无效", 400);
      }
      this.#generalConversationRoot = generalRoot.normalized;
    }
    this.#notifyManagedThreadCreated = options.notifyManagedThreadCreated;
    this.#persistManagedThread = options.persistManagedThread;
    this.#protocolApprovalPolicies = sanitizeProtocolOptions(
      options.protocolCatalog?.approvalPolicies,
    );
    this.#protocolApprovalReviewers = sanitizeProtocolOptions(
      options.protocolCatalog?.approvalReviewers,
    );
    this.#protocolClientMethods = new Set(
      sanitizeProtocolOptions(options.protocolCatalog?.clientMethods),
    );
    this.#readPersistedUsageContext = options.readPersistedUsageContext;
    this.#resolveLocalInputReference = options.resolveLocalInputReference;
    this.#resolveRegisteredProjectRoot = options.resolveRegisteredProjectRoot;
    this.#sharedAppServer = options.sharedAppServer === true;
    this.#sharedResumeDelaysMs = options.sharedResumeDelaysMs ?? SHARED_THREAD_RESUME_DELAYS_MS;
    for (const threadId of options.managedThreadIds ?? []) {
      const normalized = threadId.trim();
      if (normalized) {
        this.#managedThreads.add(normalized);
        this.#restoredThreadsNeedingRefresh.add(normalized);
      }
    }
    for (const threadId of options.pendingDesktopNotificationThreadIds ?? []) {
      const normalized = threadId.trim();
      if (this.#managedThreads.has(normalized)) {
        this.#threadsAwaitingInitialTurnCompletion.add(normalized);
        this.#restoredPendingDesktopNotifications.add(normalized);
      }
    }
    this.projects = options.projects;
  }

  listProjects(): Promise<ProjectSummary[]> {
    return Promise.resolve(this.projects.list());
  }

  async #discoverThreadProjects(threads: readonly Record<string, unknown>[]): Promise<void> {
    const candidateCwds = new Map<string, string>();
    for (const thread of threads) {
      const cwd = asString(thread.cwd);
      if (
        cwd === undefined ||
        asString(thread.parentThreadId) !== undefined ||
        this.projects.findIdByCwd(cwd) ||
        this.#isGeneralConversationRoot(cwd)
      ) {
        continue;
      }
      const cwdKey = windowsPathKey(cwd);
      if (cwdKey !== undefined) {
        candidateCwds.set(cwdKey, cwd);
      }
    }
    const discovered = await Promise.all(
      [...candidateCwds.values()].map(async (cwd) => await safeThreadProject(cwd)),
    );
    for (const project of discovered) {
      if (
        project !== undefined &&
        !this.#isGeneralConversationRoot(project.root) &&
        !this.projects.findIdByCwd(project.root)
      ) {
        this.projects.register(project);
      }
    }
  }

  async listModels(): Promise<ServiceResult<ModelOption[]>> {
    const rawModels: Record<string, unknown>[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let truncated = false;
    for (let page = 0; page < 20; page += 1) {
      const response = asRecord(
        await this.#gateway.request("model/list", {
          ...(cursor === undefined ? {} : { cursor }),
          includeHidden: false,
          limit: 100,
        }),
      );
      rawModels.push(...asRecordArray(response.data));
      const nextCursor = asString(response.nextCursor);
      if (!nextCursor) {
        break;
      }
      if (seenCursors.has(nextCursor)) {
        truncated = true;
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      if (page === 19) {
        truncated = true;
      }
    }
    const models = rawModels
      .filter((model) => model.hidden !== true)
      .map((model) => {
        const description = asString(model.description);
        const defaultReasoningEffort = asReasoningEffort(model.defaultReasoningEffort);
        const defaultServiceTier = asString(model.defaultServiceTier);
        const serviceTiers = asRecordArray(model.serviceTiers)
          .map((tier) => {
            const id = asString(tier.id);
            const displayName = asString(tier.name);
            const tierDescription = asString(tier.description);
            if (!id || !displayName) {
              return undefined;
            }
            return {
              displayName,
              id,
              ...(tierDescription === undefined ? {} : { description: tierDescription }),
            };
          })
          .filter((tier): tier is NonNullable<typeof tier> => tier !== undefined);
        return {
          id: asString(model.model) ?? asString(model.id) ?? "",
          displayName:
            asString(model.displayName) ??
            asString(model.model) ??
            asString(model.id) ??
            "可用模型",
          supportedReasoningEfforts: asRecordArray(model.supportedReasoningEfforts)
            .map((option) => asReasoningEffort(option.reasoningEffort))
            .filter((effort): effort is ReasoningEffort => effort !== undefined),
          isDefault: model.isDefault === true,
          ...(description === undefined ? {} : { description }),
          ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
          ...(serviceTiers.length === 0 ? {} : { serviceTiers }),
          ...(defaultServiceTier === undefined ? {} : { defaultServiceTier }),
        };
      })
      .filter((model) => model.id.length > 0);
    const unique = [...new Map(models.map((model) => [model.id, model])).values()];
    return {
      data: unique,
      degradations: truncated
        ? [
            {
              code: "temporarily-unavailable",
              feature: "models",
              message: "可用模型较多，当前列表未能完整加载。",
            },
          ]
        : [],
    };
  }

  async listPermissionProfiles(
    options: { projectId?: string; threadId?: string } = {},
  ): Promise<ServiceResult<PermissionProfileOption[]>> {
    try {
      let cwd: string | undefined;
      if (options.threadId !== undefined) {
        requireNonEmpty(options.threadId, "对话 id");
        if (this.#managedThreads.has(options.threadId)) {
          await this.#ensureSharedThread(options.threadId);
        }
        const response = asRecord(
          await this.#gateway.request("thread/read", {
            includeTurns: false,
            threadId: options.threadId,
          }),
        );
        cwd = asString(asRecord(response.thread).cwd);
      } else if (options.projectId !== undefined) {
        cwd = await this.#requireAuthorizedProjectRoot(options.projectId);
      } else {
        cwd = this.#generalConversationRoot;
      }
      if (!cwd) {
        throw new Error("permission profile cwd unavailable");
      }

      const data: PermissionProfileOption[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const response = asRecord(
          await this.#gateway.request("permissionProfile/list", {
            ...(cursor === undefined ? {} : { cursor }),
            cwd,
            limit: 100,
          }),
        );
        for (const profile of asRecordArray(response.data)) {
          const id = asString(profile.id);
          if (!id || typeof profile.allowed !== "boolean") {
            continue;
          }
          const description = asString(profile.description);
          data.push({
            allowed: profile.allowed,
            id,
            ...(description === undefined ? {} : { description }),
          });
        }
        const nextCursor = asString(response.nextCursor);
        if (!nextCursor || nextCursor === cursor) {
          break;
        }
        cursor = nextCursor;
      }
      return {
        data: [...new Map(data.map((profile) => [profile.id, profile])).values()],
        degradations: [],
      };
    } catch {
      return {
        data: [],
        degradations: [
          {
            code: "feature-unavailable",
            feature: "permissions",
            message: "当前 Codex 暂未提供可选权限；消息和设置均未更改。",
          },
        ],
      };
    }
  }

  async listApprovalReviewers(): Promise<ServiceResult<ApprovalReviewerOption[]>> {
    try {
      const response = asRecord(await this.#gateway.request("configRequirements/read"));
      const requirements = asRecord(response.requirements);
      const reviewers = selectAllowedProtocolOptions(
        requirements.allowedApprovalsReviewers,
        this.#protocolApprovalReviewers,
      );
      const data = [...new Set(reviewers)].map((id) => ({ id }));
      if (data.length === 0) {
        throw new Error("approval reviewer catalog is empty");
      }
      return { data, degradations: [] };
    } catch {
      return {
        data: [],
        degradations: [
          {
            code: "feature-unavailable",
            feature: "approval-reviewer",
            message: "当前 Codex 没有公开可选的审批方式；不会发送猜测值，将沿用 Codex 当前设置。",
          },
        ],
      };
    }
  }

  async listApprovalPolicies(): Promise<ServiceResult<ApprovalPolicyOption[]>> {
    try {
      const response = asRecord(await this.#gateway.request("configRequirements/read"));
      const requirements = asRecord(response.requirements);
      const policies = selectAllowedProtocolOptions(
        requirements.allowedApprovalPolicies,
        this.#protocolApprovalPolicies,
      );
      const data = [...new Set(policies)].map((id) => ({ id }));
      if (data.length === 0) {
        throw new Error("approval policy catalog is empty");
      }
      return { data, degradations: [] };
    } catch {
      return {
        data: [],
        degradations: [
          {
            code: "feature-unavailable",
            feature: "approval-policy",
            message: "当前 Codex 没有公开可选的审批策略；不会发送猜测值，将沿用 Codex 当前设置。",
          },
        ],
      };
    }
  }

  async listCollaborationModes(): Promise<ServiceResult<CollaborationModeOption[]>> {
    try {
      const response = asRecord(await this.#gateway.request("collaborationMode/list", {}));
      const modes: CollaborationModeOption[] = [];
      for (const mode of asRecordArray(response.data)) {
        const id = asString(mode.name);
        if (id) {
          modes.push({
            available: true,
            displayName: collaborationDisplayName(id),
            id,
          });
        }
      }
      return { data: modes, degradations: [] };
    } catch {
      return {
        data: [],
        degradations: [collaborationUnavailable()],
      };
    }
  }

  async getUsage(threadId?: string): Promise<ServiceResult<UsageSnapshot>> {
    const updatedAt = new Date().toISOString();
    if (threadId !== undefined) {
      await this.#hydrateUsageContext(threadId);
    }
    const context = this.#usageContextFor(threadId);
    const [accountResult, rateLimitResult, tokenUsageResult] = await Promise.allSettled([
      this.#gateway.request("account/read", { refreshToken: false }),
      this.#gateway.request("account/rateLimits/read"),
      this.#gateway.request("account/usage/read"),
    ]);
    const degradations: ServiceDegradation[] = [];
    const account =
      accountResult.status === "fulfilled" ? asRecord(asRecord(accountResult.value).account) : {};
    if (accountResult.status === "rejected") {
      degradations.push(usageDegradation("暂时无法读取账户套餐信息。"));
    }

    let windows: UsageWindow[] = [];
    let credits: UsageCredits[] | undefined;
    if (rateLimitResult.status === "fulfilled") {
      const rateLimits = asRecord(rateLimitResult.value);
      windows = projectUsageWindows(rateLimits);
      credits = projectUsageCredits(rateLimits);
    } else {
      degradations.push(usageDegradation("暂时无法读取使用额度，请稍后刷新。"));
    }

    let tokenUsageSummary: AccountTokenUsageSummary | undefined;
    let dailyUsageBuckets: DailyTokenUsage[] | undefined;
    if (tokenUsageResult.status === "fulfilled") {
      const usage = asRecord(tokenUsageResult.value);
      tokenUsageSummary = projectAccountTokenUsageSummary(usage.summary);
      dailyUsageBuckets = projectDailyTokenUsage(usage.dailyUsageBuckets);
    } else {
      degradations.push(usageDegradation("累计与每日用量暂时不可用。"));
    }

    const plan = asString(account.planType);
    return {
      data: {
        updatedAt,
        windows,
        ...(plan === undefined ? {} : { plan }),
        ...(credits === undefined ? {} : { credits }),
        ...(tokenUsageSummary === undefined ? {} : { tokenUsageSummary }),
        ...(dailyUsageBuckets === undefined ? {} : { dailyUsageBuckets }),
        ...(context === undefined ? {} : { context }),
      },
      degradations,
    };
  }

  async listThreads(
    options: {
      archived?: boolean;
      cursor?: string;
      limit?: number;
      projectId?: string;
      searchTerm?: string;
    } = {},
  ): Promise<ThreadPage> {
    const includeActiveInventory =
      options.cursor === undefined &&
      options.archived !== true &&
      options.projectId === undefined &&
      options.searchTerm === undefined;
    if (includeActiveInventory && this.#sharedAppServer) {
      const inventoryRefresh = this.resubscribeSharedThreads().catch(() => undefined);
      await Promise.race([inventoryRefresh, delay(SHARED_INVENTORY_FAST_PATH_MS)]);
      // History remains usable while a large shared loaded-thread inventory
      // continues in the background. The next Web refresh merges the
      // authoritative active roots after reconciliation completes.
    }
    const baseParams: Record<string, unknown> = {
      archived: options.archived === true,
      limit: Math.min(Math.max(options.limit ?? 25, 1), 100),
      sortKey: "updated_at",
      sortDirection: "desc",
    };
    if (options.cursor) {
      baseParams.cursor = options.cursor;
    }
    if (options.searchTerm) {
      baseParams.searchTerm = options.searchTerm;
    }
    if (options.projectId) {
      baseParams.cwd = this.projects.requireRoot(options.projectId);
    }

    const rawThreads: Record<string, unknown>[] = [];
    let cursor = options.cursor;
    let nextCursor: string | undefined;
    const pageLimit = 1;
    for (let page = 0; page < pageLimit; page += 1) {
      const response = asRecord(
        await this.#gateway.request("thread/list", {
          ...baseParams,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      );
      rawThreads.push(...asRecordArray(response.data));
      nextCursor = asString(response.nextCursor);
      if (!nextCursor) {
        break;
      }
      cursor = nextCursor;
    }
    await this.#refreshPinnedThreadIds();
    if (
      options.cursor === undefined &&
      options.archived !== true &&
      options.projectId === undefined &&
      options.searchTerm === undefined &&
      this.#pinnedThreadRanks.size > 0
    ) {
      rawThreads.push(...(await this.#readMissingPinnedThreads(rawThreads)));
    }
    await this.#discoverThreadProjects(rawThreads);
    this.#historyTruncated = nextCursor !== undefined && !options.cursor;
    if (this.#historyTruncated) {
      this.#events?.append("diagnostic", {
        code: "history-truncated",
        message: "历史对话较多，可在对话页继续加载更早记录。",
      });
    }
    const uniqueThreads = new Map<string, Record<string, unknown>>();
    for (const thread of rawThreads) {
      const id = asString(thread.id);
      if (id && !uniqueThreads.has(id)) {
        uniqueThreads.set(id, thread);
      }
    }
    const listedThreadIds = new Set(uniqueThreads.keys());
    for (const thread of uniqueThreads.values()) {
      const threadId = asString(thread.id);
      if (threadId !== undefined) {
        this.#rememberUsageFromSource(threadId, thread);
        if (this.#sharedAppServer) {
          this.#rememberSharedThreadSnapshot(thread);
        }
      }
    }
    const activeRootIds = includeActiveInventory
      ? this.#activeTopLevelThreadIds()
      : new Set<string>();
    if (includeActiveInventory) {
      for (const [threadId, thread] of this.#sharedThreadSnapshots) {
        const rootThreadId = topLevelThreadId(threadId, this.#sharedThreadSnapshots);
        if (rootThreadId && activeRootIds.has(rootThreadId)) {
          uniqueThreads.set(threadId, thread);
        }
      }
    }
    const descendantCounts = descendantCountsByRoot(uniqueThreads);
    const data = [...uniqueThreads.values()]
      .filter((thread) => asString(thread.parentThreadId) === undefined)
      .filter((thread) => {
        const threadId = asString(thread.id);
        return (
          threadId !== undefined && (listedThreadIds.has(threadId) || activeRootIds.has(threadId))
        );
      })
      .map((thread) => {
        const threadId = asString(thread.id) ?? "";
        return {
          ...this.#projectTopLevelThreadSummary(
            thread,
            uniqueThreads,
            descendantCounts.get(threadId),
          ),
          archived: options.archived === true,
        };
      })
      .sort((left, right) => {
        if (left.pinnedRank !== undefined || right.pinnedRank !== undefined) {
          if (left.pinnedRank === undefined) return 1;
          if (right.pinnedRank === undefined) return -1;
          if (left.pinnedRank !== right.pinnedRank) {
            return left.pinnedRank - right.pinnedRank;
          }
        }
        return right.updatedAt.localeCompare(left.updatedAt);
      });
    return {
      data,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  get historyTruncated(): boolean {
    return this.#historyTruncated;
  }

  async resubscribeSharedThreads(): Promise<void> {
    if (!this.#sharedAppServer) {
      return;
    }
    if (this.#sharedInventoryRefreshPromise) {
      await this.#sharedInventoryRefreshPromise;
      return;
    }
    const refresh = this.#refreshSharedThreadInventory();
    this.#sharedInventoryRefreshPromise = refresh;
    try {
      await refresh;
    } finally {
      if (this.#sharedInventoryRefreshPromise === refresh) {
        this.#sharedInventoryRefreshPromise = undefined;
      }
    }
  }

  async #refreshSharedThreadInventory(): Promise<void> {
    const previouslyActiveThreadIds = new Set(this.#activeThreadIds);
    const loadedThreadIds = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LOADED_THREAD_PAGES; page += 1) {
      const response = asRecord(
        await this.#gateway.request("thread/loaded/list", {
          ...(cursor === undefined ? {} : { cursor }),
          limit: 100,
        }),
      );
      for (const entry of asRecordArray(response.data)) {
        const threadId = asString(entry.id);
        if (threadId) {
          loadedThreadIds.add(threadId);
        }
      }
      if (Array.isArray(response.data)) {
        for (const entry of response.data) {
          if (typeof entry === "string" && entry.trim()) {
            loadedThreadIds.add(entry);
          }
        }
      }
      const nextCursor = asString(response.nextCursor);
      if (!nextCursor || nextCursor === cursor) {
        break;
      }
      cursor = nextCursor;
    }
    this.#loadedThreadIds.clear();
    for (const threadId of loadedThreadIds) {
      this.#loadedThreadIds.add(threadId);
    }
    const threadIds = [...new Set([...loadedThreadIds, ...previouslyActiveThreadIds])];
    for (let offset = 0; offset < threadIds.length; offset += LOADED_THREAD_BACKFILL_BATCH_SIZE) {
      await Promise.allSettled(
        threadIds
          .slice(offset, offset + LOADED_THREAD_BACKFILL_BATCH_SIZE)
          .map(async (threadId) => {
            await this.#ensureSharedThread(threadId);
          }),
      );
    }
    await this.#hydrateSharedThreadAncestors(threadIds);
    await this.#promoteLoadedSharedRoots(loadedThreadIds);
    this.#publishTopLevelSnapshotsFor(
      new Set([...previouslyActiveThreadIds, ...this.#activeThreadIds, ...this.#loadedThreadIds]),
    );
  }

  async getThread(
    threadId: string,
    options: { historyCursor?: string; includeTurns?: boolean } = {},
  ): Promise<ThreadDetail> {
    requireNonEmpty(threadId, "对话 id");
    await this.#refreshPinnedThreadIds();
    if (this.#managedThreads.has(threadId)) {
      await this.#ensureSharedThread(threadId);
    } else if (this.#sharedAppServer && this.#loadedThreadIds.has(threadId)) {
      await this.#ensureSharedThread(threadId);
      await this.#hydrateSharedThreadAncestors([threadId]);
      await this.#promoteSharedTopLevelThread(threadId);
    }
    if (this.#isControllableThread(threadId) && this.#restoredThreadsNeedingRefresh.has(threadId)) {
      const restored = await this.#refreshRestoredThread(threadId);
      if (restored) {
        return this.#withControlState(restored);
      }
    }
    const response = await this.#readThreadForDisplay(
      threadId,
      options.includeTurns !== false,
      options.historyCursor,
    );
    const thread = asRecord(response.thread);
    if (!asString(thread.id)) {
      throw new DomainError("THREAD_NOT_FOUND", "找不到这个对话", 404);
    }
    this.#rememberRuntimeSettings(threadId, response);
    this.#rememberUsageFromSource(threadId, response);
    const projectId = this.#projectIdForCwd(thread.cwd);
    let detail = projectThreadDetail(thread, {
      directInputAvailable: this.#isDirectInputAvailable(threadId),
      managed: this.#isControllableThread(threadId),
      ...this.#pinnedProjectionOptions(threadId),
      ...this.#runtimeProjectionOptions(threadId),
      ...(projectId === undefined ? {} : { projectId }),
    });
    const historyNextCursor = asString(response.historyNextCursor);
    if (historyNextCursor !== undefined) {
      detail = { ...detail, historyNextCursor };
    }
    if (isInitialTurnSafelyTerminal(thread)) {
      void this.#notifyManagedThreadAfterInitialTurn(threadId);
    }
    if (this.#sharedAppServer) {
      detail = await this.#recoverSharedActiveTurn(detail);
      this.#markExistingActiveTurnUncontrollable(detail);
    }
    return this.#withControlState(detail);
  }

  async #readThreadForDisplay(
    threadId: string,
    includeTurns: boolean,
    historyCursor?: string,
  ): Promise<Record<string, unknown>> {
    if (!includeTurns) {
      return asRecord(
        await this.#gateway.request("thread/read", {
          includeTurns: false,
          threadId,
        }),
      );
    }

    if (
      this.#protocolClientMethods.has("thread/items/list") &&
      this.#protocolClientMethods.has("thread/turns/list")
    ) {
      try {
        const [shellResult, itemsResult, turnsResult] = await Promise.all([
          this.#gateway.request("thread/read", {
            includeTurns: false,
            threadId,
          }),
          this.#gateway.request("thread/items/list", {
            ...(historyCursor === undefined ? {} : { cursor: historyCursor }),
            limit: 160,
            sortDirection: "desc",
            threadId,
          }),
          this.#gateway.request("thread/turns/list", {
            itemsView: "summary",
            limit: 12,
            sortDirection: "desc",
            threadId,
          }),
        ]);
        const shell = asRecord(shellResult);
        const rawThread = asRecord(shell.thread);
        const itemPage = asRecord(itemsResult);
        const itemEntries = asRecordArray(itemPage.data).reverse();
        const turnSummaries = asRecordArray(asRecord(turnsResult).data).reverse();
        const itemsByTurn = new Map<string, unknown[]>();
        const orderedTurnIds: string[] = [];
        for (const entry of itemEntries) {
          const turnId = asString(entry.turnId);
          if (!turnId || entry.item === undefined) continue;
          let items = itemsByTurn.get(turnId);
          if (!items) {
            items = [];
            itemsByTurn.set(turnId, items);
            orderedTurnIds.push(turnId);
          }
          items.push(entry.item);
        }
        const summariesByTurn = new Map(
          turnSummaries.flatMap((turn) => {
            const turnId = asString(turn.id);
            return turnId ? [[turnId, turn] as const] : [];
          }),
        );
        for (const turn of turnSummaries) {
          const turnId = asString(turn.id);
          if (turnId && !itemsByTurn.has(turnId)) orderedTurnIds.push(turnId);
        }
        const recentTurns = [...new Set(orderedTurnIds)].map((turnId) => ({
          ...(summariesByTurn.get(turnId) ?? { id: turnId, status: "completed" }),
          id: turnId,
          items: itemsByTurn.get(turnId) ?? [],
        }));
        return {
          ...shell,
          ...(asString(itemPage.nextCursor) === undefined
            ? {}
            : { historyNextCursor: asString(itemPage.nextCursor) }),
          thread: {
            ...rawThread,
            turns: recentTurns,
          },
        };
      } catch (error) {
        if (historyCursor !== undefined) throw error;
        // A newly introduced item page may be temporarily unavailable even
        // when its schema is present. Fall through to bounded turn pages.
      }
    }

    if (historyCursor !== undefined) {
      throw new DomainError("FEATURE_UNAVAILABLE", "当前 Codex 版本暂时不能继续加载更早对话", 409);
    }

    if (!this.#protocolClientMethods.has("thread/turns/list")) {
      return asRecord(
        await this.#gateway.request("thread/read", {
          includeTurns: true,
          threadId,
        }),
      );
    }

    try {
      const [shellResult, turnsResult] = await Promise.all([
        this.#gateway.request("thread/read", {
          includeTurns: false,
          threadId,
        }),
        this.#gateway.request("thread/turns/list", {
          itemsView: "full",
          limit: 12,
          sortDirection: "desc",
          threadId,
        }),
      ]);
      const shell = asRecord(shellResult);
      const rawThread = asRecord(shell.thread);
      const recentTurns = asRecordArray(asRecord(turnsResult).data).reverse();
      return {
        ...shell,
        thread: {
          ...rawThread,
          turns: recentTurns,
        },
      };
    } catch {
      // Older or temporarily incompatible app-server builds keep the stable
      // full-read path. The protocol catalog is regenerated after upgrades, so
      // supported builds never pay the unbounded transcript cost on first load.
      return asRecord(
        await this.#gateway.request("thread/read", {
          includeTurns: true,
          threadId,
        }),
      );
    }
  }

  async reconcilePendingDesktopNotifications(): Promise<void> {
    if (this.#desktopReconciliationPromise) {
      await this.#desktopReconciliationPromise;
      return;
    }
    const reconciliation = this.#runDesktopNotificationReconciliation();
    this.#desktopReconciliationPromise = reconciliation;
    try {
      await reconciliation;
    } finally {
      if (this.#desktopReconciliationPromise === reconciliation) {
        this.#desktopReconciliationPromise = undefined;
      }
    }
  }

  async createThread(input: CreateThreadInput): Promise<ServiceResult<ThreadDetail>> {
    const prompt = requireNonEmpty(input.prompt, "消息");
    const cwd = await this.#requireNewThreadRoot(input.projectId);
    const turnInput = await this.#resolveTurnInput(prompt, input.attachments, input.projectId);
    if (input.permissionProfileId !== undefined && input.permissionMode !== undefined) {
      throw new DomainError("INVALID_INPUT", "动态权限和旧权限模式不能同时设置", 400);
    }
    if (input.permissionProfileId !== undefined) {
      const profiles = await this.listPermissionProfiles({
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      });
      const selected = profiles.data.find((profile) => profile.id === input.permissionProfileId);
      if (!selected?.allowed) {
        throw new DomainError("INVALID_INPUT", "这个权限已不可用；新对话尚未创建。", 409);
      }
    }
    if (input.approvalsReviewer !== undefined) {
      await this.#requireAvailableApprovalReviewer(input.approvalsReviewer);
    }
    if (input.approvalPolicy !== undefined) {
      await this.#requireAvailableApprovalPolicy(input.approvalPolicy);
    }
    const startParams: Record<string, unknown> = {
      cwd,
      threadSource: "codex-local-remote",
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
      ...(input.approvalsReviewer === undefined
        ? {}
        : { approvalsReviewer: input.approvalsReviewer }),
      ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
      ...(input.permissionProfileId === undefined
        ? permissionParams(input.permissionMode)
        : { permissions: input.permissionProfileId }),
    };
    const startResponse = asRecord(await this.#gateway.request("thread/start", startParams));
    const thread = asRecord(startResponse.thread);
    const threadId = asString(thread.id);
    if (!threadId) {
      throw new DomainError("THREAD_NOT_FOUND", "Codex 没有返回新对话", 502);
    }

    const degradations: ServiceDegradation[] = [];
    // Default is already the app-server's ordinary mode. Re-sending it as a
    // collaboration preset with a user-selected model makes Desktop label the
    // thread as "Custom" even though the turn really used that model.
    if (input.collaborationMode && input.collaborationMode.trim().toLowerCase() !== "default") {
      const degradation = await this.#configureCollaboration(
        threadId,
        input.collaborationMode,
        input.model ?? asString(startResponse.model),
        input.reasoningEffort,
      );
      if (degradation) {
        degradations.push(degradation);
      }
    }

    // thread/start only creates an idle shell. Recheck the registered directory
    // identity immediately before the first turn can perform filesystem work.
    await this.#requireNewThreadRoot(input.projectId);
    // Loading the same thread in Desktop while this app-server owns its first
    // turn can interrupt that turn. Persist visibility together with ownership
    // now, but open it only after a matching terminal state is observed.
    await this.#markManaged(
      threadId,
      !this.#sharedAppServer && this.#notifyManagedThreadCreated !== undefined,
    );
    this.#rememberDirectInput(threadId, thread);
    this.#rememberRuntimeSettings(threadId, startResponse);
    this.#rememberRuntimeSettings(threadId, {
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
      ...(input.permissionProfileId === undefined
        ? {}
        : { permissionProfileId: input.permissionProfileId }),
      ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
      ...(input.approvalsReviewer === undefined
        ? {}
        : { approvalsReviewer: input.approvalsReviewer }),
      ...(input.collaborationMode === undefined
        ? {}
        : { collaborationMode: input.collaborationMode }),
    });

    this.#pendingTurnStarts.add(threadId);
    let turnResponse: Record<string, unknown>;
    try {
      turnResponse = asRecord(
        await this.#gateway.request("turn/start", {
          threadId,
          input: turnInput,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.reasoningEffort === undefined ? {} : { effort: input.reasoningEffort }),
          ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
          ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
          ...(input.approvalsReviewer === undefined
            ? {}
            : { approvalsReviewer: input.approvalsReviewer }),
          ...(input.permissionProfileId === undefined
            ? {}
            : { permissions: input.permissionProfileId }),
        }),
      );
    } catch (error) {
      this.#turnStartsCompletedBeforeResponse.delete(threadId);
      if (this.#threadsAwaitingInitialTurnCompletion.has(threadId)) {
        this.#restoredPendingDesktopNotifications.add(threadId);
        await this.#discardPendingDesktopNotification(threadId);
      }
      throw error;
    } finally {
      this.#pendingTurnStarts.delete(threadId);
    }
    const turn = asRecord(turnResponse.turn);
    const turnId = asString(turn.id);
    const completedBeforeResponse = this.#consumeTurnCompletionBeforeResponse(threadId, turnId);
    if (turnId && !completedBeforeResponse) {
      this.#activeTurns.set(threadId, turnId);
      this.#orphanedActiveTurns.delete(threadId);
    }
    if (this.#sharedAppServer) {
      this.#sharedSubscribedThreads.add(threadId);
    }
    if (this.#sharedAppServer) {
      try {
        await this.#notifyManagedThreadCreated?.(threadId);
      } catch {
        // In shared mode turn/start is the persistence/subscription barrier.
        // Navigation remains best effort, but it must never run before the
        // Desktop connection can resume and hydrate the real running thread.
      }
    }
    const projectedThread = {
      ...thread,
      status: { type: "active", activeFlags: [] },
      turns: [...asRecordArray(thread.turns), turn],
    };

    return {
      data: projectThreadDetail(projectedThread, {
        directInputAvailable: this.#isDirectInputAvailable(threadId),
        managed: true,
        ...this.#pinnedProjectionOptions(threadId),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...this.#runtimeProjectionOptions(threadId),
      }),
      degradations,
    };
  }

  async #requireNewThreadRoot(projectId: string | undefined): Promise<string> {
    if (projectId === undefined) {
      if (!this.#generalConversationRoot) {
        throw new DomainError("INVALID_INPUT", "当前未配置无项目对话目录", 400);
      }
      return this.#generalConversationRoot;
    }
    return await this.#requireAuthorizedProjectRoot(projectId);
  }

  async #resolveTurnInput(
    prompt: string,
    attachments: readonly LocalInputReference[] | undefined,
    expectedProjectId: string | undefined,
  ): Promise<AppServerUserInput[]> {
    const input: AppServerUserInput[] = [textInput(prompt)];
    if (!attachments?.length) {
      return input;
    }
    if (!this.#resolveLocalInputReference) {
      throw new DomainError("FEATURE_UNAVAILABLE", "当前版本暂时不能添加文件或文件夹", 503);
    }
    if (attachments.length > 20) {
      throw new DomainError("INVALID_INPUT", "一次最多添加 20 个文件或文件夹", 400);
    }
    const seen = new Set<string>();
    for (const reference of attachments) {
      const projectReference =
        reference.projectId !== undefined && reference.uploadId === undefined;
      const uploadReference = reference.uploadId !== undefined && reference.projectId === undefined;
      if (
        (!projectReference && !uploadReference) ||
        (projectReference &&
          (expectedProjectId === undefined || reference.projectId !== expectedProjectId)) ||
        (uploadReference && reference.kind !== "file") ||
        (reference.kind !== "file" && reference.kind !== "directory") ||
        !reference.relativePath.trim() ||
        reference.relativePath.length > 32_768
      ) {
        throw new DomainError(
          "PROJECT_NOT_AUTHORIZED",
          projectReference && expectedProjectId === undefined
            ? "不关联项目的对话不能引用电脑文件"
            : "附件来源或路径无效",
          403,
        );
      }
      const key = `${reference.projectId ?? reference.uploadId}:${reference.kind}:${reference.relativePath.toLocaleLowerCase("en-US")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let resolved: ResolvedLocalInputReference;
      try {
        resolved = await this.#resolveLocalInputReference(reference);
      } catch {
        throw new DomainError(
          "PROJECT_NOT_AUTHORIZED",
          "附件已经移动、不可访问或不再属于当前项目",
          403,
        );
      }
      if (
        resolved.kind !== reference.kind ||
        !resolved.name.trim() ||
        resolved.name.length > 1_024 ||
        !path.win32.isAbsolute(resolved.path) ||
        resolved.path.length > 32_768
      ) {
        throw new DomainError("PROJECT_NOT_AUTHORIZED", "附件路径验证失败", 403);
      }
      input.push(
        resolved.kind === "file" && isImageAttachment(resolved.path)
          ? { path: resolved.path, type: "localImage" }
          : { name: resolved.name, path: resolved.path, type: "mention" },
      );
    }
    return input;
  }

  async #requireAuthorizedProjectRoot(projectId: string): Promise<string> {
    const registeredRoot = this.projects.requireRegisteredRoot(projectId);
    let authorizedRoot: string | undefined;
    try {
      authorizedRoot = await this.#resolveRegisteredProjectRoot(projectId);
    } catch {
      authorizedRoot = undefined;
    }
    const rootValidation = authorizedRoot
      ? validateSafeWindowsProjectRoot(authorizedRoot)
      : undefined;
    if (
      !rootValidation?.ok ||
      rootValidation.normalized.toLocaleLowerCase("en-US") !==
        registeredRoot.toLocaleLowerCase("en-US")
    ) {
      throw new DomainError(
        "PROJECT_NOT_AUTHORIZED",
        "项目目录已经变化，请在电脑本机重新登记后再继续",
        403,
      );
    }
    return rootValidation.normalized;
  }

  async resumeThread(threadId: string): Promise<ThreadDetail> {
    requireNonEmpty(threadId, "对话 id");
    if (this.#sharedAppServer) {
      try {
        await this.#ensureSharedThread(threadId);
      } catch (error) {
        throw sharedHistoryResumeError(error);
      }
      await this.#hydrateSharedThreadAncestors([threadId]);
      const snapshot = this.#sharedThreadSnapshots.get(threadId);
      if (asString(snapshot?.parentThreadId) !== undefined) {
        throw new DomainError(
          "THREAD_READ_ONLY",
          "子智能体由父任务控制，请先恢复它的父任务。",
          409,
        );
      }
      await this.#requireAuthorizedThreadProjectRoot(threadId);
      await this.#markManaged(threadId, false);
      return await this.getThread(threadId);
    }
    const response = asRecord(await this.#gateway.request("thread/resume", { threadId }));
    const thread = asRecord(response.thread);
    if (asString(thread.id) !== threadId) {
      throw new DomainError("THREAD_NOT_FOUND", "找不到这个对话", 404);
    }
    const projectId = this.#projectIdForCwd(thread.cwd);
    if (projectId === undefined && !this.#isGeneralConversationRoot(thread.cwd)) {
      throw new DomainError(
        "PROJECT_NOT_AUTHORIZED",
        "这个对话的项目尚未在电脑本机登记，暂时不能远程继续。",
        403,
      );
    }
    if (projectId !== undefined) {
      await this.#requireAuthorizedProjectRoot(projectId);
    }
    await this.#markManaged(threadId, false);
    this.#rememberDirectInput(threadId, thread);
    this.#rememberRuntimeSettings(threadId, response);
    const detail = projectThreadDetail(thread, {
      directInputAvailable: this.#isDirectInputAvailable(threadId),
      managed: true,
      ...this.#pinnedProjectionOptions(threadId),
      ...this.#runtimeProjectionOptions(threadId),
      ...(projectId === undefined ? {} : { projectId }),
    });
    this.#restoredThreadsNeedingRefresh.delete(threadId);
    this.#markExistingActiveTurnUncontrollable(detail);
    return this.#withControlState(detail);
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.#prepareManagedThread(threadId);
    await this.#gateway.request("thread/name/set", {
      threadId,
      name: requireNonEmpty(name, "对话名称"),
    });
  }

  async updateThreadSettings(threadId: string, input: ThreadSettingsInput): Promise<void> {
    await this.#prepareManagedThread(threadId);
    await this.#requireAuthorizedThreadProjectRoot(threadId);

    const params: Record<string, unknown> = { threadId };
    const model =
      input.model === undefined || input.model === null
        ? input.model
        : requireNonEmpty(input.model, "模型");
    const effort =
      input.reasoningEffort === undefined || input.reasoningEffort === null
        ? input.reasoningEffort
        : requireNonEmpty(input.reasoningEffort, "思考等级");
    if (input.model !== undefined) {
      params.model = model;
    }
    if (input.reasoningEffort !== undefined) {
      params.effort = effort;
    }
    if (input.serviceTier !== undefined) {
      params.serviceTier =
        input.serviceTier === null ? null : requireNonEmpty(input.serviceTier, "速度");
    }
    if (input.approvalPolicy !== undefined) {
      if (input.approvalPolicy === null) {
        params.approvalPolicy = null;
      } else {
        const approvalPolicy = requireNonEmpty(input.approvalPolicy, "审批策略");
        await this.#requireAvailableApprovalPolicy(approvalPolicy);
        params.approvalPolicy = approvalPolicy;
      }
    }
    if (input.approvalsReviewer !== undefined) {
      if (input.approvalsReviewer === null) {
        params.approvalsReviewer = null;
      } else {
        const approvalsReviewer = requireNonEmpty(input.approvalsReviewer, "审批方式");
        await this.#requireAvailableApprovalReviewer(approvalsReviewer);
        params.approvalsReviewer = approvalsReviewer;
      }
    }
    if (input.permissionProfileId !== undefined) {
      if (input.permissionProfileId === null) {
        params.permissions = null;
      } else {
        const permissionProfileId = requireNonEmpty(input.permissionProfileId, "权限");
        await this.#requireAvailablePermissionProfile(threadId, permissionProfileId);
        params.permissions = permissionProfileId;
      }
    }
    if (input.collaborationMode !== undefined) {
      const rememberedSettings = this.#runtimeProjectionOptions(threadId);
      params.collaborationMode =
        input.collaborationMode === null
          ? null
          : await this.#resolveCollaborationSettings(
              requireNonEmpty(input.collaborationMode, "协作模式"),
              model ??
                (typeof rememberedSettings.model === "string"
                  ? rememberedSettings.model
                  : undefined),
              effort ??
                (typeof rememberedSettings.reasoningEffort === "string"
                  ? rememberedSettings.reasoningEffort
                  : undefined),
            );
    }
    if (Object.keys(params).length === 1) {
      return;
    }

    try {
      await this.#gateway.request("thread/settings/update", params);
    } catch {
      throw new DomainError(
        "FEATURE_UNAVAILABLE",
        "当前 Codex 暂不支持这组下一轮设置；草稿和现有设置均未更改。",
        409,
      );
    }
    this.#rememberRuntimeSettings(threadId, {
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
      ...(input.permissionProfileId === undefined
        ? {}
        : { permissionProfileId: input.permissionProfileId }),
      ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
      ...(input.approvalsReviewer === undefined
        ? {}
        : { approvalsReviewer: input.approvalsReviewer }),
      ...(input.collaborationMode === undefined
        ? {}
        : { collaborationMode: input.collaborationMode }),
    });
  }

  async getThreadGoal(threadId: string): Promise<ThreadGoal | undefined> {
    await this.#prepareManagedThread(threadId);
    let response: Record<string, unknown>;
    try {
      response = asRecord(await this.#gateway.request("thread/goal/get", { threadId }));
    } catch {
      throw new DomainError("FEATURE_UNAVAILABLE", "当前 Codex 暂不支持目标功能。", 409);
    }
    if (response.goal === null || response.goal === undefined) {
      return undefined;
    }
    return projectThreadGoal(response.goal, threadId);
  }

  async setThreadGoal(threadId: string, input: SetThreadGoalInput): Promise<void> {
    await this.#prepareManagedThread(threadId);
    await this.#requireAuthorizedThreadProjectRoot(threadId);
    const objective = requireNonEmpty(input.objective, "目标");
    if (
      input.tokenBudget !== undefined &&
      (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget <= 0)
    ) {
      throw new DomainError("INVALID_INPUT", "目标额度必须是正整数", 400);
    }
    try {
      await this.#gateway.request("thread/goal/set", {
        threadId,
        objective,
        ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
      });
    } catch {
      throw new DomainError(
        "FEATURE_UNAVAILABLE",
        "当前 Codex 暂不支持设置目标；现有目标未更改。",
        409,
      );
    }
  }

  async clearThreadGoal(threadId: string): Promise<void> {
    await this.#prepareManagedThread(threadId);
    await this.#requireAuthorizedThreadProjectRoot(threadId);
    try {
      await this.#gateway.request("thread/goal/clear", { threadId });
    } catch {
      throw new DomainError(
        "FEATURE_UNAVAILABLE",
        "当前 Codex 暂不支持清除目标；现有目标未更改。",
        409,
      );
    }
  }

  async compactThread(threadId: string): Promise<void> {
    await this.#prepareManagedThread(threadId);
    const reservation = this.#reserveCompaction(threadId);
    try {
      await this.#refreshRestoredThread(threadId);
      this.#requireDirectInput(threadId);
      this.#assertTurnControlAvailable(threadId);
      await this.#requireAuthorizedThreadProjectRoot(threadId);
      const state = this.#compactingThreads.get(threadId);
      if (state !== reservation || state.phase !== "reserving") {
        throw new DomainError("TURN_MISMATCH", "上下文压缩已经结束，请刷新后重试", 409);
      }
      state.phase = "requested";
      await this.#gateway.request("thread/compact/start", { threadId });
    } catch (error) {
      if (this.#compactingThreads.get(threadId) === reservation) {
        this.#compactingThreads.delete(threadId);
      }
      throw error;
    }
  }

  async startTurn(threadId: string, input: SendTurnInput): Promise<TurnCommandResult> {
    await this.#prepareManagedThread(threadId);
    const prompt = requireNonEmpty(input.prompt, "消息");
    this.#reserveTurnStart(threadId);
    let response: Record<string, unknown>;
    try {
      await this.#refreshRestoredThread(threadId);
      this.#requireDirectInput(threadId);
      this.#assertTurnControlAvailable(threadId);
      const projectId = await this.#requireAuthorizedThreadProjectRoot(threadId);
      const turnInput = await this.#resolveTurnInput(prompt, input.attachments, projectId);
      if (input.permissionProfileId !== undefined) {
        await this.#requireAvailablePermissionProfile(threadId, input.permissionProfileId);
      }
      if (input.approvalsReviewer !== undefined) {
        await this.#requireAvailableApprovalReviewer(input.approvalsReviewer);
      }
      if (input.approvalPolicy !== undefined) {
        await this.#requireAvailableApprovalPolicy(input.approvalPolicy);
      }
      const rememberedSettings = this.#runtimeProjectionOptions(threadId);
      const collaborationMode =
        input.collaborationMode === undefined
          ? undefined
          : await this.#resolveCollaborationSettings(
              input.collaborationMode,
              input.model ??
                (typeof rememberedSettings.model === "string"
                  ? rememberedSettings.model
                  : undefined),
              input.reasoningEffort ??
                (typeof rememberedSettings.reasoningEffort === "string"
                  ? rememberedSettings.reasoningEffort
                  : undefined),
            );
      response = asRecord(
        await this.#gateway.request("turn/start", {
          threadId,
          input: turnInput,
          ...(input.clientUserMessageId === undefined
            ? {}
            : { clientUserMessageId: input.clientUserMessageId }),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.reasoningEffort === undefined ? {} : { effort: input.reasoningEffort }),
          ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
          ...(input.permissionProfileId === undefined
            ? {}
            : { permissions: input.permissionProfileId }),
          ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
          ...(input.approvalsReviewer === undefined
            ? {}
            : { approvalsReviewer: input.approvalsReviewer }),
          ...(collaborationMode === undefined ? {} : { collaborationMode }),
        }),
      );
    } catch (error) {
      this.#turnStartsCompletedBeforeResponse.delete(threadId);
      if (isBrokerTurnStartConflict(error)) {
        throw new DomainError(
          "TURN_MISMATCH",
          "Codex 仍在收尾当前回复，消息没有发送，请稍后重试",
          409,
        );
      }
      throw error;
    } finally {
      this.#pendingTurnStarts.delete(threadId);
    }
    const turnId = asString(asRecord(response.turn).id);
    if (!turnId) {
      this.#turnStartsCompletedBeforeResponse.delete(threadId);
      throw new DomainError("TURN_MISMATCH", "Codex 没有开始回复", 502);
    }
    const completedBeforeResponse = this.#consumeTurnCompletionBeforeResponse(threadId, turnId);
    this.#recentlyCompletedCompactionTurns.delete(threadId);
    if (!completedBeforeResponse) {
      this.#activeTurns.set(threadId, turnId);
      this.#orphanedActiveTurns.delete(threadId);
    }
    this.#rememberRuntimeSettings(threadId, {
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
      ...(input.permissionProfileId === undefined
        ? {}
        : { permissionProfileId: input.permissionProfileId }),
      ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
      ...(input.approvalsReviewer === undefined
        ? {}
        : { approvalsReviewer: input.approvalsReviewer }),
      ...(input.collaborationMode === undefined
        ? {}
        : { collaborationMode: input.collaborationMode }),
    });
    return { state: "running", threadId, turnId };
  }

  async reconcileClientUserMessage(
    threadId: string,
    clientUserMessageId: string,
  ): Promise<
    { state: "accepted"; turnId?: string } | { state: "active" | "absent-idle" | "unknown" }
  > {
    await this.#prepareManagedThread(threadId);
    const normalizedClientId = requireNonEmpty(clientUserMessageId, "消息标识");
    if (normalizedClientId.length > 512) {
      throw new DomainError("INVALID_INPUT", "消息标识无效", 400);
    }
    const response = asRecord(
      await this.#gateway.request("thread/read", { includeTurns: true, threadId }),
    );
    const thread = asRecord(response.thread);
    const turns = asRecordArray(thread.turns);
    for (const turn of turns) {
      const matched = asRecordArray(turn.items).some(
        (item) => item.type === "userMessage" && item.clientId === normalizedClientId,
      );
      if (matched) {
        const turnId = asString(turn.id);
        return {
          state: "accepted",
          ...(turnId === undefined ? {} : { turnId }),
        };
      }
    }
    const status = asString(asRecord(thread.status).type) ?? asString(thread.status);
    if (status === "active" || turns.some((turn) => turn.status === "inProgress")) {
      return { state: "active" };
    }
    if (status === "idle" || status === "systemError") {
      return { state: "absent-idle" };
    }
    return { state: "unknown" };
  }

  async #requireAuthorizedThreadProjectRoot(threadId: string): Promise<string | undefined> {
    const response = asRecord(
      await this.#gateway.request("thread/read", { includeTurns: false, threadId }),
    );
    const cwd = asRecord(response.thread).cwd;
    const projectId = this.projects.findIdByCwd(cwd);
    if (projectId) {
      await this.#requireAuthorizedProjectRoot(projectId);
      return projectId;
    }
    if (!this.#isGeneralConversationRoot(cwd)) {
      throw new DomainError(
        "PROJECT_NOT_AUTHORIZED",
        "这个对话的项目尚未在电脑本机登记，不能开始下一轮",
        403,
      );
    }
    return undefined;
  }

  async steerTurn(
    threadId: string,
    turnId: string,
    input: SteerTurnInput | string,
  ): Promise<TurnCommandResult> {
    await this.#prepareManagedThread(threadId);
    this.#assertNotCompacting(threadId);
    await this.#refreshRestoredThread(threadId);
    this.#requireDirectInput(threadId);
    this.#assertTurnControlAvailable(threadId);
    const steerInput = typeof input === "string" ? { prompt: input } : input;
    const projectId = await this.#requireAuthorizedThreadProjectRoot(threadId);
    const prompt = requireNonEmpty(steerInput.prompt, "补充消息");
    const turnInput = await this.#resolveTurnInput(prompt, steerInput.attachments, projectId);
    const activeTurn = this.#activeTurns.get(threadId);
    if (activeTurn !== turnId) {
      throw new DomainError("TURN_MISMATCH", "这个回复已经结束或已被替换", 409);
    }
    const response = asRecord(
      await this.#gateway.request("turn/steer", {
        expectedTurnId: turnId,
        input: turnInput,
        threadId,
      }),
    );
    return {
      state: "running",
      threadId,
      turnId: asString(response.turnId) ?? turnId,
    };
  }

  async interruptTurn(threadId: string, turnId: string): Promise<TurnCommandResult> {
    await this.#prepareManagedThread(threadId);
    this.#assertNotCompacting(threadId);
    await this.#refreshRestoredThread(threadId);
    this.#requireDirectInput(threadId);
    this.#assertTurnControlAvailable(threadId);
    if (this.#activeTurns.get(threadId) !== turnId) {
      throw new DomainError("TURN_MISMATCH", "这个回复已经结束或已被替换", 409);
    }
    await this.#gateway.request("turn/interrupt", { threadId, turnId });
    // The RPC only requests interruption. Keep the active turn authoritative
    // until app-server emits its terminal lifecycle event; otherwise another
    // browser can race a new turn into work that is still stopping.
    return { state: "running", threadId, turnId };
  }

  async listSubagents(
    threadId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<SubagentPage> {
    const cursorState = decodeSubagentCursor(options.cursor);
    const continuing = options.cursor !== undefined;
    let collections: {
      archived: { nextCursor?: string; threads: Record<string, unknown>[] };
      current: { nextCursor?: string; threads: Record<string, unknown>[] };
    };
    let ancestorFilterTrusted = true;
    try {
      collections = await this.#collectSubagentStreams(
        {
          ancestorThreadId: threadId,
        },
        options,
        cursorState,
        continuing,
      );
    } catch {
      ancestorFilterTrusted = false;
      collections = await this.#collectSubagentStreams({}, options, cursorState, continuing);
    }
    const snapshotDiscovery =
      !continuing && !this.#isControllableThread(threadId)
        ? await this.#discoverSnapshotSubagents(threadId)
        : { labels: new Map<string, string>(), threads: [] };
    const visibleThreads = [
      ...collections.current.threads,
      ...collections.archived.threads,
      ...snapshotDiscovery.threads,
    ];
    const byId = new Map(
      visibleThreads
        .map((thread) => [asString(thread.id), thread] as const)
        .filter((entry): entry is [string, Record<string, unknown>] => entry[0] !== undefined),
    );
    await this.#hydrateSubagentAncestors(threadId, visibleThreads, byId);
    const visibleById = new Map(
      visibleThreads
        .map((thread) => [asString(thread.id), thread] as const)
        .filter((entry): entry is [string, Record<string, unknown>] => entry[0] !== undefined),
    );
    const data = [...visibleById.values()]
      .filter(
        (thread) =>
          (ancestorFilterTrusted && asString(thread.id) !== threadId) ||
          isDescendantOf(thread, threadId, byId),
      )
      .map((thread) => {
        const id = asString(thread.id) ?? "";
        const parentThreadId = asString(thread.parentThreadId) ?? threadId;
        const summary = projectThreadSummary(thread, {
          managed: this.#isControllableThread(id),
        });
        return {
          depth: calculateDepth(thread, threadId, byId),
          isDirectlyControllable: this.#isControllableThread(id),
          parentThreadId,
          state: summary.state,
          threadId: id,
          title: snapshotDiscovery.labels.get(id) ?? summary.title,
          updatedAt: summary.updatedAt,
        };
      });
    const nextCursor = encodeSubagentCursor({
      ...(collections.current.nextCursor === undefined
        ? {}
        : { current: collections.current.nextCursor }),
      ...(collections.archived.nextCursor === undefined
        ? {}
        : { archived: collections.archived.nextCursor }),
    });
    return {
      data,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  async #hydrateSubagentAncestors(
    rootThreadId: string,
    visibleThreads: readonly Record<string, unknown>[],
    byId: Map<string, Record<string, unknown>>,
  ): Promise<void> {
    const pending = new Set<string>();
    const attempted = new Set<string>();
    for (const thread of visibleThreads) {
      const parentThreadId = asString(thread.parentThreadId);
      if (parentThreadId && parentThreadId !== rootThreadId && !byId.has(parentThreadId)) {
        pending.add(parentThreadId);
      }
    }

    while (pending.size > 0 && attempted.size < MAX_SUBAGENT_ANCESTOR_READS) {
      const batch = [...pending]
        .filter((threadId) => !attempted.has(threadId))
        .slice(0, SUBAGENT_ANCESTOR_READ_CONCURRENCY);
      if (batch.length === 0) {
        break;
      }
      for (const threadId of batch) {
        pending.delete(threadId);
        attempted.add(threadId);
      }
      const ancestors = await Promise.all(
        batch.map(async (threadId) => {
          try {
            const response = asRecord(
              await this.#gateway.request("thread/read", {
                includeTurns: false,
                threadId,
              }),
            );
            const thread = asRecord(response.thread);
            return asString(thread.id) === threadId ? thread : undefined;
          } catch {
            return undefined;
          }
        }),
      );
      for (const ancestor of ancestors) {
        if (!ancestor) {
          continue;
        }
        const ancestorId = asString(ancestor.id);
        if (!ancestorId) {
          continue;
        }
        byId.set(ancestorId, ancestor);
        const parentThreadId = asString(ancestor.parentThreadId);
        if (
          parentThreadId &&
          parentThreadId !== rootThreadId &&
          !byId.has(parentThreadId) &&
          !attempted.has(parentThreadId)
        ) {
          pending.add(parentThreadId);
        }
      }
    }
  }

  async #discoverSnapshotSubagents(
    rootThreadId: string,
  ): Promise<{ labels: Map<string, string>; threads: Record<string, unknown>[] }> {
    const labels = new Map<string, string>();
    const threads: Record<string, unknown>[] = [];
    const seen = new Set<string>([rootThreadId]);
    const frontier = [rootThreadId];

    for (let depth = 0; depth < 16 && frontier.length > 0 && seen.size <= 500; depth += 1) {
      const batch = frontier.splice(0, 32);
      const responses = await Promise.all(
        batch.map(async (threadId) => {
          try {
            const response = asRecord(
              await this.#gateway.request("thread/read", { includeTurns: true, threadId }),
            );
            const thread = asRecord(response.thread);
            return asString(thread.id) ? thread : undefined;
          } catch {
            return undefined;
          }
        }),
      );

      const next: string[] = [];
      for (const thread of responses) {
        if (!thread) continue;
        const id = asString(thread.id);
        if (id && id !== rootThreadId) {
          threads.push(thread);
        }
        for (const activity of subagentActivities(thread)) {
          if (activity.label) {
            labels.set(activity.threadId, activity.label);
          }
          if (!seen.has(activity.threadId) && seen.size < 500) {
            seen.add(activity.threadId);
            next.push(activity.threadId);
          }
        }
      }
      frontier.push(...next);
    }

    return { labels, threads };
  }

  async #collectSubagentStreams(
    filters: Record<string, unknown>,
    options: { cursor?: string; limit?: number },
    cursorState: SubagentCursorState,
    continuing: boolean,
  ): Promise<{
    archived: { nextCursor?: string; threads: Record<string, unknown>[] };
    current: { nextCursor?: string; threads: Record<string, unknown>[] };
  }> {
    const empty = { threads: [] };
    const [current, archived] = await Promise.all([
      continuing && cursorState.current === undefined
        ? Promise.resolve(empty)
        : this.#collectSubagentPages(
            { ...filters, archived: false },
            {
              ...(cursorState.current === undefined ? {} : { cursor: cursorState.current }),
              ...(options.limit === undefined ? {} : { limit: options.limit }),
            },
          ),
      continuing && cursorState.archived === undefined
        ? Promise.resolve(empty)
        : this.#collectSubagentPages(
            { ...filters, archived: true },
            {
              ...(cursorState.archived === undefined ? {} : { cursor: cursorState.archived }),
              ...(options.limit === undefined ? {} : { limit: options.limit }),
            },
          ),
    ]);
    return { archived, current };
  }

  async #collectSubagentPages(
    filters: Record<string, unknown>,
    options: { cursor?: string; limit?: number },
  ): Promise<{
    nextCursor?: string;
    threads: Record<string, unknown>[];
  }> {
    const response = asRecord(
      await this.#gateway.request("thread/list", {
        ...filters,
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        limit: Math.min(Math.max(options.limit ?? 100, 1), 100),
        sortKey: "updated_at",
        sortDirection: "desc",
      }),
    );
    const nextCursor = asString(response.nextCursor);
    return {
      threads: asRecordArray(response.data),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  handleNotification(notification: AppServerNotificationLike): void {
    const params = asRecord(notification.params);
    const notificationThread = asRecord(params.thread);
    const threadId = asString(params.threadId) ?? asString(notificationThread.id);
    if (
      threadId &&
      this.#sharedAppServer &&
      isSharedThreadLifecycleNotification(notification.method)
    ) {
      if (this.#applySharedThreadLifecycleNotification(threadId, notification)) {
        this.#publishTopLevelSnapshotsFor(new Set([threadId]));
        void this.#promoteSharedTopLevelThread(threadId)
          .then(() => {
            this.#publishTopLevelSnapshotsFor(new Set([threadId]));
          })
          .catch(() => {
            // A later loaded-thread census retries root promotion. Until then
            // the snapshot remains visible without unsafe controls.
          });
      } else {
        void this.#hydrateSharedThreadLifecycleNotification(threadId, notification).catch(() => {
          // A lifecycle notification may beat the rollout becoming readable.
          // The next loaded-thread census or notification retries hydration.
        });
      }
    }
    if (threadId && this.#sharedAppServer && notification.method === "thread/started") {
      this.#rememberRuntimeSettings(threadId, notificationThread);
      void this.#hydrateStartedThreadSnapshot(threadId).catch(() => {
        // A brand-new thread is announced before its rollout is durable. The
        // bounded retry lives in #ensureSharedThread. Until it succeeds, the
        // broadcast shell remains a read-only discovery row.
      });
    }
    if (
      threadId &&
      this.#isControllableThread(threadId) &&
      notification.method === "item/started" &&
      asString(asRecord(params.item).type) === "contextCompaction"
    ) {
      const turnId = asString(params.turnId);
      if (turnId) {
        const itemId = asString(asRecord(params.item).id);
        const existing = this.#compactingThreads.get(threadId);
        if (!existing || existing.phase === "reserving") {
          this.#compactingThreads.set(threadId, {
            ...(itemId === undefined ? {} : { itemId }),
            phase: "observed",
            turnId,
          });
        } else if (existing.phase === "requested" && existing.turnId === undefined) {
          existing.turnId = turnId;
        }
      }
    }
    if (
      threadId &&
      (notification.method === "item/started" || notification.method === "item/completed")
    ) {
      const compaction = this.#compactingThreads.get(threadId);
      const item = asRecord(params.item);
      const itemId = asString(item.id);
      const itemType = asString(item.type);
      const turnId = asString(params.turnId);
      const completedObservedCompaction =
        notification.method === "item/completed" &&
        itemType === "contextCompaction" &&
        (compaction?.itemId === undefined || compaction.itemId === itemId);
      const movedPastObservedCompaction =
        notification.method === "item/started" &&
        itemType !== undefined &&
        itemType !== "contextCompaction";
      if (
        compaction?.phase === "observed" &&
        compaction.turnId === turnId &&
        (completedObservedCompaction || movedPastObservedCompaction)
      ) {
        // Automatic compaction can run inside a still-active turn. Some
        // app-server versions omit item/completed for that internal item, but
        // the next item/started is authoritative proof that compaction itself
        // ended. Keep the turn active so steer/interrupt resume immediately.
        this.#compactingThreads.delete(threadId);
      }
    }
    if (threadId && notification.method === "turn/started") {
      const turnId = asString(asRecord(params.turn).id);
      if (turnId) {
        const compaction = this.#compactingThreads.get(threadId);
        if (compaction?.phase === "requested") {
          compaction.turnId = turnId;
        } else if (this.#isControllableThread(threadId) || this.#pendingTurnStarts.has(threadId)) {
          this.#recentlyCompletedCompactionTurns.delete(threadId);
          this.#activeTurns.set(threadId, turnId);
          this.#orphanedActiveTurns.delete(threadId);
        }
      }
    }
    if (threadId && notification.method === "turn/completed") {
      const completedTurnId = asString(asRecord(params.turn).id);
      if (this.#pendingTurnStarts.has(threadId) && completedTurnId) {
        const completedTurnIds =
          this.#turnStartsCompletedBeforeResponse.get(threadId) ?? new Set<string>();
        completedTurnIds.add(completedTurnId);
        this.#turnStartsCompletedBeforeResponse.set(threadId, completedTurnIds);
      }
      const compaction = this.#compactingThreads.get(threadId);
      if (compaction?.turnId && compaction.turnId === completedTurnId) {
        this.#compactingThreads.delete(threadId);
        this.#recentlyCompletedCompactionTurns.set(threadId, completedTurnId);
      }
      const activeTurnId = this.#activeTurns.get(threadId);
      if (completedTurnId === undefined || activeTurnId === completedTurnId) {
        this.#activeTurns.delete(threadId);
        this.#orphanedActiveTurns.delete(threadId);
      }
      if (this.#threadsAwaitingInitialTurnCompletion.has(threadId)) {
        void this.reconcilePendingDesktopNotifications();
      }
    }
    if (threadId && notification.method === "error" && params.willRetry === false) {
      const failedTurnId = asString(params.turnId);
      const compaction = this.#compactingThreads.get(threadId);
      if (
        compaction !== undefined &&
        (compaction.turnId === undefined ||
          failedTurnId === undefined ||
          compaction.turnId === failedTurnId)
      ) {
        this.#compactingThreads.delete(threadId);
        if (compaction.turnId) {
          this.#recentlyCompletedCompactionTurns.set(threadId, compaction.turnId);
        }
      }
    }
    if (threadId && notification.method === "thread/settings/updated") {
      this.#rememberRuntimeSettings(threadId, asRecord(params.threadSettings));
    }
    if (threadId && notification.method === "model/rerouted") {
      const toModel = asString(params.toModel);
      if (toModel) {
        this.#rememberRuntimeSettings(threadId, { model: toModel });
      }
    }
    if (threadId && notification.method === "thread/tokenUsage/updated") {
      this.#rememberUsageContext(threadId, params.tokenUsage);
    }
    if (!this.#events) {
      return;
    }
    for (const event of projectAppServerNotification(notification)) {
      if (
        this.#sharedAppServer &&
        event.type === "thread.snapshot" &&
        !this.#isTopLevelThreadSnapshot(event.payload)
      ) {
        continue;
      }
      this.#events.append(event.type, event.payload, {
        ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      });
    }
  }

  isManagedThread(threadId: string): boolean {
    return this.#isControllableThread(threadId);
  }

  handleBackendRestart(): void {
    this.#activeTurns.clear();
    this.#compactingThreads.clear();
    this.#directInputThreads.clear();
    this.#orphanedActiveTurns.clear();
    this.#pendingTurnStarts.clear();
    this.#turnStartsCompletedBeforeResponse.clear();
    this.#recentlyCompletedCompactionTurns.clear();
    this.#loadedThreadIds.clear();
    this.#sharedSubscribedThreads.clear();
    this.#sharedSubscriptionPromises.clear();
    this.#sharedInventoryRefreshPromise = undefined;
    for (const threadId of this.#threadsAwaitingInitialTurnCompletion) {
      this.#restoredPendingDesktopNotifications.add(threadId);
    }
    for (const threadId of this.#managedThreads) {
      this.#restoredThreadsNeedingRefresh.add(threadId);
    }
  }

  async #markManaged(threadId: string, desktopNotificationPending: boolean): Promise<void> {
    const alreadyManaged = this.#managedThreads.has(threadId);
    this.#managedThreads.add(threadId);
    try {
      await this.#persistManagedThread?.(threadId, { desktopNotificationPending });
      if (desktopNotificationPending) {
        this.#threadsAwaitingInitialTurnCompletion.add(threadId);
      }
      this.#restoredThreadsNeedingRefresh.delete(threadId);
    } catch (error) {
      if (!alreadyManaged) {
        this.#managedThreads.delete(threadId);
      }
      throw error;
    }
  }

  async #deliverPendingDesktopNotification(threadId: string): Promise<void> {
    try {
      await this.#notifyManagedThreadCreated?.(threadId);
      await this.#clearPendingDesktopNotification?.(threadId);
      this.#threadsAwaitingInitialTurnCompletion.delete(threadId);
      this.#restoredPendingDesktopNotifications.delete(threadId);
    } catch {
      // Keep the durable pending marker so a later bounded reconciliation can
      // retry. A host integration failure cannot invalidate the real thread.
    }
  }

  #notifyManagedThreadAfterInitialTurn(threadId: string): Promise<void> {
    const existing = this.#desktopNotificationAttempts.get(threadId);
    if (existing) {
      return existing;
    }
    if (
      !this.#threadsAwaitingInitialTurnCompletion.has(threadId) ||
      !this.#notifyManagedThreadCreated
    ) {
      return Promise.resolve();
    }
    const attempt = this.#deliverPendingDesktopNotification(threadId);
    this.#desktopNotificationAttempts.set(threadId, attempt);
    void attempt.finally(() => {
      if (this.#desktopNotificationAttempts.get(threadId) === attempt) {
        this.#desktopNotificationAttempts.delete(threadId);
      }
    });
    return attempt;
  }

  #consumeTurnCompletionBeforeResponse(threadId: string, turnId: string | undefined): boolean {
    const completedTurnIds = this.#turnStartsCompletedBeforeResponse.get(threadId);
    this.#turnStartsCompletedBeforeResponse.delete(threadId);
    return turnId !== undefined && completedTurnIds?.has(turnId) === true;
  }

  #discardPendingDesktopNotification(threadId: string): Promise<void> {
    const existing = this.#desktopNotificationAttempts.get(threadId);
    if (existing) {
      return existing;
    }
    if (!this.#threadsAwaitingInitialTurnCompletion.has(threadId)) {
      return Promise.resolve();
    }
    const attempt = (async () => {
      try {
        await this.#clearPendingDesktopNotification?.(threadId);
        this.#threadsAwaitingInitialTurnCompletion.delete(threadId);
        this.#restoredPendingDesktopNotifications.delete(threadId);
      } catch {
        // Retain the durable marker and retry on a later reconciliation.
      }
    })();
    this.#desktopNotificationAttempts.set(threadId, attempt);
    void attempt.finally(() => {
      if (this.#desktopNotificationAttempts.get(threadId) === attempt) {
        this.#desktopNotificationAttempts.delete(threadId);
      }
    });
    return attempt;
  }

  async #runDesktopNotificationReconciliation(): Promise<void> {
    if (!this.#notifyManagedThreadCreated) {
      return;
    }
    const candidates = [...this.#threadsAwaitingInitialTurnCompletion].slice(
      0,
      DESKTOP_RECONCILIATION_BATCH_SIZE,
    );
    for (const threadId of candidates) {
      try {
        const response = asRecord(
          await this.#gateway.request("thread/read", { includeTurns: true, threadId }),
        );
        const thread = asRecord(response.thread);
        const safelyTerminal = isInitialTurnSafelyTerminal(thread);
        const restoredWithPersistedItem =
          this.#restoredPendingDesktopNotifications.has(threadId) && hasPersistedTurnItem(thread);
        if (asString(thread.id) === threadId && (safelyTerminal || restoredWithPersistedItem)) {
          await this.#notifyManagedThreadAfterInitialTurn(threadId);
        } else if (
          asString(thread.id) === threadId &&
          this.#restoredPendingDesktopNotifications.has(threadId) &&
          isIdleThreadWithoutPersistedItem(thread)
        ) {
          await this.#discardPendingDesktopNotification(threadId);
        }
      } catch {
        // A later running-state reconciliation retries only the durable pending
        // IDs; historical managed threads are never opened.
      } finally {
        if (this.#threadsAwaitingInitialTurnCompletion.delete(threadId)) {
          this.#threadsAwaitingInitialTurnCompletion.add(threadId);
        }
      }
    }
  }

  async #refreshRestoredThread(threadId: string): Promise<ThreadDetail | undefined> {
    if (!this.#restoredThreadsNeedingRefresh.has(threadId)) {
      return undefined;
    }
    const response = asRecord(await this.#gateway.request("thread/resume", { threadId }));
    const thread = asRecord(response.thread);
    if (!asString(thread.id)) {
      throw new DomainError("THREAD_NOT_FOUND", "找不到这个对话", 404);
    }
    this.#rememberRuntimeSettings(threadId, response);
    this.#rememberDirectInput(threadId, thread);
    const projectId = this.#projectIdForCwd(thread.cwd);
    let detail = projectThreadDetail(thread, {
      directInputAvailable: this.#isDirectInputAvailable(threadId),
      managed: true,
      ...this.#pinnedProjectionOptions(threadId),
      ...this.#runtimeProjectionOptions(threadId),
      ...(projectId === undefined ? {} : { projectId }),
    });
    this.#restoredThreadsNeedingRefresh.delete(threadId);
    detail = await this.#recoverSharedActiveTurn(detail);
    this.#markExistingActiveTurnUncontrollable(detail);
    if (isInitialTurnSafelyTerminal(thread)) {
      void this.#notifyManagedThreadAfterInitialTurn(threadId);
    }
    return detail;
  }

  async #recoverSharedActiveTurn(detail: ThreadDetail): Promise<ThreadDetail> {
    if (
      !this.#sharedAppServer ||
      detail.activeTurnId !== undefined ||
      (detail.state !== "running" && detail.state !== "waiting-for-approval") ||
      !detail.availableActions.changeModelNextTurn
    ) {
      return detail;
    }

    let turnId = this.#activeTurns.get(detail.id);
    if (turnId === undefined) {
      try {
        const response = asRecord(
          await this.#gateway.request("thread/turns/list", {
            itemsView: "summary",
            limit: 1,
            sortDirection: "desc",
            threadId: detail.id,
          }),
        );
        const latest = asRecordArray(response.data).at(0);
        if (latest?.status === "inProgress") {
          turnId = asString(latest.id);
        }
      } catch {
        // Older Desktop/app-server versions may not expose paginated turns.
        // Keep the active task visible but fail closed instead of guessing an
        // expectedTurnId or accidentally starting a competing turn.
        return detail;
      }
    }
    if (turnId === undefined) {
      return detail;
    }
    return {
      ...detail,
      activeTurnId: turnId,
      availableActions: {
        ...detail.availableActions,
        interrupt: true,
        reply: false,
        steer: true,
      },
    };
  }

  #markExistingActiveTurnUncontrollable(detail: ThreadDetail): void {
    if (detail.activeTurnId) {
      if (this.#sharedAppServer) {
        this.#activeTurns.set(detail.id, detail.activeTurnId);
        this.#orphanedActiveTurns.delete(detail.id);
      } else {
        this.#activeTurns.delete(detail.id);
        this.#orphanedActiveTurns.add(detail.id);
      }
    } else {
      this.#activeTurns.delete(detail.id);
      this.#orphanedActiveTurns.delete(detail.id);
    }
  }

  #withControlState(detail: ThreadDetail): ThreadDetail {
    if (this.#compactingThreads.has(detail.id)) {
      return {
        ...detail,
        availableActions: {
          changeModelNextTurn: false,
          interrupt: false,
          reply: false,
          steer: false,
        },
      };
    }
    const recentlyCompletedCompaction = this.#recentlyCompletedCompactionTurns.get(detail.id);
    if (
      recentlyCompletedCompaction !== undefined &&
      detail.activeTurnId === recentlyCompletedCompaction
    ) {
      return {
        ...detail,
        availableActions: {
          changeModelNextTurn: false,
          interrupt: false,
          reply: false,
          steer: false,
        },
      };
    }
    if (recentlyCompletedCompaction !== undefined) {
      this.#recentlyCompletedCompactionTurns.delete(detail.id);
    }
    if (detail.activeTurnId && this.#activeTurns.get(detail.id) !== detail.activeTurnId) {
      this.#orphanedActiveTurns.add(detail.id);
      return {
        ...detail,
        availableActions: {
          changeModelNextTurn: false,
          interrupt: false,
          reply: false,
          steer: false,
        },
      };
    }
    return detail;
  }

  #assertTurnControlAvailable(threadId: string): void {
    if (this.#orphanedActiveTurns.has(threadId)) {
      throw new DomainError(
        "TURN_CONTROL_LOST",
        "这个回复在后台连接中断后仍显示为进行中，远程端不会贸然接管；请先在电脑端确认状态。",
        409,
      );
    }
  }

  #assertNotCompacting(threadId: string): void {
    if (this.#compactingThreads.has(threadId)) {
      throw new DomainError("TURN_MISMATCH", "正在压缩对话上下文，完成后才能继续操作", 409);
    }
  }

  #reserveCompaction(threadId: string): CompactionRuntimeState {
    if (
      this.#activeTurns.has(threadId) ||
      this.#pendingTurnStarts.has(threadId) ||
      this.#compactingThreads.has(threadId)
    ) {
      throw new DomainError("TURN_MISMATCH", "当前对话正在执行其他操作，请完成后再压缩上下文", 409);
    }
    this.#recentlyCompletedCompactionTurns.delete(threadId);
    const reservation: CompactionRuntimeState = { phase: "reserving" };
    this.#compactingThreads.set(threadId, reservation);
    return reservation;
  }

  #reserveTurnStart(threadId: string): void {
    if (
      this.#activeTurns.has(threadId) ||
      this.#pendingTurnStarts.has(threadId) ||
      this.#compactingThreads.has(threadId)
    ) {
      throw new DomainError("TURN_MISMATCH", "当前回复尚未结束或正在启动", 409);
    }
    this.#pendingTurnStarts.add(threadId);
  }

  #rememberDirectInput(threadId: string, thread: Record<string, unknown>): void {
    if (thread.canAcceptDirectInput === true) {
      this.#directInputThreads.add(threadId);
    } else {
      this.#directInputThreads.delete(threadId);
    }
  }

  #requireDirectInput(threadId: string): void {
    if (!this.#isDirectInputAvailable(threadId)) {
      throw new DomainError(
        "DIRECT_INPUT_UNAVAILABLE",
        "这个对话当前不能从远程端继续，请先在电脑端确认它已就绪。",
        409,
      );
    }
  }

  #isDirectInputAvailable(threadId: string): boolean {
    if (this.#sharedAppServer) {
      // A successful thread/resume through the shared Broker is the stable
      // control boundary. Newer Desktop builds may omit the legacy
      // canAcceptDirectInput hint or report a stale false value. Exact
      // subscription and turn ids still fail closed, and app-server remains
      // authoritative for actions that are genuinely unsupported.
      return this.#sharedSubscribedThreads.has(threadId);
    }
    return this.#directInputThreads.has(threadId);
  }

  #rememberRuntimeSettings(threadId: string, source: Record<string, unknown>): void {
    const current = this.#threadRuntimeSettings.get(threadId) ?? {};
    const next: ThreadRuntimeSettingsState = { ...current };
    const thread = asRecord(source.thread);
    if (Object.keys(thread).length > 0) {
      this.#applyRuntimeSettingsTree(next, thread);
    }
    this.#applyRuntimeSettingsTree(next, source);
    this.#threadRuntimeSettings.set(threadId, next);
  }

  #applyRuntimeSettingsTree(
    target: ThreadRuntimeSettingsState,
    source: Record<string, unknown>,
  ): void {
    const turn = preferredRuntimeSettingsSource(asRecordArray(source.turns));
    if (turn !== undefined) {
      this.#applyRuntimeSettingsFields(target, turn);
      this.#applyRuntimeSettingsFields(target, asRecord(turn.settings));
      this.#applyRuntimeSettingsFields(target, asRecord(turn.turnSettings));
    }
    this.#applyRuntimeSettingsFields(target, source);
    this.#applyRuntimeSettingsFields(target, asRecord(source.settings));
    this.#applyRuntimeSettingsFields(target, asRecord(source.threadSettings));
  }

  #applyRuntimeSettingsFields(
    target: ThreadRuntimeSettingsState,
    source: Record<string, unknown>,
  ): void {
    if (Object.hasOwn(source, "model")) {
      if (source.model === null) {
        target.model = null;
      } else {
        const model = boundedPlainString(source.model, 256);
        if (model !== undefined) {
          target.model = model;
        }
      }
    }
    const effortField = Object.hasOwn(source, "reasoningEffort")
      ? "reasoningEffort"
      : Object.hasOwn(source, "effort")
        ? "effort"
        : Object.hasOwn(source, "reasoning_effort")
          ? "reasoning_effort"
          : undefined;
    if (effortField !== undefined) {
      const rawEffort = source[effortField];
      if (rawEffort === null) {
        target.reasoningEffort = null;
      } else {
        const reasoningEffort = asReasoningEffort(rawEffort);
        if (reasoningEffort !== undefined) {
          target.reasoningEffort = reasoningEffort;
        }
      }
    }
    for (const field of ["serviceTier", "approvalPolicy", "approvalsReviewer"] as const) {
      if (!Object.hasOwn(source, field)) {
        continue;
      }
      if (source[field] === null) {
        target[field] = null;
      } else {
        const value = boundedPlainString(source[field], 256);
        if (value !== undefined) {
          target[field] = value;
        }
      }
    }
    const activePermissionProfile = asRecord(source.activePermissionProfile);
    const permissionProfileField = Object.hasOwn(source, "permissionProfileId")
      ? "permissionProfileId"
      : Object.hasOwn(source, "permissions")
        ? "permissions"
        : Object.hasOwn(source, "activePermissionProfile")
          ? "activePermissionProfile"
          : undefined;
    if (permissionProfileField !== undefined) {
      const rawPermission =
        permissionProfileField === "activePermissionProfile"
          ? activePermissionProfile.id
          : source[permissionProfileField];
      if (
        source[permissionProfileField] === null ||
        (permissionProfileField === "activePermissionProfile" &&
          source.activePermissionProfile === null)
      ) {
        target.permissionProfileId = null;
      } else {
        const permissionProfileId = boundedPlainString(rawPermission, 256);
        if (permissionProfileId !== undefined) {
          target.permissionProfileId = permissionProfileId;
        }
      }
    }
    if (Object.hasOwn(source, "collaborationMode")) {
      const rawMode = source.collaborationMode;
      if (rawMode === null) {
        target.collaborationMode = null;
      } else {
        const mode = asRecord(rawMode);
        const collaborationMode =
          boundedPlainString(rawMode, 256) ??
          boundedPlainString(mode.name, 256) ??
          boundedPlainString(mode.mode, 256);
        if (collaborationMode !== undefined) {
          target.collaborationMode = collaborationMode;
        }
      }
    }
  }

  #runtimeProjectionOptions(threadId: string): ThreadRuntimeSettingsState {
    return this.#threadRuntimeSettings.get(threadId) ?? {};
  }

  #rememberUsageContext(threadId: string, rawUsage: unknown): void {
    const usage = asRecord(rawUsage);
    const rawTotalTokens = asFiniteNumber(asRecord(usage.last).totalTokens);
    const rawLimitTokens = asFiniteNumber(usage.modelContextWindow);
    const totalTokens =
      rawTotalTokens !== undefined && rawTotalTokens >= 0 ? rawTotalTokens : undefined;
    const limitTokens =
      rawLimitTokens !== undefined && rawLimitTokens > 0 ? rawLimitTokens : undefined;
    if (totalTokens === undefined && limitTokens === undefined) {
      return;
    }
    const current = this.#usageContexts.get(threadId) ?? {};
    const usedTokens = totalTokens ?? current.usedTokens;
    const contextLimit = limitTokens ?? current.limitTokens;
    this.#usageContexts.set(threadId, {
      ...(usedTokens === undefined ? {} : { usedTokens }),
      ...(contextLimit === undefined ? {} : { limitTokens: contextLimit }),
      ...(usedTokens === undefined || contextLimit === undefined
        ? {}
        : { usedPercent: clampPercent((usedTokens / contextLimit) * 100) }),
    });
  }

  #rememberUsageFromSource(threadId: string, source: Record<string, unknown>): void {
    const records = [
      source,
      asRecord(source.thread),
      asRecord(source.extra),
      asRecord(asRecord(source.thread).extra),
    ];
    for (const record of [...records]) {
      records.push(...asRecordArray(record.turns));
    }
    for (const record of records) {
      if (Object.hasOwn(record, "tokenUsage")) {
        this.#rememberUsageContext(threadId, record.tokenUsage);
      }
      const usage = asRecord(record.usage);
      if (Object.hasOwn(usage, "last") || Object.hasOwn(usage, "modelContextWindow")) {
        this.#rememberUsageContext(threadId, usage);
      }
      const context = asRecord(record.context);
      const usedTokens = asFiniteNumber(context.usedTokens);
      const limitTokens = asFiniteNumber(context.limitTokens);
      if (
        (usedTokens !== undefined && usedTokens >= 0) ||
        (limitTokens !== undefined && limitTokens > 0)
      ) {
        this.#rememberUsageContext(threadId, {
          last: {
            ...(usedTokens === undefined || usedTokens < 0 ? {} : { totalTokens: usedTokens }),
          },
          ...(limitTokens === undefined || limitTokens <= 0
            ? {}
            : { modelContextWindow: limitTokens }),
        });
      }
    }
  }

  async #hydrateUsageContext(threadId: string): Promise<void> {
    let sessionPath: string | undefined;
    try {
      const response = asRecord(
        await this.#gateway.request("thread/read", {
          includeTurns: false,
          threadId,
        }),
      );
      this.#rememberUsageFromSource(threadId, response);
      sessionPath = asString(asRecord(response.thread).path) ?? asString(response.path);
    } catch {
      // Current app-server schemas do not guarantee persisted token usage on
      // thread/read. Absence stays unavailable rather than becoming a fake 0.
    }
    await this.#hydratePersistedUsageContext(threadId, sessionPath);
  }

  async #hydratePersistedUsageContext(
    threadId: string,
    sessionPath: string | undefined,
  ): Promise<void> {
    const current = this.#usageContexts.get(threadId);
    if (
      this.#readPersistedUsageContext === undefined ||
      (current?.usedTokens !== undefined && current.limitTokens !== undefined)
    ) {
      return;
    }
    try {
      const persisted = await this.#readPersistedUsageContext(threadId, sessionPath);
      if (persisted === undefined) {
        return;
      }
      this.#rememberUsageContext(threadId, {
        last: {
          ...(persisted.usedTokens === undefined ? {} : { totalTokens: persisted.usedTokens }),
        },
        ...(persisted.limitTokens === undefined
          ? {}
          : { modelContextWindow: persisted.limitTokens }),
      });
    } catch {
      // The local Desktop session is an optional read-only fallback. Protocol
      // usage remains authoritative and an unsafe or unreadable file stays unavailable.
    }
  }

  #usageContextFor(threadId: string | undefined): UsageSnapshot["context"] | undefined {
    if (threadId) {
      return this.#usageContexts.get(threadId);
    }
    return undefined;
  }

  async #configureCollaboration(
    threadId: string,
    collaborationMode: string,
    requestedModel?: string,
    requestedEffort?: ReasoningEffort,
  ): Promise<ServiceDegradation | undefined> {
    try {
      await this.#gateway.request("thread/settings/update", {
        threadId,
        collaborationMode: await this.#resolveCollaborationSettings(
          collaborationMode,
          requestedModel,
          requestedEffort,
        ),
      });
      return undefined;
    } catch {
      return collaborationUnavailable();
    }
  }

  async #resolveCollaborationSettings(
    collaborationMode: string,
    requestedModel?: string,
    requestedEffort?: ReasoningEffort,
  ): Promise<Record<string, unknown>> {
    const response = asRecord(await this.#gateway.request("collaborationMode/list", {}));
    const selected = asRecordArray(response.data).find(
      (mode) => asString(mode.name) === collaborationMode,
    );
    if (!selected) {
      throw new DomainError("INVALID_INPUT", "这个协作模式已不可用；设置和消息均未更改。", 409);
    }
    // The collaboration preset supplies defaults, but an explicit model or
    // effort chosen in the remote UI must remain authoritative. Otherwise a
    // preset can silently replace the user's visible next-turn settings.
    const model = requestedModel ?? asString(selected.model);
    if (!model) {
      throw new DomainError("INVALID_INPUT", "这个协作模式没有可用模型；设置和消息均未更改。", 409);
    }
    return {
      mode: asString(selected.mode) ?? "default",
      settings: {
        developer_instructions: null,
        model,
        reasoning_effort: requestedEffort ?? asReasoningEffort(selected.reasoning_effort) ?? null,
      },
    };
  }

  async #requireAvailablePermissionProfile(
    threadId: string,
    permissionProfileId: string,
  ): Promise<void> {
    const normalized = requireNonEmpty(permissionProfileId, "权限");
    const profiles = await this.listPermissionProfiles({ threadId });
    const selected = profiles.data.find((profile) => profile.id === normalized);
    if (!selected?.allowed) {
      throw new DomainError("INVALID_INPUT", "这个权限已不可用；设置和消息均未更改。", 409);
    }
  }

  async #requireAvailableApprovalReviewer(approvalReviewer: string): Promise<void> {
    const normalized = requireNonEmpty(approvalReviewer, "审批方式");
    const reviewers = await this.listApprovalReviewers();
    if (!reviewers.data.some((reviewer) => reviewer.id === normalized)) {
      throw new DomainError(
        "INVALID_INPUT",
        "这个审批方式未由当前 Codex 运行时声明；设置和消息均未更改。",
        409,
      );
    }
  }

  async #requireAvailableApprovalPolicy(approvalPolicy: string): Promise<void> {
    const normalized = requireNonEmpty(approvalPolicy, "审批策略");
    const policies = await this.listApprovalPolicies();
    if (!policies.data.some((policy) => policy.id === normalized)) {
      throw new DomainError(
        "INVALID_INPUT",
        "这个审批策略未由当前 Codex 运行时声明；设置和消息均未更改。",
        409,
      );
    }
  }

  #requireManagedThread(threadId: string): void {
    requireNonEmpty(threadId, "对话 id");
    if (!this.#isControllableThread(threadId)) {
      throw new DomainError(
        "THREAD_READ_ONLY",
        "这个桌面对话是只读快照；请先在手机端接管后再操作。",
        409,
      );
    }
  }

  async #prepareManagedThread(threadId: string): Promise<void> {
    requireNonEmpty(threadId, "对话 id");
    if (!this.#managedThreads.has(threadId)) {
      this.#requireManagedThread(threadId);
    }
    await this.#ensureSharedThread(threadId);
    this.#requireManagedThread(threadId);
  }

  #isControllableThread(threadId: string): boolean {
    if (!this.#managedThreads.has(threadId)) {
      return false;
    }
    if (!this.#sharedAppServer) {
      return true;
    }
    if (!this.#sharedSubscribedThreads.has(threadId)) {
      return false;
    }
    return asString(this.#sharedThreadSnapshots.get(threadId)?.parentThreadId) === undefined;
  }

  #rememberSharedThreadSnapshot(thread: Record<string, unknown>): void {
    const threadId = asString(thread.id);
    if (threadId === undefined) {
      return;
    }
    this.#sharedThreadSnapshots.set(threadId, thread);
    if (rawThreadIsActive(thread)) {
      this.#activeThreadIds.add(threadId);
    } else {
      this.#activeThreadIds.delete(threadId);
    }
  }

  #activeTopLevelThreadIds(): Set<string> {
    const rootThreadIds = new Set<string>();
    for (const threadId of this.#activeThreadIds) {
      const rootThreadId = topLevelThreadId(threadId, this.#sharedThreadSnapshots);
      if (rootThreadId !== undefined) {
        rootThreadIds.add(rootThreadId);
      }
    }
    return rootThreadIds;
  }

  #projectTopLevelThreadSummary(
    rootThread: Record<string, unknown>,
    byId: Map<string, Record<string, unknown>>,
    knownChildCount?: number,
  ): ThreadSummary {
    const rootThreadId = asString(rootThread.id) ?? "";
    const projectId = this.#projectIdForCwd(rootThread.cwd);
    const rootSummary = projectThreadSummary(rootThread, {
      managed: this.#isControllableThread(rootThreadId),
      ...this.#pinnedProjectionOptions(rootThreadId),
      ...this.#runtimeProjectionOptions(rootThreadId),
      ...(projectId === undefined ? {} : { projectId }),
    });
    let childCount = knownChildCount ?? 0;
    let hasWaitingDescendant = false;
    let hasRunningDescendant = false;
    let updatedAt = rootSummary.updatedAt;
    if (knownChildCount === undefined) {
      childCount = 0;
    }
    for (const [threadId, thread] of byId) {
      if (threadId === rootThreadId || !isDescendantOf(thread, rootThreadId, byId)) {
        continue;
      }
      if (knownChildCount === undefined) {
        childCount += 1;
      }
      const childSummary = projectThreadSummary(thread, {
        managed: this.#isControllableThread(threadId),
        ...this.#runtimeProjectionOptions(threadId),
      });
      hasWaitingDescendant ||= childSummary.state === "waiting-for-approval";
      hasRunningDescendant ||= childSummary.state === "running";
      if (childSummary.updatedAt > updatedAt) {
        updatedAt = childSummary.updatedAt;
      }
    }
    const state: ThreadSummary["state"] = hasWaitingDescendant
      ? "waiting-for-approval"
      : hasRunningDescendant
        ? "running"
        : rootSummary.state;
    return {
      ...rootSummary,
      state,
      updatedAt,
      ...(childCount > 0 ? { childCount } : {}),
    };
  }

  async #hydrateSharedThreadAncestors(seedThreadIds: Iterable<string>): Promise<void> {
    const queued = new Set<string>();
    const queue: string[] = [];
    const enqueueParent = (threadId: string): void => {
      const parentThreadId = asString(this.#sharedThreadSnapshots.get(threadId)?.parentThreadId);
      if (parentThreadId !== undefined && !queued.has(parentThreadId)) {
        queued.add(parentThreadId);
        queue.push(parentThreadId);
      }
    };
    for (const threadId of seedThreadIds) {
      queued.add(threadId);
      enqueueParent(threadId);
    }

    let hydratedCount = 0;
    while (queue.length > 0 && hydratedCount < MAX_SUBAGENT_ANCESTOR_READS) {
      const batch = queue.splice(
        0,
        Math.min(SUBAGENT_ANCESTOR_READ_CONCURRENCY, MAX_SUBAGENT_ANCESTOR_READS - hydratedCount),
      );
      hydratedCount += batch.length;
      const hydratedParents = await Promise.all(
        batch.map(async (parentThreadId): Promise<string | undefined> => {
          if (!this.#sharedSubscribedThreads.has(parentThreadId)) {
            try {
              await this.#ensureSharedThread(parentThreadId);
            } catch {
              // A historical ancestor may no longer be resumable. A metadata
              // read is still sufficient to fold its descendants correctly.
            }
          }
          if (!this.#sharedThreadSnapshots.has(parentThreadId)) {
            try {
              const response = asRecord(
                await this.#gateway.request("thread/read", {
                  includeTurns: false,
                  threadId: parentThreadId,
                }),
              );
              const thread = asRecord(response.thread);
              if (asString(thread.id) === parentThreadId) {
                this.#rememberRuntimeSettings(parentThreadId, response);
                this.#rememberUsageFromSource(parentThreadId, response);
                this.#rememberSharedThreadSnapshot(thread);
              }
            } catch {
              return undefined;
            }
          }
          return asString(this.#sharedThreadSnapshots.get(parentThreadId)?.parentThreadId);
        }),
      );
      for (const parentThreadId of hydratedParents) {
        if (parentThreadId !== undefined && !queued.has(parentThreadId)) {
          queued.add(parentThreadId);
          queue.push(parentThreadId);
        }
      }
    }
  }

  async #promoteLoadedSharedRoots(seedThreadIds: Iterable<string>): Promise<void> {
    const rootThreadIds = new Set<string>();
    for (const threadId of seedThreadIds) {
      const rootThreadId = topLevelThreadId(threadId, this.#sharedThreadSnapshots);
      if (rootThreadId !== undefined) {
        rootThreadIds.add(rootThreadId);
      }
    }
    for (const rootThreadId of rootThreadIds) {
      await this.#promoteSharedTopLevelThread(rootThreadId);
    }
  }

  async #promoteSharedTopLevelThread(threadId: string): Promise<string | undefined> {
    if (!this.#sharedAppServer) {
      return undefined;
    }
    const rootThreadId = topLevelThreadId(threadId, this.#sharedThreadSnapshots);
    if (rootThreadId === undefined) {
      return undefined;
    }
    await this.#ensureSharedThread(rootThreadId);
    const rootThread = this.#sharedThreadSnapshots.get(rootThreadId);
    if (
      rootThread === undefined ||
      asString(rootThread.parentThreadId) !== undefined ||
      !this.#sharedSubscribedThreads.has(rootThreadId)
    ) {
      return undefined;
    }
    await this.#markManaged(rootThreadId, false);
    return rootThreadId;
  }

  #publishTopLevelSnapshotsFor(threadIds: Iterable<string>): void {
    if (!this.#events) {
      return;
    }
    const rootThreadIds = new Set<string>();
    for (const threadId of threadIds) {
      const rootThreadId = topLevelThreadId(threadId, this.#sharedThreadSnapshots);
      if (rootThreadId !== undefined) {
        rootThreadIds.add(rootThreadId);
      }
    }
    const descendantCounts = descendantCountsByRoot(this.#sharedThreadSnapshots);
    for (const rootThreadId of rootThreadIds) {
      const rootThread = this.#sharedThreadSnapshots.get(rootThreadId);
      if (rootThread === undefined) {
        continue;
      }
      const snapshot = this.#projectTopLevelThreadSummary(
        rootThread,
        this.#sharedThreadSnapshots,
        descendantCounts.get(rootThreadId),
      );
      const signature = JSON.stringify(snapshot);
      if (this.#publishedThreadSnapshotSignatures.get(rootThreadId) === signature) {
        continue;
      }
      this.#publishedThreadSnapshotSignatures.set(rootThreadId, signature);
      this.#events.append("thread.snapshot", snapshot, { threadId: rootThreadId });
    }
  }

  #applySharedThreadLifecycleNotification(
    threadId: string,
    notification: AppServerNotificationLike,
  ): boolean {
    const current = this.#sharedThreadSnapshots.get(threadId);
    if (current === undefined) {
      return false;
    }
    const params = asRecord(notification.params);
    const next: Record<string, unknown> = { ...current };
    if (notification.method === "thread/status/changed") {
      if (!Object.hasOwn(params, "status")) {
        return false;
      }
      next.status = params.status;
    } else {
      const turn = asRecord(params.turn);
      const turnId = asString(turn.id);
      if (turnId === undefined) {
        return false;
      }
      const turns = [...asRecordArray(current.turns)];
      const existingTurnIndex = turns.findIndex((candidate) => asString(candidate.id) === turnId);
      if (existingTurnIndex >= 0) {
        turns[existingTurnIndex] = turn;
      } else {
        turns.push(turn);
      }
      next.turns = turns;
      if (notification.method === "turn/started") {
        next.status = {
          activeFlags: [],
          type: "active",
        };
      } else if (notification.method === "turn/completed") {
        next.status = turns.some((candidate) => candidate.status === "inProgress")
          ? { activeFlags: [], type: "active" }
          : { type: "idle" };
      } else {
        return false;
      }
    }
    this.#rememberSharedThreadSnapshot(next);
    return true;
  }

  async #hydrateSharedThreadLifecycleNotification(
    threadId: string,
    notification: AppServerNotificationLike,
  ): Promise<void> {
    await this.#ensureSharedThread(threadId);
    if (!this.#sharedThreadSnapshots.has(threadId)) {
      const response = asRecord(
        await this.#gateway.request("thread/read", {
          includeTurns: false,
          threadId,
        }),
      );
      const thread = asRecord(response.thread);
      if (asString(thread.id) !== threadId) {
        throw new DomainError("THREAD_NOT_FOUND", "找不到这个对话", 404);
      }
      this.#rememberRuntimeSettings(threadId, response);
      this.#rememberUsageFromSource(threadId, response);
      this.#rememberSharedThreadSnapshot(thread);
    }
    if (!this.#applySharedThreadLifecycleNotification(threadId, notification)) {
      return;
    }
    await this.#hydrateSharedThreadAncestors([threadId]);
    await this.#promoteSharedTopLevelThread(threadId);
    this.#publishTopLevelSnapshotsFor(new Set([threadId]));
  }

  #isTopLevelThreadSnapshot(payload: unknown): boolean {
    const snapshot = asRecord(payload);
    const threadId = asString(snapshot.id);
    if (threadId === undefined || asString(snapshot.parentThreadId) !== undefined) {
      return false;
    }
    return asString(this.#sharedThreadSnapshots.get(threadId)?.parentThreadId) === undefined;
  }

  async #hydrateStartedThreadSnapshot(threadId: string): Promise<void> {
    await this.#ensureSharedThread(threadId);
    const cachedThread = this.#sharedThreadSnapshots.get(threadId);
    const response =
      cachedThread === undefined
        ? asRecord(
            await this.#gateway.request("thread/read", {
              includeTurns: false,
              threadId,
            }),
          )
        : { thread: cachedThread };
    const thread = cachedThread ?? asRecord(response.thread);
    if (asString(thread.id) !== threadId) {
      throw new DomainError("THREAD_NOT_FOUND", "找不到这个对话", 404);
    }
    this.#rememberRuntimeSettings(threadId, response);
    this.#rememberUsageFromSource(threadId, response);
    this.#rememberSharedThreadSnapshot(thread);
    await this.#hydrateSharedThreadAncestors([threadId]);
    await this.#promoteSharedTopLevelThread(threadId);
    this.#publishTopLevelSnapshotsFor(new Set([threadId]));
  }

  async #ensureSharedThread(threadId: string): Promise<void> {
    if (!this.#sharedAppServer || this.#sharedSubscribedThreads.has(threadId)) {
      return;
    }
    const existing = this.#sharedSubscriptionPromises.get(threadId);
    if (existing) {
      await existing;
      return;
    }

    const subscription = this.#resumeSharedThread(threadId);
    this.#sharedSubscriptionPromises.set(threadId, subscription);
    try {
      await subscription;
    } finally {
      if (this.#sharedSubscriptionPromises.get(threadId) === subscription) {
        this.#sharedSubscriptionPromises.delete(threadId);
      }
    }
  }

  async #resumeSharedThread(threadId: string): Promise<void> {
    let lastError: unknown;
    for (const delayMs of this.#sharedResumeDelaysMs) {
      if (this.#sharedSubscribedThreads.has(threadId)) {
        return;
      }
      if (delayMs > 0) {
        await delay(delayMs);
      }
      try {
        const response = asRecord(
          await this.#gateway.request("thread/resume", {
            // Reconnect only needs a live subscription and metadata. Pulling
            // every historical turn here can produce tens-of-megabytes frames
            // for long Desktop conversations and repeatedly tear down the
            // shared transport before the Sidecar becomes usable.
            excludeTurns: true,
            threadId,
          }),
        );
        const resumedThread = asRecord(response.thread);
        if (asString(resumedThread.id) !== threadId) {
          throw new DomainError("THREAD_NOT_FOUND", "找不到这个对话", 404);
        }
        const readResponse = asRecord(
          await this.#gateway.request("thread/read", {
            includeTurns: false,
            threadId,
          }),
        );
        const thread = asRecord(readResponse.thread);
        if (asString(thread.id) !== threadId) {
          throw new DomainError("THREAD_NOT_FOUND", "找不到这个对话", 404);
        }
        this.#sharedSubscribedThreads.add(threadId);
        this.#rememberDirectInput(threadId, thread);
        this.#rememberRuntimeSettings(threadId, response);
        this.#rememberRuntimeSettings(threadId, readResponse);
        this.#rememberUsageFromSource(threadId, response);
        this.#rememberUsageFromSource(threadId, readResponse);
        this.#rememberSharedThreadSnapshot(thread);
        const projectId = this.#projectIdForCwd(thread.cwd);
        const detail = projectThreadDetail(thread, {
          directInputAvailable: this.#isDirectInputAvailable(threadId),
          managed: true,
          ...this.#pinnedProjectionOptions(threadId),
          ...this.#runtimeProjectionOptions(threadId),
          ...(projectId === undefined ? {} : { projectId }),
        });
        this.#restoredThreadsNeedingRefresh.delete(threadId);
        this.#markExistingActiveTurnUncontrollable(detail);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("暂时无法订阅共享对话");
  }

  async #refreshPinnedThreadIds(): Promise<void> {
    if (this.#listPinnedThreadIds === undefined) {
      return;
    }
    let threadIds: readonly string[] | undefined;
    try {
      threadIds = await this.#listPinnedThreadIds();
    } catch {
      return;
    }
    if (threadIds === undefined) {
      return;
    }
    const nextRanks = new Map<string, number>();
    for (const rawThreadId of threadIds) {
      if (typeof rawThreadId !== "string") {
        continue;
      }
      const threadId = rawThreadId.trim();
      if (threadId.length === 0 || threadId.length > 512 || nextRanks.has(threadId)) {
        continue;
      }
      nextRanks.set(threadId, nextRanks.size);
      if (nextRanks.size >= MAX_PINNED_THREAD_SUPPLEMENTS) {
        break;
      }
    }
    this.#pinnedThreadRanks.clear();
    for (const [threadId, rank] of nextRanks) {
      this.#pinnedThreadRanks.set(threadId, rank);
    }
  }

  async #readMissingPinnedThreads(
    listedThreads: readonly Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    const listedIds = new Set(
      listedThreads
        .map((thread) => asString(thread.id))
        .filter((threadId): threadId is string => threadId !== undefined),
    );
    const missingThreadIds = [...this.#pinnedThreadRanks.entries()]
      .sort((left, right) => left[1] - right[1])
      .map(([threadId]) => threadId)
      .filter((threadId) => !listedIds.has(threadId))
      .slice(0, MAX_PINNED_THREAD_SUPPLEMENTS);
    const snapshots: Array<Record<string, unknown> | undefined> = [];
    for (
      let offset = 0;
      offset < missingThreadIds.length;
      offset += PINNED_THREAD_READ_CONCURRENCY
    ) {
      const batch = missingThreadIds.slice(offset, offset + PINNED_THREAD_READ_CONCURRENCY);
      snapshots.push(
        ...(await Promise.all(
          batch.map(async (threadId): Promise<Record<string, unknown> | undefined> => {
            try {
              const response = asRecord(
                await this.#gateway.request("thread/read", {
                  includeTurns: false,
                  threadId,
                }),
              );
              const thread = asRecord(response.thread);
              return asString(thread.id) === threadId ? thread : undefined;
            } catch {
              return undefined;
            }
          }),
        )),
      );
    }
    return snapshots.filter((thread): thread is Record<string, unknown> => thread !== undefined);
  }

  #pinnedProjectionOptions(threadId: string): { pinnedRank?: number } {
    const pinnedRank = this.#pinnedThreadRanks.get(threadId);
    return pinnedRank === undefined ? {} : { pinnedRank };
  }

  #isGeneralConversationRoot(cwd: unknown): boolean {
    const cwdKey = windowsPathKey(cwd);
    if (cwdKey === undefined) return false;
    return (
      (this.#generalConversationRoot !== undefined &&
        cwdKey === windowsPathKey(this.#generalConversationRoot)) ||
      isNativeDesktopConversationRoot(cwdKey)
    );
  }

  #projectIdForCwd(cwd: unknown): string | undefined {
    const registeredProjectId = this.projects.findIdByCwd(cwd);
    if (registeredProjectId !== undefined) return registeredProjectId;
    return this.#isGeneralConversationRoot(cwd) ? undefined : undefined;
  }
}

function permissionParams(mode: PermissionMode | undefined): Record<string, unknown> {
  switch (mode) {
    case "read-only":
      return { approvalPolicy: "never", sandbox: "read-only" };
    case "workspace-write":
      return { approvalPolicy: "on-request", sandbox: "workspace-write" };
    case "ask":
      return { approvalPolicy: "untrusted", sandbox: "workspace-write" };
    default:
      return {};
  }
}

function sanitizeProtocolOptions(options: readonly string[] | undefined): readonly string[] {
  return [
    ...new Set(
      (options ?? []).filter(
        (option) =>
          typeof option === "string" &&
          option.length > 0 &&
          option.length <= 256 &&
          option.trim() === option,
      ),
    ),
  ];
}

function selectAllowedProtocolOptions(
  restrictions: unknown,
  protocolOptions: readonly string[],
): string[] {
  if (!Array.isArray(restrictions)) {
    return [...protocolOptions];
  }
  return [
    ...new Set(
      restrictions.filter(
        (option): option is string =>
          typeof option === "string" &&
          option.length > 0 &&
          option.length <= 256 &&
          option.trim() === option,
      ),
    ),
  ];
}

type AppServerUserInput =
  | { text: string; text_elements: []; type: "text" }
  | { name: string; path: string; type: "mention" }
  | { path: string; type: "localImage" };

function textInput(text: string): { text: string; text_elements: []; type: "text" } {
  return { text, text_elements: [], type: "text" };
}

function isImageAttachment(filePath: string): boolean {
  return /\.(?:avif|gif|jpe?g|png|webp)$/iu.test(filePath);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, milliseconds));
  });
}

function collaborationUnavailable(): ServiceDegradation {
  return {
    code: "feature-unavailable",
    feature: "collaboration-mode",
    message: "当前 Codex 版本不支持所选协作方式，已使用普通对话。",
  };
}

function usageDegradation(message: string): ServiceDegradation {
  return {
    code: "temporarily-unavailable",
    feature: "usage",
    message,
  };
}

function collaborationDisplayName(id: string): string {
  switch (id) {
    case "default":
      return "普通对话";
    case "plan":
      return "先规划再执行";
    default:
      return id;
  }
}

function usageRateLimitSnapshots(
  rateLimitsResponse: Record<string, unknown>,
): Array<[string, unknown]> {
  const byId = asRecord(rateLimitsResponse.rateLimitsByLimitId);
  return Object.keys(byId).length > 0
    ? Object.entries(byId).slice(0, 64)
    : [["codex", rateLimitsResponse.rateLimits]];
}

function projectUsageWindows(rateLimitsResponse: Record<string, unknown>): UsageWindow[] {
  const windows: UsageWindow[] = [];

  for (const [fallbackId, rawSnapshot] of usageRateLimitSnapshots(rateLimitsResponse)) {
    const snapshot = asRecord(rawSnapshot);
    const limitId = asString(snapshot.limitId) ?? fallbackId;
    const label = asString(snapshot.limitName) ?? "Codex";
    for (const [kind, rawWindow] of [
      ["primary", snapshot.primary],
      ["secondary", snapshot.secondary],
    ] as const) {
      const window = asRecord(rawWindow);
      const usedPercent = asFiniteNumber(window.usedPercent);
      if (usedPercent === undefined) {
        continue;
      }
      const resetsAt = asFiniteNumber(window.resetsAt);
      windows.push({
        id: `${limitId}-${kind}`,
        label: kind === "primary" ? `${label} · 当前周期` : `${label} · 较长周期`,
        usedPercent: clampPercent(usedPercent),
        remainingPercent: clampPercent(100 - usedPercent),
        ...(resetsAt === undefined ? {} : { resetsAt: new Date(resetsAt * 1_000).toISOString() }),
      });
    }
  }
  return windows;
}

function projectUsageCredits(rateLimitsResponse: Record<string, unknown>): UsageCredits[] {
  const result: UsageCredits[] = [];
  for (const [fallbackId, rawSnapshot] of usageRateLimitSnapshots(rateLimitsResponse)) {
    const snapshot = asRecord(rawSnapshot);
    const credits = asRecord(snapshot.credits);
    if (typeof credits.hasCredits !== "boolean" || typeof credits.unlimited !== "boolean") {
      continue;
    }
    const id =
      boundedPlainString(snapshot.limitId, 128) ?? boundedPlainString(fallbackId, 128) ?? "codex";
    const label = boundedPlainString(snapshot.limitName, 256) ?? "Codex";
    const balance = boundedPlainString(credits.balance, 128);
    result.push({
      id,
      label,
      hasCredits: credits.hasCredits,
      unlimited: credits.unlimited,
      ...(balance === undefined ? {} : { balance }),
    });
  }
  return result;
}

function projectAccountTokenUsageSummary(value: unknown): AccountTokenUsageSummary {
  const summary = asRecord(value);
  const lifetimeTokens = asUnsignedIntegerString(summary.lifetimeTokens);
  const peakDailyTokens = asUnsignedIntegerString(summary.peakDailyTokens);
  const longestRunningTurnSec = asSafeUnsignedInteger(summary.longestRunningTurnSec);
  const currentStreakDays = asSafeUnsignedInteger(summary.currentStreakDays);
  const longestStreakDays = asSafeUnsignedInteger(summary.longestStreakDays);
  return {
    ...(lifetimeTokens === undefined ? {} : { lifetimeTokens }),
    ...(peakDailyTokens === undefined ? {} : { peakDailyTokens }),
    ...(longestRunningTurnSec === undefined ? {} : { longestRunningTurnSec }),
    ...(currentStreakDays === undefined ? {} : { currentStreakDays }),
    ...(longestStreakDays === undefined ? {} : { longestStreakDays }),
  };
}

function projectDailyTokenUsage(value: unknown): DailyTokenUsage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return asRecordArray(value)
    .slice(0, 400)
    .flatMap((bucket) => {
      const startDate = boundedPlainString(bucket.startDate, 32);
      const tokens = asUnsignedIntegerString(bucket.tokens);
      return startDate && tokens ? [{ startDate, tokens }] : [];
    });
}

function projectThreadGoal(value: unknown, expectedThreadId: string): ThreadGoal {
  const goal = asRecord(value);
  const threadId = asString(goal.threadId);
  const objective = boundedPlainString(goal.objective, 16_384);
  const status = boundedPlainString(goal.status, 128);
  const tokensUsed = asSafeUnsignedInteger(goal.tokensUsed);
  const timeUsedSeconds = asSafeUnsignedInteger(goal.timeUsedSeconds);
  const createdAt = protocolTimestamp(goal.createdAt);
  const updatedAt = protocolTimestamp(goal.updatedAt);
  const tokenBudget =
    goal.tokenBudget === null || goal.tokenBudget === undefined
      ? undefined
      : asSafeUnsignedInteger(goal.tokenBudget);
  if (
    threadId !== expectedThreadId ||
    !objective ||
    !status ||
    tokensUsed === undefined ||
    timeUsedSeconds === undefined ||
    !createdAt ||
    !updatedAt ||
    (goal.tokenBudget !== null && goal.tokenBudget !== undefined && tokenBudget === undefined)
  ) {
    throw new DomainError("FEATURE_UNAVAILABLE", "当前 Codex 返回了不兼容的目标格式。", 502);
  }
  return {
    createdAt,
    objective,
    status,
    threadId,
    timeUsedSeconds,
    tokensUsed,
    updatedAt,
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
  };
}

function protocolTimestamp(value: unknown): string | undefined {
  const seconds = asFiniteNumber(value);
  if (seconds === undefined || seconds < 0) {
    return undefined;
  }
  try {
    return new Date(seconds * 1_000).toISOString();
  } catch {
    return undefined;
  }
}

function boundedPlainString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const clean = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint === 9 || (codePoint >= 32 && codePoint !== 127);
    })
    .join("")
    .trim();
  return clean.length === 0 ? undefined : clean.slice(0, maxLength);
}

function asUnsignedIntegerString(value: unknown): string | undefined {
  if (typeof value === "bigint") {
    return value >= 0n ? value.toString() : undefined;
  }
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return String(value);
  }
  if (typeof value === "string" && /^\d{1,64}$/u.test(value)) {
    return value.replace(/^0+(?=\d)/u, "");
  }
  return undefined;
}

function asSafeUnsignedInteger(value: unknown): number | undefined {
  const integer = asUnsignedIntegerString(value);
  if (!integer) {
    return undefined;
  }
  const parsed = Number(integer);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function calculateDepth(
  thread: Record<string, unknown>,
  rootThreadId: string,
  byId: Map<string, Record<string, unknown>>,
): number {
  let depth = 1;
  let parent = asString(thread.parentThreadId);
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    if (parent === rootThreadId) {
      return depth;
    }
    seen.add(parent);
    const parentThread = byId.get(parent);
    if (!parentThread) {
      break;
    }
    depth += 1;
    parent = asString(parentThread.parentThreadId);
  }
  return depth;
}

function preferredRuntimeSettingsSource(
  turns: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  const candidates = turns.filter((turn) => hasRuntimeSettings(turn));
  const active = candidates.filter((turn) => turn.status === "inProgress");
  return (active.length > 0 ? active : candidates).sort(compareRuntimeTurns).at(-1);
}

function hasRuntimeSettings(turn: Record<string, unknown>): boolean {
  return (
    hasDirectRuntimeSetting(turn) ||
    hasDirectRuntimeSetting(asRecord(turn.settings)) ||
    hasDirectRuntimeSetting(asRecord(turn.turnSettings))
  );
}

function hasDirectRuntimeSetting(source: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(source, "model") ||
    Object.hasOwn(source, "reasoningEffort") ||
    Object.hasOwn(source, "effort") ||
    Object.hasOwn(source, "reasoning_effort")
  );
}

function compareRuntimeTurns(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  const leftTimestamp =
    asFiniteNumber(left.startedAt) ??
    asFiniteNumber(left.createdAt) ??
    asFiniteNumber(left.completedAt) ??
    Number.NEGATIVE_INFINITY;
  const rightTimestamp =
    asFiniteNumber(right.startedAt) ??
    asFiniteNumber(right.createdAt) ??
    asFiniteNumber(right.completedAt) ??
    Number.NEGATIVE_INFINITY;
  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }
  return (asString(left.id) ?? "").localeCompare(asString(right.id) ?? "", "en-US");
}

function isDescendantOf(
  thread: Record<string, unknown>,
  ancestorThreadId: string,
  byId: Map<string, Record<string, unknown>>,
): boolean {
  let parent = asString(thread.parentThreadId);
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    if (parent === ancestorThreadId) {
      return true;
    }
    seen.add(parent);
    parent = asString(byId.get(parent)?.parentThreadId);
  }
  return false;
}

function topLevelThreadId(
  threadId: string,
  byId: Map<string, Record<string, unknown>>,
): string | undefined {
  let currentThreadId = threadId;
  const seen = new Set<string>();
  while (!seen.has(currentThreadId)) {
    seen.add(currentThreadId);
    const thread = byId.get(currentThreadId);
    if (thread === undefined) {
      return undefined;
    }
    const parentThreadId = asString(thread.parentThreadId);
    if (parentThreadId === undefined) {
      return currentThreadId;
    }
    currentThreadId = parentThreadId;
  }
  return undefined;
}

function descendantCountsByRoot(byId: Map<string, Record<string, unknown>>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const threadId of byId.keys()) {
    const rootThreadId = topLevelThreadId(threadId, byId);
    if (rootThreadId === undefined || rootThreadId === threadId) {
      continue;
    }
    counts.set(rootThreadId, (counts.get(rootThreadId) ?? 0) + 1);
  }
  return counts;
}

function rawThreadIsActive(thread: Record<string, unknown>): boolean {
  const status = asRecord(thread.status);
  return (
    (asString(status.type) ?? asString(thread.status)) === "active" ||
    asRecordArray(thread.turns).some((turn) => turn.status === "inProgress")
  );
}

function isSharedThreadLifecycleNotification(method: string): boolean {
  return (
    method === "thread/status/changed" || method === "turn/started" || method === "turn/completed"
  );
}

function subagentActivities(
  thread: Record<string, unknown>,
): Array<{ label?: string; threadId: string }> {
  const activities: Array<{ label?: string; threadId: string }> = [];
  for (const turn of asRecordArray(thread.turns)) {
    for (const item of asRecordArray(turn.items)) {
      if (item.type !== "subAgentActivity") continue;
      const threadId = asString(item.agentThreadId);
      if (!threadId) continue;
      const label = asString(item.agentPath);
      activities.push({ ...(label === undefined ? {} : { label }), threadId });
    }
  }
  return activities;
}

function decodeSubagentCursor(cursor: string | undefined): SubagentCursorState {
  if (cursor === undefined) {
    return {};
  }
  if (!cursor.startsWith(SUBAGENT_CURSOR_PREFIX)) {
    return { current: cursor };
  }
  try {
    const encoded = cursor.slice(SUBAGENT_CURSOR_PREFIX.length);
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("invalid cursor");
    }
    const record = value as Record<string, unknown>;
    const current = asString(record.current);
    const archived = asString(record.archived);
    if (
      (current === undefined && archived === undefined) ||
      (current !== undefined && current.length > 4_096) ||
      (archived !== undefined && archived.length > 4_096)
    ) {
      throw new Error("invalid cursor");
    }
    return {
      ...(current === undefined ? {} : { current }),
      ...(archived === undefined ? {} : { archived }),
    };
  } catch {
    throw new DomainError("INVALID_INPUT", "子智能体分页位置无效", 400);
  }
}

function encodeSubagentCursor(state: SubagentCursorState): string | undefined {
  if (state.current === undefined && state.archived === undefined) {
    return undefined;
  }
  return `${SUBAGENT_CURSOR_PREFIX}${Buffer.from(JSON.stringify(state), "utf8").toString(
    "base64url",
  )}`;
}

async function safeThreadProject(cwd: unknown): Promise<RegisteredProject | undefined> {
  const normalizedCwd = normalizeTrustedWindowsPath(cwd);
  if (normalizedCwd === undefined) {
    return undefined;
  }
  try {
    const canonical = await realpath(normalizedCwd);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory() || isDangerousDiscoveredRoot(canonical)) {
      return undefined;
    }
    const id = createHash("sha256")
      .update(canonical.toLocaleLowerCase("en-US"))
      .digest("hex")
      .slice(0, 16);
    return {
      id: `thread-${id}`,
      name: path.win32.basename(canonical),
      root: canonical,
      source: "thread",
    };
  } catch {
    return undefined;
  }
}

function normalizeTrustedWindowsPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 32_767) {
    return undefined;
  }
  let candidate = value;
  if (/^\\\\\?\\unc\\/iu.test(candidate)) {
    candidate = `\\\\${candidate.slice(8)}`;
  } else if (candidate.startsWith("\\\\?\\")) {
    candidate = candidate.slice(4);
  }
  const isDriveAbsolute = /^[A-Za-z]:[\\/]/u.test(candidate);
  const isUncAbsolute = /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(candidate);
  if (!path.win32.isAbsolute(candidate) || (!isDriveAbsolute && !isUncAbsolute)) {
    return undefined;
  }
  const normalized = path.win32.normalize(candidate);
  const root = path.win32.parse(normalized).root;
  return normalized.length > root.length ? normalized.replace(/[\\/]+$/u, "") : normalized;
}

function windowsPathKey(value: unknown): string | undefined {
  return normalizeTrustedWindowsPath(value)?.toLocaleLowerCase("en-US");
}

function isNativeDesktopConversationRoot(cwdKey: string): boolean {
  const desktopScratchRoot = windowsPathKey(path.win32.join(os.homedir(), "Documents", "Codex"));
  if (desktopScratchRoot === undefined) return false;
  const relation = path.win32.relative(desktopScratchRoot, cwdKey);
  if (
    relation.length === 0 ||
    path.win32.isAbsolute(relation) ||
    relation === ".." ||
    relation.startsWith(`..${path.win32.sep}`)
  ) {
    return false;
  }
  const segments = relation.split(/[\\/]/u).filter(Boolean);
  return segments.length === 2 && /^\d{4}-\d{2}-\d{2}$/u.test(segments[0] ?? "");
}

function isDangerousDiscoveredRoot(root: string): boolean {
  const rootValidation = validateSafeWindowsProjectRoot(root);
  if (!rootValidation.ok) {
    return true;
  }
  const normalized = rootValidation.normalized.toLocaleLowerCase("en-US");
  const driveRoot = path.win32.parse(normalized).root.toLocaleLowerCase("en-US");
  if (normalized === driveRoot) {
    return true;
  }
  const home = path.win32.resolve(os.homedir()).toLocaleLowerCase("en-US");
  const broadRoots = [
    home,
    path.win32.dirname(home),
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
  ]
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => path.win32.resolve(candidate).toLocaleLowerCase("en-US"));
  return broadRoots.includes(normalized);
}

function sharedHistoryResumeError(error: unknown): DomainError {
  if (error instanceof DomainError) {
    return error;
  }
  const message = error instanceof Error ? error.message : "";
  if (/Codex Desktop is not connected/iu.test(message)) {
    return new DomainError(
      "THREAD_READ_ONLY",
      "电脑上的 Codex Desktop 当前未连接，因此只能查看历史记录。",
      409,
    );
  }
  if (/Thread subscription barrier failed/iu.test(message)) {
    return new DomainError(
      "THREAD_READ_ONLY",
      "Desktop 未能同步加载这项历史任务，请保持 Desktop 打开后重试。",
      409,
    );
  }
  if (/no rollout found|thread.+not found|找不到.+对话/iu.test(message)) {
    return new DomainError(
      "THREAD_NOT_FOUND",
      "这项历史任务的本地运行记录暂时无法恢复，已有内容仍可查看。",
      404,
    );
  }
  return new DomainError(
    "THREAD_READ_ONLY",
    "当前 Codex 版本未能恢复这项历史任务，已有内容仍可查看。",
    409,
  );
}

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new DomainError("INVALID_INPUT", `${label}不能为空`, 400);
  }
  return trimmed;
}

function asReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= 64
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isBrokerTurnStartConflict(error: unknown): boolean {
  const record = asRecord(error);
  return record.code === -32_094 && (record.method === undefined || record.method === "turn/start");
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}

function isInitialTurnSafelyTerminal(thread: Record<string, unknown>): boolean {
  const status = asString(asRecord(thread.status).type) ?? asString(thread.status);
  if (status === "active") {
    return false;
  }
  switch (asString(asRecordArray(thread.turns).at(-1)?.status)) {
    case "cancelled":
    case "completed":
    case "failed":
    case "interrupted":
      return hasPersistedTurnItem(thread);
    default:
      return false;
  }
}

function hasPersistedTurnItem(thread: Record<string, unknown>): boolean {
  return asRecordArray(thread.turns).some(hasPersistedItemInTurn);
}

function isIdleThreadWithoutPersistedItem(thread: Record<string, unknown>): boolean {
  const status = asString(asRecord(thread.status).type) ?? asString(thread.status);
  return status === "idle" && !hasPersistedTurnItem(thread);
}

function hasPersistedItemInTurn(turn: Record<string, unknown>): boolean {
  return asRecordArray(turn.items).length > 0;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
