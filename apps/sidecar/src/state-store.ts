import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SessionRecord } from "@codex-local-remote/security";
import {
  createSession,
  digestSessionToken,
  touchSession,
  validateSafeWindowsProjectRoot,
  validateSession,
  verifyPassword,
} from "@codex-local-remote/security";

import type { RegisteredProject } from "@codex-local-remote/domain";

const STATE_SCHEMA_VERSION = 5;
const ABSOLUTE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const IDLE_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const SESSION_PERSIST_INTERVAL_MS = 60_000;
const MAX_CSRF_GENERATIONS = 8;
const MAX_MUTATION_RECEIPTS = 1_000;

interface StoredSession extends SessionRecord {
  csrfDigests: string[];
}

interface ProjectRootIdentity {
  dev: string;
  ino: string;
}

interface PersistedRegisteredProject {
  id: string;
  name: string;
  root: string;
  rootIdentity: ProjectRootIdentity;
  source: "registered";
}

interface PersistedMutationReceipt {
  state: "completed" | "started";
  updatedAtMs: number;
}

export interface PersistedArchiveIntent {
  desktopNotificationPending: boolean;
  managed: boolean;
  targetArchived: boolean;
  threadId: string;
}

interface PersistedState {
  archiveIntents: PersistedArchiveIntent[];
  managedThreadIds: string[];
  mutationReceipts: Record<string, PersistedMutationReceipt>;
  pendingDesktopNotificationThreadIds: string[];
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  passwordHash?: string;
  projects: PersistedRegisteredProject[];
  sessions: Record<string, StoredSession>;
}

export type SessionLookup =
  | { valid: false }
  | {
      valid: true;
      record: SessionRecord;
      csrfDigest: string;
      csrfDigests: string[];
    };

export class SidecarStateStore {
  readonly #dataDir: string;
  readonly #lastSessionPersistedAt = new Map<string, number>();
  readonly #statePath: string;
  #state: PersistedState;
  #writeChain: Promise<void> = Promise.resolve();

  private constructor(dataDir: string, state: PersistedState) {
    this.#dataDir = dataDir;
    this.#statePath = path.join(dataDir, "state.json");
    this.#state = state;
    for (const session of Object.values(state.sessions)) {
      this.#lastSessionPersistedAt.set(session.tokenDigest, session.lastSeenAtMs);
    }
  }

  static async open(dataDir: string): Promise<SidecarStateStore> {
    await mkdir(dataDir, { recursive: true });
    const statePath = path.join(dataDir, "state.json");
    let state = emptyState();
    try {
      state = parseState(await readFile(statePath, "utf8"));
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new Error("Sidecar 本机状态无法读取");
      }
    }
    return new SidecarStateStore(dataDir, state);
  }

  static async createTemporaryDirectoryForTests(prefix: string): Promise<string> {
    return await mkdtemp(prefix);
  }

  get configured(): boolean {
    return typeof this.#state.passwordHash === "string";
  }

  listProjects(): RegisteredProject[] {
    return this.#state.projects.map(({ id, name, root, source }) => ({ id, name, root, source }));
  }

  listManagedThreadIds(): string[] {
    return [...this.#state.managedThreadIds];
  }

  listPendingDesktopNotificationThreadIds(): string[] {
    return [...this.#state.pendingDesktopNotificationThreadIds];
  }

  listArchiveIntents(): PersistedArchiveIntent[] {
    return this.#state.archiveIntents.map((intent) => ({ ...intent }));
  }

  async verifyPassword(password: string): Promise<boolean> {
    const encodedHash = this.#state.passwordHash;
    return encodedHash ? await verifyPassword(password, encodedHash) : false;
  }

  async setPasswordHash(encodedHash: string): Promise<void> {
    await this.#commitState((current) => ({
      ...current,
      mutationReceipts: {},
      passwordHash: encodedHash,
      sessions: {},
    }));
    this.#lastSessionPersistedAt.clear();
  }

  async reserveMutation(scope: string, now: number): Promise<"completed" | "reserved" | "started"> {
    requireMutationReceiptInput(scope, now);
    let result: "completed" | "reserved" | "started" = "reserved";
    await this.#commitState((current) => {
      const existing = current.mutationReceipts[scope];
      if (existing) {
        result = existing.state;
        return current;
      }
      const mutationReceipts = {
        ...current.mutationReceipts,
        [scope]: { state: "started" as const, updatedAtMs: now },
      };
      return {
        ...current,
        mutationReceipts: pruneMutationReceipts(mutationReceipts),
      };
    });
    return result;
  }

  async completeMutation(scope: string, now: number): Promise<void> {
    requireMutationReceiptInput(scope, now);
    await this.#commitState((current) => {
      const existing = current.mutationReceipts[scope];
      if (!existing || (existing.state === "completed" && existing.updatedAtMs === now)) {
        return current;
      }
      return {
        ...current,
        mutationReceipts: {
          ...current.mutationReceipts,
          [scope]: { state: "completed", updatedAtMs: now },
        },
      };
    });
  }

  async releaseMutation(scope: string): Promise<void> {
    requireMutationScope(scope);
    await this.#commitState((current) => {
      if (current.mutationReceipts[scope]?.state !== "started") {
        return current;
      }
      const mutationReceipts = { ...current.mutationReceipts };
      delete mutationReceipts[scope];
      return { ...current, mutationReceipts };
    });
  }

  async registerProject(project: RegisteredProject): Promise<void> {
    if (project.source !== "registered") {
      throw new Error("只有电脑本机显式登记的项目才能获得远程授权");
    }
    const canonicalRoot = await realpath(project.root);
    const rootMetadata = await stat(canonicalRoot, { bigint: true });
    const canonicalRootAfterStat = await realpath(project.root);
    const rootValidation = validateSafeWindowsProjectRoot(canonicalRoot);
    if (
      !rootMetadata.isDirectory() ||
      !rootValidation.ok ||
      !sameWindowsPath(canonicalRoot, canonicalRootAfterStat)
    ) {
      throw new Error("项目根目录不安全，不能授予远程访问");
    }
    const normalizedProject: PersistedRegisteredProject = {
      id: project.id.trim(),
      name: project.name.trim(),
      root: rootValidation.normalized,
      rootIdentity: directoryIdentity(rootMetadata),
      source: "registered",
    };
    if (!normalizedProject.id || !normalizedProject.name) {
      throw new Error("项目配置无效");
    }
    await this.#commitState((current) => {
      const existing = current.projects.findIndex((item) => item.id === normalizedProject.id);
      if (
        existing >= 0 &&
        JSON.stringify(current.projects[existing]) === JSON.stringify(normalizedProject)
      ) {
        return current;
      }
      const projects = current.projects.map((item) => ({ ...item }));
      if (existing >= 0) {
        projects[existing] = normalizedProject;
      } else {
        projects.push(normalizedProject);
      }
      return { ...current, projects };
    });
  }

  async authorizeRegisteredProjectRoot(projectId: string): Promise<string | undefined> {
    const project = this.#state.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      return undefined;
    }
    try {
      const canonicalRoot = await realpath(project.root);
      if (!sameWindowsPath(canonicalRoot, project.root)) {
        return undefined;
      }
      const rootValidation = validateSafeWindowsProjectRoot(canonicalRoot);
      if (!rootValidation.ok || !sameWindowsPath(rootValidation.normalized, project.root)) {
        return undefined;
      }
      const metadata = await stat(canonicalRoot, { bigint: true });
      if (!metadata.isDirectory() || !sameDirectoryIdentity(project.rootIdentity, metadata)) {
        return undefined;
      }
      const canonicalRootAfterStat = await realpath(project.root);
      return sameWindowsPath(canonicalRootAfterStat, project.root) ? project.root : undefined;
    } catch {
      return undefined;
    }
  }

  async markManagedThread(
    threadId: string,
    options: { desktopNotificationPending?: boolean } = {},
  ): Promise<void> {
    const normalized = requireManagedThreadId(threadId);
    await this.#commitState((current) => {
      const managed = current.managedThreadIds.includes(normalized);
      const pending = current.pendingDesktopNotificationThreadIds.includes(normalized);
      if (managed && (options.desktopNotificationPending !== true || pending)) {
        return current;
      }
      return {
        ...current,
        managedThreadIds: managed
          ? current.managedThreadIds
          : [...current.managedThreadIds, normalized],
        pendingDesktopNotificationThreadIds:
          options.desktopNotificationPending === true && !pending
            ? [...current.pendingDesktopNotificationThreadIds, normalized]
            : current.pendingDesktopNotificationThreadIds,
      };
    });
  }

  async unmarkManagedThread(threadId: string): Promise<void> {
    const normalized = requireManagedThreadId(threadId);
    await this.#commitState((current) => {
      const managed = current.managedThreadIds.includes(normalized);
      const pending = current.pendingDesktopNotificationThreadIds.includes(normalized);
      if (!managed && !pending) {
        return current;
      }
      return {
        ...current,
        managedThreadIds: current.managedThreadIds.filter((candidate) => candidate !== normalized),
        pendingDesktopNotificationThreadIds: current.pendingDesktopNotificationThreadIds.filter(
          (candidate) => candidate !== normalized,
        ),
      };
    });
  }

  async beginArchiveIntent(
    threadId: string,
    targetArchived: boolean,
  ): Promise<PersistedArchiveIntent> {
    const normalized = requireManagedThreadId(threadId);
    let resolved: PersistedArchiveIntent | undefined;
    await this.#commitState((current) => {
      const existing = current.archiveIntents.find((intent) => intent.threadId === normalized);
      if (existing !== undefined) {
        if (existing.targetArchived !== targetArchived) {
          throw new Error("对话已有相反的归档恢复意图");
        }
        resolved = { ...existing };
        return current;
      }
      const intent: PersistedArchiveIntent = {
        desktopNotificationPending:
          current.pendingDesktopNotificationThreadIds.includes(normalized),
        managed: current.managedThreadIds.includes(normalized),
        targetArchived,
        threadId: normalized,
      };
      resolved = intent;
      return {
        ...current,
        archiveIntents: [...current.archiveIntents, intent],
      };
    });
    if (resolved === undefined) {
      throw new Error("归档意图无法持久化");
    }
    return { ...resolved };
  }

  async settleArchiveIntent(threadId: string, observedArchived: boolean): Promise<void> {
    const normalized = requireManagedThreadId(threadId);
    await this.#commitState((current) => {
      const intent = current.archiveIntents.find((candidate) => candidate.threadId === normalized);
      if (intent === undefined && !observedArchived) {
        return current;
      }
      const managedThreadIds = new Set(current.managedThreadIds);
      const pendingDesktopNotificationThreadIds = new Set(
        current.pendingDesktopNotificationThreadIds,
      );
      if (observedArchived) {
        managedThreadIds.delete(normalized);
        pendingDesktopNotificationThreadIds.delete(normalized);
      } else if (intent !== undefined) {
        if (intent.managed) {
          managedThreadIds.add(normalized);
        } else {
          managedThreadIds.delete(normalized);
        }
        if (intent.managed && intent.desktopNotificationPending) {
          pendingDesktopNotificationThreadIds.add(normalized);
        } else {
          pendingDesktopNotificationThreadIds.delete(normalized);
        }
      }
      return {
        ...current,
        archiveIntents: current.archiveIntents.filter(
          (candidate) => candidate.threadId !== normalized,
        ),
        managedThreadIds: [...managedThreadIds],
        pendingDesktopNotificationThreadIds: [...pendingDesktopNotificationThreadIds],
      };
    });
  }

  async clearPendingDesktopNotification(threadId: string): Promise<void> {
    await this.#commitState((current) => {
      if (!current.pendingDesktopNotificationThreadIds.includes(threadId)) {
        return current;
      }
      return {
        ...current,
        pendingDesktopNotificationThreadIds: current.pendingDesktopNotificationThreadIds.filter(
          (candidate) => candidate !== threadId,
        ),
      };
    });
  }

  async createSession(
    now: number,
    csrfDigest: string,
  ): Promise<{ token: string; record: SessionRecord }> {
    const session = createSession({
      absoluteTtlMs: ABSOLUTE_SESSION_TTL_MS,
      idleTtlMs: IDLE_SESSION_TTL_MS,
      now,
    });
    await this.#commitState((current) => ({
      ...current,
      sessions: {
        ...current.sessions,
        [session.record.tokenDigest]: {
          ...session.record,
          csrfDigests: [csrfDigest],
        },
      },
    }));
    this.#lastSessionPersistedAt.set(session.record.tokenDigest, session.record.lastSeenAtMs);
    return session;
  }

  findSession(token: string, now: number): SessionLookup {
    const digest = digestSessionToken(token);
    const stored = this.#state.sessions[digest];
    if (!stored) {
      return { valid: false };
    }
    const validation = validateSession(token, stored, now);
    return validation.valid
      ? {
          csrfDigest: stored.csrfDigests.at(-1) ?? "",
          csrfDigests: [...stored.csrfDigests],
          record: sessionRecord(stored),
          valid: true,
        }
      : { valid: false };
  }

  isSessionActive(tokenDigest: string, now: number): boolean {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(tokenDigest) || !Number.isSafeInteger(now) || now < 0) {
      return false;
    }
    const stored = this.#state.sessions[tokenDigest];
    return (
      stored?.tokenDigest === tokenDigest &&
      now < stored.absoluteExpiresAtMs &&
      now < stored.idleExpiresAtMs
    );
  }

  async touchSession(token: string, now: number): Promise<SessionLookup> {
    await this.#writeChain;
    const digest = digestSessionToken(token);
    const stored = this.#state.sessions[digest];
    if (!stored || !validateSession(token, stored, now).valid) {
      return { valid: false };
    }
    const touched = touchSession(stored, now, IDLE_SESSION_TTL_MS);
    const lastPersisted = this.#lastSessionPersistedAt.get(digest) ?? stored.lastSeenAtMs;
    if (now - lastPersisted >= SESSION_PERSIST_INTERVAL_MS) {
      await this.#commitState((current) => ({
        ...current,
        sessions: {
          ...current.sessions,
          [digest]: {
            ...touched,
            csrfDigests: [...stored.csrfDigests],
          },
        },
      }));
      this.#lastSessionPersistedAt.set(digest, now);
    } else {
      this.#state = {
        ...this.#state,
        sessions: {
          ...this.#state.sessions,
          [digest]: {
            ...touched,
            csrfDigests: [...stored.csrfDigests],
          },
        },
      };
    }
    return {
      csrfDigest: stored.csrfDigests.at(-1) ?? "",
      csrfDigests: [...stored.csrfDigests],
      record: touched,
      valid: true,
    };
  }

  async rotateCsrf(token: string, csrfDigest: string, now: number): Promise<SessionLookup> {
    await this.#writeChain;
    const digest = digestSessionToken(token);
    const stored = this.#state.sessions[digest];
    if (!stored || !validateSession(token, stored, now).valid) {
      return { valid: false };
    }
    const touched = touchSession(stored, now, IDLE_SESSION_TTL_MS);
    const csrfDigests = [
      ...stored.csrfDigests.filter((candidate) => candidate !== csrfDigest),
      csrfDigest,
    ].slice(-MAX_CSRF_GENERATIONS);
    await this.#commitState((current) => ({
      ...current,
      sessions: {
        ...current.sessions,
        [digest]: { ...touched, csrfDigests },
      },
    }));
    this.#lastSessionPersistedAt.set(digest, now);
    return { csrfDigest, csrfDigests, record: touched, valid: true };
  }

  async deleteSession(token: string): Promise<void> {
    const digest = digestSessionToken(token);
    await this.#commitState((current) => {
      if (current.sessions[digest] === undefined) {
        return current;
      }
      const sessions = { ...current.sessions };
      delete sessions[digest];
      return { ...current, sessions };
    });
    this.#lastSessionPersistedAt.delete(digest);
  }

  async #commitState(update: (current: PersistedState) => PersistedState): Promise<void> {
    const operation = this.#writeChain.then(async () => {
      const current = this.#state;
      const next = update(current);
      if (next === current) {
        return;
      }
      const temporaryPath = path.join(
        this.#dataDir,
        `.state-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
      );
      await writeFile(temporaryPath, JSON.stringify(next, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.#statePath);
      this.#state = next;
    });
    this.#writeChain = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }
}

function emptyState(): PersistedState {
  return {
    archiveIntents: [],
    managedThreadIds: [],
    mutationReceipts: {},
    pendingDesktopNotificationThreadIds: [],
    projects: [],
    schemaVersion: STATE_SCHEMA_VERSION,
    sessions: {},
  };
}

function parseState(serialized: string): PersistedState {
  const value: unknown = JSON.parse(serialized);
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 1 &&
      value.schemaVersion !== 2 &&
      value.schemaVersion !== 3 &&
      value.schemaVersion !== 4 &&
      value.schemaVersion !== STATE_SCHEMA_VERSION)
  ) {
    throw new Error("unsupported state");
  }
  // V1 authorized projects by path string only. Do not silently bless whatever
  // currently occupies that path during migration; the user must register it
  // again so V2 can bind authorization to the directory identity.
  const projects =
    value.schemaVersion !== 1 && Array.isArray(value.projects)
      ? value.projects.filter(isPersistedRegisteredProject)
      : [];
  const managedThreadIds = Array.isArray(value.managedThreadIds)
    ? [...new Set(value.managedThreadIds.filter(isManagedThreadId))]
    : [];
  const archiveIntents =
    value.schemaVersion === STATE_SCHEMA_VERSION && Array.isArray(value.archiveIntents)
      ? deduplicateArchiveIntents(value.archiveIntents.filter(isPersistedArchiveIntent))
      : [];
  const managedThreadIdSet = new Set(managedThreadIds);
  const pendingDesktopNotificationThreadIds =
    (value.schemaVersion === 3 ||
      value.schemaVersion === 4 ||
      value.schemaVersion === STATE_SCHEMA_VERSION) &&
    Array.isArray(value.pendingDesktopNotificationThreadIds)
      ? [
          ...new Set(
            value.pendingDesktopNotificationThreadIds
              .filter(isManagedThreadId)
              .filter((threadId) => managedThreadIdSet.has(threadId)),
          ),
        ]
      : [];
  const mutationReceipts: Record<string, PersistedMutationReceipt> = {};
  if (
    (value.schemaVersion === 4 || value.schemaVersion === STATE_SCHEMA_VERSION) &&
    isRecord(value.mutationReceipts)
  ) {
    const valid = Object.entries(value.mutationReceipts)
      .filter(
        (entry): entry is [string, PersistedMutationReceipt] =>
          isMutationScope(entry[0]) && isPersistedMutationReceipt(entry[1]),
      )
      .sort((left, right) => left[1].updatedAtMs - right[1].updatedAtMs)
      .slice(-MAX_MUTATION_RECEIPTS);
    for (const [scope, receipt] of valid) {
      mutationReceipts[scope] = receipt;
    }
  }
  const sessions: Record<string, StoredSession> = {};
  if (isRecord(value.sessions)) {
    for (const [digest, candidate] of Object.entries(value.sessions)) {
      const stored = normalizeStoredSession(candidate);
      if (stored && stored.tokenDigest === digest) {
        sessions[digest] = stored;
      }
    }
  }
  return {
    archiveIntents,
    managedThreadIds,
    mutationReceipts,
    pendingDesktopNotificationThreadIds,
    projects,
    schemaVersion: STATE_SCHEMA_VERSION,
    sessions,
    ...(typeof value.passwordHash === "string" ? { passwordHash: value.passwordHash } : {}),
  };
}

function requireManagedThreadId(threadId: string): string {
  const normalized = threadId.trim();
  if (!isManagedThreadId(normalized)) {
    throw new Error("对话标识无效");
  }
  return normalized;
}

function isPersistedArchiveIntent(value: unknown): value is PersistedArchiveIntent {
  return (
    isRecord(value) &&
    isManagedThreadId(value.threadId) &&
    typeof value.managed === "boolean" &&
    typeof value.desktopNotificationPending === "boolean" &&
    typeof value.targetArchived === "boolean" &&
    (!value.desktopNotificationPending || value.managed)
  );
}

function deduplicateArchiveIntents(intents: PersistedArchiveIntent[]): PersistedArchiveIntent[] {
  const deduplicated = new Map<string, PersistedArchiveIntent>();
  for (const intent of intents) {
    if (!deduplicated.has(intent.threadId)) {
      deduplicated.set(intent.threadId, { ...intent });
    }
  }
  return [...deduplicated.values()];
}

function normalizeStoredSession(value: unknown): StoredSession | undefined {
  if (isStoredSession(value)) {
    return value;
  }
  if (
    isRecord(value) &&
    typeof value.csrfDigest === "string" &&
    hasStoredSessionTimestamps(value) &&
    typeof value.tokenDigest === "string"
  ) {
    return {
      absoluteExpiresAtMs: value.absoluteExpiresAtMs as number,
      createdAtMs: value.createdAtMs as number,
      csrfDigests: [value.csrfDigest],
      idleExpiresAtMs: value.idleExpiresAtMs as number,
      lastSeenAtMs: value.lastSeenAtMs as number,
      tokenDigest: value.tokenDigest,
    };
  }
  return undefined;
}

function isManagedThreadId(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 512
  );
}

function requireMutationReceiptInput(scope: string, now: number): void {
  requireMutationScope(scope);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("操作回执时间无效");
  }
}

function requireMutationScope(scope: string): void {
  if (!isMutationScope(scope)) {
    throw new TypeError("操作回执范围无效");
  }
}

function isMutationScope(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length >= 8 &&
    value.length <= 4_096
  );
}

function isPersistedMutationReceipt(value: unknown): value is PersistedMutationReceipt {
  return (
    isRecord(value) &&
    (value.state === "completed" || value.state === "started") &&
    Number.isSafeInteger(value.updatedAtMs) &&
    (value.updatedAtMs as number) >= 0
  );
}

function pruneMutationReceipts(
  receipts: Record<string, PersistedMutationReceipt>,
): Record<string, PersistedMutationReceipt> {
  const entries = Object.entries(receipts);
  if (entries.length <= MAX_MUTATION_RECEIPTS) {
    return receipts;
  }
  return Object.fromEntries(
    entries
      .sort((left, right) => left[1].updatedAtMs - right[1].updatedAtMs)
      .slice(-MAX_MUTATION_RECEIPTS),
  );
}

function sessionRecord(value: StoredSession): SessionRecord {
  return {
    absoluteExpiresAtMs: value.absoluteExpiresAtMs,
    createdAtMs: value.createdAtMs,
    idleExpiresAtMs: value.idleExpiresAtMs,
    lastSeenAtMs: value.lastSeenAtMs,
    tokenDigest: value.tokenDigest,
  };
}

function isStoredSession(value: unknown): value is StoredSession {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.tokenDigest === "string" &&
    Array.isArray(value.csrfDigests) &&
    value.csrfDigests.length > 0 &&
    value.csrfDigests.length <= MAX_CSRF_GENERATIONS &&
    value.csrfDigests.every((digest) => typeof digest === "string") &&
    hasStoredSessionTimestamps(value)
  );
}

function hasStoredSessionTimestamps(value: Record<string, unknown>): boolean {
  return ["createdAtMs", "lastSeenAtMs", "absoluteExpiresAtMs", "idleExpiresAtMs"].every((key) =>
    Number.isSafeInteger(value[key]),
  );
}

function isPersistedRegisteredProject(value: unknown): value is PersistedRegisteredProject {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.root !== "string" ||
    value.source !== "registered" ||
    !isProjectRootIdentity(value.rootIdentity)
  ) {
    return false;
  }
  return validateSafeWindowsProjectRoot(value.root).ok;
}

function isProjectRootIdentity(value: unknown): value is ProjectRootIdentity {
  return (
    isRecord(value) &&
    typeof value.dev === "string" &&
    /^\d+$/u.test(value.dev) &&
    typeof value.ino === "string" &&
    /^\d+$/u.test(value.ino)
  );
}

function directoryIdentity(metadata: { dev: bigint; ino: bigint }): ProjectRootIdentity {
  return { dev: metadata.dev.toString(), ino: metadata.ino.toString() };
}

function sameDirectoryIdentity(
  expected: ProjectRootIdentity,
  metadata: { dev: bigint; ino: bigint },
): boolean {
  return expected.dev === metadata.dev.toString() && expected.ino === metadata.ino.toString();
}

function sameWindowsPath(left: string, right: string): boolean {
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
