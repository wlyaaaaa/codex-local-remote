import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { FileEntry, FileListing } from "@codex-local-remote/contracts";
import {
  authorizeDownloadFromCanonicalRoot,
  evaluateDownload,
  resolveContainedPathFromCanonicalRoot,
  validateSafeWindowsProjectRoot,
  validateSafeWindowsRelativePath,
} from "@codex-local-remote/security";

import { ProductHttpError } from "./errors.js";
import type { SidecarStateStore } from "./state-store.js";

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024;
const MAX_PDF_PREVIEW_BYTES = 25 * 1024 * 1024;
const HIDDEN_DIRECTORIES = new Set([".codex", ".git", ".gnupg", ".ssh", "node_modules"]);
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

export interface AuthorizedProjectFile {
  contentType?: string;
  handle: Awaited<ReturnType<typeof authorizeDownloadFromCanonicalRoot>>["handle"];
  size: number;
}

export async function listProjectFiles(
  state: SidecarStateStore,
  projectId: string,
  relativePath: string,
): Promise<FileListing> {
  const root = await requireProjectRoot(state, projectId);
  const validation = validateSafeWindowsRelativePath(relativePath);
  if (!validation.ok) {
    throw fileAccessDenied();
  }
  let directory: string;
  try {
    directory = await resolveContainedPathFromCanonicalRoot(root, validation.normalized);
  } catch {
    throw fileAccessDenied();
  }
  const directoryStat = await safeStat(directory);
  if (!directoryStat?.isDirectory()) {
    throw new ProductHttpError("FILE_NOT_FOUND", "找不到这个文件夹", 404);
  }

  const entries: FileEntry[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory() && HIDDEN_DIRECTORIES.has(item.name.toLocaleLowerCase("en-US"))) {
      continue;
    }
    const childRelativePath = [...validation.segments, item.name].join("\\");
    let resolvedPath: string;
    try {
      resolvedPath = await resolveContainedPathFromCanonicalRoot(root, childRelativePath);
    } catch {
      continue;
    }
    const metadata = await safeStat(resolvedPath);
    if (!metadata || (!metadata.isFile() && !metadata.isDirectory())) {
      continue;
    }
    const kind = metadata.isDirectory() ? "directory" : "file";
    const downloadDecision =
      kind === "file"
        ? evaluateDownload({
            kind,
            maxBytes: MAX_DOWNLOAD_BYTES,
            relativePath: childRelativePath,
            size: metadata.size,
          })
        : { allowed: false as const, reason: "not-file" as const };
    if (
      !downloadDecision.allowed &&
      (downloadDecision.reason === "sensitive-directory" ||
        downloadDecision.reason === "sensitive-file" ||
        downloadDecision.reason === "unsafe-path")
    ) {
      continue;
    }
    entries.push({
      downloadable: downloadDecision.allowed,
      kind,
      modifiedAt: metadata.mtime.toISOString(),
      name: item.name,
      relativePath: [...validation.segments, item.name].join("/"),
      ...(kind === "file" ? { size: metadata.size } : {}),
    });
  }
  entries.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }
    return left.name.localeCompare(right.name, "zh-CN");
  });
  await assertProjectRootStillAuthorized(state, projectId, root);
  return {
    entries,
    projectId,
    relativePath: validation.segments.join("/"),
  };
}

export async function getProjectPreview(
  state: SidecarStateStore,
  projectId: string,
  relativePath: string,
): Promise<Required<AuthorizedProjectFile>> {
  const extension = path.win32.extname(relativePath).toLocaleLowerCase("en-US");
  const textType = TEXT_CONTENT_TYPES.get(extension);
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
  const authorized = await authorizeProjectFile(state, projectId, relativePath, maxBytes);
  return { ...authorized, contentType };
}

export async function getProjectDownload(
  state: SidecarStateStore,
  projectId: string,
  relativePath: string,
): Promise<AuthorizedProjectFile> {
  return await authorizeProjectFile(state, projectId, relativePath, MAX_DOWNLOAD_BYTES);
}

async function requireProjectRoot(state: SidecarStateStore, projectId: string): Promise<string> {
  const project = state.listProjects().find((candidate) => candidate.id === projectId);
  if (!project) {
    throw new ProductHttpError("PROJECT_NOT_FOUND", "找不到这个项目", 404);
  }
  const rootValidation = validateSafeWindowsProjectRoot(project.root);
  if (project.source !== "registered" || !rootValidation.ok) {
    throw fileAccessDenied();
  }
  const authorizedRoot = await state.authorizeRegisteredProjectRoot(projectId);
  if (
    !authorizedRoot ||
    authorizedRoot.toLocaleLowerCase("en-US") !==
      rootValidation.normalized.toLocaleLowerCase("en-US")
  ) {
    throw fileAccessDenied();
  }
  return authorizedRoot;
}

async function authorizeProjectFile(
  state: SidecarStateStore,
  projectId: string,
  relativePath: string,
  maxBytes: number,
): Promise<AuthorizedProjectFile> {
  try {
    const root = await requireProjectRoot(state, projectId);
    const authorized = await authorizeDownloadFromCanonicalRoot(root, relativePath, maxBytes);
    try {
      await assertProjectRootStillAuthorized(state, projectId, root);
      return authorized;
    } catch (error) {
      await authorized.handle.close().catch(() => undefined);
      throw error;
    }
  } catch (error) {
    if (error instanceof ProductHttpError) {
      throw error;
    }
    throw fileAccessDenied();
  }
}

async function assertProjectRootStillAuthorized(
  state: SidecarStateStore,
  projectId: string,
  expectedRoot: string,
): Promise<void> {
  const currentRoot = await state.authorizeRegisteredProjectRoot(projectId);
  if (
    !currentRoot ||
    currentRoot.toLocaleLowerCase("en-US") !== expectedRoot.toLocaleLowerCase("en-US")
  ) {
    throw fileAccessDenied();
  }
}

async function safeStat(candidate: string) {
  try {
    return await stat(candidate);
  } catch {
    return undefined;
  }
}

function fileAccessDenied(): ProductHttpError {
  return new ProductHttpError("FILE_ACCESS_DENIED", "这个文件不能通过远程端读取", 403);
}
