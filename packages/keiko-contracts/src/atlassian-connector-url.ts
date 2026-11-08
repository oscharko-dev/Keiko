/** Existing Atlassian connection URL boundary, shared without the aggregate contract's cycles. */
export const ATLASSIAN_CONNECTOR_BASE_URL_MAX_CHARS = 2048;

// The WHATWG parser guarantees a non-empty host for https URLs after successful parsing.
function isSafeParsedBaseUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
  );
}

// HTTPS only; no embedded credentials, query or fragment. Data Center context paths are allowed.
// Literal marker checks also refuse empty userinfo/query/fragment forms after URL normalization.
export function isSafeAtlassianConnectorBaseUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > ATLASSIAN_CONNECTOR_BASE_URL_MAX_CHARS) return false;
  if (/\s/u.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!isSafeParsedBaseUrl(url)) return false;
  return !value.includes("@") && !value.includes("?") && !value.includes("#");
}

/** Exact target identity; ambiguous path encodings and normalizing traversal are not admitted. */
export function canonicalAtlassianConnectorBaseUrl(value: unknown): string | undefined {
  if (!isSafeAtlassianConnectorBaseUrl(value)) return undefined;
  const url = new URL(value);
  const normalized = url.toString().replace(/\/$/, "");
  if (normalized !== value.replace(/\/$/, "")) return undefined;
  if (url.pathname.includes("%") || url.pathname.includes("//")) return undefined;
  return normalized;
}
