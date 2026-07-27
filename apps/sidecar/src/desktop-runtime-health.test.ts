import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readDesktopRuntimeHealth } from "./desktop-runtime-health.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-remote-runtime-health-"));
  cleanupDirectories.push(directory);
  return directory;
}

function startupReceipt(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    Bootstrap: {},
    BootstrapInvocationId: "a".repeat(32),
    Message: "",
    RecordedAtUtc: "2026-07-26T00:00:00.000Z",
    Runtime: {},
    RuntimeInvocationId: "b".repeat(32),
    Signature: "codex-local-remote/startup-status/v3",
    Stage: "supervising",
    Status: "ready",
    Version: 3,
    ...overrides,
  };
}

async function writeReceipt(
  dataDir: string,
  receipt: Record<string, unknown> | string,
): Promise<void> {
  await writeFile(
    path.join(dataDir, "startup-last.json"),
    typeof receipt === "string" ? receipt : JSON.stringify(receipt),
    "utf8",
  );
}

describe("readDesktopRuntimeHealth", () => {
  it("fails closed when the managed startup receipt is absent", async () => {
    const dataDir = await fixtureDirectory();

    await expect(readDesktopRuntimeHealth(dataDir)).resolves.toEqual({
      state: "missing",
      warning: "Codex Desktop 启动健康回执缺失，远程控制已标记为降级。",
    });
  });

  it("accepts only a bounded v3 current receipt", async () => {
    const dataDir = await fixtureDirectory();
    await writeReceipt(dataDir, startupReceipt());

    await expect(readDesktopRuntimeHealth(dataDir)).resolves.toEqual({ state: "current" });
  });

  it("keeps a verified Desktop runtime current during application-only history backfill", async () => {
    const dataDir = await fixtureDirectory();
    await writeReceipt(
      dataDir,
      startupReceipt({
        Message: "private application diagnostics",
        Stage: "application-degraded",
        Status: "degraded",
      }),
    );

    await expect(readDesktopRuntimeHealth(dataDir)).resolves.toEqual({ state: "current" });
  });

  it.each([
    {
      expectedState: "update-pending",
      receipt: startupReceipt({
        Message: "private path and hash must not escape",
        Stage: "update-pending",
        Status: "degraded",
      }),
      warning: "当前实时能力探针通过时可继续使用",
    },
    {
      expectedState: "runtime-check-blocked",
      receipt: startupReceipt({
        Message: "private token must not escape",
        Stage: "runtime-check-blocked",
        Status: "degraded",
      }),
      warning: "无法确认 Codex Desktop 更新兼容性",
    },
    {
      expectedState: "runtime-check-blocked",
      receipt: startupReceipt({
        Message: "arbitrary private diagnostics",
        Stage: "supervising",
        Status: "degraded",
      }),
      warning: "Codex Desktop 启动健康状态已降级",
    },
    {
      expectedState: "starting",
      receipt: startupReceipt({
        Message: "private startup details",
        Stage: "sidecar-start",
        Status: "starting",
      }),
      warning: "受管连接正在启动",
    },
  ])(
    "projects $expectedState without exposing the raw receipt message",
    async ({ expectedState, receipt, warning }) => {
      const dataDir = await fixtureDirectory();
      await writeReceipt(dataDir, receipt);

      const health = await readDesktopRuntimeHealth(dataDir);

      expect(health.state).toBe(expectedState);
      expect("warning" in health ? health.warning : "").toContain(warning);
      expect(JSON.stringify(health)).not.toContain(String(receipt.Message));
    },
  );

  it.each([
    ["undersized receipt", "{"],
    ["malformed JSON", "{{"],
    [
      "legacy schema",
      JSON.stringify(
        startupReceipt({
          Signature: "codex-local-remote/startup-status/v2",
          Version: 2,
        }),
      ),
    ],
    ["oversized receipt", JSON.stringify({ padding: "x".repeat(65_537) })],
  ])("blocks an invalid %s receipt", async (_label, contents) => {
    const dataDir = await fixtureDirectory();
    await writeReceipt(dataDir, contents);

    await expect(readDesktopRuntimeHealth(dataDir)).resolves.toEqual({
      state: "invalid",
      warning: "Codex Desktop 启动健康回执无效，远程控制已标记为降级。",
    });
  });

  it("rejects a directory and a symbolic link instead of following them", async () => {
    const directoryDataDir = await fixtureDirectory();
    await mkdir(path.join(directoryDataDir, "startup-last.json"));
    await expect(readDesktopRuntimeHealth(directoryDataDir)).resolves.toMatchObject({
      state: "invalid",
    });

    const symlinkDataDir = await fixtureDirectory();
    const target = path.join(symlinkDataDir, "target.json");
    await writeFile(target, JSON.stringify(startupReceipt()), "utf8");
    await symlink(target, path.join(symlinkDataDir, "startup-last.json"), "file");
    await expect(readDesktopRuntimeHealth(symlinkDataDir)).resolves.toMatchObject({
      state: "invalid",
    });
  });
});
