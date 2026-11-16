// A provider refuses a function whose parameters are not a plain object schema at the top level:
// "Invalid schema for function 'jira_set_issue_property': schema must have type 'object' and not have
// 'oneOf'/'anyOf'/'allOf'/'enum'/'const'/'not' at the top level." (HTTP 400 on the Azure lane; the
// captured body names the TOP LEVEL). That used to be found only by a live run. This walk projects
// every tool definition Keiko can advertise the way the gateway projects it for the wire and fails
// on any construct outside the documented provider-neutral subset:
//
//   - the root is `type: "object"`;
//   - the root carries none of oneOf, anyOf, allOf, enum, const, not.
//
// NESTED constructs (alternatives and negations below the root) are deliberately NOT judged, and that
// is a stated position, not an oversight. Evidence: the captured 400 and the provider's own rule name
// the TOP LEVEL only ("... at the top level"), Keiko sends no `strict: true` function schema, and many
// registered tools carry nested alternatives on the wire today (inventory test below). What is NOT proven: a captured run showing every provider accepts them. The Azure
// functional pass carries a full Jira catalog turn (jira.set-issue-property plus every operation that
// has nested alternatives) and is the evidence; if any provider names a nested construct, the
// projection must fold that level and this walk must judge it.
//
// The projection (provider-tool-schema.ts) folds ROOT constructs only. It emits a nested `anyOf` in
// exactly one case, the merge of differing property definitions across root alternatives.
//
// Not covered here, because their schemas are not known until runtime: managed MCP external tools
// and the tools the OpenCode runtime brings itself. Both still pass the gateway's single wire choke
// point (`openAiCompatiblePromptTools`), so their ROOT constructs are projected; their nested
// constructs go through unchanged. Keiko's own validation always uses the original schema; the
// projection only decides what the provider is shown (strictness pins in toolCatalogBridge.test).
import { describe, expect, it } from "vitest";
import { openAiCompatiblePromptTools } from "@oscharko-dev/keiko-model-gateway/internal/prompt-token-accounting";
import {
  JIRA_MANAGED_READ_TOOLS,
  JIRA_MUTATION_OPERATIONS,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { OPENCODE_NATIVE_EXTENSION_DEFINITIONS } from "@oscharko-dev/keiko-tool-catalog";
import type { ToolDefinition } from "@oscharko-dev/keiko-contracts";
import { createJiraCatalogDiscoveryProvider } from "./atlassian/jiraCatalogDiscovery.js";
import { jiraOperationContracts } from "./atlassian/jiraManagedProvider.js";
import { OPENCODE_MODEL_VISIBLE_TOOLS } from "./coding-runtime/opencodeToolSchemas.js";
import { buildUiHandlerDeps } from "./deps.js";
import { createKnowledgeRequirementsProvider } from "./requirementsTool.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT_KEYWORDS = ["oneOf", "anyOf", "allOf", "enum", "const", "not"] as const;

interface Advertised {
  readonly source: string;
  readonly definition: ToolDefinition;
}

function jiraOperations(): readonly Advertised[] {
  return jiraOperationContracts().map((contract) => ({
    source: "jira-operation",
    definition: {
      name: contract.declaration.name,
      description: contract.declaration.descriptor.description,
      parameters: contract.declaration.descriptor.inputSchema,
    },
  }));
}

function declared(
  source: string,
  tools: readonly {
    readonly name: string;
    readonly descriptor: { readonly description: string; readonly inputSchema: unknown };
  }[],
): readonly Advertised[] {
  return tools.map((tool) => ({
    source,
    definition: {
      name: tool.name,
      description: tool.descriptor.description,
      parameters: tool.descriptor.inputSchema as Record<string, unknown>,
    },
  }));
}

function chatBaseTools(): readonly Advertised[] {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "keiko-tool-schemas-"));
  const deps = buildUiHandlerDeps({
    configPath: undefined,
    evidenceDir: join(root, "evidence"),
    uiDbPath: join(root, "ui.db"),
    env: { KEIKO_MEMORY_DIR: join(root, "memory") },
  });
  try {
    return [
      ...declared("jira-discovery", createJiraCatalogDiscoveryProvider().tools()),
      ...declared("knowledge", createKnowledgeRequirementsProvider(deps).tools()),
    ];
  } finally {
    void deps.dispose?.();
    rmSync(root, { recursive: true, force: true });
  }
}

function codingTools(): readonly Advertised[] {
  return [
    ...OPENCODE_MODEL_VISIBLE_TOOLS.map(({ name, parameters }): Advertised => ({
      source: "coding",
      definition: {
        name,
        description: `Keiko coding tool ${name}.`,
        parameters,
      },
    })),
    ...OPENCODE_NATIVE_EXTENSION_DEFINITIONS.map((extension): Advertised => ({
      source: "coding-native-extension",
      definition: {
        name: extension.alias,
        description: extension.description,
        parameters: extension.inputSchema,
      },
    })),
  ];
}

const NESTED_ALTERNATIVE_KEYWORDS: ReadonlySet<string> = new Set([
  "oneOf",
  "anyOf",
  "allOf",
  "not",
]);

/** Every path below the root that carries an alternative or negation keyword. */
function nestedAlternatives(node: unknown, path: string): readonly string[] {
  if (Array.isArray(node))
    return node.flatMap((entry, index) => nestedAlternatives(entry, `${path}[${String(index)}]`));
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) => {
    const here = path === "" ? key : `${path}.${key}`;
    // At the root, `properties` and the other structural keys are walked; the root keywords are
    // judged by `rootViolations`, never double-counted here.
    const own = path !== "" && NESTED_ALTERNATIVE_KEYWORDS.has(key) ? [here] : [];
    return [...own, ...nestedAlternatives(value, here)];
  });
}

/** The rule itself: what a provider refuses at the top level of a function's parameters. */
function rootViolations(parameters: Record<string, unknown>): readonly string[] {
  return [
    ...(parameters.type === "object" ? [] : ["type"]),
    ...ROOT_KEYWORDS.filter((key) => parameters[key] !== undefined),
  ];
}

function violations(advertised: readonly Advertised[]): readonly string[] {
  const wire = openAiCompatiblePromptTools(advertised.map((entry) => entry.definition));
  return wire.flatMap((tool, index) => {
    const parameters = (tool.function as { parameters: Record<string, unknown> }).parameters;
    const found = rootViolations(parameters);
    return found.length === 0
      ? []
      : [`${advertised[index]?.definition.name ?? "?"}: ${found.join(", ")}`];
  });
}

describe("every advertised tool definition is provider-neutral on the wire", () => {
  it("covers every Jira operation, and the walk reaches the root keywords a provider refuses", () => {
    const operations = jiraOperations();
    // Derived from the producers, never a restated count.
    expect(operations).toHaveLength(
      JIRA_MANAGED_READ_TOOLS.length + JIRA_MUTATION_OPERATIONS.length,
    );
    const refusedAsRegistered = operations.filter((entry) =>
      ROOT_KEYWORDS.some((key) => entry.definition.parameters[key] !== undefined),
    );
    // Vacuity guard: the registered operations really do carry root keywords (allOf, not), so
    // the assertion below is about the projection, not about an empty class.
    expect(refusedAsRegistered.length).toBeGreaterThan(0);
    expect(violations(operations)).toEqual([]);
  }, 60_000);

  it("covers the Chat base tools: Jira discovery and Knowledge", () => {
    const tools = chatBaseTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(violations(tools)).toEqual([]);
  }, 60_000);

  it("covers the Coding tools Keiko defines, native extensions included", () => {
    const tools = codingTools();
    expect(tools.some((entry) => entry.source === "coding-native-extension")).toBe(true);
    expect(violations(tools)).toEqual([]);
  }, 60_000);

  it("fails on a root keyword: the rule catches what the projection would not have folded", () => {
    expect(rootViolations({ type: "object", allOf: [{ required: ["a"] }] })).toEqual(["allOf"]);
    expect(rootViolations({ type: "object", not: { required: ["a"] } })).toEqual(["not"]);
    expect(rootViolations({ type: ["object", "null"] })).toEqual(["type"]);
    expect(rootViolations({ type: "object", properties: {} })).toEqual([]);
  });

  it("inventories the nested alternatives the registered tools carry, so the live pass exercises them", () => {
    const operations = jiraOperations();
    const wire = openAiCompatiblePromptTools(operations.map((entry) => entry.definition));
    const carrying = wire.filter(
      (tool) =>
        nestedAlternatives((tool.function as { parameters: unknown }).parameters, "").length > 0,
    );
    // Vacuity guard for the position in the header: nested alternatives exist on the wire, are not
    // judged, and the walk can see them.
    expect(carrying.length).toBeGreaterThan(0);
    const nested = {
      type: "object",
      properties: {
        items: { type: "array", items: { oneOf: [{ type: "string" }] } },
        kind: { type: "string", enum: ["a"] },
      },
    };
    expect(nestedAlternatives(nested, "")).toEqual(["properties.items.items.oneOf"]);
    expect(rootViolations(nested)).toEqual([]);
  });
});
