import { open, lstat } from "node:fs/promises";
import path from "node:path";

const STARTUP_RECEIPT_NAME = "startup-last.json";
const MIN_RECEIPT_BYTES = 2;
const MAX_RECEIPT_BYTES = 65_536;
const STARTUP_RECEIPT_KEYS = [
  "Bootstrap",
  "BootstrapInvocationId",
  "Message",
  "RecordedAtUtc",
  "Runtime",
  "RuntimeInvocationId",
  "Signature",
  "Stage",
  "Status",
  "Version",
] as const;
const STARTUP_STAGES = new Set([
  "preflight",
  "runtime-discovered",
  "broker-start",
  "broker-ready",
  "sidecar-start",
  "sidecar-handshake",
  "supervising",
  "application-degraded",
  "update-pending",
  "runtime-check-blocked",
]);
const STARTUP_STATUSES = new Set(["ready", "degraded", "failed", "starting"]);
const INVOCATION_ID = /^[0-9a-f]{32}$/u;

export type DesktopRuntimeHealth =
  | { state: "current" }
  | {
      state: "invalid" | "missing" | "runtime-check-blocked" | "starting" | "update-pending";
      warning: string;
    };

export async function readDesktopRuntimeHealth(dataDir: string): Promise<DesktopRuntimeHealth> {
  const receiptPath = path.join(dataDir, STARTUP_RECEIPT_NAME);
  let before;
  try {
    before = await lstat(receiptPath);
  } catch (error) {
    return isMissingFileError(error)
      ? {
          state: "missing",
          warning: "Codex Desktop 启动健康回执缺失，远程控制已标记为降级。",
        }
      : invalidReceipt();
  }
  if (!isOrdinaryBoundedFile(before)) {
    return invalidReceipt();
  }

  let handle;
  try {
    handle = await open(receiptPath, "r");
    const opened = await handle.stat();
    const afterOpen = await lstat(receiptPath);
    if (
      !isOrdinaryBoundedFile(opened) ||
      !isOrdinaryBoundedFile(afterOpen) ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(opened, afterOpen)
    ) {
      return invalidReceipt();
    }
    const raw = await handle.readFile({ encoding: "utf8" });
    const afterRead = await lstat(receiptPath);
    const openedAfterRead = await handle.stat();
    if (
      Buffer.byteLength(raw, "utf8") !== opened.size ||
      !sameFileIdentity(opened, openedAfterRead) ||
      !sameFileIdentity(opened, afterRead)
    ) {
      return invalidReceipt();
    }
    return projectStartupReceipt(parseStartupReceipt(raw));
  } catch {
    return invalidReceipt();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface StartupReceiptV3 {
  Stage: string;
  Status: string;
}

function parseStartupReceipt(raw: string): StartupReceiptV3 | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== STARTUP_RECEIPT_KEYS.length ||
    !STARTUP_RECEIPT_KEYS.every((key, index) => keys[index] === key) ||
    value.Signature !== "codex-local-remote/startup-status/v3" ||
    value.Version !== 3 ||
    typeof value.Status !== "string" ||
    !STARTUP_STATUSES.has(value.Status) ||
    typeof value.Stage !== "string" ||
    !STARTUP_STAGES.has(value.Stage) ||
    typeof value.Message !== "string" ||
    value.Message.length > 4_096 ||
    typeof value.BootstrapInvocationId !== "string" ||
    !INVOCATION_ID.test(value.BootstrapInvocationId) ||
    !isInvocationIdOrNull(value.RuntimeInvocationId) ||
    !isRecordOrNull(value.Bootstrap) ||
    !isRecordOrNull(value.Runtime) ||
    typeof value.RecordedAtUtc !== "string" ||
    value.RecordedAtUtc.length > 64 ||
    !Number.isFinite(Date.parse(value.RecordedAtUtc))
  ) {
    return undefined;
  }
  return { Stage: value.Stage, Status: value.Status };
}

function projectStartupReceipt(receipt: StartupReceiptV3 | undefined): DesktopRuntimeHealth {
  if (!receipt) {
    return invalidReceipt();
  }
  if (receipt.Stage === "application-degraded" && receipt.Status === "degraded") {
    return { state: "current" };
  }
  if (receipt.Stage === "update-pending") {
    return {
      state: "update-pending",
      warning:
        "Codex Desktop 已更新；当前实时能力探针通过时可继续使用，待当前工作结束后热更新受管连接以采用新运行时。",
    };
  }
  if (receipt.Stage === "runtime-check-blocked") {
    return {
      state: "runtime-check-blocked",
      warning: "无法确认 Codex Desktop 更新兼容性；现有任务未被中断，远程控制已标记为降级。",
    };
  }
  if (receipt.Status === "starting") {
    return {
      state: "starting",
      warning: "Codex Desktop 受管连接正在启动，远程控制暂不可用。",
    };
  }
  if (receipt.Status !== "ready" || receipt.Stage !== "supervising") {
    return {
      state: "runtime-check-blocked",
      warning: "Codex Desktop 启动健康状态已降级；现有任务未被中断，远程控制已标记为降级。",
    };
  }
  return { state: "current" };
}

function invalidReceipt(): DesktopRuntimeHealth {
  return {
    state: "invalid",
    warning: "Codex Desktop 启动健康回执无效，远程控制已标记为降级。",
  };
}

function isOrdinaryBoundedFile(stats: {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  size: number;
}): boolean {
  return (
    stats.isFile() &&
    !stats.isSymbolicLink() &&
    stats.size >= MIN_RECEIPT_BYTES &&
    stats.size <= MAX_RECEIPT_BYTES
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

function isInvocationIdOrNull(value: unknown): boolean {
  return value === null || (typeof value === "string" && INVOCATION_ID.test(value));
}

function isRecordOrNull(value: unknown): boolean {
  return value === null || isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
