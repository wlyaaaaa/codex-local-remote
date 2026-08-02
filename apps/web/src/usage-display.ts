import type { UsageCredits, UsageSnapshot, UsageWindow } from "@codex-local-remote/contracts";

export type QuotaPresentation = {
  state: "available" | "warning" | "exhausted" | "unknown";
  usedPercent?: number;
  message?: string;
};

export type ContextPresentation = {
  state: "available" | "unknown";
  usedPercent?: number;
};

export type CodexAccountPresentation = {
  detail: string;
  status: string;
  tone: "success" | "warning";
};

export function codexAccountPresentation(
  usage: UsageSnapshot | undefined,
): CodexAccountPresentation {
  const account = usage?.codexAccount;
  if (!account) {
    return {
      detail:
        usage?.availability?.account === "available"
          ? "Codex 未提供可显示的账号名称"
          : "账号信息暂时无法读取",
      status: "暂时不可用",
      tone: "warning",
    };
  }
  if (account.type === "chatgpt") {
    return {
      detail: account.email ?? "ChatGPT 账号",
      status: usage?.plan?.trim() || "已登录",
      tone: "success",
    };
  }
  return {
    detail: account.type === "apiKey" ? "OpenAI API Key" : "Amazon Bedrock",
    status: "已配置",
    tone: "success",
  };
}

export function usageAvailabilityMessage(usage: UsageSnapshot | undefined): string | undefined {
  const availability = usage?.availability;
  if (!availability) return undefined;
  const accountUnavailable = availability.account === "temporarily-unavailable";
  const rateLimitsUnavailable = availability.rateLimits === "temporarily-unavailable";
  const tokenUsageUnavailable = availability.tokenUsage === "temporarily-unavailable";
  if (!accountUnavailable && !rateLimitsUnavailable && !tokenUsageUnavailable) return undefined;
  if (accountUnavailable && !rateLimitsUnavailable && !tokenUsageUnavailable) {
    return "Codex 账号信息暂时无法读取。额度与 Token 用量仍可继续显示。";
  }
  const unavailableParts = [
    ...(accountUnavailable ? ["账号"] : []),
    ...(rateLimitsUnavailable ? ["额度、Credits"] : []),
    ...(tokenUsageUnavailable ? ["Token 用量"] : []),
  ];
  const joined =
    unavailableParts.length > 1
      ? `${unavailableParts.slice(0, -1).join("、")} 与 ${unavailableParts.at(-1)}`
      : unavailableParts[0];
  return `${accountUnavailable ? "Codex " : "Codex 已登录，但"}${joined}暂时无法读取。请检查电脑的系统网络或代理后重试。`;
}

export function usedPercentLabel(value: number | undefined): string {
  return value === undefined ? "已用比例暂时无法读取" : `已用 ${Math.round(value)}%`;
}

export function remainingPercentLabel(value: number | undefined): string {
  return value === undefined ? "剩余额度暂时无法读取" : `剩余额度 ${Math.round(value)}%`;
}

export function remainingContextPercentLabel(value: number | undefined): string {
  return value === undefined ? "剩余上下文暂时无法读取" : `剩余上下文 ${Math.round(value)}%`;
}

export function remainingFromUsedPercent(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.max(0, Math.min(100, 100 - value));
}

export function creditBalanceLabel(credit: UsageCredits): string {
  if (credit.unlimited) return "额外 Credits 不限";
  if (!credit.hasCredits) return "无额外 Credits";
  return credit.balance === undefined
    ? "额外 Credits 余额暂时无法读取"
    : `额外 Credits 余额 ${credit.balance}`;
}

export function usageWindowForDisplay(
  windows: readonly UsageWindow[] | undefined,
  preferredModel?: string,
): UsageWindow | undefined {
  if (!windows?.length) return undefined;
  const model = preferredModel?.trim().toLocaleLowerCase("en-US");
  if (model) {
    const exactModelWindow = windows.find((window) =>
      window.label.toLocaleLowerCase("en-US").includes(model),
    );
    if (exactModelWindow) return exactModelWindow;
  }
  return [...windows].sort((left, right) => {
    const leftGeneric = /^codex(?:\s|·|$)/iu.test(left.label) ? 0 : 1;
    const rightGeneric = /^codex(?:\s|·|$)/iu.test(right.label) ? 0 : 1;
    return leftGeneric - rightGeneric || left.id.localeCompare(right.id, "en-US");
  })[0];
}

export function formatUtc8Time(value?: string): string {
  if (!value) return "暂时无法读取";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "暂时无法读取";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((result, part) => {
      if (part.type !== "literal") result[part.type] = part.value;
      return result;
    }, {});
  if (!parts.year || !parts.month || !parts.day || !parts.hour || !parts.minute) {
    return "暂时无法读取";
  }
  return `${parts.year}年${Number(parts.month)}月${Number(parts.day)}日 ${parts.hour}:${parts.minute}（UTC+8）`;
}

export function quotaPresentation(
  usage: UsageSnapshot | undefined,
  preferredModel?: string,
): QuotaPresentation {
  const window = usageWindowForDisplay(usage?.windows, preferredModel);
  const usedPercent =
    window?.usedPercent === undefined ? undefined : Math.max(0, Math.min(100, window.usedPercent));
  if (usedPercent !== undefined && (usedPercent >= 100 || window?.remainingPercent === 0)) {
    return {
      state: "exhausted",
      usedPercent,
      message: "当前额度已用完",
    };
  }
  if (usedPercent !== undefined && usedPercent >= 85) {
    return {
      state: "warning",
      usedPercent,
      message: "当前额度即将用完",
    };
  }
  if (usedPercent === undefined) {
    return {
      state: "unknown",
      message: "额度暂时无法读取",
    };
  }
  return {
    state: "available",
    usedPercent,
  };
}

export function contextPresentation(usage: UsageSnapshot | undefined): ContextPresentation {
  const context = usage?.context;
  const calculatedPercent =
    context?.usedTokens !== undefined &&
    context.limitTokens !== undefined &&
    context.limitTokens > 0
      ? (context.usedTokens / context.limitTokens) * 100
      : undefined;
  const usedPercent = calculatedPercent ?? context?.usedPercent;
  if (usedPercent === undefined) {
    return { state: "unknown" };
  }
  return {
    state: "available",
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
  };
}

export function contextUsageOrbLabel(
  presentation: ContextPresentation,
  refreshing: boolean,
): string {
  if (refreshing) return "正在刷新额度与上下文";
  if (presentation.usedPercent === undefined) {
    return "当前上下文暂时无法读取，点按查看额度与上下文";
  }
  return `当前上下文已用 ${Math.round(presentation.usedPercent)}%，点按查看额度与上下文`;
}
