import path from "node:path";

import { describe, expect, it } from "vitest";

import { CodexExecutableNotFoundError, discoverCodexExecutable } from "./discovery.js";

const win = path.win32;

describe("discoverCodexExecutable", () => {
  it("uses the explicit environment override before every discovered candidate", async () => {
    const override = "D:\\Tools\\codex.exe";
    const inspected: string[] = [];

    const result = await discoverCodexExecutable({
      environment: { CODEX_REMOTE_CODEX_EXE: override },
      exists: async (candidate) => {
        inspected.push(candidate);
        return true;
      },
      getAppxInstallLocations: async () => ["C:\\Program Files\\WindowsApps\\OpenAI.Codex_fixture"],
      listDirectoryNames: async () => ["build-a"],
      localAppData: "C:\\Users\\fixture\\AppData\\Local",
      pathValue: "C:\\bin",
      programFiles: "C:\\Program Files",
    });

    expect(result).toEqual({ path: override, source: "environment" });
    expect(inspected).toEqual([override]);
  });

  it("prefers the current-user Desktop bundle and treats WindowsApps as diagnostic-only", async () => {
    const localAppData = "C:\\Users\\fixture\\AppData\\Local";
    const localBundle = win.join(localAppData, "OpenAI", "Codex", "bin", "build-b", "codex.exe");
    const appxRoot = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_fixture";
    const appxBundle = win.join(appxRoot, "app", "resources", "codex.exe");
    const pathBundle = "D:\\bin\\codex.exe";

    const common = {
      environment: {},
      getAppxInstallLocations: async () => [appxRoot],
      listDirectoryNames: async (directory: string) =>
        directory.endsWith(win.join("OpenAI", "Codex", "bin")) ? ["build-a", "build-b"] : [],
      localAppData,
      pathValue: "D:\\bin",
      programFiles: "C:\\Program Files",
    };

    await expect(
      discoverCodexExecutable({
        ...common,
        exists: async (candidate) => candidate === localBundle,
      }),
    ).resolves.toEqual({ path: localBundle, source: "desktop-user-bundle" });

    await expect(
      discoverCodexExecutable({
        ...common,
        exists: async (candidate) => candidate === appxBundle || candidate === pathBundle,
      }),
    ).resolves.toEqual({ path: pathBundle, source: "path" });
  });

  it("orders opaque materialized Desktop builds by executable freshness, not hash name", async () => {
    const localAppData = "C:\\Users\\fixture\\AppData\\Local";
    const newer = win.join(localAppData, "OpenAI", "Codex", "bin", "aaa-old-sort", "codex.exe");
    const older = win.join(localAppData, "OpenAI", "Codex", "bin", "zzz-new-sort", "codex.exe");

    await expect(
      discoverCodexExecutable({
        environment: {},
        exists: async (candidate) => candidate === newer || candidate === older,
        getAppxInstallLocations: async () => [],
        getLastModifiedMs: async (candidate) => (candidate === newer ? 200 : 100),
        listDirectoryNames: async (directory) =>
          directory.endsWith(win.join("OpenAI", "Codex", "bin"))
            ? ["aaa-old-sort", "zzz-new-sort"]
            : [],
        localAppData,
        pathValue: "",
        programFiles: "",
      }),
    ).resolves.toEqual({ path: newer, source: "desktop-user-bundle" });
  });

  it("reports a present WindowsApps bundle without exposing its path or attempting to select it", async () => {
    const appxRoot = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_fixture";
    const appxBundle = win.join(appxRoot, "app", "resources", "codex.exe");
    let error: unknown;

    try {
      await discoverCodexExecutable({
        environment: {},
        exists: async (candidate) => candidate === appxBundle,
        getAppxInstallLocations: async () => [appxRoot],
        listDirectoryNames: async () => [],
        localAppData: "C:\\Users\\fixture\\AppData\\Local",
        pathValue: "",
        programFiles: "C:\\Program Files",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: "CODEX_EXECUTABLE_NOT_FOUND",
    });
    expect((error as CodexExecutableNotFoundError).diagnostics).toContainEqual({
      code: "WINDOWS_APP_PACKAGE_REQUIRES_MATERIALIZED_BINARY",
      severity: "warning",
    });
    expect(String(error)).not.toContain(appxRoot);
  });

  it("rejects a missing explicit override instead of silently using another installation", async () => {
    await expect(
      discoverCodexExecutable({
        environment: { CODEX_REMOTE_CODEX_EXE: "D:\\missing\\codex.exe" },
        exists: async () => false,
        getAppxInstallLocations: async () => [],
        listDirectoryNames: async () => [],
        localAppData: "C:\\Users\\fixture\\AppData\\Local",
        pathValue: "C:\\bin",
        programFiles: "C:\\Program Files",
      }),
    ).rejects.toMatchObject({
      code: "CODEX_OVERRIDE_NOT_FOUND",
    });
  });

  it("keeps the former override name as a compatibility alias", async () => {
    const override = "D:\\Tools\\codex.exe";
    await expect(
      discoverCodexExecutable({
        environment: { CODEX_LOCAL_REMOTE_CODEX_PATH: override },
        exists: async (candidate) => candidate === override,
        getAppxInstallLocations: async () => [],
        listDirectoryNames: async () => [],
        localAppData: "",
        pathValue: "",
        programFiles: "",
      }),
    ).resolves.toEqual({ path: override, source: "environment" });
  });

  it("returns a diagnostic error without leaking the inspected machine paths", async () => {
    let error: unknown;
    try {
      await discoverCodexExecutable({
        environment: {},
        exists: async () => false,
        getAppxInstallLocations: async () => [],
        listDirectoryNames: async () => [],
        localAppData: "C:\\Users\\fixture\\AppData\\Local",
        pathValue: "D:\\secret-bin",
        programFiles: "C:\\Program Files",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CodexExecutableNotFoundError);
    expect(String(error)).not.toContain("fixture");
    expect(String(error)).not.toContain("secret-bin");
  });
});
