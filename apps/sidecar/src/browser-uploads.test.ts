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

  it("resolves a persisted upload path back to an opaque preview and download identity", async () => {
    const store = await createStore();
    const reference = await store.save({
      bytes: Buffer.from('{"source":"phone"}', "utf8"),
      name: "evidence.json",
      relativePath: "reports/evidence.json",
    });
    const resolved = await store.resolve(reference);

    const historyEntry = await store.resolveHistoryPath(resolved.path);
    expect(historyEntry).toMatchObject({
      downloadable: true,
      kind: "file",
      name: "evidence.json",
      projectId: `browser-upload:${reference.uploadId}`,
      relativePath: "reports/evidence.json",
    });

    const preview = await store.getPreview(historyEntry.projectId, historyEntry.relativePath);
    expect(preview.contentType).toBe("application/json; charset=utf-8");
    expect(await preview.handle.readFile("utf8")).toBe('{"source":"phone"}');
    await preview.handle.close();

    const download = await store.getDownload(historyEntry.projectId, historyEntry.relativePath);
    expect(await download.handle.readFile("utf8")).toBe('{"source":"phone"}');
    await download.handle.close();
  });

  it("does not treat arbitrary local paths as browser upload history", async () => {
    const store = await createStore();
    await expect(store.resolveHistoryPath("C:\\Windows\\win.ini")).rejects.toMatchObject({
      code: "UPLOAD_HISTORY_NOT_APPLICABLE",
    });
    await expect(
      store.getDownload("browser-upload:00000000-0000-4000-8000-000000000000", "../secret.txt"),
    ).rejects.toMatchObject({ code: "UPLOAD_PATH_INVALID" });
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
