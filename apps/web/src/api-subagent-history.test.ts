import { describe, expect, it, vi } from "vitest";

import { HttpApiClient, subagentHistoryIntegrityFrom } from "./api";

const partialIntegrity = {
  status: "partial",
  reason: "pagination-pending",
  observedCount: 2,
  streams: {
    current: { status: "more-available", observedCount: 2 },
    archived: { status: "not-requested", observedCount: 0 },
  },
} as const;

describe("subagent history integrity transport", () => {
  it("parses a valid compatibility header and ignores malformed metadata", () => {
    const valid = new Headers({
      "X-Subagent-History-Integrity": encodeURIComponent(JSON.stringify(partialIntegrity)),
    });
    expect(subagentHistoryIntegrityFrom(valid)).toEqual(partialIntegrity);
    expect(
      subagentHistoryIntegrityFrom(new Headers({ "X-Subagent-History-Integrity": "%not-json" })),
    ).toBeUndefined();
  });

  it("keeps the array payload and attaches integrity metadata to the Web page result", async () => {
    const response = new Response(
      JSON.stringify([
        {
          threadId: "agent-1",
          parentThreadId: "thread-1",
          title: "只读核验",
          depth: 1,
          state: "completed",
          updatedAt: "2026-07-27T00:00:00.000Z",
          isDirectlyControllable: false,
        },
      ]),
      {
        headers: {
          "Content-Type": "application/json",
          "X-Next-Cursor": "next-page",
          "X-Subagent-History-Integrity": encodeURIComponent(JSON.stringify(partialIntegrity)),
        },
      },
    );
    const fetcher = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetcher);
    const client = new HttpApiClient("/codex-remote/api/v1", fetcher);

    await expect(client.subagents("thread-1")).resolves.toEqual({
      items: [expect.objectContaining({ threadId: "agent-1" })],
      nextCursor: "next-page",
      historyIntegrity: partialIntegrity,
    });
  });
});
