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

  it("reuses one idempotency key when the same logical send is retried after response loss", async () => {
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
    const client = new HttpApiClient("/codex-remote/api/v1", fetcher);
    const input = {
      clientUserMessageId: "client-logical-send-1",
      prompt: "只执行一次",
    };

    await expect(client.sendTurn("thread-1", input)).rejects.toMatchObject({ code: "OFFLINE" });
    await expect(client.sendTurn("thread-1", input)).resolves.toMatchObject({
      id: "thread-1",
    });

    const firstHeaders = new Headers(fetcher.mock.calls[0]![1]?.headers);
    const secondHeaders = new Headers(fetcher.mock.calls[1]![1]?.headers);
    expect(secondHeaders.get("Idempotency-Key")).toBe(firstHeaders.get("Idempotency-Key"));
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
