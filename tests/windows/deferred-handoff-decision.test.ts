import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const scriptPath = join(
  repositoryRoot,
  "scripts",
  "windows",
  "Complete-CodexLocalRemoteDeferredHandoff.ps1",
);
const onDemandScriptPath = join(
  repositoryRoot,
  "scripts",
  "windows",
  "Invoke-CodexLocalRemoteOnDemandHandoff.ps1",
);
const controlScriptPath = join(
  repositoryRoot,
  "scripts",
  "windows",
  "CodexLocalRemote.Control.ps1",
);
const driverPath = join(import.meta.dirname, "fixtures", "deferred-handoff-decision-driver.ps1");
const safetyDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "deferred-handoff-safety-driver.ps1",
);
const naturalExitDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "deferred-handoff-natural-exit-driver.ps1",
);
const workerGuardDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "deferred-handoff-worker-guard-driver.ps1",
);
const immediateRestartDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "on-demand-immediate-restart-driver.ps1",
);

function inspectSafety(mode: "cim-error" | "desktop-remains"): {
  count: number;
  error: string;
  launchCalls: number;
  threw: boolean;
} {
  const result = spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      safetyDriverPath,
      "-ScriptPath",
      scriptPath,
      "-Mode",
      mode,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as {
    count: number;
    error: string;
    launchCalls: number;
    threw: boolean;
  };
}

function decide(input: {
  brokerReachable: boolean;
  desktopConnected: boolean;
  desktopProcessCount: number;
  sidecarConnected: boolean;
  unsafeThreadCount: number;
}): string {
  const result = spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      driverPath,
      "-ScriptPath",
      scriptPath,
      "-BrokerReachable",
      input.brokerReachable ? "1" : "0",
      "-DesktopConnected",
      input.desktopConnected ? "1" : "0",
      "-DesktopProcessCount",
      String(input.desktopProcessCount),
      "-SidecarConnected",
      input.sidecarConnected ? "1" : "0",
      "-UnsafeThreadCount",
      String(input.unsafeThreadCount),
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return (JSON.parse(result.stdout) as { Decision: string }).Decision;
}

function inspectNaturalExit(
  mode: "success" | "cim-error" | "process-reappears" | "broker-busy" | "broker-rebusy",
): {
  error: string;
  launchCalls: number;
  observationCount: number;
  succeeded: boolean;
} {
  const result = spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      naturalExitDriverPath,
      "-ScriptPath",
      scriptPath,
      "-Mode",
      mode,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as {
    error: string;
    launchCalls: number;
    observationCount: number;
    succeeded: boolean;
  };
}

function inspectWorkerGuard(
  mode:
    | "wrong-generation"
    | "mutex-busy"
    | "foreign-fresh-receipt"
    | "matching-intent-receipt"
    | "matching-desired-intent"
    | "native-desired-intent"
    | "superseded-desired-intent"
    | "wrong-desired-runtime",
): {
  HolderProcessId?: number;
  HolderStartTimeUtcTicks?: number;
  IsValid: boolean;
  MutexName?: string;
  ReadyState?: string;
  Reason: string;
} {
  const result = spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      workerGuardDriverPath,
      "-ScriptPath",
      scriptPath,
      "-Mode",
      mode,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as {
    IsValid: boolean;
    MutexName?: string;
    Reason: string;
  };
}

function inspectImmediateRestart(
  mode:
    | "barrier-current"
    | "barrier-bound-stdio"
    | "barrier-foreign-stdio"
    | "barrier-multiple-stdio"
    | "barrier-stdio-ownership-drift"
    | "barrier-cancelled"
    | "barrier-legacy-native-rewrite"
    | "barrier-remote-superseded"
    | "barrier-native-runtime-superseded"
    | "barrier-ready-native-superseded"
    | "barrier-rearm-failure"
    | "barrier-rearm-external-remote"
    | "stop-exact"
    | "stop-empty-path"
    | "stop-wrong-path"
    | "stop-identity-drift",
): {
  CloseCalls: number;
  CompensationCalls: number;
  CompensationError: string;
  CompensationStatus: string;
  CurrentDesiredIntentId: string;
  CurrentDesiredMode: string;
  DesiredModeReadCalls: number;
  DesiredModeWrites: string[];
  DeferredCompensationIntentId: string;
  DrainCalls: number;
  Error: string;
  IdentityOpenCalls: number;
  NativeDesktopWasClosed: boolean;
  NativeStartCalls: number;
  OpenContinuationCalls: number;
  PortWaitCalls: number;
  RootStopCalls: number;
  GroupStopCalls: number;
  StopCalls: number;
  WaitCalls: number;
  Succeeded: boolean;
} {
  const result = spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      immediateRestartDriverPath,
      "-ScriptPath",
      onDemandScriptPath,
      "-Mode",
      mode,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as {
    CloseCalls: number;
    CompensationCalls: number;
    CompensationError: string;
    CompensationStatus: string;
    CurrentDesiredIntentId: string;
    CurrentDesiredMode: string;
    DesiredModeReadCalls: number;
    DesiredModeWrites: string[];
    DeferredCompensationIntentId: string;
    DrainCalls: number;
    Error: string;
    IdentityOpenCalls: number;
    NativeDesktopWasClosed: boolean;
    NativeStartCalls: number;
    OpenContinuationCalls: number;
    PortWaitCalls: number;
    StopCalls: number;
    WaitCalls: number;
    Succeeded: boolean;
  };
}

windowsOnly("deferred immutable runtime handoff decision", () => {
  it("waits while any broker-observed thread is unsafe", () => {
    expect(
      decide({
        brokerReachable: true,
        desktopConnected: false,
        desktopProcessCount: 1,
        sidecarConnected: false,
        unsafeThreadCount: 1,
      }),
    ).toBe("wait-turns");
  });

  it("closes Desktop only after every thread is idle", () => {
    expect(
      decide({
        brokerReachable: true,
        desktopConnected: true,
        desktopProcessCount: 0,
        sidecarConnected: true,
        unsafeThreadCount: 0,
      }),
    ).toBe("close-desktop");
  });

  it("closes Desktop when Broker is disconnected but a Desktop process remains", () => {
    expect(
      decide({
        brokerReachable: true,
        desktopConnected: false,
        desktopProcessCount: 1,
        sidecarConnected: false,
        unsafeThreadCount: 0,
      }),
    ).toBe("close-desktop");
  });

  it("launches directly only when Desktop is disconnected and absent", () => {
    expect(
      decide({
        brokerReachable: true,
        desktopConnected: false,
        desktopProcessCount: 0,
        sidecarConnected: false,
        unsafeThreadCount: 0,
      }),
    ).toBe("launch");
  });

  it("waits rather than guessing when the broker cannot be inspected", () => {
    expect(
      decide({
        brokerReachable: false,
        desktopConnected: false,
        desktopProcessCount: 1,
        sidecarConnected: false,
        unsafeThreadCount: 0,
      }),
    ).toBe("wait-broker");
  });
});

windowsOnly("deferred immutable runtime handoff safety gates", () => {
  it("fails closed when CIM process enumeration cannot be completed", () => {
    const result = inspectSafety("cim-error");

    expect(result.threw).toBe(true);
    expect(result.count).toBe(-1);
    expect(result.error).toContain("simulated CIM enumeration failure");
  });

  it("refuses launch when a strict final enumeration still sees Desktop", () => {
    const result = inspectSafety("desktop-remains");

    expect(result.threw).toBe(true);
    expect(result.count).toBe(1);
    expect(result.launchCalls).toBe(0);
    expect(result.error).toContain("Desktop remains running");
  });

  it("places the strict final Desktop assertion after the disconnect delay and before launch", () => {
    const source = readFileSync(scriptPath, "utf8");
    const disconnectDelay = source.indexOf("Start-Sleep -Seconds $DisconnectDelaySeconds");
    const strictAssertion = source.indexOf("Assert-DeferredHandoffDesktopStopped", disconnectDelay);
    const launch = source.indexOf("$launchRequest = & $launcherPath", strictAssertion);

    expect(disconnectDelay).toBeGreaterThan(-1);
    expect(strictAssertion).toBeGreaterThan(disconnectDelay);
    expect(launch).toBeGreaterThan(strictAssertion);
  });

  it("delegates the immediate restart barrier to the locked installed control", () => {
    const source = readFileSync(scriptPath, "utf8");
    const onDemand = readFileSync(onDemandScriptPath, "utf8");
    const control = readFileSync(controlScriptPath, "utf8");
    const immediateBranchStart = source.indexOf(
      "if ($InvokeInstalledControl -and -not $WaitForNaturalDesktopExit)",
    );
    const immediateBranchEnd = source.indexOf("$idleDeadline =", immediateBranchStart);
    const immediateBranch = source.slice(immediateBranchStart, immediateBranchEnd);

    expect(immediateBranchStart).toBeGreaterThan(-1);
    expect(immediateBranchEnd).toBeGreaterThan(immediateBranchStart);
    expect(immediateBranch).toContain("& $controlPath");
    expect(immediateBranch).toContain("-AllowDesktopRestart");
    expect(immediateBranch).toContain("-ReadyWaitSeconds $VerificationTimeoutSeconds");
    expect(immediateBranch).toContain("-ImmediateAuthorizedDesktopRestartForOpen");
    expect(immediateBranch).not.toContain("Stop-DeferredHandoffDesktopImmediately");
    expect(immediateBranch).not.toContain("Start-Sleep -Seconds $DisconnectDelaySeconds");
    expect(control).toContain("ImmediateAuthorizedDesktopRestartForOpen");
    expect(control).toContain("[ValidateRange(15, 600)]");
    expect(control).toContain("[int]$ReadyWaitSeconds = 120");
    expect(control).toContain("-ReadyWaitSeconds $ReadyWaitSeconds");
    expect(source).toMatch(
      /\[ValidateRange\(15, 600\)\]\s+\[int\]\$VerificationTimeoutSeconds = 180/u,
    );
    expect(source.match(/-ReadyWaitSeconds \$VerificationTimeoutSeconds/gu)).toHaveLength(2);
    expect(onDemand).toContain("Invoke-OnDemandImmediateAuthorizedDesktopRestartBarrier");

    const freshStart = onDemand.slice(
      onDemand.lastIndexOf("$desiredMode = Set-OnDemandOpenDesiredRemote"),
      onDemand.lastIndexOf("$startStatus ="),
    );
    const desiredRemote = freshStart.indexOf("$desiredMode = Set-OnDemandOpenDesiredRemote");
    const ownerIntent = freshStart.indexOf("New-CodexDesktopOwnerIntent", desiredRemote);
    const selectedStart = freshStart.indexOf("Start-OnDemandSelectedRemoteRuntime", ownerIntent);
    expect(desiredRemote).toBeGreaterThanOrEqual(0);
    expect(ownerIntent).toBeGreaterThan(desiredRemote);
    expect(selectedStart).toBeGreaterThan(ownerIntent);
    expect(freshStart.slice(desiredRemote, ownerIntent)).toContain(
      "$ImmediateAuthorizedDesktopRestartForOpen",
    );
    expect(freshStart.slice(desiredRemote, ownerIntent)).toContain(
      "$decision -ceq 'start-without-desktop-restart'",
    );
    expect(onDemand).toContain("-OwnerIntent $script:immediateFreshStartOwnerIntent");

    const mutexAcquire = onDemand.indexOf("$controlMutex.WaitOne");
    const restartBarrier = onDemand.lastIndexOf(
      "Invoke-OnDemandImmediateAuthorizedDesktopRestartBarrier",
    );
    const mutexRelease = onDemand.lastIndexOf("$controlMutex.ReleaseMutex");
    expect(mutexAcquire).toBeGreaterThan(-1);
    expect(restartBarrier).toBeGreaterThan(mutexAcquire);
    expect(mutexRelease).toBeGreaterThan(restartBarrier);
  });

  it("serializes intent, exact Desktop stop, task drain, and installed Open", () => {
    expect(inspectImmediateRestart("barrier-cancelled")).toMatchObject({
      CompensationCalls: 0,
      DesiredModeReadCalls: 1,
      DesiredModeWrites: [],
      DrainCalls: 0,
      NativeDesktopWasClosed: false,
      OpenContinuationCalls: 0,
      StopCalls: 0,
      WaitCalls: 0,
      Succeeded: false,
    });
    expect(inspectImmediateRestart("barrier-current")).toMatchObject({
      CompensationCalls: 0,
      DesiredModeReadCalls: 2,
      DesiredModeWrites: ["Native", "Remote"],
      DeferredCompensationIntentId: "d".repeat(32),
      DrainCalls: 1,
      NativeDesktopWasClosed: true,
      OpenContinuationCalls: 1,
      PortWaitCalls: 1,
      RootStopCalls: 1,
      GroupStopCalls: 0,
      StopCalls: 1,
      WaitCalls: 1,
      Succeeded: true,
    });
    expect(inspectImmediateRestart("barrier-bound-stdio")).toMatchObject({
      DesiredModeWrites: ["Native", "Remote"],
      DrainCalls: 1,
      NativeDesktopWasClosed: true,
      OpenContinuationCalls: 1,
      RootStopCalls: 0,
      GroupStopCalls: 1,
      StopCalls: 1,
      Succeeded: true,
    });
    expect(inspectImmediateRestart("barrier-foreign-stdio")).toMatchObject({
      DesiredModeReadCalls: 0,
      DesiredModeWrites: [],
      DrainCalls: 0,
      Error:
        "The deferred Desktop restart barrier found a stdio app-server outside the exact package Desktop root.",
      NativeDesktopWasClosed: false,
      StopCalls: 0,
      Succeeded: false,
    });
    expect(inspectImmediateRestart("barrier-multiple-stdio")).toMatchObject({
      DesiredModeReadCalls: 0,
      DesiredModeWrites: [],
      DrainCalls: 0,
      Error:
        "The deferred Desktop restart barrier found multiple independent stdio app-servers and refused to guess Desktop ownership.",
      NativeDesktopWasClosed: false,
      StopCalls: 0,
      Succeeded: false,
    });
    expect(inspectImmediateRestart("barrier-stdio-ownership-drift")).toMatchObject({
      DesiredModeReadCalls: 0,
      DesiredModeWrites: [],
      DrainCalls: 0,
      Error:
        "The deferred Desktop restart barrier ownership snapshot changed before Desktop shutdown.",
      NativeDesktopWasClosed: false,
      StopCalls: 0,
      Succeeded: false,
    });
    expect(inspectImmediateRestart("barrier-legacy-native-rewrite")).toMatchObject({
      CompensationCalls: 0,
      CurrentDesiredIntentId: "d".repeat(32),
      CurrentDesiredMode: "Remote",
      DesiredModeReadCalls: 2,
      DesiredModeWrites: ["Native", "Remote"],
      DeferredCompensationIntentId: "d".repeat(32),
      DrainCalls: 1,
      NativeDesktopWasClosed: true,
      OpenContinuationCalls: 1,
      PortWaitCalls: 1,
      StopCalls: 1,
      WaitCalls: 1,
      Succeeded: true,
    });
    expect(inspectImmediateRestart("barrier-remote-superseded")).toMatchObject({
      CompensationCalls: 1,
      DesiredModeReadCalls: 2,
      DesiredModeWrites: ["Native"],
      DrainCalls: 1,
      NativeDesktopWasClosed: true,
      OpenContinuationCalls: 0,
      PortWaitCalls: 1,
      StopCalls: 1,
      WaitCalls: 1,
      Succeeded: false,
    });
    expect(inspectImmediateRestart("barrier-native-runtime-superseded")).toMatchObject({
      CompensationCalls: 1,
      DesiredModeWrites: ["Native"],
      OpenContinuationCalls: 0,
      Succeeded: false,
    });
    expect(inspectImmediateRestart("barrier-ready-native-superseded")).toMatchObject({
      CompensationCalls: 1,
      DesiredModeWrites: ["Native"],
      OpenContinuationCalls: 0,
      PortWaitCalls: 1,
      Succeeded: false,
    });
  });

  it("compensates a post-rearm failure using only the rearmed Remote intent", () => {
    expect(inspectImmediateRestart("barrier-rearm-failure")).toMatchObject({
      CompensationCalls: 1,
      CompensationError: "",
      CompensationStatus: "native-restored",
      CurrentDesiredIntentId: "f".repeat(32),
      CurrentDesiredMode: "Native",
      DeferredCompensationIntentId: "d".repeat(32),
      DesiredModeWrites: ["Native", "Remote", "Native"],
      NativeStartCalls: 1,
      Succeeded: false,
    });
    expect(inspectImmediateRestart("barrier-rearm-external-remote")).toMatchObject({
      CompensationCalls: 1,
      CompensationStatus: "",
      CurrentDesiredIntentId: "8".repeat(32),
      CurrentDesiredMode: "Remote",
      DeferredCompensationIntentId: "d".repeat(32),
      DesiredModeWrites: ["Native", "Remote"],
      NativeStartCalls: 0,
      Succeeded: false,
    });
  });

  it("stops only one exact package Desktop identity and fails closed on ambiguity or PID drift", () => {
    expect(inspectImmediateRestart("stop-exact")).toMatchObject({
      CloseCalls: 1,
      IdentityOpenCalls: 1,
      Succeeded: true,
    });
    expect(inspectImmediateRestart("stop-empty-path")).toMatchObject({
      CloseCalls: 0,
      IdentityOpenCalls: 0,
      Succeeded: false,
    });
    expect(inspectImmediateRestart("stop-wrong-path")).toMatchObject({
      CloseCalls: 0,
      IdentityOpenCalls: 0,
      Succeeded: false,
    });
    expect(inspectImmediateRestart("stop-identity-drift")).toMatchObject({
      CloseCalls: 0,
      IdentityOpenCalls: 1,
      Succeeded: false,
    });
  });
});

windowsOnly("deferred immutable runtime natural-exit handoff", () => {
  it("launches only after two consecutive zero-process observations with an idle broker", () => {
    const result = inspectNaturalExit("success");

    expect(result.succeeded).toBe(true);
    expect(result.launchCalls).toBe(1);
    expect(result.observationCount).toBe(4);
  });

  it("fails closed without launch when strict CIM enumeration fails", () => {
    const result = inspectNaturalExit("cim-error");

    expect(result.succeeded).toBe(false);
    expect(result.launchCalls).toBe(0);
    expect(result.error).toContain("simulated CIM enumeration failure");
  });

  it("resets the zero-process barrier when Desktop reappears and never launches", () => {
    const result = inspectNaturalExit("process-reappears");

    expect(result.succeeded).toBe(false);
    expect(result.launchCalls).toBe(0);
    expect(result.observationCount).toBeGreaterThanOrEqual(3);
    expect(result.error).toContain("naturally");
  });

  it("never launches while the broker still reports unsafe threads", () => {
    const result = inspectNaturalExit("broker-busy");

    expect(result.succeeded).toBe(false);
    expect(result.launchCalls).toBe(0);
    expect(result.error).toContain("naturally");
  });

  it("rechecks broker safety after the disconnect delay and before launch", () => {
    const result = inspectNaturalExit("broker-rebusy");

    expect(result.succeeded).toBe(false);
    expect(result.launchCalls).toBe(0);
    expect(result.error).toContain("unsafe thread");
  });

  it("keeps the natural-exit implementation free of Desktop close and kill calls", () => {
    const source = readFileSync(scriptPath, "utf8");
    const helper = source.match(
      /function Wait-DeferredHandoffNaturalDesktopExit[\s\S]*?\r?\n\}\r?\n\r?\nfunction Assert-DeferredHandoffDesktopStopped/u,
    )?.[0];
    const safeStatus = source.indexOf("-Status 'waiting-for-natural-desktop-exit'");
    const modeBranchStart = source.lastIndexOf("if ($WaitForNaturalDesktopExit) {", safeStatus);
    const modeBranchEnd = source.indexOf("\n        } else {", safeStatus);
    const modeBranch = source.slice(modeBranchStart, modeBranchEnd);

    expect(source).toContain("[switch]$WaitForNaturalDesktopExit");
    expect(helper).toBeDefined();
    expect(helper).not.toContain("CloseMainWindow");
    expect(helper).not.toMatch(/\bStop-Process\b/u);
    expect(safeStatus).toBeGreaterThan(-1);
    expect(modeBranchStart).toBeGreaterThan(-1);
    expect(modeBranchEnd).toBeGreaterThan(modeBranchStart);
    expect(modeBranch).not.toContain("CloseMainWindow");
    expect(modeBranch).not.toMatch(/\bStop-Process\b/u);
  });
});

windowsOnly("deferred handoff worker identity guards", () => {
  it("keeps waiting only while the exact Remote intent still owns the selected runtime", () => {
    expect(inspectWorkerGuard("matching-desired-intent").IsValid).toBe(true);
    expect(inspectWorkerGuard("native-desired-intent").IsValid).toBe(false);
    expect(inspectWorkerGuard("superseded-desired-intent").IsValid).toBe(false);
    expect(inspectWorkerGuard("wrong-desired-runtime").IsValid).toBe(false);

    const source = readFileSync(scriptPath, "utf8");
    const waitStart = source.indexOf("$idleDeadline =");
    const waitEnd = source.indexOf("-Status 'switching'", waitStart);
    const waitBlock = source.slice(waitStart, waitEnd);
    expect(waitBlock).toContain("Test-DeferredHandoffCurrentDesiredModeIntent");
    expect(waitBlock).toContain("-Status 'cancelled'");
    expect(waitBlock).toContain("Invoke-DeferredHandoffBrokerLifecycleReconciliation");
    expect(waitBlock).toContain("$reconciliationAttempts -lt 3");
    expect(source).toContain("'reconcile'");
    expect(source).toContain("ProcessStartTimeUtcTicks =");
  });

  it("fails closed when the selected generation changes before verification", () => {
    const result = inspectWorkerGuard("wrong-generation");

    expect(result.IsValid).toBe(false);
    expect(result.Reason).toBe("expected-runtime-mismatch");
  });

  it("uses a dedicated per-DataDir mutex and rejects a second worker", () => {
    const result = inspectWorkerGuard("mutex-busy");

    expect(result.IsValid).toBe(false);
    expect(result.MutexName).toMatch(/^Global\\CodexLocalRemote\.DeferredHandoff\.[0-9a-f]{64}$/u);
    expect(result.MutexName).not.toContain(".DesktopOwner.");
    expect(result.Reason).toContain("duplicate worker");
    expect(result.HolderProcessId).toBeGreaterThan(0);
    expect(result.HolderStartTimeUtcTicks).toBeGreaterThan(0);
    expect(result.ReadyState).toBe("ready");
  });

  it("uses an isolated bounded and diagnosable holder handshake", () => {
    const fixture = readFileSync(workerGuardDriverPath, "utf8");

    expect(fixture).toContain("[guid]::NewGuid()");
    expect(fixture).toContain("-RedirectStandardError $stderrPath");
    expect(fixture).toContain("$holder.HasExited");
    expect(fixture).toContain("$holder.StartTime.ToUniversalTime().Ticks");
    expect(fixture).toContain("[DateTime]::UtcNow.AddSeconds(20)");
    expect(fixture).toContain("$holder.WaitForExit(5000)");
    expect(fixture).not.toContain("[DateTime]::UtcNow.AddSeconds(3)");
  });

  it("rejects a genuinely fresh receipt owned by a different launch request", () => {
    const result = inspectWorkerGuard("foreign-fresh-receipt");

    expect(result.IsValid).toBe(false);
    expect(result.Reason).toBe("launch-receipt-correlation-mismatch");
  });

  it("accepts a fresh receipt bound to the exact returned intent identity", () => {
    const result = inspectWorkerGuard("matching-intent-receipt");

    expect(result.IsValid).toBe(true);
    expect(result.Reason).toBe("verified");
  });

  it("calls the same-runtime launcher directly with the selected target", () => {
    const source = readFileSync(scriptPath, "utf8");
    const targetRead = source.indexOf("$currentBeforeLaunch =");
    const baselineRead = source.indexOf("$launchReceiptBaseline =");
    const launchStarted = source.indexOf(
      "$launchStartedAt = [DateTimeOffset]::UtcNow",
      baselineRead,
    );
    const launch = source.indexOf("$launchRequest = & $launcherPath", launchStarted);

    expect(targetRead).toBeGreaterThan(-1);
    expect(baselineRead).toBeGreaterThan(targetRead);
    expect(launchStarted).toBeGreaterThan(baselineRead);
    expect(launch).toBeGreaterThan(launchStarted);
    expect(source).toContain("-RequestDesktopLaunch");
    expect(source).toContain("-ExpectedSelectedRuntimeVersionId $expectedVersionId");
    expect(source).toContain("-ExpectedSelectedRuntimeRoot $selectedRoot");
    expect(source).toContain("$expectedLaunchCorrelationId = [string]$launchRequest.IntentId");
    expect(source).not.toContain("Start-Process -FilePath $shortcutPath");
  });
});
