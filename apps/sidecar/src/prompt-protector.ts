import { spawn } from "node:child_process";
import path from "node:path";

export interface PromptProtector {
  protect(plaintext: string): Promise<string>;
  unprotect(protectedValue: string): Promise<string>;
}

const PROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$entropy = [Text.Encoding]::UTF8.GetBytes('Codex Local Remote turn outbox v1')
$cipher = [Security.Cryptography.ProtectedData]::Protect(
  $bytes,
  $entropy,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($cipher))
`;

const UNPROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -AssemblyName System.Security
$encoded = [Console]::In.ReadToEnd()
$cipher = [Convert]::FromBase64String($encoded)
$entropy = [Text.Encoding]::UTF8.GetBytes('Codex Local Remote turn outbox v1')
$bytes = [Security.Cryptography.ProtectedData]::Unprotect(
  $cipher,
  $entropy,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
`;

export function createWindowsDpapiPromptProtector(
  options: { executable?: string; timeoutMs?: number } = {},
): PromptProtector {
  if (process.platform !== "win32" && options.executable === undefined) {
    throw new Error("DPAPI prompt protection is available only on Windows");
  }
  const executable =
    options.executable ??
    path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  const timeoutMs = options.timeoutMs ?? 15_000;
  return {
    protect: async (plaintext) =>
      await runPowerShell(executable, PROTECT_SCRIPT, plaintext, timeoutMs),
    unprotect: async (protectedValue) =>
      await runPowerShell(executable, UNPROTECT_SCRIPT, protectedValue, timeoutMs),
  };
}

async function runPowerShell(
  executable: string,
  script: string,
  input: string,
  timeoutMs: number,
): Promise<string> {
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("DPAPI operation timed out"));
    }, timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length + chunk.length > 2 * 1024 * 1024) {
        child.kill();
        finish(new Error("DPAPI output is too large"));
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 16_384) {
        stderr += chunk.slice(0, 16_384 - stderr.length);
      }
    });
    child.once("error", (error) => {
      finish(new Error(`DPAPI helper could not start: ${error.message}`));
    });
    child.once("close", (code) => {
      if (code === 0) {
        finish();
      } else {
        finish(new Error(`DPAPI operation failed (${code ?? "unknown"})`));
      }
    });
    child.stdin.on("error", (error) => {
      finish(new Error(`DPAPI input failed: ${error.message}`));
    });
    child.stdin.end(input, "utf8");
  });
}
