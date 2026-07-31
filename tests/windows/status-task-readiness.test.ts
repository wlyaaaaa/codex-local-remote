import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const statusScript = join(repositoryRoot, "scripts", "windows", "Get-CodexLocalRemoteStatus.ps1");
const driver = join(import.meta.dirname, "fixtures", "status-task-mock-driver.ps1");

interface StatusResult {
  Ready: boolean;
  TaskState: string;
  LastTaskResult: number;
  TaskOwned: boolean;
  TaskRunning: boolean;
  TaskReady: boolean;
  TaskRuntimeBinding: string;
  SidecarListenerReady: boolean;
  SidecarOwned: boolean;
  SidecarPid: number | null;
  SidecarLoopbackOnly: boolean;
  CapabilityTokenReady: boolean;
  LauncherScriptReady: boolean;
  LauncherShortcutReady: boolean;
  LauncherIconReady: boolean;
  LauncherConfigured: boolean;
  LaunchMode: string;
  DesktopLaunchReceiptReady: boolean;
  DesktopLaunchReceiptVersion: number | null;
  DesktopLaunchStatus: string;
  DesktopLaunchRemoteEnabled: boolean | null;
  DesktopLaunchDecision: string;
  DesktopLaunchRemoteFailureStage: string | null;
  DesktopLaunchRemoteFailureCode: string | null;
  DesktopLaunchCorrelationId: string | null;
  DesktopLaunchFeedbackStatus: string | null;
  DesktopLaunchFeedbackFailureCode: string | null;
  DesktopLaunchRecordedAtUtc: string | null;
  LegacyPersistentOverrideBlocked: boolean;
}

windowsOnly("Windows scheduled-task readiness status", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = join(tmpdir(), `codex-local-remote-status-${process.pid}-${crypto.randomUUID()}`);
    mkdirSync(sandbox, { recursive: true });
  });

  function getStatus(mode: string) {
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        driver,
        "-TargetScript",
        statusScript,
        "-Mode",
        mode,
        "-InstallRoot",
        repositoryRoot,
        "-DataDir",
        join(sandbox, "data"),
        "-NodePath",
        join(sandbox, "node.exe"),
        "-CodexPath",
        join(sandbox, "codex.exe"),
        "-PwshPath",
        join(sandbox, "pwsh.exe"),
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, LOCALAPPDATA: sandbox },
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    return JSON.parse(result.stdout.trim()) as StatusResult;
  }

  it("accepts the exact Desktop-owner V5 task that is currently Running", () => {
    const status = getStatus("valid-running");
    expect(status).toMatchObject({
      TaskState: "Running",
      LastTaskResult: 267009,
      TaskOwned: true,
      TaskRunning: true,
      TaskReady: true,
      TaskRuntimeBinding: "desktop-owner-v5",
    });
  });

  it("normalizes the real scheduler's null trigger collection to zero triggers", () => {
    const status = getStatus("valid-running-null-triggers");
    expect(status).toMatchObject({
      TaskState: "Running",
      TaskOwned: true,
      TaskRunning: true,
      TaskReady: true,
      TaskRuntimeBinding: "desktop-owner-v5",
    });
  });

  it("does not let LastTaskResult 267009 block a currently Running task", () => {
    const status = getStatus("valid-running");
    expect(status.LastTaskResult).toBe(267009);
    expect(status.TaskReady).toBe(true);
  });

  it.each(["legacy-no-desktop-launch", "legacy-pre-headless"])(
    "reports the exact %s V3 legacy action as update-required",
    (mode) => {
      const status = getStatus(mode);
      expect(status).toMatchObject({
        TaskOwned: true,
        TaskRunning: true,
        TaskReady: false,
        TaskRuntimeBinding: "dynamic-v3-update-required",
      });
    },
  );

  it("keeps the exact headless V4 task recognized as update-required", () => {
    const status = getStatus("legacy-headless-v4");
    expect(status).toMatchObject({
      TaskOwned: true,
      TaskRunning: true,
      TaskReady: false,
      TaskRuntimeBinding: "headless-v4-update-required",
    });
  });

  it("reports the exact process-scoped fail-open launcher without a persistent override", () => {
    const status = getStatus("valid-running");
    expect(status).toMatchObject({
      CapabilityTokenReady: true,
      LauncherScriptReady: true,
      LauncherShortcutReady: true,
      LauncherIconReady: true,
      LauncherConfigured: true,
      LaunchMode: "process-scoped-pending-proof",
      LegacyPersistentOverrideBlocked: false,
    });
  });

  it.each(["launcher-non-elevated", "launcher-minimized"])(
    "rejects a managed-looking launcher that lacks the current privilege or window contract in %s mode",
    (mode) => {
      const status = getStatus(mode);
      expect(status).toMatchObject({
        LauncherScriptReady: true,
        LauncherShortcutReady: false,
        LauncherIconReady: true,
        LauncherConfigured: false,
        LaunchMode: "native-only",
      });
    },
  );

  it("rejects the legacy TakeOver shortcut even when its RunAs and other fields match", () => {
    const status = getStatus("launcher-legacy-takeover");
    expect(status).toMatchObject({
      LauncherScriptReady: true,
      LauncherShortcutReady: false,
      LauncherIconReady: true,
      LauncherConfigured: false,
      LaunchMode: "native-only",
    });
  });

  it("reports the latest token-free Desktop launch result", () => {
    const status = getStatus("valid-launch-receipt");
    expect(status).toMatchObject({
      DesktopLaunchReceiptReady: true,
      DesktopLaunchReceiptVersion: 1,
      DesktopLaunchStatus: "launched-remote",
      DesktopLaunchRemoteEnabled: true,
      DesktopLaunchDecision: "remote-ready",
      DesktopLaunchRemoteFailureStage: null,
      DesktopLaunchRemoteFailureCode: null,
      DesktopLaunchCorrelationId: null,
      DesktopLaunchFeedbackStatus: null,
      DesktopLaunchFeedbackFailureCode: null,
      DesktopLaunchRecordedAtUtc: "2026-07-27T12:34:56.0000000Z",
    });
  });

  it("reports only the allowlisted v2 failure and feedback diagnostics", () => {
    const status = getStatus("valid-launch-receipt-v2");
    expect(status).toMatchObject({
      DesktopLaunchReceiptReady: true,
      DesktopLaunchReceiptVersion: 2,
      DesktopLaunchStatus: "launched-native",
      DesktopLaunchRemoteEnabled: false,
      DesktopLaunchDecision: "remote-start-failed",
      DesktopLaunchRemoteFailureStage: "runtime-handoff",
      DesktopLaunchRemoteFailureCode: "runtime-handoff-failed",
      DesktopLaunchCorrelationId: "0123456789abcdef0123456789abcdef",
      DesktopLaunchFeedbackStatus: "render-failed",
      DesktopLaunchFeedbackFailureCode: "feedback-render-failed",
      DesktopLaunchRecordedAtUtc: "2026-07-29T23:45:56.0000000Z",
    });
  });

  it("accepts a v2 success receipt whose nullable diagnostics are absent", () => {
    const status = getStatus("valid-launch-receipt-v2-success");
    expect(status).toMatchObject({
      DesktopLaunchReceiptReady: true,
      DesktopLaunchReceiptVersion: 2,
      DesktopLaunchStatus: "launched-remote",
      DesktopLaunchRemoteEnabled: true,
      DesktopLaunchDecision: "remote-attached",
      DesktopLaunchRemoteFailureStage: null,
      DesktopLaunchRemoteFailureCode: null,
      DesktopLaunchCorrelationId: null,
      DesktopLaunchFeedbackStatus: "rendered",
      DesktopLaunchFeedbackFailureCode: null,
    });
  });

  it("fails the launch receipt closed without changing current readiness", () => {
    const status = getStatus("invalid-launch-receipt");
    expect(status).toMatchObject({
      DesktopLaunchReceiptReady: false,
      DesktopLaunchReceiptVersion: null,
      DesktopLaunchStatus: "invalid",
      DesktopLaunchRemoteEnabled: null,
      DesktopLaunchDecision: "",
      DesktopLaunchRemoteFailureStage: null,
      DesktopLaunchRemoteFailureCode: null,
      DesktopLaunchCorrelationId: null,
      DesktopLaunchFeedbackStatus: null,
      DesktopLaunchFeedbackFailureCode: null,
      DesktopLaunchRecordedAtUtc: null,
    });
  });

  it.each([
    "invalid-launch-receipt-v2-extra",
    "invalid-launch-receipt-v2-stage",
    "invalid-launch-receipt-v2-code",
    "invalid-launch-receipt-v2-decision",
    "invalid-launch-receipt-v2-correlation",
    "invalid-launch-receipt-v2-feedback-status",
    "invalid-launch-receipt-v2-feedback",
    "invalid-launch-receipt-v2-failure-pair",
  ])("fails the diagnostic launch receipt closed for %s", (mode) => {
    const status = getStatus(mode);
    expect(status).toMatchObject({
      DesktopLaunchReceiptReady: false,
      DesktopLaunchReceiptVersion: null,
      DesktopLaunchStatus: "invalid",
      DesktopLaunchRemoteEnabled: null,
      DesktopLaunchDecision: "",
      DesktopLaunchRemoteFailureStage: null,
      DesktopLaunchRemoteFailureCode: null,
      DesktopLaunchCorrelationId: null,
      DesktopLaunchFeedbackStatus: null,
      DesktopLaunchFeedbackFailureCode: null,
      DesktopLaunchRecordedAtUtc: null,
    });
    expect(JSON.stringify(status)).not.toContain("PRIVATE_FAILURE_SENTINEL");
  });

  it("marks any persistent user override as a P0 launch blocker", () => {
    const status = getStatus("persistent-user-override");
    expect(status).toMatchObject({
      LauncherConfigured: true,
      LaunchMode: "blocked-persistent-user-override",
      LegacyPersistentOverrideBlocked: true,
    });
    expect(status.Ready).toBe(false);
  });

  it("accepts the current user's SID as the exact principal identity", () => {
    const status = getStatus("valid-running-sid");
    expect(status.TaskOwned).toBe(true);
    expect(status.TaskReady).toBe(true);
  });

  it.each([
    "foreign-action",
    "foreign-working-directory",
    "missing-action-property",
    "foreign-principal-user",
    "foreign-principal-logon",
    "foreign-principal-run-level",
    "missing-principal-user",
    "foreign-trigger-class",
    "foreign-trigger-user",
    "foreign-trigger-disabled",
    "foreign-trigger-extra",
    "missing-trigger-user",
    "foreign-setting",
    "missing-setting-property",
    "missing-principal",
    "missing-triggers",
    "missing-settings",
  ])("fails closed for unified fingerprint counterexample %s", (mode) => {
    const status = getStatus(mode);
    expect(status.TaskRunning).toBe(true);
    expect(status.TaskOwned).toBe(false);
    expect(status.TaskReady).toBe(false);
  });

  it("requires TaskState Running even when the task is exactly owned", () => {
    const status = getStatus("valid-ready");
    expect(status).toMatchObject({
      TaskState: "Ready",
      TaskOwned: true,
      TaskRunning: false,
      TaskReady: false,
    });
  });

  it("accepts only one IPv4-loopback listener owned by the exact managed Sidecar", () => {
    const status = getStatus("valid-running");
    expect(status).toMatchObject({
      SidecarListenerReady: true,
      SidecarOwned: true,
      SidecarPid: 4242,
      SidecarLoopbackOnly: true,
    });
  });

  it("ignores an unrelated IPv6-loopback neighbor when the managed IPv4 endpoint is exact", () => {
    const status = getStatus("sidecar-ipv6-loopback-neighbor");
    expect(status).toMatchObject({
      SidecarListenerReady: true,
      SidecarOwned: true,
      SidecarPid: 4242,
      SidecarLoopbackOnly: true,
    });
  });

  it("rejects a non-loopback Sidecar listener", () => {
    const status = getStatus("sidecar-nonloopback");
    expect(status).toMatchObject({
      SidecarListenerReady: false,
      SidecarOwned: false,
      SidecarPid: null,
      SidecarLoopbackOnly: false,
    });
  });

  it("rejects multiple Sidecar listeners and owners", () => {
    const status = getStatus("sidecar-multiple");
    expect(status).toMatchObject({
      SidecarListenerReady: false,
      SidecarOwned: false,
      SidecarPid: null,
      SidecarLoopbackOnly: true,
    });
  });

  it("rejects a listener owned by a foreign Sidecar command", () => {
    const status = getStatus("sidecar-foreign");
    expect(status).toMatchObject({
      SidecarListenerReady: true,
      SidecarOwned: false,
      SidecarPid: 4242,
      SidecarLoopbackOnly: true,
    });
  });

  it("includes TaskReady in the aggregate Ready gate", () => {
    const source = readFileSync(statusScript, "utf8");
    expect(source).toMatch(/^\s*Ready\s*=\s*\(\s*\r?\n\s*\$taskReady\s+-and/mu);
    expect(source).toMatch(/\$taskReady\s+-and\s*\r?\n\s*\$sidecarReady\s+-and/mu);
    expect(source).toMatch(/\$launcherConfigured\s+-and/u);
    expect(source).toMatch(/-not \$legacyPersistentOverrideBlocked\s+-and/u);
    expect(source).toContain("$currentPersistentOverride = Get-StatusUserEnvironmentValueState");
    expect(source).toContain(
      "$legacyPersistentOverrideBlocked = [bool]$currentPersistentOverride.Exists",
    );
    expect(source).toContain("'blocked-persistent-user-override'");
    expect(source).not.toContain("$desktopEnvironmentConfigured");
    const launcherDefinitionStart = source.indexOf("function Get-StatusLauncherShortcutDefinition");
    const launcherDefinitionEnd = source.indexOf(
      "function Test-StatusLauncherShortcut",
      launcherDefinitionStart,
    );
    expect(launcherDefinitionStart).toBeGreaterThanOrEqual(0);
    expect(launcherDefinitionEnd).toBeGreaterThan(launcherDefinitionStart);
    const launcherDefinition = source.slice(launcherDefinitionStart, launcherDefinitionEnd);
    expect(launcherDefinition).toContain("Get-CodexLocalRemoteControlDispatcherPath");
    expect(launcherDefinition).toContain("'-Operation'");
    expect(launcherDefinition).toContain("'Open'");
    expect(launcherDefinition).toContain("'-AllowDesktopRestart'");
    expect(launcherDefinition.match(/'-DataDir'/gu)).toHaveLength(1);
    expect(launcherDefinition.indexOf("'-Operation'")).toBeLessThan(
      launcherDefinition.indexOf("'-DataDir'"),
    );
    expect(launcherDefinition).not.toContain("'-RequestDesktopLaunch'");
    expect(launcherDefinition).not.toContain("'-TakeOverExistingNativeDesktop'");
    expect(source).toContain("'desktop-owner-v5'");
    expect(source).toContain("Get-LegacyHeadlessStartupTaskDefinitionV4");
    expect(source).toContain("'headless-v4-update-required'");
  });
});
