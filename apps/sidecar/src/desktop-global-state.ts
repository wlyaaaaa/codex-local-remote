import type { BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

const GLOBAL_STATE_FILE = ".codex-global-state.json";
const DEFAULT_CACHE_TTL_MS = 5_000;
const MAX_GLOBAL_STATE_BYTES = 2 * 1024 * 1024;
const MAX_GLOBAL_STATE_BYTES_BIGINT = BigInt(MAX_GLOBAL_STATE_BYTES);
const MAX_PINNED_THREADS = 100;
const MAX_RAW_PIN_ENTRIES = 10_000;
const MAX_THREAD_ID_LENGTH = 512;

interface PinSnapshot {
  valid: boolean;
  threadIds: string[];
}

interface ReadableFileHandle {
  close(): Promise<void>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  stat(): Promise<BigIntStats>;
}

interface DesktopPinnedThreadReaderOptions {
  cacheTtlMs?: number;
  now?: () => number;
  openFile?: (filePath: string) => Promise<ReadableFileHandle>;
}

type CachedSnapshot =
  | { kind: "expired" | "missing" }
  | { kind: "fresh"; threadIds: readonly string[] };

export class DesktopPinnedThreadReader {
  readonly #cacheTtlMs: number;
  readonly #now: () => number;
  readonly #openFile: (filePath: string) => Promise<ReadableFileHandle>;
  #lastValid:
    | {
        canonicalHome: string;
        capturedAtMs: number;
        requestedHome: string;
        threadIds: readonly string[];
      }
    | undefined;

  constructor(options: DesktopPinnedThreadReaderOptions = {}) {
    const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) {
      throw new RangeError("Desktop pin cache TTL must be a finite non-negative number");
    }
    this.#cacheTtlMs = cacheTtlMs;
    this.#now = options.now ?? Date.now;
    this.#openFile =
      options.openFile ??
      (async (filePath) => {
        const handle = await open(filePath, "r");
        return {
          close: async () => {
            await handle.close();
          },
          read: async (buffer, offset, length, position) =>
            await handle.read(buffer, offset, length, position),
          stat: async () => await handle.stat({ bigint: true }),
        };
      });
  }

  async read(codexHome: string): Promise<readonly string[]> {
    const requestedHome = normalizeLocalAbsoluteHome(codexHome);
    if (requestedHome === undefined) {
      return [];
    }

    let canonicalHome: string;
    try {
      const beforeHomeMetadata = await lstat(requestedHome, { bigint: true });
      canonicalHome = await realpath(requestedHome);
      const afterHomeMetadata = await lstat(requestedHome, { bigint: true });
      if (
        !beforeHomeMetadata.isDirectory() ||
        beforeHomeMetadata.isSymbolicLink() ||
        !afterHomeMetadata.isDirectory() ||
        afterHomeMetadata.isSymbolicLink() ||
        !sameFileIdentity(beforeHomeMetadata, afterHomeMetadata) ||
        normalizeLocalAbsoluteHome(canonicalHome) === undefined ||
        !sameLocalPath(requestedHome, canonicalHome)
      ) {
        return [];
      }
    } catch {
      const cached = this.#readCached(requestedHome);
      return cached.kind === "fresh" ? [...cached.threadIds] : [];
    }

    const primary = await readPinSnapshot(canonicalHome, GLOBAL_STATE_FILE, this.#openFile);
    if (primary.valid) {
      this.#lastValid = {
        canonicalHome,
        capturedAtMs: this.#now(),
        requestedHome,
        threadIds: [...primary.threadIds],
      };
      return [...primary.threadIds];
    }

    const cached = this.#readCached(requestedHome, canonicalHome);
    if (cached.kind === "fresh") {
      return [...cached.threadIds];
    }
    if (cached.kind === "expired") {
      return [];
    }

    const backup = await readPinSnapshot(canonicalHome, `${GLOBAL_STATE_FILE}.bak`, this.#openFile);
    if (backup.valid) {
      this.#lastValid = {
        canonicalHome,
        capturedAtMs: this.#now(),
        requestedHome,
        threadIds: [...backup.threadIds],
      };
      return [...backup.threadIds];
    }
    return [];
  }

  #readCached(requestedHome: string, canonicalHome?: string): CachedSnapshot {
    const cached = this.#lastValid;
    if (
      cached === undefined ||
      !sameLocalPath(cached.requestedHome, requestedHome) ||
      (canonicalHome !== undefined && !sameLocalPath(cached.canonicalHome, canonicalHome))
    ) {
      return { kind: "missing" };
    }
    const ageMs = this.#now() - cached.capturedAtMs;
    if (ageMs < 0 || ageMs > this.#cacheTtlMs) {
      this.#lastValid = undefined;
      return { kind: "expired" };
    }
    return { kind: "fresh", threadIds: cached.threadIds };
  }
}

async function readPinSnapshot(
  codexHome: string,
  fileName: string,
  openFile: (filePath: string) => Promise<ReadableFileHandle>,
): Promise<PinSnapshot> {
  let handle: ReadableFileHandle | undefined;
  try {
    const requestedPath = path.join(codexHome, fileName);
    const beforePathMetadata = await lstat(requestedPath, { bigint: true });
    const canonicalBeforeOpen = await realpath(requestedPath);
    if (
      !isBoundedRegularFile(beforePathMetadata) ||
      !sameLocalPath(path.dirname(canonicalBeforeOpen), codexHome) ||
      !sameLocalPath(canonicalBeforeOpen, requestedPath)
    ) {
      return { threadIds: [], valid: false };
    }

    handle = await openFile(requestedPath);
    const pathMetadataAfterOpen = await lstat(requestedPath, { bigint: true });
    const canonicalAfterOpen = await realpath(requestedPath);
    const pathMetadataAfterRealpath = await lstat(requestedPath, { bigint: true });
    const handleMetadataBeforeRead = await handle.stat();
    if (
      !isBoundedRegularFile(pathMetadataAfterOpen) ||
      !isBoundedRegularFile(pathMetadataAfterRealpath) ||
      !isBoundedRegularFile(handleMetadataBeforeRead) ||
      !sameLocalPath(canonicalAfterOpen, requestedPath) ||
      !sameLocalPath(canonicalBeforeOpen, canonicalAfterOpen) ||
      !sameFileIdentity(beforePathMetadata, pathMetadataAfterOpen) ||
      !sameFileIdentity(pathMetadataAfterOpen, pathMetadataAfterRealpath) ||
      !sameFileIdentity(pathMetadataAfterRealpath, handleMetadataBeforeRead) ||
      !sameFileVersion(beforePathMetadata, handleMetadataBeforeRead)
    ) {
      return { threadIds: [], valid: false };
    }

    const buffer = await readUntilEofOrLimit(handle);
    if (buffer === undefined) {
      return { threadIds: [], valid: false };
    }

    const pathMetadataAfterRead = await lstat(requestedPath, { bigint: true });
    const canonicalAfterRead = await realpath(requestedPath);
    const pathMetadataAfterReadRealpath = await lstat(requestedPath, { bigint: true });
    const handleMetadataAfterRead = await handle.stat();
    if (
      !isBoundedRegularFile(pathMetadataAfterRead) ||
      !isBoundedRegularFile(pathMetadataAfterReadRealpath) ||
      !isBoundedRegularFile(handleMetadataAfterRead) ||
      !sameLocalPath(canonicalAfterRead, requestedPath) ||
      !sameFileIdentity(handleMetadataBeforeRead, pathMetadataAfterRead) ||
      !sameFileIdentity(pathMetadataAfterRead, pathMetadataAfterReadRealpath) ||
      !sameFileIdentity(pathMetadataAfterReadRealpath, handleMetadataAfterRead) ||
      !sameFileVersion(handleMetadataBeforeRead, handleMetadataAfterRead) ||
      BigInt(buffer.length) !== handleMetadataAfterRead.size
    ) {
      return { threadIds: [], valid: false };
    }

    const text = buffer.toString("utf8");
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) {
      return { threadIds: [], valid: false };
    }
    if (!Object.prototype.hasOwnProperty.call(value, "pinned-thread-ids")) {
      return { threadIds: [], valid: true };
    }
    const rawIds = value["pinned-thread-ids"];
    if (!Array.isArray(rawIds) || rawIds.length > MAX_RAW_PIN_ENTRIES) {
      return { threadIds: [], valid: false };
    }
    const seen = new Set<string>();
    const threadIds: string[] = [];
    for (const rawId of rawIds) {
      if (typeof rawId !== "string") {
        continue;
      }
      const threadId = rawId.trim();
      if (threadId.length === 0 || threadId.length > MAX_THREAD_ID_LENGTH || seen.has(threadId)) {
        continue;
      }
      seen.add(threadId);
      threadIds.push(threadId);
      if (threadIds.length >= MAX_PINNED_THREADS) {
        break;
      }
    }
    return { threadIds, valid: true };
  } catch {
    return { threadIds: [], valid: false };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readUntilEofOrLimit(handle: ReadableFileHandle): Promise<Buffer | undefined> {
  const buffer = Buffer.allocUnsafe(MAX_GLOBAL_STATE_BYTES + 1);
  let totalBytesRead = 0;
  while (totalBytesRead < buffer.length) {
    const remainingBytes = buffer.length - totalBytesRead;
    const result = await handle.read(buffer, totalBytesRead, remainingBytes, totalBytesRead);
    if (
      !Number.isInteger(result.bytesRead) ||
      result.bytesRead < 0 ||
      result.bytesRead > remainingBytes
    ) {
      return undefined;
    }
    if (result.bytesRead === 0) {
      break;
    }
    totalBytesRead += result.bytesRead;
  }
  if (totalBytesRead > MAX_GLOBAL_STATE_BYTES) {
    return undefined;
  }
  return buffer.subarray(0, totalBytesRead);
}

function normalizeLocalAbsoluteHome(candidate: string): string | undefined {
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
    const normalized = path.win32.normalize(candidate);
    return sameWindowsPath(normalized, path.win32.parse(normalized).root) ? undefined : normalized;
  }

  if (
    candidate.startsWith("//") ||
    !path.posix.isAbsolute(candidate) ||
    candidate === path.posix.parse(candidate).root
  ) {
    return undefined;
  }
  return path.posix.normalize(candidate);
}

function isBoundedRegularFile(metadata: BigIntStats): boolean {
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.size >= 0n &&
    metadata.size <= MAX_GLOBAL_STATE_BYTES_BIGINT
  );
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileVersion(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameLocalPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? sameWindowsPath(left, right)
    : path.posix.normalize(left) === path.posix.normalize(right);
}

function sameWindowsPath(left: string, right: string): boolean {
  return (
    path.win32.normalize(left).toLocaleLowerCase("en-US") ===
    path.win32.normalize(right).toLocaleLowerCase("en-US")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
