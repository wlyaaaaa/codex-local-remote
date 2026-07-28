import { mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProductHttpError } from "./errors.js";
import {
  getProjectDownload,
  getProjectPreview,
  listProjectFiles,
  resolveProjectFileReference,
} from "./files.js";
import { SidecarStateStore } from "./state-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function createFixture() {
  const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
    path.join(os.tmpdir(), "codex-local-remote-files-"),
  );
  temporaryDirectories.push(directory);
  const root = path.join(directory, "project");
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "docs", "README.md"), "# 安全预览", "utf8");
  await writeFile(path.join(root, ".env"), "SECRET=never-expose", "utf8");
  await mkdir(path.join(root, ".git"));
  const state = await SidecarStateStore.open(path.join(directory, "state"));
  await state.registerProject({
    id: "project-1",
    name: "测试项目",
    root,
    source: "registered",
  });
  return { root, state };
}

describe("project file boundary", () => {
  it("lists contained files while hiding sensitive entries", async () => {
    const { state } = await createFixture();

    const root = await listProjectFiles(state, "project-1", "");
    expect(root.entries.map((entry) => entry.name)).toEqual(["docs"]);

    const docs = await listProjectFiles(state, "project-1", "docs");
    expect(docs.entries).toEqual([
      expect.objectContaining({
        downloadable: true,
        kind: "file",
        name: "README.md",
        relativePath: "docs/README.md",
      }),
    ]);
  });

  it("authorizes safe previews and rejects sensitive or traversing downloads", async () => {
    const { root, state } = await createFixture();

    await expect(getProjectPreview(state, "project-1", "docs/README.md")).resolves.toMatchObject({
      contentType: "text/markdown; charset=utf-8",
    });
    await expect(
      resolveProjectFileReference(state, "project-1", path.join(root, "docs", "README.md")),
    ).resolves.toMatchObject({
      downloadable: true,
      kind: "file",
      name: "README.md",
      relativePath: "docs/README.md",
    });
    await expect(getProjectDownload(state, "project-1", ".env")).rejects.toMatchObject({
      code: "FILE_ACCESS_DENIED",
    });
    await expect(
      resolveProjectFileReference(state, "project-1", path.join(root, ".env")),
    ).rejects.toMatchObject({
      code: "FILE_PROTECTED",
    });
    await expect(getProjectDownload(state, "project-1", "../outside.txt")).rejects.toMatchObject({
      code: "FILE_ACCESS_DENIED",
    });
  });

  it("resolves an absolute file against the deepest registered project even without a thread project", async () => {
    const { root, state } = await createFixture();
    const nestedRoot = path.join(root, "nested-project");
    await mkdir(path.join(nestedRoot, "src"), { recursive: true });
    const nestedFile = path.join(nestedRoot, "src", "index.ts");
    await writeFile(nestedFile, "export const ready = true;\n", "utf8");
    await state.registerProject({
      id: "project-nested",
      name: "嵌套项目",
      root: nestedRoot,
      source: "registered",
    });

    await expect(resolveProjectFileReference(state, undefined, nestedFile)).resolves.toMatchObject({
      downloadable: true,
      kind: "file",
      name: "index.ts",
      projectId: "project-nested",
      relativePath: "src/index.ts",
    });
    await expect(
      resolveProjectFileReference(state, "project-1", nestedFile),
    ).resolves.toMatchObject({
      projectId: "project-nested",
      relativePath: "src/index.ts",
    });
  });

  it("keeps ambiguous relative history paths read-only until a registered project is known", async () => {
    const { state } = await createFixture();

    await expect(
      resolveProjectFileReference(state, undefined, "docs/README.md"),
    ).rejects.toMatchObject({
      code: "FILE_PROJECT_REQUIRED",
    });
  });

  it("explains that Git internals stay protected while the recorded diff remains viewable", async () => {
    const { root, state } = await createFixture();
    await writeFile(path.join(root, ".git", "config"), "[core]\n", "utf8");

    try {
      await resolveProjectFileReference(state, "project-1", path.join(root, ".git", "config"));
      expect.unreachable("受保护的 Git 文件不应被远程读取");
    } catch (error) {
      expect(error).toBeInstanceOf(ProductHttpError);
      if (!(error instanceof ProductHttpError)) return;
      expect(error.code).toBe("FILE_PROTECTED");
      expect(error.message).toContain("修改差异仍可查看");
    }
  });

  it("rejects a harmless-looking junction whose physical target is Git internals", async () => {
    const { root, state } = await createFixture();
    await writeFile(path.join(root, ".git", "config"), "[core]\n", "utf8");
    await symlink(path.join(root, ".git"), path.join(root, "safe-alias"), "junction");

    const listing = await listProjectFiles(state, "project-1", "");
    expect(listing.entries.map((entry) => entry.name)).not.toContain("safe-alias");
    await expect(
      resolveProjectFileReference(state, "project-1", "safe-alias/config"),
    ).rejects.toMatchObject({
      code: "FILE_PROTECTED",
    });
  });

  it("rejects every file sink when a registered root is rebound to a junction", async () => {
    const { root, state } = await createFixture();
    const originalRoot = `${root}-original`;
    const outside = `${root}-outside`;
    await mkdir(path.join(outside, "docs"), { recursive: true });
    await writeFile(path.join(outside, "docs", "README.md"), "# outside", "utf8");
    await rename(root, originalRoot);
    await symlink(outside, root, "junction");

    await expect(listProjectFiles(state, "project-1", "")).rejects.toMatchObject({
      code: "FILE_ACCESS_DENIED",
    });
    await expect(getProjectPreview(state, "project-1", "docs/README.md")).rejects.toMatchObject({
      code: "FILE_ACCESS_DENIED",
    });
    await expect(getProjectDownload(state, "project-1", "docs/README.md")).rejects.toMatchObject({
      code: "FILE_ACCESS_DENIED",
    });
  });

  it("does not restore legacy auto-discovered roots as file authorization", async () => {
    const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-files-"),
    );
    temporaryDirectories.push(directory);
    const root = path.join(directory, "discovered-project");
    await mkdir(root);
    await writeFile(path.join(root, "README.md"), "# discovered", "utf8");
    const stateDirectory = path.join(directory, "state");
    await mkdir(stateDirectory);
    await writeFile(
      path.join(stateDirectory, "state.json"),
      JSON.stringify({
        managedThreadIds: [],
        projects: [
          {
            id: "thread-discovered",
            name: "discovered-project",
            root,
            source: "thread",
          },
        ],
        schemaVersion: 1,
        sessions: {},
      }),
      "utf8",
    );

    const state = await SidecarStateStore.open(stateDirectory);

    expect(state.listProjects()).toEqual([]);
    await expect(listProjectFiles(state, "thread-discovered", "")).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
  });

  it.each([".ssh", ".codex", ".git", ".gnupg", "node_modules"])(
    "rejects %s in every normalized registered-root segment",
    async (sensitiveSegment) => {
      const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
        path.join(os.tmpdir(), "codex-local-remote-files-"),
      );
      temporaryDirectories.push(directory);
      const root = path.join(directory, "outer", sensitiveSegment, "project");
      await mkdir(root, { recursive: true });
      const state = await SidecarStateStore.open(path.join(directory, "state"));

      await expect(
        state.registerProject({
          id: `sensitive-${sensitiveSegment}`,
          name: "敏感目录",
          root,
          source: "registered",
        }),
      ).rejects.toThrow(/敏感|安全|授权/u);
      expect(state.listProjects()).toEqual([]);
    },
  );

  it("defends the file sink even if an unregistered project source reaches it", async () => {
    const directory = await SidecarStateStore.createTemporaryDirectoryForTests(
      path.join(os.tmpdir(), "codex-local-remote-files-"),
    );
    temporaryDirectories.push(directory);
    const root = path.join(directory, "synthetic-thread-project");
    await mkdir(root);
    await writeFile(path.join(root, "README.md"), "# should stay unreachable", "utf8");
    const state = {
      listProjects: () => [
        {
          id: "thread-only",
          name: "只读归类",
          root,
          source: "thread" as const,
        },
      ],
    } as SidecarStateStore;

    await expect(listProjectFiles(state, "thread-only", "")).rejects.toMatchObject({
      code: "FILE_ACCESS_DENIED",
    });
  });
});
