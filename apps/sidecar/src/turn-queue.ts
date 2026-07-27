import type {
  EditQueuedTurnInput,
  QueueTurnInput,
  ReorderQueuedTurnsInput,
  SendQueuedTurnInput,
  SteerQueuedTurnInput,
  TurnQueueSnapshot,
} from "@codex-local-remote/contracts";

import type { DurableTurnOutbox } from "./turn-outbox.js";
import type { TurnQueueDispatcher } from "./turn-queue-dispatcher.js";

export interface SidecarTurnQueueApi {
  enqueue(
    threadId: string,
    input: QueueTurnInput,
    idempotencyScope: string,
  ): Promise<TurnQueueSnapshot>;
  edit(
    threadId: string,
    queueId: string,
    input: EditQueuedTurnInput,
    idempotencyScope: string,
  ): Promise<TurnQueueSnapshot>;
  list(threadId: string): Promise<TurnQueueSnapshot>;
  remove(
    threadId: string,
    queueId: string,
    expectedRevision: number,
    idempotencyScope: string,
  ): Promise<TurnQueueSnapshot>;
  reorder(
    threadId: string,
    input: ReorderQueuedTurnsInput,
    idempotencyScope: string,
  ): Promise<TurnQueueSnapshot>;
  send(
    threadId: string,
    queueId: string,
    input: SendQueuedTurnInput,
    idempotencyScope: string,
  ): Promise<TurnQueueSnapshot>;
  steer(
    threadId: string,
    queueId: string,
    input: SteerQueuedTurnInput,
    idempotencyScope: string,
  ): Promise<TurnQueueSnapshot>;
}

export class TurnQueueService implements SidecarTurnQueueApi {
  readonly #dispatcher: TurnQueueDispatcher;
  readonly #outbox: DurableTurnOutbox;

  constructor(options: { dispatcher: TurnQueueDispatcher; outbox: DurableTurnOutbox }) {
    this.#dispatcher = options.dispatcher;
    this.#outbox = options.outbox;
  }

  async enqueue(
    threadId: string,
    input: QueueTurnInput,
    idempotencyScope: string,
  ): Promise<TurnQueueSnapshot> {
    await this.#outbox.enqueue({ idempotencyScope, input, threadId });
    await this.#wakeBestEffort(threadId);
    return await this.#outbox.snapshot(threadId);
  }

  async edit(
    threadId: string,
    queueId: string,
    input: EditQueuedTurnInput,
    idempotencyScope: string,
  ): Promise<TurnQueueSnapshot> {
    await this.#outbox.edit({
      expectedRevision: input.expectedRevision,
      idempotencyScope,
      input,
      queueId,
      threadId,
    });
    return await this.#outbox.snapshot(threadId);
  }

  async list(threadId: string): Promise<TurnQueueSnapshot> {
    return await this.#outbox.snapshot(threadId);
  }

  async remove(
    threadId: string,
    queueId: string,
    expectedRevision: number,
    idempotencyScope: string,
  ): Promise<TurnQueueSnapshot> {
    return await this.#outbox.remove({
      expectedRevision,
      idempotencyScope,
      queueId,
      threadId,
    });
  }

  async reorder(
    threadId: string,
    input: ReorderQueuedTurnsInput,
    idempotencyScope: string,
  ): Promise<TurnQueueSnapshot> {
    return await this.#outbox.reorder({
      expectedRevision: input.expectedRevision,
      idempotencyScope,
      queueIds: input.queueIds,
      threadId,
    });
  }

  async send(
    threadId: string,
    queueId: string,
    input: SendQueuedTurnInput,
    idempotencyScope: string,
  ): Promise<TurnQueueSnapshot> {
    await this.#outbox.resume({
      expectedRevision: input.expectedRevision,
      idempotencyScope,
      queueId,
      retryAmbiguous: input.retryAmbiguous === true,
      threadId,
    });
    await this.#wakeBestEffort(threadId);
    return await this.#outbox.snapshot(threadId);
  }

  async steer(
    threadId: string,
    queueId: string,
    input: SteerQueuedTurnInput,
    idempotencyScope: string,
  ): Promise<TurnQueueSnapshot> {
    await this.#dispatcher.steerQueued(threadId, queueId, input, idempotencyScope);
    return await this.#outbox.snapshot(threadId);
  }

  async #wakeBestEffort(threadId: string): Promise<void> {
    try {
      await this.#dispatcher.wake(threadId);
    } catch {
      // The encrypted queue entry is already durable. A reconnect transition
      // will inspect the authoritative thread and retry without losing it.
    }
  }
}
