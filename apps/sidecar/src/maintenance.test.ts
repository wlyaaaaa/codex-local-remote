import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MaintenanceDrainTimeoutError,
  readMaintenanceToken,
  SidecarMaintenanceController,
} from "./maintenance.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("maintenance activity gate", () => {
  it("returns to serving only after the final drain waiter times out", async () => {
    vi.useFakeTimers();
    const maintenance = new SidecarMaintenanceController(10);
    const active = maintenance.tryAdmitActivity();
    expect(active).toBeDefined();

    const first = maintenance.drain("0123456789abcdef0123456789abcdef");
    const firstTimeout = expect(first).rejects.toBeInstanceOf(MaintenanceDrainTimeoutError);
    await vi.advanceTimersByTimeAsync(5);
    const second = maintenance.drain("0123456789abcdef0123456789abcdef");
    const secondTimeout = expect(second).rejects.toBeInstanceOf(MaintenanceDrainTimeoutError);

    await vi.advanceTimersByTimeAsync(5);
    await firstTimeout;
    expect(maintenance.state).toBe("draining");
    expect(maintenance.tryAdmitActivity()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5);
    await secondTimeout;
    expect(maintenance.state).toBe("serving");
    const admittedAfterTimeout = maintenance.tryAdmitActivity();
    expect(admittedAfterTimeout).toBeDefined();

    admittedAfterTimeout?.release();
    active?.release();
  });
});

describe("maintenance capability file", () => {
  it("reads one 32-byte lowercase-hex token from the configured file", async () => {
    const directory = path.join(
      os.tmpdir(),
      `codex-local-remote-maintenance-${process.pid}-${Date.now()}`,
    );
    temporaryDirectories.push(directory);
    await mkdir(directory, { recursive: true });
    const tokenFile = path.join(directory, "maintenance.token");
    const token = "0123456789abcdef".repeat(4);
    await writeFile(tokenFile, `${token}\r\n`, "utf8");

    expect(await readMaintenanceToken(tokenFile)).toBe(token);
  });

  it("rejects low-entropy or non-canonical token file contents", async () => {
    const directory = path.join(
      os.tmpdir(),
      `codex-local-remote-maintenance-invalid-${process.pid}-${Date.now()}`,
    );
    temporaryDirectories.push(directory);
    await mkdir(directory, { recursive: true });
    const tokenFile = path.join(directory, "maintenance.token");
    await writeFile(tokenFile, "too-short", "utf8");
    await expect(readMaintenanceToken(tokenFile)).rejects.toThrow("token file is invalid");

    await writeFile(tokenFile, "A".repeat(64), "utf8");
    await expect(readMaintenanceToken(tokenFile)).rejects.toThrow("token file is invalid");
  });
});
