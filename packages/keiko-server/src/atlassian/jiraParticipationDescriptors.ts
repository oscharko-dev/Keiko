import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { object, text } from "./jiraManagedSchemas.js";
import {
  jiraNativeIdentitySchema as ID,
  jiraNativeProjectSchema as ISSUE,
  jiraNativePagingSchema as PAGING,
  jiraNativeReadResult,
  jiraNativeWriteResult,
  jiraNativeDeclaration,
  type JiraNativeDefinition,
} from "./jiraProjectStructureDescriptors.js";

const COUNT = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const PERSON = object(
  { name: { ...text(255), minLength: 1 }, displayName: text(255), active: { type: "boolean" } },
  ["name"],
);
const READ_RESULT = jiraNativeReadResult({
  issueKey: ISSUE,
  items: { type: "array", maxItems: 100, items: PERSON },
  startAt: PAGING.startAt,
  total: COUNT,
  nextStartAt: PAGING.startAt,
  listComplete: { type: "boolean" },
  watchCount: COUNT,
  votes: COUNT,
  isWatching: { type: "boolean" },
  hasVoted: { type: "boolean" },
});
const ISSUE_INPUT = object({ issueKey: ISSUE }, ["issueKey"]);
const PARTICIPATION_RECEIPT = {
  issueKey: ISSUE,
  issueId: ID,
  isWatching: { type: "boolean" },
  hasVoted: { type: "boolean" },
};
const WORKLOG_FIELDS = {
  timeSpentSeconds: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  started: {
    ...text(40),
    minLength: 20,
    description: "ISO timestamp with an explicit timezone, for example 2026-11-07T09:00:00.000Z.",
  },
  comment: text(32768),
};
const VISIBILITY = object(
  { type: { type: "string", enum: ["group", "role"] }, value: { ...text(255), minLength: 1 } },
  ["type", "value"],
);
export const JIRA_PARTICIPATION_READ_DEFINITIONS = {
  "jira.watchers": {
    description:
      "Read the issue's native watcher count, the connected user's observed watching state and a local page of visible watcher identities. listComplete describes the returned native list; missing or permission-hidden people are not inferred from a count. No user emails or remote URLs are exposed.",
    input: object({ issueKey: ISSUE, ...PAGING }, ["issueKey"]),
    result: READ_RESULT,
    risk: "read",
    maxResultCount: 100,
  },
  "jira.votes": {
    description:
      "Read the issue's native vote count, the connected user's observed vote state and a local page of visible voter identities. Missing identities or state stay unknown. listComplete never treats a permission-hidden list as complete; no emails or remote URLs are exposed.",
    input: object({ issueKey: ISSUE, ...PAGING }, ["issueKey"]),
    result: READ_RESULT,
    risk: "read",
    maxResultCount: 100,
  },
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;
function participation(description: string): JiraNativeDefinition {
  return {
    description,
    input: ISSUE_INPUT,
    result: jiraNativeWriteResult(PARTICIPATION_RECEIPT),
    risk: "write",
    maxResultCount: 1,
  };
}
export const JIRA_PARTICIPATION_WRITE_DEFINITIONS = {
  "jira.watch": participation(
    "Start watching the issue as the connected Jira user. Read current state first, perform one native POST and independently confirm isWatching=true. Other users cannot be selected. An already matching state causes no write; never retry an unknown outcome.",
  ),
  "jira.unwatch": participation(
    "Stop watching the issue as the connected Jira user. Resolve that user's identity through the bound credential, perform one native DELETE and independently confirm isWatching=false. No other actor or target can be selected. Never retry an unknown outcome.",
  ),
  "jira.vote": participation(
    "Cast the connected user's vote for the issue using one native POST after current-state inspection. Jira voting rules and permissions remain authoritative. Independently confirm hasVoted=true; never claim success from the HTTP acknowledgement alone or retry an unknown outcome.",
  ),
  "jira.unvote": participation(
    "Withdraw the connected user's own vote using one native DELETE after current-state inspection. Independently confirm hasVoted=false; an already matching state performs no write. This cannot remove somebody else's vote. Never retry an unknown outcome.",
  ),
  "jira.create-worklog": {
    description:
      "Record work on the issue with explicit seconds and start time, optional native Jira comment and optional group/role visibility. The fixed native adjustEstimate=leave preserves the remaining estimate. Apply active issue templates before one POST and independently read the exact returned worklog identity. Never repeat an unconfirmed create.",
    input: object({ issueKey: ISSUE, ...WORKLOG_FIELDS, visibility: VISIBILITY }, [
      "issueKey",
      "timeSpentSeconds",
      "started",
    ]),
    result: jiraNativeWriteResult({ issueKey: ISSUE, issueId: ID, worklogId: ID }),
    risk: "write",
    maxResultCount: 1,
  },
  "jira.update-worklog": {
    description:
      "Update one issue-bound worklog's seconds, start time or native Jira comment, preserving its observed visibility and the issue's remaining estimate (adjustEstimate=leave). Supply at least one changed field. Apply active issue templates, send one PUT and independently read back identity and requested values. Never retry an unknown outcome.",
    input: {
      ...object({ issueKey: ISSUE, worklogId: ID, ...WORKLOG_FIELDS }, ["issueKey", "worklogId"]),
      anyOf: [
        { required: ["timeSpentSeconds"] },
        { required: ["started"] },
        { required: ["comment"] },
      ],
    },
    result: jiraNativeWriteResult({ issueKey: ISSUE, issueId: ID, worklogId: ID }),
    risk: "write",
    maxResultCount: 1,
  },
} as const satisfies Readonly<Record<string, JiraNativeDefinition>>;
export function jiraParticipationDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, JiraNativeDefinition>> = {
    ...JIRA_PARTICIPATION_READ_DEFINITIONS,
    ...JIRA_PARTICIPATION_WRITE_DEFINITIONS,
  };
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : jiraNativeDeclaration(name, selected);
}
