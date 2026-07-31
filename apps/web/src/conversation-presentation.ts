import type { ConversationItem } from "@codex-local-remote/contracts";

export type ConversationSegment =
  | { kind: "content"; item: ConversationItem }
  | { kind: "work"; items: ConversationItem[] }
  | { kind: "compaction"; item: Extract<ConversationItem, { kind: "tool" }> };

export function groupConversationItems(items: readonly ConversationItem[]): ConversationSegment[] {
  const segments: ConversationSegment[] = [];
  for (const item of items) {
    if (item.kind === "tool" && item.operation === "context-compaction") {
      segments.push({ kind: "compaction", item });
      continue;
    }
    if (!isWorkLogItem(item)) {
      segments.push({ kind: "content", item });
      continue;
    }
    const previous = segments.at(-1);
    if (previous?.kind === "work" && workSegmentAcceptsItem(previous.items, item)) {
      previous.items.push(item);
      continue;
    }
    segments.push({ kind: "work", items: [item] });
  }
  return segments;
}

function isWorkLogItem(item: ConversationItem): boolean {
  return (
    item.kind === "reasoning-summary" ||
    (item.kind === "assistant-message" && item.phase === "commentary") ||
    item.kind === "tool" ||
    item.kind === "file-change" ||
    item.kind === "subagent-activity"
  );
}

export function activitySummary(items: readonly ConversationItem[]): string {
  let commands = 0;
  let files = 0;
  let images = 0;
  let other = 0;
  for (const item of items) {
    if (item.kind === "file-change") {
      files += 1;
    } else if (item.kind === "tool" && item.title === "运行命令") {
      commands += item.occurrences ?? 1;
    } else if (item.kind === "tool" && item.title === "查看图片") {
      images += item.occurrences ?? 1;
    } else if (item.kind === "tool") {
      other += item.occurrences ?? 1;
    }
  }
  const parts: string[] = [];
  if (files) parts.push(`编辑了 ${files} 个文件`);
  if (commands) parts.push(`运行了 ${commands} 个命令`);
  if (images) parts.push(`查看了 ${images} 张图像`);
  if (other) parts.push(`完成了 ${other} 项操作`);
  return parts.length ? parts.join(" · ") : "工作记录";
}

export function workLogSummary(items: readonly ConversationItem[]): string {
  let thoughts = 0;
  let operations = 0;
  const agentIds = new Set<string>();
  for (const item of items) {
    if (
      item.kind === "reasoning-summary" ||
      (item.kind === "assistant-message" && item.phase === "commentary")
    ) {
      thoughts += 1;
    } else if (item.kind === "tool") {
      operations += item.occurrences ?? 1;
    } else if (item.kind === "file-change") {
      operations += 1;
    } else if (item.kind === "subagent-activity") {
      for (const agent of item.agents) agentIds.add(agent.threadId);
    }
  }
  const parts: string[] = [];
  if (thoughts) parts.push(`${thoughts} 条思考`);
  if (operations) parts.push(`${operations} 项操作`);
  if (agentIds.size) parts.push(`${agentIds.size} 个子智能体`);
  return parts.length ? parts.join(" · ") : "工作记录";
}

export function workLogHeadline(items: readonly ConversationItem[]): string | undefined {
  const latestThought = items.findLast(
    (item) =>
      item.kind === "reasoning-summary" ||
      (item.kind === "assistant-message" && item.phase === "commentary"),
  );
  if (latestThought?.kind !== "reasoning-summary" && latestThought?.kind !== "assistant-message") {
    return undefined;
  }
  const text = latestReasoningText(latestThought.text);
  if (text === undefined) return undefined;
  return text.length <= 120 ? text : `${text.slice(0, 119).trimEnd()}…`;
}

export function activeWorkLogSegmentIndex(
  segments: readonly ConversationSegment[],
  activeTurnId: string | undefined,
): number {
  if (activeTurnId === undefined) return -1;
  const exactIndex = segments.findLastIndex(
    (segment) =>
      segment.kind === "work" && segment.items.some((item) => item.turnId === activeTurnId),
  );
  if (exactIndex >= 0) return exactIndex;
  const latestUserIndex = segments.findLastIndex(
    (segment) => segment.kind === "content" && segment.item.kind === "user-message",
  );
  if (latestUserIndex < 0) return -1;
  return segments.findLastIndex(
    (segment, index) => index > latestUserIndex && segment.kind === "work",
  );
}

export function workLogSegmentBelongsToActiveTurn(
  segments: readonly ConversationSegment[],
  segmentIndex: number,
  activeTurnId: string | undefined,
): boolean {
  if (activeTurnId === undefined) return false;
  const segment = segments[segmentIndex];
  if (segment?.kind !== "work") return false;
  const explicitTurnIds = segment.items.flatMap((item) =>
    item.turnId === undefined ? [] : [item.turnId],
  );
  if (explicitTurnIds.includes(activeTurnId)) return true;
  if (explicitTurnIds.length > 0) return false;
  const latestUserIndex = segments.findLastIndex(
    (candidate) => candidate.kind === "content" && candidate.item.kind === "user-message",
  );
  return latestUserIndex >= 0 && segmentIndex > latestUserIndex;
}

export function subagentActivityStatusForDisplay(
  status: Extract<ConversationItem, { kind: "subagent-activity" }>["status"],
  active: boolean,
  action?: Extract<ConversationItem, { kind: "subagent-activity" }>["action"],
): Extract<ConversationItem, { kind: "subagent-activity" }>["status"] | "unknown" {
  if (status === "failed") return "failed";
  if (status === "complete" || action === "close") return "complete";
  return active ? "running" : "unknown";
}

export function assistantPhaseForDisplay(
  item: ConversationItem,
  items: readonly ConversationItem[],
): "commentary" | "final_answer" | undefined {
  if (item.kind !== "assistant-message") return undefined;
  if (item.phase) return item.phase;
  const sameTurnAssistantItems = items.filter(
    (candidate) =>
      candidate.kind === "assistant-message" &&
      (item.turnId === undefined || candidate.turnId === item.turnId),
  );
  return sameTurnAssistantItems.at(-1)?.id === item.id ? "final_answer" : "commentary";
}

export function conversationContentItems(
  items: readonly ConversationItem[],
  activeTurnId?: string,
): ConversationItem[] {
  const latestUserIndex = latestUserMessageIndex(items);
  const activeReasoningId = latestActiveReasoning(items, activeTurnId)?.id;
  return items.filter((item, index) => {
    if (item.kind === "plan-progress") {
      return false;
    }
    if (item.kind === "reasoning-summary") {
      return (
        item.id === activeReasoningId &&
        activeTurnId !== undefined &&
        (item.turnId === activeTurnId ||
          (item.turnId === undefined && latestUserIndex >= 0 && index > latestUserIndex))
      );
    }
    if (item.kind !== "assistant-message") {
      return true;
    }
    if (item.phase === "commentary") {
      return false;
    }
    const formalPlan = items.find(
      (candidate): candidate is Extract<ConversationItem, { kind: "formal-plan" }> =>
        candidate.kind === "formal-plan" && candidate.turnId === item.turnId,
    );
    return (
      formalPlan === undefined ||
      normalizePlanText(extractProposedPlan(item.text)) !== normalizePlanText(formalPlan.text)
    );
  });
}

export function latestPlanProgress(
  items: readonly ConversationItem[],
): Extract<ConversationItem, { kind: "plan-progress" }> | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "plan-progress") {
      return item.steps.length > 0 ? item : undefined;
    }
  }
  return undefined;
}

export function latestActiveReasoning(
  items: readonly ConversationItem[],
  activeTurnId: string | undefined,
): { id: string; text: string } | undefined {
  if (activeTurnId === undefined) {
    return undefined;
  }
  const latestUserIndex = latestUserMessageIndex(items);
  const oldestCandidateIndex = latestUserIndex < 0 ? 0 : latestUserIndex + 1;
  for (let index = items.length - 1; index >= oldestCandidateIndex; index -= 1) {
    const item = items[index];
    if (
      item?.kind === "reasoning-summary" &&
      (item.turnId === activeTurnId || (item.turnId === undefined && latestUserIndex >= 0))
    ) {
      return { id: item.id, text: item.text };
    }
  }
  return undefined;
}

export function latestReasoningText(text: string): string | undefined {
  const lines = text
    .replace(/\r\n?/gu, "\n")
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const latest = lines.at(-1);
  if (latest === undefined) return undefined;
  return latest
    .replace(/^(?:\*\*|__)(.+)(?:\*\*|__)$/u, "$1")
    .replace(/^`(.+)`$/u, "$1")
    .trim();
}

export type LiveConversationPhase =
  | { kind: "activity"; text: string }
  | { kind: "reasoning"; text: string };

export function currentLivePhase(
  items: readonly ConversationItem[],
  activeTurnId: string | undefined,
): LiveConversationPhase | undefined {
  if (activeTurnId === undefined) {
    return undefined;
  }
  const latestUserIndex = latestUserMessageIndex(items);
  const belongsToActiveTurn = (item: ConversationItem, index: number) =>
    item.turnId === activeTurnId ||
    (item.turnId === undefined && latestUserIndex >= 0 && index > latestUserIndex);

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined || !belongsToActiveTurn(item, index)) {
      continue;
    }
    if (
      item.kind === "tool" &&
      (item.status === "running" ||
        item.occurrenceDetails?.some((occurrence) => occurrence.status === "running"))
    ) {
      return { kind: "activity", text: runningToolLabel(item.title, item.operation) };
    }
    if (item.kind === "file-change" && item.status === "inProgress") {
      return {
        kind: "activity",
        text:
          item.change === "added"
            ? "正在创建文件"
            : item.change === "deleted"
              ? "正在删除文件"
              : "正在编辑文件",
      };
    }
    if (item.kind === "subagent-activity" && item.status === "running") {
      return { kind: "activity", text: "子智能体正在工作" };
    }
  }

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined || !belongsToActiveTurn(item, index)) {
      continue;
    }
    if (latestUserIndex >= 0 && index <= latestUserIndex) {
      return undefined;
    }
    if (item.kind === "reasoning-summary") {
      return {
        kind: "reasoning",
        text: "正在思考",
      };
    }
    if (item.kind === "assistant-message") {
      return undefined;
    }
    if (
      item.kind === "tool" ||
      item.kind === "file-change" ||
      item.kind === "subagent-activity" ||
      item.kind === "plan-progress"
    ) {
      return undefined;
    }
  }
  return undefined;
}

function latestUserMessageIndex(items: readonly ConversationItem[]): number {
  return items.findLastIndex((item) => item.kind === "user-message");
}

function runningToolLabel(
  title: string,
  operation: Extract<ConversationItem, { kind: "tool" }>["operation"],
): string {
  if (operation === "context-compaction") {
    return "正在压缩上下文";
  }
  const normalized = title.trim();
  if (normalized === "运行命令") {
    return "正在运行命令";
  }
  if (normalized === "使用连接工具") {
    return "正在使用连接工具";
  }
  if (normalized === "使用工具") {
    return "正在使用工具";
  }
  if (normalized.includes("编辑") || normalized.includes("修改")) {
    return "正在编辑文件";
  }
  if (normalized.startsWith("正在")) {
    return normalized;
  }
  return normalized.length > 0 ? `正在${normalized}` : "正在执行操作";
}

function workSegmentAcceptsItem(
  segmentItems: readonly ConversationItem[],
  item: ConversationItem,
): boolean {
  if (segmentItems.length === 0) return false;
  if (item.turnId === undefined) return true;
  const explicitTurnId = segmentItems.find((candidate) => candidate.turnId !== undefined)?.turnId;
  return explicitTurnId === undefined || explicitTurnId === item.turnId;
}

function extractProposedPlan(text: string): string {
  const match = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/iu.exec(text);
  return match?.[1] ?? text;
}

function normalizePlanText(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
}
