import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(import.meta.dirname, "..", "..");
const windowsScript = (name: string) =>
  readFileSync(join(repositoryRoot, "scripts", "windows", name), "utf8");
const takeoverSafetyDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "desktop-takeover-safety-driver.ps1",
);

describe("Windows Desktop Owner Coordinator v5", () => {
  it("makes the V5 startup task the only Desktop process owner", () => {
    const module = windowsScript("CodexLocalRemote.Windows.psm1");
    const registration = windowsScript("Register-CodexLocalRemoteStartup.ps1");
    const startup = windowsScript("Start-CodexLocalRemote.ps1");
    const shortcutStart = registration.indexOf("function Get-ManagedLauncherShortcutDefinition");
    const shortcutEnd = registration.indexOf("\nfunction ", shortcutStart + 10);
    const shortcutDefinition = registration.slice(shortcutStart, shortcutEnd);

    expect(module).toContain("codex-local-remote/startup-task/v5");
    expect(module).toContain("'-DesktopOwnerCoordinator'");
    expect(module).toContain("'-TakeOverExistingNativeDesktop'");
    expect(shortcutDefinition).toContain("Get-CodexLocalRemoteControlDispatcherPath");
    expect(shortcutDefinition).toContain("'-Operation'");
    expect(shortcutDefinition).toContain("'Open'");
    expect(shortcutDefinition).toContain("'-AllowDesktopRestart'");
    expect(shortcutDefinition).toContain("'-RequestDesktopLaunch'");
    expect(shortcutDefinition).not.toContain("'-TakeOverExistingNativeDesktop'");
    expect(startup).toContain("[switch]$DesktopOwnerCoordinator");
    expect(startup).toContain("-DesktopOwnerExecution");
  });

  it("uses a generation-bound idempotent intent and one owner mutex", () => {
    const module = windowsScript("CodexLocalRemote.Windows.psm1");
    const launcher = windowsScript("Launch-CodexWithRemote.ps1");
    const startup = windowsScript("Start-CodexLocalRemote.ps1");

    expect(module).toContain("function New-CodexDesktopOwnerIntent");
    expect(module).toContain("TargetRuntimeVersionId");
    expect(module).toContain("TargetRuntimeRoot");
    expect(module).toContain("function Invoke-WithCodexDesktopOwnerMutex");
    expect(module).toContain("function New-CodexDesktopOwnerIntentUnderOwnerLock");
    expect(module).toContain("function Complete-CodexDesktopOwnerIntentUnderOwnerLock");
    const completeStart = module.indexOf("function Complete-CodexDesktopOwnerIntent");
    const completeUnderLockStart = module.indexOf(
      "function Complete-CodexDesktopOwnerIntentUnderOwnerLock",
    );
    const complete = module.slice(completeStart, completeUnderLockStart);
    expect(complete).toContain("Invoke-WithCodexDesktopOwnerMutex");
    expect(launcher).toContain("[switch]$RequestDesktopLaunch");
    expect(launcher).toContain("New-CodexDesktopOwnerIntentUnderOwnerLock");
    expect(launcher).toContain("Wait-CodexDesktopOwnerRequestAcknowledgement");
    expect(launcher).toContain("Invoke-CodexRequesterNativeFailOpen");
    expect(launcher).toContain("'requester-timeout-cancelled'");
    expect(startup).toContain("Read-CodexDesktopOwnerIntent");
    expect(startup).toContain("Complete-CodexDesktopOwnerIntent");
    expect(startup).toContain("Invoke-WithCodexDesktopOwnerMutex");
  });

  it("does not use an absent Desktop as an unconditional recovery trigger", () => {
    const startup = windowsScript("Start-CodexLocalRemote.ps1");

    expect(startup).toContain("Get-CodexDesktopOwnerDecision");
    expect(startup).not.toMatch(
      /\$desktopRecoveryAllowed\s*=\s*\(\s*\$desktopRootProcesses\.Count -eq 0/u,
    );
    expect(startup).toContain("$desktopOwnerState.StartupIntentPending = $false");
    expect(startup).toContain("$desktopOwnerState.LastAttemptedRootIdentityKey");
  });

  it("keeps V3 and headless V4 as activation-required legacy contracts", () => {
    const module = windowsScript("CodexLocalRemote.Windows.psm1");
    const launcher = windowsScript("Launch-CodexWithRemote.ps1");

    expect(module).toContain("Contract = 'desktop-owner-v5'");
    expect(module).toContain("Contract = 'headless-v4'");
    expect(module).toContain("Contract = 'desktop-owner-v3'");
    expect(launcher).toContain("'headless-v4'");
    expect(launcher).toContain("'desktop-owner-v3'");
    expect(launcher).toContain("Status = 'activation-required'");
  });

  it("marks every running managed upgrade pending when registration does not request a start", () => {
    const registration = windowsScript("Register-CodexLocalRemoteStartup.ps1");
    const start = registration.indexOf("if ($ownership.Kind -cne 'current')");
    const end = registration.indexOf("$null = Set-CodexLocalRemoteManagedConfiguration", start);
    const upgrade = registration.slice(start, end);

    expect(upgrade).toContain("[string]$previousTask.State -ceq 'Running' -and");
    expect(upgrade).toContain("-not $startAfterRegistration");
    expect(upgrade).toContain("'pending-live-bootstrap-restart'");
    expect(upgrade).not.toContain("$ownership.Kind -cin");
  });

  it("coalesces duplicate intents and never retries an unchanged native root", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "codex-owner-v5-"));
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
            "desktop-owner-coordinator-driver.ps1",
          ),
          "-ModulePath",
          join(repositoryRoot, "scripts", "windows", "CodexLocalRemote.Windows.psm1"),
          "-SandboxRoot",
          sandbox,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const receipt = JSON.parse(result.stdout) as {
        FirstIntentId: string;
        SecondIntentId: string;
        ReadIntentId: string;
        IntentRemoved: boolean;
        ReceiptExists: boolean;
        ExpiredIntentRemoved: boolean;
        ExpiredReceiptOutcome: string;
        FutureIntentRemoved: boolean;
        FutureReceiptOutcome: string;
        InvalidIntentRemoved: boolean;
        InvalidReceiptOutcome: string;
        Freshness: Record<string, string>;
        ConnectedProofs: Record<string, boolean>;
        Decisions: Record<string, string>;
        ResumeGap: Record<string, boolean>;
      };
      expect(receipt.FirstIntentId).toBe(receipt.SecondIntentId);
      expect(receipt.ReadIntentId).toBe(receipt.SecondIntentId);
      expect(receipt.IntentRemoved).toBe(true);
      expect(receipt.ReceiptExists).toBe(true);
      expect(receipt.ExpiredIntentRemoved).toBe(true);
      expect(receipt.ExpiredReceiptOutcome).toBe("expired");
      expect(receipt.FutureIntentRemoved).toBe(true);
      expect(receipt.FutureReceiptOutcome).toBe("future");
      expect(receipt.InvalidIntentRemoved).toBe(true);
      expect(receipt.InvalidReceiptOutcome).toBe("invalid");
      expect(receipt.Freshness).toEqual({
        Fresh: "fresh",
        Expired: "expired",
        Future: "future",
        Invalid: "invalid",
      });
      expect(receipt.ConnectedProofs).toEqual({
        Complete: true,
        ArbitraryNonce: false,
        MissingNonce: false,
        CountMismatch: false,
        RuntimeMismatch: false,
        UnknownClient: false,
        MissingRoot: false,
        EmptyRoot: false,
        Persisted: true,
        PersistedEmptyRoot: false,
        ProofRuntimeMismatch: false,
        ProofRootMismatch: false,
      });
      expect(receipt.Decisions).toEqual({
        Startup: "launch-intent",
        Intent: "launch-intent",
        NativeFirst: "idle",
        NativeRepeated: "idle",
        UserClosed: "idle",
        Connected: "idle-connected",
        BridgeThenNative: "idle",
        SameRootDisconnectedOnce: "idle",
        SameRootDisconnectedRepeated: "idle",
        FallbackRootRepeated: "idle",
        ResumeSuppressed: "idle",
        PackageChanged: "idle",
        ExplicitIntentAfterResume: "launch-intent",
      });
      expect(receipt.ResumeGap).toEqual({
        OrdinaryLoop: false,
        SleepResume: true,
      });
    } finally {
      rmSync(sandbox, { force: true, recursive: true });
    }
  });

  it("requires a current nonce-bound Desktop proof before suppressing native takeover", () => {
    const module = windowsScript("CodexLocalRemote.Windows.psm1");
    const startup = windowsScript("Start-CodexLocalRemote.ps1");

    expect(module).toContain("function Test-CodexDesktopOwnerConnectedProof");
    expect(module).toContain("function Write-CodexDesktopOwnerConnectionProof");
    expect(module).toContain("ExpectedLaunchNonceDigest");
    expect(startup).toContain("Get-VerifiedBrokerRuntimeSnapshot");
    expect(startup).toContain("Read-CodexDesktopOwnerConnectionProof");
    expect(startup).toContain("Test-CodexDesktopOwnerConnectionProof");
    expect(startup).toContain("$finalDesktopRootIdentityKey");
    expect(startup).toContain("$desktopOwnerState.PendingFinalRootCapture");
    expect(startup).not.toMatch(
      /\$desktopConnected\s*=\s*\(\s*\$null -ne \$desktopRecoveryReadiness[\s\S]{0,180}\[bool\]\$desktopRecoveryReadiness\.desktopConnected/u,
    );
  });

  it("expires delayed intents instead of launching after the user has exited", () => {
    const module = windowsScript("CodexLocalRemote.Windows.psm1");
    const startup = windowsScript("Start-CodexLocalRemote.ps1");

    expect(module).toContain("function Get-CodexDesktopOwnerIntentFreshnessDecision");
    expect(module).toContain("[int]$MaximumAgeSeconds = 120");
    expect(module).toContain("Freshness");
    expect(startup).toContain("-Outcome $intentFreshness");
  });

  it.each([
    ["safe", true, 2],
    ["active-managed-turns", true, 2],
    ["cim-unknown", false, 1],
    ["reconnect-final", false, 2],
    ["runtime-drift-final", false, 2],
  ])(
    "uses a consecutive strict takeover safety window in %s",
    (mode, expectedSuccess, expectedObservations) => {
      const result = spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          takeoverSafetyDriverPath,
          "-StartPath",
          join(repositoryRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1"),
          "-Mode",
          mode,
        ],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const receipt = JSON.parse(result.stdout) as {
        Succeeded: boolean;
        Error: string;
        Observations: number;
        StopCalls: number;
        LaunchCalls: number;
      };
      expect(receipt.Succeeded).toBe(expectedSuccess);
      expect(receipt.Observations).toBe(expectedObservations);
      expect(receipt.StopCalls).toBe(expectedSuccess ? 1 : 0);
      expect(receipt.LaunchCalls).toBe(expectedSuccess ? 1 : 0);
    },
  );

  it.each([
    ["safe", true],
    ["active-managed-turns", true],
    ["reconnect-late", false],
  ])("uses a bounded three-second recovery window in %s", (mode, expectedSuccess) => {
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        takeoverSafetyDriverPath,
        "-StartPath",
        join(repositoryRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1"),
        "-Mode",
        mode,
        "-RequiredObservations",
        "4",
        "-GraceMilliseconds",
        "1000",
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const receipt = JSON.parse(result.stdout) as {
      Succeeded: boolean;
      Observations: number;
      StopCalls: number;
      LaunchCalls: number;
      SleepCalls: number;
      SleepMilliseconds: number;
    };
    expect(receipt).toMatchObject({
      Succeeded: expectedSuccess,
      Observations: 4,
      StopCalls: expectedSuccess ? 1 : 0,
      LaunchCalls: expectedSuccess ? 1 : 0,
      SleepCalls: 3,
      SleepMilliseconds: 3000,
    });
  });

  it("uses the longer bounded safety window only for disconnected-root recovery", () => {
    const startup = windowsScript("Start-CodexLocalRemote.ps1");
    const attempted = startup.indexOf("$desktopRecoveryLaunchAttempted = $true");
    const safetyCall = startup.lastIndexOf(
      "Assert-CodexDesktopOwnerTakeoverSafetyWindow",
      attempted,
    );
    const safety = startup.slice(safetyCall, attempted);

    expect(safety).toContain("-RequiredObservations");
    expect(safety).toContain("-GraceMilliseconds");
    expect(safety).toContain("'recover-disconnected-root'");
    expect(safety).toContain("{ 4 } else { 2 }");
    expect(safety).toContain("{ 1000 } else { 150 }");
  });

  it("keeps active managed turns on the Broker while reconnecting only Desktop", () => {
    const startup = windowsScript("Start-CodexLocalRemote.ps1");
    const safetyStart = startup.indexOf("function Assert-CodexDesktopOwnerTakeoverSafetyWindow");
    const safetyEnd = startup.indexOf(
      "\nfunction Get-UniqueCodexDesktopRootIdentityKey",
      safetyStart,
    );
    const safety = startup.slice(safetyStart, safetyEnd);
    const launcher = windowsScript("Launch-CodexWithRemote.ps1");

    expect(safety).not.toContain("[decimal]$readiness.unsafeThreadCount -ne 0");
    expect(safety).toContain("[bool]$readiness.desktopConnected");
    expect(safety).not.toContain("Stop-CodexAppServerBroker");
    const takeoverStart = launcher.indexOf("function Test-CodexDesktopTakeoverSafetySnapshot");
    const takeoverEnd = launcher.indexOf("\nfunction ", takeoverStart + 10);
    expect(launcher.slice(takeoverStart, takeoverEnd)).not.toContain("unsafeThreadCount");
    expect(launcher).toContain("[decimal]$Readiness.unsafeThreadCount -eq 0");
  });

  it("separates ordinary crash recovery from resume and package-update takeover", () => {
    const module = windowsScript("CodexLocalRemote.Windows.psm1");
    const startup = windowsScript("Start-CodexLocalRemote.ps1");

    expect(module).toContain("[bool]$AutomaticTakeoverAllowed = $false");
    expect(module).not.toContain("return 'takeover-new-native-root'");
    expect(module).not.toContain("return 'recover-disconnected-root'");
    expect(module).toContain("[bool]$RuntimeGenerationCurrent = $true");
    expect(module).toContain("function Test-CodexDesktopOwnerResumeGap");
    expect(startup).toContain("$desktopOwnerResumeSuppressedAtUtc");
    expect(startup).toContain("$DesktopOwnerResumeGapSeconds");
    expect(startup).toContain("-AutomaticTakeoverAllowed");
    expect(startup).toContain("-RuntimeGenerationCurrent");
    expect(startup).toContain("Test-DesktopRuntimeIdentityCurrent");
    expect(startup).toContain("'resume-suppressed'");
    expect(startup).toContain("'package-update-suppressed'");
  });

  it("backs off before recording a failed destructive attempt when takeover safety is unknown", () => {
    const startup = windowsScript("Start-CodexLocalRemote.ps1");
    const attempted = startup.indexOf("$desktopRecoveryLaunchAttempted = $true");
    const safety = startup.lastIndexOf("Assert-CodexDesktopOwnerTakeoverSafetyWindow", attempted);
    const launch = startup.indexOf("$desktopRecoveryLaunch =", attempted);
    const catchStart = startup.indexOf("} catch {", launch);

    expect(safety).toBeGreaterThan(-1);
    expect(attempted).toBeGreaterThan(safety);
    expect(launch).toBeGreaterThan(attempted);
    expect(catchStart).toBeGreaterThan(launch);
    expect(startup.slice(catchStart, catchStart + 1200)).toContain(
      "if ($desktopRecoveryLaunchAttempted)",
    );
  });
});
