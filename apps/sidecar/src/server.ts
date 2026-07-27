import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

import {
  RpcConnectionClosedError,
  RpcTimeoutError,
  SharedAppServerConnectionError,
} from "@codex-local-remote/app-server-client";
import type {
  ApiError,
  ApprovalPolicyOption,
  ApprovalReviewerOption,
  AuthSession,
  CollaborationModeOption,
  CreateThreadInput,
  DiagnosticSnapshot,
  EditQueuedTurnInput,
  LocalInputReference,
  ModelOption,
  PermissionProfileOption,
  ProjectSummary,
  PublicBootstrap,
  QueueTurnInput,
  ReorderQueuedTurnsInput,
  RemoteEvent,
  SendQueuedTurnInput,
  SetThreadGoalInput,
  SendTurnInput,
  SteerQueuedTurnInput,
  SteerTurnInput,
  ThreadDetail,
  ThreadGoal,
  ThreadSettingsInput,
  UsageSnapshot,
} from "@codex-local-remote/contracts";
import { API_SCHEMA_VERSION } from "@codex-local-remote/contracts";
import type {
  ApprovalCoordinator,
  ApprovalResolution,
  RemoteEventBuffer,
  ServiceDegradation,
  ServiceResult,
  SubagentPage,
  ThreadPage,
  TurnCommandResult,
} from "@codex-local-remote/domain";
import { ApprovalResolutionError, DomainError } from "@codex-local-remote/domain";
import {
  createCsrfToken,
  LoginRateLimiter,
  validateBrowserMutation,
} from "@codex-local-remote/security";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { setupPassword } from "./auth.js";
import { BrowserUploadStore, MAX_BROWSER_UPLOAD_BYTES } from "./browser-uploads.js";
import type { SidecarConfig } from "./config.js";
import { ProductHttpError } from "./errors.js";
import {
  getProjectDownload,
  getProjectPreview,
  listProjectFiles,
  resolveProjectFileReference,
} from "./files.js";
import type { SessionLookup, SidecarStateStore } from "./state-store.js";
import type { SidecarTurnQueueApi } from "./turn-queue.js";
import { OutboxConflictError } from "./turn-outbox.js";

const SESSION_COOKIE = "codex_remote_session";
const PRODUCT_NAME = "Codex Local Remote";
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u;

export interface SidecarDomainApi {
  compactThread(threadId: string): Promise<void>;
  createThread(input: CreateThreadInput): Promise<ServiceResult<ThreadDetail>>;
  getThread(threadId: string, options?: { includeTurns?: boolean }): Promise<ThreadDetail>;
  getThreadGoal(threadId: string): Promise<ThreadGoal | undefined>;
  getUsage(threadId?: string): Promise<ServiceResult<UsageSnapshot>>;
  interruptTurn(threadId: string, turnId: string): Promise<TurnCommandResult>;
  listApprovalPolicies(): Promise<ServiceResult<ApprovalPolicyOption[]>>;
  listApprovalReviewers(): Promise<ServiceResult<ApprovalReviewerOption[]>>;
  listCollaborationModes(): Promise<ServiceResult<CollaborationModeOption[]>>;
  listModels(): Promise<ServiceResult<ModelOption[]>>;
  listPermissionProfiles(options?: {
    projectId?: string;
    threadId?: string;
  }): Promise<ServiceResult<PermissionProfileOption[]>>;
  listProjects(): Promise<ProjectSummary[]> | ProjectSummary[];
  listSubagents(
    threadId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<SubagentPage>;
  listThreads(options?: {
    archived?: boolean;
    cursor?: string;
    limit?: number;
    projectId?: string;
    searchTerm?: string;
  }): Promise<ThreadPage>;
  resumeThread(threadId: string): Promise<ThreadDetail>;
  clearThreadGoal(threadId: string): Promise<void>;
  setThreadGoal(threadId: string, input: SetThreadGoalInput): Promise<void>;
  setThreadName(threadId: string, name: string): Promise<void>;
  startTurn(threadId: string, input: SendTurnInput): Promise<TurnCommandResult>;
  steerTurn(threadId: string, turnId: string, input: SteerTurnInput): Promise<TurnCommandResult>;
  updateThreadSettings(threadId: string, input: ThreadSettingsInput): Promise<void>;
}

export interface CreateSidecarServerOptions {
  approvals: ApprovalCoordinator;
  config: SidecarConfig;
  diagnostics: () => DiagnosticSnapshot;
  domain: SidecarDomainApi;
  events: RemoteEventBuffer;
  queue?: SidecarTurnQueueApi;
  requestReady?: () => boolean;
  state: SidecarStateStore;
}

interface AuthenticatedRequest {
  csrfDigest: string;
  csrfDigests: string[];
  record: Extract<SessionLookup, { valid: true }>["record"];
  token: string;
}

interface CachedCommand {
  body?: unknown;
  status: number;
}

export async function createSidecarServer(
  options: CreateSidecarServerOptions,
): Promise<FastifyInstance> {
  const { approvals, config, diagnostics, domain, events, queue, requestReady, state } = options;
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    logger: false,
    trustProxy: (address) => isLoopbackAddress(address),
  });
  app.addContentTypeParser(
    "application/octet-stream",
    { bodyLimit: MAX_BROWSER_UPLOAD_BYTES, parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );
  const api = `${config.basePath}/api/v1`;
  const uploads = await BrowserUploadStore.open(config.dataDir);
  const streamInstanceId = randomUUID();
  const idempotencyCache = new Map<string, Promise<CachedCommand>>();
  const loginLimiter = new LoginRateLimiter({
    baseDelayMs: 500,
    global: { lockoutMs: 15 * 60_000, maxAttempts: 50, windowMs: 10 * 60_000 },
    maxDelayMs: 30_000,
    maxSources: 1024,
    source: { lockoutMs: 15 * 60_000, maxAttempts: 5, windowMs: 10 * 60_000 },
  });

  app.addHook("onRequest", async (request, reply) => {
    setSecurityHeaders(reply);
    if (request.url === `${config.basePath}/api` || request.url.startsWith(`${api}/`)) {
      reply.header("Cache-Control", "no-store, private").header("Pragma", "no-cache");
    }
    if (request.protocol === "https") {
      reply.header("Strict-Transport-Security", "max-age=31536000");
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const projected = projectError(error, request.id);
    if (projected.status === 503 && projected.body.error.code === "DESKTOP_RUNTIME_NOT_READY") {
      reply.header("Retry-After", "2");
    }
    void reply.status(projected.status).send(projected.body);
  });
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send(apiError("NOT_FOUND", "找不到这个页面", request.id));
  });

  app.get(config.basePath, async (_request, reply) => {
    return await reply.redirect(`${config.basePath}/`, 308);
  });

  app.get(`${api}/bootstrap`, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authenticated = findAuthentication(request, state) !== undefined;
    const body: PublicBootstrap = {
      authenticated,
      basePath: config.basePath,
      configured: state.configured,
      productName: PRODUCT_NAME,
      schemaVersion: API_SCHEMA_VERSION,
    };
    return body;
  });

  app.get(`${api}/ready`, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (requestReady?.() !== true) {
      return await reply.header("Retry-After", "2").status(503).send({ status: "recovering" });
    }
    return { status: "ready" };
  });

  app.post(`${api}/setup/password`, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!isLocalSetupRequest(request, config.port)) {
      throw new ProductHttpError("LOCAL_SETUP_REQUIRED", "首次设置只能在这台电脑上完成", 403);
    }
    if (state.configured) {
      throw new ProductHttpError("ALREADY_CONFIGURED", "访问密码已经设置", 409);
    }
    const body = asRecord(request.body);
    await setupPassword(
      state,
      requireString(body.password, "请输入访问密码"),
      requireString(body.confirmation, "请再次输入访问密码"),
    );
    const session = await issueSession(state);
    setSessionCookie(reply, config.basePath, session.token, session.auth.expiresAt);
    return session.auth;
  });

  app.post(`${api}/auth/login`, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    requireSameOriginLogin(request);
    if (!state.configured) {
      throw new ProductHttpError("SETUP_REQUIRED", "请先在电脑上设置访问密码", 409);
    }
    const now = Date.now();
    const source = loginRateSource(request);
    const decision = loginLimiter.beforeAttempt(source, now);
    if (!decision.allowed) {
      reply.header("Retry-After", String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
      throw new ProductHttpError("LOGIN_RATE_LIMITED", "尝试次数过多，请稍后再试", 429);
    }
    const password = requireString(asRecord(request.body).password, "请输入访问密码");
    if (!(await state.verifyPassword(password))) {
      loginLimiter.recordFailure(source, now);
      throw new ProductHttpError("INVALID_CREDENTIALS", "访问密码不正确", 401);
    }
    loginLimiter.recordSuccess(source);
    const session = await issueSession(state);
    setSessionCookie(reply, config.basePath, session.token, session.auth.expiresAt);
    return session.auth;
  });

  app.get(`${api}/auth/session`, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const authentication = await requireAuthentication(request, state);
    const csrf = createCsrfToken();
    const rotated = await state.rotateCsrf(authentication.token, csrf.digest, Date.now());
    if (!rotated.valid) {
      throw unauthenticated();
    }
    return authSession(rotated.record, csrf.token);
  });

  app.post(`${api}/auth/logout`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    await state.deleteSession(authentication.token);
    clearSessionCookie(reply, config.basePath);
    return await reply.status(204).send();
  });

  app.get(`${api}/projects`, async (request) => {
    await requireAuthentication(request, state);
    return await domain.listProjects();
  });

  app.get(`${api}/models`, async (request) => {
    await requireAuthentication(request, state);
    return unwrapServiceResult(await domain.listModels(), events);
  });

  app.get(`${api}/approval-reviewers`, async (request) => {
    await requireAuthentication(request, state);
    return unwrapServiceResult(await domain.listApprovalReviewers(), events);
  });

  app.get(`${api}/approval-policies`, async (request) => {
    await requireAuthentication(request, state);
    return unwrapServiceResult(await domain.listApprovalPolicies(), events);
  });

  app.get(`${api}/collaboration-modes`, async (request) => {
    await requireAuthentication(request, state);
    return unwrapServiceResult(await domain.listCollaborationModes(), events);
  });

  app.get(`${api}/permission-profiles`, async (request) => {
    await requireAuthentication(request, state);
    const query = asRecord(request.query);
    const projectId = optionalString(query.projectId);
    const threadId = optionalString(query.threadId);
    if (projectId !== undefined && threadId !== undefined) {
      throw new ProductHttpError("INVALID_INPUT", "项目和对话权限范围不能同时指定", 400);
    }
    return unwrapServiceResult(
      await domain.listPermissionProfiles({
        ...(projectId === undefined ? {} : { projectId }),
        ...(threadId === undefined ? {} : { threadId }),
      }),
      events,
    );
  });

  app.get(`${api}/threads`, async (request, reply) => {
    await requireAuthentication(request, state);
    const query = asRecord(request.query);
    const archived = optionalBoolean(query.archived) ?? false;
    const cursor = optionalString(query.cursor);
    const limit = optionalInteger(query.limit);
    const projectId = optionalString(query.projectId);
    const searchTerm = optionalString(query.searchTerm);
    const page = await domain.listThreads({
      archived,
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(searchTerm === undefined ? {} : { searchTerm }),
    });
    if (page.nextCursor) {
      reply.header("X-Next-Cursor", page.nextCursor).header("X-History-Truncated", "true");
    }
    return page.data;
  });

  app.get(`${api}/threads/:threadId`, async (request) => {
    await requireAuthentication(request, state);
    const query = asRecord(request.query);
    const includeItems = optionalBoolean(query.includeItems) ?? true;
    const snapshotEventSeq = events.latestSequence;
    const detail = includeItems
      ? await domain.getThread(routeParameter(request, "threadId"))
      : await domain.getThread(routeParameter(request, "threadId"), {
          includeTurns: false,
        });
    return attachSnapshotEventSequence(detail, snapshotEventSeq);
  });

  app.post(`${api}/uploads`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const query = asRecord(request.query);
    const name = requireString(query.name, "请选择要上传的文件");
    const relativePath = optionalString(query.relativePath);
    const bytes = request.body;
    if (!Buffer.isBuffer(bytes)) {
      throw new ProductHttpError("INVALID_INPUT", "上传内容无效", 400);
    }
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => ({
      body: await uploads.save({
        bytes,
        name,
        ...(relativePath === undefined ? {} : { relativePath }),
      }),
      status: 201,
    }));
    return await sendCached(reply, result);
  });

  app.get(`${api}/threads/:threadId/queue`, async (request) => {
    await requireAuthentication(request, state);
    return await requireQueue(queue).list(routeParameter(request, "threadId"));
  });

  app.post(`${api}/threads/:threadId/queue`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const snapshot = await requireQueue(queue).enqueue(
      routeParameter(request, "threadId"),
      parseQueueTurnInput(request.body),
      requireIdempotencyScope(request, authentication),
    );
    return await reply.status(202).send(snapshot);
  });

  app.patch(`${api}/threads/:threadId/queue/:queueId`, async (request) => {
    const authentication = await requireProtectedMutation(request, state);
    return await requireQueue(queue).edit(
      routeParameter(request, "threadId"),
      routeParameter(request, "queueId"),
      parseEditQueuedTurnInput(request.body),
      requireIdempotencyScope(request, authentication),
    );
  });

  app.delete(`${api}/threads/:threadId/queue/:queueId`, async (request) => {
    const authentication = await requireProtectedMutation(request, state);
    return await requireQueue(queue).remove(
      routeParameter(request, "threadId"),
      routeParameter(request, "queueId"),
      requireExpectedRevision(request.body),
      requireIdempotencyScope(request, authentication),
    );
  });

  app.put(`${api}/threads/:threadId/queue/order`, async (request) => {
    const authentication = await requireProtectedMutation(request, state);
    return await requireQueue(queue).reorder(
      routeParameter(request, "threadId"),
      parseReorderQueuedTurnsInput(request.body),
      requireIdempotencyScope(request, authentication),
    );
  });

  app.post(`${api}/threads/:threadId/queue/:queueId/send`, async (request) => {
    const authentication = await requireProtectedMutation(request, state);
    return await requireQueue(queue).send(
      routeParameter(request, "threadId"),
      routeParameter(request, "queueId"),
      parseSendQueuedTurnInput(request.body),
      requireIdempotencyScope(request, authentication),
    );
  });

  app.post(`${api}/threads/:threadId/queue/:queueId/steer`, async (request) => {
    const authentication = await requireProtectedMutation(request, state);
    return await requireQueue(queue).steer(
      routeParameter(request, "threadId"),
      routeParameter(request, "queueId"),
      parseSteerQueuedTurnInput(request.body),
      requireIdempotencyScope(request, authentication),
    );
  });

  app.post(`${api}/threads`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    if (requestReady?.() !== true) {
      throw new ProductHttpError(
        "DESKTOP_RUNTIME_NOT_READY",
        "电脑端连接正在恢复，请稍后重试",
        503,
      );
    }
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      const snapshotEventSeq = events.latestSequence;
      const created = await domain.createThread(parseCreateThreadInput(request.body));
      publishDegradations(created.degradations, events);
      return { body: attachSnapshotEventSequence(created.data, snapshotEventSeq), status: 201 };
    });
    return await sendCached(reply, result);
  });

  app.post(`${api}/threads/:threadId/resume`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      const snapshotEventSeq = events.latestSequence;
      return {
        body: attachSnapshotEventSequence(
          await domain.resumeThread(routeParameter(request, "threadId")),
          snapshotEventSeq,
        ),
        status: 200,
      };
    });
    return await sendCached(reply, result);
  });

  app.post(`${api}/threads/:threadId/compact`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      await domain.compactThread(routeParameter(request, "threadId"));
      return { status: 202 };
    });
    return await sendCached(reply, result);
  });

  app.put(`${api}/threads/:threadId/name`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      await domain.setThreadName(
        routeParameter(request, "threadId"),
        requireString(asRecord(request.body).name, "请输入对话名称"),
      );
      return { status: 204 };
    });
    return await sendCached(reply, result);
  });

  app.get(`${api}/threads/:threadId/goal`, async (request) => {
    await requireAuthentication(request, state);
    return {
      goal: (await domain.getThreadGoal(routeParameter(request, "threadId"))) ?? null,
    };
  });

  app.put(`${api}/threads/:threadId/goal`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      await domain.setThreadGoal(
        routeParameter(request, "threadId"),
        parseSetThreadGoalInput(request.body),
      );
      return { status: 204 };
    });
    return await sendCached(reply, result);
  });

  app.delete(`${api}/threads/:threadId/goal`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      await domain.clearThreadGoal(routeParameter(request, "threadId"));
      return { status: 204 };
    });
    return await sendCached(reply, result);
  });

  app.patch(`${api}/threads/:threadId/settings`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      await domain.updateThreadSettings(
        routeParameter(request, "threadId"),
        parseThreadSettingsInput(request.body),
      );
      return { status: 204 };
    });
    return await sendCached(reply, result);
  });

  app.post(`${api}/threads/:threadId/turns`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      const snapshotEventSeq = events.latestSequence;
      const threadId = routeParameter(request, "threadId");
      await domain.startTurn(threadId, parseSendTurnInput(request.body));
      return {
        body: attachSnapshotEventSequence(await domain.getThread(threadId), snapshotEventSeq),
        status: 200,
      };
    });
    return await sendCached(reply, result);
  });

  app.post(`${api}/threads/:threadId/turns/:turnId/steer`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      const threadId = routeParameter(request, "threadId");
      const turnId = routeParameter(request, "turnId");
      const input = parseSteerTurnInput(request.body);
      const aliasId = `pending-steer-${randomUUID()}`;
      events.append(
        "thread.item",
        {
          item: [
            {
              id: aliasId,
              kind: "user-message",
              text: input.prompt,
            },
          ],
          lifecycle: "started",
          localRemoteAlias: "steer",
        },
        { threadId, turnId },
      );
      try {
        await domain.steerTurn(threadId, turnId, input);
      } catch (error) {
        events.append(
          "thread.item",
          {
            item: [
              {
                id: aliasId,
                kind: "user-message",
                text: input.prompt,
              },
            ],
            lifecycle: "failed",
            localRemoteAlias: "steer-cancel",
          },
          { threadId, turnId },
        );
        throw error;
      }
      return { status: 204 };
    });
    return await sendCached(reply, result);
  });

  app.post(`${api}/threads/:threadId/turns/:turnId/interrupt`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      await domain.interruptTurn(
        routeParameter(request, "threadId"),
        routeParameter(request, "turnId"),
      );
      return { status: 204 };
    });
    return await sendCached(reply, result);
  });

  app.get(`${api}/threads/:threadId/subagents`, async (request, reply) => {
    await requireAuthentication(request, state);
    const query = asRecord(request.query);
    const cursor = optionalString(query.cursor);
    const limit = optionalInteger(query.limit);
    const page = await domain.listSubagents(routeParameter(request, "threadId"), {
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
    });
    if (page.nextCursor) {
      reply.header("X-Next-Cursor", page.nextCursor);
    }
    return page.data;
  });

  app.get(`${api}/usage`, async (request) => {
    await requireAuthentication(request, state);
    const threadId = optionalString(asRecord(request.query).threadId);
    return unwrapServiceResult(await domain.getUsage(threadId), events);
  });

  app.get(`${api}/approvals`, async (request) => {
    await requireAuthentication(request, state);
    return approvals.listPending();
  });

  app.post(`${api}/approvals/:approvalId/resolve`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      const body = asRecord(request.body);
      const answers = parseApprovalAnswers(body.answers);
      const resolution: ApprovalResolution = {
        choiceId: requireString(body.choiceId, "请选择处理方式"),
        ...(answers === undefined ? {} : { answers }),
      };
      await approvals.resolve(routeParameter(request, "approvalId"), resolution);
      return { status: 204 };
    });
    return await sendCached(reply, result);
  });

  app.get(`${api}/files`, async (request) => {
    await requireAuthentication(request, state);
    const query = asRecord(request.query);
    return await listProjectFiles(
      state,
      requireString(query.projectId, "请选择项目"),
      optionalString(query.path) ?? "",
    );
  });

  app.get(`${api}/files/resolve`, async (request) => {
    await requireAuthentication(request, state);
    const query = asRecord(request.query);
    return await resolveProjectFileReference(
      state,
      optionalString(query.projectId),
      requireString(query.path, "请选择文件"),
    );
  });

  app.get(`${api}/files/preview`, async (request, reply) => {
    await requireAuthentication(request, state);
    const query = asRecord(request.query);
    const relativePath = requireString(query.path, "请选择文件");
    const file = await getProjectPreview(
      state,
      requireString(query.projectId, "请选择项目"),
      relativePath,
    );
    reply
      .header("Cache-Control", "no-store")
      .header("Content-Disposition", contentDisposition("inline", relativePath))
      .type(file.contentType);
    const stream = file.handle.createReadStream({ autoClose: true });
    reply.raw.once("close", () => {
      void file.handle.close().catch(() => undefined);
    });
    return await reply.send(stream);
  });

  app.get(`${api}/files/download`, async (request, reply) => {
    await requireAuthentication(request, state);
    const query = asRecord(request.query);
    const relativePath = requireString(query.path, "请选择文件");
    const file = await getProjectDownload(
      state,
      requireString(query.projectId, "请选择项目"),
      relativePath,
    );
    reply
      .header("Cache-Control", "no-store")
      .header("Content-Disposition", contentDisposition("attachment", relativePath))
      .type("application/octet-stream");
    const stream = file.handle.createReadStream({ autoClose: true });
    reply.raw.once("close", () => {
      void file.handle.close().catch(() => undefined);
    });
    return await reply.send(stream);
  });

  app.get(`${api}/diagnostics`, async (request) => {
    await requireAuthentication(request, state);
    return diagnostics();
  });

  app.get(`${api}/events`, async (request, reply) => {
    const authentication = await requireAuthentication(request, state);
    const query = asRecord(request.query);
    const queryCursor = optionalEventStreamCursor(query.cursor);
    const threadId = optionalEventStreamThreadId(query.threadId);
    openEventStream(
      request,
      reply,
      events,
      streamInstanceId,
      state,
      authentication.record.tokenDigest,
      queryCursor,
      threadId,
    );
  });

  if (await directoryExists(config.webDir)) {
    await app.register(fastifyStatic, {
      index: false,
      prefix: `${config.basePath}/`,
      root: config.webDir,
      wildcard: false,
    });
    app.get(`${config.basePath}/`, async (_request, reply) => {
      return await reply.header("Cache-Control", "no-cache").sendFile("index.html");
    });
    app.get(`${config.basePath}/*`, async (request, reply) => {
      const suffix = routeParameter(request, "*");
      if (suffix === "api" || suffix.startsWith("api/")) {
        throw new ProductHttpError("NOT_FOUND", "找不到这个页面", 404);
      }
      if (suffix === "assets" || suffix.startsWith("assets/")) {
        const segments = suffix.split("/");
        if (
          suffix === "assets" ||
          suffix.includes("\\") ||
          suffix.includes("\0") ||
          segments.some((segment) => segment === "" || segment === "." || segment === "..")
        ) {
          throw new ProductHttpError("NOT_FOUND", "找不到这个资源", 404);
        }
        return await reply
          .header("Cache-Control", "public, max-age=31536000, immutable")
          .sendFile(suffix);
      }
      return await reply.header("Cache-Control", "no-cache").sendFile("index.html");
    });
  } else {
    app.get(`${config.basePath}/`, async (_request, reply) => {
      return await reply
        .status(503)
        .send(apiError("WEB_NOT_BUILT", "网页资源尚未构建，请先完成安装", undefined));
    });
  }

  return app;

  async function requireProtectedMutation(
    request: FastifyRequest,
    store: SidecarStateStore,
  ): Promise<AuthenticatedRequest> {
    const authentication = await requireAuthentication(request, store);
    const allowed = authentication.csrfDigests.some(
      (expectedCsrfDigest) =>
        validateBrowserMutation({
          allowedOrigins: [effectiveOrigin(request)],
          authenticated: true,
          csrfToken: headerValue(request.headers["x-csrf-token"]),
          expectedCsrfDigest,
          method: request.method,
          origin: headerValue(request.headers.origin),
          secFetchSite: headerValue(request.headers["sec-fetch-site"]),
        }).allowed,
    );
    if (!allowed) {
      throw new ProductHttpError(
        "REQUEST_VERIFICATION_FAILED",
        "请求验证失败，请刷新页面后重试",
        403,
      );
    }
    return authentication;
  }
}

function findAuthentication(
  request: FastifyRequest,
  state: SidecarStateStore,
): AuthenticatedRequest | undefined {
  const token = parseCookies(headerValue(request.headers.cookie))[SESSION_COOKIE];
  if (!token) {
    return undefined;
  }
  const lookup = state.findSession(token, Date.now());
  return lookup.valid
    ? {
        csrfDigest: lookup.csrfDigest,
        csrfDigests: lookup.csrfDigests,
        record: lookup.record,
        token,
      }
    : undefined;
}

async function requireAuthentication(
  request: FastifyRequest,
  state: SidecarStateStore,
): Promise<AuthenticatedRequest> {
  const authentication = findAuthentication(request, state);
  if (!authentication) {
    throw unauthenticated();
  }
  const touched = await state.touchSession(authentication.token, Date.now());
  if (!touched.valid) {
    throw unauthenticated();
  }
  return {
    csrfDigest: touched.csrfDigest,
    csrfDigests: touched.csrfDigests,
    record: touched.record,
    token: authentication.token,
  };
}

function requireSameOriginLogin(request: FastifyRequest): void {
  const origin = headerValue(request.headers.origin);
  if (
    origin === undefined ||
    origin !== effectiveOrigin(request) ||
    headerValue(request.headers["sec-fetch-site"]) !== "same-origin"
  ) {
    throw new ProductHttpError(
      "REQUEST_VERIFICATION_FAILED",
      "请求验证失败，请刷新页面后重试",
      403,
    );
  }
}

function isLocalSetupRequest(request: FastifyRequest, port: number): boolean {
  if (!isLoopbackAddress(request.raw.socket.remoteAddress)) {
    return false;
  }
  if (
    Object.entries(request.headers).some(
      ([name, value]) =>
        value !== undefined &&
        (name.toLocaleLowerCase("en-US") === "forwarded" ||
          name.toLocaleLowerCase("en-US").startsWith("x-forwarded-")),
    )
  ) {
    return false;
  }
  const host = headerValue(request.headers.host)?.toLocaleLowerCase("en-US");
  const allowedHosts = new Set([`127.0.0.1:${port}`, `[::1]:${port}`, `localhost:${port}`]);
  if (!host || !allowedHosts.has(host)) {
    return false;
  }
  const origin = headerValue(request.headers.origin);
  if (!origin || headerValue(request.headers["sec-fetch-site"]) !== "same-origin") {
    return false;
  }
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.host.toLocaleLowerCase("en-US") === host &&
      parsed.origin === origin
    );
  } catch {
    return false;
  }
}

function loginRateSource(request: FastifyRequest): string {
  const candidate = request.ip.trim();
  return candidate.length > 0 && candidate.length <= 512
    ? candidate
    : (request.raw.socket.remoteAddress ?? "loopback-unknown");
}

function effectiveOrigin(request: FastifyRequest): string {
  const trustForwarded = isLoopbackAddress(request.raw.socket.remoteAddress);
  const protocol = trustForwarded
    ? (firstForwardedValue(request.headers["x-forwarded-proto"]) ??
      (request.protocol === "https" ? "https" : "http"))
    : request.protocol === "https"
      ? "https"
      : "http";
  const host = trustForwarded
    ? (firstForwardedValue(request.headers["x-forwarded-host"]) ??
      headerValue(request.headers.host))
    : headerValue(request.headers.host);
  if ((protocol !== "http" && protocol !== "https") || !host || /\s|[/?#@]/u.test(host)) {
    throw new ProductHttpError(
      "REQUEST_VERIFICATION_FAILED",
      "请求验证失败，请刷新页面后重试",
      403,
    );
  }
  try {
    const url = new URL(`${protocol}://${host}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("invalid origin");
    }
    return url.origin;
  } catch {
    throw new ProductHttpError(
      "REQUEST_VERIFICATION_FAILED",
      "请求验证失败，请刷新页面后重试",
      403,
    );
  }
}

async function issueSession(state: SidecarStateStore): Promise<{
  auth: AuthSession;
  token: string;
}> {
  const now = Date.now();
  const csrf = createCsrfToken();
  const session = await state.createSession(now, csrf.digest);
  return {
    auth: authSession(session.record, csrf.token),
    token: session.token,
  };
}

function authSession(record: AuthenticatedRequest["record"], csrfToken: string): AuthSession {
  return {
    authenticated: true,
    csrfToken,
    expiresAt: new Date(record.absoluteExpiresAtMs).toISOString(),
    idleExpiresAt: new Date(record.idleExpiresAtMs).toISOString(),
  };
}

function setSessionCookie(
  reply: FastifyReply,
  basePath: string,
  token: string,
  expiresAt: string,
): void {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  reply.header(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=${basePath}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`,
  );
}

function clearSessionCookie(reply: FastifyReply, basePath: string): void {
  reply.header(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=${basePath}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
  );
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header || header.length > 8192) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (/^[A-Za-z0-9_-]+$/u.test(key) && /^[A-Za-z0-9_-]+$/u.test(value)) {
      result[key] = value;
    }
  }
  return result;
}

async function runIdempotent(
  request: FastifyRequest,
  authentication: AuthenticatedRequest,
  cache: Map<string, Promise<CachedCommand>>,
  command: () => Promise<CachedCommand>,
): Promise<CachedCommand> {
  const cacheKey = requireIdempotencyScope(request, authentication);
  const cached = cache.get(cacheKey);
  if (cached) {
    return await cached;
  }
  const pending = command();
  cache.set(cacheKey, pending);
  while (cache.size > 1000) {
    const oldest = cache.keys().next().value;
    if (!oldest) {
      break;
    }
    cache.delete(oldest);
  }
  try {
    return await pending;
  } catch (error) {
    cache.delete(cacheKey);
    throw error;
  }
}

function requireIdempotencyScope(
  request: FastifyRequest,
  authentication: AuthenticatedRequest,
): string {
  const key = headerValue(request.headers["idempotency-key"]);
  if (!key || !IDEMPOTENCY_KEY.test(key)) {
    throw new ProductHttpError("IDEMPOTENCY_KEY_REQUIRED", "请求标识缺失，请刷新页面后重试", 400);
  }
  const routeParameters = isRecord(request.params) ? request.params : {};
  const targets = Object.entries(routeParameters)
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([name, value]) => {
      if (typeof value !== "string" || !value || value.length > 512) {
        throw new ProductHttpError("INVALID_ROUTE_TARGET", "请求目标无效", 400);
      }
      return `${name}=${encodeURIComponent(value)}`;
    });
  return [
    authentication.record.tokenDigest,
    request.method,
    request.routeOptions.url,
    ...targets,
    key,
  ].join(":");
}

async function sendCached(reply: FastifyReply, result: CachedCommand) {
  if (result.status === 204) {
    return await reply.status(204).send();
  }
  return await reply.status(result.status).send(result.body);
}

function unwrapServiceResult<T>(result: ServiceResult<T>, events: RemoteEventBuffer): T {
  publishDegradations(result.degradations, events);
  return result.data;
}

function publishDegradations(degradations: ServiceDegradation[], events: RemoteEventBuffer): void {
  for (const degradation of degradations) {
    events.append("diagnostic", {
      code: degradation.code,
      feature: degradation.feature,
      message: degradation.message,
    });
  }
}

function attachSnapshotEventSequence(detail: ThreadDetail, snapshotEventSeq: number): ThreadDetail {
  return {
    ...detail,
    snapshotEventSeq,
  };
}

function openEventStream(
  request: FastifyRequest,
  reply: FastifyReply,
  events: RemoteEventBuffer,
  streamInstanceId: string,
  state: SidecarStateStore,
  sessionTokenDigest: string,
  queryCursor?: string,
  threadId?: string,
): void {
  const raw = reply.raw;
  reply.hijack();
  raw.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
  });
  const lastEventId = headerValue(request.headers["last-event-id"]) ?? queryCursor;
  const cursor = parseEventStreamCursor(lastEventId);
  const replay =
    lastEventId === undefined
      ? events.replayAfter(events.latestSequence)
      : cursor?.instanceId === streamInstanceId
        ? events.replayAfter(cursor.sequence)
        : { events: [], resetRequired: true };
  let heartbeat: NodeJS.Timeout | undefined;
  let closed = false;
  let unsubscribe: () => void = () => undefined;
  const closeStream = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    unsubscribe();
    if (!raw.destroyed && !raw.writableEnded) {
      raw.end();
    }
  };
  const writeAuthenticatedEvent = (event: RemoteEvent): boolean => {
    if (!eventMatchesSubscription(event, threadId)) {
      return true;
    }
    if (!state.isSessionActive(sessionTokenDigest, Date.now())) {
      closeStream();
      return false;
    }
    if (!writeEvent(raw, event, streamInstanceId)) {
      closeStream();
      return false;
    }
    return true;
  };
  unsubscribe = events.subscribe((event) => {
    writeAuthenticatedEvent(event);
  });
  raw.once("close", closeStream);
  if (replay.resetRequired) {
    if (!writeAuthenticatedEvent(events.createResetEvent())) {
      return;
    }
  } else {
    for (const event of replay.events) {
      if (!writeAuthenticatedEvent(event)) {
        return;
      }
    }
  }
  const ready: RemoteEvent = {
    emittedAt: new Date().toISOString(),
    payload: { latestSequence: events.latestSequence },
    schemaVersion: API_SCHEMA_VERSION,
    seq: events.latestSequence,
    type: "connection.ready",
  };
  if (!writeAuthenticatedEvent(ready)) {
    return;
  }
  heartbeat = setInterval(() => {
    if (!state.isSessionActive(sessionTokenDigest, Date.now())) {
      closeStream();
      return;
    }
    if (!raw.destroyed && !raw.writableEnded && !raw.write(": keepalive\n\n")) {
      closeStream();
    }
  }, 25_000);
  heartbeat.unref();
}

function optionalEventStreamCursor(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined;
}

function optionalEventStreamThreadId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined;
}

export function eventMatchesSubscription(event: RemoteEvent, threadId?: string): boolean {
  const detailScoped =
    event.type === "thread.item" ||
    event.type === "usage.updated" ||
    event.type === "queue.updated" ||
    (event.type === "diagnostic" && event.threadId !== undefined);
  if (!detailScoped || event.threadId === undefined) {
    return true;
  }
  return threadId !== undefined && event.threadId === threadId;
}

function parseEventStreamCursor(
  value: string | undefined,
): { instanceId: string; sequence: number } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^([^:]+):(0|[1-9][0-9]*)$/u.exec(value);
  if (!match) {
    return undefined;
  }
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence)) {
    return undefined;
  }
  return { instanceId: match[1] ?? "", sequence };
}

export function writeEvent(
  stream: FastifyReply["raw"],
  event: RemoteEvent,
  streamInstanceId: string,
): boolean {
  if (stream.destroyed || stream.writableEnded) {
    return false;
  }
  try {
    return stream.write(`id: ${streamInstanceId}:${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  } catch {
    return false;
  }
}

function setSecurityHeaders(reply: FastifyReply): void {
  reply
    .header(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' blob: data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
    )
    .header("Cross-Origin-Opener-Policy", "same-origin")
    .header("Cross-Origin-Resource-Policy", "same-origin")
    .header("Permissions-Policy", "camera=(), geolocation=(), microphone=()")
    .header("Referrer-Policy", "no-referrer")
    .header("X-Content-Type-Options", "nosniff")
    .header("X-Frame-Options", "DENY");
}

function parseCreateThreadInput(value: unknown): CreateThreadInput {
  const body = asRecord(value);
  const attachments = parseLocalInputReferences(body.attachments);
  const approvalPolicy = optionalString(body.approvalPolicy);
  const approvalsReviewer = optionalString(body.approvalsReviewer);
  const collaborationMode = optionalString(body.collaborationMode);
  const model = optionalString(body.model);
  const permissionProfileId = optionalString(body.permissionProfileId);
  const projectId = optionalString(body.projectId);
  const serviceTier = optionalString(body.serviceTier);
  return {
    prompt: requireString(body.prompt, "请输入消息"),
    ...(attachments === undefined ? {} : { attachments }),
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
    ...(approvalsReviewer === undefined ? {} : { approvalsReviewer }),
    ...(collaborationMode === undefined ? {} : { collaborationMode }),
    ...(model === undefined ? {} : { model }),
    ...(permissionProfileId === undefined ? {} : { permissionProfileId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(isPermissionMode(body.permissionMode) ? { permissionMode: body.permissionMode } : {}),
    ...(isReasoningEffort(body.reasoningEffort) ? { reasoningEffort: body.reasoningEffort } : {}),
    ...(serviceTier === undefined ? {} : { serviceTier }),
  };
}

function parseSendTurnInput(value: unknown): SendTurnInput {
  const body = asRecord(value);
  const attachments = parseLocalInputReferences(body.attachments);
  const approvalPolicy = optionalString(body.approvalPolicy);
  const approvalsReviewer = optionalString(body.approvalsReviewer);
  const collaborationMode = optionalString(body.collaborationMode);
  const model = optionalString(body.model);
  const permissionProfileId = optionalString(body.permissionProfileId);
  const serviceTier = optionalString(body.serviceTier);
  return {
    prompt: requireString(body.prompt, "请输入消息"),
    ...(attachments === undefined ? {} : { attachments }),
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
    ...(approvalsReviewer === undefined ? {} : { approvalsReviewer }),
    ...(collaborationMode === undefined ? {} : { collaborationMode }),
    ...(model === undefined ? {} : { model }),
    ...(permissionProfileId === undefined ? {} : { permissionProfileId }),
    ...(isReasoningEffort(body.reasoningEffort) ? { reasoningEffort: body.reasoningEffort } : {}),
    ...(serviceTier === undefined ? {} : { serviceTier }),
  };
}

function parseThreadSettingsInput(value: unknown): ThreadSettingsInput {
  const body = asRecord(value);
  const reasoningEffort = optionalNullableSetting(body, "reasoningEffort", "思考等级无效");
  if (
    typeof reasoningEffort === "string" &&
    (reasoningEffort.length > 64 || reasoningEffort.trim() !== reasoningEffort)
  ) {
    throw new ProductHttpError("INVALID_INPUT", "思考等级无效", 400);
  }
  return {
    ...nullableSetting(body, "model", "模型无效"),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...nullableSetting(body, "serviceTier", "速度设置无效"),
    ...nullableSetting(body, "permissionProfileId", "权限设置无效"),
    ...nullableSetting(body, "approvalPolicy", "审批策略无效"),
    ...nullableSetting(body, "approvalsReviewer", "审批方式无效"),
    ...nullableSetting(body, "collaborationMode", "协作模式无效"),
  };
}

function parseSetThreadGoalInput(value: unknown): SetThreadGoalInput {
  const body = asRecord(value);
  const tokenBudget = optionalInteger(body.tokenBudget);
  if (Object.hasOwn(body, "tokenBudget") && (tokenBudget === undefined || tokenBudget <= 0)) {
    throw new ProductHttpError("INVALID_INPUT", "目标额度必须是正整数", 400);
  }
  return {
    objective: requireString(body.objective, "请输入目标"),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
  };
}

function parseQueueTurnInput(value: unknown): QueueTurnInput {
  const body = asRecord(value);
  const attachments = parseLocalInputReferences(body.attachments);
  const approvalPolicy = optionalString(body.approvalPolicy);
  const approvalsReviewer = optionalString(body.approvalsReviewer);
  const collaborationMode = optionalString(body.collaborationMode);
  const model = optionalString(body.model);
  const permissionProfileId = optionalString(body.permissionProfileId);
  const serviceTier = optionalString(body.serviceTier);
  return {
    prompt: requireString(body.prompt, "请输入消息"),
    ...(attachments === undefined ? {} : { attachments }),
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
    ...(approvalsReviewer === undefined ? {} : { approvalsReviewer }),
    ...(collaborationMode === undefined ? {} : { collaborationMode }),
    ...(model === undefined ? {} : { model }),
    ...(permissionProfileId === undefined ? {} : { permissionProfileId }),
    ...(isReasoningEffort(body.reasoningEffort) ? { reasoningEffort: body.reasoningEffort } : {}),
    ...(serviceTier === undefined ? {} : { serviceTier }),
  };
}

function parseSteerTurnInput(value: unknown): SteerTurnInput {
  const body = asRecord(value);
  const attachments = parseLocalInputReferences(body.attachments);
  return {
    prompt: requireString(body.prompt, "请输入补充要求"),
    ...(attachments === undefined ? {} : { attachments }),
  };
}

function parseLocalInputReferences(value: unknown): LocalInputReference[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20) {
    throw new ProductHttpError("INVALID_INPUT", "一次最多添加 20 个文件或文件夹", 400);
  }
  return value.map((candidate) => {
    const reference = asRecord(candidate);
    const projectId = optionalString(reference.projectId);
    const uploadId = optionalString(reference.uploadId);
    const relativePath = requireString(reference.relativePath, "附件路径无效");
    const projectReference = projectId !== undefined && uploadId === undefined;
    const uploadReference = uploadId !== undefined && projectId === undefined;
    if (
      (!projectReference && !uploadReference) ||
      (projectId?.length ?? uploadId?.length ?? 0) > 512 ||
      relativePath.length > 32_768 ||
      relativePath.includes("\0")
    ) {
      throw new ProductHttpError("INVALID_INPUT", "附件路径无效", 400);
    }
    if (reference.kind !== "file" && reference.kind !== "directory") {
      throw new ProductHttpError("INVALID_INPUT", "附件类型无效", 400);
    }
    if (uploadReference && reference.kind !== "file") {
      throw new ProductHttpError("INVALID_INPUT", "浏览器上传仅支持文件", 400);
    }
    return {
      kind: reference.kind,
      relativePath,
      ...(projectId === undefined ? {} : { projectId }),
      ...(uploadId === undefined ? {} : { uploadId }),
    };
  });
}

function parseEditQueuedTurnInput(value: unknown): EditQueuedTurnInput {
  return {
    ...parseQueueTurnInput(value),
    expectedRevision: requireExpectedRevision(value),
  };
}

function parseReorderQueuedTurnsInput(value: unknown): ReorderQueuedTurnsInput {
  const body = asRecord(value);
  if (
    !Array.isArray(body.queueIds) ||
    body.queueIds.length > 500 ||
    body.queueIds.some(
      (queueId) =>
        typeof queueId !== "string" ||
        !queueId.trim() ||
        queueId.trim() !== queueId ||
        queueId.length > 512,
    )
  ) {
    throw new ProductHttpError("INVALID_INPUT", "排队顺序无效", 400);
  }
  return {
    expectedRevision: requireExpectedRevision(value),
    queueIds: body.queueIds as string[],
  };
}

function parseSendQueuedTurnInput(value: unknown): SendQueuedTurnInput {
  return {
    expectedRevision: requireExpectedRevision(value),
    ...(asRecord(value).retryAmbiguous === true ? { retryAmbiguous: true } : {}),
  };
}

function parseSteerQueuedTurnInput(value: unknown): SteerQueuedTurnInput {
  return {
    expectedRevision: requireExpectedRevision(value),
    turnId: requireString(asRecord(value).turnId, "当前回复无效"),
  };
}

function requireExpectedRevision(value: unknown): number {
  const revision = optionalInteger(asRecord(value).expectedRevision);
  if (revision === undefined || revision < 0) {
    throw new ProductHttpError("INVALID_INPUT", "排队版本无效", 400);
  }
  return revision;
}

function parseApprovalAnswers(value: unknown): Record<string, string[]> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || Object.keys(value).length > 20) {
    throw new ProductHttpError("INVALID_INPUT", "回答内容无效", 400);
  }
  const result: Record<string, string[]> = {};
  for (const [id, answers] of Object.entries(value)) {
    const answerList = Array.isArray(answers) ? (answers as unknown[]) : undefined;
    if (
      !id ||
      id.length > 128 ||
      answerList === undefined ||
      answerList.some((answer) => typeof answer !== "string")
    ) {
      throw new ProductHttpError("INVALID_INPUT", "回答内容无效", 400);
    }
    result[id] = answerList.filter((answer): answer is string => typeof answer === "string");
  }
  return result;
}

function routeParameter(request: FastifyRequest, name: string): string {
  return requireString(asRecord(request.params)[name], "请求路径无效");
}

function requireQueue(queue: SidecarTurnQueueApi | undefined): SidecarTurnQueueApi {
  if (!queue) {
    throw new ProductHttpError("QUEUE_UNAVAILABLE", "远程消息队列尚未就绪，请稍后重试", 503);
  }
  return queue;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 16_384) {
    throw new ProductHttpError("INVALID_INPUT", message, 400);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384
    ? value
    : undefined;
}

function optionalNullableSetting(
  body: Record<string, unknown>,
  key: keyof ThreadSettingsInput,
  message: string,
): string | null | undefined {
  if (!Object.hasOwn(body, key)) {
    return undefined;
  }
  const value = body[key];
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value
  ) {
    throw new ProductHttpError("INVALID_INPUT", message, 400);
  }
  return value;
}

function nullableSetting<K extends keyof ThreadSettingsInput>(
  body: Record<string, unknown>,
  key: K,
  message: string,
): Partial<Pick<ThreadSettingsInput, K>> {
  const value = optionalNullableSetting(body, key, message);
  return value === undefined ? {} : ({ [key]: value } as Partial<Pick<ThreadSettingsInput, K>>);
}

function optionalInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    return Number(value);
  }
  return undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  return undefined;
}

function isReasoningEffort(value: unknown): value is NonNullable<SendTurnInput["reasoningEffort"]> {
  return (
    typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 64
  );
}

function isPermissionMode(
  value: unknown,
): value is NonNullable<CreateThreadInput["permissionMode"]> {
  return value === "read-only" || value === "workspace-write" || value === "ask";
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function firstForwardedValue(value: string | string[] | undefined): string | undefined {
  const header = headerValue(value);
  return header?.split(",", 1)[0]?.trim();
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }
  const normalized = address.toLocaleLowerCase("en-US");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

function contentDisposition(kind: "attachment" | "inline", relativePath: string): string {
  const name = relativePath.split(/[\\/]/u).at(-1) ?? "file";
  const fallback = name.replace(/[^\x20-\x7E]/gu, "_").replace(/["\\]/gu, "_");
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function unauthenticated(): ProductHttpError {
  return new ProductHttpError("AUTHENTICATION_REQUIRED", "请先登录", 401);
}

function apiError(code: string, message: string, requestId: string | undefined): ApiError {
  return {
    error: {
      code,
      message,
      ...(requestId === undefined ? {} : { requestId }),
    },
  };
}

function projectError(error: unknown, requestId: string): { body: ApiError; status: number } {
  if (
    error instanceof ProductHttpError ||
    error instanceof DomainError ||
    error instanceof ApprovalResolutionError ||
    error instanceof OutboxConflictError
  ) {
    return {
      body: apiError(error.code, error.message, requestId),
      status: error.httpStatus,
    };
  }
  if (
    error instanceof RpcConnectionClosedError ||
    error instanceof RpcTimeoutError ||
    error instanceof SharedAppServerConnectionError
  ) {
    return {
      body: apiError("DESKTOP_RUNTIME_NOT_READY", "电脑端连接正在恢复，请稍后重试", requestId),
      status: 503,
    };
  }
  const statusCode = asRecord(error).statusCode;
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
    return {
      body: apiError("INVALID_REQUEST", "请求内容无效", requestId),
      status: statusCode,
    };
  }
  return {
    body: apiError("INTERNAL_ERROR", "电脑端暂时无法完成这个请求", requestId),
    status: 500,
  };
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}
