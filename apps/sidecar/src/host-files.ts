import { randomUUID } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { FileListing, FileRoot, ResolvedFileEntry } from "@codex-local-remote/contracts";
import { validateSafeWindowsRelativePath } from "@codex-local-remote/security";

import { ProductHttpError } from "./errors.js";

const execFileAsync = promisify(execFile);
const HOST_ROOT_PREFIX = "host-root:";
const HOST_FILE_PREFIX = "host-file:";
const HOST_GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GRANT_TTL_MS = 30 * 60 * 1_000;
const MAX_GRANTS = 512;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 25 * 1024 * 1024;
const MAX_PDF_PREVIEW_BYTES = 50 * 1024 * 1024;
const TEXT_CONTENT_TYPES = new Map([
  [".c", "text/plain; charset=utf-8"],
  [".cpp", "text/plain; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".go", "text/plain; charset=utf-8"],
  [".h", "text/plain; charset=utf-8"],
  [".html", "text/plain; charset=utf-8"],
  [".ini", "text/plain; charset=utf-8"],
  [".java", "text/plain; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".jsx", "text/javascript; charset=utf-8"],
  [".log", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".ps1", "text/plain; charset=utf-8"],
  [".py", "text/plain; charset=utf-8"],
  [".rs", "text/plain; charset=utf-8"],
  [".sh", "text/plain; charset=utf-8"],
  [".sql", "text/plain; charset=utf-8"],
  [".toml", "text/plain; charset=utf-8"],
  [".ts", "text/plain; charset=utf-8"],
  [".tsx", "text/plain; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".xml", "text/plain; charset=utf-8"],
  [".yaml", "text/plain; charset=utf-8"],
  [".yml", "text/plain; charset=utf-8"],
]);
const IMAGE_CONTENT_TYPES = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

interface HostRootSpec {
  id: string;
  name: string;
  path: string;
}

interface HostGrant {
  absolutePath: string;
  createdAt: number;
  name: string;
}

export interface AuthorizedHostFile {
  contentType?: string;
  handle: Awaited<ReturnType<typeof open>>;
  size: number;
}

export interface HostMoveInput {
  sourcePath: string;
  sourceProjectId: string;
  targetPath: string;
  targetProjectId: string;
  overwrite?: boolean;
}

export class HostFileStore {
  readonly #grants = new Map<string, HostGrant>();
  readonly #recycle: (absolutePath: string, isDirectory: boolean) => Promise<void>;
  readonly #roots: Map<string, HostRootSpec>;

  private constructor(
    roots: HostRootSpec[],
    recycle: (absolutePath: string, isDirectory: boolean) => Promise<void>,
  ) {
    this.#roots = new Map(roots.map((root) => [root.id, root]));
    this.#recycle = recycle;
  }

  static async open(
    options: {
      recycle?: (absolutePath: string, isDirectory: boolean) => Promise<void>;
      roots?: HostRootSpec[];
    } = {},
  ): Promise<HostFileStore> {
    const roots = options.roots ?? (await discoverWindowsVolumes());
    const normalizedRoots = (
      await Promise.all(
        roots.map(async (root): Promise<HostRootSpec | undefined> => {
          try {
            return {
              ...root,
              path: await realpath(root.path),
            };
          } catch {
            // A removable or network-backed drive can disappear between
            // discovery and canonicalization. Keep the remaining drives
            // usable instead of failing the entire owner file manager.
            return undefined;
          }
        }),
      )
    ).filter((root): root is HostRootSpec => root !== undefined);
    return new HostFileStore(normalizedRoots, options.recycle ?? recycleOnWindows);
  }

  roots(): FileRoot[] {
    return [...this.#roots.values()].map((root) => ({
      id: root.id,
      kind: "host",
      name: root.name,
      rootLabel: root.path,
    }));
  }

  isHostProject(projectId: string | undefined): boolean {
    return (
      (projectId?.startsWith(HOST_ROOT_PREFIX) === true && this.#roots.has(projectId)) ||
      projectId?.startsWith(HOST_FILE_PREFIX) === true
    );
  }

  async list(projectId: string, relativePath: string): Promise<FileListing> {
    const directory = await this.#resolveRootPath(projectId, relativePath, true);
    const metadata = await safeStat(directory);
    if (!metadata?.isDirectory()) {
      throw new ProductHttpError("FILE_NOT_FOUND", "找不到这个文件夹", 404);
    }
    const base = this.#requireRoot(projectId).path;
    const entries: FileListing["entries"] = [];
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, item.name);
      const itemMetadata = await safeStat(absolutePath);
      if (!itemMetadata || (!itemMetadata.isDirectory() && !itemMetadata.isFile())) continue;
      const kind = itemMetadata.isDirectory() ? "directory" : "file";
      entries.push({
        downloadable: kind === "file" && itemMetadata.size <= MAX_DOWNLOAD_BYTES,
        kind,
        modifiedAt: itemMetadata.mtime.toISOString(),
        name: item.name,
        relativePath: toPortableRelative(path.relative(base, absolutePath)),
        ...(kind === "file" ? { size: itemMetadata.size } : {}),
      });
    }
    entries.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name, "zh-CN");
    });
    return { entries, projectId, relativePath: toPortableRelative(path.relative(base, directory)) };
  }

  async resolve(projectId: string, sourcePath: string): Promise<ResolvedFileEntry> {
    const absolutePath = await this.#resolveRootPath(projectId, sourcePath, true);
    return await this.#entryForAbsolutePath(projectId, absolutePath);
  }

  async grantAbsolutePath(sourcePath: string): Promise<ResolvedFileEntry> {
    const source = sourcePath.trim();
    if (!source || !path.isAbsolute(source)) {
      throw new ProductHttpError("FILE_PATH_INVALID", "文件路径无效", 400);
    }
    let absolutePath: string;
    try {
      absolutePath = await realpath(source);
    } catch {
      throw new ProductHttpError("FILE_NOT_FOUND", "文件已不存在或已经移动", 404);
    }
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) {
      throw new ProductHttpError("FILE_NOT_FOUND", "这个路径不是文件", 404);
    }
    this.#pruneGrants();
    const grantId = randomUUID();
    this.#grants.set(grantId, {
      absolutePath,
      createdAt: Date.now(),
      name: path.basename(absolutePath),
    });
    return {
      downloadable: metadata.size <= MAX_DOWNLOAD_BYTES,
      kind: "file",
      modifiedAt: metadata.mtime.toISOString(),
      name: path.basename(absolutePath),
      projectId: `${HOST_FILE_PREFIX}${grantId}`,
      relativePath: path.basename(absolutePath),
      size: metadata.size,
    };
  }

  async getPreview(projectId: string, relativePath: string): Promise<Required<AuthorizedHostFile>> {
    const extension = path.extname(relativePath).toLocaleLowerCase("en-US");
    const baseName = path.basename(relativePath).toLocaleLowerCase("en-US");
    const textType =
      TEXT_CONTENT_TYPES.get(extension) ??
      (baseName === ".env" || baseName.startsWith(".env.")
        ? "text/plain; charset=utf-8"
        : undefined);
    const imageType = IMAGE_CONTENT_TYPES.get(extension);
    const contentType =
      textType ?? imageType ?? (extension === ".pdf" ? "application/pdf" : undefined);
    if (!contentType) {
      throw new ProductHttpError(
        "FILE_PREVIEW_UNSUPPORTED",
        "这种文件暂不支持在线预览，可尝试下载后查看",
        415,
      );
    }
    const maxBytes = textType
      ? MAX_TEXT_PREVIEW_BYTES
      : imageType
        ? MAX_IMAGE_PREVIEW_BYTES
        : MAX_PDF_PREVIEW_BYTES;
    return {
      ...(await this.#authorize(projectId, relativePath, maxBytes)),
      contentType,
    };
  }

  async getDownload(projectId: string, relativePath: string): Promise<AuthorizedHostFile> {
    return await this.#authorize(projectId, relativePath, MAX_DOWNLOAD_BYTES);
  }

  async createDirectory(projectId: string, relativePath: string): Promise<void> {
    const destination = await this.#resolveRootPath(projectId, relativePath, false);
    try {
      await mkdir(destination, { recursive: false });
    } catch (error) {
      throw fileMutationError(error, "无法创建文件夹");
    }
  }

  async writeFile(
    projectId: string,
    relativePath: string,
    bytes: Buffer,
    overwrite: boolean,
  ): Promise<void> {
    const destination = await this.#resolveRootPath(projectId, relativePath, false);
    try {
      await writeFile(destination, bytes, { flag: overwrite ? "w" : "wx" });
    } catch (error) {
      throw fileMutationError(error, "无法保存文件");
    }
  }

  async copy(input: HostMoveInput): Promise<void> {
    const source = await this.#resolveRootPath(input.sourceProjectId, input.sourcePath, true);
    const target = await this.#resolveRootPath(input.targetProjectId, input.targetPath, false);
    const metadata = await stat(source);
    try {
      if (metadata.isDirectory()) {
        await cp(source, target, {
          errorOnExist: input.overwrite !== true,
          force: input.overwrite === true,
          recursive: true,
        });
      } else {
        if (input.overwrite !== true && (await safeStat(target))) {
          throw new ProductHttpError("FILE_ALREADY_EXISTS", "目标位置已经存在同名项目", 409);
        }
        await copyFile(source, target);
      }
    } catch (error) {
      throw fileMutationError(error, "无法复制文件");
    }
  }

  async move(input: HostMoveInput): Promise<void> {
    const source = await this.#resolveRootPath(input.sourceProjectId, input.sourcePath, true);
    const target = await this.#resolveRootPath(input.targetProjectId, input.targetPath, false);
    if (input.overwrite !== true && (await safeStat(target))) {
      throw new ProductHttpError("FILE_ALREADY_EXISTS", "目标位置已经存在同名项目", 409);
    }
    try {
      if (input.overwrite === true) await rm(target, { force: true, recursive: true });
      await rename(source, target);
    } catch (error) {
      if (isNodeError(error) && error.code === "EXDEV") {
        await this.copy(input);
        await rm(source, { force: true, recursive: true });
        return;
      }
      throw fileMutationError(error, "无法移动文件");
    }
  }

  async rename(projectId: string, relativePath: string, name: string): Promise<void> {
    const validation = validateSafeWindowsRelativePath(name);
    if (!validation.ok || validation.segments.length !== 1) {
      throw new ProductHttpError("FILE_PATH_INVALID", "新名称无效", 400);
    }
    const portableSource = relativePath.replaceAll("\\", "/");
    const parent = portableSource.includes("/")
      ? portableSource.slice(0, portableSource.lastIndexOf("/"))
      : "";
    await this.move({
      sourcePath: relativePath,
      sourceProjectId: projectId,
      targetPath: [parent, name].filter(Boolean).join("/"),
      targetProjectId: projectId,
    });
  }

  async delete(projectId: string, relativePath: string, permanent: boolean): Promise<void> {
    const absolutePath = await this.#resolveRootPath(projectId, relativePath, true);
    const metadata = await stat(absolutePath);
    try {
      if (permanent) {
        await rm(absolutePath, { force: false, recursive: metadata.isDirectory() });
      } else {
        await this.#recycle(absolutePath, metadata.isDirectory());
      }
    } catch (error) {
      throw fileMutationError(error, "无法删除文件");
    }
  }

  async #authorize(
    projectId: string,
    relativePath: string,
    maxBytes: number,
  ): Promise<AuthorizedHostFile> {
    const absolutePath = projectId.startsWith(HOST_FILE_PREFIX)
      ? this.#resolveGrant(projectId, relativePath)
      : await this.#resolveRootPath(projectId, relativePath, true);
    const handle = await open(absolutePath, "r");
    try {
      const [handleMetadata, canonicalPath, pathMetadata] = await Promise.all([
        handle.stat({ bigint: true }),
        realpath(absolutePath),
        stat(absolutePath, { bigint: true }),
      ]);
      if (
        !handleMetadata.isFile() ||
        handleMetadata.dev !== pathMetadata.dev ||
        handleMetadata.ino !== pathMetadata.ino ||
        handleMetadata.size !== pathMetadata.size ||
        canonicalPath !== (await realpath(absolutePath))
      ) {
        throw new Error("file-changed-during-authorization");
      }
      const size = Number(handleMetadata.size);
      if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
        throw new ProductHttpError("FILE_TOO_LARGE", "文件过大，不能通过当前入口传输", 413);
      }
      return { handle, size };
    } catch (error) {
      await handle.close().catch(() => undefined);
      if (error instanceof ProductHttpError) throw error;
      throw fileMutationError(error, "无法读取文件");
    }
  }

  async #entryForAbsolutePath(projectId: string, absolutePath: string): Promise<ResolvedFileEntry> {
    const root = this.#requireRoot(projectId);
    const metadata = await stat(absolutePath);
    const kind = metadata.isDirectory() ? "directory" : "file";
    return {
      downloadable: kind === "file" && metadata.size <= MAX_DOWNLOAD_BYTES,
      kind,
      modifiedAt: metadata.mtime.toISOString(),
      name: path.basename(absolutePath) || root.name,
      projectId,
      relativePath: toPortableRelative(path.relative(root.path, absolutePath)),
      ...(kind === "file" ? { size: metadata.size } : {}),
    };
  }

  #resolveGrant(projectId: string, relativePath: string): string {
    this.#pruneGrants();
    const grantId = projectId.slice(HOST_FILE_PREFIX.length);
    if (!HOST_GRANT_ID.test(grantId)) {
      throw new ProductHttpError("FILE_PATH_INVALID", "文件授权无效", 400);
    }
    const grant = this.#grants.get(grantId);
    if (!grant || grant.name !== relativePath) {
      throw new ProductHttpError("FILE_GRANT_EXPIRED", "文件授权已过期，请重新打开", 410);
    }
    return grant.absolutePath;
  }

  async #resolveRootPath(
    projectId: string,
    relativePath: string,
    mustExist: boolean,
  ): Promise<string> {
    const root = this.#requireRoot(projectId);
    const validation = validateSafeWindowsRelativePath(relativePath);
    if (!validation.ok) {
      throw new ProductHttpError("FILE_PATH_INVALID", "文件路径无效", 400);
    }
    const candidate = path.resolve(root.path, ...validation.segments);
    if (!isLexicallyContained(root.path, candidate)) {
      throw new ProductHttpError("FILE_PATH_INVALID", "文件路径无效", 400);
    }
    if (!mustExist) {
      const parent = path.dirname(candidate);
      const parentMetadata = await safeStat(parent);
      if (!parentMetadata?.isDirectory()) {
        throw new ProductHttpError("FILE_NOT_FOUND", "目标文件夹不存在", 404);
      }
      return candidate;
    }
    try {
      await stat(candidate);
      return candidate;
    } catch {
      throw new ProductHttpError("FILE_NOT_FOUND", "文件已不存在或已经移动", 404);
    }
  }

  #requireRoot(projectId: string): HostRootSpec {
    const root = this.#roots.get(projectId);
    if (!root || !projectId.startsWith(HOST_ROOT_PREFIX)) {
      throw new ProductHttpError("FILE_ROOT_NOT_FOUND", "找不到这个磁盘", 404);
    }
    return root;
  }

  #pruneGrants(): void {
    const cutoff = Date.now() - GRANT_TTL_MS;
    for (const [id, grant] of this.#grants) {
      if (grant.createdAt < cutoff) this.#grants.delete(id);
    }
    while (this.#grants.size >= MAX_GRANTS) {
      const first = this.#grants.keys().next().value;
      if (!first) break;
      this.#grants.delete(first);
    }
  }
}

async function discoverWindowsVolumes(): Promise<HostRootSpec[]> {
  const candidates = Array.from({ length: 26 }, (_, index) => {
    const letter = String.fromCharCode("A".charCodeAt(0) + index);
    return { letter, rootPath: `${letter}:\\` };
  });
  const roots = await Promise.all(
    candidates.map(async ({ letter, rootPath }): Promise<HostRootSpec | undefined> => {
      const metadata = await safeStat(rootPath);
      if (!metadata?.isDirectory()) return undefined;
      return {
        id: `${HOST_ROOT_PREFIX}${letter}`,
        name: `${letter}:`,
        path: rootPath,
      };
    }),
  );
  return roots.filter((root): root is HostRootSpec => root !== undefined);
}

async function recycleOnWindows(absolutePath: string, isDirectory: boolean): Promise<void> {
  const escaped = absolutePath.replaceAll("'", "''");
  const method = isDirectory ? "DeleteDirectory" : "DeleteFile";
  const options = isDirectory
    ? "[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs," +
      "[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin," +
      "[Microsoft.VisualBasic.FileIO.UICancelOption]::DoNothing"
    : "[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs," +
      "[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin";
  const script =
    `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
    `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}('${escaped}',${options})`;
  await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true },
  );
}

function isLexicallyContained(root: string, candidate: string): boolean {
  const relation = path.relative(root, candidate);
  return (
    relation === "" ||
    (!path.isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${path.sep}`))
  );
}

function toPortableRelative(value: string): string {
  return value.replaceAll("\\", "/");
}

async function safeStat(candidate: string) {
  try {
    return await stat(candidate);
  } catch {
    return undefined;
  }
}

function fileMutationError(error: unknown, fallback: string): ProductHttpError {
  if (error instanceof ProductHttpError) return error;
  if (isNodeError(error)) {
    if (error.code === "EEXIST") {
      return new ProductHttpError("FILE_ALREADY_EXISTS", "目标位置已经存在同名项目", 409);
    }
    if (error.code === "EACCES" || error.code === "EPERM") {
      return new ProductHttpError(
        "FILE_PERMISSION_DENIED",
        "当前 Windows 身份没有权限执行此操作",
        403,
      );
    }
    if (error.code === "ENOENT") {
      return new ProductHttpError("FILE_NOT_FOUND", "文件已不存在或已经移动", 404);
    }
  }
  return new ProductHttpError("FILE_OPERATION_FAILED", fallback, 500);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
