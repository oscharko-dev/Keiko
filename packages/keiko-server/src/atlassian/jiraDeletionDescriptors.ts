import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeIdentitySchema as ID,
  jiraNativeProjectSchema as ISSUE,
  jiraNativeWriteResult,
  jiraNativeDeclaration,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const VISIBILITY = object(
  { type: { type: "string", enum: ["group", "role"] }, value: { ...text(255), minLength: 1 } },
  ["type", "value"],
);
const SIZE = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };

export const JIRA_DELETION_DEFINITIONS = {
  "jira.delete-comment": {
    description:
      "Permanently delete one issue-bound comment after comparing its current native body and visibility with the reviewed snapshot. expectedBody may be empty; omitting expectedVisibility explicitly means unrestricted. A changed or inaccessible comment refuses before DELETE. Confirm only after the same issue remains readable and the exact comment is absent. Never retry an unknown deletion.",
    input: object(
      {
        issueKey: ISSUE,
        commentId: ID,
        expectedBody: text(32768),
        expectedVisibility: VISIBILITY,
      },
      ["issueKey", "commentId", "expectedBody"],
    ),
    result: jiraNativeWriteResult({ issueKey: ISSUE, issueId: ID, commentId: ID }),
    risk: "write",
    maxResultCount: 1,
  },
  "jira.delete-attachment": {
    description:
      "Permanently delete one attachment only after verifying its issue membership, exact attachment ID, native filename and byte size against this reviewed snapshot. Send one DELETE, then independently confirm that the same readable issue no longer lists the attachment. A remote 404 or lost response alone never proves success. Never retry an unknown deletion.",
    input: object(
      {
        issueKey: ISSUE,
        attachmentId: ID,
        filename: { ...text(1024), minLength: 1 },
        size: SIZE,
      },
      ["issueKey", "attachmentId", "filename", "size"],
    ),
    result: jiraNativeWriteResult({ issueKey: ISSUE, issueId: ID, attachmentId: ID }),
    risk: "write",
    maxResultCount: 1,
  },
  "jira.delete-worklog": {
    description:
      "Permanently delete one issue-bound worklog after matching the full reviewed native snapshot: seconds, explicit-timezone start, comment and visibility (null means unrestricted). Preserve remaining estimate with fixed adjustEstimate=leave; admit the observed aggregate time change through active issue templates. After one DELETE, confirm absence only in a complete readable worklog list for the same issue. Never retry an unknown deletion.",
    input: object(
      {
        issueKey: ISSUE,
        worklogId: ID,
        timeSpentSeconds: SIZE,
        started: { ...text(40), minLength: 20 },
        comment: text(32768),
        visibility: { anyOf: [{ type: "null" }, VISIBILITY] },
      },
      ["issueKey", "worklogId", "timeSpentSeconds", "started", "comment", "visibility"],
    ),
    result: jiraNativeWriteResult({ issueKey: ISSUE, issueId: ID, worklogId: ID }),
    risk: "write",
    maxResultCount: 1,
  },
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;

export function jiraDeletionDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = JIRA_DELETION_DEFINITIONS;
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
