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
  SidecarListenerReady: boolean;
  SidecarOwned: boolean;
  SidecarPid: number | null;
  SidecarLoopbackOnly: boolean;
  CapabilityTokenReady: boolean;
  LauncherScriptReady: boolean;
  LauncherShortcutReady: boolean;
  LauncherConfigured: boolean;
  LaunchMode: string;
  DesktopLaunchReceiptReady: boolean;
  DesktopLaunchStatus: string;
  DesktopLaunchRemoteEnabled: boolean | null;
  DesktopLaunchDecision: string;
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

  it("accepts only an exact V2 task that is currently Running", () => {
    const status = getStatus("valid-running");
    expect(status).toMatchObject({
      TaskState: "Running",
      LastTaskResult: 267009,
      TaskOwned: true,
      TaskRunning: true,
      TaskReady: true,
    });
  });

  it("does not let LastTaskResult 267009 block a currently Running task", () => {
    const status = getStatus("valid-running");
    expect(status.LastTaskResult).toBe(267009);
    expect(status.TaskReady).toBe(true);
  });

  it("reports the exact process-scoped fail-open launcher without a persistent override", () => {
    const status = getStatus("valid-running");
    expect(status).toMatchObject({
      CapabilityTokenReady: true,
      LauncherScriptReady: true,
      LauncherShortcutReady: true,
      LauncherConfigured: true,
      LaunchMode: "process-scoped-fail-open",
      LegacyPersistentOverrideBlocked: false,
    });
  });

  it("reports the latest token-free Desktop launch result", () => {
    const status = getStatus("valid-launch-receipt");
    expect(status).toMatchObject({
      DesktopLaunchReceiptReady: true,
      DesktopLaunchStatus: "launched-remote",
      DesktopLaunchRemoteEnabled: true,
      DesktopLaunchDecision: "remote-ready",
      DesktopLaunchRecordedAtUtc: "2026-07-27T12:34:56.0000000Z",
    });
  });

  it("fails the launch receipt closed without changing current readiness", () => {
    const status = getStatus("invalid-launch-receipt");
    expect(status).toMatchObject({
      DesktopLaunchReceiptReady: false,
      DesktopLaunchStatus: "invalid",
      DesktopLaunchRemoteEnabled: null,
      DesktopLaunchDecision: "",
      DesktopLaunchRecordedAtUtc: null,
    });
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
  });
});
