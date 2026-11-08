const UNRESERVED = /^[A-Za-z0-9._~-]$/u;

function decodedUnreservedPath(path: string): string {
  return path.replaceAll(/%[0-9a-f]{2}/giu, (encoded) => {
    const decoded = String.fromCodePoint(Number.parseInt(encoded.slice(1), 16));
    return UNRESERVED.test(decoded) ? decoded : encoded;
  });
}

/**
 * Comparison only. Jira's configured Base URL can differ from the bound transport destination.
 * The response must name the exact native resource; its origin is never followed or displayed.
 */
export function jiraResourceSelfMatches(value: unknown, resourcePath: string): boolean {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\p{Cc}\\?#]/u.test(value) ||
    !URL.canParse(value)
  )
    return false;
  const url = new URL(value);
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.username === "" &&
    url.password === "" &&
    decodedUnreservedPath(url.pathname).endsWith(`/rest/api/2/${resourcePath}`)
  );
}
