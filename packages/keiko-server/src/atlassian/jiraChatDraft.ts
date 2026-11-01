import {
  excludedJiraDraftRefs,
  executeJiraDraftItem,
  findJiraDraftItem,
  jiraBrowseUrl,
  jiraDraftDependencies,
  parseJiraDraft,
  type AtlassianHttpBodyPort,
  type JiraDraft,
  type JiraDraftActivity,
  type JiraDraftItem,
  type JiraManagedConnection,
  type JiraTraceOutcome,
} from "@oscharko-dev/keiko-connectors";
import {
  JIRA_DRAFT_RESULT_ROWS_MAX,
  type JiraDraftItemState,
  type JiraMutationAttempt,
  type JiraMutationOutcome,
  type JiraMutationResultState,
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
import { compactIssueKeys } from "./jiraDraftKeyRanges.js";
import { JIRA_REJECTED_GUIDANCE, JIRA_UNCERTAIN_GUIDANCE } from "./jiraMutationResult.js";
import {
  logTrace,
  newTally,
  tallyOutcome,
  tallyRefusal,
  traceOutcomeData,
  traceRefusalData,
  type ItemTrace,
  type TraceResolution,
  type TraceSession,
  type TraceTally,
} from "../requirement-trace.js";

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
  /**
   * The trace of the Chat's Knowledge Pods for this draft (#4179). An item's explicit
   * `requirementIds` are validated before any item is created; an unknown or ambiguous reference
   * refuses the whole draft. Without it an item that names requirements cannot be traced and the
   * draft is refused.
   */
  readonly openTrace?: (() => TraceSession) | undefined;
  /** Body-free progress and end-of-run counts for the Activity Log. */
  readonly activity?: ((activity: JiraDraftActivity) => void) | undefined;
  readonly now?: (() => number) | undefined;
  /** Test seam: how long a run may create, and how long it may take in all. */
  readonly budget?: JiraDraftRunBudget | undefined;
}

/**
 * A run is time-bounded, not size-bounded: no new item is started once the run has been creating
 * for `writeMs` or has taken `totalMs` in all (inside the tool's own duration ceiling). Items not
 * started are reported as pending, and running the same draft again reconciles what exists and
 * continues with them (#4178). Reading ahead through items that already exist does not use the
 * creating allowance up, so a continuation always reaches the first item still to be created.
 */
export interface JiraDraftRunBudget {
  readonly writeMs: number;
  readonly totalMs: number;
}
export const JIRA_DRAFT_RUN_BUDGET: JiraDraftRunBudget = Object.freeze({
  writeMs: 10 * 60_000,
  totalMs: 40 * 60_000,
});
/** A progress line is written to the Activity Log after this many items were attempted. */
const PROGRESS_EVERY = 100;

interface DraftItemResult {
  readonly ref: string;
  readonly state: JiraDraftItemState;
  readonly issueKey?: string;
  readonly detail?: CatalogJsonObject;
  /** What of the requested trace reached the created issue. */
  readonly trace?: CatalogJsonObject;
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
    // The approved draft authorizes exactly its own items: the batch, not the per-turn bound on
    // single writes, limits them (#4178).
    batchDigest: parent.actionDigest,
  };
}

const DETAIL_KEYS = [
  "reason",
  "fieldId",
  "validation",
  "fieldErrors",
  "messages",
  "violations",
  // A created item whose further links did not all land (#4176): which are missing.
  "linksRequested",
  "linksCreated",
  "linksMissing",
  "linksUnconfirmed",
] as const;
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
  // A partial effect names the issue it did create, so it is never created again.
  const partialKey = keyOf(result.data.issueKey);
  return {
    ref,
    state: "uncertain",
    ...(partialKey === undefined ? {} : { issueKey: partialKey }),
    detail: failureDetail(result.data),
  };
}

async function runItem(
  input: JiraChatDraftExecution,
  item: JiraDraftItem,
  keys: ReadonlyMap<string, string>,
  trace: ItemTrace | undefined,
  tally: TraceTally,
): Promise<DraftItemResult> {
  let traced: JiraTraceOutcome | undefined;
  const settled = await runTracedItem(
    input,
    item,
    keys,
    trace === undefined
      ? undefined
      : {
          ...trace,
          report: (outcome): void => {
            traced = outcome;
          },
        },
  );
  if (trace === undefined) return settled;
  tallyOutcome(tally, traced);
  const data = traceOutcomeData(traced);
  return data === undefined ? settled : { ...settled, trace: data };
}

async function runTracedItem(
  input: JiraChatDraftExecution,
  item: JiraDraftItem,
  keys: ReadonlyMap<string, string>,
  trace: Parameters<typeof executeJiraDraftItem>[4],
): Promise<DraftItemResult> {
  let attempt: JiraMutationAttempt | undefined;
  const result = await executeJiraChatMutation({
    journal: input.journal,
    intent: jiraDraftChildIntent(input.intent, item.ref),
    httpPortFactory: input.httpPortFactory,
    beforeEffect: input.beforeEffect,
    beforeMutation: input.beforeMutation,
    execute: async (http) => {
      attempt = await executeJiraDraftItem(
        item,
        keys,
        input.context,
        { ...input.connection, http },
        trace,
      );
      return attempt;
    },
  });
  const settled = settledItem(item.ref, result, attempt);
  const outcome = result.data.outcome;
  if (result.data.replayed !== true) return settled;
  // A replay never runs the executor: a created item and a reconciled one (settled without any
  // write) both come back from their journal without the key their dependents need.
  if (outcome === "succeeded") return recoveredKey(input, item, keys, settled, "created");
  return outcome === "not-dispatched"
    ? recoveredKey(input, item, keys, settled, "existing")
    : settled;
}

/**
 * A replayed item keeps its journal outcome; its key comes back from a read-only lookup by its
 * draft identity, so no mutation is ever resent.
 */
async function recoveredKey(
  input: JiraChatDraftExecution,
  item: JiraDraftItem,
  keys: ReadonlyMap<string, string>,
  settled: DraftItemResult,
  state: "created" | "existing",
): Promise<DraftItemResult> {
  const http = input.httpPortFactory({
    beforeDispatch: (request) => request.method === "GET" && input.beforeEffect(),
  });
  try {
    const found = await findJiraDraftItem(item, keys, input.context, {
      ...input.connection,
      http,
    });
    const issueKey = found.ok ? keyOf(found.receipt.issueKey) : undefined;
    if (issueKey === undefined) return settled;
    return { ref: item.ref, state, issueKey };
  } catch (error) {
    // Without its key a created item stays created; only its dependents are skipped.
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

interface RunState {
  readonly excluded: ReadonlySet<string>;
  readonly keys: Map<string, string>;
  /** Refs not started because the run's time ended; their dependents wait with them. */
  readonly pending: Set<string>;
  /** An uncertain item halts the draft: the journal admits no further write in this turn. */
  halted: boolean;
  /** Latched once the run's time is up. */
  stopped: boolean;
  firstWriteAt: number | undefined;
  attempted: number;
}

function blockedState(item: JiraDraftItem, run: RunState): JiraDraftItemState | undefined {
  if (run.excluded.has(item.ref)) return "excluded";
  const dependencies = jiraDraftDependencies(item);
  if (dependencies.some((ref) => run.pending.has(ref))) return "pending";
  if (!dependencies.every((ref) => run.keys.has(ref))) return "skipped";
  if (run.halted) return "skipped";
  return run.stopped ? "pending" : undefined;
}
function timeIsUp(
  run: RunState,
  clock: {
    readonly now: () => number;
    readonly startedAt: number;
    readonly budget: JiraDraftRunBudget;
  },
): boolean {
  const at = clock.now();
  const creating = run.firstWriteAt === undefined ? 0 : at - run.firstWriteAt;
  return at - clock.startedAt >= clock.budget.totalMs || creating >= clock.budget.writeMs;
}

function settledCount(results: readonly DraftItemResult[]): number {
  return results.filter((result) => SETTLED_STATES.has(result.state)).length;
}
function pendingCount(results: readonly DraftItemResult[]): number {
  return results.filter((result) => result.state === "pending").length;
}
function reportRun(
  input: JiraChatDraftExecution,
  phase: "progress" | "executed",
  results: readonly DraftItemResult[],
  total: number,
  durationMs: number,
): void {
  input.activity?.({
    phase,
    newDraft: false,
    pageItemCount: 0,
    itemCount: total,
    pageCount: 0,
    byteCount: 0,
    unresolvedRefCount: 0,
    violationCount: 0,
    settledCount: settledCount(results),
    // Before the end, every item not yet looked at counts as still to do.
    pendingCount: phase === "executed" ? pendingCount(results) : total - results.length,
    durationMs,
  });
}

async function runDraft(
  input: JiraChatDraftExecution,
  draft: JiraDraft,
  traces: ReadonlyMap<string, ItemTrace>,
  tally: TraceTally,
): Promise<readonly DraftItemResult[]> {
  const now = input.now ?? Date.now;
  const clock = { now, startedAt: now(), budget: input.budget ?? JIRA_DRAFT_RUN_BUDGET };
  const run: RunState = {
    excluded: excludedJiraDraftRefs(draft, input.deselected),
    keys: new Map<string, string>(),
    pending: new Set<string>(),
    halted: false,
    stopped: false,
    firstWriteAt: undefined,
    attempted: 0,
  };
  const results: DraftItemResult[] = [];
  for (const item of draft.items) {
    run.stopped ||= timeIsUp(run, clock);
    const blocked = blockedState(item, run);
    // Each item needs the keys its earlier items received; the journal admits one effect at a time.
    const settled: DraftItemResult =
      blocked === undefined
        ? await runItem(input, item, run.keys, traces.get(item.ref), tally) // NOSONAR typescript:S9382 -- dependency order
        : { ref: item.ref, state: blocked };
    noteSettled(run, settled, now);
    results.push(settled);
    if (blocked === undefined) run.attempted++;
    if (blocked === undefined && run.attempted % PROGRESS_EVERY === 0)
      reportRun(input, "progress", results, draft.items.length, now() - clock.startedAt);
  }
  reportRun(input, "executed", results, draft.items.length, now() - clock.startedAt);
  return results;
}
function noteSettled(run: RunState, settled: DraftItemResult, now: () => number): void {
  if (settled.state === "pending") run.pending.add(settled.ref);
  if (settled.issueKey !== undefined) run.keys.set(settled.ref, settled.issueKey);
  if (settled.state === "uncertain") run.halted = true;
  if (settled.state === "created") run.firstWriteAt ??= now();
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
  pending: "pendingCount",
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
    ...(item.trace === undefined ? {} : { trace: item.trace }),
    ...item.detail,
  };
}

/** The fixed words for a run that ran out of time; no count, key or error text is repeated in it. */
export const JIRA_DRAFT_PENDING_GUIDANCE =
  "Not every item was started: the time for this step ran out first. " +
  "Tell the user in plain language how many issues were created and that the rest are not created yet. " +
  "Offer to continue: call jira.draft again with the same draftId and draftDigest; " +
  "issues that already exist are recognised, so nothing is created twice. Do not show this message.";
/** An uncertain item outranks a refused one: the model must stop and tell the user first. */
function draftGuidance(items: readonly DraftItemResult[]): string | undefined {
  if (items.some((item) => item.state === "uncertain")) return JIRA_UNCERTAIN_GUIDANCE;
  if (
    items.some(
      (item) => item.state === "failed" && (item.detail?.fieldErrors ?? item.detail?.messages),
    )
  )
    return JIRA_REJECTED_GUIDANCE;
  return items.some((item) => item.state === "pending") ? JIRA_DRAFT_PENDING_GUIDANCE : undefined;
}

// The tool result is bounded by the catalog (256 KiB, 1,000 rows). A draft whose item rows fit is
// reported item by item; a larger one is reported compactly (#4178): the items that need attention
// as rows, everything created or found as exact key ranges, and the rest by count.
const RESULT_ROWS_BYTES = 150 * 1024;
const RESULT_RANGES_BYTES = 40 * 1024;
interface ProjectedRows {
  readonly rows: readonly CatalogJsonObject[];
  readonly compact: boolean;
  readonly omitted: number;
}
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
/** The leading entries that fit both the byte budget and the catalog's row ceiling. */
function withinBudget<T>(entries: readonly T[], budget: number, ceiling: number): readonly T[] {
  const kept: T[] = [];
  let used = 0;
  for (const entry of entries) {
    used += jsonBytes(entry) + 1;
    if (used > budget || kept.length >= ceiling) break;
    kept.push(entry);
  }
  return kept;
}
function needsRow(item: DraftItemResult): boolean {
  if (item.state === "created" || item.state === "existing") return item.issueKey === undefined;
  return item.state !== "excluded";
}
function projectRows(baseUrl: string, items: readonly DraftItemResult[]): ProjectedRows {
  const all = items.map((item) => projectItem(baseUrl, item));
  const fitting = withinBudget(all, RESULT_ROWS_BYTES, JIRA_DRAFT_RESULT_ROWS_MAX);
  if (fitting.length === all.length) return { rows: all, compact: false, omitted: 0 };
  const attention = items.filter(needsRow).map((item) => projectItem(baseUrl, item));
  const rows = withinBudget(attention, RESULT_ROWS_BYTES, JIRA_DRAFT_RESULT_ROWS_MAX);
  return { rows, compact: true, omitted: attention.length - rows.length };
}
function keyRanges(
  items: readonly DraftItemResult[],
  state: "created" | "existing",
): { readonly ranges: readonly string[]; readonly truncated: boolean } {
  const keys = items.flatMap((item) =>
    item.state === state && item.issueKey !== undefined ? [item.issueKey] : [],
  );
  const all = compactIssueKeys(keys);
  const ranges = withinBudget(all, RESULT_RANGES_BYTES, JIRA_DRAFT_RESULT_ROWS_MAX);
  return { ranges, truncated: ranges.length < all.length };
}
function compactData(
  items: readonly DraftItemResult[],
  projected: ProjectedRows,
): CatalogJsonObject {
  const created = keyRanges(items, "created");
  const existing = keyRanges(items, "existing");
  return {
    compact: true,
    omittedRowCount: projected.omitted,
    createdRanges: [...created.ranges],
    existingRanges: [...existing.ranges],
    ...(created.truncated || existing.truncated ? { rangesTruncated: true } : {}),
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
  // The outcome says whether Jira changed; the call succeeds when every item is settled — created,
  // already existing or deselected — so a rerun that finds everything in place writes nothing and
  // is still no error. An item that did not land (failed, uncertain, skipped, pending) makes it one.
  const complete = items.every((item) => SETTLED_STATES.has(item.state));
  const guidance = draftGuidance(items);
  const projected = projectRows(baseUrl, items);
  return {
    data: {
      outcome,
      ...(guidance === undefined ? {} : { guidance }),
      items: [...projected.rows],
      ...(projected.compact ? compactData(items, projected) : {}),
      ...counts,
    },
    ...(complete ? {} : { isError: true }),
  };
}

interface ResolvedTraces {
  readonly traces: ReadonlyMap<string, ItemTrace>;
  readonly refused: ReadonlyMap<string, Extract<TraceResolution, { ok: false }>>;
}

/** Every item's explicit references, validated up front: nothing is created for a refused draft. */
function resolveItemTraces(
  session: TraceSession | undefined,
  draft: JiraDraft,
  tally: TraceTally,
): ResolvedTraces {
  const traces = new Map<string, ItemTrace>();
  const refused = new Map<string, Extract<TraceResolution, { ok: false }>>();
  for (const item of draft.items) {
    if (item.requirementIds === undefined) continue;
    const resolution: TraceResolution =
      session === undefined
        ? { ok: false, reason: "unavailable", problems: [] }
        : session.resolve(item.requirementIds);
    if (resolution.ok) traces.set(item.ref, resolution.trace);
    else {
      refused.set(item.ref, resolution);
      tallyRefusal(tally, resolution);
    }
  }
  return { traces, refused };
}

function refusedDraft(
  refused: ReadonlyMap<string, Extract<TraceResolution, { ok: false }>>,
): ManagedMcpToolResult {
  const problems = [...refused].flatMap(
    ([ref, resolution]) =>
      (traceRefusalData(resolution, ref).requirementProblems as
        CatalogJsonObject[] | undefined) ?? [{ ref, reference: "", reason: "malformed" }],
  );
  const first = [...refused.values()][0];
  return {
    data: {
      outcome: "rejected",
      reason: "field-validation",
      requirementRefusal: first?.reason ?? "references",
      requirementProblems: problems.slice(0, 32),
      items: [],
    },
    isError: true,
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
  const session = input.openTrace?.();
  const tally = newTally();
  try {
    const resolved = resolveItemTraces(session, draft, tally);
    if (resolved.refused.size > 0) {
      logTrace(input.intent.correlationId, "draft", tally);
      return refusedDraft(resolved.refused);
    }
    const items = await runDraft(input, draft, resolved.traces, tally);
    logTrace(input.intent.correlationId, "draft", tally);
    return draftResult(input.connection.baseUrl, items);
  } finally {
    session?.close();
  }
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
