import { vi } from "vitest";
import type { AtlassianWriteHttpOutcome } from "../atlassian-write-http.js";
import type { JiraMutationRequest } from "../jira-managed-mutation-metadata.js";

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
