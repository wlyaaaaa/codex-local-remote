import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ENVIRONMENT_OVERRIDE = "CODEX_REMOTE_CODEX_EXE";
const LEGACY_ENVIRONMENT_OVERRIDE = "CODEX_LOCAL_REMOTE_CODEX_PATH";

export type CodexExecutableSource = "environment" | "desktop-user-bundle" | "path";

export interface CodexExecutable {
  path: string;
  source: CodexExecutableSource;
}

export interface CodexDiscoveryDiagnostic {
  code:
    | "WINDOWS_APP_PACKAGE_REQUIRES_MATERIALIZED_BINARY"
    | "DESKTOP_USER_BUNDLE_NOT_FOUND"
    | "PATH_FALLBACK_USED";
  severity: "info" | "warning";
}

export interface CodexDiscoveryResult {
  candidates: CodexExecutable[];
  diagnostics: CodexDiscoveryDiagnostic[];
}

export interface DiscoverCodexExecutableOptions {
  environment?: Record<string, string | undefined>;
  exists?: (candidate: string) => Promise<boolean>;
  getAppxInstallLocations?: () => Promise<string[]>;
  getLastModifiedMs?: (candidate: string) => Promise<number>;
  listDirectoryNames?: (directory: string) => Promise<string[]>;
  localAppData?: string;
  pathValue?: string;
  programFiles?: string;
}

export class CodexExecutableNotFoundError extends Error {
  readonly code: "CODEX_EXECUTABLE_NOT_FOUND" | "CODEX_OVERRIDE_NOT_FOUND";
  readonly diagnostics: CodexDiscoveryDiagnostic[];

  constructor(
    code: "CODEX_EXECUTABLE_NOT_FOUND" | "CODEX_OVERRIDE_NOT_FOUND",
    diagnostics: CodexDiscoveryDiagnostic[] = [],
  ) {
    super(
      code === "CODEX_OVERRIDE_NOT_FOUND"
        ? "指定的 Codex 程序不可用"
        : "未找到可由当前用户启动的 Codex 程序",
    );
    this.name = "CodexExecutableNotFoundError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export async function discoverCodexExecutable(
  options: DiscoverCodexExecutableOptions = {},
): Promise<CodexExecutable> {
  const result = await discoverCodexExecutables(options);
  const executable = result.candidates[0];
  if (!executable) {
    throw new CodexExecutableNotFoundError("CODEX_EXECUTABLE_NOT_FOUND", result.diagnostics);
  }
  return executable;
}

export async function discoverCodexExecutables(
  options: DiscoverCodexExecutableOptions = {},
): Promise<CodexDiscoveryResult> {
  const environment = options.environment ?? process.env;
  const exists = options.exists ?? fileExists;
  const listDirectoryNames = options.listDirectoryNames ?? listNames;
  const getAppxInstallLocations = options.getAppxInstallLocations ?? getInstalledCodexAppxLocations;
  const getLastModifiedMs = options.getLastModifiedMs ?? lastModifiedMs;
  const localAppData = options.localAppData ?? environment.LOCALAPPDATA;
  const programFiles = options.programFiles ?? environment.ProgramFiles;
  const pathValue = options.pathValue ?? environment.Path ?? environment.PATH ?? "";
  const diagnostics: CodexDiscoveryDiagnostic[] = [];
  const candidates: CodexExecutable[] = [];
  const seen = new Set<string>();

  const addCandidate = async (candidate: string, source: CodexExecutableSource): Promise<void> => {
    const normalized = path.win32.normalize(candidate);
    const key = normalized.toLocaleLowerCase("en-US");
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    if (await exists(normalized)) {
      candidates.push({ path: normalized, source });
    }
  };

  const override =
    environment[ENVIRONMENT_OVERRIDE]?.trim() ?? environment[LEGACY_ENVIRONMENT_OVERRIDE]?.trim();
  if (override) {
    const normalizedOverride = path.win32.normalize(stripWrappingQuotes(override));
    if (!(await exists(normalizedOverride))) {
      throw new CodexExecutableNotFoundError("CODEX_OVERRIDE_NOT_FOUND");
    }
    return {
      candidates: [{ path: normalizedOverride, source: "environment" }],
      diagnostics,
    };
  }

  if (localAppData) {
    const materializedRoot = path.win32.join(localAppData, "OpenAI", "Codex", "bin");
    const materializedCandidates = (
      await Promise.all(
        (await safelyList(listDirectoryNames, materializedRoot)).map(async (build) => {
          const candidate = path.win32.join(materializedRoot, build, "codex.exe");
          return {
            candidate,
            modifiedAt: await safelyGetLastModified(getLastModifiedMs, candidate),
          };
        }),
      )
    ).sort(
      (left, right) =>
        right.modifiedAt - left.modifiedAt ||
        right.candidate.localeCompare(left.candidate, "en-US"),
    );
    for (const { candidate } of materializedCandidates) {
      await addCandidate(candidate, "desktop-user-bundle");
    }

    await addCandidate(
      path.win32.join(localAppData, "Programs", "Codex", "resources", "codex.exe"),
      "desktop-user-bundle",
    );
    await addCandidate(
      path.win32.join(localAppData, "Programs", "OpenAI Codex", "resources", "codex.exe"),
      "desktop-user-bundle",
    );
  }

  if (!candidates.some((candidate) => candidate.source === "desktop-user-bundle")) {
    diagnostics.push({ code: "DESKTOP_USER_BUNDLE_NOT_FOUND", severity: "warning" });
  }

  const appxLocations = await safelyGetLocations(getAppxInstallLocations);
  let appxPresent = false;
  for (const installLocation of appxLocations) {
    const packagedExecutable = path.win32.join(installLocation, "app", "resources", "codex.exe");
    if (await exists(packagedExecutable)) {
      appxPresent = true;
      break;
    }
  }

  if (!appxPresent && programFiles) {
    const windowsApps = path.win32.join(programFiles, "WindowsApps");
    const packages = await safelyList(listDirectoryNames, windowsApps);
    for (const packageName of packages.filter((name) => /^OpenAI\.Codex_/i.test(name))) {
      const packagedExecutable = path.win32.join(
        windowsApps,
        packageName,
        "app",
        "resources",
        "codex.exe",
      );
      if (await exists(packagedExecutable)) {
        appxPresent = true;
        break;
      }
    }
  }

  if (appxPresent) {
    diagnostics.push({
      code: "WINDOWS_APP_PACKAGE_REQUIRES_MATERIALIZED_BINARY",
      severity: "warning",
    });
  }

  for (const entry of pathValue.split(";")) {
    const directory = stripWrappingQuotes(entry.trim());
    if (directory.length > 0) {
      await addCandidate(path.win32.join(directory, "codex.exe"), "path");
    }
  }

  if (candidates.some((candidate) => candidate.source === "path")) {
    diagnostics.push({ code: "PATH_FALLBACK_USED", severity: "info" });
  }

  return { candidates, diagnostics };
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function listNames(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function getInstalledCodexAppxLocations(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | ForEach-Object { $_.InstallLocation }",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    return stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

async function safelyList(
  listDirectoryNames: (directory: string) => Promise<string[]>,
  directory: string,
): Promise<string[]> {
  try {
    return await listDirectoryNames(directory);
  } catch {
    return [];
  }
}

async function safelyGetLocations(getLocations: () => Promise<string[]>): Promise<string[]> {
  try {
    return await getLocations();
  } catch {
    return [];
  }
}

async function safelyGetLastModified(
  getLastModifiedMs: (candidate: string) => Promise<number>,
  candidate: string,
): Promise<number> {
  try {
    const value = await getLastModifiedMs(candidate);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

async function lastModifiedMs(candidate: string): Promise<number> {
  return (await stat(candidate)).mtimeMs;
}

function stripWrappingQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}
