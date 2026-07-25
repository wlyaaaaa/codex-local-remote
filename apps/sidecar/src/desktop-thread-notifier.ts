import { spawn } from "node:child_process";
import path from "node:path";

const CODEX_THREAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface DetachedChildProcess {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "spawn", listener: () => void): unknown;
  unref(): void;
}

interface DetachedLaunchOptions {
  detached: true;
  shell: false;
  stdio: "ignore";
  windowsHide: true;
}

type DesktopProtocolLauncher = (
  executable: string,
  args: string[],
  options: DetachedLaunchOptions,
) => DetachedChildProcess;

export interface CreateDesktopThreadNotifierOptions {
  enabled: boolean;
  explorerPath?: string;
  launch?: DesktopProtocolLauncher;
  platform?: NodeJS.Platform;
}

export function createDesktopThreadNotifier(
  options: CreateDesktopThreadNotifierOptions,
): ((threadId: string) => Promise<void>) | undefined {
  const platform = options.platform ?? process.platform;
  if (!options.enabled || platform !== "win32") {
    return undefined;
  }

  const explorerPath = options.explorerPath ?? defaultExplorerPath();
  const launch: DesktopProtocolLauncher =
    options.launch ?? ((executable, args, spawnOptions) => spawn(executable, args, spawnOptions));

  return async (threadId) => {
    if (!CODEX_THREAD_ID.test(threadId)) {
      throw new Error("对话标识无效");
    }
    const threadUrl = `codex://threads/${threadId.toLocaleLowerCase("en-US")}`;
    await new Promise<void>((resolve, reject) => {
      const child = launch(explorerPath, [threadUrl], {
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("spawn", resolve);
      child.unref();
    });
  };
}

function defaultExplorerPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return path.win32.join(systemRoot, "explorer.exe");
}
