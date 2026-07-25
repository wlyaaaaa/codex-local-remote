export type AuditMetadata = Record<string, unknown>;

const REDACTED = "[REDACTED]";
const REDACTED_PATH = "[REDACTED_PATH]";
const MAX_DEPTH = 4;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 40;
const MAX_STRING_LENGTH = 512;

const SECRET_KEY =
  /(?:authorization|cookie|password|passphrase|secret|token|csrf|prompt|response|content|command|output)/iu;
const PATH_KEY = /(?:path|paths|filename)$/iu;
const WINDOWS_ABSOLUTE_PATH = /(?:^|\s)(?:[A-Za-z]:[\\/]|\\\\)[^\r\n]*/u;
const BEARER_OR_API_KEY = /(?:Bearer\s+[A-Za-z0-9._~+/-]+=*|sk-[A-Za-z0-9_-]{10,})/giu;

function sanitizeString(value: string): string {
  if (WINDOWS_ABSOLUTE_PATH.test(value)) {
    return "[REDACTED_TEXT]";
  }
  return value.replace(BEARER_OR_API_KEY, REDACTED).slice(0, MAX_STRING_LENGTH);
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value !== "object") {
    return `[${typeof value}]`;
  }
  if (depth >= MAX_DEPTH || seen.has(value)) {
    return "[TRUNCATED]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1, seen));
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    if (SECRET_KEY.test(key)) {
      output[key] = REDACTED;
    } else if (PATH_KEY.test(key)) {
      output[key] = REDACTED_PATH;
    } else {
      output[key] = sanitizeValue(child, depth + 1, seen);
    }
  }
  return output;
}

export function sanitizeAuditMetadata(metadata: AuditMetadata): Record<string, unknown> {
  return sanitizeValue(metadata, 0, new WeakSet<object>()) as Record<string, unknown>;
}
