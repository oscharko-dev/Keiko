import {
  excludedJiraDraftRefs,
  executeJiraDraftItem,
  findJiraDraftItem,
  jiraBrowseUrl,
  jiraDraftDependencies,
  parseJiraDraft,
  type AtlassianHttpBodyPort,
  type JiraDraft,
  type JiraDraftItem,
  type JiraManagedConnection,
} from "@oscharko-dev/keiko-connectors";
import type {
  JiraDraftItemState,
  JiraMutationAttempt,
  JiraMutationOutcome,
  JiraMutationResultState,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import type {
  ManagedMcpInvocationContext,
  ManagedMcpToolResult,
} from "@oscharko-dev/keiko-contracts/runtime/managed-mcp";
import { canonicalise, sha256Hex } from "@oscharko-dev/keiko-security";
import { emitServerDiagnostic, serverDiagnosticFromError } from "../diagnostics-log.js";
import { observedChatToolMutationOutcome } from "../store/chatToolMutationState.js";
import type {
  ChatToolMutationStore,
  JiraChatToolMutationIntent,
} from "../store/chatToolMutationTypes.js";
import type { AtlassianHttpLifecycleOptions } from "./httpRequestLifecycle.js";
import { executeJiraChatMutation } from "./jiraChatMutation.js";

/**
 * Backlog drafts (#4178): the server runs every selected item as its own journaled `jira.create`
 * under a child identity derived from the draft action, in dependency order, behind the draft's one
 * approval. A child journal replays exactly like any mutation (#2953): a sent item is never sent
 * again, and an item that already exists in Jira is reconciled, not created twice.
 */
export interface JiraChatDraftExecution {
  readonly journal: ChatToolMutationStore | undefined;
  /** The draft action's own intent; children inherit everything but identity and operation. */
  readonly intent: JiraChatToolMutationIntent;
  readonly arguments: CatalogJsonObject;
  /** Items the human deselected on the approval; empty under Full access. */
  readonly deselected: readonly string[];
  readonly context: ManagedMcpInvocationContext;
  readonly connection: Omit<JiraManagedConnection, "http">;
  readonly httpPortFactory: (lifecycle: AtlassianHttpLifecycleOptions) => AtlassianHttpBodyPort;
  readonly beforeEffect: () => boolean;
  readonly beforeMutation: () => boolean;
}

interface DraftItemResult {
  readonly ref: string;
  readonly state: JiraDraftItemState;
  readonly issueKey?: string;
  readonly detail?: CatalogJsonObject;
}

/** The deterministic journal identity of one draft item. */
export function jiraDraftChildIntent(
  parent: JiraChatToolMutationIntent,
  ref: string,
): JiraChatToolMutationIntent {
  return {
    ...parent,
    operation: "jira.create",
    invocationId: sha256Hex(canonicalise({ draft: parent.invocationId, ref })),
    actionDigest: sha256Hex(canonicalise({ draft: parent.actionDigest, ref })),
  };
}

const DETAIL_KEYS = ["reason", "fieldId", "validation", "fieldErrors", "messages"] as const;
function failureDetail(data: CatalogJsonObject): CatalogJsonObject {
  const detail: Record<string, CatalogJsonValue> = {};
  for (const key of DETAIL_KEYS) {
    const value = data[key];
    if (value !== undefined) detail[key] = value;
  }
  return detail;
}
function keyOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
/** Journal outcome first; the attempt only names the key a reconciliation found. */
function settledItem(
  ref: string,
  result: ManagedMcpToolResult,
  attempt: JiraMutationAttempt | undefined,
): DraftItemResult {
  const outcome = result.data.outcome;
  if (outcome === "succeeded") {
    const issueKey = keyOf(result.data.issueKey);
    return { ref, state: "created", ...(issueKey === undefined ? {} : { issueKey }) };
  }
  if (outcome === "not-dispatched" && attempt?.ok === true) {
    const issueKey = keyOf(attempt.receipt.issueKey);
    return { ref, state: "existing", ...(issueKey === undefined ? {} : { issueKey }) };
  }
  if (outcome === "rejected" || outcome === "not-dispatched")
    return { ref, state: "failed", detail: failureDetail(result.data) };
  return { ref, state: "uncertain", detail: failureDetail(result.data) };
}

async function runItem(
  input: JiraChatDraftExecution,
  item: JiraDraftItem,
  keys: ReadonlyMap<string, string>,
): Promise<DraftItemResult> {
  let attempt: JiraMutationAttempt | undefined;
  const result = await executeJiraChatMutation({
    journal: input.journal,
    intent: jiraDraftChildIntent(input.intent, item.ref),
    httpPortFactory: input.httpPortFactory,
    beforeEffect: input.beforeEffect,
    beforeMutation: input.beforeMutation,
    execute: async (http) => {
      attempt = await executeJiraDraftItem(item, keys, input.context, {
        ...input.connection,
        http,
      });
      return attempt;
    },
  });
  const settled = settledItem(item.ref, result, attempt);
  return result.data.replayed === true && settled.state === "created"
    ? recoveredKey(input, item, settled)
    : settled;
}

/** A replayed item keeps its journal outcome; its key comes back from a read-only lookup. */
async function recoveredKey(
  input: JiraChatDraftExecution,
  item: JiraDraftItem,
  settled: DraftItemResult,
): Promise<DraftItemResult> {
  const http = input.httpPortFactory({
    beforeDispatch: (request) => request.method === "GET" && input.beforeEffect(),
  });
  try {
    const found = await findJiraDraftItem(item, input.context, { ...input.connection, http });
    const issueKey = found.ok ? keyOf(found.receipt.issueKey) : undefined;
    return issueKey === undefined ? settled : { ...settled, issueKey };
  } catch (error) {
    // Without its key the item stays created; only its dependents are skipped.
    emitServerDiagnostic(
      undefined,
      serverDiagnosticFromError({
        correlationId: input.intent.correlationId,
        operation: "jira.mutation-execution-failed",
        source: "jira-chat-mutation",
        error,
        redact: () => "server-operation-failed",
      }),
    );
    return settled;
  }
}

function blockedState(
  item: JiraDraftItem,
  excluded: ReadonlySet<string>,
  keys: ReadonlyMap<string, string>,
): JiraDraftItemState | undefined {
  if (excluded.has(item.ref)) return "excluded";
  return jiraDraftDependencies(item).every((ref) => keys.has(ref)) ? undefined : "skipped";
}

async function runDraft(
  input: JiraChatDraftExecution,
  draft: JiraDraft,
): Promise<readonly DraftItemResult[]> {
  const excluded = excludedJiraDraftRefs(draft, input.deselected);
  const keys = new Map<string, string>();
  const results: DraftItemResult[] = [];
  let halted = false;
  for (const item of draft.items) {
    // After an uncertain item the journal admits no further write in this turn; nothing is tried.
    const blocked: JiraDraftItemState | undefined =
      blockedState(item, excluded, keys) ?? (halted ? "skipped" : undefined);
    // Each item needs the keys its earlier items received; the journal admits one effect at a time.
    const settled: DraftItemResult =
      blocked === undefined
        ? await runItem(input, item, keys) // NOSONAR typescript:S9382 -- dependency order
        : { ref: item.ref, state: blocked };
    if (settled.issueKey !== undefined) keys.set(item.ref, settled.issueKey);
    halted ||= settled.state === "uncertain";
    results.push(settled);
  }
  return results;
}

const SETTLED_STATES: ReadonlySet<JiraDraftItemState> = new Set([
  "created",
  "existing",
  "excluded",
]);
const STATE_COUNTS: Readonly<Record<JiraDraftItemState, string>> = {
  created: "createdCount",
  existing: "existingCount",
  failed: "failedCount",
  uncertain: "uncertainCount",
  skipped: "skippedCount",
  excluded: "excludedCount",
};
/** One draft outcome over its items; an uncertain item makes the whole draft uncertain. */
export function jiraDraftOutcome(
  outcomes: readonly (JiraMutationOutcome | undefined)[],
): JiraMutationOutcome {
  const present = new Set(outcomes);
  if (present.has("unknown") || present.has(undefined)) return "unknown";
  if (present.has("succeeded-unconfirmed")) return "succeeded-unconfirmed";
  if (present.has("succeeded")) return "succeeded";
  return present.has("rejected") ? "rejected" : "not-dispatched";
}
function itemOutcome(state: JiraDraftItemState): JiraMutationOutcome {
  if (state === "created") return "succeeded";
  if (state === "uncertain") return "unknown";
  return state === "failed" ? "rejected" : "not-dispatched";
}
function projectItem(baseUrl: string, item: DraftItemResult): CatalogJsonObject {
  const browseUrl = item.issueKey === undefined ? undefined : jiraBrowseUrl(baseUrl, item.issueKey);
  return {
    ref: item.ref,
    state: item.state,
    ...(item.issueKey === undefined ? {} : { issueKey: item.issueKey }),
    ...(browseUrl === undefined ? {} : { browseUrl }),
    ...item.detail,
  };
}
function draftResult(baseUrl: string, items: readonly DraftItemResult[]): ManagedMcpToolResult {
  const counts: Record<string, number> = Object.fromEntries(
    Object.values(STATE_COUNTS).map((name) => [name, 0]),
  );
  for (const item of items)
    counts[STATE_COUNTS[item.state]] = (counts[STATE_COUNTS[item.state]] ?? 0) + 1;
  const outcome: JiraMutationResultState = jiraDraftOutcome(
    items.map((item) => itemOutcome(item.state)),
  );
  // The outcome says whether Jira changed; an item that did not land still makes the call an error.
  const complete = items.every((item) => SETTLED_STATES.has(item.state));
  return {
    data: { outcome, items: items.map((item) => projectItem(baseUrl, item)), ...counts },
    ...(outcome === "succeeded" && complete ? {} : { isError: true }),
  };
}

export async function executeJiraChatDraft(
  input: JiraChatDraftExecution,
): Promise<ManagedMcpToolResult> {
  const draft = parseJiraDraft(input.arguments);
  if (draft === undefined)
    return {
      data: { outcome: "rejected", reason: "field-validation", items: [] },
      isError: true,
    };
  return draftResult(input.connection.baseUrl, await runDraft(input, draft));
}

/** The durable draft outcome, read from the journal records of its items (#4178). */
export function observedJiraDraftOutcome(
  journal: ChatToolMutationStore | undefined,
  intent: JiraChatToolMutationIntent,
  args: Readonly<Record<string, unknown>>,
): JiraMutationOutcome | undefined {
  const draft = parseJiraDraft(args);
  if (draft === undefined || journal === undefined) return undefined;
  const records = draft.items
    .map((item) => journal.find(jiraDraftChildIntent(intent, item.ref).invocationId))
    .filter((record) => record !== undefined);
  if (records.length === 0) return undefined;
  return jiraDraftOutcome(records.map(observedChatToolMutationOutcome));
}
