import path from "node:path";

import type {
  ConversationItem,
  ReasoningEffort,
  RunState,
  ThreadDetail,
  ThreadSummary,
} from "@codex-local-remote/contracts";

export interface ThreadProjectionOptions {
  managed: boolean;
  model?: string;
  projectId?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface AppServerNotificationLike {
  method: string;
  params?: unknown;
}

export interface RemoteEventDraft {
  type:
    | "thread.snapshot"
    | "thread.updated"
    | "thread.item"
    | "turn.state"
    | "usage.updated"
    | "approval.resolved"
    | "diagnostic";
  payload: unknown;
  threadId?: string;
  turnId?: string;
}

export function projectThreadSummary(
  rawThread: unknown,
  options: ThreadProjectionOptions,
): ThreadSummary {
  const thread = requireRecord(rawThread, "对话");
  const id = requireString(thread.id, "对话 id");
  const turns = asRecordArray(thread.turns);
  const activeTurn = turns.findLast((turn) => turn.status === "inProgress");
  const updatedAtSeconds =
    asFiniteNumber(thread.updatedAt) ?? asFiniteNumber(thread.createdAt) ?? 0;
  const parentThreadId = asNonEmptyString(thread.parentThreadId);

  return {
    id,
    mode: options.managed ? "managed" : "desktop-snapshot",
    state: projectRunState(thread, turns),
    title: chooseThreadTitle(thread),
    updatedAt: new Date(updatedAtSeconds * 1_000).toISOString(),
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
    ...(asNonEmptyString(thread.cwd) === undefined
      ? {}
      : { cwdLabel: path.win32.basename(asNonEmptyString(thread.cwd) ?? "") }),
    ...(parentThreadId === undefined ? {} : { parentThreadId }),
    ...(activeTurn === undefined ? {} : {}),
  };
}

export function projectThreadDetail(
  rawThread: unknown,
  options: ThreadProjectionOptions,
): ThreadDetail {
  const thread = requireRecord(rawThread, "对话");
  const turns = asRecordArray(thread.turns);
  const activeTurn = turns.findLast((turn) => turn.status === "inProgress");
  const canControl = options.managed && thread.canAcceptDirectInput === true;
  const items: ConversationItem[] = [];

  for (const turn of turns) {
    const createdAt = secondsToIso(asFiniteNumber(turn.startedAt));
    const turnItems: ConversationItem[] = [];
    for (const item of asRecordArray(turn.items)) {
      turnItems.push(...projectThreadItem(item, createdAt));
    }
    items.push(...aggregateToolItems(turnItems));
  }

  return {
    ...projectThreadSummary(thread, options),
    availableActions: {
      changeModelNextTurn: canControl,
      interrupt: canControl && activeTurn !== undefined,
      reply: canControl && activeTurn === undefined,
      steer: canControl && activeTurn !== undefined,
    },
    items,
    ...(activeTurn === undefined
      ? {}
      : { activeTurnId: requireString(activeTurn.id, "进行中的回复 id") }),
  };
}

export function projectThreadItem(rawItem: unknown, createdAt?: string): ConversationItem[] {
  if (!isRecord(rawItem)) {
    return [];
  }
  const id = asNonEmptyString(rawItem.id);
  const type = asNonEmptyString(rawItem.type);
  if (!id || !type) {
    return [];
  }
  const timestamp = createdAt === undefined ? {} : { createdAt };

  switch (type) {
    case "userMessage": {
      const text = asRecordArray(rawItem.content)
        .filter((item) => item.type === "text")
        .map((item) => asNonEmptyString(item.text))
        .filter((item): item is string => item !== undefined)
        .join("\n");
      return text.length === 0 ? [] : [{ id, kind: "user-message", text, ...timestamp }];
    }
    case "agentMessage": {
      const text = asNonEmptyString(rawItem.text);
      return text ? [{ id, kind: "assistant-message", text, ...timestamp }] : [];
    }
    case "reasoning": {
      const summary = asStringArray(rawItem.summary).join("\n");
      return summary.length === 0
        ? []
        : [{ id, kind: "reasoning-summary", text: summary, ...timestamp }];
    }
    case "plan": {
      const text = asNonEmptyString(rawItem.text);
      return text ? [{ id, kind: "reasoning-summary", text, ...timestamp }] : [];
    }
    case "commandExecution": {
      const command = boundedProductText(rawItem.command, 1_024);
      const detail = boundedProductText(
        asNonEmptyString(rawItem.aggregatedOutput) ?? asNonEmptyString(rawItem.error),
        16_384,
      );
      return [
        {
          id,
          kind: "tool",
          status: projectToolStatus(rawItem.status),
          title: "运行命令",
          ...(command === undefined ? {} : { summary: command }),
          ...(detail === undefined ? {} : { detail }),
          ...timestamp,
        },
      ];
    }
    case "fileChange":
      return projectFileChanges(id, rawItem, createdAt);
    case "mcpToolCall": {
      const tool = boundedProductText(rawItem.tool, 1_024);
      const error = isRecord(rawItem.error) ? rawItem.error : {};
      const detail =
        boundedProductText(error.message, 16_384) ?? projectMcpToolResult(rawItem.result);
      return [
        {
          id,
          kind: "tool",
          status: projectToolStatus(rawItem.status),
          title: "使用连接工具",
          ...(tool === undefined ? {} : { summary: tool }),
          ...(detail === undefined ? {} : { detail }),
          ...timestamp,
        },
      ];
    }
    case "dynamicToolCall": {
      const tool = boundedProductText(rawItem.tool, 1_024);
      const detail = projectDynamicToolContent(rawItem.contentItems);
      return [
        {
          id,
          kind: "tool",
          status: rawItem.success === false ? "failed" : projectToolStatus(rawItem.status),
          title: "使用工具",
          ...(tool === undefined ? {} : { summary: tool }),
          ...(detail === undefined ? {} : { detail }),
          ...timestamp,
        },
      ];
    }
    case "collabAgentToolCall":
      return [
        {
          id,
          kind: "tool",
          status: projectToolStatus(rawItem.status),
          title: "协作任务",
          ...timestamp,
        },
      ];
    case "subAgentActivity":
      return [
        {
          id,
          kind: "tool",
          status: projectSubagentActivityStatus(rawItem.kind),
          title: "协作任务",
          ...timestamp,
        },
      ];
    case "webSearch":
      return [{ id, kind: "tool", status: "complete", title: "查询网页", ...timestamp }];
    case "imageView":
      return [{ id, kind: "tool", status: "complete", title: "查看图片", ...timestamp }];
    case "sleep": {
      const durationMs = asFiniteNumber(rawItem.durationMs);
      return [
        {
          id,
          kind: "tool",
          status: "complete",
          title: "等待",
          ...(durationMs === undefined ? {} : { summary: `${durationMs} 毫秒` }),
          ...timestamp,
        },
      ];
    }
    case "imageGeneration": {
      const summary = boundedProductText(rawItem.revisedPrompt, 1_024);
      return [
        {
          id,
          kind: "tool",
          status: projectToolStatus(rawItem.status),
          title: "生成图片",
          ...(summary === undefined ? {} : { summary }),
          ...timestamp,
        },
      ];
    }
    default:
      return [];
  }
}

export function projectAppServerNotification(
  notification: AppServerNotificationLike,
): RemoteEventDraft[] {
  const params = isRecord(notification.params) ? notification.params : {};
  const threadId = asNonEmptyString(params.threadId);
  const turnId = asNonEmptyString(params.turnId);
  const context = {
    ...(threadId === undefined ? {} : { threadId }),
    ...(turnId === undefined ? {} : { turnId }),
  };

  switch (notification.method) {
    case "item/reasoning/textDelta":
      return [];
    case "item/reasoning/summaryTextDelta":
      return threadId && turnId
        ? [
            {
              type: "thread.item",
              threadId,
              turnId,
              payload: {
                kind: "reasoning-summary-delta",
                itemId: asNonEmptyString(params.itemId) ?? "",
                delta: boundedProductText(params.delta, 8_192) ?? "",
                summaryIndex: asFiniteNumber(params.summaryIndex) ?? 0,
              },
            },
          ]
        : [];
    case "item/agentMessage/delta":
      return [
        {
          type: "thread.item",
          payload: {
            kind: "assistant-message-delta",
            itemId: asNonEmptyString(params.itemId) ?? "",
            delta: boundedProductText(params.delta, 32_768) ?? "",
          },
          ...context,
        },
      ];
    case "item/started":
    case "item/completed": {
      const item = projectThreadItem(params.item);
      return item.length === 0
        ? []
        : [
            {
              type: "thread.item",
              payload: {
                item,
                lifecycle: notification.method === "item/started" ? "started" : "completed",
              },
              ...context,
            },
          ];
    }
    case "turn/started": {
      const startedTurnId = isRecord(params.turn) ? asNonEmptyString(params.turn.id) : undefined;
      return [
        {
          type: "turn.state",
          payload: { state: "running", turn: params.turn },
          ...context,
          ...(turnId === undefined && startedTurnId !== undefined ? { turnId: startedTurnId } : {}),
        },
      ];
    }
    case "turn/completed": {
      const turn = isRecord(params.turn) ? params.turn : {};
      const completedTurnId = asNonEmptyString(turn.id);
      return [
        {
          type: "turn.state",
          payload: { state: projectTurnState(turn.status), turn },
          ...context,
          ...(turnId === undefined && completedTurnId !== undefined
            ? { turnId: completedTurnId }
            : {}),
        },
      ];
    }
    case "thread/status/changed":
    case "thread/name/updated":
    case "thread/settings/updated":
      return [{ type: "thread.updated", payload: params, ...context }];
    case "model/rerouted": {
      const fromModel = boundedProductText(params.fromModel, 256);
      const toModel = boundedProductText(params.toModel, 256);
      const reason = boundedProductText(params.reason, 2_048);
      if (!toModel) {
        return [];
      }
      const transition =
        fromModel && fromModel !== toModel
          ? `Codex 已将模型从 ${fromModel} 切换为 ${toModel}`
          : `Codex 已切换为 ${toModel}`;
      return [
        {
          type: "thread.updated",
          payload: { model: toModel, reason: "model-rerouted" },
          ...context,
        },
        {
          type: "diagnostic",
          payload: {
            category: "model/rerouted",
            message: reason ? `${transition}：${reason}` : transition,
          },
          ...context,
        },
      ];
    }
    case "thread/tokenUsage/updated":
    case "account/rateLimits/updated":
      return [{ type: "usage.updated", payload: params, ...context }];
    case "serverRequest/resolved":
      return [{ type: "approval.resolved", payload: params, ...context }];
    case "error":
    case "warning":
    case "guardianWarning":
    case "deprecationNotice":
    case "configWarning":
      return [
        {
          type: "diagnostic",
          payload: {
            category: notification.method,
            message: projectDiagnosticMessage(notification.method, params),
          },
          ...context,
        },
      ];
    default:
      return [];
  }
}

function aggregateToolItems(items: ConversationItem[]): ConversationItem[] {
  const result: ConversationItem[] = [];
  const toolIndexes = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "tool") {
      result.push(item);
      continue;
    }
    const key = JSON.stringify([item.title, item.summary ?? "", item.status]);
    const existingIndex = toolIndexes.get(key);
    if (existingIndex === undefined) {
      toolIndexes.set(key, result.length);
      result.push(item);
      continue;
    }
    const existing = result[existingIndex];
    if (existing?.kind === "tool") {
      result[existingIndex] = {
        ...item,
        occurrences: (existing.occurrences ?? 1) + (item.occurrences ?? 1),
      };
    }
  }
  return result;
}

function boundedProductText(value: unknown, maxLength: number): string | undefined {
  const text =
    typeof value === "string"
      ? Array.from(value)
          .filter((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            return (
              codePoint === 9 ||
              codePoint === 10 ||
              codePoint === 13 ||
              (codePoint >= 32 && codePoint !== 127)
            );
          })
          .join("")
      : undefined;
  if (!text) {
    return undefined;
  }
  if (text.length <= maxLength) {
    return text;
  }
  const suffix = "\n…（内容已截断）";
  return `${text.slice(0, Math.max(0, maxLength - suffix.length))}${suffix}`;
}

function projectRunState(
  thread: Record<string, unknown>,
  turns: Record<string, unknown>[],
): RunState {
  const statusRecord = isRecord(thread.status) ? thread.status : {};
  const status = isRecord(thread.status) ? statusRecord.type : thread.status;
  if (status === "systemError") {
    return "failed";
  }
  if (status === "active") {
    const activeFlags = asStringArray(statusRecord.activeFlags);
    if (activeFlags.includes("waitingOnApproval") || activeFlags.includes("waitingOnUserInput")) {
      return "waiting-for-approval";
    }
    return "running";
  }
  const lastTurn = turns.at(-1);
  return lastTurn ? projectTurnState(lastTurn.status) : "idle";
}

function projectTurnState(value: unknown): RunState {
  switch (value) {
    case "inProgress":
      return "running";
    case "failed":
      return "failed";
    case "completed":
      return "complete";
    default:
      return "idle";
  }
}

function projectToolStatus(value: unknown): "running" | "complete" | "failed" {
  switch (value) {
    case "completed":
    case "complete":
    case "succeeded":
      return "complete";
    case "failed":
    case "declined":
    case "error":
      return "failed";
    default:
      return "running";
  }
}

function projectSubagentActivityStatus(value: unknown): "running" | "complete" | "failed" {
  switch (value) {
    case "started":
      return "running";
    case "interacted":
      return "complete";
    case "interrupted":
      return "failed";
    default:
      return "failed";
  }
}

function projectMcpToolResult(value: unknown): string | undefined {
  const result = isRecord(value) ? value : {};
  const textContent = Array.isArray(result.content)
    ? result.content
        .map((item) => {
          if (typeof item === "string") {
            return item;
          }
          return isRecord(item) && item.type === "text" ? asNonEmptyString(item.text) : undefined;
        })
        .filter((item): item is string => item !== undefined)
        .join("\n")
    : "";
  if (textContent) {
    return boundedProductText(textContent, 16_384);
  }
  return boundedJsonText(result.structuredContent, 16_384);
}

function projectDynamicToolContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const text = value
    .filter(isRecord)
    .filter((item) => item.type === "inputText")
    .map((item) => asNonEmptyString(item.text))
    .filter((item): item is string => item !== undefined)
    .join("\n");
  return boundedProductText(text, 16_384);
}

function boundedJsonText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    return boundedProductText(JSON.stringify(value), maxLength);
  } catch {
    return undefined;
  }
}

function projectDiagnosticMessage(method: string, params: Record<string, unknown>): string {
  if (method === "error") {
    const error = isRecord(params.error) ? params.error : {};
    return joinDiagnosticText(error.message, error.additionalDetails);
  }
  if (method === "deprecationNotice" || method === "configWarning") {
    return joinDiagnosticText(params.summary, params.details);
  }
  return boundedProductText(params.message, 16_384) ?? "Codex 返回了一条运行提示";
}

function joinDiagnosticText(summary: unknown, details: unknown): string {
  const safeSummary = boundedProductText(summary, 8_192);
  const safeDetails = boundedProductText(details, 8_192);
  if (safeSummary && safeDetails) {
    return `${safeSummary}\n\n${safeDetails}`.slice(0, 16_384);
  }
  return safeSummary ?? safeDetails ?? "Codex 返回了一条运行提示";
}

function projectFileChanges(
  itemId: string,
  item: Record<string, unknown>,
  createdAt?: string,
): ConversationItem[] {
  const changes = asRecordArray(item.changes);
  const status = projectFileChangeStatus(item.status);
  return changes.flatMap((change, index) => {
    const filePath = boundedProductText(change.path, 4_096);
    if (!filePath) {
      return [];
    }
    const kindRecord = isRecord(change.kind) ? change.kind : {};
    const kind =
      asNonEmptyString(kindRecord.type) ??
      asNonEmptyString(change.kind) ??
      asNonEmptyString(change.change);
    const projectedChange =
      kind === "add" || kind === "added"
        ? "added"
        : kind === "delete" || kind === "deleted"
          ? "deleted"
          : "modified";
    const counts = countUnifiedDiff(change.diff);
    const targetPath = boundedProductText(kindRecord.move_path ?? kindRecord.movePath, 4_096);
    const diff = boundedProductText(change.diff, 65_536);
    return [
      {
        id: changes.length === 1 ? itemId : `${itemId}:${index}`,
        kind: "file-change",
        path: filePath,
        change: projectedChange,
        ...(status === undefined ? {} : { status }),
        ...(targetPath === undefined ? {} : { targetPath }),
        ...(diff === undefined ? {} : { diff }),
        ...(counts.additions === 0 ? {} : { additions: counts.additions }),
        ...(counts.deletions === 0 ? {} : { deletions: counts.deletions }),
        ...(createdAt === undefined ? {} : { createdAt }),
      } satisfies ConversationItem,
    ];
  });
}

function projectFileChangeStatus(
  value: unknown,
): "inProgress" | "completed" | "failed" | "declined" | undefined {
  switch (value) {
    case "inProgress":
    case "completed":
    case "failed":
    case "declined":
      return value;
    default:
      return undefined;
  }
}

function countUnifiedDiff(value: unknown): { additions: number; deletions: number } {
  if (typeof value !== "string") {
    return { additions: 0, deletions: 0 };
  }
  let additions = 0;
  let deletions = 0;
  const bounded = value.slice(0, 1024 * 1024);
  for (const line of bounded.split(/\r?\n/u).slice(0, 100_000)) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function chooseThreadTitle(thread: Record<string, unknown>): string {
  const title = asNonEmptyString(thread.name) ?? asNonEmptyString(thread.preview) ?? "未命名对话";
  const firstLine = title.split(/\r?\n/u)[0]?.trim() || "未命名对话";
  return firstLine.length <= 100 ? firstLine : `${firstLine.slice(0, 99)}…`;
}

function secondsToIso(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value * 1_000).toISOString();
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label}数据格式无效`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  const result = asNonEmptyString(value);
  if (!result) {
    throw new TypeError(`${label}无效`);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
