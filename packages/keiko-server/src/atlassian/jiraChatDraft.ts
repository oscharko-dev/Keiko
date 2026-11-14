import {
  checkJiraDraft,
  excludedJiraDraftRefs,
  executeJiraDraftItem,
  findJiraDraftItem,
  jiraBrowseUrl,
  jiraDraftDependencies,
  jiraTemplateViolationGuidance,
  parseJiraDraft,
  parseRequirementIds,
  type AtlassianHttpBodyPort,
  type JiraDraft,
  type JiraDraftActivity,
  type JiraDraftItem,
  type JiraDraftReadCounts,
  type JiraManagedConnection,
  type JiraTraceOutcome,
  withJiraCreateMetadataMemo,
} from "@oscharko-dev/keiko-connectors";
import {
  JIRA_DRAFT_RESULT_ROWS_MAX,
  type JiraDraftItemState,
  type JiraMutationAttempt,
  type JiraMutationOutcome,
  type JiraMutationResultState,
  type JiraTemplateViolation,
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
import { draftProblemData } from "./jiraChatDraftArguments.js";
import { JIRA_DRAFT_UNLISTED_GUIDANCE, listIssueKeys } from "./jiraDraftKeyRanges.js";
import {
  JIRA_ALREADY_REFUSED_GUIDANCE,
  JIRA_LOCAL_REFUSAL_GUIDANCE,
  JIRA_PERMISSION_GUIDANCE,
  JIRA_REJECTED_GUIDANCE,
  JIRA_UNCERTAIN_GUIDANCE,
} from "./jiraMutationResult.js";
import {
  logTrace,
  newTally,
  tallyOutcome,
  tallyRefusal,
  traceOutcomeData,
  traceRefusalData,
  traceRefusalGuidance,
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
  readonly beforeMutation: (itemRef?: string) => boolean;
  /**
   * The trace of the Chat's Knowledge Pods for this draft (#4179). An item's explicit
   * `requirementIds` are validated before any item is created; an unknown or ambiguous reference
   * refuses the whole draft. Without it an item that names requirements cannot be traced and the
   * draft is refused.
   */
  readonly openTrace?: (() => TraceSession) | undefined;
  /** The immutable source payload covered by this write's source digest. */
  readonly preparedTraces?: ReadonlyMap<string, ItemTrace>;
  /**
   * Reports the untraced-draft refusal while the Chat's Pods hold requirements; its return value
   * never decides admission. The runtime omits this notification only for the exact draft a human
   * has actually approved through the existing review owner. Repetition never acknowledges it.
   */
  readonly adviseUntraced?: ((refs: readonly string[]) => void) | undefined;
  /** Body-free progress and end-of-run counts for the Activity Log. */
  readonly activity?: ((activity: JiraDraftActivity) => void) | undefined;
  readonly now?: (() => number) | undefined;
  /** Pure bounded receipt snapshot for this invocation's existing parent transcript. */
  readonly retainProgress?: ((snapshot: () => CatalogJsonObject) => void) | undefined;
  /** Test seam: how long a run may create, and how long it may take in all. */
  readonly budget?: JiraDraftRunBudget | undefined;
  /**
   * Owned by the run: the Jira GETs its items sent and the metadata GETs answered once for all
   * items of this invocation. Supplied by `runDraft`; callers leave it unset.
   */
  readonly createReads?: JiraDraftReadCounts | undefined;
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

export interface DraftItemResult {
  readonly ref: string;
  readonly state: JiraDraftItemState;
  readonly issueKey?: string;
  readonly detail?: CatalogJsonObject;
  /**
   * Who refused a failed item, a closed fact taken from the instruction its own result carries (#4357
   * AC3): Jira's error document or permission, or Keiko's own check before the item was sent. Never
   * projected into a row.
   */
  readonly refusedBy?: "jira" | "keiko";
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
  "unchanged",
  "violations",
  "replayed",
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
/**
 * A refusal that names an issue (an existing item still missing links) keeps its key: the issue
 * exists, so its dependents proceed and the model repairs it instead of creating it again.
 */
function failedItem(ref: string, result: ManagedMcpToolResult): DraftItemResult {
  const issueKey = keyOf(result.data.issueKey);
  const guidance = result.data.guidance;
  return {
    ref,
    state: "failed",
    ...(issueKey === undefined ? {} : { issueKey }),
    detail: failureDetail(result.data),
    refusedBy:
      guidance === JIRA_REJECTED_GUIDANCE || guidance === JIRA_PERMISSION_GUIDANCE
        ? "jira"
        : "keiko",
  };
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
  if (outcome === "rejected" || outcome === "not-dispatched") return failedItem(ref, result);
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
  tallyOutcome(tally, traced, trace);
  const data = traceOutcomeData(traced);
  return data === undefined ? settled : { ...settled, trace: data };
}

/** The item's connection: batch-wide create metadata is read once per invocation, the rest live. */
function createConnection(
  input: JiraChatDraftExecution,
  http: AtlassianHttpBodyPort,
): JiraManagedConnection {
  const connection = { ...input.connection, http };
  return input.createReads === undefined
    ? connection
    : withJiraCreateMetadataMemo(
        connection,
        input.context,
        input.httpPortFactory,
        input.createReads,
      );
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
    beforeMutation: () => input.beforeMutation(item.ref),
    execute: async (http) => {
      attempt = await executeJiraDraftItem(
        item,
        keys,
        input.context,
        createConnection(input, http),
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
    ...(input.createReads === undefined
      ? {}
      : { readCount: input.createReads.made, readReusedCount: input.createReads.reused }),
    durationMs,
  });
}

/** An item that waits for others: the refs among them that have no key, so the model sees why. */
function skippedItem(item: JiraDraftItem, keys: ReadonlyMap<string, string>): DraftItemResult {
  const blockedBy = jiraDraftDependencies(item).filter((ref) => !keys.has(ref));
  return {
    ref: item.ref,
    state: "skipped",
    ...(blockedBy.length === 0 ? {} : { detail: { blockedBy } }),
  };
}
function blockedItem(
  item: JiraDraftItem,
  state: JiraDraftItemState,
  keys: ReadonlyMap<string, string>,
): DraftItemResult {
  return state === "skipped" ? skippedItem(item, keys) : { ref: item.ref, state };
}

interface DraftAcknowledgement {
  acknowledgement: DraftItemResult | undefined;
}
function retainDraftProgress(
  input: JiraChatDraftExecution,
  draft: JiraDraft,
  results: readonly DraftItemResult[],
  current: DraftAcknowledgement,
  excluded: ReadonlySet<string>,
): void {
  input.retainProgress?.(
    () =>
      draftResult(input.connection.baseUrl, [
        ...results,
        ...draft.items
          .slice(results.length)
          .map((item, index): DraftItemResult =>
            index === 0 && current.acknowledgement !== undefined
              ? current.acknowledgement
              : { ref: item.ref, state: excluded.has(item.ref) ? "excluded" : "pending" },
          ),
      ]).data,
  );
}
function acknowledgingInput(
  input: JiraChatDraftExecution,
  item: JiraDraftItem,
  current: DraftAcknowledgement,
): JiraChatDraftExecution {
  return {
    ...input,
    connection: {
      ...input.connection,
      onCreatedIssueAcknowledged: (issueKey): void => {
        current.acknowledgement = { ref: item.ref, state: "uncertain", issueKey };
      },
    },
  };
}

interface DraftExecutionRun {
  readonly input: JiraChatDraftExecution;
  readonly draft: JiraDraft;
  readonly traces: ReadonlyMap<string, ItemTrace>;
  readonly tally: TraceTally;
  readonly run: RunState;
  readonly clock: Parameters<typeof timeIsUp>[1];
  readonly current: DraftAcknowledgement;
  readonly results: DraftItemResult[];
}

function retainDraftItem(
  state: DraftExecutionRun,
  settled: DraftItemResult,
  attempted: boolean,
): void {
  const { input, draft, run, clock, current, results } = state;
  // A valid 201/key remains known even when its read-back is interrupted.
  const retained = withAcknowledgedKey(settled, current.acknowledgement);
  noteSettled(run, retained, clock.now);
  results.push(retained);
  current.acknowledgement = undefined;
  if (attempted) run.attempted++;
  if (attempted && run.attempted % PROGRESS_EVERY === 0)
    reportRun(input, "progress", results, draft.items.length, clock.now() - clock.startedAt);
}

function advanceDraftRun(
  state: DraftExecutionRun,
  items: Iterator<JiraDraftItem>,
): Promise<boolean> | false {
  const { input, run, clock, current, traces, tally } = state;
  let next = items.next();
  while (!next.done) {
    const item = next.value;
    current.acknowledgement = undefined;
    run.stopped ||= timeIsUp(run, clock);
    const blocked = blockedState(item, run);
    if (blocked === undefined) {
      return runItem(
        acknowledgingInput(input, item, current),
        item,
        run.keys,
        traces.get(item.ref),
        tally,
      ).then((settled) => {
        retainDraftItem(state, settled, true);
        return true;
      });
    }
    retainDraftItem(state, blockedItem(item, blocked, run.keys), false);
    next = items.next();
  }
  return false;
}

function drainDraftRun(state: DraftExecutionRun): Promise<void> {
  const items = state.draft.items.values();
  return new Promise<void>((resolve, reject) => {
    // Each step finishes before the next starts. The void callback does not link the next
    // step's promise to the previous one, so long drafts retain no growing promise chain.
    const next = (): void => {
      void Promise.resolve()
        .then(() => advanceDraftRun(state, items))
        .then((more) => {
          if (more) next();
          else resolve();
        }, reject);
    };
    next();
  });
}

async function runDraft(
  callerInput: JiraChatDraftExecution,
  draft: JiraDraft,
  traces: ReadonlyMap<string, ItemTrace>,
  tally: TraceTally,
  excluded: ReadonlySet<string>,
): Promise<readonly DraftItemResult[]> {
  // One invocation, one set of create metadata reads; a new run always starts empty.
  const input: JiraChatDraftExecution = { ...callerInput, createReads: { made: 0, reused: 0 } };
  const now = input.now ?? Date.now;
  const clock = { now, startedAt: now(), budget: input.budget ?? JIRA_DRAFT_RUN_BUDGET };
  const run: RunState = {
    excluded,
    keys: new Map<string, string>(),
    pending: new Set<string>(),
    halted: false,
    stopped: false,
    firstWriteAt: undefined,
    attempted: 0,
  };
  const results: DraftItemResult[] = [];
  const current: DraftAcknowledgement = { acknowledgement: undefined };
  retainDraftProgress(input, draft, results, current, excluded);
  await drainDraftRun({ input, draft, traces, tally, run, clock, current, results });
  reportRun(input, "executed", results, draft.items.length, now() - clock.startedAt);
  return results;
}
function withAcknowledgedKey(
  settled: DraftItemResult,
  known: DraftItemResult | undefined,
): DraftItemResult {
  return known?.issueKey !== undefined && settled.issueKey === undefined
    ? { ...settled, state: "uncertain", issueKey: known.issueKey }
    : settled;
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
/**
 * A rerun that finds every issue already in Jira writes nothing (`not-dispatched`); without this the
 * model read that outcome as a failure and created the issues again one by one (S19, #4178). A
 * later request for other issues must not resume this finished draft: committing it again only
 * reconciles its own items, so the words name the way to a new draft.
 */
export const JIRA_DRAFT_EXISTING_GUIDANCE =
  "Every item already exists in Jira and was recognised, so nothing was created and nothing is missing. " +
  "Report the existing keys as the result. Do not create these issues again with jira.create. " +
  "This draft is complete: issues it does not contain need a new draft, so call jira.draft with items and without draftId. " +
  "Do not show this message.";
/**
 * Jira refused some items while others are in Jira: "nothing was changed" would be false, so the
 * words name both and scope the correction to the refused items (#4178).
 */
export const JIRA_DRAFT_PARTLY_REJECTED_GUIDANCE =
  "Jira refused the items marked failed; the items with an issueKey are in Jira. " +
  "Correct the fields named in each failed item's fieldErrors or messages, then send the corrected draft once: " +
  "issues already in Jira are recognised, so nothing is created twice. " +
  "Tell the user in plain language which issues were created and which item Jira refused and why.";
/** What failed items without Jira's own words need: why, or that the same request cannot help. */
function refusedAgainGuidance(failed: readonly DraftItemResult[]): string | undefined {
  if (failed.some((item) => item.detail?.replayed === true)) return JIRA_ALREADY_REFUSED_GUIDANCE;
  return jiraTemplateViolationGuidance(
    failed.flatMap(
      (item) => (item.detail?.violations ?? []) as unknown as readonly JiraTemplateViolation[],
    ),
  );
}
/**
 * Keiko refused some items marked failed before sending them, and Jira refused others: neither
 * "Jira refused" nor "Keiko refused" alone would be true of the draft (#4357 AC3).
 */
export const JIRA_DRAFT_MIXED_REFUSAL_GUIDANCE =
  "Some items marked failed were refused by Keiko before sending them and some by Jira; the items with an issueKey, if any, are in Jira. " +
  "Do what each failed item's fieldErrors or messages say, then send the corrected draft once: " +
  "issues already in Jira are recognised, so nothing is created twice. " +
  "Tell the user in plain language what was created, if anything, and which item was refused and why.";
/** Keiko's own checks refused the failed items while others were created. */
export const JIRA_DRAFT_PARTLY_LOCAL_REFUSAL_GUIDANCE =
  "Keiko refused the items marked failed before sending them; the items with an issueKey are in Jira. " +
  "Do what each failed item's messages say, then send the corrected draft once: " +
  "issues already in Jira are recognised, so nothing is created twice. " +
  "Tell the user in plain language which issues were created and which item was refused and why.";
/** The words for failed items that carry an explanation, by who refused them. */
function explainedDraftGuidance(
  items: readonly DraftItemResult[],
  explained: readonly DraftItemResult[],
): string {
  const created = items.some((item) => item.issueKey !== undefined);
  const jira = explained.some((item) => item.refusedBy === "jira");
  const keiko = explained.some((item) => item.refusedBy !== "jira");
  if (jira && keiko) return JIRA_DRAFT_MIXED_REFUSAL_GUIDANCE;
  if (jira) return created ? JIRA_DRAFT_PARTLY_REJECTED_GUIDANCE : JIRA_REJECTED_GUIDANCE;
  return created ? JIRA_DRAFT_PARTLY_LOCAL_REFUSAL_GUIDANCE : JIRA_LOCAL_REFUSAL_GUIDANCE;
}
/** An uncertain item outranks a refused one: the model must stop and tell the user first. */
export function jiraDraftGuidance(items: readonly DraftItemResult[]): string | undefined {
  if (items.some((item) => item.state === "uncertain")) return JIRA_UNCERTAIN_GUIDANCE;
  const failed = items.filter((item) => item.state === "failed");
  const explained = failed.filter((item) => item.detail?.fieldErrors ?? item.detail?.messages);
  if (explained.length > 0) return explainedDraftGuidance(items, explained);
  const refused = refusedAgainGuidance(failed);
  if (refused !== undefined) return refused;
  if (items.some((item) => item.state === "pending")) return JIRA_DRAFT_PENDING_GUIDANCE;
  const reconciledOnly =
    items.some((item) => item.state === "existing") &&
    items.every((item) => item.state === "existing" || item.state === "excluded");
  return reconciledOnly ? JIRA_DRAFT_EXISTING_GUIDANCE : undefined;
}

// The tool result is bounded by the catalog (256 KiB, 1,000 rows). A draft whose item rows fit is
// reported item by item; a larger one is reported compactly (#4178): the items that need attention
// as rows, everything created or found as exact key ranges, and the rest by count.
const RESULT_ROWS_BYTES = 150 * 1024;
// What the result's key lists may use: the catalog's byte bound less the counts, guidance and
// envelope, and less the rows already reported. A list that still does not fit says so (below).
const RESULT_DATA_BYTES = 250 * 1024;
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
function keysOf(items: readonly DraftItemResult[], state: "created" | "existing"): string[] {
  return items.flatMap((item) =>
    item.state === state && item.issueKey !== undefined ? [item.issueKey] : [],
  );
}
/**
 * The browse prefix every listed key shares (`https://jira.example/browse/`): the compact lists carry
 * keys without rows, so the viewer links them as prefix plus key. Never stored in activity evidence.
 */
function browsePrefix(baseUrl: string): string | undefined {
  const probe = jiraBrowseUrl(baseUrl, "KEIKO-1");
  return probe?.endsWith("KEIKO-1") === true ? probe.slice(0, -"KEIKO-1".length) : undefined;
}
function compactData(
  baseUrl: string,
  items: readonly DraftItemResult[],
  projected: ProjectedRows,
): CatalogJsonObject {
  const listed = listIssueKeys(
    { created: keysOf(items, "created"), existing: keysOf(items, "existing") },
    RESULT_DATA_BYTES - jsonBytes(projected.rows),
    JIRA_DRAFT_RESULT_ROWS_MAX,
  );
  const prefix = browsePrefix(baseUrl);
  return {
    compact: true,
    ...(prefix === undefined ? {} : { browseUrlPrefix: prefix }),
    omittedRowCount: projected.omitted,
    createdRanges: listed.created.map((entry) => entry.text),
    existingRanges: listed.existing.map((entry) => entry.text),
    ...(listed.unlisted === 0 ? {} : { rangesTruncated: true, unlistedKeyCount: listed.unlisted }),
  };
}
export function draftResult(
  baseUrl: string,
  items: readonly DraftItemResult[],
): ManagedMcpToolResult {
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
  const projected = projectRows(baseUrl, items);
  const compact = projected.compact ? compactData(baseUrl, items, projected) : {};
  const guidance =
    jiraDraftGuidance(items) ??
    (compact.rangesTruncated === true ? JIRA_DRAFT_UNLISTED_GUIDANCE : undefined);
  return {
    data: {
      outcome,
      ...(guidance === undefined ? {} : { guidance }),
      items: [...projected.rows],
      ...compact,
      ...counts,
    },
    ...(complete ? {} : { isError: true }),
  };
}

interface ResolvedTraces {
  readonly traces: ReadonlyMap<string, ItemTrace>;
  readonly refused: ReadonlyMap<string, Extract<TraceResolution, { ok: false }>>;
}

/**
 * The explicit references of every item that can still run, validated up front: nothing is created
 * for a refused draft. An item the human deselected, or that hangs from one, never runs, so a
 * reference it names cannot refuse the items that do.
 */
function draftItemDescription(item: object): unknown {
  const fields = "fields" in item ? item.fields : undefined;
  return fields !== null && typeof fields === "object" && "description" in fields
    ? fields.description
    : undefined;
}
function resolveDraftItemTrace(
  session: TraceSession | undefined,
  item: object,
): TraceResolution | undefined {
  const references = parseRequirementIds(
    "requirementIds" in item ? item.requirementIds : undefined,
  );
  if (references === null) return undefined;
  if (references === undefined)
    return { ok: false, reason: "references", problems: [{ reference: "", reason: "malformed" }] };
  if (session === undefined) return { ok: false, reason: "unavailable", problems: [] };
  return session.resolve(references, { description: draftItemDescription(item) });
}

function resolveItemTraces(
  session: TraceSession | undefined,
  draft: { readonly items: readonly object[] },
  tally: TraceTally,
  excluded: ReadonlySet<string>,
): ResolvedTraces {
  const traces = new Map<string, ItemTrace>();
  const refused = new Map<string, Extract<TraceResolution, { ok: false }>>();
  for (const item of draft.items) {
    const ref = "ref" in item && typeof item.ref === "string" ? item.ref : "";
    if (excluded.has(ref)) continue;
    const resolution = resolveDraftItemTrace(session, item);
    if (resolution === undefined) continue;
    if (resolution.ok) traces.set(ref, resolution.trace);
    else {
      refused.set(ref, resolution);
      tallyRefusal(tally, resolution);
    }
  }
  return { traces, refused };
}

/**
 * The words for a draft created in a Chat that holds requirements while no item names one. Without
 * a reference the issues carry no source trace, and later requirement changes cannot reach them.
 */
export const JIRA_DRAFT_UNTRACED_GUIDANCE =
  "Nothing was created. This Chat holds requirements but this draft has no requirementIds. " +
  "Read knowledge.requirements, put applicable references in requirementIds beside fields, and copy their criteria verbatim into fields.description. Stage the corrected traced draft. " +
  "For an intentionally unrelated draft, show the missing-trace warning and obtain explicit human approval of this exact draft through the existing review control. " +
  "Repeating the call never confirms this choice.";

/** No item that can run names a requirement. */
function untracedRun(draft: JiraDraft, excluded: ReadonlySet<string>): boolean {
  const runnable = draft.items.filter((item) => !excluded.has(item.ref));
  return runnable.length > 0 && runnable.every((item) => item.requirementIds === undefined);
}

function untracedDraft(): ManagedMcpToolResult {
  return {
    data: {
      outcome: "rejected",
      reason: "field-validation",
      requirementRefusal: "untraced",
      guidance: JIRA_DRAFT_UNTRACED_GUIDANCE,
      items: [],
    },
    isError: true,
  };
}

/** The refusal applies while the Chat's Pods hold requirements and the draft remains untraced. */
function advisesUntraced(
  input: JiraChatDraftExecution,
  session: TraceSession | undefined,
  draft: JiraDraft,
  excluded: ReadonlySet<string>,
): boolean {
  if (input.adviseUntraced === undefined || session === undefined) return false;
  if (!untracedRun(draft, excluded) || session.unitCount() === 0) return false;
  input.adviseUntraced(draft.items.map((item) => item.ref));
  return true;
}

/**
 * The same advice for a draft about to be put before a human (S05 of #4173), where it can still
 * change what the human reviews. Undefined when nothing needs saying.
 */
export function jiraDraftUntracedAdvice(
  draftArguments: CatalogJsonObject,
  openTrace: () => TraceSession,
  adviseUntraced: (refs: readonly string[]) => void,
): CatalogJsonObject | undefined {
  const draft = parseJiraDraft(draftArguments);
  if (draft === undefined || !untracedRun(draft, new Set())) return undefined;
  const session = openTrace();
  try {
    if (session.unitCount() > 0) {
      adviseUntraced(draft.items.map((item) => item.ref));
      return untracedDraft().data;
    }
    return undefined;
  } finally {
    session.close();
  }
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
  const guidance = [...refused.values()]
    .map((resolution) => traceRefusalGuidance(resolution))
    .find((value) => value !== undefined);
  return {
    data: {
      outcome: "rejected",
      reason: "field-validation",
      requirementRefusal: first?.reason ?? "references",
      ...(guidance === undefined ? {} : { guidance }),
      requirementProblems: problems.slice(0, 32),
      items: [],
    },
    isError: true,
  };
}

/** Same immutable source criteria before staging, human approval and final draft execution. */
export function jiraDraftRequirementRefusal(
  items: readonly object[],
  openTrace: (() => TraceSession) | undefined,
  correlationId: string,
): { readonly data: CatalogJsonObject; readonly violationCount: number } | undefined {
  const session = openTrace?.();
  const tally = newTally();
  try {
    const resolved = resolveItemTraces(session, { items }, tally, new Set());
    if (resolved.refused.size === 0) return undefined;
    logTrace(correlationId, "draft", tally);
    return { data: refusedDraft(resolved.refused).data, violationCount: tally.problems };
  } finally {
    session?.close();
  }
}

export async function executeJiraChatDraft(
  input: JiraChatDraftExecution,
): Promise<ManagedMcpToolResult> {
  const checked = checkJiraDraft(input.arguments);
  if (!checked.ok)
    return {
      data: {
        outcome: "rejected",
        reason: "field-validation",
        ...draftProblemData(checked.problem, checked.item),
        items: [],
      },
      isError: true,
    };
  const { draft } = checked;
  const session = input.openTrace?.();
  const tally = newTally();
  try {
    const excluded = excludedJiraDraftRefs(draft, input.deselected);
    const resolved =
      input.preparedTraces === undefined
        ? resolveItemTraces(session, draft, tally, excluded)
        : {
            traces: input.preparedTraces,
            refused: new Map<string, Extract<TraceResolution, { ok: false }>>(),
          };
    if (resolved.refused.size > 0) {
      logTrace(input.intent.correlationId, "draft", tally);
      return refusedDraft(resolved.refused);
    }
    if (advisesUntraced(input, session, draft, excluded)) return untracedDraft();
    const items = await runDraft(input, draft, resolved.traces, tally, excluded);
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
  return jiraDraftOutcome(records.map((record) => observedChatToolMutationOutcome(record)));
}
