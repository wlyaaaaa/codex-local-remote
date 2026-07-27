import type { ConversationItem } from "@codex-local-remote/contracts";

export type ConversationSegment =
  | { kind: "content"; item: ConversationItem }
  | { kind: "activity"; items: ConversationItem[] }
  | { kind: "compaction"; item: Extract<ConversationItem, { kind: "tool" }> }
  | { kind: "subagents"; items: ConversationItem[] };

export function groupConversationItems(items: readonly ConversationItem[]): ConversationSegment[] {
  const segments: ConversationSegment[] = [];
  for (const item of items) {
    if (item.kind === "tool" && item.operation === "context-compaction") {
      segments.push({ kind: "compaction", item });
      continue;
    }
    const segmentKind =
      item.kind === "tool" || item.kind === "file-change"
        ? "activity"
        : item.kind === "subagent-activity"
          ? "subagents"
          : "content";
    if (segmentKind === "content") {
      segments.push({ kind: "content", item });
      continue;
    }
    const previous = segments.at(-1);
    if (previous?.kind === segmentKind && sameTurn(previous.items.at(-1), item)) {
      previous.items.push(item);
      continue;
    }
    segments.push({ kind: segmentKind, items: [item] });
  }
  return segments;
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
  _activeTurnId?: string,
): ConversationItem[] {
  return items.filter((item) => item.kind !== "reasoning-summary" && item.kind !== "plan-progress");
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
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "reasoning-summary" && item.turnId === activeTurnId) {
      return { id: item.id, text: item.text };
    }
  }

  let latestUserIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.kind === "user-message") {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0) {
    return undefined;
  }
  for (let index = items.length - 1; index > latestUserIndex; index -= 1) {
    const item = items[index];
    if (item?.kind === "reasoning-summary" && item.turnId === undefined) {
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
  let latestUserIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.kind === "user-message") {
      latestUserIndex = index;
      break;
    }
  }
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
    if (item.kind === "reasoning-summary") {
      return {
        kind: "reasoning",
        text: latestReasoningText(item.text) ?? "正在思考",
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

function sameTurn(left: ConversationItem | undefined, right: ConversationItem): boolean {
  if (!left) return false;
  if (left.turnId === undefined || right.turnId === undefined) return true;
  return left.turnId === right.turnId;
}
