import { createHash } from "node:crypto";

/**
 * The stable identity of one Jira: a digest of its normalised base URL (scheme, lower-cased host,
 * non-default port and context path), never the URL itself. A template bound to issue-type ids carries
 * it, so those ids govern only on the Jira they were read from (#4354).
 */
export function jiraInstanceIdentity(baseUrl: string): string {
  return createHash("sha256").update(normalisedBase(baseUrl), "utf8").digest("hex").slice(0, 32);
}

/** Cuts the slashes a path ends with, by position, so no input makes it slow. */
function withoutTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text.charAt(end - 1) === "/") end -= 1;
  return text.slice(0, end);
}

function normalisedBase(baseUrl: string): string {
  const text = baseUrl.trim();
  // An unparsable base URL cannot reach a request; it still gets one stable identity.
  if (!URL.canParse(text)) return withoutTrailingSlashes(text.toLowerCase());
  const url = new URL(text);
  return `${url.protocol}//${url.host.toLowerCase()}${withoutTrailingSlashes(url.pathname)}`;
}
