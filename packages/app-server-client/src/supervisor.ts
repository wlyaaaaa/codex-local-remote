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
} from "./jsonl-connection.js";

export type CapabilityState = "available" | "degraded" | "unavailable";

export interface CapabilitySupport {
  state: CapabilityState;
  reason?: "method-not-supported" | "probe-failed";
}

export interface AppServerCapabilities {
  account: CapabilitySupport;
  collaborationModes: CapabilitySupport;
  models: CapabilitySupport;
  permissions: CapabilitySupport;
  rateLimits: CapabilitySupport;
  usage: CapabilitySupport;
}

export interface AppServerSession {
  capabilities: AppServerCapabilities;
  executableSource: CodexExecutableSource;
  initialization: AppServerInitialization;
  notify(method: string, params?: unknown): Promise<void>;
  onExit(listener: (error?: Error) => void): () => void;
  onNotification(listener: (notification: RpcNotification) => void): () => void;
  onServerRequest(listener: (request: RpcServerRequest) => void): () => void;
  request<T = unknown>(method: string, params?: unknown, options?: RpcRequestOptions): Promise<T>;
  stop(): Promise<void>;
}

export interface AppServerSupervisorSnapshot {
  state: "stopped" | "starting" | "running" | "degraded";
  executableSource?: CodexExecutableSource;
  userAgent?: string;
  capabilities?: AppServerCapabilities;
  diagnostics: CodexDiscoveryDiagnostic[];
  restartAttempt: number;
}

interface SupervisorEvents {
  notification: [notification: RpcNotification];
  serverRequest: [request: RpcServerRequest];
  state: [snapshot: AppServerSupervisorSnapshot];
}

export interface AppServerSupervisorOptions {
  candidateProvider?: () => Promise<CodexDiscoveryResult>;
  clientVersion?: string;
  initializationTimeoutMs?: number;
  launchCandidate?: (candidate: CodexExecutable) => Promise<AppServerSession>;
  probeTimeoutMs?: number;
  requestTimeoutMs?: number;
  restartDelaysMs?: number[];
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

export async function probeAppServerCapabilities(
  request: (method: string, params?: unknown, options?: RpcRequestOptions) => Promise<unknown>,
  timeoutMs = 5_000,
): Promise<AppServerCapabilities> {
  const probe = async (method: string, params?: unknown): Promise<CapabilitySupport> => {
    try {
      await request(method, params, { timeoutMs });
      return { state: "available" };
    } catch (error) {
      if (error instanceof RpcRequestError && error.code === -32_601) {
        return { reason: "method-not-supported", state: "unavailable" };
      }
      return { reason: "probe-failed", state: "degraded" };
    }
  };

  const [models, account, rateLimits, usage, permissions, collaborationModes] = await Promise.all([
    probe("model/list", { includeHidden: false, limit: 1 }),
    probe("account/read", { refreshToken: false }),
    probe("account/rateLimits/read"),
    probe("account/usage/read"),
    probe("permissionProfile/list", { limit: 1 }),
    probe("collaborationMode/list", {}),
  ]);

  return { account, collaborationModes, models, permissions, rateLimits, usage };
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

export class AppServerSupervisor extends EventEmitter<SupervisorEvents> {
  readonly #candidateProvider: () => Promise<CodexDiscoveryResult>;
  readonly #launchCandidate: (candidate: CodexExecutable) => Promise<AppServerSession>;
  readonly #restartDelaysMs: number[];
  #diagnostics: CodexDiscoveryDiagnostic[] = [];
  #detachSessionListeners: Array<() => void> = [];
  #intendedRunning = false;
  #restartAttempt = 0;
  #restartTimer: NodeJS.Timeout | undefined;
  #session: AppServerSession | undefined;
  #startPromise: Promise<void> | undefined;
  #state: AppServerSupervisorSnapshot["state"] = "stopped";

  constructor(options: AppServerSupervisorOptions = {}) {
    super();
    const clientVersion = options.clientVersion ?? "0.1.0";
    this.#candidateProvider = options.candidateProvider ?? (() => discoverCodexExecutables());
    this.#restartDelaysMs = options.restartDelaysMs ?? [500, 1_000, 2_500, 5_000, 10_000];
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
  }

  async start(): Promise<void> {
    this.#intendedRunning = true;
    if (this.#session) {
      return;
    }
    if (this.#startPromise) {
      return await this.#startPromise;
    }

    this.#startPromise = this.#startNow();
    try {
      await this.#startPromise;
    } finally {
      this.#startPromise = undefined;
    }
  }

  async stop(): Promise<void> {
    this.#intendedRunning = false;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
    }
    this.#detachActiveSession();
    const session = this.#session;
    this.#session = undefined;
    if (session) {
      await session.stop();
    }
    this.#restartAttempt = 0;
    this.#setState("stopped");
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
    return await session.request<T>(method, params, options);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (!this.#session) {
      await this.start();
    }
    const session = this.#session;
    if (!session) {
      throw new RpcConnectionClosedError("Codex 后台尚未就绪");
    }
    await session.notify(method, params);
  }

  snapshot(): AppServerSupervisorSnapshot {
    const session = this.#session;
    return {
      state: this.#state,
      diagnostics: [...this.#diagnostics],
      restartAttempt: this.#restartAttempt,
      ...(session
        ? {
            capabilities: session.capabilities,
            executableSource: session.executableSource,
            userAgent: session.initialization.userAgent,
          }
        : {}),
    };
  }

  async #startNow(): Promise<void> {
    this.#setState("starting");
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
        this.#setState("degraded");
        if (this.#intendedRunning) {
          this.#scheduleRestart();
        }
      }),
    ];
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
    const delay = this.#restartDelaysMs[index] ?? 5_000;
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
