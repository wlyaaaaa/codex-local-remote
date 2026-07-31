import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const modulePath = join(repositoryRoot, "scripts", "windows", "CodexLocalRemote.Windows.psm1");
const driver = join(import.meta.dirname, "fixtures", "runtime-discovery-driver.ps1");
const launcherPath = join(repositoryRoot, "scripts", "windows", "Launch-CodexWithRemote.ps1");
const registrationPath = join(
  repositoryRoot,
  "scripts",
  "windows",
  "Register-CodexLocalRemoteStartup.ps1",
);
const handoffDriver = join(
  import.meta.dirname,
  "fixtures",
  "runtime-handoff-transaction-driver.ps1",
);
const registrationBindingDriver = join(
  import.meta.dirname,
  "fixtures",
  "runtime-registration-binding-transaction-driver.ps1",
);
const versionedOwnershipDriver = join(
  import.meta.dirname,
  "fixtures",
  "runtime-versioned-ownership-driver.ps1",
);

interface RuntimeResult {
  Signature: string;
  PackageFullName: string;
  PackageVersion: string;
  CodexPath: string;
  CodexSha256: string;
  BundledCodexSha256: string;
  Source: string;
}

interface HandoffResult {
  Mode: string;
  Succeeded: boolean;
  Error: string | null;
  TaskState: string;
  PointerRuntime: string;
  TaskRuntime: string;
  ActiveRuntime: string;
  PairState: "old" | "new" | "mixed";
  PriorRuntimeVerified: boolean;
  SelectedPairVerified: boolean;
  PriorTaskBindingVerified: boolean;
  SelectedTaskBindingVerified: boolean;
  ExactOldTaskXml: boolean;
  ExactSelectedTaskXml: boolean;
  TaskXmlSha256: string;
  OldTaskXmlSha256: string;
  SelectedTaskXmlSha256: string;
  StartAttempts: number;
  StopAttempts: number;
  RegisterAttempts: number;
  PointerAttempts: number;
  PointerWrites: number;
  DesktopReads: number;
  GenerationReads: number;
  ReadinessReads: number;
  FirstDelayedTaskObservation: string | null;
  FirstDelayedGenerationObservation: string | null;
  CleanupSilentReadsBeforeOldRestore: number;
  ActiveRuntimeBeforeOldRestore: string | null;
  Events: string[];
}

interface RegistrationBindingResult {
  Baseline: "fresh" | "current" | "current-absent-pointer" | "upgrade";
  Fault: "before-once" | "after-effect" | "persistent-before" | "prepare-after-effect";
  TransactionSucceeded: boolean;
  TransactionError: string | null;
  TransactionFailure: string | null;
  FinalKind: "absent" | "old" | "selected" | "mixed";
  SelectedVerified: boolean;
  BaselineVerified: boolean;
  ExactOldTask: boolean;
  TaskAbsent: boolean;
  PointerAbsent: boolean;
  SetAttempts: number;
  RegisterAttempts: number;
  SyncAttempts: number;
  UnregisterAttempts: number;
  StopAttempts: number;
  Operations: string[];
}

interface VersionedOwnershipResult {
  Mode:
    | "pre-takeover"
    | "pre-takeover-prehidden"
    | "pre-takeover-preheadless"
    | "pre-takeover-preheadless-prehidden"
    | "foreign-drift";
  IsManaged: boolean;
  Kind: "versioned-v3" | "foreign";
  OldRuntimeRoot: string;
  CandidateRuntimeRoot: string;
  RootsDiffer: boolean;
  OldRuntimeValid: boolean;
  HasTakeoverSwitch: boolean;
}

windowsOnly("dynamic Codex Desktop runtime discovery", () => {
  let sandbox: string;
  let packageRoot: string;
  let localAppData: string;
  let bundledCodex: string;

  beforeEach(() => {
    sandbox = join(tmpdir(), `codex-runtime-discovery-${process.pid}-${crypto.randomUUID()}`);
    packageRoot = join(sandbox, "WindowsApps", "OpenAI.Codex_dynamic");
    localAppData = join(sandbox, "LocalAppData");
    bundledCodex = join(packageRoot, "app", "resources", "codex.exe");
    const desktopExecutable = join(packageRoot, "app", "ChatGPT.exe");
    mkdirSync(dirname(bundledCodex), { recursive: true });
    writeFileSync(bundledCodex, "current desktop managed runtime", "utf8");
    writeFileSync(desktopExecutable, "current desktop executable", "utf8");
  });

  function discover(mode: string) {
    return spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        driver,
        "-ModulePath",
        modulePath,
        "-PackageRoot",
        packageRoot,
        "-LocalAppDataPath",
        localAppData,
        "-Mode",
        mode,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
  }

  function discoverStatus(mode: string) {
    return spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        driver,
        "-ModulePath",
        modulePath,
        "-PackageRoot",
        packageRoot,
        "-LocalAppDataPath",
        localAppData,
        "-Mode",
        mode,
        "-StatusOnly",
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
  }

  it("prefers a dynamically named Desktop cache entry only when its hash matches", () => {
    const cacheCodex = join(
      localAppData,
      "OpenAI",
      "Codex",
      "bin",
      "future-random-generation",
      "codex.exe",
    );
    mkdirSync(dirname(cacheCodex), { recursive: true });
    writeFileSync(cacheCodex, readFileSync(bundledCodex));

    const result = discover("valid");

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const runtime = JSON.parse(result.stdout) as RuntimeResult;
    expect(runtime).toMatchObject({
      Signature: "codex-local-remote/codex-desktop-runtime/v1",
      PackageFullName: "OpenAI.Codex_dynamic-fixture_x64__2p2nqsd0c76g0",
      PackageVersion: "999.1.2.3",
      CodexPath: resolve(cacheCodex),
      Source: "desktop-cache-hash-match",
    });
    expect(runtime.CodexSha256).toMatch(/^[0-9A-F]{64}$/u);
    expect(runtime.CodexSha256).toBe(runtime.BundledCodexSha256);

    const cachedResult = discover("valid");
    expect(cachedResult.status, `${cachedResult.stdout}${cachedResult.stderr}`).toBe(0);
    expect(JSON.parse(cachedResult.stdout) as RuntimeResult).toMatchObject({
      CodexPath: resolve(cacheCodex),
      Source: "persistent-runtime-cache-hash-verified",
      CodexSha256: runtime.CodexSha256,
    });
  });

  it("invalidates the persistent receipt when the selected runtime no longer hash-matches", () => {
    const cacheCodex = join(
      localAppData,
      "OpenAI",
      "Codex",
      "bin",
      "future-random-generation",
      "codex.exe",
    );
    mkdirSync(dirname(cacheCodex), { recursive: true });
    writeFileSync(cacheCodex, readFileSync(bundledCodex));
    expect(discover("valid").status).toBe(0);

    writeFileSync(cacheCodex, "tampered cached runtime", "utf8");
    const result = discover("valid");

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout) as RuntimeResult).toMatchObject({
      CodexPath: resolve(bundledCodex),
      Source: "package-bundled",
    });
  });

  it("rebuilds the persistent receipt after the installed package runtime changes", () => {
    const first = discover("valid");
    expect(first.status, `${first.stdout}${first.stderr}`).toBe(0);
    const firstRuntime = JSON.parse(first.stdout) as RuntimeResult;

    writeFileSync(bundledCodex, "updated desktop managed runtime", "utf8");
    const updated = discover("valid");

    expect(updated.status, `${updated.stdout}${updated.stderr}`).toBe(0);
    const updatedRuntime = JSON.parse(updated.stdout) as RuntimeResult;
    expect(updatedRuntime).toMatchObject({
      CodexPath: resolve(bundledCodex),
      Source: "package-bundled",
    });
    expect(updatedRuntime.CodexSha256).not.toBe(firstRuntime.CodexSha256);

    const cached = discover("valid");
    expect(cached.status, `${cached.stdout}${cached.stderr}`).toBe(0);
    expect(JSON.parse(cached.stdout) as RuntimeResult).toMatchObject({
      CodexPath: resolve(bundledCodex),
      Source: "persistent-runtime-cache-hash-verified",
      CodexSha256: updatedRuntime.CodexSha256,
    });
  });

  it("uses the current package runtime when no hydrated cache exists", () => {
    const result = discover("valid");

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout) as RuntimeResult).toMatchObject({
      CodexPath: resolve(bundledCodex),
      Source: "package-bundled",
    });
  });

  it("ignores stale cache generations whose content does not match the package", () => {
    const staleCodex = join(localAppData, "OpenAI", "Codex", "bin", "old-fixed-hash", "codex.exe");
    mkdirSync(dirname(staleCodex), { recursive: true });
    writeFileSync(staleCodex, "old runtime", "utf8");

    const result = discover("valid");

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout) as RuntimeResult).toMatchObject({
      CodexPath: resolve(bundledCodex),
      Source: "package-bundled",
    });
  });

  it.each([
    ["missing-package", "found 0"],
    ["multiple-packages", "found 2"],
    ["unhealthy-package", "found 0"],
    ["foreign-running-desktop", "different package generation"],
  ])("fails closed for %s with a clear diagnostic", (mode, message) => {
    const result = discover(mode);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(message);
    expect(`${result.stdout}${result.stderr}`).toContain(
      mode === "foreign-running-desktop" ? "left untouched" : "Remote startup is disabled",
    );
  });

  it("keeps the persistent task definition free of package versions and cache hashes", () => {
    const module = readFileSync(modulePath, "utf8");
    const start = module.indexOf("function Get-StartupTaskDefinition");
    const end = module.indexOf("\nfunction Get-PinnedStartupTaskDefinitionV2", start);
    const definition = module.slice(start, end);
    expect(definition).not.toContain("WindowsApps");
    expect(definition).not.toContain("OpenAI.Codex");
    expect(definition).not.toContain("'-CodexPath'");
    expect(definition).not.toContain("$resolvedCodex");
  });

  it("provides a bounded package-generation identity for routine status checks", () => {
    const result = discoverStatus("valid");

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      Signature: "codex-local-remote/codex-desktop-package-status/v1",
      PackageFullName: "OpenAI.Codex_dynamic-fixture_x64__2p2nqsd0c76g0",
      PackageVersion: "999.1.2.3",
      Source: "package-metadata",
      CodexSha256: null,
    });
  });
});

windowsOnly("immutable runtime handoff transaction", () => {
  function handoff(mode: string): HandoffResult {
    const sandbox = join(tmpdir(), `codex-runtime-handoff-${process.pid}-${crypto.randomUUID()}`);
    mkdirSync(sandbox, { recursive: true });
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        handoffDriver,
        "-LauncherPath",
        launcherPath,
        "-SandboxRoot",
        sandbox,
        "-Mode",
        mode,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return JSON.parse(result.stdout) as HandoffResult;
  }

  function registrationBinding(
    baseline: RegistrationBindingResult["Baseline"],
    fault: RegistrationBindingResult["Fault"],
  ): RegistrationBindingResult {
    const sandbox = join(
      tmpdir(),
      `codex-registration-binding-${process.pid}-${crypto.randomUUID()}`,
    );
    mkdirSync(sandbox, { recursive: true });
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        registrationBindingDriver,
        "-RegistrationPath",
        registrationPath,
        "-SandboxRoot",
        sandbox,
        "-Baseline",
        baseline,
        "-Fault",
        fault,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return JSON.parse(result.stdout) as RegistrationBindingResult;
  }

  function versionedOwnership(mode: VersionedOwnershipResult["Mode"]): VersionedOwnershipResult {
    const sandbox = join(
      tmpdir(),
      `codex-versioned-ownership-${process.pid}-${crypto.randomUUID()}`,
    );
    mkdirSync(sandbox, { recursive: true });
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        versionedOwnershipDriver,
        "-ModulePath",
        modulePath,
        "-RegistrationPath",
        registrationPath,
        "-SandboxRoot",
        sandbox,
        "-Mode",
        mode,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return JSON.parse(result.stdout) as VersionedOwnershipResult;
  }

  it.each([
    "pre-takeover",
    "pre-takeover-prehidden",
    "pre-takeover-preheadless",
    "pre-takeover-preheadless-prehidden",
  ] as const)("recognizes an exact %s task at a valid prior immutable root", (mode) => {
    expect(versionedOwnership(mode)).toMatchObject({
      Mode: mode,
      IsManaged: true,
      Kind: "versioned-v3",
      RootsDiffer: true,
      OldRuntimeValid: true,
      HasTakeoverSwitch: false,
    });
  });

  it("still rejects adjacent argument drift at a valid prior immutable root", () => {
    expect(versionedOwnership("foreign-drift")).toMatchObject({
      Mode: "foreign-drift",
      IsManaged: false,
      Kind: "foreign",
      RootsDiffer: true,
      OldRuntimeValid: true,
      HasTakeoverSwitch: false,
    });
  });

  it("captures the old task XML in the selected pointer before replacing the task definition", () => {
    const registration = readFileSync(registrationPath, "utf8");
    const transactionStart = registration.indexOf("$runtimeTransitionRequired");
    const transactionEnd = registration.indexOf(
      '"upgraded-$($ownership.Kind)-to-versioned-v5"',
      transactionStart,
    );
    const transaction = registration.slice(transactionStart, transactionEnd);

    expect(transactionStart).toBeGreaterThan(0);
    expect(transactionEnd).toBeGreaterThan(transactionStart);
    expect(transaction).toContain("Export-ScheduledTask");
    expect(transaction).toContain("XmlSha256 = $oldTaskXmlSha256");
    expect(transaction).toContain("-PreviousTaskPreImage $taskPreImage");
    expect(transaction).toContain("-CurrentTaskDefinition $taskPreImage");
    expect(transaction.indexOf("Set-CodexLocalRemoteCurrentRuntime")).toBeLessThan(
      transaction.indexOf("Register-ScheduledTask"),
    );
    expect(registration).not.toContain("Convert-CodexLocalRemoteTaskXmlRuntimeRoot");
  });

  it("fills a missing selected-task binding on ordinary same-runtime and fresh registration", () => {
    const registration = readFileSync(registrationPath, "utf8");
    const sameRuntimeStart = registration.indexOf(
      "if ($useImmutableRuntime -and\n                -not $runtimePointerCommitted)",
    );
    const sameRuntimeEnd = registration.indexOf(
      "Set-CodexLocalRemoteManagedConfiguration",
      sameRuntimeStart,
    );
    const sameRuntimeBinding = registration.slice(sameRuntimeStart, sameRuntimeEnd);
    const freshStart = registration.lastIndexOf("$resultStatus = 'registered'");
    const freshEnd = registration.indexOf("Set-CodexLocalRemoteManagedConfiguration", freshStart);
    const freshBinding = registration.slice(freshStart, freshEnd);

    expect(sameRuntimeStart).toBeGreaterThan(0);
    expect(sameRuntimeEnd).toBeGreaterThan(sameRuntimeStart);
    expect(sameRuntimeBinding).toContain("Complete-RegistrationRuntimeBindingTransaction");
    expect(sameRuntimeBinding).toContain("-Baseline $runtimeBindingBaseline");
    expect(freshStart).toBeGreaterThan(0);
    expect(freshEnd).toBeGreaterThan(freshStart);
    expect(freshBinding).toContain("Complete-RegistrationRuntimeBindingTransaction");
    expect(freshBinding).toContain("-Baseline $runtimeBindingBaseline");
  });

  it("routes current sync and both task-registration entry effects through the binding transaction runner", () => {
    const registration = readFileSync(registrationPath, "utf8");
    const managedStart = registration.indexOf("if ($ownership.Kind -cin @(");
    const managedEnd = registration.indexOf("} elseif ($PSCmdlet.ShouldProcess(", managedStart);
    const managed = registration.slice(managedStart, managedEnd);
    const fresh = registration.slice(managedEnd);

    expect(managed).toMatch(
      /\$prepareSelectedRuntimeState = \{\s+Sync-CodexLocalRemoteCurrentRuntime/,
    );
    expect(managed).toMatch(
      /\$prepareSelectedRuntimeState = \{\s+Register-ScheduledTask[\s\S]+?-Force \| Out-Null\s+\}/,
    );
    expect(managed).toContain("-PrepareSelectedState $prepareSelectedRuntimeState");
    expect(fresh).toMatch(/\$prepareSelectedRuntimeState = \{\s+Register-ScheduledTask/);
    expect(fresh).toContain("-PrepareSelectedState $prepareSelectedRuntimeState");
  });

  it.each(["fresh", "current", "upgrade"] as const)(
    "converges %s registration to selected after a one-time binding failure before effect",
    (baseline) => {
      const result = registrationBinding(baseline, "before-once");

      expect(result).toMatchObject({
        TransactionSucceeded: true,
        TransactionError: null,
        FinalKind: "selected",
        SelectedVerified: true,
        SetAttempts: 2,
        UnregisterAttempts: 0,
        StopAttempts: 0,
      });
    },
  );

  it.each(["fresh", "current", "upgrade"] as const)(
    "accepts only the exact selected pair after a %s binding write throws after effect",
    (baseline) => {
      const result = registrationBinding(baseline, "after-effect");

      expect(result).toMatchObject({
        TransactionSucceeded: true,
        TransactionError: null,
        FinalKind: "selected",
        SelectedVerified: true,
        SetAttempts: 1,
        UnregisterAttempts: 0,
        StopAttempts: 0,
      });
    },
  );

  it.each([
    ["fresh", "register-after-effect"],
    ["upgrade", "register-after-effect"],
    ["current-absent-pointer", "sync-after-effect"],
  ] as const)(
    "audits and converges %s when its entry preparation throws after effect",
    (baseline, expectedEffect) => {
      const result = registrationBinding(baseline, "prepare-after-effect");

      expect(result).toMatchObject({
        TransactionSucceeded: true,
        TransactionError: null,
        FinalKind: "selected",
        SelectedVerified: true,
        SetAttempts: 1,
        UnregisterAttempts: 0,
        StopAttempts: 0,
      });
      expect(result.Operations).toContain(expectedEffect);
      expect(result.Operations).toContain("pointer-write");
      expect(result.TransactionFailure).toContain("selected preparation attempt 1 failed");
      if (baseline === "current-absent-pointer") {
        expect(result).toMatchObject({
          RegisterAttempts: 0,
          SyncAttempts: 1,
        });
      } else {
        expect(result).toMatchObject({
          RegisterAttempts: 1,
          SyncAttempts: 0,
        });
      }
      expect(result.FinalKind).not.toBe("mixed");
    },
  );

  it("removes only the exact fresh task when persistent binding writes fail before effect", () => {
    const result = registrationBinding("fresh", "persistent-before");

    expect(result).toMatchObject({
      TransactionSucceeded: false,
      FinalKind: "absent",
      BaselineVerified: true,
      TaskAbsent: true,
      PointerAbsent: true,
      SetAttempts: 2,
      RegisterAttempts: 1,
      UnregisterAttempts: 1,
      StopAttempts: 0,
    });
    expect(result.TransactionError).toContain("exact absent registration baseline");
  });

  it("preserves an existing current task without stopping or unregistering it on persistent binding failure", () => {
    const result = registrationBinding("current", "persistent-before");

    expect(result).toMatchObject({
      TransactionSucceeded: false,
      FinalKind: "old",
      BaselineVerified: true,
      SetAttempts: 2,
      RegisterAttempts: 0,
      UnregisterAttempts: 0,
      StopAttempts: 0,
    });
    expect(result.TransactionError).toContain("exact old registration baseline");
    expect(result.Operations).not.toContain("unregister");
    expect(result.Operations).not.toContain("stop");
  });

  it("removes only the pointer created by current-runtime sync when its binding cannot converge", () => {
    const result = registrationBinding("current-absent-pointer", "persistent-before");

    expect(result).toMatchObject({
      TransactionSucceeded: false,
      FinalKind: "old",
      BaselineVerified: true,
      PointerAbsent: true,
      RegisterAttempts: 0,
      UnregisterAttempts: 0,
      StopAttempts: 0,
    });
    expect(result.Operations).toContain("sync-pointer-create");
    expect(result.Operations).not.toContain("unregister");
    expect(result.Operations).not.toContain("stop");
  });

  it("restores the exact noncurrent same-runtime task and binding when binding cannot converge", () => {
    const result = registrationBinding("upgrade", "persistent-before");

    expect(result).toMatchObject({
      TransactionSucceeded: false,
      FinalKind: "old",
      BaselineVerified: true,
      ExactOldTask: true,
      SetAttempts: 2,
      RegisterAttempts: 2,
      UnregisterAttempts: 0,
      StopAttempts: 0,
    });
    expect(result.TransactionError).toContain("exact old registration baseline");
  });

  it("switches only after the post-stop generation and silence barrier remains stable", () => {
    const result = handoff("happy");

    expect(result).toMatchObject({
      Succeeded: true,
      Error: null,
      TaskState: "Running",
      StartAttempts: 1,
      StopAttempts: 1,
      PointerRuntime: "new",
      TaskRuntime: "new",
      ActiveRuntime: "new",
      PairState: "new",
      PriorRuntimeVerified: false,
      SelectedPairVerified: true,
      ExactSelectedTaskXml: true,
      RegisterAttempts: 0,
      PointerAttempts: 0,
      PointerWrites: 0,
    });
    expect(result.DesktopReads).toBeGreaterThanOrEqual(2);
    expect(result.GenerationReads).toBeGreaterThanOrEqual(2);
    expect(result.ReadinessReads).toBeGreaterThanOrEqual(2);
    expect(result.Events).toEqual([
      "task-stop:1",
      "sidecar-stop",
      "broker-stop",
      "task-start:1",
      "task-running:new",
    ]);
  });

  it.each(["desktop-after-stop", "generation-drift-after-stop", "readiness-drift-after-stop"])(
    "restores the prior task without stopping runtime owners when %s",
    (mode) => {
      const result = handoff(mode);

      expect(result.Succeeded).toBe(false);
      expect(result.Error).toContain("handoff");
      expect(result.TaskState).toBe("Running");
      expect(result).toMatchObject({
        PointerRuntime: "old",
        TaskRuntime: "old",
        ActiveRuntime: "old",
        PairState: "old",
        PriorRuntimeVerified: true,
        ExactOldTaskXml: true,
        RegisterAttempts: 1,
        PointerAttempts: 1,
        PointerWrites: 1,
      });
      expect(result.StartAttempts).toBe(1);
      expect(result.StopAttempts).toBe(1);
      expect(result.Events).toEqual([
        "task-stop:1",
        "task-register:old",
        "pointer-set:old",
        "task-start:1",
        "task-running:old",
      ]);
    },
  );

  it.each(["sidecar-stop-fails", "broker-stop-fails"])(
    "restores the prior task after the injected %s failure",
    (mode) => {
      const result = handoff(mode);

      expect(result.Succeeded).toBe(false);
      expect(result.Error).toContain("restored");
      expect(result.TaskState).toBe("Running");
      expect(result).toMatchObject({
        PointerRuntime: "old",
        TaskRuntime: "old",
        ActiveRuntime: "old",
        PairState: "old",
        PriorRuntimeVerified: true,
        ExactOldTaskXml: true,
        RegisterAttempts: 1,
        PointerAttempts: 1,
        PointerWrites: 1,
      });
      expect(result.StartAttempts).toBe(1);
      expect(result.StopAttempts).toBe(1);
      expect(result.Events.at(-1)).toBe("task-running:old");
      expect(result.Events.filter((event) => event === "sidecar-stop")).toHaveLength(1);
      expect(result.Events.filter((event) => event === "broker-stop")).toHaveLength(
        mode === "broker-stop-fails" ? 1 : 0,
      );
    },
  );

  it("makes one bounded compensating start when the intended task start fails", () => {
    const result = handoff("start-fails-once");

    expect(result.Succeeded).toBe(false);
    expect(result.Error).toContain("restored");
    expect(result.TaskState).toBe("Running");
    expect(result).toMatchObject({
      PointerRuntime: "old",
      TaskRuntime: "old",
      ActiveRuntime: "old",
      PairState: "old",
      PriorRuntimeVerified: true,
      ExactOldTaskXml: true,
      RegisterAttempts: 1,
      PointerAttempts: 1,
      PointerWrites: 1,
    });
    expect(result.StartAttempts).toBe(2);
    expect(result.StopAttempts).toBeGreaterThanOrEqual(2);
    expect(result.Events).toContain("task-start:1");
    expect(result.Events).toContain("new-sidecar-stop");
    expect(result.Events).toContain("new-broker-stop");
    expect(result.Events.slice(-4)).toEqual([
      "task-register:old",
      "pointer-set:old",
      "task-start:2",
      "task-running:old",
    ]);
  });

  it("removes the unready selected generation and verifies old task readiness", () => {
    const result = handoff("start-readiness-fails");

    expect(result).toMatchObject({
      Succeeded: false,
      TaskState: "Running",
      PointerRuntime: "old",
      TaskRuntime: "old",
      ActiveRuntime: "old",
      PairState: "old",
      PriorRuntimeVerified: true,
      ExactOldTaskXml: true,
      StartAttempts: 2,
      RegisterAttempts: 1,
      PointerAttempts: 1,
      PointerWrites: 1,
    });
    expect(result.StopAttempts).toBeGreaterThanOrEqual(2);
    expect(result.Error).toContain("restored");
    expect(result.Events).toContain("new-sidecar-stop");
    expect(result.Events).toContain("new-broker-stop");
    expect(result.Events.slice(-4)).toEqual([
      "task-register:old",
      "pointer-set:old",
      "task-start:2",
      "task-running:old",
    ]);
  });

  it("does not claim restoration when the old task cannot be restarted", () => {
    const result = handoff("recovery-start-fails");

    expect(result).toMatchObject({
      Succeeded: false,
      TaskState: "Ready",
      PointerRuntime: "old",
      TaskRuntime: "old",
      PairState: "old",
      PriorRuntimeVerified: false,
      ExactOldTaskXml: true,
      StartAttempts: 2,
      RegisterAttempts: 1,
      PointerAttempts: 1,
      PointerWrites: 1,
    });
    expect(result.Error).toContain("prior runtime recovery was not verified");
    expect(result.Error).not.toContain("were restored and verified");
  });

  it("restores the exact persisted old task XML instead of synthesizing it from the selected task", () => {
    const result = handoff("sidecar-stop-fails");

    expect(result).toMatchObject({
      Succeeded: false,
      PairState: "old",
      ExactOldTaskXml: true,
      ExactSelectedTaskXml: false,
      PriorRuntimeVerified: true,
    });
    expect(result.TaskXmlSha256).toBe(result.OldTaskXmlSha256);
    expect(result.TaskXmlSha256).not.toBe(result.SelectedTaskXmlSha256);
  });

  it.each([
    ["recovery-register-fails", "new"],
    ["recovery-pointer-fails", "new"],
    ["recovery-register-after-effect-throws", "old"],
    ["recovery-pointer-after-effect-throws", "old"],
  ] as const)(
    "leaves only a verified old or selected pointer/task pair when %s",
    (mode, expectedPair) => {
      const result = handoff(mode);

      expect(result.Succeeded).toBe(false);
      expect(result.PairState).toBe(expectedPair);
      expect(result.PairState).not.toBe("mixed");
      if (expectedPair === "old") {
        expect(result.PriorRuntimeVerified).toBe(true);
        expect(result.ExactOldTaskXml).toBe(true);
        expect(result.Error).toContain("restored and verified");
      } else {
        expect(result.SelectedPairVerified).toBe(true);
        expect(result.ExactSelectedTaskXml).toBe(true);
        expect(result.Error).toContain(
          "selected runtime pointer and task definition remain verified",
        );
        expect(result.Error).not.toContain("were restored and verified");
      }
    },
  );

  it("does not call a selected pair verified when its task binding cannot be repaired", () => {
    const result = handoff("recovery-selected-binding-repair-fails");

    expect(result).toMatchObject({
      Succeeded: false,
      PairState: "new",
      PriorRuntimeVerified: false,
      SelectedPairVerified: false,
      PriorTaskBindingVerified: false,
      SelectedTaskBindingVerified: false,
      RegisterAttempts: 1,
      PointerAttempts: 1,
      PointerWrites: 0,
    });
    expect(result.Error).toContain("neither the exact prior nor selected");
    expect(result.Error).not.toContain(
      "selected runtime pointer and task definition remain verified",
    );
    expect(result.Events).toContain("selected-binding-drifted");
    expect(result.Events).toContain("pointer-binding-repair-failed:new");
  });

  it("re-audits and removes the selected generation when start throws after taking effect", () => {
    const result = handoff("start-after-effect-throws");

    expect(result).toMatchObject({
      Succeeded: false,
      PairState: "old",
      PointerRuntime: "old",
      TaskRuntime: "old",
      ActiveRuntime: "old",
      ExactOldTaskXml: true,
      PriorRuntimeVerified: true,
      StartAttempts: 2,
    });
    expect(result.StopAttempts).toBeGreaterThanOrEqual(2);
    expect(result.Error).toContain("restored and verified");
    expect(result.Events).toContain("task-running:new");
    expect(result.Events).toContain("new-sidecar-stop");
    expect(result.Events).toContain("new-broker-stop");
    expect(result.Events.at(-1)).toBe("task-running:old");
  });

  it("repeats selected owner cleanup and proves stable silence before restoring the old task", () => {
    const result = handoff("selected-owner-reappears-after-cleanup");

    expect(result).toMatchObject({
      Succeeded: false,
      PairState: "old",
      PriorRuntimeVerified: true,
      ActiveRuntimeBeforeOldRestore: "old",
    });
    expect(result.CleanupSilentReadsBeforeOldRestore).toBeGreaterThanOrEqual(2);
    expect(result.Events).toContain("selected-owner-reappeared");
    expect(result.Events).toContain("selected-owner-silent-after-second-cleanup");
    expect(
      result.Events.filter((event) => event === "new-sidecar-stop").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      result.Events.filter((event) => event === "new-broker-stop").length,
    ).toBeGreaterThanOrEqual(2);
    expect(result.Events.indexOf("selected-owner-silent-after-second-cleanup")).toBeLessThan(
      result.Events.indexOf("task-register:old"),
    );
  });

  it("re-audits the exact selected pair after readiness before declaring success", () => {
    const result = handoff("selected-pair-drift-after-readiness");

    expect(result).toMatchObject({
      Succeeded: false,
      PairState: "old",
      PriorRuntimeVerified: true,
      SelectedPairVerified: false,
    });
    expect(result.Error).toContain("restored and verified");
    expect(result.Events).toContain("selected-pair-drifted-during-final-readiness-audit");
  });

  it("does not declare old recovery verified when its binding drifts after readiness", () => {
    const result = handoff("old-pair-drift-after-readiness");

    expect(result).toMatchObject({
      Succeeded: false,
      PairState: "old",
      PriorRuntimeVerified: false,
      PriorTaskBindingVerified: false,
    });
    expect(result.Error).toContain("prior runtime recovery was not verified");
    expect(result.Error).not.toContain("were restored and verified");
    expect(result.Events).toContain("old-binding-drifted-after-readiness");
  });

  it("keeps cleaning after an accepted start is initially invisible and becomes selected later", () => {
    const result = handoff("delayed-start-after-effect");

    expect(result).toMatchObject({
      Succeeded: false,
      PairState: "old",
      PointerRuntime: "old",
      TaskRuntime: "old",
      ActiveRuntime: "old",
      ExactOldTaskXml: true,
      PriorRuntimeVerified: true,
      StartAttempts: 2,
    });
    expect(result.StopAttempts).toBeGreaterThanOrEqual(3);
    expect(result.Error).toContain("restored and verified");
    expect(result.Events).toContain("task-start-accepted-delayed");
    expect(result.FirstDelayedTaskObservation).toBe("Ready");
    expect(result.FirstDelayedGenerationObservation).toBe("old");
    expect(result.Events).toContain("task-delayed-running:new");
    expect(result.Events).toContain("new-sidecar-stop");
    expect(result.Events).toContain("new-broker-stop");
    expect(result.Events.at(-1)).toBe("task-running:old");
  });

  it("rejects a selected task with trigger and settings drift before stopping anything", () => {
    const result = handoff("selected-task-contract-drift");

    expect(result).toMatchObject({
      Succeeded: false,
      PairState: "new",
      SelectedPairVerified: false,
      StopAttempts: 0,
      StartAttempts: 0,
      RegisterAttempts: 0,
      PointerAttempts: 0,
    });
    expect(result.Error).toContain("selected scheduled-task definition");
    expect(result.Events).toEqual([]);
  });
});
