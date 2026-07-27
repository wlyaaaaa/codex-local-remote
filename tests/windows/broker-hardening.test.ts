import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const modulePath = join(repositoryRoot, "scripts", "windows", "CodexLocalRemote.Windows.psm1");
const driver = join(import.meta.dirname, "fixtures", "broker-module-driver.ps1");

function runDriver(arguments_: string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      driver,
      "-ModulePath",
      modulePath,
      ...arguments_,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, ...environment },
    },
  );
}

windowsOnly("Windows shared app-server broker hardening", () => {
  let sandbox: string;
  let installRoot: string;
  let dataDir: string;
  let nodePath: string;
  let codexPath: string;
  let pwshPath: string;

  beforeEach(() => {
    sandbox = join(tmpdir(), `codex-local-remote-broker-${process.pid}-${crypto.randomUUID()}`);
    installRoot = join(sandbox, "install root");
    dataDir = join(sandbox, "data root");
    nodePath = join(sandbox, "Node Runtime", "node.exe");
    codexPath = join(sandbox, "Codex Runtime", "codex.exe");
    pwshPath = join(sandbox, "PowerShell Runtime", "pwsh.exe");
    for (const path of [nodePath, codexPath, pwshPath]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "", "utf8");
    }
    mkdirSync(join(installRoot, "apps", "sidecar", "dist"), {
      recursive: true,
    });
    mkdirSync(join(installRoot, "apps", "broker", "dist"), {
      recursive: true,
    });
    writeFileSync(join(installRoot, "apps", "sidecar", "dist", "cli.js"), "", "utf8");
    writeFileSync(join(installRoot, "apps", "broker", "dist", "cli.js"), "", "utf8");
  });

  it("builds one startup action that launches the broker bootstrap before the sidecar", () => {
    const result = runDriver([
      "-Operation",
      "startup-definition",
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
    ]);

    expect(result.status).toBe(0);
    const definition = JSON.parse(result.stdout) as {
      Description: string;
      Execute: string;
      Arguments: string;
      Bootstrap: string;
    };
    expect(definition.Description).toContain("startup-task/v3");
    expect(definition.Execute).toBe(resolve(pwshPath));
    expect(result.stdout).not.toContain("/ws/");
    expect(definition.Bootstrap).toBe(
      resolve(installRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1"),
    );
    expect(definition.Arguments).toContain("-File");
    expect(definition.Arguments).toContain("-BrokerPort 18791");
    expect(definition.Arguments).toContain("-BrokerUpstreamPort 18792");
    expect(definition.Arguments).toContain("-SidecarPort 18790");
    expect(definition.Arguments).not.toContain("-CodexPath");
    expect(definition.Arguments).not.toContain(resolve(codexPath));
  });

  it.each([
    "ws://0.0.0.0:18791",
    "ws://localhost:18791",
    "ws://[::1]:18791",
    "wss://127.0.0.1:18791",
    "ws://127.0.0.1:18791/",
    "ws://127.0.0.1",
    "ws://127.0.0.1:18791/stream",
    "ws://127.0.0.1:18791?token=bad",
  ])("rejects a broker URL that is not the exact IPv4 loopback origin: %s", (url) => {
    const result = runDriver(["-Operation", "validate-url", "-WebSocketUrl", url]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("loopback WebSocket");
  });

  it("accepts only the canonical loopback WebSocket URL", () => {
    const result = runDriver([
      "-Operation",
      "validate-url",
      "-WebSocketUrl",
      "ws://127.0.0.1:18791",
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("ws://127.0.0.1:18791/");
  });

  it("recognizes only the exact Node broker CLI and managed loopback command", () => {
    const tokenFile = join(dataDir, "broker-capability.token");
    const managed = runDriver([
      "-Operation",
      "classify-process",
      "-NodePath",
      nodePath,
      "-CodexPath",
      join(installRoot, "apps", "broker", "dist", "cli.js"),
      "-PwshPath",
      codexPath,
      "-DataDir",
      dataDir,
      "-WebSocketUrl",
      tokenFile,
      "-ExecutablePath",
      nodePath,
      "-CommandLine",
      `"${nodePath}" "${join(installRoot, "apps", "broker", "dist", "cli.js")}" serve --host 127.0.0.1 --port 18791 --upstream-port 18792 --codex-path "${codexPath}" --data-dir "${dataDir}" --capability-token-file "${tokenFile}"`,
    ]);
    expect(managed.status).toBe(0);
    expect(JSON.parse(managed.stdout)).toEqual({
      IsManaged: true,
      Reason: "exact-managed-command",
    });

    const foreign = runDriver([
      "-Operation",
      "classify-process",
      "-NodePath",
      nodePath,
      "-CodexPath",
      join(installRoot, "apps", "broker", "dist", "cli.js"),
      "-PwshPath",
      codexPath,
      "-DataDir",
      dataDir,
      "-WebSocketUrl",
      tokenFile,
      "-ExecutablePath",
      nodePath,
      "-CommandLine",
      `"${nodePath}" "${join(installRoot, "apps", "broker", "dist", "cli.js")}" serve --host 0.0.0.0 --port 18791 --upstream-port 18792`,
    ]);
    expect(foreign.status).toBe(0);
    expect(JSON.parse(foreign.stdout)).toEqual({
      IsManaged: false,
      Reason: "command-line-mismatch",
    });
  });

  it.each([
    {
      label: "an extra trailing argument",
      mutate: (command: string) => `${command} --foreign true`,
    },
    {
      label: "a prefixed foreign argv",
      mutate: (command: string) => `"C:\\foreign.exe" --wrap ${command}`,
    },
    {
      label: "a suffix joined to the token path",
      mutate: (command: string) => `${command}suffix`,
    },
  ])("rejects a broker command with $label", ({ mutate }) => {
    const brokerCli = join(installRoot, "apps", "broker", "dist", "cli.js");
    const tokenFile = join(dataDir, "broker-capability.token");
    const command =
      `"${nodePath}" "${brokerCli}" serve --host 127.0.0.1 ` +
      `--port 18791 --upstream-port 18792 --codex-path "${codexPath}" ` +
      `--data-dir "${dataDir}" --capability-token-file "${tokenFile}"`;
    const result = runDriver([
      "-Operation",
      "classify-process",
      "-NodePath",
      nodePath,
      "-CodexPath",
      brokerCli,
      "-PwshPath",
      codexPath,
      "-DataDir",
      dataDir,
      "-WebSocketUrl",
      tokenFile,
      "-ExecutablePath",
      nodePath,
      "-CommandLine",
      mutate(command),
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      IsManaged: false,
      Reason: "command-line-mismatch",
    });
  });

  it.each([
    {
      label: "exact managed sidecar",
      mutate: (command: string) => command,
      expected: true,
    },
    {
      label: "foreign host",
      mutate: (command: string) => command.replace("--host 127.0.0.1", "--host 0.0.0.0"),
      expected: false,
    },
    {
      label: "foreign port",
      mutate: (command: string) => command.replace("--port 18790", "--port 18789"),
      expected: false,
    },
    {
      label: "extra arguments",
      mutate: (command: string) => `${command} --foreign true`,
      expected: false,
    },
  ])("classifies only the $label command as this managed Sidecar", ({ mutate, expected }) => {
    const sidecarCli = join(installRoot, "apps", "sidecar", "dist", "cli.js");
    const command = `"${nodePath}" "${sidecarCli}" serve --host 127.0.0.1 --port 18790 --base-path /codex-remote --data-dir "${dataDir}"`;
    const result = runDriver([
      "-Operation",
      "classify-sidecar",
      "-NodePath",
      nodePath,
      "-CodexPath",
      sidecarCli,
      "-DataDir",
      dataDir,
      "-ExecutablePath",
      nodePath,
      "-CommandLine",
      mutate(command),
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      IsManaged: expected,
      Reason: expected ? "exact-managed-command" : "command-line-mismatch",
    });
  });

  it("creates one fixed high-entropy token atomically and reuses it on reinstall", () => {
    const first = runDriver(["-Operation", "ensure-token", "-DataDir", dataDir]);
    expect(first.status).toBe(0);
    const firstResult = JSON.parse(first.stdout) as {
      Status: string;
      TokenPath: string;
      TokenLength: number;
    };
    const tokenPath = join(dataDir, "broker-capability.token");
    const firstMetadataResult = runDriver(["-Operation", "token-metadata", "-DataDir", dataDir]);
    expect(firstMetadataResult.status).toBe(0);
    const firstMetadata = JSON.parse(firstMetadataResult.stdout) as {
      Length: number;
      Sha256: string;
    };
    expect(firstResult).toMatchObject({
      Status: "created",
      TokenPath: resolve(tokenPath),
      TokenLength: firstMetadata.Length,
    });
    expect(firstResult.TokenLength).toBeGreaterThanOrEqual(43);
    expect(firstMetadata.Sha256).toMatch(/^[a-f0-9]{64}$/);

    const second = runDriver(["-Operation", "ensure-token", "-DataDir", dataDir]);
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({
      Status: "reused",
      TokenPath: resolve(tokenPath),
      TokenLength: firstMetadata.Length,
    });
    const secondMetadataResult = runDriver(["-Operation", "token-metadata", "-DataDir", dataDir]);
    expect(secondMetadataResult.status).toBe(0);
    expect(JSON.parse(secondMetadataResult.stdout)).toEqual(firstMetadata);
  });

  it("hardens an existing data directory before creating a capability token", () => {
    mkdirSync(dataDir, { recursive: true });
    const claimed = runDriver(["-Operation", "protect-data-dir", "-DataDir", dataDir]);
    expect(claimed.status).toBe(0);
    const existingStatePath = join(dataDir, "existing-state.json");
    writeFileSync(existingStatePath, "{}", "utf8");
    const widened = runDriver(["-Operation", "add-everyone-rule", "-DataDir", existingStatePath]);
    expect(widened.status).toBe(0);

    const installed = runDriver(["-Operation", "ensure-token", "-DataDir", dataDir]);
    expect(installed.status).toBe(0);
    expect(existsSync(join(dataDir, "broker-capability.token"))).toBe(true);

    const inspected = runDriver(["-Operation", "inspect-data-dir-acl", "-DataDir", dataDir]);
    expect(inspected.status).toBe(0);
    const access = JSON.parse(inspected.stdout) as {
      AreAccessRulesProtected: boolean;
      CurrentUserSid: string;
      Rules: Array<{
        Sid: string;
        AccessControlType: string;
        FileSystemRights: string;
        InheritanceFlags: string;
        PropagationFlags: string;
        IsInherited: boolean;
      }>;
    };

    expect(access.AreAccessRulesProtected).toBe(true);
    expect(access.Rules.map((rule) => rule.Sid).sort()).toEqual(
      [access.CurrentUserSid, "S-1-5-18", "S-1-5-32-544"].sort(),
    );
    for (const rule of access.Rules) {
      expect(rule).toMatchObject({
        AccessControlType: "Allow",
        FileSystemRights: "FullControl",
        PropagationFlags: "None",
        IsInherited: false,
      });
      expect(rule.InheritanceFlags).toContain("ContainerInherit");
      expect(rule.InheritanceFlags).toContain("ObjectInherit");
    }

    const tokenInspected = runDriver([
      "-Operation",
      "inspect-data-dir-acl",
      "-DataDir",
      join(dataDir, "broker-capability.token"),
    ]);
    expect(tokenInspected.status).toBe(0);
    const tokenAccess = JSON.parse(tokenInspected.stdout) as typeof access;
    expect(tokenAccess.AreAccessRulesProtected).toBe(false);
    expect(tokenAccess.Rules.map((rule) => rule.Sid).sort()).toEqual(
      [tokenAccess.CurrentUserSid, "S-1-5-18", "S-1-5-32-544"].sort(),
    );
    expect(tokenAccess.Rules.every((rule) => rule.IsInherited)).toBe(true);

    const existingStateInspected = runDriver([
      "-Operation",
      "inspect-data-dir-acl",
      "-DataDir",
      existingStatePath,
    ]);
    expect(existingStateInspected.status).toBe(0);
    const existingStateAccess = JSON.parse(existingStateInspected.stdout) as typeof access;
    expect(existingStateAccess.Rules.map((rule) => rule.Sid).sort()).toEqual(
      [existingStateAccess.CurrentUserSid, "S-1-5-18", "S-1-5-32-544"].sort(),
    );
    expect(existingStateAccess.Rules.every((rule) => rule.IsInherited)).toBe(true);
  }, 10_000);

  it("hardens an existing data directory before an atomic runtime state write", () => {
    mkdirSync(dataDir, { recursive: true });

    const written = runDriver(["-Operation", "write-state", "-DataDir", dataDir]);
    expect(written.status).toBe(0);
    expect(existsSync(join(dataDir, "test-runtime-state.json"))).toBe(true);

    const inspected = runDriver(["-Operation", "inspect-data-dir-acl", "-DataDir", dataDir]);
    expect(inspected.status).toBe(0);
    const access = JSON.parse(inspected.stdout) as {
      AreAccessRulesProtected: boolean;
      CurrentUserSid: string;
      Rules: Array<{ Sid: string }>;
    };
    expect(access.AreAccessRulesProtected).toBe(true);
    expect(access.Rules.map((rule) => rule.Sid).sort()).toEqual(
      [access.CurrentUserSid, "S-1-5-18", "S-1-5-32-544"].sort(),
    );
  });

  it("fails closed before a token write when the data directory is a reparse point", () => {
    const target = join(sandbox, "reparse target");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, dataDir, "junction");

    const installed = runDriver(["-Operation", "ensure-token", "-DataDir", dataDir]);
    expect(installed.status).not.toBe(0);
    expect(`${installed.stdout}${installed.stderr}`).toContain("reparse point");
    expect(existsSync(join(target, "broker-capability.token"))).toBe(false);
  });

  it("fails closed before writing through an ancestor reparse point", () => {
    const target = join(sandbox, "ancestor target");
    const junction = join(sandbox, "ancestor junction");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, junction, "junction");
    const nestedDataDir = join(junction, "nested data");

    const installed = runDriver(["-Operation", "ensure-token", "-DataDir", nestedDataDir]);
    expect(installed.status).not.toBe(0);
    expect(`${installed.stdout}${installed.stderr}`).toContain("ancestor reparse point");
    expect(existsSync(join(target, "nested data", "broker-capability.token"))).toBe(false);
  });

  it("rejects a descendant reparse point before changing the root ACL", () => {
    mkdirSync(dataDir, { recursive: true });
    const target = join(sandbox, "descendant target");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(dataDir, "descendant junction"), "junction");

    const beforeResult = runDriver(["-Operation", "inspect-data-dir-acl", "-DataDir", dataDir]);
    expect(beforeResult.status).toBe(0);
    const before = JSON.parse(beforeResult.stdout) as unknown;

    const installed = runDriver(["-Operation", "ensure-token", "-DataDir", dataDir]);
    expect(installed.status).not.toBe(0);
    expect(`${installed.stdout}${installed.stderr}`).toContain("contains reparse point");

    const afterResult = runDriver(["-Operation", "inspect-data-dir-acl", "-DataDir", dataDir]);
    expect(afterResult.status).toBe(0);
    expect(JSON.parse(afterResult.stdout)).toEqual(before);
  });

  it.each(["C:\\", "V:\\"])("rejects filesystem root %s through a pure path guard", (root) => {
    const validated = runDriver(["-Operation", "validate-data-dir-path", "-DataDir", root]);
    expect(validated.status).not.toBe(0);
    expect(`${validated.stdout}${validated.stderr}`).toContain("filesystem root");
  });

  it("fails closed on an invalid existing token and removes only the fixed token file", () => {
    mkdirSync(dataDir, { recursive: true });
    const claimed = runDriver(["-Operation", "protect-data-dir", "-DataDir", dataDir]);
    expect(claimed.status).toBe(0);
    const tokenPath = join(dataDir, "broker-capability.token");
    const neighbor = join(dataDir, "keep.txt");
    writeFileSync(tokenPath, "too-short", "utf8");
    writeFileSync(neighbor, "keep", "utf8");

    const invalid = runDriver(["-Operation", "ensure-token", "-DataDir", dataDir]);
    expect(invalid.status).not.toBe(0);
    expect(`${invalid.stdout}${invalid.stderr}`).toContain("not a valid managed capability token");
    expect(`${invalid.stdout}${invalid.stderr}`).not.toContain("too-short");

    const removed = runDriver(["-Operation", "remove-token", "-DataDir", dataDir]);
    expect(removed.status).toBe(0);
    expect(existsSync(tokenPath)).toBe(false);
    expect(readFileSync(neighbor, "utf8")).toBe("keep");
  });

  it("blocks startup when FORCE_CLI would create a second app-server owner", () => {
    const result = runDriver(["-Operation", "assert-force-cli"], {
      CODEX_APP_SERVER_FORCE_CLI: "1",
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("CODEX_APP_SERVER_FORCE_CLI=1");
    expect(`${result.stdout}${result.stderr}`).toContain("second app-server owner");
  });

  it.each([
    {
      command: '"codex.exe" app-server --analytics-default-enabled',
      parent: "ChatGPT.exe",
      expected: true,
    },
    {
      command: '"codex.exe" app-server',
      parent: "ChatGPT.exe",
      expected: true,
    },
    {
      command: '"codex.exe" app-server --listen ws://127.0.0.1:18792',
      parent: "node.exe",
      expected: false,
    },
    {
      command: '"codex.exe" app-server',
      parent: "pwsh.exe",
      expected: false,
    },
  ])(
    "classifies Desktop stdio ownership without confusing the managed upstream: %#",
    ({ command, parent, expected }) => {
      const result = runDriver([
        "-Operation",
        "classify-desktop",
        "-CommandLine",
        command,
        "-ParentProcessName",
        parent,
      ]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toBe(expected);
    },
  );

  it.each([
    {
      exists: false,
      value: "",
      expectedExists: false,
      expectedValue: null,
    },
    {
      exists: true,
      value: "",
      expectedExists: true,
      expectedValue: "",
    },
    {
      exists: true,
      value: "ws://127.0.0.1:29999",
      expectedExists: true,
      expectedValue: "ws://127.0.0.1:29999",
    },
  ])(
    "records the exact prior user environment state for rollback: %#",
    ({ exists, value, expectedExists, expectedValue }) => {
      const result = runDriver([
        "-Operation",
        "environment-backup",
        "-WebSocketUrl",
        "ws://127.0.0.1:18791",
        "-PreviousValueExists",
        String(exists),
        "-PreviousValue",
        value,
      ]);
      expect(result.status).toBe(0);
      const state = JSON.parse(result.stdout) as {
        Signature: string;
        AppliedValueSha256: string;
        PreviousUserValueExists: boolean;
        PreviousUserValue: null | string;
      };
      expect(state).toMatchObject({
        Signature: "codex-local-remote/user-environment/v2",
        PreviousUserValueExists: expectedExists,
        PreviousUserValue: expectedValue,
      });
      expect(state.AppliedValueSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(result.stdout).not.toContain("ws://127.0.0.1:18791");
    },
  );

  it("recognizes only the authenticated fixed-path app-server owner", () => {
    const upstreamToken = join(dataDir, "app-server-upstream.token");
    const managed = runDriver([
      "-Operation",
      "classify-app-server",
      "-CodexPath",
      codexPath,
      "-ExecutablePath",
      codexPath,
      "-WebSocketUrl",
      upstreamToken,
      "-CommandLine",
      `"${codexPath}" -c features.code_mode_host=true app-server --listen ws://127.0.0.1:18792 --ws-auth capability-token --ws-token-file "${upstreamToken}"`,
    ]);
    expect(managed.status).toBe(0);
    expect(JSON.parse(managed.stdout)).toEqual({
      IsManaged: true,
      Reason: "exact-managed-command",
    });

    const unauthenticated = runDriver([
      "-Operation",
      "classify-app-server",
      "-CodexPath",
      codexPath,
      "-ExecutablePath",
      codexPath,
      "-WebSocketUrl",
      upstreamToken,
      "-CommandLine",
      `"${codexPath}" app-server --listen ws://127.0.0.1:18792`,
    ]);
    expect(unauthenticated.status).toBe(0);
    expect(JSON.parse(unauthenticated.stdout)).toMatchObject({
      IsManaged: false,
      Reason: "command-line-mismatch",
    });
  });

  it.each([
    {
      label: "an extra trailing argument",
      mutate: (command: string) => `${command} --foreign true`,
    },
    {
      label: "a prefixed foreign argv",
      mutate: (command: string) => `"C:\\foreign.exe" --wrap ${command}`,
    },
    {
      label: "a suffix joined to the token path",
      mutate: (command: string) => `${command}suffix`,
    },
  ])("rejects an app-server command with $label", ({ mutate }) => {
    const upstreamToken = join(dataDir, "app-server-upstream.token");
    const command =
      `"${codexPath}" -c features.code_mode_host=true app-server ` +
      `--listen ws://127.0.0.1:18792 --ws-auth capability-token ` +
      `--ws-token-file "${upstreamToken}"`;
    const result = runDriver([
      "-Operation",
      "classify-app-server",
      "-CodexPath",
      codexPath,
      "-ExecutablePath",
      codexPath,
      "-WebSocketUrl",
      upstreamToken,
      "-CommandLine",
      mutate(command),
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      IsManaged: false,
      Reason: "command-line-mismatch",
    });
  });

  it.each([
    { json: "0", expected: true },
    { json: "12", expected: true },
    { json: "-1", expected: false },
    { json: "1.5", expected: false },
    { json: '"0"', expected: false },
    { json: "null", expected: false },
  ])("validates unknownCount as a non-negative integer: %#", ({ json, expected }) => {
    const result = runDriver(["-Operation", "validate-unknown-count", "-WebSocketUrl", json]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe(expected);
  });

  it("allows one bounded unknown Sidecar handshake before entering strict monitoring", () => {
    const snapshots = [
      {
        phase: "SidecarHandshake",
        readiness: {
          appServerReady: true,
          degraded: false,
          desktopConnected: false,
          sidecarConnected: false,
          unknownCount: 1,
        },
        expected: "Wait",
      },
      {
        phase: "SidecarHandshake",
        readiness: {
          appServerReady: true,
          degraded: false,
          desktopConnected: false,
          sidecarConnected: true,
          unknownCount: 0,
        },
        expected: "Ready",
      },
      {
        phase: "StrictRuntime",
        readiness: {
          appServerReady: true,
          degraded: false,
          desktopConnected: false,
          sidecarConnected: true,
          unknownCount: 0,
        },
        expected: "Ready",
      },
    ] as const;

    for (const snapshot of snapshots) {
      const result = runDriver([
        "-Operation",
        "sidecar-readiness-decision",
        "-Phase",
        snapshot.phase,
        "-WebSocketUrl",
        JSON.stringify(snapshot.readiness),
      ]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(snapshot.expected);
    }
  });

  it("allows a bounded runtime client reconnect and returns to zero-unknown readiness", () => {
    const snapshots = [
      {
        readiness: {
          appServerReady: true,
          degraded: true,
          desktopConnected: true,
          sidecarConnected: true,
          unknownCount: 0,
        },
        expected: "Degraded",
      },
      {
        readiness: {
          appServerReady: true,
          degraded: false,
          desktopConnected: true,
          sidecarConnected: true,
          unknownCount: 1,
        },
        expected: "Wait",
      },
      {
        readiness: {
          appServerReady: true,
          degraded: false,
          desktopConnected: true,
          sidecarConnected: true,
          unknownCount: 0,
        },
        expected: "Ready",
      },
    ] as const;

    for (const snapshot of snapshots) {
      const result = runDriver([
        "-Operation",
        "sidecar-readiness-decision",
        "-Phase",
        "RuntimeTransition",
        "-WebSocketUrl",
        JSON.stringify(snapshot.readiness),
      ]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toBe(snapshot.expected);
    }

    const strict = runDriver([
      "-Operation",
      "sidecar-readiness-decision",
      "-Phase",
      "StrictRuntime",
      "-WebSocketUrl",
      JSON.stringify(snapshots.at(-1)!.readiness),
    ]);
    expect(strict.status).toBe(0);
    expect(JSON.parse(strict.stdout)).toBe("Ready");
  });

  it("keeps degraded application state alive while strict readiness stays fail closed", () => {
    const degraded = {
      appServerReady: true,
      degraded: true,
      desktopConnected: true,
      sidecarConnected: true,
      unknownCount: 0,
    };
    for (const [phase, expected] of [
      ["Infrastructure", "Ready"],
      ["SidecarHandshake", "Wait"],
      ["RuntimeTransition", "Degraded"],
      ["StrictRuntime", "Reject"],
    ] as const) {
      const result = runDriver([
        "-Operation",
        "sidecar-readiness-decision",
        "-Phase",
        phase,
        "-WebSocketUrl",
        JSON.stringify(degraded),
      ]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toBe(expected);
    }
  });

  it.each([
    {
      label: "more than one unknown client",
      readiness: {
        appServerReady: true,
        degraded: false,
        desktopConnected: true,
        sidecarConnected: true,
        unknownCount: 2,
      },
    },
    {
      label: "illegal unknown count",
      readiness: {
        appServerReady: true,
        degraded: false,
        desktopConnected: true,
        sidecarConnected: true,
        unknownCount: "1",
      },
    },
    {
      label: "missing unknown count",
      readiness: {
        appServerReady: true,
        degraded: false,
        desktopConnected: true,
        sidecarConnected: true,
      },
    },
  ])("rejects unsafe runtime client transition: $label", ({ readiness }) => {
    const result = runDriver([
      "-Operation",
      "sidecar-readiness-decision",
      "-Phase",
      "RuntimeTransition",
      "-WebSocketUrl",
      JSON.stringify(readiness),
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe("Reject");
  });

  it.each([
    {
      label: "multiple unknown clients",
      phase: "SidecarHandshake",
      unknownCount: 2,
    },
    {
      label: "negative count",
      phase: "SidecarHandshake",
      unknownCount: -1,
    },
    {
      label: "fractional count",
      phase: "SidecarHandshake",
      unknownCount: 1.5,
    },
    {
      label: "string count",
      phase: "SidecarHandshake",
      unknownCount: "1",
    },
    {
      label: "strict monitoring regression",
      phase: "StrictRuntime",
      unknownCount: 1,
    },
  ])("fails unsafe Sidecar readiness state: $label", ({ phase, unknownCount }) => {
    const result = runDriver([
      "-Operation",
      "sidecar-readiness-decision",
      "-Phase",
      phase,
      "-WebSocketUrl",
      JSON.stringify({
        appServerReady: true,
        degraded: false,
        desktopConnected: false,
        sidecarConnected: phase === "StrictRuntime",
        unknownCount,
      }),
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toBe("Reject");
  });
});
