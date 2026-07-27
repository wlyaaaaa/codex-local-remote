import type { ApprovalRequest, RemoteEvent, RunState } from "@codex-local-remote/contracts";

export const WORKSPACE_REFRESH_MS = 10_000;
const RUNNING_THREAD_REFRESH_MS = 15_000;
const IDLE_THREAD_REFRESH_MS = 30_000;
const PENDING_RECONCILIATION_REFRESH_MS = 1_000;

export function threadRefreshDelay(state: RunState | undefined, pendingReconciliation = false) {
  // Live output arrives through the resumable event stream. A full
  // thread/read is only a convergence fallback, and can be expensive for a
  // long conversation because the protocol returns the complete transcript.
  // A user-visible operation that was accepted but has no terminal event yet
  // gets a short bounded convergence loop so lost/coalesced events cannot
  // leave the UI stuck indefinitely.
  if (pendingReconciliation) return PENDING_RECONCILIATION_REFRESH_MS;
  return state === "running" ? RUNNING_THREAD_REFRESH_MS : IDLE_THREAD_REFRESH_MS;
}

export function canRefreshDocument(visibilityState: DocumentVisibilityState) {
  return visibilityState === "visible";
}

export function isTextEntryElement(
  element:
    | {
        getAttribute(name: string): string | null;
        tagName: string;
      }
    | null
    | undefined,
) {
  if (!element) return false;
  const tagName = element.tagName.toLocaleLowerCase("en-US");
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    element.getAttribute("contenteditable")?.toLocaleLowerCase("en-US") === "true"
  );
}

export function workspaceEventNeedsRefresh(event: Pick<RemoteEvent, "type">): boolean {
  return (
    event.type === "connection.reset" ||
    event.type === "thread.updated" ||
    event.type === "turn.state" ||
    event.type === "approval.requested" ||
    event.type === "approval.resolved"
  );
}

export function resolvedApprovalId(
  event: Pick<RemoteEvent, "payload" | "type">,
): string | undefined {
  if (
    event.type !== "approval.resolved" ||
    typeof event.payload !== "object" ||
    event.payload === null ||
    Array.isArray(event.payload)
  ) {
    return undefined;
  }
  const approvalId = (event.payload as Record<string, unknown>).approvalId;
  return typeof approvalId === "string" && approvalId.length > 0 ? approvalId : undefined;
}

export function reconcileFetchedApprovals(
  fetched: readonly ApprovalRequest[],
  locallyResolvedIds: ReadonlySet<string>,
): {
  approvals: ApprovalRequest[];
  remainingResolvedIds: Set<string>;
} {
  const fetchedIds = new Set(fetched.map((approval) => approval.id));
  const remainingResolvedIds = new Set([...locallyResolvedIds].filter((id) => fetchedIds.has(id)));
  return {
    approvals: fetched.filter((approval) => !remainingResolvedIds.has(approval.id)),
    remainingResolvedIds,
  };
}

export function reconcileSelectedApproval(
  selected: ApprovalRequest | undefined,
  approvals: readonly ApprovalRequest[],
): ApprovalRequest | undefined {
  if (!selected) return undefined;
  return approvals.find((approval) => approval.id === selected.id);
}
