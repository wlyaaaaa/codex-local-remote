import { describe, expect, it, vi } from "vitest";

import { HttpApiClient } from "./api";

describe("HttpApiClient logical mutation idempotency", () => {
  it("sends protected thread metadata mutations to their canonical encoded routes", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new HttpApiClient("/codex-remote/api/v1", fetcher);

    await client.setThreadName("thread / 1", "新的对话名称");
    await client.setThreadArchived("thread / 1", true);
    await client.setThreadArchived("thread / 1", false);

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      [
        "/codex-remote/api/v1/threads/thread%20%2F%201/name",
        "PUT",
        JSON.stringify({ name: "新的对话名称" }),
      ],
      [
        "/codex-remote/api/v1/threads/thread%20%2F%201/archive",
        "PUT",
        JSON.stringify({ archived: true }),
      ],
      [
        "/codex-remote/api/v1/threads/thread%20%2F%201/archive",
        "PUT",
        JSON.stringify({ archived: false }),
      ],
    ]);
  });

  it("retries one transient response loss automatically with the same idempotency key", async () => {
    const response = {
      activeTurnId: "turn-new",
      availableActions: {
        changeModelNextTurn: true,
        interrupt: true,
        reply: false,
        steer: true,
      },
      id: "thread-1",
      items: [],
      mode: "managed",
      state: "running",
      title: "测试",
      updatedAt: "2026-07-28T00:00:00.000Z",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(response), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      );
    const retryDelays: number[] = [];
    const client = new HttpApiClient(
      "/codex-remote/api/v1",
      fetcher,
      async (delayMs) => void retryDelays.push(delayMs),
    );
    const input = {
      clientUserMessageId: "client-logical-send-1",
      prompt: "只执行一次",
    };

    await expect(client.sendTurn("thread-1", input)).resolves.toMatchObject({
      id: "thread-1",
    });

    const firstHeaders = new Headers(fetcher.mock.calls[0]![1]?.headers);
    const secondHeaders = new Headers(fetcher.mock.calls[1]![1]?.headers);
    expect(secondHeaders.get("Idempotency-Key")).toBe(firstHeaders.get("Idempotency-Key"));
    expect(retryDelays).toEqual([300]);
  });

  it("respects a bounded Retry-After while the Desktop runtime recovers", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "DESKTOP_RUNTIME_NOT_READY",
              message: "电脑端连接正在恢复，请稍后重试",
            },
          }),
          {
            headers: { "content-type": "application/json", "retry-after": "2" },
            status: 503,
          },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const retryDelays: number[] = [];
    const client = new HttpApiClient(
      "/codex-remote/api/v1",
      fetcher,
      async (delayMs) => void retryDelays.push(delayMs),
    );

    await expect(client.interrupt("thread-1", "turn-1")).resolves.toBeUndefined();

    const firstHeaders = new Headers(fetcher.mock.calls[0]![1]?.headers);
    const secondHeaders = new Headers(fetcher.mock.calls[1]![1]?.headers);
    expect(secondHeaders.get("Idempotency-Key")).toBe(firstHeaders.get("Idempotency-Key"));
    expect(retryDelays).toEqual([2_000]);
  });

  it("does not turn rate limits or an unqualified 503 into an automatic mutation retry", async () => {
    for (const response of [
      new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "请稍后重试" } }), {
        headers: { "content-type": "application/json", "retry-after": "1" },
        status: 429,
      }),
      new Response(
        JSON.stringify({ error: { code: "RUNTIME_UNAVAILABLE", message: "暂时不可用" } }),
        { headers: { "content-type": "application/json" }, status: 503 },
      ),
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response)
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      const retryDelays: number[] = [];
      const client = new HttpApiClient(
        "/codex-remote/api/v1",
        fetcher,
        async (delayMs) => void retryDelays.push(delayMs),
      );

      await expect(client.interrupt("thread-1", "turn-1")).rejects.toMatchObject({
        status: response.status,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(retryDelays).toEqual([]);
    }
  });

  it("retries a browser upload once without creating a second upload intent", async () => {
    const reference = {
      kind: "file" as const,
      relativePath: "phone-note.txt",
      uploadId: "4d423d3a-b0ec-4c0b-aac6-cb87ce47a438",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("mobile connection changed"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(reference), {
          headers: { "content-type": "application/json" },
          status: 201,
        }),
      );
    const client = new HttpApiClient("/codex-remote/api/v1", fetcher, async () => undefined);
    const file = new File(["from phone"], "phone-note.txt", { type: "text/plain" });

    await expect(client.upload(file)).resolves.toEqual(reference);

    expect(fetcher).toHaveBeenCalledTimes(2);
    const firstHeaders = new Headers(fetcher.mock.calls[0]![1]?.headers);
    const secondHeaders = new Headers(fetcher.mock.calls[1]![1]?.headers);
    expect(secondHeaders.get("Idempotency-Key")).toBe(firstHeaders.get("Idempotency-Key"));
    expect(fetcher.mock.calls[0]![1]?.body).toBe(file);
    expect(fetcher.mock.calls[1]![1]?.body).toBe(file);
  });

  it("retires the key after a confirmed response so a later identical action is a new intent", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 204,
      }),
    );
    const client = new HttpApiClient("/codex-remote/api/v1", fetcher);

    await client.interrupt("thread-1", "turn-1");
    await client.interrupt("thread-1", "turn-1");

    const firstHeaders = new Headers(fetcher.mock.calls[0]![1]?.headers);
    const secondHeaders = new Headers(fetcher.mock.calls[1]![1]?.headers);
    expect(secondHeaders.get("Idempotency-Key")).not.toBe(firstHeaders.get("Idempotency-Key"));
  });

  it("retires a persisted key after the server confirms a replay so refresh can start a new intent", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "IDEMPOTENCY_REPLAY_REQUIRES_REFRESH",
              message: "这项操作已经完成，请刷新页面查看最新状态",
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 409,
          },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new HttpApiClient("/codex-remote/api/v1", fetcher);

    await expect(client.interrupt("thread-1", "turn-1")).rejects.toMatchObject({
      code: "IDEMPOTENCY_REPLAY_REQUIRES_REFRESH",
    });
    await expect(client.interrupt("thread-1", "turn-1")).resolves.toBeUndefined();

    const firstHeaders = new Headers(fetcher.mock.calls[0]![1]?.headers);
    const secondHeaders = new Headers(fetcher.mock.calls[1]![1]?.headers);
    expect(secondHeaders.get("Idempotency-Key")).not.toBe(firstHeaders.get("Idempotency-Key"));
  });
});
