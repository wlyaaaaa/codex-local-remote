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

const STATE_SCHEMA_VERSION = 3;
const ABSOLUTE_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const IDLE_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const SESSION_PERSIST_INTERVAL_MS = 60_000;
const MAX_CSRF_GENERATIONS = 8;

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

interface PersistedState {
  managedThreadIds: string[];
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

  async verifyPassword(password: string): Promise<boolean> {
    const encodedHash = this.#state.passwordHash;
    return encodedHash ? await verifyPassword(password, encodedHash) : false;
  }

  async setPasswordHash(encodedHash: string): Promise<void> {
    this.#state = {
      ...this.#state,
      passwordHash: encodedHash,
      sessions: {},
    };
    await this.#persist();
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
    const existing = this.#state.projects.findIndex((item) => item.id === normalizedProject.id);
    if (
      existing >= 0 &&
      JSON.stringify(this.#state.projects[existing]) === JSON.stringify(normalizedProject)
    ) {
      return;
    }
    const projects = this.#state.projects.map((item) => ({ ...item }));
    if (existing >= 0) {
      projects[existing] = normalizedProject;
    } else {
      projects.push(normalizedProject);
    }
    this.#state = { ...this.#state, projects };
    await this.#persist();
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
    const normalized = threadId.trim();
    if (!normalized || normalized.length > 512) {
      throw new Error("对话标识无效");
    }
    const managed = this.#state.managedThreadIds.includes(normalized);
    const pending = this.#state.pendingDesktopNotificationThreadIds.includes(normalized);
    if (managed && (options.desktopNotificationPending !== true || pending)) {
      return;
    }
    this.#state = {
      ...this.#state,
      managedThreadIds: managed
        ? this.#state.managedThreadIds
        : [...this.#state.managedThreadIds, normalized],
      pendingDesktopNotificationThreadIds:
        options.desktopNotificationPending === true && !pending
          ? [...this.#state.pendingDesktopNotificationThreadIds, normalized]
          : this.#state.pendingDesktopNotificationThreadIds,
    };
    await this.#persist();
  }

  async clearPendingDesktopNotification(threadId: string): Promise<void> {
    if (!this.#state.pendingDesktopNotificationThreadIds.includes(threadId)) {
      return;
    }
    this.#state = {
      ...this.#state,
      pendingDesktopNotificationThreadIds: this.#state.pendingDesktopNotificationThreadIds.filter(
        (candidate) => candidate !== threadId,
      ),
    };
    await this.#persist();
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
    this.#state.sessions[session.record.tokenDigest] = {
      ...session.record,
      csrfDigests: [csrfDigest],
    };
    this.#lastSessionPersistedAt.set(session.record.tokenDigest, session.record.lastSeenAtMs);
    await this.#persist();
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
    const digest = digestSessionToken(token);
    const stored = this.#state.sessions[digest];
    if (!stored || !validateSession(token, stored, now).valid) {
      return { valid: false };
    }
    const touched = touchSession(stored, now, IDLE_SESSION_TTL_MS);
    this.#state.sessions[digest] = {
      ...touched,
      csrfDigests: [...stored.csrfDigests],
    };
    const lastPersisted = this.#lastSessionPersistedAt.get(digest) ?? stored.lastSeenAtMs;
    if (now - lastPersisted >= SESSION_PERSIST_INTERVAL_MS) {
      this.#lastSessionPersistedAt.set(digest, now);
      try {
        await this.#persist();
      } catch (error) {
        this.#lastSessionPersistedAt.set(digest, lastPersisted);
        throw error;
      }
    }
    return {
      csrfDigest: stored.csrfDigests.at(-1) ?? "",
      csrfDigests: [...stored.csrfDigests],
      record: touched,
      valid: true,
    };
  }

  async rotateCsrf(token: string, csrfDigest: string, now: number): Promise<SessionLookup> {
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
    this.#state.sessions[digest] = { ...touched, csrfDigests };
    this.#lastSessionPersistedAt.set(digest, now);
    await this.#persist();
    return { csrfDigest, csrfDigests, record: touched, valid: true };
  }

  async deleteSession(token: string): Promise<void> {
    const digest = digestSessionToken(token);
    delete this.#state.sessions[digest];
    this.#lastSessionPersistedAt.delete(digest);
    await this.#persist();
  }

  async #persist(): Promise<void> {
    const snapshot = JSON.stringify(this.#state, null, 2);
    this.#writeChain = this.#writeChain.then(async () => {
      const temporaryPath = path.join(
        this.#dataDir,
        `.state-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
      );
      await writeFile(temporaryPath, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.#statePath);
    });
    await this.#writeChain;
  }
}

function emptyState(): PersistedState {
  return {
    managedThreadIds: [],
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
  const managedThreadIdSet = new Set(managedThreadIds);
  const pendingDesktopNotificationThreadIds =
    value.schemaVersion === STATE_SCHEMA_VERSION &&
    Array.isArray(value.pendingDesktopNotificationThreadIds)
      ? [
          ...new Set(
            value.pendingDesktopNotificationThreadIds
              .filter(isManagedThreadId)
              .filter((threadId) => managedThreadIdSet.has(threadId)),
          ),
        ]
      : [];
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
    managedThreadIds,
    pendingDesktopNotificationThreadIds,
    projects,
    schemaVersion: STATE_SCHEMA_VERSION,
    sessions,
    ...(typeof value.passwordHash === "string" ? { passwordHash: value.passwordHash } : {}),
  };
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
