import type { JiraMutationAttempt } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray } from "./atlassian-sync-classify.js";
import {
  JIRA_ISSUE_LINK_PATH,
  jiraIssueLinkAccount,
  jiraIssueLinkBody,
  orderedJiraIssueLinks,
  type JiraIssueLinkPlan,
  type JiraIssueLinkRequest,
} from "./jira-issue-links.js";
import { dispatchFailure, type JiraMutationFailure } from "./jira-mutation-failure.js";
import {
  confirmJiraMutationFields,
  readJiraMutationIssue,
  type JiraFieldConfirmation,
} from "./jira-mutation-confirmation.js";
import type { JiraMutationRequest } from "./jira-managed-mutation-metadata.js";

const MALFORMED: JiraMutationFailure = { ok: false, reason: "malformed-payload" };

interface JiraIssueLinkWrites {
  /** Further links Jira acknowledged, in order. */
  readonly created: number;
  /** The first refusal or lost answer; the links after it were not tried. */
  readonly failure?: JiraMutationFailure;
}

/**
 * One `POST /rest/api/2/issueLink` per further link, in order, stopping at the first that does not
 * land (#4176). A POST is dispatched at most once: a link whose answer was lost may exist, so it is
 * accounted for by reading the issue back, never by sending it again. Recursion keeps the calls
 * strictly sequential without an await inside a loop.
 */
async function writeFrom(
  request: JiraMutationRequest,
  issueKey: string,
  links: readonly JiraIssueLinkRequest[],
  created: number,
): Promise<JiraIssueLinkWrites> {
  const link = links[created];
  if (link === undefined) return { created };
  const response = await request(
    JIRA_ISSUE_LINK_PATH,
    "POST",
    jiraIssueLinkBody(issueKey, link),
    "none",
  );
  if (!response.ok) return { created, failure: dispatchFailure(response) };
  if (response.status !== 201) return { created, failure: MALFORMED };
  return writeFrom(request, issueKey, links, created + 1);
}

/**
 * Finishes a create/edit that carried links: writes the further ones, then confirms the issue. Any
 * failure after the issue was acknowledged names the issue and which requested links are missing,
 * so a partial effect is never reported as plain failure or as success.
 */
export async function completeJiraLinkedMutation(
  request: JiraMutationRequest,
  input: JiraFieldConfirmation,
  plan: JiraIssueLinkPlan,
): Promise<JiraMutationAttempt> {
  const links = orderedJiraIssueLinks(plan);
  if (links.length === 0) return confirmJiraMutationFields(request, input);
  const written = await writeFrom(request, input.issueKey, plan.further, 0);
  const settled = written.failure ?? (await confirmJiraMutationFields(request, input));
  if (settled.ok)
    return {
      ...settled,
      links: { requested: links.length, created: links.length, missing: [], unconfirmed: false },
    };
  const current = await readJiraMutationIssue(request, input.issueKey, ["issuelinks"]);
  const entries = current.ok ? asArray(current.fields.issuelinks ?? []) : undefined;
  const accepted = plan.present.length + plan.inline.length + written.created;
  return {
    ...settled,
    receipt: input.receipt,
    links: jiraIssueLinkAccount(links, entries, accepted),
  };
}
