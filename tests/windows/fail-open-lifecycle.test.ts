import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const scripts = join(repositoryRoot, "scripts", "windows");
const driver = join(import.meta.dirname, "fixtures", "scheduler-mock-driver.ps1");

interface RegistrationResult {
  Status: string;
  LaunchMode: string;
  LauncherShortcut: string;
  LauncherIcon: string;
  LegacyPersistentOverride: string;
  BrokerCapabilityToken: string;
}

interface ShortcutDefinition {
  Arguments: string;
  Description: string;
  IconLocation: string;
  WorkingDirectory: string;
  WindowStyle: number;
  LinkFlags: number;
  RunAsUser: boolean;
}

function writeRuntimeFile(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "", "utf8");
}

windowsOnly("Windows fail-open lifecycle", () => {
  let sandbox: string;
  let installRoot: string;
  let dataDir: string;
  let nodePath: string;
  let stateFile: string;

  beforeEach(() => {
    sandbox = join(
      tmpdir(),
      `codex-remote-fail-open-lifecycle-${process.pid}-${crypto.randomUUID()}`,
    );
    installRoot = join(sandbox, "install root");
    dataDir = join(sandbox, "managed data");
    nodePath = join(sandbox, "Node Runtime", "node.exe");
    stateFile = join(sandbox, "scheduler.json");
    for (const path of [
      nodePath,
      join(installRoot, "apps", "sidecar", "dist", "cli.js"),
      join(installRoot, "apps", "broker", "dist", "cli.js"),
      join(installRoot, "scripts", "windows", "Start-CodexLocalRemote.ps1"),
      join(installRoot, "scripts", "windows", "Launch-CodexWithRemote.ps1"),
      join(installRoot, "scripts", "windows", "CodexLocalRemote.Control.ps1"),
    ]) {
      writeRuntimeFile(path);
    }
    writeFileSync(stateFile, JSON.stringify({ Task: null, Operations: [] }), "utf8");
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function register() {
    return runLifecycle("register");
  }

  function readShortcut(path: string): ShortcutDefinition {
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:SHORTCUT_PATH); $b=[IO.File]::ReadAllBytes($env:SHORTCUT_PATH); $f=[BitConverter]::ToUInt32($b,20); [pscustomobject]@{Arguments=$s.Arguments;Description=$s.Description;IconLocation=$s.IconLocation;WorkingDirectory=$s.WorkingDirectory;WindowStyle=$s.WindowStyle;LinkFlags=$f;RunAsUser=(($f -band 0x2000)-ne 0)}|ConvertTo-Json -Compress",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, SHORTCUT_PATH: path },
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    return JSON.parse(result.stdout.trim()) as ShortcutDefinition;
  }

  function writeShortcutArguments(path: string, argumentsValue: string) {
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:SHORTCUT_PATH); $s.Arguments=$env:SHORTCUT_ARGUMENTS; $s.Save()",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          SHORTCUT_PATH: path,
          SHORTCUT_ARGUMENTS: argumentsValue,
        },
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }

  function writeLegacyRuntimeShortcut(path: string) {
    const legacyLauncher = join(installRoot, "scripts", "windows", "Launch-CodexWithRemote.ps1");
    const legacyArguments =
      `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden ` +
      `-ExecutionPolicy Bypass -File "${legacyLauncher}" ` +
      `-DataDir "${dataDir}" -BrokerPort 18791 ` +
      `-TaskName "Codex Local Remote" -RequestDesktopLaunch`;
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:SHORTCUT_PATH); $s.Arguments=$env:SHORTCUT_ARGUMENTS; $s.WorkingDirectory=$env:SHORTCUT_WORKING_DIRECTORY; $s.Description=$s.Description.Replace('Explicitly opens Remote through the stable control dispatcher.','Uses Remote when ready and otherwise starts Codex Desktop natively.'); $s.Save()",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          SHORTCUT_PATH: path,
          SHORTCUT_ARGUMENTS: legacyArguments,
          SHORTCUT_WORKING_DIRECTORY: installRoot,
        },
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }

  function writeShortcutWindowStyle(path: string, windowStyle: number) {
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:SHORTCUT_PATH); $s.WindowStyle=[int]$env:SHORTCUT_WINDOW_STYLE; $s.Save()",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          SHORTCUT_PATH: path,
          SHORTCUT_WINDOW_STYLE: String(windowStyle),
        },
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }

  function clearShortcutRunAsUser(path: string) {
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$b=[IO.File]::ReadAllBytes($env:SHORTCUT_PATH); $f=[BitConverter]::ToUInt32($b,20) -band (-bnot 0x2000); [BitConverter]::GetBytes([uint32]$f).CopyTo($b,20); [IO.File]::WriteAllBytes($env:SHORTCUT_PATH,$b)",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, SHORTCUT_PATH: path },
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }

  function runLifecycle(operation: "register" | "unregister") {
    const result = spawnSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        driver,
        "-TargetScript",
        join(
          scripts,
          operation === "register"
            ? "Register-CodexLocalRemoteStartup.ps1"
            : "Unregister-CodexLocalRemoteStartup.ps1",
        ),
        "-StateFile",
        stateFile,
        "-Operation",
        operation,
        "-InstallRoot",
        installRoot,
        "-DataDir",
        dataDir,
        "-NodePath",
        nodePath,
        "-ExerciseFailOpenLifecycle",
        "-JsonResult",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, LOCALAPPDATA: sandbox },
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    return JSON.parse(result.stdout.trim()) as RegistrationResult;
  }

  it("installs a capability token and exact safe launcher without a persistent override", () => {
    const registration = register();
    expect(registration).toMatchObject({
      Status: "registered",
      LaunchMode: "native-default-on-demand-remote",
      LauncherShortcut: "created",
      LauncherIcon: "created",
      LegacyPersistentOverride: "not-found",
      BrokerCapabilityToken: "created",
    });
    expect(existsSync(join(dataDir, "broker-capability.token"))).toBe(true);
    const iconPath = join(dataDir, "managed-chatgpt.ico");
    expect(existsSync(iconPath)).toBe(true);
    expect([...readFileSync(iconPath).subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    const shortcutPath = join(dataDir, "Codex Remote safe launch.lnk");
    expect(existsSync(shortcutPath)).toBe(true);
    const shortcut = readShortcut(shortcutPath);
    expect(shortcut).toMatchObject({
      WindowStyle: 1,
      RunAsUser: true,
    });
    expect(shortcut.LinkFlags & 0x0000_2000).toBe(0x0000_2000);
    expect(shortcut.Arguments).toContain("-WindowStyle Hidden");
    expect(shortcut.Arguments).toContain("CodexLocalRemote.Control.ps1");
    expect(shortcut.Arguments).toContain("-Operation Open");
    expect(shortcut.Arguments).toContain("-AllowDesktopRestart");
    expect(shortcut.Arguments).not.toContain("-RequestDesktopLaunch");
    expect(shortcut.IconLocation.toLowerCase()).toBe(`${iconPath},0`.toLowerCase());
  });

  it("upgrades an exact non-elevated launcher to the RunAsUser shell-link flag", () => {
    register();
    const shortcutPath = join(dataDir, "Codex Remote safe launch.lnk");
    clearShortcutRunAsUser(shortcutPath);
    expect(readShortcut(shortcutPath).RunAsUser).toBe(false);

    const registration = register();
    expect(registration).toMatchObject({
      Status: "already-registered",
      LauncherShortcut: "upgraded",
    });
    expect(readShortcut(shortcutPath)).toMatchObject({
      WindowStyle: 1,
      RunAsUser: true,
    });
    expect(readShortcut(shortcutPath).Arguments).toContain("-WindowStyle Hidden");
  }, 30_000);

  it("upgrades the exact minimized launcher while keeping the PowerShell host hidden", () => {
    register();
    const shortcutPath = join(dataDir, "Codex Remote safe launch.lnk");
    writeShortcutWindowStyle(shortcutPath, 7);

    const registration = register();
    expect(registration).toMatchObject({
      Status: "already-registered",
      LauncherShortcut: "upgraded",
      LauncherIcon: "reused",
    });
    expect(readShortcut(shortcutPath)).toMatchObject({
      WindowStyle: 1,
    });
    expect(readShortcut(shortcutPath).Arguments).toContain("-WindowStyle Hidden");
  });

  it("retires an exact stale managed environment state when no override remains", () => {
    register();
    const legacyStatePath = join(dataDir, "windows-broker-environment.json");
    writeFileSync(
      legacyStatePath,
      JSON.stringify({
        Signature: "codex-local-remote/user-environment/v2",
        Version: 2,
        AppliedValueSha256: "a".repeat(64),
        PreviousUserValueExists: false,
        PreviousUserValue: null,
      }),
      "utf8",
    );

    const registration = register();
    expect(registration).toMatchObject({
      Status: "already-registered",
      LaunchMode: "native-default-on-demand-remote",
      LauncherShortcut: "reused",
      LauncherIcon: "reused",
      LegacyPersistentOverride: "stale-state-removed",
      BrokerCapabilityToken: "reused",
    });
    expect(existsSync(legacyStatePath)).toBe(false);
  });

  it("upgrades the exact older visible-window launcher in place", () => {
    register();
    const shortcutPath = join(dataDir, "Codex Remote safe launch.lnk");
    const current = readShortcut(shortcutPath);
    writeShortcutArguments(shortcutPath, current.Arguments.replace(" -WindowStyle Hidden", ""));

    const registration = register();
    expect(registration).toMatchObject({
      Status: "already-registered",
      LauncherShortcut: "upgraded",
      LauncherIcon: "reused",
    });
    expect(readShortcut(shortcutPath).Arguments).toContain("-WindowStyle Hidden");
  });

  it("upgrades the exact former runtime launcher to the stable dispatcher", () => {
    register();
    const shortcutPath = join(dataDir, "Codex Remote safe launch.lnk");
    writeLegacyRuntimeShortcut(shortcutPath);

    const registration = register();
    expect(registration).toMatchObject({
      Status: "already-registered",
      LauncherShortcut: "upgraded",
      LauncherIcon: "reused",
    });
    expect(readShortcut(shortcutPath).Arguments).toContain("-Operation Open");
    expect(readShortcut(shortcutPath).Arguments).toContain("-AllowDesktopRestart");
    expect(readShortcut(shortcutPath).Arguments).not.toContain("-RequestDesktopLaunch");
    expect(readShortcut(shortcutPath).Arguments).not.toContain("-TakeOverExistingNativeDesktop");
  });

  it("unregisters only the exact launcher, token, and legacy residue", () => {
    register();
    const removal = runLifecycle("unregister");
    expect(removal).toMatchObject({
      Status: "removed",
      LaunchMode: "native-only",
      LauncherShortcut: "removed",
      LauncherIcon: "removed",
      LegacyPersistentOverride: "not-found",
      BrokerCapabilityToken: "removed",
    });
    expect(existsSync(join(dataDir, "broker-capability.token"))).toBe(false);
    expect(existsSync(join(dataDir, "Codex Remote safe launch.lnk"))).toBe(false);
    expect(existsSync(join(dataDir, "managed-chatgpt.ico"))).toBe(false);
  });

  it.each(["visible", "visible-pre-takeover"] as const)(
    "unregisters the exact historical %s launcher shape",
    (shape) => {
      register();
      const shortcutPath = join(dataDir, "Codex Remote safe launch.lnk");
      writeLegacyRuntimeShortcut(shortcutPath);
      const current = readShortcut(shortcutPath);
      let arguments_ = current.Arguments.replace(" -WindowStyle Hidden", "");
      if (shape === "visible-pre-takeover") {
        arguments_ = arguments_.replace(
          " -RequestDesktopLaunch",
          " -TakeOverExistingNativeDesktop",
        );
      }
      writeShortcutArguments(shortcutPath, arguments_);

      const removal = runLifecycle("unregister");
      expect(removal).toMatchObject({
        Status: "removed",
        LauncherShortcut: "removed",
      });
      expect(existsSync(shortcutPath)).toBe(false);
    },
  );

  it("keeps uninstall recognition symmetric with candidate and previous runtime roots", () => {
    const removal = readFileSync(join(scripts, "Unregister-CodexLocalRemoteStartup.ps1"), "utf8");
    expect(removal).toContain("[string]$currentRuntime.PreviousRoot");
    expect(removal).toContain("Test-VisibleManagedLauncherShortcut");
    expect(removal).toContain("Test-VisiblePreTakeoverManagedLauncherShortcut");
    expect(removal).toContain("Test-RecognizedManagedLauncherShortcut");
  });

  it("contains no normal registration path that writes the user override", () => {
    const registration = readFileSync(
      join(scripts, "Register-CodexLocalRemoteStartup.ps1"),
      "utf8",
    );
    expect(registration).not.toContain("Install-BrokerUserEnvironment");
    expect(registration).not.toContain("Set-UserEnvironmentValue");
    expect(registration).not.toMatch(/EnvironmentVariableTarget\]::User/u);
    expect(registration).not.toMatch(/setx(?:\.exe)?\b/iu);
  });
});
