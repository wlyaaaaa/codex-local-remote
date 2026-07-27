const AMBIENT_BROWSER_CONTEXT_OPEN = '<in-app-browser-context source="ambient-ui-state">';
const AMBIENT_BROWSER_CONTEXT_CLOSE = "</in-app-browser-context>";
const CODEX_DELEGATION_OPEN = "<codex_delegation>";
const CODEX_DELEGATION_CLOSE = "</codex_delegation>";
const MAX_ADJACENT_SEPARATOR_BREAKS = 2;
const HOST_FILE_MANIFEST =
  /^[ \t]*#{1,6}[ \t]+Files mentioned by the user:[ \t]*(?:\r\n|\n|\r)(?:(?!^[ \t]*#{1,6}[ \t]+My request for Codex:)[\s\S])*?(?=^[ \t]*#{1,6}[ \t]+My request for Codex:)/gmu;
const HOST_REQUEST_HEADING =
  /^[ \t]*#{1,6}[ \t]+My request for Codex(?::[ \t]*)?(.*?)(\r\n|\n|\r|$)/gmu;
const HOST_IMAGE_MARKER =
  /^[ \t]*<image[ \t]+name=\[Image #[0-9]+\][ \t]+path="[^"\r\n]*">[ \t]*(?:\r\n|\n|\r|$)/gmu;

export function UserMessageText({ children }: { children: string }) {
  return <div className="user-message-text">{stripInjectedMessageScaffolding(children)}</div>;
}

export function stripInjectedMessageScaffolding(message: string): string {
  let visible = stripCompleteTaggedBlocks(
    message,
    AMBIENT_BROWSER_CONTEXT_OPEN,
    AMBIENT_BROWSER_CONTEXT_CLOSE,
  );
  visible = stripCompleteTaggedBlocks(visible, CODEX_DELEGATION_OPEN, CODEX_DELEGATION_CLOSE);
  visible = visible.replace(HOST_FILE_MANIFEST, "");
  visible = visible.replace(
    HOST_REQUEST_HEADING,
    (_match, inlineContent: string, lineEnding: string) =>
      inlineContent.length > 0 ? `${inlineContent}${lineEnding}` : "",
  );
  visible = visible.replace(HOST_IMAGE_MARKER, "");
  return trimBlankSeparatorLines(visible);
}

// Kept as a compatibility export for callers and older tests that used the
// narrower name before all host scaffolding was removed in one place.
export const stripInjectedBrowserContext = stripInjectedMessageScaffolding;

function stripCompleteTaggedBlocks(message: string, open: string, close: string): string {
  let cursor = 0;
  let scanFrom = 0;
  let visible = "";
  let lastRemovalReachedEnd = false;

  while (scanFrom < message.length) {
    const start = message.indexOf(open, scanFrom);
    if (start < 0) {
      visible += message.slice(cursor);
      break;
    }
    const contentStart = start + open.length;
    const end = message.indexOf(close, contentStart);
    if (end < 0) {
      visible += message.slice(cursor);
      break;
    }

    // Treat a nested opening marker as user-authored or malformed text. This
    // prevents an unmatched marker from swallowing a later complete block.
    const nestedStart = message.indexOf(open, contentStart);
    if (nestedStart >= 0 && nestedStart < end) {
      scanFrom = nestedStart;
      continue;
    }

    visible += message.slice(cursor, start);
    cursor = skipLeadingLineBreaks(message, end + close.length, MAX_ADJACENT_SEPARATOR_BREAKS);
    scanFrom = cursor;
    lastRemovalReachedEnd = cursor === message.length;
  }

  const result = lastRemovalReachedEnd
    ? removeTrailingLineBreaks(visible, MAX_ADJACENT_SEPARATOR_BREAKS)
    : visible;
  return result;
}

function skipLeadingLineBreaks(value: string, start: number, maximum: number): number {
  let cursor = start;
  for (let count = 0; count < maximum; count += 1) {
    if (value.startsWith("\r\n", cursor)) {
      cursor += 2;
    } else if (value[cursor] === "\n" || value[cursor] === "\r") {
      cursor += 1;
    } else {
      break;
    }
  }
  return cursor;
}

function removeTrailingLineBreaks(value: string, maximum: number): string {
  let end = value.length;
  for (let count = 0; count < maximum; count += 1) {
    if (value.slice(0, end).endsWith("\r\n")) {
      end -= 2;
    } else if (value[end - 1] === "\n" || value[end - 1] === "\r") {
      end -= 1;
    } else {
      break;
    }
  }
  return value.slice(0, end);
}

function trimBlankSeparatorLines(value: string): string {
  return value.replace(/^(?:[ \t]*(?:\r\n|\n|\r))+/u, "").replace(/(?:\r\n|\n|\r)[ \t]*$/u, "");
}
