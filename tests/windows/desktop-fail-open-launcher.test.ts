import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const launcherPath = join(repositoryRoot, "scripts", "windows", "Launch-CodexWithRemote.ps1");
const driverPath = join(import.meta.dirname, "fixtures", "desktop-fail-open-launcher-driver.ps1");
const environmentDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "desktop-process-environment-driver.ps1",
);

interface FixtureResult {
  Result: {
    Status: string;
    RemoteEnabled: boolean | null;
    RemoteDecision: string;
    RemoteFallbackAttempts: number;
    RemoteStopAttempts: number;
    DesktopProcessId: number;
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
    StopCalls: number;
    ChildOverridePresent: boolean;
    ChildOverride: string | null;
    LaunchOverrides: Array<string | null>;
  };
  ParentOverride: string;
  OriginalOverride: string;
  CapabilityEndpoint: string;
}

function runFixture(mode: string): FixtureResult {
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

windowsOnly("Codex Desktop fail-open launcher", () => {
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
      Title: "ChatGPT 已启动",
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
    expect(receipt.ParentOverride).toBe(receipt.OriginalOverride);
  });

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

  it("never writes the user environment or launches through the persistent shell", () => {
    const launcher = readFileSync(launcherPath, "utf8");

    expect(launcher).not.toContain("Set-UserEnvironmentValue");
    expect(launcher).not.toContain("Install-BrokerUserEnvironment");
    expect(launcher).not.toMatch(/EnvironmentVariableTarget\]::User/u);
    expect(launcher).not.toMatch(/setx(?:\.exe)?\b/iu);
    expect(launcher).not.toContain("explorer.exe");
    expect(launcher).toContain("$startInfo.UseShellExecute = $false");
    expect(launcher).toContain("$startInfo.Environment['CODEX_APP_SERVER_WS_URL']");
  });

  it("places the endpoint on the exact child without leaking or inheriting a stale override", () => {
    const receipt = runEnvironmentFixture();

    expect(receipt.RemoteChildOverride).toBe(receipt.CapabilityEndpoint);
    expect(receipt.NativeChildOverride).toBe("");
    expect(receipt.ParentOverride).toBe(receipt.OriginalOverride);
  });
});
