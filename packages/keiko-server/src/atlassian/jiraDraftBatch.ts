import type { ChatToolBatchProgress } from "@oscharko-dev/keiko-contracts/bff-wire";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { criteriaFitDescription } from "./jiraDraftBatchDescription.js";
import {
  draftPageSize,
  exhaustedItemTokens,
  initialItemTokens,
  itemsWithinInput,
  measuredItemTokens,
  splitPage,
} from "./jiraDraftBatchPlan.js";
import {
  draftItem,
  entryPromptChars,
  fillMessages,
  fillOverheadChars,
  outlineLine,
  outlineMessages,
  parseOutline,
  parsePage,
  type DraftBatchEntry,
  type DraftBatchInstructions,
  type DraftBatchMessage,
  type DraftBatchRequirement,
  type DraftItemPlacement,
  type WrittenDraftItem,
} from "./jiraDraftBatchPrompt.js";

// A Keiko-driven draft batch (#4173): Keiko reads every selected requirement itself, plans the
// issues (one per requirement, or groups the model proposes), and drafts them page by page into one
// staged backlog draft. Each page is sized from the model's output budget and the measured cost of
// the previous pages; a page that runs out of output or is refused twice is split, and a single
// issue that still fails is reported, never dropped silently. The same draft then goes through the
// existing jira.draft approval, so nothing here writes to Jira.

export type DraftBatchGeneration =
  | { readonly kind: "text"; readonly text: string; readonly completionTokens?: number | undefined }
  | { readonly kind: "exhausted" };

export type DraftBatchStageOutcome =
  | {
      readonly kind: "staged";
      readonly draftId: string;
      readonly draftDigest: string;
      readonly itemCount: number;
      readonly pageCount: number;
    }
  /**
   * The page is wrong in content: the guidance says what to correct. `owner` says who can correct
   * it: the model (wording, sections, model fields) or Keiko (trace, criteria, labels, parent,
   * requirement references), which no new model answer can change. Absent means the model.
   */
  | {
      readonly kind: "rejected";
      readonly guidance: string;
      readonly owner?: "model" | "keiko" | undefined;
    }
  /**
   * The draft itself cannot continue (changed connection, size limit, unknown draft). A transient
   * one may succeed when staged again.
   */
  | {
      readonly kind: "fatal";
      readonly reason: string;
      readonly transient?: boolean | undefined;
      readonly error?: unknown;
    };

/** Body-free facts for the Activity Log: counts and closed outcomes only. */
export type DraftBatchObservation =
  | {
      readonly kind: "outline";
      readonly outcome: "grouped" | "exhausted" | "unassigned";
      readonly requirementCount: number;
      readonly groupCount: number;
    }
  | {
      readonly kind: "page";
      readonly outcome:
        "staged" | "exhausted" | "corrected" | "refused" | "split" | "failed" | "too-large";
      readonly itemCount: number;
      readonly plannedItemTokens: number;
      readonly completionTokens?: number | undefined;
    };

export interface DraftBatchPorts {
  readonly generate: (
    messages: readonly DraftBatchMessage[],
    purpose: "outline" | "fill",
  ) => Promise<DraftBatchGeneration>;
  readonly stage: (
    items: readonly CatalogJsonObject[],
    draftId: string | undefined,
  ) => Promise<DraftBatchStageOutcome>;
  readonly progress: (progress: ChatToolBatchProgress) => void;
  readonly observe: (observation: DraftBatchObservation) => void;
  readonly signal: AbortSignal;
  /** The invocation's clock and hard deadline; absent means no deadline to respect. */
  readonly budget?: { readonly nowMs: () => number; readonly deadlineAtMs: number } | undefined;
  /** Model calls the accepted turn still allows; read before each call. Absent means unbounded. */
  readonly remainingCalls?: (() => number) | undefined;
}

export interface DraftBatchInput {
  readonly requirements: readonly DraftBatchRequirement[];
  readonly granularity: "per-requirement" | "grouped";
  readonly instructions: DraftBatchInstructions;
  readonly placement: DraftItemPlacement;
  readonly maxOutputTokens: number;
  /** The model's prompt budget when known; pages and grouping chunks are sized by it too. */
  readonly maxInputTokens?: number | undefined;
  /** Draft refs are `<refPrefix><n>`; a fresh prefix per batch keeps appended refs unique. */
  readonly refPrefix: string;
  /** Appends to an existing draft of the same Chat. */
  readonly draftId?: string | undefined;
  /** Replaces the computed model-call allowance; a safety net that tests can lower. */
  readonly maxCalls?: number | undefined;
}

export type DraftBatchStopReason =
  "no-requirements" | "stage-failed" | "call-limit" | "model-failed" | "deadline";

export interface DraftBatchResult {
  readonly progress: ChatToolBatchProgress;
  readonly draftId?: string | undefined;
  readonly draftDigest?: string | undefined;
  readonly itemCount: number;
  readonly pageCount: number;
  readonly failedRequirementRefs: readonly string[];
  /** Requirements the batch had not begun when the deadline stopped it; a new call drafts them. */
  readonly deferredRequirementRefs: readonly string[];
  readonly stopReason?: DraftBatchStopReason | undefined;
  /** The error that stopped the batch (`model-failed`, `stage-failed`), for the failure line. */
  readonly error?: unknown;
  /** Planned issues whose verbatim criteria alone exceed the description limit. */
  readonly tooLargeCount: number;
}

/** A batch never makes more model calls than this per requirement, plus the grouping calls. */
const CALLS_PER_ENTRY = 4;
const OUTLINE_CALLS = 16;

class BatchState {
  draftId: string | undefined;
  draftDigest: string | undefined;
  itemCount = 0;
  pageCount = 0;
  calls = 0;
  itemTokens: number;
  tooLargeCount = 0;
  /** The slowest page so far, retries included: the estimate of the next one. */
  slowestPageMs = 0;
  /** The slowest single model call so far: the estimate before any page has run. */
  slowestCallMs = 0;
  error: unknown;
  readonly drafted = new Set<string>();
  readonly failed: DraftBatchEntry[] = [];
  /** What the model wrote for each planned issue, kept until it is staged or given up. */
  readonly written = new Map<string, WrittenDraftItem>();
  /** Summaries taken in this draft, by lower-case text, so two issues never share one. */
  readonly summaries = new Map<string, string>();
  readonly fillOverheadChars: number;
  entries: readonly DraftBatchEntry[] = [];
  stopReason: DraftBatchStopReason | undefined;

  constructor(readonly input: DraftBatchInput) {
    this.draftId = input.draftId;
    this.itemTokens = initialItemTokens(input.instructions);
    this.fillOverheadChars = fillOverheadChars(input.instructions);
  }
  /** Bounded by the selected requirements, so grouping hundreds of them is never cut short. */
  get callLimit(): number {
    if (this.input.maxCalls !== undefined) return this.input.maxCalls;
    const planned = Math.max(1, this.entries.length, this.input.requirements.length);
    return OUTLINE_CALLS + CALLS_PER_ENTRY * planned;
  }
  progress(phase: ChatToolBatchProgress["phase"]): ChatToolBatchProgress {
    const covered = new Set<string>();
    for (const entry of this.entries)
      if (this.drafted.has(entry.ref)) entry.requirements.forEach((item) => covered.add(item.ref));
    return {
      phase,
      draftedCount: this.drafted.size,
      plannedCount: this.entries.length,
      coveredRequirementCount: covered.size,
      requirementCount: this.input.requirements.length,
      failedCount: this.failed.length,
    };
  }
}

function refFor(state: BatchState, index: number): string {
  return `${state.input.refPrefix}${String(index + 1)}`;
}

function perRequirementEntries(state: BatchState): readonly DraftBatchEntry[] {
  return state.input.requirements.map((requirement, index) => ({
    ref: refFor(state, index),
    hint: requirement.title,
    requirements: [requirement],
  }));
}

/** One model call, its duration kept as the estimate of the next one. */
async function timedGenerate(
  state: BatchState,
  ports: DraftBatchPorts,
  messages: readonly DraftBatchMessage[],
  purpose: "outline" | "fill",
): Promise<DraftBatchGeneration> {
  const startedAt = ports.budget?.nowMs() ?? 0;
  const generated = await ports.generate(messages, purpose);
  if (ports.budget !== undefined)
    state.slowestCallMs = Math.max(state.slowestCallMs, ports.budget.nowMs() - startedAt);
  return generated;
}

/**
 * One model call. An error that is not a cancellation ends the model work of the batch: nothing
 * more is asked, and what is already staged stays a valid, reported partial result.
 */
async function generate(
  state: BatchState,
  ports: DraftBatchPorts,
  messages: readonly DraftBatchMessage[],
  purpose: "outline" | "fill",
): Promise<DraftBatchGeneration | undefined> {
  ports.signal.throwIfAborted();
  if (state.stopReason === "model-failed") return undefined;
  if (state.calls >= state.callLimit || (ports.remainingCalls?.() ?? 1) <= 0) {
    state.stopReason = "call-limit";
    return undefined;
  }
  state.calls += 1;
  try {
    return await timedGenerate(state, ports, messages, purpose);
  } catch (error) {
    if (ports.signal.aborted) throw error;
    state.stopReason = "model-failed";
    state.error = error;
    return undefined;
  }
}

interface OutlineGroup {
  readonly summary: string;
  readonly requirements: readonly DraftBatchRequirement[];
}

interface OutlineStep {
  readonly groups: readonly OutlineGroup[];
  /** Halves of a chunk whose grouping ran out of output. */
  readonly halves?: readonly (readonly DraftBatchRequirement[])[] | undefined;
  /** Requirements the answer left out. */
  readonly unassigned?: readonly DraftBatchRequirement[] | undefined;
}

function singleGroup(requirement: DraftBatchRequirement): OutlineGroup {
  return { summary: requirement.title, requirements: [requirement] };
}

function outlineGroups(
  text: string,
  chunk: readonly DraftBatchRequirement[],
): readonly OutlineGroup[] {
  const byRef = new Map(chunk.map((item) => [item.ref, item]));
  return parseOutline(text, chunk).map((group) => ({
    summary: group.summary,
    requirements: group.refs.flatMap((ref) => byRef.get(ref) ?? []),
  }));
}

/** Groups one chunk; a chunk that runs out of output is halved, a lone requirement stays alone. */
async function outlineChunk(
  state: BatchState,
  ports: DraftBatchPorts,
  chunk: readonly DraftBatchRequirement[],
): Promise<OutlineStep> {
  const messages = outlineMessages(chunk, state.input.instructions);
  const generated = await generate(state, ports, messages, "outline");
  if (generated === undefined) return { groups: chunk.map(singleGroup) };
  const observed = { requirementCount: chunk.length };
  if (generated.kind === "exhausted") {
    ports.observe({ kind: "outline", outcome: "exhausted", ...observed, groupCount: 0 });
    return chunk.length === 1
      ? { groups: chunk.map(singleGroup) }
      : { groups: [], halves: splitPage(chunk) };
  }
  const groups = outlineGroups(generated.text, chunk);
  const assigned = new Set(groups.flatMap((group) => group.requirements.map((item) => item.ref)));
  const unassigned = chunk.filter((item) => !assigned.has(item.ref));
  const outcome = unassigned.length === 0 ? "grouped" : "unassigned";
  ports.observe({ kind: "outline", outcome, ...observed, groupCount: groups.length });
  return { groups, unassigned };
}

interface OutlineChunk {
  readonly chunk: readonly DraftBatchRequirement[];
  /**
   * The chunk is what an earlier answer left out without grouping anything; left out again, each
   * becomes its own issue.
   */
  readonly retried: boolean;
}

/** The first grouping chunks: as many requirements as one prompt of the model's window holds. */
function firstOutlineChunks(state: BatchState): readonly OutlineChunk[] {
  const { requirements, instructions, maxInputTokens } = state.input;
  const overhead = outlineMessages([], instructions).reduce(
    (sum, message) => sum + message.content.length,
    0,
  );
  const chunks: OutlineChunk[] = [];
  for (let rest = requirements; rest.length > 0;) {
    const take = itemsWithinInput(
      maxInputTokens,
      overhead,
      rest.map((item) => outlineLine(item).length + 1),
    );
    chunks.push({ chunk: rest.slice(0, take), retried: false });
    rest = rest.slice(take);
  }
  return chunks;
}

/**
 * Every selected requirement lands in exactly one planned issue: the model proposes groups, and
 * what it leaves out is asked for again while each answer still groups something, because every
 * such round shrinks the chunk. An answer that groups nothing is asked once more, then each
 * requirement left becomes an issue of its own.
 */
async function groupedEntries(
  state: BatchState,
  ports: DraftBatchPorts,
): Promise<readonly DraftBatchEntry[]> {
  const groups: OutlineGroup[] = [];
  const pending: OutlineChunk[] = [...firstOutlineChunks(state)];
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    if (!fitsDeadline(state, ports)) {
      // No time for another grouping call: what is left becomes one issue each, drafted later.
      state.stopReason = "deadline";
      groups.push(...[next, ...pending].flatMap((chunk) => chunk.chunk.map(singleGroup)));
      break;
    }
    const step = await outlineChunk(state, ports, next.chunk); // NOSONAR typescript:S9382 -- each answer decides what is asked next and spends the shared deadline
    groups.push(...step.groups);
    for (const half of step.halves ?? []) pending.push({ chunk: half, retried: next.retried });
    const unassigned = step.unassigned ?? [];
    if (unassigned.length === 0) continue;
    if (step.groups.length > 0) pending.push({ chunk: unassigned, retried: false });
    else if (next.retried) groups.push(...unassigned.map(singleGroup));
    else pending.push({ chunk: unassigned, retried: true });
  }
  return groups.map((group, index) => ({
    ref: refFor(state, index),
    hint: group.summary,
    requirements: group.requirements,
  }));
}

type Pages = readonly (readonly DraftBatchEntry[])[];

type PageOutcome =
  | { readonly kind: "staged" }
  | { readonly kind: "exhausted" }
  | { readonly kind: "refused" }
  /** Keiko staged what it could; the pages left need a new model answer. */
  | { readonly kind: "redo"; readonly pages: Pages }
  | { readonly kind: "stopped" };

function recordStaged(
  state: BatchState,
  page: readonly DraftBatchEntry[],
  staged: Extract<DraftBatchStageOutcome, { kind: "staged" }>,
): void {
  state.draftId = staged.draftId;
  state.draftDigest = staged.draftDigest;
  state.itemCount = staged.itemCount;
  state.pageCount = staged.pageCount;
  page.forEach((entry) => {
    state.drafted.add(entry.ref);
    state.written.delete(entry.ref);
  });
}

const SUMMARY_CHARS_MAX = 255;

function compactIds(entry: DraftBatchEntry): string {
  const ids = entry.requirements.map((item) => item.ref.slice(item.ref.lastIndexOf(":") + 1));
  return ids.length > 3 ? `${ids.slice(0, 3).join(", ")}, …` : ids.join(", ");
}

/**
 * Jira refuses a second issue with the summary of a first one after approval, so a summary that is
 * already taken in this draft gets the requirement ids appended, compactly, before it is staged.
 */
function uniqueSummary(state: BatchState, entry: DraftBatchEntry, summary: string): string {
  const free = (text: string): boolean => {
    const owner = state.summaries.get(text.toLowerCase());
    return owner === undefined || owner === entry.ref;
  };
  const fit = (base: string, suffix: string): string =>
    `${base.slice(0, SUMMARY_CHARS_MAX - suffix.length).trimEnd()}${suffix}`;
  let chosen = summary;
  let n = 0;
  while (!free(chosen)) {
    chosen = fit(
      summary,
      n === 0 ? ` (${compactIds(entry)})` : ` (${compactIds(entry)} #${String(n + 1)})`,
    );
    n += 1;
  }
  state.summaries.set(chosen.toLowerCase(), entry.ref);
  return chosen;
}

function stageItems(state: BatchState, page: readonly DraftBatchEntry[]): CatalogJsonObject[] {
  const { instructions, placement } = state.input;
  return page.flatMap((entry) => {
    const written = state.written.get(entry.ref);
    if (written === undefined) return [];
    const summary = uniqueSummary(state, entry, written.summary);
    return [draftItem(entry, { ...written, summary }, instructions, placement)];
  });
}

async function stageOnce(
  state: BatchState,
  ports: DraftBatchPorts,
  page: readonly DraftBatchEntry[],
): Promise<DraftBatchStageOutcome> {
  try {
    return await ports.stage(stageItems(state, page), state.draftId);
  } catch (error) {
    if (ports.signal.aborted) throw error;
    return { kind: "fatal", reason: "stage-error", transient: true, error };
  }
}

/** Stages a page from the cached answers; a transient failure of the draft is tried once more. */
async function stagePage(
  state: BatchState,
  ports: DraftBatchPorts,
  page: readonly DraftBatchEntry[],
): Promise<DraftBatchStageOutcome> {
  const first = await stageOnce(state, ports, page);
  return first.kind === "fatal" && first.transient === true ? stageOnce(state, ports, page) : first;
}

function stopStaging(state: BatchState, outcome: { readonly error?: unknown }): PageOutcome {
  state.stopReason = "stage-failed";
  if (outcome.error !== undefined) state.error = outcome.error;
  return { kind: "stopped" };
}

function failEntries(
  state: BatchState,
  ports: DraftBatchPorts,
  page: readonly DraftBatchEntry[],
): void {
  state.failed.push(...page);
  page.forEach((entry) => state.written.delete(entry.ref));
  ports.observe({
    kind: "page",
    outcome: "failed",
    itemCount: page.length,
    plannedItemTokens: state.itemTokens,
  });
}

/**
 * A rejection no new answer can change (the trace, the criteria, labels, parent): the cached
 * answers are staged again in halves, with no model call, until the one issue Jira's checks refuse
 * is found and reported. An issue the model can still correct goes back to the model alone.
 */
async function bisectPage(
  state: BatchState,
  ports: DraftBatchPorts,
  page: readonly DraftBatchEntry[],
): Promise<PageOutcome> {
  ports.observe({
    kind: "page",
    outcome: "split",
    itemCount: page.length,
    plannedItemTokens: state.itemTokens,
  });
  const redo: (readonly DraftBatchEntry[])[] = [];
  const stack: (readonly DraftBatchEntry[])[] = [...splitPage(page)].reverse();
  for (let part = stack.pop(); part !== undefined; part = stack.pop()) {
    ports.signal.throwIfAborted();
    if (part.length === 0) continue;
    const outcome = await stagePage(state, ports, part);
    if (outcome.kind === "staged") recordStaged(state, part, outcome);
    else if (outcome.kind === "fatal") return stopStaging(state, outcome);
    else if (part.length > 1) stack.push(...[...splitPage(part)].reverse());
    else if (outcome.owner === "keiko") failEntries(state, ports, part);
    else redo.push(part);
  }
  return { kind: "redo", pages: redo };
}

/** Writes one page and stages it; one correction follows a wrong answer or a refused page. */
async function draftPage(
  state: BatchState,
  ports: DraftBatchPorts,
  page: readonly DraftBatchEntry[],
): Promise<PageOutcome> {
  const { instructions } = state.input;
  let correction: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const planned = state.itemTokens;
    const generated = await generate(
      state,
      ports,
      fillMessages(page, instructions, correction),
      "fill",
    );
    if (generated === undefined) return { kind: "stopped" };
    if (generated.kind === "exhausted") return { kind: "exhausted" };
    state.itemTokens = measuredItemTokens(planned, generated.completionTokens, page.length);
    const parsed = parsePage(generated.text, page, instructions);
    const observed = {
      itemCount: page.length,
      plannedItemTokens: planned,
      completionTokens: generated.completionTokens,
    };
    if (!parsed.ok) {
      correction = parsed.problems.join(" ");
      ports.observe({ kind: "page", outcome: "corrected", ...observed });
      continue;
    }
    parsed.items.forEach((written, ref) => state.written.set(ref, written));
    const settled = await stageParsedPage(state, ports, page, observed);
    if (typeof settled !== "string") return settled;
    correction = settled;
  }
  return { kind: "refused" };
}

/** Stages a parsed page: its final outcome, or the correction text for one more attempt. */
async function stageParsedPage(
  state: BatchState,
  ports: DraftBatchPorts,
  page: readonly DraftBatchEntry[],
  observed: { itemCount: number; plannedItemTokens: number; completionTokens?: number | undefined },
): Promise<PageOutcome | string> {
  const staged = await stagePage(state, ports, page);
  if (staged.kind === "fatal") return stopStaging(state, staged);
  if (staged.kind === "staged") {
    recordStaged(state, page, staged);
    ports.observe({ kind: "page", outcome: "staged", ...observed });
    return { kind: "staged" };
  }
  ports.observe({ kind: "page", outcome: "refused", ...observed });
  if (staged.owner === "keiko")
    return page.length === 1 ? { kind: "refused" } : bisectPage(state, ports, page);
  return staged.guidance;
}

function nextPage(
  state: BatchState,
  retries: (readonly DraftBatchEntry[])[],
  pending: DraftBatchEntry[],
): readonly DraftBatchEntry[] | undefined {
  const retry = retries.pop();
  if (retry !== undefined) return retry;
  if (pending.length === 0) return undefined;
  const { instructions, maxInputTokens, maxOutputTokens } = state.input;
  const candidates = pending.slice(0, draftPageSize(maxOutputTokens, state.itemTokens));
  const fits = itemsWithinInput(
    maxInputTokens,
    state.fillOverheadChars,
    candidates.map((entry) => entryPromptChars(entry, instructions)),
  );
  return pending.splice(0, Math.min(candidates.length, fits));
}

/** A page that could not be drafted is retried in halves; a single issue is reported as failed. */
function settleUndrafted(
  state: BatchState,
  ports: DraftBatchPorts,
  page: readonly DraftBatchEntry[],
  outcome: PageOutcome,
  retries: (readonly DraftBatchEntry[])[],
): void {
  if (outcome.kind === "exhausted") state.itemTokens = exhaustedItemTokens(state.itemTokens);
  if (page.length === 1) {
    failEntries(state, ports, page);
    return;
  }
  const [first, second] = splitPage(page);
  retries.push(second, first);
  ports.observe({
    kind: "page",
    outcome: "split",
    itemCount: page.length,
    plannedItemTokens: state.itemTokens,
  });
}

/** A group whose combined criteria exceed the limit becomes one issue per requirement. */
function splitOversizedGroups(state: BatchState): void {
  const { instructions } = state.input;
  state.entries = state.entries.flatMap((entry) =>
    entry.requirements.length < 2 || criteriaFitDescription(entry, instructions)
      ? [entry]
      : entry.requirements.map((requirement, index) => ({
          ref: `${entry.ref}-${String(index + 1)}`,
          hint: entry.hint,
          requirements: [requirement],
        })),
  );
}

/** Issues whose own verbatim criteria exceed the description limit are reported, not drafted. */
function withoutOversized(state: BatchState, ports: DraftBatchPorts): DraftBatchEntry[] {
  const { instructions } = state.input;
  splitOversizedGroups(state);
  const fits = state.entries.filter((entry) => criteriaFitDescription(entry, instructions));
  const oversized = state.entries.filter((entry) => !fits.includes(entry));
  if (oversized.length > 0) {
    state.failed.push(...oversized);
    state.tooLargeCount = oversized.length;
    ports.observe({
      kind: "page",
      outcome: "too-large",
      itemCount: oversized.length,
      plannedItemTokens: state.itemTokens,
    });
  }
  return fits;
}

/** Share added to the slowest observed page, and time kept to settle the result. */
const PAGE_ESTIMATE_MARGIN = 1.25;
const DEADLINE_RESERVE_MS = 10_000;

/**
 * More work (an outline chunk or a page) starts only when the slowest page or model call so far,
 * with a margin, still ends before the deadline. Before any measurement only the reserve counts.
 */
function fitsDeadline(state: BatchState, ports: DraftBatchPorts): boolean {
  const { budget } = ports;
  if (budget === undefined) return true;
  const slowest = Math.max(state.slowestPageMs, state.slowestCallMs);
  const estimate = slowest * PAGE_ESTIMATE_MARGIN + DEADLINE_RESERVE_MS;
  return budget.nowMs() + estimate <= budget.deadlineAtMs;
}

async function draftAll(state: BatchState, ports: DraftBatchPorts): Promise<void> {
  const pending = withoutOversized(state, ports);
  const retries: (readonly DraftBatchEntry[])[] = [];
  for (
    let page = nextPage(state, retries, pending);
    page !== undefined;
    page = nextPage(state, retries, pending)
  ) {
    if (state.stopReason === "deadline" || !fitsDeadline(state, ports)) {
      state.stopReason = "deadline";
      break;
    }
    const startedAt = ports.budget?.nowMs() ?? 0;
    const outcome = await draftPage(state, ports, page);
    if (ports.budget !== undefined)
      state.slowestPageMs = Math.max(state.slowestPageMs, ports.budget.nowMs() - startedAt);
    if (outcome.kind === "stopped") break;
    if (outcome.kind === "redo") retries.push(...[...outcome.pages].reverse());
    else if (outcome.kind !== "staged") settleUndrafted(state, ports, page, outcome, retries);
    ports.progress(state.progress("drafting"));
  }
}

function refsOf(entries: readonly DraftBatchEntry[]): readonly string[] {
  return [...new Set(entries.flatMap((entry) => entry.requirements.map((item) => item.ref)))];
}

function undraftedRefs(state: BatchState): readonly string[] {
  return refsOf(state.entries.filter((entry) => !state.drafted.has(entry.ref)));
}

/** Undrafted issues that were neither tried nor given up: only a deadline leaves such issues. */
function deferredRefs(state: BatchState): readonly string[] {
  if (state.stopReason !== "deadline") return [];
  const failed = new Set(state.failed.map((entry) => entry.ref));
  return refsOf(
    state.entries.filter((entry) => !state.drafted.has(entry.ref) && !failed.has(entry.ref)),
  );
}

/**
 * Runs one batch to its end. Cancellation propagates; every other stop, a failed model call
 * included, is reported in the result with what was staged and what was not.
 */
export async function runJiraDraftBatch(
  input: DraftBatchInput,
  ports: DraftBatchPorts,
): Promise<DraftBatchResult> {
  const state = new BatchState(input);
  if (input.requirements.length === 0)
    return {
      progress: state.progress("complete"),
      itemCount: 0,
      pageCount: 0,
      failedRequirementRefs: [],
      deferredRequirementRefs: [],
      stopReason: "no-requirements",
      tooLargeCount: 0,
    };
  ports.progress(state.progress("outlining"));
  state.entries =
    input.granularity === "grouped"
      ? await groupedEntries(state, ports)
      : perRequirementEntries(state);
  ports.progress(state.progress("drafting"));
  await draftAll(state, ports);
  const progress = state.progress("complete");
  ports.progress(progress);
  return {
    progress,
    draftId: state.draftId,
    draftDigest: state.draftDigest,
    itemCount: state.itemCount,
    pageCount: state.pageCount,
    failedRequirementRefs: undraftedRefs(state),
    deferredRequirementRefs: deferredRefs(state),
    stopReason: state.stopReason,
    ...(state.error === undefined ? {} : { error: state.error }),
    tooLargeCount: state.tooLargeCount,
  };
}
