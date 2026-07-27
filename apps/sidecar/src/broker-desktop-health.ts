import { lstat, open } from "node:fs/promises";
import path from "node:path";

const BROKER_RECEIPT_NAME = "app-server-broker.json";
const MAX_DOCUMENT_BYTES = 65_536;
const INVOCATION_ID = /^[0-9a-f]{32}$/u;

export type BrokerDesktopHealth =
  | { state: "current" }
  | { state: "application-degraded" | "degraded"; warning: string };

export async function readBrokerDesktopHealth(
  dataDir: string,
  appServerUrl: string,
): Promise<BrokerDesktopHealth> {
  const receipt = await readBrokerReceipt(path.join(dataDir, BROKER_RECEIPT_NAME));
  if (!receipt) return invalidBrokerHealth();

  let readyUrl: URL;
  try {
    const endpoint = new URL(appServerUrl);
    if (
      endpoint.protocol !== "ws:" ||
      endpoint.hostname !== "127.0.0.1" ||
      endpoint.username ||
      endpoint.password ||
      !endpoint.port
    ) {
      return invalidBrokerHealth();
    }
    readyUrl = new URL(`http://127.0.0.1:${endpoint.port}/ready`);
  } catch {
    return invalidBrokerHealth();
  }

  const readiness = await readBrokerReadiness(readyUrl);
  if (
    !readiness ||
    readiness.runtimeInvocationId !== receipt.runtimeInvocationId ||
    readiness.brokerProcessId !== receipt.brokerProcessId ||
    readiness.upstreamProcessId !== receipt.upstreamProcessId
  ) {
    return invalidBrokerHealth();
  }
  if (
    !readiness.appServerReady ||
    !readiness.desktopConnected ||
    !readiness.sidecarConnected ||
    readiness.unknownCount !== 0
  ) {
    return {
      state: "degraded",
      warning:
        "共享 Broker 尚未确认 Codex Desktop 与远程端处于同一健康连接；现有内容仍可查看，新任务已暂停。",
    };
  }
  if (readiness.degraded) {
    return {
      state: "application-degraded",
      warning: "共享 Broker 正在后台恢复部分历史任务；实时模型与任务探针通过时仍可继续操作。",
    };
  }
  return { state: "current" };
}

type BrokerReceipt = {
  brokerProcessId: number;
  runtimeInvocationId: string;
  upstreamProcessId: number;
};

type BrokerReadiness = BrokerReceipt & {
  appServerReady: boolean;
  degraded: boolean;
  desktopConnected: boolean;
  sidecarConnected: boolean;
  unknownCount: number;
};

async function readBrokerReceipt(receiptPath: string): Promise<BrokerReceipt | undefined> {
  const value = await readBoundedJson(receiptPath);
  if (
    !isRecord(value) ||
    value.Signature !== "codex-local-remote/app-server-broker/v3" ||
    value.Version !== 3 ||
    (value.Status !== "broker-ready" && value.Status !== "ready") ||
    !isInvocationId(value.RuntimeInvocationId) ||
    !isPositiveInteger(value.ProcessId) ||
    !isRecord(value.Upstream) ||
    !isPositiveInteger(value.Upstream.ProcessId) ||
    value.Upstream.RuntimeInvocationId !== value.RuntimeInvocationId
  ) {
    return undefined;
  }
  return {
    brokerProcessId: value.ProcessId,
    runtimeInvocationId: value.RuntimeInvocationId,
    upstreamProcessId: value.Upstream.ProcessId,
  };
}

async function readBrokerReadiness(url: URL): Promise<BrokerReadiness | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  timeout.unref();
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (
      !Number.isFinite(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > MAX_DOCUMENT_BYTES
    ) {
      return undefined;
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_DOCUMENT_BYTES) return undefined;
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      typeof value.appServerReady !== "boolean" ||
      typeof value.degraded !== "boolean" ||
      typeof value.desktopConnected !== "boolean" ||
      typeof value.sidecarConnected !== "boolean" ||
      !isNonNegativeInteger(value.unknownCount) ||
      !isPositiveInteger(value.brokerProcessId) ||
      !isPositiveInteger(value.upstreamProcessId) ||
      !isInvocationId(value.runtimeInvocationId)
    ) {
      return undefined;
    }
    return {
      appServerReady: value.appServerReady,
      brokerProcessId: value.brokerProcessId,
      degraded: value.degraded,
      desktopConnected: value.desktopConnected,
      runtimeInvocationId: value.runtimeInvocationId,
      sidecarConnected: value.sidecarConnected,
      unknownCount: value.unknownCount,
      upstreamProcessId: value.upstreamProcessId,
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedJson(filePath: string): Promise<unknown> {
  let before;
  try {
    before = await lstat(filePath);
  } catch {
    return undefined;
  }
  if (!isOrdinaryBoundedFile(before)) return undefined;

  let handle;
  try {
    handle = await open(filePath, "r");
    const opened = await handle.stat();
    const afterOpen = await lstat(filePath);
    if (
      !isOrdinaryBoundedFile(opened) ||
      !isOrdinaryBoundedFile(afterOpen) ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(opened, afterOpen)
    ) {
      return undefined;
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    const openedAfterRead = await handle.stat();
    const afterRead = await lstat(filePath);
    if (
      Buffer.byteLength(raw, "utf8") !== opened.size ||
      !sameFileIdentity(opened, openedAfterRead) ||
      !sameFileIdentity(opened, afterRead)
    ) {
      return undefined;
    }
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isOrdinaryBoundedFile(stats: {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  size: number;
}): boolean {
  return (
    stats.isFile() && !stats.isSymbolicLink() && stats.size >= 2 && stats.size <= MAX_DOCUMENT_BYTES
  );
}

function sameFileIdentity(
  left: { dev: number; ino: number; size: number; mtimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number },
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInvocationId(value: unknown): value is string {
  return typeof value === "string" && INVOCATION_ID.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function invalidBrokerHealth(): BrokerDesktopHealth {
  return {
    state: "degraded",
    warning: "无法验证共享 Broker 与 Codex Desktop 的实时连接，远程控制已降级，新任务已暂停。",
  };
}
