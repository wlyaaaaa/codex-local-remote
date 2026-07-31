import { describe, expect, it } from "vitest";
import { ApiRequestError } from "./api";
import {
  DIAGNOSTICS_LAST_KNOWN_TTL_MS,
  WORKSPACE_RECOVERY_RETRY_MS,
  retainLastKnownDiagnosticSnapshot,
  workspaceLoadFailurePolicy,
} from "./workspace-recovery";

describe("工作区请求恢复策略", () => {
  it("401 立即回到登录，不把会话过期伪装成电脑离线", () => {
    expect(workspaceLoadFailurePolicy(new ApiRequestError("登录已过期", 401), true)).toEqual({
      kind: "authentication",
      preserveSnapshot: false,
      retryAfterMs: undefined,
    });
  });

  it.each([0, 502, 503, 504])("状态 %s 会自动重试，并在已有快照时保留当前界面", (status) => {
    expect(workspaceLoadFailurePolicy(new ApiRequestError("暂时不可用", status), true)).toEqual({
      kind: "transient",
      preserveSnapshot: true,
      retryAfterMs: WORKSPACE_RECOVERY_RETRY_MS,
    });
    expect(workspaceLoadFailurePolicy(new ApiRequestError("暂时不可用", status), false)).toEqual({
      kind: "transient",
      preserveSnapshot: false,
      retryAfterMs: WORKSPACE_RECOVERY_RETRY_MS,
    });
  });

  it("普通业务错误不进入快速无限重试", () => {
    expect(workspaceLoadFailurePolicy(new ApiRequestError("请求内容无效", 400), true)).toEqual({
      kind: "fatal",
      preserveSnapshot: true,
      retryAfterMs: undefined,
    });
  });

  it("单个可选诊断刷新失败时只在短暂宽限期内保留最后一次能力快照", () => {
    const generatedAt = Date.parse("2026-07-31T12:00:00.000Z");
    type DiagnosticStub = {
      generatedAt: string;
      capabilities: { appServer: "available" | "unavailable" };
    };
    const previous: DiagnosticStub = {
      generatedAt: new Date(generatedAt).toISOString(),
      capabilities: { appServer: "available" },
    };

    expect(retainLastKnownDiagnosticSnapshot(undefined, previous, generatedAt + 1_000)).toBe(
      previous,
    );
    expect(
      retainLastKnownDiagnosticSnapshot(
        {
          generatedAt: new Date(generatedAt + 2_000).toISOString(),
          capabilities: { appServer: "unavailable" as const },
        },
        previous,
        generatedAt + 2_000,
      ),
    ).toEqual({
      generatedAt: new Date(generatedAt + 2_000).toISOString(),
      capabilities: { appServer: "unavailable" },
    });
    expect(
      retainLastKnownDiagnosticSnapshot(
        undefined,
        previous,
        generatedAt + DIAGNOSTICS_LAST_KNOWN_TTL_MS + 1,
      ),
    ).toBeUndefined();
    expect(
      retainLastKnownDiagnosticSnapshot(
        undefined,
        { ...previous, generatedAt: "invalid" },
        generatedAt + 1_000,
      ),
    ).toBeUndefined();
    expect(
      retainLastKnownDiagnosticSnapshot(undefined, undefined, generatedAt + 1_000),
    ).toBeUndefined();
  });
});
