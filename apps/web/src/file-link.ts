const EXTERNAL_LINK_SCHEME = /^(https?|mailto|tel|data):/i;
const FILE_URI_PREFIX = /^file:\/\/\/?/i;
const WINDOWS_DRIVE_WITH_LEADING_SLASH = /^\/[a-z]:[\\/]/i;
const TEXT_LOCATION_SUFFIX = /:(\d+)(?::(\d+))?$/;
const GITHUB_LINE_FRAGMENT = /#L\d+(?:C\d+)?$/i;

export function localFilePathFromHref(href: string | undefined): string | undefined {
  if (!href || href.startsWith("#") || EXTERNAL_LINK_SCHEME.test(href)) return undefined;

  let value = href;
  try {
    value = decodeURIComponent(href);
  } catch {
    // Keep the original value; the Sidecar resolver is the final authority.
  }

  value = value.replace(FILE_URI_PREFIX, "");
  if (WINDOWS_DRIVE_WITH_LEADING_SLASH.test(value)) value = value.slice(1);

  return value
    .replace(GITHUB_LINE_FRAGMENT, "")
    .replace(TEXT_LOCATION_SUFFIX, "")
    .replaceAll("\\", "/");
}
