import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import { jiraNativeDeclaration, jiraNativeIdentitySchema as ID, jiraNativeProjectSchema as ISSUE, jiraNativeWriteResult, type JiraNativeDefinition } from "./jiraProjectStructureDescriptors.js";
import { jiraRemoteLinkValueSchema as REMOTE_VALUE, jiraRemoteLinkUpsertValueSchema as UPSERT_VALUE, jiraRemoteLinkSnapshotSchema as REMOTE_EXPECTED } from "./jiraRemoteLinkSchemas.js";

const NAME = { ...text(255), minLength: 1 };
const REMOTE_INPUT = { issueIdOrKey: ISSUE, expectedActorKey: NAME };
const LINK_TYPE = object({ id: ID, name: NAME, inward: NAME, outward: NAME }, ["id", "name", "inward", "outward"]);
const ISSUE_INPUT = { inwardIssueIdOrKey: ISSUE, outwardIssueIdOrKey: ISSUE, expectedActorKey: NAME, linkType: LINK_TYPE };
const ISSUE_REQUIRED = ["inwardIssueIdOrKey", "outwardIssueIdOrKey", "expectedActorKey", "linkType"];
const RECEIPT = jiraNativeWriteResult({ issueId: ID, issueKey: ISSUE, linkedIssueId: ID, linkedIssueKey: ISSUE, linkTypeId: ID, linkId: ID, userKey: NAME, linkPresent: { type: "boolean" } });
function definition(description: string, input: CatalogJsonObject): JiraNativeDefinition {
  return { description, input, result: RECEIPT, risk: "write", maxResultCount: 1 };
}
/** Fixed native effects only. No link-type catalog mutation, reciprocal write, or optional comment. */
export const JIRA_LINK_WRITE_DEFINITIONS = {
  "jira.create-issue-link": definition(
    "Create one exact native issue relation. inwardIssueIdOrKey is the source and outwardIssueIdOrKey the destination. Review the connected actor key and the exact current link type ID/name/inward/outward labels. Independently bind both issues, read complete relation lists and enforce saved issue templates for the planned state. An existing exact relation reports unchanged. Send one POST without a comment; only acknowledged creation plus one new matching native ID on both lists and an independent link detail can confirm. Lost responses are never replayed.",
    object(ISSUE_INPUT, ISSUE_REQUIRED)),
  "jira.delete-issue-link": definition(
    "Delete one native issue relation by exact link ID after reviewing both issue identities and all link-type labels. Bind the selected detail and both complete parent relation lists, and enforce saved templates against the relation after removal. Send one DELETE; confirm only exact absence in both still-readable complete relation lists with all other relations unchanged. A 404 or inaccessible parent is not deletion proof. Never replay an uncertain operation.",
    object({ ...ISSUE_INPUT, linkId: ID }, [...ISSUE_REQUIRED, "linkId"])),
  "jira.upsert-remote-link": definition(
    "Create or replace one remote issue link by its global ID (nonempty, at most 255 characters). Jira POST updates an existing global ID rather than always creating. Supply the full replacement value with every nullable field explicit, plus exactly one review form: expectAbsent:true or expected containing the exact native ID and complete prior value from reviewSnapshot. Missing optional native fields are represented as null only for the complete supported bean. Rebind the actor and parent and compare the complete list immediately before one POST; Jira has no atomic compare-and-set, so concurrent changes remain possible. Creation requires an acknowledged new ID; independently verify the complete same-parent list and exact detail. No external URL is followed and unknown results are not replayed.",
    { ...object({ ...REMOTE_INPUT, value: UPSERT_VALUE, expected: REMOTE_EXPECTED, expectAbsent: { const: true } }, ["issueIdOrKey", "expectedActorKey", "value"]),
      oneOf: [{ required: ["expectAbsent"], not: { required: ["expected"] } }, { required: ["expected"], not: { required: ["expectAbsent"] } }] }),
  "jira.update-remote-link": definition(
    "Replace one exact remote link by native ID. Review expected with every prior nullable field explicit and provide the complete replacement value: Jira PUT clears omitted native fields. Canonical actor/issue, complete list and selected detail must agree; a changed snapshot or global-ID collision refuses before one PUT. Independently confirm the exact same link and unchanged other links. URLs are metadata, never fetched. No automatic replay.",
    object({ ...REMOTE_INPUT, linkId: ID, expected: REMOTE_EXPECTED, value: REMOTE_VALUE }, ["issueIdOrKey", "expectedActorKey", "linkId", "expected", "value"])),
  "jira.delete-remote-link": definition(
    "Delete one remote link by its exact native ID and reviewed complete expected value. Bind the connected actor, canonical parent, complete collection and selected detail before one DELETE. Confirm only its absence from the independently readable complete same-parent collection while every other link remains unchanged; 404 alone proves nothing. Unknown outcomes retain the known ID and are never replayed.",
    object({ ...REMOTE_INPUT, linkId: ID, expected: REMOTE_EXPECTED }, ["issueIdOrKey", "expectedActorKey", "linkId", "expected"])),
  "jira.delete-remote-link-by-global-id": definition(
    "Delete the single remote link with the reviewed global ID on one canonical issue. Review its complete expected value including the observed native ID; the complete list must prove one unambiguous global-ID member and its detail must match. Encode only the fixed globalId query, send one DELETE, and independently confirm complete same-parent absence plus unchanged other links. No 404 absence inference or replay.",
    object({ ...REMOTE_INPUT, globalId: NAME, expected: REMOTE_EXPECTED }, ["issueIdOrKey", "expectedActorKey", "globalId", "expected"])),
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;
export function jiraLinkMutationDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_LINK_WRITE_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
