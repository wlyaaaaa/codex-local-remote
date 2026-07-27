import { describe, expect, it, vi } from "vitest";
import { dismissNotice, noticeDismissalKey, readNoticeDismissal } from "./notice-dismissal";

describe("persistent notice dismissal", () => {
  it("persists a dismissed notice and restores it after refresh", () => {
    const setItem = vi.fn();
    const key = noticeDismissalKey("#/threads/thread-1", "Codex 运行提示", "历史较多");

    dismissNotice({ setItem }, key);

    expect(setItem).toHaveBeenCalledWith(
      "codex-local-remote:dismissed-notice:%23%2Fthreads%2Fthread-1%7CCodex%20%E8%BF%90%E8%A1%8C%E6%8F%90%E7%A4%BA%7C%E5%8E%86%E5%8F%B2%E8%BE%83%E5%A4%9A",
      "1",
    );
    expect(readNoticeDismissal({ getItem: () => "1" }, key)).toBe(true);
  });

  it("shows a changed message even when the previous notice was dismissed", () => {
    expect(noticeDismissalKey("#/threads/thread-1", "Codex 运行提示", "新提示")).not.toBe(
      noticeDismissalKey("#/threads/thread-1", "Codex 运行提示", "旧提示"),
    );
  });

  it("fails open when browser storage is unavailable", () => {
    expect(
      readNoticeDismissal(
        {
          getItem() {
            throw new Error("storage unavailable");
          },
        },
        "notice",
      ),
    ).toBe(false);
  });
});
