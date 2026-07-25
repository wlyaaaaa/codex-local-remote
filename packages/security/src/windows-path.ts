import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

export type WindowsRelativePathValidation =
  | {
      ok: true;
      normalized: string;
      segments: string[];
    }
  | {
      ok: false;
      reason: string;
    };

export type WindowsProjectRootValidation =
  | {
      ok: true;
      normalized: string;
    }
  | {
      ok: false;
      reason: "not-absolute" | "path-too-long" | "sensitive-directory" | "unsafe-device-path";
    };

const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])$/iu;
const INVALID_SEGMENT_CHARACTERS = /[<>:"|?*]/u;
const SENSITIVE_PROJECT_ROOT_SEGMENTS = new Set([
  ".codex",
  ".git",
  ".gnupg",
  ".ssh",
  "node_modules",
]);

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => (character.codePointAt(0) ?? 0) <= 0x1f);
}

export function validateSafeWindowsRelativePath(value: string): WindowsRelativePathValidation {
  if (value.length > 4_096) {
    return { ok: false, reason: "path-too-long" };
  }
  if (value.length === 0) {
    return { ok: true, normalized: "", segments: [] };
  }
  if (
    win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    /^[\\/]/u.test(value) ||
    value.startsWith("\\\\?\\") ||
    value.startsWith("\\\\.\\")
  ) {
    return { ok: false, reason: "absolute-or-device-path" };
  }
  if (/[\\/]{2}/u.test(value)) {
    return { ok: false, reason: "empty-segment" };
  }

  const segments = value.split(/[\\/]/u);
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      return { ok: false, reason: "traversal-or-empty-segment" };
    }
    if (segment.length > 255) {
      return { ok: false, reason: "segment-too-long" };
    }
    if (
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      INVALID_SEGMENT_CHARACTERS.test(segment) ||
      containsControlCharacter(segment)
    ) {
      return { ok: false, reason: "invalid-segment" };
    }
    const baseName = segment.split(".", 1)[0] ?? "";
    if (RESERVED_DEVICE_NAME.test(baseName)) {
      return { ok: false, reason: "reserved-device-name" };
    }
  }

  return {
    ok: true,
    normalized: segments.join("\\"),
    segments,
  };
}

export function validateSafeWindowsProjectRoot(value: string): WindowsProjectRootValidation {
  if (value.length > 32_767) {
    return { ok: false, reason: "path-too-long" };
  }
  if (value.startsWith("\\\\?\\") || value.startsWith("\\\\.\\")) {
    return { ok: false, reason: "unsafe-device-path" };
  }
  const isDriveAbsolute = /^[A-Za-z]:[\\/]/u.test(value);
  const isUncAbsolute = /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(value);
  if (!win32.isAbsolute(value) || (!isDriveAbsolute && !isUncAbsolute)) {
    return { ok: false, reason: "not-absolute" };
  }

  const normalized = win32.normalize(value);
  const segments = normalized
    .split(/[\\/]+/u)
    .filter(Boolean)
    .map((segment) => segment.toLocaleLowerCase("en-US"));
  if (segments.some((segment) => SENSITIVE_PROJECT_ROOT_SEGMENTS.has(segment))) {
    return { ok: false, reason: "sensitive-directory" };
  }
  return { normalized, ok: true };
}

function isContained(root: string, target: string): boolean {
  const relation = relative(root, target);
  return (
    relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
  );
}

export async function resolveContainedPath(root: string, relativePath: string): Promise<string> {
  if (!isAbsolute(root)) {
    throw new TypeError("registered root must be absolute");
  }
  const rootValidation = validateSafeWindowsProjectRoot(root);
  if (!rootValidation.ok) {
    throw new Error(`Registered root denied: ${rootValidation.reason}`);
  }
  const validation = validateSafeWindowsRelativePath(relativePath);
  if (!validation.ok) {
    throw new Error(`Unsafe relative path: ${validation.reason}`);
  }

  const realRoot = await realpath(root);
  return await resolveContainedPathFromCanonicalRoot(realRoot, relativePath);
}

export async function resolveContainedPathFromCanonicalRoot(
  canonicalRoot: string,
  relativePath: string,
): Promise<string> {
  if (!isAbsolute(canonicalRoot)) {
    throw new TypeError("canonical registered root must be absolute");
  }
  const canonicalRootValidation = validateSafeWindowsProjectRoot(canonicalRoot);
  if (!canonicalRootValidation.ok) {
    throw new Error(`Registered root denied: ${canonicalRootValidation.reason}`);
  }
  const validation = validateSafeWindowsRelativePath(relativePath);
  if (!validation.ok) {
    throw new Error(`Unsafe relative path: ${validation.reason}`);
  }
  const realRoot = canonicalRootValidation.normalized;
  const candidate = resolve(join(realRoot, ...validation.segments));
  const realTarget = await realpath(candidate);
  if (!isContained(realRoot, realTarget)) {
    throw new Error("Resolved target is outside project containment");
  }
  return realTarget;
}
