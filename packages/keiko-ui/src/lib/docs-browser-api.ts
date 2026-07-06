/**
 * Typed fetch wrapper for the governed documentation browser BFF route (Epic #1851, ADR-0113).
 * Mirrors browser-api.ts: same-origin relative path, CSRF header on the state-changing POST, no
 * response-body logging. The route classifies the target and returns a redacted navigation result;
 * it never returns raw page content.
 */

import { bffFetchJson } from "./http";
import type { DocumentationNavigationResult } from "./types";

export async function navigateDocumentation(
  target: string,
): Promise<DocumentationNavigationResult> {
  return bffFetchJson<DocumentationNavigationResult>("/api/docs-browser/navigate", {
    method: "POST",
    body: JSON.stringify({ target }),
  });
}
