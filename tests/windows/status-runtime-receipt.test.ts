import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const statusScript = join(repositoryRoot, "scripts", "windows", "Get-CodexLocalRemoteStatus.ps1");
const driver = join(import.meta.dirname, "fixtures", "status-runtime-receipt-mock-driver.ps1");

interface RuntimeStatus {
  Ready: boolean;
  Degraded: boolean;
  SidecarRequestReady: boolean;
  DesktopRuntimeStatus: string;
  BootstrapIdentityReady: boolean;
  BrokerIdentityReady: boolean;
  SidecarIdentityReady: boolean;
  UpstreamIdentityReady: boolean;
  StartupInvocationReady: boolean;
  RuntimeReceiptReady: boolean;
}

interface DriverResult {
  Status: RuntimeStatus;
  TokenReadCount: number;
  OutputContainsTokenSentinel: boolean;
}

windowsOnly("Windows runtime receipt status", () => {
  let sandbox: string;
  let installRoot: string;
  let dataDir: string;
  let nodePath: string;
  let codexPath: string;
  let pwshPath: string;

  beforeEach(() => {
    sandbox = join(tmpdir(), `codex-runtime-receipt-${process.pid}-${crypto.randomUUID()}`);
    installRoot = join(sandbox, "Install Root");
    dataDir = join(sandbox, "Data Root");
    nodePath = join(sandbox, "Node Runtime", "node.exe");
    codexPath = join(sandbox, "Codex Runtime", "codex.exe");
    pwshPath = join(sandbox, "PowerShell Runtime", "pwsh.exe");
    mkdirSync(installRoot, { recursive: true });
  });

  function getStatus(mode: string) {
    const execution = spawnSync(
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
        installRoot,
        "-DataDir",
        dataDir,
        "-NodePath",
        nodePath,
        "-CodexPath",
        codexPath,
        "-PwshPath",
        pwshPath,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, LOCALAPPDATA: sandbox },
        timeout: 15_000,
      },
    );
    expect(
      execution.status,
      `${execution.error?.message ?? ""}\n${execution.stdout}\n${execution.stderr}`,
    ).toBe(0);
    return JSON.parse(execution.stdout.trim()) as DriverResult;
  }

  it.each(["valid", "path-case"])(
    "accepts one stable same-generation runtime in %s mode",
    (mode) => {
      const result = getStatus(mode);
      expect(result.Status).toMatchObject({
        Degraded: false,
        SidecarRequestReady: true,
        DesktopRuntimeStatus: "current",
        BootstrapIdentityReady: true,
        BrokerIdentityReady: true,
        SidecarIdentityReady: true,
        UpstreamIdentityReady: true,
        StartupInvocationReady: true,
        RuntimeReceiptReady: true,
      });
      expect(result.TokenReadCount).toBe(0);
      expect(result.OutputContainsTokenSentinel).toBe(false);
    },
  );

  it.each(["runtime-package-drift", "runtime-hash-drift"])(
    "marks %s update-pending and fails the aggregate readiness gate",
    (mode) => {
      const result = getStatus(mode);
      expect(result.Status).toMatchObject({
        Ready: false,
        Degraded: true,
        DesktopRuntimeStatus: "update-pending",
        RuntimeReceiptReady: true,
      });
    },
  );

  it.each(["legacy-v2", "runtime-blocked"])(
    "marks %s blocked and fails the aggregate readiness gate",
    (mode) => {
      const result = getStatus(mode);
      expect(result.Status).toMatchObject({
        Ready: false,
        Degraded: true,
        DesktopRuntimeStatus: "blocked",
      });
    },
  );

  it.each([
    "id",
    "pid",
    "creation",
    "start",
    "argv",
    "schema",
    "version",
    "status",
    "missing",
    "mixed",
    "tail-replacement",
    "listener-replacement",
    "health-id",
    "health-pid",
  ])("fails closed for runtime receipt counterexample %s", (mode) => {
    const result = getStatus(mode);
    expect(result.Status.RuntimeReceiptReady).toBe(false);
    expect(result.Status.Ready).toBe(false);
    expect(result.TokenReadCount).toBe(0);
    expect(result.OutputContainsTokenSentinel).toBe(false);
  });

  it("isolates a foreign Sidecar argv without hiding the other exact identities", () => {
    const result = getStatus("argv");
    expect(result.Status).toMatchObject({
      BootstrapIdentityReady: true,
      BrokerIdentityReady: true,
      SidecarIdentityReady: false,
      UpstreamIdentityReady: true,
      StartupInvocationReady: true,
      RuntimeReceiptReady: false,
    });
  });

  it("requires the Bootstrap full argv from the canonical task definition", () => {
    const result = getStatus("bootstrap-argv");
    expect(result.Status).toMatchObject({
      BootstrapIdentityReady: false,
      BrokerIdentityReady: true,
      SidecarIdentityReady: true,
      UpstreamIdentityReady: true,
      StartupInvocationReady: true,
      RuntimeReceiptReady: false,
    });
  });

  it("rejects a tail replacement after otherwise valid identity checks", () => {
    const result = getStatus("tail-replacement");
    expect(result.Status).toMatchObject({
      BootstrapIdentityReady: false,
      BrokerIdentityReady: false,
      SidecarIdentityReady: false,
      UpstreamIdentityReady: false,
      StartupInvocationReady: true,
      RuntimeReceiptReady: false,
    });
  });
});
