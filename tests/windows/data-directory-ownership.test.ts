import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const windowsOnly = process.platform === "win32" ? describe : describe.skip;
const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const modulePath = join(repositoryRoot, "scripts", "windows", "CodexLocalRemote.Windows.psm1");
const driver = join(import.meta.dirname, "fixtures", "data-directory-owner-driver.ps1");
const markerName = ".codex-local-remote-data-owner.json";
const markerSignature = "codex-local-remote/data-directory-owner/v1";

function runDriver(operation: string, dataDir: string, environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      driver,
      "-ModulePath",
      modulePath,
      "-Operation",
      operation,
      "-DataDir",
      dataDir,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, ...environment },
    },
  );
}

function parseLastJson<T>(stdout: string): T {
  const line = stdout
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) {
    throw new Error(`No JSON object in output: ${stdout}`);
  }
  return JSON.parse(line) as T;
}

function inspectAcl(dataDir: string, environment: NodeJS.ProcessEnv = {}) {
  const result = runDriver("inspect-acl", dataDir, environment);
  expect(result.status).toBe(0);
  return parseLastJson<{
    Sddl: string;
    AreAccessRulesProtected: boolean;
    Rules: Array<{ Sid: string; IsInherited: boolean }>;
  }>(result.stdout);
}

function markerPath(dataDir: string) {
  return join(dataDir, markerName);
}

windowsOnly("Windows DataDir ownership gate", () => {
  let sandbox: string;
  let localAppData: string;
  let userProfile: string;
  let environment: NodeJS.ProcessEnv;

  beforeEach(() => {
    sandbox = join(tmpdir(), `codex-local-remote-data-owner-${process.pid}-${crypto.randomUUID()}`);
    localAppData = join(sandbox, "LocalAppData");
    userProfile = join(sandbox, "Profile");
    environment = {
      LOCALAPPDATA: localAppData,
      USERPROFILE: userProfile,
      HOMEDRIVE: dirname(userProfile),
      HOMEPATH: userProfile.slice(dirname(userProfile).length),
    };
  });

  it.each([
    { label: "empty", populate: (_path: string) => undefined },
    {
      label: "non-empty",
      populate: (path: string) => writeFileSync(join(path, "keep.txt"), "keep", "utf8"),
    },
  ])("rejects the $label Documents folder without changing its ACL", ({ populate }) => {
    const documents = join(userProfile, "Documents");
    mkdirSync(documents, { recursive: true });
    populate(documents);
    const before = inspectAcl(documents, environment);

    const result = runDriver("protect", documents, environment);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("known folder");
    expect(existsSync(markerPath(documents))).toBe(false);
    expect(inspectAcl(documents, environment)).toEqual(before);
  });

  it.each([
    { label: "empty", populate: (_path: string) => undefined },
    {
      label: "non-empty",
      populate: (path: string) => writeFileSync(join(path, "keep.txt"), "keep", "utf8"),
    },
  ])(
    "rejects a $label directory inside a Git worktree without changing its ACL",
    ({ populate }) => {
      const repository = join(sandbox, "repository");
      const dataDir = join(repository, "candidate");
      mkdirSync(join(repository, ".git"), { recursive: true });
      writeFileSync(join(repository, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
      mkdirSync(dataDir, { recursive: true });
      populate(dataDir);
      const before = inspectAcl(dataDir, environment);

      const result = runDriver("protect", dataDir, environment);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("Git");
      expect(existsSync(markerPath(dataDir))).toBe(false);
      expect(inspectAcl(dataDir, environment)).toEqual(before);
    },
  );

  it("rejects a directory inside a bare Git repository without changing its ACL", () => {
    const bareRepository = join(sandbox, "bare.git");
    const dataDir = join(bareRepository, "candidate");
    mkdirSync(join(bareRepository, "objects"), { recursive: true });
    mkdirSync(join(bareRepository, "refs"), { recursive: true });
    writeFileSync(join(bareRepository, "HEAD"), "ref: refs/heads/main\n", "utf8");
    writeFileSync(join(bareRepository, "config"), "[core]\n\tbare = true\n", "utf8");
    mkdirSync(dataDir, { recursive: true });
    const before = inspectAcl(dataDir, environment);

    const result = runDriver("protect", dataDir, environment);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("bare repository");
    expect(existsSync(markerPath(dataDir))).toBe(false);
    expect(inspectAcl(dataDir, environment)).toEqual(before);
  });

  it("plans a missing directory without writing, then creates and claims it", () => {
    const dataDir = join(sandbox, "missing custom data");
    const plan = runDriver("plan", dataDir, environment);
    expect(plan.status).toBe(0);
    expect(parseLastJson<{ Action: string }>(plan.stdout).Action).toBe("create");
    expect(existsSync(dataDir)).toBe(false);

    const protectedResult = runDriver("protect", dataDir, environment);
    expect(protectedResult.status).toBe(0);
    expect(parseLastJson<{ Status: string }>(protectedResult.stdout).Status).toBe("created");
    expect(existsSync(markerPath(dataDir))).toBe(true);
    expect(inspectAcl(dataDir, environment).AreAccessRulesProtected).toBe(true);
  });

  it("claims an existing empty custom directory", () => {
    const dataDir = join(sandbox, "empty custom data");
    mkdirSync(dataDir, { recursive: true });

    const result = runDriver("protect", dataDir, environment);

    expect(result.status).toBe(0);
    expect(parseLastJson<{ Status: string }>(result.stdout).Status).toBe("claimed");
    expect(existsSync(markerPath(dataDir))).toBe(true);
  });

  it("legacy-adopts only the exact default directory with currently managed entries", () => {
    const dataDir = join(localAppData, "CodexLocalRemote");
    mkdirSync(dataDir, { recursive: true });
    for (const name of ["state.json", "startup-last.json", "app-server-broker.json"]) {
      writeFileSync(join(dataDir, name), "{}", "utf8");
    }
    writeFileSync(
      join(dataDir, "broker-capability.token"),
      "synthetic-capability-token-with-43-characters-only",
      "utf8",
    );
    writeFileSync(
      join(dataDir, "app-server-upstream.token"),
      "synthetic-upstream-token-with-43-characters-onlyxx",
      "utf8",
    );
    const aclBeforePreview = inspectAcl(dataDir, environment);

    const preview = runDriver("protect-whatif", dataDir, environment);
    expect(preview.status).toBe(0);
    expect(parseLastJson<{ Status: string }>(preview.stdout).Status).toBe("would-adopt");
    expect(existsSync(markerPath(dataDir))).toBe(false);
    expect(inspectAcl(dataDir, environment)).toEqual(aclBeforePreview);

    const result = runDriver("protect", dataDir, environment);
    expect(result.status).toBe(0);
    expect(parseLastJson<{ Status: string }>(result.stdout).Status).toBe("adopted");
    expect(existsSync(markerPath(dataDir))).toBe(true);
  });

  it("legacy-adopts only source-exact temporary file names", () => {
    const dataDir = join(localAppData, "CodexLocalRemote");
    mkdirSync(dataDir, { recursive: true });
    for (const name of [
      ".startup-last.json.0123456789abcdef0123456789abcdef.tmp",
      ".broker-capability.token.0123456789abcdef0123456789abcdef.tmp",
      ".state-123-0123456789ab.tmp",
      "app-server-upstream.token.123.01234567-89ab-cdef-0123-456789abcdef.tmp",
      "..codex-local-remote-data-owner.json.0123456789abcdef0123456789abcdef.tmp",
    ]) {
      writeFileSync(join(dataDir, name), "synthetic", "utf8");
    }

    const result = runDriver("protect", dataDir, environment);

    expect(result.status).toBe(0);
    expect(parseLastJson<{ Status: string }>(result.stdout).Status).toBe("adopted");
  });

  it("rejects a non-empty custom directory without an owner marker", () => {
    const dataDir = join(sandbox, "nonempty custom");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "state.json"), "{}", "utf8");
    const before = inspectAcl(dataDir, environment);

    const result = runDriver("protect", dataDir, environment);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("non-empty");
    expect(existsSync(markerPath(dataDir))).toBe(false);
    expect(inspectAcl(dataDir, environment)).toEqual(before);
  });

  it("keeps WhatIf fully read-only for create and ACL repair", () => {
    const missing = join(sandbox, "whatif missing");
    const createPreview = runDriver("protect-whatif", missing, environment);
    expect(createPreview.status).toBe(0);
    expect(parseLastJson<{ Status: string }>(createPreview.stdout).Status).toBe("would-create");
    expect(existsSync(missing)).toBe(false);

    const owned = join(sandbox, "owned");
    mkdirSync(owned, { recursive: true });
    expect(runDriver("protect", owned, environment).status).toBe(0);
    expect(runDriver("add-everyone-rule", owned, environment).status).toBe(0);
    const before = inspectAcl(owned, environment);

    const repairPreview = runDriver("protect-whatif", owned, environment);
    expect(repairPreview.status).toBe(0);
    expect(parseLastJson<{ Status: string }>(repairPreview.stdout).Status).toBe("would-repair");
    expect(inspectAcl(owned, environment)).toEqual(before);
  });

  it.each([
    {
      label: "malformed JSON",
      value: "{",
    },
    {
      label: "wrong signature",
      value: {
        Signature: "foreign",
        Version: 1,
        CanonicalPath: "__DATA_DIR__",
        OwnerSid: "__CURRENT_SID__",
        InstanceId: crypto.randomUUID(),
      },
    },
    {
      label: "wrong version type",
      value: {
        Signature: markerSignature,
        Version: "1",
        CanonicalPath: "__DATA_DIR__",
        OwnerSid: "__CURRENT_SID__",
        InstanceId: crypto.randomUUID(),
      },
    },
    {
      label: "wrong version number",
      value: {
        Signature: markerSignature,
        Version: 2,
        CanonicalPath: "__DATA_DIR__",
        OwnerSid: "__CURRENT_SID__",
        InstanceId: crypto.randomUUID(),
      },
    },
    {
      label: "wrong canonical path",
      value: {
        Signature: markerSignature,
        Version: 1,
        CanonicalPath: "__DATA_DIR__\\other",
        OwnerSid: "__CURRENT_SID__",
        InstanceId: crypto.randomUUID(),
      },
    },
    {
      label: "wrong owner SID",
      value: {
        Signature: markerSignature,
        Version: 1,
        CanonicalPath: "__DATA_DIR__",
        OwnerSid: "S-1-5-18",
        InstanceId: crypto.randomUUID(),
      },
    },
    {
      label: "invalid instance id",
      value: {
        Signature: markerSignature,
        Version: 1,
        CanonicalPath: "__DATA_DIR__",
        OwnerSid: "__CURRENT_SID__",
        InstanceId: "not-a-guid",
      },
    },
  ])("rejects a marker with $label and never overwrites it", ({ value }) => {
    const dataDir = join(sandbox, `bad marker ${crypto.randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
    const sidResult = runDriver("current-sid", dataDir, environment);
    expect(sidResult.status).toBe(0);
    const currentSid = parseLastJson<{ Sid: string }>(sidResult.stdout).Sid;
    const raw =
      typeof value === "string"
        ? value
        : JSON.stringify(value)
            .replaceAll("__DATA_DIR__", resolve(dataDir).replaceAll("\\", "\\\\"))
            .replace("__CURRENT_SID__", currentSid);
    writeFileSync(markerPath(dataDir), raw, "utf8");
    const before = readFileSync(markerPath(dataDir));
    const aclBefore = inspectAcl(dataDir, environment);

    const result = runDriver("protect", dataDir, environment);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("owner marker");
    expect(readFileSync(markerPath(dataDir))).toEqual(before);
    expect(inspectAcl(dataDir, environment)).toEqual(aclBefore);
  });

  it("accepts only case differences in an otherwise exact marker canonical path", () => {
    const dataDir = join(sandbox, "canonical case");
    mkdirSync(dataDir, { recursive: true });
    expect(runDriver("protect", dataDir, environment).status).toBe(0);
    const marker = JSON.parse(readFileSync(markerPath(dataDir), "utf8")) as {
      CanonicalPath: string;
    };
    marker.CanonicalPath = marker.CanonicalPath.toUpperCase();
    writeFileSync(markerPath(dataDir), JSON.stringify(marker), "utf8");

    const result = runDriver("protect", dataDir, environment);

    expect(result.status).toBe(0);
    expect(parseLastJson<{ Status: string }>(result.stdout).Status).toBe("already-protected");
  });

  it("rejects a hard-linked marker without reading through or replacing it", () => {
    const dataDir = join(sandbox, "hardlink marker");
    const source = join(sandbox, "foreign-marker.json");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(source, "foreign", "utf8");
    linkSync(source, markerPath(dataDir));
    const before = inspectAcl(dataDir, environment);

    const result = runDriver("protect", dataDir, environment);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("hard link");
    expect(readFileSync(source, "utf8")).toBe("foreign");
    expect(inspectAcl(dataDir, environment)).toEqual(before);
  });

  it("checks marker hard-link count in-process without launching fsutil", () => {
    const source = readFileSync(modulePath, "utf8");

    expect(source).toContain("GetFileInformationByHandle");
    expect(source).not.toContain("System32\\fsutil.exe");
  });

  it("rejects a marker that is itself a junction", () => {
    const dataDir = join(sandbox, "junction marker");
    const target = join(sandbox, "foreign marker directory");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(target, { recursive: true });
    symlinkSync(target, markerPath(dataDir), "junction");
    const before = inspectAcl(dataDir, environment);

    const result = runDriver("protect", dataDir, environment);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("reparse point");
    expect(inspectAcl(dataDir, environment)).toEqual(before);
  });

  it.each([
    {
      label: "unknown entry",
      prepare: (dataDir: string) => writeFileSync(join(dataDir, "unknown.txt"), "x", "utf8"),
    },
    {
      label: "allowlisted file with directory type",
      prepare: (dataDir: string) => mkdirSync(join(dataDir, "state.json")),
    },
    {
      label: "allowlisted directory with file type",
      prepare: (dataDir: string) =>
        writeFileSync(join(dataDir, "RemoteConversations"), "x", "utf8"),
    },
  ])("refuses legacy adoption for $label", ({ prepare }) => {
    const dataDir = join(localAppData, "CodexLocalRemote");
    mkdirSync(dataDir, { recursive: true });
    prepare(dataDir);
    const before = inspectAcl(dataDir, environment);

    const result = runDriver("protect", dataDir, environment);

    expect(result.status).not.toBe(0);
    expect(existsSync(markerPath(dataDir))).toBe(false);
    expect(inspectAcl(dataDir, environment)).toEqual(before);
  });

  it("rejects a reparse point in legacy data before marker or ACL writes", () => {
    const dataDir = join(localAppData, "CodexLocalRemote");
    const target = join(sandbox, "foreign target");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(dataDir, "RemoteConversations"), "junction");
    const before = inspectAcl(dataDir, environment);

    const result = runDriver("protect", dataDir, environment);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("reparse point");
    expect(existsSync(markerPath(dataDir))).toBe(false);
    expect(inspectAcl(dataDir, environment)).toEqual(before);
  });

  it("rejects a descendant reparse point even after a valid ownership claim", () => {
    const dataDir = join(sandbox, "owned with later junction");
    const target = join(sandbox, "later foreign target");
    mkdirSync(dataDir, { recursive: true });
    expect(runDriver("protect", dataDir, environment).status).toBe(0);
    const markerBefore = readFileSync(markerPath(dataDir));
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(dataDir, "later junction"), "junction");
    const before = inspectAcl(dataDir, environment);

    const result = runDriver("protect", dataDir, environment);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("reparse point");
    expect(readFileSync(markerPath(dataDir))).toEqual(markerBefore);
    expect(inspectAcl(dataDir, environment)).toEqual(before);
  });

  it("is idempotent and repairs ACL drift without replacing its marker", () => {
    const dataDir = join(sandbox, "idempotent");
    mkdirSync(dataDir, { recursive: true });
    const first = runDriver("protect", dataDir, environment);
    expect(first.status).toBe(0);
    const markerBefore = readFileSync(markerPath(dataDir));
    const aclBeforeSecond = inspectAcl(dataDir, environment);

    const second = runDriver("protect", dataDir, environment);
    expect(second.status).toBe(0);
    expect(parseLastJson<{ Status: string }>(second.stdout).Status).toBe("already-protected");
    expect(readFileSync(markerPath(dataDir))).toEqual(markerBefore);
    expect(inspectAcl(dataDir, environment)).toEqual(aclBeforeSecond);

    expect(runDriver("add-everyone-rule", dataDir, environment).status).toBe(0);
    const repaired = runDriver("protect", dataDir, environment);
    expect(repaired.status).toBe(0);
    expect(parseLastJson<{ Status: string }>(repaired.stdout).Status).toBe("repaired");
    expect(readFileSync(markerPath(dataDir))).toEqual(markerBefore);
    expect(inspectAcl(dataDir, environment).Rules.map((rule) => rule.Sid)).not.toContain("S-1-1-0");
  }, 15_000);

  it("provides a bounded startup gate that rejects root ACL drift", () => {
    const dataDir = join(sandbox, "bounded startup protection");
    mkdirSync(dataDir, { recursive: true });
    expect(runDriver("protect", dataDir, environment).status).toBe(0);

    const accepted = runDriver("assert-startup-protection", dataDir, environment);
    expect(accepted.status).toBe(0);
    expect(parseLastJson<{ Status: string }>(accepted.stdout).Status).toBe("startup-protected");

    expect(runDriver("add-everyone-rule", dataDir, environment).status).toBe(0);
    const rejected = runDriver("assert-startup-protection", dataDir, environment);
    expect(rejected.status).not.toBe(0);
    expect(`${rejected.stdout}${rejected.stderr}`).toContain("protected root ACL");
  }, 15_000);
});
