import type { JiraMutationAttempt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";

export type JiraMutationFailure = Extract<JiraMutationAttempt, { ok: false }>;
export type JiraHttpFailure = Extract<AtlassianWriteHttpOutcome, { ok: false }>;

/** The dispatch's own refusal, with Jira's explanation when it gave one. */
export function dispatchFailure(response: JiraHttpFailure): JiraMutationFailure {
  return {
    ok: false,
    reason: response.reason,
    ...(response.remote === undefined ? {} : { detail: response.remote }),
  };
}
