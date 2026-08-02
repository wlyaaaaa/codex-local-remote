import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const targetScript = join(repositoryRoot, "scripts", "windows", "Stop-CodexLocalRemoteSidecar.ps1");
const driver = join(import.meta.dirname, "fixtures", "sidecar-stop-mock-driver.ps1");
const testPort = 49732;

interface Listener {
  LocalAddress: string;
  OwningProcess: number;
}

interface ProcessSnapshot {
  ProcessId: number;
  CreationDate: string;
  CommandLine: string;
  ExecutablePath: string;
}

interface Outcome {
  Succeeded: boolean;
  Error: string | null;
  Result: { Status: string; ProcessId: number | null } | null;
  StopIds: number[];
  Trace: string[];
  ListenerReads: number;
  ProcessReads: number;
  HandleReads: number;
}

windowsOnly("Stop-CodexLocalRemoteSidecar fresh-owner hardening", () => {
  let sandbox: string;
  let nodePath: string;
  let sidecarCliPath: string;
  let dataDir: string;
  let scenarioFile: string;

  beforeEach(() => {
    sandbox = join(
      tmpdir(),
      `codex-local-remote-sidecar-stop-${process.pid}-${crypto.randomUUID()}`,
    );
    nodePath = join(sandbox, "Node Runtime", "node.exe");
    sidecarCliPath = join(sandbox, "Install Root", "apps", "sidecar", "dist", "cli.js");
    dataDir = join(sandbox, "Data Root");
    scenarioFile = join(sandbox, "scenario.json");
    mkdirSync(dirname(nodePath), { recursive: true });
    mkdirSync(dirname(sidecarCliPath), { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function managedProcess(
    processId = 4101,
    creationDate = "20260726010101.000000-000",
  ): ProcessSnapshot {
    return {
      ProcessId: processId,
      CreationDate: creationDate,
      ExecutablePath: resolve(nodePath),
      CommandLine:
        `"${resolve(nodePath)}" "${resolve(sidecarCliPath)}" serve ` +
        `--host 127.0.0.1 --port ${testPort} --base-path /codex-remote ` +
        `--data-dir "${resolve(dataDir)}" --maintenance-token-file ` +
        `"${resolve(dataDir, "sidecar-maintenance-token.txt")}"`,
    };
  }

  function listener(processId = 4101, address = "127.0.0.1"): Listener {
    return { LocalAddress: address, OwningProcess: processId };
  }

  function runScenario(
    listenerSnapshots: Listener[][],
    processSnapshots: Array<ProcessSnapshot | null>,
    expectedProcessId?: number,
    stopError?: string,
  ) {
    writeFileSync(
      scenarioFile,
      JSON.stringify({
        ListenerSnapshots: listenerSnapshots,
        ProcessSnapshots: processSnapshots,
        StopError: stopError,
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
        "-SidecarCliPath",
        sidecarCliPath,
        "-DataDir",
        dataDir,
        "-Port",
        String(testPort),
        ...(expectedProcessId === undefined
          ? []
          : ["-ExpectedProcessId", String(expectedProcessId)]),
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    const stdout = execution.stdout.trim();
    expect(stdout, execution.stderr).not.toBe("");
    return {
      execution,
      outcome: JSON.parse(stdout) as Outcome,
    };
  }

  it("returns not-found without querying or stopping a process when the first snapshot is empty", () => {
    const { execution, outcome } = runScenario([[]], [], 4101);

    expect(execution.status).toBe(0);
    expect(outcome).toMatchObject({
      Succeeded: true,
      Result: { Status: "not-found", ProcessId: null },
      StopIds: [],
      ListenerReads: 1,
      ProcessReads: 0,
    });
  });

  it("treats an empty fresh pre-stop snapshot as an idempotent success", () => {
    const owner = managedProcess();
    const { execution, outcome } = runScenario([[listener(owner.ProcessId)], []], [owner]);

    expect(execution.status).toBe(0);
    expect(outcome).toMatchObject({
      Succeeded: true,
      Result: { Status: "already-stopped", ProcessId: owner.ProcessId },
      StopIds: [],
      ListenerReads: 2,
      ProcessReads: 1,
    });
  });

  it("bounded-rechecks a vanished fresh owner and succeeds only after proving the port empty", () => {
    const owner = managedProcess();
    const { execution, outcome } = runScenario(
      [[listener(owner.ProcessId)], [listener(owner.ProcessId)], []],
      [owner, null],
    );

    expect(execution.status).toBe(0);
    expect(outcome).toMatchObject({
      Succeeded: true,
      Result: { Status: "already-stopped", ProcessId: owner.ProcessId },
      StopIds: [],
      ListenerReads: 3,
      ProcessReads: 2,
    });
    expect(outcome.Trace).toEqual([
      "listeners:0",
      "process:0:ProcessId = 4101",
      "listeners:1",
      "process:1:ProcessId = 4101",
      "listeners:2",
    ]);
  });

  it("does not adopt a replacement owner during the bounded vanished-owner recheck", () => {
    const owner = managedProcess();
    const replacement = managedProcess(4202);
    const { execution, outcome } = runScenario(
      [[listener(owner.ProcessId)], [listener(owner.ProcessId)], [listener(replacement.ProcessId)]],
      [owner, null],
    );

    expect(execution.status).not.toBe(0);
    expect(outcome.Succeeded).toBe(false);
    expect(outcome.Error).toContain("ownership changed");
    expect(outcome.StopIds).toEqual([]);
    expect(outcome).toMatchObject({
      ListenerReads: 3,
      ProcessReads: 2,
    });
  });

  it("rejects an exact managed replacement when the outer verified PID is supplied", () => {
    const outerOwner = managedProcess();
    const replacement = managedProcess(4202);
    const { execution, outcome } = runScenario(
      [[listener(replacement.ProcessId)]],
      [replacement],
      outerOwner.ProcessId,
    );

    expect(execution.status).not.toBe(0);
    expect(outcome.Succeeded).toBe(false);
    expect(outcome.Error).toContain("does not match expected PID 4101");
    expect(outcome.StopIds).toEqual([]);
    expect(outcome).toMatchObject({
      ListenerReads: 1,
      ProcessReads: 1,
    });
  });

  it.each([
    {
      label: "a different single owner",
      kind: "changed-owner",
      error: "ownership changed",
    },
    {
      label: "a foreign command under the same PID",
      kind: "foreign",
      error: "not the exact managed Sidecar",
    },
    {
      label: "multiple listener owners",
      kind: "multiple",
      error: "one exclusive listener owner",
    },
    {
      label: "a non-loopback listener",
      kind: "non-loopback",
      error: "non-loopback listener",
    },
  ])("fails closed without stopping when the fresh snapshot has $label", (scenario) => {
    const owner = managedProcess();
    const changedOwner = managedProcess(4202);
    const foreign = {
      ...owner,
      CommandLine: `"${resolve("C:\\Windows\\System32\\not-managed.exe")}" --port ${testPort}`,
    };
    const fresh =
      scenario.kind === "changed-owner"
        ? { listeners: [listener(changedOwner.ProcessId)], process: changedOwner }
        : scenario.kind === "foreign"
          ? { listeners: [listener(owner.ProcessId)], process: foreign }
          : scenario.kind === "multiple"
            ? {
                listeners: [listener(owner.ProcessId), listener(changedOwner.ProcessId)],
                process: null,
              }
            : { listeners: [listener(owner.ProcessId, "0.0.0.0")], process: null };
    const { execution, outcome } = runScenario(
      [[listener(owner.ProcessId)], fresh.listeners],
      fresh.process === null ? [owner] : [owner, fresh.process],
    );

    expect(execution.status).not.toBe(0);
    expect(outcome.Succeeded).toBe(false);
    expect(outcome.Error).toContain(scenario.error);
    expect(outcome.StopIds).toEqual([]);
  });

  it("fails closed when the Sidecar uses a different maintenance token path", () => {
    const owner = managedProcess();
    owner.CommandLine = owner.CommandLine.replace(
      resolve(dataDir, "sidecar-maintenance-token.txt"),
      resolve(dataDir, "foreign-maintenance-token.txt"),
    );
    const { execution, outcome } = runScenario([[listener(owner.ProcessId)]], [owner]);

    expect(execution.status).not.toBe(0);
    expect(outcome.Succeeded).toBe(false);
    expect(outcome.Error).toContain("command-line-mismatch");
    expect(outcome.StopIds).toEqual([]);
  });

  it("rejects PID reuse when the same PID has a different CreationDate", () => {
    const owner = managedProcess();
    const reused = managedProcess(owner.ProcessId, "20260726010201.000000-000");
    const { execution, outcome } = runScenario(
      [[listener(owner.ProcessId)], [listener(reused.ProcessId)]],
      [owner, reused],
      owner.ProcessId,
    );

    expect(execution.status).not.toBe(0);
    expect(outcome.Succeeded).toBe(false);
    expect(outcome.Error).toContain("ownership changed");
    expect(outcome.StopIds).toEqual([]);
    expect(outcome.HandleReads).toBe(1);
  });

  it("stops only the exact unchanged managed owner and proves the port empty afterward", () => {
    const owner = managedProcess();
    const { execution, outcome } = runScenario(
      [[listener(owner.ProcessId)], [listener(owner.ProcessId)], []],
      [owner, owner],
      owner.ProcessId,
    );

    expect(execution.status).toBe(0);
    expect(outcome).toMatchObject({
      Succeeded: true,
      Result: { Status: "stopped", ProcessId: owner.ProcessId },
      StopIds: [owner.ProcessId],
      ListenerReads: 3,
      ProcessReads: 2,
    });
    expect(outcome.Trace).toEqual([
      "listeners:0",
      "process:0:ProcessId = 4101",
      "listeners:1",
      "process:1:ProcessId = 4101",
      "stop:4101",
      "wait:4101",
      "listeners:2",
    ]);
  });

  it("accepts the bounded dynamically rediscovered Codex schema-source argument", () => {
    const owner = managedProcess();
    owner.CommandLine = owner.CommandLine.replace(
      `--data-dir "${resolve(dataDir)}"`,
      `--codex-path "C:\\Program Files\\OpenAI\\Codex\\bin\\current\\codex.exe" ` +
        `--data-dir "${resolve(dataDir)}"`,
    );
    const { execution, outcome } = runScenario(
      [[listener(owner.ProcessId)], [listener(owner.ProcessId)], []],
      [owner, owner],
      owner.ProcessId,
    );

    expect(execution.status).toBe(0);
    expect(outcome).toMatchObject({
      Succeeded: true,
      Result: { Status: "stopped", ProcessId: owner.ProcessId },
      StopIds: [owner.ProcessId],
    });
  });

  it("returns already-stopped when the held owner exits during Kill and the port is fresh-proven empty", () => {
    const owner = managedProcess();
    const { execution, outcome } = runScenario(
      [[listener(owner.ProcessId)], [listener(owner.ProcessId)], []],
      [owner, owner],
      owner.ProcessId,
      "mock process naturally exited",
    );

    expect(execution.status).toBe(0);
    expect(outcome).toMatchObject({
      Succeeded: true,
      Result: { Status: "already-stopped", ProcessId: owner.ProcessId },
      StopIds: [owner.ProcessId],
      ListenerReads: 3,
      ProcessReads: 2,
    });
    expect(outcome.Trace).toEqual([
      "listeners:0",
      "process:0:ProcessId = 4101",
      "listeners:1",
      "process:1:ProcessId = 4101",
      "stop:4101",
      "listeners:2",
    ]);
  });

  it("fails closed when held-handle Kill races with a replacement listener", () => {
    const owner = managedProcess();
    const replacement = managedProcess(4202);
    const { execution, outcome } = runScenario(
      [[listener(owner.ProcessId)], [listener(owner.ProcessId)], [listener(replacement.ProcessId)]],
      [owner, owner],
      owner.ProcessId,
      "mock process naturally exited",
    );

    expect(execution.status).not.toBe(0);
    expect(outcome.Succeeded).toBe(false);
    expect(outcome.Error).toContain("remained occupied");
    expect(outcome.StopIds).toEqual([owner.ProcessId]);
    expect(outcome.Trace).not.toContain("stop:4202");
    expect(outcome.ListenerReads).toBe(3);
  });

  it("fails if the port cannot be proven empty after stopping the exact owner", () => {
    const owner = managedProcess();
    const { execution, outcome } = runScenario(
      [[listener(owner.ProcessId)], [listener(owner.ProcessId)], [listener(4303)]],
      [owner, owner],
    );

    expect(execution.status).not.toBe(0);
    expect(outcome.Succeeded).toBe(false);
    expect(outcome.Error).toContain("remained occupied");
    expect(outcome.StopIds).toEqual([owner.ProcessId]);
    expect(outcome.ListenerReads).toBe(3);
  });
});
