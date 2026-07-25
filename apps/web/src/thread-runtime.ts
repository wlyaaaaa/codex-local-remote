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
  if (snapshot && !thread.model && !thread.reasoningEffort) {
    return "模型未知 / 思考等级未知（桌面接口未提供）";
  }
  const model = thread.model ?? (snapshot ? "模型未知（桌面接口未提供）" : "默认模型");
  const effort = thread.reasoningEffort
    ? `${effortLabels[thread.reasoningEffort] ?? thread.reasoningEffort}思考`
    : snapshot
      ? "思考等级未知（桌面接口未提供）"
      : "默认思考";
  return `${model} · ${effort}`;
}
