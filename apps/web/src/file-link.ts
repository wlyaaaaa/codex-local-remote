const EXTERNAL_LINK_SCHEME = /^(https?|mailto|tel|data):/i;
const FILE_URI_PREFIX = /^file:\/\/\/?/i;
const WINDOWS_DRIVE_WITH_LEADING_SLASH = /^\/[a-z]:[\\/]/i;
const TEXT_LOCATION_SUFFIX = /:(\d+)(?::(\d+))?$/;
const GITHUB_LINE_FRAGMENT = /#L(\d+)(?:C(\d+))?$/i;
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABSOLUTE_PATH = /^\/?[a-z]:[\\/]/i;
const LOCAL_MARKDOWN_HREF_PREFIX = "/__codex_local_file__/";

export interface LocalFileReference {
  path: string;
  line?: number;
  column?: number;
}

export function encodeLocalFileHrefForMarkdown(href: string): string | undefined {
  if (!href || href.startsWith("#") || EXTERNAL_LINK_SCHEME.test(href)) return undefined;
  const isLocal =
    FILE_URI_PREFIX.test(href) ||
    WINDOWS_ABSOLUTE_PATH.test(href) ||
    href.startsWith("/") ||
    href.startsWith("./") ||
    href.startsWith("../") ||
    !URI_SCHEME.test(href);
  return isLocal ? `${LOCAL_MARKDOWN_HREF_PREFIX}${encodeURIComponent(href)}` : undefined;
}

export function localFilePathFromHref(href: string | undefined): string | undefined {
  return localFileReferenceFromHref(href)?.path;
}

export function localFileReferenceFromHref(
  href: string | undefined,
): LocalFileReference | undefined {
  if (!href || href.startsWith("#") || EXTERNAL_LINK_SCHEME.test(href)) return undefined;

  let value = href.startsWith(LOCAL_MARKDOWN_HREF_PREFIX)
    ? href.slice(LOCAL_MARKDOWN_HREF_PREFIX.length)
    : href;
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep the original value; the Sidecar resolver is the final authority.
  }

  value = value.replace(FILE_URI_PREFIX, "");
  if (WINDOWS_DRIVE_WITH_LEADING_SLASH.test(value)) value = value.slice(1);

  const fragmentMatch = value.match(GITHUB_LINE_FRAGMENT);
  const suffixMatch = fragmentMatch ? undefined : value.match(TEXT_LOCATION_SUFFIX);
  const lineText = fragmentMatch?.[1] ?? suffixMatch?.[1];
  const columnText = fragmentMatch?.[2] ?? suffixMatch?.[2];
  const path = value
    .replace(GITHUB_LINE_FRAGMENT, "")
    .replace(TEXT_LOCATION_SUFFIX, "")
    .replaceAll("\\", "/");
  if (!path) return undefined;
  const line = lineText === undefined ? undefined : Number.parseInt(lineText, 10);
  const column = columnText === undefined ? undefined : Number.parseInt(columnText, 10);
  return {
    path,
    ...(line !== undefined && Number.isSafeInteger(line) && line > 0 ? { line } : {}),
    ...(column !== undefined && Number.isSafeInteger(column) && column > 0 ? { column } : {}),
  };
}
