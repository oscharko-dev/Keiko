import {
  TOOL_CATALOG_LIMITS,
  type CatalogJsonObject,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpProvider,
  ManagedMcpTool,
  ManagedMcpToolResult,
  ManagedMcpInvocationContext,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { createToolDescriptor, createToolRef, ToolCatalogError } from "@oscharko-dev/keiko-tool-catalog";
import { CatalogDispatchFault, requireDispatch } from "../tool-catalog/catalogToolErrors.js";
import { jiraOperationDefinitions } from "./jiraOperationRegistry.js";
import { object, text } from "./jiraManagedSchemas.js";

/** Local catalog metadata operations; these never construct or dispatch Jira HTTP requests. */
export const JIRA_CATALOG_DISCOVERY_TOOLS = ["jira.discover", "jira.describe"] as const;
export type JiraCatalogDiscoveryToolName = (typeof JIRA_CATALOG_DISCOVERY_TOOLS)[number];
export interface JiraCatalogDiscoveryContext extends ManagedMcpInvocationContext {
  readonly jiraDiscoveryResultFits?: ((result: CatalogJsonObject) => boolean) | undefined;
  readonly selectJiraOperations?: ((identities: readonly string[], result: CatalogJsonObject) => Promise<void>) | undefined;
}
interface DiscoveryOptions {
  /** Server-owned admitted subset; absent retains Chat's ordinary catalog admission. */
  readonly tools?: ReadonlySet<string>;
  readonly nativeToolNames?: true;
}
type Context = JiraCatalogDiscoveryContext;
const IDENTITY = text(512);
const ITEM = object(
  {
    identity: IDENTITY,
    tool: text(128),
    description: text(4096),
    kind: { type: "string", enum: ["native", "composite"] },
    effects: { type: "array", maxItems: 16, items: text(64) },
  },
  ["identity", "tool"],
);

interface Summary extends CatalogJsonObject {
  readonly identity: string;
  readonly tool: string;
}
function summaries(options: DiscoveryOptions): readonly Summary[] {
  return jiraOperationDefinitions().filter((definition) =>
    options.tools === undefined || options.tools.has(definition.tool),
  ).map((definition) => ({
    identity: definition.identity,
    tool: options.nativeToolNames === true ? definition.tool : definition.tool.replace(/[.-]/gu, "_"),
    description: definition.authorityAction,
    kind: definition.kind,
    effects: definition.effects,
  }));
}

/** Exact registry identity lookup: neither user URLs nor HTTP request shapes are accepted. */
export function jiraToolsForIdentities(identities: readonly string[]): readonly string[] {
  const definitions = jiraOperationDefinitions();
  requireDispatch(new Set(identities).size === identities.length, "invalid", "invalid-arguments");
  return identities.map((identity) => {
    const definition = definitions.find((entry) => entry.identity === identity);
    requireDispatch(definition !== undefined, "invalid", "invalid-arguments");
    return definition.tool;
  });
}

function discover(args: CatalogJsonObject, context: Context, options: DiscoveryOptions): Promise<ManagedMcpToolResult> {
  context.signal.throwIfAborted();
  requireDispatch(context.beforeEffect(), "denied", "effect-denied");
  const startAt = typeof args.startAt === "number" ? args.startAt : 0;
  const maxResults = typeof args.maxResults === "number" ? args.maxResults : 100;
  const available = summaries(options);
  requireDispatch(context.jiraDiscoveryResultFits !== undefined, "failed", "handler-unavailable");
  const items: CatalogJsonObject[] = [];
  const page = (): CatalogJsonObject => ({
    outcome: "succeeded",
    items: [...items],
    startAt,
    total: available.length,
    ...(startAt + items.length < available.length ? { nextStartAt: startAt + items.length } : {}),
  });
  for (const item of available.slice(startAt, startAt + maxResults)) {
    items.push(item);
    const candidate = page();
    if (
      Buffer.byteLength(JSON.stringify(candidate)) <= TOOL_CATALOG_LIMITS.maxResultBytes &&
      context.jiraDiscoveryResultFits(candidate)
    )
      continue;
    items.pop();
    if (items.length === 0)
      return Promise.resolve({
        isError: true,
        data: { outcome: "failed", reason: "budget-exhausted", items: [] },
      });
    break;
  }
  return Promise.resolve({ data: page() });
}

async function describe(args: CatalogJsonObject, context: Context, options: DiscoveryOptions): Promise<ManagedMcpToolResult> {
  context.signal.throwIfAborted();
  requireDispatch(context.beforeEffect(), "denied", "effect-denied");
  const identities = args.identities;
  requireDispatch(
    Array.isArray(identities) && identities.every((identity) => typeof identity === "string"),
    "invalid",
    "invalid-arguments",
  );
  const tools = jiraToolsForIdentities(identities);
  requireDispatch(tools.every((name) => options.tools === undefined || options.tools.has(name)), "denied", "effect-denied");
  requireDispatch(context.selectJiraOperations !== undefined, "failed", "handler-unavailable");
  const selected = new Set(identities);
  const data: CatalogJsonObject = {
    outcome: "succeeded",
    items: summaries(options)
      .filter((item) => selected.has(item.identity))
      .map((item) => ({ identity: item.identity, tool: item.tool })),
    selectedFor: "next-round",
  };
  try {
    await context.selectJiraOperations(identities, data);
    return { data };
  } catch (error) {
    if (!(error instanceof CatalogDispatchFault) && !(error instanceof ToolCatalogError)) throw error;
    return {
      isError: true,
      data: {
        outcome: "failed",
        items: [],
        reason: error.reason === "budget-exhausted" ? "budget-exhausted" : "selection-unavailable",
      },
    };
  }
}

const RESULT_SCHEMA = object(
  {
    reason: { type: "string", enum: ["budget-exhausted", "selection-unavailable"] },
    outcome: { type: "string", enum: ["succeeded", "failed"] },
    items: {
      type: "array",
      maxItems: TOOL_CATALOG_LIMITS.maxArrayItems,
      items: ITEM,
    },
    startAt: { type: "integer", minimum: 0 },
    total: { type: "integer", minimum: 0 },
    nextStartAt: { type: "integer", minimum: 0 },
    selectedFor: { type: "string", enum: ["next-round"] },
  },
  ["outcome", "items"],
);

function tool(name: JiraCatalogDiscoveryToolName, options: DiscoveryOptions): ManagedMcpTool<Context> {
  const discovery = name === "jira.discover";
  return {
    name,
    risk: "read",
    descriptor: createToolDescriptor({
      toolRef: createToolRef(`keiko.${name}`, 1),
      description: discovery
        ? "List implemented Jira Data Center operations by stable identity. This reads local catalog metadata, not Jira data. Page until the required operation is found, then use jira.describe to load its typed tool."
        : "Select Jira operation identities returned by jira.discover. Replaces the selected Jira tool set for the next model round; typed argument schemas are offered there subject to current authority and budgets. Include all operations needed together. An empty list clears the selection. Unknown identities or a subset exceeding the model or authority budget are refused without truncation.",
      inputSchema: discovery
        ? object({
            startAt: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
            maxResults: { type: "integer", minimum: 1, maximum: 100 },
          })
        : object(
            {
              identities: {
                type: "array",
                maxItems: TOOL_CATALOG_LIMITS.maxArrayItems,
                items: IDENTITY,
              },
            },
            ["identities"],
          ),
      resultSchema: RESULT_SCHEMA,
      effects: ["connector-access"],
      actionMapping: [{ action: name, effects: ["connector-access"] }],
      policyReferences: ["adr-0128.d4"],
      handlerRequirement: { id: name, contractVersion: 1 },
      bounds: {
        maxArgumentBytes: TOOL_CATALOG_LIMITS.maxArgumentBytes,
        maxResultBytes: TOOL_CATALOG_LIMITS.maxResultBytes,
        maxResultCount: TOOL_CATALOG_LIMITS.maxArrayItems,
        maxDurationMs: 15000,
      },
      idempotency: "server-key-required",
      cancellation: "before-effect",
    }),
    execute: (args, context) => discovery ? discover(args, context, options) : describe(args, context, options),
  };
}

export function createJiraCatalogDiscoveryProvider(options: DiscoveryOptions = {}): ManagedMcpProvider<Context> {
  const tools = JIRA_CATALOG_DISCOVERY_TOOLS.map((name) => tool(name, options));
  return { id: "jira-catalog-discovery", tools: () => tools };
}
