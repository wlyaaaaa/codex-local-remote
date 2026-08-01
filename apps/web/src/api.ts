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
  FileRoot,
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
  SubagentHistoryIntegrity,
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
import { isDemoModeAllowed } from "./demo-mode";
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

export type SubagentCursorPage = CursorPage<SubagentSummary> & {
  historyIntegrity?: SubagentHistoryIntegrity;
};

const subagentIntegrityStatuses = new Set(["complete", "partial", "unknown", "failed"]);
const subagentIntegrityReasons = new Set([
  "verified-exhaustive",
  "pagination-pending",
  "pagination-failed",
  "read-failed",
  "read-truncated",
  "upstream-short-page-without-cursor",
  "verification-mismatch",
  "continuation-unverified",
]);
const subagentStreamStatuses = new Set(["exhausted", "more-available", "failed", "not-requested"]);

export function subagentHistoryIntegrityFrom(
  headers: Headers,
): SubagentHistoryIntegrity | undefined {
  const raw = headers.get("X-Subagent-History-Integrity")?.trim();
  if (!raw) return undefined;
  try {
    const value = JSON.parse(decodeURIComponent(raw)) as Partial<SubagentHistoryIntegrity>;
    const current = value.streams?.current;
    const archived = value.streams?.archived;
    if (
      typeof value.status !== "string" ||
      !subagentIntegrityStatuses.has(value.status) ||
      typeof value.reason !== "string" ||
      !subagentIntegrityReasons.has(value.reason) ||
      !Number.isSafeInteger(value.observedCount) ||
      (value.observedCount ?? -1) < 0 ||
      typeof current?.status !== "string" ||
      !subagentStreamStatuses.has(current.status) ||
      !Number.isSafeInteger(current.observedCount) ||
      current.observedCount < 0 ||
      typeof archived?.status !== "string" ||
      !subagentStreamStatuses.has(archived.status) ||
      !Number.isSafeInteger(archived.observedCount) ||
      archived.observedCount < 0
    ) {
      return undefined;
    }
    return value as SubagentHistoryIntegrity;
  } catch {
    return undefined;
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
  thread(id: string, historyCursor?: string): Promise<ThreadDetail>;
  threadShell(id: string): Promise<ThreadDetail>;
  createThread(input: CreateThreadInput): Promise<ThreadDetail>;
  resumeThread(threadId: string, idempotencyKey: string): Promise<ThreadDetail>;
  compact(threadId: string, idempotencyKey: string): Promise<void>;
  setThreadName(threadId: string, name: string): Promise<void>;
  setThreadArchived(threadId: string, archived: boolean): Promise<void>;
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
  subagents(threadId: string, cursor?: string): Promise<SubagentCursorPage>;
  usage(threadId?: string): Promise<UsageSnapshot>;
  approvals(): Promise<ApprovalRequest[]>;
  resolveApproval(id: string, input: ApprovalResolutionInput): Promise<void>;
  upload(file: File, relativePath?: string): Promise<LocalInputReference>;
  fileRoots(): Promise<FileRoot[]>;
  files(projectId: string, path: string): Promise<FileListing>;
  createFolder(projectId: string, path: string): Promise<void>;
  writeHostFile(projectId: string, path: string, file: File, overwrite?: boolean): Promise<void>;
  renameHostFile(projectId: string, path: string, name: string): Promise<void>;
  copyHostFile(input: {
    sourceProjectId: string;
    sourcePath: string;
    targetProjectId: string;
    targetPath: string;
    overwrite?: boolean;
  }): Promise<void>;
  moveHostFile(input: {
    sourceProjectId: string;
    sourcePath: string;
    targetProjectId: string;
    targetPath: string;
    overwrite?: boolean;
  }): Promise<void>;
  deleteHostFile(projectId: string, path: string, permanent?: boolean): Promise<void>;
  resolveFile(projectId: string | undefined, path: string): Promise<ResolvedFileEntry>;
  preview(projectId: string, path: string): Promise<{ contentType: string; blob: Blob }>;
  downloadUrl(projectId: string, path: string): string;
  diagnostics(): Promise<DiagnosticSnapshot>;
  subscribe(
    onEvent: (event: RemoteEvent) => void,
    onConnection: (online: boolean) => void,
    options?: { cursor?: string; threadId?: string },
  ): () => void;
}

export const EVENT_SOURCE_CLOSED = 2;
export const EVENT_SOURCE_CONNECTING = 0;
export const EVENT_SOURCE_OPEN = 1;
export const EVENT_STREAM_OFFLINE_GRACE_MS = 3_000;
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
  const hashIndex = url.indexOf("#");
  const hash = hashIndex < 0 ? "" : url.slice(hashIndex);
  const withoutHash = hashIndex < 0 ? url : url.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf("?");
  const path = queryIndex < 0 ? withoutHash : withoutHash.slice(0, queryIndex);
  const query = new URLSearchParams(queryIndex < 0 ? "" : withoutHash.slice(queryIndex + 1));
  query.set("cursor", cursor);
  return `${path}?${query.toString()}${hash}`;
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
  let offlineTimer: number | undefined;
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

  const clearOffline = () => {
    if (offlineTimer === undefined) return;
    dependencies.cancel(offlineTimer);
    offlineTimer = undefined;
  };

  const scheduleOffline = () => {
    if (disposed || offlineTimer !== undefined || lastConnectionState === false) return;
    offlineTimer = dependencies.schedule(() => {
      offlineTimer = undefined;
      if (!disposed) reportConnection(false);
    }, EVENT_STREAM_OFFLINE_GRACE_MS);
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
      scheduleOffline();
      scheduleReconnect();
      return;
    }
    currentSource = source;
    source.onopen = () => {
      if (disposed || currentSource !== source) return;
      retryAttempt = 0;
      clearRetry();
      clearOffline();
      reportConnection(true);
    };
    source.onerror = () => {
      if (disposed || currentSource !== source) return;
      scheduleOffline();
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
    clearOffline();
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

async function logicalIntentStorageKey(fingerprint: string): Promise<string | undefined> {
  try {
    if (!crypto.subtle) {
      return undefined;
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprint));
    const hex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return `codex-remote:idempotency:${hex}`;
  } catch {
    return undefined;
  }
}

function sessionStorageIfAvailable(): Storage | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

export class HttpApiClient implements ApiClient {
  readonly demo = false;
  private apiRoot: string;
  private csrfToken: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly pendingIdempotencyKeys = new Map<string, string>();

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
    const logicalIntent =
      options.idempotent && options.idempotencyKey === undefined
        ? await this.acquireLogicalIdempotencyKey(path, options)
        : undefined;
    const idempotencyKey = options.idempotent
      ? (options.idempotencyKey ?? logicalIntent?.key)
      : undefined;
    const execute = async () => {
      const headers = new Headers(options.headers);
      headers.set("Accept", "application/json");
      if (options.body !== undefined && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
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
        if (firstFailure.code === "IDEMPOTENCY_REPLAY_REQUIRES_REFRESH") {
          this.retireLogicalIdempotencyKey(logicalIntent);
        }
        throw new ApiRequestError(firstFailure.message, response.status, firstFailure.code);
      }
    }
    if (!response.ok) {
      const failure = await apiErrorPayload(response);
      if (failure.code === "IDEMPOTENCY_REPLAY_REQUIRES_REFRESH") {
        this.retireLogicalIdempotencyKey(logicalIntent);
      }
      throw new ApiRequestError(failure.message, response.status, failure.code);
    }
    if (response.status === 204) {
      this.retireLogicalIdempotencyKey(logicalIntent);
      return undefined as T;
    }
    const body = await response.text();
    const result = body.length === 0 ? (undefined as T) : (JSON.parse(body) as T);
    this.retireLogicalIdempotencyKey(logicalIntent);
    return result;
  }

  private async acquireLogicalIdempotencyKey(
    path: string,
    options: RequestInit,
  ): Promise<{ fingerprint: string; key: string; storageKey?: string }> {
    const method = (options.method ?? "GET").toUpperCase();
    const body = typeof options.body === "string" ? options.body : "";
    const fingerprint = `${method}\u0000${this.apiRoot}${path}\u0000${body}`;
    const inMemory = this.pendingIdempotencyKeys.get(fingerprint);
    if (inMemory) {
      return { fingerprint, key: inMemory };
    }

    const storageKey = await logicalIntentStorageKey(fingerprint);
    const storage = sessionStorageIfAvailable();
    const persisted = storageKey ? storage?.getItem(storageKey) : undefined;
    const key =
      persisted && /^[A-Za-z0-9._:-]{8,200}$/u.test(persisted) ? persisted : crypto.randomUUID();
    this.pendingIdempotencyKeys.set(fingerprint, key);
    if (storageKey) {
      try {
        storage?.setItem(storageKey, key);
      } catch {
        // Private browsing or a full storage quota must not block the request.
      }
    }
    return { fingerprint, key, ...(storageKey ? { storageKey } : {}) };
  }

  private retireLogicalIdempotencyKey(
    intent: { fingerprint: string; key: string; storageKey?: string } | undefined,
  ): void {
    if (!intent || this.pendingIdempotencyKeys.get(intent.fingerprint) !== intent.key) {
      return;
    }
    this.pendingIdempotencyKeys.delete(intent.fingerprint);
    if (intent.storageKey) {
      try {
        const storage = sessionStorageIfAvailable();
        if (storage?.getItem(intent.storageKey) === intent.key) {
          storage.removeItem(intent.storageKey);
        }
      } catch {
        // The in-memory lifecycle remains authoritative for this page.
      }
    }
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

  private async requestPage<T>(
    path: string,
  ): Promise<CursorPage<T> & { historyIntegrity?: SubagentHistoryIntegrity }> {
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
    const historyIntegrity = subagentHistoryIntegrityFrom(response.headers);
    return {
      items,
      ...(nextCursor ? { nextCursor } : {}),
      ...(historyIntegrity ? { historyIntegrity } : {}),
    };
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

  thread(id: string, historyCursor?: string) {
    const query =
      historyCursor === undefined ? "" : `?${new URLSearchParams({ historyCursor }).toString()}`;
    return this.request<ThreadDetail>(`/threads/${encodeURIComponent(id)}${query}`);
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

  setThreadName(threadId: string, name: string) {
    return this.request<void>(`/threads/${encodeURIComponent(threadId)}/name`, {
      body: JSON.stringify({ name }),
      idempotent: true,
      method: "PUT",
      mutation: true,
    });
  }

  setThreadArchived(threadId: string, archived: boolean) {
    return this.request<void>(`/threads/${encodeURIComponent(threadId)}/archive`, {
      body: JSON.stringify({ archived }),
      idempotent: true,
      method: "PUT",
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

  fileRoots() {
    return this.request<FileRoot[]>("/file-roots");
  }

  createFolder(projectId: string, path: string) {
    return this.request<void>("/files/folders", {
      body: JSON.stringify({ path, projectId }),
      idempotent: true,
      method: "POST",
      mutation: true,
    });
  }

  writeHostFile(projectId: string, path: string, file: File, overwrite = false) {
    const query = new URLSearchParams({ overwrite: String(overwrite), path, projectId });
    return this.request<void>(`/files/content?${query.toString()}`, {
      body: file,
      headers: { "Content-Type": "application/octet-stream" },
      idempotent: true,
      method: "PUT",
      mutation: true,
    });
  }

  renameHostFile(projectId: string, path: string, name: string) {
    return this.request<void>("/files/rename", {
      body: JSON.stringify({ name, path, projectId }),
      idempotent: true,
      method: "POST",
      mutation: true,
    });
  }

  copyHostFile(input: {
    sourceProjectId: string;
    sourcePath: string;
    targetProjectId: string;
    targetPath: string;
    overwrite?: boolean;
  }) {
    return this.request<void>("/files/copy", {
      body: JSON.stringify(input),
      idempotent: true,
      method: "POST",
      mutation: true,
    });
  }

  moveHostFile(input: {
    sourceProjectId: string;
    sourcePath: string;
    targetProjectId: string;
    targetPath: string;
    overwrite?: boolean;
  }) {
    return this.request<void>("/files/move", {
      body: JSON.stringify(input),
      idempotent: true,
      method: "POST",
      mutation: true,
    });
  }

  deleteHostFile(projectId: string, path: string, permanent = false) {
    return this.request<void>("/files", {
      body: JSON.stringify({ path, permanent, projectId }),
      idempotent: true,
      method: "DELETE",
      mutation: true,
    });
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
    options: { cursor?: string; threadId?: string } = {},
  ) {
    const parameters = new URLSearchParams();
    if (options.threadId) parameters.set("threadId", options.threadId);
    if (options.cursor) parameters.set("cursor", options.cursor);
    const query = parameters.size > 0 ? `?${parameters.toString()}` : "";
    return subscribeRemoteEvents(`${this.apiRoot}/events${query}`, onEvent, onConnection);
  }
}

class DemoApiClient implements ApiClient {
  readonly demo = true;
  private detail: ThreadDetail = structuredClone(demoThreadDetail);
  private threadSummaries: ThreadSummary[] = structuredClone(demoThreads);
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
    return this.later<ApprovalReviewerOption[]>([{ id: "user" }, { id: "auto_review" }]);
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
      items: this.threadSummaries.filter(
        (thread) => Boolean(thread.archived) === Boolean(options.archived),
      ),
    });
  }

  thread(id: string, _historyCursor?: string): Promise<ThreadDetail> {
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
            id: `${id}-request`,
            kind: "user-message",
            text: "只检查分配给你的模块，并把可验证结论返回父对话。",
          },
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
          {
            id: `${id}-verification`,
            kind: "assistant-message",
            phase: "commentary",
            text: "相关文件和边界已经核对完成，正在整理可以回读的验证结果。",
          },
          {
            id: `${id}-answer`,
            kind: "assistant-message",
            text: "子任务已完成：检查记录、工具活动和最终结论都保留在这个子智能体对话中。",
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
    const summary = this.threadSummaries.find((thread) => thread.id === id) ?? demoThreads[0]!;
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

  async setThreadName(threadId: string, name: string) {
    this.threadSummaries = this.threadSummaries.map((thread) =>
      thread.id === threadId ? { ...thread, title: name } : thread,
    );
    if (this.detail.id === threadId) {
      this.detail = { ...this.detail, title: name };
    }
    return this.later(undefined);
  }

  async setThreadArchived(threadId: string, archived: boolean) {
    this.threadSummaries = this.threadSummaries.map((thread) => {
      if (thread.id !== threadId) return thread;
      const { archived: _archived, pinnedRank: _pinnedRank, ...rest } = thread;
      return archived ? { ...rest, archived: true } : rest;
    });
    if (this.detail.id === threadId) {
      const { archived: _archived, pinnedRank: _pinnedRank, ...rest } = this.detail;
      this.detail = archived ? { ...rest, archived: true } : rest;
    }
    return this.later(undefined);
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
    const existing = this.goalsByThread.get(threadId);
    const tokenBudget = input.tokenBudget ?? existing?.tokenBudget;
    const goal: ThreadGoal = {
      threadId,
      objective: input.objective ?? existing?.objective ?? "持续完成当前任务",
      status: input.status ?? existing?.status ?? "active",
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
      tokensUsed: existing?.tokensUsed ?? 0,
      timeUsedSeconds: existing?.timeUsedSeconds ?? 0,
      createdAt: existing?.createdAt ?? timestamp,
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

  subagents(threadId: string, _cursor?: string): Promise<SubagentCursorPage> {
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

  fileRoots() {
    return this.later<FileRoot[]>([
      {
        id: "host-root:C",
        kind: "host",
        name: "C:",
        rootLabel: "C:\\",
      },
      {
        id: "host-root:V",
        kind: "host",
        name: "V:",
        rootLabel: "V:\\",
      },
    ]);
  }

  createFolder(_projectId: string, _path: string) {
    return this.later(undefined);
  }

  writeHostFile(_projectId: string, _path: string, _file: File, _overwrite = false) {
    return this.later(undefined);
  }

  renameHostFile(_projectId: string, _path: string, _name: string) {
    return this.later(undefined);
  }

  copyHostFile(_input: {
    sourceProjectId: string;
    sourcePath: string;
    targetProjectId: string;
    targetPath: string;
    overwrite?: boolean;
  }) {
    return this.later(undefined);
  }

  moveHostFile(_input: {
    sourceProjectId: string;
    sourcePath: string;
    targetProjectId: string;
    targetPath: string;
    overwrite?: boolean;
  }) {
    return this.later(undefined);
  }

  deleteHostFile(_projectId: string, _path: string, _permanent = false) {
    return this.later(undefined);
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
    _options: { cursor?: string; threadId?: string } = {},
  ) {
    onConnection(true);
    return () => undefined;
  }
}

export function createApiClient(): ApiClient {
  const demoRequested = isDemoModeAllowed({
    buildEnabled: import.meta.env.VITE_DEMO_MODE === "true",
    hostname: window.location.hostname,
    search: window.location.search,
    storedPreference: window.localStorage.getItem("local-remote-demo"),
  });
  return demoRequested ? new DemoApiClient() : new HttpApiClient();
}
