import type { RunState } from "@codex-local-remote/contracts";

const PRODUCT_TITLE = "Codex Local Remote";
const MAX_THREAD_TITLE_LENGTH = 32;

export interface BrowserAttentionInput {
  approvalCount: number;
  currentState?: RunState;
  currentTitle?: string;
  online: boolean;
  runningCount: number;
}

export function browserAttentionTitle(input: BrowserAttentionInput): string {
  if (!input.online) return `连接中断 · ${PRODUCT_TITLE}`;

  const approvalCount = boundedCount(input.approvalCount);
  if (approvalCount > 0) {
    return `(${approvalCount}) 等待处理 · ${PRODUCT_TITLE}`;
  }

  const currentTitle = compactThreadTitle(input.currentTitle);
  if (input.currentState === "waiting-for-approval") {
    return currentTitle
      ? `等待处理 · ${currentTitle} · Codex Remote`
      : `等待处理 · ${PRODUCT_TITLE}`;
  }
  if (input.currentState === "running") {
    return currentTitle ? `运行中 · ${currentTitle} · Codex Remote` : `运行中 · ${PRODUCT_TITLE}`;
  }
  if (input.currentState === "failed") {
    return currentTitle
      ? `任务失败 · ${currentTitle} · Codex Remote`
      : `任务失败 · ${PRODUCT_TITLE}`;
  }

  const runningCount = boundedCount(input.runningCount);
  if (runningCount > 0) {
    return `(${runningCount}) 运行中 · ${PRODUCT_TITLE}`;
  }
  return currentTitle ? `${currentTitle} · Codex Remote` : PRODUCT_TITLE;
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(99, Math.floor(value));
}

function compactThreadTitle(value: string | undefined): string {
  const normalized = value?.replace(/\s+/gu, " ").trim() ?? "";
  if (normalized.length <= MAX_THREAD_TITLE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_THREAD_TITLE_LENGTH - 1)}…`;
}
