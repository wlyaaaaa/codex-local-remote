import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  AccountTokenUsageSummary,
  CollaborationModeOption,
  CreateThreadInput,
  DailyTokenUsage,
  ModelOption,
  PermissionMode,
  ProjectSummary,
  ReasoningEffort,
  SendTurnInput,
  SubagentSummary,
  ThreadDetail,
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
  feature: "collaboration-mode" | "usage" | "permissions" | "history" | "models";
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
    const rootKey = root.toLocaleLowerCase("en-US");
    const existing = [...this.#projects.values()].find(
      (candidate) => candidate.root.toLocaleLowerCase("en-US") === rootKey,
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
    if (typeof cwd !== "string" || cwd.length === 0) {
      return undefined;
    }
    const normalized = path.win32.resolve(cwd).toLocaleLowerCase("en-US");
    return [...this.#projects.values()].find(
      (project) => project.root.toLocaleLowerCase("en-US") === normalized,
    )?.id;
  }
}

export interface CodexDomainServiceOptions {
  events?: RemoteEventBuffer;
  gateway: AppServerGateway;
  managedThreadIds?: Iterable<string>;
  persistManagedThread?: (threadId: string) => Promise<void>;
  projects: ProjectRegistry;
  resolveRegisteredProjectRoot: (projectId: string) => Promise<string | undefined>;
}

export class CodexDomainService {
  readonly #events: RemoteEventBuffer | undefined;
  readonly #gateway: AppServerGateway;
  readonly #managedThreads = new Set<string>();
  readonly #persistManagedThread: ((threadId: string) => Promise<void>) | undefined;
  readonly #resolveRegisteredProjectRoot: (projectId: string) => Promise<string | undefined>;
  readonly #restoredThreadsNeedingRefresh = new Set<string>();
  readonly #activeTurns = new Map<string, string>();
  readonly #directInputThreads = new Set<string>();
  readonly #orphanedActiveTurns = new Set<string>();
  readonly #pendingTurnStarts = new Set<string>();
  #projectDiscoveryPromise: Promise<void> | undefined;
  #projectsDiscoveredAt = 0;
  readonly #threadRuntimeSettings = new Map<
    string,
    { model?: string; reasoningEffort?: ReasoningEffort }
  >();
  readonly #usageContexts = new Map<string, NonNullable<UsageSnapshot["context"]>>();
  #historyTruncated = false;
  readonly projects: ProjectRegistry;

  constructor(options: CodexDomainServiceOptions) {
    this.#events = options.events;
    this.#gateway = options.gateway;
    this.#persistManagedThread = options.persistManagedThread;
    this.#resolveRegisteredProjectRoot = options.resolveRegisteredProjectRoot;
    for (const threadId of options.managedThreadIds ?? []) {
      const normalized = threadId.trim();
      if (normalized) {
        this.#managedThreads.add(normalized);
        this.#restoredThreadsNeedingRefresh.add(normalized);
      }
    }
    this.projects = options.projects;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    if (Date.now() - this.#projectsDiscoveredAt >= 60_000) {
      this.#projectDiscoveryPromise ??= this.#discoverThreadProjects().finally(() => {
        this.#projectDiscoveryPromise = undefined;
      });
      await this.#projectDiscoveryPromise;
      this.#projectsDiscoveredAt = Date.now();
    }
    return this.projects.list();
  }

  async #discoverThreadProjects(): Promise<void> {
    for (const archived of [false, true]) {
      let cursor: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const response = asRecord(
          await this.#gateway.request("thread/list", {
            archived,
            ...(cursor === undefined ? {} : { cursor }),
            limit: 100,
            sortDirection: "desc",
            sortKey: "updated_at",
            sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
          }),
        );
        for (const thread of asRecordArray(response.data)) {
          if (asString(thread.parentThreadId)) {
            continue;
          }
          const project = await safeThreadProject(thread.cwd);
          if (!project || this.projects.findIdByCwd(project.root)) {
            continue;
          }
          this.projects.register(project);
        }
        cursor = asString(response.nextCursor);
        if (!cursor) {
          break;
        }
      }
    }
  }

  async listModels(): Promise<ServiceResult<ModelOption[]>> {
    const rawModels: Record<string, unknown>[] = [];
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
      cursor = asString(response.nextCursor);
      if (!cursor) {
        break;
      }
      if (page === 19) {
        truncated = true;
      }
    }
    const models = rawModels
      .filter((model) => model.hidden !== true)
      .map((model) => {
        const description = asString(model.description);
        const defaultReasoningEffort = asReasoningEffort(model.defaultReasoningEffort);
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
    const baseParams: Record<string, unknown> = {
      archived: options.archived === true,
      limit: Math.min(Math.max(options.limit ?? 100, 1), 100),
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
    const pageLimit = options.cursor ? 1 : 5;
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
    this.#historyTruncated = nextCursor !== undefined && !options.cursor;
    if (this.#historyTruncated) {
      this.#events?.append("diagnostic", {
        code: "history-truncated",
        message: "历史对话较多，当前最多显示最近 500 条。",
      });
    }
    const uniqueThreads = new Map<string, Record<string, unknown>>();
    for (const thread of rawThreads) {
      const id = asString(thread.id);
      if (id && !uniqueThreads.has(id)) {
        uniqueThreads.set(id, thread);
      }
    }
    const data = [...uniqueThreads.values()]
      .map((thread) => {
        const threadId = asString(thread.id) ?? "";
        const projectId = this.projects.findIdByCwd(thread.cwd);
        return {
          ...projectThreadSummary(thread, {
            managed: this.#managedThreads.has(threadId),
            ...this.#runtimeProjectionOptions(threadId),
            ...(projectId === undefined ? {} : { projectId }),
          }),
          archived: options.archived === true,
        };
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return {
      data,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  get historyTruncated(): boolean {
    return this.#historyTruncated;
  }

  async getThread(threadId: string): Promise<ThreadDetail> {
    requireNonEmpty(threadId, "对话 id");
    if (this.#managedThreads.has(threadId) && this.#restoredThreadsNeedingRefresh.has(threadId)) {
      const restored = await this.#refreshRestoredThread(threadId);
      if (restored) {
        return this.#withControlState(restored);
      }
    }
    const response = asRecord(
      await this.#gateway.request("thread/read", { includeTurns: true, threadId }),
    );
    const thread = asRecord(response.thread);
    if (!asString(thread.id)) {
      throw new DomainError("THREAD_NOT_FOUND", "找不到这个对话", 404);
    }
    this.#rememberRuntimeSettings(threadId, response);
    const projectId = this.projects.findIdByCwd(thread.cwd);
    return this.#withControlState(
      projectThreadDetail(thread, {
        managed: this.#managedThreads.has(threadId),
        ...this.#runtimeProjectionOptions(threadId),
        ...(projectId === undefined ? {} : { projectId }),
      }),
    );
  }

  async createThread(input: CreateThreadInput): Promise<ServiceResult<ThreadDetail>> {
    const prompt = requireNonEmpty(input.prompt, "消息");
    const cwd = await this.#requireAuthorizedProjectRoot(input.projectId);
    const startParams: Record<string, unknown> = {
      cwd,
      threadSource: "codex-local-remote",
      ...(input.model === undefined ? {} : { model: input.model }),
      ...permissionParams(input.permissionMode),
    };
    const startResponse = asRecord(await this.#gateway.request("thread/start", startParams));
    const thread = asRecord(startResponse.thread);
    const threadId = asString(thread.id);
    if (!threadId) {
      throw new DomainError("THREAD_NOT_FOUND", "Codex 没有返回新对话", 502);
    }

    const degradations: ServiceDegradation[] = [];
    if (input.collaborationMode) {
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
    await this.#requireAuthorizedProjectRoot(input.projectId);
    await this.#markManaged(threadId);
    this.#rememberDirectInput(threadId, thread);
    this.#rememberRuntimeSettings(threadId, startResponse);
    this.#rememberRuntimeSettings(threadId, {
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    });

    this.#pendingTurnStarts.add(threadId);
    let turnResponse: Record<string, unknown>;
    try {
      turnResponse = asRecord(
        await this.#gateway.request("turn/start", {
          threadId,
          input: [textInput(prompt)],
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.reasoningEffort === undefined ? {} : { effort: input.reasoningEffort }),
        }),
      );
    } finally {
      this.#pendingTurnStarts.delete(threadId);
    }
    const turn = asRecord(turnResponse.turn);
    const turnId = asString(turn.id);
    if (turnId) {
      this.#activeTurns.set(threadId, turnId);
      this.#orphanedActiveTurns.delete(threadId);
    }
    const projectedThread = {
      ...thread,
      status: { type: "active", activeFlags: [] },
      turns: [...asRecordArray(thread.turns), turn],
    };

    return {
      data: projectThreadDetail(projectedThread, {
        managed: true,
        projectId: input.projectId,
        ...this.#runtimeProjectionOptions(threadId),
      }),
      degradations,
    };
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
    this.#requireManagedThread(threadId);
    const response = asRecord(await this.#gateway.request("thread/resume", { threadId }));
    const thread = asRecord(response.thread);
    if (!asString(thread.id)) {
      throw new DomainError("THREAD_NOT_FOUND", "找不到这个对话", 404);
    }
    this.#rememberDirectInput(threadId, thread);
    this.#rememberRuntimeSettings(threadId, response);
    const projectId = this.projects.findIdByCwd(thread.cwd);
    const detail = projectThreadDetail(thread, {
      managed: true,
      ...this.#runtimeProjectionOptions(threadId),
      ...(projectId === undefined ? {} : { projectId }),
    });
    this.#restoredThreadsNeedingRefresh.delete(threadId);
    this.#markExistingActiveTurnUncontrollable(detail);
    return this.#withControlState(detail);
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    this.#requireManagedThread(threadId);
    await this.#gateway.request("thread/name/set", {
      threadId,
      name: requireNonEmpty(name, "对话名称"),
    });
  }

  async startTurn(threadId: string, input: SendTurnInput): Promise<TurnCommandResult> {
    this.#requireManagedThread(threadId);
    await this.#refreshRestoredThread(threadId);
    this.#requireDirectInput(threadId);
    this.#assertTurnControlAvailable(threadId);
    if (this.#activeTurns.has(threadId)) {
      throw new DomainError("TURN_MISMATCH", "当前回复尚未结束", 409);
    }
    await this.#requireAuthorizedThreadProjectRoot(threadId);
    this.#pendingTurnStarts.add(threadId);
    let response: Record<string, unknown>;
    try {
      response = asRecord(
        await this.#gateway.request("turn/start", {
          threadId,
          input: [textInput(requireNonEmpty(input.prompt, "消息"))],
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.reasoningEffort === undefined ? {} : { effort: input.reasoningEffort }),
        }),
      );
    } finally {
      this.#pendingTurnStarts.delete(threadId);
    }
    const turnId = asString(asRecord(response.turn).id);
    if (!turnId) {
      throw new DomainError("TURN_MISMATCH", "Codex 没有开始回复", 502);
    }
    this.#activeTurns.set(threadId, turnId);
    this.#orphanedActiveTurns.delete(threadId);
    this.#rememberRuntimeSettings(threadId, {
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    });
    return { state: "running", threadId, turnId };
  }

  async #requireAuthorizedThreadProjectRoot(threadId: string): Promise<void> {
    const response = asRecord(
      await this.#gateway.request("thread/read", { includeTurns: false, threadId }),
    );
    const projectId = this.projects.findIdByCwd(asRecord(response.thread).cwd);
    if (!projectId) {
      throw new DomainError(
        "PROJECT_NOT_AUTHORIZED",
        "这个对话的项目尚未在电脑本机登记，不能开始下一轮",
        403,
      );
    }
    await this.#requireAuthorizedProjectRoot(projectId);
  }

  async steerTurn(threadId: string, turnId: string, prompt: string): Promise<TurnCommandResult> {
    this.#requireManagedThread(threadId);
    await this.#refreshRestoredThread(threadId);
    this.#requireDirectInput(threadId);
    this.#assertTurnControlAvailable(threadId);
    const activeTurn = this.#activeTurns.get(threadId);
    if (activeTurn !== turnId) {
      throw new DomainError("TURN_MISMATCH", "这个回复已经结束或已被替换", 409);
    }
    const response = asRecord(
      await this.#gateway.request("turn/steer", {
        expectedTurnId: turnId,
        input: [textInput(requireNonEmpty(prompt, "补充消息"))],
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
    this.#requireManagedThread(threadId);
    await this.#refreshRestoredThread(threadId);
    this.#requireDirectInput(threadId);
    this.#assertTurnControlAvailable(threadId);
    if (this.#activeTurns.get(threadId) !== turnId) {
      throw new DomainError("TURN_MISMATCH", "这个回复已经结束或已被替换", 409);
    }
    await this.#gateway.request("turn/interrupt", { threadId, turnId });
    this.#activeTurns.delete(threadId);
    return { state: "idle", threadId, turnId };
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
      collections = await this.#collectSubagentStreams({}, options, cursorState, continuing);
    }
    const snapshotDiscovery =
      !continuing && !this.#managedThreads.has(threadId)
        ? await this.#discoverSnapshotSubagents(threadId)
        : { labels: new Map<string, string>(), threads: [] };
    const byId = new Map(
      [
        ...collections.current.threads,
        ...collections.archived.threads,
        ...snapshotDiscovery.threads,
      ]
        .map((thread) => [asString(thread.id), thread] as const)
        .filter((entry): entry is [string, Record<string, unknown>] => entry[0] !== undefined),
    );
    const threads = [...byId.values()];
    const data = threads
      .filter((thread) => isDescendantOf(thread, threadId, byId))
      .map((thread) => {
        const id = asString(thread.id) ?? "";
        const parentThreadId = asString(thread.parentThreadId) ?? threadId;
        const summary = projectThreadSummary(thread, {
          managed: this.#managedThreads.has(id),
        });
        return {
          depth: calculateDepth(thread, byId),
          isDirectlyControllable: this.#managedThreads.has(id),
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
    const threadId = asString(params.threadId);
    if (
      threadId &&
      notification.method === "turn/started" &&
      this.#pendingTurnStarts.has(threadId)
    ) {
      const turnId = asString(asRecord(params.turn).id);
      if (turnId) {
        this.#activeTurns.set(threadId, turnId);
      }
    }
    if (threadId && notification.method === "turn/completed") {
      this.#activeTurns.delete(threadId);
      this.#orphanedActiveTurns.delete(threadId);
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
      this.#events.append(event.type, event.payload, {
        ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
      });
    }
  }

  isManagedThread(threadId: string): boolean {
    return this.#managedThreads.has(threadId);
  }

  handleBackendRestart(): void {
    this.#activeTurns.clear();
    this.#directInputThreads.clear();
    this.#orphanedActiveTurns.clear();
    this.#pendingTurnStarts.clear();
    for (const threadId of this.#managedThreads) {
      this.#restoredThreadsNeedingRefresh.add(threadId);
    }
  }

  async #markManaged(threadId: string): Promise<void> {
    if (this.#managedThreads.has(threadId)) {
      this.#restoredThreadsNeedingRefresh.delete(threadId);
      return;
    }
    this.#managedThreads.add(threadId);
    try {
      await this.#persistManagedThread?.(threadId);
    } catch (error) {
      this.#managedThreads.delete(threadId);
      throw error;
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
    const projectId = this.projects.findIdByCwd(thread.cwd);
    const detail = projectThreadDetail(thread, {
      managed: true,
      ...this.#runtimeProjectionOptions(threadId),
      ...(projectId === undefined ? {} : { projectId }),
    });
    this.#restoredThreadsNeedingRefresh.delete(threadId);
    this.#markExistingActiveTurnUncontrollable(detail);
    return detail;
  }

  #markExistingActiveTurnUncontrollable(detail: ThreadDetail): void {
    if (detail.activeTurnId) {
      this.#activeTurns.delete(detail.id);
      this.#orphanedActiveTurns.add(detail.id);
    } else {
      this.#activeTurns.delete(detail.id);
      this.#orphanedActiveTurns.delete(detail.id);
    }
  }

  #withControlState(detail: ThreadDetail): ThreadDetail {
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

  #rememberDirectInput(threadId: string, thread: Record<string, unknown>): void {
    if (thread.canAcceptDirectInput === true) {
      this.#directInputThreads.add(threadId);
    } else {
      this.#directInputThreads.delete(threadId);
    }
  }

  #requireDirectInput(threadId: string): void {
    if (!this.#directInputThreads.has(threadId)) {
      throw new DomainError(
        "DIRECT_INPUT_UNAVAILABLE",
        "这个对话当前不能从远程端继续，请先在电脑端确认它已就绪。",
        409,
      );
    }
  }

  #rememberRuntimeSettings(threadId: string, source: Record<string, unknown>): void {
    const current = this.#threadRuntimeSettings.get(threadId) ?? {};
    const model = asString(source.model);
    const next: { model?: string; reasoningEffort?: ReasoningEffort } = { ...current };
    if (model !== undefined) {
      next.model = model;
    }
    const effortField = Object.hasOwn(source, "reasoningEffort")
      ? "reasoningEffort"
      : Object.hasOwn(source, "effort")
        ? "effort"
        : undefined;
    if (effortField !== undefined) {
      const rawEffort = source[effortField];
      if (rawEffort === null) {
        delete next.reasoningEffort;
      } else {
        const reasoningEffort = asReasoningEffort(rawEffort);
        if (reasoningEffort !== undefined) {
          next.reasoningEffort = reasoningEffort;
        }
      }
    }
    this.#threadRuntimeSettings.set(threadId, next);
  }

  #runtimeProjectionOptions(threadId: string): {
    model?: string;
    reasoningEffort?: ReasoningEffort;
  } {
    return this.#threadRuntimeSettings.get(threadId) ?? {};
  }

  #rememberUsageContext(threadId: string, rawUsage: unknown): void {
    const usage = asRecord(rawUsage);
    const totalTokens = asFiniteNumber(asRecord(usage.last).totalTokens);
    const limitTokens = asFiniteNumber(usage.modelContextWindow);
    if (totalTokens === undefined && limitTokens === undefined) {
      return;
    }
    this.#usageContexts.set(threadId, {
      ...(totalTokens === undefined ? {} : { usedTokens: totalTokens }),
      ...(limitTokens === undefined ? {} : { limitTokens }),
      ...(totalTokens === undefined || limitTokens === undefined || limitTokens <= 0
        ? {}
        : { usedPercent: clampPercent((totalTokens / limitTokens) * 100) }),
    });
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
      const response = asRecord(await this.#gateway.request("collaborationMode/list", {}));
      const selected = asRecordArray(response.data).find(
        (mode) => asString(mode.name) === collaborationMode,
      );
      if (!selected) {
        return collaborationUnavailable();
      }
      const model = asString(selected.model) ?? requestedModel;
      if (!model) {
        return collaborationUnavailable();
      }
      await this.#gateway.request("thread/settings/update", {
        threadId,
        collaborationMode: {
          mode: asString(selected.mode) ?? "default",
          settings: {
            model,
            reasoning_effort:
              asReasoningEffort(selected.reasoning_effort) ?? requestedEffort ?? null,
            developer_instructions: null,
          },
        },
      });
      return undefined;
    } catch {
      return collaborationUnavailable();
    }
  }

  #requireManagedThread(threadId: string): void {
    requireNonEmpty(threadId, "对话 id");
    if (!this.#managedThreads.has(threadId)) {
      throw new DomainError(
        "THREAD_READ_ONLY",
        "这个桌面对话是只读快照；请先在手机端接管后再操作。",
        409,
      );
    }
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

function textInput(text: string): { text: string; text_elements: []; type: "text" } {
  return { text, text_elements: [], type: "text" };
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
  byId: Map<string, Record<string, unknown>>,
): number {
  let depth = 1;
  let parent = asString(thread.parentThreadId);
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
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
  if (typeof cwd !== "string" || !/^[A-Za-z]:\\/u.test(cwd) || !path.win32.isAbsolute(cwd)) {
    return undefined;
  }
  try {
    const canonical = await realpath(cwd);
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

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
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
