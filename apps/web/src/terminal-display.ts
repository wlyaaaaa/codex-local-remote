import type { ThreadDetail } from "@codex-local-remote/contracts";

type ToolItem = Extract<ThreadDetail["items"][number], { kind: "tool" }>;
type FileChangeItem = Extract<ThreadDetail["items"][number], { kind: "file-change" }>;

const changeLabels: Record<FileChangeItem["change"], string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
};

export function toolFallbackSummary(status: ToolItem["status"]): string {
  if (status === "running") return "正在执行";
  if (status === "failed") return "执行失败";
  return "已完成";
}

export function fileChangeStatusLabel(
  change: FileChangeItem["change"],
  status: NonNullable<FileChangeItem["status"]> = "completed",
): string {
  const action = changeLabels[change];
  if (status === "inProgress") return `正在${action}`;
  if (status === "failed") return `${action}失败`;
  if (status === "declined") return `已拒绝${action}`;
  return action;
}
