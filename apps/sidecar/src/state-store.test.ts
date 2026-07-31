import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { setupPassword } from "./auth.js";
import { SidecarStateStore } from "./state-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("SidecarStateStore", () => {
  it("persists only the password hash and rejects weak or mismatched setup input", async () => {
    const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-state-"),
    );
    temporaryDirectories.push(directory);
    const store = await SidecarStateStore.open(directory);

    await expect(setupPassword(store, "short", "short")).rejects.toThrow("密码至少需要 15 个字符");
    await expect(
      setupPassword(store, "这是足够长但两次输入不同的安全口令", "不一样的安全口令也足够长"),
    ).rejects.toThrow("两次输入不一致");

    const password = "这是一个只保存在本机输入流中的足够长口令";
    await setupPassword(store, password, password);

    expect(store.configured).toBe(true);
    const persisted = await readFile(path.join(directory, "state.json"), "utf8");
    expect(persisted).not.toContain(password);
    expect(persisted).toContain("scrypt$");
  });

  it("stores session digests and can reopen them without persisting browser tokens", async () => {
    const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-state-"),
    );
    temporaryDirectories.push(directory);
    const store = await SidecarStateStore.open(directory);
    const session = await store.createSession(1_000, "csrf-digest");

    const persisted = await readFile(path.join(directory, "state.json"), "utf8");
    expect(persisted).not.toContain(session.token);
    expect(persisted).toContain(session.record.tokenDigest);

    const reopened = await SidecarStateStore.open(directory);
    expect(reopened.findSession(session.token, 1_001)).toMatchObject({
      csrfDigest: "csrf-digest",
      valid: true,
    });
  });

  it("persists mutation reservations so a process restart cannot execute the same intent twice", async () => {
    const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-state-"),
    );
    temporaryDirectories.push(directory);
    const store = await SidecarStateStore.open(directory);
    const scope = "session-digest:POST:/threads/:threadId/turns:threadId=thread-1:intent-1";

    await expect(store.reserveMutation(scope, 1_000)).resolves.toBe("reserved");
    await store.completeMutation(scope, 1_001);

    const reopened = await SidecarStateStore.open(directory);
    await expect(reopened.reserveMutation(scope, 1_002)).resolves.toBe("completed");
  });

  it("releases a failed mutation reservation while retaining an unknown crash reservation", async () => {
    const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-state-"),
    );
    temporaryDirectories.push(directory);
    const store = await SidecarStateStore.open(directory);

    await expect(store.reserveMutation("failed-intent", 1_000)).resolves.toBe("reserved");
    await store.releaseMutation("failed-intent");
    await expect(store.reserveMutation("failed-intent", 1_001)).resolves.toBe("reserved");

    const reopened = await SidecarStateStore.open(directory);
    await expect(reopened.reserveMutation("failed-intent", 1_002)).resolves.toBe("started");
  });

  it("checks a bound session digest synchronously without extending its idle lifetime", async () => {
    const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-state-"),
    );
    temporaryDirectories.push(directory);
    const store = await SidecarStateStore.open(directory);
    const session = await store.createSession(1_000, "csrf-digest");

    expect(store.isSessionActive(session.record.tokenDigest, 1_001)).toBe(true);
    expect(store.findSession(session.token, 1_002)).toMatchObject({
      record: { idleExpiresAtMs: session.record.idleExpiresAtMs, lastSeenAtMs: 1_000 },
      valid: true,
    });
    expect(store.isSessionActive(session.record.tokenDigest, session.record.idleExpiresAtMs)).toBe(
      false,
    );

    await store.deleteSession(session.token);
    expect(store.isSessionActive(session.record.tokenDigest, 1_003)).toBe(false);
  });

  it("atomically restores managed ownership and a pending Desktop notification", async () => {
    const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-state-"),
    );
    temporaryDirectories.push(directory);
    const store = await SidecarStateStore.open(directory);
    await store.markManagedThread("thread-owned-by-phone", {
      desktopNotificationPending: true,
    });

    const persisted = JSON.parse(await readFile(path.join(directory, "state.json"), "utf8")) as {
      managedThreadIds: string[];
      pendingDesktopNotificationThreadIds: string[];
    };
    expect(persisted.managedThreadIds).toEqual(["thread-owned-by-phone"]);
    expect(persisted.pendingDesktopNotificationThreadIds).toEqual(["thread-owned-by-phone"]);

    const reopened = await SidecarStateStore.open(directory);
    expect(reopened.listManagedThreadIds()).toEqual(["thread-owned-by-phone"]);
    expect(reopened.listPendingDesktopNotificationThreadIds()).toEqual(["thread-owned-by-phone"]);

    await reopened.clearPendingDesktopNotification("thread-owned-by-phone");
    const delivered = await SidecarStateStore.open(directory);
    expect(delivered.listManagedThreadIds()).toEqual(["thread-owned-by-phone"]);
    expect(delivered.listPendingDesktopNotificationThreadIds()).toEqual([]);
  });

  it("atomically releases managed ownership and any pending Desktop notification", async () => {
    const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-state-"),
    );
    temporaryDirectories.push(directory);
    const store = await SidecarStateStore.open(directory);
    await store.markManagedThread("thread-being-archived", {
      desktopNotificationPending: true,
    });

    await store.unmarkManagedThread("thread-being-archived");
    await store.unmarkManagedThread("thread-being-archived");

    const reopened = await SidecarStateStore.open(directory);
    expect(reopened.listManagedThreadIds()).toEqual([]);
    expect(reopened.listPendingDesktopNotificationThreadIds()).toEqual([]);
  });

  it("rolls back an in-memory managed mark after persistence fails and allows an exact retry", async () => {
    const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-state-"),
    );
    temporaryDirectories.push(directory);
    const store = await SidecarStateStore.open(directory);
    const statePath = path.join(directory, "state.json");
    await mkdir(statePath);

    await expect(
      store.markManagedThread("thread-mark-retry", { desktopNotificationPending: true }),
    ).rejects.toThrow();
    expect(store.listManagedThreadIds()).toEqual([]);
    expect(store.listPendingDesktopNotificationThreadIds()).toEqual([]);

    await rm(statePath, { force: true, recursive: true });
    await expect(
      store.markManagedThread("thread-mark-retry", { desktopNotificationPending: true }),
    ).resolves.toBeUndefined();
    expect(store.listManagedThreadIds()).toEqual(["thread-mark-retry"]);
    expect(store.listPendingDesktopNotificationThreadIds()).toEqual(["thread-mark-retry"]);
  });

  it("rolls back an in-memory managed release after persistence fails and allows an exact retry", async () => {
    const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-state-"),
    );
    temporaryDirectories.push(directory);
    const store = await SidecarStateStore.open(directory);
    const statePath = path.join(directory, "state.json");
    await store.markManagedThread("thread-unmark-retry", {
      desktopNotificationPending: true,
    });
    await rm(statePath);
    await mkdir(statePath);

    await expect(store.unmarkManagedThread("thread-unmark-retry")).rejects.toThrow();
    expect(store.listManagedThreadIds()).toEqual(["thread-unmark-retry"]);
    expect(store.listPendingDesktopNotificationThreadIds()).toEqual(["thread-unmark-retry"]);

    await rm(statePath, { force: true, recursive: true });
    await expect(store.unmarkManagedThread("thread-unmark-retry")).resolves.toBeUndefined();
    expect(store.listManagedThreadIds()).toEqual([]);
    expect(store.listPendingDesktopNotificationThreadIds()).toEqual([]);
  });

  it("recovers a crash-before-archive-RPC intent by restoring its exact prior ownership", async () => {
    const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-state-"),
    );
    temporaryDirectories.push(directory);
    const store = await SidecarStateStore.open(directory);
    await store.markManagedThread("thread-crash-before-rpc", {
      desktopNotificationPending: true,
    });

    await expect(store.beginArchiveIntent("thread-crash-before-rpc", true)).resolves.toMatchObject({
      desktopNotificationPending: true,
      managed: true,
      targetArchived: true,
      threadId: "thread-crash-before-rpc",
    });
    await store.unmarkManagedThread("thread-crash-before-rpc");

    const restarted = await SidecarStateStore.open(directory);
    expect(restarted.listManagedThreadIds()).toEqual([]);
    expect(restarted.listArchiveIntents()).toEqual([
      {
        desktopNotificationPending: true,
        managed: true,
        targetArchived: true,
        threadId: "thread-crash-before-rpc",
      },
    ]);

    await restarted.settleArchiveIntent("thread-crash-before-rpc", false);
    const recovered = await SidecarStateStore.open(directory);
    expect(recovered.listManagedThreadIds()).toEqual(["thread-crash-before-rpc"]);
    expect(recovered.listPendingDesktopNotificationThreadIds()).toEqual([
      "thread-crash-before-rpc",
    ]);
    expect(recovered.listArchiveIntents()).toEqual([]);
  });

  it("recovers a success-before-cleanup intent by completing the durable managed release", async () => {
    const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-state-"),
    );
    temporaryDirectories.push(directory);
    const store = await SidecarStateStore.open(directory);
    await store.markManagedThread("thread-success-before-cleanup", {
      desktopNotificationPending: true,
    });
    await store.beginArchiveIntent("thread-success-before-cleanup", true);
    await store.unmarkManagedThread("thread-success-before-cleanup");

    const restarted = await SidecarStateStore.open(directory);
    await restarted.settleArchiveIntent("thread-success-before-cleanup", true);

    const recovered = await SidecarStateStore.open(directory);
    expect(recovered.listManagedThreadIds()).toEqual([]);
    expect(recovered.listPendingDesktopNotificationThreadIds()).toEqual([]);
    expect(recovered.listArchiveIntents()).toEqual([]);
  });

  it("retains an unsettled archive intent after one cleanup write failure and retries exactly", async () => {
    const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-state-"),
    );
    temporaryDirectories.push(directory);
    const store = await SidecarStateStore.open(directory);
    const statePath = path.join(directory, "state.json");
    await store.markManagedThread("thread-settle-retry", {
      desktopNotificationPending: true,
    });
    await store.beginArchiveIntent("thread-settle-retry", true);
    await store.unmarkManagedThread("thread-settle-retry");
    await rm(statePath);
    await mkdir(statePath);

    await expect(store.settleArchiveIntent("thread-settle-retry", true)).rejects.toThrow();
    expect(store.listManagedThreadIds()).toEqual([]);
    expect(store.listArchiveIntents()).toHaveLength(1);

    await rm(statePath, { force: true, recursive: true });
    await expect(store.settleArchiveIntent("thread-settle-retry", true)).resolves.toBeUndefined();
    const recovered = await SidecarStateStore.open(directory);
    expect(recovered.listManagedThreadIds()).toEqual([]);
    expect(recovered.listArchiveIntents()).toEqual([]);
  });

  it("serializes archive state with concurrent session and mutation-receipt persistence", async () => {
    const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-state-"),
    );
    temporaryDirectories.push(directory);
    const store = await SidecarStateStore.open(directory);
    await store.markManagedThread("thread-concurrent-archive");

    const [, session] = await Promise.all([
      store.beginArchiveIntent("thread-concurrent-archive", true),
      store.createSession(1_000, "csrf-concurrent"),
    ]);
    await Promise.all([
      store.unmarkManagedThread("thread-concurrent-archive"),
      store.reserveMutation("concurrent-archive-receipt", 1_001),
    ]);

    const restarted = await SidecarStateStore.open(directory);
    expect(restarted.listManagedThreadIds()).toEqual([]);
    expect(restarted.listArchiveIntents()).toHaveLength(1);
    expect(restarted.findSession(session.token, 1_002)).toMatchObject({ valid: true });
    await expect(restarted.reserveMutation("concurrent-archive-receipt", 1_003)).resolves.toBe(
      "started",
    );
  });

  it.each([1, 2])(
    "migrates schema v%s without treating historical managed threads as pending",
    async (schemaVersion) => {
      const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
        path.join(os.tmpdir(), "codex-local-remote-state-"),
      );
      temporaryDirectories.push(directory);
      await writeFile(
        path.join(directory, "state.json"),
        JSON.stringify({
          managedThreadIds: ["historical-managed-thread"],
          pendingDesktopNotificationThreadIds: ["must-not-be-trusted-from-an-old-schema"],
          projects: [],
          schemaVersion,
          sessions: {},
        }),
        "utf8",
      );

      const migrated = await SidecarStateStore.open(directory);

      expect(migrated.listManagedThreadIds()).toEqual(["historical-managed-thread"]);
      expect(migrated.listPendingDesktopNotificationThreadIds()).toEqual([]);
    },
  );

  it("keeps only managed pending ids from the notification-capable schema", async () => {
    const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-state-"),
    );
    temporaryDirectories.push(directory);
    await writeFile(
      path.join(directory, "state.json"),
      JSON.stringify({
        managedThreadIds: ["managed-pending-thread"],
        pendingDesktopNotificationThreadIds: ["managed-pending-thread", "unmanaged-must-not-open"],
        projects: [],
        schemaVersion: 3,
        sessions: {},
      }),
      "utf8",
    );

    const restored = await SidecarStateStore.open(directory);

    expect(restored.listPendingDesktopNotificationThreadIds()).toEqual(["managed-pending-thread"]);
  });

  it("migrates schema v4 mutation receipts without inventing archive intents", async () => {
    const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-state-"),
    );
    temporaryDirectories.push(directory);
    await writeFile(
      path.join(directory, "state.json"),
      JSON.stringify({
        managedThreadIds: [],
        mutationReceipts: {
          "completed-schema-v4-receipt": { state: "completed", updatedAtMs: 1_000 },
        },
        pendingDesktopNotificationThreadIds: [],
        projects: [],
        schemaVersion: 4,
        sessions: {},
      }),
      "utf8",
    );

    const migrated = await SidecarStateStore.open(directory);

    expect(migrated.listArchiveIntents()).toEqual([]);
    await expect(migrated.reserveMutation("completed-schema-v4-receipt", 1_001)).resolves.toBe(
      "completed",
    );
  });

  it("binds a registered root to its directory identity across restarts", async () => {
    const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-state-"),
    );
    temporaryDirectories.push(directory);
    const root = path.join(directory, "project");
    const outside = path.join(directory, "outside");
    await mkdir(root);
    await mkdir(outside);
    const store = await SidecarStateStore.open(path.join(directory, "state"));
    await store.registerProject({
      id: "project-1",
      name: "测试项目",
      root,
      source: "registered",
    });

    const persisted = JSON.parse(
      await readFile(path.join(directory, "state", "state.json"), "utf8"),
    ) as {
      projects: Array<{ rootIdentity?: { dev?: string; ino?: string } }>;
      schemaVersion: number;
    };
    expect(persisted.schemaVersion).toBe(5);
    expect(persisted.projects[0]?.rootIdentity?.dev).toMatch(/^\d+$/u);
    expect(persisted.projects[0]?.rootIdentity?.ino).toMatch(/^\d+$/u);
    await expect(store.authorizeRegisteredProjectRoot("project-1")).resolves.toBeDefined();

    await rename(root, `${root}-original`);
    await symlink(outside, root, "junction");

    await expect(store.authorizeRegisteredProjectRoot("project-1")).resolves.toBeUndefined();
    const reopened = await SidecarStateStore.open(path.join(directory, "state"));
    await expect(reopened.authorizeRegisteredProjectRoot("project-1")).resolves.toBeUndefined();
  });

  it("throttles concurrent sliding-session persistence while keeping memory current", async () => {
    const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-state-"),
    );
    temporaryDirectories.push(directory);
    const store = await SidecarStateStore.open(directory);
    const session = await store.createSession(1_000, "csrf-one");

    await Promise.all(
      Array.from({ length: 8 }, async () => await store.touchSession(session.token, 2_000)),
    );
    const beforeInterval = JSON.parse(
      await readFile(path.join(directory, "state.json"), "utf8"),
    ) as { sessions: Record<string, { lastSeenAtMs: number }> };
    expect(beforeInterval.sessions[session.record.tokenDigest]?.lastSeenAtMs).toBe(1_000);
    expect(store.findSession(session.token, 2_001)).toMatchObject({
      record: { lastSeenAtMs: 2_000 },
      valid: true,
    });

    await Promise.all(
      Array.from({ length: 8 }, async () => await store.touchSession(session.token, 61_001)),
    );
    const afterInterval = JSON.parse(
      await readFile(path.join(directory, "state.json"), "utf8"),
    ) as { sessions: Record<string, { lastSeenAtMs: number }> };
    expect(afterInterval.sessions[session.record.tokenDigest]?.lastSeenAtMs).toBe(61_001);
  });

  it("recovers later persistence after one state-file I/O failure", async () => {
    const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-state-"),
    );
    temporaryDirectories.push(directory);
    const store = await SidecarStateStore.open(directory);
    const statePath = path.join(directory, "state.json");
    await mkdir(statePath);

    await expect(store.createSession(1_000, "csrf-fails-once")).rejects.toThrow();

    await rm(statePath, { force: true, recursive: true });
    await expect(store.setPasswordHash("fixture-password-hash")).resolves.toBeUndefined();
    await expect(readFile(statePath, "utf8")).resolves.toContain("fixture-password-hash");
  });
});
