import { describe, expect, it } from "vitest";
import {
  CursorPaginationGuardError,
  beginCursorPaginationPage,
  completeCursorPaginationPage,
  createCursorPaginationGuard,
  loadGuardedCursorPage,
  type CursorPaginationGuard,
  type CursorPaginationGuardLimits,
} from "./pagination";

type TestPage = { items: Array<{ id: string }>; nextCursor?: string };

async function runAutomaticPageChain(
  pages: Readonly<Record<string, TestPage>>,
  limits?: CursorPaginationGuardLimits,
): Promise<{ calls: string[]; error?: unknown; items: string[] }> {
  const calls: string[] = [];
  const items = new Set<string>();
  let cursor: string | undefined = "page-a";
  let guard = createCursorPaginationGuard();
  try {
    while (cursor) {
      const result: { guard: CursorPaginationGuard; page: TestPage } =
        await loadGuardedCursorPage<TestPage>({
          countAddedItems: (page) => page.items.filter((item) => !items.has(item.id)).length,
          cursor,
          guard,
          ...(limits === undefined ? {} : { limits }),
          loadPage: async (pageCursor) => {
            calls.push(pageCursor);
            return pages[pageCursor]!;
          },
        });
      for (const item of result.page.items) items.add(item.id);
      cursor = result.page.nextCursor;
      guard = result.guard;
    }
    return { calls, items: [...items] };
  } catch (error) {
    return { calls, error, items: [...items] };
  }
}

function expectGuardReason(action: () => void, reason: CursorPaginationGuardError["reason"]): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CursorPaginationGuardError);
  if (caught instanceof CursorPaginationGuardError) expect(caught.reason).toBe(reason);
}

describe("游标分页安全边界", () => {
  it("状态链正常耗尽多页，并在循环游标出现后停止下一次网络请求", async () => {
    await expect(
      runAutomaticPageChain({
        "page-a": { items: [{ id: "a" }], nextCursor: "page-b" },
        "page-b": { items: [{ id: "b" }] },
      }),
    ).resolves.toEqual({ calls: ["page-a", "page-b"], items: ["a", "b"] });

    const sameCursor = await runAutomaticPageChain({
      "page-a": { items: [{ id: "a" }], nextCursor: "page-a" },
    });
    expect(sameCursor.calls).toEqual(["page-a"]);
    expect(sameCursor.error).toMatchObject({ reason: "cursor-cycle" });

    const cycle = await runAutomaticPageChain({
      "page-a": { items: [{ id: "a" }], nextCursor: "page-b" },
      "page-b": { items: [{ id: "b" }], nextCursor: "page-a" },
    });
    expect(cycle.calls).toEqual(["page-a", "page-b"]);
    expect(cycle.error).toMatchObject({ reason: "cursor-cycle" });
  });

  it("状态链在唯一页数、累计项目数和无新增线程时停止网络推进", async () => {
    const pageLimit = await runAutomaticPageChain(
      {
        "page-a": { items: [{ id: "a" }], nextCursor: "page-b" },
        "page-b": { items: [{ id: "b" }], nextCursor: "page-c" },
        "page-c": { items: [{ id: "c" }] },
      },
      { maxItems: 10, maxPages: 2 },
    );
    expect(pageLimit.calls).toEqual(["page-a", "page-b"]);
    expect(pageLimit.error).toMatchObject({ reason: "page-limit" });

    const itemLimit = await runAutomaticPageChain(
      {
        "page-a": { items: [{ id: "a" }, { id: "b" }], nextCursor: "page-b" },
        "page-b": { items: [{ id: "c" }, { id: "d" }], nextCursor: "page-c" },
      },
      { maxItems: 3, maxPages: 10 },
    );
    expect(itemLimit.calls).toEqual(["page-a", "page-b"]);
    expect(itemLimit.error).toMatchObject({ reason: "item-limit" });

    const noProgress = await runAutomaticPageChain({
      "page-a": { items: [{ id: "same" }], nextCursor: "page-b" },
      "page-b": { items: [{ id: "same" }], nextCursor: "page-c" },
    });
    expect(noProgress.calls).toEqual(["page-a", "page-b"]);
    expect(noProgress.error).toMatchObject({ reason: "no-progress" });
  });

  it("正常多页会持续推进并记录累计页数与项目数", () => {
    let guard = createCursorPaginationGuard();
    guard = beginCursorPaginationPage(guard, "page-a");
    guard = completeCursorPaginationPage(guard, {
      addedItems: 2,
      nextCursor: "page-b",
      receivedItems: 2,
    });
    guard = beginCursorPaginationPage(guard, "page-b");
    guard = completeCursorPaginationPage(guard, {
      addedItems: 1,
      receivedItems: 1,
    });

    expect(guard.pageCount).toBe(2);
    expect(guard.receivedItemCount).toBe(3);
    expect([...guard.seenCursors]).toEqual(["page-a", "page-b"]);
  });

  it.each([
    ["重复同一游标", ["page-a", "page-a"]],
    ["A 到 B 再回 A", ["page-a", "page-b", "page-a"]],
  ])("阻止%s且不会发起循环中的下一次请求", (_label, cursors) => {
    let guard = createCursorPaginationGuard();
    for (const [index, cursor] of cursors.slice(0, -1).entries()) {
      guard = beginCursorPaginationPage(guard, cursor);
      const nextCursor = cursors[index + 1]!;
      if (index === cursors.length - 2) {
        expectGuardReason(
          () =>
            completeCursorPaginationPage(guard, {
              addedItems: 1,
              nextCursor,
              receivedItems: 1,
            }),
          "cursor-cycle",
        );
      } else {
        guard = completeCursorPaginationPage(guard, {
          addedItems: 1,
          nextCursor,
          receivedItems: 1,
        });
      }
    }
  });

  it("在发起超过唯一页数上限的请求前停止", () => {
    let guard = createCursorPaginationGuard();
    guard = beginCursorPaginationPage(guard, "page-a", { maxItems: 10, maxPages: 2 });
    guard = completeCursorPaginationPage(
      guard,
      { addedItems: 1, nextCursor: "page-b", receivedItems: 1 },
      { maxItems: 10, maxPages: 2 },
    );
    guard = beginCursorPaginationPage(guard, "page-b", { maxItems: 10, maxPages: 2 });

    expectGuardReason(
      () =>
        completeCursorPaginationPage(
          guard,
          { addedItems: 1, nextCursor: "page-c", receivedItems: 1 },
          { maxItems: 10, maxPages: 2 },
        ),
      "page-limit",
    );
  });

  it("游标变化但没有新增项目时停止无进展链", () => {
    const guard = beginCursorPaginationPage(createCursorPaginationGuard(), "page-a");

    expectGuardReason(
      () =>
        completeCursorPaginationPage(guard, {
          addedItems: 0,
          nextCursor: "page-b",
          receivedItems: 3,
        }),
      "no-progress",
    );
  });

  it("累计响应项目超过上限时停止继续合并", () => {
    let guard = beginCursorPaginationPage(createCursorPaginationGuard(), "page-a", {
      maxItems: 3,
      maxPages: 10,
    });
    guard = completeCursorPaginationPage(
      guard,
      { addedItems: 2, nextCursor: "page-b", receivedItems: 2 },
      { maxItems: 3, maxPages: 10 },
    );
    guard = beginCursorPaginationPage(guard, "page-b", { maxItems: 3, maxPages: 10 });

    expectGuardReason(
      () =>
        completeCursorPaginationPage(
          guard,
          { addedItems: 2, nextCursor: "page-c", receivedItems: 2 },
          { maxItems: 3, maxPages: 10 },
        ),
      "item-limit",
    );
  });
});
