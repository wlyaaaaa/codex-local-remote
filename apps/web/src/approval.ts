import type { ApprovalRequest, ApprovalResolutionInput } from "@codex-local-remote/contracts";

export const OTHER_ANSWER = "__other__";

export interface ApprovalAnswerDraft {
  selected?: string;
  text?: string;
}

export type ApprovalAnswerDrafts = Record<string, ApprovalAnswerDraft>;

export function approvalInputType(isSecret: boolean) {
  return isSecret ? ("password" as const) : ("text" as const);
}

export function isApprovalQuestionAnswered(
  question: NonNullable<ApprovalRequest["questions"]>[number],
  draft: ApprovalAnswerDraft | undefined,
) {
  if (question.options?.length) {
    if (!draft?.selected) return false;
    return draft.selected !== OTHER_ANSWER || Boolean(draft.text?.trim());
  }
  return Boolean(draft?.text?.trim());
}

export function buildApprovalResolution(
  choiceId: string,
  questions: ApprovalRequest["questions"],
  drafts: ApprovalAnswerDrafts,
): ApprovalResolutionInput {
  const answers: Record<string, string[]> = {};
  for (const question of questions ?? []) {
    const draft = drafts[question.id];
    const value = question.options?.length
      ? draft?.selected === OTHER_ANSWER
        ? draft.text?.trim()
        : draft?.selected
      : draft?.text?.trim();
    if (value) answers[question.id] = [value];
  }
  return Object.keys(answers).length ? { choiceId, answers } : { choiceId };
}

export function choiceRequiresAnswers(approval: ApprovalRequest, choiceId: string) {
  return approval.choices.find((choice) => choice.id === choiceId)?.tone === "primary";
}
