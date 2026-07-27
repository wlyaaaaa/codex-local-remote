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

type ApprovalKind = "decision" | "unsupported" | "user-input";

interface PendingApproval {
  kind: ApprovalKind;
  params: Record<string, unknown>;
  productRequest: ApprovalRequest;
  protocolChoices?: Map<string, unknown>;
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
  readonly #serverRequestDecisionFallbacks: Readonly<Record<string, readonly unknown[]>>;

  constructor(
    events: RemoteEventBuffer,
    serverRequestDecisionFallbacks: Readonly<Record<string, readonly unknown[]>> = {},
  ) {
    this.#events = events;
    this.#serverRequestDecisionFallbacks = serverRequestDecisionFallbacks;
  }

  handleServerRequest(request: InboundServerRequest): boolean {
    const pending = projectApproval(request, this.#serverRequestDecisionFallbacks);
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

function projectApproval(
  request: InboundServerRequest,
  serverRequestDecisionFallbacks: Readonly<Record<string, readonly unknown[]>>,
): PendingApproval | undefined {
  const id = String(request.id);
  const params = asRecord(request.params);
  const threadId = asString(params.threadId) ?? asString(params.conversationId);
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
      const projectedDecisions = decisionChoices(
        advertisedDecisionsOrFallback(params, serverRequestDecisionFallbacks[request.method]),
      );
      return {
        kind: projectedDecisions.choices.length > 0 ? "decision" : "unsupported",
        params,
        protocolChoices: projectedDecisions.protocolChoices,
        request,
        productRequest: {
          ...base,
          title: "允许运行此操作？",
          choices: projectedDecisions.choices,
          ...(projectedDecisions.choices.length > 0 ? {} : { limitation: choicesNotAdvertised() }),
          ...(command === undefined ? {} : { command }),
          ...(explanation === undefined ? {} : { explanation }),
        },
      };
    }
    case "item/fileChange/requestApproval": {
      const grantRoot = asString(params.grantRoot);
      const explanation = asString(params.reason);
      const projectedDecisions = decisionChoices(
        advertisedDecisionsOrFallback(params, serverRequestDecisionFallbacks[request.method]),
      );
      return {
        kind: projectedDecisions.choices.length > 0 ? "decision" : "unsupported",
        params,
        protocolChoices: projectedDecisions.protocolChoices,
        request,
        productRequest: {
          ...base,
          title: "允许修改项目文件？",
          choices: projectedDecisions.choices,
          ...(projectedDecisions.choices.length > 0 ? {} : { limitation: choicesNotAdvertised() }),
          ...(explanation === undefined ? {} : { explanation }),
          ...(grantRoot === undefined ? {} : { paths: [grantRoot] }),
        },
      };
    }
    case "item/permissions/requestApproval": {
      const explanation = asString(params.reason);
      const projectedDecisions = decisionChoices(
        advertisedDecisionsOrFallback(params, serverRequestDecisionFallbacks[request.method]),
      );
      return {
        kind: projectedDecisions.choices.length > 0 ? "decision" : "unsupported",
        params,
        protocolChoices: projectedDecisions.protocolChoices,
        request,
        productRequest: {
          ...base,
          title: "允许临时扩大访问范围？",
          choices: projectedDecisions.choices,
          ...(projectedDecisions.choices.length > 0 ? {} : { limitation: choicesNotAdvertised() }),
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
      return projectFutureDecisionApproval(
        request,
        params,
        base,
        serverRequestDecisionFallbacks[request.method],
      );
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

  if (pending.kind === "decision") {
    if (!pending.protocolChoices?.has(resolution.choiceId)) {
      throw invalidChoice();
    }
    const decision = pending.protocolChoices.get(resolution.choiceId);
    return { decision };
  }

  throw invalidChoice();
}

function projectFutureDecisionApproval(
  request: InboundServerRequest,
  params: Record<string, unknown>,
  base: { id: string; threadId: string; turnId?: string },
  fallbackDecisions: readonly unknown[] | undefined,
): PendingApproval | undefined {
  const questions = projectQuestions(params.questions);
  if (questions) {
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

  const decisionsAdvertised = Array.isArray(params.availableDecisions);
  const schemaDecisions =
    fallbackDecisions === undefined ? undefined : Array.from(fallbackDecisions);
  if (
    !request.method.endsWith("/requestApproval") &&
    !decisionsAdvertised &&
    schemaDecisions === undefined
  ) {
    return undefined;
  }
  const projectedDecisions = decisionChoices(
    decisionsAdvertised ? params.availableDecisions : schemaDecisions,
  );
  const explanation = asString(params.reason);
  const command = displayCommand(params.command);
  const fileChanges = asRecord(params.fileChanges);
  const paths = Object.keys(fileChanges).slice(0, 100);
  return {
    kind: projectedDecisions.choices.length > 0 ? "decision" : "unsupported",
    params,
    protocolChoices: projectedDecisions.protocolChoices,
    request,
    productRequest: {
      ...base,
      title:
        command !== undefined
          ? "允许运行此操作？"
          : paths.length > 0
            ? "允许修改项目文件？"
            : "Codex 请求批准",
      choices: projectedDecisions.choices,
      ...(projectedDecisions.choices.length > 0 ? {} : { limitation: choicesNotAdvertised() }),
      ...(command === undefined ? {} : { command }),
      ...(explanation === undefined ? {} : { explanation }),
      ...(paths.length === 0 ? {} : { paths }),
    },
  };
}

function choicesNotAdvertised(): string {
  return "当前 Codex 请求没有声明可返回的选择。为避免替你猜测，手机端不会发送审批结果；请在 Desktop 处理或停止当前任务。";
}

function advertisedDecisionsOrFallback(
  params: Record<string, unknown>,
  fallbackDecisions: readonly unknown[] | undefined,
): unknown {
  const advertised = params.availableDecisions;
  return Array.isArray(advertised) && advertised.length > 0 ? advertised : fallbackDecisions;
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

function decisionChoices(value: unknown): {
  choices: ApprovalRequest["choices"];
  protocolChoices: Map<string, unknown>;
} {
  const advertised = Array.isArray(value) ? value : [];
  const choices: ApprovalRequest["choices"] = [];
  const protocolChoices = new Map<string, unknown>();

  for (const [index, decision] of advertised.entries()) {
    if (decision === "accept" || decision === "approved") {
      addProtocolChoice(
        choices,
        protocolChoices,
        { id: "allow-once", label: "仅本次允许", tone: "primary" },
        decision,
      );
      continue;
    }
    if (decision === "acceptForSession" || decision === "approved_for_session") {
      addProtocolChoice(
        choices,
        protocolChoices,
        { id: "allow-session", label: "本次对话允许", tone: "neutral" },
        decision,
      );
      continue;
    }
    if (decision === "decline" || decision === "cancel" || decision === "abort") {
      addProtocolChoice(
        choices,
        protocolChoices,
        {
          id: decision === "decline" ? "deny" : decision === "abort" ? "abort" : "cancel",
          label: decision === "decline" ? "拒绝" : decision === "abort" ? "拒绝并停止" : "取消",
          tone: "danger",
        },
        decision,
      );
      continue;
    }

    const record = asRecord(decision);
    const denied = asRecord(record.denied);
    if (
      Object.keys(record).length === 1 &&
      typeof denied.rejection === "string" &&
      denied.rejection.length > 0
    ) {
      addProtocolChoice(
        choices,
        protocolChoices,
        { id: "deny", label: "拒绝", tone: "danger" },
        decision,
      );
      continue;
    }
    const execPolicy = asRecord(record.acceptWithExecpolicyAmendment);
    if (
      Object.keys(record).length === 1 &&
      Array.isArray(execPolicy.execpolicy_amendment) &&
      execPolicy.execpolicy_amendment.every((part) => typeof part === "string")
    ) {
      addProtocolChoice(
        choices,
        protocolChoices,
        {
          id: `protocol-decision-${index}`,
          label: "允许类似命令",
          tone: "neutral",
        },
        decision,
      );
      continue;
    }

    const networkContainer = asRecord(record.applyNetworkPolicyAmendment);
    const network = asRecord(networkContainer.network_policy_amendment);
    const host = boundedString(network.host, 512);
    const action = asString(network.action);
    if (Object.keys(record).length === 1 && host && (action === "allow" || action === "deny")) {
      addProtocolChoice(
        choices,
        protocolChoices,
        {
          id: `protocol-decision-${index}`,
          label: action === "allow" ? `以后允许访问 ${host}` : `以后阻止访问 ${host}`,
          tone: "neutral",
        },
        decision,
      );
      continue;
    }

    const label = safeDecisionLabel(decision, index);
    if (label) {
      addProtocolChoice(
        choices,
        protocolChoices,
        {
          id: `protocol-decision-${index}`,
          label,
          tone: "neutral",
        },
        decision,
      );
    }
  }
  return { choices, protocolChoices };
}

function safeDecisionLabel(decision: unknown, index: number): string | undefined {
  const record = asRecord(decision);
  for (const key of ["label", "title", "name", "action", "id"]) {
    const advertisedLabel = boundedString(record[key], 512);
    if (advertisedLabel) {
      return advertisedLabel;
    }
  }

  if (typeof decision === "string") {
    const token = humanizeProtocolToken(decision);
    return token ? `Codex 选项 ${index + 1}：${token}` : undefined;
  }
  if (typeof decision === "number" || typeof decision === "boolean") {
    return `Codex 选项 ${index + 1}：${String(decision)}`;
  }

  const keys = Object.keys(record);
  if (keys.length === 1) {
    const token = humanizeProtocolToken(keys[0] ?? "");
    return token ? `Codex 选项 ${index + 1}：${token}` : `Codex 选项 ${index + 1}`;
  }
  return keys.length > 0 ? `Codex 选项 ${index + 1}` : undefined;
}

function humanizeProtocolToken(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 480);
}

function addProtocolChoice(
  choices: ApprovalRequest["choices"],
  protocolChoices: Map<string, unknown>,
  choice: ApprovalRequest["choices"][number],
  decision: unknown,
): void {
  if (protocolChoices.has(choice.id)) {
    return;
  }
  choices.push(choice);
  protocolChoices.set(choice.id, decision);
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

function displayCommand(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 256 &&
    value.every((part) => typeof part === "string")
  ) {
    return value.join(" ").slice(0, 16_384);
  }
  return undefined;
}
