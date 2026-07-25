import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const scripts = join(repositoryRoot, "scripts", "windows");
const fixtures = join(import.meta.dirname, "fixtures");

interface FunnelState {
  _mockSetCalls?: number;
  TCP: Record<string, { HTTPS: boolean }>;
  Web: Record<
    string,
    {
      Handlers: Record<string, { Proxy: string }>;
    }
  >;
}

interface SchedulerState {
  Task: null | {
    TaskName: string;
    TaskPath: string;
    Description: string;
    Actions: Array<{
      Execute: string;
      Arguments: string;
      WorkingDirectory: string;
    }>;
  };
  Operations: string[];
}

function runPowerShell(script: string, arguments_: string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, ...arguments_],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, ...environment },
    },
  );
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value), "utf8");
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function mockHandlers(state: FunnelState) {
  const web = state.Web["mock.example.ts.net:443"];
  if (!web) throw new Error("Missing mock Funnel web handler");
  return web.Handlers;
}

function managedTask(state: SchedulerState) {
  if (!state.Task) throw new Error("Missing managed scheduler task");
  return state.Task;
}

windowsOnly("Windows script hardening", () => {
  let sandbox: string;
  let stateFile: string;
  let logFile: string;
  let localAppData: string;
  let port: number;

  beforeEach(() => {
    sandbox = join(tmpdir(), `codex-local-remote-windows-${process.pid}-${crypto.randomUUID()}`);
    mkdirSync(sandbox, { recursive: true });
    // GitHub-hosted Windows runners can expose TEMP through an 8.3 path
    // (RUNNER~1), while PowerShell canonicalizes it to the long path when it
    // resolves scheduled-task arguments. Keep both sides of the assertion in
    // the same canonical form.
    sandbox = realpathSync(sandbox);
    stateFile = join(sandbox, "tailscale-state.json");
    logFile = join(sandbox, "tailscale.log");
    localAppData = join(sandbox, "local-app-data");
    writeFileSync(logFile, "", "utf8");

    port = 18_791;
  });

  function funnelEnvironment(mode?: string): NodeJS.ProcessEnv {
    return {
      LOCALAPPDATA: localAppData,
      MOCK_TAILSCALE_LOG: logFile,
      MOCK_TAILSCALE_MODE: mode,
      MOCK_TAILSCALE_STATE: stateFile,
      PATH: `${fixtures};${process.env.PATH ?? ""}`,
    };
  }

  function runFunnel(
    target: "set" | "remove",
    arguments_: string[],
    environment: NodeJS.ProcessEnv,
  ) {
    return runPowerShell(
      join(fixtures, "funnel-mock-driver.ps1"),
      [
        "-TargetScript",
        join(
          scripts,
          target === "set" ? "Set-TailscaleFunnelRoute.ps1" : "Remove-TailscaleFunnelRoute.ps1",
        ),
        ...arguments_,
      ],
      environment,
    );
  }

  function initialState(includeProjectRoute = false): FunnelState {
    return {
      TCP: { "443": { HTTPS: true } },
      Web: {
        "mock.example.ts.net:443": {
          Handlers: {
            "/": { Proxy: "http://127.0.0.1:18000" },
            "/keep": { Proxy: "http://127.0.0.1:18001" },
            ...(includeProjectRoute
              ? {
                  "/codex-remote": {
                    Proxy: `http://127.0.0.1:${port}`,
                  },
                }
              : {}),
          },
        },
      },
    };
  }

  it.each(["/../escape", "/a//b", "/a/", "/a/./b", "/a/../b"])(
    "rejects non-canonical BasePath %s before touching Windows services",
    (basePath) => {
      const result = runFunnel("set", ["-BasePath", basePath], {
        PATH: `${fixtures};${process.env.PATH ?? ""}`,
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("not canonical");
    },
  );

  it("keeps WhatIf read-only and creates no backup", () => {
    writeJson(stateFile, initialState());
    const result = runFunnel("set", ["-Port", String(port), "-WhatIf"], funnelEnvironment());
    expect(result.status).toBe(0);
    expect(readFileSync(logFile, "utf8").trim().split(/\r?\n/u)).toHaveLength(1);
    expect(readJson<FunnelState>(stateFile)).toEqual(initialState());
    expect(existsSync(join(localAppData, "CodexLocalRemote", "funnel-backups"))).toBe(false);
  });

  it("adds only the project route and preserves every existing handler", () => {
    const before = initialState();
    writeJson(stateFile, before);
    const result = runFunnel("set", ["-Port", String(port)], funnelEnvironment());
    expect(result.status).toBe(0);
    const after = readJson<FunnelState>(stateFile);
    expect(mockHandlers(after)["/"]).toEqual(mockHandlers(before)["/"]);
    expect(mockHandlers(after)["/keep"]).toEqual(mockHandlers(before)["/keep"]);
    expect(mockHandlers(after)["/codex-remote"]).toEqual({
      Proxy: `http://127.0.0.1:${port}`,
    });
    expect(existsSync(join(localAppData, "CodexLocalRemote", "funnel-backups"))).toBe(true);
  });

  it("rolls back the project route when post-write verification fails", () => {
    const before = initialState();
    writeJson(stateFile, before);
    const result = runFunnel(
      "set",
      ["-Port", String(port)],
      funnelEnvironment("wrong-target-on-first-set"),
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("rolled back");
    const after = readJson<FunnelState>(stateFile);
    delete after._mockSetCalls;
    expect(after).toEqual(before);
  });

  it("refuses a stale write when another Funnel handler appears before mutation", () => {
    const before = initialState();
    writeJson(stateFile, before);
    const result = runFunnel(
      "set",
      ["-Port", String(port)],
      funnelEnvironment("drift-before-write"),
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("changed concurrently");
    const log = readFileSync(logFile, "utf8");
    expect(log).not.toContain('"--set-path=/codex-remote"');
    const after = readJson<FunnelState>(stateFile);
    expect(mockHandlers(after)["/codex-remote"]).toBeUndefined();
    expect(mockHandlers(after)["/concurrent"]).toEqual({
      Proxy: "http://127.0.0.1:18888",
    });
  });

  it("does not roll back over a project handler changed by another writer", () => {
    const before = initialState();
    writeJson(stateFile, before);
    const result = runFunnel(
      "set",
      ["-Port", String(port)],
      funnelEnvironment("foreignize-before-rollback"),
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("Automatic rollback was incomplete");
    const after = readJson<FunnelState>(stateFile);
    expect(mockHandlers(after)["/codex-remote"]).toEqual({
      Proxy: "http://127.0.0.1:19999",
    });
    const log = readFileSync(logFile, "utf8");
    expect(log).not.toContain('"off","--yes"');
  });

  it("refuses to remove a route whose target is not owned by this project", () => {
    const before = initialState();
    mockHandlers(before)["/codex-remote"] = {
      Proxy: "http://127.0.0.1:19999",
    };
    writeJson(stateFile, before);
    const result = runFunnel(
      "remove",
      ["-Port", String(port), "-ConfirmFalse"],
      funnelEnvironment(),
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("refusing to remove");
    expect(readJson<FunnelState>(stateFile)).toEqual(before);
  });

  it("removes only a live route verified as this project", () => {
    const before = initialState(true);
    writeJson(stateFile, before);
    const result = runFunnel(
      "remove",
      ["-Port", String(port), "-ConfirmFalse"],
      funnelEnvironment(),
    );
    expect(result.status).toBe(0);
    const after = readJson<FunnelState>(stateFile);
    expect(mockHandlers(after)["/codex-remote"]).toBeUndefined();
    expect(mockHandlers(after)["/keep"]).toEqual(mockHandlers(before)["/keep"]);
  });

  it("refuses a stale remove when the project route is foreignized before mutation", () => {
    const before = initialState(true);
    writeJson(stateFile, before);
    const result = runFunnel(
      "remove",
      ["-Port", String(port), "-ConfirmFalse"],
      funnelEnvironment("foreignize-remove-before-write"),
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("changed concurrently");
    const log = readFileSync(logFile, "utf8");
    expect(log).not.toContain('"off","--yes"');
    const after = readJson<FunnelState>(stateFile);
    expect(mockHandlers(after)["/codex-remote"]).toEqual({
      Proxy: "http://127.0.0.1:19999",
    });
  });

  it("does not restore over a route claimed by another writer during remove rollback", () => {
    const before = initialState(true);
    writeJson(stateFile, before);
    const result = runFunnel(
      "remove",
      ["-Port", String(port), "-ConfirmFalse"],
      funnelEnvironment("foreignize-remove-before-rollback"),
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("Automatic rollback was incomplete");
    const after = readJson<FunnelState>(stateFile);
    expect(mockHandlers(after)["/codex-remote"]).toEqual({
      Proxy: "http://127.0.0.1:19999",
    });
    const log = readFileSync(logFile, "utf8");
    expect(log).not.toContain('"--bg"');
  });

  it("refuses to overwrite or delete a same-name foreign scheduled task", () => {
    const installRoot = join(sandbox, "install root");
    const dataDir = join(sandbox, "state with spaces");
    const nodePath = join(sandbox, "Node Runtime", "node.exe");
    mkdirSync(dirname(nodePath), { recursive: true });
    mkdirSync(join(installRoot, "apps", "sidecar", "dist"), {
      recursive: true,
    });
    writeFileSync(nodePath, "", "utf8");
    writeFileSync(join(installRoot, "apps", "sidecar", "dist", "cli.js"), "", "utf8");
    const foreign = {
      Task: {
        TaskName: "Codex Local Remote",
        TaskPath: "\\",
        Description: "Unrelated task",
        Actions: [
          {
            Execute: nodePath,
            Arguments: "foreign",
            WorkingDirectory: installRoot,
          },
        ],
      },
      Operations: [],
    };

    for (const operation of ["register", "unregister"]) {
      writeJson(stateFile, foreign);
      const target =
        operation === "register"
          ? "Register-CodexLocalRemoteStartup.ps1"
          : "Unregister-CodexLocalRemoteStartup.ps1";
      const result = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
        "-TargetScript",
        join(scripts, target),
        "-StateFile",
        stateFile,
        "-Operation",
        operation,
        "-InstallRoot",
        installRoot,
        "-DataDir",
        dataDir,
        "-NodePath",
        nodePath,
      ]);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("refusing");
      expect(readJson<SchedulerState>(stateFile).Operations).toEqual([]);
    }
  });

  it("registers and removes only its exact managed task with Windows-safe quoting", () => {
    const installRoot = join(sandbox, "install root");
    const dataDir = join(sandbox, "state with spaces");
    const nodePath = join(sandbox, "Node Runtime", "node.exe");
    mkdirSync(dirname(nodePath), { recursive: true });
    mkdirSync(join(installRoot, "apps", "sidecar", "dist"), {
      recursive: true,
    });
    writeFileSync(nodePath, "", "utf8");
    writeFileSync(join(installRoot, "apps", "sidecar", "dist", "cli.js"), "", "utf8");
    writeJson(stateFile, { Task: null, Operations: [] });

    const commonArguments = [
      "-StateFile",
      stateFile,
      "-InstallRoot",
      installRoot,
      "-DataDir",
      dataDir,
      "-NodePath",
      nodePath,
    ];
    const registrationPreview = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "register",
      "-WhatIf",
      ...commonArguments,
    ]);
    expect(registrationPreview.status).toBe(0);
    expect(registrationPreview.stdout).toContain("what-if");
    expect(readJson<SchedulerState>(stateFile).Operations).toEqual([]);

    const registration = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "register",
      ...commonArguments,
    ]);
    expect(registration.status).toBe(0);
    const registered = readJson<SchedulerState>(stateFile);
    const task = managedTask(registered);
    expect(task.Description).toContain("codex-local-remote/startup-task/v1");
    expect(task.Actions[0]?.Arguments).toContain(
      `"${join(installRoot, "apps", "sidecar", "dist", "cli.js")}"`,
    );
    expect(task.Actions[0]?.Arguments).toContain(`"${dataDir}"`);
    expect(registered.Operations).toEqual(["register"]);

    const removalPreview = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Unregister-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "unregister",
      "-WhatIf",
      ...commonArguments,
    ]);
    expect(removalPreview.status).toBe(0);
    expect(removalPreview.stdout).toContain("what-if");
    expect(readJson<SchedulerState>(stateFile).Operations).toEqual(["register"]);

    const removal = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Unregister-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "unregister",
      ...commonArguments,
    ]);
    expect(removal.status).toBe(0);
    const removed = readJson<SchedulerState>(stateFile);
    expect(removed.Task).toBeNull();
    expect(removed.Operations).toEqual(["register", "stop", "unregister"]);
  });
});
