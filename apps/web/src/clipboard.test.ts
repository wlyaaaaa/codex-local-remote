import { describe, expect, it, vi } from "vitest";

import { copyPlainText, type ClipboardEnvironment } from "./clipboard";

describe("对话复制", () => {
  it("优先使用浏览器剪贴板 API，断网时也不依赖远端", async () => {
    const writeText = vi.fn(async () => undefined);

    await copyPlainText("需要复制的内容", { clipboard: { writeText } });

    expect(writeText).toHaveBeenCalledWith("需要复制的内容");
  });

  it("剪贴板 API 被移动浏览器拒绝时回退到临时文本框", async () => {
    const writeText = vi.fn(async () => {
      throw new DOMException("not allowed", "NotAllowedError");
    });
    const remove = vi.fn();
    const select = vi.fn();
    const append = vi.fn();
    const execCommand = vi.fn(() => true);
    const control = {
      readOnly: false,
      remove,
      select,
      style: {
        opacity: "",
        pointerEvents: "",
        position: "",
      },
      value: "",
    };

    await copyPlainText("synthetic-task-id", {
      clipboard: { writeText },
      document: {
        body: { append },
        createElement: vi.fn(() => control),
        execCommand,
      } as unknown as NonNullable<ClipboardEnvironment["document"]>,
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(control.value).toBe("synthetic-task-id");
    expect(select).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
