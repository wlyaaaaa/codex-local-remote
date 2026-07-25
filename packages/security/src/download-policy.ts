import type { FileHandle } from "node:fs/promises";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep, win32 } from "node:path";

import {
  resolveContainedPathFromCanonicalRoot,
  validateSafeWindowsRelativePath,
} from "./windows-path.js";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const SENSITIVE_DIRECTORIES = new Set([".codex", ".git", ".gnupg", ".ssh", "node_modules"]);
const SENSITIVE_EXTENSIONS = new Set([
  ".cer",
  ".crt",
  ".db",
  ".der",
  ".key",
  ".kdbx",
  ".p12",
  ".p8",
  ".pem",
  ".pfx",
  ".ppk",
  ".db3",
  ".sqlite3",
  ".sqlite",
]);
const SENSITIVE_BASENAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "credentials.json",
  "id_dsa",
  "id_ed25519",
  "id_ecdsa",
  "id_rsa",
]);

export interface DownloadCandidate {
  relativePath: string;
  size: number;
  kind: "file" | "directory";
  maxBytes?: number;
}

export type DownloadDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "not-file"
        | "invalid-size"
        | "unsafe-path"
        | "sensitive-directory"
        | "sensitive-file"
        | "too-large";
    };

export interface AuthorizedDownload {
  handle: FileHandle;
  size: number;
}

export interface DownloadAuthorizationFileSystem {
  open(path: string, flags: "r"): Promise<FileHandle>;
  realpath(path: string): Promise<string>;
  stat(
    path: string,
    options: { bigint: true },
  ): Promise<{
    dev: bigint;
    ino: bigint;
    isFile(): boolean;
    size: bigint;
  }>;
}

const DEFAULT_FILE_SYSTEM: DownloadAuthorizationFileSystem = {
  open,
  realpath,
  stat: async (candidate, options) => await stat(candidate, options),
};

export function evaluateDownload(candidate: DownloadCandidate): DownloadDecision {
  if (candidate.kind !== "file") {
    return { allowed: false, reason: "not-file" };
  }
  if (!Number.isSafeInteger(candidate.size) || candidate.size < 0) {
    return { allowed: false, reason: "invalid-size" };
  }
  const validation = validateSafeWindowsRelativePath(candidate.relativePath);
  if (!validation.ok || validation.segments.length === 0) {
    return { allowed: false, reason: "unsafe-path" };
  }

  const lowerSegments = validation.segments.map((segment) => segment.toLocaleLowerCase("en-US"));
  if (lowerSegments.some((segment) => SENSITIVE_DIRECTORIES.has(segment))) {
    return { allowed: false, reason: "sensitive-directory" };
  }

  const basename = lowerSegments.at(-1) ?? "";
  const extension = win32.extname(basename);
  if (
    basename === ".env" ||
    basename.startsWith(".env.") ||
    SENSITIVE_BASENAMES.has(basename) ||
    SENSITIVE_EXTENSIONS.has(extension)
  ) {
    return { allowed: false, reason: "sensitive-file" };
  }

  const maxBytes = candidate.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }
  if (candidate.size > maxBytes) {
    return { allowed: false, reason: "too-large" };
  }
  return { allowed: true };
}

export async function authorizeDownload(
  root: string,
  relativePath: string,
  maxBytes?: number,
  fileSystem: DownloadAuthorizationFileSystem = DEFAULT_FILE_SYSTEM,
): Promise<AuthorizedDownload> {
  const realRoot = await fileSystem.realpath(root);
  return await authorizeDownloadFromCanonicalRoot(realRoot, relativePath, maxBytes, fileSystem);
}

export async function authorizeDownloadFromCanonicalRoot(
  realRoot: string,
  relativePath: string,
  maxBytes?: number,
  fileSystem: DownloadAuthorizationFileSystem = DEFAULT_FILE_SYSTEM,
): Promise<AuthorizedDownload> {
  const resolvedPath = await resolveContainedPathFromCanonicalRoot(realRoot, relativePath);
  assertRootIsNotSensitive(realRoot);
  const handle = await fileSystem.open(resolvedPath, "r");
  try {
    // Re-resolve after opening. A local process may have replaced a directory,
    // symlink, or junction between the initial containment check and open().
    const reopenedTarget = await fileSystem.realpath(resolvedPath);
    if (!isContained(realRoot, reopenedTarget)) {
      throw new Error("Download denied: unsafe-path");
    }
    const [handleMetadata, pathMetadata] = await Promise.all([
      handle.stat({ bigint: true }),
      fileSystem.stat(reopenedTarget, { bigint: true }),
    ]);
    if (
      handleMetadata.dev !== pathMetadata.dev ||
      handleMetadata.ino !== pathMetadata.ino ||
      handleMetadata.size !== pathMetadata.size ||
      handleMetadata.isFile() !== pathMetadata.isFile()
    ) {
      throw new Error("Download denied: file-changed-during-authorization");
    }
    const size = Number(handleMetadata.size);
    const canonicalRelativePath = relative(realRoot, reopenedTarget);
    const decision = evaluateDownload({
      relativePath: canonicalRelativePath,
      size,
      kind: handleMetadata.isFile() ? "file" : "directory",
      ...(maxBytes === undefined ? {} : { maxBytes }),
    });
    if (!decision.allowed) {
      throw new Error(`Download denied: ${decision.reason}`);
    }
    return { handle, size };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function assertRootIsNotSensitive(realRoot: string): void {
  const rootSegments = realRoot
    .split(/[\\/]/u)
    .filter(Boolean)
    .map((segment) => segment.toLocaleLowerCase("en-US"));
  if (rootSegments.some((segment) => SENSITIVE_DIRECTORIES.has(segment))) {
    throw new Error("Download denied: sensitive-directory");
  }
}

function isContained(root: string, target: string): boolean {
  const relation = relative(root, target);
  return (
    relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
  );
}
