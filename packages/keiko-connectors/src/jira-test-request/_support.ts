import { vi } from "vitest";
import type { AtlassianWriteHttpOutcome } from "../atlassian-write-http.js";
import type { JiraMutationRequest } from "../jira-managed-mutation-metadata.js";
import { asRecord } from "../atlassian-sync-classify.js";

/** Closed response scripts keep synthetic throw/lost-response cases outside production exports. */
export function scriptedJiraMutationRequest(
  script: readonly (AtlassianWriteHttpOutcome | Error)[],
): ReturnType<typeof vi.fn<JiraMutationRequest>> {
  let index = 0;
  return vi.fn<JiraMutationRequest>().mockImplementation(async () => {
    const next = script[index++];
    if (next instanceof Error) throw next;
    if (next === undefined) throw new TypeError("Unexpected scripted Jira mutation request");
    return next;
  });
}

/** Object-only native fixtures must reject scalar bodies rather than simulate a successful write. */
export function jiraObjectMutationBody(value: Parameters<JiraMutationRequest>[2]): Readonly<Record<string, unknown>> {
  const body = asRecord(value);
  if (body === undefined) throw new TypeError("Expected a native JSON object request body");
  return body;
}
