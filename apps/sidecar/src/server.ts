import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

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
import { HostFileStore } from "./host-files.js";
import {
  isCanonicalMaintenanceUpdateId,
  isHighEntropyMaintenanceToken,
  MaintenanceDrainTimeoutError,
  type MaintenanceMutationLease,
  MaintenanceUpdateConflictError,
  matchesMaintenanceBearer,
  SidecarMaintenanceController,
} from "./maintenance.js";
import type { SessionLookup, SidecarStateStore } from "./state-store.js";
import type { SidecarTurnQueueApi } from "./turn-queue.js";
import { OutboxConflictError } from "./turn-outbox.js";

const SESSION_COOKIE = "codex_remote_session";
const PRODUCT_NAME = "Codex Local Remote";
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const RECENT_THREAD_DETAIL_CACHE_CAPACITY = 8;
const EVENT_STREAM_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const EVENT_STREAM_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const EVENT_STREAM_MAX_QUEUED_EVENTS = 256;

export interface SidecarDomainApi {
  compactThread(threadId: string): Promise<void>;
  createThread(input: CreateThreadInput): Promise<ServiceResult<ThreadDetail>>;
  getThread(
    threadId: string,
    options?: { historyCursor?: string; includeTurns?: boolean },
  ): Promise<ThreadDetail>;
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
  setThreadArchived(threadId: string, archived: boolean): Promise<void>;
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
  hostFiles?: HostFileStore;
  maintenanceController?: SidecarMaintenanceController;
  maintenanceDrainTimeoutMs?: number;
  maintenanceToken?: string;
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

interface TrackedMutation {
  handlerStarted: boolean;
  lease: MaintenanceMutationLease;
}

interface EventStreamWriterOptions {
  canWrite?: () => boolean;
  createOverflowEvent?: () => RemoteEvent;
  maxFrameBytes?: number;
  maxQueuedBytes?: number;
  maxQueuedEvents?: number;
  onFailure: (reason: EventStreamWriterFailure) => void;
  stream: FastifyReply["raw"];
  streamInstanceId: string;
}

export type EventStreamWriterFailure = "overflow" | "transport";

export interface EventStreamWriter {
  close(): void;
  writeEvent(event: RemoteEvent): boolean;
  writeKeepalive(): boolean;
}

interface CachedThreadDetail {
  detail: ThreadDetail;
  snapshotEventSeq: number;
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
  const maintenanceDrainPath = `${config.basePath}/_control/drain`;
  if (
    options.maintenanceToken !== undefined &&
    !isHighEntropyMaintenanceToken(options.maintenanceToken)
  ) {
    throw new Error("Sidecar maintenance token is invalid");
  }
  const maintenance =
    options.maintenanceController ??
    new SidecarMaintenanceController(options.maintenanceDrainTimeoutMs);
  const mutations = new WeakMap<FastifyRequest, TrackedMutation>();
  const releaseMutation = (request: FastifyRequest) => {
    mutations.get(request)?.lease.release();
    mutations.delete(request);
  };
  const uploads = await BrowserUploadStore.open(config.dataDir);
  const hostFiles = options.hostFiles ?? (await HostFileStore.open());
  const streamInstanceId = randomUUID();
  const idempotencyCache = new Map<string, Promise<CachedCommand>>();
  const runIdempotent = async (
    request: FastifyRequest,
    authentication: AuthenticatedRequest,
    cache: Map<string, Promise<CachedCommand>>,
    command: () => Promise<CachedCommand>,
  ): Promise<CachedCommand> =>
    await runPersistedIdempotent(request, authentication, cache, state, command);
  const recentThreadDetails = new Map<string, CachedThreadDetail>();
  const recentThreadSnapshotWatermarks = new Map<string, number>();
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
    if (isMutatingHttpMethod(request.method) && request.url !== maintenanceDrainPath) {
      const lease = maintenance.tryAdmitActivity();
      if (lease === undefined) {
        reply.header("Retry-After", "1");
        throw new ProductHttpError("SIDECAR_DRAINING", "服务正在安全更新，请稍后重试", 503);
      }
      mutations.set(request, { handlerStarted: false, lease });
    }
  });

  app.addHook("preHandler", (request, _reply, done) => {
    const mutation = mutations.get(request);
    if (mutation !== undefined) {
      mutation.handlerStarted = true;
    }
    done();
  });

  app.addHook("onRequestAbort", (request, done) => {
    if (mutations.get(request)?.handlerStarted === false) {
      releaseMutation(request);
    }
    done();
  });

  app.addHook("onSend", async (request, _reply, payload) => {
    releaseMutation(request);
    return payload;
  });

  app.addHook("onError", (request, _reply, _error, done) => {
    releaseMutation(request);
    done();
  });

  app.addHook("onResponse", (request, _reply, done) => {
    releaseMutation(request);
    done();
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

  if (options.maintenanceToken !== undefined) {
    const maintenanceToken = options.maintenanceToken;
    app.post(maintenanceDrainPath, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!isLoopbackAddress(request.raw.socket.remoteAddress) || !isLoopbackAddress(request.ip)) {
        throw new ProductHttpError(
          "MAINTENANCE_LOOPBACK_REQUIRED",
          "维护控制入口仅供本机使用",
          403,
        );
      }
      if (!matchesMaintenanceBearer(maintenanceToken, headerValue(request.headers.authorization))) {
        throw new ProductHttpError("MAINTENANCE_CAPABILITY_REQUIRED", "维护能力验证失败", 401);
      }
      const updateId = headerValue(request.headers["x-codex-update-id"]);
      if (!isCanonicalMaintenanceUpdateId(updateId)) {
        throw new ProductHttpError("INVALID_UPDATE_ID", "更新标识无效", 400);
      }
      try {
        return await maintenance.drain(updateId);
      } catch (error) {
        if (error instanceof MaintenanceDrainTimeoutError) {
          reply.header("Retry-After", "1");
          throw new ProductHttpError(
            "SIDECAR_DRAIN_TIMEOUT",
            "仍有已接纳操作正在完成，请稍后重试",
            503,
          );
        }
        if (error instanceof MaintenanceUpdateConflictError) {
          throw new ProductHttpError(
            "SIDECAR_DRAIN_UPDATE_CONFLICT",
            "Sidecar 正在为另一更新排空",
            409,
          );
        }
        throw error;
      }
    });
  }

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
    const password = requireString(asRecord(request.body).password, "请输入访问密码");
    const now = Date.now();
    const source = loginRateSource(request);
    const decision = loginLimiter.reserveAttempt(source, now);
    if (!decision.allowed) {
      reply.header("Retry-After", String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))));
      throw new ProductHttpError("LOGIN_RATE_LIMITED", "尝试次数过多，请稍后再试", 429);
    }
    let verified: boolean;
    try {
      verified = await state.verifyPassword(password);
    } catch (error) {
      loginLimiter.cancelAttempt(source, Date.now());
      throw error;
    }
    if (!verified) {
      loginLimiter.recordFailure(source, Date.now());
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
    const historyCursor = optionalString(query.historyCursor);
    const threadId = routeParameter(request, "threadId");
    if (includeItems && historyCursor === undefined) {
      const snapshotEventSeq = events.latestSequence;
      rememberThreadSnapshotWatermark(threadId, snapshotEventSeq);
      return await loadRecentThreadDetail(threadId, snapshotEventSeq);
    }
    const snapshotEventSeq = events.latestSequence;
    const detail =
      includeItems && historyCursor !== undefined
        ? await domain.getThread(threadId, { historyCursor })
        : await domain.getThread(threadId, { includeTurns: false });
    return attachSnapshotEventSequence(detail, snapshotEventSeq, streamInstanceId);
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
      rememberThreadDetail(created.data, snapshotEventSeq);
      return {
        body: attachSnapshotEventSequence(created.data, snapshotEventSeq, streamInstanceId),
        status: 201,
      };
    });
    return await sendCached(reply, result);
  });

  app.post(`${api}/threads/:threadId/resume`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      const snapshotEventSeq = events.latestSequence;
      const threadId = routeParameter(request, "threadId");
      const detail = await domain.resumeThread(threadId);
      rememberThreadDetail(detail, snapshotEventSeq);
      return {
        body: attachSnapshotEventSequence(detail, snapshotEventSeq, streamInstanceId),
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
      const threadId = routeParameter(request, "threadId");
      await domain.setThreadName(
        threadId,
        requireString(asRecord(request.body).name, "请输入对话名称"),
      );
      recentThreadDetails.delete(threadId);
      return { status: 204 };
    });
    return await sendCached(reply, result);
  });

  app.put(`${api}/threads/:threadId/archive`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      const threadId = routeParameter(request, "threadId");
      await domain.setThreadArchived(
        threadId,
        requireBoolean(asRecord(request.body).archived, "请选择归档或恢复"),
      );
      recentThreadDetails.delete(threadId);
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
        body: await loadRecentThreadDetail(threadId, snapshotEventSeq, false),
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
    if (page.historyIntegrity) {
      reply.header(
        "X-Subagent-History-Integrity",
        encodeURIComponent(JSON.stringify(page.historyIntegrity)),
      );
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

  app.get(`${api}/file-roots`, async (request) => {
    await requireAuthentication(request, state);
    return hostFiles.roots();
  });

  app.get(`${api}/files`, async (request) => {
    await requireAuthentication(request, state);
    const query = asRecord(request.query);
    const projectId = requireString(query.projectId, "请选择磁盘或项目");
    const relativePath = optionalString(query.path) ?? "";
    return hostFiles.isHostProject(projectId)
      ? await hostFiles.list(projectId, relativePath)
      : await listProjectFiles(state, projectId, relativePath);
  });

  app.get(`${api}/files/resolve`, async (request) => {
    await requireAuthentication(request, state);
    const query = asRecord(request.query);
    const projectId = optionalString(query.projectId);
    const sourcePath = requireString(query.path, "请选择文件");
    if (projectId === undefined) {
      try {
        return await uploads.resolveHistoryPath(sourcePath);
      } catch (error) {
        if (
          !(error instanceof ProductHttpError) ||
          error.code !== "UPLOAD_HISTORY_NOT_APPLICABLE"
        ) {
          throw error;
        }
      }
      if (path.isAbsolute(sourcePath)) {
        return await hostFiles.grantAbsolutePath(sourcePath);
      }
    }
    return hostFiles.isHostProject(projectId)
      ? await hostFiles.resolve(requireString(projectId, "请选择磁盘"), sourcePath)
      : await resolveProjectFileReference(state, projectId, sourcePath);
  });

  app.get(`${api}/files/preview`, async (request, reply) => {
    await requireAuthentication(request, state);
    const query = asRecord(request.query);
    const relativePath = requireString(query.path, "请选择文件");
    const projectId = requireString(query.projectId, "请选择项目");
    const file = uploads.isHistoryProject(projectId)
      ? await uploads.getPreview(projectId, relativePath)
      : hostFiles.isHostProject(projectId)
        ? await hostFiles.getPreview(projectId, relativePath)
        : await getProjectPreview(state, projectId, relativePath);
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
    const projectId = requireString(query.projectId, "请选择项目");
    const file = uploads.isHistoryProject(projectId)
      ? await uploads.getDownload(projectId, relativePath)
      : hostFiles.isHostProject(projectId)
        ? await hostFiles.getDownload(projectId, relativePath)
        : await getProjectDownload(state, projectId, relativePath);
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

  app.post(`${api}/files/folders`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      const body = asRecord(request.body);
      const projectId = requireHostMutationProject(hostFiles, body.projectId);
      await hostFiles.createDirectory(projectId, requireString(body.path, "请输入文件夹名称"));
      return { status: 204 };
    });
    return await sendCached(reply, result);
  });

  app.put(`${api}/files/content`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      const query = asRecord(request.query);
      const projectId = requireHostMutationProject(hostFiles, query.projectId);
      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        throw new ProductHttpError("INVALID_FILE_CONTENT", "上传内容无效", 400);
      }
      await hostFiles.writeFile(
        projectId,
        requireString(query.path, "请输入文件名"),
        body,
        optionalBoolean(query.overwrite) ?? false,
      );
      return { status: 204 };
    });
    return await sendCached(reply, result);
  });

  app.post(`${api}/files/rename`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      const body = asRecord(request.body);
      const projectId = requireHostMutationProject(hostFiles, body.projectId);
      await hostFiles.rename(
        projectId,
        requireString(body.path, "请选择文件"),
        requireString(body.name, "请输入新名称"),
      );
      return { status: 204 };
    });
    return await sendCached(reply, result);
  });

  app.post(`${api}/files/copy`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      const body = asRecord(request.body);
      await hostFiles.copy({
        sourcePath: requireString(body.sourcePath, "请选择源文件"),
        sourceProjectId: requireHostMutationProject(hostFiles, body.sourceProjectId),
        targetPath: requireString(body.targetPath, "请选择目标位置"),
        targetProjectId: requireHostMutationProject(hostFiles, body.targetProjectId),
        overwrite: optionalBoolean(body.overwrite) ?? false,
      });
      return { status: 204 };
    });
    return await sendCached(reply, result);
  });

  app.post(`${api}/files/move`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      const body = asRecord(request.body);
      await hostFiles.move({
        sourcePath: requireString(body.sourcePath, "请选择源文件"),
        sourceProjectId: requireHostMutationProject(hostFiles, body.sourceProjectId),
        targetPath: requireString(body.targetPath, "请选择目标位置"),
        targetProjectId: requireHostMutationProject(hostFiles, body.targetProjectId),
        overwrite: optionalBoolean(body.overwrite) ?? false,
      });
      return { status: 204 };
    });
    return await sendCached(reply, result);
  });

  app.delete(`${api}/files`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      const body = asRecord(request.body);
      const projectId = requireHostMutationProject(hostFiles, body.projectId);
      await hostFiles.delete(
        projectId,
        requireString(body.path, "请选择文件"),
        optionalBoolean(body.permanent) ?? false,
      );
      return { status: 204 };
    });
    return await sendCached(reply, result);
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
    const cachedDetailSequence =
      queryCursor === undefined && threadId !== undefined
        ? recentThreadDetails.get(threadId)?.snapshotEventSeq
        : undefined;
    const provisionalSequence =
      queryCursor === undefined && threadId !== undefined
        ? recentThreadSnapshotWatermarks.get(threadId)
        : undefined;
    const cachedSnapshotEventSeq =
      cachedDetailSequence === undefined
        ? provisionalSequence
        : provisionalSequence === undefined
          ? cachedDetailSequence
          : Math.min(cachedDetailSequence, provisionalSequence);
    openEventStream(
      request,
      reply,
      events,
      streamInstanceId,
      state,
      authentication.record.tokenDigest,
      queryCursor,
      threadId,
      cachedSnapshotEventSeq,
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

  async function loadRecentThreadDetail(
    threadId: string,
    fallbackSnapshotEventSeq = events.latestSequence,
    includeItems = true,
  ): Promise<ThreadDetail> {
    if (!includeItems) {
      const detail = await domain.getThread(threadId, { includeTurns: false });
      return attachSnapshotEventSequence(detail, fallbackSnapshotEventSeq, streamInstanceId);
    }

    const cached = recentThreadDetails.get(threadId);
    if (cached !== undefined) {
      if (!events.replayAfter(cached.snapshotEventSeq).resetRequired) {
        return attachSnapshotEventSequence(
          {
            ...cached.detail,
            items: [...cached.detail.items],
          },
          cached.snapshotEventSeq,
          streamInstanceId,
        );
      }
      recentThreadDetails.delete(threadId);
    }

    const detail = await domain.getThread(threadId);
    rememberThreadDetail(detail, fallbackSnapshotEventSeq);
    return attachSnapshotEventSequence(detail, fallbackSnapshotEventSeq, streamInstanceId);
  }

  function rememberThreadDetail(detail: ThreadDetail, snapshotEventSeq: number): void {
    rememberThreadSnapshotWatermark(detail.id, snapshotEventSeq);
    recentThreadDetails.delete(detail.id);
    recentThreadDetails.set(detail.id, {
      detail: {
        ...detail,
        items: [...detail.items],
      },
      snapshotEventSeq,
    });
    while (recentThreadDetails.size > RECENT_THREAD_DETAIL_CACHE_CAPACITY) {
      const oldestThreadId = recentThreadDetails.keys().next().value;
      if (oldestThreadId === undefined) break;
      recentThreadDetails.delete(oldestThreadId);
    }
  }

  function rememberThreadSnapshotWatermark(threadId: string, snapshotEventSeq: number): void {
    const existing = recentThreadSnapshotWatermarks.get(threadId);
    const reusableExisting = existing !== undefined && !events.replayAfter(existing).resetRequired;
    recentThreadSnapshotWatermarks.delete(threadId);
    recentThreadSnapshotWatermarks.set(
      threadId,
      reusableExisting ? Math.min(existing, snapshotEventSeq) : snapshotEventSeq,
    );
    while (recentThreadSnapshotWatermarks.size > RECENT_THREAD_DETAIL_CACHE_CAPACITY) {
      const oldestThreadId = recentThreadSnapshotWatermarks.keys().next().value;
      if (oldestThreadId === undefined) break;
      recentThreadSnapshotWatermarks.delete(oldestThreadId);
    }
  }

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

async function runPersistedIdempotent(
  request: FastifyRequest,
  authentication: AuthenticatedRequest,
  cache: Map<string, Promise<CachedCommand>>,
  state: SidecarStateStore,
  command: () => Promise<CachedCommand>,
): Promise<CachedCommand> {
  const cacheKey = requireIdempotencyScope(request, authentication);
  const cached = cache.get(cacheKey);
  if (cached) {
    return await cached;
  }
  const pending = (async () => {
    const reservation = await state.reserveMutation(cacheKey, Date.now());
    if (reservation !== "reserved") {
      throw new ProductHttpError(
        "IDEMPOTENCY_REPLAY_REQUIRES_REFRESH",
        reservation === "completed"
          ? "这项操作已经完成，请刷新页面查看最新状态"
          : "上次操作的结果仍在确认中，请刷新页面查看最新状态",
        409,
      );
    }
    let result: CachedCommand;
    try {
      result = await command();
    } catch (error) {
      await state.releaseMutation(cacheKey);
      throw error;
    }
    await state.completeMutation(cacheKey, Date.now());
    return result;
  })();
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

function attachSnapshotEventSequence(
  detail: ThreadDetail,
  snapshotEventSeq: number,
  streamInstanceId: string,
): ThreadDetail {
  return {
    ...detail,
    snapshotEventCursor: `${streamInstanceId}:${snapshotEventSeq}`,
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
  freshReplayAfterSequence?: number,
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
      ? events.replayAfter(freshReplayAfterSequence ?? events.latestSequence)
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
    raw.off("close", closeStream);
    unsubscribe();
    writer.close();
    if (!raw.destroyed && !raw.writableEnded) {
      raw.end();
    }
  };
  const writer = createEventStreamWriter({
    canWrite: () => state.isSessionActive(sessionTokenDigest, Date.now()),
    createOverflowEvent: () => events.createResetEvent(),
    onFailure: closeStream,
    stream: raw,
    streamInstanceId,
  });
  const writeAuthenticatedEvent = (event: RemoteEvent): boolean => {
    if (!eventMatchesSubscription(event, threadId)) {
      return true;
    }
    if (!state.isSessionActive(sessionTokenDigest, Date.now())) {
      closeStream();
      return false;
    }
    return writer.writeEvent(event);
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
    writer.writeKeepalive();
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

export function createEventStreamWriter(options: EventStreamWriterOptions): EventStreamWriter {
  const {
    canWrite = () => true,
    createOverflowEvent,
    maxFrameBytes = EVENT_STREAM_MAX_FRAME_BYTES,
    maxQueuedBytes = EVENT_STREAM_MAX_QUEUED_BYTES,
    maxQueuedEvents = EVENT_STREAM_MAX_QUEUED_EVENTS,
    onFailure,
    stream,
    streamInstanceId,
  } = options;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
    throw new RangeError("SSE frame byte limit must be a positive integer");
  }
  if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes < 1) {
    throw new RangeError("SSE queued byte limit must be a positive integer");
  }
  if (!Number.isSafeInteger(maxQueuedEvents) || maxQueuedEvents < 1) {
    throw new RangeError("SSE queued event limit must be a positive integer");
  }

  const queue: Array<{ bytes: number; frame: string }> = [];
  let closed = false;
  let queuedBytes = 0;
  let resetThroughSequence: number | undefined;
  let waitingForDrain = false;

  const clearQueue = () => {
    queue.length = 0;
    queuedBytes = 0;
  };
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (waitingForDrain) {
      stream.off("drain", drainQueue);
      waitingForDrain = false;
    }
    clearQueue();
  };
  const fail = (reason: EventStreamWriterFailure): false => {
    if (!closed) {
      close();
      onFailure(reason);
    }
    return false;
  };
  const writeNow = (frame: string): "drain" | "failed" | "ready" => {
    if (closed || stream.destroyed || stream.writableEnded) {
      return "failed";
    }
    try {
      if (!canWrite()) {
        return "failed";
      }
      return stream.write(frame) ? "ready" : "drain";
    } catch {
      return "failed";
    }
  };
  const waitForDrain = () => {
    waitingForDrain = true;
    stream.once("drain", drainQueue);
  };
  const recoverOverflow = (): boolean => {
    if (createOverflowEvent === undefined || closed || stream.destroyed || stream.writableEnded) {
      return fail("overflow");
    }
    let reset: RemoteEvent;
    let frame: string;
    try {
      if (!canWrite()) {
        return fail("transport");
      }
      reset = createOverflowEvent();
      frame = formatEventStreamEvent(reset, streamInstanceId);
    } catch {
      return fail("overflow");
    }
    const bytes = Buffer.byteLength(frame, "utf8");
    if (bytes > maxFrameBytes || bytes > maxQueuedBytes) {
      return fail("overflow");
    }

    clearQueue();
    resetThroughSequence = Math.max(resetThroughSequence ?? 0, reset.seq);
    if (waitingForDrain) {
      queue.push({ bytes, frame });
      queuedBytes = bytes;
      return true;
    }

    const result = writeNow(frame);
    if (result === "failed") {
      return fail("transport");
    }
    if (result === "drain") {
      waitForDrain();
    }
    return true;
  };
  const enqueue = (frame: string): boolean => {
    const bytes = Buffer.byteLength(frame, "utf8");
    if (queue.length >= maxQueuedEvents || bytes > maxQueuedBytes - queuedBytes) {
      return recoverOverflow();
    }
    queue.push({ bytes, frame });
    queuedBytes += bytes;
    return true;
  };
  function drainQueue(): void {
    waitingForDrain = false;
    while (queue.length > 0) {
      const pending = queue.shift();
      if (pending === undefined) {
        break;
      }
      queuedBytes -= pending.bytes;
      const result = writeNow(pending.frame);
      if (result === "failed") {
        fail("transport");
        return;
      }
      if (result === "drain") {
        waitForDrain();
        return;
      }
    }
  }
  const writeFrame = (frame: string): boolean => {
    if (closed) {
      return false;
    }
    if (Buffer.byteLength(frame, "utf8") > maxFrameBytes) {
      return recoverOverflow();
    }
    if (waitingForDrain) {
      return enqueue(frame);
    }
    const result = writeNow(frame);
    if (result === "failed") {
      return fail("transport");
    }
    if (result === "drain") {
      waitForDrain();
    }
    return true;
  };

  return {
    close,
    writeEvent(event: RemoteEvent): boolean {
      if (
        resetThroughSequence !== undefined &&
        event.type !== "connection.ready" &&
        event.seq <= resetThroughSequence
      ) {
        return true;
      }
      try {
        return writeFrame(formatEventStreamEvent(event, streamInstanceId));
      } catch {
        return fail("transport");
      }
    },
    writeKeepalive(): boolean {
      if (waitingForDrain) {
        // Pending event data already keeps the connection active; do not spend bounded queue space
        // on heartbeat comments that carry no cursor or product state.
        return true;
      }
      return writeFrame(": keepalive\n\n");
    },
  };
}

function formatEventStreamEvent(event: RemoteEvent, streamInstanceId: string): string {
  return `id: ${streamInstanceId}:${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
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
  const objective = Object.hasOwn(body, "objective")
    ? requireString(body.objective, "请输入目标")
    : undefined;
  const status = Object.hasOwn(body, "status") ? body.status : undefined;
  if (status !== undefined && !isThreadGoalStatus(status)) {
    throw new ProductHttpError("INVALID_INPUT", "目标状态无效", 400);
  }
  const tokenBudget = optionalInteger(body.tokenBudget);
  if (Object.hasOwn(body, "tokenBudget") && (tokenBudget === undefined || tokenBudget <= 0)) {
    throw new ProductHttpError("INVALID_INPUT", "目标额度必须是正整数", 400);
  }
  if (objective === undefined && status === undefined && tokenBudget === undefined) {
    throw new ProductHttpError("INVALID_INPUT", "目标修改不能为空", 400);
  }
  return {
    ...(objective === undefined ? {} : { objective }),
    ...(status === undefined ? {} : { status }),
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

function requireHostMutationProject(hostFiles: HostFileStore, value: unknown): string {
  const projectId = requireString(value, "请选择磁盘");
  if (!projectId.startsWith("host-root:") || !hostFiles.isHostProject(projectId)) {
    throw new ProductHttpError(
      "FILE_MUTATION_ROOT_REQUIRED",
      "请选择本机磁盘后再执行文件操作",
      400,
    );
  }
  return projectId;
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

function requireBoolean(value: unknown, message: string): boolean {
  if (value === true || value === false) {
    return value;
  }
  throw new ProductHttpError("INVALID_INPUT", message, 400);
}

function isReasoningEffort(value: unknown): value is NonNullable<SendTurnInput["reasoningEffort"]> {
  return (
    typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 64
  );
}

function isThreadGoalStatus(value: unknown): value is NonNullable<SetThreadGoalInput["status"]> {
  return (
    value === "active" ||
    value === "paused" ||
    value === "blocked" ||
    value === "usageLimited" ||
    value === "budgetLimited" ||
    value === "complete"
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

function isMutatingHttpMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
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
