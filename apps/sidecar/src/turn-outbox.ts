import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  LocalInputReference,
  QueueTurnInput,
  QueuedTurnItem,
  QueuedTurnState,
  QueuedTurnSummary,
  QueueUpdatedEvent,
  TurnQueueSnapshot,
} from "@codex-local-remote/contracts";

import type { PromptProtector } from "./prompt-protector.js";

const OUTBOX_SCHEMA_VERSION = 3;
const PREVIOUS_OUTBOX_SCHEMA_VERSION = 2;
const LEGACY_OUTBOX_SCHEMA_VERSION = 1;
const MAX_RECEIPTS = 2_000;
const DEFAULT_CRYPTO_CONCURRENCY = 4;
const DEFAULT_OUTBOX_LIMITS: OutboxLimits = {
  maxItemsPerThread: 100,
  maxProtectedBytes: 16 * 1024 * 1024,
  maxTotalItems: 1_000,
};

type ThreadDispatchGate = "awaiting-terminal" | "paused" | "pending-inspection" | "ready";

export interface OutboxLimits {
  maxItemsPerThread: number;
  maxProtectedBytes: number;
  maxTotalItems: number;
}

interface PersistedTurn extends Omit<QueuedTurnSummary, "position"> {
  protectedAttachments?: string;
  protectedPrompt?: string;
  approvalPolicy?: string;
  serviceTier?: string;
  permissionProfileId?: string;
  approvalsReviewer?: string;
  collaborationMode?: string;
}

interface PersistedReceipt {
  itemId?: string;
  kind: "enqueue" | "edit" | "reorder" | "remove" | "resume" | "steer";
  threadId: string;
}

interface PersistedOutbox {
  items: PersistedTurn[];
  receipts: Record<string, PersistedReceipt>;
  receiptOrder: string[];
  revisions: Record<string, number>;
  threadGates: Record<string, ThreadDispatchGate>;
  schemaVersion: typeof OUTBOX_SCHEMA_VERSION;
}

export interface OutboxChange {
  event: QueueUpdatedEvent;
  threadId: string;
}

export interface DispatchClaim extends QueueTurnInput {
  id: string;
  threadId: string;
  clientUserMessageId: string;
  revision: number;
  prompt: string;
}

export interface OutboxOpenOptions {
  clock?: () => Date;
  cryptoConcurrency?: number;
  dataDir: string;
  idFactory?: () => string;
  limits?: Partial<OutboxLimits>;
  protector: PromptProtector;
}

export class OutboxConflictError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 409) {
    super(message);
    this.name = "OutboxConflictError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class DurableTurnOutbox {
  readonly #clock: () => Date;
  readonly #cryptoLimiter: AsyncLimiter;
  readonly #dataDir: string;
  readonly #idFactory: () => string;
  readonly #limits: OutboxLimits;
  readonly #listeners = new Set<(change: OutboxChange) => void>();
  readonly #path: string;
  readonly #protector: PromptProtector;
  #mutationChain: Promise<void> = Promise.resolve();
  #persistenceGeneration = 0;
  #state: PersistedOutbox;

  private constructor(options: OutboxOpenOptions, state: PersistedOutbox) {
    this.#clock = options.clock ?? (() => new Date());
    this.#cryptoLimiter = new AsyncLimiter(
      requirePositiveSafeInteger(
        options.cryptoConcurrency ?? DEFAULT_CRYPTO_CONCURRENCY,
        "cryptoConcurrency",
      ),
    );
    this.#dataDir = options.dataDir;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#limits = resolveLimits(options.limits);
    this.#path = path.join(options.dataDir, "turn-outbox.json");
    this.#protector = options.protector;
    this.#state = state;
  }

  static async open(options: OutboxOpenOptions): Promise<DurableTurnOutbox> {
    await mkdir(options.dataDir, { recursive: true });
    const limits = resolveLimits(options.limits);
    let state = emptyState();
    try {
      state = parseState(
        await readFile(path.join(options.dataDir, "turn-outbox.json"), "utf8"),
        limits,
      );
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new Error("远程消息队列无法读取");
      }
    }
    return new DurableTurnOutbox(options, state);
  }

  static async createTemporaryDirectoryForTests(prefix: string): Promise<string> {
    return await mkdtemp(prefix);
  }

  subscribe(listener: (change: OutboxChange) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async enqueue(options: {
    idempotencyScope: string;
    input: QueueTurnInput;
    threadId: string;
  }): Promise<QueuedTurnItem> {
    const threadId = requireThreadId(options.threadId);
    const prompt = requirePrompt(options.input.prompt);
    const protectedPrompt = await this.#protect(prompt);
    const protectedAttachments = await this.#protectAttachments(options.input.attachments);
    return await this.#mutate(async () => {
      const receipt = this.#receipt(options.idempotencyScope);
      if (receipt) {
        const existing = this.#state.items.find((item) => item.id === receipt.itemId);
        if (!existing) {
          throw new OutboxConflictError(
            "IDEMPOTENCY_RESULT_EXPIRED",
            "这次排队请求已经处理过，但结果已被删除",
          );
        }
        return await this.#projectItem(existing);
      }
      this.#requireCapacity(threadId, protectedPrompt, protectedAttachments);
      const now = this.#clock().toISOString();
      const revision = this.#nextRevision(threadId);
      const item: PersistedTurn = {
        clientUserMessageId: requireGeneratedId(this.#idFactory()),
        createdAt: now,
        id: requireGeneratedId(this.#idFactory()),
        ...(protectedAttachments === undefined ? {} : { protectedAttachments }),
        protectedPrompt,
        revision,
        state: "queued",
        threadId,
        updatedAt: now,
        ...queueSettings(options.input),
      };
      this.#state.items.push(item);
      this.#state.threadGates[threadId] ??= "pending-inspection";
      this.#rememberReceipt(options.idempotencyScope, {
        itemId: item.id,
        kind: "enqueue",
        threadId,
      });
      await this.#persist();
      this.#emit("enqueued", item);
      return await this.#projectItem(item);
    });
  }

  async snapshot(threadId: string): Promise<TurnQueueSnapshot> {
    const normalized = requireThreadId(threadId);
    await this.#mutationChain;
    const items = structuredClone(this.#itemsForThread(normalized));
    const revision = this.#state.revisions[normalized] ?? 0;
    return {
      items: await Promise.all(
        items.map(async (item, position) => await this.#projectCapturedItem(item, position)),
      ),
      revision,
      threadId: normalized,
    };
  }

  async edit(options: {
    expectedRevision: number;
    idempotencyScope: string;
    input: QueueTurnInput;
    queueId: string;
    threadId: string;
  }): Promise<QueuedTurnItem> {
    const threadId = requireThreadId(options.threadId);
    const prompt = requirePrompt(options.input.prompt);
    const protectedPrompt = await this.#protect(prompt);
    const protectedAttachments = await this.#protectAttachments(options.input.attachments);
    return await this.#mutate(async () => {
      const duplicate = this.#receipt(options.idempotencyScope);
      if (duplicate) {
        const existing = this.#requireItem(threadId, options.queueId);
        return await this.#projectItem(existing);
      }
      this.#requireRevision(threadId, options.expectedRevision);
      const current = this.#requireItem(threadId, options.queueId);
      requireEditable(current);
      this.#requireCapacity(threadId, protectedPrompt, protectedAttachments, current);
      const revision = this.#nextRevision(threadId);
      const replacement: PersistedTurn = {
        ...withoutQueueSettings(current),
        ...queueSettings(options.input),
        ...(protectedAttachments === undefined ? {} : { protectedAttachments }),
        protectedPrompt,
        revision,
        updatedAt: this.#clock().toISOString(),
      };
      this.#replaceItem(replacement);
      this.#rememberReceipt(options.idempotencyScope, {
        itemId: replacement.id,
        kind: "edit",
        threadId,
      });
      await this.#persist();
      this.#emit("updated", replacement);
      return await this.#projectItem(replacement);
    });
  }

  async reorder(options: {
    expectedRevision: number;
    idempotencyScope: string;
    queueIds: string[];
    threadId: string;
  }): Promise<TurnQueueSnapshot> {
    const threadId = requireThreadId(options.threadId);
    return await this.#mutate(async () => {
      if (this.#receipt(options.idempotencyScope)) {
        return await this.#projectSnapshot(threadId);
      }
      this.#requireRevision(threadId, options.expectedRevision);
      const current = this.#itemsForThread(threadId);
      const movable = current.filter((item) => item.state !== "started");
      if (
        options.queueIds.length !== movable.length ||
        new Set(options.queueIds).size !== movable.length ||
        options.queueIds.some((id) => !movable.some((item) => item.id === id))
      ) {
        throw new OutboxConflictError("QUEUE_ORDER_MISMATCH", "排队顺序已经变化，请刷新后重试");
      }
      const positions = this.#state.items
        .map((item, index) => ({ index, item }))
        .filter(({ item }) => item.threadId === threadId && item.state !== "started")
        .map(({ index }) => index);
      const byId = new Map(movable.map((item) => [item.id, item]));
      const revision = this.#nextRevision(threadId);
      for (const [offset, queueId] of options.queueIds.entries()) {
        const targetIndex = positions[offset];
        const item = byId.get(queueId);
        if (targetIndex === undefined || !item) {
          throw new OutboxConflictError("QUEUE_ORDER_MISMATCH", "排队顺序无效");
        }
        this.#state.items[targetIndex] = {
          ...item,
          revision,
          updatedAt: this.#clock().toISOString(),
        };
      }
      this.#rememberReceipt(options.idempotencyScope, {
        kind: "reorder",
        threadId,
      });
      await this.#persist();
      this.#emitThread("reordered", threadId, revision);
      return await this.#projectSnapshot(threadId);
    });
  }

  async remove(options: {
    expectedRevision: number;
    idempotencyScope: string;
    queueId: string;
    threadId: string;
  }): Promise<TurnQueueSnapshot> {
    const threadId = requireThreadId(options.threadId);
    return await this.#mutate(async () => {
      if (this.#receipt(options.idempotencyScope)) {
        return await this.#projectSnapshot(threadId);
      }
      this.#requireRevision(threadId, options.expectedRevision);
      const item = this.#requireItem(threadId, options.queueId);
      if (item.state === "dispatching" || item.state === "started") {
        throw new OutboxConflictError("QUEUE_ITEM_DISPATCHING", "这条消息已经开始发送，不能删除");
      }
      this.#state.items = this.#state.items.filter((candidate) => candidate.id !== item.id);
      if (!this.#state.items.some((candidate) => candidate.threadId === threadId)) {
        delete this.#state.threadGates[threadId];
      }
      const revision = this.#nextRevision(threadId);
      this.#rememberReceipt(options.idempotencyScope, {
        itemId: item.id,
        kind: "remove",
        threadId,
      });
      await this.#persist();
      this.#emitThread("removed", threadId, revision);
      return await this.#projectSnapshot(threadId);
    });
  }

  async resume(options: {
    expectedRevision: number;
    idempotencyScope: string;
    queueId: string;
    retryAmbiguous: boolean;
    threadId: string;
  }): Promise<QueuedTurnItem> {
    const threadId = requireThreadId(options.threadId);
    return await this.#mutate(async () => {
      if (this.#receipt(options.idempotencyScope)) {
        return await this.#projectItem(this.#requireItem(threadId, options.queueId));
      }
      this.#requireRevision(threadId, options.expectedRevision);
      const item = this.#requireItem(threadId, options.queueId);
      if (item.state === "ambiguous" && !options.retryAmbiguous) {
        throw new OutboxConflictError(
          "QUEUE_AMBIGUOUS_RETRY_CONFIRMATION_REQUIRED",
          "请先确认可能重复发送的风险",
        );
      }
      if (item.state !== "queued" && item.state !== "paused" && item.state !== "ambiguous") {
        throw new OutboxConflictError("QUEUE_ITEM_NOT_PAUSED", "这条消息当前不需要手动发送");
      }
      const replacement = withState(
        item,
        "queued",
        this.#nextRevision(threadId),
        this.#clock().toISOString(),
      );
      this.#replaceItem(replacement);
      this.#moveToFront(replacement);
      this.#state.threadGates[threadId] = "pending-inspection";
      this.#rememberReceipt(options.idempotencyScope, {
        itemId: item.id,
        kind: "resume",
        threadId,
      });
      await this.#persist();
      this.#emit("state-changed", replacement);
      return await this.#projectItem(replacement);
    });
  }

  async claimForSteer(options: {
    expectedRevision: number;
    idempotencyScope: string;
    queueId: string;
    threadId: string;
  }): Promise<DispatchClaim | "already-complete"> {
    const threadId = requireThreadId(options.threadId);
    return await this.#mutate(async () => {
      if (this.#receipt(options.idempotencyScope)) {
        return "already-complete";
      }
      this.#requireRevision(threadId, options.expectedRevision);
      const item = this.#requireItem(threadId, options.queueId);
      if (item.state === "ambiguous") {
        throw new OutboxConflictError(
          "QUEUE_AMBIGUOUS_STEER_BLOCKED",
          "这条消息的发送结果未知，不能直接改为引导",
        );
      }
      if (item.state !== "queued" && item.state !== "paused") {
        throw new OutboxConflictError("QUEUE_ITEM_NOT_STEERABLE", "这条消息当前不能改为引导");
      }
      if (!item.protectedPrompt) {
        throw new OutboxConflictError("QUEUE_ITEM_NOT_EDITABLE", "这条消息的内容当前不可用");
      }
      const replacement = withState(
        item,
        "dispatching",
        this.#nextRevision(threadId),
        this.#clock().toISOString(),
      );
      this.#replaceItem(replacement);
      this.#state.threadGates[threadId] = "awaiting-terminal";
      await this.#persist();
      this.#emit("state-changed", replacement);
      return {
        clientUserMessageId: replacement.clientUserMessageId,
        id: replacement.id,
        prompt: await this.#unprotect(item.protectedPrompt),
        ...(item.protectedAttachments === undefined
          ? {}
          : { attachments: await this.#unprotectAttachments(item.protectedAttachments) }),
        revision: replacement.revision,
        threadId: replacement.threadId,
        ...(replacement.approvalPolicy === undefined
          ? {}
          : { approvalPolicy: replacement.approvalPolicy }),
        ...(replacement.approvalsReviewer === undefined
          ? {}
          : { approvalsReviewer: replacement.approvalsReviewer }),
        ...(replacement.collaborationMode === undefined
          ? {}
          : { collaborationMode: replacement.collaborationMode }),
        ...(replacement.model === undefined ? {} : { model: replacement.model }),
        ...(replacement.permissionProfileId === undefined
          ? {}
          : { permissionProfileId: replacement.permissionProfileId }),
        ...(replacement.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: replacement.reasoningEffort }),
        ...(replacement.serviceTier === undefined ? {} : { serviceTier: replacement.serviceTier }),
      };
    });
  }

  async markSteered(options: {
    idempotencyScope: string;
    queueId: string;
    threadId: string;
  }): Promise<void> {
    const threadId = requireThreadId(options.threadId);
    await this.#mutate(async () => {
      if (this.#receipt(options.idempotencyScope)) {
        return;
      }
      const item = this.#requireItem(threadId, options.queueId);
      if (item.state !== "dispatching") {
        throw new OutboxConflictError("QUEUE_ITEM_NOT_STEERABLE", "这条消息当前不能改为引导");
      }
      this.#state.items = this.#state.items.filter((candidate) => candidate.id !== item.id);
      const hasRemaining = this.#state.items.some((candidate) => candidate.threadId === threadId);
      if (hasRemaining) {
        this.#state.threadGates[threadId] = "awaiting-terminal";
      } else {
        delete this.#state.threadGates[threadId];
      }
      const revision = this.#nextRevision(threadId);
      this.#rememberReceipt(options.idempotencyScope, {
        itemId: item.id,
        kind: "steer",
        threadId,
      });
      await this.#persist();
      this.#emitThread("removed", threadId, revision);
    });
  }

  async claimNext(threadId: string): Promise<DispatchClaim | undefined> {
    const normalized = requireThreadId(threadId);
    return await this.#mutate(async () => {
      const item = this.#itemsForThread(normalized).find(
        (candidate) => candidate.state === "queued",
      );
      if (!item?.protectedPrompt) {
        return undefined;
      }
      const replacement = withState(
        item,
        "dispatching",
        this.#nextRevision(normalized),
        this.#clock().toISOString(),
      );
      this.#replaceItem(replacement);
      this.#state.threadGates[normalized] = "awaiting-terminal";
      await this.#persist();
      this.#emit("state-changed", replacement);
      return {
        clientUserMessageId: replacement.clientUserMessageId,
        id: replacement.id,
        prompt: await this.#unprotect(item.protectedPrompt),
        ...(item.protectedAttachments === undefined
          ? {}
          : { attachments: await this.#unprotectAttachments(item.protectedAttachments) }),
        revision: replacement.revision,
        threadId: replacement.threadId,
        ...(replacement.approvalPolicy === undefined
          ? {}
          : { approvalPolicy: replacement.approvalPolicy }),
        ...(replacement.approvalsReviewer === undefined
          ? {}
          : { approvalsReviewer: replacement.approvalsReviewer }),
        ...(replacement.collaborationMode === undefined
          ? {}
          : { collaborationMode: replacement.collaborationMode }),
        ...(replacement.model === undefined ? {} : { model: replacement.model }),
        ...(replacement.permissionProfileId === undefined
          ? {}
          : { permissionProfileId: replacement.permissionProfileId }),
        ...(replacement.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: replacement.reasoningEffort }),
        ...(replacement.serviceTier === undefined ? {} : { serviceTier: replacement.serviceTier }),
      };
    });
  }

  async markStarted(queueId: string, turnId?: string): Promise<void> {
    await this.#mutate(async () => {
      const item = this.#state.items.find((candidate) => candidate.id === queueId);
      if (!item || item.state === "started") {
        return;
      }
      if (item.state !== "dispatching" && item.state !== "ambiguous") {
        return;
      }
      const replacement = withState(
        item,
        "started",
        this.#nextRevision(item.threadId),
        this.#clock().toISOString(),
        {
          clearPrompt: true,
          ...(turnId === undefined ? {} : { turnId }),
        },
      );
      this.#replaceItem(replacement);
      this.#state.threadGates[item.threadId] = "awaiting-terminal";
      await this.#persist();
      this.#emit("state-changed", replacement);
    });
  }

  async reconcileAcceptedTerminal(
    queueId: string,
    options: { issue?: string; status: "completed" | "failed"; turnId?: string },
  ): Promise<void> {
    await this.#mutate(async () => {
      const item = this.#state.items.find((candidate) => candidate.id === queueId);
      if (
        !item ||
        (item.state !== "dispatching" && item.state !== "ambiguous" && item.state !== "started")
      ) {
        return;
      }
      if (
        options.turnId !== undefined &&
        item.turnId !== undefined &&
        item.turnId !== options.turnId
      ) {
        return;
      }
      const revision = this.#nextRevision(item.threadId);
      const updatedAt = this.#clock().toISOString();
      this.#state.items = this.#state.items.filter((candidate) => candidate.id !== item.id);
      const remaining = this.#state.items.filter(
        (candidate) => candidate.threadId === item.threadId,
      );
      if (options.status === "failed") {
        const pendingIds = new Set(
          remaining
            .filter((candidate) => candidate.state === "queued")
            .map((candidate) => candidate.id),
        );
        this.#state.items = this.#state.items.map((candidate) =>
          pendingIds.has(candidate.id)
            ? withState(candidate, "paused", revision, updatedAt, {
                issue: options.issue ?? "PREVIOUS_TURN_DID_NOT_COMPLETE",
              })
            : candidate,
        );
        if (remaining.length > 0) {
          this.#state.threadGates[item.threadId] = "paused";
        } else {
          delete this.#state.threadGates[item.threadId];
        }
      } else if (remaining.length > 0) {
        this.#state.threadGates[item.threadId] = "ready";
      } else {
        delete this.#state.threadGates[item.threadId];
      }
      await this.#persist();
      this.#emitThread(remaining.length > 0 ? "state-changed" : "removed", item.threadId, revision);
    });
  }

  async markAmbiguous(queueId: string, issue = "SEND_RESULT_UNKNOWN"): Promise<void> {
    await this.#mutate(async () => {
      const item = this.#state.items.find((candidate) => candidate.id === queueId);
      if (!item || item.state !== "dispatching") {
        return;
      }
      const replacement = withState(
        item,
        "ambiguous",
        this.#nextRevision(item.threadId),
        this.#clock().toISOString(),
        { issue },
      );
      this.#replaceItem(replacement);
      this.#state.threadGates[item.threadId] = "paused";
      await this.#persist();
      this.#emit("state-changed", replacement);
    });
  }

  async confirmClientMessage(clientUserMessageId: string, turnId?: string): Promise<boolean> {
    let confirmed = false;
    await this.#mutate(async () => {
      const item = this.#state.items.find(
        (candidate) =>
          candidate.clientUserMessageId === clientUserMessageId &&
          (candidate.state === "dispatching" || candidate.state === "ambiguous"),
      );
      if (!item) {
        return;
      }
      const replacement = withState(
        item,
        "started",
        this.#nextRevision(item.threadId),
        this.#clock().toISOString(),
        { clearPrompt: true, ...(turnId === undefined ? {} : { turnId }) },
      );
      this.#replaceItem(replacement);
      this.#state.threadGates[item.threadId] = "awaiting-terminal";
      await this.#persist();
      this.#emit("state-changed", replacement);
      confirmed = true;
    });
    return confirmed;
  }

  async pauseThread(threadId: string, issue = "PREVIOUS_TURN_DID_NOT_COMPLETE"): Promise<void> {
    const normalized = requireThreadId(threadId);
    await this.#mutate(async () => {
      if (!this.#state.items.some((item) => item.threadId === normalized)) {
        return;
      }
      const pending = this.#state.items.filter(
        (item) => item.threadId === normalized && item.state === "queued",
      );
      const gateChanged = this.#state.threadGates[normalized] !== "paused";
      this.#state.threadGates[normalized] = "paused";
      if (pending.length === 0) {
        if (gateChanged) {
          await this.#persist();
        }
        return;
      }
      const revision = this.#nextRevision(normalized);
      const updatedAt = this.#clock().toISOString();
      const pendingIds = new Set(pending.map((item) => item.id));
      this.#state.items = this.#state.items.map((item) =>
        pendingIds.has(item.id) ? withState(item, "paused", revision, updatedAt, { issue }) : item,
      );
      await this.#persist();
      this.#emitThread("state-changed", normalized, revision);
    });
  }

  async observeThreadActive(threadId: string): Promise<void> {
    const normalized = requireThreadId(threadId);
    await this.#mutate(async () => {
      if ((this.#state.threadGates[normalized] ?? "pending-inspection") !== "pending-inspection") {
        return;
      }
      this.#state.threadGates[normalized] = "awaiting-terminal";
      await this.#persist();
    });
  }

  async authorizeIdleDispatch(threadId: string): Promise<"authorized" | "blocked" | "empty"> {
    const normalized = requireThreadId(threadId);
    let result: "authorized" | "blocked" | "empty" = "blocked";
    await this.#mutate(async () => {
      if (
        !this.#state.items.some((item) => item.threadId === normalized && item.state === "queued")
      ) {
        result = "empty";
        if (this.#state.threadGates[normalized] !== undefined) {
          delete this.#state.threadGates[normalized];
          await this.#persist();
        }
        return;
      }
      const gate = this.#state.threadGates[normalized] ?? "pending-inspection";
      if (gate !== "pending-inspection" && gate !== "ready") {
        return;
      }
      result = "authorized";
      if (gate !== "ready") {
        this.#state.threadGates[normalized] = "ready";
        await this.#persist();
      }
    });
    return result;
  }

  async returnClaimToQueue(queueId: string): Promise<void> {
    await this.#mutate(async () => {
      const item = this.#state.items.find((candidate) => candidate.id === queueId);
      if (!item || item.state !== "dispatching") {
        return;
      }
      const replacement = withState(
        item,
        "queued",
        this.#nextRevision(item.threadId),
        this.#clock().toISOString(),
      );
      this.#replaceItem(replacement);
      this.#moveToFront(replacement);
      this.#state.threadGates[item.threadId] = "awaiting-terminal";
      await this.#persist();
      this.#emit("state-changed", replacement);
    });
  }

  async pauseClaim(queueId: string, issue: string): Promise<void> {
    await this.#mutate(async () => {
      const item = this.#state.items.find((candidate) => candidate.id === queueId);
      if (!item || item.state !== "dispatching") {
        return;
      }
      const replacement = withState(
        item,
        "paused",
        this.#nextRevision(item.threadId),
        this.#clock().toISOString(),
        { issue },
      );
      this.#replaceItem(replacement);
      this.#state.threadGates[item.threadId] = "paused";
      await this.#persist();
      this.#emit("state-changed", replacement);
    });
  }

  async recordTerminal(
    threadId: string,
    options: { issue?: string; status: "completed" | "failed"; turnId?: string },
  ): Promise<void> {
    const normalized = requireThreadId(threadId);
    await this.#mutate(async () => {
      const threadItems = this.#state.items.filter((item) => item.threadId === normalized);
      if (threadItems.length === 0 && this.#state.threadGates[normalized] === undefined) {
        return;
      }
      const matchingStarted = this.#state.items.filter(
        (item) =>
          item.threadId === normalized &&
          item.state === "started" &&
          (options.turnId === undefined || item.turnId === options.turnId),
      );
      const pending = this.#state.items.filter(
        (item) => item.threadId === normalized && item.state === "queued",
      );
      const nextGate: ThreadDispatchGate = options.status === "completed" ? "ready" : "paused";
      const gateChanged = this.#state.threadGates[normalized] !== nextGate;
      this.#state.threadGates[normalized] = nextGate;
      if (
        matchingStarted.length === 0 &&
        (options.status === "completed" || pending.length === 0)
      ) {
        if (gateChanged) {
          await this.#persist();
        }
        return;
      }
      const revision = this.#nextRevision(normalized);
      const updatedAt = this.#clock().toISOString();
      const removedIds = new Set(matchingStarted.map((item) => item.id));
      const pendingIds = new Set(pending.map((item) => item.id));
      this.#state.items = this.#state.items
        .filter((item) => !removedIds.has(item.id))
        .map((item) =>
          options.status === "failed" && pendingIds.has(item.id)
            ? withState(item, "paused", revision, updatedAt, {
                issue: options.issue ?? "PREVIOUS_TURN_DID_NOT_COMPLETE",
              })
            : item,
        );
      if (!this.#state.items.some((item) => item.threadId === normalized)) {
        delete this.#state.threadGates[normalized];
      }
      await this.#persist();
      this.#emitThread(
        matchingStarted.length > 0 && pending.length === 0 ? "removed" : "state-changed",
        normalized,
        revision,
      );
    });
  }

  async reconcilePendingAfterRestart(): Promise<string[]> {
    const safeThreadIds: string[] = [];
    await this.#mutate(async () => {
      const changedRevisions: Array<{ revision: number; threadId: string }> = [];
      const queuedThreadIds = [
        ...new Set(
          this.#state.items.filter((item) => item.state === "queued").map((item) => item.threadId),
        ),
      ];
      let changed = false;
      for (const threadId of queuedThreadIds) {
        const gate = this.#state.threadGates[threadId] ?? "pending-inspection";
        if (gate === "ready") {
          safeThreadIds.push(threadId);
          continue;
        }
        const pending = this.#state.items.filter(
          (item) => item.threadId === threadId && item.state === "queued",
        );
        if (pending.length === 0) {
          continue;
        }
        const revision = this.#nextRevision(threadId);
        const updatedAt = this.#clock().toISOString();
        const pendingIds = new Set(pending.map((item) => item.id));
        this.#state.items = this.#state.items.map((item) =>
          pendingIds.has(item.id)
            ? withState(item, "paused", revision, updatedAt, {
                issue: "PREVIOUS_TURN_RESULT_UNKNOWN_AFTER_RESTART",
              })
            : item,
        );
        this.#state.threadGates[threadId] = "paused";
        changedRevisions.push({ revision, threadId });
        changed = true;
      }
      if (changed) {
        await this.#persist();
        for (const { revision, threadId } of changedRevisions) {
          this.#emitThread("state-changed", threadId, revision);
        }
      }
    });
    return safeThreadIds;
  }

  async dispatchingItems(): Promise<QueuedTurnSummary[]> {
    await this.#mutationChain;
    return this.#state.items
      .filter((item) => item.state === "dispatching")
      .map((item) => this.#summary(item));
  }

  async reconcilableItems(): Promise<QueuedTurnSummary[]> {
    await this.#mutationChain;
    return this.#state.items
      .filter((item) => item.state === "dispatching" || item.state === "started")
      .map((item) => this.#summary(item));
  }

  async pendingThreadIds(): Promise<string[]> {
    await this.#mutationChain;
    return [
      ...new Set(
        this.#state.items
          .filter(
            (item) =>
              item.state === "queued" ||
              item.state === "dispatching" ||
              item.state === "ambiguous" ||
              item.state === "started",
          )
          .map((item) => item.threadId),
      ),
    ];
  }

  async #projectSnapshot(threadId: string): Promise<TurnQueueSnapshot> {
    const items = structuredClone(this.#itemsForThread(threadId));
    const revision = this.#state.revisions[threadId] ?? 0;
    return {
      items: await Promise.all(
        items.map(async (item, position) => await this.#projectCapturedItem(item, position)),
      ),
      revision,
      threadId,
    };
  }

  async #projectItem(item: PersistedTurn): Promise<QueuedTurnItem> {
    const captured = structuredClone(item);
    const position = this.#itemsForThread(item.threadId).findIndex(
      (candidate) => candidate.id === item.id,
    );
    return await this.#projectCapturedItem(captured, Math.max(0, position));
  }

  async #projectCapturedItem(item: PersistedTurn, position: number): Promise<QueuedTurnItem> {
    return {
      ...summaryForPosition(item, position),
      ...(item.protectedPrompt === undefined
        ? {}
        : { prompt: await this.#unprotect(item.protectedPrompt) }),
      ...(item.protectedAttachments === undefined
        ? {}
        : { attachments: await this.#unprotectAttachments(item.protectedAttachments) }),
    };
  }

  #summary(item: PersistedTurn): QueuedTurnSummary {
    const items = this.#itemsForThread(item.threadId);
    return summaryForPosition(
      item,
      Math.max(
        0,
        items.findIndex((candidate) => candidate.id === item.id),
      ),
    );
  }

  #itemsForThread(threadId: string): PersistedTurn[] {
    return this.#state.items.filter((item) => item.threadId === threadId);
  }

  #requireItem(threadId: string, queueId: string): PersistedTurn {
    const item = this.#state.items.find(
      (candidate) => candidate.id === queueId && candidate.threadId === threadId,
    );
    if (!item) {
      throw new OutboxConflictError("QUEUE_ITEM_NOT_FOUND", "找不到这条排队消息");
    }
    return item;
  }

  #replaceItem(replacement: PersistedTurn): void {
    this.#state.items = this.#state.items.map((item) =>
      item.id === replacement.id ? replacement : item,
    );
  }

  #moveToFront(item: PersistedTurn): void {
    const threadPositions = this.#state.items
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => candidate.threadId === item.threadId)
      .map(({ index }) => index);
    const currentIndex = this.#state.items.findIndex((candidate) => candidate.id === item.id);
    const firstIndex = threadPositions[0];
    if (currentIndex < 0 || firstIndex === undefined || currentIndex === firstIndex) {
      return;
    }
    this.#state.items.splice(currentIndex, 1);
    this.#state.items.splice(firstIndex, 0, item);
  }

  #requireCapacity(
    threadId: string,
    protectedPrompt: string,
    protectedAttachments: string | undefined,
    replacing?: PersistedTurn,
  ): void {
    const itemDelta = replacing === undefined ? 1 : 0;
    const threadItems = this.#state.items.filter((item) => item.threadId === threadId).length;
    if (threadItems + itemDelta > this.#limits.maxItemsPerThread) {
      throw new OutboxConflictError(
        "QUEUE_THREAD_CAPACITY_EXCEEDED",
        "这个对话的排队消息已达到上限",
        413,
      );
    }
    if (this.#state.items.length + itemDelta > this.#limits.maxTotalItems) {
      throw new OutboxConflictError(
        "QUEUE_TOTAL_CAPACITY_EXCEEDED",
        "远程消息队列已达到总容量上限",
        413,
      );
    }
    const currentProtectedBytes = this.#state.items.reduce(
      (total, item) =>
        total +
        protectedByteLength(item.protectedPrompt) +
        protectedByteLength(item.protectedAttachments),
      0,
    );
    const replacedBytes =
      protectedByteLength(replacing?.protectedPrompt) +
      protectedByteLength(replacing?.protectedAttachments);
    if (
      currentProtectedBytes -
        replacedBytes +
        protectedByteLength(protectedPrompt) +
        protectedByteLength(protectedAttachments) >
      this.#limits.maxProtectedBytes
    ) {
      throw new OutboxConflictError(
        "QUEUE_PROTECTED_CAPACITY_EXCEEDED",
        "远程消息队列的加密正文已达到容量上限",
        413,
      );
    }
  }

  async #protect(plaintext: string): Promise<string> {
    return await this.#cryptoLimiter.run(async () => await this.#protector.protect(plaintext));
  }

  async #unprotect(protectedValue: string): Promise<string> {
    return await this.#cryptoLimiter.run(
      async () => await this.#protector.unprotect(protectedValue),
    );
  }

  async #protectAttachments(
    attachments: readonly LocalInputReference[] | undefined,
  ): Promise<string | undefined> {
    const normalized = requireAttachments(attachments);
    return normalized.length === 0 ? undefined : await this.#protect(JSON.stringify(normalized));
  }

  async #unprotectAttachments(protectedValue: string): Promise<LocalInputReference[]> {
    return requireAttachments(JSON.parse(await this.#unprotect(protectedValue)));
  }

  #requireRevision(threadId: string, expected: number): void {
    if (!Number.isSafeInteger(expected) || expected < 0) {
      throw new OutboxConflictError("QUEUE_REVISION_INVALID", "排队版本无效");
    }
    if ((this.#state.revisions[threadId] ?? 0) !== expected) {
      throw new OutboxConflictError("QUEUE_REVISION_CONFLICT", "排队内容已经变化，请刷新后重试");
    }
  }

  #nextRevision(threadId: string): number {
    const next = (this.#state.revisions[threadId] ?? 0) + 1;
    this.#state.revisions[threadId] = next;
    return next;
  }

  #receipt(scope: string): PersistedReceipt | undefined {
    return this.#state.receipts[digestScope(scope)];
  }

  #rememberReceipt(scope: string, receipt: PersistedReceipt): void {
    const digest = digestScope(scope);
    if (!this.#state.receipts[digest]) {
      this.#state.receiptOrder.push(digest);
    }
    this.#state.receipts[digest] = receipt;
    while (this.#state.receiptOrder.length > MAX_RECEIPTS) {
      const oldest = this.#state.receiptOrder.shift();
      if (oldest) {
        delete this.#state.receipts[oldest];
      }
    }
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    let resolveResult: (value: T | PromiseLike<T>) => void = () => undefined;
    let rejectResult: (reason?: unknown) => void = () => undefined;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.#mutationChain = this.#mutationChain
      .catch(() => undefined)
      .then(async () => {
        const previousState = structuredClone(this.#state);
        const previousPersistenceGeneration = this.#persistenceGeneration;
        try {
          resolveResult(await operation());
        } catch (error) {
          if (this.#persistenceGeneration === previousPersistenceGeneration) {
            this.#state = previousState;
          }
          rejectResult(error);
        }
      });
    await this.#mutationChain;
    return await result;
  }

  async #persist(): Promise<void> {
    const temporaryPath = path.join(
      this.#dataDir,
      `.turn-outbox-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
    );
    await writeFile(temporaryPath, JSON.stringify(this.#state, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.#path);
    this.#persistenceGeneration += 1;
  }

  #emit(action: QueueUpdatedEvent["action"], item: PersistedTurn): void {
    this.#publish({
      event: {
        action,
        item: this.#summary(item),
        revision: this.#state.revisions[item.threadId] ?? item.revision,
      },
      threadId: item.threadId,
    });
  }

  #emitThread(action: QueueUpdatedEvent["action"], threadId: string, revision: number): void {
    this.#publish({ event: { action, revision }, threadId });
  }

  #publish(change: OutboxChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch {
        // Queue persistence must not depend on an SSE consumer.
      }
    }
  }
}

function emptyState(): PersistedOutbox {
  return {
    items: [],
    receiptOrder: [],
    receipts: {},
    revisions: {},
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    threadGates: {},
  };
}

function parseState(serialized: string, limits: OutboxLimits): PersistedOutbox {
  const value: unknown = JSON.parse(serialized);
  if (
    !isRecord(value) ||
    (value.schemaVersion !== OUTBOX_SCHEMA_VERSION &&
      value.schemaVersion !== PREVIOUS_OUTBOX_SCHEMA_VERSION &&
      value.schemaVersion !== LEGACY_OUTBOX_SCHEMA_VERSION)
  ) {
    throw new Error("unsupported outbox state");
  }
  if (!Array.isArray(value.items) || !isRecord(value.receipts) || !isRecord(value.revisions)) {
    throw new Error("invalid outbox state");
  }
  const items = value.items.map(parsePersistedTurn);
  const ids = new Set<string>();
  const clientIds = new Set<string>();
  const itemCountByThread = new Map<string, number>();
  let protectedBytes = 0;
  for (const item of items) {
    if (ids.has(item.id) || clientIds.has(item.clientUserMessageId)) {
      throw new Error("duplicate outbox item identity");
    }
    ids.add(item.id);
    clientIds.add(item.clientUserMessageId);
    const nextThreadCount = (itemCountByThread.get(item.threadId) ?? 0) + 1;
    if (nextThreadCount > limits.maxItemsPerThread) {
      throw new Error("outbox thread capacity exceeded");
    }
    itemCountByThread.set(item.threadId, nextThreadCount);
    protectedBytes +=
      protectedByteLength(item.protectedPrompt) + protectedByteLength(item.protectedAttachments);
  }
  if (items.length > limits.maxTotalItems || protectedBytes > limits.maxProtectedBytes) {
    throw new Error("outbox capacity exceeded");
  }

  const receipts: Record<string, PersistedReceipt> = {};
  for (const [digest, candidate] of Object.entries(value.receipts)) {
    if (!isBoundedString(digest, 256) || !isPersistedReceipt(candidate)) {
      throw new Error("invalid outbox receipt");
    }
    receipts[digest] = candidate;
  }
  if (
    !Array.isArray(value.receiptOrder) ||
    value.receiptOrder.length > MAX_RECEIPTS ||
    value.receiptOrder.some(
      (digest) => typeof digest !== "string" || receipts[digest] === undefined,
    )
  ) {
    throw new Error("invalid outbox receipt order");
  }
  const receiptOrder = value.receiptOrder as string[];
  if (
    new Set(receiptOrder).size !== receiptOrder.length ||
    Object.keys(receipts).some((digest) => !receiptOrder.includes(digest))
  ) {
    throw new Error("inconsistent outbox receipts");
  }

  const revisions: Record<string, number> = {};
  for (const [threadId, revision] of Object.entries(value.revisions)) {
    if (!isThreadId(threadId) || !Number.isSafeInteger(revision) || (revision as number) < 0) {
      throw new Error("invalid outbox revision");
    }
    revisions[threadId] = revision as number;
  }
  for (const item of items) {
    if ((revisions[item.threadId] ?? -1) < item.revision) {
      throw new Error("outbox item revision exceeds thread revision");
    }
  }

  const threadGates: Record<string, ThreadDispatchGate> = {};
  if (
    value.schemaVersion === OUTBOX_SCHEMA_VERSION ||
    value.schemaVersion === PREVIOUS_OUTBOX_SCHEMA_VERSION
  ) {
    if (!isRecord(value.threadGates)) {
      throw new Error("invalid outbox thread gates");
    }
    for (const [threadId, gate] of Object.entries(value.threadGates)) {
      if (!isThreadId(threadId) || !isThreadDispatchGate(gate)) {
        throw new Error("invalid outbox thread gate");
      }
      threadGates[threadId] = gate;
    }
  } else {
    for (const item of items) {
      threadGates[item.threadId] ??= "pending-inspection";
    }
  }
  for (const item of items) {
    if (threadGates[item.threadId] === undefined) {
      throw new Error("missing outbox thread gate");
    }
  }
  return {
    items,
    receiptOrder,
    receipts,
    revisions,
    schemaVersion: OUTBOX_SCHEMA_VERSION,
    threadGates,
  };
}

function parsePersistedTurn(value: unknown): PersistedTurn {
  if (
    !isRecord(value) ||
    !isBoundedString(value.id, 512) ||
    !isThreadId(value.threadId) ||
    !isBoundedString(value.clientUserMessageId, 512) ||
    !isQueuedTurnState(value.state) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    !isIsoTimestamp(value.createdAt) ||
    !isIsoTimestamp(value.updatedAt)
  ) {
    throw new Error("invalid outbox item");
  }
  const state = value.state;
  const hasProtectedPrompt = isBoundedString(value.protectedPrompt, 32 * 1024 * 1024);
  const hasProtectedAttachments = isBoundedString(value.protectedAttachments, 32 * 1024 * 1024);
  if (
    (state === "started" && value.protectedPrompt !== undefined) ||
    (state !== "started" && !hasProtectedPrompt)
  ) {
    throw new Error("invalid protected outbox prompt");
  }
  if (
    (state === "started" && value.protectedAttachments !== undefined) ||
    (state !== "started" && value.protectedAttachments !== undefined && !hasProtectedAttachments)
  ) {
    throw new Error("invalid protected outbox attachments");
  }
  if (
    ((state === "ambiguous" || state === "paused") && !isBoundedString(value.issue, 512)) ||
    (state !== "ambiguous" && state !== "paused" && value.issue !== undefined)
  ) {
    throw new Error("invalid outbox issue");
  }
  if (
    (state === "started" && value.turnId !== undefined && !isBoundedString(value.turnId, 512)) ||
    (state !== "started" && value.turnId !== undefined)
  ) {
    throw new Error("invalid outbox turn identity");
  }
  for (const setting of [
    value.model,
    value.reasoningEffort,
    value.serviceTier,
    value.permissionProfileId,
    value.approvalPolicy,
    value.approvalsReviewer,
    value.collaborationMode,
  ]) {
    if (setting !== undefined && !isBoundedString(setting, 512)) {
      throw new Error("invalid outbox setting");
    }
  }
  return value as unknown as PersistedTurn;
}

function withState(
  item: PersistedTurn,
  state: QueuedTurnState,
  revision: number,
  updatedAt: string,
  options: { clearPrompt?: boolean; issue?: string; turnId?: string } = {},
): PersistedTurn {
  const {
    issue: _issue,
    protectedAttachments: _protectedAttachments,
    protectedPrompt: _protectedPrompt,
    turnId: _turnId,
    ...base
  } = item;
  return {
    ...base,
    state,
    revision,
    updatedAt,
    ...(options.clearPrompt
      ? {}
      : item.protectedPrompt === undefined
        ? {}
        : { protectedPrompt: item.protectedPrompt }),
    ...(options.clearPrompt || item.protectedAttachments === undefined
      ? {}
      : { protectedAttachments: item.protectedAttachments }),
    ...(options.issue === undefined ? {} : { issue: options.issue }),
    ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
  };
}

function withoutQueueSettings(item: PersistedTurn): PersistedTurn {
  const {
    approvalPolicy: _approvalPolicy,
    approvalsReviewer: _approvalsReviewer,
    collaborationMode: _collaborationMode,
    model: _model,
    permissionProfileId: _permissionProfileId,
    protectedAttachments: _protectedAttachments,
    reasoningEffort: _reasoningEffort,
    serviceTier: _serviceTier,
    ...base
  } = item;
  return base;
}

function queueSettings(input: QueueTurnInput): Partial<PersistedTurn> {
  return {
    ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    ...(input.serviceTier === undefined ? {} : { serviceTier: input.serviceTier }),
    ...(input.permissionProfileId === undefined
      ? {}
      : { permissionProfileId: input.permissionProfileId }),
    ...(input.approvalsReviewer === undefined
      ? {}
      : { approvalsReviewer: input.approvalsReviewer }),
    ...(input.collaborationMode === undefined
      ? {}
      : { collaborationMode: input.collaborationMode }),
  };
}

function requireEditable(item: PersistedTurn): void {
  if (item.state === "dispatching" || item.state === "started") {
    throw new OutboxConflictError("QUEUE_ITEM_NOT_EDITABLE", "这条消息已经开始发送，不能再编辑");
  }
}

function requireAttachments(value: unknown): LocalInputReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new OutboxConflictError(
      "QUEUE_ATTACHMENTS_INVALID",
      "一次最多添加 20 个文件或文件夹",
      400,
    );
  }
  const result: LocalInputReference[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const projectId =
      isRecord(candidate) && isBoundedString(candidate.projectId, 512)
        ? candidate.projectId
        : undefined;
    const uploadId =
      isRecord(candidate) && isBoundedString(candidate.uploadId, 512)
        ? candidate.uploadId
        : undefined;
    const projectReference = projectId !== undefined && uploadId === undefined;
    const uploadReference = uploadId !== undefined && projectId === undefined;
    if (
      !isRecord(candidate) ||
      (!projectReference && !uploadReference) ||
      !isBoundedString(candidate.relativePath, 32_768) ||
      (candidate.kind !== "file" && candidate.kind !== "directory") ||
      (uploadReference && candidate.kind !== "file") ||
      candidate.relativePath.includes("\0")
    ) {
      throw new OutboxConflictError("QUEUE_ATTACHMENTS_INVALID", "附件路径无效", 400);
    }
    const key = `${projectId ?? uploadId}:${candidate.kind}:${candidate.relativePath.toLocaleLowerCase("en-US")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      kind: candidate.kind,
      relativePath: candidate.relativePath,
      ...(projectId === undefined ? {} : { projectId }),
      ...(uploadId === undefined ? {} : { uploadId }),
    });
  }
  return result;
}

function requirePrompt(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1_000_000) {
    throw new OutboxConflictError("QUEUE_PROMPT_INVALID", "请输入要发送的消息", 400);
  }
  return value;
}

function requireThreadId(value: string): string {
  if (!isThreadId(value)) {
    throw new OutboxConflictError("QUEUE_THREAD_INVALID", "对话标识无效", 400);
  }
  return value;
}

function requireGeneratedId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new Error("Queue id factory returned an invalid id");
  }
  return normalized;
}

function digestScope(value: string): string {
  if (!value || value.length > 4_096) {
    throw new OutboxConflictError("IDEMPOTENCY_KEY_INVALID", "请求标识无效", 400);
  }
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function summaryForPosition(item: PersistedTurn, position: number): QueuedTurnSummary {
  return {
    clientUserMessageId: item.clientUserMessageId,
    createdAt: item.createdAt,
    id: item.id,
    position,
    revision: item.revision,
    state: item.state,
    threadId: item.threadId,
    updatedAt: item.updatedAt,
    ...(item.approvalPolicy === undefined ? {} : { approvalPolicy: item.approvalPolicy }),
    ...(item.approvalsReviewer === undefined ? {} : { approvalsReviewer: item.approvalsReviewer }),
    ...(item.collaborationMode === undefined ? {} : { collaborationMode: item.collaborationMode }),
    ...(item.model === undefined ? {} : { model: item.model }),
    ...(item.permissionProfileId === undefined
      ? {}
      : { permissionProfileId: item.permissionProfileId }),
    ...(item.reasoningEffort === undefined ? {} : { reasoningEffort: item.reasoningEffort }),
    ...(item.serviceTier === undefined ? {} : { serviceTier: item.serviceTier }),
    ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
    ...(item.issue === undefined ? {} : { issue: item.issue }),
  };
}

function resolveLimits(overrides: Partial<OutboxLimits> | undefined): OutboxLimits {
  return {
    maxItemsPerThread: requirePositiveSafeInteger(
      overrides?.maxItemsPerThread ?? DEFAULT_OUTBOX_LIMITS.maxItemsPerThread,
      "maxItemsPerThread",
    ),
    maxProtectedBytes: requirePositiveSafeInteger(
      overrides?.maxProtectedBytes ?? DEFAULT_OUTBOX_LIMITS.maxProtectedBytes,
      "maxProtectedBytes",
    ),
    maxTotalItems: requirePositiveSafeInteger(
      overrides?.maxTotalItems ?? DEFAULT_OUTBOX_LIMITS.maxTotalItems,
      "maxTotalItems",
    ),
  };
}

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function protectedByteLength(value: string | undefined): number {
  return value === undefined ? 0 : Buffer.byteLength(value, "utf8");
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= maxLength
  );
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isPersistedReceipt(value: unknown): value is PersistedReceipt {
  return (
    isRecord(value) &&
    (value.kind === "enqueue" ||
      value.kind === "edit" ||
      value.kind === "reorder" ||
      value.kind === "remove" ||
      value.kind === "resume" ||
      value.kind === "steer") &&
    isThreadId(value.threadId) &&
    (value.itemId === undefined || isBoundedString(value.itemId, 512))
  );
}

function isThreadDispatchGate(value: unknown): value is ThreadDispatchGate {
  return (
    value === "awaiting-terminal" ||
    value === "paused" ||
    value === "pending-inspection" ||
    value === "ready"
  );
}

function isQueuedTurnState(value: unknown): value is QueuedTurnState {
  return (
    value === "queued" ||
    value === "dispatching" ||
    value === "started" ||
    value === "ambiguous" ||
    value === "paused"
  );
}

function isThreadId(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 512
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

class AsyncLimiter {
  readonly #concurrency: number;
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(concurrency: number) {
    this.#concurrency = concurrency;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#concurrency) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#active += 1;
    try {
      return await operation();
    } finally {
      this.#active -= 1;
      this.#waiting.shift()?.();
    }
  }
}
