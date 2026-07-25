import type { ApprovalRequest, ApprovalResolutionInput } from "@codex-local-remote/contracts";

import type { RemoteEventBuffer } from "./events.js";

export interface InboundServerRequest {
  id: string | number;
  method: string;
  params?: unknown;
  respond(result: unknown): Promise<void>;
  reject(error: { code: number; message: string; data?: unknown }): Promise<void>;
}

export type ApprovalResolution = ApprovalResolutionInput;

type ApprovalKind = "command" | "file-change" | "permissions" | "user-input";

interface PendingApproval {
  kind: ApprovalKind;
  params: Record<string, unknown>;
  productRequest: ApprovalRequest;
  request: InboundServerRequest;
}

export class ApprovalResolutionError extends Error {
  readonly code: "APPROVAL_NOT_FOUND" | "INVALID_APPROVAL_CHOICE";
  readonly httpStatus: number;

  constructor(code: ApprovalResolutionError["code"], message: string, httpStatus: number) {
    super(message);
    this.name = "ApprovalResolutionError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class ApprovalCoordinator {
  readonly #events: RemoteEventBuffer;
  readonly #pending = new Map<string, PendingApproval>();

  constructor(events: RemoteEventBuffer) {
    this.#events = events;
  }

  handleServerRequest(request: InboundServerRequest): boolean {
    const pending = projectApproval(request);
    if (!pending) {
      void request.reject({
        code: -32_601,
        message: "此请求不能由移动端处理",
      });
      return false;
    }

    const id = String(request.id);
    if (this.#pending.has(id)) {
      void request.reject({
        code: -32_000,
        message: "审批请求重复",
      });
      return false;
    }

    this.#pending.set(id, pending);
    this.#events.append("approval.requested", pending.productRequest, {
      threadId: pending.productRequest.threadId,
      ...(pending.productRequest.turnId === undefined
        ? {}
        : { turnId: pending.productRequest.turnId }),
    });
    return true;
  }

  listPending(): ApprovalRequest[] {
    return [...this.#pending.values()].map((pending) => pending.productRequest);
  }

  async resolve(id: string, resolution: ApprovalResolution): Promise<void> {
    const pending = this.#pending.get(id);
    if (!pending) {
      throw new ApprovalResolutionError("APPROVAL_NOT_FOUND", "这个审批已经处理或已过期", 404);
    }
    const result = resolutionFor(pending, resolution);
    await pending.request.respond(result);
    this.#pending.delete(id);
    this.#events.append(
      "approval.resolved",
      { approvalId: id, choiceId: resolution.choiceId },
      {
        threadId: pending.productRequest.threadId,
        ...(pending.productRequest.turnId === undefined
          ? {}
          : { turnId: pending.productRequest.turnId }),
      },
    );
  }

  markResolved(id: string | number): void {
    this.#pending.delete(String(id));
  }

  handleNotification(notification: { method: string; params?: unknown }): void {
    if (notification.method !== "serverRequest/resolved") {
      return;
    }
    const requestId = asRecord(notification.params).requestId;
    if (typeof requestId === "string" || typeof requestId === "number") {
      this.markResolved(requestId);
    }
  }

  handleBackendRestart(): void {
    for (const [id, pending] of this.#pending) {
      this.#events.append(
        "approval.resolved",
        { approvalId: id, reason: "connection-restarted" },
        {
          threadId: pending.productRequest.threadId,
          ...(pending.productRequest.turnId === undefined
            ? {}
            : { turnId: pending.productRequest.turnId }),
        },
      );
    }
    this.#pending.clear();
  }
}

function projectApproval(request: InboundServerRequest): PendingApproval | undefined {
  const id = String(request.id);
  const params = asRecord(request.params);
  const threadId = asString(params.threadId);
  if (!threadId) {
    return undefined;
  }
  const turnId = asString(params.turnId);
  const base = {
    id,
    threadId,
    ...(turnId === undefined ? {} : { turnId }),
  };

  switch (request.method) {
    case "item/commandExecution/requestApproval": {
      const command = asString(params.command);
      const explanation = asString(params.reason);
      const choices = commandChoices(params.availableDecisions);
      if (choices.length === 0) {
        return undefined;
      }
      return {
        kind: "command",
        params,
        request,
        productRequest: {
          ...base,
          title: "允许运行此操作？",
          choices,
          ...(command === undefined ? {} : { command }),
          ...(explanation === undefined ? {} : { explanation }),
        },
      };
    }
    case "item/fileChange/requestApproval": {
      const grantRoot = asString(params.grantRoot);
      const explanation = asString(params.reason);
      return {
        kind: "file-change",
        params,
        request,
        productRequest: {
          ...base,
          title: "允许修改项目文件？",
          choices: standardChoices(),
          ...(explanation === undefined ? {} : { explanation }),
          ...(grantRoot === undefined ? {} : { paths: [grantRoot] }),
        },
      };
    }
    case "item/permissions/requestApproval": {
      const explanation = asString(params.reason);
      return {
        kind: "permissions",
        params,
        request,
        productRequest: {
          ...base,
          title: "允许临时扩大访问范围？",
          choices: standardChoices(),
          ...(explanation === undefined ? {} : { explanation }),
        },
      };
    }
    case "item/tool/requestUserInput": {
      const questions = projectQuestions(params.questions);
      if (!questions) {
        return undefined;
      }
      return {
        kind: "user-input",
        params,
        request,
        productRequest: {
          ...base,
          title: "Codex 需要你的选择",
          choices: [
            { id: "submit", label: "提交回答", tone: "primary" },
            { id: "cancel", label: "跳过", tone: "danger" },
          ],
          questions,
        },
      };
    }
    default:
      return undefined;
  }
}

function resolutionFor(pending: PendingApproval, resolution: ApprovalResolution): unknown {
  if (pending.kind === "user-input") {
    if (resolution.choiceId === "cancel") {
      return { answers: {} };
    }
    if (resolution.choiceId === "submit" && resolution.answers) {
      return {
        answers: validateUserInputAnswers(
          pending.productRequest.questions ?? [],
          resolution.answers,
        ),
      };
    }
    throw invalidChoice();
  }

  const decision =
    pending.kind === "command"
      ? commandDecision(pending.params.availableDecisions, resolution.choiceId)
      : resolution.choiceId === "allow-once"
        ? "accept"
        : resolution.choiceId === "allow-session"
          ? "acceptForSession"
          : resolution.choiceId === "deny"
            ? "decline"
            : undefined;
  if (!decision) {
    throw invalidChoice();
  }

  if (pending.kind === "permissions") {
    const permissions =
      resolution.choiceId === "deny"
        ? {}
        : compactPermissionProfile(asRecord(pending.params.permissions));
    return {
      permissions,
      scope: resolution.choiceId === "allow-session" ? "session" : "turn",
    };
  }
  return { decision };
}

function projectQuestions(value: unknown): ApprovalRequest["questions"] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    return undefined;
  }
  const projected: NonNullable<ApprovalRequest["questions"]> = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    const question = asRecord(candidate);
    const id = boundedString(question.id, 128);
    const header = boundedString(question.header, 256);
    const text = boundedString(question.question, 4_096);
    if (
      !id ||
      !header ||
      !text ||
      ids.has(id) ||
      typeof question.isOther !== "boolean" ||
      typeof question.isSecret !== "boolean"
    ) {
      return undefined;
    }
    ids.add(id);
    const options = Array.isArray(question.options)
      ? question.options
          .map((rawOption) => {
            const option = asRecord(rawOption);
            const label = boundedString(option.label, 512);
            const description = boundedString(option.description, 2_048) ?? "";
            return label ? { description, label } : undefined;
          })
          .filter(
            (option): option is { description: string; label: string } => option !== undefined,
          )
      : undefined;
    if (Array.isArray(question.options) && options?.length !== question.options.length) {
      return undefined;
    }
    projected.push({
      header,
      id,
      isOther: question.isOther,
      isSecret: question.isSecret,
      question: text,
      ...(options === undefined ? {} : { options }),
    });
  }
  return projected;
}

function validateUserInputAnswers(
  questions: NonNullable<ApprovalRequest["questions"]>,
  answers: Record<string, string[]>,
): Record<string, { answers: string[] }> {
  const expectedIds = new Set(questions.map((question) => question.id));
  if (Object.keys(answers).some((id) => !expectedIds.has(id))) {
    throw invalidChoice();
  }
  const result: Record<string, { answers: string[] }> = {};
  for (const question of questions) {
    const values = answers[question.id];
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > 20 ||
      values.some(
        (value) => typeof value !== "string" || value.trim().length === 0 || value.length > 4_096,
      )
    ) {
      throw invalidChoice();
    }
    const labels = new Set(question.options?.map((option) => option.label) ?? []);
    if (labels.size > 0 && !question.isOther && values.some((value) => !labels.has(value))) {
      throw invalidChoice();
    }
    result[question.id] = { answers: [...values] };
  }
  return result;
}

function compactPermissionProfile(requested: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(isRecord(requested.network) ? { network: requested.network } : {}),
    ...(isRecord(requested.fileSystem) ? { fileSystem: requested.fileSystem } : {}),
  };
}

function standardChoices(): ApprovalRequest["choices"] {
  return [
    { id: "allow-once", label: "仅本次允许", tone: "primary" },
    { id: "allow-session", label: "本次对话允许", tone: "neutral" },
    { id: "deny", label: "拒绝", tone: "danger" },
  ];
}

function commandChoices(value: unknown): ApprovalRequest["choices"] {
  const decisions = commandDecisionSet(value);
  return [
    ...(decisions.has("accept")
      ? [{ id: "allow-once", label: "仅本次允许", tone: "primary" as const }]
      : []),
    ...(decisions.has("acceptForSession")
      ? [{ id: "allow-session", label: "本次对话允许", tone: "neutral" as const }]
      : []),
    ...(decisions.has("decline") || decisions.has("cancel")
      ? [{ id: "deny", label: "拒绝", tone: "danger" as const }]
      : []),
  ];
}

function commandDecision(value: unknown, choiceId: string): string | undefined {
  const decisions = commandDecisionSet(value);
  if (choiceId === "allow-once" && decisions.has("accept")) {
    return "accept";
  }
  if (choiceId === "allow-session" && decisions.has("acceptForSession")) {
    return "acceptForSession";
  }
  if (choiceId === "deny") {
    return decisions.has("decline") ? "decline" : decisions.has("cancel") ? "cancel" : undefined;
  }
  return undefined;
}

function commandDecisionSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    return new Set(["accept", "acceptForSession", "decline"]);
  }
  return new Set(
    (value as unknown[]).filter(
      (decision): decision is string =>
        decision === "accept" ||
        decision === "acceptForSession" ||
        decision === "decline" ||
        decision === "cancel",
    ),
  );
}

function invalidChoice(): ApprovalResolutionError {
  return new ApprovalResolutionError("INVALID_APPROVAL_CHOICE", "请选择一个有效操作", 400);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}
