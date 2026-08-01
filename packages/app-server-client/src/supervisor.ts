import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

import type {
  CodexDiscoveryDiagnostic,
  CodexDiscoveryResult,
  CodexExecutable,
  CodexExecutableSource,
} from "./discovery.js";
import { discoverCodexExecutables } from "./discovery.js";
import type { AppServerInitialization } from "./initialize.js";
import { initializeAppServer } from "./initialize.js";
import type { RpcNotification, RpcRequestOptions, RpcServerRequest } from "./jsonl-connection.js";
import {
  JsonlRpcConnection,
  RpcConnectionClosedError,
  RpcRequestError,
  RpcTimeoutError,
} from "./jsonl-connection.js";
import type { WebSocketFactory } from "./websocket-connection.js";
import {
  normalizeLoopbackWebSocketEndpoint,
  WebSocketRpcConnection,
} from "./websocket-connection.js";

export type CapabilityState = "available" | "degraded" | "unavailable";
export type AppServerTransportMode = "owned-stdio" | "shared-websocket";

export interface CapabilitySupport {
  state: CapabilityState;
  reason?: "method-not-supported" | "not-advertised" | "probe-failed";
}

export interface AppServerCapabilities {
  account: CapabilitySupport;
  approvalReviewers?: CapabilitySupport;
  collaborationModes: CapabilitySupport;
  compact?: CapabilitySupport;
  goals?: CapabilitySupport;
  models: CapabilitySupport;
  permissions: CapabilitySupport;
  rateLimits: CapabilitySupport;
  serviceTiers?: CapabilitySupport;
  settingsUpdate?: CapabilitySupport;
  threadList?: CapabilitySupport;
  usage: CapabilitySupport;
}

export interface AppServerSession {
  capabilities: AppServerCapabilities;
  executableSource?: CodexExecutableSource;
  initialization: AppServerInitialization;
  transportMode?: AppServerTransportMode;
  notify(method: string, params?: unknown): Promise<void>;
  onExit(listener: (error?: Error) => void): () => void;
  onNotification(listener: (notification: RpcNotification) => void): () => void;
  onServerRequest(listener: (request: RpcServerRequest) => void): () => void;
  request<T = unknown>(method: string, params?: unknown, options?: RpcRequestOptions): Promise<T>;
  stop(): Promise<void>;
}

export interface AppServerSupervisorSnapshot {
  state: "stopped" | "starting" | "running" | "degraded";
  codexHome?: string;
  endpoint?: string;
  executableSource?: CodexExecutableSource;
  mode: AppServerTransportMode;
  userAgent?: string;
  capabilities?: AppServerCapabilities;
  diagnostics: CodexDiscoveryDiagnostic[];
  restartAttempt: number;
  runtimeFailureCount: number;
}

interface SupervisorEvents {
  notification: [notification: RpcNotification];
  serverRequest: [request: RpcServerRequest];
  state: [snapshot: AppServerSupervisorSnapshot];
}

export interface AppServerSupervisorOptions {
  candidateProvider?: () => Promise<CodexDiscoveryResult>;
  clientVersion?: string;
  connectSharedSession?: (endpoint: string) => Promise<AppServerSession>;
  connectionTimeoutMs?: number;
  endpoint?: string;
  initializationTimeoutMs?: number;
  launchCandidate?: (candidate: CodexExecutable) => Promise<AppServerSession>;
  maxFrameBytes?: number;
  mode?: AppServerTransportMode;
  probeTimeoutMs?: number;
  requestTimeoutMs?: number;
  restartDelaysMs?: number[];
  runtimeFailureLimit?: number;
  runtimeFailureWindowMs?: number;
  webSocketFactory?: WebSocketFactory;
}

export class AppServerLaunchError extends Error {
  readonly attempts: Array<{
    source: CodexExecutableSource;
    stage: "launch-or-initialize";
  }>;

  constructor(attempts: Array<{ source: CodexExecutableSource; stage: "launch-or-initialize" }>) {
    super("无法启动可用的 Codex 后台连接");
    this.name = "AppServerLaunchError";
    this.attempts = attempts;
  }
}

export class SharedAppServerConnectionError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string) {
    super("无法连接共享 Codex 后台");
    this.name = "SharedAppServerConnectionError";
    this.endpoint = endpoint;
  }
}

export async function probeAppServerCapabilities(
  request: (method: string, params?: unknown, options?: RpcRequestOptions) => Promise<unknown>,
  timeoutMs = 5_000,
): Promise<AppServerCapabilities> {
  const probeWithResult = async (
    method: string,
    params?: unknown,
  ): Promise<{ result?: unknown; support: CapabilitySupport }> => {
    try {
      const result = await request(method, params, { timeoutMs });
      return { result, support: { state: "available" } };
    } catch (error) {
      if (error instanceof RpcRequestError && error.code === -32_601) {
        return {
          support: { reason: "method-not-supported", state: "unavailable" },
        };
      }
      return { support: { reason: "probe-failed", state: "degraded" } };
    }
  };
  const probe = async (method: string, params?: unknown): Promise<CapabilitySupport> =>
    (await probeWithResult(method, params)).support;
  const probeModelCatalog = async (): Promise<{
    result?: unknown;
    support: CapabilitySupport;
  }> => {
    const data: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let firstSupport: CapabilitySupport | undefined;

    for (let page = 0; page < 20; page += 1) {
      const probeResult = await probeWithResult("model/list", {
        ...(cursor === undefined ? {} : { cursor }),
        includeHidden: false,
        limit: 100,
      });
      firstSupport ??= probeResult.support;
      if (probeResult.support.state !== "available") {
        return page === 0
          ? probeResult
          : {
              result: { data, nextCursor: cursor },
              support: firstSupport,
            };
      }
      const result = isRecord(probeResult.result) ? probeResult.result : {};
      if (!Array.isArray(result.data)) {
        return { result: probeResult.result, support: firstSupport };
      }
      const pageData = result.data as unknown[];
      data.push(...pageData);
      const nextCursor =
        typeof result.nextCursor === "string" && result.nextCursor.length > 0
          ? result.nextCursor
          : undefined;
      if (!nextCursor) {
        return { result: { ...result, data }, support: firstSupport };
      }
      if (seenCursors.has(nextCursor) || page === 19) {
        return {
          result: { ...result, data, nextCursor },
          support: firstSupport,
        };
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return {
      result: { data, nextCursor: cursor },
      support: firstSupport ?? { reason: "probe-failed", state: "degraded" },
    };
  };

  const probeMethodPresence = async (
    method: string,
    params: unknown,
  ): Promise<CapabilitySupport> => {
    try {
      await request(method, params, { timeoutMs });
      return { state: "available" };
    } catch (error) {
      if (error instanceof RpcRequestError) {
        if (error.code === -32_601) {
          return { reason: "method-not-supported", state: "unavailable" };
        }
        if (isStructuredSentinelThreadMiss(error, method, missingThreadId)) {
          return { state: "available" };
        }
      }
      return { reason: "probe-failed", state: "degraded" };
    }
  };

  const missingThreadId = "00000000-0000-0000-0000-000000000000";
  const [
    modelsProbe,
    account,
    rateLimits,
    usage,
    permissions,
    approvalReviewersProbe,
    collaborationModes,
    threadList,
    compact,
    goals,
    settingsUpdate,
  ] = await Promise.all([
    probeModelCatalog(),
    probe("account/read", { refreshToken: false }),
    probe("account/rateLimits/read"),
    probe("account/usage/read"),
    probe("permissionProfile/list", { limit: 1 }),
    probeWithResult("configRequirements/read"),
    probe("collaborationMode/list", {}),
    probe("thread/list", {
      archived: false,
      limit: 1,
      sortDirection: "desc",
      sortKey: "updated_at",
    }),
    probeMethodPresence("thread/compact/start", { threadId: missingThreadId }),
    probeMethodPresence("thread/goal/get", { threadId: missingThreadId }),
    probeMethodPresence("thread/settings/update", { threadId: missingThreadId }),
  ]);
  const serviceTiers = serviceTierSupport(modelsProbe);
  const approvalReviewers = approvalReviewerCatalogSupport(approvalReviewersProbe);

  return {
    account,
    approvalReviewers,
    collaborationModes,
    compact,
    goals,
    models: modelsProbe.support,
    permissions,
    rateLimits,
    serviceTiers,
    settingsUpdate,
    threadList,
    usage,
  };
}

function approvalReviewerCatalogSupport(probe: {
  result?: unknown;
  support: CapabilitySupport;
}): CapabilitySupport {
  if (probe.support.state !== "available") {
    return probe.support;
  }
  const result = isRecord(probe.result) ? probe.result : {};
  const requirements = isRecord(result.requirements) ? result.requirements : {};
  const advertised = requirements.allowedApprovalsReviewers;
  if (
    !Array.isArray(advertised) ||
    advertised.length === 0 ||
    advertised.some((reviewer) => typeof reviewer !== "string" || reviewer.length === 0)
  ) {
    return { reason: "not-advertised", state: "unavailable" };
  }
  return { state: "available" };
}

function isStructuredSentinelThreadMiss(
  error: RpcRequestError,
  method: string,
  sentinelThreadId: string,
): boolean {
  if (error.code !== -32_000 || error.method !== method || !isRecord(error.data)) {
    return false;
  }
  return (
    error.data.kind === "not_found" &&
    error.data.method === method &&
    error.data.resource === "thread" &&
    error.data.resourceId === sentinelThreadId
  );
}

function serviceTierSupport(probe: {
  result?: unknown;
  support: CapabilitySupport;
}): CapabilitySupport {
  if (probe.support.state !== "available") {
    return probe.support;
  }
  if (!isRecord(probe.result) || !Array.isArray(probe.result.data)) {
    return { reason: "probe-failed", state: "degraded" };
  }
  const advertised = probe.result.data.some((model) => {
    if (!isRecord(model) || !Array.isArray(model.serviceTiers)) {
      return false;
    }
    return model.serviceTiers.some(
      (tier) =>
        isRecord(tier) &&
        typeof tier.id === "string" &&
        tier.id.length > 0 &&
        ((typeof tier.name === "string" && tier.name.length > 0) ||
          (typeof tier.displayName === "string" && tier.displayName.length > 0)),
    );
  });
  if (advertised) {
    return { state: "available" };
  }
  if (typeof probe.result.nextCursor === "string" && probe.result.nextCursor.length > 0) {
    return { reason: "probe-failed", state: "degraded" };
  }
  return probe.result.data.length === 0
    ? { reason: "probe-failed", state: "degraded" }
    : { reason: "not-advertised", state: "unavailable" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function launchAppServerSession(
  candidate: CodexExecutable,
  options: {
    clientVersion: string;
    initializationTimeoutMs?: number;
    probeTimeoutMs?: number;
    requestTimeoutMs?: number;
  },
): Promise<AppServerSession> {
  const child = spawn(candidate.path, ["app-server", "--stdio"], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  try {
    // app-server may write operational diagnostics to stderr. We deliberately
    // drain instead of logging it: an unread pipe can deadlock the child, while
    // retaining it could persist prompts, paths, or tool output.
    child.stderr.resume();
    await waitForSpawn(child);
    const connection = new JsonlRpcConnection({
      readable: child.stdout,
      writable: child.stdin,
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { defaultTimeoutMs: options.requestTimeoutMs }),
    });
    const initialization = await initializeAppServer(connection, {
      clientVersion: options.clientVersion,
      experimentalApi: true,
      ...(options.initializationTimeoutMs === undefined
        ? {}
        : { timeoutMs: options.initializationTimeoutMs }),
    });
    const capabilities = await probeAppServerCapabilities(
      connection.request.bind(connection),
      options.probeTimeoutMs,
    );
    return new ChildProcessAppServerSession(
      child,
      connection,
      candidate.source,
      initialization,
      capabilities,
    );
  } catch (error) {
    terminateOwnedChild(child);
    throw error;
  }
}

export async function connectSharedAppServerSession(
  endpoint: string,
  options: {
    clientVersion: string;
    connectionTimeoutMs?: number;
    initializationTimeoutMs?: number;
    maxFrameBytes?: number;
    probeTimeoutMs?: number;
    requestTimeoutMs?: number;
    webSocketFactory?: WebSocketFactory;
  },
): Promise<AppServerSession> {
  const connection = await WebSocketRpcConnection.connect({
    endpoint,
    ...(options.connectionTimeoutMs === undefined
      ? {}
      : { connectionTimeoutMs: options.connectionTimeoutMs }),
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { defaultTimeoutMs: options.requestTimeoutMs }),
    ...(options.webSocketFactory === undefined
      ? {}
      : { webSocketFactory: options.webSocketFactory }),
  });

  try {
    const initialization = await initializeAppServer(connection, {
      clientVersion: options.clientVersion,
      experimentalApi: true,
      ...(options.initializationTimeoutMs === undefined
        ? {}
        : { timeoutMs: options.initializationTimeoutMs }),
    });
    const capabilities = await probeAppServerCapabilities(
      connection.request.bind(connection),
      options.probeTimeoutMs,
    );
    return new SharedWebSocketAppServerSession(connection, initialization, capabilities);
  } catch (error) {
    connection.close(
      error instanceof Error
        ? new RpcConnectionClosedError(error.message)
        : new RpcConnectionClosedError("共享 Codex 后台初始化失败"),
    );
    throw error;
  }
}

export class AppServerSupervisor extends EventEmitter<SupervisorEvents> {
  readonly #candidateProvider: () => Promise<CodexDiscoveryResult>;
  readonly #connectSharedSession: (endpoint: string) => Promise<AppServerSession>;
  readonly #endpoint: string | undefined;
  readonly #launchCandidate: (candidate: CodexExecutable) => Promise<AppServerSession>;
  readonly #mode: AppServerTransportMode;
  readonly #restartDelaysMs: number[];
  readonly #runtimeFailureLimit: number;
  readonly #runtimeFailureWindowMs: number;
  #diagnostics: CodexDiscoveryDiagnostic[] = [];
  #detachSessionListeners: Array<() => void> = [];
  #intendedRunning = false;
  #lifecycleChain: Promise<void> = Promise.resolve();
  #restartAttempt = 0;
  #restartTimer: NodeJS.Timeout | undefined;
  #runtimeFailures: number[] = [];
  #session: AppServerSession | undefined;
  #state: AppServerSupervisorSnapshot["state"] = "stopped";

  constructor(options: AppServerSupervisorOptions = {}) {
    super();
    const clientVersion = options.clientVersion ?? "0.1.0";
    this.#mode = options.mode ?? "owned-stdio";
    this.#endpoint =
      this.#mode === "shared-websocket"
        ? normalizeLoopbackWebSocketEndpoint(
            options.endpoint ??
              (() => {
                throw new TypeError("shared-websocket 模式必须配置 endpoint");
              })(),
          )
        : undefined;
    this.#candidateProvider = options.candidateProvider ?? (() => discoverCodexExecutables());
    this.#restartDelaysMs = options.restartDelaysMs ?? [500, 1_000, 2_500, 5_000, 10_000];
    this.#runtimeFailureLimit = Math.max(1, Math.trunc(options.runtimeFailureLimit ?? 3));
    this.#runtimeFailureWindowMs = Math.max(
      1,
      Math.trunc(options.runtimeFailureWindowMs ?? 60_000),
    );
    this.#launchCandidate =
      options.launchCandidate ??
      (async (candidate) =>
        await launchAppServerSession(candidate, {
          clientVersion,
          ...(options.initializationTimeoutMs === undefined
            ? {}
            : { initializationTimeoutMs: options.initializationTimeoutMs }),
          ...(options.probeTimeoutMs === undefined
            ? {}
            : { probeTimeoutMs: options.probeTimeoutMs }),
          ...(options.requestTimeoutMs === undefined
            ? {}
            : { requestTimeoutMs: options.requestTimeoutMs }),
        }));
    this.#connectSharedSession =
      options.connectSharedSession ??
      (async (endpoint) =>
        await connectSharedAppServerSession(endpoint, {
          clientVersion,
          ...(options.connectionTimeoutMs === undefined
            ? {}
            : { connectionTimeoutMs: options.connectionTimeoutMs }),
          ...(options.initializationTimeoutMs === undefined
            ? {}
            : { initializationTimeoutMs: options.initializationTimeoutMs }),
          ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
          ...(options.probeTimeoutMs === undefined
            ? {}
            : { probeTimeoutMs: options.probeTimeoutMs }),
          ...(options.requestTimeoutMs === undefined
            ? {}
            : { requestTimeoutMs: options.requestTimeoutMs }),
          ...(options.webSocketFactory === undefined
            ? {}
            : { webSocketFactory: options.webSocketFactory }),
        }));
  }

  async start(): Promise<void> {
    this.#intendedRunning = true;
    await this.#enqueueLifecycle(async () => {
      if (!this.#intendedRunning || this.#session || this.#restartTimer) {
        return;
      }
      await this.#startNow();
    });
  }

  async stop(): Promise<void> {
    this.#intendedRunning = false;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
    }
    await this.#enqueueLifecycle(async () => {
      this.#detachActiveSession();
      const session = this.#session;
      this.#session = undefined;
      if (session) {
        await session.stop();
      }
      this.#restartAttempt = 0;
      this.#runtimeFailures = [];
      this.#setState("stopped");
    });
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: RpcRequestOptions,
  ): Promise<T> {
    if (!this.#session) {
      await this.start();
    }
    const session = this.#session;
    if (!session) {
      throw new RpcConnectionClosedError("Codex 后台尚未就绪");
    }
    try {
      const result = await session.request<T>(method, params, options);
      if (this.#session === session) {
        this.#pruneRuntimeFailures(Date.now());
      }
      return result;
    } catch (error) {
      if (error instanceof RpcTimeoutError || error instanceof RpcConnectionClosedError) {
        await this.#recycleFailedSession(session);
      } else if (this.#session === session) {
        // A structured RPC error still proves that the active runtime answered.
        this.#pruneRuntimeFailures(Date.now());
      }
      throw error;
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (!this.#session) {
      await this.start();
    }
    const session = this.#session;
    if (!session) {
      throw new RpcConnectionClosedError("Codex 后台尚未就绪");
    }
    try {
      await session.notify(method, params);
    } catch (error) {
      if (error instanceof RpcTimeoutError || error instanceof RpcConnectionClosedError) {
        await this.#recycleFailedSession(session);
      }
      throw error;
    }
  }

  snapshot(): AppServerSupervisorSnapshot {
    const session = this.#session;
    return {
      state: this.#state,
      mode: this.#mode,
      diagnostics: [...this.#diagnostics],
      restartAttempt: this.#restartAttempt,
      runtimeFailureCount: this.#runtimeFailureCount(),
      ...(this.#endpoint === undefined ? {} : { endpoint: this.#endpoint }),
      ...(session
        ? {
            capabilities: session.capabilities,
            codexHome: session.initialization.codexHome,
            userAgent: session.initialization.userAgent,
            ...(session.executableSource === undefined
              ? {}
              : { executableSource: session.executableSource }),
          }
        : {}),
    };
  }

  #enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const result = this.#lifecycleChain.then(operation, operation);
    this.#lifecycleChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #startNow(): Promise<void> {
    this.#setState("starting");
    if (this.#mode === "shared-websocket") {
      const endpoint = this.#endpoint;
      if (!endpoint) {
        this.#setState("degraded");
        throw new SharedAppServerConnectionError("");
      }
      try {
        const session = await this.#connectSharedSession(endpoint);
        if (!this.#intendedRunning) {
          await session.stop();
          return;
        }
        this.#attachSession(session);
        this.#restartAttempt = 0;
        this.#setState("running");
        return;
      } catch {
        this.#setState("degraded");
        if (this.#intendedRunning) {
          this.#scheduleRestart();
        }
        throw new SharedAppServerConnectionError(endpoint);
      }
    }

    let discovery: CodexDiscoveryResult;
    try {
      discovery = await this.#candidateProvider();
    } catch {
      this.#diagnostics = [];
      this.#setState("degraded");
      if (this.#intendedRunning) {
        this.#scheduleRestart();
      }
      throw new AppServerLaunchError([]);
    }
    this.#diagnostics = [...discovery.diagnostics];
    const attempts: AppServerLaunchError["attempts"] = [];

    for (const candidate of discovery.candidates) {
      try {
        const session = await this.#launchCandidate(candidate);
        if (!this.#intendedRunning) {
          await session.stop();
          return;
        }
        this.#attachSession(session);
        this.#restartAttempt = 0;
        this.#setState("running");
        return;
      } catch {
        attempts.push({ source: candidate.source, stage: "launch-or-initialize" });
      }
    }

    this.#setState("degraded");
    if (this.#intendedRunning) {
      this.#scheduleRestart();
    }
    throw new AppServerLaunchError(attempts);
  }

  #attachSession(session: AppServerSession): void {
    this.#detachActiveSession();
    this.#session = session;
    this.#detachSessionListeners = [
      session.onNotification((notification) => {
        this.emit("notification", notification);
      }),
      session.onServerRequest((request) => {
        this.emit("serverRequest", request);
      }),
      session.onExit(() => {
        if (this.#session !== session) {
          return;
        }
        this.#detachActiveSession();
        this.#session = undefined;
        this.#recordRuntimeFailure();
        this.#setState("degraded");
        if (this.#intendedRunning) {
          this.#scheduleRestart();
        }
      }),
    ];
  }

  async #recycleFailedSession(session: AppServerSession): Promise<void> {
    await this.#enqueueLifecycle(async () => {
      if (this.#session !== session) {
        return;
      }
      this.#detachActiveSession();
      this.#session = undefined;
      this.#recordRuntimeFailure();
      await session.stop().catch(() => undefined);
      this.#setState("degraded");
      if (this.#intendedRunning) {
        this.#scheduleRestart();
      }
    });
  }

  #detachActiveSession(): void {
    for (const detach of this.#detachSessionListeners.splice(0)) {
      detach();
    }
  }

  #scheduleRestart(): void {
    if (this.#restartTimer || !this.#intendedRunning) {
      return;
    }
    const index = Math.min(this.#restartAttempt, this.#restartDelaysMs.length - 1);
    const retryDelay = this.#restartDelaysMs[index] ?? 5_000;
    const now = Date.now();
    this.#pruneRuntimeFailures(now);
    const oldestFailure = this.#runtimeFailures[0];
    const circuitDelay =
      this.#runtimeFailures.length >= this.#runtimeFailureLimit && oldestFailure !== undefined
        ? Math.max(0, oldestFailure + this.#runtimeFailureWindowMs - now)
        : 0;
    const delay = Math.max(retryDelay, circuitDelay);
    this.#restartAttempt += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      if (!this.#intendedRunning) {
        return;
      }
      void this.start().catch(() => {
        this.#scheduleRestart();
      });
    }, delay);
    this.#restartTimer.unref();
    this.emit("state", this.snapshot());
  }

  #recordRuntimeFailure(): void {
    const now = Date.now();
    this.#pruneRuntimeFailures(now);
    this.#runtimeFailures.push(now);
  }

  #runtimeFailureCount(): number {
    this.#pruneRuntimeFailures(Date.now());
    return this.#runtimeFailures.length;
  }

  #pruneRuntimeFailures(now: number): void {
    const cutoff = now - this.#runtimeFailureWindowMs;
    while (this.#runtimeFailures[0] !== undefined && this.#runtimeFailures[0] <= cutoff) {
      this.#runtimeFailures.shift();
    }
  }

  #setState(state: AppServerSupervisorSnapshot["state"]): void {
    this.#state = state;
    this.emit("state", this.snapshot());
  }
}

export class ChildProcessAppServerSession implements AppServerSession {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #connection: JsonlRpcConnection;
  readonly #exitListeners = new Set<(error?: Error) => void>();
  #exitError: Error | undefined;
  #exited = false;
  #notifyLateExit = false;
  readonly capabilities: AppServerCapabilities;
  readonly executableSource: CodexExecutableSource;
  readonly initialization: AppServerInitialization;

  constructor(
    child: ChildProcessWithoutNullStreams,
    connection: JsonlRpcConnection,
    executableSource: CodexExecutableSource,
    initialization: AppServerInitialization,
    capabilities: AppServerCapabilities,
  ) {
    this.#child = child;
    this.#connection = connection;
    this.executableSource = executableSource;
    this.initialization = initialization;
    this.capabilities = capabilities;
    this.#child.once("exit", this.#handleExit);
    this.#child.once("error", this.#handleError);
    this.#connection.once("closed", this.#handleConnectionClosed);
    if (this.#connection.closed) {
      const error = this.#connection.closeReason ?? new RpcConnectionClosedError();
      this.#handleConnectionClosed(error);
      throw error;
    }
  }

  request<T = unknown>(method: string, params?: unknown, options?: RpcRequestOptions): Promise<T> {
    return this.#connection.request<T>(method, params, options);
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.#connection.notify(method, params);
  }

  onNotification(listener: (notification: RpcNotification) => void): () => void {
    this.#connection.on("notification", listener);
    return () => {
      this.#connection.off("notification", listener);
    };
  }

  onServerRequest(listener: (request: RpcServerRequest) => void): () => void {
    this.#connection.on("serverRequest", listener);
    return () => {
      this.#connection.off("serverRequest", listener);
    };
  }

  onExit(listener: (error?: Error) => void): () => void {
    if (this.#notifyLateExit) {
      let subscribed = true;
      queueMicrotask(() => {
        if (subscribed) {
          listener(this.#exitError);
        }
      });
      return () => {
        subscribed = false;
      };
    }
    this.#exitListeners.add(listener);
    return () => {
      this.#exitListeners.delete(listener);
    };
  }

  stop(): Promise<void> {
    if (this.#exited) {
      return Promise.resolve();
    }
    this.#exited = true;
    this.#child.off("exit", this.#handleExit);
    this.#child.off("error", this.#handleError);
    this.#connection.off("closed", this.#handleConnectionClosed);
    this.#connection.close();
    terminateOwnedChild(this.#child);
    this.#exitListeners.clear();
    return Promise.resolve();
  }

  readonly #handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    const detail =
      code === 0 ? undefined : new Error(signal ? "Codex 后台被终止" : "Codex 后台异常退出");
    this.#emitExit(detail);
  };

  readonly #handleError = (): void => {
    this.#emitExit(new Error("Codex 后台进程错误"), true);
  };

  readonly #handleConnectionClosed = (error: Error): void => {
    this.#emitExit(error, true);
  };

  #emitExit(error?: Error, terminateChild = false): void {
    if (this.#exited) {
      return;
    }
    this.#exited = true;
    this.#notifyLateExit = true;
    this.#exitError = error;
    this.#child.off("exit", this.#handleExit);
    this.#child.off("error", this.#handleError);
    this.#connection.off("closed", this.#handleConnectionClosed);
    this.#connection.close(error ?? new RpcConnectionClosedError());
    if (terminateChild) {
      terminateOwnedChild(this.#child);
    }
    for (const listener of this.#exitListeners) {
      listener(error);
    }
    this.#exitListeners.clear();
  }
}

export class SharedWebSocketAppServerSession implements AppServerSession {
  readonly #connection: WebSocketRpcConnection;
  readonly #exitListeners = new Set<(error?: Error) => void>();
  #exitError: Error | undefined;
  #exited = false;
  #notifyLateExit = false;
  readonly capabilities: AppServerCapabilities;
  readonly initialization: AppServerInitialization;
  readonly transportMode = "shared-websocket" as const;

  constructor(
    connection: WebSocketRpcConnection,
    initialization: AppServerInitialization,
    capabilities: AppServerCapabilities,
  ) {
    this.#connection = connection;
    this.initialization = initialization;
    this.capabilities = capabilities;
    this.#connection.once("closed", this.#handleConnectionClosed);
    if (this.#connection.closed) {
      const error = this.#connection.closeReason ?? new RpcConnectionClosedError();
      this.#handleConnectionClosed(error);
      throw error;
    }
  }

  request<T = unknown>(method: string, params?: unknown, options?: RpcRequestOptions): Promise<T> {
    return this.#connection.request<T>(method, params, options);
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.#connection.notify(method, params);
  }

  onNotification(listener: (notification: RpcNotification) => void): () => void {
    this.#connection.on("notification", listener);
    return () => {
      this.#connection.off("notification", listener);
    };
  }

  onServerRequest(listener: (request: RpcServerRequest) => void): () => void {
    this.#connection.on("serverRequest", listener);
    return () => {
      this.#connection.off("serverRequest", listener);
    };
  }

  onExit(listener: (error?: Error) => void): () => void {
    if (this.#notifyLateExit) {
      let subscribed = true;
      queueMicrotask(() => {
        if (subscribed) {
          listener(this.#exitError);
        }
      });
      return () => {
        subscribed = false;
      };
    }
    this.#exitListeners.add(listener);
    return () => {
      this.#exitListeners.delete(listener);
    };
  }

  stop(): Promise<void> {
    if (this.#exited) {
      return Promise.resolve();
    }
    this.#exited = true;
    this.#connection.off("closed", this.#handleConnectionClosed);
    this.#connection.close();
    this.#exitListeners.clear();
    return Promise.resolve();
  }

  readonly #handleConnectionClosed = (error: Error): void => {
    if (this.#exited) {
      return;
    }
    this.#exited = true;
    this.#notifyLateExit = true;
    this.#exitError = error;
    this.#connection.off("closed", this.#handleConnectionClosed);
    for (const listener of this.#exitListeners) {
      listener(error);
    }
    this.#exitListeners.clear();
  };
}

async function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function terminateOwnedChild(child: ChildProcessWithoutNullStreams): void {
  if (!child.killed && child.exitCode === null && child.signalCode === null) {
    child.kill();
  }
}
