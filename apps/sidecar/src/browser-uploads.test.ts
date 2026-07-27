import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BrowserUploadStore } from "./browser-uploads.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function createStore(maxBytes = 1024) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-browser-uploads-"));
  temporaryDirectories.push(directory);
  return await BrowserUploadStore.open(directory, { maxBytes });
}

describe("BrowserUploadStore", () => {
  it("stores one browser-selected file under an isolated id and resolves it for Codex", async () => {
    const store = await createStore();
    const reference = await store.save({
      bytes: Buffer.from("手机上传内容", "utf8"),
      name: "验收.txt",
      relativePath: "资料/验收.txt",
    });

    expect(reference).toMatchObject({
      kind: "file",
      relativePath: "资料/验收.txt",
    });
    expect(reference.uploadId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(reference.projectId).toBeUndefined();

    const resolved = await store.resolve(reference);
    expect(resolved.kind).toBe("file");
    expect(resolved.name).toBe("验收.txt");
    expect(path.isAbsolute(resolved.path)).toBe(true);
    expect(await readFile(resolved.path, "utf8")).toBe("手机上传内容");
  });

  it("rejects traversal and files larger than the bounded upload limit", async () => {
    const store = await createStore(4);

    await expect(
      store.save({
        bytes: Buffer.from("ok"),
        name: "secret.txt",
        relativePath: "../secret.txt",
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_PATH_INVALID" });
    await expect(
      store.save({
        bytes: Buffer.from("12345"),
        name: "large.txt",
        relativePath: "large.txt",
      }),
    ).rejects.toMatchObject({ code: "UPLOAD_TOO_LARGE" });
  });
});
