import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { createDesktopThreadNotifier } from "./desktop-thread-notifier.js";

const THREAD_ID = "01900000-0000-7000-8000-000000000001";

function createChildProcessDouble() {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = vi.fn(() => undefined);
  return child;
}

describe("createDesktopThreadNotifier", () => {
  it("resolves only after Windows confirms that the protocol process spawned", async () => {
    const child = createChildProcessDouble();
    const launch = vi.fn(() => child);
    const notify = createDesktopThreadNotifier({
      enabled: true,
      explorerPath: "C:\\Windows\\explorer.exe",
      launch,
      platform: "win32",
    });

    expect(notify).toBeDefined();
    const notification = notify?.(THREAD_ID);
    expect(launch).toHaveBeenCalledWith(
      "C:\\Windows\\explorer.exe",
      [`codex://threads/${THREAD_ID}`],
      {
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    expect(child.unref).toHaveBeenCalledOnce();
    child.emit("spawn");
    await expect(notification).resolves.toBeUndefined();
  });

  it.each([
    "",
    "thread-new",
    `${THREAD_ID}/../../settings`,
    `${THREAD_ID}?x=1`,
    `${THREAD_ID}&calc.exe`,
    `"${THREAD_ID}"`,
    ` ${THREAD_ID}`,
    "00000000-0000-0000-0000-000000000000",
  ])("refuses a non-canonical or injectable thread id: %s", async (threadId) => {
    const launch = vi.fn();
    const notify = createDesktopThreadNotifier({
      enabled: true,
      launch,
      platform: "win32",
    });

    await expect(notify?.(threadId)).rejects.toThrow("对话标识无效");
    expect(launch).not.toHaveBeenCalled();
  });

  it("is a no-op outside Windows and when explicitly disabled", () => {
    const launch = vi.fn();

    expect(
      createDesktopThreadNotifier({ enabled: true, launch, platform: "linux" }),
    ).toBeUndefined();
    expect(
      createDesktopThreadNotifier({ enabled: false, launch, platform: "win32" }),
    ).toBeUndefined();

    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects synchronous and asynchronous launcher failures", async () => {
    const notify = createDesktopThreadNotifier({
      enabled: true,
      launch: () => {
        throw new Error("spawn failed");
      },
      platform: "win32",
    });

    await expect(notify?.(THREAD_ID)).rejects.toThrow("spawn failed");

    const child = createChildProcessDouble();
    const asynchronous = createDesktopThreadNotifier({
      enabled: true,
      launch: () => child,
      platform: "win32",
    });
    const notification = asynchronous?.(THREAD_ID);
    child.emit("error", new Error("protocol handler unavailable"));
    await expect(notification).rejects.toThrow("protocol handler unavailable");
  });
});
