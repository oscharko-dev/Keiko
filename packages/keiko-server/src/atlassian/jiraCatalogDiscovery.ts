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
import { jiraOperationInReleaseScope } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { jiraOperationDefinitions } from "./jiraOperationRegistry.js";
import { JIRA_OPERATION_SUMMARIES } from "./jiraOperationSummaries.generated.js";
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
/**
 * What a hit says about itself: the operation's own plain one-line summary (#4357). A person or a model
 * reads it to choose, so it is the descriptor's first sentence, not the authority action it is gated by.
 */
function summaries(options: DiscoveryOptions): readonly Summary[] {
  return jiraOperationDefinitions()
    .filter((definition) => options.tools === undefined || options.tools.has(definition.tool))
    .filter((definition) => jiraOperationInReleaseScope(definition.tool))
    .map((definition) => ({
      identity: definition.identity,
      tool:
        options.nativeToolNames === true ? definition.tool : definition.tool.replace(/[.-]/gu, "_"),
      description: JIRA_OPERATION_SUMMARIES[definition.tool] ?? definition.tool,
      kind: definition.kind,
      effects: definition.effects,
    }));
}

const QUERY_MAX_CHARS = 200;
const QUERY_TERMS_MAX = 12;
/** Words that carry no operation: a query made only of them lists everything, like a blank one. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "of",
  "to",
  "for",
  "in",
  "on",
  "and",
  "or",
  "am",
  "is",
  "are",
  "i",
  "me",
  "my",
  "as",
  "this",
  "that",
  "it",
  "do",
  "does",
  "can",
  "how",
]);
/**
 * Plain phrases a person uses for an operation whose summary does not carry them. Closed and small on
 * purpose: only where the summary lacks the words, never a translation table. A query in another
 * language is phrased in these English operation words by the model, as the discover description says.
 * A phrase counts when every one of its significant words is in the query.
 */
const PLAIN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "jira.myself": [
    // The question itself; the summary says "current authenticated Jira user", never "who am I".
    "who am i",
    "current user",
    // "user name" and "account" are what a person calls their own login.
    "user name",
    "account",
    "profile",
  ],
  "jira.watch": [
    // "add me as a watcher" and "watch this issue": the summary says "start watching".
    "add watcher",
    "watch",
    // Other common words for watching an issue.
    "subscribe",
    "follow",
  ],
  "jira.unwatch": ["remove watcher", "stop watching", "unsubscribe", "unfollow"],
  "jira.users": [
    // The summary says "search"; people say "find" or "look up" a user.
    "find user",
    "look user",
  ],
  "jira.watchers": [
    // Reading who watches: the summary says "visible watcher identities".
    "who watch",
    "list watcher",
  ],
};
/** Lowercase words of an identity, tool name or query; separators and HTTP path syntax split words. */
function rawWords(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 0);
}
const words = (value: string): readonly string[] => rawWords(value).map(singular);
/** The words of a phrase or query that name something, in their plural-free form. */
const significantTerms = (value: string): readonly string[] => [
  ...new Set(
    rawWords(value)
      .filter((word) => !STOP_WORDS.has(word))
      .map(singular),
  ),
];
/** One deterministic plural rule, applied to query and operation words alike: statuses is status. */
function singular(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(?:ses|ches|shes|xes)$/u.test(word)) return word.slice(0, -2);
  return word.endsWith("s") && !/(?:ss|us)$/u.test(word) ? word.slice(0, -1) : word;
}
interface Candidate {
  readonly summary: Summary;
  readonly name: ReadonlySet<string>;
  readonly alias: readonly (readonly string[])[];
  readonly said: ReadonlySet<string>;
  readonly identity: ReadonlySet<string>;
}
const CANDIDATE_WORDS = new Map<string, Omit<Candidate, "summary">>();
function candidateWords(
  summary: Summary,
  definition: ReturnType<typeof jiraOperationDefinitions>[number],
): Omit<Candidate, "summary"> {
  const known = CANDIDATE_WORDS.get(definition.tool);
  if (known !== undefined) return known;
  const built = {
    name: new Set(words(definition.tool)),
    alias: (PLAIN_ALIASES[definition.tool] ?? []).map(significantTerms),
    said: new Set(words(typeof summary.description === "string" ? summary.description : "")),
    identity: new Set(words(`${definition.identity} ${definition.authorityAction}`)),
  };
  CANDIDATE_WORDS.set(definition.tool, built);
  return built;
}
function candidates(options: DiscoveryOptions): readonly Candidate[] {
  const listed = summaries(options);
  const byIdentity = new Map(jiraOperationDefinitions().map((item) => [item.identity, item]));
  return listed.flatMap((summary) => {
    const definition = byIdentity.get(summary.identity);
    return definition === undefined ? [] : [{ summary, ...candidateWords(summary, definition) }];
  });
}
/**
 * A whole word of the tool name counts 3, of the plain summary 2, of the identity 1; a plain phrase
 * whose words are all in the query counts 6, because a person chose it for exactly this operation.
 */
function scoreOf(candidate: Candidate, terms: readonly string[]): number {
  const asked = new Set(terms);
  const words = terms.reduce(
    (total, term) =>
      total +
      (candidate.name.has(term) ? 3 : 0) +
      (candidate.said.has(term) ? 2 : 0) +
      (candidate.identity.has(term) ? 1 : 0),
    0,
  );
  const phrases = candidate.alias.filter(
    (phrase) => phrase.length > 0 && phrase.every((word) => asked.has(word)),
  );
  return words + phrases.length * 6;
}
/**
 * Rank summaries by query words, lexically and deterministically (no model, no embedding). The narrower
 * tool name, then registry order, breaks ties. Partial agreement still ranks, so a synonym in the query
 * cannot hide every operation.
 */
function matching(options: DiscoveryOptions, query: string): readonly Summary[] {
  const terms = significantTerms(query).slice(0, QUERY_TERMS_MAX);
  const available = candidates(options);
  if (terms.length === 0) return available.map((candidate) => candidate.summary);
  return available
    .map((candidate, index) => ({ candidate, index, score: scoreOf(candidate, terms) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.name.size - right.candidate.name.size ||
        left.index - right.index,
    )
    .map((entry) => entry.candidate.summary);
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

/**
 * The registry identity each requested entry names. An entry is either an exact identity or the
 * name of an operation this same provider lists: the `tool` field jira.discover returns beside
 * the identity, or the dotted registry name (`jira.priorities`) that Keiko's own tool descriptions
 * and instructions use. Models copy both, and refusing either spent a model round on every first
 * describe (measured 2026-11-13: 6 of 15 first describes still failed after only the first form was
 * accepted; each retry differed from the refused call by the separator alone). Only operations the
 * provider lists are resolved. Neither a URL nor an HTTP request shape is ever resolved. Unknown
 * entries and an operation named twice (by identity, name or both) yield `undefined`: nothing is
 * selected.
 */
function canonicalIdentities(
  requested: readonly string[],
  options: DiscoveryOptions,
): readonly string[] | undefined {
  const listed = jiraOperationDefinitions().filter(
    (definition) =>
      (options.tools === undefined || options.tools.has(definition.tool)) &&
      jiraOperationInReleaseScope(definition.tool),
  );
  // An operation outside this release's scope is not an identity a model may select.
  const known = new Set(
    jiraOperationDefinitions()
      .filter((definition) => jiraOperationInReleaseScope(definition.tool))
      .map((definition) => definition.identity),
  );
  const resolved: string[] = [];
  for (const entry of requested) {
    const identity = known.has(entry) ? entry : namedOperation(listed, entry, options)?.identity;
    if (identity === undefined) return undefined;
    resolved.push(identity);
  }
  return new Set(resolved).size === resolved.length ? resolved : undefined;
}
function namedOperation(
  listed: readonly { readonly identity: string; readonly tool: string }[],
  entry: string,
  options: DiscoveryOptions,
): { readonly identity: string } | undefined {
  return listed.find(
    (definition) =>
      definition.tool === entry ||
      (options.nativeToolNames !== true && definition.tool.replace(/[.-]/gu, "_") === entry),
  );
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
    typeof args.query === "string" ? matching(options, args.query) : summaries(options);
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
      return Promise.resolve(discoveryFailure({ reason: "budget-exhausted" }));
    break;
  }
  return Promise.resolve({ data: page() });
}

/**
 * The one failure shape of the discover/describe tools: always a managed tool error, so the host,
 * the catalog adapter and the activity log count it as a refusal and never as a success.
 */
function discoveryFailure(
  failure: { readonly reason: string } & CatalogJsonObject,
): ManagedMcpToolResult {
  return { isError: true, data: { outcome: "failed", items: [], ...failure } };
}

const INVALID_DESCRIPTION = {
  outcome: "failed",
  reason: "invalid-arguments",
  guidance:
    "Pass only the identity or the tool name that jira.discover returned for an operation, each operation at most once; a name jira.discover did not list is refused. The current tool selection was not changed.",
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
    if (error.reason === "input-bound") return discoveryFailure(TOO_LARGE_SELECTION);
    return discoveryFailure({
      reason: error.reason === "budget-exhausted" ? "budget-exhausted" : "selection-unavailable",
    });
  }
}

async function describe(
  args: CatalogJsonObject,
  context: Context,
  options: DiscoveryOptions,
): Promise<ManagedMcpToolResult> {
  context.signal.throwIfAborted();
  requireDispatch(context.beforeEffect(), "denied", "effect-denied");
  const invalid = discoveryFailure(INVALID_DESCRIPTION);
  const requested = args.identities;
  if (!Array.isArray(requested) || !requested.every((identity) => typeof identity === "string"))
    return invalid;
  const identities = canonicalIdentities(requested, options);
  if (identities === undefined) return invalid;
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

// A pure constant: built once per process, not again for every catalog a Chat turn composes.
const DISCOVERY_DESCRIPTORS = new Map<
  JiraCatalogDiscoveryToolName,
  ReturnType<typeof createToolDescriptor>
>();
function discoveryDescriptor(
  name: JiraCatalogDiscoveryToolName,
): ReturnType<typeof createToolDescriptor> {
  const known = DISCOVERY_DESCRIPTORS.get(name);
  if (known !== undefined) return known;
  const discovery = name === "jira.discover";
  const descriptor = createToolDescriptor({
    toolRef: createToolRef(`keiko.${name}`, 2),
    description: discovery
      ? "Search the Jira Data Center operations that are not offered directly. This reads local catalog metadata, not Jira data. Use it whenever no offered tool does what was asked, before answering that it cannot be done. Pass a short query of plain English operation words, such as who am I, project statuses, watch issue or create project; each hit has a one-line description. Phrase a request given in another language in these English words. Page until the operation is found, then use jira.describe to load its typed tool."
      : "Select additional native Jira operations by the identity or the tool name that jira.discover returned (jira.priorities and jira_priorities name the same operation). Curated Jira tools stay available. Replaces the additional selected tool set for the next model round; typed argument schemas are offered there subject to current authority and budgets. Include all additional operations needed together. An empty list clears the additional selection. Unknown identities or a subset exceeding the model or authority budget are refused without truncation.",
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
  });
  DISCOVERY_DESCRIPTORS.set(name, descriptor);
  return descriptor;
}

function tool(
  name: JiraCatalogDiscoveryToolName,
  options: DiscoveryOptions,
): ManagedMcpTool<Context> {
  const discovery = name === "jira.discover";
  return {
    name,
    risk: "read",
    descriptor: discoveryDescriptor(name),
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
