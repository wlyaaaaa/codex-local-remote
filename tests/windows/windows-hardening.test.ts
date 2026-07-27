import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
    State?: string;
    Description: string;
    Actions: Array<{
      Execute: string;
      Arguments: string;
      WorkingDirectory: string;
    }>;
    Triggers?: Array<{
      CimClassName: string;
      UserId: string;
      Enabled: boolean;
    }>;
    Principal?: {
      UserId: string;
      LogonType: string;
      RunLevel: string;
    };
    Settings?: Record<string, unknown>;
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

function exactSchedulerFingerprint() {
  const identity = spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    ],
    { encoding: "utf8" },
  ).stdout.trim();
  return {
    Triggers: [
      {
        CimClassName: "MSFT_TaskLogonTrigger",
        UserId: identity,
        Enabled: true,
      },
    ],
    Principal: {
      UserId: identity,
      LogonType: "Interactive",
      RunLevel: "Limited",
    },
    Settings: {
      DisallowStartIfOnBatteries: false,
      StopIfGoingOnBatteries: false,
      ExecutionTimeLimit: "P3650D",
      MultipleInstances: "IgnoreNew",
      RestartCount: 3,
      RestartInterval: "PT1M",
      StartWhenAvailable: true,
      Enabled: true,
      AllowDemandStart: true,
      RunOnlyIfIdle: false,
      RunOnlyIfNetworkAvailable: false,
    },
  };
}

function expectSameFileSystemEntry(actual: string, expected: string) {
  const actualStat = statSync(actual);
  const expectedStat = statSync(expected);
  expect({ dev: actualStat.dev, ino: actualStat.ino }).toEqual({
    dev: expectedStat.dev,
    ino: expectedStat.ino,
  });
}

function inspectDataDirectoryAcl(path: string) {
  const result = runPowerShell(join(fixtures, "broker-module-driver.ps1"), [
    "-ModulePath",
    join(scripts, "CodexLocalRemote.Windows.psm1"),
    "-Operation",
    "inspect-data-dir-acl",
    "-DataDir",
    path,
  ]);
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as unknown;
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
    target: "set" | "remove" | "status",
    arguments_: string[],
    environment: NodeJS.ProcessEnv,
  ) {
    return runPowerShell(
      join(fixtures, "funnel-mock-driver.ps1"),
      [
        "-TargetScript",
        join(
          scripts,
          target === "set"
            ? "Set-TailscaleFunnelRoute.ps1"
            : target === "remove"
              ? "Remove-TailscaleFunnelRoute.ps1"
              : "Get-CodexLocalRemoteStatus.ps1",
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
                    Proxy: `http://127.0.0.1:${port}/codex-remote`,
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
      Proxy: `http://127.0.0.1:${port}/codex-remote`,
    });
    expect(readFileSync(logFile, "utf8")).toContain(`"http://127.0.0.1:${port}/codex-remote"`);
    expect(existsSync(join(localAppData, "CodexLocalRemote", "funnel-backups"))).toBe(true);
  });

  it("upgrades the exact legacy pathless target without changing other handlers", () => {
    const before = initialState(true);
    mockHandlers(before)["/codex-remote"] = {
      Proxy: `http://127.0.0.1:${port}`,
    };
    writeJson(stateFile, before);

    const result = runFunnel("set", ["-Port", String(port)], funnelEnvironment());
    expect(result.status).toBe(0);
    const after = readJson<FunnelState>(stateFile);
    expect(mockHandlers(after)["/"]).toEqual(mockHandlers(before)["/"]);
    expect(mockHandlers(after)["/keep"]).toEqual(mockHandlers(before)["/keep"]);
    expect(mockHandlers(after)["/codex-remote"]).toEqual({
      Proxy: `http://127.0.0.1:${port}/codex-remote`,
    });
  });

  it("restores the exact legacy target when upgrade verification fails", () => {
    const before = initialState(true);
    mockHandlers(before)["/codex-remote"] = {
      Proxy: `http://127.0.0.1:${port}`,
    };
    writeJson(stateFile, before);

    const result = runFunnel(
      "set",
      ["-Port", String(port)],
      funnelEnvironment("wrong-target-on-first-set"),
    );
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("rolled back");
    const after = readJson<FunnelState>(stateFile);
    delete after._mockSetCalls;
    expect(after).toEqual(before);
  });

  it("reports the public route configured only for the prefix-preserving target", () => {
    writeJson(stateFile, initialState(true));
    const configured = runFunnel("status", ["-Port", String(port)], funnelEnvironment());
    expect(configured.status).toBe(0);
    expect(configured.stdout).toContain('"PublicRoute":"configured"');

    const stale = initialState(true);
    mockHandlers(stale)["/codex-remote"] = {
      Proxy: `http://127.0.0.1:${port}`,
    };
    writeJson(stateFile, stale);
    const notConfigured = runFunnel("status", ["-Port", String(port)], funnelEnvironment());
    expect(notConfigured.status).toBe(0);
    expect(notConfigured.stdout).toContain('"PublicRoute":"not-configured"');
  }, 30_000);

  it("emits one machine-readable status object across a pwsh process boundary", () => {
    writeJson(stateFile, initialState(true));

    const result = runFunnel("status", ["-Port", String(port), "-Json"], funnelEnvironment());

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout) as Record<string, unknown>).toMatchObject({
      Product: "Codex Local Remote",
      PublicRoute: "configured",
      Ready: false,
    });
  });

  it("rolls back the project route when post-write verification fails", () => {
    const before = initialState();
    writeJson(stateFile, before);
    const result = runFunnel(
      "set",
      ["-Port", String(port)],
      funnelEnvironment("wrong-target-on-first-set"),
    );
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
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

  it("can remove the exact verified legacy pathless project route", () => {
    const before = initialState(true);
    mockHandlers(before)["/codex-remote"] = {
      Proxy: `http://127.0.0.1:${port}`,
    };
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
    mkdirSync(join(installRoot, "apps", "broker", "dist"), {
      recursive: true,
    });
    mkdirSync(join(installRoot, "scripts", "windows"), { recursive: true });
    writeFileSync(nodePath, "", "utf8");
    writeFileSync(join(installRoot, "apps", "sidecar", "dist", "cli.js"), "", "utf8");
    writeFileSync(join(installRoot, "apps", "broker", "dist", "cli.js"), "", "utf8");
    writeFileSync(
      join(installRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1"),
      "",
      "utf8",
    );
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
    mkdirSync(join(installRoot, "apps", "broker", "dist"), {
      recursive: true,
    });
    mkdirSync(join(installRoot, "scripts", "windows"), { recursive: true });
    writeFileSync(nodePath, "", "utf8");
    writeFileSync(join(installRoot, "apps", "sidecar", "dist", "cli.js"), "", "utf8");
    writeFileSync(join(installRoot, "apps", "broker", "dist", "cli.js"), "", "utf8");
    writeFileSync(
      join(installRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1"),
      "",
      "utf8",
    );
    mkdirSync(dataDir, { recursive: true });
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
    const aclBeforePreview = inspectDataDirectoryAcl(dataDir);
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
    expect(inspectDataDirectoryAcl(dataDir)).toEqual(aclBeforePreview);

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
    expect(task.Description).toContain("codex-local-remote/startup-task/v3");
    const action = task.Actions[0];
    expect(action).toBeDefined();
    if (!action) throw new Error("Missing managed scheduler action");
    const bootstrapMatch = action.Arguments.match(/-File "([^"]+)"/);
    const dataDirMatch = action.Arguments.match(/-DataDir "([^"]+)"/);
    expect(bootstrapMatch).not.toBeNull();
    expect(dataDirMatch).not.toBeNull();
    if (!bootstrapMatch?.[1] || !dataDirMatch?.[1]) {
      throw new Error("Scheduled-task arguments are not safely quoted");
    }
    expectSameFileSystemEntry(
      bootstrapMatch[1],
      join(installRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1"),
    );
    expectSameFileSystemEntry(dataDirMatch[1], dataDir);
    expect(action.Arguments).toContain("-BrokerPort 18791");
    expect(action.Arguments).toContain("-SidecarPort 18790");
    expect(task).toMatchObject(exactSchedulerFingerprint());
    expect(registered.Operations).toEqual(["register"]);

    const idempotentRegistration = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "register",
      ...commonArguments,
    ]);
    expect(
      idempotentRegistration.status,
      `${idempotentRegistration.stdout}${idempotentRegistration.stderr}`,
    ).toBe(0);
    expect(idempotentRegistration.stdout).toContain("already-registered");
    expect(readJson<SchedulerState>(stateFile).Operations).toEqual(["register"]);

    const staleStart = runPowerShell(
      join(fixtures, "scheduler-mock-driver.ps1"),
      [
        "-TargetScript",
        join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
        "-Operation",
        "register",
        "-Start",
        ...commonArguments,
      ],
      { MOCK_SCHEDULER_SWAP_ON_GET_COUNT: "2" },
    );
    expect(staleStart.status, `${staleStart.stdout}${staleStart.stderr}`).not.toBe(0);
    const replacedBeforeStart = readJson<SchedulerState>(stateFile);
    expect(replacedBeforeStart.Operations).toEqual(["register"]);
    expect(managedTask(replacedBeforeStart).Description).toBe("foreign replacement");
    writeJson(stateFile, registered);

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
  }, 15_000);

  it("upgrades only an exact pinned-runtime V2 task to the dynamic V3 action", () => {
    const installRoot = join(sandbox, "pinned v2 install");
    const dataDir = join(sandbox, "pinned v2 state");
    const nodePath = join(sandbox, "pinned v2 node", "node.exe");
    const codexPath = join(sandbox, "old desktop cache", "codex.exe");
    for (const path of [
      nodePath,
      codexPath,
      join(installRoot, "apps", "sidecar", "dist", "cli.js"),
      join(installRoot, "apps", "broker", "dist", "cli.js"),
      join(installRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1"),
    ]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "", "utf8");
    }
    writeJson(stateFile, { Task: null, Operations: [] });
    const common = [
      "-StateFile",
      stateFile,
      "-InstallRoot",
      installRoot,
      "-DataDir",
      dataDir,
      "-NodePath",
      nodePath,
      "-CodexPath",
      codexPath,
    ];
    const initial = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "register",
      ...common,
    ]);
    expect(initial.status, `${initial.stdout}${initial.stderr}`).toBe(0);
    const pinned = readJson<SchedulerState>(stateFile);
    const pinnedTask = managedTask(pinned);
    pinnedTask.Description =
      "codex-local-remote/startup-task/v2 - Starts the loopback app-server broker before the local-only Codex Local Remote sidecar at user sign-in.";
    const pinnedAction = pinnedTask.Actions[0];
    if (!pinnedAction) throw new Error("Missing pinned task action");
    pinnedAction.Arguments = pinnedAction.Arguments.replace(
      "-NodePath",
      `-CodexPath "${codexPath}" -NodePath`,
    );
    pinnedTask.State = "Running";
    pinned.Operations = [];
    writeJson(stateFile, pinned);

    const upgrade = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "register",
      ...common,
    ]);

    expect(upgrade.status, `${upgrade.stdout}${upgrade.stderr}`).toBe(0);
    expect(upgrade.stdout).toContain("upgraded-pinned-v2");
    const upgraded = readJson<SchedulerState>(stateFile);
    expect(managedTask(upgraded).Description).toContain("startup-task/v3");
    expect(managedTask(upgraded).Actions[0]?.Arguments).not.toContain("-CodexPath");
    expect(managedTask(upgraded).State).toBe("Running");
    expect(upgraded.Operations).toEqual(["register"]);
  });

  it("requires NoStart before upgrading a running pinned-runtime V2 task", () => {
    const installRoot = join(sandbox, "running pinned v2 install");
    const dataDir = join(sandbox, "running pinned v2 state");
    const nodePath = join(sandbox, "running pinned v2 node", "node.exe");
    const codexPath = join(sandbox, "running desktop cache", "codex.exe");
    for (const path of [
      nodePath,
      codexPath,
      join(installRoot, "apps", "sidecar", "dist", "cli.js"),
      join(installRoot, "apps", "broker", "dist", "cli.js"),
      join(installRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1"),
    ]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "", "utf8");
    }
    writeJson(stateFile, { Task: null, Operations: [] });
    const common = [
      "-StateFile",
      stateFile,
      "-InstallRoot",
      installRoot,
      "-DataDir",
      dataDir,
      "-NodePath",
      nodePath,
      "-CodexPath",
      codexPath,
    ];
    const initial = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "register",
      ...common,
    ]);
    expect(initial.status, `${initial.stdout}${initial.stderr}`).toBe(0);
    const pinned = readJson<SchedulerState>(stateFile);
    const pinnedTask = managedTask(pinned);
    pinnedTask.Description =
      "codex-local-remote/startup-task/v2 - Starts the loopback app-server broker before the local-only Codex Local Remote sidecar at user sign-in.";
    const pinnedAction = pinnedTask.Actions[0];
    if (!pinnedAction) throw new Error("Missing pinned task action");
    pinnedAction.Arguments = pinnedAction.Arguments.replace(
      "-NodePath",
      `-CodexPath "${codexPath}" -NodePath`,
    );
    pinnedTask.State = "Running";
    pinned.Operations = [];
    writeJson(stateFile, pinned);

    const unsafeUpgrade = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "register",
      "-Start",
      ...common,
    ]);

    expect(unsafeUpgrade.status).not.toBe(0);
    expect(`${unsafeUpgrade.stdout}${unsafeUpgrade.stderr}`).toContain("requires -NoStart");
    const unchanged = readJson<SchedulerState>(stateFile);
    expect(managedTask(unchanged).Description).toContain("startup-task/v2");
    expect(managedTask(unchanged).State).toBe("Running");
    expect(unchanged.Operations).toEqual([]);
  });

  it("refuses the exact V1 task and directs the user to the migration script", () => {
    const installRoot = join(sandbox, "legacy install root");
    const dataDir = join(sandbox, "legacy state root");
    const nodePath = join(sandbox, "Legacy Node", "node.exe");
    const sidecarCli = join(installRoot, "apps", "sidecar", "dist", "cli.js");
    mkdirSync(dirname(nodePath), { recursive: true });
    mkdirSync(dirname(sidecarCli), { recursive: true });
    mkdirSync(join(installRoot, "apps", "broker", "dist"), { recursive: true });
    mkdirSync(join(installRoot, "scripts", "windows"), { recursive: true });
    writeFileSync(nodePath, "", "utf8");
    writeFileSync(sidecarCli, "", "utf8");
    writeFileSync(join(installRoot, "apps", "broker", "dist", "cli.js"), "", "utf8");
    writeFileSync(
      join(installRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1"),
      "",
      "utf8",
    );
    writeJson(stateFile, {
      Task: {
        ...exactSchedulerFingerprint(),
        TaskName: "Codex Local Remote",
        TaskPath: "\\",
        Description:
          "codex-local-remote/startup-task/v1 - Starts the local-only Codex Local Remote sidecar at user sign-in.",
        Actions: [
          {
            Execute: nodePath,
            Arguments: `"${sidecarCli}" serve --host 127.0.0.1 --port 18790 --base-path /codex-remote --data-dir "${dataDir}"`,
            WorkingDirectory: installRoot,
          },
        ],
      },
      Operations: [],
    });

    const result = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-StateFile",
      stateFile,
      "-Operation",
      "register",
      "-InstallRoot",
      installRoot,
      "-DataDir",
      dataDir,
      "-NodePath",
      nodePath,
    ]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("Migrate-CodexLocalRemoteSharedOwner.ps1");
    const unchanged = readJson<SchedulerState>(stateFile);
    expect(managedTask(unchanged).Description).toContain("startup-task/v1");
    expect(unchanged.Operations).toEqual([]);
  });

  it("does not overwrite a same-name task that wins the create race", () => {
    const installRoot = join(sandbox, "registration collision");
    const dataDir = join(sandbox, "registration collision state");
    const nodePath = join(sandbox, "registration collision node", "node.exe");
    mkdirSync(dirname(nodePath), { recursive: true });
    mkdirSync(join(installRoot, "apps", "sidecar", "dist"), { recursive: true });
    mkdirSync(join(installRoot, "apps", "broker", "dist"), { recursive: true });
    mkdirSync(join(installRoot, "scripts", "windows"), { recursive: true });
    writeFileSync(nodePath, "", "utf8");
    writeFileSync(join(installRoot, "apps", "sidecar", "dist", "cli.js"), "", "utf8");
    writeFileSync(join(installRoot, "apps", "broker", "dist", "cli.js"), "", "utf8");
    writeFileSync(
      join(installRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1"),
      "",
      "utf8",
    );
    writeJson(stateFile, { Task: null, Operations: [] });

    const result = runPowerShell(
      join(fixtures, "scheduler-mock-driver.ps1"),
      [
        "-TargetScript",
        join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
        "-StateFile",
        stateFile,
        "-Operation",
        "register",
        "-InstallRoot",
        installRoot,
        "-DataDir",
        dataDir,
        "-NodePath",
        nodePath,
      ],
      { MOCK_SCHEDULER_COLLIDE_ON_REGISTER: "1" },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    const collided = readJson<SchedulerState>(stateFile);
    expect(collided.Operations).toEqual([]);
    expect(managedTask(collided).Description).toBe("foreign collision");
  });

  it.each([
    { mode: "fail", expectedOperation: [] },
    { mode: "still-running", expectedOperation: ["stop"] },
  ])("refuses uninstall when the exact task stop is $mode", ({ mode, expectedOperation }) => {
    const installRoot = join(sandbox, `uninstall ${mode}`);
    const dataDir = join(sandbox, `uninstall state ${mode}`);
    const nodePath = join(sandbox, `uninstall node ${mode}`, "node.exe");
    mkdirSync(dirname(nodePath), { recursive: true });
    mkdirSync(join(installRoot, "apps", "sidecar", "dist"), { recursive: true });
    mkdirSync(join(installRoot, "apps", "broker", "dist"), { recursive: true });
    mkdirSync(join(installRoot, "scripts", "windows"), { recursive: true });
    writeFileSync(nodePath, "", "utf8");
    writeFileSync(join(installRoot, "apps", "sidecar", "dist", "cli.js"), "", "utf8");
    writeFileSync(join(installRoot, "apps", "broker", "dist", "cli.js"), "", "utf8");
    writeFileSync(
      join(installRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1"),
      "",
      "utf8",
    );
    writeJson(stateFile, { Task: null, Operations: [] });
    const common = [
      "-StateFile",
      stateFile,
      "-InstallRoot",
      installRoot,
      "-DataDir",
      dataDir,
      "-NodePath",
      nodePath,
    ];
    const registration = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "register",
      ...common,
    ]);
    expect(registration.status).toBe(0);
    const beforeRemoval = readJson<SchedulerState>(stateFile);
    managedTask(beforeRemoval).State = "Running";
    beforeRemoval.Operations = [];
    writeJson(stateFile, beforeRemoval);

    const removal = runPowerShell(
      join(fixtures, "scheduler-mock-driver.ps1"),
      [
        "-TargetScript",
        join(scripts, "Unregister-CodexLocalRemoteStartup.ps1"),
        "-Operation",
        "unregister",
        ...common,
      ],
      { MOCK_SCHEDULER_STOP_MODE: mode },
    );

    expect(removal.status, `${removal.stdout}${removal.stderr}`).not.toBe(0);
    const afterRemoval = readJson<SchedulerState>(stateFile);
    expect(afterRemoval.Operations, `${removal.stdout}${removal.stderr}`).toEqual(
      expectedOperation,
    );
    expect(managedTask(afterRemoval).Description).toContain("startup-task/v3");
  });

  it("refuses to delete a task replaced after exact process cleanup", () => {
    const installRoot = join(sandbox, "uninstall swap");
    const dataDir = join(sandbox, "uninstall swap state");
    const nodePath = join(sandbox, "uninstall swap node", "node.exe");
    mkdirSync(dirname(nodePath), { recursive: true });
    mkdirSync(join(installRoot, "apps", "sidecar", "dist"), { recursive: true });
    mkdirSync(join(installRoot, "apps", "broker", "dist"), { recursive: true });
    mkdirSync(join(installRoot, "scripts", "windows"), { recursive: true });
    writeFileSync(nodePath, "", "utf8");
    writeFileSync(join(installRoot, "apps", "sidecar", "dist", "cli.js"), "", "utf8");
    writeFileSync(join(installRoot, "apps", "broker", "dist", "cli.js"), "", "utf8");
    writeFileSync(
      join(installRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1"),
      "",
      "utf8",
    );
    writeJson(stateFile, { Task: null, Operations: [] });
    const common = [
      "-StateFile",
      stateFile,
      "-InstallRoot",
      installRoot,
      "-DataDir",
      dataDir,
      "-NodePath",
      nodePath,
    ];
    const registration = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "register",
      ...common,
    ]);
    expect(registration.status).toBe(0);
    const beforeRemoval = readJson<SchedulerState>(stateFile);
    managedTask(beforeRemoval).State = "Running";
    beforeRemoval.Operations = [];
    writeJson(stateFile, beforeRemoval);

    const removal = runPowerShell(
      join(fixtures, "scheduler-mock-driver.ps1"),
      [
        "-TargetScript",
        join(scripts, "Unregister-CodexLocalRemoteStartup.ps1"),
        "-Operation",
        "unregister",
        ...common,
      ],
      { MOCK_SCHEDULER_SWAP_ON_GET_COUNT: "4" },
    );

    expect(removal.status, `${removal.stdout}${removal.stderr}`).not.toBe(0);
    const afterRemoval = readJson<SchedulerState>(stateFile);
    expect(afterRemoval.Operations, `${removal.stdout}${removal.stderr}`).toEqual(["stop"]);
    expect(managedTask(afterRemoval).Description).toBe("foreign replacement");
  });
});
