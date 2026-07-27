import { readFile } from "node:fs/promises";
import { isAbsolute, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { assertHighEntropyCapabilityToken, startBroker } from "./runtime.js";
import type { BrokerRuntimeOptions } from "./runtime.js";

export interface ParsedBrokerCli {
  capabilityTokenFile?: string;
  command: "serve";
  options: Required<
    Pick<
      BrokerRuntimeOptions,
      "codexPath" | "dataDir" | "host" | "port" | "upstreamHost" | "upstreamPort"
    >
  >;
}

export function parseBrokerCli(args: string[]): ParsedBrokerCli {
  const [command, ...rest] = args;
  if (command !== "serve") {
    throw new Error("Usage: codex-local-remote-broker serve [options]");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("Broker options must use --name value");
    }
    if (values.has(flag)) {
      throw new Error(`Duplicate Broker option ${flag}`);
    }
    values.set(flag, value);
  }
  const supported = new Set([
    "--codex-path",
    "--capability-token-file",
    "--data-dir",
    "--host",
    "--port",
    "--upstream-host",
    "--upstream-port",
  ]);
  for (const flag of values.keys()) {
    if (!supported.has(flag)) {
      throw new Error(`Unknown Broker option ${flag}`);
    }
  }

  const capabilityTokenFile = values.get("--capability-token-file");
  if (
    capabilityTokenFile !== undefined &&
    !isAbsolute(capabilityTokenFile) &&
    !win32.isAbsolute(capabilityTokenFile)
  ) {
    throw new Error("--capability-token-file must be an absolute path");
  }

  return {
    ...(capabilityTokenFile === undefined ? {} : { capabilityTokenFile }),
    command: "serve",
    options: {
      codexPath: required(values, "--codex-path"),
      dataDir: required(values, "--data-dir"),
      host: values.get("--host") ?? "127.0.0.1",
      port: integer(values.get("--port") ?? "18791", "--port"),
      upstreamHost: values.get("--upstream-host") ?? "127.0.0.1",
      upstreamPort: integer(values.get("--upstream-port") ?? "18792", "--upstream-port"),
    },
  };
}

export async function runBrokerCli(args: string[]): Promise<void> {
  const parsed = parseBrokerCli(args);
  const capabilityToken =
    parsed.capabilityTokenFile === undefined
      ? undefined
      : await readCapabilityTokenFile(parsed.capabilityTokenFile);
  const broker = await startBroker({
    ...parsed.options,
    ...(capabilityToken === undefined ? {} : { capabilityToken }),
  });
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= broker.stop();
    return stopping;
  };
  const handleSignal = () => {
    void stop().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  const exit = await broker.closed;
  process.off("SIGINT", handleSignal);
  process.off("SIGTERM", handleSignal);
  if (exit.reason === "owned-app-server-exit") {
    throw exit.error;
  }
}

export async function readCapabilityTokenFile(path: string): Promise<string> {
  if (!isAbsolute(path) && !win32.isAbsolute(path)) {
    throw new Error("--capability-token-file must be an absolute path");
  }
  const token = (await readFile(path, "utf8")).trim();
  return assertHighEntropyCapabilityToken(token);
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag)?.trim();
  if (!value) {
    throw new Error(`Missing Broker option ${flag}`);
  }
  return value;
}

function integer(value: string, flag: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${flag} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${flag} must be an integer`);
  }
  return parsed;
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && fileURLToPath(import.meta.url) === invoked;
}

if (isMainModule()) {
  runBrokerCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Broker failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
