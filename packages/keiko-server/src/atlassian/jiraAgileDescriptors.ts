import {
  ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS,
  JIRA_FIELD_VALIDATION_FAILURES,
  JIRA_MUTATION_RESULT_STATES,
  JIRA_MUTATION_DETAIL_LIMITS,
  JIRA_TEMPLATE_RULE_IDS,
  JIRA_TEMPLATE_VIOLATIONS_MAX,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { createToolDescriptor, createToolRef } from "@oscharko-dev/keiko-tool-catalog";
import { ATLASSIAN_ACTION_APPROVAL_TTL_MS } from "./actionApprovalLimits.js";
import { object, text } from "./jiraManagedSchemas.js";

const FAILURE_FIELD_ERRORS = {
  type: "array",
  maxItems: JIRA_MUTATION_DETAIL_LIMITS.fieldErrors,
  items: object(
    {
      fieldId: text(64),
      fieldName: text(JIRA_MUTATION_DETAIL_LIMITS.messageChars),
      message: text(JIRA_MUTATION_DETAIL_LIMITS.messageChars),
    },
    ["fieldId", "message"],
  ),
};
const FAILURE_MESSAGES = {
  type: "array",
  maxItems: JIRA_MUTATION_DETAIL_LIMITS.messages,
  items: text(JIRA_MUTATION_DETAIL_LIMITS.messageChars),
};
const TEMPLATE_VIOLATIONS = {
  type: "array",
  maxItems: JIRA_TEMPLATE_VIOLATIONS_MAX,
  items: object(
    {
      ruleId: { type: "string", enum: JIRA_TEMPLATE_RULE_IDS },
      subject: text(120),
      template: text(256),
    },
    ["ruleId", "subject", "template"],
  ),
};
// Preserve every bounded template refusal, including worst-case JSON escaping of its text.
const WRITE_RESULT_BYTES =
  32768 +
  JIRA_TEMPLATE_VIOLATIONS_MAX *
    ((Math.max(...JIRA_TEMPLATE_RULE_IDS.map((id) => id.length)) + 120 + 256) * 6 + 128);

// These declarations describe the closed DC adapters; neither an endpoint nor a method is input.
const ID = {
  ...text(16),
  pattern: "^[1-9][0-9]{0,15}$",
  description: "Canonical decimal Jira ID, no greater than 9007199254740991.",
};
const KEY = { ...text(50), pattern: "^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,15}$" };
const EPIC_ID_OR_KEY = {
  ...text(50),
  pattern: "^(?:[1-9][0-9]{0,15}|[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,15})$",
};
const NAME = { ...text(255), minLength: 1 };
const DATE = { ...text(40), description: "ISO 8601 timestamp including its UTC offset or Z." };
const BOARD_TYPE = { type: "string", enum: ["scrum", "kanban"] };
const SPRINT_STATE = { type: "string", enum: ["future", "active", "closed"] };
const PAGE_NUMBER = { type: "integer", minimum: 0, maximum: 1_000_000 };
const PAGING = {
  startAt: PAGE_NUMBER,
  maxResults: { type: "integer", minimum: 1, maximum: 100 },
};
const ISSUE_KEYS = {
  type: "array",
  minItems: 1,
  maxItems: 50,
  items: KEY,
  description: "Unique issue keys. Jira permits at most 50 issues in one membership change.",
};
const BOARD_FIELDS = { id: ID, name: NAME, type: BOARD_TYPE, browseUrl: text(4096) };
const BOARD = object(BOARD_FIELDS, ["id", "name", "type"]);
const SPRINT = object(
  {
    id: ID,
    name: NAME,
    state: SPRINT_STATE,
    originBoardId: ID,
    boardBrowseUrl: text(4096),
    startDate: DATE,
    endDate: DATE,
    activatedDate: DATE,
    completeDate: DATE,
    goal: text(2048),
  },
  ["id", "name", "state"],
);
const EPIC = object(
  {
    id: ID,
    key: KEY,
    name: NAME,
    summary: NAME,
    done: { type: "boolean" },
    color: {
      type: "string",
      enum: Array.from({ length: 14 }, (_, index) => `color_${String(index + 1)}`),
    },
    browseUrl: text(4096),
  },
  ["id", "key", "name", "summary", "done"],
);
const REFERENCE = object({
  id: text(256),
  key: text(256),
  name: text(256),
  displayName: text(256),
});
const ISSUE = object(
  {
    id: text(128),
    key: text(128),
    summary: text(255),
    browseUrl: text(4096),
    status: REFERENCE,
    issuetype: REFERENCE,
    project: REFERENCE,
    assignee: REFERENCE,
    priority: REFERENCE,
    assigneeEmpty: { type: "boolean" },
    labels: { type: "array", maxItems: 100, items: text(255) },
    created: text(64),
    updated: text(64),
  },
  ["id", "key", "summary", "browseUrl"],
);
const CONFIGURATION = object(
  {
    ...BOARD_FIELDS,
    filterId: ID,
    columns: {
      type: "array",
      maxItems: 100,
      items: object(
        {
          name: NAME,
          statusIds: { type: "array", maxItems: 100, items: ID },
          min: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          max: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        },
        ["name", "statusIds"],
      ),
    },
  },
  ["id", "name", "type", "filterId", "columns"],
);
interface ReadDefinition {
  readonly description: string;
  readonly parameters: CatalogJsonObject;
  readonly required: readonly string[];
  readonly item: CatalogJsonObject;
  readonly paged: boolean;
}
const FILTER = object(
  {
    id: ID,
    name: NAME,
    jql: text(TOOL_CATALOG_LIMITS.maxStringBytes),
    owner: object({ key: text(255), name: text(255), displayName: text(255) }),
    favourite: { type: "boolean" },
    shareScope: { type: "string", enum: ["private", "shared", "unknown"] },
    sharePermissionCount: PAGE_NUMBER,
  },
  ["id", "name", "jql", "shareScope"],
);
/** C2 board reuse prerequisites remain native REST v2 reads, not Agile-root operations. */
export const JIRA_FILTER_READ_DEFINITIONS = {
  "jira.filter": {
    description:
      "Read a saved filter's ID, name, native JQL and available owner/sharing facts before using it for a board. Missing sharing facts mean unknown, never private.",
    parameters: { filterId: ID },
    required: ["filterId"],
    item: FILTER,
    paged: false,
  },
  "jira.favourite-filters": {
    description:
      "Read the current actor's favourite saved filters for board reuse. Jira returns an unpaged list; Keiko bounds that reply and exposes a local page with nextStartAt.",
    parameters: { startAt: { type: "integer", minimum: 0, maximum: 1000 } },
    required: [],
    item: FILTER,
    paged: true,
  },
} as const satisfies Readonly<Record<string, ReadDefinition>>;
export const JIRA_AGILE_READ_DEFINITIONS = {
  "jira.boards": {
    description:
      "List visible Jira Software boards, optionally filtered by name, project or board type. Follow nextStartAt for another page.",
    parameters: { name: NAME, type: BOARD_TYPE, projectKeyOrId: text(255) },
    required: [],
    item: BOARD,
    paged: true,
  },
  "jira.board": {
    description: "Read one visible Jira Software board by its ID.",
    parameters: { boardId: ID },
    required: ["boardId"],
    item: BOARD,
    paged: false,
  },
  "jira.board-configuration": {
    description:
      "Read a board's configured filter and columns with their status IDs and optional limits.",
    parameters: { boardId: ID },
    required: ["boardId"],
    item: CONFIGURATION,
    paged: false,
  },
  "jira.board-backlog": {
    description:
      "Read a page of issues in a board's backlog. Returns standard issue summaries, not an unrestricted JQL query.",
    parameters: { boardId: ID },
    required: ["boardId"],
    item: ISSUE,
    paged: true,
  },
  "jira.board-issues": {
    description:
      "Read a page of issues visible on a board. Follow nextStartAt; only the current bounded page is returned.",
    parameters: { boardId: ID },
    required: ["boardId"],
    item: ISSUE,
    paged: true,
  },
  "jira.board-epics": {
    description: "Read a page of epics on a board, optionally filtered by their done state.",
    parameters: { boardId: ID, done: { type: "boolean" } },
    required: ["boardId"],
    item: EPIC,
    paged: true,
  },
  "jira.epic": {
    description: "Read one visible epic by issue key or numeric ID.",
    parameters: { epicIdOrKey: EPIC_ID_OR_KEY },
    required: ["epicIdOrKey"],
    item: EPIC,
    paged: false,
  },
  "jira.epic-issues": {
    description: "Read a bounded page of issues belonging to one epic.",
    parameters: { epicIdOrKey: EPIC_ID_OR_KEY },
    required: ["epicIdOrKey"],
    item: ISSUE,
    paged: true,
  },
  "jira.sprints": {
    description:
      "Read a page of a board's sprints, optionally filtered by future, active or closed state.",
    parameters: { boardId: ID, state: SPRINT_STATE },
    required: ["boardId"],
    item: SPRINT,
    paged: true,
  },
  "jira.sprint": {
    description: "Read one visible sprint including its state, goal and available dates.",
    parameters: { sprintId: ID },
    required: ["sprintId"],
    item: SPRINT,
    paged: false,
  },
  "jira.sprint-issues": {
    description: "Read a bounded page of issues belonging to one sprint.",
    parameters: { sprintId: ID },
    required: ["sprintId"],
    item: ISSUE,
    paged: true,
  },
} as const satisfies Readonly<Record<string, ReadDefinition>>;
const SPRINT_CHANGES = { name: NAME, startDate: DATE, endDate: DATE, goal: text(2048) };
interface WriteDefinition {
  readonly description: string;
  readonly input: CatalogJsonObject;
  readonly receipts: CatalogJsonObject;
}
export const JIRA_AGILE_WRITE_DEFINITIONS = {
  "jira.board-create": {
    description:
      "Create one Jira Software board from an existing saved filter. Filter sharing determines visibility. Confirms the created board's name, type and filter; never repeat an uncertain creation automatically.",
    input: object({ name: { ...NAME, maxLength: 254 }, type: BOARD_TYPE, filterId: ID }, [
      "name",
      "type",
      "filterId",
    ]),
    receipts: { boardId: ID, browseUrl: text(4096) },
  },
  "jira.sprint-create": {
    description:
      "Create a future sprint on a board and verify its stored fields. Name and board ID are required; dates and goal are optional. Never repeat an uncertain creation automatically.",
    input: object({ ...SPRINT_CHANGES, originBoardId: ID }, ["name", "originBoardId"]),
    receipts: { sprintId: ID, originBoardId: ID, boardBrowseUrl: text(4096) },
  },
  "jira.sprint-update": {
    description:
      "Partially update a sprint, preserving omitted fields. Supply at least one change. Start only a future sprint with start/end dates; close only an active sprint. Closed sprints cannot be edited. An empty goal removes the goal; completeDate is controlled by Jira.",
    input: object(
      { sprintId: ID, ...SPRINT_CHANGES, state: { type: "string", enum: ["active", "closed"] } },
      ["sprintId"],
    ),
    receipts: { sprintId: ID, originBoardId: ID, boardBrowseUrl: text(4096) },
  },
  "jira.sprint-move-issues": {
    description:
      "Move up to 50 unique issues into a future or active sprint. Jira checks edit permissions; each issue's actual membership is read back after the acknowledgement.",
    input: object({ sprintId: ID, issues: ISSUE_KEYS }, ["sprintId", "issues"]),
    receipts: {
      sprintId: ID,
      issueKeys: ISSUE_KEYS,
      originBoardId: ID,
      boardBrowseUrl: text(4096),
    },
  },
  "jira.backlog-move-issues": {
    description:
      "Move up to 50 unique issues to the backlog, removing active/future sprint membership while retaining closed sprint history. Each issue must confirm the removal after Jira acknowledges it.",
    input: object({ issues: ISSUE_KEYS }, ["issues"]),
    receipts: { issueKeys: ISSUE_KEYS },
  },
  "jira.epic-update": {
    description:
      "Partially update an existing epic's name, summary, done state or documented color. Supply at least one change. Omitted fields are preserved and changed fields are read back.",
    input: object(
      {
        epicIdOrKey: EPIC_ID_OR_KEY,
        name: NAME,
        summary: NAME,
        done: { type: "boolean" },
        color: {
          type: "string",
          enum: Array.from({ length: 9 }, (_, index) => `color_${String(index + 1)}`),
        },
      },
      ["epicIdOrKey"],
    ),
    receipts: { epicKey: KEY, browseUrl: text(4096) },
  },
  "jira.epic-move-issues": {
    description:
      "Move up to 50 unique issues to an epic, replacing any previous epic membership. Jira checks edit permissions for the epic and issues; each issue is read back to confirm the new epic.",
    input: object({ epicIdOrKey: EPIC_ID_OR_KEY, issues: ISSUE_KEYS }, ["epicIdOrKey", "issues"]),
    receipts: { epicKey: KEY, issueKeys: ISSUE_KEYS, browseUrl: text(4096) },
  },
} as const satisfies Readonly<Record<string, WriteDefinition>>;

function readResult(definition: ReadDefinition): CatalogJsonObject {
  return object(
    {
      outcome: { type: "string", enum: ["succeeded", "failed"] },
      reason: text(64),
      fieldErrors: FAILURE_FIELD_ERRORS,
      messages: FAILURE_MESSAGES,
      items: { type: "array", maxItems: definition.paged ? 100 : 1, items: definition.item },
      ...(definition.paged
        ? { startAt: PAGE_NUMBER, total: PAGE_NUMBER, nextStartAt: PAGE_NUMBER }
        : {}),
    },
    ["outcome"],
  );
}
function writeResult(definition: WriteDefinition): CatalogJsonObject {
  return object(
    {
      ...definition.receipts,
      violations: TEMPLATE_VIOLATIONS,
      outcome: { type: "string", enum: JIRA_MUTATION_RESULT_STATES },
      reason: { type: "string", enum: ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS },
      replayed: { type: "boolean" },
      unchanged: { type: "boolean" },
      guidance: text(512),
      fieldId: text(64),
      validation: { type: "string", enum: JIRA_FIELD_VALIDATION_FAILURES },
      fieldErrors: FAILURE_FIELD_ERRORS,
      messages: FAILURE_MESSAGES,
    },
    ["outcome"],
  );
}
function declaration(
  name: string,
  definition: ReadDefinition | WriteDefinition,
): ManagedMcpToolDeclaration {
  const write = "input" in definition;
  return Object.freeze({
    name,
    risk: write ? "write" : "read",
    descriptor: createToolDescriptor({
      toolRef: createToolRef(`keiko.${name.replaceAll("-", ".")}`, 1),
      description: definition.description,
      inputSchema: write
        ? definition.input
        : object(
            { ...(definition.paged ? PAGING : {}), ...definition.parameters },
            definition.required,
          ),
      resultSchema: write ? writeResult(definition) : readResult(definition),
      effects: ["connector-access"],
      actionMapping: [{ action: name, effects: ["connector-access"] }],
      policyReferences: ["adr-0128.d4"],
      handlerRequirement: { id: name, contractVersion: 1 },
      bounds: {
        maxArgumentBytes: write ? 32768 : 8192,
        maxResultBytes: write ? WRITE_RESULT_BYTES : 262144,
        maxResultCount: write ? 1 : 100,
        maxDurationMs: write ? 90000 + ATLASSIAN_ACTION_APPROVAL_TTL_MS : 15000,
      },
      idempotency: "server-key-required",
      cancellation: "before-effect",
    }),
  });
}
/** Pure selected lookup: callers need not compile every Agile schema to offer one operation. */
export function jiraAgileDeclarationForTool(name: string): ManagedMcpToolDeclaration | undefined {
  const reads: Readonly<Record<string, ReadDefinition>> = {
    ...JIRA_AGILE_READ_DEFINITIONS,
    ...JIRA_FILTER_READ_DEFINITIONS,
  };
  const writes: Readonly<Record<string, WriteDefinition>> = JIRA_AGILE_WRITE_DEFINITIONS;
  const definition = Object.hasOwn(reads, name)
    ? reads[name]
    : Object.hasOwn(writes, name)
      ? writes[name]
      : undefined;
  return definition === undefined ? undefined : declaration(name, definition);
}
