import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type { AtlassianWriteHttpOutcome } from "./atlassian-write-http.js";
import type { JiraMutationBody, JiraMutationRequest } from "./jira-managed-mutation-metadata.js";
import type { JiraIssueTemplateSource } from "./jira-managed-template-gate.js";
import { dispatchFailure, JiraAcknowledgedMutationError } from "./jira-mutation-failure.js";
import { jiraNativeId, jiraNativeNumericId } from "./jira-native-values.js";
import { readSavedActor } from "./jira-saved-configuration-values.js";
import {
  parseSchemaMutation,
  type FieldInput,
  type IssueTypeInput,
  type LinkTypeInput,
  type SchemaInput,
  type TerminologyInput,
} from "./jira-schema-mutation-input.js";
import {
  admitSchemaMutation,
  readSchemaCreationIds,
  readSchemaFields,
  readSchemaLink,
  readSchemaLinks,
  readSchemaTerminology,
  readSchemaType,
  sameTerminology,
} from "./jira-schema-mutation-observations.js";
import {
  SCHEMA_MALFORMED,
  sameSchemaValue,
  schemaRefusal,
  schemaUnchanged,
  schemaUnconfirmed,
  type JiraSchemaMutation,
  type JiraSchemaMutationReceipt,
  type SchemaAttempt,
  type TerminologySnapshot,
} from "./jira-schema-mutation-values.js";
export {
  JIRA_SCHEMA_MUTATIONS,
  isJiraSchemaMutation,
  type JiraSchemaMutation,
} from "./jira-schema-mutation-values.js";

interface Effect {
  readonly path: string;
  readonly method: "POST" | "PUT" | "DELETE";
  readonly body?: JiraMutationBody;
  readonly expect: "json" | "none";
}
function typeEffect(input: IssueTypeInput): Effect {
  if (input.kind === "create")
    return {
      path: "issuetype",
      method: "POST",
      body: { name: input.name, description: input.description, type: input.type },
      expect: "json",
    };
  if (input.kind === "update")
    return {
      path: `issuetype/${input.expected.id}`,
      method: "PUT",
      body: { ...input.target },
      expect: "none",
    };
  const query =
    input.alternative === null
      ? ""
      : `?${new URLSearchParams({ alternativeIssueTypeId: input.alternative.id })}`;
  return { path: `issuetype/${input.expected.id}${query}`, method: "DELETE", expect: "none" };
}
function linkEffect(input: LinkTypeInput): Effect {
  if (input.kind === "create")
    return { path: "issueLinkType", method: "POST", body: { ...input.target }, expect: "json" };
  if (input.kind === "order")
    return {
      path: "issueLinkType/order",
      method: "PUT",
      body: { direction: input.direction },
      expect: "none",
    };
  if (input.kind === "move")
    return {
      path: `issueLinkType/${input.id}/order`,
      method: "PUT",
      body: { newPosition: input.newPosition },
      expect: "none",
    };
  return input.kind === "delete"
    ? { path: `issueLinkType/${input.expected.id}`, method: "DELETE", expect: "none" }
    : {
        path: `issueLinkType/${input.expected.id}`,
        method: "PUT",
        body: { ...input.target },
        expect: "none",
      };
}
function fieldEffect(input: FieldInput): Effect {
  if (input.kind === "create")
    return {
      path: "field",
      method: "POST",
      expect: "json",
      body: {
        name: input.name,
        description: input.description,
        type: input.type,
        searcherKey: input.searcherKey,
        projectIds: input.projectIds.map(Number),
        issueTypeIds: [...input.issueTypeIds],
      },
    };
  const query = new URLSearchParams();
  for (const field of input.expectedFields) query.append("ids", field.id);
  return { path: `customFields?${query}`, method: "DELETE", expect: "none" };
}
function effect(input: SchemaInput): Effect {
  if (input.family === "issue-type") return typeEffect(input);
  if (input.family === "link-type") return linkEffect(input);
  if (input.family === "field") return fieldEffect(input);
  return {
    path: "terminology/entries",
    method: "POST",
    body: input.entries.map((entry) => ({ ...entry })),
    expect: "none",
  };
}
function typeReceipt(input: IssueTypeInput, id?: string): JiraSchemaMutationReceipt {
  return {
    userKey: input.actor,
    ...(id === undefined ? {} : { issueTypeId: id }),
    issueTypePresent: input.kind !== "delete",
    ...(input.kind === "delete" && input.alternative !== null
      ? { replacementIssueTypeId: input.alternative.id }
      : {}),
  };
}
function linkReceipt(input: LinkTypeInput, id?: string): JiraSchemaMutationReceipt {
  if (input.kind === "order" || input.kind === "move")
    return {
      userKey: input.actor,
      linkTypeIds: Object.freeze(input.expectedTypes.map((item) => item.id)),
      ...(input.kind === "move" ? { linkTypeId: input.id } : {}),
    };
  return {
    userKey: input.actor,
    ...(id === undefined ? {} : { linkTypeId: id }),
    linkTypePresent: input.kind !== "delete",
  };
}
function receipt(input: SchemaInput, id?: string): JiraSchemaMutationReceipt {
  if (input.family === "issue-type") return typeReceipt(input, id ?? knownTypeId(input));
  if (input.family === "link-type") return linkReceipt(input, id ?? knownLinkId(input));
  if (input.family === "terminology")
    return {
      userKey: input.actor,
      terminologyNames: Object.freeze(input.entries.map((entry) => entry.originalName)),
    };
  return fieldReceipt(input, id);
}
function knownTypeId(input: IssueTypeInput): string | undefined {
  return input.kind === "create" ? undefined : input.expected.id;
}
function knownLinkId(input: LinkTypeInput): string | undefined {
  return input.kind === "delete" || input.kind === "update" ? input.expected.id : undefined;
}
function fieldReceipt(input: FieldInput, id?: string): JiraSchemaMutationReceipt {
  return input.kind === "delete"
    ? {
        userKey: input.actor,
        fieldIds: Object.freeze(input.expectedFields.map((field) => field.id)),
        fieldPresent: false,
      }
    : { userKey: input.actor, ...(id === undefined ? {} : { fieldId: id }), fieldPresent: true };
}
function unchanged(input: SchemaInput): boolean {
  if (input.family === "issue-type" && input.kind === "update")
    return sameSchemaValue({ ...input.expected, ...input.target }, input.expected);
  if (input.family === "link-type" && input.kind === "update")
    return sameSchemaValue({ ...input.target, id: input.expected.id }, input.expected);
  if (input.family === "terminology")
    return input.entries.every((target) =>
      input.expectedEntries.some(
        (current) =>
          current.originalName.toLowerCase() === target.originalName &&
          current.newName === target.newName &&
          current.newNamePlural === target.newNamePlural,
      ),
    );
  // A list's presentation order does not prove the manager's persisted native ordering.
  return false;
}
function creation(input: SchemaInput): boolean {
  return input.family !== "terminology" && input.kind === "create";
}
function createdId(
  input: SchemaInput,
  response: Extract<AtlassianWriteHttpOutcome, { ok: true }>,
): string | undefined {
  if (input.family !== "field") return jiraNativeNumericId(response.body?.id);
  const id = response.body?.id;
  return typeof id === "string" && id.startsWith("customfield_") && jiraNativeId(id.slice(12))
    ? id
    : undefined;
}
async function confirmType(
  request: JiraMutationRequest,
  input: IssueTypeInput,
  known: JiraSchemaMutationReceipt,
): Promise<SchemaAttempt> {
  if (known.issueTypeId === undefined) return schemaUnconfirmed(known);
  const current = await readSchemaType(request, known.issueTypeId);
  if (!current.ok) return { ...current, receipt: known };
  if (input.kind !== "update") return schemaUnconfirmed(known);
  return sameSchemaValue(current.value, { ...input.expected, ...input.target })
    ? { ok: true, receipt: known }
    : schemaUnconfirmed(known);
}
async function confirmLink(
  request: JiraMutationRequest,
  input: LinkTypeInput,
  known: JiraSchemaMutationReceipt,
): Promise<SchemaAttempt> {
  if (input.kind === "order" || input.kind === "move") {
    const current = await readSchemaLinks(request);
    return current.ok ? schemaUnconfirmed(known) : { ...current, receipt: known };
  }
  if (known.linkTypeId === undefined) return schemaUnconfirmed(known);
  const current = await readSchemaLink(request, known.linkTypeId);
  if (!current.ok) return { ...current, receipt: known };
  if (input.kind === "delete") return schemaUnconfirmed(known);
  return sameSchemaValue(current.value, { ...input.target, id: known.linkTypeId })
    ? { ok: true, receipt: known }
    : schemaUnconfirmed(known);
}
async function confirmFields(
  request: JiraMutationRequest,
  known: JiraSchemaMutationReceipt,
): Promise<SchemaAttempt> {
  const current = await readSchemaFields(request);
  // Native bulk deletion permits partial success; neither list omission nor an ACK establishes
  // all value, screen, plugin and index consequences. No deleted/unchanged counts are invented.
  return current.ok ? schemaUnconfirmed(known) : { ...current, receipt: known };
}
function desiredTerminology(input: TerminologyInput): readonly TerminologySnapshot[] {
  return input.expectedEntries.map((prior) => {
    const target = input.entries.find(
      (entry) => entry.originalName === prior.originalName.toLowerCase(),
    );
    return target === undefined
      ? prior
      : {
          ...prior,
          newName: target.newName,
          newNamePlural: target.newNamePlural,
          isDefault:
            target.newName === target.originalName &&
            target.newNamePlural === prior.originalNamePlural.toLowerCase(),
        };
  });
}
async function confirmTerminology(
  request: JiraMutationRequest,
  input: TerminologyInput,
  known: JiraSchemaMutationReceipt,
): Promise<SchemaAttempt> {
  const current = await readSchemaTerminology(request);
  if (!current.ok) return { ...current, receipt: known };
  return sameTerminology(current.value, desiredTerminology(input))
    ? { ok: true, receipt: known }
    : schemaUnconfirmed(known);
}
async function confirm(
  request: JiraMutationRequest,
  input: SchemaInput,
  known: JiraSchemaMutationReceipt,
): Promise<SchemaAttempt> {
  try {
    const actor = await readSavedActor(request, input.actor);
    if (!actor.ok) return { ...actor, receipt: known };
    if (input.family === "issue-type") return await confirmType(request, input, known);
    if (input.family === "link-type") return await confirmLink(request, input, known);
    if (input.family === "field") return await confirmFields(request, known);
    return await confirmTerminology(request, input, known);
  } catch (error) {
    throw new JiraAcknowledgedMutationError(error, known);
  }
}
function readableAcknowledgement(response: AtlassianWriteHttpOutcome): boolean {
  const status = response.ok ? response.status : response.httpStatus;
  return status !== undefined && status >= 200 && status < 300;
}
async function write(
  request: JiraMutationRequest,
  input: SchemaInput,
  known: JiraSchemaMutationReceipt,
  priorIds: readonly string[],
): Promise<SchemaAttempt> {
  const target = effect(input);
  const response = await request(target.path, target.method, target.body, target.expect);
  if (!readableAcknowledgement(response))
    return response.ok
      ? { ...SCHEMA_MALFORMED, receipt: known }
      : { ...dispatchFailure(response), receipt: known };
  if (!creation(input)) return confirm(request, input, known);
  const id = response.ok ? createdId(input, response) : undefined;
  if (id === undefined) return schemaUnconfirmed(known);
  const identified = Object.freeze(receipt(input, id));
  return priorIds.includes(id)
    ? schemaUnconfirmed(identified)
    : confirm(request, input, identified);
}
/** Fixed native schema endpoints only. Native permissions remain independent of local admin
 * authority; preflight review never claims atomic compare-and-swap or complete issue visibility. */
export async function executeJiraSchemaMutation(
  operation: JiraSchemaMutation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check = false,
  templates?: JiraIssueTemplateSource,
): Promise<SchemaAttempt> {
  const input = parseSchemaMutation(operation, args);
  if (input === undefined)
    return schemaRefusal(
      "Supply the exact actor and reviewed native schema snapshots. Custom fields use 1–50 explicit safe numeric project IDs and exact issue-type IDs; deletion admits 1–50 custom fields only. Link positions are 1-based in the reviewed bounded collection. Terminology uses canonical lowercase alphanumeric names and spaces. Missing facts are not null, false or an empty collection.",
    );
  const known = Object.freeze(receipt(input));
  if (new TextEncoder().encode(JSON.stringify(known)).byteLength > 16384)
    return { ok: false, reason: "bounds-exceeded" };
  const refused = await admitSchemaMutation(request, input, templates);
  if (refused !== undefined) return refused;
  const prior = await readSchemaCreationIds(request, input);
  if (!prior.ok) return prior;
  if (unchanged(input)) return schemaUnchanged(known);
  if (check) return { ok: true, receipt: {} };
  const actor = await readSavedActor(request, input.actor);
  return actor.ok ? write(request, input, known, prior.value) : actor;
}
