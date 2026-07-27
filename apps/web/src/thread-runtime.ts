import type { ThreadSummary } from "@codex-local-remote/contracts";

const effortLabels: Readonly<Record<string, string>> = {
  none: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  ultra: "Ultra（最高）",
};

export function threadRuntimeSummary(
  thread: Pick<ThreadSummary, "mode" | "model" | "reasoningEffort">,
): string {
  const snapshot = thread.mode === "desktop-snapshot";
  if (!thread.model && !thread.reasoningEffort) {
    return snapshot ? "模型未知 / 思考等级未知（桌面接口未提供）" : "模型未知 / 思考等级未知";
  }
  const model = thread.model ?? (snapshot ? "模型未知（桌面接口未提供）" : "模型未知");
  const effort = thread.reasoningEffort
    ? `${effortLabels[thread.reasoningEffort] ?? thread.reasoningEffort}思考`
    : snapshot
      ? "思考等级未知（桌面接口未提供）"
      : "思考等级未知";
  return `${model} · ${effort}`;
}
