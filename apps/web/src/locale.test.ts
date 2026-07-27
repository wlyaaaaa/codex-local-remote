import { describe, expect, it, vi } from "vitest";
import { localeCopy, readUiLocale, writeUiLocale } from "./locale";

describe("UI locale", () => {
  it("defaults to Simplified Chinese and ignores unknown persisted values", () => {
    expect(readUiLocale({ getItem: () => null })).toBe("zh");
    expect(readUiLocale({ getItem: () => "fr" })).toBe("zh");
  });

  it("restores and persists the explicit English choice", () => {
    expect(readUiLocale({ getItem: () => "en" })).toBe("en");
    const setItem = vi.fn();

    writeUiLocale({ setItem }, "en");

    expect(setItem).toHaveBeenCalledWith("codex-local-remote:locale", "en");
  });

  it("keeps the primary navigation complete in both languages", () => {
    expect(localeCopy("zh").nav).toEqual(["任务", "文件", "设置"]);
    expect(localeCopy("en").nav).toEqual(["Tasks", "Files", "Settings"]);
    expect(localeCopy("en").unprojected).toBe("No project");
  });
});
