const AMBIENT_BROWSER_CONTEXT_OPEN = '<in-app-browser-context source="ambient-ui-state">';
const AMBIENT_BROWSER_CONTEXT_CLOSE = "</in-app-browser-context>";
const MAX_ADJACENT_SEPARATOR_BREAKS = 2;

export function UserMessageText({ children }: { children: string }) {
  return <div className="user-message-text">{stripInjectedBrowserContext(children)}</div>;
}

export function stripInjectedBrowserContext(message: string): string {
  let cursor = 0;
  let scanFrom = 0;
  let visible = "";
  let lastRemovalReachedEnd = false;

  while (scanFrom < message.length) {
    const start = message.indexOf(AMBIENT_BROWSER_CONTEXT_OPEN, scanFrom);
    if (start < 0) {
      visible += message.slice(cursor);
      break;
    }
    const contentStart = start + AMBIENT_BROWSER_CONTEXT_OPEN.length;
    const end = message.indexOf(AMBIENT_BROWSER_CONTEXT_CLOSE, contentStart);
    if (end < 0) {
      visible += message.slice(cursor);
      break;
    }

    // Treat a nested opening marker as user-authored or malformed text. This
    // prevents an unmatched marker from swallowing a later complete block.
    const nestedStart = message.indexOf(AMBIENT_BROWSER_CONTEXT_OPEN, contentStart);
    if (nestedStart >= 0 && nestedStart < end) {
      scanFrom = nestedStart;
      continue;
    }

    visible += message.slice(cursor, start);
    cursor = skipLeadingLineBreaks(
      message,
      end + AMBIENT_BROWSER_CONTEXT_CLOSE.length,
      MAX_ADJACENT_SEPARATOR_BREAKS,
    );
    scanFrom = cursor;
    lastRemovalReachedEnd = cursor === message.length;
  }

  return lastRemovalReachedEnd
    ? removeTrailingLineBreaks(visible, MAX_ADJACENT_SEPARATOR_BREAKS)
    : visible;
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
