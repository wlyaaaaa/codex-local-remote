import os from "node:os";
import path from "node:path";

export interface SidecarConfig {
  host: "127.0.0.1" | "::1";
  port: number;
  basePath: string;
  dataDir: string;
  desktopSyncEnabled: boolean;
  webDir: string;
}

export interface SidecarConfigOverrides {
  host?: string;
  port?: number;
  basePath?: string;
  dataDir?: string;
  desktopSyncEnabled?: boolean;
  webDir?: string;
}

export interface ResolveSidecarConfigOptions {
  cli?: SidecarConfigOverrides;
  environment?: Record<string, string | undefined>;
}

export type CliInvocation =
  | { command: "help" }
  | { command: "serve"; config: SidecarConfigOverrides }
  | { command: "setup-password"; config: Pick<SidecarConfigOverrides, "dataDir"> }
  | {
      command: "register-project";
      config: Pick<SidecarConfigOverrides, "dataDir">;
      project: { id: string; name: string; root: string };
    };

export function resolveSidecarConfig(options: ResolveSidecarConfigOptions = {}): SidecarConfig {
  const environment = options.environment ?? process.env;
  const cli = options.cli ?? {};
  const localAppData =
    environment.LOCALAPPDATA ?? path.win32.join(os.homedir(), "AppData", "Local");
  const host = cli.host ?? environment.CODEX_REMOTE_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Sidecar 监听地址必须是本机回环地址");
  }

  const port = cli.port ?? parsePort(environment.CODEX_REMOTE_PORT) ?? 18_790;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Sidecar 端口无效");
  }

  const basePath = normalizeBasePath(
    cli.basePath ?? environment.CODEX_REMOTE_BASE_PATH ?? "/codex-remote",
  );
  const dataDir = path.win32.resolve(
    cli.dataDir ??
      environment.CODEX_REMOTE_DATA_DIR ??
      path.win32.join(localAppData, "CodexLocalRemote"),
  );
  const webDir =
    cli.webDir ??
    environment.CODEX_REMOTE_WEB_DIR ??
    path.resolve(import.meta.dirname, "../../web/dist");
  const desktopSyncEnabled =
    cli.desktopSyncEnabled ?? parseBooleanSwitch(environment.CODEX_REMOTE_DESKTOP_SYNC) ?? true;

  return { basePath, dataDir, desktopSyncEnabled, host, port, webDir };
}

export function parseCliInvocation(args: string[]): CliInvocation {
  const [command, ...rest] = args;
  if (
    command === undefined ||
    ((command === "--help" || command === "-h" || command === "help") && rest.length === 0)
  ) {
    return { command: "help" };
  }
  if (command !== "serve" && command !== "setup-password" && command !== "register-project") {
    throw new Error("请使用 serve、setup-password 或 register-project");
  }
  const values = parseFlags(rest);

  if (command === "serve") {
    assertAllowedFlags(values, [
      "base-path",
      "data-dir",
      "host",
      "no-desktop-sync",
      "port",
      "web-dir",
    ]);
    return {
      command,
      config: compactConfig({
        basePath: values.get("base-path"),
        dataDir: values.get("data-dir"),
        desktopSyncEnabled: values.has("no-desktop-sync") ? false : undefined,
        host: values.get("host"),
        port: parsePort(values.get("port")),
        webDir: values.get("web-dir"),
      }),
    };
  }

  if (command === "setup-password") {
    assertAllowedFlags(values, ["data-dir"]);
    const dataDir = values.get("data-dir");
    return {
      command,
      config: dataDir === undefined ? {} : { dataDir },
    };
  }

  assertAllowedFlags(values, ["data-dir", "id", "name", "root"]);
  const id = values.get("id");
  const name = values.get("name");
  const root = values.get("root");
  if (!id || !name || !root) {
    throw new Error("register-project 需要 --id、--name 和 --root");
  }
  const dataDir = values.get("data-dir");
  return {
    command,
    config: dataDir === undefined ? {} : { dataDir },
    project: { id, name, root },
  };
}

function normalizeBasePath(value: string): string {
  const withoutTrailing = value.length > 1 ? value.replace(/\/+$/u, "") : value;
  if (
    withoutTrailing === "/" ||
    !withoutTrailing.startsWith("/") ||
    withoutTrailing.includes("//") ||
    withoutTrailing.split("/").some((segment, index) => {
      if (index === 0) {
        return false;
      }
      return (
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._~-]+$/u.test(segment)
      );
    })
  ) {
    throw new Error("Sidecar 路径前缀无效");
  }
  return withoutTrailing;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error("Sidecar 端口无效");
  }
  return Number(value);
}

function parseBooleanSwitch(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  switch (value.trim().toLocaleLowerCase("en-US")) {
    case "1":
    case "on":
    case "true":
    case "yes":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new Error("Sidecar 桌面端同步开关无效");
  }
}

function parseFlags(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; ) {
    const flag = args[index];
    if (!flag?.startsWith("--")) {
      throw new Error("不支持的参数或缺少参数值");
    }
    const key = flag.slice(2);
    if (result.has(key)) {
      throw new Error("不支持重复参数");
    }
    if (key === "no-desktop-sync") {
      result.set(key, "");
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("不支持的参数或缺少参数值");
    }
    result.set(key, value);
    index += 2;
  }
  return result;
}

function assertAllowedFlags(values: Map<string, string>, allowed: string[]): void {
  const allowlist = new Set(allowed);
  if ([...values.keys()].some((key) => !allowlist.has(key))) {
    throw new Error("不支持的参数");
  }
}

function compactConfig(input: {
  host?: string | undefined;
  port?: number | undefined;
  basePath?: string | undefined;
  dataDir?: string | undefined;
  desktopSyncEnabled?: boolean | undefined;
  webDir?: string | undefined;
}): SidecarConfigOverrides {
  return {
    ...(input.host === undefined ? {} : { host: input.host }),
    ...(input.port === undefined ? {} : { port: input.port }),
    ...(input.basePath === undefined ? {} : { basePath: input.basePath }),
    ...(input.dataDir === undefined ? {} : { dataDir: input.dataDir }),
    ...(input.desktopSyncEnabled === undefined
      ? {}
      : { desktopSyncEnabled: input.desktopSyncEnabled }),
    ...(input.webDir === undefined ? {} : { webDir: input.webDir }),
  };
}
