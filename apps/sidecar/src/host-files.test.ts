import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HostFileStore } from "./host-files.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    cleanupDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-host-files-"));
  cleanupDirectories.push(directory);
  const recycled: string[] = [];
  const store = await HostFileStore.open({
    recycle: async (absolutePath) => {
      recycled.push(absolutePath);
    },
    roots: [{ id: "host-root:test", name: "测试磁盘", path: directory }],
  });
  return { directory, recycled, store };
}

describe("HostFileStore", () => {
  it("lists every ordinary and hidden entry and grants arbitrary absolute files an opaque identity", async () => {
    const { directory, store } = await fixture();
    await mkdir(path.join(directory, ".private"));
    await writeFile(path.join(directory, ".env"), "LOCAL_ONLY=1", "utf8");
    await writeFile(path.join(directory, "screen.png"), Buffer.from("fake-png"));

    expect(store.roots()).toEqual([
      {
        id: "host-root:test",
        kind: "host",
        name: "测试磁盘",
        rootLabel: directory,
      },
    ]);
    const listing = await store.list("host-root:test", "");
    expect(listing.entries.map((entry) => entry.name)).toEqual([".private", ".env", "screen.png"]);

    const resolved = await store.grantAbsolutePath(path.join(directory, "screen.png"));
    expect(resolved).toMatchObject({
      kind: "file",
      name: "screen.png",
      relativePath: "screen.png",
    });
    expect(resolved.projectId).toMatch(/^host-file:[0-9a-f-]{36}$/u);
    expect(JSON.stringify(resolved)).not.toContain(directory);

    const download = await store.getDownload(resolved.projectId, resolved.relativePath);
    await expect(download.handle.readFile("utf8")).resolves.toBe("fake-png");
    await download.handle.close();
  });

  it("supports create, write, copy, move, rename and both recycle and permanent delete", async () => {
    const { directory, recycled, store } = await fixture();

    await store.createDirectory("host-root:test", "notes");
    await store.writeFile("host-root:test", "notes/one.txt", Buffer.from("one"), false);
    await store.copy({
      sourcePath: "notes/one.txt",
      sourceProjectId: "host-root:test",
      targetPath: "notes/two.txt",
      targetProjectId: "host-root:test",
    });
    await store.move({
      sourcePath: "notes/two.txt",
      sourceProjectId: "host-root:test",
      targetPath: "moved.txt",
      targetProjectId: "host-root:test",
    });
    await store.rename("host-root:test", "moved.txt", "renamed.txt");

    await expect(readFile(path.join(directory, "notes", "one.txt"), "utf8")).resolves.toBe("one");
    await expect(readFile(path.join(directory, "renamed.txt"), "utf8")).resolves.toBe("one");

    await store.delete("host-root:test", "renamed.txt", false);
    expect(recycled).toEqual([path.join(directory, "renamed.txt")]);
    expect((await stat(path.join(directory, "renamed.txt"))).isFile()).toBe(true);

    await store.delete("host-root:test", "notes", true);
    await expect(stat(path.join(directory, "notes"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not allow lexical traversal outside the selected root", async () => {
    const { store } = await fixture();
    await expect(store.list("host-root:test", "../")).rejects.toMatchObject({
      code: "FILE_PATH_INVALID",
    });
    await expect(
      store.writeFile("host-root:test", "../outside.txt", Buffer.from("no"), false),
    ).rejects.toMatchObject({ code: "FILE_PATH_INVALID" });
  });

  it("requires an explicit overwrite choice before replacing an existing file", async () => {
    const { directory, store } = await fixture();
    await writeFile(path.join(directory, "existing.txt"), "old", "utf8");
    await writeFile(path.join(directory, "source.txt"), "source", "utf8");

    await expect(
      store.writeFile("host-root:test", "existing.txt", Buffer.from("new"), false),
    ).rejects.toMatchObject({ code: "FILE_ALREADY_EXISTS" });
    await expect(readFile(path.join(directory, "existing.txt"), "utf8")).resolves.toBe("old");

    await expect(
      store.copy({
        sourcePath: "source.txt",
        sourceProjectId: "host-root:test",
        targetPath: "existing.txt",
        targetProjectId: "host-root:test",
      }),
    ).rejects.toMatchObject({ code: "FILE_ALREADY_EXISTS" });
    await expect(readFile(path.join(directory, "existing.txt"), "utf8")).resolves.toBe("old");

    await store.writeFile("host-root:test", "existing.txt", Buffer.from("new"), true);
    await expect(readFile(path.join(directory, "existing.txt"), "utf8")).resolves.toBe("new");
  });

  it("previews complete bounded text, images and PDFs with safe content types", async () => {
    const { directory, store } = await fixture();
    await writeFile(path.join(directory, "evidence.json"), '{"passed":true}', "utf8");
    await writeFile(path.join(directory, "screen.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(directory, "report.pdf"), Buffer.from("%PDF-1.7"));

    const textPreview = await store.getPreview("host-root:test", "evidence.json");
    expect(textPreview.contentType).toBe("application/json; charset=utf-8");
    await expect(textPreview.handle.readFile("utf8")).resolves.toBe('{"passed":true}');
    await textPreview.handle.close();

    const imagePreview = await store.getPreview("host-root:test", "screen.png");
    expect(imagePreview.contentType).toBe("image/png");
    await expect(imagePreview.handle.readFile()).resolves.toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    await imagePreview.handle.close();

    const pdfPreview = await store.getPreview("host-root:test", "report.pdf");
    expect(pdfPreview.contentType).toBe("application/pdf");
    await pdfPreview.handle.close();
  });

  it("rejects unsupported or oversized previews without blocking bounded downloads", async () => {
    const { directory, store } = await fixture();
    await writeFile(path.join(directory, "archive.bin"), Buffer.from("binary"));
    await writeFile(path.join(directory, "large.txt"), Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));

    await expect(store.getPreview("host-root:test", "archive.bin")).rejects.toMatchObject({
      code: "FILE_PREVIEW_UNSUPPORTED",
    });
    await expect(store.getPreview("host-root:test", "large.txt")).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });

    const download = await store.getDownload("host-root:test", "large.txt");
    expect(download.size).toBe(5 * 1024 * 1024 + 1);
    await download.handle.close();
  });
});
