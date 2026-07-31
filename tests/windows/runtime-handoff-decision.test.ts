import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const launcherPath = join(repositoryRoot, "scripts", "windows", "Launch-CodexWithRemote.ps1");
const driverPath = join(import.meta.dirname, "fixtures", "runtime-handoff-decision-driver.ps1");
const transactionDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "runtime-handoff-transaction-driver.ps1",
);
const bootstrapActivationDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "bootstrap-activation-launch-driver.ps1",
);
const codexPackageHandoffDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "codex-package-handoff-driver.ps1",
);
const codexPackageWorkerDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "codex-package-refresh-worker-driver.ps1",
);
const codexPackageSpawnerDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "codex-package-refresh-spawner-driver.ps1",
);
const desktopPackageRefreshStateDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "desktop-package-refresh-state-driver.ps1",
);
const runtimeRestartCimFailureDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "runtime-restart-cim-failure-driver.ps1",
);
const runtimeRestartPostStopBarrierDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "runtime-restart-post-stop-barrier-driver.ps1",
);
const startupPath = join(repositoryRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1");

function decide(taskState: string, generationStatus: string, desktopProcessCount = 0): string {
  const result = spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      driverPath,
      "-LauncherPath",
      launcherPath,
      "-TaskState",
      taskState,
      "-GenerationStatus",
      generationStatus,
      "-DesktopProcessCount",
      String(desktopProcessCount),
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return (JSON.parse(result.stdout) as { Decision: string }).Decision;
}

windowsOnly("immutable runtime handoff decision", () => {
  it.each([
    {
      mode: "updated-zero-desktop",
      Succeeded: true,
      RestartCalls: 1,
      FinalStatus: "current",
      ErrorCode: null,
    },
    {
      mode: "updated-existing-desktop",
      Succeeded: false,
      RestartCalls: 0,
      FinalStatus: "drifted",
      ErrorCode: "desktop-running",
    },
    {
      mode: "current-package-resolution-failed",
      Succeeded: false,
      RestartCalls: 0,
      FinalStatus: "unverified",
      ErrorCode: "runtime-generation-unverified",
    },
    {
      mode: "updated-unsafe-turn",
      Succeeded: false,
      RestartCalls: 0,
      FinalStatus: "drifted",
      ErrorCode: "runtime-handoff-failed",
    },
    {
      mode: "updated-fresh-vendor-root",
      Succeeded: false,
      RestartCalls: 0,
      WorkerCalls: 1,
      FinalStatus: "drifted",
      ErrorCode: "handoff-launch-denied",
    },
  ])(
    "gates a Running V5 app-server against the current Codex package in $mode",
    ({ mode, ...expected }) => {
      const result = spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          codexPackageHandoffDriverPath,
          "-LauncherPath",
          launcherPath,
          "-Mode",
          mode,
        ],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject(expected);
    },
  );

  it("switches a stale running generation only while Desktop is absent", () => {
    expect(decide("Running", "transition-required")).toBe("switch");
    expect(decide("Running", "transition-required", 1)).toBe("block-desktop-running");
    expect(decide("Running", "activation-required")).toBe("switch");
    expect(decide("Running", "activation-required", 1)).toBe("block-desktop-running");
  });

  it("reuses the current running generation and starts a stopped task", () => {
    expect(decide("Running", "current")).toBe("reuse");
    expect(decide("Ready", "active-receipt-missing")).toBe("start");
  });

  it("does not silently reuse an unverified running generation", () => {
    expect(decide("Running", "active-receipt-missing")).toBe("block-unverified-generation");
    expect(decide("Running", "active-bootstrap-unverified")).toBe("block-unverified-generation");
  });

  it("performs a required generation switch directly inside the elevated launcher", () => {
    const launcher = readFileSync(launcherPath, "utf8");
    const start = launcher.indexOf("function Start-CodexLocalRemoteRegisteredTask");
    const end = launcher.indexOf("\nfunction Invoke-CodexDesktopScopedProcessStart", start);
    const functionSource = launcher.slice(start, end);
    const switchStart = functionSource.indexOf("if ($decision -ceq 'switch')");
    const switchEnd = functionSource.indexOf("} elseif ($decision -ceq 'start')", switchStart);
    const switchBranch = functionSource.slice(switchStart, switchEnd);

    expect(functionSource).toContain("codex-local-remote/startup-task/v3");
    expect(functionSource).toContain("codex-local-remote/startup-task/v4");
    expect(functionSource).toContain(
      "codex-local-remote/startup-task/v5 - Starts the loopback app-server broker and local-only Codex Local Remote sidecar only on an explicit demand start.",
    );
    expect(switchBranch).toContain("Switch-CodexLocalRemoteRuntimeGeneration");
    expect(switchBranch).toContain("-ManagedSidecarPort $ManagedSidecarPort");
    expect(switchBranch).toContain("-ManagedBrokerPort $ManagedBrokerPort");
    expect(switchBranch).toContain("-ManagedBrokerUpstreamPort $ManagedBrokerUpstreamPort");
    expect(switchBranch).toContain("-ManagedBasePath $ManagedBasePath");
    expect(switchBranch).not.toContain("Start-Process");
    expect(switchBranch).not.toContain("RunAs");
  });

  it.each([
    {
      mode: "live-v3",
      Succeeded: true,
      SwitchCount: 1,
      SwitchedStatus: "activation-required",
      ErrorCode: null,
    },
    {
      mode: "live-v4",
      Succeeded: true,
      SwitchCount: 1,
      SwitchedStatus: "activation-required",
      ErrorCode: null,
    },
    {
      mode: "live-v5",
      Succeeded: true,
      SwitchCount: 0,
      SwitchedStatus: null,
      ErrorCode: null,
    },
    {
      mode: "unverified",
      Succeeded: false,
      SwitchCount: 0,
      SwitchedStatus: null,
      ErrorCode: "runtime-generation-unverified",
    },
  ])(
    "separates registered V5 from the $mode live bootstrap before Desktop launch",
    ({ mode, ...expected }) => {
      const sandbox = join(
        tmpdir(),
        `codex-bootstrap-activation-${process.pid}-${crypto.randomUUID()}`,
      );
      mkdirSync(sandbox, { recursive: true });
      const result = spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          bootstrapActivationDriverPath,
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
      expect(JSON.parse(result.stdout)).toMatchObject(expected);
    },
  );

  it("keeps same-root activation inside the stop, exact-owner cleanup, start, and V5 verification gate", () => {
    const launcher = readFileSync(launcherPath, "utf8");
    const start = launcher.indexOf("function Switch-CodexLocalRemoteBootstrapActivation");
    const end = launcher.indexOf("\nfunction Switch-CodexLocalRemoteRuntimeGeneration", start);
    const activation = launcher.slice(start, end);

    expect(activation).toContain("Assert-CodexLocalRemoteRuntimeHandoffBarrier");
    expect(activation).toContain("Stop-ScheduledTask");
    expect(activation).toContain("Assert-CodexLocalRemoteBootstrapActivationPostStopBarrier");
    expect(activation).toContain("Stop-CodexLocalRemoteSidecar.ps1");
    expect(activation).toContain("Stop-CodexAppServerBroker.ps1");
    expect(activation).toContain("Start-CodexLocalRemoteScheduledTaskBounded");
    expect(activation).toContain("Wait-CodexLocalRemoteBootstrapActivationReady");
    expect(activation).not.toContain("Start-Process");
    expect(activation).not.toContain("RunAs");
  });

  it("separates full runtime readiness from short task control in every restart path", () => {
    const launcher = readFileSync(launcherPath, "utf8");
    const functionSource = (name: string, nextName: string) => {
      const start = launcher.indexOf(`function ${name}`);
      const end = launcher.indexOf(`\nfunction ${nextName}`, start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return launcher.slice(start, end);
    };
    const bootstrap = functionSource(
      "Switch-CodexLocalRemoteBootstrapActivation",
      "Switch-CodexLocalRemoteRuntimeGeneration",
    );
    const generation = functionSource(
      "Switch-CodexLocalRemoteRuntimeGeneration",
      "Wait-CodexLocalRemoteCodexRuntimeReady",
    );
    const packageRestart = functionSource(
      "Restart-CodexLocalRemoteCodexRuntime",
      "Start-CodexLocalRemotePackageRefreshWorker",
    );

    for (const restartPath of [bootstrap, generation, packageRestart]) {
      expect(restartPath).toContain("[int]$RuntimeReadyTimeoutSeconds = 120");
      expect(restartPath).toContain("-TimeoutSeconds $RuntimeReadyTimeoutSeconds");
      expect(restartPath).toContain("-TimeoutSeconds $TimeoutSeconds");
    }
    expect(generation).toContain("-RuntimeReadyTimeoutSeconds $RuntimeReadyTimeoutSeconds");
  });

  it("fails closed when Desktop enumeration is unknown at every destructive handoff boundary", () => {
    const launcher = readFileSync(launcherPath, "utf8");
    const functionSource = (name: string, nextName: string) => {
      const start = launcher.indexOf(`function ${name}`);
      const end = launcher.indexOf(`\nfunction ${nextName}`, start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return launcher.slice(start, end);
    };
    const boundaries = [
      functionSource(
        "Stop-CodexLocalRemotePossiblyStartedSelectedGeneration",
        "Test-CodexLocalRemotePathEqual",
      ),
      functionSource(
        "Assert-CodexLocalRemoteBootstrapActivationPostStopBarrier",
        "Wait-CodexLocalRemoteBootstrapActivationReady",
      ),
      functionSource(
        "Wait-CodexLocalRemoteBootstrapActivationReady",
        "Switch-CodexLocalRemoteBootstrapActivation",
      ),
      functionSource(
        "Switch-CodexLocalRemoteBootstrapActivation",
        "Switch-CodexLocalRemoteRuntimeGeneration",
      ),
      functionSource(
        "Wait-CodexLocalRemoteCodexRuntimeReady",
        "Restart-CodexLocalRemoteCodexRuntime",
      ),
      functionSource(
        "Restart-CodexLocalRemoteCodexRuntime",
        "Start-CodexLocalRemotePackageRefreshWorker",
      ),
      functionSource(
        "Start-CodexLocalRemoteRegisteredTask",
        "Invoke-CodexDesktopScopedProcessStart",
      ),
    ];
    const preparedGate = functionSource(
      "Assert-CodexLocalRemoteDesktopHandoffProcessGate",
      "Assert-CodexLocalRemoteRuntimeHandoffBarrier",
    );

    for (const boundary of boundaries) {
      expect(boundary).toMatch(
        /Get-CodexDesktopHandoffProcesses|Assert-CodexLocalRemoteDesktopHandoffProcessGate/u,
      );
      expect(boundary).not.toContain("Get-RunningCodexDesktopProcesses");
    }
    expect(preparedGate).toContain("Get-CodexDesktopHandoffProcesses");
    expect(preparedGate).toContain("Read-CodexLocalRemoteDesktopHandoffPreparation");
    expect(preparedGate).toContain("-RequireLiveOwnership");
    expect(preparedGate).not.toContain("Get-RunningCodexDesktopProcesses");
  });

  it("checks Codex package identity and unsafe turns before any same-V5 restart", () => {
    const launcher = readFileSync(launcherPath, "utf8");
    const restartStart = launcher.indexOf("function Restart-CodexLocalRemoteCodexRuntime");
    const restartEnd = launcher.indexOf(
      "\nfunction Start-CodexLocalRemoteRegisteredTask",
      restartStart,
    );
    const restart = launcher.slice(restartStart, restartEnd);
    const firstSafety = restart.indexOf("Test-CodexLocalRemoteCodexRuntimeRestartSafe");
    const taskStop = restart.indexOf("Stop-ScheduledTask");
    const sidecarStop = restart.indexOf("$null = & $sidecarStop");
    const brokerStop = restart.indexOf("$null = & $brokerStop");

    expect(firstSafety).toBeGreaterThan(0);
    expect(firstSafety).toBeLessThan(taskStop);
    expect(taskStop).toBeLessThan(sidecarStop);
    expect(sidecarStop).toBeLessThan(brokerStop);
    expect(launcher).toContain("[decimal]$Readiness.unsafeThreadCount -eq 0");
    expect(restart).toContain("PreviousRuntimeInvocationId");

    const ownerStart = launcher.indexOf("if (-not $DefinitionOnly)");
    const owner = launcher.slice(ownerStart);
    const readinessGate = owner.indexOf("Get-CodexLocalRemoteActiveCodexRuntimeStatus");
    const readinessReturn = owner.indexOf("return $readiness", readinessGate);
    expect(readinessGate).toBeGreaterThan(0);
    expect(readinessReturn).toBeGreaterThan(readinessGate);
  });

  it("does no destructive restart work when strict Desktop CIM enumeration is unknown", () => {
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        runtimeRestartCimFailureDriverPath,
        "-LauncherPath",
        launcherPath,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      Failure: "fixture strict CIM enumeration failed",
      RestartActionCalls: 0,
      TaskStopCalls: 0,
      TaskStartCalls: 0,
      DesktopStartCalls: 0,
    });
  });

  it.each([
    "unsafe-after-task-stop",
    "unknown-after-task-stop",
    "generation-drift-after-task-stop",
    "broker-unreachable-after-task-stop",
  ])("revalidates the exact runtime after the task stops in %s", (mode) => {
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        runtimeRestartPostStopBarrierDriverPath,
        "-LauncherPath",
        launcherPath,
        "-Mode",
        mode,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      Succeeded: false,
      TaskStopCalls: 1,
      TaskStartCalls: 1,
      SidecarStopCalls: 0,
      BrokerStopCalls: 0,
      GenerationObservations: 3,
      ReadinessObservations: 3,
    });
  });

  it.each([
    {
      mode: "success",
      Outcome: "refreshed",
      StopCalls: 1,
      RestartCalls: 1,
      NativeFallbackCalls: 0,
      TaskStartCalls: 0,
      FeedbackCalls: 0,
      ReceiptWrites: 0,
      SuppressionExists: false,
    },
    {
      mode: "restart-failed",
      Outcome: "native-fallback",
      StopCalls: 1,
      RestartCalls: 1,
      NativeFallbackCalls: 1,
      TaskStartCalls: 1,
      FeedbackCalls: 1,
      ReceiptWrites: 1,
      SuppressionExists: true,
    },
  ])("runs independent package refresh worker compensation in $mode", ({ mode, ...expected }) => {
    const sandbox = join(tmpdir(), `codex-package-worker-${process.pid}-${crypto.randomUUID()}`);
    mkdirSync(sandbox, { recursive: true });
    const workerPath = join(
      repositoryRoot,
      "scripts",
      "windows",
      "Invoke-CodexLocalRemotePackageRefresh.ps1",
    );
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        codexPackageWorkerDriverPath,
        "-WorkerPath",
        workerPath,
        "-SandboxRoot",
        sandbox,
        "-Mode",
        mode,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject(expected);
  });

  it.each(["cim-unknown", "unsafe-first", "unsafe-final", "generation-drift-final"])(
    "fails package refresh closed before destructive work in %s",
    (mode) => {
      const sandbox = join(tmpdir(), `codex-package-safety-${process.pid}-${crypto.randomUUID()}`);
      mkdirSync(sandbox, { recursive: true });
      const workerPath = join(
        repositoryRoot,
        "scripts",
        "windows",
        "Invoke-CodexLocalRemotePackageRefresh.ps1",
      );
      const result = spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          codexPackageWorkerDriverPath,
          "-WorkerPath",
          workerPath,
          "-SandboxRoot",
          sandbox,
          "-Mode",
          mode,
        ],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const receipt = JSON.parse(result.stdout) as {
        Outcome: string;
        StopCalls: number;
        RestartCalls: number;
        NativeFallbackCalls: number;
        StrictDesktopEnumerations: number;
        ReadinessChecks: number;
      };
      expect(receipt).toMatchObject({
        Outcome: "preserved",
        StopCalls: 0,
        RestartCalls: 0,
        NativeFallbackCalls: 0,
      });
      expect(receipt.StrictDesktopEnumerations).toBeGreaterThanOrEqual(1);
      if (mode === "unsafe-final" || mode === "generation-drift-final") {
        expect(receipt.ReadinessChecks).toBeGreaterThanOrEqual(2);
      }
    },
  );

  it.each([
    {
      mode: "child-first-claim",
      expected: {
        ClaimedByCurrentWorker: true,
        StopCalls: 0,
      },
    },
    {
      mode: "interleaved-intent",
      expected: {
        NewIntentPreserved: true,
        StopCalls: 0,
      },
    },
  ])("protects the package worker claim in $mode", ({ mode, expected }) => {
    const sandbox = join(tmpdir(), `codex-package-claim-${process.pid}-${crypto.randomUUID()}`);
    mkdirSync(sandbox, { recursive: true });
    const workerPath = join(
      repositoryRoot,
      "scripts",
      "windows",
      "Invoke-CodexLocalRemotePackageRefresh.ps1",
    );
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        codexPackageWorkerDriverPath,
        "-WorkerPath",
        workerPath,
        "-SandboxRoot",
        sandbox,
        "-Mode",
        mode,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject(expected);
  });

  it.each([
    {
      mode: "stale-worker",
      expected: {
        Started: true,
        SpawnCalls: 1,
        IntentReplaced: true,
        ClaimStillUnowned: true,
      },
    },
    {
      mode: "fresh-unclaimed",
      expected: {
        Started: true,
        SpawnCalls: 0,
        IntentReplaced: false,
        ClaimStillUnowned: true,
      },
    },
  ])(
    "recovers package worker launch claims in $mode",
    ({ mode, expected }) => {
      const sandbox = join(tmpdir(), `codex-package-spawner-${process.pid}-${crypto.randomUUID()}`);
      mkdirSync(sandbox, { recursive: true });
      const result = spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          codexPackageSpawnerDriverPath,
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
      expect(JSON.parse(result.stdout)).toMatchObject(expected);
    },
    30_000,
  );

  it.each([
    {
      mode: "late-suppression",
      expected: {
        decision: "idle",
        lastAttemptedRoot: true,
        pendingPackageRefreshRoot: false,
      },
    },
    {
      mode: "active-worker",
      expected: {
        decision: "idle",
        lastAttemptedRoot: true,
        pendingPackageRefreshRoot: true,
      },
    },
    {
      mode: "stale-worker",
      expected: {
        decision: "idle",
        lastAttemptedRoot: false,
        pendingPackageRefreshRoot: false,
      },
    },
  ])("updates the supervisor package refresh state in $mode", ({ mode, expected }) => {
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        desktopPackageRefreshStateDriverPath,
        "-StartPath",
        startupPath,
        "-Mode",
        mode,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const parsed: unknown = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty("Decision", expected.decision);
    expect(parsed).toHaveProperty(
      "LastAttemptedRootIdentityKey",
      expected.lastAttemptedRoot ? expect.stringContaining("42001|") : "",
    );
    expect(parsed).toHaveProperty(
      "PendingPackageRefreshRootIdentityKey",
      expected.pendingPackageRefreshRoot ? expect.stringContaining("42001|") : "",
    );
  });

  it("fresh-reads fallback suppression and worker claims inside the owner mutex", () => {
    const startup = readFileSync(startupPath, "utf8");
    const loop = startup.indexOf("if ($DesktopOwnerCoordinator -and");
    const ownerMutex = startup.indexOf("Invoke-WithCodexDesktopOwnerMutex", loop);
    const suppression = startup.indexOf(
      "Get-CodexDesktopFallbackSuppressionRootIdentityKey",
      ownerMutex,
    );
    const worker = startup.indexOf("Get-CodexPackageRefreshWorkerRootIdentityKey", suppression);
    const update = startup.indexOf("Update-CodexDesktopOwnerPackageRefreshState", worker);
    const decision = startup.indexOf("Get-CodexDesktopOwnerDecision", update);

    expect(ownerMutex).toBeGreaterThan(loop);
    expect(suppression).toBeGreaterThan(ownerMutex);
    expect(worker).toBeGreaterThan(suppression);
    expect(update).toBeGreaterThan(worker);
    expect(decision).toBeGreaterThan(update);
  });

  it("bounds elevated reads of an existing package refresh intent", () => {
    const launcher = readFileSync(launcherPath, "utf8");
    const start = launcher.indexOf("function Start-CodexLocalRemotePackageRefreshWorker");
    const end = launcher.indexOf("\nfunction Start-CodexLocalRemoteRegisteredTask", start);
    const workerStart = launcher.slice(start, end);
    const itemGate = workerStart.indexOf("Get-Item -LiteralPath $intentPath");
    const contentRead = workerStart.indexOf("Get-Content", itemGate);

    expect(itemGate).toBeGreaterThan(0);
    expect(workerStart).toContain("[System.IO.FileAttributes]::ReparsePoint");
    expect(workerStart).toContain("[long]$existingItem.Length -gt 8192");
    expect(contentRead).toBeGreaterThan(itemGate);
  });
});

interface TransactionResult {
  Succeeded: boolean;
  TaskState: string;
  PointerRuntime: string;
  TaskRuntime: string;
  ActiveRuntime: string;
  PriorRuntimeVerified: boolean;
  StartAttempts: number;
  TaskControlTimeouts: number[];
  RuntimeReadyTimeouts: number[];
  Events: string[];
}

function runTransaction(mode: string): TransactionResult {
  const sandbox = join(tmpdir(), `codex-interrupted-handoff-${process.pid}-${crypto.randomUUID()}`);
  mkdirSync(sandbox, { recursive: true });
  const result = spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      transactionDriverPath,
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
  return JSON.parse(result.stdout) as TransactionResult;
}

windowsOnly("interrupted post-stop runtime handoff recovery", () => {
  it("gives runtime readiness its own full startup window while task control stays short", () => {
    const result = runTransaction("happy");

    expect(result.Succeeded).toBe(true);
    expect(result.TaskControlTimeouts.length).toBeGreaterThanOrEqual(2);
    expect(result.TaskControlTimeouts.every((timeout) => timeout === 1)).toBe(true);
    expect(result.RuntimeReadyTimeouts).toEqual([120]);
    expect(result.RuntimeReadyTimeouts[0]).toBeGreaterThanOrEqual(15 + 60 + 15);
  });

  it("continues from a stopped task with a disconnected Sidecar and the exact old Broker", () => {
    const result = runTransaction("interrupted-post-stop");

    expect(result).toMatchObject({
      Succeeded: true,
      TaskState: "Running",
      PointerRuntime: "new",
      TaskRuntime: "new",
      ActiveRuntime: "new",
      StartAttempts: 1,
    });
    expect(result.Events[0]).toBe("sidecar-stop");
    expect(result.Events).toContain("sidecar-stop");
    expect(result.Events).toContain("broker-stop");
  });

  it("retires an exact orphan Sidecar before switching a stopped stale generation", () => {
    const result = runTransaction("interrupted-task-ready-sidecar-orphan");

    expect(result).toMatchObject({
      Succeeded: true,
      TaskState: "Running",
      PointerRuntime: "new",
      TaskRuntime: "new",
      ActiveRuntime: "new",
      StartAttempts: 1,
    });
    expect(result.Events[0]).toBe("sidecar-stop");
    expect(result.Events.filter((event) => event === "sidecar-stop")).toHaveLength(1);
    expect(result.Events).toContain("broker-stop");
  });

  it("waits for an exact orphan Sidecar disconnect to propagate before switching", () => {
    const result = runTransaction("interrupted-task-ready-sidecar-delayed-disconnect");

    expect(result).toMatchObject({
      Succeeded: true,
      TaskState: "Running",
      PointerRuntime: "new",
      TaskRuntime: "new",
      ActiveRuntime: "new",
      StartAttempts: 1,
    });
    expect(result.Events[0]).toBe("sidecar-stop");
    expect(result.Events.filter((event) => event === "sidecar-stop")).toHaveLength(1);
    expect(result.Events).toContain("broker-stop");
  });

  it("accepts Desktop-detached application degradation only for one exact live preparation", () => {
    const result = runTransaction("desktop-detached-degraded-prepared");

    expect(result).toMatchObject({
      Succeeded: true,
      TaskState: "Running",
      PointerRuntime: "new",
      TaskRuntime: "new",
      ActiveRuntime: "new",
      StartAttempts: 1,
    });
  });

  it("keeps Desktop-detached application degradation fail-closed without preparation", () => {
    const result = runTransaction("desktop-detached-degraded-unprepared");

    expect(result).toMatchObject({
      Succeeded: false,
      TaskState: "Running",
      PointerRuntime: "old",
      TaskRuntime: "old",
      ActiveRuntime: "old",
      PriorRuntimeVerified: true,
      StartAttempts: 2,
    });
  });

  it("restores and starts the exact prior runtime when selected startup fails from post-stop", () => {
    const result = runTransaction("interrupted-post-stop-start-fails");

    expect(result).toMatchObject({
      Succeeded: false,
      TaskState: "Running",
      PointerRuntime: "old",
      TaskRuntime: "old",
      ActiveRuntime: "old",
      PriorRuntimeVerified: true,
      StartAttempts: 2,
    });
    expect(result.Events[0]).toBe("sidecar-stop");
    expect(result.Events.slice(-4)).toEqual([
      "task-register:old",
      "pointer-set:old",
      "task-start:2",
      "task-running:old",
    ]);
  });
});
