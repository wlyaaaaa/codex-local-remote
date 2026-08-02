import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const launcherPath = join(repositoryRoot, "scripts", "windows", "Launch-CodexWithRemote.ps1");
const startupPath = join(repositoryRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1");
const driverPath = join(import.meta.dirname, "fixtures", "desktop-fail-open-launcher-driver.ps1");
const receiptDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "desktop-launch-receipt-driver.ps1",
);
const environmentDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "desktop-process-environment-driver.ps1",
);
const splitTokenDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "desktop-split-token-launch-driver.ps1",
);
const requesterFallbackDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "desktop-requester-fallback-driver.ps1",
);

interface FixtureResult {
  Result: {
    Status: string;
    RemoteEnabled: boolean | null;
    RemoteDecision: string;
    RemoteFallbackAttempts: number;
    RemoteStopAttempts: number;
    DesktopProcessId: number;
    CorrelationId: string;
  };
  Feedback: {
    Kind: "connected" | "already-running" | "degraded";
    Title: string;
    Message: string;
  };
  State: {
    HealthChecks: number;
    RemoteStartCalls: number;
    DesktopLaunchCalls: number;
    CreatedProcessChecks: number;
    ProcessHandleChecks: number;
    RunningDesktopChecks: number;
    StopCalls: number;
    ExistingDesktopStopped: boolean;
    ChildOverridePresent: boolean;
    ChildOverride: string | null;
    LaunchOverrides: Array<string | null>;
    LaunchOverrideNoncePresent: boolean[];
    RemoteLaunchNonceDigest: string | null;
    PostLaunchHealthChecks: number;
  };
  ParentOverride: string;
  OriginalOverride: string;
  CapabilityEndpoint: string;
}

function runFixture(mode: string, launchCorrelationId = ""): FixtureResult {
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
      "-Mode",
      mode,
      ...(launchCorrelationId === "" ? [] : ["-LaunchCorrelationId", launchCorrelationId]),
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as FixtureResult;
}

function runEnvironmentFixture() {
  const result = spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      environmentDriverPath,
      "-LauncherPath",
      launcherPath,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as {
    RemoteChildOverride: string;
    NativeChildOverride: string;
    ParentOverride: string;
    OriginalOverride: string;
    CapabilityEndpoint: string;
  };
}

function runSplitTokenFixture() {
  const result = spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      splitTokenDriverPath,
      "-LauncherPath",
      launcherPath,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as {
    SelectedProcessId: number;
    RemoteExactCount: number;
    RemoteStaleCount: number;
    RemotePathCount: number;
    NativeOverrideCount: number;
    RemoteCleared: boolean;
    NativeCleared: boolean;
    MalformedFailedClosed: boolean;
    MalformedSourceCleared: boolean;
    SplitTokenCalls: Array<{
      ExecutablePath: string;
      Endpoint: string | null;
      ArgumentCount: number;
    }>;
  };
}

function runReceiptFixture(): Record<string, unknown> {
  const result = spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      receiptDriverPath,
      "-LauncherPath",
      launcherPath,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function runRequesterFallbackFixture(mode: string) {
  const result = spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      requesterFallbackDriverPath,
      "-LauncherPath",
      launcherPath,
      "-Mode",
      mode,
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as {
    Result: {
      Status: string;
      RemoteDecision: string;
      RemoteFailureStage: string;
      RemoteFailureCode: string;
    };
    NativeLaunchCalls: number;
    RootChecks: number;
    MutexNameMatchesModule: boolean;
  };
}

windowsOnly("Codex Desktop fail-open launcher", () => {
  it("preserves a valid external launch correlation identity", () => {
    const intentId = "0123456789abcdef0123456789abcdef";
    const receipt = runFixture("ready", intentId);

    expect(receipt.Result.CorrelationId).toBe(intentId);
  });

  it("does not launch native when the coordination module is missing but the existing owner holds the mutex", () => {
    const receipt = runRequesterFallbackFixture("module-missing-owner-mutex-held");

    expect(receipt.NativeLaunchCalls).toBe(0);
    expect(receipt.RootChecks).toBe(0);
    expect(receipt.MutexNameMatchesModule).toBe(true);
    expect(receipt.Result).toMatchObject({
      Status: "remote-launch-unverified",
      RemoteDecision: "existing-desktop-takeover-state-drifted",
      RemoteFailureStage: "runtime-handoff",
      RemoteFailureCode: "handoff-timeout",
    });
  });

  it("rechecks the exact Desktop root after acquiring the owner mutex and preserves it", () => {
    const receipt = runRequesterFallbackFixture("root-appears-before-fallback");

    expect(receipt.NativeLaunchCalls).toBe(0);
    expect(receipt.RootChecks).toBe(1);
    expect(receipt.MutexNameMatchesModule).toBe(true);
    expect(receipt.Result).toMatchObject({
      Status: "remote-launch-unverified",
      RemoteDecision: "existing-desktop-takeover-state-drifted",
      RemoteFailureStage: "runtime-handoff",
      RemoteFailureCode: "handoff-timeout",
    });
  });

  it("shows the first cold-start result and the next successful automatic recovery without failure spam", () => {
    const startup = readFileSync(startupPath, "utf8");
    const functionStart = startup.indexOf("function Invoke-ManagedDesktopLaunch");
    const functionEnd = startup.indexOf(
      "\nfunction Get-RunningCodexDesktopRootProcesses",
      functionStart,
    );
    const launchFunction = startup.slice(functionStart, functionEnd);

    expect(launchFunction).toContain("[switch]$SuppressFeedback");
    expect(launchFunction).toContain("[switch]$NotifyOnRemoteSuccessOnly");
    expect(launchFunction).toContain("-NotifyOnRemoteSuccessOnly:$NotifyOnRemoteSuccessOnly");
    expect(startup).toMatch(/Invoke-ManagedDesktopLaunch `\r?\n\s+-NotifyOnRemoteSuccessOnly/);
    expect(startup).not.toContain("Invoke-ManagedDesktopLaunch -SuppressFeedback");

    const launcher = readFileSync(launcherPath, "utf8");
    expect(launcher).toContain("[switch]$NotifyOnRemoteSuccessOnly");
    expect(launcher).toContain("if ($SuppressNotification)");
    expect(launcher).toContain(
      "$NotifyOnRemoteSuccessOnly -and\n" +
        "        [string]$launchResult.Status -cne 'launched-remote'",
    );
    expect(launcher).toContain("$launchResult.FeedbackStatus = 'filtered'");
  });

  it("preserves an existing owner proof when a launch observation is inconclusive", () => {
    const launcher = readFileSync(launcherPath, "utf8");

    expect(launcher).not.toContain("if (-not [bool]$launchResult.RemoteEnabled)");
    expect(launcher).toContain("if ([string]$launchResult.Status -ceq 'launched-native')");
  });

  it("serializes every owner-proof write and removal with the Desktop owner mutex", () => {
    const launcher = readFileSync(launcherPath, "utf8");
    const blockStart = launcher.lastIndexOf(
      "if ($script:WindowsModuleAvailable)",
      launcher.indexOf("$connectionProofProperty ="),
    );
    const blockEnd = launcher.indexOf(
      "if ($script:WindowsModuleAvailable)",
      launcher.indexOf("Remove-CodexDesktopOwnerConnectionProof", blockStart),
    );
    const proofBlock = launcher.slice(blockStart, blockEnd);
    const writeStart = proofBlock.indexOf("Write-CodexDesktopOwnerConnectionProof");
    const writeMutex = proofBlock.lastIndexOf("Invoke-WithCodexDesktopOwnerMutex", writeStart);
    const removeStart = proofBlock.indexOf("Remove-CodexDesktopOwnerConnectionProof");
    const removeMutex = proofBlock.lastIndexOf("Invoke-WithCodexDesktopOwnerMutex", removeStart);

    expect(blockStart).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(blockStart);
    expect(writeStart).toBeGreaterThan(-1);
    expect(writeMutex).toBeGreaterThan(-1);
    expect(removeStart).toBeGreaterThan(writeStart);
    expect(removeMutex).toBeGreaterThan(writeStart);
  });

  it("renders one compact auto-dismiss receipt without relying on a suppressible tray balloon", () => {
    const launcher = readFileSync(launcherPath, "utf8");
    const start = launcher.indexOf("function Show-CodexRemoteLaunchFeedback");
    const end = launcher.indexOf("\nfunction Invoke-CodexDesktopFailOpenLaunch", start);
    const feedback = launcher.slice(start, end);

    expect(feedback).toContain("[System.Windows.Forms.Form]::new()");
    expect(feedback).toContain("$form.ShowInTaskbar = $false");
    expect(feedback).toContain("$form.TopMost = $true");
    expect(feedback).toContain("[System.Drawing.Icon]::new(");
    expect(feedback).toContain("[System.Windows.Forms.PictureBox]::new()");
    expect(feedback).toContain("$picture.AccessibleName = 'ChatGPT'");
    expect(feedback).toContain("$form.Show()");
    expect(feedback).toContain("ShowWindow($form.Handle, 4)");
    expect(feedback).toContain("[System.Windows.Forms.Application]::DoEvents()");
    expect(feedback).not.toContain("[System.Windows.Forms.NotifyIcon]::new()");
    expect(launcher).toContain("-IconPath (Join-Path $resolvedDataDir 'managed-chatgpt.ico')");
  });

  it("launches native Desktop without an override when port 18791 is unavailable", () => {
    const receipt = runFixture("port-refused");

    expect(receipt.Result).toMatchObject({
      Status: "launched-native",
      RemoteEnabled: false,
      RemoteDecision: "remote-not-ready",
      DesktopProcessId: 42002,
    });
    expect(receipt.Feedback).toMatchObject({
      Kind: "degraded",
      Title: "远程启动失败",
      Message: "远程未连接，ChatGPT 已按原生模式启动。",
    });
    expect(receipt.State.HealthChecks).toBeGreaterThanOrEqual(2);
    expect(receipt.State.RemoteStartCalls).toBe(1);
    expect(receipt.State.DesktopLaunchCalls).toBe(1);
    expect(receipt.State.ChildOverridePresent).toBe(false);
    expect(receipt.State.ChildOverride).toBeNull();
    expect(receipt.ParentOverride).toBe(receipt.OriginalOverride);
  });

  it("injects the capability endpoint only when infrastructure is ready", () => {
    const receipt = runFixture("ready");

    expect(receipt.Result).toMatchObject({
      Status: "launched-remote",
      RemoteEnabled: true,
      RemoteDecision: "remote-attached",
      RemoteFallbackAttempts: 0,
      RemoteStopAttempts: 0,
      DesktopProcessId: 42002,
    });
    expect(receipt.Feedback).toMatchObject({
      Kind: "connected",
      Title: "ChatGPT 已启动",
      Message: "远程已连接，可以从手机继续使用。",
    });
    expect(receipt.State.RemoteStartCalls).toBe(0);
    expect(receipt.State.DesktopLaunchCalls).toBe(1);
    expect(receipt.State.ChildOverridePresent).toBe(true);
    expect(receipt.State.ChildOverride).toBe(receipt.CapabilityEndpoint);
    expect(receipt.State.LaunchOverrideNoncePresent).toEqual([true]);
    expect(receipt.State.RemoteLaunchNonceDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.ParentOverride).toBe(receipt.OriginalOverride);
  });

  it("does not treat a broker role without a launch nonce or GUI root as an existing Desktop", () => {
    const receipt = runFixture("connected-without-root-no-nonce");

    expect(receipt.Result.RemoteDecision).not.toBe("broker-reports-desktop-connected");
    expect(receipt.State.DesktopLaunchCalls).toBeGreaterThanOrEqual(1);
    expect(receipt.State.LaunchOverrides[0]).toBe(receipt.CapabilityEndpoint);
  });

  it("preserves a proven same-root existing remote Desktop", () => {
    const receipt = runFixture("already-running-proven-remote");

    expect(receipt.Result).toMatchObject({
      Status: "already-running",
      RemoteEnabled: true,
      RemoteDecision: "broker-reports-desktop-connected",
      RemoteFallbackAttempts: 0,
      RemoteStopAttempts: 0,
      DesktopProcessId: 42001,
    });
    expect(receipt.State.DesktopLaunchCalls).toBe(0);
  });

  it("does not let an arbitrary bridge nonce suppress exact managed takeover", () => {
    const receipt = runFixture("already-running-arbitrary-bridge");

    expect(receipt.Result.RemoteDecision).not.toBe("broker-reports-desktop-connected");
    expect(receipt.State.StopCalls).toBeGreaterThanOrEqual(1);
    expect(receipt.State.DesktopLaunchCalls).toBeGreaterThanOrEqual(1);
  });

  it("fails closed when a different Desktop root appears before attach is accepted", () => {
    const receipt = runFixture("attach-other-root");

    expect(receipt.Result).toMatchObject({
      Status: "remote-launch-unverified",
      RemoteEnabled: false,
      RemoteDecision: "remote-attached-root-process-set-unverified",
      RemoteFallbackAttempts: 0,
      RemoteStopAttempts: 0,
      DesktopProcessId: 42002,
    });
    expect(receipt.State.RunningDesktopChecks).toBeGreaterThanOrEqual(2);
    expect(receipt.State.DesktopLaunchCalls).toBe(1);
    expect(receipt.State.StopCalls).toBe(0);
    expect(receipt.State.LaunchOverrides).toEqual([receipt.CapabilityEndpoint]);
  });

  it("does not attribute a foreign Desktop renderer after its root disappeared to the launched root", () => {
    const receipt = runFixture("attach-foreign-root-gone");

    expect(receipt.Result).toMatchObject({
      Status: "launched-native",
      RemoteEnabled: false,
      RemoteDecision: "remote-broker-lost-before-attach",
      RemoteFallbackAttempts: 1,
      RemoteStopAttempts: 1,
      DesktopProcessId: 42003,
    });
    expect(receipt.State.RunningDesktopChecks).toBeGreaterThanOrEqual(1);
    expect(receipt.State.DesktopLaunchCalls).toBe(2);
    expect(receipt.State.StopCalls).toBe(1);
    expect(receipt.State.LaunchOverrides).toEqual([receipt.CapabilityEndpoint, null]);
    expect(receipt.State.LaunchOverrideNoncePresent).toEqual([true, false]);
  });

  it.each(["attach-nonce-mismatch", "attach-nonce-missing", "attach-nonce-malformed-shape"])(
    "fails closed when attach identity is %s",
    (mode) => {
      const receipt = runFixture(mode);

      expect(receipt.Result).toMatchObject({
        Status: "launched-native",
        RemoteEnabled: false,
        RemoteDecision: "remote-broker-lost-before-attach",
        RemoteFallbackAttempts: 1,
        RemoteStopAttempts: 1,
        DesktopProcessId: 42003,
      });
      expect(receipt.State.DesktopLaunchCalls).toBe(2);
      expect(receipt.State.StopCalls).toBe(1);
    },
  );

  it("accepts multiple initialized Desktop connections only when every one belongs to this launch", () => {
    const own = runFixture("attach-multiple-all-own");
    const mixedForeign = runFixture("attach-multiple-foreign");
    const mixedLegacy = runFixture("attach-multiple-legacy");

    expect(own.Result).toMatchObject({
      Status: "launched-remote",
      RemoteEnabled: true,
      RemoteDecision: "remote-attached",
      RemoteFallbackAttempts: 0,
      RemoteStopAttempts: 0,
    });
    expect(own.State.PostLaunchHealthChecks).toBeGreaterThanOrEqual(2);
    for (const mixed of [mixedForeign, mixedLegacy]) {
      expect(mixed.Result).toMatchObject({
        Status: "launched-native",
        RemoteEnabled: false,
        RemoteDecision: "remote-broker-lost-before-attach",
        RemoteFallbackAttempts: 1,
        RemoteStopAttempts: 1,
      });
    }
  });

  it("requires consecutive own-launch observations and preserves the process after an observed attach disconnects", () => {
    const receipt = runFixture("attach-disconnect");

    expect(receipt.Result).toMatchObject({
      Status: "remote-launch-unverified",
      RemoteEnabled: false,
      RemoteDecision: "remote-attached-then-unverified-process-preserved",
      RemoteFallbackAttempts: 0,
      RemoteStopAttempts: 0,
      DesktopProcessId: 42002,
    });
    expect(receipt.State.PostLaunchHealthChecks).toBeGreaterThanOrEqual(2);
    expect(receipt.State.DesktopLaunchCalls).toBe(1);
    expect(receipt.State.StopCalls).toBe(0);
  });

  it.each(["attach-runtime-invocation-drift", "attach-runtime-receipt-drift"])(
    "does not carry attach observations across %s",
    (mode) => {
      const receipt = runFixture(mode);

      expect(receipt.Result).toMatchObject({
        Status: "remote-launch-unverified",
        RemoteEnabled: false,
        RemoteDecision: "remote-attached-then-unverified-process-preserved",
        RemoteFallbackAttempts: 0,
        RemoteStopAttempts: 0,
        DesktopProcessId: 42002,
      });
      expect(receipt.State.PostLaunchHealthChecks).toBeGreaterThanOrEqual(2);
      expect(receipt.State.DesktopLaunchCalls).toBe(1);
      expect(receipt.State.StopCalls).toBe(0);
    },
  );

  it("cold-starts transport before launching Desktop without requiring Desktop request readiness", () => {
    const receipt = runFixture("cold-start");

    expect(receipt.Result).toMatchObject({
      Status: "launched-remote",
      RemoteEnabled: true,
      RemoteDecision: "remote-attached",
      RemoteFallbackAttempts: 0,
      RemoteStopAttempts: 0,
      DesktopProcessId: 42002,
    });
    expect(receipt.State.RemoteStartCalls).toBe(1);
    expect(receipt.State.HealthChecks).toBeGreaterThanOrEqual(3);
    expect(receipt.State.DesktopLaunchCalls).toBe(1);
    expect(receipt.State.ChildOverride).toBe(receipt.CapabilityEndpoint);
    expect(receipt.ParentOverride).toBe(receipt.OriginalOverride);
  });

  it("still launches native Desktop when the managed task cannot start", () => {
    const receipt = runFixture("start-failed");

    expect(receipt.Result).toMatchObject({
      Status: "launched-native",
      RemoteEnabled: false,
      RemoteDecision: "remote-start-failed",
    });
    expect(receipt.State.RemoteStartCalls).toBe(1);
    expect(receipt.State.DesktopLaunchCalls).toBe(1);
    expect(receipt.State.ChildOverridePresent).toBe(false);
    expect(receipt.ParentOverride).toBe(receipt.OriginalOverride);
  });

  it("does not launch or restart an already running Desktop", () => {
    const receipt = runFixture("already-running");

    expect(receipt.Result).toMatchObject({
      Status: "already-running",
      RemoteEnabled: null,
      RemoteDecision: "existing-desktop-preserved",
      RemoteFallbackAttempts: 0,
      RemoteStopAttempts: 0,
      DesktopProcessId: 42001,
    });
    expect(receipt.Feedback).toMatchObject({
      Kind: "already-running",
      Title: "ChatGPT 已在运行",
      Message: "远程状态未确认；请先退出 ChatGPT，再使用此快捷方式。",
    });
    expect(receipt.State.HealthChecks).toBe(0);
    expect(receipt.State.RemoteStartCalls).toBe(0);
    expect(receipt.State.DesktopLaunchCalls).toBe(0);
    expect(receipt.ParentOverride).toBe(receipt.OriginalOverride);
  });

  it("lets the managed bootstrap take over one exact native Desktop after Remote is ready", () => {
    const receipt = runFixture("already-running-managed-takeover");

    expect(receipt.Result).toMatchObject({
      Status: "launched-remote",
      RemoteEnabled: true,
      RemoteDecision: "existing-native-desktop-relaunched-remote",
      RemoteFallbackAttempts: 0,
      RemoteStopAttempts: 1,
      DesktopProcessId: 42002,
    });
    expect(receipt.State.HealthChecks).toBeGreaterThanOrEqual(2);
    expect(receipt.State.RemoteStartCalls).toBe(0);
    expect(receipt.State.DesktopLaunchCalls).toBe(1);
    expect(receipt.State.StopCalls).toBe(1);
    expect(receipt.State.ExistingDesktopStopped).toBe(true);
    expect(receipt.State.ChildOverride).toBe(receipt.CapabilityEndpoint);
  });

  it("preserves an existing Desktop when exact managed takeover cannot stop its identity", () => {
    const receipt = runFixture("already-running-takeover-stop-failed");

    expect(receipt.Result).toMatchObject({
      Status: "already-running",
      RemoteEnabled: false,
      RemoteDecision: "existing-desktop-takeover-identity-unverified",
      RemoteFallbackAttempts: 0,
      RemoteStopAttempts: 1,
      DesktopProcessId: 42001,
    });
    expect(receipt.State.DesktopLaunchCalls).toBe(0);
    expect(receipt.State.StopCalls).toBe(1);
    expect(receipt.State.ExistingDesktopStopped).toBe(false);
  });

  it("preserves an existing Desktop when the Broker generation drifts immediately before takeover", () => {
    const receipt = runFixture("already-running-takeover-readiness-drift");

    expect(receipt.Result).toMatchObject({
      Status: "already-running",
      RemoteEnabled: false,
      RemoteDecision: "existing-desktop-takeover-state-drifted",
      RemoteFallbackAttempts: 0,
      RemoteStopAttempts: 0,
      DesktopProcessId: 42001,
    });
    expect(receipt.State.HealthChecks).toBeGreaterThanOrEqual(2);
    expect(receipt.State.RunningDesktopChecks).toBeGreaterThanOrEqual(2);
    expect(receipt.State.DesktopLaunchCalls).toBe(0);
    expect(receipt.State.StopCalls).toBe(0);
    expect(receipt.State.ExistingDesktopStopped).toBe(false);
  });

  it("keeps active managed turns on the Broker during a Desktop-only reconnect", () => {
    const receipt = runFixture("already-running-takeover-unsafe");

    expect(receipt.Result).toMatchObject({
      Status: "launched-remote",
      RemoteEnabled: true,
      RemoteDecision: "existing-native-desktop-relaunched-remote",
      RemoteFallbackAttempts: 0,
      RemoteStopAttempts: 1,
      DesktopProcessId: 42002,
    });
    expect(receipt.State.HealthChecks).toBeGreaterThanOrEqual(2);
    expect(receipt.State.RemoteStartCalls).toBe(0);
    expect(receipt.State.DesktopLaunchCalls).toBe(1);
    expect(receipt.State.StopCalls).toBe(1);
    expect(receipt.State.ExistingDesktopStopped).toBe(true);
  });

  it("does not let an unbound connected transport role block exact takeover", () => {
    const receipt = runFixture("already-running-takeover-desktop-connected-drift");

    expect(receipt.Result).toMatchObject({
      Status: "launched-native",
      RemoteEnabled: false,
      RemoteDecision: "remote-broker-lost-before-attach",
      RemoteFallbackAttempts: 1,
      RemoteStopAttempts: 2,
      DesktopProcessId: 42003,
    });
    expect(receipt.State.HealthChecks).toBeGreaterThanOrEqual(2);
    expect(receipt.State.RunningDesktopChecks).toBeGreaterThanOrEqual(2);
    expect(receipt.State.DesktopLaunchCalls).toBe(2);
    expect(receipt.State.StopCalls).toBe(2);
    expect(receipt.State.ExistingDesktopStopped).toBe(true);
  });

  it("preserves an existing Desktop when its exact root identity drifts immediately before takeover", () => {
    const receipt = runFixture("already-running-takeover-root-drift");

    expect(receipt.Result).toMatchObject({
      Status: "already-running",
      RemoteEnabled: false,
      RemoteDecision: "existing-desktop-takeover-state-drifted",
      RemoteFallbackAttempts: 0,
      RemoteStopAttempts: 0,
      DesktopProcessId: 42001,
    });
    expect(receipt.State.HealthChecks).toBeGreaterThanOrEqual(2);
    expect(receipt.State.RunningDesktopChecks).toBeGreaterThanOrEqual(2);
    expect(receipt.State.DesktopLaunchCalls).toBe(0);
    expect(receipt.State.StopCalls).toBe(0);
    expect(receipt.State.ExistingDesktopStopped).toBe(false);
  });

  it("preserves an existing Desktop when the root process count changes immediately before takeover", () => {
    const receipt = runFixture("already-running-takeover-root-count-drift");

    expect(receipt.Result).toMatchObject({
      Status: "already-running",
      RemoteEnabled: false,
      RemoteDecision: "existing-desktop-takeover-state-drifted",
      RemoteFallbackAttempts: 0,
      RemoteStopAttempts: 0,
      DesktopProcessId: 42001,
    });
    expect(receipt.State.HealthChecks).toBeGreaterThanOrEqual(2);
    expect(receipt.State.RunningDesktopChecks).toBeGreaterThanOrEqual(2);
    expect(receipt.State.DesktopLaunchCalls).toBe(0);
    expect(receipt.State.StopCalls).toBe(0);
    expect(receipt.State.ExistingDesktopStopped).toBe(false);
  });

  it("preserves an existing native Desktop when managed infrastructure cannot start", () => {
    const receipt = runFixture("already-running-managed-start-failed");

    expect(receipt.Result).toMatchObject({
      Status: "already-running",
      RemoteEnabled: false,
      RemoteDecision: "remote-start-failed",
      RemoteFallbackAttempts: 0,
      RemoteStopAttempts: 0,
      DesktopProcessId: 42001,
    });
    expect(receipt.State.RemoteStartCalls).toBe(1);
    expect(receipt.State.DesktopLaunchCalls).toBe(0);
    expect(receipt.State.StopCalls).toBe(0);
    expect(receipt.State.ExistingDesktopStopped).toBe(false);
  });

  it("falls back once when the same Broker generation dies before Desktop attaches", () => {
    const receipt = runFixture("broker-before-attach-death");

    expect(receipt.Result).toMatchObject({
      Status: "launched-native",
      RemoteEnabled: false,
      RemoteDecision: "remote-broker-lost-before-attach",
      RemoteFallbackAttempts: 1,
      RemoteStopAttempts: 1,
      DesktopProcessId: 42003,
    });
    expect(receipt.State.DesktopLaunchCalls).toBe(2);
    expect(receipt.State.StopCalls).toBe(1);
    expect(receipt.State.LaunchOverrides).toEqual([receipt.CapabilityEndpoint, null]);
    expect(receipt.ParentOverride).toBe(receipt.OriginalOverride);
  });

  it("relaunches native once without stopping when the remote child exits before attach", () => {
    const receipt = runFixture("early-exit");

    expect(receipt.Result).toMatchObject({
      Status: "launched-native",
      RemoteEnabled: false,
      RemoteDecision: "remote-desktop-exited-before-attach",
      RemoteFallbackAttempts: 1,
      RemoteStopAttempts: 0,
      DesktopProcessId: 42003,
    });
    expect(receipt.State.DesktopLaunchCalls).toBe(2);
    expect(receipt.State.StopCalls).toBe(0);
    expect(receipt.State.LaunchOverrides).toEqual([receipt.CapabilityEndpoint, null]);
  });

  it("preserves the process when its exact startup identity cannot be proven", () => {
    const receipt = runFixture("identity-unverified");

    expect(receipt.Result).toMatchObject({
      Status: "remote-launch-unverified",
      RemoteEnabled: false,
      RemoteDecision: "created-desktop-identity-unverified",
      RemoteFallbackAttempts: 0,
      RemoteStopAttempts: 0,
      DesktopProcessId: 42002,
    });
    expect(receipt.State.DesktopLaunchCalls).toBe(1);
    expect(receipt.State.StopCalls).toBe(0);
    expect(receipt.State.LaunchOverrides).toEqual([receipt.CapabilityEndpoint]);
  });

  it("restores native Desktop when the takeover child exits before its identity can be read", () => {
    const receipt = runFixture("already-running-takeover-child-identity-unavailable-exited");

    expect(receipt.Result).toMatchObject({
      Status: "launched-native",
      RemoteEnabled: false,
      RemoteDecision: "remote-desktop-exited-before-identity",
      RemoteFallbackAttempts: 1,
      RemoteStopAttempts: 1,
      DesktopProcessId: 42003,
    });
    expect(receipt.State.DesktopLaunchCalls).toBe(2);
    expect(receipt.State.StopCalls).toBe(1);
    expect(receipt.State.ProcessHandleChecks).toBeGreaterThanOrEqual(1);
    expect(receipt.State.LaunchOverrides).toEqual([receipt.CapabilityEndpoint, null]);
  });

  it("preserves an unknown running takeover child without killing or duplicating it", () => {
    const receipt = runFixture("already-running-takeover-child-identity-unavailable-running");

    expect(receipt.Result).toMatchObject({
      Status: "remote-launch-unverified",
      RemoteEnabled: false,
      RemoteDecision: "created-desktop-identity-unavailable",
      RemoteFallbackAttempts: 0,
      RemoteStopAttempts: 1,
      DesktopProcessId: null,
    });
    expect(receipt.State.DesktopLaunchCalls).toBe(1);
    expect(receipt.State.StopCalls).toBe(1);
    expect(receipt.State.ProcessHandleChecks).toBeGreaterThanOrEqual(1);
    expect(receipt.State.LaunchOverrides).toEqual([receipt.CapabilityEndpoint]);
  });

  it("restores native Desktop when an unverified takeover child is proven exited by its original handle", () => {
    const receipt = runFixture("already-running-takeover-created-state-unverified-exited");

    expect(receipt.Result).toMatchObject({
      Status: "launched-native",
      RemoteEnabled: false,
      RemoteDecision: "remote-desktop-exited-before-attach",
      RemoteFallbackAttempts: 1,
      RemoteStopAttempts: 1,
      DesktopProcessId: 42003,
    });
    expect(receipt.State.DesktopLaunchCalls).toBe(2);
    expect(receipt.State.StopCalls).toBe(1);
    expect(receipt.State.ProcessHandleChecks).toBeGreaterThanOrEqual(1);
    expect(receipt.State.LaunchOverrides).toEqual([receipt.CapabilityEndpoint, null]);
  });

  it("preserves an unverified running takeover child without killing or duplicating it", () => {
    const receipt = runFixture("already-running-takeover-created-state-unverified-running");

    expect(receipt.Result).toMatchObject({
      Status: "remote-launch-unverified",
      RemoteEnabled: false,
      RemoteDecision: "created-desktop-identity-unverified",
      RemoteFallbackAttempts: 0,
      RemoteStopAttempts: 1,
      DesktopProcessId: 42002,
    });
    expect(receipt.State.DesktopLaunchCalls).toBe(1);
    expect(receipt.State.StopCalls).toBe(1);
    expect(receipt.State.ProcessHandleChecks).toBeGreaterThanOrEqual(1);
    expect(receipt.State.LaunchOverrides).toEqual([receipt.CapabilityEndpoint]);
  });

  it("never writes the user environment and uses a scoped split token only when elevated", () => {
    const launcher = readFileSync(launcherPath, "utf8");

    expect(launcher).not.toContain("Set-UserEnvironmentValue");
    expect(launcher).not.toContain("Install-BrokerUserEnvironment");
    expect(launcher).not.toMatch(/EnvironmentVariableTarget\]::User/u);
    expect(launcher).not.toMatch(/setx(?:\.exe)?\b/iu);
    expect(launcher).toContain("GetProcessesByName('explorer')");
    expect(launcher).toContain("Select-CodexDesktopInteractiveExplorerCandidate");
    expect(launcher).toContain("DuplicateTokenEx");
    expect(launcher).toContain("CreateEnvironmentBlock");
    expect(launcher).toContain("DestroyEnvironmentBlock");
    expect(launcher).toContain("CreateProcessWithTokenW");
    expect(launcher).toContain("[uint32]0x00000400");
    expect(launcher).toContain("SecureZeroMemory");
    expect(launcher).toContain("CloseHandle");
    expect(launcher).not.toContain("[System.Environment]::GetEnvironmentVariables()");
    expect(launcher).toContain("$startInfo.UseShellExecute = $false");
    expect(launcher).toContain("$startInfo.Environment['CODEX_APP_SERVER_WS_URL']");
  });

  it("strictly selects the same-session same-SID medium Explorer and clears scoped environment blocks", () => {
    const receipt = runSplitTokenFixture();

    expect(receipt.SelectedProcessId).toBe(606);
    expect(receipt.RemoteExactCount).toBe(1);
    expect(receipt.RemoteStaleCount).toBe(0);
    expect(receipt.RemotePathCount).toBe(1);
    expect(receipt.NativeOverrideCount).toBe(0);
    expect(receipt.RemoteCleared).toBe(true);
    expect(receipt.NativeCleared).toBe(true);
    expect(receipt.MalformedFailedClosed).toBe(true);
    expect(receipt.MalformedSourceCleared).toBe(true);
    expect(receipt.SplitTokenCalls).toEqual([
      {
        ExecutablePath: "C:\\fixture\\ChatGPT.exe",
        Endpoint: "ws://127.0.0.1:18791/ws/fixture-endpoint",
        ArgumentCount: 0,
      },
      {
        ExecutablePath: "C:\\fixture\\ChatGPT.exe",
        Endpoint: "",
        ArgumentCount: 0,
      },
    ]);
  });

  it("keeps the raw launch nonce and query-bearing endpoint out of the persistent launch receipt", () => {
    const launcher = readFileSync(launcherPath, "utf8");
    const receiptStart = launcher.indexOf("function Write-CodexDesktopLaunchReceipt");
    const receiptEnd = launcher.indexOf("\nfunction Get-CodexDesktopLaunchIdentity", receiptStart);
    const receiptWriter = launcher.slice(receiptStart, receiptEnd);

    expect(receiptWriter).not.toMatch(/nonce/iu);
    expect(receiptWriter).not.toContain("RemoteEndpoint");
    expect(receiptWriter).not.toContain("CODEX_APP_SERVER_WS_URL");
    expect(receiptWriter).not.toContain("desktopLaunchNonce");
  });

  it("normalizes every persistent v2 diagnostic before writing the launch receipt", () => {
    const receipt = runReceiptFixture();

    expect(Object.keys(receipt).sort()).toEqual(
      [
        "CorrelationId",
        "DesktopProcessId",
        "FeedbackFailureCode",
        "FeedbackStatus",
        "RecordedAtUtc",
        "RemoteDecision",
        "RemoteEnabled",
        "RemoteFailureCode",
        "RemoteFailureStage",
        "RemoteFallbackAttempts",
        "RemoteStopAttempts",
        "Signature",
        "Status",
        "Version",
      ].sort(),
    );
    expect(receipt).toMatchObject({
      Signature: "codex-local-remote/desktop-launch/v2",
      Version: 2,
      Status: "remote-launch-unverified",
      RemoteEnabled: null,
      RemoteDecision: "remote-start-failed",
      RemoteFallbackAttempts: 0,
      RemoteStopAttempts: 0,
      DesktopProcessId: null,
      RemoteFailureStage: "unexpected",
      RemoteFailureCode: "unexpected",
      CorrelationId: null,
      FeedbackStatus: "render-failed",
      FeedbackFailureCode: "feedback-render-failed",
    });
    expect(JSON.stringify(receipt)).not.toContain("PRIVATE_SENTINEL");
  });

  it("places the endpoint on the exact child without leaking or inheriting a stale override", () => {
    const receipt = runEnvironmentFixture();

    expect(receipt.RemoteChildOverride).toBe(receipt.CapabilityEndpoint);
    expect(receipt.NativeChildOverride).toBe("");
    expect(receipt.ParentOverride).toBe(receipt.OriginalOverride);
  });
});
