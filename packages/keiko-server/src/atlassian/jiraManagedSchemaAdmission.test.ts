import { expect, it, vi } from "vitest";
import {
  JIRA_MANAGED_READ_TOOLS,
  JIRA_MUTATION_OPERATIONS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { createManagedMcpHost } from "@oscharko-dev/keiko-mcp";
import type {
  CatalogDigest,
  CatalogJsonObject,
  ToolDescriptor,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  catalogJsonBytes,
  compileExternalCatalogSchema,
  createToolDescriptor,
  validateToolArguments,
  validateToolResultEnvelope,
} from "@oscharko-dev/keiko-tool-catalog";
import { createJiraProviderForCatalog } from "./jiraManagedProvider.js";
import { jiraMutationDeclarations } from "./jiraManagedMutationDescriptors.js";
import {
  createJiraOperationContract,
  matchesJiraOperationBinding,
} from "./jiraOperationRegistry.js";

// Admit each real declaration separately: a large inventory must not hide a malformed descriptor
// behind the host's aggregate tool-count limit, and metadata admission must never execute Jira.
it.each([...JIRA_MANAGED_READ_TOOLS, ...JIRA_MUTATION_OPERATIONS])(
  "admits the current %s descriptor through the actual managed MCP schema guard",
  async (name) => {
    const connection = vi.fn((): never => {
      throw new TypeError("Schema admission must not resolve a Jira connection");
    });
    const mutation = vi.fn((): never => {
      throw new TypeError("Schema admission must not execute a Jira mutation");
    });
    const provider = createJiraProviderForCatalog(connection, [name], mutation);
    const host = createManagedMcpHost({
      providers: [provider],
      log: { write: () => undefined },
    });
    try {
      await host.admit("jira-schema-admission");
      expect(host.catalog().map((tool) => tool.name)).toEqual([name]);
      expect(connection).not.toHaveBeenCalled();
      expect(mutation).not.toHaveBeenCalled();
    } finally {
      await host.close();
    }
  },
);

const COMMENT = jiraMutationDeclarations().find((entry) => entry.name === "jira.comment");
if (COMMENT === undefined) throw new TypeError("Missing comment declaration");
const COMMENT_DECLARATION = COMMENT;
const BRANCHES = [
  {
    type: "object",
    properties: { left: { type: "string", minLength: 1 } },
    required: ["left"],
    additionalProperties: false,
  },
  {
    type: "object",
    properties: { right: { type: "integer", minimum: 1 } },
    required: ["right"],
    additionalProperties: false,
  },
] as const satisfies readonly CatalogJsonObject[];
const PROJECTION = "c".repeat(64) as CatalogDigest;

function resultEnvelope(descriptor: ToolDescriptor, data: CatalogJsonObject): unknown {
  return {
    schemaVersion: 1,
    invocationId: "jira-schema-result",
    toolRef: descriptor.toolRef,
    projectionDigest: PROJECTION,
    effectStarted: true,
    status: "completed",
    reason: "none",
    data,
    page: { truncated: false, reason: "none", cursor: null },
    metrics: {
      inputBytes: 2,
      outputBytes: catalogJsonBytes(data),
      resultCount: 1,
      durationMs: 1,
    },
  };
}

it.each(["anyOf", "oneOf"] as const)(
  "preserves closed %s branches, binding requirements and stale-contract rejection",
  (keyword) => {
    const schema = compileExternalCatalogSchema({ [keyword]: BRANCHES });
    const { descriptorDigest: _digest, ...original } = COMMENT_DECLARATION.descriptor;
    const declaration = {
      ...COMMENT_DECLARATION,
      descriptor: createToolDescriptor({ ...original, inputSchema: schema, resultSchema: schema }),
    };
    const contract = createJiraOperationContract(declaration);
    const descriptor = contract.declaration.descriptor;
    expect(descriptor.inputSchema).toEqual({ ...schema, type: "object" });
    expect(descriptor.resultSchema.type).toBe("object");
    const validValues: readonly CatalogJsonObject[] = [{ left: "value" }, { right: 1 }];
    for (const valid of validValues) {
      expect(() => validateToolArguments(valid, descriptor)).not.toThrow();
      expect(() =>
        validateToolResultEnvelope(
          resultEnvelope(descriptor, { ...valid, operationBinding: contract.binding }),
          { descriptor, projectionDigest: PROJECTION },
        ),
      ).not.toThrow();
    }
    const invalidValues: readonly CatalogJsonObject[] = [
      {},
      { left: "" },
      { left: "value", right: 1 },
      { right: 0 },
    ];
    for (const invalid of invalidValues) {
      expect(() => validateToolArguments(invalid, descriptor)).toThrow();
      expect(() =>
        validateToolResultEnvelope(
          resultEnvelope(descriptor, { ...invalid, operationBinding: contract.binding }),
          { descriptor, projectionDigest: PROJECTION },
        ),
      ).toThrow();
    }
    expect(() =>
      validateToolResultEnvelope(resultEnvelope(descriptor, { left: "value" }), {
        descriptor,
        projectionDigest: PROJECTION,
      }),
    ).toThrow();
    const changed = createJiraOperationContract({
      ...declaration,
      descriptor: createToolDescriptor({
        ...original,
        inputSchema: compileExternalCatalogSchema({ [keyword]: [BRANCHES[0]] }),
        resultSchema: schema,
      }),
    });
    expect(matchesJiraOperationBinding(changed, contract.binding)).toBe(false);
  },
);

it.each(["string", "null", "array", null] as const)(
  "refuses an explicit non-object root type %s instead of normalizing it away",
  (type) => {
    for (const field of ["inputSchema", "resultSchema"] as const)
      expect(() =>
        createJiraOperationContract({
          ...COMMENT_DECLARATION,
          descriptor: {
            ...COMMENT_DECLARATION.descriptor,
            [field]: { type, anyOf: BRANCHES },
          },
        }),
      ).toThrow("invalid-schema");
  },
);

// Live limit run 2026-11-08: a model sent `projectTemplateKey: ""`; native Jira answered 500
// ("Invalid module key specified") and left the effect uncertain. Empty identifiers are refused
// before dispatch so the model receives a correctable validation error instead.
it.each([
  ["jira.create-project", "key"],
  ["jira.create-project", "name"],
  ["jira.create-project", "lead"],
  ["jira.create-project", "projectTypeKey"],
  ["jira.create-project", "projectTemplateKey"],
  ["jira.update-project", "projectIdOrKey"],
  ["jira.update-project", "name"],
  ["jira.update-project", "lead"],
])("refuses an empty %s %s identifier before any Jira dispatch", (name, field) => {
  const declaration = jiraMutationDeclarations().find((entry) => entry.name === name);
  if (declaration === undefined) throw new TypeError(`Missing ${name} declaration`);
  const descriptor = createJiraOperationContract(declaration).declaration.descriptor;
  const valid: CatalogJsonObject =
    name === "jira.create-project"
      ? { key: "LIM1", name: "Limit", lead: "keiko-admin", projectTypeKey: "software" }
      : { projectIdOrKey: "LIM1", name: "Limit" };
  expect(() => validateToolArguments(valid, descriptor)).not.toThrow();
  expect(() => validateToolArguments({ ...valid, [field]: "" }, descriptor)).toThrow();
});
