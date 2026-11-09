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
import {
  createToolDescriptor,
  createToolRef,
  ToolCatalogError,
} from "@oscharko-dev/keiko-tool-catalog";
import { CatalogDispatchFault, requireDispatch } from "../tool-catalog/catalogToolErrors.js";
import { jiraOperationDefinitions } from "./jiraOperationRegistry.js";
import { object, text } from "./jiraManagedSchemas.js";

/** Local catalog metadata operations; these never construct or dispatch Jira HTTP requests. */
export const JIRA_CATALOG_DISCOVERY_TOOLS = ["jira.discover", "jira.describe"] as const;
export type JiraCatalogDiscoveryToolName = (typeof JIRA_CATALOG_DISCOVERY_TOOLS)[number];
export interface JiraCatalogDiscoveryContext extends ManagedMcpInvocationContext {
  readonly jiraDiscoveryResultFits?: ((result: CatalogJsonObject) => boolean) | undefined;
  readonly selectJiraOperations?:
    ((identities: readonly string[], result: CatalogJsonObject) => Promise<void>) | undefined;
  /** Identities of the selection the next describe replaces; absent when none is tracked. */
  readonly selectedJiraOperations?: (() => readonly string[]) | undefined;
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
  return jiraOperationDefinitions()
    .filter((definition) => options.tools === undefined || options.tools.has(definition.tool))
    .map((definition) => ({
      identity: definition.identity,
      tool:
        options.nativeToolNames === true ? definition.tool : definition.tool.replace(/[.-]/gu, "_"),
      description: definition.authorityAction,
      kind: definition.kind,
      effects: definition.effects,
    }));
}

const QUERY_MAX_CHARS = 200;
const QUERY_TERMS_MAX = 12;
/** Lowercase words of an identity, tool name or query; separators and HTTP path syntax split words. */
function words(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 0);
}
/**
 * Rank summaries by query words: a whole word of the tool name counts twice, a word found anywhere
 * in the identity, tool or description once. The narrower tool name, then registry order, breaks
 * ties. Partial agreement still ranks, so a synonym in the query cannot hide every operation.
 */
function matching(available: readonly Summary[], query: string): readonly Summary[] {
  const terms = [...new Set(words(query))].slice(0, QUERY_TERMS_MAX);
  if (terms.length === 0) return available;
  return available
    .map((summary, index) => {
      const name = new Set(words(summary.tool));
      const description = typeof summary.description === "string" ? summary.description : "";
      const haystack = words(`${summary.identity} ${summary.tool} ${description}`).join(" ");
      const score = terms.reduce(
        (total, term) => total + (name.has(term) ? 2 : 0) + (haystack.includes(term) ? 1 : 0),
        0,
      );
      return { summary, index, score, breadth: name.size };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.breadth - right.breadth || left.index - right.index,
    )
    .map((entry) => entry.summary);
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

function discover(
  args: CatalogJsonObject,
  context: Context,
  options: DiscoveryOptions,
): Promise<ManagedMcpToolResult> {
  context.signal.throwIfAborted();
  requireDispatch(context.beforeEffect(), "denied", "effect-denied");
  const startAt = typeof args.startAt === "number" ? args.startAt : 0;
  const maxResults = typeof args.maxResults === "number" ? args.maxResults : 100;
  const available =
    typeof args.query === "string" ? matching(summaries(options), args.query) : summaries(options);
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

const INVALID_DESCRIPTION = {
  outcome: "failed",
  reason: "invalid-arguments",
  guidance:
    "Use only exact operation identities returned by jira.discover, each at most once. The current tool selection was not changed.",
} as const;

/** More operations than one tool host or catalog can carry; nothing was selected. */
const TOO_LARGE_SELECTION = {
  reason: "selection-too-large",
  guidance:
    "Too many operations were selected at once. Select only the operations needed for the next step, then select others in a later round. The current tool selection was not changed.",
} as const;

async function selectedDescription(
  select: NonNullable<Context["selectJiraOperations"]>,
  identities: readonly string[],
  data: CatalogJsonObject,
): Promise<ManagedMcpToolResult> {
  try {
    await select(identities, data);
    return { data };
  } catch (error) {
    if (!(error instanceof CatalogDispatchFault) && !(error instanceof ToolCatalogError))
      throw error;
    if (error.reason === "input-bound")
      return { isError: true, data: { outcome: "failed", items: [], ...TOO_LARGE_SELECTION } };
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

async function describe(
  args: CatalogJsonObject,
  context: Context,
  options: DiscoveryOptions,
): Promise<ManagedMcpToolResult> {
  context.signal.throwIfAborted();
  requireDispatch(context.beforeEffect(), "denied", "effect-denied");
  const invalid: ManagedMcpToolResult = {
    isError: true,
    data: { ...INVALID_DESCRIPTION, items: [] },
  };
  const identities = args.identities;
  if (!Array.isArray(identities) || !identities.every((identity) => typeof identity === "string"))
    return invalid;
  let tools: readonly string[];
  try {
    tools = jiraToolsForIdentities(identities);
  } catch (error) {
    if (!(error instanceof CatalogDispatchFault) || error.reason !== "invalid-arguments")
      throw error;
    return invalid;
  }
  requireDispatch(
    tools.every((name) => options.tools === undefined || options.tools.has(name)),
    "denied",
    "effect-denied",
  );
  requireDispatch(context.selectJiraOperations !== undefined, "failed", "handler-unavailable");
  const selected = new Set(identities);
  const previous = new Set(context.selectedJiraOperations?.() ?? []);
  const known = summaries(options);
  const deselected = known
    .filter((item) => previous.has(item.identity) && !selected.has(item.identity))
    .map((item) => ({ identity: item.identity, tool: item.tool }));
  const data: CatalogJsonObject = {
    outcome: "succeeded",
    items: known
      .filter((item) => selected.has(item.identity))
      .map((item) => ({ identity: item.identity, tool: item.tool })),
    selectedFor: "next-round",
    ...(deselected.length === 0 ? {} : { deselected, guidance: DESELECTED_GUIDANCE }),
  };
  return selectedDescription(context.selectJiraOperations.bind(context), identities, data);
}

/** A replacing selection names what it dropped, so a model never calls a tool it lost unknowingly. */
const DESELECTED_GUIDANCE =
  "This selection replaced the previous one. The operations under deselected are no longer offered in the next round; select them again together with the others if they are still needed.";

const RESULT_SCHEMA = object(
  {
    reason: {
      type: "string",
      enum: [
        "budget-exhausted",
        "selection-unavailable",
        "selection-too-large",
        "invalid-arguments",
      ],
    },
    guidance: text(512),
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
    deselected: {
      type: "array",
      maxItems: TOOL_CATALOG_LIMITS.maxArrayItems,
      items: ITEM,
    },
  },
  ["outcome", "items"],
);

function tool(
  name: JiraCatalogDiscoveryToolName,
  options: DiscoveryOptions,
): ManagedMcpTool<Context> {
  const discovery = name === "jira.discover";
  return {
    name,
    risk: "read",
    descriptor: createToolDescriptor({
      toolRef: createToolRef(`keiko.${name}`, 2),
      description: discovery
        ? "List implemented Jira Data Center operations by stable identity. This reads local catalog metadata, not Jira data. Pass a short query of plain words, such as create project or sprint issues, to rank matching operations first; page until the required operation is found, then use jira.describe to load its typed tool."
        : "Select additional native Jira operation identities returned by jira.discover. Curated Jira tools stay available. Replaces the additional selected tool set for the next model round; typed argument schemas are offered there subject to current authority and budgets. Include all additional operations needed together. An empty list clears the additional selection. Unknown identities or a subset exceeding the model or authority budget are refused without truncation.",
      inputSchema: discovery
        ? object({
            query: text(QUERY_MAX_CHARS),
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
    execute: (args, context) =>
      discovery ? discover(args, context, options) : describe(args, context, options),
  };
}

export function createJiraCatalogDiscoveryProvider(
  options: DiscoveryOptions = {},
): ManagedMcpProvider<Context> {
  const tools = JIRA_CATALOG_DISCOVERY_TOOLS.map((name) => tool(name, options));
  return { id: "jira-catalog-discovery", tools: () => tools };
}
