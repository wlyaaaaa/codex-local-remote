import type { BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import type { UsageSnapshot } from "@codex-local-remote/contracts";

const MAX_DISCOVERY_DEPTH = 4;
const MAX_DISCOVERY_ENTRIES = 4_096;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type ContextUsage = NonNullable<UsageSnapshot["context"]>;

export interface DesktopSessionUsageInput {
  codexHome: string;
  sessionPath?: string;
  threadId: string;
}

export class DesktopSessionUsageReader {
  async read(input: DesktopSessionUsageInput): Promise<ContextUsage | undefined> {
    const threadId = input.threadId.trim();
    if (!THREAD_ID_PATTERN.test(threadId)) {
      return undefined;
    }

    const requestedHome = normalizeLocalAbsolutePath(input.codexHome);
    if (requestedHome === undefined) {
      return undefined;
    }
    const canonicalHome = await canonicalDirectory(requestedHome);
    if (canonicalHome === undefined || !sameLocalPath(requestedHome, canonicalHome)) {
      return undefined;
    }

    const requestedSessionsRoot = path.join(canonicalHome, "sessions");
    const sessionsRoot = await canonicalDirectory(requestedSessionsRoot);
    if (
      sessionsRoot === undefined ||
      !sameLocalPath(requestedSessionsRoot, sessionsRoot) ||
      !isPathInside(canonicalHome, sessionsRoot)
    ) {
      return undefined;
    }

    const suppliedPath =
      input.sessionPath === undefined ? undefined : normalizeLocalAbsolutePath(input.sessionPath);
    if (input.sessionPath !== undefined && suppliedPath === undefined) {
      return undefined;
    }
    const candidate =
      suppliedPath ??
      (await discoverSessionFile({
        root: sessionsRoot,
        threadId,
      }));
    if (
      candidate === undefined ||
      !path.basename(candidate).toLocaleLowerCase("en-US").endsWith(`-${threadId}.jsonl`) ||
      !isPathInside(sessionsRoot, candidate)
    ) {
      return undefined;
    }

    return await readLatestUsageSnapshot(candidate, sessionsRoot);
  }
}

async function discoverSessionFile(input: {
  root: string;
  threadId: string;
}): Promise<string | undefined> {
  const suffix = `-${input.threadId}.jsonl`.toLocaleLowerCase("en-US");
  const pending: Array<{ depth: number; directory: string }> = [
    { depth: 0, directory: input.root },
  ];
  let inspectedEntries = 0;
  let newest: { modifiedAtNs: bigint; path: string } | undefined;

  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) {
      break;
    }
    let entries;
    try {
      entries = await readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      inspectedEntries += 1;
      if (inspectedEntries > MAX_DISCOVERY_ENTRIES) {
        return undefined;
      }
      const candidate = path.join(current.directory, entry.name);
      if (entry.isDirectory() && current.depth < MAX_DISCOVERY_DEPTH) {
        const canonical = await canonicalDirectory(candidate);
        if (
          canonical !== undefined &&
          sameLocalPath(candidate, canonical) &&
          isPathInside(input.root, canonical)
        ) {
          pending.push({ depth: current.depth + 1, directory: canonical });
        }
        continue;
      }
      if (
        !entry.isFile() ||
        !entry.name.toLocaleLowerCase("en-US").endsWith(suffix) ||
        !isPathInside(input.root, candidate)
      ) {
        continue;
      }
      try {
        const metadata = await lstat(candidate, { bigint: true });
        if (
          !metadata.isFile() ||
          metadata.isSymbolicLink() ||
          (newest !== undefined && metadata.mtimeNs <= newest.modifiedAtNs)
        ) {
          continue;
        }
        newest = { modifiedAtNs: metadata.mtimeNs, path: candidate };
      } catch {
        // A concurrently removed candidate is simply not discoverable.
      }
    }
  }
  return newest?.path;
}

async function readLatestUsageSnapshot(
  requestedPath: string,
  sessionsRoot: string,
): Promise<ContextUsage | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(requestedPath, { bigint: true });
    const canonicalBeforeOpen = await realpath(requestedPath);
    if (
      !isRegularFile(before) ||
      !sameLocalPath(requestedPath, canonicalBeforeOpen) ||
      !isPathInside(sessionsRoot, canonicalBeforeOpen)
    ) {
      return undefined;
    }

    handle = await open(requestedPath, "r");
    const afterOpen = await lstat(requestedPath, { bigint: true });
    const canonicalAfterOpen = await realpath(requestedPath);
    const handleBeforeRead = await handle.stat({ bigint: true });
    if (
      !isRegularFile(afterOpen) ||
      !isRegularFile(handleBeforeRead) ||
      !sameLocalPath(canonicalBeforeOpen, canonicalAfterOpen) ||
      !sameFileIdentity(before, afterOpen) ||
      !sameFileIdentity(afterOpen, handleBeforeRead) ||
      !isPathInside(sessionsRoot, canonicalAfterOpen)
    ) {
      return undefined;
    }

    const capturedSize = handleBeforeRead.size;
    const tailLength = Number(
      capturedSize > BigInt(MAX_TAIL_BYTES) ? BigInt(MAX_TAIL_BYTES) : capturedSize,
    );
    const tailStart = capturedSize - BigInt(tailLength);
    const buffer = Buffer.allocUnsafe(tailLength);
    let bytesRead = 0;
    while (bytesRead < tailLength) {
      const result = await handle.read(
        buffer,
        bytesRead,
        tailLength - bytesRead,
        tailStart + BigInt(bytesRead),
      );
      if (
        !Number.isInteger(result.bytesRead) ||
        result.bytesRead <= 0 ||
        result.bytesRead > tailLength - bytesRead
      ) {
        return undefined;
      }
      bytesRead += result.bytesRead;
    }

    const afterRead = await lstat(requestedPath, { bigint: true });
    const canonicalAfterRead = await realpath(requestedPath);
    const handleAfterRead = await handle.stat({ bigint: true });
    if (
      !isRegularFile(afterRead) ||
      !isRegularFile(handleAfterRead) ||
      !sameLocalPath(canonicalBeforeOpen, canonicalAfterRead) ||
      !sameFileIdentity(handleBeforeRead, afterRead) ||
      !sameFileIdentity(afterRead, handleAfterRead) ||
      afterRead.size < capturedSize ||
      handleAfterRead.size < capturedSize
    ) {
      return undefined;
    }

    const lines = buffer.toString("utf8").split(/\r?\n/u);
    if (tailStart > 0n) {
      lines.shift();
    }
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }
      const context = parseUsageLine(line);
      if (context !== undefined) {
        return context;
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseUsageLine(line: string): ContextUsage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = asRecord(value);
  const payload = asRecord(record.payload);
  const info = asRecord(payload.info);
  const lastUsage = asRecord(info.last_token_usage);
  if (record.type !== "event_msg" || payload.type !== "token_count") {
    return undefined;
  }
  const usedTokens = finiteNumber(lastUsage.total_tokens);
  const limitTokens = finiteNumber(info.model_context_window);
  if (usedTokens === undefined || usedTokens < 0 || limitTokens === undefined || limitTokens <= 0) {
    return undefined;
  }
  return {
    limitTokens,
    usedPercent: Math.round(Math.min(100, (usedTokens / limitTokens) * 100) * 100) / 100,
    usedTokens,
  };
}

async function canonicalDirectory(candidate: string): Promise<string | undefined> {
  try {
    const before = await lstat(candidate, { bigint: true });
    const canonical = await realpath(candidate);
    const after = await lstat(candidate, { bigint: true });
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      !sameFileIdentity(before, after)
    ) {
      return undefined;
    }
    return canonical;
  } catch {
    return undefined;
  }
}

function normalizeLocalAbsolutePath(candidate: string): string | undefined {
  if (candidate.length === 0 || candidate.includes("\0")) {
    return undefined;
  }
  if (process.platform === "win32") {
    if (
      candidate.startsWith(String.raw`\\`) ||
      candidate.startsWith("//") ||
      !path.win32.isAbsolute(candidate) ||
      !/^[a-z]:[\\/]/iu.test(candidate)
    ) {
      return undefined;
    }
    return path.win32.normalize(candidate);
  }
  if (candidate.startsWith("//") || !path.posix.isAbsolute(candidate)) {
    return undefined;
  }
  return path.posix.normalize(candidate);
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isRegularFile(metadata: BigIntStats): boolean {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.size >= 0n;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameLocalPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? path.win32.normalize(left).toLocaleLowerCase("en-US") ===
        path.win32.normalize(right).toLocaleLowerCase("en-US")
    : path.posix.normalize(left) === path.posix.normalize(right);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
