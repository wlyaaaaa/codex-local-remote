import {
  initializeAppServer,
  WebSocketRpcConnection,
  type AppServerRpcConnection,
  type WebSocketLike,
} from "@codex-local-remote/app-server-client";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";

import { assertHighEntropyCapabilityToken } from "./runtime.js";

export interface BrokerLifecycleReconciliationOptions {
  capabilityToken: string;
  port: number;
  timeoutMs?: number;
}

interface ReconciliationConnection extends AppServerRpcConnection {
  close(): void;
}

export interface BrokerLifecycleReconciliationDependencies {
  connect?: (endpoint: string, timeoutMs: number) => Promise<ReconciliationConnection>;
}

export interface BrokerLifecycleReconciliationResult {
  hasMore: boolean;
  observedThreadCount: number;
  resumedThreadCount: number;
  signature: "codex-local-remote/broker-lifecycle-reconciliation/v1";
  status: "reconciled";
  version: 1;
}

export async function reconcileBrokerLifecycle(
  options: BrokerLifecycleReconciliationOptions,
  dependencies: BrokerLifecycleReconciliationDependencies = {},
): Promise<BrokerLifecycleReconciliationResult> {
  const capabilityToken = assertHighEntropyCapabilityToken(options.capabilityToken);
  const port = requirePort(options.port);
  const timeoutMs = requirePositiveInteger(options.timeoutMs ?? 45_000, "timeoutMs");
  const deadlineAtMs = performance.now() + timeoutMs;
  const endpoint = `ws://127.0.0.1:${port}/ws/${capabilityToken}`;
  const connect = dependencies.connect ?? connectLoopbackBroker;
  const connection = await connect(endpoint, timeoutMs);
  try {
    await initializeAppServer(connection, {
      clientVersion: "0.1.3-handoff-reconciler",
      timeoutMs: remainingTimeoutMs(deadlineAtMs),
    });
    const seenCursors = new Set<string>();
    let cursor: null | string = null;
    let observedThreadCount = 0;
    let resumedThreadCount = 0;
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const response = await connection.request<unknown>(
        "thread/loaded/list",
        { limit: 200, ...(cursor === null ? {} : { cursor }) },
        { timeoutMs: remainingTimeoutMs(deadlineAtMs) },
      );
      const page = parseLoadedThreadPage(response);
      observedThreadCount += page.data.length;
      for (const threadId of page.data) {
        await connection.request<unknown>(
          "thread/resume",
          { threadId },
          { timeoutMs: remainingTimeoutMs(deadlineAtMs) },
        );
        resumedThreadCount += 1;
      }
      if (page.nextCursor === null) {
        return {
          hasMore: false,
          observedThreadCount,
          resumedThreadCount,
          signature: "codex-local-remote/broker-lifecycle-reconciliation/v1",
          status: "reconciled",
          version: 1,
        };
      }
      if (seenCursors.has(page.nextCursor)) {
        throw new Error("Broker reconciliation returned a repeated cursor");
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error("Broker reconciliation exceeded the loaded-thread page limit");
  } finally {
    connection.close();
  }
}

async function connectLoopbackBroker(
  endpoint: string,
  timeoutMs: number,
): Promise<ReconciliationConnection> {
  return await WebSocketRpcConnection.connect({
    connectionTimeoutMs: timeoutMs,
    defaultTimeoutMs: timeoutMs,
    endpoint,
    webSocketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
  });
}

function parseLoadedThreadPage(value: unknown): { data: string[]; nextCursor: null | string } {
  if (typeof value !== "object" || value === null) {
    throw new Error("Broker reconciliation returned an invalid loaded-thread page");
  }
  const page = value as Record<string, unknown>;
  if (
    !Array.isArray(page.data) ||
    page.data.length > 200 ||
    !page.data.every(isThreadId) ||
    (page.nextCursor !== null && typeof page.nextCursor !== "string")
  ) {
    throw new Error("Broker reconciliation returned an invalid loaded-thread page");
  }
  return { data: page.data, nextCursor: page.nextCursor };
}

function isThreadId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value
  );
}

function remainingTimeoutMs(deadlineAtMs: number): number {
  const remaining = Math.ceil(deadlineAtMs - performance.now());
  if (remaining < 1) {
    throw new Error("Broker lifecycle reconciliation timed out");
  }
  return remaining;
}

function requirePort(value: number): number {
  const port = requirePositiveInteger(value, "port");
  if (port > 65_535) throw new TypeError("port must be a TCP port");
  return port;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}
