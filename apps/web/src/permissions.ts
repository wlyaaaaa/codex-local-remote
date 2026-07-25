import type { ThreadDetail } from "@codex-local-remote/contracts";

export function canDirectlyCompose(
  thread: Pick<ThreadDetail, "activeTurnId" | "availableActions">,
) {
  return thread.activeTurnId ? thread.availableActions.steer : thread.availableActions.reply;
}
