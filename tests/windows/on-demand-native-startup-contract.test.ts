import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");
const windowsPath = (name: string) => join(repositoryRoot, "scripts", "windows", name);
const windowsScript = (name: string) => readFileSync(windowsPath(name), "utf8");

describe("Windows native-default on-demand Remote contract", () => {
  it("registers an on-demand task with zero triggers and no catch-up", () => {
    const module = windowsScript("CodexLocalRemote.Windows.psm1");
    const registration = windowsScript("Register-CodexLocalRemoteStartup.ps1");

    expect(module).toContain("TriggerCount = 0");
    expect(module).toContain("StartWhenAvailable = $false");
    expect(module).toContain("function Get-LegacyAutoStartStartupTaskDefinitionV5");
    expect(registration).not.toContain("New-ScheduledTaskTrigger");
    expect(registration).not.toMatch(/-Trigger\s+\$/u);
    expect(registration.match(/-StartWhenAvailable:\$false/gu)?.length).toBeGreaterThanOrEqual(2);
  });

  it("does not start Remote during registration unless explicitly requested", () => {
    const registration = windowsScript("Register-CodexLocalRemoteStartup.ps1");
    const starts = [...registration.matchAll(/Start-ScheduledTask/gu)];

    expect(registration).toContain("[switch]$StartRemoteNow");
    expect(registration).toContain("$startAfterRegistration = [bool]$StartRemoteNow");
    expect(starts.length).toBe(2);
    for (const match of starts) {
      const prefix = registration.slice(Math.max(0, match.index - 700), match.index);
      expect(prefix).toContain("if ($startAfterRegistration)");
    }
  });

  it("chooses idempotent zero-restart paths before one authorized handoff", () => {
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        join(
          repositoryRoot,
          "tests",
          "windows",
          "fixtures",
          "on-demand-handoff-decision-driver.ps1",
        ),
        "-ScriptPath",
        windowsPath("Invoke-CodexLocalRemoteOnDemandHandoff.ps1"),
      ],
      { encoding: "utf8" },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      AlreadyRunning: "remote-lease-active",
      Queued: "remote-start-pending",
      DetachedNative: "request-active-lease-recovery",
      DetachedNativeWithoutAuthority: "desktop-restart-authorization-required",
      BackgroundRepair: "wait-background-recovery",
      BackgroundNativeWithoutAuthority: "desktop-restart-authorization-required",
      BackgroundNativeWithAuthority: "handoff-native-desktop-once",
      BackgroundNativeHeadless: "start-without-desktop-restart",
      BackgroundNativeOrphanStdio: "blocked-independent-stdio",
      RunningUnverified: "blocked-runtime-unverified",
      TransitionNativeWithoutAuthority: "desktop-restart-authorization-required",
      TransitionNativeWithAuthority: "handoff-native-desktop-once",
      BusyTransitionWithoutAuthority: "deferred-handoff-authorization-required",
      BusyTransitionWithAuthority: "defer-runtime-handoff",
      TransitionHeadless: "start-without-desktop-restart",
      TransitionAmbiguousRoots: "blocked-ambiguous-desktop-roots",
      TransitionOrphanStdio: "blocked-independent-stdio",
      BackgroundOnly: "start-without-desktop-restart",
      RestartRequired: "desktop-restart-authorization-required",
      RestartAuthorized: "handoff-native-desktop-once",
      AmbiguousRoots: "blocked-ambiguous-desktop-roots",
      OrphanStdio: "blocked-independent-stdio",
      DisabledTask: "blocked-task-state",
    });
  });

  it("serializes Open, Close, and Status for one canonical DataDir", () => {
    const handoff = windowsScript("Invoke-CodexLocalRemoteOnDemandHandoff.ps1");

    expect(handoff).toContain("Global\\CodexLocalRemote.OnDemandControl.");
    expect(handoff).toContain("Timed out waiting for another Remote control operation.");
    expect(handoff).toContain("$controlMutex.WaitOne");
    expect(handoff).toContain("$controlMutex.ReleaseMutex()");
    expect(handoff).toContain("$controlMutex.Dispose()");
  });

  it("does not mistake the observed public-503 detached lease for ready", () => {
    const handoff = windowsScript("Invoke-CodexLocalRemoteOnDemandHandoff.ps1");

    expect(handoff).toContain("function Get-OnDemandRemoteState");
    expect(handoff).toContain("appServerReady");
    expect(handoff).toContain("desktopConnected");
    expect(handoff).toContain("sidecarConnected");
    expect(handoff).toContain("unsafeThreadCount");
    expect(handoff).toContain("unknownCount");
    expect(handoff).toContain("app-server-broker.json");
    expect(handoff).toContain("$currentGeneration");
    expect(handoff).toContain("$previousGeneration");
    expect(handoff).toContain("'runtime-transition'");
    expect(handoff).toContain("New-CodexDesktopOwnerIntent");
    expect(handoff).toContain("'request-active-lease-recovery'");
    expect(handoff).not.toMatch(
      /if \(\$taskDecision -ceq 'remote-lease-active'\)[\s\S]{0,800}return/u,
    );
  });

  it("classifies only one exact silent rollback ancestor as transitionable", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "codex-on-demand-state-"));
    try {
      const result = spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          join(repositoryRoot, "tests", "windows", "fixtures", "on-demand-remote-state-driver.ps1"),
          "-ScriptPath",
          windowsPath("Invoke-CodexLocalRemoteOnDemandHandoff.ps1"),
          "-SandboxRoot",
          sandbox,
        ],
        { encoding: "utf8" },
      );

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        CurrentActive: "ready",
        CurrentDetached: "desktop-detached",
        CurrentHandshakeUnpublished: "unverified",
        CurrentUnsafeDetached: "unverified",
        CurrentBackground: "background-repairable",
        PreviousSilent: "runtime-transition",
        PreviousWithSidecar: "runtime-transition",
        PreviousActive: "runtime-transition-busy",
        PreviousIdleActive: "runtime-transition",
        PreviousDegraded: "unverified",
        PreviousDesktopConnected: "unverified",
        PreviousUnknown: "unverified",
        PreviousUnsafe: "unverified",
        PreviousManifestMismatch: "unverified",
        Unrelated: "unverified",
      });
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("defers an authorized busy-generation handoff to one hidden idle worker", () => {
    const handoff = windowsScript("Invoke-CodexLocalRemoteOnDemandHandoff.ps1");

    expect(handoff).toContain("function Start-OnDemandDeferredRuntimeHandoff");
    expect(handoff).toContain("Complete-CodexLocalRemoteDeferredHandoff.ps1");
    expect(handoff).toContain("-WindowStyle Hidden");
    expect(handoff).toContain("-Status 'restart-deferred'");
    expect(handoff).toContain("-ExpectedSelectedVersionId");
    expect(handoff).toContain("-ExpectedSelectedRuntimeRoot");
    expect(handoff).toContain("Global\\CodexLocalRemote.DeferredHandoff.");
    expect(handoff).toContain("Test-OnDemandDeferredHandoffWorkerActive");
    expect(handoff).toContain("WorkerAlreadyActive");
    expect(handoff).toContain("ExpectedDesiredModeIntentId");

    const stateStart = handoff.indexOf("function Get-OnDemandDeferredHandoffWorkerState");
    const stateEnd = handoff.indexOf(
      "function Test-OnDemandDeferredHandoffWorkerMatches",
      stateStart,
    );
    const stateHelper = handoff.slice(stateStart, stateEnd);
    expect(stateHelper.match(/Test-OnDemandDeferredHandoffWorkerActive/gu)?.length).toBe(2);
    expect(stateHelper).toContain("ProcessStartTimeUtcTicks");
    expect(stateHelper).toContain("Get-Process");
  });

  it("spawns one runtime-bound hidden worker and reuses only its exact active claim", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "codex-on-demand-worker-"));
    try {
      const result = spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          join(
            repositoryRoot,
            "tests",
            "windows",
            "fixtures",
            "on-demand-deferred-worker-driver.ps1",
          ),
          "-ScriptPath",
          windowsPath("Invoke-CodexLocalRemoteOnDemandHandoff.ps1"),
          "-SandboxRoot",
          sandbox,
        ],
        { encoding: "utf8" },
      );

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const receipt = JSON.parse(result.stdout) as {
        DataDir: string;
        CreatedDesiredMode: { IntentId: string };
        CreatedDesiredModeWasCreated: boolean;
        DesiredModeSetCalls: number;
        Existing: { AlreadyActive: boolean; ProcessId: number };
        Fresh: { AlreadyActive: boolean; ProcessId: number; ProcessStartTimeUtcTicks: number };
        KilledProcesses: number;
        ReusedDesiredMode: { IntentId: string };
        ReusedDesiredModeWasCreated: boolean;
        Superseded: {
          AlreadyActive: boolean;
          ProcessId: number;
          ProcessStartTimeUtcTicks: number;
        };
        RuntimeRoot: string;
        RuntimeVersionId: string;
        StartCalls: Array<{
          ArgumentList: string;
          PassThru: boolean;
          RedirectStandardError: string;
          RedirectStandardOutput: string;
          WindowStyle: string;
          WorkingDirectory: string;
        }>;
        WaitForExitCalls: number;
        WorkerAdmissionFailureCaught: boolean;
      };

      expect(receipt.Fresh.AlreadyActive).toBe(false);
      expect(receipt.Fresh.ProcessId).toBe(8123);
      expect(receipt.Fresh.ProcessStartTimeUtcTicks).toBeGreaterThan(0);
      expect(receipt.Existing).toMatchObject({ AlreadyActive: true, ProcessId: 0 });
      expect(receipt.Superseded.AlreadyActive).toBe(false);
      expect(receipt.Superseded.ProcessId).toBe(8123);
      expect(receipt.ReusedDesiredMode.IntentId).toBe("f".repeat(32));
      expect(receipt.ReusedDesiredModeWasCreated).toBe(false);
      expect(receipt.CreatedDesiredMode.IntentId).toBe("d".repeat(32));
      expect(receipt.CreatedDesiredModeWasCreated).toBe(true);
      expect(receipt.DesiredModeSetCalls).toBe(1);
      expect(receipt.WorkerAdmissionFailureCaught).toBe(true);
      expect(receipt.KilledProcesses).toBe(1);
      expect(receipt.WaitForExitCalls).toBe(1);
      expect(receipt.StartCalls).toHaveLength(3);
      const call = receipt.StartCalls[0];
      expect(call.WindowStyle).toBe("Hidden");
      expect(call.PassThru).toBe(true);
      expect(call.WorkingDirectory).toBe(receipt.RuntimeRoot);
      expect(call.ArgumentList).toContain(receipt.RuntimeVersionId);
      expect(call.ArgumentList).toContain("-ExpectedSelectedRuntimeRoot");
      expect(call.ArgumentList).toContain("-InvokeInstalledControl");
      expect(call.ArgumentList).toContain("-ExpectedDesiredModeIntentId");
      expect(call.ArgumentList).toContain("-Confirm:$false");
      expect(call.RedirectStandardOutput).toMatch(
        /deferred-handoff-worker-[0-9a-f]{32}\.stdout\.log$/u,
      );
      expect(call.RedirectStandardError).toMatch(
        /deferred-handoff-worker-[0-9a-f]{32}\.stderr\.log$/u,
      );

      const handoff = windowsScript("Invoke-CodexLocalRemoteOnDemandHandoff.ps1");
      expect(handoff).toContain("$claimWait.Elapsed -lt [TimeSpan]::FromSeconds(30)");
      expect(handoff).toContain("$worker.Kill()");
      expect(handoff).toContain("$worker.WaitForExit(5000)");
      const deferStart = handoff.indexOf("if ($decision -ceq 'defer-runtime-handoff')");
      const deferEnd = handoff.indexOf("-Status 'restart-deferred'", deferStart);
      const deferBlock = handoff.slice(deferStart, deferEnd);
      expect(deferBlock.indexOf("Set-OnDemandOpenDesiredRemote")).toBeGreaterThan(-1);
      expect(deferBlock.indexOf("Start-OnDemandDeferredRuntimeHandoff")).toBeGreaterThan(
        deferBlock.indexOf("Set-OnDemandOpenDesiredRemote"),
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("prepares exact task-bound infrastructure before the attach-only Desktop exit", () => {
    const handoff = windowsScript("Invoke-CodexLocalRemoteOnDemandHandoff.ps1");
    const permissionGate = handoff.lastIndexOf("'desktop-restart-authorization-required'");
    const exactTaskGate = handoff.indexOf("CurrentTaskDefinitionSha256");
    const preparation = handoff.lastIndexOf("Prepare-OnDemandSelectedRemoteRuntime `");
    const attachOnlyExit = handoff.lastIndexOf("Invoke-OnDemandPreparedAttach `");

    expect(handoff).toContain("[switch]$AllowDesktopRestart");
    expect(exactTaskGate).toBeGreaterThan(-1);
    expect(permissionGate).toBeGreaterThan(exactTaskGate);
    expect(preparation).toBeGreaterThan(exactTaskGate);
    expect(permissionGate).toBeGreaterThan(preparation);
    expect(attachOnlyExit).toBeGreaterThan(preparation);
    expect(handoff).toContain("Read-CodexLocalRemoteDesktopHandoffPreparation");
    expect(handoff).not.toContain("RequestDesktopLaunch");
    expect(handoff).not.toContain(".lnk");
  });

  it("routes preparation through the transactional runtime-generation activator", () => {
    const handoff = windowsScript("Invoke-CodexLocalRemoteOnDemandHandoff.ps1");
    const prepareStart = handoff.indexOf("function Prepare-OnDemandSelectedRemoteRuntime");
    const prepareEnd = handoff.indexOf("function Stop-OnDemandDesktopProcessGroup", prepareStart);
    const prepareBody = handoff.slice(prepareStart, prepareEnd);

    expect(handoff).toContain("Launch-CodexWithRemote.ps1");
    expect(handoff).toContain("Start-CodexLocalRemoteRegisteredTask");
    expect(prepareBody).toContain("Start-OnDemandSelectedRemoteRuntime `");
    expect(prepareBody).toContain("-DesktopHandoffPreparation $preparation");
    expect(handoff).not.toMatch(/\n\s*Start-ScheduledTask\s+`\s*\n\s*-TaskName \$TaskName/u);
  });

  it("restores native Desktop when an authorized Open fails after closing it", () => {
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        join(
          repositoryRoot,
          "tests",
          "windows",
          "fixtures",
          "on-demand-open-compensation-driver.ps1",
        ),
        "-ScriptPath",
        windowsPath("Invoke-CodexLocalRemoteOnDemandHandoff.ps1"),
      ],
      { encoding: "utf8" },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const receipt: unknown = JSON.parse(result.stdout);
    expect(receipt).toMatchObject({
      StartFailed: {
        Result: {
          Status: "native-restored",
          TaskStopped: false,
          DesktopRestored: true,
        },
        State: { NativeStartCalls: 1 },
      },
      VerifiedIdle: {
        Result: {
          Status: "native-restored",
          TaskStopped: true,
          DesktopRestored: true,
        },
        State: {
          TaskStopCalls: 1,
          TaskWaitCalls: 1,
          DrainCalls: 1,
          NativeStartCalls: 1,
        },
      },
      RunningNotReady: {
        Result: {
          Status: "remote-recovery-requested",
          RecoveryStatus: "running-generation-preserved",
          RecoveryReason: "readiness-not-verified-idle",
          TaskStopped: false,
          DesktopRestored: false,
          IntentId: "fixture-intent",
        },
        State: {
          TaskStopCalls: 0,
          IntentCalls: 1,
          NativeStartCalls: 0,
        },
      },
      UnknownClients: {
        Result: {
          Status: "remote-recovery-requested",
          RecoveryStatus: "running-generation-preserved",
          TaskStopped: false,
          DesktopRestored: false,
          IntentId: "fixture-intent",
        },
        State: {
          TaskStopCalls: 0,
          IntentCalls: 1,
          NativeStartCalls: 0,
        },
      },
      MissingCounts: {
        Result: {
          Status: "remote-recovery-requested",
          RecoveryStatus: "running-generation-preserved",
          TaskStopped: false,
          DesktopRestored: false,
          IntentId: "fixture-intent",
        },
        State: {
          TaskStopCalls: 0,
          IntentCalls: 1,
          NativeStartCalls: 0,
        },
      },
      LauncherFailed: {
        Result: {
          Status: "native-restored",
          TaskStopped: false,
          DesktopRestored: true,
        },
        State: { NativeStartCalls: 1 },
      },
      ActiveTurns: {
        Result: {
          Status: "remote-recovery-requested",
          RecoveryStatus: "running-generation-preserved",
          TaskStopped: false,
          DesktopRestored: false,
          IntentId: "fixture-intent",
        },
        State: {
          TaskStopCalls: 0,
          IntentCalls: 1,
          NativeStartCalls: 0,
        },
      },
      OuterCatch: {
        ErrorCaught: true,
        ErrorMessage: "fixture task state read failed after transactional activation",
        ErrorRecoveryStatus: "",
        ErrorRecoveryIntentId: "",
        DesiredMode: "Native",
        DesiredIntentId: "fixture-restored-native-intent",
        RestoreDesiredCalls: 1,
        TaskStartCalls: 0,
        SharedActivationCalls: 1,
        ActivationArgumentsValid: true,
        TaskStopCalls: 0,
        RecoveryIntentCalls: 0,
        DesktopClosed: false,
        PersistedStatus: "failed",
        PersistedStage: "handoff",
        PersistedCode: "control-operation-failed",
      },
      PriorRollback: {
        ErrorCaught: true,
        ErrorMessage: "fixture switch restored prior runtime then reported failure",
        ErrorRecoveryStatus: "",
        DesiredMode: "Native",
        DesiredUsesPrior: true,
        RecoveryIntentUsesPrior: false,
        RestoreDesiredCalls: 1,
        DesktopClosed: false,
        SharedActivationCalls: 1,
        PersistedStatus: "failed",
        PersistedStage: "handoff",
        PersistedCode: "control-operation-failed",
      },
      PointerDrift: {
        ErrorCaught: true,
        ErrorMessage:
          "The selected runtime changed after activation preflight; Desktop was preserved.",
        DesiredMode: "Native",
        RestoreDesiredCalls: 0,
        DesktopClosed: false,
        SharedActivationCalls: 0,
        PointerReadCalls: 2,
        PersistedStatus: "failed",
        PersistedStage: "handoff",
        PersistedCode: "control-operation-failed",
      },
    });
  });

  it("installs one stable DataDir dispatcher for Open, Close, and Status", () => {
    const module = windowsScript("CodexLocalRemote.Windows.psm1");
    const registration = windowsScript("Register-CodexLocalRemoteStartup.ps1");
    const dispatcher = windowsScript("CodexLocalRemote.Control.ps1");

    expect(module).toContain("function Install-CodexLocalRemoteControlDispatcher");
    expect(registration).toContain("Install-CodexLocalRemoteControlDispatcher");
    expect(dispatcher).toContain("# codex-local-remote/control-dispatcher/v1");
    expect(dispatcher).toContain("[ValidateSet('Open', 'Close', 'Status')]");
    expect(dispatcher).toContain("runtime-current.json");
    expect(dispatcher).toContain("runtime-manifest.json");
    expect(dispatcher).toContain("ComputeHash($stream)");
    expect(dispatcher).toContain("CurrentManifestSha256");
    expect(dispatcher).toContain(
      "The selected runtime manifest does not match the selected pointer.",
    );
    expect(dispatcher).toContain("Invoke-CodexLocalRemoteOnDemandHandoff.ps1");
    expect(dispatcher).toContain("-ExpectedSelectedVersionId");
    expect(dispatcher).toContain("-ExpectedSelectedRuntimeRoot");
    expect(dispatcher).toContain("-ExpectedSelectedManifestSha256");
    expect(dispatcher).toContain("-Operation Open");
    expect(dispatcher).toContain("-Operation Close");
    expect(dispatcher).toContain("-Operation Status");
    expect(dispatcher).toContain(
      "AllowDesktopRestart is valid only for an explicit Open operation.",
    );
    const closeCase = dispatcher.slice(
      dispatcher.indexOf("'Close' {"),
      dispatcher.indexOf("'Status' {"),
    );
    expect(closeCase).not.toContain("-AllowDesktopRestart");
    expect(dispatcher).not.toContain(repositoryRoot);
  });

  it("rechecks the dispatcher-selected runtime inside the operation mutex", () => {
    const handoff = windowsScript("Invoke-CodexLocalRemoteOnDemandHandoff.ps1");
    const mutexGate = handoff.indexOf("if (-not $controlMutexTaken)");
    const selectedRead = handoff.indexOf(
      "$runtime = Get-CodexLocalRemoteCurrentRuntime",
      mutexGate,
    );
    const driftGate = handoff.indexOf(
      "The selected runtime changed after dispatcher verification.",
      selectedRead,
    );

    expect(handoff).toContain("[string]$ExpectedSelectedVersionId");
    expect(handoff).toContain("[string]$ExpectedSelectedRuntimeRoot");
    expect(handoff).toContain("[string]$ExpectedSelectedManifestSha256");
    expect(selectedRead).toBeGreaterThan(mutexGate);
    expect(driftGate).toBeGreaterThan(selectedRead);
  });

  it("persists only a stable failure code and sanitized message", () => {
    const handoff = windowsScript("Invoke-CodexLocalRemoteOnDemandHandoff.ps1");
    const finalCatch = handoff.slice(
      handoff.indexOf("} catch {\n    $failure = $_"),
      handoff.lastIndexOf("} finally {"),
    );

    expect(handoff).toContain("Code = $Code");
    expect(finalCatch).toContain("'control-operation-failed'");
    expect(finalCatch).toContain("-Code $failureCode");
    expect(finalCatch).not.toContain("$failure.Exception.Message");
    expect(finalCatch).not.toContain("$remoteDesktopWasClosed");
  });

  it("makes already-installed runtime shortcuts native-only unless internally bound", () => {
    const launcher = windowsScript("Launch-CodexWithRemote.ps1");
    const main = launcher.slice(launcher.indexOf("if (-not $DefinitionOnly)"));
    const legacyGate = main.slice(
      main.indexOf("if (-not $DesktopOwnerExecution -and"),
      main.indexOf("if (-not $DesktopOwnerExecution) {", 100),
    );

    expect(legacyGate).toContain("$RequestDesktopLaunch");
    expect(legacyGate).toContain("$ExpectedSelectedRuntimeVersionId");
    expect(legacyGate).toContain("$ExpectedSelectedRuntimeRoot");
    expect(legacyGate).toContain("Invoke-CodexRequesterNativeFailOpen");
    expect(legacyGate).not.toContain("Start-ScheduledTask");
    expect(legacyGate).not.toContain("New-CodexDesktopOwnerIntent");
  });

  it("keeps shortcut feedback explicit, bounded, and detached from AI calls", () => {
    const dispatcher = windowsScript("CodexLocalRemote.Control.ps1");
    const registration = windowsScript("Register-CodexLocalRemoteStartup.ps1");
    const status = windowsScript("Get-CodexLocalRemoteStatus.ps1");
    const removal = windowsScript("Unregister-CodexLocalRemoteStartup.ps1");
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        join(repositoryRoot, "tests", "windows", "fixtures", "control-feedback-adapter-driver.ps1"),
        "-ControlPath",
        windowsPath("CodexLocalRemote.Control.ps1"),
      ],
      { encoding: "utf8" },
    );

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const feedback: unknown = JSON.parse(result.stdout);
    expect(feedback).toEqual({
      Count: 8,
      RepairedExact: true,
      PendingExact: true,
      RestartRequiredExact: true,
      NativeFallbackExact: true,
      FailedExact: true,
      NativeExact: true,
      AlreadyNativeExact: true,
      NativePendingDesktopExitExact: true,
    });
    expect(dispatcher).toContain("[switch]$InteractiveShortcutFeedback");
    expect(dispatcher).toContain("$shell.Popup($message, 4, $title, 64)");
    expect(dispatcher).toContain("Show-ControlNotification");
    for (const definition of [registration, status, removal]) {
      expect(definition).toContain("'-InteractiveShortcutFeedback'");
    }
    const closeCase = dispatcher.slice(
      dispatcher.indexOf("'Close' {"),
      dispatcher.indexOf("'Status' {"),
    );
    expect(closeCase).not.toContain("-InteractiveShortcutFeedback");
  });

  it("atomically reuses its dispatcher and refuses a foreign target", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "codex-control-dispatcher-"));
    try {
      const result = spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          join(
            repositoryRoot,
            "tests",
            "windows",
            "fixtures",
            "control-dispatcher-install-driver.ps1",
          ),
          "-ModulePath",
          windowsPath("CodexLocalRemote.Windows.psm1"),
          "-SourcePath",
          windowsPath("CodexLocalRemote.Control.ps1"),
          "-SandboxRoot",
          sandbox,
        ],
        { encoding: "utf8" },
      );

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        Created: "created",
        Reused: "reused",
        ForeignBlocked: true,
        MarkerOnlyBlocked: true,
        Removed: "removed",
        RemovedAgain: "not-found",
      });
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });

  it("preflights the exact dispatcher receipt before install or uninstall mutations", () => {
    const module = windowsScript("CodexLocalRemote.Windows.psm1");
    const registration = windowsScript("Register-CodexLocalRemoteStartup.ps1");
    const removal = windowsScript("Unregister-CodexLocalRemoteStartup.ps1");

    expect(module).toContain("codex-local-remote/control-dispatcher-receipt/v1");
    expect(module).toContain("Invoke-WithCodexLocalRemoteControlDispatcherMutex");
    expect(module).toContain("function Remove-CodexLocalRemoteControlDispatcher");
    expect(registration).toContain("Get-CodexLocalRemoteControlDispatcherState");
    expect(registration.indexOf("Get-CodexLocalRemoteControlDispatcherState")).toBeLessThan(
      registration.indexOf("$action = New-ScheduledTaskAction"),
    );
    expect(removal).toContain("Get-CodexLocalRemoteControlDispatcherState");
    expect(removal).toContain("Remove-CodexLocalRemoteControlDispatcher");
    expect(removal.indexOf("Get-CodexLocalRemoteControlDispatcherState")).toBeLessThan(
      removal.indexOf("Stop-ScheduledTask"),
    );
    expect(removal.indexOf("Remove-CodexLocalRemoteControlDispatcher")).toBeGreaterThan(
      removal.lastIndexOf("Remove-BrokerCapabilityToken"),
    );
  });

  it("closes only the public Sidecar and lets Desktop exit naturally", () => {
    const close = windowsScript("Invoke-CodexLocalRemoteOnDemandHandoff.ps1");
    const closeStart = close.indexOf("if ($Operation -ceq 'Close')");
    const closeEnd = close.indexOf("if ($decision -ceq 'remote-lease-active')", closeStart);
    const closeBlock = close.slice(closeStart, closeEnd);

    expect(close).toContain("[switch]$AllowDesktopRestart");
    expect(close).toContain("'already-native'");
    expect(closeBlock).toContain("Set-CodexLocalRemoteDesiredMode");
    expect(closeBlock).toContain("-Mode Native");
    expect(closeBlock).toContain("'native-pending-desktop-exit'");
    expect(closeBlock).not.toContain("Stop-ScheduledTask");
    expect(closeBlock).not.toContain("CloseMainWindow");
    expect(closeBlock).not.toContain("Start-OnDemandNativeDesktop");
    expect(closeBlock).toContain("Broker remain untouched until Desktop exits naturally.");
  });

  it("keeps Status read-only and validates the active Broker independently of selected Sidecar", () => {
    const handoff = windowsScript("Invoke-CodexLocalRemoteOnDemandHandoff.ps1");
    const statusStart = handoff.indexOf("if ($Operation -ceq 'Status')");
    const statusEnd = handoff.indexOf("if ($Operation -ceq 'Close')", statusStart);
    const status = handoff.slice(statusStart, statusEnd);

    expect(status).not.toContain("Write-OnDemandHandoffStatus");
    expect(handoff).toContain("$activeBrokerRuntimeRoot");
    expect(handoff).toContain("$activeBrokerVersionId");
    expect(handoff).toContain("Test-CodexLocalRemoteRuntimeVersion");
    expect(handoff).not.toContain("$expectedBrokerCli");
  });
});
