import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { jiraMutationToolResult } from "./jiraMutationResult.js";

// #4354 AC4. A write approval nobody decided runs out after ATLASSIAN_ACTION_APPROVAL_TTL_MS. That is
// not a decision: the model must not read it as "declined", and the person must be able to ask
// again without the model drafting everything anew. The words below are fixed; the draft's id and
// digest are Keiko's own values, never user text.

/** The Chat's open draft a refused write left behind: the references of the existing draft store. */
export interface HeldJiraDraft {
  readonly id: string;
  readonly digest: string;
  readonly itemCount: number;
}

export const JIRA_APPROVAL_EXPIRED_GUIDANCE =
  "The approval expired before anyone decided, so nothing was changed. This is not a refusal by the person. " +
  "Tell the user in plain language that the approval expired and that you can ask again.";

function resubmitGuidance(draft: HeldJiraDraft): string {
  return (
    `The draft stays the Chat's open draft (${String(draft.itemCount)} items): to ask again, call jira_draft ` +
    `with only draftId ${draft.id} and draftDigest ${draft.digest}; do not draft the items anew.`
  );
}

/** The tool result of a write whose approval expired: closed fields plus the fixed guidance. */
export function jiraApprovalExpiredResult(draft: HeldJiraDraft | undefined): CatalogJsonObject {
  const base = jiraMutationToolResult("not-dispatched", "effect-denied").data;
  return {
    ...base,
    guidance:
      draft === undefined
        ? JIRA_APPROVAL_EXPIRED_GUIDANCE
        : `${JIRA_APPROVAL_EXPIRED_GUIDANCE} ${resubmitGuidance(draft)}`,
  };
}
