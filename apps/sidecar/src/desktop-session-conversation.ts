import type { BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import type {
  ConversationAttachment,
  ConversationItem,
  ThreadSettingsInput,
} from "@codex-local-remote/contracts";

const DEFAULT_READ_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_JSON_LINE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_PROJECTED_ITEMS = 50_000;
const DEFAULT_MAX_PROJECTED_TEXT_BYTES = 64 * 1024 * 1024;
const RECENT_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_USER_ATTACHMENTS = 32;
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface DesktopSessionConversationInput {
  codexHome: string;
  sessionPath?: string;
  threadId: string;
}

export interface DesktopSessionConversationReaderOptions {
  maxJsonLineBytes?: number;
  maxProjectedItems?: number;
  maxProjectedTextBytes?: number;
  readChunkBytes?: number;
}

export interface DesktopSessionConversationReadDiagnostic {
  capturedBytes: string;
  processedBytes: string;
  reason?:
    | "invalid-json"
    | "overlong-line"
    | "projection-limit"
    | "read-failed"
    | "unstable-file"
    | "unterminated-line";
  skippedItems: number;
  skippedLines: number;
  status: "complete" | "failed" | "truncated";
}

export interface DesktopSessionConversationReadResult {
  diagnostic: DesktopSessionConversationReadDiagnostic;
  items: ConversationItem[];
}

export interface DesktopSessionControlHead {
  activeTurnId?: string;
  sourceBytes: number;
}

interface ResolvedReaderOptions {
  maxJsonLineBytes: number;
  maxProjectedItems: number;
  maxProjectedTextBytes: number;
  readChunkBytes: number;
}

interface PendingQuestionCall {
  createdAt?: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    isSecret: boolean;
    options?: Array<{ label: string; description: string }>;
  }>;
  turnId?: string;
}

interface PendingUserMessage {
  attachments: ConversationAttachment[];
  createdAt?: string;
  id: string;
  text: string;
  turnId?: string;
}

interface PendingToolCall {
  index: number;
  itemId: string;
  replaceOnPatch: boolean;
  toolKind: "image-generation" | "other" | "shell" | "view-image";
  turnId?: string;
}

interface CachedConversation {
  diagnostic: DesktopSessionConversationReadDiagnostic;
  items: ConversationItem[];
  modifiedAtNs: bigint;
  path: string;
  runtimeSettings?: ThreadSettingsInput;
  size: bigint;
}

interface CachedRuntimeSettings {
  modifiedAtNs: bigint;
  path: string;
  runtimeSettings?: ThreadSettingsInput;
  size: bigint;
}

interface StreamResult {
  diagnostic: DesktopSessionConversationReadDiagnostic;
  stable: boolean;
}

interface StableTailResult {
  capturedBytes: bigint;
  lines: string[];
  stable: boolean;
  unterminatedLine: boolean;
}

type ConversationReadScope = "complete" | "recent";
type HistoryPartialReason = "invalid-json" | "overlong-line" | "unterminated-line";

interface ProjectionResult {
  diagnostic: DesktopSessionConversationReadDiagnostic;
  items: ConversationItem[];
  runtimeSettings?: ThreadSettingsInput;
}

export class DesktopSessionConversationReader {
  readonly #cache = new Map<string, CachedConversation>();
  readonly #options: ResolvedReaderOptions;
  readonly #runtimeSettingsCache = new Map<string, CachedRuntimeSettings>();

  constructor(options: DesktopSessionConversationReaderOptions = {}) {
    this.#options = {
      maxJsonLineBytes: positiveInteger(options.maxJsonLineBytes, DEFAULT_MAX_JSON_LINE_BYTES),
      maxProjectedItems: positiveInteger(options.maxProjectedItems, DEFAULT_MAX_PROJECTED_ITEMS),
      maxProjectedTextBytes: positiveInteger(
        options.maxProjectedTextBytes,
        DEFAULT_MAX_PROJECTED_TEXT_BYTES,
      ),
      readChunkBytes: positiveInteger(options.readChunkBytes, DEFAULT_READ_CHUNK_BYTES),
    };
  }

  async read(input: DesktopSessionConversationInput): Promise<ConversationItem[]> {
    const result = await this.readWithDiagnostic(input, "complete");
    return result?.items ?? [];
  }

  async readRecent(input: DesktopSessionConversationInput): Promise<ConversationItem[]> {
    const result = await this.readWithDiagnostic(input, "recent");
    return result?.items ?? [];
  }

  async readDiagnostic(
    input: DesktopSessionConversationInput,
    scope: ConversationReadScope = "complete",
  ): Promise<DesktopSessionConversationReadDiagnostic | undefined> {
    const result = await this.readWithDiagnostic(input, scope);
    return result?.diagnostic;
  }

  async readWithDiagnostic(
    input: DesktopSessionConversationInput,
    scope: ConversationReadScope = "complete",
  ): Promise<DesktopSessionConversationReadResult | undefined> {
    const snapshot = await this.#readSnapshot(input, scope);
    return snapshot === undefined
      ? undefined
      : {
          diagnostic: structuredClone(snapshot.diagnostic),
          items: snapshot.items.map(cloneConversationItem),
        };
  }

  async readRuntimeSettings(
    input: DesktopSessionConversationInput,
  ): Promise<ThreadSettingsInput | undefined> {
    const location = await resolveSessionLocation(input);
    if (location === undefined) return undefined;
    let metadata: BigIntStats;
    try {
      metadata = await lstat(location.path, { bigint: true });
    } catch {
      return undefined;
    }
    const cached = this.#runtimeSettingsCache.get(input.threadId);
    if (
      cached !== undefined &&
      sameLocalPath(cached.path, location.path) &&
      cached.modifiedAtNs === metadata.mtimeNs &&
      cached.size === metadata.size
    ) {
      return cached.runtimeSettings === undefined
        ? undefined
        : structuredClone(cached.runtimeSettings);
    }
    const tail = await readStableTailLines(location.path, location.sessionsRoot);
    if (!tail.stable) return undefined;
    const runtimeSettings = projectPersistedRuntimeSettings(tail.lines);
    this.#runtimeSettingsCache.set(input.threadId, {
      modifiedAtNs: metadata.mtimeNs,
      path: location.path,
      ...(runtimeSettings === undefined ? {} : { runtimeSettings }),
      size: metadata.size,
    });
    return runtimeSettings === undefined ? undefined : structuredClone(runtimeSettings);
  }

  async readControlHead(
    input: DesktopSessionConversationInput,
  ): Promise<DesktopSessionControlHead | undefined> {
    const location = await resolveSessionLocation(input);
    if (location === undefined) return undefined;
    let metadata: BigIntStats;
    try {
      metadata = await lstat(location.path, { bigint: true });
    } catch {
      return undefined;
    }
    const sourceBytes = Number(metadata.size);
    if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0) return undefined;
    let tail = await readStableTailLines(location.path, location.sessionsRoot);
    if (!tail.stable) {
      tail = await readStableTailLines(location.path, location.sessionsRoot);
    }
    if (!tail.stable) return { sourceBytes };
    const activeTurnId = projectPersistedActiveTurnId(tail.lines);
    return {
      ...(activeTurnId === undefined ? {} : { activeTurnId }),
      sourceBytes,
    };
  }

  async #readSnapshot(
    input: DesktopSessionConversationInput,
    scope: ConversationReadScope,
  ): Promise<CachedConversation | undefined> {
    const location = await resolveSessionLocation(input);
    if (location === undefined) return undefined;

    let metadata: BigIntStats;
    try {
      metadata = await lstat(location.path, { bigint: true });
    } catch {
      return undefined;
    }
    const cacheKey = `${input.threadId}:${scope}`;
    const cached = this.#cache.get(cacheKey);
    if (
      cached !== undefined &&
      sameLocalPath(cached.path, location.path) &&
      cached.modifiedAtNs === metadata.mtimeNs &&
      cached.size === metadata.size
    ) {
      return cached;
    }

    const readProjection = async () => {
      const projection = new PersistedConversationProjection(input.threadId, this.#options);
      const stream =
        scope === "complete"
          ? await streamStableJsonLines(
              location.path,
              location.sessionsRoot,
              this.#options,
              (line) => projection.accept(line),
            )
          : await streamStableTailJsonLines(location.path, location.sessionsRoot, (line) =>
              projection.accept(line),
            );
      return { projection, stream };
    };
    let attempt = await readProjection();
    if (!attempt.stream.stable && attempt.stream.diagnostic.reason === "unstable-file") {
      attempt = await readProjection();
    }
    const { projection, stream } = attempt;
    const projected = stream.stable
      ? projection.finish(stream.diagnostic)
      : failedProjection(input.threadId, stream.diagnostic);
    const snapshot: CachedConversation = {
      diagnostic: projected.diagnostic,
      items: projected.items,
      modifiedAtNs: metadata.mtimeNs,
      path: location.path,
      ...(projected.runtimeSettings === undefined
        ? {}
        : { runtimeSettings: projected.runtimeSettings }),
      size: metadata.size,
    };
    if (stream.stable) {
      this.#cache.set(cacheKey, snapshot);
    }
    return snapshot;
  }
}

class PersistedConversationProjection {
  #currentTurnId: string | undefined;
  readonly #itemIndexes = new Map<string, number>();
  readonly #items: ConversationItem[] = [];
  readonly #options: ResolvedReaderOptions;
  readonly #pendingQuestions = new Map<string, PendingQuestionCall>();
  readonly #pendingTools = new Map<string, PendingToolCall>();
  readonly #suppressedToolCalls = new Set<string>();
  readonly #threadId: string;
  #pendingUser: PendingUserMessage | undefined;
  #projectedTextBytes = 0;
  #runtimeSettings: ThreadSettingsInput | undefined;
  #skippedItems = 0;
  #syntheticEventSequence = 0;

  constructor(threadId: string, options: ResolvedReaderOptions) {
    this.#threadId = threadId;
    this.#options = options;
  }

  accept(line: string): boolean {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return false;
    }
    const record = asRecord(value);
    const payload = asRecord(record.payload);
    const createdAt = asString(record.timestamp);
    const recordTurnId = persistedTurnId(payload);
    if (
      recordTurnId !== undefined &&
      this.#currentTurnId !== undefined &&
      recordTurnId !== this.#currentTurnId
    ) {
      this.#finalizePendingToolsBeforeTurn(recordTurnId);
    }
    if (recordTurnId !== undefined) this.#currentTurnId = recordTurnId;

    if (record.type === "turn_context") {
      const settings = projectTurnContextSettings(payload);
      if (settings !== undefined) this.#runtimeSettings = settings;
      return true;
    }

    if (record.type === "response_item" && payload.type === "message") {
      const role = asString(payload.role);
      if (role === "user") {
        this.#acceptUserMessage(payload, createdAt);
      } else if (role === "assistant") {
        this.#flushPendingUser();
        this.#acceptAssistantMessage(payload, createdAt);
      }
      return true;
    }

    if (record.type === "response_item" && payload.type === "reasoning") {
      this.#flushPendingUser();
      this.#acceptReasoningSummary(payload, createdAt);
      return true;
    }

    if (record.type === "event_msg" && payload.type === "user_message") {
      this.#acceptUserMessageAttachments(payload);
      this.#flushPendingUser();
      return true;
    }

    if (
      record.type === "response_item" &&
      (payload.type === "function_call" ||
        payload.type === "custom_tool_call" ||
        payload.type === "tool_search_call")
    ) {
      this.#flushPendingUser();
      if (payload.type === "function_call" && asString(payload.name) === "request_user_input") {
        this.#acceptQuestionCall(payload, createdAt);
      } else {
        this.#acceptToolCall(payload, createdAt);
      }
      return true;
    }

    if (
      record.type === "response_item" &&
      (payload.type === "function_call_output" ||
        payload.type === "custom_tool_call_output" ||
        payload.type === "tool_search_output")
    ) {
      this.#flushPendingUser();
      const callId = asString(payload.call_id);
      if (
        payload.type === "function_call_output" &&
        callId !== undefined &&
        this.#pendingQuestions.has(callId)
      ) {
        this.#acceptQuestionOutput(payload, createdAt);
      } else {
        this.#acceptToolOutput(payload, createdAt);
      }
      return true;
    }

    if (record.type === "event_msg") {
      if (payload.type === "item_completed") {
        this.#acceptCompletedItem(payload, createdAt);
      } else if (payload.type === "sub_agent_activity") {
        this.#flushPendingUser();
        this.#acceptSubagentActivity(payload, createdAt);
      } else if (payload.type === "context_compacted") {
        this.#flushPendingUser();
        this.#acceptContextCompaction(createdAt);
      } else if (payload.type === "patch_apply_end") {
        this.#flushPendingUser();
        this.#acceptPatchApplyEnd(payload, createdAt);
      }
    }
    return true;
  }

  finish(streamDiagnostic: DesktopSessionConversationReadDiagnostic): ProjectionResult {
    this.#flushPendingUser();
    const diagnostic: DesktopSessionConversationReadDiagnostic = {
      ...streamDiagnostic,
      ...(streamDiagnostic.status === "complete" && this.#skippedItems > 0
        ? { reason: "projection-limit" as const, status: "truncated" as const }
        : {}),
      skippedItems: streamDiagnostic.skippedItems + this.#skippedItems,
    };
    const items = [...this.#items];
    if (diagnostic.status !== "complete") {
      items.push(diagnosticConversationItem(this.#threadId, diagnostic));
    }
    return {
      diagnostic,
      items,
      ...(this.#runtimeSettings === undefined ? {} : { runtimeSettings: this.#runtimeSettings }),
    };
  }

  #acceptUserMessage(payload: Record<string, unknown>, createdAt: string | undefined): void {
    const id = asString(payload.id);
    if (id === undefined) return;
    const metadata = asRecord(payload.internal_chat_message_metadata_passthrough);
    const turnId = asString(metadata.turn_id);
    const next: PendingUserMessage = {
      attachments: [],
      ...(createdAt === undefined ? {} : { createdAt }),
      id,
      text: messageText(payload.content, "input_text"),
      ...(turnId === undefined ? {} : { turnId }),
    };
    if (
      this.#pendingUser !== undefined &&
      !sameOptionalTurn(this.#pendingUser.turnId, next.turnId)
    ) {
      this.#flushPendingUser();
    }
    // A Codex turn can contain multiple host-injected role=user records. The
    // last role=user record in that turn is the actual user/delegation message.
    this.#pendingUser = next;
  }

  #acceptAssistantMessage(payload: Record<string, unknown>, createdAt: string | undefined): void {
    const id = asString(payload.id);
    if (id === undefined) return;
    const text = messageText(payload.content, "output_text");
    if (text.length === 0) return;
    const metadata = asRecord(payload.internal_chat_message_metadata_passthrough);
    const turnId = asString(metadata.turn_id);
    const rawPhase = asString(payload.phase);
    const phase = rawPhase === "commentary" || rawPhase === "final_answer" ? rawPhase : undefined;
    this.#push({
      id,
      kind: "assistant-message",
      text,
      ...(phase === undefined ? {} : { phase }),
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(turnId === undefined ? {} : { turnId }),
    });
  }

  #acceptReasoningSummary(payload: Record<string, unknown>, createdAt: string | undefined): void {
    const id = asString(payload.id);
    if (id === undefined) return;
    const text = reasoningSummaryText(payload.summary);
    if (text.length === 0) return;
    const turnId = persistedTurnId(payload);
    this.#push({
      id,
      kind: "reasoning-summary",
      text,
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(turnId === undefined ? {} : { turnId }),
    });
  }

  #acceptUserMessageAttachments(payload: Record<string, unknown>): void {
    const pending = this.#pendingUser;
    if (pending === undefined) return;
    const eventText = asString(payload.message);
    if (pending.text.length === 0 && eventText !== undefined) pending.text = eventText;

    const candidates: Array<{ kind: ConversationAttachment["kind"]; value: unknown }> = [
      ...asStringArray(payload.local_images).map((value) => ({ kind: "image" as const, value })),
      ...asStringArray(payload.local_audio).map((value) => ({ kind: "file" as const, value })),
    ];
    for (const element of asRecordArray(payload.text_elements)) {
      const type = asString(element.type)?.toLocaleLowerCase("en-US") ?? "";
      const kind: ConversationAttachment["kind"] = type.includes("image") ? "image" : "file";
      candidates.push(
        { kind, value: element.path },
        { kind, value: element.local_path },
        { kind, value: element.image_path },
      );
    }
    const knownPaths = new Set(pending.attachments.map((attachment) => attachment.path));
    for (const candidate of candidates) {
      if (pending.attachments.length >= MAX_USER_ATTACHMENTS) break;
      const rawPath = asString(candidate.value);
      const normalized = rawPath === undefined ? undefined : normalizeLocalAbsolutePath(rawPath);
      if (normalized === undefined || knownPaths.has(normalized)) continue;
      knownPaths.add(normalized);
      pending.attachments.push({
        kind: candidate.kind,
        name: path.basename(normalized),
        path: normalized,
      });
    }
  }

  #acceptQuestionCall(payload: Record<string, unknown>, createdAt: string | undefined): void {
    const callId = asString(payload.call_id);
    if (callId === undefined || asString(payload.name) !== "request_user_input") return;
    const argumentsRecord = parseJsonRecord(payload.arguments);
    const questions = projectQuestions(argumentsRecord.questions);
    if (questions.length === 0) return;
    const metadata = asRecord(payload.internal_chat_message_metadata_passthrough);
    const turnId = asString(metadata.turn_id);
    this.#pendingQuestions.set(callId, {
      ...(createdAt === undefined ? {} : { createdAt }),
      questions,
      ...(turnId === undefined ? {} : { turnId }),
    });
  }

  #acceptQuestionOutput(payload: Record<string, unknown>, createdAt: string | undefined): void {
    const callId = asString(payload.call_id);
    const pending = callId === undefined ? undefined : this.#pendingQuestions.get(callId);
    if (callId === undefined || pending === undefined) return;
    const output = parseJsonRecord(payload.output);
    const answers = asRecord(output.answers);
    const answered = pending.questions.some(
      (question) => asStringArray(asRecord(answers[question.id]).answers).length > 0,
    );
    const questions = pending.questions.map((question) => {
      const answerRecord = asRecord(answers[question.id]);
      const answerValues = question.isSecret ? [] : asStringArray(answerRecord.answers).slice(0, 8);
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        isSecret: question.isSecret,
        ...(question.options === undefined ? {} : { options: question.options }),
        ...(answerValues.length === 0 ? {} : { answers: answerValues }),
      };
    });
    this.#push({
      id: `interaction-${callId}`,
      kind: "interaction-record",
      interaction: "question",
      status: answered ? "answered" : "skipped",
      title: "Codex 提出了问题",
      questions,
      ...((createdAt ?? pending.createdAt) === undefined
        ? {}
        : { createdAt: createdAt ?? pending.createdAt }),
      ...(pending.turnId === undefined ? {} : { turnId: pending.turnId }),
    });
    this.#pendingQuestions.delete(callId);
  }

  #acceptToolCall(payload: Record<string, unknown>, createdAt: string | undefined): void {
    const callId = asString(payload.call_id);
    if (callId === undefined || this.#suppressedToolCalls.has(callId)) return;
    const toolName = asString(payload.name);
    if (isDedicatedProductControlTool(toolName)) {
      this.#suppressedToolCalls.add(callId);
      return;
    }
    const itemId = asString(payload.id) ?? `persisted-tool-call-${callId}`;
    const turnId = persistedTurnId(payload) ?? this.#currentTurnId;
    const toolKind = persistedToolKind(toolName);
    const title =
      payload.type === "tool_search_call" ? "查找可用工具" : persistedToolTitle(toolName);
    const status = persistedToolStatus(payload.status, "running");
    const callArguments = parseJsonRecord(payload.arguments);
    const viewedPath =
      toolKind === "view-image"
        ? normalizeLocalAbsolutePath(asString(callArguments.path) ?? "")
        : undefined;
    const shellSummary =
      toolKind === "shell" ? boundedProductText(callArguments.command, 1_024) : undefined;
    const index = this.#push(
      viewedPath === undefined
        ? {
            id: itemId,
            kind: "tool",
            status,
            title,
            ...(shellSummary === undefined ? {} : { summary: shellSummary }),
            ...(createdAt === undefined ? {} : { createdAt }),
            ...(turnId === undefined ? {} : { turnId }),
          }
        : {
            id: itemId,
            kind: "image-activity",
            action: "viewed",
            attachments: [
              {
                kind: "image",
                name: path.win32.basename(viewedPath.replaceAll("/", "\\")) || "已查看的图片",
                path: viewedPath,
              },
            ],
            status,
            ...(createdAt === undefined ? {} : { createdAt }),
            ...(turnId === undefined ? {} : { turnId }),
          },
    );
    if (index === undefined) return;
    this.#pendingTools.set(callId, {
      index,
      itemId,
      replaceOnPatch: toolName?.toLocaleLowerCase("en-US") === "apply_patch",
      toolKind,
      ...(turnId === undefined ? {} : { turnId }),
    });
  }

  #acceptToolOutput(payload: Record<string, unknown>, createdAt: string | undefined): void {
    const callId = asString(payload.call_id);
    if (callId === undefined) return;
    if (this.#suppressedToolCalls.has(callId) || looksLikeQuestionOutput(payload.output)) return;
    const pending = this.#pendingTools.get(callId);
    const status = persistedToolOutputFailed(payload) ? "failed" : "complete";
    if (pending !== undefined) {
      const current = this.#items[pending.index];
      if (current?.id === pending.itemId) {
        const generatedPath =
          status === "complete" && pending.toolKind === "image-generation"
            ? persistedGeneratedImagePath(payload.output)
            : undefined;
        if (generatedPath !== undefined) {
          this.#replace(pending.index, {
            id: current.id,
            kind: "image-activity",
            action: "generated",
            attachments: [
              {
                kind: "image",
                name: path.win32.basename(generatedPath.replaceAll("/", "\\")) || "生成的图片",
                path: generatedPath,
              },
            ],
            status: "complete",
            ...(current.createdAt === undefined ? {} : { createdAt: current.createdAt }),
            ...(current.turnId === undefined ? {} : { turnId: current.turnId }),
          });
        } else if (current.kind === "tool") {
          const detail =
            pending.toolKind === "shell" ? boundedProductText(payload.output, 16_384) : undefined;
          this.#replace(pending.index, {
            ...current,
            status,
            ...(detail === undefined ? {} : { detail }),
          });
        } else if (current.kind === "image-activity") {
          this.#replace(pending.index, { ...current, status });
        }
      }
      if (!pending.replaceOnPatch) this.#pendingTools.delete(callId);
      return;
    }

    const itemId = asString(payload.id) ?? `persisted-tool-output-${callId}`;
    const turnId = persistedTurnId(payload) ?? this.#currentTurnId;
    this.#push({
      id: itemId,
      kind: "tool",
      status,
      title: payload.type === "tool_search_output" ? "查找可用工具" : "使用工具",
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(turnId === undefined ? {} : { turnId }),
    });
  }

  #acceptSubagentActivity(payload: Record<string, unknown>, createdAt: string | undefined): void {
    const threadId = boundedString(payload.agent_thread_id, 512);
    if (threadId === undefined) return;
    const kind = asString(payload.kind)?.toLocaleLowerCase("en-US");
    const rawAgentPath = boundedString(payload.agent_path, 1_024);
    const label =
      rawAgentPath === undefined
        ? undefined
        : boundedString(path.posix.basename(rawAgentPath.replaceAll("\\", "/")), 256);
    const eventCreatedAt = createdAt ?? timestampFromEpochMilliseconds(payload.occurred_at_ms);
    const id =
      boundedString(payload.event_id, 512) ??
      `persisted-subagent-${threadId}-${eventCreatedAt ?? kind ?? "activity"}`;
    const turnId = persistedTurnId(payload) ?? this.#currentTurnId;
    const activity: ConversationItem = {
      id,
      kind: "subagent-activity",
      action: persistedSubagentAction(kind),
      agents: [{ threadId, ...(label === undefined ? {} : { label }) }],
      status: persistedSubagentStatus(kind),
      ...(eventCreatedAt === undefined ? {} : { createdAt: eventCreatedAt }),
      ...(turnId === undefined ? {} : { turnId }),
    };
    this.#push(activity);
  }

  #acceptContextCompaction(createdAt: string | undefined): void {
    const turnId = this.#currentTurnId;
    const sequence = this.#syntheticEventSequence;
    this.#syntheticEventSequence += 1;
    this.#push({
      id: `persisted-context-compaction-${turnId ?? this.#threadId}-${sequence}-${createdAt ?? "unknown"}`,
      kind: "tool",
      operation: "context-compaction",
      status: "complete",
      title: "压缩对话上下文",
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(turnId === undefined ? {} : { turnId }),
    });
  }

  #acceptPatchApplyEnd(payload: Record<string, unknown>, createdAt: string | undefined): void {
    const changes = asRecord(payload.changes);
    const callId = boundedString(payload.call_id, 512) ?? createdAt ?? "unknown";
    const turnId = persistedTurnId(payload) ?? this.#currentTurnId;
    const status = persistedFileChangeStatus(payload);
    const projectedChanges: ConversationItem[] = [];
    let changeIndex = 0;
    for (const [rawPath, rawChange] of Object.entries(changes)) {
      const changedPath = normalizeLocalAbsolutePath(rawPath);
      const changeRecord = asRecord(rawChange);
      const change = persistedFileChangeKind(changeRecord.type);
      if (changedPath === undefined || change === undefined) continue;
      const targetPathValue = asString(changeRecord.move_path);
      const targetPath =
        targetPathValue === undefined ? undefined : normalizeLocalAbsolutePath(targetPathValue);
      const unifiedDiff = asString(changeRecord.unified_diff);
      const diff = boundedProductText(unifiedDiff, 128 * 1_024);
      const diffCounts = unifiedDiffCounts(unifiedDiff);
      projectedChanges.push({
        id: `patch-${callId}-${changeIndex}`,
        kind: "file-change",
        path: changedPath,
        change,
        status,
        ...(targetPath === undefined ? {} : { targetPath }),
        ...(diff === undefined ? {} : { diff }),
        ...(diffCounts === undefined ? {} : diffCounts),
        ...(createdAt === undefined ? {} : { createdAt }),
        ...(turnId === undefined ? {} : { turnId }),
      });
      changeIndex += 1;
    }
    if (projectedChanges.length === 0) {
      projectedChanges.push({
        id: `patch-${callId}`,
        kind: "tool",
        status: status === "completed" ? "complete" : "failed",
        title: "修改文件",
        ...(createdAt === undefined ? {} : { createdAt }),
        ...(turnId === undefined ? {} : { turnId }),
      });
    }
    this.#replaceToolCallWithItems(callId, projectedChanges);
  }

  #acceptCompletedItem(payload: Record<string, unknown>, createdAt: string | undefined): void {
    const item = asRecord(payload.item);
    if (asString(item.type)?.toLocaleLowerCase("en-US") !== "plan") return;
    const id = asString(item.id);
    const text = asString(item.text);
    if (id === undefined || text === undefined) return;
    this.#flushPendingUser();
    const turnId = asString(payload.turn_id);
    this.#push({
      id,
      kind: "formal-plan",
      text,
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(turnId === undefined ? {} : { turnId }),
    });
  }

  #flushPendingUser(): void {
    const pending = this.#pendingUser;
    if (pending === undefined) return;
    this.#pendingUser = undefined;
    if (pending.text.length === 0 && pending.attachments.length === 0) return;
    this.#push({
      id: pending.id,
      kind: "user-message",
      text: pending.text,
      ...(pending.attachments.length === 0 ? {} : { attachments: pending.attachments }),
      ...(pending.createdAt === undefined ? {} : { createdAt: pending.createdAt }),
      ...(pending.turnId === undefined ? {} : { turnId: pending.turnId }),
    });
  }

  #push(item: ConversationItem): number | undefined {
    const knownIndex = this.#itemIndexes.get(item.id);
    if (knownIndex !== undefined) return knownIndex;
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (
      this.#items.length >= this.#options.maxProjectedItems ||
      this.#projectedTextBytes + itemBytes > this.#options.maxProjectedTextBytes
    ) {
      this.#skippedItems += 1;
      return undefined;
    }
    const index = this.#items.length;
    this.#items.push(item);
    this.#itemIndexes.set(item.id, index);
    this.#projectedTextBytes += itemBytes;
    return index;
  }

  #replace(index: number, item: ConversationItem): void {
    const current = this.#items[index];
    if (current === undefined || current.id !== item.id) return;
    const currentBytes = Buffer.byteLength(JSON.stringify(current), "utf8");
    let next = item;
    let nextBytes = Buffer.byteLength(JSON.stringify(next), "utf8");
    if (this.#projectedTextBytes - currentBytes + nextBytes > this.#options.maxProjectedTextBytes) {
      this.#skippedItems += 1;
      if (current.kind === "tool" && next.kind === "tool") {
        const { detail: _detail, ...withoutDetail } = next;
        next = withoutDetail;
      } else if (current.kind === "tool" && next.kind === "image-activity") {
        next = { ...current, status: next.status };
      }
      nextBytes = Buffer.byteLength(JSON.stringify(next), "utf8");
      if (
        this.#projectedTextBytes - currentBytes + nextBytes >
        this.#options.maxProjectedTextBytes
      ) {
        return;
      }
    }
    this.#items[index] = next;
    this.#projectedTextBytes += nextBytes - currentBytes;
  }

  #replaceToolCallWithItems(callId: string, replacements: ConversationItem[]): void {
    this.#suppressedToolCalls.add(callId);
    const pending = this.#pendingTools.get(callId);
    this.#pendingTools.delete(callId);
    if (pending === undefined) {
      for (const replacement of replacements) this.#push(replacement);
      return;
    }

    const current = this.#items[pending.index];
    if (current === undefined || current.id !== pending.itemId) {
      for (const replacement of replacements) this.#push(replacement);
      return;
    }

    const currentBytes = Buffer.byteLength(JSON.stringify(current), "utf8");
    let nextBytes = this.#projectedTextBytes - currentBytes;
    const accepted: ConversationItem[] = [];
    for (const replacement of replacements) {
      let candidate = replacement;
      const knownIndex = this.#itemIndexes.get(candidate.id);
      if (knownIndex !== undefined && knownIndex !== pending.index) continue;
      let replacementBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
      if (
        nextBytes + replacementBytes > this.#options.maxProjectedTextBytes &&
        candidate.kind === "file-change" &&
        candidate.diff !== undefined
      ) {
        const { diff: _diff, ...withoutDiff } = candidate;
        candidate = withoutDiff;
        replacementBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
        this.#skippedItems += 1;
      }
      if (
        this.#items.length - 1 + accepted.length >= this.#options.maxProjectedItems ||
        nextBytes + replacementBytes > this.#options.maxProjectedTextBytes
      ) {
        this.#skippedItems += 1;
        continue;
      }
      accepted.push(candidate);
      nextBytes += replacementBytes;
    }
    this.#items.splice(pending.index, 1, ...accepted);
    this.#projectedTextBytes = nextBytes;
    this.#rebuildIndexes();
  }

  #rebuildIndexes(): void {
    this.#itemIndexes.clear();
    for (const [index, item] of this.#items.entries()) this.#itemIndexes.set(item.id, index);
    for (const [callId, pending] of this.#pendingTools) {
      const index = this.#itemIndexes.get(pending.itemId);
      if (index === undefined) {
        this.#pendingTools.delete(callId);
      } else {
        pending.index = index;
      }
    }
  }

  #finalizePendingToolsBeforeTurn(nextTurnId: string): void {
    for (const [callId, pending] of this.#pendingTools) {
      if (pending.turnId === undefined || pending.turnId === nextTurnId) continue;
      const current = this.#items[pending.index];
      if (
        current?.id === pending.itemId &&
        (current.kind === "tool" || current.kind === "image-activity")
      ) {
        this.#replace(
          pending.index,
          current.status === "running" ? { ...current, status: "failed" } : current,
        );
      }
      this.#pendingTools.delete(callId);
    }
  }
}

function projectPersistedRuntimeSettings(
  lines: readonly string[],
): ThreadSettingsInput | undefined {
  let latest: ThreadSettingsInput | undefined;
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(value);
    if (record.type !== "turn_context") continue;
    const settings = projectTurnContextSettings(asRecord(record.payload));
    if (settings !== undefined) latest = settings;
  }
  return latest;
}

function projectPersistedActiveTurnId(lines: readonly string[]): string | undefined {
  let latest: string | undefined;
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(value);
    const turnId = persistedTurnId(asRecord(record.payload));
    if (turnId !== undefined) latest = turnId;
  }
  return latest;
}

function projectTurnContextSettings(
  payload: Record<string, unknown>,
): ThreadSettingsInput | undefined {
  const collaboration = asRecord(payload.collaboration_mode);
  const model = boundedString(payload.model, 256);
  const reasoningEffort =
    boundedString(payload.effort, 128) ?? boundedString(payload.reasoning_effort, 128);
  const serviceTier = boundedString(payload.service_tier, 128);
  const approvalPolicy = boundedString(payload.approval_policy, 128);
  const approvalsReviewer = boundedString(payload.approvals_reviewer, 128);
  const collaborationMode =
    boundedString(payload.collaboration_mode, 128) ??
    boundedString(collaboration.mode, 128) ??
    boundedString(collaboration.name, 128);
  const settings: ThreadSettingsInput = {
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
    ...(approvalsReviewer === undefined ? {} : { approvalsReviewer }),
    ...(collaborationMode === undefined ? {} : { collaborationMode }),
  };
  return Object.keys(settings).length === 0 ? undefined : settings;
}

function projectQuestions(value: unknown): PendingQuestionCall["questions"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const question = asRecord(candidate);
    const id = asString(question.id);
    const header = asString(question.header);
    const text = asString(question.question);
    if (id === undefined || header === undefined || text === undefined) return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((candidateOption) => {
          const option = asRecord(candidateOption);
          const label = asString(option.label);
          const description = asString(option.description);
          return label === undefined || description === undefined ? [] : [{ label, description }];
        })
      : [];
    return [
      {
        id,
        header,
        question: text,
        isSecret: question.isSecret === true,
        ...(options.length === 0 ? {} : { options }),
      },
    ];
  });
}

function persistedTurnId(payload: Record<string, unknown>): string | undefined {
  const metadata = asRecord(payload.internal_chat_message_metadata_passthrough);
  return boundedString(payload.turn_id, 512) ?? boundedString(metadata.turn_id, 512);
}

function reasoningSummaryText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((candidate) => {
      const summary = asRecord(candidate);
      const text = asString(summary.text);
      return summary.type === "summary_text" && text !== undefined ? [text] : [];
    })
    .join("\n");
}

function persistedToolTitle(name: string | undefined): string {
  switch (name?.toLocaleLowerCase("en-US")) {
    case "shell_command":
    case "exec":
      return "运行命令";
    case "apply_patch":
      return "修改文件";
    case "update_plan":
      return "更新计划";
    case "read_thread":
    case "send_message_to_thread":
    case "wait_threads":
      return "管理任务";
    case "followup_task":
    case "interrupt_agent":
    case "list_agents":
    case "send_message":
    case "spawn_agent":
    case "wait_agent":
      return "协作任务";
    case "view_image":
      return "查看图片";
    case "image_gen.imagegen":
    case "image_gen__imagegen":
    case "image_generation":
    case "imagegen":
      return "生成图片";
    case "wait":
      return "等待操作";
    default:
      return "使用工具";
  }
}

function persistedToolKind(name: string | undefined): PendingToolCall["toolKind"] {
  switch (name?.toLocaleLowerCase("en-US")) {
    case "shell_command":
      return "shell";
    case "view_image":
      return "view-image";
    case "image_gen.imagegen":
    case "image_gen__imagegen":
    case "image_generation":
    case "imagegen":
      return "image-generation";
    default:
      return "other";
  }
}

function isDedicatedProductControlTool(name: string | undefined): boolean {
  switch (name?.toLocaleLowerCase("en-US")) {
    case "followup_task":
    case "interrupt_agent":
    case "list_agents":
    case "read_thread":
    case "send_message":
    case "send_message_to_thread":
    case "spawn_agent":
    case "update_plan":
    case "wait_agent":
    case "wait_threads":
      return true;
    default:
      return false;
  }
}

function persistedToolStatus(
  value: unknown,
  fallback: "running" | "complete" | "failed",
): "running" | "complete" | "failed" {
  switch (asString(value)?.toLocaleLowerCase("en-US")) {
    case "complete":
    case "completed":
    case "success":
    case "succeeded":
      return "complete";
    case "cancelled":
    case "declined":
    case "error":
    case "failed":
      return "failed";
    case "in_progress":
    case "pending":
    case "running":
    case "started":
      return "running";
    default:
      return fallback;
  }
}

function persistedToolOutputFailed(payload: Record<string, unknown>): boolean {
  const exitCode = strictToolExitCode(payload.output);
  if (exitCode !== undefined) return exitCode !== 0;
  if (persistedToolStatus(payload.status, "complete") === "failed") return true;
  const output = parseJsonRecord(payload.output);
  if (output.success === false || output.ok === false || output.is_error === true) return true;
  const outputStatus = asString(output.status)?.toLocaleLowerCase("en-US");
  if (
    outputStatus === "cancelled" ||
    outputStatus === "declined" ||
    outputStatus === "error" ||
    outputStatus === "failed"
  ) {
    return true;
  }
  return output.error !== undefined && output.error !== null && output.error !== false;
}

function strictToolExitCode(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^Exit code:[ \t]*(-?\d+)[ \t]*(?:\r?\n|$)/u.exec(value);
  if (match === null) return undefined;
  const exitCode = Number(match[1]);
  return Number.isSafeInteger(exitCode) ? exitCode : undefined;
}

function persistedGeneratedImagePath(value: unknown): string | undefined {
  const output = parseJsonRecord(value);
  const candidate = asString(output.saved_path) ?? asString(output.savedPath);
  return candidate === undefined ? undefined : normalizeLocalAbsolutePath(candidate);
}

function boundedProductText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint === 9 ||
        codePoint === 10 ||
        codePoint === 13 ||
        (codePoint >= 32 && codePoint !== 127)
      );
    })
    .join("");
  if (text.length === 0) return undefined;
  if (text.length <= maxLength) return text;
  const suffix = "\n…（内容已截断）";
  return `${text.slice(0, Math.max(0, maxLength - suffix.length))}${suffix}`;
}

function unifiedDiffCounts(
  diff: string | undefined,
): { additions: number; deletions: number } | undefined {
  if (diff === undefined) return undefined;
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function looksLikeQuestionOutput(value: unknown): boolean {
  const answers = asRecord(parseJsonRecord(value).answers);
  return Object.keys(answers).length > 0;
}

function persistedSubagentAction(
  kind: string | undefined,
): Extract<ConversationItem, { kind: "subagent-activity" }>["action"] {
  switch (kind) {
    case "spawn":
    case "spawned":
    case "start":
    case "started":
      return "spawn";
    case "resume":
    case "resumed":
      return "resume";
    case "wait":
    case "waiting":
      return "wait";
    case "close":
    case "closed":
    case "complete":
    case "completed":
    case "finished":
      return "close";
    case "interacted":
    case "message":
    case "updated":
      return "update";
    default:
      return "activity";
  }
}

function persistedSubagentStatus(
  kind: string | undefined,
): Extract<ConversationItem, { kind: "subagent-activity" }>["status"] {
  switch (kind) {
    case "spawn":
    case "spawned":
    case "start":
    case "started":
      return "running";
    case "close":
    case "closed":
    case "complete":
    case "completed":
    case "finished":
    case "interacted":
      return "complete";
    case "cancelled":
    case "error":
    case "failed":
    case "interrupted":
      return "failed";
    default:
      return "failed";
  }
}

function timestampFromEpochMilliseconds(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  try {
    return new Date(value).toISOString();
  } catch {
    return undefined;
  }
}

function persistedFileChangeKind(
  value: unknown,
): Extract<ConversationItem, { kind: "file-change" }>["change"] | undefined {
  switch (asString(value)?.toLocaleLowerCase("en-US")) {
    case "add":
    case "added":
    case "create":
    case "created":
      return "added";
    case "delete":
    case "deleted":
    case "remove":
    case "removed":
      return "deleted";
    case "modify":
    case "modified":
    case "move":
    case "rename":
    case "update":
      return "modified";
    default:
      return undefined;
  }
}

function persistedFileChangeStatus(
  payload: Record<string, unknown>,
): NonNullable<Extract<ConversationItem, { kind: "file-change" }>["status"]> {
  const status = asString(payload.status)?.toLocaleLowerCase("en-US");
  if (payload.success === false || status === "error" || status === "failed") return "failed";
  if (status === "declined") return "declined";
  if (status === "in_progress" || status === "running") return "inProgress";
  return "completed";
}

async function resolveSessionLocation(
  input: DesktopSessionConversationInput,
): Promise<{ path: string; sessionsRoot: string } | undefined> {
  if (!THREAD_ID_PATTERN.test(input.threadId.trim()) || input.sessionPath === undefined) {
    return undefined;
  }
  const requestedHome = normalizeLocalAbsolutePath(input.codexHome);
  const requestedPath = normalizeLocalAbsolutePath(input.sessionPath);
  if (requestedHome === undefined || requestedPath === undefined) return undefined;
  const canonicalHome = await canonicalDirectory(requestedHome);
  if (canonicalHome === undefined || !sameLocalPath(requestedHome, canonicalHome)) return undefined;
  const requestedSessionsRoot = path.join(canonicalHome, "sessions");
  const sessionsRoot = await canonicalDirectory(requestedSessionsRoot);
  if (
    sessionsRoot === undefined ||
    !sameLocalPath(requestedSessionsRoot, sessionsRoot) ||
    !isPathInside(canonicalHome, sessionsRoot) ||
    !path.basename(requestedPath).toLocaleLowerCase("en-US").endsWith(`-${input.threadId}.jsonl`) ||
    !isPathInside(sessionsRoot, requestedPath)
  ) {
    return undefined;
  }
  return { path: requestedPath, sessionsRoot };
}

async function streamStableTailJsonLines(
  requestedPath: string,
  sessionsRoot: string,
  accept: (line: string) => boolean,
): Promise<StreamResult> {
  const tail = await readStableTailLines(requestedPath, sessionsRoot);
  if (!tail.stable) return failedStream("unstable-file", tail.capturedBytes, 0n);
  let skippedLines = 0;
  let partialReason: HistoryPartialReason | undefined;
  for (const line of tail.lines) {
    if (accept(line)) continue;
    skippedLines += 1;
    partialReason = preferHistoryPartialReason(partialReason, "invalid-json");
  }
  if (tail.unterminatedLine) {
    skippedLines += 1;
    partialReason = preferHistoryPartialReason(partialReason, "unterminated-line");
  }
  return {
    diagnostic: {
      capturedBytes: tail.capturedBytes.toString(),
      processedBytes: tail.capturedBytes.toString(),
      ...(partialReason === undefined ? {} : { reason: partialReason }),
      skippedItems: 0,
      skippedLines,
      status: partialReason === undefined ? "complete" : "truncated",
    },
    stable: true,
  };
}

async function readStableTailLines(
  requestedPath: string,
  sessionsRoot: string,
): Promise<StableTailResult> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let capturedBytes = 0n;
  try {
    const before = await lstat(requestedPath, { bigint: true });
    const canonicalBeforeOpen = normalizeLocalAbsolutePath(await realpath(requestedPath));
    if (
      canonicalBeforeOpen === undefined ||
      !isRegularFile(before) ||
      !sameLocalPath(requestedPath, canonicalBeforeOpen) ||
      !isPathInside(sessionsRoot, canonicalBeforeOpen)
    ) {
      return { capturedBytes, lines: [], stable: false, unterminatedLine: false };
    }
    handle = await open(requestedPath, "r");
    const handleBeforeRead = await handle.stat({ bigint: true });
    if (!isRegularFile(handleBeforeRead) || !sameFileIdentity(before, handleBeforeRead)) {
      return { capturedBytes, lines: [], stable: false, unterminatedLine: false };
    }
    const capturedSize = handleBeforeRead.size;
    const tailLength = Number(
      capturedSize > BigInt(RECENT_TAIL_BYTES) ? BigInt(RECENT_TAIL_BYTES) : capturedSize,
    );
    capturedBytes = BigInt(tailLength);
    const tailStart = capturedSize - capturedBytes;
    const buffer = Buffer.allocUnsafe(tailLength);
    let bytesRead = 0;
    while (bytesRead < tailLength) {
      const result = await handle.read(
        buffer,
        bytesRead,
        tailLength - bytesRead,
        tailStart + BigInt(bytesRead),
      );
      if (result.bytesRead <= 0 || result.bytesRead > tailLength - bytesRead) {
        return { capturedBytes, lines: [], stable: false, unterminatedLine: false };
      }
      bytesRead += result.bytesRead;
    }
    const afterRead = await lstat(requestedPath, { bigint: true });
    const handleAfterRead = await handle.stat({ bigint: true });
    const canonicalAfterRead = normalizeLocalAbsolutePath(await realpath(requestedPath));
    if (
      canonicalAfterRead === undefined ||
      !isRegularFile(afterRead) ||
      !isRegularFile(handleAfterRead) ||
      !sameFileSnapshot(handleBeforeRead, afterRead) ||
      !sameFileSnapshot(afterRead, handleAfterRead) ||
      !sameLocalPath(requestedPath, canonicalAfterRead) ||
      afterRead.size !== capturedSize
    ) {
      return { capturedBytes, lines: [], stable: false, unterminatedLine: false };
    }
    const unterminatedLine = buffer.length > 0 && buffer[buffer.length - 1] !== 10;
    const lines = buffer.toString("utf8").split(/\r?\n/u);
    if (tailStart > 0n) lines.shift();
    if (unterminatedLine) lines.pop();
    return {
      capturedBytes,
      lines: lines.filter((line) => line.trim().length > 0),
      stable: true,
      unterminatedLine,
    };
  } catch {
    return { capturedBytes, lines: [], stable: false, unterminatedLine: false };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function streamStableJsonLines(
  requestedPath: string,
  sessionsRoot: string,
  options: ResolvedReaderOptions,
  accept: (line: string) => boolean,
): Promise<StreamResult> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let capturedSize = 0n;
  let processedBytes = 0n;
  let skippedLines = 0;
  let partialReason: HistoryPartialReason | undefined;
  try {
    const before = await lstat(requestedPath, { bigint: true });
    const canonicalBeforeOpen = normalizeLocalAbsolutePath(await realpath(requestedPath));
    if (
      canonicalBeforeOpen === undefined ||
      !isRegularFile(before) ||
      !sameLocalPath(requestedPath, canonicalBeforeOpen) ||
      !isPathInside(sessionsRoot, canonicalBeforeOpen)
    ) {
      return failedStream("unstable-file", capturedSize, processedBytes);
    }
    handle = await open(requestedPath, "r");
    const handleBeforeRead = await handle.stat({ bigint: true });
    if (!isRegularFile(handleBeforeRead) || !sameFileIdentity(before, handleBeforeRead)) {
      return failedStream("unstable-file", capturedSize, processedBytes);
    }
    capturedSize = handleBeforeRead.size;

    let lineParts: Buffer[] = [];
    let lineBytes = 0;
    let skippingLine = false;
    const finishLine = (terminated: boolean) => {
      if (skippingLine) {
        skippedLines += 1;
        partialReason = preferHistoryPartialReason(partialReason, "overlong-line");
      } else if (lineBytes > 0) {
        const lineBuffer =
          lineParts.length === 1 ? lineParts[0]! : Buffer.concat(lineParts, lineBytes);
        const content =
          lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 13
            ? lineBuffer.subarray(0, lineBuffer.length - 1)
            : lineBuffer;
        if (!terminated) {
          skippedLines += 1;
          partialReason = preferHistoryPartialReason(partialReason, "unterminated-line");
        } else if (content.length > 0 && !accept(content.toString("utf8"))) {
          skippedLines += 1;
          partialReason = preferHistoryPartialReason(partialReason, "invalid-json");
        }
      }
      lineParts = [];
      lineBytes = 0;
      skippingLine = false;
    };
    const appendSegment = (segment: Buffer) => {
      if (segment.length === 0 || skippingLine) return;
      if (lineBytes + segment.length > options.maxJsonLineBytes) {
        lineParts = [];
        lineBytes = 0;
        skippingLine = true;
        return;
      }
      lineParts.push(segment);
      lineBytes += segment.length;
    };

    let position = 0n;
    while (position < capturedSize) {
      const remaining = capturedSize - position;
      const requestedBytes = Number(
        remaining > BigInt(options.readChunkBytes) ? BigInt(options.readChunkBytes) : remaining,
      );
      const buffer = Buffer.allocUnsafe(requestedBytes);
      let chunkBytesRead = 0;
      while (chunkBytesRead < requestedBytes) {
        const result = await handle.read(
          buffer,
          chunkBytesRead,
          requestedBytes - chunkBytesRead,
          position + BigInt(chunkBytesRead),
        );
        if (result.bytesRead <= 0 || result.bytesRead > requestedBytes - chunkBytesRead) {
          return failedStream("read-failed", capturedSize, processedBytes);
        }
        chunkBytesRead += result.bytesRead;
        processedBytes += BigInt(result.bytesRead);
      }

      let segmentStart = 0;
      for (let index = 0; index < chunkBytesRead; index += 1) {
        if (buffer[index] !== 10) continue;
        appendSegment(buffer.subarray(segmentStart, index));
        finishLine(true);
        segmentStart = index + 1;
      }
      appendSegment(buffer.subarray(segmentStart, chunkBytesRead));
      position += BigInt(chunkBytesRead);
    }
    if (lineBytes > 0 || skippingLine) finishLine(false);

    const afterRead = await lstat(requestedPath, { bigint: true });
    const handleAfterRead = await handle.stat({ bigint: true });
    const canonicalAfterRead = normalizeLocalAbsolutePath(await realpath(requestedPath));
    if (
      canonicalAfterRead === undefined ||
      !isRegularFile(afterRead) ||
      !isRegularFile(handleAfterRead) ||
      !sameFileSnapshot(handleBeforeRead, afterRead) ||
      !sameFileSnapshot(afterRead, handleAfterRead) ||
      !sameLocalPath(requestedPath, canonicalAfterRead) ||
      afterRead.size !== capturedSize
    ) {
      return failedStream("unstable-file", capturedSize, processedBytes);
    }
    return {
      diagnostic: {
        capturedBytes: capturedSize.toString(),
        processedBytes: processedBytes.toString(),
        ...(partialReason === undefined ? {} : { reason: partialReason }),
        skippedItems: 0,
        skippedLines,
        status: partialReason === undefined ? "complete" : "truncated",
      },
      stable: true,
    };
  } catch {
    return failedStream("read-failed", capturedSize, processedBytes);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function failedProjection(
  threadId: string,
  diagnostic: DesktopSessionConversationReadDiagnostic,
): ProjectionResult {
  return {
    diagnostic,
    items: [diagnosticConversationItem(threadId, diagnostic)],
  };
}

function failedStream(
  reason: "read-failed" | "unstable-file",
  capturedSize: bigint,
  processedBytes: bigint,
): StreamResult {
  return {
    diagnostic: {
      capturedBytes: capturedSize.toString(),
      processedBytes: processedBytes.toString(),
      reason,
      skippedItems: 0,
      skippedLines: 0,
      status: "failed",
    },
    stable: false,
  };
}

function diagnosticConversationItem(
  threadId: string,
  diagnostic: DesktopSessionConversationReadDiagnostic,
): ConversationItem {
  const summary =
    diagnostic.status === "failed"
      ? "本机历史记录读取失败；未把不完整快照伪装成完整对话。刷新后会重试。"
      : diagnostic.reason === "overlong-line" ||
          diagnostic.reason === "invalid-json" ||
          diagnostic.reason === "unterminated-line"
        ? `本机历史中有 ${diagnostic.skippedLines} 条记录未完整读取；仅展示已验证的完整记录。`
        : `本机历史达到投影上限，${diagnostic.skippedItems} 项未显示；已保留明确截断状态。`;
  return {
    id: `persisted-history-diagnostic-${threadId}`,
    kind: "tool",
    status: "failed",
    summary,
    title: "历史记录读取不完整",
  };
}

function preferHistoryPartialReason(
  current: HistoryPartialReason | undefined,
  candidate: HistoryPartialReason,
): HistoryPartialReason {
  const priority: Record<HistoryPartialReason, number> = {
    "invalid-json": 1,
    "overlong-line": 2,
    "unterminated-line": 3,
  };
  return current === undefined || priority[candidate] > priority[current] ? candidate : current;
}

function messageText(content: unknown, expectedType: "input_text" | "output_text"): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((candidate) => {
      const part = asRecord(candidate);
      const text = asString(part.text);
      return part.type === expectedType && text !== undefined ? [text] : [];
    })
    .join("\n");
}

function cloneConversationItem(item: ConversationItem): ConversationItem {
  return structuredClone(item);
}

async function canonicalDirectory(candidate: string): Promise<string | undefined> {
  try {
    const before = await lstat(candidate, { bigint: true });
    const canonical = normalizeLocalAbsolutePath(await realpath(candidate));
    const after = await lstat(candidate, { bigint: true });
    if (
      canonical === undefined ||
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      !sameFileIdentity(before, after)
    ) {
      return undefined;
    }
    return canonical;
  } catch {
    return undefined;
  }
}

function normalizeLocalAbsolutePath(candidate: string): string | undefined {
  if (candidate.length === 0 || candidate.includes("\0")) return undefined;
  if (process.platform === "win32") {
    let normalizedCandidate = candidate;
    if (normalizedCandidate.startsWith("\\\\?\\")) {
      if (!/^\\\\\?\\[a-z]:[\\/]/iu.test(normalizedCandidate)) return undefined;
      normalizedCandidate = normalizedCandidate.slice(4);
    }
    if (
      normalizedCandidate.startsWith("\\\\") ||
      normalizedCandidate.startsWith("//") ||
      !path.win32.isAbsolute(normalizedCandidate) ||
      !/^[a-z]:[\\/]/iu.test(normalizedCandidate)
    ) {
      return undefined;
    }
    return path.win32.normalize(normalizedCandidate);
  }
  if (candidate.startsWith("//") || !path.posix.isAbsolute(candidate)) return undefined;
  return path.posix.normalize(candidate);
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isRegularFile(metadata: BigIntStats): boolean {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.size >= 0n;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs
  );
}

function sameLocalPath(left: string, right: string): boolean {
  const normalizedLeft = normalizeLocalAbsolutePath(left);
  const normalizedRight = normalizeLocalAbsolutePath(right);
  if (normalizedLeft === undefined || normalizedRight === undefined) return false;
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function sameOptionalTurn(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isSafeInteger(value) || value <= 0 ? fallback : value;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  const normalized = asString(value);
  return normalized === undefined || normalized.length > maxLength ? undefined : normalized;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((candidate): candidate is string => typeof candidate === "string")
    : [];
}
