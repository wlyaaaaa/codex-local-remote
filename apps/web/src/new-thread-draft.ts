export const NEW_THREAD_DRAFT_KEY = "codex-local-remote:new-thread-draft:v1";

const MAX_PROMPT_LENGTH = 100_000;
const MAX_PROJECT_ID_LENGTH = 512;

interface StorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export interface NewThreadDraft {
  prompt: string;
  projectId: string;
}

export function readNewThreadDraft(storage: StorageLike): NewThreadDraft | undefined {
  try {
    const raw = storage.getItem(NEW_THREAD_DRAFT_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      (value as Record<string, unknown>)["version"] !== 1
    ) {
      return undefined;
    }
    const prompt = (value as Record<string, unknown>)["prompt"];
    const projectId = (value as Record<string, unknown>)["projectId"];
    if (
      typeof prompt !== "string" ||
      prompt.length > MAX_PROMPT_LENGTH ||
      typeof projectId !== "string" ||
      projectId.length > MAX_PROJECT_ID_LENGTH
    ) {
      return undefined;
    }
    return { prompt, projectId };
  } catch {
    return undefined;
  }
}

export function writeNewThreadDraft(storage: StorageLike, draft: NewThreadDraft): boolean {
  if (draft.prompt.length > MAX_PROMPT_LENGTH || draft.projectId.length > MAX_PROJECT_ID_LENGTH) {
    return false;
  }
  try {
    storage.setItem(
      NEW_THREAD_DRAFT_KEY,
      JSON.stringify({ version: 1, prompt: draft.prompt, projectId: draft.projectId }),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearNewThreadDraft(storage: StorageLike): boolean {
  try {
    storage.removeItem(NEW_THREAD_DRAFT_KEY);
    return true;
  } catch {
    return false;
  }
}

export function initialNewThreadProject(
  selectableProjectIds: readonly string[],
  requestedProjectId: string | null,
  draftProjectId: string | undefined,
): string {
  if (requestedProjectId && selectableProjectIds.includes(requestedProjectId)) {
    return requestedProjectId;
  }
  if (
    draftProjectId !== undefined &&
    (draftProjectId === "" || selectableProjectIds.includes(draftProjectId))
  ) {
    return draftProjectId;
  }
  return selectableProjectIds[0] ?? "";
}
