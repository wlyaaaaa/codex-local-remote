import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const launcherPath =
  process.env.CODEX_LAUNCHER_UNDER_TEST ??
  join(repositoryRoot, "scripts", "windows", "Launch-CodexWithRemote.ps1");
const startupPath = join(repositoryRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1");
const retryDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "shortcut-runtime-handoff-retry-driver.ps1",
);
const receiptDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "shortcut-request-failure-receipt-driver.ps1",
);
const drainDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "shortcut-desktop-drain-observation-driver.ps1",
);
const intentBoundDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "intent-bound-launch-driver.ps1",
);
const boundRequesterFallbackDriverPath = join(
  import.meta.dirname,
  "fixtures",
  "bound-requester-fallback-driver.ps1",
);

interface RetryFixtureResult {
  Result: { Status: string } | null;
  RequestCalls: number;
  WaitCalls: number;
  FallbackCalls: number;
  FailureStage: string | null;
  FailureCode: string | null;
}

interface ReceiptFixtureResult {
  Result: {
    Status: string;
    RemoteFailureStage: string;
    RemoteFailureCode: string;
  };
  NativeLaunchCalls: number;
  DesktopStartCalls: number;
}

function runFixture<T>(driverPath: string, mode: string): T {
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
      ...(mode === "" ? [] : ["-Mode", mode]),
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as T;
}

windowsOnly("safe shortcut runtime handoff retry", () => {
  it.each([
    ["bound-invalid", "handoff-request-invalid"],
    ["bound-mismatch", "handoff-result-mismatch"],
    ["bound-pointer-missing", "runtime-generation-unverified"],
    ["bound-pointer-damaged", "runtime-generation-unverified"],
  ])("does not enter native requester fail-open for %s", (mode, expectedCode) => {
    const receipt = runFixture<{
      Result: {
        Status: string;
        RemoteFailureStage: string;
        RemoteFailureCode: string;
      };
      FallbackCalls: number;
      NativeStartCalls: number;
      TaskStartCalls: number;
    }>(boundRequesterFallbackDriverPath, mode);

    expect(receipt).toMatchObject({
      Result: {
        Status: "remote-launch-unverified",
        RemoteFailureStage: "runtime-handoff",
        RemoteFailureCode: expectedCode,
      },
      FallbackCalls: 0,
      NativeStartCalls: 0,
      TaskStartCalls: 0,
    });
  });

  it.each(["bound-version-only", "bound-root-only"])(
    "routes the incomplete legacy request %s directly to native",
    (mode) => {
      const receipt = runFixture<{
        Result: {
          Status: string;
          RemoteFailureStage: string | null;
          RemoteFailureCode: string | null;
        };
        FallbackCalls: number;
        NativeStartCalls: number;
        TaskStartCalls: number;
      }>(boundRequesterFallbackDriverPath, mode);

      expect(receipt).toMatchObject({
        Result: {
          Status: "launched-native",
          RemoteFailureStage: null,
          RemoteFailureCode: null,
        },
        FallbackCalls: 1,
        NativeStartCalls: 1,
        TaskStartCalls: 0,
      });
    },
  );

  it("routes an ordinary unbound legacy shortcut directly to native without starting Remote", () => {
    const receipt = runFixture<{
      Result: {
        Status: string;
        RemoteFailureStage: string | null;
        RemoteFailureCode: string | null;
      };
      FallbackCalls: number;
      NativeStartCalls: number;
      TaskStartCalls: number;
    }>(boundRequesterFallbackDriverPath, "unbound-owner-failure");

    expect(receipt).toMatchObject({
      Result: {
        Status: "launched-native",
        RemoteFailureStage: null,
        RemoteFailureCode: null,
      },
      FallbackCalls: 1,
      NativeStartCalls: 1,
      TaskStartCalls: 0,
    });
  });

  it("does not start the task or Desktop when the selected runtime mismatches the request", () => {
    const receipt = runFixture<{
      StartTaskCalls: number;
      DesktopStartCalls: number;
      RequestFailureStage: string;
      RequestFailureCode: string;
      DesktopFailureStage: string;
      DesktopFailureCode: string;
    }>(intentBoundDriverPath, "");

    expect(receipt).toEqual({
      StartTaskCalls: 0,
      DesktopStartCalls: 0,
      RequestFailureStage: "runtime-handoff",
      RequestFailureCode: "handoff-result-mismatch",
      DesktopFailureStage: "runtime-handoff",
      DesktopFailureCode: "handoff-result-mismatch",
    });
  });

  it("binds requester, supervisor, and owner execution to the same target and intent", () => {
    const launcher = readFileSync(launcherPath, "utf8");
    const startup = readFileSync(startupPath, "utf8");
    const requestStart = launcher.indexOf("$runtimeBeforeTaskStart =");
    const taskStart = launcher.indexOf(
      "$null = Start-CodexLocalRemoteRegisteredTask",
      requestStart,
    );
    const postTaskBarrier = launcher.indexOf(
      "$runtime = Assert-CodexExpectedSelectedRuntime",
      taskStart,
    );
    const publishIntent = launcher.indexOf("$publishedIntent =", postTaskBarrier);
    const ownerDesktopStart = launcher.indexOf(
      "Start-CodexDesktopProcess",
      launcher.indexOf("-StartDesktopAction {", publishIntent),
    );
    const ownerBarrier = launcher.lastIndexOf(
      "Assert-CodexExpectedSelectedRuntime",
      ownerDesktopStart,
    );

    expect(requestStart).toBeGreaterThan(-1);
    expect(taskStart).toBeGreaterThan(requestStart);
    expect(postTaskBarrier).toBeGreaterThan(taskStart);
    expect(publishIntent).toBeGreaterThan(postTaskBarrier);
    expect(ownerBarrier).toBeGreaterThan(publishIntent);
    expect(ownerDesktopStart).toBeGreaterThan(ownerBarrier);
    expect(startup).toContain("[string]$pendingIntent.TargetRuntimeVersionId");
    expect(startup).toContain("[string]$pendingIntent.TargetRuntimeRoot");
    expect(startup).toContain("[string]$pendingIntent.IntentId");
    expect(startup).toContain("-LaunchCorrelationId $LaunchCorrelationId");
  });

  it("waits for a draining Desktop and retries the owner request exactly once", () => {
    const receipt = runFixture<RetryFixtureResult>(retryDriverPath, "desktop-drains");

    expect(receipt).toMatchObject({
      Result: { Status: "desktop-owner-requested" },
      RequestCalls: 2,
      WaitCalls: 1,
      FallbackCalls: 0,
      FailureStage: null,
      FailureCode: null,
    });
  });

  it("preserves a stable Desktop without retrying or switching generations", () => {
    const receipt = runFixture<RetryFixtureResult>(retryDriverPath, "desktop-stays-running");

    expect(receipt).toMatchObject({
      Result: null,
      RequestCalls: 1,
      WaitCalls: 1,
      FallbackCalls: 1,
      FailureStage: "runtime-handoff",
      FailureCode: "desktop-running",
    });
  });

  it("does not retry a non-drain runtime handoff failure", () => {
    const receipt = runFixture<RetryFixtureResult>(retryDriverPath, "handoff-fails");

    expect(receipt).toMatchObject({
      Result: null,
      RequestCalls: 1,
      WaitCalls: 0,
      FallbackCalls: 1,
      FailureStage: "runtime-handoff",
      FailureCode: "runtime-handoff-failed",
    });
  });

  it("does not retry when the bounded Desktop drain wait itself fails", () => {
    const receipt = runFixture<RetryFixtureResult>(retryDriverPath, "drain-wait-fails");

    expect(receipt).toMatchObject({
      Result: null,
      RequestCalls: 1,
      WaitCalls: 1,
      FallbackCalls: 1,
      FailureStage: "runtime-handoff",
      FailureCode: "desktop-running",
    });
  });

  it.each([
    ["drains-consecutively", 3],
    ["empty-observation-resets", 4],
  ])(
    "requires two consecutive process-empty and Broker-disconnected observations in %s",
    (mode, expectedChecks) => {
      const receipt = runFixture<{
        Drained: boolean;
        ProcessChecks: number;
        ReadinessChecks: number;
      }>(drainDriverPath, mode);

      expect(receipt).toEqual({
        Drained: true,
        ProcessChecks: expectedChecks,
        ReadinessChecks: expectedChecks,
      });
    },
  );

  it("fails the drain observation closed when CIM process enumeration fails", () => {
    const receipt = runFixture<{
      Drained: boolean;
      ProcessChecks: number;
      ReadinessChecks: number;
    }>(drainDriverPath, "cim-fails");

    expect(receipt.Drained).toBe(false);
    expect(receipt.ProcessChecks).toBeGreaterThan(0);
    expect(receipt.ReadinessChecks).toBe(0);
  });

  it("carries desktop-running through a successful native requester fallback", () => {
    const receipt = runFixture<ReceiptFixtureResult>(receiptDriverPath, "desktop-running-native");

    expect(receipt.NativeLaunchCalls).toBe(1);
    expect(receipt.Result).toMatchObject({
      Status: "launched-native",
      RemoteFailureStage: "runtime-handoff",
      RemoteFailureCode: "desktop-running",
    });
  });

  it("carries runtime-handoff-failed through an unresolved requester fallback", () => {
    const receipt = runFixture<ReceiptFixtureResult>(
      receiptDriverPath,
      "handoff-failed-unresolved",
    );

    expect(receipt.NativeLaunchCalls).toBe(0);
    expect(receipt.Result).toMatchObject({
      Status: "remote-launch-unverified",
      RemoteFailureStage: "runtime-handoff",
      RemoteFailureCode: "runtime-handoff-failed",
    });
  });

  it("keeps a later native Desktop start failure instead of hiding it", () => {
    const receipt = runFixture<ReceiptFixtureResult>(receiptDriverPath, "native-start-failed");

    expect(receipt.NativeLaunchCalls).toBe(1);
    expect(receipt.Result).toMatchObject({
      Status: "remote-launch-unverified",
      RemoteFailureStage: "desktop-start",
      RemoteFailureCode: "desktop-start-failed",
    });
  });

  it("fails closed without a native start when strict CIM fails during requester fallback", () => {
    const receipt = runFixture<ReceiptFixtureResult>(
      receiptDriverPath,
      "cim-fails-before-native-start",
    );

    expect(receipt.NativeLaunchCalls).toBe(1);
    expect(receipt.DesktopStartCalls).toBe(0);
    expect(receipt.Result).toMatchObject({
      Status: "remote-launch-unverified",
      RemoteFailureStage: "runtime-handoff",
      RemoteFailureCode: "desktop-running",
    });
  });
});
