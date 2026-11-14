import { createHash } from "node:crypto";

/**
 * The stable identity of one Jira: a digest of its normalised base URL (scheme, lower-cased host,
 * non-default port and context path), never the URL itself. A template bound to issue-type ids carries
 * it, so those ids govern only on the Jira they were read from (#4354).
 */
export function jiraInstanceIdentity(baseUrl: string): string {
  return createHash("sha256").update(normalisedBase(baseUrl), "utf8").digest("hex").slice(0, 32);
}

function normalisedBase(baseUrl: string): string {
  try {
    const url = new URL(baseUrl.trim());
    const path = url.pathname.replace(/\/+$/u, "");
    return `${url.protocol}//${url.host.toLowerCase()}${path}`;
  } catch {
    // An unparsable base URL cannot reach a request; it still gets one stable identity.
    return baseUrl.trim().toLowerCase().replace(/\/+$/u, "");
  }
}
