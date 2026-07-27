import type { ApprovalReviewerOption } from "@codex-local-remote/contracts";

/**
 * Presentation labels do not define availability. The running Codex
 * requirements catalog remains the only source of reviewer ids.
 */
export function approvalReviewerLabel(id: string): string {
  switch (id) {
    case "user":
      return "我来确认";
    case "auto_review":
      return "Codex 自动确认";
    case "guardian_subagent":
      return "安全智能体代我确认";
    default:
      return id;
  }
}

export function approvalReviewerDescription(id: string): string {
  switch (id) {
    case "user":
      return "审批会同步到 Desktop 和手机，由你同意或拒绝。";
    case "auto_review":
      return "由 Codex 按当前安全规则自动决定。";
    case "guardian_subagent":
      return "由独立的安全检查智能体判断是否允许。";
    default:
      return `由当前 Codex 运行时提供：${id}`;
  }
}

export function chooseApprovalReviewer(
  options: readonly ApprovalReviewerOption[],
  preferred?: string | null,
): string {
  if (preferred && options.some((option) => option.id === preferred)) {
    return preferred;
  }
  return options[0]?.id ?? "";
}
