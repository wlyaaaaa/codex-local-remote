import path from "node:path";

import type {
  ConversationItem,
  ReasoningEffort,
  RunState,
  ThreadDetail,
  ThreadSummary,
} from "@codex-local-remote/contracts";

export interface ThreadProjectionOptions {
  childCount?: number;
  directInputAvailable?: boolean;
  managed: boolean;
  model?: string | null;
  approvalPolicy?: string | null;
  approvalsReviewer?: string | null;
  collaborationMode?: string | null;
  permissionProfileId?: string | null;
  pinnedRank?: number;
  projectId?: string;
  reasoningEffort?: ReasoningEffort | null;
  serviceTier?: string | null;
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
  const id = requireBoundedIdentifier(thread.id, "对话 id", 512);
  const turns = asRecordArray(thread.turns);
  const activeTurn = turns.findLast((turn) => turn.status === "inProgress");
  const updatedAtSeconds =
    asFiniteNumber(thread.updatedAt) ?? asFiniteNumber(thread.createdAt) ?? 0;
  const parentThreadId = asNonEmptyString(thread.parentThreadId);
  const runtimeSettings = projectRuntimeSettings(thread, options);
  const cwd = boundedProductText(thread.cwd, 4_096);
  const cwdLabel =
    cwd === undefined ? undefined : boundedProductText(path.win32.basename(cwd), 256);

  return {
    id,
    mode: options.managed ? "managed" : "desktop-snapshot",
    state: projectRunState(thread, turns),
    title: chooseThreadTitle(thread),
    updatedAt: new Date(updatedAtSeconds * 1_000).toISOString(),
    ...(options.childCount === undefined ? {} : { childCount: options.childCount }),
    ...(options.pinnedRank === undefined ? {} : { pinnedRank: options.pinnedRank }),
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    ...(runtimeSettings.model === undefined ? {} : { model: runtimeSettings.model }),
    ...(runtimeSettings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: runtimeSettings.reasoningEffort }),
    ...(runtimeSettings.serviceTier === undefined
      ? {}
      : { serviceTier: runtimeSettings.serviceTier }),
    ...(runtimeSettings.permissionProfileId === undefined
      ? {}
      : { permissionProfileId: runtimeSettings.permissionProfileId }),
    ...(runtimeSettings.approvalPolicy === undefined
      ? {}
      : { approvalPolicy: runtimeSettings.approvalPolicy }),
    ...(runtimeSettings.approvalsReviewer === undefined
      ? {}
      : { approvalsReviewer: runtimeSettings.approvalsReviewer }),
    ...(runtimeSettings.collaborationMode === undefined
      ? {}
      : { collaborationMode: runtimeSettings.collaborationMode }),
    ...(cwdLabel === undefined ? {} : { cwdLabel }),
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
  const canControl =
    options.managed && (options.directInputAvailable ?? thread.canAcceptDirectInput === true);
  const items: ConversationItem[] = [];

  for (const turn of turns) {
    const createdAt = secondsToIso(asFiniteNumber(turn.startedAt));
    const completedAt = secondsToIso(asFiniteNumber(turn.completedAt));
    const turnId = asNonEmptyString(turn.id);
    const turnContext = {
      ...(turnId === undefined ? {} : { turnId }),
      ...(createdAt === undefined ? {} : { turnStartedAt: createdAt }),
      ...(completedAt === undefined ? {} : { turnCompletedAt: completedAt }),
    };
    const turnItems: ConversationItem[] = [];
    for (const item of asRecordArray(turn.items)) {
      turnItems.push(
        ...projectThreadItem(item, undefined, turn.status).map((projected) => ({
          ...projected,
          ...turnContext,
        })),
      );
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

export function projectThreadItem(
  rawItem: unknown,
  createdAt?: string,
  parentTurnStatus?: unknown,
): ConversationItem[] {
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
      const phase =
        rawItem.phase === "commentary" || rawItem.phase === "final_answer"
          ? rawItem.phase
          : undefined;
      return text
        ? [
            {
              id,
              kind: "assistant-message",
              text,
              ...(phase === undefined ? {} : { phase }),
              ...timestamp,
            },
          ]
        : [];
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
    case "collabAgentToolCall": {
      const agentsStates = isRecord(rawItem.agentsStates) ? rawItem.agentsStates : {};
      const threadIds = [...asStringArray(rawItem.receiverThreadIds), ...Object.keys(agentsStates)]
        .filter((threadId) => threadId.length > 0 && threadId.length <= 512)
        .filter((threadId, index, all) => all.indexOf(threadId) === index)
        .slice(0, 32);
      if (threadIds.length === 0) {
        return [
          {
            id,
            kind: "tool",
            status: projectToolStatus(rawItem.status),
            title: "协作任务",
            ...timestamp,
          },
        ];
      }
      const action = projectCollabAgentAction(rawItem.tool);
      const summary = boundedProductText(rawItem.prompt, 1_024);
      return [
        {
          id,
          kind: "subagent-activity",
          action,
          agents: threadIds.map((threadId) => ({ threadId })),
          status: projectToolStatus(rawItem.status),
          ...(summary === undefined ? {} : { summary }),
          ...timestamp,
        },
      ];
    }
    case "subAgentActivity": {
      const threadId = boundedProductText(rawItem.agentThreadId, 512);
      if (threadId === undefined) return [];
      const agentPath = boundedProductText(rawItem.agentPath, 1_024);
      const label =
        agentPath === undefined
          ? undefined
          : boundedProductText(path.posix.basename(agentPath.replaceAll("\\", "/")), 256);
      return [
        {
          id,
          kind: "subagent-activity",
          action: "activity",
          agents: [{ threadId, ...(label === undefined ? {} : { label }) }],
          status: projectSubagentActivityStatus(rawItem.kind),
          ...timestamp,
        },
      ];
    }
    case "contextCompaction":
      return [
        {
          id,
          kind: "tool",
          operation: "context-compaction",
          status: projectToolStatus(rawItem.status ?? parentTurnStatus),
          title: "压缩对话上下文",
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
    case "thread/started": {
      const thread = isRecord(params.thread) ? params.thread : {};
      if (!isCompleteThreadSnapshot(thread)) {
        return [];
      }
      try {
        const snapshot = projectThreadSummary(thread, { managed: false });
        return [
          {
            type: "thread.snapshot",
            threadId: snapshot.id,
            payload: snapshot,
          },
        ];
      } catch {
        return [];
      }
    }
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
    case "turn/plan/updated": {
      if (!threadId || !turnId) return [];
      const steps = asRecordArray(params.plan)
        .map((rawStep) => {
          const text = boundedProductText(rawStep.step, 2_048);
          const status =
            rawStep.status === "pending" ||
            rawStep.status === "inProgress" ||
            rawStep.status === "completed"
              ? rawStep.status
              : undefined;
          return text && status ? { text, status } : undefined;
        })
        .filter(
          (
            step,
          ): step is {
            text: string;
            status: "pending" | "inProgress" | "completed";
          } => step !== undefined,
        )
        .slice(0, 64);
      if (steps.length === 0) return [];
      const explanation = boundedProductText(params.explanation, 4_096);
      return [
        {
          type: "thread.item",
          threadId,
          turnId,
          payload: {
            item: [
              {
                id: `plan-progress-${turnId}`,
                kind: "plan-progress",
                steps,
                ...(explanation === undefined ? {} : { explanation }),
              },
            ],
            lifecycle: "updated",
          },
        },
      ];
    }
    case "item/started":
    case "item/completed": {
      const item = projectThreadItem(params.item).map((projected) =>
        notification.method === "item/completed" &&
        projected.kind === "tool" &&
        projected.operation === "context-compaction"
          ? { ...projected, status: "complete" as const }
          : projected,
      );
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
  const maxOccurrenceDetails = 50;
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
      const existingDetails = existing.occurrenceDetails ?? [
        {
          id: existing.id,
          status: existing.status,
          ...(existing.summary === undefined ? {} : { summary: existing.summary }),
          ...(existing.detail === undefined ? {} : { detail: existing.detail }),
          ...(existing.createdAt === undefined ? {} : { createdAt: existing.createdAt }),
        },
      ];
      const nextDetails = item.occurrenceDetails ?? [
        {
          id: item.id,
          status: item.status,
          ...(item.summary === undefined ? {} : { summary: item.summary }),
          ...(item.detail === undefined ? {} : { detail: item.detail }),
          ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
        },
      ];
      result[existingIndex] = {
        ...existing,
        occurrences: (existing.occurrences ?? 1) + (item.occurrences ?? 1),
        occurrenceDetails: [...existingDetails, ...nextDetails].slice(0, maxOccurrenceDetails),
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

function projectCollabAgentAction(
  value: unknown,
): "spawn" | "update" | "resume" | "wait" | "close" | "activity" {
  switch (value) {
    case "spawnAgent":
      return "spawn";
    case "sendInput":
      return "update";
    case "resumeAgent":
      return "resume";
    case "wait":
      return "wait";
    case "closeAgent":
      return "close";
    default:
      return "activity";
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
  const rawTitle =
    boundedProductText(thread.name, 4_096) ??
    boundedProductText(thread.preview, 4_096) ??
    "未命名对话";
  let title = rawTitle;
  if (/%[0-9a-f]{2}/iu.test(rawTitle)) {
    try {
      title = decodeURIComponent(rawTitle);
    } catch {
      // Keep malformed legacy names visible instead of dropping the task.
    }
  }
  title = title
    .replace(/\*\*([^*\r\n]+)\*\*/gu, "$1")
    .replace(/__([^_\r\n]+)__/gu, "$1")
    .replace(/~~([^~\r\n]+)~~/gu, "$1")
    .replace(/`([^`\r\n]+)`/gu, "$1");
  const firstLine = title.split(/\r?\n/u)[0]?.trim() || "未命名对话";
  return firstLine.length <= 100 ? firstLine : `${firstLine.slice(0, 99)}…`;
}

function projectRuntimeSettings(
  thread: Record<string, unknown>,
  options: ThreadProjectionOptions,
): RuntimeSettingsProjection {
  const settings: RuntimeSettingsProjection = {};
  const turn = preferredRuntimeSettingsTurn(asRecordArray(thread.turns));
  if (turn !== undefined) {
    applyRuntimeSettings(settings, turn);
    applyRuntimeSettings(settings, isRecord(turn.settings) ? turn.settings : {});
    applyRuntimeSettings(settings, isRecord(turn.turnSettings) ? turn.turnSettings : {});
  }
  applyRuntimeSettings(settings, thread);
  applyRuntimeSettings(settings, isRecord(thread.settings) ? thread.settings : {});
  applyRuntimeSettings(settings, isRecord(thread.threadSettings) ? thread.threadSettings : {});
  if (Object.hasOwn(options, "model")) {
    const model = boundedProductText(options.model, 256);
    settings.model = model;
  }
  if (Object.hasOwn(options, "reasoningEffort")) {
    const effort = boundedProductText(options.reasoningEffort, 128);
    settings.reasoningEffort = effort;
  }
  for (const field of [
    "serviceTier",
    "permissionProfileId",
    "approvalPolicy",
    "approvalsReviewer",
    "collaborationMode",
  ] as const) {
    if (Object.hasOwn(options, field)) {
      settings[field] = boundedProductText(options[field], 256);
    }
  }
  return {
    ...(settings.model === undefined ? {} : { model: settings.model }),
    ...(settings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: settings.reasoningEffort }),
    ...(settings.serviceTier === undefined ? {} : { serviceTier: settings.serviceTier }),
    ...(settings.permissionProfileId === undefined
      ? {}
      : { permissionProfileId: settings.permissionProfileId }),
    ...(settings.approvalPolicy === undefined ? {} : { approvalPolicy: settings.approvalPolicy }),
    ...(settings.approvalsReviewer === undefined
      ? {}
      : { approvalsReviewer: settings.approvalsReviewer }),
    ...(settings.collaborationMode === undefined
      ? {}
      : { collaborationMode: settings.collaborationMode }),
  };
}

function applyRuntimeSettings(
  target: RuntimeSettingsProjection,
  source: Record<string, unknown>,
): void {
  if (Object.hasOwn(source, "model")) {
    const model = boundedProductText(source.model, 256);
    if (model !== undefined || source.model === null) {
      target.model = model;
    }
  }
  const effortField = Object.hasOwn(source, "reasoningEffort")
    ? "reasoningEffort"
    : Object.hasOwn(source, "effort")
      ? "effort"
      : Object.hasOwn(source, "reasoning_effort")
        ? "reasoning_effort"
        : undefined;
  if (effortField !== undefined) {
    const effort = boundedProductText(source[effortField], 128);
    if (effort !== undefined || source[effortField] === null) {
      target.reasoningEffort = effort;
    }
  }
  applyNullableRuntimeString(target, source, "serviceTier");
  applyNullableRuntimeString(target, source, "approvalPolicy");
  applyNullableRuntimeString(target, source, "approvalsReviewer");
  const permissionProfile =
    asNonEmptyString(source.permissionProfileId) ??
    asNonEmptyString(source.permissions) ??
    asNonEmptyString(
      isRecord(source.activePermissionProfile) ? source.activePermissionProfile.id : undefined,
    );
  if (
    permissionProfile !== undefined ||
    source.permissionProfileId === null ||
    source.permissions === null ||
    source.activePermissionProfile === null
  ) {
    target.permissionProfileId = boundedProductText(permissionProfile, 256);
  }
  if (Object.hasOwn(source, "collaborationMode")) {
    const rawMode = source.collaborationMode;
    const modeRecord = isRecord(rawMode) ? rawMode : {};
    const mode =
      asNonEmptyString(rawMode) ??
      asNonEmptyString(modeRecord.name) ??
      asNonEmptyString(modeRecord.mode);
    if (mode !== undefined || rawMode === null) {
      target.collaborationMode = boundedProductText(mode, 256);
    }
  }
}

interface RuntimeSettingsProjection {
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  serviceTier?: string | undefined;
  permissionProfileId?: string | undefined;
  approvalPolicy?: string | undefined;
  approvalsReviewer?: string | undefined;
  collaborationMode?: string | undefined;
}

function applyNullableRuntimeString(
  target: RuntimeSettingsProjection,
  source: Record<string, unknown>,
  field: "approvalPolicy" | "approvalsReviewer" | "serviceTier",
): void {
  if (!Object.hasOwn(source, field)) {
    return;
  }
  const value = boundedProductText(source[field], 256);
  if (value !== undefined || source[field] === null) {
    target[field] = value;
  }
}

function preferredRuntimeSettingsTurn(
  turns: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  const candidates = turns.filter((turn) => hasRuntimeSettings(turn));
  const active = candidates.filter((turn) => turn.status === "inProgress");
  return (active.length > 0 ? active : candidates).sort(compareRuntimeTurns).at(-1);
}

function hasRuntimeSettings(turn: Record<string, unknown>): boolean {
  return (
    hasDirectRuntimeSetting(turn) ||
    hasDirectRuntimeSetting(isRecord(turn.settings) ? turn.settings : {}) ||
    hasDirectRuntimeSetting(isRecord(turn.turnSettings) ? turn.turnSettings : {})
  );
}

function hasDirectRuntimeSetting(source: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(source, "model") ||
    Object.hasOwn(source, "reasoningEffort") ||
    Object.hasOwn(source, "effort") ||
    Object.hasOwn(source, "reasoning_effort") ||
    Object.hasOwn(source, "serviceTier") ||
    Object.hasOwn(source, "permissionProfileId") ||
    Object.hasOwn(source, "permissions") ||
    Object.hasOwn(source, "activePermissionProfile") ||
    Object.hasOwn(source, "approvalPolicy") ||
    Object.hasOwn(source, "approvalsReviewer") ||
    Object.hasOwn(source, "collaborationMode")
  );
}

function compareRuntimeTurns(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  const leftTimestamp =
    asFiniteNumber(left.startedAt) ??
    asFiniteNumber(left.createdAt) ??
    asFiniteNumber(left.completedAt) ??
    Number.NEGATIVE_INFINITY;
  const rightTimestamp =
    asFiniteNumber(right.startedAt) ??
    asFiniteNumber(right.createdAt) ??
    asFiniteNumber(right.completedAt) ??
    Number.NEGATIVE_INFINITY;
  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }
  return (asNonEmptyString(left.id) ?? "").localeCompare(asNonEmptyString(right.id) ?? "", "en-US");
}

function isCompleteThreadSnapshot(thread: Record<string, unknown>): boolean {
  const status = isRecord(thread.status) ? thread.status.type : thread.status;
  return (
    asBoundedIdentifier(thread.id, 512) !== undefined &&
    boundedProductText(thread.cwd, 4_096) !== undefined &&
    (asFiniteNumber(thread.updatedAt) !== undefined ||
      asFiniteNumber(thread.createdAt) !== undefined) &&
    (status === "notLoaded" ||
      status === "idle" ||
      status === "systemError" ||
      status === "active") &&
    Array.isArray(thread.turns)
  );
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

function requireBoundedIdentifier(value: unknown, label: string, maxLength: number): string {
  const result = asBoundedIdentifier(value, maxLength);
  if (!result) {
    throw new TypeError(`${label}无效`);
  }
  return result;
}

function asBoundedIdentifier(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    return undefined;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) {
      return undefined;
    }
  }
  return value;
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
