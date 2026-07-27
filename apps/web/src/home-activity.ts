import type { ThreadSummary } from "@codex-local-remote/contracts";
import type { StatusTone } from "@codex-local-remote/ui";

const inactiveStates = new Set([
  "archived",
  "canceled",
  "cancelled",
  "complete",
  "completed",
  "failed",
  "idle",
  "interrupted",
  "stopped",
  "unknown",
]);

const activityLabels: Readonly<Record<string, string>> = {
  active: "运行中",
  "in-progress": "运行中",
  pending: "等待开始",
  queued: "排队中",
  running: "运行中",
  starting: "正在启动",
  "waiting-for-approval": "等待审批",
  "waiting-for-user": "等待用户输入",
  "waiting-for-user-input": "等待用户输入",
};

export function homeActivityThreads(threads: readonly ThreadSummary[]): ThreadSummary[] {
  return threads.filter(isHomeActivityThread);
}

export function isHomeActivityThread(thread: ThreadSummary): boolean {
  if (thread.archived || thread.parentThreadId) return false;
  return !inactiveStates.has(String(thread.state).toLowerCase());
}

export function homeActivityStateLabel(state: string): string {
  const normalized = state.trim().toLowerCase();
  const fallback = normalized.replace(/[-_]+/gu, " ").replace(/\s+/gu, " ").trim();
  return activityLabels[normalized] ?? (fallback || "状态未知");
}

export function homeActivityStateTone(state: string): StatusTone {
  const normalized = state.toLowerCase();
  if (normalized.includes("waiting")) return "warning";
  if (normalized.includes("fail") || normalized.includes("error")) return "danger";
  if (["active", "in-progress", "running"].includes(normalized)) return "success";
  return "info";
}
