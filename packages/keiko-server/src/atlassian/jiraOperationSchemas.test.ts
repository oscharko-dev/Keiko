import { describe, expect, it } from "vitest";
import {
  JIRA_MANAGED_READ_TOOLS,
  JIRA_MUTATION_OPERATIONS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security/hashing";
import {
  compileExternalCatalogSchema,
  createToolDescriptor,
  createToolRef,
  describeCatalogSchemaMismatch,
  ToolCatalogError,
  verifyToolDescriptor,
} from "@oscharko-dev/keiko-tool-catalog";
import { jiraOperationContracts, jiraOperationForTool } from "./jiraManagedProvider.js";
import { createJiraOperationContract, jiraOperationDefinitions } from "./jiraOperationRegistry.js";
import { JIRA_JOB_OBSERVATION_READ_DEFINITIONS } from "./jiraJobObservationDescriptors.js";
import { jiraNativeDeclaration } from "./jiraProjectStructureDescriptors.js";
import { object, text } from "./jiraManagedSchemas.js";

function selected(name: string) {
  const entry = jiraOperationForTool(name);
  if (entry === undefined) throw new TypeError("Missing canonical Jira declaration");
  return entry;
}
function schemaObject(value: CatalogJsonValue | undefined): CatalogJsonObject {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Missing authored object schema");
  return value;
}
function inputField(name: string, field: string): CatalogJsonObject {
  return compileExternalCatalogSchema(schemaObject(schemaObject(selected(name).declaration.descriptor.inputSchema.properties)[field]));
}
function resultField(name: string, field: string): CatalogJsonObject {
  return compileExternalCatalogSchema(schemaObject(schemaObject(selected(name).declaration.descriptor.resultSchema.properties)[field]));
}

describe("the complete Jira catalog remains independently compilable", () => {
  // Each canonical tool gets its own case: one invalid schema cannot hide the rest of the audit.
  it.each([...JIRA_MANAGED_READ_TOOLS, ...JIRA_MUTATION_OPERATIONS])("compiles and binds %s", (name) => {
    const entry = selected(name);
    expect(entry.definition.tool).toBe(name);
    expect(verifyToolDescriptor(entry.declaration.descriptor)).toBe(entry.declaration.descriptor);
    expect(entry.declaration.descriptor.policyReferences).toContain(`jira-operation-contract.${entry.binding.contractDigest}`);
    expect(jiraOperationForTool(name)).toBe(entry);
  });

  it("keeps metadata-only discovery complete and immutable, and explicit enumeration exhaustive", () => {
    const definitions = jiraOperationDefinitions();
    const complete = jiraOperationContracts();
    expect(new Set(definitions.map((entry) => entry.tool))).toEqual(new Set([...JIRA_MANAGED_READ_TOOLS, ...JIRA_MUTATION_OPERATIONS]));
    expect(definitions).toHaveLength(complete.length);
    expect(complete.map((entry) => entry.definition.tool)).toEqual([...JIRA_MANAGED_READ_TOOLS, ...JIRA_MUTATION_OPERATIONS]);
    for (const entry of complete) expect(definitions.find((definition) => definition.tool === entry.definition.tool)).toEqual(entry.definition);
    expect(jiraOperationDefinitions()).toBe(definitions);
    expect(Reflect.set(definitions, "0", {})).toBe(false);
    const first = definitions[0];
    if (first === undefined) throw new TypeError("Missing operation inventory");
    expect(Reflect.set(first, "identity", "GET /unexpected")).toBe(false);
  });
});

const UNION_RESULTS: readonly { readonly name: string; readonly value: CatalogJsonObject }[] = [
  { name: "jira.email-template-pack", value: { outcome: "succeeded", selectionScope: "complete-exported-email-template-pack", archiveBytes: 1, archiveSha256: "a".repeat(64), manifestSha256: "b".repeat(64), entryCount: 0, items: [] } },
  { name: "jira.application-properties", value: { outcome: "succeeded", settingsScope: "application-properties", key: "jira.clone.prefix", valueState: "observed", valueType: "string", stringValue: "" } },
  { name: "jira.application-properties", value: { outcome: "succeeded", settingsScope: "application-properties", items: [], startAt: 0, total: 0 } },
  { name: "jira.advanced-settings", value: { outcome: "succeeded", settingsScope: "advanced-settings", items: [{ key: "jira.option.voting", valueState: "observed", valueType: "boolean", booleanValue: false }], startAt: 0, total: 1 } },
  { name: "jira.my-preference", value: { outcome: "succeeded", settingsScope: "current-user-preference", key: "user.issues.per.page", valueState: "observed", valueType: "integer", integerValue: 0 } },
  { name: "jira.reindex-status", value: { outcome: "succeeded", taskSelection: "active-or-latest", taskState: "no-prior-task" } },
];
describe("operation bindings preserve closed result alternatives", () => {
  it.each(UNION_RESULTS)("retains $name branch semantics and requires a binding", ({ name, value }) => {
    const entry = selected(name);
    const schema = entry.declaration.descriptor.resultSchema;
    const result = { ...value, operationBinding: entry.binding };
    expect(describeCatalogSchemaMismatch(schema, result)).toBeUndefined();
    expect(describeCatalogSchemaMismatch(schema, value)).toBeDefined();
    expect(describeCatalogSchemaMismatch(schema, { ...result, foreignField: true })).toBeDefined();
    expect(describeCatalogSchemaMismatch(schema, { ...result, operationBinding: { identity: entry.binding.identity } })).toBeDefined();
    expect(describeCatalogSchemaMismatch(schema, { outcome: "failed", operationBinding: entry.binding })).toBeUndefined();
  });

  it.each([
    { name: "jira.email-template-pack", value: { outcome: "succeeded", archiveBytes: 1 } },
    { name: "jira.my-preference", value: { outcome: "succeeded", settingsScope: "current-user-preference", key: "jira.home", valueState: "withheld", stringValue: "must remain withheld" } },
    { name: "jira.application-properties", value: { outcome: "succeeded", settingsScope: "application-properties", key: "jira.option.voting", valueState: "observed", valueType: "boolean", booleanValue: false, stringValue: "false" } },
    { name: "jira.advanced-settings", value: { outcome: "succeeded", settingsScope: "advanced-settings", key: "jira.clone.prefix", valueState: "unknown", valueType: "string" } },
    { name: "jira.reindex-status", value: { outcome: "succeeded", taskSelection: "active-or-latest", taskState: "no-prior-task", currentProgress: 0 } },
  ] as const)("does not weaken $name alternatives", ({ name, value }) => {
    const entry = selected(name);
    expect(describeCatalogSchemaMismatch(entry.declaration.descriptor.resultSchema, { ...value, operationBinding: entry.binding })).toBeDefined();
  });

  it.each(["anyOf", "oneOf"] as const)("binds every closed %s branch without accepting scalar alternatives", (keyword) => {
    const definition = JIRA_JOB_OBSERVATION_READ_DEFINITIONS["jira.reindex-progress"];
    const declaration = jiraNativeDeclaration("jira.reindex-progress", { ...definition, result: {
      [keyword]: [object({ state: { type: "string", enum: ["first"] } }, ["state"]), object({ state: { type: "string", enum: ["second"] }, count: { type: "integer" } }, ["state", "count"])],
    } });
    const entry = createJiraOperationContract(declaration);
    const values: readonly CatalogJsonObject[] = [{ state: "first" }, { state: "second", count: 0 }];
    for (const value of values) {
      expect(describeCatalogSchemaMismatch(entry.declaration.descriptor.resultSchema, { ...value, operationBinding: entry.binding })).toBeUndefined();
      expect(describeCatalogSchemaMismatch(entry.declaration.descriptor.resultSchema, value)).toBeDefined();
    }
    const invalid = jiraNativeDeclaration("jira.reindex-progress", { ...definition, result: { [keyword]: [object({}), text(32)] } });
    expect(() => createJiraOperationContract(invalid)).toThrow(ToolCatalogError);
  });

  it("preserves the previous object binding and digest calculation exactly", () => {
    const raw = jiraNativeDeclaration("jira.reindex-progress", JIRA_JOB_OBSERVATION_READ_DEFINITIONS["jira.reindex-progress"]);
    const { descriptorDigest: _digest, ...original } = raw.descriptor;
    const required = original.resultSchema.required;
    if (!Array.isArray(required)) throw new TypeError("Missing authored requirements");
    const projection = createToolDescriptor({
      ...original,
      toolRef: createToolRef(original.toolRef.canonicalId, original.toolRef.contractVersion + 1),
      resultSchema: { ...original.resultSchema, properties: { ...schemaObject(original.resultSchema.properties), operationBinding: object({ identity: text(192), contractDigest: { type: "string", maxLength: 64, pattern: "^[a-f0-9]{64}$" } }, ["identity", "contractDigest"]) }, required: [...required, "operationBinding"] },
      bounds: { ...original.bounds, maxResultBytes: Math.min(TOOL_CATALOG_LIMITS.maxResultBytes, original.bounds.maxResultBytes + 384) },
    });
    const entry = createJiraOperationContract(raw);
    expect(entry.binding.contractDigest).toBe(sha256Hex(canonicalise({ domain: "keiko.jira-operation-contract.v1", definition: entry.definition, members: [], descriptorDigest: projection.descriptorDigest })));
  });
});

describe("new review facts use the existing external schema dialect", () => {
  it.each([
    { name: "jira.filter", value: { outcome: "succeeded", items: [{ id: "42", name: "Reviewed", jql: "project = TEST", description: null, shareScope: "unknown" }] } },
    { name: "jira.favourite-filters", value: { outcome: "succeeded", items: [{ id: "42", name: "Reviewed", jql: "project = TEST", description: "", shareScope: "private" }], startAt: 0, total: 1 } },
    { name: "jira.sprint", value: { outcome: "succeeded", items: [{ id: "7", name: "Reviewed", state: "future", reviewSnapshot: { id: "7", originBoardId: "1", name: "Reviewed", state: "future", goal: null, synced: false } }] } },
    { name: "jira.project", value: { outcome: "succeeded", reviewSnapshot: { id: "9223372036854775807", key: "TEST", name: "Reviewed", archived: false } } },
  ] as const)("retains nullable and exact $name metadata after binding", ({ name, value }) => {
    const entry = selected(name);
    expect(describeCatalogSchemaMismatch(entry.declaration.descriptor.resultSchema, { ...value, operationBinding: entry.binding })).toBeUndefined();
  });
});

describe("authored linear constraints preserve the native grammar", () => {
  it.each(["1", "9223372036854775807"])("retains exact maintenance IDs %s", (value) => {
    expect(describeCatalogSchemaMismatch(resultField("jira.process-reindex-requests", "reindexRequestIds"), [value])).toBeUndefined();
  });
  it.each(["0", "01", "-1", "1.0", "１", "1e2", "12345678901234567890"])("refuses noncanonical maintenance ID %s", (value) => {
    expect(describeCatalogSchemaMismatch(resultField("jira.process-reindex-requests", "reindexRequestIds"), [value])).toBeDefined();
  });
  it.each(["a:b", "com.vendor.module:custom-field", "A_1.-:B_2.-"])("retains bounded module key %s", (value) => {
    expect(describeCatalogSchemaMismatch(inputField("jira.create-custom-field", "type"), value)).toBeUndefined();
  });
  it.each(["a", ":b", "a:", "a:b:c", "a/b:c", "a b:c", "a:\nb", "a:ü"])("refuses malformed module key %s", (value) => {
    expect(describeCatalogSchemaMismatch(inputField("jira.create-custom-field", "type"), value)).toBeDefined();
  });
  it("retains only canonical custom-field IDs in uncertain creation receipts", () => {
    const schema = resultField("jira.create-custom-field", "fieldId");
    for (const id of ["customfield_1", "customfield_9223372036854775807"])
      expect(describeCatalogSchemaMismatch(schema, id)).toBeUndefined();
    for (const id of ["customfield_0", "customfield_01", "customfield_-1", "customfield_12345678901234567890", "customfield_１"])
      expect(describeCatalogSchemaMismatch(schema, id)).toBeDefined();
  });
  it("preserves the exact configured application-ID grammar without URL or URN forms", () => {
    const application = inputField("jira.create-reciprocal-remote-link", "expectedApplication");
    const schema = compileExternalCatalogSchema(schemaObject(schemaObject(application.properties).id));
    for (const id of ["12345678-1234-1234-1234-123456789abc", "ABCDEF01-ABCD-ABCD-ABCD-ABCDEF012345"])
      expect(describeCatalogSchemaMismatch(schema, id)).toBeUndefined();
    for (const id of ["urn:uuid:12345678-1234-1234-1234-123456789abc", "12345678123412341234123456789abc", "12345678-1234-1234-1234-123456789abz", "12345678-1234-1234-1234-123456789ab-"])
      expect(describeCatalogSchemaMismatch(schema, id)).toBeDefined();
  });
  it("keeps terminology bounded lowercase native text without punctuation or controls", () => {
    const entries = inputField("jira.set-terminology", "entries");
    const row = schemaObject(entries.items);
    const schema = compileExternalCatalogSchema(schemaObject(schemaObject(row.properties).newName));
    for (const value of ["feature", "planning cycle 2"])
      expect(describeCatalogSchemaMismatch(schema, value)).toBeUndefined();
    for (const value of ["", "Feature", "feature-cycle", "feature\ncycle", "ä", "a".repeat(101)])
      expect(describeCatalogSchemaMismatch(schema, value)).toBeDefined();
  });
});
