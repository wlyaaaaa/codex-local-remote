import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const targetScript = join(
  repositoryRoot,
  "scripts",
  "windows",
  "Invoke-CodexLocalRemoteOnDemandHandoff.ps1",
);
const driver = join(import.meta.dirname, "fixtures", "on-demand-orphan-repair-driver.ps1");

interface Outcome {
  Succeeded: boolean;
  Error: string | null;
  Result: boolean | null;
  StopCalls: number;
  StopAllowActiveTurns: boolean | null;
  StopInstallRoot: string | null;
  ExpectedRetiredRuntimeRoot: string;
  PortWaitCalls: number;
}

windowsOnly("Windows on-demand receipt-bound orphan repair", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = join(tmpdir(), `codex-orphan-repair-${crypto.randomUUID()}`);
    mkdirSync(sandbox, { recursive: true });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function runScenario(
    mode: "live-without-authorization" | "live-with-authorization" | "dead-legacy-conhost",
  ) {
    const execution = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        driver,
        "-ScriptPath",
        targetScript,
        "-SandboxRoot",
        sandbox,
        "-Mode",
        mode,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    return {
      execution,
      outcome: JSON.parse(execution.stdout.trim()) as Outcome,
    };
  }

  it("fails closed before the stop script when the receipt PID is alive without authorization", () => {
    const { execution, outcome } = runScenario("live-without-authorization");

    expect(execution.status, `${execution.stdout}${execution.stderr}`).toBe(0);
    expect(outcome).toMatchObject({
      Succeeded: false,
      Result: null,
      StopCalls: 0,
      StopAllowActiveTurns: null,
      StopInstallRoot: null,
      PortWaitCalls: 0,
    });
    expect(outcome.Error).toContain(
      "requires explicit Desktop restart authorization before cleanup",
    );
  });

  it("continues through the selected stop script for a live receipt PID with authorization", () => {
    const { execution, outcome } = runScenario("live-with-authorization");

    expect(execution.status, `${execution.stdout}${execution.stderr}`).toBe(0);
    expect(outcome).toMatchObject({
      Succeeded: true,
      Error: null,
      Result: true,
      StopCalls: 1,
      StopAllowActiveTurns: true,
      PortWaitCalls: 1,
    });
    expect(outcome.StopInstallRoot).toBe(outcome.ExpectedRetiredRuntimeRoot);
  });

  it("continues to the legacy conhost-compatible stop path when the recorded PID is dead", () => {
    const { execution, outcome } = runScenario("dead-legacy-conhost");

    expect(execution.status, `${execution.stdout}${execution.stderr}`).toBe(0);
    expect(outcome).toMatchObject({
      Succeeded: true,
      Error: null,
      Result: true,
      StopCalls: 1,
      StopAllowActiveTurns: false,
      PortWaitCalls: 1,
    });
    expect(outcome.StopInstallRoot).toBe(outcome.ExpectedRetiredRuntimeRoot);
  });
});
