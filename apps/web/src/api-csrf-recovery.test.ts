import { describe, expect, it, vi } from "vitest";

import { HttpApiClient, type ApiRequestError } from "./api";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function session(csrfToken: string) {
  return {
    authenticated: true,
    csrfToken,
    expiresAt: "2026-07-28T00:00:00.000Z",
    idleExpiresAt: "2026-07-27T12:00:00.000Z",
  };
}

describe("HttpApiClient CSRF 自愈", () => {
  it("审批遇到过期令牌时刷新会话，并用同一幂等键重试一次", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(session("csrf-old")))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "REQUEST_VERIFICATION_FAILED",
              message: "请求验证失败，请刷新页面后重试",
            },
          },
          403,
        ),
      )
      .mockResolvedValueOnce(jsonResponse(session("csrf-new")))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new HttpApiClient("/codex-remote/api/v1", fetcher);

    await client.session();
    await client.resolveApproval("approval-1", { choiceId: "allow-once" });

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/codex-remote/api/v1/auth/session",
      "/codex-remote/api/v1/approvals/approval-1/resolve",
      "/codex-remote/api/v1/auth/session",
      "/codex-remote/api/v1/approvals/approval-1/resolve",
    ]);
    const firstMutationHeaders = new Headers(fetcher.mock.calls[1]![1]?.headers);
    const retriedMutationHeaders = new Headers(fetcher.mock.calls[3]![1]?.headers);
    expect(firstMutationHeaders.get("X-CSRF-Token")).toBe("csrf-old");
    expect(retriedMutationHeaders.get("X-CSRF-Token")).toBe("csrf-new");
    expect(retriedMutationHeaders.get("Idempotency-Key")).toBe(
      firstMutationHeaders.get("Idempotency-Key"),
    );
  });

  it("会话本身失效时保留原始审批错误，不循环重试", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(session("csrf-old")))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "REQUEST_VERIFICATION_FAILED",
              message: "请求验证失败，请刷新页面后重试",
            },
          },
          403,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "AUTHENTICATION_REQUIRED",
              message: "请先登录",
            },
          },
          401,
        ),
      );
    const client = new HttpApiClient("/codex-remote/api/v1", fetcher);

    await client.session();
    await expect(
      client.resolveApproval("approval-1", { choiceId: "allow-once" }),
    ).rejects.toMatchObject({
      code: "REQUEST_VERIFICATION_FAILED",
      status: 403,
    } satisfies Partial<ApiRequestError>);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
