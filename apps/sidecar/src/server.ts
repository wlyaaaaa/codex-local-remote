import { stat } from "node:fs/promises";

import type {
  ApiError,
  AuthSession,
  CollaborationModeOption,
  CreateThreadInput,
  DiagnosticSnapshot,
  ModelOption,
  ProjectSummary,
  PublicBootstrap,
  RemoteEvent,
  SendTurnInput,
  ThreadDetail,
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
import type { SidecarConfig } from "./config.js";
import { ProductHttpError } from "./errors.js";
import { getProjectDownload, getProjectPreview, listProjectFiles } from "./files.js";
import type { SessionLookup, SidecarStateStore } from "./state-store.js";

const SESSION_COOKIE = "codex_remote_session";
const PRODUCT_NAME = "Codex Local Remote";
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u;

export interface SidecarDomainApi {
  compactThread(threadId: string): Promise<void>;
  createThread(input: CreateThreadInput): Promise<ServiceResult<ThreadDetail>>;
  getThread(threadId: string): Promise<ThreadDetail>;
  getUsage(threadId?: string): Promise<ServiceResult<UsageSnapshot>>;
  interruptTurn(threadId: string, turnId: string): Promise<TurnCommandResult>;
  listCollaborationModes(): Promise<ServiceResult<CollaborationModeOption[]>>;
  listModels(): Promise<ServiceResult<ModelOption[]>>;
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
  setThreadName(threadId: string, name: string): Promise<void>;
  startTurn(threadId: string, input: SendTurnInput): Promise<TurnCommandResult>;
  steerTurn(threadId: string, turnId: string, prompt: string): Promise<TurnCommandResult>;
}

export interface CreateSidecarServerOptions {
  approvals: ApprovalCoordinator;
  config: SidecarConfig;
  diagnostics: () => DiagnosticSnapshot;
  domain: SidecarDomainApi;
  events: RemoteEventBuffer;
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
  const { approvals, config, diagnostics, domain, events, state } = options;
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    logger: false,
    trustProxy: (address) => isLoopbackAddress(address),
  });
  const api = `${config.basePath}/api/v1`;
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

  app.get(`${api}/collaboration-modes`, async (request) => {
    await requireAuthentication(request, state);
    return unwrapServiceResult(await domain.listCollaborationModes(), events);
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
    return await domain.getThread(routeParameter(request, "threadId"));
  });

  app.post(`${api}/threads`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      const created = await domain.createThread(parseCreateThreadInput(request.body));
      publishDegradations(created.degradations, events);
      return { body: created.data, status: 201 };
    });
    return await sendCached(reply, result);
  });

  app.post(`${api}/threads/:threadId/resume`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => ({
      body: await domain.resumeThread(routeParameter(request, "threadId")),
      status: 200,
    }));
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

  app.post(`${api}/threads/:threadId/turns`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      const threadId = routeParameter(request, "threadId");
      await domain.startTurn(threadId, parseSendTurnInput(request.body));
      return { body: await domain.getThread(threadId), status: 200 };
    });
    return await sendCached(reply, result);
  });

  app.post(`${api}/threads/:threadId/turns/:turnId/steer`, async (request, reply) => {
    const authentication = await requireProtectedMutation(request, state);
    const result = await runIdempotent(request, authentication, idempotencyCache, async () => {
      await domain.steerTurn(
        routeParameter(request, "threadId"),
        routeParameter(request, "turnId"),
        requireString(asRecord(request.body).prompt, "请输入补充要求"),
      );
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
    await requireAuthentication(request, state);
    openEventStream(request, reply, events);
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
  const key = headerValue(request.headers["idempotency-key"]);
  if (!key || !IDEMPOTENCY_KEY.test(key)) {
    throw new ProductHttpError("IDEMPOTENCY_KEY_REQUIRED", "请求标识缺失，请刷新页面后重试", 400);
  }
  const cacheKey = [
    authentication.record.tokenDigest,
    request.method,
    request.routeOptions.url,
    key,
  ].join(":");
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

function openEventStream(
  request: FastifyRequest,
  reply: FastifyReply,
  events: RemoteEventBuffer,
): void {
  const raw = reply.raw;
  reply.hijack();
  raw.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
  });
  const lastEventId = optionalInteger(headerValue(request.headers["last-event-id"]));
  const replay = events.replayAfter(lastEventId);
  const unsubscribe = events.subscribe((event) => {
    writeEvent(raw, event);
  });
  if (replay.resetRequired) {
    writeEvent(raw, events.createResetEvent());
  } else {
    for (const event of replay.events) {
      writeEvent(raw, event);
    }
  }
  const ready: RemoteEvent = {
    emittedAt: new Date().toISOString(),
    payload: { latestSequence: events.latestSequence },
    schemaVersion: API_SCHEMA_VERSION,
    seq: events.latestSequence,
    type: "connection.ready",
  };
  writeEvent(raw, ready);
  const heartbeat = setInterval(() => {
    if (!raw.destroyed) {
      raw.write(": keepalive\n\n");
    }
  }, 25_000);
  heartbeat.unref();
  raw.once("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function writeEvent(stream: FastifyReply["raw"], event: RemoteEvent): void {
  if (!stream.destroyed) {
    stream.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
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
  const collaborationMode = optionalString(body.collaborationMode);
  const model = optionalString(body.model);
  return {
    projectId: requireString(body.projectId, "请选择项目"),
    prompt: requireString(body.prompt, "请输入消息"),
    ...(collaborationMode === undefined ? {} : { collaborationMode }),
    ...(model === undefined ? {} : { model }),
    ...(isPermissionMode(body.permissionMode) ? { permissionMode: body.permissionMode } : {}),
    ...(isReasoningEffort(body.reasoningEffort) ? { reasoningEffort: body.reasoningEffort } : {}),
  };
}

function parseSendTurnInput(value: unknown): SendTurnInput {
  const body = asRecord(value);
  const model = optionalString(body.model);
  return {
    prompt: requireString(body.prompt, "请输入消息"),
    ...(model === undefined ? {} : { model }),
    ...(isReasoningEffort(body.reasoningEffort) ? { reasoningEffort: body.reasoningEffort } : {}),
  };
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
    error instanceof ApprovalResolutionError
  ) {
    return {
      body: apiError(error.code, error.message, requestId),
      status: error.httpStatus,
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
