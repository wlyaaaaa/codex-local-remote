import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DesktopSessionUsageReader } from "./desktop-session-usage.js";

const THREAD_ID = "019f99ea-c6de-7002-9f9c-03eeb3e9f37b";

describe("DesktopSessionUsageReader", () => {
  const sandboxes: string[] = [];

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(
      sandboxes.splice(0).map((sandbox) => rm(sandbox, { force: true, recursive: true })),
    );
  });

  async function fixture() {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-session-usage-"));
    sandboxes.push(codexHome);
    const sessionDirectory = path.join(codexHome, "sessions", "2026", "07", "26");
    await mkdir(sessionDirectory, { recursive: true });
    const sessionPath = path.join(
      sessionDirectory,
      `rollout-2026-07-26T01-02-03-${THREAD_ID}.jsonl`,
    );
    return { codexHome, sessionPath };
  }

  it("returns the newest valid token-count snapshot without using lifetime usage", async () => {
    const { codexHome, sessionPath } = await fixture();
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { total_tokens: 102_000 },
              model_context_window: 258_000,
              total_token_usage: { total_tokens: 900_000_000 },
            },
          },
        }),
        JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { total_tokens: 238_814 },
              model_context_window: 258_400,
              total_token_usage: { total_tokens: 1_017_917_889 },
            },
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const reader = new DesktopSessionUsageReader();
    await expect(reader.read({ codexHome, sessionPath, threadId: THREAD_ID })).resolves.toEqual({
      limitTokens: 258_400,
      usedPercent: 92.42,
      usedTokens: 238_814,
    });
  });

  it("discovers the bounded session file by thread id when app-server omits the path", async () => {
    const { codexHome, sessionPath } = await fixture();
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { total_tokens: 64_000 },
            model_context_window: 256_000,
          },
        },
      })}\n`,
      "utf8",
    );

    const reader = new DesktopSessionUsageReader();
    await expect(reader.read({ codexHome, threadId: THREAD_ID })).resolves.toEqual({
      limitTokens: 256_000,
      usedPercent: 25,
      usedTokens: 64_000,
    });
  });

  it("rejects a supplied path outside the canonical Codex sessions directory", async () => {
    const { codexHome } = await fixture();
    const outsidePath = path.join(path.dirname(codexHome), `outside-${THREAD_ID}.jsonl`);
    await writeFile(
      outsidePath,
      `${JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { total_tokens: 1 },
            model_context_window: 2,
          },
        },
      })}\n`,
      "utf8",
    );
    sandboxes.push(outsidePath);

    const reader = new DesktopSessionUsageReader();
    await expect(
      reader.read({ codexHome, sessionPath: outsidePath, threadId: THREAD_ID }),
    ).resolves.toBeUndefined();
  });

  it("leaves malformed or incomplete token snapshots unavailable", async () => {
    const { codexHome, sessionPath } = await fixture();
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { total_tokens: -1 },
              model_context_window: 0,
            },
          },
        }),
        '{"type":"event_msg","payload":',
      ].join("\n"),
      "utf8",
    );

    const reader = new DesktopSessionUsageReader();
    await expect(
      reader.read({ codexHome, sessionPath, threadId: THREAD_ID }),
    ).resolves.toBeUndefined();
  });
});
