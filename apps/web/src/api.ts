import type {
  ApprovalPolicyOption,
  ApprovalRequest,
  ApprovalReviewerOption,
  ApprovalResolutionInput,
  AuthSession,
  CollaborationModeOption,
  CreateThreadInput,
  DiagnosticSnapshot,
  FileListing,
  LocalInputReference,
  ResolvedFileEntry,
  EditQueuedTurnInput,
  ModelOption,
  PermissionProfileOption,
  ProjectSummary,
  PublicBootstrap,
  QueueTurnInput,
  QueuedTurnItem,
  ReorderQueuedTurnsInput,
  RemoteEvent,
  SendTurnInput,
  SendQueuedTurnInput,
  SetThreadGoalInput,
  SteerQueuedTurnInput,
  SteerTurnInput,
  SubagentSummary,
  ThreadDetail,
  ThreadGoal,
  ThreadSettingsInput,
  ThreadSummary,
  TurnQueueSnapshot,
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
  approvalPolicies(): Promise<ApprovalPolicyOption[]>;
  approvalReviewers(): Promise<ApprovalReviewerOption[]>;
  permissionProfiles(input: {
    threadId?: string;
    projectId?: string;
  }): Promise<PermissionProfileOption[]>;
  collaborationModes(): Promise<CollaborationModeOption[]>;
  threads(options?: { archived?: boolean; cursor?: string }): Promise<CursorPage<ThreadSummary>>;
  thread(id: string): Promise<ThreadDetail>;
  threadShell(id: string): Promise<ThreadDetail>;
  createThread(input: CreateThreadInput): Promise<ThreadDetail>;
  resumeThread(threadId: string, idempotencyKey: string): Promise<ThreadDetail>;
  compact(threadId: string, idempotencyKey: string): Promise<void>;
  queue(threadId: string): Promise<TurnQueueSnapshot>;
  enqueue(threadId: string, input: QueueTurnInput): Promise<TurnQueueSnapshot>;
  updateQueued(
    threadId: string,
    itemId: string,
    input: EditQueuedTurnInput,
  ): Promise<TurnQueueSnapshot>;
  deleteQueued(
    threadId: string,
    itemId: string,
    expectedRevision: number,
  ): Promise<TurnQueueSnapshot>;
  reorderQueue(threadId: string, input: ReorderQueuedTurnsInput): Promise<TurnQueueSnapshot>;
  dispatchQueued(
    threadId: string,
    itemId: string,
    input: SendQueuedTurnInput,
  ): Promise<TurnQueueSnapshot>;
  steerQueued(
    threadId: string,
    itemId: string,
    input: SteerQueuedTurnInput,
  ): Promise<TurnQueueSnapshot>;
  updateThreadSettings(threadId: string, input: ThreadSettingsInput): Promise<void>;
  threadGoal(threadId: string): Promise<{ goal: ThreadGoal | null }>;
  setThreadGoal(threadId: string, input: SetThreadGoalInput): Promise<void>;
  clearThreadGoal(threadId: string): Promise<void>;
  sendTurn(threadId: string, input: SendTurnInput): Promise<ThreadDetail>;
  steer(threadId: string, turnId: string, input: SteerTurnInput): Promise<void>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  subagents(threadId: string, cursor?: string): Promise<CursorPage<SubagentSummary>>;
  usage(threadId?: string): Promise<UsageSnapshot>;
  approvals(): Promise<ApprovalRequest[]>;
  resolveApproval(id: string, input: ApprovalResolutionInput): Promise<void>;
  upload(file: File, relativePath?: string): Promise<LocalInputReference>;
  files(projectId: string, path: string): Promise<FileListing>;
  resolveFile(projectId: string | undefined, path: string): Promise<ResolvedFileEntry>;
  preview(projectId: string, path: string): Promise<{ contentType: string; blob: Blob }>;
  downloadUrl(projectId: string, path: string): string;
  diagnostics(): Promise<DiagnosticSnapshot>;
  subscribe(
    onEvent: (event: RemoteEvent) => void,
    onConnection: (online: boolean) => void,
    options?: { threadId?: string },
  ): () => void;
}

export const EVENT_SOURCE_CLOSED = 2;
export const EVENT_SOURCE_CONNECTING = 0;
export const EVENT_SOURCE_OPEN = 1;
export const EVENT_STREAM_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;

export interface EventStreamSource {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  close(): void;
}

export interface EventStreamDependencies {
  createSource: (url: string) => EventStreamSource;
  schedule: (callback: () => void, delay: number) => number;
  cancel: (timerId: number) => void;
}

type EventStreamFetch = (
  input: string,
  init?: {
    cache?: RequestCache;
    credentials?: RequestCredentials;
    headers?: HeadersInit;
    signal?: AbortSignal;
  },
) => Promise<Response>;

class FetchEventStreamSource implements EventStreamSource {
  readonly #controller = new AbortController();
  readonly #fetcher: EventStreamFetch;
  readonly #url: string;
  #buffer = "";
  #dataLines: string[] = [];
  #lastEventId = "";
  readyState = EVENT_SOURCE_CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;

  constructor(url: string, fetcher: EventStreamFetch) {
    this.#url = url;
    this.#fetcher = fetcher;
    void this.#run();
  }

  close(): void {
    if (this.readyState === EVENT_SOURCE_CLOSED) return;
    this.readyState = EVENT_SOURCE_CLOSED;
    this.#controller.abort();
  }

  async #run(): Promise<void> {
    try {
      const response = await this.#fetcher(this.#url, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "text/event-stream", Pragma: "no-cache" },
        signal: this.#controller.signal,
      });
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!response.ok || !response.body || !contentType.startsWith("text/event-stream")) {
        throw new Error("Event stream response is unavailable");
      }
      if (this.readyState === EVENT_SOURCE_CLOSED) return;
      this.readyState = EVENT_SOURCE_OPEN;
      this.onopen?.(new Event("open"));
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const result = await reader.read();
        if (result.done) {
          this.#consume(decoder.decode());
          throw new Error("Event stream closed");
        }
        this.#consume(decoder.decode(result.value, { stream: true }));
      }
    } catch {
      if (this.#controller.signal.aborted || this.readyState === EVENT_SOURCE_CLOSED) return;
      this.readyState = EVENT_SOURCE_CLOSED;
      this.onerror?.(new Event("error"));
    }
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      let line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#consumeLine(line);
    }
  }

  #consumeLine(line: string): void {
    if (line === "") {
      if (this.#dataLines.length === 0) return;
      const data = this.#dataLines.join("\n");
      this.#dataLines = [];
      this.onmessage?.(
        new MessageEvent<string>("message", {
          data,
          lastEventId: this.#lastEventId,
        }),
      );
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      this.#dataLines.push(value);
    } else if (field === "id" && !value.includes("\0")) {
      this.#lastEventId = value;
    }
  }
}

export function createFetchEventStreamSource(
  url: string,
  fetcher: EventStreamFetch = globalThis.fetch.bind(globalThis),
): EventStreamSource {
  return new FetchEventStreamSource(url, fetcher);
}

function createBrowserEventStreamSource(url: string): EventStreamSource {
  if (typeof globalThis.EventSource === "function") {
    return new globalThis.EventSource(url, { withCredentials: true }) as EventStreamSource;
  }
  return createFetchEventStreamSource(url);
}

function eventStreamUrl(url: string, cursor: string): string {
  if (!cursor) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}cursor=${encodeURIComponent(cursor)}`;
}

export function subscribeRemoteEvents(
  url: string,
  onEvent: (event: RemoteEvent) => void,
  onConnection: (online: boolean) => void,
  dependencies: EventStreamDependencies = {
    createSource: createBrowserEventStreamSource,
    schedule: (callback, delay) => window.setTimeout(callback, delay),
    cancel: (timerId) => window.clearTimeout(timerId),
  },
): () => void {
  let currentSource: EventStreamSource | undefined;
  let retryTimer: number | undefined;
  let retryAttempt = 0;
  let disposed = false;
  let lastEventId = "";
  let lastConnectionState: boolean | undefined;

  const reportConnection = (online: boolean) => {
    if (lastConnectionState === online) return;
    lastConnectionState = online;
    onConnection(online);
  };

  const clearRetry = () => {
    if (retryTimer === undefined) return;
    dependencies.cancel(retryTimer);
    retryTimer = undefined;
  };

  const scheduleReconnect = () => {
    if (disposed || retryTimer !== undefined || currentSource !== undefined) return;
    const delay =
      EVENT_STREAM_RETRY_DELAYS_MS[
        Math.min(retryAttempt, EVENT_STREAM_RETRY_DELAYS_MS.length - 1)
      ] ?? EVENT_STREAM_RETRY_DELAYS_MS[EVENT_STREAM_RETRY_DELAYS_MS.length - 1]!;
    retryAttempt += 1;
    retryTimer = dependencies.schedule(() => {
      retryTimer = undefined;
      connect();
    }, delay);
  };

  const connect = () => {
    if (disposed || currentSource !== undefined) return;
    let source: EventStreamSource;
    try {
      source = dependencies.createSource(eventStreamUrl(url, lastEventId));
    } catch {
      reportConnection(false);
      scheduleReconnect();
      return;
    }
    currentSource = source;
    source.onopen = () => {
      if (disposed || currentSource !== source) return;
      retryAttempt = 0;
      clearRetry();
      reportConnection(true);
    };
    source.onerror = () => {
      if (disposed || currentSource !== source) return;
      reportConnection(false);
      if (source.readyState !== EVENT_SOURCE_CLOSED) return;
      source.close();
      currentSource = undefined;
      scheduleReconnect();
    };
    source.onmessage = (message) => {
      if (disposed || currentSource !== source || typeof message.data !== "string") return;
      if (message.lastEventId) lastEventId = message.lastEventId;
      try {
        onEvent(JSON.parse(message.data) as RemoteEvent);
      } catch {
        // Invalid stream entries are ignored and the next valid projection wins.
      }
    };
  };

  connect();
  return () => {
    disposed = true;
    clearRetry();
    const source = currentSource;
    currentSource = undefined;
    source?.close();
  };
}

function initialApiRoot() {
  const base = new URL("./", document.baseURI);
  return new URL("api/v1", base).pathname.replace(/\/$/, "");
}

type ApiErrorPayload = {
  code: string;
  message: string;
};

async function apiErrorPayload(response: Response): Promise<ApiErrorPayload> {
  const fallback = `请求失败（${response.status}）`;
  try {
    const payload = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    return {
      code: payload.error?.code ?? "REQUEST_FAILED",
      message: payload.error?.message ?? fallback,
    };
  } catch {
    return { code: "REQUEST_FAILED", message: fallback };
  }
}

export class HttpApiClient implements ApiClient {
  readonly demo = false;
  private apiRoot: string;
  private csrfToken: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(apiRoot = initialApiRoot(), fetcher: typeof fetch = fetch) {
    this.apiRoot = apiRoot;
    this.fetcher = (input, init) => fetcher(input, init);
  }

  private updateBasePath(basePath: string) {
    const clean = basePath === "/" ? "" : basePath.replace(/\/$/, "");
    this.apiRoot = `${clean}/api/v1`;
  }

  private async request<T>(
    path: string,
    options: RequestInit & {
      mutation?: boolean;
      idempotent?: boolean;
      idempotencyKey?: string;
    } = {},
  ): Promise<T> {
    const idempotencyKey = options.idempotent
      ? (options.idempotencyKey ?? crypto.randomUUID())
      : undefined;
    const execute = async () => {
      const headers = new Headers(options.headers);
      headers.set("Accept", "application/json");
      if (options.body !== undefined) headers.set("Content-Type", "application/json");
      if (options.mutation && this.csrfToken) headers.set("X-CSRF-Token", this.csrfToken);
      if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
      return await this.fetcher(`${this.apiRoot}${path}`, {
        ...options,
        credentials: "same-origin",
        headers,
      });
    };

    let response: Response;
    try {
      response = await execute();
    } catch {
      throw new ApiRequestError("无法连接到电脑，请检查网络后重试。", 0, "OFFLINE");
    }

    if (!response.ok) {
      const firstFailure = await apiErrorPayload(response);
      if (
        options.mutation &&
        firstFailure.code === "REQUEST_VERIFICATION_FAILED" &&
        (await this.refreshCsrfToken())
      ) {
        try {
          response = await execute();
        } catch {
          throw new ApiRequestError("无法连接到电脑，请检查网络后重试。", 0, "OFFLINE");
        }
      } else {
        throw new ApiRequestError(firstFailure.message, response.status, firstFailure.code);
      }
    }
    if (!response.ok) {
      const failure = await apiErrorPayload(response);
      throw new ApiRequestError(failure.message, response.status, failure.code);
    }
    if (response.status === 204) return undefined as T;
    const body = await response.text();
    return body.length === 0 ? (undefined as T) : (JSON.parse(body) as T);
  }

  private async refreshCsrfToken(): Promise<boolean> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.apiRoot}/auth/session`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
    } catch {
      return false;
    }
    if (!response.ok) return false;
    try {
      const session = (await response.json()) as Partial<AuthSession>;
      if (typeof session.csrfToken !== "string" || session.csrfToken.length === 0) {
        return false;
      }
      this.csrfToken = session.csrfToken;
      return true;
    } catch {
      return false;
    }
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

  approvalReviewers() {
    return this.request<ApprovalReviewerOption[]>("/approval-reviewers");
  }

  approvalPolicies() {
    return this.request<ApprovalPolicyOption[]>("/approval-policies");
  }

  permissionProfiles(input: { threadId?: string; projectId?: string }) {
    const query = new URLSearchParams(
      input.threadId ? { threadId: input.threadId } : { projectId: input.projectId ?? "" },
    );
    return this.request<PermissionProfileOption[]>(`/permission-profiles?${query.toString()}`);
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

  threadShell(id: string) {
    return this.request<ThreadDetail>(`/threads/${encodeURIComponent(id)}?includeItems=false`);
  }

  createThread(input: CreateThreadInput) {
    return this.request<ThreadDetail>("/threads", {
      body: JSON.stringify(input),
      idempotent: true,
      method: "POST",
      mutation: true,
    });
  }

  resumeThread(threadId: string, idempotencyKey: string) {
    return this.request<ThreadDetail>(`/threads/${encodeURIComponent(threadId)}/resume`, {
      idempotent: true,
      idempotencyKey,
      method: "POST",
      mutation: true,
    });
  }

  compact(threadId: string, idempotencyKey: string) {
    return this.request<void>(`/threads/${encodeURIComponent(threadId)}/compact`, {
      idempotent: true,
      idempotencyKey,
      method: "POST",
      mutation: true,
    });
  }

  queue(threadId: string) {
    return this.request<TurnQueueSnapshot>(`/threads/${encodeURIComponent(threadId)}/queue`);
  }

  enqueue(threadId: string, input: QueueTurnInput) {
    return this.request<TurnQueueSnapshot>(`/threads/${encodeURIComponent(threadId)}/queue`, {
      body: JSON.stringify(input),
      idempotent: true,
      method: "POST",
      mutation: true,
    });
  }

  updateQueued(threadId: string, itemId: string, input: EditQueuedTurnInput) {
    return this.request<TurnQueueSnapshot>(
      `/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(itemId)}`,
      {
        body: JSON.stringify(input),
        idempotent: true,
        method: "PATCH",
        mutation: true,
      },
    );
  }

  deleteQueued(threadId: string, itemId: string, expectedRevision: number) {
    return this.request<TurnQueueSnapshot>(
      `/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(itemId)}`,
      {
        body: JSON.stringify({ expectedRevision }),
        idempotent: true,
        method: "DELETE",
        mutation: true,
      },
    );
  }

  reorderQueue(threadId: string, input: ReorderQueuedTurnsInput) {
    return this.request<TurnQueueSnapshot>(`/threads/${encodeURIComponent(threadId)}/queue/order`, {
      body: JSON.stringify(input),
      idempotent: true,
      method: "PUT",
      mutation: true,
    });
  }

  dispatchQueued(threadId: string, itemId: string, input: SendQueuedTurnInput) {
    return this.request<TurnQueueSnapshot>(
      `/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(itemId)}/send`,
      {
        body: JSON.stringify(input),
        idempotent: true,
        method: "POST",
        mutation: true,
      },
    );
  }

  steerQueued(threadId: string, itemId: string, input: SteerQueuedTurnInput) {
    return this.request<TurnQueueSnapshot>(
      `/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(itemId)}/steer`,
      {
        body: JSON.stringify(input),
        idempotent: true,
        method: "POST",
        mutation: true,
      },
    );
  }

  updateThreadSettings(threadId: string, input: ThreadSettingsInput) {
    return this.request<void>(`/threads/${encodeURIComponent(threadId)}/settings`, {
      body: JSON.stringify(input),
      idempotent: true,
      method: "PATCH",
      mutation: true,
    });
  }

  threadGoal(threadId: string) {
    return this.request<{ goal: ThreadGoal | null }>(
      `/threads/${encodeURIComponent(threadId)}/goal`,
    );
  }

  setThreadGoal(threadId: string, input: SetThreadGoalInput) {
    return this.request<void>(`/threads/${encodeURIComponent(threadId)}/goal`, {
      body: JSON.stringify(input),
      idempotent: true,
      method: "PUT",
      mutation: true,
    });
  }

  clearThreadGoal(threadId: string) {
    return this.request<void>(`/threads/${encodeURIComponent(threadId)}/goal`, {
      idempotent: true,
      method: "DELETE",
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

  async upload(file: File, relativePath = file.webkitRelativePath || file.name) {
    const query = new URLSearchParams({
      name: file.name,
      relativePath,
    });
    const headers = new Headers({
      Accept: "application/json",
      "Content-Type": "application/octet-stream",
      "Idempotency-Key": crypto.randomUUID(),
    });
    if (this.csrfToken) headers.set("X-CSRF-Token", this.csrfToken);

    let response: Response;
    try {
      response = await fetch(`${this.apiRoot}/uploads?${query.toString()}`, {
        body: file,
        credentials: "same-origin",
        headers,
        method: "POST",
      });
    } catch {
      throw new ApiRequestError("上传中断，请检查网络后重新选择。", 0, "OFFLINE");
    }
    if (!response.ok) {
      const fallback = `上传失败（${response.status}）`;
      let message = fallback;
      let code = "UPLOAD_FAILED";
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
    return (await response.json()) as LocalInputReference;
  }

  files(projectId: string, path: string) {
    const query = new URLSearchParams({ projectId, path });
    return this.request<FileListing>(`/files?${query.toString()}`);
  }

  resolveFile(projectId: string | undefined, path: string) {
    const query = new URLSearchParams({ path });
    if (projectId) query.set("projectId", projectId);
    return this.request<ResolvedFileEntry>(`/files/resolve?${query.toString()}`);
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

  subscribe(
    onEvent: (event: RemoteEvent) => void,
    onConnection: (online: boolean) => void,
    options: { threadId?: string } = {},
  ) {
    const query = options.threadId
      ? `?${new URLSearchParams({ threadId: options.threadId }).toString()}`
      : "";
    return subscribeRemoteEvents(`${this.apiRoot}/events${query}`, onEvent, onConnection);
  }
}

class DemoApiClient implements ApiClient {
  readonly demo = true;
  private detail: ThreadDetail = structuredClone(demoThreadDetail);
  private createdSubagents: SubagentSummary[] = [];
  private readonly queuedByThread = new Map<string, TurnQueueSnapshot>();
  private readonly goalsByThread = new Map<string, ThreadGoal>();

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

  approvalReviewers() {
    return this.later<ApprovalReviewerOption[]>([
      { id: "user" },
      { id: "auto_review" },
      { id: "guardian_subagent" },
    ]);
  }

  approvalPolicies() {
    return this.later<ApprovalPolicyOption[]>([
      { id: "untrusted" },
      { id: "on-request" },
      { id: "never" },
    ]);
  }

  permissionProfiles(_input: { threadId?: string; projectId?: string }) {
    return this.later<PermissionProfileOption[]>([
      {
        id: "ask",
        description: "敏感操作先向你确认",
        allowed: true,
      },
      {
        id: "workspace-write",
        description: "允许修改当前项目文件",
        allowed: true,
      },
      {
        id: "read-only",
        description: "仅检查和回答，不改文件",
        allowed: true,
      },
    ]);
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
    const running =
      summary.mode === "managed" &&
      (summary.state === "running" || summary.state === "waiting-for-approval");
    const detail: ThreadDetail = {
      ...summary,
      ...(running
        ? {
            activeTurnId:
              summary.id === "thread-desktop-running"
                ? "desktop-turn"
                : summary.id === "thread-approval"
                  ? "turn-install"
                  : `demo-turn-${summary.id}`,
          }
        : {}),
      availableActions: {
        changeModelNextTurn: summary.mode === "managed",
        interrupt: running,
        reply: summary.mode === "managed" && !running,
        steer: running,
      },
      items,
    };
    return this.later(detail);
  }

  async threadShell(id: string): Promise<ThreadDetail> {
    const detail = await this.thread(id);
    return { ...detail, items: [] };
  }

  async createThread(input: CreateThreadInput) {
    const threadId = `demo-${Date.now()}`;
    const created: ThreadDetail = {
      id: threadId,
      title: input.prompt.slice(0, 32),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      cwdLabel:
        input.projectId === undefined
          ? "无项目"
          : (demoProjects.find((project) => project.id === input.projectId)?.rootLabel ??
            "已选项目"),
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

  async resumeThread(threadId: string, _idempotencyKey: string) {
    const restored = await this.thread(threadId);
    this.detail = {
      ...restored,
      mode: "managed",
      state: restored.state === "running" ? "running" : "idle",
      availableActions: {
        ...restored.availableActions,
        changeModelNextTurn: true,
        interrupt: Boolean(restored.activeTurnId),
        reply: !restored.activeTurnId,
        steer: Boolean(restored.activeTurnId),
      },
    };
    return this.later(this.detail);
  }

  async compact(threadId: string, _idempotencyKey: string) {
    if (threadId !== this.detail.id) {
      throw new ApiRequestError("找不到这个对话", 404, "THREAD_NOT_FOUND");
    }
    const itemId = `demo-compaction-${Date.now()}`;
    this.detail = {
      ...this.detail,
      activeTurnId: "demo-compaction-turn",
      state: "running",
      updatedAt: new Date().toISOString(),
      items: [
        ...this.detail.items,
        {
          id: itemId,
          kind: "tool",
          operation: "context-compaction",
          status: "running",
          title: "压缩对话上下文",
        },
      ],
      availableActions: {
        changeModelNextTurn: false,
        interrupt: false,
        reply: false,
        steer: false,
      },
    };
    window.setTimeout(() => {
      const { activeTurnId: _activeTurnId, ...detailWithoutActiveTurn } = this.detail;
      this.detail = {
        ...detailWithoutActiveTurn,
        state: "complete",
        updatedAt: new Date().toISOString(),
        items: this.detail.items.map((item) =>
          item.id === itemId && item.kind === "tool"
            ? { ...item, status: "complete" as const }
            : item,
        ),
        availableActions: {
          changeModelNextTurn: true,
          interrupt: false,
          reply: true,
          steer: false,
        },
      };
    }, 650);
    await this.later(undefined);
  }

  queue(threadId: string) {
    return this.later(this.queuedByThread.get(threadId) ?? { threadId, revision: 0, items: [] });
  }

  async enqueue(threadId: string, input: QueueTurnInput) {
    const current = this.queuedByThread.get(threadId) ?? {
      threadId,
      revision: 0,
      items: [],
    };
    const revision = current.revision + 1;
    const timestamp = new Date().toISOString();
    const queued: QueuedTurnItem = {
      id: `queue-${Date.now()}-${current.items.length}`,
      threadId,
      clientUserMessageId: crypto.randomUUID(),
      state: "queued",
      position: current.items.length,
      revision,
      createdAt: timestamp,
      updatedAt: timestamp,
      prompt: input.prompt,
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    };
    const snapshot = { threadId, revision, items: [...current.items, queued] };
    this.queuedByThread.set(threadId, snapshot);
    return this.later(snapshot);
  }

  async updateQueued(threadId: string, itemId: string, input: EditQueuedTurnInput) {
    const current = this.queuedByThread.get(threadId) ?? {
      threadId,
      revision: 0,
      items: [],
    };
    if (input.expectedRevision !== current.revision) {
      throw new ApiRequestError("队列已经变化，请刷新后重试", 409, "QUEUE_REVISION_CONFLICT");
    }
    const index = current.items.findIndex((item) => item.id === itemId);
    if (index < 0) throw new ApiRequestError("这条排队消息已经不存在", 404, "QUEUE_NOT_FOUND");
    const revision = current.revision + 1;
    const updated: QueuedTurnItem = {
      ...current.items[index]!,
      prompt: input.prompt,
      ...(input.attachments ? { attachments: input.attachments } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      revision,
      updatedAt: new Date().toISOString(),
    };
    const next = [...current.items];
    next[index] = updated;
    const snapshot = { threadId, revision, items: next };
    this.queuedByThread.set(threadId, snapshot);
    return this.later(snapshot);
  }

  async deleteQueued(threadId: string, itemId: string, expectedRevision: number) {
    const current = this.queuedByThread.get(threadId) ?? {
      threadId,
      revision: 0,
      items: [],
    };
    if (expectedRevision !== current.revision) {
      throw new ApiRequestError("队列已经变化，请刷新后重试", 409, "QUEUE_REVISION_CONFLICT");
    }
    const revision = current.revision + 1;
    const snapshot = {
      threadId,
      revision,
      items: current.items
        .filter((item) => item.id !== itemId)
        .map((item, position) => ({ ...item, position, revision })),
    };
    this.queuedByThread.set(threadId, snapshot);
    return this.later(snapshot);
  }

  async reorderQueue(threadId: string, input: ReorderQueuedTurnsInput) {
    const current = this.queuedByThread.get(threadId) ?? {
      threadId,
      revision: 0,
      items: [],
    };
    if (input.expectedRevision !== current.revision) {
      throw new ApiRequestError("队列已经变化，请刷新后重试", 409, "QUEUE_REVISION_CONFLICT");
    }
    const byId = new Map(current.items.map((item) => [item.id, item]));
    const ordered = input.queueIds
      .map((id) => byId.get(id))
      .filter((item): item is QueuedTurnItem => item !== undefined);
    for (const item of current.items) {
      if (!input.queueIds.includes(item.id)) ordered.push(item);
    }
    const revision = current.revision + 1;
    const snapshot = {
      threadId,
      revision,
      items: ordered.map((item, position) => ({ ...item, position, revision })),
    };
    this.queuedByThread.set(threadId, snapshot);
    return this.later(snapshot);
  }

  async dispatchQueued(threadId: string, itemId: string, input: SendQueuedTurnInput) {
    if (this.detail.id === threadId && this.detail.activeTurnId) {
      throw new ApiRequestError("当前回复仍在运行，请先等待完成或停止", 409, "TURN_ACTIVE");
    }
    const current = this.queuedByThread.get(threadId) ?? {
      threadId,
      revision: 0,
      items: [],
    };
    if (input.expectedRevision !== current.revision) {
      throw new ApiRequestError("队列已经变化，请刷新后重试", 409, "QUEUE_REVISION_CONFLICT");
    }
    const queued = current.items.find((item) => item.id === itemId);
    if (!queued) throw new ApiRequestError("这条排队消息已经不存在", 404, "QUEUE_NOT_FOUND");
    if (!queued.prompt) {
      throw new ApiRequestError("这条消息正在发送或内容不可用", 409, "QUEUE_NOT_EDITABLE");
    }
    const snapshot = await this.deleteQueued(threadId, itemId, current.revision);
    await this.sendTurn(threadId, {
      prompt: queued.prompt,
      ...(queued.model ? { model: queued.model } : {}),
      ...(queued.reasoningEffort ? { reasoningEffort: queued.reasoningEffort } : {}),
    });
    return this.later(snapshot);
  }

  async steerQueued(threadId: string, itemId: string, input: SteerQueuedTurnInput) {
    if (this.detail.id !== threadId || this.detail.activeTurnId !== input.turnId) {
      throw new ApiRequestError("当前回复已经变化，请刷新后重试", 409, "TURN_MISMATCH");
    }
    const current = this.queuedByThread.get(threadId) ?? {
      threadId,
      revision: 0,
      items: [],
    };
    if (input.expectedRevision !== current.revision) {
      throw new ApiRequestError("队列已经变化，请刷新后重试", 409, "QUEUE_REVISION_CONFLICT");
    }
    const queued = current.items.find((item) => item.id === itemId);
    if (!queued?.prompt) {
      throw new ApiRequestError("这条消息的内容当前不可用", 409, "QUEUE_ITEM_NOT_STEERABLE");
    }
    if (queued.state === "ambiguous") {
      throw new ApiRequestError(
        "这条消息的发送结果未知，不能直接改为引导",
        409,
        "QUEUE_AMBIGUOUS_STEER_BLOCKED",
      );
    }
    await this.steer(threadId, input.turnId, {
      prompt: queued.prompt,
      ...(queued.attachments === undefined ? {} : { attachments: queued.attachments }),
    });
    return await this.deleteQueued(threadId, itemId, current.revision);
  }

  async updateThreadSettings(threadId: string, input: ThreadSettingsInput) {
    if (this.detail.id !== threadId) return this.later(undefined);
    this.detail = {
      ...this.detail,
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    };
    return this.later(undefined);
  }

  threadGoal(threadId: string) {
    return this.later({ goal: this.goalsByThread.get(threadId) ?? null });
  }

  async setThreadGoal(threadId: string, input: SetThreadGoalInput) {
    const timestamp = new Date().toISOString();
    const goal: ThreadGoal = {
      threadId,
      objective: input.objective,
      status: "active",
      ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: this.goalsByThread.get(threadId)?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.goalsByThread.set(threadId, goal);
    return this.later(undefined);
  }

  async clearThreadGoal(threadId: string) {
    this.goalsByThread.delete(threadId);
    return this.later(undefined);
  }

  async steer(_threadId: string, _turnId: string, input: SteerTurnInput) {
    this.detail = {
      ...this.detail,
      items: [
        ...this.detail.items,
        { id: `steer-${Date.now()}`, kind: "user-message", text: input.prompt },
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

  upload(file: File, relativePath = file.webkitRelativePath || file.name) {
    return this.later<LocalInputReference>({
      kind: "file",
      relativePath,
      uploadId: crypto.randomUUID(),
    });
  }

  files(projectId: string, path: string) {
    const listing = demoFiles[path] ?? {
      projectId,
      relativePath: path,
      entries: [],
    };
    return this.later({ ...listing, projectId });
  }

  async resolveFile(projectId: string | undefined, path: string): Promise<ResolvedFileEntry> {
    const resolvedProjectId = projectId ?? demoProjects[0]?.id ?? "project-console";
    const normalized = path.replaceAll("\\", "/").replace(/^\.\/+/u, "");
    const segments = normalized.split("/");
    const parentPath = segments.slice(0, -1).join("/");
    const listing = await this.files(resolvedProjectId, parentPath);
    return {
      ...(listing.entries.find((entry) => entry.relativePath === normalized) ?? {
        downloadable: true,
        kind: "file",
        name: segments.at(-1) ?? normalized,
        relativePath: normalized,
      }),
      projectId: resolvedProjectId,
    };
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

  subscribe(
    _onEvent: (event: RemoteEvent) => void,
    onConnection: (online: boolean) => void,
    _options: { threadId?: string } = {},
  ) {
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
