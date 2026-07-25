import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

export type RpcRequestId = string | number;

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface RpcServerRequest {
  id: RpcRequestId;
  method: string;
  params?: unknown;
  respond(result: unknown): Promise<void>;
  reject(error: { code: number; message: string; data?: unknown }): Promise<void>;
}

interface ConnectionEvents {
  closed: [error: Error];
  notification: [notification: RpcNotification];
  protocolError: [error: Error];
  serverRequest: [request: RpcServerRequest];
}

export interface JsonlRpcConnectionOptions {
  readable: Readable;
  writable: Writable;
  defaultTimeoutMs?: number;
  maxBufferBytes?: number;
}

export interface RpcRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  removeAbortListener?: () => void;
}

export class RpcRequestError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly method: string;

  constructor(method: string, code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcRequestError";
    this.code = code;
    this.data = data;
    this.method = method;
  }
}

export class RpcTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`请求 ${method} 在 ${timeoutMs}ms 内未完成`);
    this.name = "RpcTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class RpcConnectionClosedError extends Error {
  constructor(message = "与 Codex 的连接已关闭") {
    super(message);
    this.name = "RpcConnectionClosedError";
  }
}

export class JsonlRpcConnection extends EventEmitter<ConnectionEvents> {
  readonly #defaultTimeoutMs: number;
  readonly #pending = new Map<RpcRequestId, PendingRequest>();
  readonly #readable: Readable;
  readonly #writable: Writable;
  readonly #maxBufferBytes: number;
  #buffer = "";
  #closed = false;
  #closeReason: Error | undefined;
  #nextRequestId = 1;

  constructor(options: JsonlRpcConnectionOptions) {
    super();
    this.#readable = options.readable;
    this.#writable = options.writable;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.#maxBufferBytes = options.maxBufferBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxBufferBytes) || this.#maxBufferBytes < 1) {
      throw new TypeError("maxBufferBytes 必须是正整数");
    }

    this.#readable.on("data", this.#handleData);
    this.#readable.once("end", this.#handleTransportClosed);
    this.#readable.once("close", this.#handleTransportClosed);
    this.#readable.once("error", this.#handleTransportError);
    this.#writable.once("error", this.#handleTransportError);
  }

  get closed(): boolean {
    return this.#closed;
  }

  get closeReason(): Error | undefined {
    return this.#closeReason;
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options: RpcRequestOptions = {},
  ): Promise<T> {
    if (this.#closed) {
      throw new RpcConnectionClosedError();
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
        const onAbort = () => {
          this.#settlePending(id);
          reject(
            options.signal?.reason instanceof Error
              ? options.signal.reason
              : new Error("请求已取消"),
          );
        };
        if (options.signal.aborted) {
          clearTimeout(timer);
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbortListener = () => {
          options.signal?.removeEventListener("abort", onAbort);
        };
      }

      this.#pending.set(id, pending);
      this.#writeEnvelope(envelope).catch((error: unknown) => {
        const current = this.#settlePending(id);
        current?.reject(asError(error));
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const envelope: Record<string, unknown> = { method };
    if (params !== undefined) {
      envelope.params = params;
    }
    await this.#writeEnvelope(envelope);
  }

  close(reason = new RpcConnectionClosedError()): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#closeReason = reason;
    this.#readable.off("data", this.#handleData);
    this.#readable.off("end", this.#handleTransportClosed);
    this.#readable.off("close", this.#handleTransportClosed);
    this.#readable.off("error", this.#handleTransportError);
    this.#writable.off("error", this.#handleTransportError);
    this.#buffer = "";
    for (const [id, pending] of this.#pending) {
      this.#settlePending(id);
      pending.reject(reason);
    }
    this.emit("closed", reason);
  }

  readonly #handleData = (chunk: Buffer | string): void => {
    if (this.#closed) {
      return;
    }
    this.#buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (Buffer.byteLength(this.#buffer, "utf8") > this.#maxBufferBytes) {
      const error = new Error("Codex 协议消息超过安全大小限制");
      this.emit("protocolError", error);
      this.close(new RpcConnectionClosedError(error.message));
      return;
    }

    while (true) {
      const newlineIndex = this.#buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }

      const line = this.#buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (Buffer.byteLength(line, "utf8") > this.#maxBufferBytes) {
        const error = new Error("Codex 协议消息超过安全大小限制");
        this.emit("protocolError", error);
        this.close(new RpcConnectionClosedError(error.message));
        return;
      }
      if (line.length === 0) {
        continue;
      }
      this.#handleLine(line);
    }
  };

  readonly #handleTransportClosed = (): void => {
    this.close();
  };

  readonly #handleTransportError = (error: Error): void => {
    this.close(new RpcConnectionClosedError(error.message));
  };

  #handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("protocolError", new Error("收到无法解析的 Codex 协议消息"));
      return;
    }

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
        respond: async (result) => {
          await this.#writeEnvelope({ id, result });
        },
        reject: async (error) => {
          await this.#writeEnvelope({ error, id });
        },
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

  async #writeEnvelope(envelope: Record<string, unknown>): Promise<void> {
    if (this.#closed) {
      throw new RpcConnectionClosedError();
    }

    const serialized = `${JSON.stringify(envelope)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.#writable.write(serialized, "utf8", (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RpcRequestId {
  return typeof value === "string" || typeof value === "number";
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("写入 Codex 连接失败");
}
