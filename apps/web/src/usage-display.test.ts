import type { UsageSnapshot } from "@codex-local-remote/contracts";
import { describe, expect, it } from "vitest";
import {
  contextPresentation,
  contextUsageOrbLabel,
  formatUtc8Time,
  quotaPresentation,
  remainingContextPercentLabel,
} from "./usage-display";

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    updatedAt: "2026-07-26T09:30:00.000Z",
    windows: [
      {
        id: "codex",
        label: "Codex · 当前周期",
        usedPercent: 42.4,
        remainingPercent: 57.6,
        resetsAt: "2026-07-26T10:05:00.000Z",
      },
    ],
    ...overrides,
  };
}

describe("额度圆环与 UTC+8 展示", () => {
  it("所有重置时间都明确转换为 UTC+8，而不是浏览器本地时区", () => {
    expect(formatUtc8Time("2026-07-26T10:05:00.000Z")).toBe("2026年7月26日 18:05（UTC+8）");
    expect(formatUtc8Time("not-a-date")).toBe("暂时无法读取");
  });

  it("圆环只表达当前对话上下文，而不是账户额度窗口", () => {
    const usage = snapshot({
      context: {
        limitTokens: 258_000,
        usedPercent: 39.53,
        usedTokens: 102_000,
      },
    });
    const presentation = contextPresentation(usage);
    expect(presentation.state).toBe("available");
    expect(presentation.usedPercent).toBeCloseTo(39.53, 2);
    expect(contextUsageOrbLabel(presentation, false)).toBe(
      "当前上下文已用 40%，点按查看额度与上下文",
    );
    expect(contextUsageOrbLabel(presentation, true)).toBe("正在刷新额度与上下文");
    expect(remainingContextPercentLabel(60.47)).toBe("剩余上下文 60%");
    expect(remainingContextPercentLabel(undefined)).toBe("剩余上下文暂时无法读取");
  });

  it("额度耗尽时优先显示阻断状态，而不是仍标成绿色可用", () => {
    const presentation = quotaPresentation(
      snapshot({
        windows: [
          {
            id: "spark",
            label: "GPT-5.3 Codex Spark",
            usedPercent: 100,
            remainingPercent: 0,
          },
        ],
        credits: [
          {
            id: "spark",
            label: "Spark",
            hasCredits: false,
            unlimited: false,
          },
        ],
      }),
      "gpt-5.3-codex-spark",
    );
    expect(presentation).toEqual({
      state: "exhausted",
      usedPercent: 100,
      message: "当前额度已用完",
    });
  });

  it("额度接近上限时进入警告态，未知数据不伪造百分比", () => {
    expect(
      quotaPresentation(
        snapshot({
          windows: [{ id: "codex", label: "Codex", usedPercent: 88, remainingPercent: 12 }],
        }),
      ),
    ).toEqual({
      state: "warning",
      usedPercent: 88,
      message: "当前额度即将用完",
    });
    expect(quotaPresentation(snapshot({ windows: [] }))).toEqual({
      state: "unknown",
      message: "额度暂时无法读取",
    });
  });

  it("没有额外 Credits 不等于订阅周期额度耗尽", () => {
    expect(
      quotaPresentation(
        snapshot({
          credits: [
            {
              id: "codex",
              label: "Codex",
              hasCredits: false,
              unlimited: false,
            },
          ],
          windows: [
            {
              id: "codex-primary",
              label: "Codex · 当前周期",
              usedPercent: 9,
              remainingPercent: 91,
            },
          ],
        }),
      ),
    ).toEqual({
      state: "available",
      usedPercent: 9,
    });
  });
});
