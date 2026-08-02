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

const CODEX_INTERNAL_CONTEXT_ENVELOPE =
  /^<codex_internal_context(?:\s+[^<>]*?)?>[\s\S]*<\/codex_internal_context>$/u;
const CODEX_UI_DIRECTIVE_LINE =
  /^[\t ]*::(?:code-comment|created-thread|git-(?:commit|create-branch|create-pr|push|stage))\{[^\r\n]*\}[\t ]*$/u;

export function isCodexInternalContextEnvelope(text: string): boolean {
  const candidate = text.trim();
  return candidate.length > 0 && CODEX_INTERNAL_CONTEXT_ENVELOPE.test(candidate);
}

export function stripCodexUiDirectives(text: string): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  let fence: "`" | "~" | undefined;
  const visibleLines: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const fenceMatch = /^[\t ]*(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0];
      if (marker === "`" || marker === "~") {
        fence = fence === undefined ? marker : fence === marker ? undefined : fence;
      }
      visibleLines.push(line);
      continue;
    }
    if (fence === undefined && CODEX_UI_DIRECTIVE_LINE.test(line)) continue;
    visibleLines.push(line);
  }
  return visibleLines.join(newline).trim();
}

export function projectThreadSummary(
  rawThread: unknown,
  options: ThreadProjectionOptions,
): ThreadSummary {
  const thread = requireRecord(rawThread, "对话");
  const id = requireBoundedIdentifier(thread.id, "对话 id", 512);
  const turns = asRecordArray(thread.turns);
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
  };
}

export function projectThreadDetail(
  rawThread: unknown,
  options: ThreadProjectionOptions,
): ThreadDetail {
  const thread = requireRecord(rawThread, "对话");
  const turns = asRecordArray(thread.turns);
  const activeTurn = projectActiveTurn(thread, turns);
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
    const rawTurnItems = asRecordArray(turn.items);
    for (let index = 0; index < rawTurnItems.length; index += 1) {
      const item = rawTurnItems[index];
      const itemParentStatus =
        item?.type === "contextCompaction" && index < rawTurnItems.length - 1
          ? "completed"
          : turn.status;
      turnItems.push(
        ...projectThreadItem(item, undefined, itemParentStatus).map((projected) => ({
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
      const content = asRecordArray(rawItem.content);
      const text = content
        .filter((item) => item.type === "text")
        .map((item) => asNonEmptyString(item.text))
        .filter((item): item is string => item !== undefined)
        .join("\n");
      const visibleText = isCodexInternalContextEnvelope(text) ? "" : text;
      const attachments = content.flatMap((item) => {
        if (item.type !== "localImage" && item.type !== "mention") {
          return [];
        }
        const sourcePath = boundedProductText(item.path, 32_768);
        if (!sourcePath) {
          return [];
        }
        const providedName = boundedProductText(item.name, 255);
        return [
          {
            kind: item.type === "localImage" ? ("image" as const) : ("file" as const),
            name: providedName ?? (path.win32.basename(sourcePath) || "附件"),
            path: sourcePath,
          },
        ];
      });
      return visibleText.length === 0 && attachments.length === 0
        ? []
        : [
            {
              id,
              kind: "user-message",
              text: visibleText,
              ...(attachments.length === 0 ? {} : { attachments }),
              ...timestamp,
            },
          ];
    }
    case "agentMessage": {
      const rawText = asNonEmptyString(rawItem.text);
      const text =
        rawText === undefined ? undefined : asNonEmptyString(stripCodexUiDirectives(rawText));
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
      return text ? [{ id, kind: "formal-plan", text, ...timestamp }] : [];
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
      const toolSummary = projectedToolSummary(tool);
      const error = isRecord(rawItem.error) ? rawItem.error : {};
      const detail =
        boundedProductText(error.message, 16_384) ?? projectMcpToolResult(rawItem.result);
      return [
        {
          id,
          kind: "tool",
          status: projectToolStatus(rawItem.status),
          title: projectedToolTitle(tool, "使用连接工具"),
          ...(toolSummary === undefined ? {} : { summary: toolSummary }),
          ...(detail === undefined ? {} : { detail }),
          ...timestamp,
        },
      ];
    }
    case "dynamicToolCall": {
      const tool = boundedProductText(rawItem.tool, 1_024);
      const toolSummary = projectedToolSummary(tool);
      const detail = projectDynamicToolContent(rawItem.contentItems);
      return [
        {
          id,
          kind: "tool",
          status: rawItem.success === false ? "failed" : projectToolStatus(rawItem.status),
          title: projectedToolTitle(tool, "使用工具"),
          ...(toolSummary === undefined ? {} : { summary: toolSummary }),
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
          status: projectCollabAgentStatus(agentsStates, rawItem.status),
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
    case "imageView": {
      const viewedPaths = imagePathsFromItem(rawItem);
      if (viewedPaths.length > 0) {
        return [
          {
            id,
            kind: "image-activity",
            action: "viewed",
            attachments: viewedPaths.map((imagePath) => ({
              kind: "image",
              name:
                boundedProductText(path.win32.basename(imagePath.replaceAll("/", "\\")), 512) ??
                "已查看的图片",
              path: imagePath,
            })),
            status: "complete",
            summary: `已查看 ${viewedPaths.length} 张图像`,
            ...timestamp,
          },
        ];
      }
      return [{ id, kind: "tool", status: "complete", title: "查看图片", ...timestamp }];
    }
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
      const summary = boundedProductText(rawItem.revisedPrompt ?? rawItem.revised_prompt, 1_024);
      const savedPath = boundedProductText(rawItem.savedPath ?? rawItem.saved_path, 32_768);
      if (savedPath !== undefined) {
        return [
          {
            id,
            kind: "image-activity",
            action: "generated",
            attachments: [
              {
                kind: "image",
                name: boundedProductText(path.win32.basename(savedPath), 512) ?? "生成的图片",
                path: savedPath,
              },
            ],
            status: projectToolStatus(rawItem.status),
            ...(summary === undefined ? {} : { summary }),
            ...timestamp,
          },
        ];
      }
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
      const lifecycle = notification.method === "item/started" ? "started" : "completed";
      const item = projectThreadItem(params.item).map((projected) =>
        normalizeProjectedItemLifecycle(projected, lifecycle),
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
    case "thread/settings/updated":
      return [{ type: "thread.updated", payload: params, ...context }];
    case "thread/name/updated":
      return [
        {
          type: "thread.updated",
          payload: {
            ...params,
            ...(typeof params.threadName === "string" ? { name: params.threadName } : {}),
          },
          ...context,
        },
      ];
    case "thread/archived":
      return [
        {
          type: "thread.updated",
          payload: { ...params, archived: true },
          ...context,
        },
      ];
    case "thread/unarchived":
      return [
        {
          type: "thread.updated",
          payload: { ...params, archived: false },
          ...context,
        },
      ];
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
    case "error": {
      const diagnostic: RemoteEventDraft = {
        type: "diagnostic",
        payload: {
          category: notification.method,
          message: projectDiagnosticMessage(notification.method, params),
        },
        ...context,
      };
      return params.willRetry === false && threadId !== undefined && turnId !== undefined
        ? [
            diagnostic,
            {
              type: "turn.state",
              payload: {
                state: "failed",
                turn: {
                  id: turnId,
                  status: "failed",
                },
              },
              ...context,
            },
          ]
        : [diagnostic];
    }
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

function normalizeProjectedItemLifecycle(
  item: ConversationItem,
  lifecycle: "started" | "completed",
): ConversationItem {
  if (item.kind === "subagent-activity") {
    return item;
  }
  if (item.kind === "tool" || item.kind === "image-activity") {
    if (item.status === "failed") return item;
    return { ...item, status: lifecycle === "started" ? "running" : "complete" };
  }
  if (item.kind === "file-change") {
    if (item.status === "failed" || item.status === "declined") return item;
    return { ...item, status: lifecycle === "started" ? "inProgress" : "completed" };
  }
  return item;
}

function projectCollabAgentStatus(
  agentsStates: Record<string, unknown>,
  fallbackStatus: unknown,
): "running" | "complete" | "failed" {
  const statuses = Object.values(agentsStates).flatMap((state) => {
    const status = isRecord(state) ? asNonEmptyString(state.status) : undefined;
    return status === undefined ? [] : [status];
  });
  if (statuses.some((status) => ["interrupted", "errored", "notFound"].includes(status))) {
    return "failed";
  }
  if (statuses.some((status) => status === "pendingInit" || status === "running")) {
    return "running";
  }
  if (statuses.some((status) => status === "completed" || status === "shutdown")) {
    return "complete";
  }
  return projectToolStatus(fallbackStatus);
}

function projectedToolTitle(tool: string | undefined, fallback: string): string {
  const normalized = tool?.trim().toLocaleLowerCase("en-US") ?? "";
  if (/(?:^|__)list_threads$/u.test(normalized)) return "列出 Codex 任务";
  if (/(?:^|__)read_thread$/u.test(normalized)) return "读取另一个 Codex 任务";
  if (/(?:^|__)send_message_to_thread$/u.test(normalized)) {
    return "向另一个 Codex 任务发送消息";
  }
  if (/(?:^|__)wait_threads$/u.test(normalized)) return "等待 Codex 任务";
  if (/(?:^|[._-])gmail(?:[._-]|$)|(?:^|__)gmail__/u.test(normalized)) {
    return "使用 Gmail 插件";
  }
  return fallback;
}

function projectedToolSummary(tool: string | undefined): string | undefined {
  if (tool === undefined || projectedToolTitle(tool, "")) return undefined;
  return tool;
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

function imagePathsFromItem(item: Record<string, unknown>): string[] {
  const candidates: unknown[] = [
    item.path,
    item.imagePath,
    item.image_path,
    item.savedPath,
    item.saved_path,
    ...asStringArray(item.paths),
    ...asStringArray(item.imagePaths),
    ...asStringArray(item.image_paths),
    ...asStringArray(item.local_images),
  ];
  for (const image of asRecordArray(item.images)) {
    candidates.push(
      image.path,
      image.imagePath,
      image.image_path,
      image.savedPath,
      image.saved_path,
    );
  }
  const paths = new Set<string>();
  for (const candidate of candidates) {
    const value = boundedProductText(candidate, 32_768);
    if (value === undefined || /^(?:data|https?):/i.test(value)) continue;
    paths.add(value);
  }
  return [...paths];
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
  const lastTurnState = lastTurn ? projectTurnState(lastTurn.status) : "idle";
  if (status === "idle" || status === "notLoaded") {
    return lastTurnState === "running" ? "idle" : lastTurnState;
  }
  if (status === "failed" || status === "systemError") {
    return "failed";
  }
  if (status === "complete" || status === "completed") {
    return "complete";
  }
  return lastTurnState;
}

function projectActiveTurn(
  thread: Record<string, unknown>,
  turns: Record<string, unknown>[],
): Record<string, unknown> | undefined {
  const statusRecord = isRecord(thread.status) ? thread.status : {};
  const status = isRecord(thread.status) ? statusRecord.type : thread.status;
  if (
    status === "idle" ||
    status === "notLoaded" ||
    status === "systemError" ||
    status === "failed" ||
    status === "complete" ||
    status === "completed"
  ) {
    return undefined;
  }
  return turns.findLast((turn) => turn.status === "inProgress");
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
