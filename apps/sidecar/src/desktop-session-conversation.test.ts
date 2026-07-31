import { appendFile, mkdtemp, mkdir, open, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopSessionConversationReader } from "./desktop-session-conversation.js";

const THREAD_ID = "00000000-0000-0000-0000-000000000002";

function persistedMessage(id: string, role: "user" | "assistant", text: string): string {
  return JSON.stringify({
    timestamp: "2026-07-28T03:25:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      id,
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id: `turn-${id}` },
    },
  });
}

describe("DesktopSessionConversationReader", () => {
  const sandboxes: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      sandboxes.splice(0).map((sandbox) => rm(sandbox, { force: true, recursive: true })),
    );
  });

  async function fixture() {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-session-conversation-"));
    sandboxes.push(codexHome);
    const sessionDirectory = path.join(codexHome, "sessions", "2026", "07", "28");
    await mkdir(sessionDirectory, { recursive: true });
    const sessionPath = path.join(
      sessionDirectory,
      `rollout-2026-07-28T03-25-24-${THREAD_ID}.jsonl`,
    );
    return { codexHome, sessionPath };
  }

  it("recovers the latest active turn from a bounded tail after a multi-megabyte prefix", async () => {
    const { codexHome, sessionPath } = await fixture();
    const prefix = `${"x".repeat(9 * 1024 * 1024)}\n`;
    await writeFile(
      sessionPath,
      `${prefix}${JSON.stringify({
        timestamp: "2026-07-31T15:33:46.484Z",
        type: "turn_context",
        payload: { turn_id: "tail-active-turn" },
      })}\n`,
      "utf8",
    );

    const reader = new DesktopSessionConversationReader();
    const head = await reader.readControlHead({ codexHome, sessionPath, threadId: THREAD_ID });
    expect(head?.activeTurnId).toBe("tail-active-turn");
    expect(head?.sourceBytes).toBeGreaterThan(8 * 1024 * 1024);
  });

  it("restores answered plan questions and the formal plan in event order", async () => {
    const { codexHome, sessionPath } = await fixture();
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-07-28T03:26:00.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "request_user_input",
            call_id: "call-question",
            arguments: JSON.stringify({
              questions: [
                {
                  id: "test_choice",
                  header: "测试选择",
                  question: "这次选择哪一种结果？",
                  isSecret: false,
                  options: [
                    { label: "生成示例计划", description: "生成可查看的计划卡片" },
                    { label: "跳过", description: "不生成计划" },
                  ],
                },
                {
                  id: "secret",
                  header: "秘密",
                  question: "输入临时秘密",
                  isSecret: true,
                },
              ],
            }),
            internal_chat_message_metadata_passthrough: { turn_id: "turn-plan" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:03.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-question",
            output: JSON.stringify({
              answers: {
                test_choice: { answers: ["生成示例计划"] },
                secret: { answers: ["never-render-this"] },
              },
            }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:10.000Z",
          type: "event_msg",
          payload: {
            type: "item_completed",
            turn_id: "turn-plan",
            item: {
              id: "plan-1",
              type: "Plan",
              text: "# 计划模式测试\n\n1. 显示问题\n2. 显示计划",
            },
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const reader = new DesktopSessionConversationReader();
    const items = await reader.read({ codexHome, sessionPath, threadId: THREAD_ID });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "interaction-call-question",
      kind: "interaction-record",
      status: "answered",
      turnId: "turn-plan",
      questions: [
        { answers: ["生成示例计划"], id: "test_choice" },
        { id: "secret", isSecret: true },
      ],
    });
    expect(JSON.stringify(items[0])).not.toContain("never-render-this");
    expect(items[1]).toMatchObject({
      id: "plan-1",
      kind: "formal-plan",
      turnId: "turn-plan",
    });
  });

  it("restores ordinary user and assistant messages, attachments, and interactions in source order", async () => {
    const { codexHome, sessionPath } = await fixture();
    const imagePath = path.join(codexHome, "uploaded-proof.png");
    await writeFile(imagePath, "not-an-image-fixture", "utf8");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-07-28T03:25:56.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "host-injected-user-1",
            role: "user",
            content: [
              { type: "input_text", text: "<recommended_plugins>...</recommended_plugins>" },
            ],
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:25:57.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "host-injected-user-2",
            role: "user",
            content: [{ type: "input_text", text: "# AGENTS.md instructions" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:25:58.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "user-1",
            role: "user",
            content: [
              { type: "input_text", text: "第一段" },
              { type: "input_text", text: "第二段" },
            ],
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:25:59.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "第一段\n第二段",
            local_images: [imagePath],
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "assistant-1",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "先检查。" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "request_user_input",
            call_id: "call-question",
            arguments: JSON.stringify({
              questions: [
                {
                  id: "choice",
                  header: "选择",
                  question: "是否继续？",
                  isSecret: false,
                  options: [{ label: "继续", description: "继续执行" }],
                },
              ],
            }),
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-question",
            output: JSON.stringify({ answers: { choice: { answers: ["继续"] } } }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:03.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "assistant-2",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "已经完成。" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const reader = new DesktopSessionConversationReader();
    const items = await reader.read({ codexHome, sessionPath, threadId: THREAD_ID });

    expect(items).toMatchObject([
      {
        id: "user-1",
        kind: "user-message",
        text: "第一段\n第二段",
        turnId: "turn-1",
        attachments: [{ kind: "image", name: "uploaded-proof.png", path: imagePath }],
      },
      {
        id: "assistant-1",
        kind: "assistant-message",
        phase: "commentary",
        text: "先检查。",
        turnId: "turn-1",
      },
      {
        id: "interaction-call-question",
        kind: "interaction-record",
        status: "answered",
        turnId: "turn-1",
      },
      {
        id: "assistant-2",
        kind: "assistant-message",
        phase: "final_answer",
        text: "已经完成。",
        turnId: "turn-1",
      },
    ]);
    expect(items.map((item) => item.id)).not.toContain("host-injected-user-1");
    expect(items.map((item) => item.id)).not.toContain("host-injected-user-2");
  });

  it("streams the complete session instead of dropping messages before the old 8 MiB tail", async () => {
    const { codexHome, sessionPath } = await fixture();
    const message = (id: string, role: "user" | "assistant", text: string) =>
      JSON.stringify({
        timestamp: "2026-07-28T03:25:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          id,
          role,
          content: [{ type: role === "user" ? "input_text" : "output_text", text }],
          internal_chat_message_metadata_passthrough: { turn_id: `turn-${id}` },
        },
      });
    const padding = JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", padding: "x".repeat(1024) },
    });
    await writeFile(
      sessionPath,
      [
        message("early-user", "user", "最早的用户消息"),
        message("early-assistant", "assistant", "最早的助手消息"),
        ...Array.from({ length: 8_300 }, () => padding),
        message("late-user", "user", "最新的用户消息"),
        message("late-assistant", "assistant", "最新的助手消息"),
        "",
      ].join("\n"),
      "utf8",
    );

    const reader = new DesktopSessionConversationReader();
    const items = await reader.read({ codexHome, sessionPath, threadId: THREAD_ID });

    expect(items.map((item) => item.id)).toEqual([
      "early-user",
      "early-assistant",
      "late-user",
      "late-assistant",
    ]);
  });

  it.runIf(process.platform === "win32")(
    "accepts local Windows extended-length paths while preserving the sessions boundary",
    async () => {
      const { codexHome, sessionPath } = await fixture();
      await writeFile(
        sessionPath,
        `${JSON.stringify({
          timestamp: "2026-07-28T03:25:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "extended-user",
            role: "user",
            content: [{ type: "input_text", text: "来自扩展路径" }],
          },
        })}\n`,
        "utf8",
      );

      const reader = new DesktopSessionConversationReader();
      await expect(
        reader.read({
          codexHome: path.toNamespacedPath(codexHome),
          sessionPath: path.toNamespacedPath(sessionPath),
          threadId: THREAD_ID,
        }),
      ).resolves.toMatchObject([
        { id: "extended-user", kind: "user-message", text: "来自扩展路径" },
      ]);
    },
  );

  it("retains explicit diagnostics when a bounded streaming limit skips a record", async () => {
    const { codexHome, sessionPath } = await fixture();
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-07-28T03:25:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "before-limit",
            role: "user",
            content: [{ type: "input_text", text: "限制前" }],
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "token_count", padding: "x".repeat(512) },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:25:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "after-limit",
            role: "assistant",
            content: [{ type: "output_text", text: "限制后" }],
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const reader = new DesktopSessionConversationReader({ maxJsonLineBytes: 256 });
    const input = { codexHome, sessionPath, threadId: THREAD_ID };
    const items = await reader.read(input);

    expect(items.map((item) => item.id)).toEqual([
      "before-limit",
      "after-limit",
      `persisted-history-diagnostic-${THREAD_ID}`,
    ]);
    await expect(reader.readDiagnostic(input)).resolves.toMatchObject({
      status: "truncated",
      reason: "overlong-line",
      skippedLines: 1,
    });
  });

  it("keeps valid messages in source order while marking an invalid middle JSON line partial", async () => {
    const { codexHome, sessionPath } = await fixture();
    await writeFile(
      sessionPath,
      [
        persistedMessage("before-invalid", "user", "损坏行之前"),
        '{"type":"response_item","payload":',
        persistedMessage("after-invalid", "assistant", "损坏行之后"),
        "",
      ].join("\n"),
      "utf8",
    );

    const reader = new DesktopSessionConversationReader();
    const input = { codexHome, sessionPath, threadId: THREAD_ID };

    await expect(reader.read(input)).resolves.toMatchObject([
      { id: "before-invalid", kind: "user-message" },
      { id: "after-invalid", kind: "assistant-message" },
      { id: `persisted-history-diagnostic-${THREAD_ID}`, status: "failed" },
    ]);
    await expect(reader.readDiagnostic(input)).resolves.toMatchObject({
      reason: "invalid-json",
      skippedLines: 1,
      status: "truncated",
    });
  });

  it("does not verify a snapshot whose captured EOF is a half-written JSON line", async () => {
    const { codexHome, sessionPath } = await fixture();
    await writeFile(
      sessionPath,
      `${persistedMessage("before-half-write", "user", "完整消息")}\n{"timestamp":"2026-07-28`,
      "utf8",
    );

    const reader = new DesktopSessionConversationReader();
    const input = { codexHome, sessionPath, threadId: THREAD_ID };

    await expect(reader.read(input)).resolves.toMatchObject([
      { id: "before-half-write", kind: "user-message" },
      { id: `persisted-history-diagnostic-${THREAD_ID}`, status: "failed" },
    ]);
    await expect(reader.readDiagnostic(input)).resolves.toMatchObject({
      reason: "unterminated-line",
      skippedLines: 1,
      status: "truncated",
    });
  });

  it("marks invalid JSON in the recent root-task window partial", async () => {
    const { codexHome, sessionPath } = await fixture();
    await writeFile(
      sessionPath,
      [
        persistedMessage("recent-before-invalid", "user", "损坏行之前"),
        '{"type":"response_item","payload":',
        persistedMessage("recent-after-invalid", "assistant", "损坏行之后"),
        "",
      ].join("\n"),
      "utf8",
    );

    const reader = new DesktopSessionConversationReader();
    const result = await reader.readWithDiagnostic(
      { codexHome, sessionPath, threadId: THREAD_ID },
      "recent",
    );

    expect(result?.items.map((item) => item.id)).toEqual([
      "recent-before-invalid",
      "recent-after-invalid",
      `persisted-history-diagnostic-${THREAD_ID}`,
    ]);
    expect(result?.diagnostic).toMatchObject({
      reason: "invalid-json",
      skippedLines: 1,
      status: "truncated",
    });
  });

  it("does not verify a recent root-task window whose captured EOF is half-written", async () => {
    const { codexHome, sessionPath } = await fixture();
    await writeFile(
      sessionPath,
      `${persistedMessage("recent-before-half-write", "user", "完整消息")}\n{"timestamp":"2026-07-28`,
      "utf8",
    );

    const reader = new DesktopSessionConversationReader();
    const result = await reader.readWithDiagnostic(
      { codexHome, sessionPath, threadId: THREAD_ID },
      "recent",
    );

    expect(result?.items.map((item) => item.id)).toEqual([
      "recent-before-half-write",
      `persisted-history-diagnostic-${THREAD_ID}`,
    ]);
    expect(result?.diagnostic).toMatchObject({
      reason: "unterminated-line",
      skippedLines: 1,
      status: "truncated",
    });
  });

  it("uses a stable reason priority and neutral summary for mixed damaged records", async () => {
    const { codexHome, sessionPath } = await fixture();
    await writeFile(
      sessionPath,
      [
        persistedMessage("mixed-valid", "user", "完整消息"),
        JSON.stringify({ type: "event_msg", payload: { padding: "x".repeat(2_048) } }),
        '{"type":"response_item","payload":',
      ].join("\n") + '\n{"timestamp":"2026-07-28',
      "utf8",
    );

    const reader = new DesktopSessionConversationReader({ maxJsonLineBytes: 512 });
    const result = await reader.readWithDiagnostic({
      codexHome,
      sessionPath,
      threadId: THREAD_ID,
    });

    expect(result?.diagnostic).toMatchObject({
      reason: "unterminated-line",
      skippedLines: 3,
      status: "truncated",
    });
    const diagnosticItem = result?.items.at(-1);
    expect(diagnosticItem).toMatchObject({
      id: `persisted-history-diagnostic-${THREAD_ID}`,
      kind: "tool",
    });
    if (diagnosticItem?.kind !== "tool") {
      throw new Error("Expected a persisted-history tool diagnostic.");
    }
    expect(diagnosticItem.summary).toContain("3 条记录未完整读取");
  });

  it("returns a complete diagnostic for a fully terminated valid JSONL snapshot", async () => {
    const { codexHome, sessionPath } = await fixture();
    const content = [
      persistedMessage("valid-user", "user", "合法用户消息"),
      persistedMessage("valid-assistant", "assistant", "合法助手消息"),
      "",
    ].join("\n");
    await writeFile(sessionPath, content, "utf8");

    const reader = new DesktopSessionConversationReader();
    const result = await reader.readWithDiagnostic({
      codexHome,
      sessionPath,
      threadId: THREAD_ID,
    });

    expect(result?.items.map((item) => item.id)).toEqual(["valid-user", "valid-assistant"]);
    expect(result?.diagnostic).toEqual({
      capturedBytes: Buffer.byteLength(content).toString(),
      processedBytes: Buffer.byteLength(content).toString(),
      skippedItems: 0,
      skippedLines: 0,
      status: "complete",
    });
  });

  it("retries once and verifies the new snapshot when a complete line is appended", async () => {
    const { codexHome, sessionPath } = await fixture();
    const capturedContent = `${persistedMessage("captured-user", "user", "已捕获")}\n`;
    const appendedContent = `${persistedMessage("appended-assistant", "assistant", "稍后追加")}\n`;
    await writeFile(sessionPath, capturedContent, "utf8");

    const probeHandle = await open(sessionPath, "r");
    type ReadMethod = typeof probeHandle.read;
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as { read: ReadMethod };
    const originalRead = fileHandlePrototype.read;
    await probeHandle.close();
    let appended = false;
    vi.spyOn(fileHandlePrototype, "read").mockImplementation(async function (
      this: Awaited<ReturnType<typeof open>>,
      ...args: Parameters<ReadMethod>
    ) {
      const result = (await Reflect.apply(originalRead, this, args)) as unknown as Awaited<
        ReturnType<ReadMethod>
      >;
      if (!appended) {
        appended = true;
        await appendFile(sessionPath, appendedContent, "utf8");
      }
      return result;
    });

    const reader = new DesktopSessionConversationReader({ readChunkBytes: 32 });
    const result = await reader.readWithDiagnostic({
      codexHome,
      sessionPath,
      threadId: THREAD_ID,
    });

    expect(appended).toBe(true);
    const stableContent = capturedContent + appendedContent;
    expect(result?.items.map((item) => item.id)).toEqual(["captured-user", "appended-assistant"]);
    expect(result?.diagnostic).toEqual({
      capturedBytes: Buffer.byteLength(stableContent).toString(),
      processedBytes: Buffer.byteLength(stableContent).toString(),
      skippedItems: 0,
      skippedLines: 0,
      status: "complete",
    });
  });

  it("fails closed when the JSONL keeps growing during the full-read retry", async () => {
    const { codexHome, sessionPath } = await fixture();
    const capturedContent = `${persistedMessage("captured-user", "user", "已捕获")}\n`;
    await writeFile(sessionPath, capturedContent, "utf8");

    const probeHandle = await open(sessionPath, "r");
    type ReadMethod = typeof probeHandle.read;
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as { read: ReadMethod };
    const originalRead = fileHandlePrototype.read;
    await probeHandle.close();
    let appendCount = 0;
    vi.spyOn(fileHandlePrototype, "read").mockImplementation(async function (
      this: Awaited<ReturnType<typeof open>>,
      ...args: Parameters<ReadMethod>
    ) {
      const result = (await Reflect.apply(originalRead, this, args)) as unknown as Awaited<
        ReturnType<ReadMethod>
      >;
      if (appendCount < 2) {
        appendCount += 1;
        await appendFile(
          sessionPath,
          `${persistedMessage(`appended-${appendCount}`, "assistant", `追加 ${appendCount}`)}\n`,
          "utf8",
        );
      }
      return result;
    });

    const reader = new DesktopSessionConversationReader({ readChunkBytes: 1024 * 1024 });
    const result = await reader.readWithDiagnostic({
      codexHome,
      sessionPath,
      threadId: THREAD_ID,
    });

    expect(appendCount).toBe(2);
    expect(result?.items).toEqual([
      expect.objectContaining({
        id: `persisted-history-diagnostic-${THREAD_ID}`,
        kind: "tool",
        status: "failed",
      }),
    ]);
    expect(result?.diagnostic).toMatchObject({
      reason: "unstable-file",
      skippedItems: 0,
      skippedLines: 0,
      status: "failed",
    });
  });

  it("retries the recent projection once when a complete line is appended during the read", async () => {
    const { codexHome, sessionPath } = await fixture();
    const capturedContent = `${persistedMessage("recent-captured-user", "user", "已捕获")}\n`;
    const appendedContent = `${persistedMessage(
      "recent-appended-assistant",
      "assistant",
      "稍后追加",
    )}\n`;
    await writeFile(sessionPath, capturedContent, "utf8");

    const probeHandle = await open(sessionPath, "r");
    type ReadMethod = typeof probeHandle.read;
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as { read: ReadMethod };
    const originalRead = fileHandlePrototype.read;
    await probeHandle.close();
    let appended = false;
    vi.spyOn(fileHandlePrototype, "read").mockImplementation(async function (
      this: Awaited<ReturnType<typeof open>>,
      ...args: Parameters<ReadMethod>
    ) {
      const result = (await Reflect.apply(originalRead, this, args)) as unknown as Awaited<
        ReturnType<ReadMethod>
      >;
      if (!appended) {
        appended = true;
        await appendFile(sessionPath, appendedContent, "utf8");
      }
      return result;
    });

    const reader = new DesktopSessionConversationReader();
    const result = await reader.readWithDiagnostic(
      { codexHome, sessionPath, threadId: THREAD_ID },
      "recent",
    );

    expect(appended).toBe(true);
    expect(result?.items.map((item) => item.id)).toEqual([
      "recent-captured-user",
      "recent-appended-assistant",
    ]);
    expect(result?.diagnostic).toEqual({
      capturedBytes: Buffer.byteLength(capturedContent + appendedContent).toString(),
      processedBytes: Buffer.byteLength(capturedContent + appendedContent).toString(),
      skippedItems: 0,
      skippedLines: 0,
      status: "complete",
    });
  });

  it("fails closed after exactly one recent retry when the JSONL keeps growing", async () => {
    const { codexHome, sessionPath } = await fixture();
    const capturedContent = `${persistedMessage("recent-growing-user", "user", "已捕获")}\n`;
    await writeFile(sessionPath, capturedContent, "utf8");

    const probeHandle = await open(sessionPath, "r");
    type ReadMethod = typeof probeHandle.read;
    const fileHandlePrototype = Object.getPrototypeOf(probeHandle) as { read: ReadMethod };
    const originalRead = fileHandlePrototype.read;
    await probeHandle.close();
    let appendCount = 0;
    vi.spyOn(fileHandlePrototype, "read").mockImplementation(async function (
      this: Awaited<ReturnType<typeof open>>,
      ...args: Parameters<ReadMethod>
    ) {
      const result = (await Reflect.apply(originalRead, this, args)) as unknown as Awaited<
        ReturnType<ReadMethod>
      >;
      if (appendCount < 2) {
        appendCount += 1;
        await appendFile(
          sessionPath,
          `${persistedMessage(
            `recent-growing-${appendCount}`,
            "assistant",
            `追加 ${appendCount}`,
          )}\n`,
          "utf8",
        );
      }
      return result;
    });

    const reader = new DesktopSessionConversationReader();
    const result = await reader.readWithDiagnostic(
      { codexHome, sessionPath, threadId: THREAD_ID },
      "recent",
    );

    expect(appendCount).toBe(2);
    expect(result?.items).toEqual([
      expect.objectContaining({
        id: `persisted-history-diagnostic-${THREAD_ID}`,
        kind: "tool",
        status: "failed",
      }),
    ]);
    expect(result?.diagnostic).toMatchObject({
      reason: "unstable-file",
      skippedItems: 0,
      skippedLines: 0,
      status: "failed",
    });
  });

  it("restores the latest Desktop runtime parameters without requiring a new message", async () => {
    const { codexHome, sessionPath } = await fixture();
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-07-28T03:25:00.000Z",
          type: "turn_context",
          payload: {
            approval_policy: "on-request",
            approvals_reviewer: "auto_review",
            collaboration_mode: { mode: "plan", settings: {} },
            effort: "high",
            model: "old-model",
            service_tier: "fast",
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:00.000Z",
          type: "turn_context",
          payload: {
            approval_policy: "never",
            approvals_reviewer: "guardian_subagent",
            collaboration_mode: { mode: "default", settings: {} },
            effort: "max",
            model: "gpt-5.6-sol",
            service_tier: "standard",
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const reader = new DesktopSessionConversationReader();
    await expect(
      reader.readRuntimeSettings({ codexHome, sessionPath, threadId: THREAD_ID }),
    ).resolves.toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "guardian_subagent",
      collaborationMode: "default",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      serviceTier: "standard",
    });
  });

  it("reads runtime settings from a bounded tail without populating the conversation cache", async () => {
    const { codexHome, sessionPath } = await fixture();
    const fixedTime = new Date("2026-07-28T03:30:00.000Z");
    const session = (id: "new-user" | "old-user", text: "新值" | "旧值") =>
      [
        JSON.stringify({
          timestamp: "2026-07-28T03:25:00.000Z",
          type: "turn_context",
          payload: { effort: "high", model: "gpt-5.6-sol" },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:25:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id,
            role: "user",
            content: [{ type: "input_text", text }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn-cache" },
          },
        }),
        "",
      ].join("\n");
    await writeFile(sessionPath, session("old-user", "旧值"), "utf8");
    await utimes(sessionPath, fixedTime, fixedTime);

    const reader = new DesktopSessionConversationReader();
    const input = { codexHome, sessionPath, threadId: THREAD_ID };
    await expect(reader.readRuntimeSettings(input)).resolves.toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    });

    await writeFile(sessionPath, session("new-user", "新值"), "utf8");
    await utimes(sessionPath, fixedTime, fixedTime);
    await expect(reader.read(input)).resolves.toMatchObject([
      { id: "new-user", kind: "user-message", text: "新值" },
    ]);
  });

  it("restores runtime settings from the tail after a prefix larger than 8 MiB", async () => {
    const { codexHome, sessionPath } = await fixture();
    const padding = JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", padding: "x".repeat(1024) },
    });
    await writeFile(
      sessionPath,
      [
        ...Array.from({ length: 8_300 }, () => padding),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:00.000Z",
          type: "turn_context",
          payload: {
            collaboration_mode: { mode: "default", settings: {} },
            effort: "max",
            model: "gpt-5.6-sol",
            service_tier: "standard",
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const reader = new DesktopSessionConversationReader();
    await expect(
      reader.readRuntimeSettings({ codexHome, sessionPath, threadId: THREAD_ID }),
    ).resolves.toMatchObject({
      collaborationMode: "default",
      model: "gpt-5.6-sol",
      reasoningEffort: "max",
      serviceTier: "standard",
    });
  });

  it("offers a bounded recent projection for root tasks without scanning old messages", async () => {
    const { codexHome, sessionPath } = await fixture();
    const message = (id: string, role: "user" | "assistant", text: string) =>
      JSON.stringify({
        timestamp: "2026-07-28T03:25:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          id,
          role,
          content: [{ type: role === "user" ? "input_text" : "output_text", text }],
          internal_chat_message_metadata_passthrough: { turn_id: `turn-${id}` },
        },
      });
    const padding = JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", padding: "x".repeat(1024) },
    });
    await writeFile(
      sessionPath,
      [
        message("old-user", "user", "尾部窗口以前"),
        message("old-assistant", "assistant", "尾部窗口以前"),
        ...Array.from({ length: 8_300 }, () => padding),
        message("recent-user", "user", "尾部用户消息"),
        message("recent-assistant", "assistant", "尾部助手消息"),
        "",
      ].join("\n"),
      "utf8",
    );

    const reader = new DesktopSessionConversationReader();
    await expect(
      reader.readRecent({ codexHome, sessionPath, threadId: THREAD_ID }),
    ).resolves.toMatchObject([
      { id: "recent-user", kind: "user-message" },
      { id: "recent-assistant", kind: "assistant-message" },
    ]);
  });

  it("pairs persisted tool calls with outputs and updates a running call in place", async () => {
    const { codexHome, sessionPath } = await fixture();
    const call = JSON.stringify({
      timestamp: "2026-07-28T03:26:00.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        id: "tool-item-1",
        name: "shell_command",
        call_id: "call-shell",
        arguments: JSON.stringify({ command: "Get-ChildItem -Force" }),
        internal_chat_message_metadata_passthrough: { turn_id: "turn-tools" },
      },
    });
    await writeFile(sessionPath, `${call}\n`, "utf8");

    const reader = new DesktopSessionConversationReader();
    const input = { codexHome, sessionPath, threadId: THREAD_ID };
    await expect(reader.read(input)).resolves.toEqual([
      expect.objectContaining({
        createdAt: "2026-07-28T03:26:00.000Z",
        id: "tool-item-1",
        kind: "tool",
        status: "running",
        title: "运行命令",
        turnId: "turn-tools",
      }),
    ]);

    await appendFile(
      sessionPath,
      `${JSON.stringify({
        timestamp: "2026-07-28T03:26:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          id: "tool-output-1",
          call_id: "call-shell",
          output: "Exit code: 0\nvisible command output",
          internal_chat_message_metadata_passthrough: { turn_id: "turn-tools" },
        },
      })}\n`,
      "utf8",
    );

    const completed = await reader.read(input);
    expect(completed).toEqual([
      expect.objectContaining({
        createdAt: "2026-07-28T03:26:00.000Z",
        id: "tool-item-1",
        kind: "tool",
        status: "complete",
        summary: "Get-ChildItem -Force",
        detail: "Exit code: 0\nvisible command output",
        title: "运行命令",
        turnId: "turn-tools",
      }),
    ]);
  });

  it("marks a shell command failed from strict nonzero exit-code metadata", async () => {
    const { codexHome, sessionPath } = await fixture();
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-07-28T03:26:00.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            id: "failed-shell",
            name: "shell_command",
            call_id: "failed-shell-call",
            arguments: JSON.stringify({ command: "exit 17" }),
            internal_chat_message_metadata_passthrough: { turn_id: "turn-failed-shell" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            id: "failed-shell-output",
            call_id: "failed-shell-call",
            output: "Exit code: 17\nvisible failure output",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-failed-shell" },
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const items = await new DesktopSessionConversationReader().read({
      codexHome,
      sessionPath,
      threadId: THREAD_ID,
    });

    expect(items).toMatchObject([
      {
        id: "failed-shell",
        kind: "tool",
        status: "failed",
        summary: "exit 17",
        detail: "Exit code: 17\nvisible failure output",
        title: "运行命令",
        turnId: "turn-failed-shell",
      },
    ]);
  });

  it("bounds known shell command and output details without exposing unknown tool payloads", async () => {
    const { codexHome, sessionPath } = await fixture();
    const longCommand = `pwsh -Command ${"x".repeat(2_000)}`;
    const longOutput = `Exit code: 0\n${"y".repeat(20_000)}`;
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-07-28T03:26:00.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            id: "bounded-shell",
            name: "shell_command",
            call_id: "bounded-shell-call",
            arguments: JSON.stringify({ command: longCommand }),
            internal_chat_message_metadata_passthrough: { turn_id: "turn-bounded-shell" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            id: "bounded-shell-output",
            call_id: "bounded-shell-call",
            output: longOutput,
            internal_chat_message_metadata_passthrough: { turn_id: "turn-bounded-shell" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            id: "unknown-bounded",
            name: "unknown_tool",
            call_id: "unknown-bounded-call",
            arguments: JSON.stringify({ command: "must-stay-private" }),
            internal_chat_message_metadata_passthrough: { turn_id: "turn-bounded-shell" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:03.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            id: "unknown-bounded-output",
            call_id: "unknown-bounded-call",
            output: "must-stay-private-output",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-bounded-shell" },
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const items = await new DesktopSessionConversationReader().read({
      codexHome,
      sessionPath,
      threadId: THREAD_ID,
    });
    const shell = items[0];
    const unknown = items[1];
    expect(shell).toMatchObject({ id: "bounded-shell", kind: "tool", status: "complete" });
    if (shell?.kind !== "tool") throw new Error("Expected bounded shell tool.");
    expect(shell.summary?.length).toBeLessThanOrEqual(1_024);
    expect(shell.detail?.length).toBeLessThanOrEqual(16_384);
    expect(shell.summary).toContain("内容已截断");
    expect(shell.detail).toContain("内容已截断");
    expect(unknown).toMatchObject({ id: "unknown-bounded", kind: "tool", status: "complete" });
    expect(unknown).not.toHaveProperty("summary");
    expect(unknown).not.toHaveProperty("detail");
    expect(JSON.stringify(unknown)).not.toContain("must-stay-private");
  });

  it("restores trusted local image views and generated-image paths", async () => {
    const { codexHome, sessionPath } = await fixture();
    const viewedPath = path.join(codexHome, "workspace", "viewed.png");
    const generatedPath = path.join(codexHome, "workspace", "generated.png");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-07-28T03:26:00.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            id: "view-image-item",
            name: "view_image",
            call_id: "view-image-call",
            arguments: JSON.stringify({ path: viewedPath }),
            internal_chat_message_metadata_passthrough: { turn_id: "turn-images" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            id: "view-image-output",
            call_id: "view-image-call",
            output: JSON.stringify({ success: true }),
            internal_chat_message_metadata_passthrough: { turn_id: "turn-images" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            id: "generate-image-item",
            name: "image_gen__imagegen",
            call_id: "generate-image-call",
            arguments: JSON.stringify({ prompt: "must-not-render-image-prompt" }),
            internal_chat_message_metadata_passthrough: { turn_id: "turn-images" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:03.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            id: "generate-image-output",
            call_id: "generate-image-call",
            output: JSON.stringify({
              saved_path: generatedPath,
              revised_prompt: "must-not-render-revised-prompt",
            }),
            internal_chat_message_metadata_passthrough: { turn_id: "turn-images" },
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const items = await new DesktopSessionConversationReader().read({
      codexHome,
      sessionPath,
      threadId: THREAD_ID,
    });

    expect(items).toEqual([
      {
        action: "viewed",
        attachments: [{ kind: "image", name: "viewed.png", path: viewedPath }],
        createdAt: "2026-07-28T03:26:00.000Z",
        id: "view-image-item",
        kind: "image-activity",
        status: "complete",
        turnId: "turn-images",
      },
      {
        action: "generated",
        attachments: [{ kind: "image", name: "generated.png", path: generatedPath }],
        createdAt: "2026-07-28T03:26:02.000Z",
        id: "generate-image-item",
        kind: "image-activity",
        status: "complete",
        turnId: "turn-images",
      },
    ]);
    expect(JSON.stringify(items)).not.toContain("must-not-render");
  });

  it("marks an unpaired running call failed once a later turn proves it is no longer active", async () => {
    const { codexHome, sessionPath } = await fixture();
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-07-28T03:26:00.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            id: "abandoned-tool",
            name: "shell_command",
            call_id: "abandoned-call",
            arguments: JSON.stringify({ command: "Get-Process" }),
            internal_chat_message_metadata_passthrough: { turn_id: "turn-abandoned" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:27:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "later-user",
            role: "user",
            content: [{ type: "input_text", text: "开始下一轮" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn-later" },
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const items = await new DesktopSessionConversationReader().read({
      codexHome,
      sessionPath,
      threadId: THREAD_ID,
    });

    expect(items).toMatchObject([
      {
        id: "abandoned-tool",
        kind: "tool",
        status: "failed",
        summary: "Get-Process",
        title: "运行命令",
        turnId: "turn-abandoned",
      },
      { id: "later-user", kind: "user-message", turnId: "turn-later" },
    ]);
    expect(items[0]).not.toHaveProperty("detail");
  });

  it("projects custom and tool-search calls without duplicating question interactions", async () => {
    const { codexHome, sessionPath } = await fixture();
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-07-28T03:26:00.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            id: "custom-item",
            name: "unrecognized_private_tool",
            call_id: "call-custom",
            status: "in_progress",
            input: "never-render-custom-input",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-tools" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:01.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            id: "custom-output",
            call_id: "call-custom",
            output: JSON.stringify({
              error: "never-render-custom-error",
              success: false,
            }),
            internal_chat_message_metadata_passthrough: { turn_id: "turn-tools" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:02.000Z",
          type: "response_item",
          payload: {
            type: "tool_search_call",
            id: "search-item",
            call_id: "call-search",
            status: "in_progress",
            arguments: { query: "never-render-tool-query" },
            internal_chat_message_metadata_passthrough: { turn_id: "turn-tools" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:03.000Z",
          type: "response_item",
          payload: {
            type: "tool_search_output",
            id: "search-output",
            call_id: "call-search",
            status: "completed",
            tools: [{ name: "never-render-tool-result" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn-tools" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:04.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            id: "question-item",
            name: "request_user_input",
            call_id: "call-question-only",
            arguments: JSON.stringify({
              questions: [
                {
                  id: "choice",
                  header: "选择",
                  question: "是否继续？",
                  isSecret: false,
                },
              ],
            }),
            internal_chat_message_metadata_passthrough: { turn_id: "turn-tools" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:05.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            id: "question-output",
            call_id: "call-question-only",
            output: JSON.stringify({ answers: { choice: { answers: ["继续"] } } }),
            internal_chat_message_metadata_passthrough: { turn_id: "turn-tools" },
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const items = await new DesktopSessionConversationReader().read({
      codexHome,
      sessionPath,
      threadId: THREAD_ID,
    });

    expect(items).toMatchObject([
      {
        id: "custom-item",
        kind: "tool",
        status: "failed",
        title: "使用工具",
        turnId: "turn-tools",
      },
      {
        id: "search-item",
        kind: "tool",
        status: "complete",
        title: "查找可用工具",
        turnId: "turn-tools",
      },
      {
        id: "interaction-call-question-only",
        kind: "interaction-record",
        status: "answered",
        turnId: "turn-tools",
      },
    ]);
    expect(items.filter((item) => item.kind === "tool")).toHaveLength(2);
    expect(JSON.stringify(items)).not.toContain("never-render");
  });

  it("omits collaboration polling and plan-control calls that have dedicated product records", async () => {
    const { codexHome, sessionPath } = await fixture();
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-07-28T03:26:00.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            id: "wait-control-item",
            name: "wait_agent",
            call_id: "wait-control-call",
            arguments: JSON.stringify({ timeout_ms: 30_000 }),
            internal_chat_message_metadata_passthrough: { turn_id: "turn-control" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            id: "wait-control-output",
            call_id: "wait-control-call",
            output: "never-render-poll-output",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-control" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            id: "plan-control-item",
            name: "update_plan",
            call_id: "plan-control-call",
            arguments: JSON.stringify({ plan: "never-render-plan-control" }),
            internal_chat_message_metadata_passthrough: { turn_id: "turn-control" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:03.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            id: "plan-control-output",
            call_id: "plan-control-call",
            output: "never-render-plan-output",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-control" },
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(
      new DesktopSessionConversationReader().read({
        codexHome,
        sessionPath,
        threadId: THREAD_ID,
      }),
    ).resolves.toEqual([]);
  });

  it("restores only public reasoning summaries and never encrypted reasoning", async () => {
    const { codexHome, sessionPath } = await fixture();
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        timestamp: "2026-07-28T03:26:00.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          id: "reasoning-1",
          summary: [
            { type: "summary_text", text: "先确认公开证据。" },
            { type: "summary_text", text: "再执行定向修复。" },
          ],
          encrypted_content: "never-render-encrypted-chain-of-thought",
          internal_chat_message_metadata_passthrough: { turn_id: "turn-reasoning" },
        },
      })}\n`,
      "utf8",
    );

    const items = await new DesktopSessionConversationReader().read({
      codexHome,
      sessionPath,
      threadId: THREAD_ID,
    });

    expect(items).toEqual([
      {
        createdAt: "2026-07-28T03:26:00.000Z",
        id: "reasoning-1",
        kind: "reasoning-summary",
        text: "先确认公开证据。\n再执行定向修复。",
        turnId: "turn-reasoning",
      },
    ]);
    expect(JSON.stringify(items)).not.toContain("never-render-encrypted");
  });

  it("projects subagent activity, compaction, and safe patch metadata in source order", async () => {
    const { codexHome, sessionPath } = await fixture();
    const changedPath = path.join(codexHome, "workspace", "changed.ts");
    const addedPath = path.join(codexHome, "workspace", "added.ts");
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-07-28T03:26:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "assistant-before-activity",
            role: "assistant",
            content: [{ type: "output_text", text: "开始处理。" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn-events" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:00.500Z",
          type: "response_item",
          payload: {
            type: "function_call",
            id: "collab-call-item",
            name: "spawn_agent",
            call_id: "subagent-event-1",
            arguments: JSON.stringify({ prompt: "never-render-subagent-prompt" }),
            internal_chat_message_metadata_passthrough: { turn_id: "turn-events" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:01.000Z",
          type: "event_msg",
          payload: {
            type: "sub_agent_activity",
            event_id: "subagent-event-1",
            occurred_at_ms: 1785218761000,
            agent_thread_id: "agent-thread-1",
            agent_path: "/root/persisted-reader",
            kind: "started",
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:01.500Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            id: "collab-output-item",
            call_id: "subagent-event-1",
            output: JSON.stringify({ result: "never-render-subagent-output", success: true }),
            internal_chat_message_metadata_passthrough: { turn_id: "turn-events" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:01.600Z",
          type: "event_msg",
          payload: {
            type: "sub_agent_activity",
            event_id: "subagent-event-2",
            occurred_at_ms: 1785218761600,
            agent_thread_id: "agent-thread-1",
            agent_path: "/root/persisted-reader",
            kind: "interacted",
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:01.700Z",
          type: "event_msg",
          payload: {
            type: "sub_agent_activity",
            event_id: "subagent-event-3",
            occurred_at_ms: 1785218761700,
            agent_thread_id: "agent-thread-1",
            agent_path: "/root/persisted-reader",
            kind: "interrupted",
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:01.800Z",
          type: "event_msg",
          payload: {
            type: "sub_agent_activity",
            event_id: "subagent-event-4",
            occurred_at_ms: 1785218761800,
            agent_thread_id: "agent-thread-1",
            agent_path: "/root/persisted-reader",
            kind: "future-unknown-state",
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:02.000Z",
          type: "event_msg",
          payload: { type: "context_compacted" },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:02.000Z",
          type: "event_msg",
          payload: { type: "context_compacted" },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:02.500Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            id: "patch-tool-item",
            name: "apply_patch",
            call_id: "patch-call",
            status: "completed",
            input: "never-render-patch-input",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-events" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:03.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            id: "patch-tool-output",
            call_id: "patch-call",
            output: "never-render-patch-output",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-events" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:04.000Z",
          type: "event_msg",
          payload: {
            type: "patch_apply_end",
            call_id: "patch-call",
            turn_id: "turn-events",
            stdout: "never-render-patch-stdout",
            stderr: "never-render-patch-stderr",
            success: true,
            status: "completed",
            changes: {
              [changedPath]: {
                type: "update",
                unified_diff: "@@ -1,2 +1,3 @@\n-old value\n+new value\n stable\n+added value\n",
                move_path: null,
              },
              [addedPath]: {
                type: "add",
                unified_diff: "@@ -0,0 +1,2 @@\n+first line\n+second line\n",
                move_path: null,
              },
            },
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const items = await new DesktopSessionConversationReader().read({
      codexHome,
      sessionPath,
      threadId: THREAD_ID,
    });

    expect(items).toMatchObject([
      { id: "assistant-before-activity", kind: "assistant-message", turnId: "turn-events" },
      {
        action: "spawn",
        agents: [{ label: "persisted-reader", threadId: "agent-thread-1" }],
        createdAt: "2026-07-28T03:26:01.000Z",
        id: "subagent-event-1",
        kind: "subagent-activity",
        status: "running",
        turnId: "turn-events",
      },
      {
        action: "update",
        agents: [{ label: "persisted-reader", threadId: "agent-thread-1" }],
        id: "subagent-event-2",
        kind: "subagent-activity",
        status: "complete",
        turnId: "turn-events",
      },
      {
        action: "activity",
        agents: [{ label: "persisted-reader", threadId: "agent-thread-1" }],
        id: "subagent-event-3",
        kind: "subagent-activity",
        status: "failed",
        turnId: "turn-events",
      },
      {
        action: "activity",
        agents: [{ label: "persisted-reader", threadId: "agent-thread-1" }],
        id: "subagent-event-4",
        kind: "subagent-activity",
        status: "failed",
        turnId: "turn-events",
      },
      {
        id: "persisted-context-compaction-turn-events-0-2026-07-28T03:26:02.000Z",
        kind: "tool",
        operation: "context-compaction",
        status: "complete",
        title: "压缩对话上下文",
        turnId: "turn-events",
      },
      {
        id: "persisted-context-compaction-turn-events-1-2026-07-28T03:26:02.000Z",
        kind: "tool",
        operation: "context-compaction",
        status: "complete",
        title: "压缩对话上下文",
        turnId: "turn-events",
      },
      {
        change: "modified",
        id: "patch-patch-call-0",
        kind: "file-change",
        path: changedPath,
        status: "completed",
        additions: 2,
        deletions: 1,
        diff: "@@ -1,2 +1,3 @@\n-old value\n+new value\n stable\n+added value\n",
        turnId: "turn-events",
      },
      {
        change: "added",
        id: "patch-patch-call-1",
        kind: "file-change",
        path: addedPath,
        status: "completed",
        additions: 2,
        deletions: 0,
        diff: "@@ -0,0 +1,2 @@\n+first line\n+second line\n",
        turnId: "turn-events",
      },
    ]);
    expect(JSON.stringify(items)).not.toContain("never-render");
    expect(items.filter((item) => item.kind === "file-change")).toHaveLength(2);
    expect(items.filter((item) => item.kind === "subagent-activity")).toHaveLength(4);
    expect(items.filter((item) => item.kind === "tool")).toHaveLength(2);
  });

  it("flushes an event-confirmed user before a following same-turn user record", async () => {
    const { codexHome, sessionPath } = await fixture();
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-07-28T03:25:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "confirmed-user",
            role: "user",
            content: [{ type: "input_text", text: "第一条真实消息" }],
            internal_chat_message_metadata_passthrough: { turn_id: "same-turn" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:25:01.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "第一条真实消息" },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:25:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "following-user",
            role: "user",
            content: [{ type: "input_text", text: "第二条真实消息" }],
            internal_chat_message_metadata_passthrough: { turn_id: "same-turn" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:25:03.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "following-assistant",
            role: "assistant",
            content: [{ type: "output_text", text: "收到第二条消息" }],
            internal_chat_message_metadata_passthrough: { turn_id: "same-turn" },
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const items = await new DesktopSessionConversationReader().read({
      codexHome,
      sessionPath,
      threadId: THREAD_ID,
    });

    expect(items.map((item) => item.id)).toEqual([
      "confirmed-user",
      "following-user",
      "following-assistant",
    ]);
  });

  it("restores an output whose call is before the bounded recent tail without duplicating it", async () => {
    const { codexHome, sessionPath } = await fixture();
    const padding = JSON.stringify({
      type: "event_msg",
      payload: { type: "token_count", padding: "x".repeat(1024) },
    });
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-07-28T03:25:00.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            id: "old-call-item",
            name: "shell_command",
            call_id: "call-before-tail",
            arguments: "{}",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-tail" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:25:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            id: "old-question-item",
            name: "request_user_input",
            call_id: "question-before-tail",
            arguments: JSON.stringify({
              questions: [
                {
                  id: "choice",
                  header: "选择",
                  question: "是否继续？",
                  isSecret: false,
                },
              ],
            }),
            internal_chat_message_metadata_passthrough: { turn_id: "turn-tail" },
          },
        }),
        ...Array.from({ length: 8_300 }, () => padding),
        JSON.stringify({
          timestamp: "2026-07-28T03:25:59.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            id: "tail-question-output",
            call_id: "question-before-tail",
            output: JSON.stringify({ answers: { choice: { answers: ["继续"] } } }),
            internal_chat_message_metadata_passthrough: { turn_id: "turn-tail" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-28T03:26:00.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            id: "tail-output",
            call_id: "call-before-tail",
            output: JSON.stringify({ success: true }),
            internal_chat_message_metadata_passthrough: { turn_id: "turn-tail" },
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const items = await new DesktopSessionConversationReader().readRecent({
      codexHome,
      sessionPath,
      threadId: THREAD_ID,
    });

    expect(items).toEqual([
      expect.objectContaining({
        id: "tail-output",
        kind: "tool",
        status: "complete",
        title: "使用工具",
        turnId: "turn-tail",
      }),
    ]);
  });

  it("rejects a supplied session path outside Codex home", async () => {
    const { codexHome } = await fixture();
    const outsidePath = path.join(path.dirname(codexHome), `outside-${THREAD_ID}.jsonl`);
    await writeFile(outsidePath, "{}\n", "utf8");
    sandboxes.push(outsidePath);

    const reader = new DesktopSessionConversationReader();
    await expect(
      reader.read({ codexHome, sessionPath: outsidePath, threadId: THREAD_ID }),
    ).resolves.toEqual([]);
    await expect(
      reader.readRuntimeSettings({
        codexHome,
        sessionPath: outsidePath,
        threadId: THREAD_ID,
      }),
    ).resolves.toBeUndefined();
  });
});
