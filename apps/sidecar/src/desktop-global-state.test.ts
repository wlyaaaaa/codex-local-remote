import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DesktopPinnedThreadReader } from "./desktop-global-state.js";

describe("DesktopPinnedThreadReader", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directory) => {
        await rm(directory, { force: true, recursive: true });
      }),
    );
  });

  async function createCodexHome(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "clr-desktop-state-"));
    temporaryDirectories.push(directory);
    return directory;
  }

  it("reads only the ordered pinned thread ids and never writes Desktop state", async () => {
    const codexHome = await createCodexHome();
    const statePath = path.join(codexHome, ".codex-global-state.json");
    const original = JSON.stringify({
      "pinned-thread-ids": ["thread-b", "thread-a", "thread-b", "", 42],
      "unrelated-secret": "must-never-be-returned",
    });
    await writeFile(statePath, original, "utf8");
    const before = await readdir(codexHome);

    const reader = new DesktopPinnedThreadReader();
    await expect(reader.read(codexHome)).resolves.toEqual(["thread-b", "thread-a"]);

    expect(await readdir(codexHome)).toEqual(before);
    expect(await readFile(statePath, "utf8")).toBe(original);
  });

  it("keeps reading the same open handle across short reads until EOF", async () => {
    const codexHome = await createCodexHome();
    const statePath = path.join(codexHome, ".codex-global-state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        "pinned-thread-ids": ["thread-short-a", "thread-short-b"],
      }),
      "utf8",
    );
    let readCalls = 0;
    const reader = new DesktopPinnedThreadReader({
      openFile: async (filePath) => {
        const handle = await open(filePath, "r");
        return {
          close: async () => {
            await handle.close();
          },
          read: async (buffer, offset, length, position) => {
            readCalls += 1;
            return await handle.read(buffer, offset, Math.min(length, 7), position);
          },
          stat: async () => await handle.stat({ bigint: true }),
        };
      },
    });

    await expect(reader.read(codexHome)).resolves.toEqual(["thread-short-a", "thread-short-b"]);
    expect(readCalls).toBeGreaterThan(2);
  });

  it("rejects a snapshot that grows past the byte ceiling while it is being read", async () => {
    const codexHome = await createCodexHome();
    const statePath = path.join(codexHome, ".codex-global-state.json");
    await writeFile(
      statePath,
      JSON.stringify({ "pinned-thread-ids": ["thread-before-growth"] }),
      "utf8",
    );
    let readCalls = 0;
    let grew = false;
    const reader = new DesktopPinnedThreadReader({
      openFile: async (filePath) => {
        const handle = await open(filePath, "r");
        return {
          close: async () => {
            await handle.close();
          },
          read: async (buffer, offset, length, position) => {
            if (!grew) {
              grew = true;
              await appendFile(filePath, "x".repeat(2 * 1024 * 1024), "utf8");
            }
            readCalls += 1;
            return await handle.read(buffer, offset, Math.min(length, 64 * 1024), position);
          },
          stat: async () => await handle.stat({ bigint: true }),
        };
      },
    });

    await expect(reader.read(codexHome)).resolves.toEqual([]);
    expect(grew).toBe(true);
    expect(readCalls).toBeGreaterThan(1);
  });

  it("rejects an in-place same-size rewrite while the open handle is being read", async () => {
    const codexHome = await createCodexHome();
    const statePath = path.join(codexHome, ".codex-global-state.json");
    const before = JSON.stringify({ "pinned-thread-ids": ["thread-before"] });
    const after = JSON.stringify({ "pinned-thread-ids": ["thread-after-"] });
    expect(after).toHaveLength(before.length);
    await writeFile(statePath, before, "utf8");
    let rewritten = false;
    const reader = new DesktopPinnedThreadReader({
      openFile: async (filePath) => {
        const handle = await open(filePath, "r");
        return {
          close: async () => {
            await handle.close();
          },
          read: async (buffer, offset, length, position) => {
            if (!rewritten) {
              rewritten = true;
              await writeFile(filePath, after, "utf8");
            }
            return await handle.read(buffer, offset, length, position);
          },
          stat: async () => await handle.stat({ bigint: true }),
        };
      },
    });

    await expect(reader.read(codexHome)).resolves.toEqual([]);
    expect(rewritten).toBe(true);
  });

  it("rejects a path rebound to another file after the original handle is open", async () => {
    const codexHome = await createCodexHome();
    const statePath = path.join(codexHome, ".codex-global-state.json");
    const detachedPath = `${statePath}.detached`;
    await writeFile(
      statePath,
      JSON.stringify({ "pinned-thread-ids": ["thread-original"] }),
      "utf8",
    );
    let rebound = false;
    const reader = new DesktopPinnedThreadReader({
      openFile: async (filePath) => {
        const handle = await open(filePath, "r");
        await rename(filePath, detachedPath);
        await writeFile(
          filePath,
          JSON.stringify({ "pinned-thread-ids": ["thread-rebound"] }),
          "utf8",
        );
        rebound = true;
        return {
          close: async () => {
            await handle.close();
          },
          read: async (buffer, offset, length, position) =>
            await handle.read(buffer, offset, length, position),
          stat: async () => await handle.stat({ bigint: true }),
        };
      },
    });

    await expect(reader.read(codexHome)).resolves.toEqual([]);
    expect(rebound).toBe(true);
  });

  it("rejects a reparse-point state file", async () => {
    const codexHome = await createCodexHome();
    const outsideHome = await createCodexHome();
    const outsidePath = path.join(outsideHome, "outside.json");
    const statePath = path.join(codexHome, ".codex-global-state.json");
    await writeFile(
      outsidePath,
      JSON.stringify({ "pinned-thread-ids": ["thread-outside"] }),
      "utf8",
    );
    await symlink(outsidePath, statePath, "file");

    await expect(new DesktopPinnedThreadReader().read(codexHome)).resolves.toEqual([]);
  });

  it("falls back to Desktop's backup during an invalid or missing primary snapshot", async () => {
    const codexHome = await createCodexHome();
    const statePath = path.join(codexHome, ".codex-global-state.json");
    const backupPath = `${statePath}.bak`;
    await writeFile(backupPath, JSON.stringify({ "pinned-thread-ids": ["thread-backup"] }), "utf8");
    await writeFile(statePath, "{not-json", "utf8");

    const reader = new DesktopPinnedThreadReader();
    await expect(reader.read(codexHome)).resolves.toEqual(["thread-backup"]);

    await rename(statePath, `${statePath}.replaced`);
    await expect(reader.read(codexHome)).resolves.toEqual(["thread-backup"]);
  });

  it("keeps the last valid snapshot when both atomic state files are briefly unavailable", async () => {
    const codexHome = await createCodexHome();
    const statePath = path.join(codexHome, ".codex-global-state.json");
    await writeFile(statePath, JSON.stringify({ "pinned-thread-ids": ["thread-stable"] }), "utf8");
    const reader = new DesktopPinnedThreadReader();
    await expect(reader.read(codexHome)).resolves.toEqual(["thread-stable"]);

    await rename(statePath, `${statePath}.temporary`);
    await expect(reader.read(codexHome)).resolves.toEqual(["thread-stable"]);
  });

  it("expires the last valid snapshot instead of serving stale pins forever", async () => {
    const codexHome = await createCodexHome();
    const statePath = path.join(codexHome, ".codex-global-state.json");
    await writeFile(
      statePath,
      JSON.stringify({ "pinned-thread-ids": ["thread-time-bounded"] }),
      "utf8",
    );
    let nowMs = 10_000;
    const reader = new DesktopPinnedThreadReader({
      cacheTtlMs: 1_000,
      now: () => nowMs,
    });
    await expect(reader.read(codexHome)).resolves.toEqual(["thread-time-bounded"]);

    await rename(statePath, `${statePath}.temporary`);
    await writeFile(
      `${statePath}.bak`,
      JSON.stringify({ "pinned-thread-ids": ["thread-older-backup"] }),
      "utf8",
    );
    nowMs = 10_999;
    await expect(reader.read(codexHome)).resolves.toEqual(["thread-time-bounded"]);

    nowMs = 11_001;
    await expect(reader.read(codexHome)).resolves.toEqual([]);
  });

  it("never lets an older Desktop backup replace a newer cached primary snapshot", async () => {
    const codexHome = await createCodexHome();
    const statePath = path.join(codexHome, ".codex-global-state.json");
    await writeFile(
      `${statePath}.bak`,
      JSON.stringify({ "pinned-thread-ids": ["thread-old"] }),
      "utf8",
    );
    await writeFile(statePath, JSON.stringify({ "pinned-thread-ids": ["thread-new"] }), "utf8");
    const reader = new DesktopPinnedThreadReader();
    await expect(reader.read(codexHome)).resolves.toEqual(["thread-new"]);

    await rename(statePath, `${statePath}.temporary`);
    await expect(reader.read(codexHome)).resolves.toEqual(["thread-new"]);
  });

  it("rejects oversized and malformed values without exposing another global-state field", async () => {
    const codexHome = await createCodexHome();
    const statePath = path.join(codexHome, ".codex-global-state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        "pinned-thread-ids": [
          "valid",
          "x".repeat(600),
          ...Array.from({ length: 1_100 }, (_, index) => `thread-${index}`),
        ],
        token: "do-not-return",
      }),
      "utf8",
    );

    const result = await new DesktopPinnedThreadReader().read(codexHome);

    expect(result[0]).toBe("valid");
    expect(result).toHaveLength(100);
    expect(JSON.stringify(result)).not.toContain("do-not-return");
    expect(result.some((id) => id.length > 512)).toBe(false);

    const oversizedHome = await createCodexHome();
    await writeFile(
      path.join(oversizedHome, ".codex-global-state.json"),
      "x".repeat(2 * 1024 * 1024 + 1),
      "utf8",
    );
    await expect(new DesktopPinnedThreadReader().read(oversizedHome)).resolves.toEqual([]);
  });

  it("rejects more than 10,000 raw pin entries before truncating the public result", async () => {
    const codexHome = await createCodexHome();
    await writeFile(
      path.join(codexHome, ".codex-global-state.json"),
      JSON.stringify({
        "pinned-thread-ids": Array.from({ length: 10_001 }, (_, index) => `thread-raw-${index}`),
      }),
      "utf8",
    );

    await expect(new DesktopPinnedThreadReader().read(codexHome)).resolves.toEqual([]);
  });

  it("fails closed for relative, filesystem-root, UNC, and device namespace homes", async () => {
    const codexHome = await mkdtemp(path.join(process.cwd(), ".clr-desktop-state-"));
    temporaryDirectories.push(codexHome);
    await writeFile(
      path.join(codexHome, ".codex-global-state.json"),
      JSON.stringify({ "pinned-thread-ids": ["must-not-resolve-relatively"] }),
      "utf8",
    );
    const reader = new DesktopPinnedThreadReader();
    const relativeHome = path.relative(process.cwd(), codexHome);
    const filesystemRoot = path.parse(codexHome).root;

    await expect(reader.read(relativeHome)).resolves.toEqual([]);
    await expect(reader.read(filesystemRoot)).resolves.toEqual([]);
    await expect(reader.read(String.raw`\\server\share\codex`)).resolves.toEqual([]);
    await expect(reader.read(String.raw`\\?\C:\Users\example\.codex`)).resolves.toEqual([]);
    await expect(reader.read(String.raw`\\.\C:\Users\example\.codex`)).resolves.toEqual([]);
  });

  it("rejects a codex home rebound through a junction", async () => {
    const directory = await createCodexHome();
    const originalHome = path.join(directory, "original");
    const outsideHome = path.join(directory, "outside");
    await writeFile(
      path.join(directory, "placeholder"),
      "keeps the parent directory materialized",
      "utf8",
    );
    await Promise.all([mkdir(originalHome), mkdir(outsideHome)]);
    await writeFile(
      path.join(outsideHome, ".codex-global-state.json"),
      JSON.stringify({ "pinned-thread-ids": ["thread-outside-home"] }),
      "utf8",
    );
    await rename(originalHome, `${originalHome}.detached`);
    await symlink(outsideHome, originalHome, "junction");

    await expect(new DesktopPinnedThreadReader().read(originalHome)).resolves.toEqual([]);
  });
});
