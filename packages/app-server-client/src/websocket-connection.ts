import { EventEmitter } from "node:events";
import { isIP } from "node:net";

import type {
  RpcNotification,
  RpcRequestId,
  RpcRequestOptions,
  RpcServerRequest,
} from "./jsonl-connection.js";
import { RpcConnectionClosedError, RpcRequestError, RpcTimeoutError } from "./jsonl-connection.js";

interface ConnectionEvents {
  closed: [error: Error];
  notification: [notification: RpcNotification];
  protocolError: [error: Error];
  serverRequest: [request: RpcServerRequest];
}

export interface WebSocketLike extends EventTarget {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

export type WebSocketFactory = (endpoint: string) => WebSocketLike;

export interface WebSocketRpcConnectionOptions {
  endpoint: string | URL;
  connectionTimeoutMs?: number;
  defaultTimeoutMs?: number;
  maxFrameBytes?: number;
  signal?: AbortSignal;
  webSocketFactory?: WebSocketFactory;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  removeAbortListener?: () => void;
}

const OPEN = 1;
const CLOSING = 2;
// Real Desktop threads can legitimately exceed 50 MiB once tool output,
// images, and compaction history are included. Keep a finite local transport
// bound, but leave enough headroom for those authenticated snapshots.
export const DEFAULT_APP_SERVER_MAX_FRAME_BYTES = 128 * 1024 * 1024;

export class WebSocketRpcConnection extends EventEmitter<ConnectionEvents> {
  readonly #defaultTimeoutMs: number;
  readonly #endpoint: string;
  readonly #maxFrameBytes: number;
  readonly #pending = new Map<RpcRequestId, PendingRequest>();
  readonly #socket: WebSocketLike;
  #closed = false;
  #closeReason: Error | undefined;
  #connectCleanup: (() => void) | undefined;
  #connectSettled = false;
  #messageQueue: Promise<void> = Promise.resolve();
  #nextRequestId = 1;
  readonly #ready: Promise<void>;
  #rejectReady: ((error: Error) => void) | undefined;
  #resolveReady: (() => void) | undefined;

  private constructor(
    endpoint: string,
    socket: WebSocketLike,
    options: Omit<WebSocketRpcConnectionOptions, "endpoint" | "webSocketFactory">,
  ) {
    super();
    this.#endpoint = endpoint;
    this.#socket = socket;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_APP_SERVER_MAX_FRAME_BYTES;
    const connectionTimeoutMs = options.connectionTimeoutMs ?? 10_000;
    assertPositiveInteger(this.#maxFrameBytes, "maxFrameBytes");
    assertPositiveInteger(connectionTimeoutMs, "connectionTimeoutMs");

    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });

    this.#socket.addEventListener("open", this.#handleOpen);
    this.#socket.addEventListener("message", this.#handleMessageEvent);
    this.#socket.addEventListener("close", this.#handleSocketClose);
    this.#socket.addEventListener("error", this.#handleSocketError);

    const timer = setTimeout(() => {
      this.#finishClose(
        new RpcConnectionClosedError(`连接共享 Codex 后台在 ${connectionTimeoutMs}ms 内未完成`),
        true,
      );
    }, connectionTimeoutMs);
    const signal = options.signal;
    const onAbort = () => {
      this.#finishClose(abortReason(signal), true);
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      queueMicrotask(onAbort);
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
    this.#connectCleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    if (this.#socket.readyState === OPEN) {
      queueMicrotask(this.#handleOpen);
    } else if (this.#socket.readyState >= CLOSING) {
      queueMicrotask(() => {
        this.#finishClose(new RpcConnectionClosedError("共享 Codex 后台在连接前已关闭"), false);
      });
    }
  }

  static async connect(options: WebSocketRpcConnectionOptions): Promise<WebSocketRpcConnection> {
    const endpoint = normalizeLoopbackWebSocketEndpoint(options.endpoint);
    assertPositiveInteger(options.connectionTimeoutMs ?? 10_000, "connectionTimeoutMs");
    assertPositiveInteger(
      options.maxFrameBytes ?? DEFAULT_APP_SERVER_MAX_FRAME_BYTES,
      "maxFrameBytes",
    );
    const webSocketFactory =
      options.webSocketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    const socket = webSocketFactory(endpoint);
    const connection = new WebSocketRpcConnection(endpoint, socket, {
      ...(options.connectionTimeoutMs === undefined
        ? {}
        : { connectionTimeoutMs: options.connectionTimeoutMs }),
      ...(options.defaultTimeoutMs === undefined
        ? {}
        : { defaultTimeoutMs: options.defaultTimeoutMs }),
      ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await connection.#ready;
    return connection;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get closeReason(): Error | undefined {
    return this.#closeReason;
  }

  get endpoint(): string {
    return this.#endpoint;
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options: RpcRequestOptions = {},
  ): Promise<T> {
    this.#assertOpen();
    if (options.signal?.aborted) {
      throw abortReason(options.signal);
    }

    const id = this.#nextRequestId++;
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    const envelope: Record<string, unknown> = { id, method };
    if (params !== undefined) {
      envelope.params = params;
    }

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#settlePending(id);
        reject(new RpcTimeoutError(method, timeoutMs));
      }, timeoutMs);
      const pending: PendingRequest = {
        method,
        reject,
        resolve: (value) => {
          resolve(value as T);
        },
        timer,
      };

      if (options.signal) {
        const signal = options.signal;
        const onAbort = () => {
          const current = this.#settlePending(id);
          current?.reject(abortReason(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbortListener = () => {
          signal.removeEventListener("abort", onAbort);
        };
      }

      this.#pending.set(id, pending);
      try {
        this.#writeEnvelope(envelope);
      } catch (error) {
        const current = this.#settlePending(id);
        current?.reject(asError(error));
      }
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    const envelope: Record<string, unknown> = { method };
    if (params !== undefined) {
      envelope.params = params;
    }
    return this.#sendEnvelope(envelope);
  }

  close(reason = new RpcConnectionClosedError()): void {
    this.#finishClose(reason, true);
  }

  readonly #handleOpen = (): void => {
    if (this.#closed || this.#connectSettled) {
      return;
    }
    this.#connectSettled = true;
    this.#connectCleanup?.();
    this.#connectCleanup = undefined;
    this.#resolveReady?.();
    this.#resolveReady = undefined;
    this.#rejectReady = undefined;
  };

  readonly #handleMessageEvent = (event: Event): void => {
    const data = (event as MessageEvent<unknown>).data;
    this.#messageQueue = this.#messageQueue
      .then(async () => {
        if (!this.#closed) {
          await this.#handleFrame(data);
        }
      })
      .catch((error: unknown) => {
        if (!this.#closed) {
          const protocolError = asError(error);
          this.emit("protocolError", protocolError);
          this.#finishClose(new RpcConnectionClosedError(protocolError.message), true);
        }
      });
  };

  readonly #handleSocketClose = (event: Event): void => {
    const close = event as Event & { code?: number };
    const code = typeof close.code === "number" ? close.code : 1006;
    this.#finishClose(new RpcConnectionClosedError(`共享 Codex 后台连接已关闭（${code}）`), false);
  };

  readonly #handleSocketError = (): void => {
    this.#finishClose(new RpcConnectionClosedError("共享 Codex 后台连接错误"), true);
  };

  async #handleFrame(data: unknown): Promise<void> {
    const bytes = frameByteLength(data);
    if (bytes > this.#maxFrameBytes) {
      const error = new Error("Codex WebSocket 协议帧超过安全大小限制");
      this.emit("protocolError", error);
      this.#finishClose(new RpcConnectionClosedError(error.message), true);
      return;
    }
    const text = await decodeFrame(data);
    if (this.#closed) {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.emit("protocolError", new Error("收到无法解析的 Codex 协议消息"));
      return;
    }
    this.#handleEnvelope(message);
  }

  #handleEnvelope(message: unknown): void {
    if (!isRecord(message)) {
      this.emit("protocolError", new Error("收到非对象 Codex 协议消息"));
      return;
    }

    const id = isRequestId(message.id) ? message.id : undefined;
    const method = typeof message.method === "string" ? message.method : undefined;

    if (id !== undefined && method !== undefined) {
      const request: RpcServerRequest = {
        id,
        method,
        respond: (result) => this.#sendEnvelope({ id, result }),
        reject: (error) => this.#sendEnvelope({ error, id }),
      };
      if ("params" in message) {
        request.params = message.params;
      }
      this.emit("serverRequest", request);
      return;
    }

    if (id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.#settlePending(id);
      if (!pending) {
        return;
      }
      if ("error" in message && isRecord(message.error)) {
        const code = typeof message.error.code === "number" ? message.error.code : -32_000;
        const errorMessage =
          typeof message.error.message === "string" ? message.error.message : "Codex 请求失败";
        pending.reject(new RpcRequestError(pending.method, code, errorMessage, message.error.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (method !== undefined) {
      const notification: RpcNotification = { method };
      if ("params" in message) {
        notification.params = message.params;
      }
      this.emit("notification", notification);
      return;
    }

    this.emit("protocolError", new Error("收到无法识别的 Codex 协议消息"));
  }

  #writeEnvelope(envelope: Record<string, unknown>): void {
    this.#assertOpen();
    const serialized = JSON.stringify(envelope);
    if (Buffer.byteLength(serialized, "utf8") > this.#maxFrameBytes) {
      throw new Error("Codex WebSocket 请求超过安全大小限制");
    }
    this.#socket.send(serialized);
  }

  #sendEnvelope(envelope: Record<string, unknown>): Promise<void> {
    try {
      this.#writeEnvelope(envelope);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(asError(error));
    }
  }

  #assertOpen(): void {
    if (this.#closed || this.#socket.readyState !== OPEN) {
      throw this.#closeReason ?? new RpcConnectionClosedError();
    }
  }

  #finishClose(reason: Error, closeSocket: boolean): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#closeReason = reason;
    this.#connectCleanup?.();
    this.#connectCleanup = undefined;
    this.#socket.removeEventListener("open", this.#handleOpen);
    this.#socket.removeEventListener("message", this.#handleMessageEvent);
    this.#socket.removeEventListener("close", this.#handleSocketClose);
    this.#socket.removeEventListener("error", this.#handleSocketError);
    if (!this.#connectSettled) {
      this.#connectSettled = true;
      this.#rejectReady?.(reason);
      this.#resolveReady = undefined;
      this.#rejectReady = undefined;
    }
    for (const [id, pending] of this.#pending) {
      this.#settlePending(id);
      pending.reject(reason);
    }
    if (closeSocket && this.#socket.readyState < CLOSING) {
      try {
        this.#socket.close(1000, "client stop");
      } catch {
        // The connection state and pending requests are already settled.
      }
    }
    this.emit("closed", reason);
  }

  #settlePending(id: RpcRequestId): PendingRequest | undefined {
    const pending = this.#pending.get(id);
    if (!pending) {
      return undefined;
    }
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    return pending;
  }
}

export function normalizeLoopbackWebSocketEndpoint(endpoint: string | URL): string {
  let url: URL;
  try {
    url = endpoint instanceof URL ? new URL(endpoint.href) : new URL(endpoint);
  } catch {
    throw new TypeError("共享 Codex 后台 endpoint 不是有效 URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("共享 Codex 后台 endpoint 必须使用 ws 或 wss");
  }
  if (url.username || url.password) {
    throw new TypeError("共享 Codex 后台 endpoint 不允许 URL 凭据");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  const ipVersion = isIP(hostname);
  const isLoopback =
    hostname === "localhost" ||
    (ipVersion === 4 && hostname.startsWith("127.")) ||
    (ipVersion === 6 && (hostname === "::1" || hostname.startsWith("::ffff:127.")));
  if (!isLoopback) {
    throw new TypeError("共享 Codex 后台 endpoint 必须是 loopback 地址");
  }
  url.hash = "";
  return url.toString();
}

function frameByteLength(data: unknown): number {
  if (typeof data === "string") {
    return Buffer.byteLength(data, "utf8");
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.size;
  }
  throw new Error("收到不受支持的 Codex WebSocket 帧");
}

async function decodeFrame(data: unknown): Promise<string> {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return Buffer.from(await data.arrayBuffer()).toString("utf8");
  }
  throw new Error("收到不受支持的 Codex WebSocket 帧");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RpcRequestId {
  return typeof value === "string" || typeof value === "number";
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("请求已取消");
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("WebSocket 连接失败");
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} 必须是正整数`);
  }
}
