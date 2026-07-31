import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseBrokerCli, readCapabilityTokenFile } from "./cli.js";

const cleanup: string[] = [];
const CAPABILITY_TOKEN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

afterEach(async () => {
  for (const path of cleanup.splice(0).reverse()) {
    await rm(path, { force: true, recursive: true });
  }
});

describe("parseBrokerCli", () => {
  it("accepts the Windows service contract with an absolute token-file path", () => {
    expect(
      parseBrokerCli([
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        "18791",
        "--upstream-port",
        "18792",
        "--codex-path",
        "C:\\Codex\\codex.exe",
        "--data-dir",
        "C:\\CodexRemote",
        "--capability-token-file",
        "C:\\CodexRemote\\broker-capability.token",
      ]),
    ).toEqual({
      capabilityTokenFile: "C:\\CodexRemote\\broker-capability.token",
      command: "serve",
      options: {
        codexPath: "C:\\Codex\\codex.exe",
        dataDir: "C:\\CodexRemote",
        host: "127.0.0.1",
        port: 18791,
        upstreamHost: "127.0.0.1",
        upstreamPort: 18792,
      },
    });
  });

  it("rejects a relative capability-token file", () => {
    expect(() =>
      parseBrokerCli([
        "serve",
        "--codex-path",
        "C:\\Codex\\codex.exe",
        "--data-dir",
        "C:\\CodexRemote",
        "--capability-token-file",
        "broker-capability.token",
      ]),
    ).toThrow("absolute");
  });

  it("parses the bounded loopback lifecycle reconciliation command", () => {
    expect(
      parseBrokerCli([
        "reconcile",
        "--data-dir",
        "C:\\CodexRemote",
        "--port",
        "18791",
        "--timeout-ms",
        "30000",
      ]),
    ).toEqual({
      command: "reconcile",
      dataDir: "C:\\CodexRemote",
      port: 18791,
      timeoutMs: 30000,
    });
  });

  it("requires an absolute DataDir for lifecycle reconciliation", () => {
    expect(() =>
      parseBrokerCli(["reconcile", "--data-dir", "relative", "--port", "18791"]),
    ).toThrow("absolute");
  });
});

describe("readCapabilityTokenFile", () => {
  it("reads a newline-terminated high-entropy token without exposing it in parsed argv", async () => {
    const directory = await mkdtemp(join(tmpdir(), "broker-cli-test-"));
    cleanup.push(directory);
    const tokenPath = join(directory, "capability.token");
    await writeFile(tokenPath, `${CAPABILITY_TOKEN}\r\n`, "utf8");

    await expect(readCapabilityTokenFile(tokenPath)).resolves.toBe(CAPABILITY_TOKEN);
  });

  it.each(["", "short-token", "a".repeat(64)])("rejects weak token content %#", async (value) => {
    const directory = await mkdtemp(join(tmpdir(), "broker-cli-test-"));
    cleanup.push(directory);
    const tokenPath = join(directory, "capability.token");
    await writeFile(tokenPath, value, "utf8");

    await expect(readCapabilityTokenFile(tokenPath)).rejects.toThrow("high-entropy");
  });
});
