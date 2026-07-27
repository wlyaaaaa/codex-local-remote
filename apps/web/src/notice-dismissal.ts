const NOTICE_DISMISSAL_PREFIX = "codex-local-remote:dismissed-notice:";

export function noticeDismissalKey(route: string, title: string, message: string): string {
  return `${route}|${title}|${message}`;
}

function storageKey(key: string): string {
  return `${NOTICE_DISMISSAL_PREFIX}${encodeURIComponent(key)}`;
}

export function readNoticeDismissal(storage: Pick<Storage, "getItem">, key: string): boolean {
  try {
    return storage.getItem(storageKey(key)) === "1";
  } catch {
    return false;
  }
}

export function dismissNotice(storage: Pick<Storage, "setItem">, key: string): void {
  try {
    storage.setItem(storageKey(key), "1");
  } catch {
    // Storage may be disabled or full. The notice still closes for this render.
  }
}
