import type {
  SendTurnInput,
  SteerQueuedTurnInput,
  SteerTurnInput,
} from "@codex-local-remote/contracts";
import { RpcRequestError } from "@codex-local-remote/app-server-client";
import { DomainError } from "@codex-local-remote/domain";

import type { DurableTurnOutbox } from "./turn-outbox.js";

export interface TurnQueueGateway {
  inspectThread(threadId: string): Promise<{
    state: "active" | "idle" | "unknown";
  }>;
  reconcileClientUserMessage(
    threadId: string,
    clientUserMessageId: string,
  ): Promise<
    { state: "accepted"; turnId?: string } | { state: "active" | "absent-idle" | "unknown" }
  >;
  startTurn(
    threadId: string,
    input: SendTurnInput & { clientUserMessageId: string },
  ): Promise<{ turnId: string }>;
  steerTurn(threadId: string, turnId: string, input: SteerTurnInput): Promise<void>;
}

export interface AppServerNotificationLike {
  method: string;
  params?: unknown;
}

type WakeResult = "ambiguous" | "dispatched" | "empty" | "not-idle";

export class TurnQueueDispatcher {
  readonly #completedThreads = new Set<string>();
  readonly #gateway: TurnQueueGateway;
  readonly #outbox: DurableTurnOutbox;
  readonly #threadOperations = new Map<string, Promise<void>>();

  constructor(options: { gateway: TurnQueueGateway; outbox: DurableTurnOutbox }) {
    this.#gateway = options.gateway;
    this.#outbox = options.outbox;
  }

  async wake(threadId: string): Promise<void> {
    await this.#wakeWithResult(threadId);
  }

  async steerQueued(
    threadId: string,
    queueId: string,
    input: SteerQueuedTurnInput,
    idempotencyScope: string,
  ): Promise<void> {
    const current = this.#threadOperations.get(threadId) ?? Promise.resolve();
    const result = current.then(async () => {
      const claim = await this.#outbox.claimForSteer({
        expectedRevision: input.expectedRevision,
        idempotencyScope,
        queueId,
        threadId,
      });
      if (claim === "already-complete") {
        return;
      }
      try {
        await this.#gateway.steerTurn(threadId, input.turnId, {
          prompt: claim.prompt,
          ...(claim.attachments === undefined ? {} : { attachments: claim.attachments }),
        });
        await this.#outbox.markSteered({ idempotencyScope, queueId: claim.id, threadId });
      } catch (error) {
        if (isDeterministicBusy(error)) {
          await this.#outbox.returnClaimToQueue(claim.id);
        } else if (isDeterministicRejection(error)) {
          await this.#outbox.pauseClaim(claim.id, `TURN_STEER_REJECTED:${errorCode(error)}`);
        } else {
          await this.#outbox.markAmbiguous(claim.id, "STEER_RESULT_UNKNOWN");
        }
        throw error;
      }
    });
    const operation = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.#threadOperations.get(threadId) === operation) {
          this.#threadOperations.delete(threadId);
        }
      });
    this.#threadOperations.set(threadId, operation);
    await result;
  }

  #wakeWithResult(threadId: string): Promise<WakeResult> {
    const current = this.#threadOperations.get(threadId) ?? Promise.resolve();
    const result = current.then(async (): Promise<WakeResult> => {
      const inspection = await this.#gateway.inspectThread(threadId);
      if (inspection.state === "active") {
        await this.#outbox.observeThreadActive(threadId);
        return "not-idle";
      }
      if (inspection.state !== "idle") {
        return "not-idle";
      }
      const authorization = await this.#outbox.authorizeIdleDispatch(threadId);
      if (authorization === "empty") {
        return "empty";
      }
      if (authorization !== "authorized") {
        return "not-idle";
      }
      const claim = await this.#outbox.claimNext(threadId);
      if (!claim) {
        return "empty";
      }
      try {
        const result = await this.#gateway.startTurn(threadId, {
          clientUserMessageId: claim.clientUserMessageId,
          prompt: claim.prompt,
          ...(claim.attachments === undefined ? {} : { attachments: claim.attachments }),
          ...(claim.approvalPolicy === undefined ? {} : { approvalPolicy: claim.approvalPolicy }),
          ...(claim.approvalsReviewer === undefined
            ? {}
            : { approvalsReviewer: claim.approvalsReviewer }),
          ...(claim.collaborationMode === undefined
            ? {}
            : { collaborationMode: claim.collaborationMode }),
          ...(claim.model === undefined ? {} : { model: claim.model }),
          ...(claim.permissionProfileId === undefined
            ? {}
            : { permissionProfileId: claim.permissionProfileId }),
          ...(claim.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: claim.reasoningEffort }),
          ...(claim.serviceTier === undefined ? {} : { serviceTier: claim.serviceTier }),
        });
        await this.#outbox.markStarted(claim.id, result.turnId);
        return "dispatched";
      } catch (error) {
        if (isDeterministicBusy(error)) {
          await this.#outbox.returnClaimToQueue(claim.id);
          return "not-idle";
        }
        if (isDeterministicRejection(error)) {
          await this.#outbox.pauseClaim(claim.id, `TURN_START_REJECTED:${errorCode(error)}`);
          return "empty";
        }
        // A transport error may occur after turn/start was accepted. Preserve
        // the encrypted prompt, fail closed, and require an explicit retry.
        await this.#outbox.markAmbiguous(claim.id);
        return "ambiguous";
      }
    });
    const operation = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.#threadOperations.get(threadId) === operation) {
          this.#threadOperations.delete(threadId);
        }
      });
    this.#threadOperations.set(threadId, operation);
    return result;
  }

  async handleNotification(notification: AppServerNotificationLike): Promise<void> {
    const params = asRecord(notification.params);
    const threadId = asString(params.threadId) ?? asString(asRecord(params.thread).id);
    if (!threadId) {
      return;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      const item = asRecord(params.item);
      if (item.type === "userMessage") {
        const clientId = asString(item.clientId);
        if (clientId) {
          await this.#outbox.confirmClientMessage(clientId, asString(params.turnId));
        }
      }
      return;
    }
    if (notification.method === "turn/completed") {
      const status = asString(asRecord(params.turn).status);
      const turnId = asString(asRecord(params.turn).id);
      if (status === "completed") {
        await this.#outbox.recordTerminal(threadId, {
          status: "completed",
          ...(turnId === undefined ? {} : { turnId }),
        });
        this.#completedThreads.add(threadId);
        const result = await this.#wakeWithResult(threadId);
        if (result !== "not-idle") {
          this.#completedThreads.delete(threadId);
        }
      } else {
        this.#completedThreads.delete(threadId);
        await this.#outbox.recordTerminal(threadId, {
          issue: "PREVIOUS_TURN_DID_NOT_COMPLETE",
          status: "failed",
          ...(turnId === undefined ? {} : { turnId }),
        });
      }
      return;
    }
    if (notification.method === "thread/status/changed") {
      const statusRecord = asRecord(params.status);
      const status = asString(statusRecord.type) ?? asString(params.status);
      if (status === "idle" && this.#completedThreads.delete(threadId)) {
        await this.wake(threadId);
      }
      return;
    }
    if (notification.method === "error" && params.willRetry === false) {
      this.#completedThreads.delete(threadId);
      await this.#outbox.recordTerminal(threadId, {
        issue: "PREVIOUS_TURN_DID_NOT_COMPLETE",
        status: "failed",
      });
    }
  }

  async reconcileAfterRestart(): Promise<void> {
    const dispatching = await this.#outbox.dispatchingItems();
    for (const item of dispatching) {
      try {
        const result = await this.#gateway.reconcileClientUserMessage(
          item.threadId,
          item.clientUserMessageId,
        );
        if (result.state === "accepted") {
          await this.#outbox.markStarted(item.id, result.turnId);
        } else {
          await this.#outbox.markAmbiguous(item.id);
        }
      } catch {
        await this.#outbox.markAmbiguous(item.id);
      }
    }
    const safeThreadIds = await this.#outbox.reconcilePendingAfterRestart();
    await Promise.allSettled(safeThreadIds.map(async (threadId) => await this.wake(threadId)));
  }
}

function isDeterministicBusy(error: unknown): boolean {
  return (
    (error instanceof DomainError && error.code === "TURN_MISMATCH") ||
    (error instanceof RpcRequestError && error.code === -32_094)
  );
}

function isDeterministicRejection(error: unknown): error is DomainError | RpcRequestError {
  return error instanceof DomainError || error instanceof RpcRequestError;
}

function errorCode(error: DomainError | RpcRequestError): string {
  return error instanceof DomainError ? error.code : `RPC_${error.code}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
