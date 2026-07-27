import type { ThreadSummary } from "@codex-local-remote/contracts";

export function threadTitleForDisplay(value: string): string {
  let decoded = value;
  if (/%[0-9a-f]{2}/iu.test(value)) {
    try {
      decoded = decodeURIComponent(value);
    } catch {
      // Keep malformed legacy titles visible instead of dropping the task.
    }
  }
  return decoded
    .replace(/\*\*([^*\r\n]+)\*\*/gu, "$1")
    .replace(/__([^_\r\n]+)__/gu, "$1")
    .replace(/~~([^~\r\n]+)~~/gu, "$1")
    .replace(/`([^`\r\n]+)`/gu, "$1")
    .trim();
}

export function threadLocationLabelForDisplay(
  thread: Pick<ThreadSummary, "cwdLabel" | "mode" | "projectId">,
): string {
  if (thread.mode === "desktop-snapshot") {
    return thread.cwdLabel ?? "桌面任务";
  }
  return thread.projectId === undefined ? "无项目" : (thread.cwdLabel ?? "已关联项目");
}
