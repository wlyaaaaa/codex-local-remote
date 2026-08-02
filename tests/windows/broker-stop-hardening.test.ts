import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const targetScript = join(repositoryRoot, "scripts", "windows", "Stop-CodexAppServerBroker.ps1");
const driver = join(import.meta.dirname, "fixtures", "broker-stop-mock-driver.ps1");
const brokerPort = 49731;
const upstreamPort = 49732;
const brokerPid = 5101;
const upstreamPid = 5303;
const creationDate = "20260726010101.000000-000";

interface ProcessSnapshot {
  ProcessId: number;
  CreationDate: string;
  ExecutablePath: string;
  CommandLine: string;
  Name?: string;
  ParentProcessId?: number;
}

interface Outcome {
  Succeeded: boolean;
  Error: string | null;
  Result: { Status: string; BrokerStatus: string; UpstreamStatus: string } | null;
  StopIds: number[];
  Trace: string[];
  StateExists: boolean;
}

windowsOnly("Windows broker stop process identity hardening", () => {
  let sandbox: string;
  let installRoot: string;
  let dataDir: string;
  let nodePath: string;
  let codexPath: string;
  let brokerCli: string;
  let tokenFile: string;
  let scenarioFile: string;

  beforeEach(() => {
    sandbox = join(tmpdir(), `codex-local-remote-broker-stop-${crypto.randomUUID()}`);
    installRoot = join(sandbox, "Install Root");
    dataDir = join(sandbox, "Data Root");
    nodePath = join(sandbox, "Node Runtime", "node.exe");
    codexPath = join(sandbox, "Codex Runtime", "codex.exe");
    brokerCli = join(installRoot, "apps", "broker", "dist", "cli.js");
    tokenFile = join(dataDir, "broker-capability.token");
    scenarioFile = join(sandbox, "scenario.json");
    for (const path of [nodePath, codexPath, brokerCli, tokenFile]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "", "utf8");
    }
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function managedBroker(
    processId = brokerPid,
    created = creationDate,
    suffix = "",
  ): ProcessSnapshot {
    return {
      ProcessId: processId,
      CreationDate: created,
      ExecutablePath: resolve(nodePath),
      CommandLine:
        `"${resolve(nodePath)}" "${resolve(brokerCli)}" serve ` +
        `--host 127.0.0.1 --port ${brokerPort} --upstream-port ${upstreamPort} ` +
        `--codex-path "${resolve(codexPath)}" --data-dir "${resolve(dataDir)}" ` +
        `--capability-token-file "${resolve(tokenFile)}"${suffix}`,
    };
  }

  function listener(processId = brokerPid) {
    return { LocalAddress: "127.0.0.1", OwningProcess: processId };
  }

  function managedUpstream(): ProcessSnapshot {
    const upstreamToken = join(dataDir, "app-server-upstream.token");
    mkdirSync(dirname(upstreamToken), { recursive: true });
    writeFileSync(upstreamToken, "", "utf8");
    return {
      ProcessId: upstreamPid,
      CreationDate: creationDate,
      ExecutablePath: resolve(codexPath),
      CommandLine:
        `"${resolve(codexPath)}" -c features.code_mode_host=true app-server ` +
        `--listen ws://127.0.0.1:${upstreamPort} --ws-auth capability-token ` +
        `--ws-token-file "${resolve(upstreamToken)}"`,
    };
  }

  function inheritedConhost(overrides: Partial<ProcessSnapshot> = {}): ProcessSnapshot {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const executablePath = resolve(systemRoot, "System32", "conhost.exe");
    return {
      ProcessId: 5404,
      ParentProcessId: upstreamPid,
      Name: "conhost.exe",
      CreationDate: "20260726010102.000000-000",
      ExecutablePath: executablePath,
      CommandLine: `"${executablePath}" 0x4`,
      ...overrides,
    };
  }

  function writeState(
    process: ProcessSnapshot,
    creationOverride?: string,
    upstream?: ProcessSnapshot,
  ) {
    const recordedCreation = creationOverride ?? process.CreationDate;
    const utcTicks = BigInt(
      spawnSync(
        "pwsh",
        [
          "-NoLogo",
          "-NoProfile",
          "-Command",
          `[System.Management.ManagementDateTimeConverter]::ToDateTime('${recordedCreation}').ToUniversalTime().Ticks`,
        ],
        { encoding: "utf8" },
      ).stdout.trim(),
    );
    const identity = {
      RuntimeInvocationId: "0123456789abcdef0123456789abcdef",
      ProcessId: process.ProcessId,
      CreationDate: recordedCreation,
      CreationDateUtcTicks: Number(utcTicks),
      ProcessStartTimeUtcTicks: Number(utcTicks),
    };
    const upstreamIdentity =
      upstream === undefined
        ? null
        : {
            ...identity,
            ProcessId: upstream.ProcessId,
          };
    writeFileSync(
      join(dataDir, "app-server-broker.json"),
      JSON.stringify({
        Signature: "codex-local-remote/app-server-broker/v3",
        Version: 3,
        Status: "ready",
        RuntimeInvocationId: "0123456789abcdef0123456789abcdef",
        Bootstrap: identity,
        Broker: identity,
        Sidecar: identity,
        Upstream: upstreamIdentity,
        ...identity,
        NodePath: resolve(nodePath),
        BrokerCliPath: resolve(brokerCli),
        CodexPath: resolve(codexPath),
        UpstreamPort: upstreamPort,
      }),
      "utf8",
    );
  }

  function runScenario(
    brokerListeners: Array<Array<{ LocalAddress: string; OwningProcess: number }>>,
    processes: Array<ProcessSnapshot | null>,
    upstreamListeners: Array<Array<{ LocalAddress: string; OwningProcess: number }>> = [[]],
    desktopConnected = false,
    sidecarConnected = false,
    unsafeThreadCount = 0,
    exitProcessIdsOnKill: number[] = [],
    extraScenario: Record<string, unknown> = {},
  ) {
    writeFileSync(
      scenarioFile,
      JSON.stringify({
        BrokerListenerSnapshots: brokerListeners,
        UpstreamListenerSnapshots: upstreamListeners,
        ProcessSnapshots: processes,
        BrokerReadiness: {
          brokerProcessId: brokerPid,
          desktopConnected,
          sidecarConnected,
          unsafeThreadCount,
        },
        ExitProcessIdsOnKill: exitProcessIdsOnKill,
        ...extraScenario,
      }),
      "utf8",
    );
    const execution = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        driver,
        "-TargetScript",
        targetScript,
        "-ScenarioFile",
        scenarioFile,
        "-NodePath",
        nodePath,
        "-CodexPath",
        codexPath,
        "-InstallRoot",
        installRoot,
        "-DataDir",
        dataDir,
        "-BrokerPort",
        String(brokerPort),
        "-UpstreamPort",
        String(upstreamPort),
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    return {
      execution,
      outcome: JSON.parse(execution.stdout.trim()) as Outcome,
    };
  }

  it("stops only the unchanged listener owner through its held startup-identity handle", () => {
    const owner = managedBroker();
    writeState(owner);
    const { execution, outcome } = runScenario([[listener()], [listener()], []], [owner, owner]);

    expect(execution.status).toBe(0);
    expect(outcome).toMatchObject({
      Succeeded: true,
      Result: {
        Status: "completed",
        BrokerStatus: "stopped",
        UpstreamStatus: "not-found",
      },
      StopIds: [brokerPid],
      StateExists: false,
    });
  });

  it("accepts a held upstream that exits with the broker while its listener snapshot clears one read later", () => {
    const owner = managedBroker();
    const upstream = managedUpstream();
    writeState(owner, undefined, upstream);
    const { execution, outcome } = runScenario(
      [[listener()], [listener()], []],
      [owner, upstream, owner, null],
      [[listener(upstreamPid)], [listener(upstreamPid)], [], []],
      false,
      false,
      0,
      [upstreamPid],
    );

    expect(execution.status).toBe(0);
    expect(outcome).toMatchObject({
      Succeeded: true,
      Result: {
        Status: "completed",
        BrokerStatus: "stopped",
        UpstreamStatus: "already-stopped",
      },
      StopIds: [brokerPid],
      StateExists: false,
    });
    expect(outcome.Trace).toContain(`cascade-exit:${upstreamPid}`);
  });

  it("cleans the one exact inherited conhost when the receipt-bound upstream parent is dead but still owns the listener row", () => {
    const owner = managedBroker();
    const upstream = managedUpstream();
    const conhost = inheritedConhost();
    writeState(owner, undefined, upstream);

    const { execution, outcome } = runScenario(
      [[]],
      [null, null, null, null],
      [[listener(upstreamPid)], [listener(upstreamPid)], []],
      false,
      false,
      0,
      [],
      { EnumeratedProcesses: [conhost] },
    );

    expect(execution.status).toBe(0);
    expect(outcome.Succeeded).toBe(true);
    expect(outcome.Result?.Status).toBe("completed");
    expect(outcome.StopIds).toEqual([conhost.ProcessId]);
    expect(outcome.Trace).toContain("upstream-listeners:2");
    expect(outcome.StateExists).toBe(false);
  });

  it.each([
    {
      name: "parent PID",
      child: () => inheritedConhost({ ParentProcessId: upstreamPid + 1 }),
    },
    {
      name: "System32 executable path",
      child: () =>
        inheritedConhost({
          ExecutablePath: resolve(sandbox, "Foreign", "conhost.exe"),
        }),
    },
    {
      name: "two-second creation window",
      child: () => inheritedConhost({ CreationDate: "20260726010104.000000-000" }),
    },
  ])(
    "fails closed when the inherited-listener candidate has the wrong $name",
    ({ child: createChild }) => {
      const owner = managedBroker();
      const upstream = managedUpstream();
      const child = createChild();
      writeState(owner, undefined, upstream);

      const { execution, outcome } = runScenario(
        [[]],
        [null, null, null, null],
        [[listener(upstreamPid)], [listener(upstreamPid)]],
        false,
        false,
        0,
        [],
        { EnumeratedProcesses: [child] },
      );

      expect(execution.status).not.toBe(0);
      expect(outcome.Succeeded).toBe(false);
      expect(outcome.StopIds).toEqual([]);
      expect(outcome.StateExists).toBe(true);
    },
  );

  it("fails closed if listener ownership drifts after the exact inherited conhost is proven", () => {
    const owner = managedBroker();
    const upstream = managedUpstream();
    const conhost = inheritedConhost();
    writeState(owner, undefined, upstream);

    const { execution, outcome } = runScenario(
      [[]],
      [null, null, null, null],
      [[listener(upstreamPid)], [listener(upstreamPid + 101)]],
      false,
      false,
      0,
      [],
      { EnumeratedProcesses: [conhost] },
    );

    expect(execution.status).not.toBe(0);
    expect(outcome.Succeeded).toBe(false);
    expect(outcome.StopIds).toEqual([]);
    expect(outcome.StateExists).toBe(true);
  });

  it("rejects a state CreationDate that does not match the live broker", () => {
    const owner = managedBroker();
    writeState(owner, "20260726010201.000000-000");
    const { execution, outcome } = runScenario([[listener()]], [owner]);

    expect(execution.status).not.toBe(0);
    expect(outcome.Succeeded).toBe(false);
    expect(outcome.Error).toContain("does not match state CreationDate");
    expect(outcome.StopIds).toEqual([]);
    expect(outcome.StateExists).toBe(true);
  });

  it("rejects extra broker argv before opening or stopping the process", () => {
    const owner = managedBroker();
    const foreign = managedBroker(brokerPid, creationDate, " --foreign true");
    writeState(owner);
    const { execution, outcome } = runScenario([[listener()]], [foreign]);

    expect(execution.status).not.toBe(0);
    expect(outcome.Succeeded).toBe(false);
    expect(outcome.StopIds).toEqual([]);
    expect(outcome.StateExists).toBe(true);
  });

  it("rejects same-PID reuse with a different CreationDate during the fresh pre-stop check", () => {
    const owner = managedBroker();
    const replacement = managedBroker(brokerPid, "20260726010201.000000-000");
    writeState(owner);
    const { execution, outcome } = runScenario([[listener()], [listener()]], [owner, replacement]);

    expect(execution.status).not.toBe(0);
    expect(outcome.Succeeded).toBe(false);
    expect(outcome.Error).toContain("changed creation identity");
    expect(outcome.StopIds).toEqual([]);
    expect(outcome.StateExists).toBe(true);
  });

  it("rejects a replacement listener PID immediately before stop", () => {
    const owner = managedBroker();
    writeState(owner);
    const { execution, outcome } = runScenario([[listener()], [listener(5202)]], [owner]);

    expect(execution.status).not.toBe(0);
    expect(outcome.Succeeded).toBe(false);
    expect(outcome.Error).toContain("listener ownership changed");
    expect(outcome.StopIds).toEqual([]);
    expect(outcome.StateExists).toBe(true);
  });

  it("rejects an upstream listener when no startup receipt can bind its identity", () => {
    const owner = managedBroker();
    writeState(owner);
    rmSync(join(dataDir, "app-server-broker.json"));
    const { execution, outcome } = runScenario([[]], [], [[listener(5303)]]);

    expect(execution.status).not.toBe(0);
    expect(outcome.Succeeded).toBe(false);
    expect(outcome.Error).toContain("without a recorded upstream startup identity");
    expect(outcome.StopIds).toEqual([]);
  });

  it("refuses to stop the broker while Codex Desktop is connected", () => {
    const owner = managedBroker();
    writeState(owner);
    const { execution, outcome } = runScenario(
      [[listener()], [listener()], []],
      [owner, owner],
      [[]],
      true,
    );

    expect(execution.status).not.toBe(0);
    expect(outcome.Succeeded).toBe(false);
    expect(outcome.Error).toContain("Codex Desktop is connected");
    expect(outcome.StopIds).toEqual([]);
    expect(outcome.StateExists).toBe(true);
  });

  it("refuses to stop the broker while the Sidecar is still attached", () => {
    const owner = managedBroker();
    writeState(owner);
    const { execution, outcome } = runScenario(
      [[listener()], [listener()], []],
      [owner, owner],
      [[]],
      false,
      true,
    );

    expect(execution.status).not.toBe(0);
    expect(outcome.Succeeded).toBe(false);
    expect(outcome.Error).toContain("Sidecar is connected");
    expect(outcome.StopIds).toEqual([]);
  });

  it("refuses to stop after disconnect when any turn lifecycle is still unsafe", () => {
    const owner = managedBroker();
    writeState(owner);
    const { execution, outcome } = runScenario(
      [[listener()], [listener()], []],
      [owner, owner],
      [[]],
      false,
      false,
      1,
    );

    expect(execution.status).not.toBe(0);
    expect(outcome.Succeeded).toBe(false);
    expect(outcome.Error).toContain("turn lifecycle");
    expect(outcome.StopIds).toEqual([]);
  });
});
