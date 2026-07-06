/**
 * Typed fetch wrapper for the governed documentation browser BFF route (Epic #1851, ADR-0113).
 * Mirrors browser-api.ts: same-origin relative path, CSRF header on the state-changing POST, no
 * response-body logging. The route classifies the target and returns a redacted navigation result;
 * it never returns raw page content.
 */

import { bffFetchJson } from "./http";
import type {
  DocumentationIndexingApproval,
  DocumentationIndexingProposal,
  DocumentationNavigationResult,
} from "./types";

export async function navigateDocumentation(
  target: string,
): Promise<DocumentationNavigationResult> {
  return bffFetchJson<DocumentationNavigationResult>("/api/docs-browser/navigate", {
    method: "POST",
    body: JSON.stringify({ target }),
  });
}

/**
 * Ask the BFF whether an opened target looks like an indexable HTML manual (Epic #1852). Returns a
 * redacted proposal with a bounded scope preview; it starts no crawl or index and grants no consent.
 */
export async function proposeDocumentationIndexing(
  target: string,
): Promise<DocumentationIndexingProposal> {
  return bffFetchJson<DocumentationIndexingProposal>("/api/docs-browser/propose", {
    method: "POST",
    body: JSON.stringify({ target }),
  });
}

/**
 * Record the user's explicit consent to index an approvable manual and receive the redaction-safe
 * handoff for the governed indexing pipeline. This is the only consent action; it still performs no
 * crawl or index in this milestone.
 */
export async function approveDocumentationIndexing(
  target: string,
): Promise<DocumentationIndexingApproval> {
  return bffFetchJson<DocumentationIndexingApproval>("/api/docs-browser/approve", {
    method: "POST",
    body: JSON.stringify({ target }),
  });
}
