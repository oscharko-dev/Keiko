import {
  ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS,
  JIRA_FIELD_VALIDATION_FAILURES,
  JIRA_MUTATION_DETAIL_LIMITS,
  JIRA_MUTATION_RESULT_STATES,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { ManagedMcpToolDeclaration } from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import {
  compileExternalCatalogSchema,
  createToolDescriptor,
  createToolRef,
} from "@oscharko-dev/keiko-tool-catalog";
import { ATLASSIAN_ACTION_APPROVAL_TTL_MS } from "./actionApprovalLimits.js";
import { object, text } from "./jiraManagedSchemas.js";

const ID = {
  ...text(19),
  allOf: [{ pattern: "^[1-9]" }, { pattern: "^[0-9]{1,19}$" }],
  description: "Canonical positive decimal identity, no greater than 9223372036854775807.",
};
const PROJECT = {
  ...text(128),
  allOf: [{ pattern: "^[A-Za-z0-9~]" }, { not: { pattern: "[^A-Za-z0-9._~-]" } }],
};
const NAME = { ...text(255), minLength: 1 };
const DESCRIPTION = text(32768);
const DATE = { ...text(10), format: "date" };
const PAGE_NUMBER = { type: "integer", minimum: 0, maximum: 1_000_000 };
const PAGING = {
  startAt: PAGE_NUMBER,
  maxResults: { type: "integer", minimum: 1, maximum: 100 },
};
const COMPONENT_FIELDS = {
  name: NAME,
  description: DESCRIPTION,
  leadUserName: NAME,
  assigneeType: {
    type: "string",
    enum: ["PROJECT_DEFAULT", "COMPONENT_LEAD", "PROJECT_LEAD", "UNASSIGNED"],
  },
};
const COMPONENT = object(
  {
    ...COMPONENT_FIELDS,
    id: ID,
    project: PROJECT,
    archived: { type: "boolean" },
    deleted: { type: "boolean" },
  },
  ["id", "name", "project"],
);
const VERSION_FIELDS = {
  name: NAME,
  description: DESCRIPTION,
  startDate: DATE,
  releaseDate: DATE,
  released: { type: "boolean" },
  archived: { type: "boolean" },
};
const VERSION = object({ ...VERSION_FIELDS, versionId: ID, projectId: ID }, [
  "versionId",
  "projectId",
  "name",
]);
const FAILURE_FIELDS = {
  reason: { type: "string", enum: ATLASSIAN_CONNECTOR_WRITE_FAILURE_REASONS },
  fieldErrors: {
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
  },
  messages: {
    type: "array",
    maxItems: JIRA_MUTATION_DETAIL_LIMITS.messages,
    items: text(JIRA_MUTATION_DETAIL_LIMITS.messageChars),
  },
};
function readResult(fields: CatalogJsonObject): CatalogJsonObject {
  return object(
    {
      ...fields,
      ...FAILURE_FIELDS,
      reason: text(64),
      outcome: { type: "string", enum: ["succeeded", "failed"] },
    },
    ["outcome"],
  );
}
function collection(item: CatalogJsonObject): CatalogJsonObject {
  return readResult({
    items: { type: "array", maxItems: 100, items: item },
    startAt: PAGE_NUMBER,
    total: PAGE_NUMBER,
    nextStartAt: PAGE_NUMBER,
  });
}
function writeResult(receipt: CatalogJsonObject): CatalogJsonObject {
  return object(
    {
      ...receipt,
      ...FAILURE_FIELDS,
      outcome: { type: "string", enum: JIRA_MUTATION_RESULT_STATES },
      replayed: { type: "boolean" },
      guidance: text(512),
      browseUrl: text(4096),
      fieldId: text(64),
      validation: { type: "string", enum: JIRA_FIELD_VALIDATION_FAILURES },
    },
    ["outcome"],
  );
}
interface Definition {
  readonly description: string;
  readonly input: CatalogJsonObject;
  readonly result: CatalogJsonObject;
  readonly risk: "read" | "write";
  readonly maxResultCount: number;
}
export const JIRA_PROJECT_STRUCTURE_READ_DEFINITIONS = {
  "jira.components": {
    description:
      "Read one bounded page of a project's native components. Follow nextStartAt; component identities remain exact decimal strings.",
    input: object({ projectIdOrKey: PROJECT, ...PAGING }, ["projectIdOrKey"]),
    result: collection(COMPONENT),
    risk: "read",
    maxResultCount: 100,
  },
  "jira.component": {
    description:
      "Inspect a native Jira component by its exact string identity, including its project, lead and assignee policy when available.",
    input: object({ componentId: ID }, ["componentId"]),
    result: readResult({ items: { type: "array", maxItems: 1, items: COMPONENT } }),
    risk: "read",
    maxResultCount: 1,
  },
  "jira.versions": {
    description:
      "Read one bounded page of a project's native versions, with available dates and explicit release/archive states. Follow nextStartAt.",
    input: object({ projectIdOrKey: PROJECT, ...PAGING }, ["projectIdOrKey"]),
    result: collection(VERSION),
    risk: "read",
    maxResultCount: 100,
  },
  "jira.version": {
    description:
      "Inspect a native Jira version by its exact string identity. Absent dates or release/archive states are unavailable facts.",
    input: object({ versionId: ID }, ["versionId"]),
    result: readResult({ ...VERSION_FIELDS, versionId: ID, projectId: ID }),
    risk: "read",
    maxResultCount: 1,
  },
} as const satisfies Readonly<Record<string, Definition>>;
const COMPONENT_RECEIPT = { componentId: ID, projectId: ID, projectKey: PROJECT };
export const JIRA_PROJECT_STRUCTURE_WRITE_DEFINITIONS = {
  "jira.create-component": {
    description:
      "Create a component in an explicitly selected existing project. Name is required; ordinary description, lead username and assignee policy are optional. Verify stored fields independently and never repeat uncertain creation automatically.",
    input: object({ projectIdOrKey: PROJECT, ...COMPONENT_FIELDS }, ["projectIdOrKey", "name"]),
    result: writeResult(COMPONENT_RECEIPT),
    risk: "write",
    maxResultCount: 1,
  },
  "jira.update-component": {
    description:
      "Update a component's ordinary metadata and independently read it back. Supply at least one change. Its existing project is fixed; archive, delete and project moves are unavailable here.",
    input: {
      ...object({ componentId: ID, ...COMPONENT_FIELDS }, ["componentId"]),
      minProperties: 2,
    },
    result: writeResult(COMPONENT_RECEIPT),
    risk: "write",
    maxResultCount: 1,
  },
  "jira.create-version": {
    description:
      "Create a native version in an existing project and independently verify its stored fields. Use ISO calendar dates (YYYY-MM-DD) and explicit release/archive booleans. Never repeat uncertain creation automatically.",
    input: object(
      {
        projectId: {
          ...ID,
          maxLength: 16,
          description:
            "Existing project ID as a decimal string, no greater than 9007199254740991 so the native numeric field remains exact.",
        },
        ...VERSION_FIELDS,
      },
      ["projectId", "name"],
    ),
    result: writeResult({ versionId: ID }),
    risk: "write",
    maxResultCount: 1,
  },
  "jira.update-version": {
    description:
      "Update a native version's name, description, dates or explicit release/archive state. Supply at least one change; omitted fields remain unchanged and the existing project is fixed. Independent readback confirms the change.",
    input: { ...object({ versionId: ID, ...VERSION_FIELDS }, ["versionId"]), minProperties: 2 },
    result: writeResult({ versionId: ID }),
    risk: "write",
    maxResultCount: 1,
  },
} as const satisfies Readonly<Record<string, Definition>>;
function declaration(name: string, definition: Definition): ManagedMcpToolDeclaration {
  const write = definition.risk === "write";
  return Object.freeze({
    name,
    risk: definition.risk,
    descriptor: createToolDescriptor({
      toolRef: createToolRef(`keiko.${name.replaceAll("-", ".")}`, 1),
      description: definition.description,
      inputSchema: compileExternalCatalogSchema(definition.input),
      resultSchema: compileExternalCatalogSchema(definition.result),
      effects: ["connector-access"],
      actionMapping: [{ action: name, effects: ["connector-access"] }],
      policyReferences: ["adr-0128.d4"],
      handlerRequirement: { id: name, contractVersion: 1 },
      bounds: {
        maxArgumentBytes: write ? 262144 : 8192,
        maxResultBytes: write ? 32768 : 262144,
        maxResultCount: definition.maxResultCount,
        maxDurationMs: write ? 90000 + ATLASSIAN_ACTION_APPROVAL_TTL_MS : 15000,
      },
      idempotency: "server-key-required",
      cancellation: "before-effect",
    }),
  });
}
/** Pure typed selection within the existing provider; no path or method is a model argument. */
export function jiraProjectStructureDeclarationForTool(
  name: string,
): ManagedMcpToolDeclaration | undefined {
  const definitions: Readonly<Record<string, Definition>> = {
    ...JIRA_PROJECT_STRUCTURE_READ_DEFINITIONS,
    ...JIRA_PROJECT_STRUCTURE_WRITE_DEFINITIONS,
  };
  const selected = Object.hasOwn(definitions, name) ? definitions[name] : undefined;
  return selected === undefined ? undefined : declaration(name, selected);
}
