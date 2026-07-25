import type {
  ApprovalRequest,
  ApprovalResolutionInput,
  AuthSession,
  CollaborationModeOption,
  CreateThreadInput,
  DiagnosticSnapshot,
  FileListing,
  ModelOption,
  ProjectSummary,
  PublicBootstrap,
  RemoteEvent,
  SendTurnInput,
  SteerTurnInput,
  SubagentSummary,
  ThreadDetail,
  ThreadSummary,
  UsageSnapshot,
} from "@codex-local-remote/contracts";
import {
  demoApprovals,
  demoBootstrap,
  demoCollaborationModes,
  demoDiagnostics,
  demoFiles,
  demoFileText,
  demoModels,
  demoProjects,
  demoSession,
  demoSubagents,
  demoThreadDetail,
  demoThreads,
  demoUnsafeThreadDetail,
  demoUsage,
} from "./demo";
import { nextCursorFrom, type CursorPage } from "./pagination";

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, status: number, code = "REQUEST_FAILED") {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.status = status;
  }
}

export interface ApiClient {
  readonly demo: boolean;
  bootstrap(): Promise<PublicBootstrap>;
  setup(password: string, confirmation: string): Promise<AuthSession>;
  login(password: string): Promise<AuthSession>;
  logout(): Promise<void>;
  session(): Promise<AuthSession>;
  projects(): Promise<ProjectSummary[]>;
  models(): Promise<ModelOption[]>;
  collaborationModes(): Promise<CollaborationModeOption[]>;
  threads(options?: { archived?: boolean; cursor?: string }): Promise<CursorPage<ThreadSummary>>;
  thread(id: string): Promise<ThreadDetail>;
  createThread(input: CreateThreadInput): Promise<ThreadDetail>;
  sendTurn(threadId: string, input: SendTurnInput): Promise<ThreadDetail>;
  steer(threadId: string, turnId: string, input: SteerTurnInput): Promise<void>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  subagents(threadId: string, cursor?: string): Promise<CursorPage<SubagentSummary>>;
  usage(threadId?: string): Promise<UsageSnapshot>;
  approvals(): Promise<ApprovalRequest[]>;
  resolveApproval(id: string, input: ApprovalResolutionInput): Promise<void>;
  files(projectId: string, path: string): Promise<FileListing>;
  preview(projectId: string, path: string): Promise<{ contentType: string; blob: Blob }>;
  downloadUrl(projectId: string, path: string): string;
  diagnostics(): Promise<DiagnosticSnapshot>;
  subscribe(
    onEvent: (event: RemoteEvent) => void,
    onConnection: (online: boolean) => void,
  ): () => void;
}

function initialApiRoot() {
  const base = new URL("./", document.baseURI);
  return new URL("api/v1", base).pathname.replace(/\/$/, "");
}

class HttpApiClient implements ApiClient {
  readonly demo = false;
  private apiRoot = initialApiRoot();
  private csrfToken: string | undefined;

  private updateBasePath(basePath: string) {
    const clean = basePath === "/" ? "" : basePath.replace(/\/$/, "");
    this.apiRoot = `${clean}/api/v1`;
  }

  private async request<T>(
    path: string,
    options: RequestInit & { mutation?: boolean; idempotent?: boolean } = {},
  ): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.mutation && this.csrfToken) headers.set("X-CSRF-Token", this.csrfToken);
    if (options.idempotent) headers.set("Idempotency-Key", crypto.randomUUID());

    let response: Response;
    try {
      response = await fetch(`${this.apiRoot}${path}`, {
        ...options,
        credentials: "same-origin",
        headers,
      });
    } catch {
      throw new ApiRequestError("无法连接到电脑，请检查网络后重试。", 0, "OFFLINE");
    }
    if (!response.ok) {
      const fallback = `请求失败（${response.status}）`;
      let message = fallback;
      let code = "REQUEST_FAILED";
      try {
        const payload = (await response.json()) as {
          error?: { code?: string; message?: string };
        };
        message = payload.error?.message ?? fallback;
        code = payload.error?.code ?? code;
      } catch {
        // Non-JSON errors are intentionally collapsed into a product-safe message.
      }
      throw new ApiRequestError(message, response.status, code);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async requestPage<T>(path: string): Promise<CursorPage<T>> {
    const response = await fetch(`${this.apiRoot}${path}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    }).catch(() => {
      throw new ApiRequestError("无法连接到电脑，请检查网络后重试。", 0, "OFFLINE");
    });
    if (!response.ok) {
      const fallback = `请求失败（${response.status}）`;
      let message = fallback;
      let code = "REQUEST_FAILED";
      try {
        const payload = (await response.json()) as {
          error?: { code?: string; message?: string };
        };
        message = payload.error?.message ?? fallback;
        code = payload.error?.code ?? code;
      } catch {
        // Non-JSON errors are intentionally collapsed into a product-safe message.
      }
      throw new ApiRequestError(message, response.status, code);
    }
    const items = (await response.json()) as T[];
    const nextCursor = nextCursorFrom(response.headers);
    return { items, ...(nextCursor ? { nextCursor } : {}) };
  }

  async bootstrap() {
    const result = await this.request<PublicBootstrap>("/bootstrap");
    this.updateBasePath(result.basePath);
    return result;
  }

  async setup(password: string, confirmation: string) {
    const result = await this.request<AuthSession>("/setup/password", {
      body: JSON.stringify({ password, confirmation }),
      idempotent: true,
      method: "POST",
      mutation: true,
    });
    this.csrfToken = result.csrfToken;
    return result;
  }

  async login(password: string) {
    const result = await this.request<AuthSession>("/auth/login", {
      body: JSON.stringify({ password }),
      idempotent: true,
      method: "POST",
      mutation: true,
    });
    this.csrfToken = result.csrfToken;
    return result;
  }

  async logout() {
    await this.request<void>("/auth/logout", { method: "POST", mutation: true });
    this.csrfToken = undefined;
  }

  async session() {
    const result = await this.request<AuthSession>("/auth/session");
    this.csrfToken = result.csrfToken;
    return result;
  }

  projects() {
    return this.request<ProjectSummary[]>("/projects");
  }

  models() {
    return this.request<ModelOption[]>("/models");
  }

  collaborationModes() {
    return this.request<CollaborationModeOption[]>("/collaboration-modes");
  }

  threads(options: { archived?: boolean; cursor?: string } = {}) {
    const query = new URLSearchParams({
      archived: String(options.archived ?? false),
      ...(options.cursor ? { cursor: options.cursor } : {}),
    });
    return this.requestPage<ThreadSummary>(`/threads?${query.toString()}`);
  }

  thread(id: string) {
    return this.request<ThreadDetail>(`/threads/${encodeURIComponent(id)}`);
  }

  createThread(input: CreateThreadInput) {
    return this.request<ThreadDetail>("/threads", {
      body: JSON.stringify(input),
      idempotent: true,
      method: "POST",
      mutation: true,
    });
  }

  sendTurn(threadId: string, input: SendTurnInput) {
    return this.request<ThreadDetail>(`/threads/${encodeURIComponent(threadId)}/turns`, {
      body: JSON.stringify(input),
      idempotent: true,
      method: "POST",
      mutation: true,
    });
  }

  steer(threadId: string, turnId: string, input: SteerTurnInput) {
    return this.request<void>(
      `/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/steer`,
      {
        body: JSON.stringify(input),
        idempotent: true,
        method: "POST",
        mutation: true,
      },
    );
  }

  interrupt(threadId: string, turnId: string) {
    return this.request<void>(
      `/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/interrupt`,
      { idempotent: true, method: "POST", mutation: true },
    );
  }

  subagents(threadId: string, cursor?: string) {
    const query = cursor ? `?${new URLSearchParams({ cursor }).toString()}` : "";
    return this.requestPage<SubagentSummary>(
      `/threads/${encodeURIComponent(threadId)}/subagents${query}`,
    );
  }

  usage(threadId?: string) {
    const query = threadId ? `?${new URLSearchParams({ threadId }).toString()}` : "";
    return this.request<UsageSnapshot>(`/usage${query}`);
  }

  approvals() {
    return this.request<ApprovalRequest[]>("/approvals");
  }

  resolveApproval(id: string, input: ApprovalResolutionInput) {
    return this.request<void>(`/approvals/${encodeURIComponent(id)}/resolve`, {
      body: JSON.stringify(input),
      idempotent: true,
      method: "POST",
      mutation: true,
    });
  }

  files(projectId: string, path: string) {
    const query = new URLSearchParams({ projectId, path });
    return this.request<FileListing>(`/files?${query.toString()}`);
  }

  async preview(projectId: string, path: string) {
    const query = new URLSearchParams({ projectId, path });
    let response: Response;
    try {
      response = await fetch(`${this.apiRoot}/files/preview?${query.toString()}`, {
        credentials: "same-origin",
      });
    } catch {
      throw new ApiRequestError("文件暂时无法读取。", 0, "OFFLINE");
    }
    if (!response.ok) throw new ApiRequestError("文件暂时无法预览。", response.status);
    return {
      blob: await response.blob(),
      contentType:
        response.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream",
    };
  }

  downloadUrl(projectId: string, path: string) {
    const query = new URLSearchParams({ projectId, path });
    return `${this.apiRoot}/files/download?${query.toString()}`;
  }

  diagnostics() {
    return this.request<DiagnosticSnapshot>("/diagnostics");
  }

  subscribe(onEvent: (event: RemoteEvent) => void, onConnection: (online: boolean) => void) {
    const source = new EventSource(`${this.apiRoot}/events`, { withCredentials: true });
    source.onopen = () => onConnection(true);
    source.onerror = () => onConnection(false);
    source.onmessage = (message) => {
      if (typeof message.data !== "string") return;
      try {
        onEvent(JSON.parse(message.data) as RemoteEvent);
      } catch {
        // Invalid stream entries are ignored and the next valid projection wins.
      }
    };
    return () => source.close();
  }
}

class DemoApiClient implements ApiClient {
  readonly demo = true;
  private detail: ThreadDetail = structuredClone(demoThreadDetail);
  private createdSubagents: SubagentSummary[] = [];

  private later<T>(value: T, delay = 120): Promise<T> {
    return new Promise((resolve) =>
      window.setTimeout(() => resolve(structuredClone(value)), delay),
    );
  }

  bootstrap() {
    return this.later(demoBootstrap, 240);
  }

  setup() {
    return this.later(demoSession);
  }

  login() {
    return this.later(demoSession);
  }

  logout() {
    return this.later(undefined);
  }

  session() {
    return this.later(demoSession);
  }

  projects() {
    return this.later(demoProjects);
  }

  models() {
    return this.later(demoModels);
  }

  collaborationModes() {
    return this.later(demoCollaborationModes);
  }

  threads(
    options: { archived?: boolean; cursor?: string } = {},
  ): Promise<CursorPage<ThreadSummary>> {
    return this.later({
      items: demoThreads.filter((thread) => Boolean(thread.archived) === Boolean(options.archived)),
    });
  }

  thread(id: string): Promise<ThreadDetail> {
    if (id === this.detail.id) return this.later(this.detail);
    if (id === demoUnsafeThreadDetail.id) return this.later(demoUnsafeThreadDetail);
    const subagent = [...demoSubagents, ...this.createdSubagents].find(
      (agent) => agent.threadId === id,
    );
    if (subagent) {
      const subagentDetail: ThreadDetail = {
        id: subagent.threadId,
        parentThreadId: subagent.parentThreadId,
        projectId: "project-console",
        title: subagent.title,
        cwdLabel: "…/mobile-console",
        mode: "managed",
        state: subagent.state,
        updatedAt: subagent.updatedAt,
        model: "GPT-5.4",
        reasoningEffort: "high",
        items: [
          {
            id: `${id}-summary`,
            kind: "reasoning-summary",
            text: "我正在处理分配给这个子智能体的有界任务，并将结果汇总给父对话。",
          },
          {
            id: `${id}-tool`,
            kind: "tool",
            title: "检查负责的模块",
            status:
              subagent.state === "failed"
                ? "failed"
                : subagent.state === "running"
                  ? "running"
                  : "complete",
            summary: "只查看与当前子任务相关的文件",
            occurrences: 3,
          },
        ],
        availableActions: {
          changeModelNextTurn: false,
          interrupt: false,
          reply: false,
          steer: false,
        },
      };
      return this.later(subagentDetail);
    }
    const summary = demoThreads.find((thread) => thread.id === id) ?? demoThreads[0]!;
    const items: ThreadDetail["items"] =
      summary.mode === "desktop-snapshot"
        ? [
            {
              id: "snapshot-info",
              kind: "assistant-message",
              text: "这是桌面端保存的历史快照。内容可能有延迟，远程端无法继续或停止该任务。",
            },
          ]
        : this.detail.items.slice(0, 5);
    const detail: ThreadDetail = {
      ...summary,
      ...(summary.id === "thread-snapshot-running" ? { activeTurnId: "desktop-turn" } : {}),
      availableActions: {
        changeModelNextTurn: summary.mode === "managed",
        interrupt: false,
        reply: summary.mode === "managed",
        steer: false,
      },
      items,
    };
    return this.later(detail);
  }

  async createThread(input: CreateThreadInput) {
    const threadId = `demo-${Date.now()}`;
    const created: ThreadDetail = {
      id: threadId,
      title: input.prompt.slice(0, 32),
      projectId: input.projectId,
      cwdLabel:
        demoProjects.find((project) => project.id === input.projectId)?.rootLabel ?? "已选项目",
      mode: "managed",
      state: "running",
      updatedAt: new Date().toISOString(),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      activeTurnId: "demo-turn",
      items: [{ id: "demo-user", kind: "user-message", text: input.prompt }],
      availableActions: {
        changeModelNextTurn: true,
        interrupt: true,
        reply: false,
        steer: true,
      },
    };
    this.detail = created;
    this.createdSubagents = [
      {
        threadId: `${threadId}-review`,
        parentThreadId: threadId,
        title: "检查任务边界",
        depth: 1,
        state: "running",
        updatedAt: new Date().toISOString(),
        isDirectlyControllable: false,
      },
    ];
    return this.later(created);
  }

  async sendTurn(_threadId: string, input: SendTurnInput) {
    this.detail = {
      ...this.detail,
      activeTurnId: "demo-next-turn",
      state: "running",
      items: [
        ...this.detail.items,
        { id: `user-${Date.now()}`, kind: "user-message", text: input.prompt },
      ],
      availableActions: {
        ...this.detail.availableActions,
        interrupt: true,
        reply: false,
        steer: true,
      },
    };
    return this.later(this.detail);
  }

  async steer(_threadId: string, _turnId: string, input: SteerTurnInput) {
    this.detail = {
      ...this.detail,
      items: [
        ...this.detail.items,
        { id: `steer-${Date.now()}`, kind: "user-message", text: `补充要求：${input.prompt}` },
      ],
    };
    await this.later(undefined);
  }

  async interrupt() {
    const { activeTurnId: _activeTurnId, ...detailWithoutActiveTurn } = this.detail;
    this.detail = {
      ...detailWithoutActiveTurn,
      state: "idle",
      availableActions: {
        ...this.detail.availableActions,
        interrupt: false,
        reply: true,
        steer: false,
      },
    };
    await this.later(undefined);
  }

  subagents(threadId: string, _cursor?: string): Promise<CursorPage<SubagentSummary>> {
    if (threadId === "thread-active") return this.later({ items: demoSubagents });
    return this.later({
      items: [...demoSubagents, ...this.createdSubagents].filter(
        (agent) => agent.parentThreadId === threadId,
      ),
    });
  }

  usage(threadId?: string) {
    if (!threadId) return this.later(demoUsage);
    const contextOffset = threadId.includes("review") ? 9 : 0;
    const limitTokens = demoUsage.context?.limitTokens;
    const snapshot: UsageSnapshot = {
      ...demoUsage,
      context: {
        usedTokens: (demoUsage.context?.usedTokens ?? 0) + contextOffset * 1_000,
        usedPercent: (demoUsage.context?.usedPercent ?? 0) + contextOffset,
        ...(limitTokens !== undefined ? { limitTokens } : {}),
      },
    };
    return this.later(snapshot);
  }

  approvals() {
    return this.later(demoApprovals);
  }

  resolveApproval(_id: string, _input: ApprovalResolutionInput) {
    return this.later(undefined);
  }

  files(projectId: string, path: string) {
    const listing = demoFiles[path] ?? {
      projectId,
      relativePath: path,
      entries: [],
    };
    return this.later({ ...listing, projectId });
  }

  preview(_projectId: string, path: string) {
    const content = path.endsWith(".json")
      ? JSON.stringify({ name: "local-remote", private: true }, null, 2)
      : demoFileText;
    return this.later({
      blob: new Blob([content], { type: path.endsWith(".md") ? "text/markdown" : "text/plain" }),
      contentType: path.endsWith(".md") ? "text/markdown" : "text/plain",
    });
  }

  downloadUrl(_projectId: string, _path: string) {
    return `data:text/plain;charset=utf-8,${encodeURIComponent(demoFileText)}`;
  }

  diagnostics() {
    return this.later(demoDiagnostics);
  }

  subscribe(_onEvent: (event: RemoteEvent) => void, onConnection: (online: boolean) => void) {
    onConnection(true);
    return () => undefined;
  }
}

export function createApiClient(): ApiClient {
  const demoRequested =
    import.meta.env.VITE_DEMO_MODE === "true" ||
    new URLSearchParams(window.location.search).get("demo") === "1" ||
    window.localStorage.getItem("local-remote-demo") === "1";
  return demoRequested ? new DemoApiClient() : new HttpApiClient();
}
