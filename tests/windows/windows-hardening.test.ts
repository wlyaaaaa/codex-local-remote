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

interface ShortcutOwnershipResult {
  Operation: "preflight" | "install" | "rollback";
  RaceMode:
    | "none"
    | "foreign-before-preimage"
    | "target-created-after-preimage"
    | "foreign-before-rollback"
    | "foreign-during-complete";
  RootKind: "candidate" | "previous";
  Shape:
    | "exact"
    | "minimized"
    | "non-elevated"
    | "visible"
    | "pre-takeover"
    | "visible-pre-takeover"
    | "localized-description"
    | "codepage-description"
    | "codepage-non-elevated"
    | "codepage-minimized"
    | "codepage-foreign-drift"
    | "foreign-drift";
  IconDrift: boolean;
  PathKind: "file" | "directory" | "dangling-reparse" | "missing";
  AuthoritySawReparse: boolean;
  Accepted: boolean;
  Failure: string | null;
  HashUnchanged: boolean;
  LengthUnchanged: boolean;
  LastWriteTimeUnchanged: boolean;
  ItemKindUnchanged: boolean;
  InstallStatus: "created" | "reused" | "upgraded" | null;
  RollbackStatus: "removed-created" | "restored-upgrade" | "not-needed" | null;
  TargetForeign: boolean;
  PreImageCount: number;
  PreImageManaged: boolean;
  RacerPreservedManaged: boolean;
  TemporaryCount: number;
  MoveCalls: number;
  TargetWindowStyle: number | null;
  TargetRunAsUser: boolean | null;
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

function makeLegacyAutoStart<
  T extends {
    Triggers?: Array<{
      CimClassName?: string;
      UserId?: string;
      Enabled: boolean;
    }>;
    Principal?: { UserId: string };
    Settings?: Record<string, unknown>;
  },
>(task: T) {
  if (!task.Settings || !task.Principal) {
    throw new Error("Missing scheduler principal/settings for legacy auto-start task");
  }
  task.Triggers = [
    {
      CimClassName: "MSFT_TaskLogonTrigger",
      UserId: task.Principal.UserId,
      Enabled: true,
    },
  ];
  task.Settings.StartWhenAvailable = true;
  task.Settings.RestartCount = 3;
  task.Settings.RestartInterval = "PT1M";
  return task;
}

function makeLegacyDesktopOwningV3(state: SchedulerState) {
  const task = makeLegacyAutoStart(managedTask(state));
  const action = task.Actions[0];
  const currentSuffix = " -DesktopOwnerCoordinator -TakeOverExistingNativeDesktop";
  if (!action?.Arguments.includes(currentSuffix)) {
    throw new Error("Missing canonical Desktop-owner coordinator switches");
  }
  task.Description =
    "codex-local-remote/startup-task/v3 - Starts the loopback app-server broker before the local-only Codex Local Remote sidecar at user sign-in.";
  action.Arguments = action.Arguments.replace(currentSuffix, " -TakeOverExistingNativeDesktop");
  return task;
}

type SchedulerAction = NonNullable<SchedulerState["Task"]>["Actions"][number];

function unwrapHeadlessAction(action: SchedulerAction) {
  const prefix = action.Arguments.match(/^--headless ("[^"]+"|\S+) /);
  if (!prefix) throw new Error("Missing headless console-host prefix");
  const encodedPwsh = prefix[1];
  if (!encodedPwsh) throw new Error("Missing PowerShell path in headless prefix");
  action.Execute = encodedPwsh.startsWith('"') ? encodedPwsh.slice(1, -1) : encodedPwsh;
  action.Arguments = action.Arguments.slice(prefix[0].length);
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
    Triggers: [],
    Principal: {
      UserId: identity,
      LogonType: "Interactive",
      RunLevel: "Highest",
    },
    Settings: {
      DisallowStartIfOnBatteries: false,
      StopIfGoingOnBatteries: false,
      ExecutionTimeLimit: "P3650D",
      MultipleInstances: "IgnoreNew",
      RestartCount: 0,
      RestartInterval: "",
      StartWhenAvailable: false,
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
  it("requires elevation before live runtime admission while preserving WhatIf", () => {
    const registration = readFileSync(
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "utf8",
    );
    const preflight = registration.indexOf(
      "if (-not $WhatIfPreference) {\n    Assert-HighestRunLevelRegistrationAllowed\n}",
    );
    const liveAdmission = registration.indexOf("$registrationPendingGate = $null");
    const unavailableDetails = registration.indexOf(
      "The active Broker process details are unavailable.",
    );
    const activeEvidence = registration.indexOf("function Get-RegistrationActiveRuntimeEvidence");
    const processRead = registration.indexOf("$process = Get-CimInstance", activeEvidence);
    const ownershipCheck = registration.indexOf(
      "$ownership = Test-ManagedBrokerProcess",
      unavailableDetails,
    );

    expect(preflight).toBeGreaterThan(
      registration.indexOf("function Assert-HighestRunLevelRegistrationAllowed"),
    );
    expect(liveAdmission).toBeGreaterThan(preflight);
    expect(unavailableDetails).toBeGreaterThan(processRead);
    expect(ownershipCheck).toBeGreaterThan(unavailableDetails);
  });

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

  function shortcutOwnership(
    rootKind: ShortcutOwnershipResult["RootKind"],
    shape: ShortcutOwnershipResult["Shape"],
    iconDrift = false,
    pathKind: ShortcutOwnershipResult["PathKind"] = "file",
    operation: ShortcutOwnershipResult["Operation"] = "preflight",
    raceMode: ShortcutOwnershipResult["RaceMode"] = "none",
  ): ShortcutOwnershipResult {
    const arguments_ = [
      "-RegistrationPath",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-SandboxRoot",
      sandbox,
      "-RootKind",
      rootKind,
      "-Shape",
      shape,
      "-PathKind",
      pathKind,
      "-Operation",
      operation,
      "-RaceMode",
      raceMode,
    ];
    if (iconDrift) arguments_.push("-IconDrift");
    const result = runPowerShell(
      join(fixtures, "launcher-shortcut-ownership-driver.ps1"),
      arguments_,
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return JSON.parse(result.stdout) as ShortcutOwnershipResult;
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

  it("preflights launcher ownership before runtime-cache and registration writes", () => {
    const registration = readFileSync(
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "utf8",
    );
    const managedStart = registration.indexOf("if ($ownership.Kind -cin @(");
    const freshStart = registration.indexOf("} elseif ($PSCmdlet.ShouldProcess(", managedStart);
    const managed = registration.slice(managedStart, freshStart);
    const fresh = registration.slice(freshStart);
    const entryStart = registration.indexOf("$existing = Get-ScheduledTask");
    const beforeShouldProcess = registration.slice(entryStart, managedStart);
    expect(beforeShouldProcess).not.toContain("Resolve-CodexDesktopRuntime");

    for (const branch of [managed, fresh]) {
      const preflight = branch.indexOf("Assert-ManagedLauncherShortcutOwnership");
      const runtimeCacheWrite = branch.indexOf("Resolve-CodexDesktopRuntime");
      const dataDirectoryWrite = branch.indexOf("Protect-CodexLocalRemoteDataDirectory");
      expect(preflight).toBeGreaterThan(-1);
      expect(dataDirectoryWrite).toBeGreaterThan(preflight);
      expect(runtimeCacheWrite).toBeGreaterThan(dataDirectoryWrite);
    }
  });

  it("publishes the managed alias through the stable explicit Open dispatcher", () => {
    const registration = readFileSync(
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "utf8",
    );
    const definitionStart = registration.indexOf("function Get-ManagedLauncherShortcutDefinition");
    const definitionEnd = registration.indexOf(
      "\nfunction Get-ManagedLauncherShortcutLinkFlags",
      definitionStart,
    );
    const definition = registration.slice(definitionStart, definitionEnd);

    expect(definition).toContain("Get-CodexLocalRemoteControlDispatcherPath");
    expect(definition).toContain("'-Operation'");
    expect(definition).toContain("'Open'");
    expect(definition).toContain("'-AllowDesktopRestart'");
    expect(definition).toContain("'-InteractiveShortcutFeedback'");
    expect(definition).toContain("$isLegacyRuntimeLauncher");
    expect(definition).toContain("Launch-CodexWithRemote.ps1");
  });

  it("compensates registration and unregistration across owned artifacts", () => {
    const registration = readFileSync(
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "utf8",
    );
    const removal = readFileSync(join(scripts, "Unregister-CodexLocalRemoteStartup.ps1"), "utf8");

    expect(
      registration.match(/Restore-RegistrationRuntimeBindingBaseline/gu)?.length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      registration.match(/Restore-RegistrationAncillaryPreImages/gu)?.length,
    ).toBeGreaterThanOrEqual(3);
    expect(registration).toContain("$registrationCommitted = $true");
    expect(registration.indexOf("Install-RegistrationControlDispatcher")).toBeLessThan(
      registration.lastIndexOf("Complete-ManagedLauncherShortcutTransaction"),
    );
    expect(removal).toContain("Restore-UnregistrationOrdinaryFilePreImages");
    expect(removal.lastIndexOf("Unregister-ScheduledTask")).toBeGreaterThan(
      removal.lastIndexOf("Remove-CodexLocalRemoteDesiredMode"),
    );
  });

  it.each([
    ["candidate", "exact"],
    ["candidate", "minimized"],
    ["candidate", "non-elevated"],
    ["candidate", "visible"],
    ["candidate", "pre-takeover"],
    ["candidate", "visible-pre-takeover"],
    ["candidate", "localized-description"],
    ["candidate", "codepage-description"],
    ["previous", "exact"],
    ["previous", "minimized"],
    ["previous", "non-elevated"],
    ["previous", "visible"],
    ["previous", "pre-takeover"],
    ["previous", "visible-pre-takeover"],
    ["previous", "localized-description"],
    ["previous", "codepage-description"],
  ] as const)("accepts a read-only %s-root %s launcher preflight", (rootKind, shape) => {
    expect(shortcutOwnership(rootKind, shape)).toMatchObject({
      RootKind: rootKind,
      Shape: shape,
      IconDrift: false,
      Accepted: true,
      Failure: null,
      HashUnchanged: true,
      LengthUnchanged: true,
      LastWriteTimeUnchanged: true,
    });
  });

  it.each(["candidate", "previous"] as const)(
    "accepts an otherwise exact %s-root launcher with a historical icon",
    (rootKind) => {
      expect(shortcutOwnership(rootKind, "exact", true)).toMatchObject({
        RootKind: rootKind,
        Shape: "exact",
        IconDrift: true,
        Accepted: true,
        Failure: null,
        HashUnchanged: true,
        LengthUnchanged: true,
        LastWriteTimeUnchanged: true,
      });
    },
  );

  it("rejects foreign launcher argument drift without mutating the shortcut", () => {
    const result = shortcutOwnership("previous", "foreign-drift");

    expect(result).toMatchObject({
      Accepted: false,
      HashUnchanged: true,
      LengthUnchanged: true,
      LastWriteTimeUnchanged: true,
    });
    expect(result.Failure).toContain("not the exact managed Codex Remote entry");
  });

  it.each([
    ["codepage-description", true],
    ["codepage-non-elevated", false],
    ["codepage-minimized", false],
    ["codepage-foreign-drift", false],
  ] as const)(
    "rejects the code-page alias when another ownership field drifts in %s",
    (shape, iconDrift) => {
      const result = shortcutOwnership("previous", shape, iconDrift);
      expect(result).toMatchObject({
        Accepted: false,
        HashUnchanged: true,
        LengthUnchanged: true,
        LastWriteTimeUnchanged: true,
      });
      expect(result.Failure).toContain("not the exact managed Codex Remote entry");
    },
  );

  it("upgrades a managed launcher through a no-overwrite preimage transaction", () => {
    const result = shortcutOwnership("previous", "pre-takeover", false, "file", "install", "none");
    expect(result).toMatchObject({
      Accepted: true,
      Failure: null,
      InstallStatus: "upgraded",
      TargetForeign: false,
      PreImageCount: 0,
      TemporaryCount: 0,
      MoveCalls: 3,
    });

    const registration = readFileSync(
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "utf8",
    );
    const installStart = registration.indexOf("function Install-ManagedLauncherShortcut");
    const installEnd = registration.indexOf(
      "\nfunction Test-RegistrationTaskXmlRuntimeRoot",
      installStart,
    );
    const install = registration.slice(installStart, installEnd);
    expect(install).toContain("Move-ManagedLauncherShortcutNoOverwrite");
    expect(install).not.toContain("Move-Item");
    expect(registration).toContain("[System.IO.File]::Move($sourcePath, $destinationPath, $false)");
  });

  it("transactionally upgrades the historical localized launcher description", () => {
    const result = shortcutOwnership(
      "previous",
      "localized-description",
      false,
      "file",
      "install",
      "none",
    );
    expect(result).toMatchObject({
      Accepted: true,
      Failure: null,
      InstallStatus: "upgraded",
      TargetForeign: false,
      PreImageCount: 0,
      TemporaryCount: 0,
      MoveCalls: 3,
    });
  });

  it("transactionally upgrades an exact style-7 launcher to normal style", () => {
    const result = shortcutOwnership("previous", "minimized", false, "file", "install", "none");
    expect(result).toMatchObject({
      Accepted: true,
      Failure: null,
      InstallStatus: "upgraded",
      TargetWindowStyle: 1,
      PreImageCount: 0,
      TemporaryCount: 0,
    });
  });

  it("transactionally upgrades an exact non-elevated launcher to RunAsUser", () => {
    const result = shortcutOwnership("previous", "non-elevated", false, "file", "install", "none");
    expect(result).toMatchObject({
      Accepted: true,
      Failure: null,
      InstallStatus: "upgraded",
      TargetWindowStyle: 1,
      TargetRunAsUser: true,
      PreImageCount: 0,
      TemporaryCount: 0,
    });
  });

  it("rejects a fake 76-byte shell-link header without changing its flags", () => {
    const result = runPowerShell(join(fixtures, "shell-link-flags-driver.ps1"), [
      "-RegistrationPath",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-SandboxRoot",
      join(sandbox, "fake shell link"),
    ]);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      HashUnchanged: true,
      Flags: 0,
    });
    expect(result.stdout).toContain("CLSID is invalid");
  });

  it("does not overwrite a foreign launcher replacing the target after recheck", () => {
    const result = shortcutOwnership(
      "previous",
      "pre-takeover",
      false,
      "file",
      "install",
      "foreign-before-preimage",
    );
    expect(result).toMatchObject({
      Accepted: false,
      TargetForeign: true,
      PreImageCount: 0,
      RacerPreservedManaged: true,
      TemporaryCount: 0,
    });
    expect(result.Failure).toContain("changed during managed upgrade");
  });

  it("retains the upgrade preimage when the target changes during Complete", () => {
    const result = shortcutOwnership(
      "previous",
      "pre-takeover",
      false,
      "file",
      "install",
      "foreign-during-complete",
    );
    expect(result).toMatchObject({
      Accepted: false,
      TargetForeign: true,
      PreImageCount: 1,
      PreImageManaged: true,
      RacerPreservedManaged: true,
      TemporaryCount: 0,
    });
    expect(result.Failure).toContain("changed before transaction completion");
  });

  it("preserves the old managed preimage when another writer recreates the target", () => {
    const result = shortcutOwnership(
      "previous",
      "pre-takeover",
      false,
      "file",
      "install",
      "target-created-after-preimage",
    );
    expect(result).toMatchObject({
      Accepted: false,
      TargetForeign: true,
      PreImageCount: 1,
      PreImageManaged: true,
      RacerPreservedManaged: false,
      TemporaryCount: 0,
    });
    expect(result.Failure).toContain("pre-image was preserved");
  });

  it("preserves a foreign target during created-shortcut rollback", () => {
    const result = shortcutOwnership(
      "candidate",
      "exact",
      false,
      "missing",
      "rollback",
      "foreign-before-rollback",
    );
    expect(result).toMatchObject({
      Accepted: false,
      InstallStatus: "created",
      TargetForeign: true,
      PreImageCount: 0,
      RacerPreservedManaged: true,
      TemporaryCount: 0,
    });
    expect(result.Failure).toContain("foreign target was restored without overwrite");
  });

  it("preserves a foreign target and old preimage during upgraded-shortcut rollback", () => {
    const result = shortcutOwnership(
      "previous",
      "pre-takeover",
      false,
      "file",
      "rollback",
      "foreign-before-rollback",
    );
    expect(result).toMatchObject({
      Accepted: false,
      InstallStatus: "upgraded",
      TargetForeign: true,
      PreImageCount: 1,
      PreImageManaged: true,
      RacerPreservedManaged: true,
      TemporaryCount: 0,
    });
    expect(result.Failure).toContain("old pre-image was preserved");
  });

  it("uses the shared launcher Complete and Undo helpers in both registration branches", () => {
    const registration = readFileSync(
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "utf8",
    );
    const entry = registration.slice(registration.indexOf("$existing = Get-ScheduledTask"));
    expect(entry.match(/Complete-ManagedLauncherShortcutTransaction/gu)).toHaveLength(2);
    expect(entry.match(/Undo-ManagedLauncherShortcutTransaction/gu)).toHaveLength(2);
  });

  it.each(["directory", "dangling-reparse"] as const)(
    "rejects a same-name %s without mutating it",
    (pathKind) => {
      const result = shortcutOwnership("previous", "exact", false, pathKind);
      expect(result).toMatchObject({
        PathKind: pathKind,
        AuthoritySawReparse: pathKind === "dangling-reparse",
        Accepted: false,
        HashUnchanged: true,
        LengthUnchanged: true,
        LastWriteTimeUnchanged: true,
        ItemKindUnchanged: true,
      });
      expect(result.Failure).toContain("not the exact managed Codex Remote entry");
    },
  );

  it("keeps shortcut ownership reparse points fail-closed", () => {
    const registration = readFileSync(
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "utf8",
    );
    const assertStart = registration.indexOf("function Get-ManagedLauncherShortcutPathState");
    const assertEnd = registration.indexOf(
      "\nfunction Install-ManagedLauncherShortcut",
      assertStart,
    );
    const ownershipAssert = registration.slice(assertStart, assertEnd);
    expect(ownershipAssert).toContain("[System.IO.File]::GetAttributes");
    expect(ownershipAssert).toContain("[System.IO.FileAttributes]::ReparsePoint");
    expect(ownershipAssert).not.toContain("Get-Item");
  });

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
    expect(task.Description).toContain("codex-local-remote/startup-task/v5");
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
    expect(action.Arguments).toContain("-DesktopOwnerCoordinator");
    expect(action.Arguments).toContain("-TakeOverExistingNativeDesktop");
    expect(action.Arguments).not.toContain("-NoDesktopLaunch");
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
  }, 60_000);

  it("upgrades and unregisters only the exact Desktop-owning V3 legacy action", () => {
    const installRoot = join(sandbox, "desktop owner v3 install");
    const dataDir = join(sandbox, "desktop owner v3 state");
    const nodePath = join(sandbox, "desktop owner v3 node", "node.exe");
    for (const path of [
      nodePath,
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
    ];
    const initial = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "register",
      ...common,
    ]);
    expect(initial.status, `${initial.stdout}${initial.stderr}`).toBe(0);

    const canonical = readJson<SchedulerState>(stateFile);
    const canonicalAction = managedTask(canonical).Actions[0];
    if (!canonicalAction) throw new Error("Missing canonical V3 task action");
    expect(canonicalAction.Arguments).toContain(
      " -DesktopOwnerCoordinator -TakeOverExistingNativeDesktop",
    );

    const drifted = structuredClone(canonical);
    const driftedAction = makeLegacyDesktopOwningV3(drifted).Actions[0];
    if (!driftedAction) throw new Error("Missing drifted V3 task action");
    driftedAction.Arguments += " -ForeignOwnerDrift";
    drifted.Operations = [];
    writeJson(stateFile, drifted);
    const rejected = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "register",
      ...common,
    ]);
    expect(rejected.status, `${rejected.stdout}${rejected.stderr}`).not.toBe(0);
    expect(`${rejected.stdout}${rejected.stderr}`).toContain("refusing");
    expect(readJson<SchedulerState>(stateFile).Operations).toEqual([]);

    const legacy = structuredClone(canonical);
    const legacyTask = makeLegacyDesktopOwningV3(legacy);
    const legacyAction = legacyTask.Actions[0];
    if (!legacyAction) throw new Error("Missing legacy V3 task action");
    legacyTask.State = "Running";
    legacy.Operations = [];
    writeJson(stateFile, legacy);
    const upgrade = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "register",
      ...common,
    ]);
    expect(upgrade.status, `${upgrade.stdout}${upgrade.stderr}`).toBe(0);
    expect(upgrade.stdout).toContain("upgraded-legacy-desktop-owner-v3-to-versioned-v5");
    const upgraded = readJson<SchedulerState>(stateFile);
    expect(managedTask(upgraded).Actions[0]?.Arguments).toContain(
      " -DesktopOwnerCoordinator -TakeOverExistingNativeDesktop",
    );
    expect(managedTask(upgraded).Description).toContain("startup-task/v5");
    expect(managedTask(upgraded).State).toBe("Running");
    expect(upgraded.Operations).toEqual(["register"]);

    const removableLegacy = structuredClone(upgraded);
    const removableAction = makeLegacyDesktopOwningV3(removableLegacy).Actions[0];
    if (!removableAction) throw new Error("Missing removable legacy V3 task action");
    removableLegacy.Operations = [];
    writeJson(stateFile, removableLegacy);
    const removal = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Unregister-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "unregister",
      ...common,
    ]);
    expect(removal.status, `${removal.stdout}${removal.stderr}`).toBe(0);
    const removed = readJson<SchedulerState>(stateFile);
    expect(removed.Task).toBeNull();
    expect(removed.Operations).toEqual(["stop", "unregister"]);
  }, 15_000);

  it("upgrades the exact limited V3 task to the highest run level without treating it as foreign", () => {
    const installRoot = join(sandbox, "limited v3 install");
    const dataDir = join(sandbox, "limited v3 state");
    const nodePath = join(sandbox, "limited v3 node", "node.exe");
    for (const path of [
      nodePath,
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
    ];
    const initial = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "register",
      ...common,
    ]);
    expect(initial.status, `${initial.stdout}${initial.stderr}`).toBe(0);
    const prior = readJson<SchedulerState>(stateFile);
    const priorTask = makeLegacyDesktopOwningV3(prior);
    if (!priorTask.Principal) throw new Error("Missing task principal");
    priorTask.Principal.RunLevel = "Limited";
    writeJson(stateFile, prior);

    const upgrade = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "register",
      ...common,
    ]);

    expect(upgrade.status, `${upgrade.stdout}${upgrade.stderr}`).toBe(0);
    expect(upgrade.stdout).toContain("upgraded-limited-v3");
    const upgraded = readJson<SchedulerState>(stateFile);
    expect(managedTask(upgraded)).toMatchObject(exactSchedulerFingerprint());
    expect(upgraded.Operations).toEqual(["register", "register"]);
  }, 15_000);

  it("upgrades the exact pre-hidden-window V3 task without treating it as foreign", () => {
    const installRoot = join(sandbox, "pre hidden v3 install");
    const dataDir = join(sandbox, "pre hidden v3 state");
    const nodePath = join(sandbox, "pre hidden v3 node", "node.exe");
    for (const path of [
      nodePath,
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
    ];
    const initial = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "register",
      ...common,
    ]);
    expect(initial.status, `${initial.stdout}${initial.stderr}`).toBe(0);

    const previous = readJson<SchedulerState>(stateFile);
    const previousTask = makeLegacyDesktopOwningV3(previous);
    const previousAction = previousTask.Actions[0];
    if (!previousAction) throw new Error("Missing previous V3 task action");
    previousAction.Arguments = previousAction.Arguments.replace(
      "-NonInteractive -WindowStyle Hidden",
      "-NonInteractive",
    );
    previousTask.State = "Running";
    previous.Operations = [];
    writeJson(stateFile, previous);

    const upgrade = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "register",
      ...common,
    ]);

    expect(upgrade.status, `${upgrade.stdout}${upgrade.stderr}`).toBe(0);
    expect(upgrade.stdout).toContain("upgraded-mutable-v3");
    expect(upgrade.stdout).toContain("pending-live-bootstrap-restart");
    const upgraded = readJson<SchedulerState>(stateFile);
    expect(managedTask(upgraded).Actions[0]?.Arguments).toContain("-WindowStyle Hidden");
    expect(managedTask(upgraded).State).toBe("Running");
    expect(upgraded.Operations).toEqual(["register"]);
  });

  it("upgrades the exact pre-takeover V3 task without stopping its running generation", () => {
    const installRoot = join(sandbox, "pre takeover v3 install");
    const dataDir = join(sandbox, "pre takeover v3 state");
    const nodePath = join(sandbox, "pre takeover v3 node", "node.exe");
    for (const path of [
      nodePath,
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
    ];
    const initial = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "register",
      ...common,
    ]);
    expect(initial.status, `${initial.stdout}${initial.stderr}`).toBe(0);

    const previous = readJson<SchedulerState>(stateFile);
    const previousTask = makeLegacyDesktopOwningV3(previous);
    const previousAction = previousTask.Actions[0];
    if (!previousAction) throw new Error("Missing previous V3 task action");
    previousAction.Arguments = previousAction.Arguments.replace(
      " -TakeOverExistingNativeDesktop",
      "",
    );
    previousTask.State = "Running";
    previous.Operations = [];
    writeJson(stateFile, previous);

    const upgrade = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "register",
      ...common,
    ]);

    expect(upgrade.status, `${upgrade.stdout}${upgrade.stderr}`).toBe(0);
    expect(upgrade.stdout).toContain("upgraded-pre-takeover-v3");
    const upgraded = readJson<SchedulerState>(stateFile);
    expect(managedTask(upgraded).Actions[0]?.Arguments).toContain("-DesktopOwnerCoordinator");
    expect(managedTask(upgraded).Actions[0]?.Arguments).toContain("-TakeOverExistingNativeDesktop");
    expect(managedTask(upgraded).State).toBe("Running");
    expect(upgraded.Operations).toEqual(["register"]);
  }, 30_000);

  it("upgrades an exact pre-headless V3 task without stopping its running generation", () => {
    const installRoot = join(sandbox, "pre headless v3 install");
    const dataDir = join(sandbox, "pre headless v3 state");
    const nodePath = join(sandbox, "pre headless v3 node", "node.exe");
    const pwshPath = join(sandbox, "pre headless v3 pwsh", "pwsh.exe");
    for (const path of [
      nodePath,
      pwshPath,
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
      "-PwshPath",
      pwshPath,
    ];
    const initial = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "register",
      ...common,
    ]);
    expect(initial.status, `${initial.stdout}${initial.stderr}`).toBe(0);

    const previous = readJson<SchedulerState>(stateFile);
    const previousTask = makeLegacyDesktopOwningV3(previous);
    const previousAction = previousTask.Actions[0];
    if (!previousAction) throw new Error("Missing previous V3 task action");
    previousAction.Execute = pwshPath;
    previousAction.Arguments = previousAction.Arguments.replace(
      new RegExp(`^--headless "${pwshPath.replaceAll("\\", "\\\\")}" `),
      "",
    );
    previousTask.State = "Running";
    previous.Operations = [];
    writeJson(stateFile, previous);

    const upgrade = runPowerShell(join(fixtures, "scheduler-mock-driver.ps1"), [
      "-TargetScript",
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "-Operation",
      "register",
      ...common,
    ]);

    expect(upgrade.status, `${upgrade.stdout}${upgrade.stderr}`).toBe(0);
    expect(upgrade.stdout).toContain("upgraded-mutable-v3");
    const upgraded = readJson<SchedulerState>(stateFile);
    expect(managedTask(upgraded).Actions[0]?.Execute.toLowerCase()).toContain("conhost.exe");
    expect(managedTask(upgraded).Actions[0]?.Arguments).toContain("--headless");
    expect(managedTask(upgraded).State).toBe("Running");
    expect(upgraded.Operations).toEqual(["register"]);
  });

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
    const pinnedTask = makeLegacyAutoStart(managedTask(pinned));
    pinnedTask.Description =
      "codex-local-remote/startup-task/v2 - Starts the loopback app-server broker before the local-only Codex Local Remote sidecar at user sign-in.";
    const pinnedAction = pinnedTask.Actions[0];
    if (!pinnedAction) throw new Error("Missing pinned task action");
    unwrapHeadlessAction(pinnedAction);
    pinnedAction.Arguments = pinnedAction.Arguments.replace(
      "-NodePath",
      `-CodexPath "${codexPath}" -NodePath`,
    )
      .replace("-NonInteractive -WindowStyle Hidden", "-NonInteractive")
      .replace(" -DesktopOwnerCoordinator -TakeOverExistingNativeDesktop", "");
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
    expect(upgrade.stdout).toContain("pending-live-bootstrap-restart");
    const upgraded = readJson<SchedulerState>(stateFile);
    expect(managedTask(upgraded).Description).toContain("startup-task/v5");
    expect(managedTask(upgraded).Actions[0]?.Arguments).not.toContain("-CodexPath");
    expect(managedTask(upgraded).State).toBe("Running");
    expect(upgraded.Operations).toEqual(["register"]);
  });

  it("rejects an explicit second start while upgrading a running pinned-runtime V2 task", () => {
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
    const pinnedTask = makeLegacyAutoStart(managedTask(pinned));
    pinnedTask.Description =
      "codex-local-remote/startup-task/v2 - Starts the loopback app-server broker before the local-only Codex Local Remote sidecar at user sign-in.";
    const pinnedAction = pinnedTask.Actions[0];
    if (!pinnedAction) throw new Error("Missing pinned task action");
    unwrapHeadlessAction(pinnedAction);
    pinnedAction.Arguments = pinnedAction.Arguments.replace(
      "-NodePath",
      `-CodexPath "${codexPath}" -NodePath`,
    )
      .replace("-NonInteractive -WindowStyle Hidden", "-NonInteractive")
      .replace(" -DesktopOwnerCoordinator -TakeOverExistingNativeDesktop", "");
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
    expect(`${unsafeUpgrade.stdout}${unsafeUpgrade.stderr}`).toContain(
      "cannot request another task instance",
    );
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
        ...makeLegacyAutoStart(exactSchedulerFingerprint()),
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
    expect(managedTask(afterRemoval).Description).toContain("startup-task/v5");
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
