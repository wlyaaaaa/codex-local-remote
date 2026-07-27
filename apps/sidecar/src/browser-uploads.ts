import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LocalInputReference } from "@codex-local-remote/contracts";
import {
  resolveContainedPathFromCanonicalRoot,
  validateSafeWindowsRelativePath,
} from "@codex-local-remote/security";

import { ProductHttpError } from "./errors.js";

export const MAX_BROWSER_UPLOAD_BYTES = 50 * 1024 * 1024;
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ResolvedBrowserUpload {
  kind: "file";
  name: string;
  path: string;
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
}

function formatMegabytes(bytes: number): number {
  return Math.max(1, Math.floor(bytes / (1024 * 1024)));
}

function invalidUploadPath(): ProductHttpError {
  return new ProductHttpError("UPLOAD_PATH_INVALID", "上传文件路径无效", 400);
}
