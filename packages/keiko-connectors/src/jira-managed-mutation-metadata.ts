import type {
  AtlassianConnectorWriteFailureReason,
  JiraFieldMetadata,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import type {
  AtlassianWriteHttpOutcome,
  AtlassianWriteHttpRequest,
} from "./atlassian-write-http.js";
import {
  JIRA_METADATA_MAX_FIELDS,
  parseJiraFieldMetadata,
  type JiraMetadataResult,
} from "./jira-field-metadata.js";
import { metadataPageMatches, parseJiraFieldMap } from "./jira-managed-metadata.js";

export type JiraMutationRequest = (
  path: string,
  method?: AtlassianWriteHttpRequest["method"],
  body?: Readonly<Record<string, unknown>>,
  expect?: AtlassianWriteHttpRequest["expect"],
) => Promise<AtlassianWriteHttpOutcome>;
export type JiraMutationMetadata =
  | { readonly ok: true; readonly fields: readonly JiraFieldMetadata[] }
  | { readonly ok: false; readonly reason: AtlassianConnectorWriteFailureReason };
const MALFORMED = { ok: false, reason: "malformed-payload" } as const;
function parsedMetadata(parsed: JiraMetadataResult): JiraMutationMetadata {
  return parsed.ok
    ? parsed
    : {
        ok: false,
        reason: parsed.reason === "bounds-exceeded" ? parsed.reason : "malformed-payload",
      };
}
interface CreatePage {
  readonly values: readonly unknown[];
  readonly total: number | undefined;
  readonly last: boolean;
}
function createPage(
  response: Extract<AtlassianWriteHttpOutcome, { ok: true }>,
  start: number,
): CreatePage | undefined {
  const body = response.body;
  if (response.status !== 200 || body === undefined) return undefined;
  const values = asArray(body.values);
  if (values === undefined || !metadataPageMatches(body, values.length, start, 100))
    return undefined;
  return {
    values,
    total: typeof body.total === "number" ? body.total : undefined,
    last: body.last === true,
  };
}
export async function jiraCreateMutationMetadata(
  request: JiraMutationRequest,
  projectId: string,
  issueTypeId: string,
): Promise<JiraMutationMetadata> {
  const values: unknown[] = [];
  let total: number | undefined;
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const response = await request(
      `issue/createmeta/${projectId}/issuetypes/${issueTypeId}?startAt=${String(values.length)}&maxResults=100`,
    );
    if (!response.ok) return response;
    const page = createPage(response, values.length);
    if (page === undefined || (total !== undefined && page.total !== total)) return MALFORMED;
    total = page.total;
    if (values.length + page.values.length > JIRA_METADATA_MAX_FIELDS)
      return { ok: false, reason: "bounds-exceeded" };
    values.push(...page.values);
    if (page.last) return parsedMetadata(parseJiraFieldMetadata(values));
  }
  return { ok: false, reason: "bounds-exceeded" };
}
export async function jiraEditMutationMetadata(
  request: JiraMutationRequest,
  issueKey: string,
): Promise<JiraMutationMetadata> {
  const response = await request(`issue/${encodeURIComponent(issueKey)}/editmeta`);
  if (!response.ok) return response;
  return response.status === 200 && response.body !== undefined
    ? parsedMetadata(parseJiraFieldMap(response.body.fields))
    : MALFORMED;
}
export async function jiraTransitionMutationMetadata(
  request: JiraMutationRequest,
  issueKey: string,
  transitionId: string,
): Promise<JiraMutationMetadata> {
  const response = await request(
    `issue/${encodeURIComponent(issueKey)}/transitions?expand=transitions.fields`,
  );
  if (!response.ok) return response;
  const transitions = asArray(response.body?.transitions);
  if (response.status !== 200 || transitions === undefined || transitions.length > 1000)
    return MALFORMED;
  const matches = transitions.map(asRecord).filter((item) => item?.id === transitionId);
  if (matches.length === 0) return { ok: false, reason: "invalid-transition" };
  if (matches.length !== 1) return MALFORMED;
  return parsedMetadata(parseJiraFieldMap(matches[0]?.fields));
}
