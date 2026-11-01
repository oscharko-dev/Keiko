import {
  ATLASSIAN_JQL_MAX_CHARS,
  JIRA_FIELD_ID_PATTERN,
  JIRA_REPORT_ID_PATTERN,
  JIRA_REPORT_REQUIREMENT_ID_CHARS_MAX,
  JIRA_REPORT_REQUIREMENT_ID_MAX,
  JIRA_REPORT_SECTIONS,
  JIRA_REPORT_STATUSES,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { createToolDescriptor, createToolRef } from "@oscharko-dev/keiko-tool-catalog";
import { object, text } from "./jiraManagedSchemas.js";

const OPEN_OBJECT = { type: "object", required: [], properties: {}, additionalProperties: true };
const FIELD_ID = { ...text(64), pattern: JIRA_FIELD_ID_PATTERN };

const REPORT_INPUT = object({
  projectKey: text(128),
  jql: { type: "string", minLength: 1, maxLength: ATLASSIAN_JQL_MAX_CHARS },
  estimateFieldId: FIELD_ID,
  asOf: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", maxLength: 10 },
  parentFieldIds: { type: "array", maxItems: 4, items: FIELD_ID },
  requirementsFromPods: { type: "boolean" },
  requirementIds: {
    type: "array",
    maxItems: JIRA_REPORT_REQUIREMENT_ID_MAX,
    items: {
      type: "string",
      maxLength: JIRA_REPORT_REQUIREMENT_ID_CHARS_MAX,
      pattern: `^[A-Za-z0-9][A-Za-z0-9._-]{0,${String(JIRA_REPORT_REQUIREMENT_ID_CHARS_MAX - 1)}}$`,
    },
  },
  reportId: { type: "string", maxLength: 36, pattern: JIRA_REPORT_ID_PATTERN },
  section: { type: "string", enum: JIRA_REPORT_SECTIONS },
  startAt: { type: "integer", minimum: 0, maximum: 10000000 },
  maxResults: { type: "integer", minimum: 1, maximum: 100 },
});

const DESCRIPTION =
  "Deterministic Jira report; use it, not jira.search or jira.issue, for any question about a whole project or many issues: " +
  "progress, estimates, template compliance, requirement coverage, epics without members, issues without an epic. " +
  "Scope: projectKey and/or jql. Keiko computes every number: quote report.figures verbatim, never recompute. " +
  "requirementsFromPods covers this Chat's Pod requirements. Estimate is seconds of original estimate unless estimateFieldId. " +
  "While status is reading, call again with only the reportId. " +
  "Name a section on the first call to page its list (deviations with details, requirements, statuses, epics, orphans, uncovered; maxResults up to 100, then nextStartAt; a cut summary list names its section and nextStartAt); comment is the text for jira.comment. issuesWithoutTemplate counts issues no template judged: not compliant. " +
  "A refusal names invalidArguments or a message.";

export const JIRA_REPORT_DECLARATION: ManagedMcpToolDeclaration = Object.freeze({
  name: "jira.report",
  risk: "read",
  descriptor: createToolDescriptor({
    toolRef: createToolRef("keiko.jira.report", 1),
    description: DESCRIPTION,
    inputSchema: REPORT_INPUT,
    resultSchema: object(
      {
        outcome: { type: "string", enum: ["succeeded", "failed"] },
        reason: text(64),
        status: { type: "string", enum: JIRA_REPORT_STATUSES },
        reportId: text(64),
        progress: OPEN_OBJECT,
        report: OPEN_OBJECT,
        section: OPEN_OBJECT,
        exports: { type: "array", maxItems: 4, items: text(16) },
        lastFailure: text(64),
        invalidArguments: { type: "array", maxItems: 16, items: text(64) },
        message: text(256),
        nextStartAt: { type: "integer", minimum: 0, maximum: 1000000000 },
      },
      ["outcome"],
    ),
    effects: ["connector-access"],
    actionMapping: [{ action: "jira.report", effects: ["connector-access"] }],
    policyReferences: ["adr-0128.d4"],
    handlerRequirement: { id: "jira.report", contractVersion: 1 },
    bounds: {
      maxArgumentBytes: 65536,
      maxResultBytes: 262144,
      maxResultCount: 100,
      maxDurationMs: 30000,
    },
    idempotency: "server-key-required",
    cancellation: "before-effect",
  }),
});
