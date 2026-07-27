import { describe, expect, it } from "vitest";
import {
  NEW_THREAD_DRAFT_KEY,
  clearNewThreadDraft,
  initialNewThreadProject,
  readNewThreadDraft,
  writeNewThreadDraft,
} from "./new-thread-draft";

function storage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(NEW_THREAD_DRAFT_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("新建任务草稿恢复", () => {
  it("只在浏览器本地保存提示词和已授权项目 id", () => {
    const local = storage();
    expect(
      writeNewThreadDraft(local, { prompt: "继续完成移动端验收", projectId: "project-a" }),
    ).toBe(true);
    expect(readNewThreadDraft(local)).toEqual({
      prompt: "继续完成移动端验收",
      projectId: "project-a",
    });
    expect(clearNewThreadDraft(local)).toBe(true);
    expect(readNewThreadDraft(local)).toBeUndefined();
  });

  it("拒绝损坏或异常大的草稿，不让本地存储阻断页面", () => {
    expect(readNewThreadDraft(storage("{"))).toBeUndefined();
    expect(
      readNewThreadDraft(
        storage(JSON.stringify({ version: 1, prompt: "x".repeat(100_001), projectId: "" })),
      ),
    ).toBeUndefined();
  });

  it("深链接项目优先，其次恢复仍然存在的项目或非项目选择", () => {
    const ids = ["project-a", "project-b"];
    expect(initialNewThreadProject(ids, "project-b", "project-a")).toBe("project-b");
    expect(initialNewThreadProject(ids, null, "")).toBe("");
    expect(initialNewThreadProject(ids, null, "removed-project")).toBe("project-a");
  });
});
