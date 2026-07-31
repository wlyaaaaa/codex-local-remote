import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LocalInputReference, ResolvedFileEntry } from "@codex-local-remote/contracts";
import {
  authorizeDownloadFromCanonicalRoot,
  resolveContainedPathFromCanonicalRoot,
  validateSafeWindowsRelativePath,
} from "@codex-local-remote/security";

import { ProductHttpError } from "./errors.js";

export const MAX_BROWSER_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024;
const MAX_PDF_PREVIEW_BYTES = 25 * 1024 * 1024;
const BROWSER_UPLOAD_PROJECT_PREFIX = "browser-upload:";
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TEXT_CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/plain; charset=utf-8"],
  [".ini", "text/plain; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".jsx", "text/javascript; charset=utf-8"],
  [".log", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".ps1", "text/plain; charset=utf-8"],
  [".py", "text/plain; charset=utf-8"],
  [".sh", "text/plain; charset=utf-8"],
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

export interface ResolvedBrowserUpload {
  kind: "file";
  name: string;
  path: string;
}

export interface AuthorizedBrowserUpload {
  contentType?: string;
  handle: Awaited<ReturnType<typeof authorizeDownloadFromCanonicalRoot>>["handle"];
  size: number;
}

export class BrowserUploadStore {
  readonly #maxBytes: number;
  readonly #root: string;

  private constructor(root: string, maxBytes: number) {
    this.#root = root;
    this.#maxBytes = maxBytes;
  }

  static async open(
    dataDir: string,
    options: { maxBytes?: number } = {},
  ): Promise<BrowserUploadStore> {
    const root = path.join(dataDir, "BrowserUploads");
    await mkdir(root, { recursive: true });
    return new BrowserUploadStore(
      await realpath(root),
      options.maxBytes ?? MAX_BROWSER_UPLOAD_BYTES,
    );
  }

  async save(input: {
    bytes: Buffer;
    name: string;
    relativePath?: string;
  }): Promise<LocalInputReference> {
    if (!Buffer.isBuffer(input.bytes) || input.bytes.length === 0) {
      throw new ProductHttpError("UPLOAD_EMPTY", "请选择一个有内容的文件", 400);
    }
    if (input.bytes.length > this.#maxBytes) {
      throw new ProductHttpError(
        "UPLOAD_TOO_LARGE",
        `单个文件不能超过 ${formatMegabytes(this.#maxBytes)} MB`,
        413,
      );
    }
    const nameValidation = validateSafeWindowsRelativePath(input.name);
    if (!nameValidation.ok || nameValidation.segments.length !== 1 || input.name.length > 255) {
      throw invalidUploadPath();
    }
    const requestedPath = input.relativePath?.trim() || input.name;
    const validation = validateSafeWindowsRelativePath(requestedPath);
    if (
      !validation.ok ||
      validation.segments.length === 0 ||
      validation.segments.at(-1)?.toLocaleLowerCase("en-US") !==
        nameValidation.segments[0]?.toLocaleLowerCase("en-US")
    ) {
      throw invalidUploadPath();
    }

    const uploadId = randomUUID();
    const relativePath = validation.segments.join("/");
    const destination = path.join(this.#root, uploadId, ...validation.segments);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, input.bytes, { flag: "wx" });
    return {
      kind: "file",
      relativePath,
      uploadId,
    };
  }

  async resolve(reference: LocalInputReference): Promise<ResolvedBrowserUpload> {
    if (
      reference.kind !== "file" ||
      reference.projectId !== undefined ||
      !reference.uploadId ||
      !UPLOAD_ID.test(reference.uploadId)
    ) {
      throw invalidUploadPath();
    }
    const validation = validateSafeWindowsRelativePath(reference.relativePath);
    if (!validation.ok || validation.segments.length === 0) {
      throw invalidUploadPath();
    }
    let absolutePath: string;
    try {
      absolutePath = await resolveContainedPathFromCanonicalRoot(
        this.#root,
        [reference.uploadId, ...validation.segments].join("\\"),
      );
      if (!(await stat(absolutePath)).isFile()) {
        throw new Error("not a file");
      }
    } catch {
      throw new ProductHttpError("UPLOAD_NOT_FOUND", "上传文件已过期或不存在，请重新选择", 404);
    }
    return {
      kind: "file",
      name: validation.segments.at(-1) ?? "upload",
      path: absolutePath,
    };
  }

  async resolveHistoryPath(sourcePath: string): Promise<ResolvedFileEntry> {
    const source = sourcePath.trim();
    if (!source || !path.win32.isAbsolute(source)) {
      throw uploadHistoryNotApplicable();
    }
    const lexicalRelative = path.win32.relative(this.#root, path.win32.resolve(source));
    const lexicalValidation = validateSafeWindowsRelativePath(lexicalRelative);
    if (
      !lexicalValidation.ok ||
      lexicalValidation.segments.length < 2 ||
      !UPLOAD_ID.test(lexicalValidation.segments[0] ?? "")
    ) {
      throw uploadHistoryNotApplicable();
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(source);
    } catch {
      throw new ProductHttpError("UPLOAD_NOT_FOUND", "上传文件已过期或不存在", 404);
    }
    const physicalRelative = path.win32.relative(this.#root, canonicalPath);
    const physicalValidation = validateSafeWindowsRelativePath(physicalRelative);
    const uploadId = physicalValidation.ok ? physicalValidation.segments[0] : undefined;
    if (
      !physicalValidation.ok ||
      physicalValidation.segments.length < 2 ||
      !uploadId ||
      !UPLOAD_ID.test(uploadId)
    ) {
      throw invalidUploadPath();
    }
    const metadata = await stat(canonicalPath);
    if (!metadata.isFile()) {
      throw new ProductHttpError("UPLOAD_NOT_FOUND", "上传文件已过期或不存在", 404);
    }
    const relativePath = physicalValidation.segments.slice(1).join("/");
    return {
      downloadable: metadata.size <= MAX_BROWSER_UPLOAD_BYTES,
      kind: "file",
      modifiedAt: metadata.mtime.toISOString(),
      name: physicalValidation.segments.at(-1) ?? "upload",
      projectId: `${BROWSER_UPLOAD_PROJECT_PREFIX}${uploadId}`,
      relativePath,
      size: metadata.size,
    };
  }

  async getPreview(
    projectId: string,
    relativePath: string,
  ): Promise<Required<AuthorizedBrowserUpload>> {
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
    return {
      ...(await this.#authorizeHistoryFile(projectId, relativePath, maxBytes)),
      contentType,
    };
  }

  async getDownload(projectId: string, relativePath: string): Promise<AuthorizedBrowserUpload> {
    return await this.#authorizeHistoryFile(projectId, relativePath, MAX_BROWSER_UPLOAD_BYTES);
  }

  isHistoryProject(projectId: string | undefined): boolean {
    return projectId?.startsWith(BROWSER_UPLOAD_PROJECT_PREFIX) === true;
  }

  async #authorizeHistoryFile(
    projectId: string,
    relativePath: string,
    maxBytes: number,
  ): Promise<AuthorizedBrowserUpload> {
    const uploadId = projectId.slice(BROWSER_UPLOAD_PROJECT_PREFIX.length);
    if (!UPLOAD_ID.test(uploadId)) {
      throw invalidUploadPath();
    }
    const validation = validateSafeWindowsRelativePath(relativePath);
    if (!validation.ok || validation.segments.length === 0) {
      throw invalidUploadPath();
    }
    try {
      return await authorizeDownloadFromCanonicalRoot(
        this.#root,
        [uploadId, ...validation.segments].join("\\"),
        maxBytes,
      );
    } catch (error) {
      if (error instanceof ProductHttpError) {
        throw error;
      }
      throw new ProductHttpError("UPLOAD_NOT_FOUND", "上传文件已过期或不存在", 404);
    }
  }
}

function formatMegabytes(bytes: number): number {
  return Math.max(1, Math.floor(bytes / (1024 * 1024)));
}

function invalidUploadPath(): ProductHttpError {
  return new ProductHttpError("UPLOAD_PATH_INVALID", "上传文件路径无效", 400);
}

function uploadHistoryNotApplicable(): ProductHttpError {
  return new ProductHttpError(
    "UPLOAD_HISTORY_NOT_APPLICABLE",
    "这个文件不是由浏览器上传的历史附件",
    409,
  );
}
