import type { JsonlRpcConnection } from "./jsonl-connection.js";

export interface InitializeAppServerOptions {
  clientVersion: string;
  experimentalApi?: boolean;
  timeoutMs?: number;
}

export interface AppServerInitialization {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export async function initializeAppServer(
  connection: JsonlRpcConnection,
  options: InitializeAppServerOptions,
): Promise<AppServerInitialization> {
  const result = await connection.request<unknown>(
    "initialize",
    {
      clientInfo: {
        name: "codex-local-remote",
        title: "Codex Local Remote",
        version: options.clientVersion,
      },
      capabilities: {
        experimentalApi: options.experimentalApi ?? true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
      },
    },
    options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
  );

  if (!isInitialization(result)) {
    throw new Error("Codex 初始化响应格式不受支持");
  }

  await connection.notify("initialized");
  return result;
}

function isInitialization(value: unknown): value is AppServerInitialization {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.userAgent === "string" &&
    typeof candidate.codexHome === "string" &&
    typeof candidate.platformFamily === "string" &&
    typeof candidate.platformOs === "string"
  );
}
