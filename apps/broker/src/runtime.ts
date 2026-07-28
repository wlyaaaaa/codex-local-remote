import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { createServer as createTcpServer, isIP } from "node:net";
import type { Server as NetServer } from "node:net";
import { isAbsolute, join, resolve, win32 } from "node:path";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";
import type { RawData } from "ws";

import { BrokerCoordinator } from "./coordinator.js";
import type { BrokerPair, BrokerWire } from "./coordinator.js";

export interface OwnedAppServer {
  endpoint: string;
  onExit(listener: (error?: Error) => void): () => void;
  readonly processId: number;
  stop(): Promise<void>;
}

export interface LaunchOwnedAppServerOptions {
  codexPath: string;
  dataDir: string;
  host: string;
  port: number;
  startupTimeoutMs?: number;
  upstreamCapabilityToken: string;
}

export interface BrokerRuntimeOptions {
  capabilityToken?: string;
  codexPath: string;
  dataDir: string;
  host?: string;
  launchOwnedAppServer?: (options: LaunchOwnedAppServerOptions) => Promise<OwnedAppServer>;
  maxFrameBytes?: number;
  port?: number;
  upstreamHost?: string;
  upstreamPort?: number;
}

export interface RunningBroker {
  closed: Promise<BrokerRuntimeExit>;
  httpEndpoint: string;
  port: number;
  upstreamEndpoint: string;
  webSocketEndpoint: string;
  stop(): Promise<void>;
}

export type BrokerRuntimeExit =
  | { reason: "stopped" }
  | { error: Error; reason: "owned-app-server-exit" };

export interface AppServerDataDirLease {
  release(): Promise<void>;
  releaseSync(): void;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18_791;
const DEFAULT_UPSTREAM_PORT = 18_792;
// Long Codex Desktop conversations can return snapshots well beyond the old
// 16 MiB ceiling. This listener is loopback-only and capability-authenticated,
// so retain a finite bound while allowing real large-thread history.
export const DEFAULT_BROKER_MAX_FRAME_BYTES = 128 * 1024 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const STARTUP_PROBE_TIMEOUT_MS = 500;
const MIN_CAPABILITY_TOKEN_LENGTH = 43;
const MIN_CAPABILITY_TOKEN_UNIQUE_CHARACTERS = 12;
const MAX_CAPABILITY_TOKEN_LENGTH = 256;
const CAPABILITY_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/u;
const APP_SERVER_LEASE_FILENAME = "app-server-upstream.lease";
const UPSTREAM_TOKEN_FILENAME = "app-server-upstream.token";

export async function startBroker(options: BrokerRuntimeOptions): Promise<RunningBroker> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const upstreamHost = options.upstreamHost ?? DEFAULT_HOST;
  const upstreamPort = options.upstreamPort ?? DEFAULT_UPSTREAM_PORT;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_BROKER_MAX_FRAME_BYTES;
  const capabilityToken = assertHighEntropyCapabilityToken(
    options.capabilityToken ?? generateCapabilityToken(),
  );
  const capabilityPath = `/ws/${capabilityToken}`;
  const upstreamCapabilityToken = generateCapabilityToken();
  const runtimeInvocationId = randomUUID().replaceAll("-", "");
  assertLoopbackHost(host, "Broker host");
  assertLoopbackHost(upstreamHost, "upstream host");
  assertPort(port, "port", true);
  assertPort(upstreamPort, "upstreamPort", true);
  assertPositiveInteger(maxFrameBytes, "maxFrameBytes");

  const launchOwnedAppServer = options.launchOwnedAppServer ?? launchCodexAppServer;
  const owned = await launchOwnedAppServer({
    codexPath: options.codexPath,
    dataDir: options.dataDir,
    host: upstreamHost,
    port: upstreamPort,
    upstreamCapabilityToken,
  });
  assertPositiveInteger(owned.processId, "owned app-server processId");
  let upstreamEndpoint: string;
  try {
    upstreamEndpoint = normalizeLoopbackWebSocketUrl(owned.endpoint);
  } catch (error) {
    await owned.stop();
    throw error;
  }
  const coordinator = new BrokerCoordinator({ maxFrameBytes });
  let ready = true;
  let stopped = false;
  const activePairs = new Set<BrokerPair>();
  const server = createHealthServer(() => ({
    appServerReady: ready && !stopped,
    brokerProcessId: process.pid,
    ...coordinator.snapshot(),
    runtimeInvocationId,
    unsafeThreadCount: coordinator.unsafeThreadCount(),
    upstreamProcessId: owned.processId,
  }));
  const webSocketServer = new WebSocketServer({
    maxPayload: maxFrameBytes,
    noServer: true,
  });
  let resolveClosed: (exit: BrokerRuntimeExit) => void = () => undefined;
  const closed = new Promise<BrokerRuntimeExit>((resolveExit) => {
    resolveClosed = resolveExit;
  });

  const closeAllPairs = () => {
    coordinator.stop();
    activePairs.clear();
    for (const client of webSocketServer.clients) {
      client.terminate();
    }
  };
  let detachOwnedExit: () => void = () => undefined;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (reason: BrokerRuntimeExit["reason"], error?: Error): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    stopped = true;
    ready = false;
    detachOwnedExit();
    closeAllPairs();
    const exit: BrokerRuntimeExit =
      reason === "owned-app-server-exit"
        ? {
            error: error ?? new Error("Codex app-server exited unexpectedly"),
            reason,
          }
        : { reason: "stopped" };
    shutdownPromise = (async () => {
      const results = await Promise.allSettled([
        closeWebSocketServer(webSocketServer),
        closeHttpServer(server),
        owned.stop(),
      ]);
      resolveClosed(exit);
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure && reason === "stopped") {
        throw failure.reason;
      }
    })();
    return shutdownPromise;
  };
  detachOwnedExit = owned.onExit((error) => {
    void shutdown(
      "owned-app-server-exit",
      error ?? new Error("Codex app-server exited unexpectedly"),
    );
  });

  server.on("upgrade", (request, socket, head) => {
    if (!ready || stopped) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    if (!isLoopbackAddress(remoteAddress(socket))) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (request.headers.origin !== undefined) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (request.url !== capabilityPath) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (downstream) => {
      webSocketServer.emit("connection", downstream, request);
    });
  });

  webSocketServer.on("connection", (downstream) => {
    connectDownstream(
      coordinator,
      activePairs,
      downstream,
      upstreamEndpoint,
      upstreamCapabilityToken,
      maxFrameBytes,
    );
  });

  try {
    await listen(server, host, port);
  } catch (error) {
    detachOwnedExit();
    ready = false;
    stopped = true;
    closeAllPairs();
    await closeWebSocketServer(webSocketServer);
    await owned.stop();
    throw error;
  }
  if (stopped) {
    await shutdownPromise;
    throw new Error("Codex app-server exited before the Broker became ready");
  }

  const address = server.address();
  if (typeof address === "string" || address === null) {
    detachOwnedExit();
    ready = false;
    stopped = true;
    await closeHttpServer(server);
    await closeWebSocketServer(webSocketServer);
    await owned.stop();
    throw new Error("Broker listener address is unavailable");
  }
  const endpointHost = formatUrlHost(host);
  const httpEndpoint = `http://${endpointHost}:${address.port}/`;
  const webSocketEndpoint = `ws://${endpointHost}:${address.port}${capabilityPath}`;

  return {
    closed,
    httpEndpoint,
    port: address.port,
    upstreamEndpoint,
    webSocketEndpoint,
    stop: async () => await shutdown("stopped"),
  };
}

export async function launchCodexAppServer(
  options: LaunchOwnedAppServerOptions,
): Promise<OwnedAppServer> {
  assertLoopbackHost(options.host, "upstream host");
  assertPort(options.port, "upstreamPort", true);
  const upstreamCapabilityToken = assertHighEntropyCapabilityToken(options.upstreamCapabilityToken);
  const dataDir = resolve(options.dataDir);
  await mkdir(dataDir, { recursive: true });
  const lease = await acquireAppServerDataDirLease(dataDir);
  const tokenFilePath = appServerUpstreamTokenFilePath(dataDir);
  let cleanupPromise: Promise<void> | undefined;
  const cleanupTokenFile = async () => {
    cleanupPromise ??= (async () => {
      try {
        await removeTokenFileIfOwned(tokenFilePath, upstreamCapabilityToken);
      } finally {
        await lease.release();
      }
    })();
    await cleanupPromise;
  };
  const cleanupTokenFileSync = () => {
    try {
      removeTokenFileIfOwnedSync(tokenFilePath, upstreamCapabilityToken);
    } finally {
      lease.releaseSync();
    }
  };

  let child: ChildProcess | undefined;
  try {
    const port = options.port === 0 ? await allocateLoopbackPort(options.host) : options.port;
    await assertPortAvailable(options.host, port);
    const listenEndpoint = formatCodexAppServerListenEndpoint(options.host, port);
    const endpoint = `${listenEndpoint}/`;
    await writeTokenFileAtomically(tokenFilePath, upstreamCapabilityToken);
    child = spawn(options.codexPath, buildCodexAppServerArgs(listenEndpoint, tokenFilePath), {
      cwd: dataDir,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    child.stderr?.resume();
    let startupError: Error | undefined;
    const handleStartupError = (error: Error) => {
      startupError = error;
    };
    child.on("error", handleStartupError);

    try {
      await waitForChildSpawn(child);
      await waitForAuthenticatedWebSocketReady(
        endpoint,
        upstreamCapabilityToken,
        child,
        options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
        () => startupError,
      );
    } finally {
      child.off("error", handleStartupError);
    }
    return new ChildOwnedAppServer(endpoint, child, cleanupTokenFile, cleanupTokenFileSync);
  } catch (error) {
    if (child) {
      terminateChild(child);
    }
    await cleanupTokenFile();
    throw error;
  }
}

export function formatCodexAppServerListenEndpoint(host: string, port: number): string {
  assertLoopbackHost(host, "upstream host");
  assertPort(port, "upstreamPort", false);
  return `ws://${formatUrlHost(host)}:${port}`;
}

export function buildCodexAppServerArgs(listenEndpoint: string, tokenFilePath: string): string[] {
  normalizeLoopbackWebSocketUrl(listenEndpoint);
  if (!isAbsolutePath(tokenFilePath)) {
    throw new TypeError("app-server token file path must be absolute");
  }
  return [
    "-c",
    "features.code_mode_host=true",
    "app-server",
    "--listen",
    listenEndpoint,
    "--ws-auth",
    "capability-token",
    "--ws-token-file",
    tokenFilePath,
  ];
}

export function appServerUpstreamTokenFilePath(dataDir: string): string {
  return join(resolve(dataDir), UPSTREAM_TOKEN_FILENAME);
}

export async function acquireAppServerDataDirLease(
  dataDir: string,
): Promise<AppServerDataDirLease> {
  const absoluteDataDir = await realpath(resolve(dataDir));
  if (process.platform === "win32") {
    return await acquireWindowsPipeLease(absoluteDataDir);
  }
  return await acquireFileLease(absoluteDataDir);
}

class ChildOwnedAppServer implements OwnedAppServer {
  readonly #child: ChildProcess;
  readonly #cleanupTokenFileCallback: () => Promise<void>;
  readonly #cleanupTokenFileSync: () => void;
  readonly #listeners = new Set<(error?: Error) => void>();
  #cleanupPromise: Promise<void> | undefined;
  #exitError: Error | undefined;
  #stopped = false;
  readonly endpoint: string;
  get processId(): number {
    const processId = this.#child.pid;
    if (processId === undefined) {
      throw new Error("Owned app-server process ID is unavailable");
    }
    return processId;
  }

  constructor(
    endpoint: string,
    child: ChildProcess,
    cleanupTokenFile: () => Promise<void>,
    cleanupTokenFileSync: () => void,
  ) {
    this.endpoint = endpoint;
    this.#child = child;
    this.#cleanupTokenFileCallback = cleanupTokenFile;
    this.#cleanupTokenFileSync = cleanupTokenFileSync;
    this.#child.once("exit", this.#handleExit);
    this.#child.once("error", this.#handleError);
    process.once("exit", this.#handleOwnerExit);
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
      queueMicrotask(() => {
        this.#emitExit(new Error("Codex app-server exited unexpectedly"));
      });
    }
  }

  onExit(listener: (error?: Error) => void): () => void {
    if (this.#stopped) {
      queueMicrotask(() => {
        listener(this.#exitError);
      });
      return () => undefined;
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      await this.#cleanupTokenFile();
      return;
    }
    this.#stopped = true;
    this.#child.off("exit", this.#handleExit);
    this.#child.off("error", this.#handleError);
    process.off("exit", this.#handleOwnerExit);
    this.#listeners.clear();
    if (!this.#child.killed && this.#child.exitCode === null && this.#child.signalCode === null) {
      const exited = once(this.#child, "exit").then(() => undefined);
      terminateChild(this.#child);
      await Promise.race([exited, delay(2_000)]);
    }
    await this.#cleanupTokenFile();
  }

  readonly #handleExit = (code: number | null): void => {
    this.#emitExit(code === 0 ? undefined : new Error("Codex app-server exited unexpectedly"));
  };

  readonly #handleError = (): void => {
    this.#emitExit(new Error("Codex app-server process error"));
  };

  readonly #handleOwnerExit = (): void => {
    terminateChild(this.#child);
    this.#cleanupTokenFileSync();
  };

  #emitExit(error?: Error): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#exitError = error;
    this.#child.off("exit", this.#handleExit);
    this.#child.off("error", this.#handleError);
    process.off("exit", this.#handleOwnerExit);
    for (const listener of this.#listeners) {
      listener(error);
    }
    this.#listeners.clear();
    void this.#cleanupTokenFile().catch(() => undefined);
  }

  #cleanupTokenFile(): Promise<void> {
    this.#cleanupPromise ??= this.#cleanupTokenFileCallback();
    return this.#cleanupPromise;
  }
}

function connectDownstream(
  coordinator: BrokerCoordinator,
  activePairs: Set<BrokerPair>,
  downstream: WebSocket,
  upstreamEndpoint: string,
  upstreamCapabilityToken: string,
  maxFrameBytes: number,
): void {
  const upstream = new WebSocket(upstreamEndpoint, {
    headers: {
      Authorization: `Bearer ${upstreamCapabilityToken}`,
    },
    maxPayload: maxFrameBytes,
  });
  let pair: BrokerPair | undefined;
  let closed = false;
  let bufferedBytes = 0;
  const downstreamBuffer: string[] = [];
  const upstreamBuffer: string[] = [];

  const closeBeforeAttach = (code: number, reason: string) => {
    if (closed) {
      return;
    }
    closed = true;
    closeSocket(downstream, code, reason);
    closeSocket(upstream, code, reason);
  };

  downstream.on("message", (data, isBinary) => {
    const frame = decodeTextFrame(data, isBinary, maxFrameBytes);
    if (!frame) {
      (pair ?? { close: () => closeBeforeAttach(1003, "text frames required") }).close();
      return;
    }
    if (pair) {
      void pair.receiveDownstream(frame);
      return;
    }
    bufferedBytes += Buffer.byteLength(frame, "utf8");
    if (bufferedBytes > maxFrameBytes) {
      closeBeforeAttach(1009, "buffered frames too large");
      return;
    }
    downstreamBuffer.push(frame);
  });
  upstream.on("message", (data, isBinary) => {
    const frame = decodeTextFrame(data, isBinary, maxFrameBytes);
    if (!frame) {
      (pair ?? { close: () => closeBeforeAttach(1003, "text frames required") }).close();
      return;
    }
    if (pair) {
      void pair.receiveUpstream(frame);
    } else {
      upstreamBuffer.push(frame);
    }
  });

  upstream.once("open", () => {
    if (closed) {
      return;
    }
    pair = coordinator.attach({
      downstream: webSocketWire(downstream),
      upstream: webSocketWire(upstream),
    });
    activePairs.add(pair);
    for (const frame of downstreamBuffer.splice(0)) {
      void pair.receiveDownstream(frame);
    }
    for (const frame of upstreamBuffer.splice(0)) {
      void pair.receiveUpstream(frame);
    }
  });
  upstream.on("error", () => {
    if (pair) {
      pair.close();
    } else {
      closeBeforeAttach(1011, "upstream connection failed");
    }
  });
  downstream.on("error", () => {
    if (pair) {
      pair.close();
    } else {
      closeBeforeAttach(1011, "downstream connection failed");
    }
  });
  upstream.once("close", () => {
    if (pair) {
      activePairs.delete(pair);
      pair.close();
    } else {
      closeBeforeAttach(1011, "upstream connection closed");
    }
  });
  downstream.once("close", () => {
    if (pair) {
      activePairs.delete(pair);
      pair.close();
    } else {
      closeBeforeAttach(1001, "downstream connection closed");
    }
  });
}

interface BrokerReadiness {
  appServerReady: boolean;
  brokerProcessId: number;
  degraded: boolean;
  desktopConnected: boolean;
  runtimeInvocationId: string;
  sidecarConnected: boolean;
  unknownCount: number;
  unsafeThreadCount: number;
  upstreamProcessId: number;
}

function createHealthServer(readiness: () => BrokerReadiness): HttpServer {
  return createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    if (request.method === "GET" && pathname === "/health") {
      response.statusCode = 200;
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.method === "GET" && pathname === "/ready") {
      const state = readiness();
      const ready = state.appServerReady;
      response.statusCode = ready ? 200 : 503;
      response.end(
        JSON.stringify({
          status: ready ? (state.degraded ? "degraded" : "ready") : "not-ready",
          ...state,
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ status: "not-found" }));
  });
}

function webSocketWire(socket: WebSocket): BrokerWire {
  return {
    close(code, reason) {
      closeSocket(socket, code, reason);
    },
    send(frame) {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket is not open");
      }
      socket.send(frame);
    },
  };
}

function decodeTextFrame(
  data: RawData,
  isBinary: boolean,
  maxFrameBytes: number,
): string | undefined {
  if (isBinary) {
    return undefined;
  }
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buffer.byteLength > maxFrameBytes) {
    return undefined;
  }
  return buffer.toString("utf8");
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
    return;
  }
  try {
    socket.close(code, reason);
  } catch {
    socket.terminate();
  }
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function remoteAddress(socket: Duplex): string | undefined {
  if ("remoteAddress" in socket && typeof socket.remoteAddress === "string") {
    return socket.remoteAddress;
  }
  return undefined;
}

async function listen(server: HttpServer, host: string, port: number): Promise<void> {
  server.listen({ host, port });
  await once(server, "listening");
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function waitForChildSpawn(child: ChildProcess): Promise<void> {
  if (child.pid) {
    return;
  }
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

async function waitForAuthenticatedWebSocketReady(
  endpoint: string,
  capabilityToken: string,
  child: ChildProcess,
  timeoutMs: number,
  startupError: () => Error | undefined,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const error = startupError();
    if (error) {
      throw error;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Codex app-server exited before becoming ready");
    }
    const authenticated = await probeWebSocket(endpoint, capabilityToken);
    if (authenticated.kind === "open") {
      const unauthenticated = await probeWebSocket(endpoint);
      if (
        unauthenticated.kind === "rejected" &&
        (unauthenticated.status === 401 || unauthenticated.status === 403)
      ) {
        if (child.exitCode === null && child.signalCode === null) {
          return;
        }
      } else if (unauthenticated.kind === "open") {
        throw new Error("Codex app-server accepted an unauthenticated WebSocket");
      }
    }
    await delay(50);
  }
  throw new Error("Codex app-server did not become authenticated-ready in time");
}

type WebSocketProbeResult =
  | { kind: "open" }
  | { kind: "rejected"; status: number | undefined }
  | { kind: "unreachable" };

async function probeWebSocket(
  endpoint: string,
  capabilityToken?: string,
): Promise<WebSocketProbeResult> {
  return await new Promise<WebSocketProbeResult>((resolve) => {
    const socket = new WebSocket(endpoint, {
      ...(capabilityToken === undefined
        ? {}
        : { headers: { Authorization: `Bearer ${capabilityToken}` } }),
      handshakeTimeout: STARTUP_PROBE_TIMEOUT_MS,
    });
    let settled = false;
    const finish = (result: WebSocketProbeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    socket.once("open", () => {
      finish({ kind: "open" });
      closeSocket(socket, 1000, "startup probe complete");
    });
    socket.once("unexpected-response", (_request, response) => {
      response.on("error", () => undefined);
      response.socket.on("error", () => undefined);
      const status = response.statusCode;
      response.destroy();
      finish({ kind: "rejected", status });
    });
    socket.once("error", () => {
      finish({ kind: "unreachable" });
    });
  });
}

async function allocateLoopbackPort(host: string): Promise<number> {
  const server = createTcpServer();
  server.listen({ host, port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || address === null) {
    server.close();
    throw new Error("Unable to allocate upstream port");
  }
  const port = address.port;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

async function assertPortAvailable(host: string, port: number): Promise<void> {
  const server = createTcpServer();
  server.listen({ host, port });
  try {
    await once(server, "listening");
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

function terminateChild(child: ChildProcess): void {
  if (!child.killed && child.exitCode === null && child.signalCode === null) {
    child.kill();
  }
}

export function generateCapabilityToken(): string {
  return randomBytes(32).toString("base64url");
}

export function assertHighEntropyCapabilityToken(token: string): string {
  if (
    token.length < MIN_CAPABILITY_TOKEN_LENGTH ||
    token.length > MAX_CAPABILITY_TOKEN_LENGTH ||
    !CAPABILITY_TOKEN_PATTERN.test(token) ||
    new Set(token).size < MIN_CAPABILITY_TOKEN_UNIQUE_CHARACTERS
  ) {
    throw new TypeError(
      "capability token must be a high-entropy URL-safe token (43-256 base64url characters)",
    );
  }
  return token;
}

async function acquireWindowsPipeLease(dataDir: string): Promise<AppServerDataDirLease> {
  const digest = createHash("sha256").update(dataDir.toLocaleLowerCase("en-US")).digest("hex");
  const pipeName = `\\\\.\\pipe\\codex-local-remote-app-server-${digest}`;
  const server = createTcpServer((socket) => {
    socket.destroy();
  });
  try {
    server.listen(pipeName);
    await once(server, "listening");
  } catch (error) {
    throw new Error("An owned app-server lease is already active for this data directory", {
      cause: error,
    });
  }
  server.unref();
  let released = false;
  return {
    async release() {
      if (released) {
        return;
      }
      released = true;
      await closeNetServer(server);
    },
    releaseSync() {
      if (released) {
        return;
      }
      released = true;
      server.close();
    },
  };
}

async function acquireFileLease(dataDir: string): Promise<AppServerDataDirLease> {
  const leasePath = join(dataDir, APP_SERVER_LEASE_FILENAME);
  const owner = JSON.stringify({
    nonce: randomUUID(),
    pid: process.pid,
  });
  try {
    await writeFile(leasePath, owner, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (isFileAlreadyExistsError(error)) {
      throw new Error("An owned app-server lease is already active for this data directory", {
        cause: error,
      });
    }
    throw error;
  }
  let released = false;
  return {
    async release() {
      if (released) {
        return;
      }
      released = true;
      await removeTokenFileIfOwned(leasePath, owner);
    },
    releaseSync() {
      if (released) {
        return;
      }
      released = true;
      removeTokenFileIfOwnedSync(leasePath, owner);
    },
  };
}

async function closeNetServer(server: NetServer): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function writeTokenFileAtomically(tokenFilePath: string, token: string): Promise<void> {
  if (!isAbsolutePath(tokenFilePath)) {
    throw new TypeError("app-server token file path must be absolute");
  }
  const temporaryPath = `${tokenFilePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, token, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    try {
      await rename(temporaryPath, tokenFilePath);
    } catch (error) {
      if (!isFileAlreadyExistsError(error) && !isPermissionError(error)) {
        throw error;
      }
      await unlinkIfPresent(tokenFilePath);
      await rename(temporaryPath, tokenFilePath);
    }
  } finally {
    await unlinkIfPresent(temporaryPath);
  }
}

async function removeTokenFileIfOwned(tokenFilePath: string, token: string): Promise<void> {
  let current: string;
  try {
    current = await readFile(tokenFilePath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return;
    }
    throw error;
  }
  if (current === token) {
    await unlinkIfPresent(tokenFilePath);
  }
}

function removeTokenFileIfOwnedSync(tokenFilePath: string, token: string): void {
  try {
    if (readFileSync(tokenFilePath, "utf8") === token) {
      unlinkSync(tokenFilePath);
    }
  } catch {
    // Process exit cleanup is best effort; normal stop reports cleanup failures.
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return isErrnoException(error) && error.code === "ENOENT";
}

function isFileAlreadyExistsError(error: unknown): boolean {
  return isErrnoException(error) && error.code === "EEXIST";
}

function isPermissionError(error: unknown): boolean {
  return isErrnoException(error) && error.code === "EPERM";
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isAbsolutePath(path: string): boolean {
  return isAbsolute(path) || win32.isAbsolute(path);
}

function normalizeLoopbackWebSocketUrl(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("upstream endpoint must use WebSocket");
  }
  assertLoopbackHost(url.hostname.replace(/^\[(.*)\]$/u, "$1"), "upstream endpoint");
  return url.toString();
}

function assertLoopbackHost(host: string, label: string): void {
  const normalized = host.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  const ipVersion = isIP(normalized);
  if (
    normalized !== "localhost" &&
    !(ipVersion === 4 && normalized.startsWith("127.")) &&
    !(ipVersion === 6 && (normalized === "::1" || normalized.startsWith("::ffff:127.")))
  ) {
    throw new TypeError(`${label} must be loopback`);
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }
  try {
    assertLoopbackHost(address, "remote address");
    return true;
  } catch {
    return false;
  }
}

function formatUrlHost(host: string): string {
  const normalized = host.replace(/^\[(.*)\]$/u, "$1");
  return isIP(normalized) === 6 ? `[${normalized}]` : normalized;
}

function assertPort(value: number, name: string, allowZero: boolean): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > 65_535) {
    throw new TypeError(`${name} is invalid`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

async function delay(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
