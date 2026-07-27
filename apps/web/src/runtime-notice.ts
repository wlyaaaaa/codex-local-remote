import type { RemoteEvent } from "@codex-local-remote/contracts";

export type RuntimeNotice = {
  category: "quota" | "runtime";
  message: string;
  tone: "info" | "warning" | "danger";
  updatedAt: string;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isQuotaMessage(message: string): boolean {
  return /(?:insufficient\s+quota|quota|rate[\s_-]*limit|usage[\s_-]*limit|credits?|limit\s+(?:reached|exceeded)|额度|配额|用量.{0,8}(?:上限|不足|用完|耗尽)|次数.{0,8}(?:上限|用完))/iu.test(
    message,
  );
}

function diagnosticNotice(event: RemoteEvent): RuntimeNotice | undefined {
  if (event.type !== "diagnostic") return undefined;
  const payload = record(event.payload);
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (!message) return undefined;
  const category = typeof payload.category === "string" ? payload.category : "";
  const quota = isQuotaMessage(message);
  const tone =
    quota || category === "error"
      ? "danger"
      : /warning|guardian|deprecation|config/iu.test(category)
        ? "warning"
        : "info";
  return {
    category: quota ? "quota" : "runtime",
    message,
    tone,
    updatedAt: event.emittedAt,
  };
}

export function reduceRuntimeNotice(
  current: RuntimeNotice | undefined,
  events: readonly RemoteEvent[],
): RuntimeNotice | undefined {
  let notice = current;
  for (const event of events) {
    if (event.type === "turn.state" && record(event.payload).state === "running") {
      notice = undefined;
    }
    notice = diagnosticNotice(event) ?? notice;
  }
  return notice;
}
