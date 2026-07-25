import type { UsageCredits } from "@codex-local-remote/contracts";

export function usedPercentLabel(value: number | undefined): string {
  return value === undefined ? "已用比例暂时无法读取" : `已用 ${Math.round(value)}%`;
}

export function remainingPercentLabel(value: number | undefined): string {
  return value === undefined ? "剩余额度暂时无法读取" : `剩余额度 ${Math.round(value)}%`;
}

export function remainingFromUsedPercent(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.max(0, Math.min(100, 100 - value));
}

export function creditBalanceLabel(credit: UsageCredits): string {
  if (credit.unlimited) return "无限额度";
  if (!credit.hasCredits) return "无可用额度";
  return credit.balance === undefined ? "余额暂时无法读取" : `余额 ${credit.balance}`;
}
