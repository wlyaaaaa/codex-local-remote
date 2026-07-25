import { realpath, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { ProjectRegistry } from "@codex-local-remote/domain";

import { parseCliInvocation, resolveSidecarConfig } from "./config.js";
import { setupPassword } from "./auth.js";
import { startSidecar } from "./runtime.js";
import { SidecarStateStore } from "./state-store.js";

const HELP = `Codex Local Remote

用法:
  codex-local-remote serve [--host 127.0.0.1] [--port 18790] [--base-path /codex-remote] [--data-dir PATH] [--no-desktop-sync]
  codex-local-remote setup-password [--data-dir PATH]
  codex-local-remote register-project --id ID --name NAME --root PATH [--data-dir PATH]

访问密码只从本机交互输入或标准输入读取，不能通过参数或环境变量传入。
默认会让 Codex Desktop 载入新对话；如需关闭，请使用 --no-desktop-sync。`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  const invocation = parseCliInvocation(args);
  if (invocation.command === "help") {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  if (invocation.command === "setup-password") {
    const config = resolveSidecarConfig({ cli: invocation.config });
    const state = await SidecarStateStore.open(config.dataDir);
    const [password, confirmation] = await readPasswordPair();
    await setupPassword(state, password, confirmation);
    process.stdout.write("访问密码已安全保存到本机。\n");
    return;
  }

  if (invocation.command === "register-project") {
    const config = resolveSidecarConfig({ cli: invocation.config });
    const canonicalRoot = await realpath(invocation.project.root);
    if (!(await stat(canonicalRoot)).isDirectory()) {
      throw new Error("项目路径不是文件夹");
    }
    const registry = new ProjectRegistry([
      {
        id: invocation.project.id,
        name: invocation.project.name,
        root: canonicalRoot,
        source: "registered",
      },
    ]);
    const project = {
      id: invocation.project.id,
      name: invocation.project.name,
      root: registry.requireRegisteredRoot(invocation.project.id),
      source: "registered" as const,
    };
    const state = await SidecarStateStore.open(config.dataDir);
    await state.registerProject(project);
    process.stdout.write("项目已加入可选列表。\n");
    return;
  }

  const config = resolveSidecarConfig({ cli: invocation.config });
  const running = await startSidecar(config);
  process.stdout.write(
    `Codex Local Remote 已在 ${config.host}:${config.port}${config.basePath}/ 启动。\n`,
  );
  await waitForShutdown(async () => {
    await running.stop();
  });
}

async function readPasswordPair(): Promise<[string, string]> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    let input = "";
    for await (const chunk of process.stdin) {
      input += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (input.length > 32_768) {
        throw new Error("密码输入过长");
      }
    }
    const lines = input.split(/\r?\n/u);
    if (lines.length < 2) {
      throw new Error("请通过标准输入提供两次密码");
    }
    return [lines[0] ?? "", lines[1] ?? ""];
  }
  const first = await readHiddenLine("请输入新的访问密码: ");
  const second = await readHiddenLine("请再次输入访问密码: ");
  return [first, second];
}

async function readHiddenLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  let value = "";
  try {
    return await new Promise<string>((resolve, reject) => {
      const onData = (chunk: string) => {
        for (const character of chunk) {
          if (character === "\r" || character === "\n") {
            process.stdin.off("data", onData);
            process.stdout.write("\n");
            resolve(value);
            return;
          }
          if (character === "\u0003") {
            process.stdin.off("data", onData);
            reject(new Error("操作已取消"));
            return;
          }
          if (character === "\u007F" || character === "\b") {
            value = value.slice(0, -1);
          } else if (value.length < 16_384 && character >= " ") {
            value += character;
          }
        }
      };
      process.stdin.on("data", onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

async function waitForShutdown(stop: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) {
        return;
      }
      stopping = true;
      void stop().then(resolve, reject);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  void main().catch(() => {
    process.stderr.write("Codex Local Remote 无法完成启动，请检查本机设置后重试。\n");
    process.exitCode = 1;
  });
}
