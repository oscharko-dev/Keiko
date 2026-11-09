import type { JiraTemplateRuleId } from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { sha256Hex } from "@oscharko-dev/keiko-security/hashing";
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
// the previous pages. Splits retain the last stage correction; repeating that same rejection
// after correction stops the batch. Failed issues are reported, never dropped silently. The draft goes through the
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
      readonly violationRuleCounts?:
        Partial<Readonly<Record<JiraTemplateRuleId, number>>> | undefined;
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
      readonly parseAttemptCount?: number | undefined;
      readonly stageAttemptCount?: number | undefined;
      readonly guidanceDigest?: string | undefined;
      readonly violationRuleCounts?:
        Partial<Readonly<Record<JiraTemplateRuleId, number>>> | undefined;
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
  | "no-requirements"
  | "stage-failed"
  | "stage-rejection-unchanged"
  | "call-limit"
  | "model-failed"
  | "deadline";

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
  if (generated === undefined) return { groups: chunk.map((item) => singleGroup(item)) };
  const observed = { requirementCount: chunk.length };
  if (generated.kind === "exhausted") {
    ports.observe({ kind: "outline", outcome: "exhausted", ...observed, groupCount: 0 });
    return chunk.length === 1
      ? { groups: chunk.map((item) => singleGroup(item)) }
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
function collectOutlineStep(
  groups: OutlineGroup[],
  pending: OutlineChunk[],
  next: OutlineChunk,
  step: OutlineStep,
): void {
  groups.push(...step.groups);
  for (const half of step.halves ?? []) pending.push({ chunk: half, retried: next.retried });
  const unassigned = step.unassigned ?? [];
  if (unassigned.length === 0) return;
  if (step.groups.length > 0) pending.push({ chunk: unassigned, retried: false });
  else if (next.retried) groups.push(...unassigned.map((item) => singleGroup(item)));
  else pending.push({ chunk: unassigned, retried: true });
}

function remainingOutlineGroups(chunks: readonly OutlineChunk[]): readonly OutlineGroup[] {
  return chunks.flatMap((item) => item.chunk.map((requirement) => singleGroup(requirement)));
}

function groupedEntries(
  state: BatchState,
  ports: DraftBatchPorts,
): Promise<readonly DraftBatchEntry[]> {
  const groups: OutlineGroup[] = [];
  const pending: OutlineChunk[] = [...firstOutlineChunks(state)];
  return new Promise((resolve, reject) => {
    function complete(): void {
      resolve(
        groups.map((group, index) => ({
          ref: refFor(state, index),
          hint: group.summary,
          requirements: group.requirements,
        })),
      );
    }
    function next(): void {
      const chunk = pending.shift();
      if (chunk === undefined) {
        complete();
        return;
      }
      if (!fitsDeadline(state, ports)) {
        state.stopReason = "deadline";
        groups.push(...remainingOutlineGroups([chunk, ...pending]));
        complete();
        return;
      }
      void outlineChunk(state, ports, chunk.chunk)
        .then((step) => {
          collectOutlineStep(groups, pending, chunk, step);
          next();
        })
        .catch(reject);
    }
    next();
  });
}

interface StageCorrection {
  readonly guidance: string;
  readonly digest: string;
}
interface DraftPage {
  readonly entries: readonly DraftBatchEntry[];
  readonly correction?: StageCorrection | undefined;
}
interface PageAttempts {
  parseAttemptCount: number;
  stageAttemptCount: number;
  parseFailures: number;
  stageRejections: number;
  parseCorrection: string | undefined;
  stageCorrection: StageCorrection | undefined;
}
function pageAttempts(page: DraftPage): PageAttempts {
  return {
    parseAttemptCount: 0,
    stageAttemptCount: 0,
    parseFailures: 0,
    stageRejections: 0,
    parseCorrection: undefined,
    stageCorrection: page.correction,
  };
}
function stageCorrection(
  outcome: Extract<DraftBatchStageOutcome, { kind: "rejected" }>,
): StageCorrection {
  return { guidance: outcome.guidance, digest: sha256Hex(outcome.guidance) };
}
function correctionText(attempts: PageAttempts): string | undefined {
  const parts = [attempts.stageCorrection?.guidance, attempts.parseCorrection].filter(
    (part) => part !== undefined,
  );
  return parts.length === 0 ? undefined : parts.join("\n");
}

type PageOutcome =
  | { readonly kind: "staged" }
  | { readonly kind: "exhausted" | "refused"; readonly correction?: StageCorrection | undefined }
  /** Keiko staged what it could; the pages left need a new model answer. */
  | { readonly kind: "redo"; readonly pages: readonly DraftPage[] }
  | { readonly kind: "stopped" };

interface PageObservation {
  readonly itemCount: number;
  readonly plannedItemTokens: number;
  readonly completionTokens?: number | undefined;
}
function attemptFacts(attempts: PageAttempts): {
  readonly parseAttemptCount: number;
  readonly stageAttemptCount: number;
} {
  return {
    parseAttemptCount: attempts.parseAttemptCount,
    stageAttemptCount: attempts.stageAttemptCount,
  };
}

function observeStageResult(
  ports: DraftBatchPorts,
  observed: PageObservation,
  attempts: PageAttempts,
  outcome: Exclude<DraftBatchStageOutcome, { kind: "fatal" }>,
): void {
  ports.observe({
    kind: "page",
    outcome: outcome.kind === "staged" ? "staged" : "refused",
    ...observed,
    ...attemptFacts(attempts),
    ...(outcome.kind === "rejected"
      ? {
          guidanceDigest: sha256Hex(outcome.guidance),
          violationRuleCounts: outcome.violationRuleCounts,
        }
      : {}),
  });
}

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
  attempts: PageAttempts,
): Promise<DraftBatchStageOutcome> {
  attempts.stageAttemptCount += 1;
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
  attempts: PageAttempts,
): Promise<DraftBatchStageOutcome> {
  const first = await stageOnce(state, ports, page, attempts);
  return first.kind === "fatal" && first.transient === true
    ? stageOnce(state, ports, page, attempts)
    : first;
}

function stopStaging(state: BatchState, outcome: { readonly error?: unknown }): PageOutcome {
  state.stopReason = "stage-failed";
  if (outcome.error !== undefined) state.error = outcome.error;
  return { kind: "stopped" };
}

function stopUnchangedStage(state: BatchState): PageOutcome {
  state.stopReason = "stage-rejection-unchanged";
  return { kind: "stopped" };
}

function correctedHalves(
  page: readonly DraftBatchEntry[],
  correction: StageCorrection | undefined,
): DraftPage[] {
  return splitPage(page).map((entries) => ({ entries, correction }));
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
 * answers are staged again in halves, with no model call. An unchanged rejection stops further
 * isolation. An issue the model can still correct goes back to the model with its latest guidance.
 */
function bisectPage(
  state: BatchState,
  ports: DraftBatchPorts,
  page: readonly DraftBatchEntry[],
  correction: StageCorrection,
): Promise<PageOutcome> {
  ports.observe({
    kind: "page",
    outcome: "split",
    itemCount: page.length,
    plannedItemTokens: state.itemTokens,
  });
  const redo: DraftPage[] = [];
  const stack = correctedHalves(page, correction).reverse();
  return new Promise((resolve, reject) => {
    function next(): void {
      ports.signal.throwIfAborted();
      const part = stack.pop();
      if (part === undefined) {
        resolve({ kind: "redo", pages: redo });
        return;
      }
      void stageBisectedPart(state, ports, { page: part, stack, redo })
        .then((outcome) => {
          if (outcome === undefined) next();
          else resolve(outcome);
        })
        .catch(reject);
    }
    next();
  });
}

interface BisectedPart {
  readonly page: DraftPage;
  readonly stack: DraftPage[];
  readonly redo: DraftPage[];
}
async function stageBisectedPart(
  state: BatchState,
  ports: DraftBatchPorts,
  step: BisectedPart,
): Promise<PageOutcome | undefined> {
  const { page, stack, redo } = step;
  const part = page.entries;
  const attempts = pageAttempts(page);
  const outcome = await stagePage(state, ports, part, attempts);
  if (outcome.kind === "fatal") return stopStaging(state, outcome);
  observeStageResult(
    ports,
    { itemCount: part.length, plannedItemTokens: state.itemTokens },
    attempts,
    outcome,
  );
  if (outcome.kind === "staged") {
    recordStaged(state, part, outcome);
    return undefined;
  }
  const correction = stageCorrection(outcome);
  if (page.correction?.digest === correction.digest) return stopUnchangedStage(state);
  if (part.length > 1) stack.push(...correctedHalves(part, correction).reverse());
  else if (outcome.owner === "keiko") failEntries(state, ports, part);
  else redo.push({ entries: part, correction });
  return undefined;
}

/** Parse repairs and model-owned stage corrections each retain their own bounded allowance. */
function draftPage(
  state: BatchState,
  ports: DraftBatchPorts,
  page: DraftPage,
): Promise<PageOutcome> {
  const attempts = pageAttempts(page);
  return new Promise((resolve, reject) => {
    function next(): void {
      void draftAttempt(state, ports, page.entries, attempts)
        .then((outcome) => {
          if (outcome === undefined) next();
          else resolve(outcome);
        })
        .catch(reject);
    }
    next();
  });
}

async function draftAttempt(
  state: BatchState,
  ports: DraftBatchPorts,
  page: readonly DraftBatchEntry[],
  attempts: PageAttempts,
): Promise<PageOutcome | undefined> {
  const planned = state.itemTokens;
  const generated = await generate(
    state,
    ports,
    fillMessages(page, state.input.instructions, correctionText(attempts)),
    "fill",
  );
  if (generated === undefined) return { kind: "stopped" };
  if (generated.kind === "exhausted")
    return { kind: "exhausted", correction: attempts.stageCorrection };
  state.itemTokens = measuredItemTokens(planned, generated.completionTokens, page.length);
  attempts.parseAttemptCount += 1;
  const parsed = parsePage(generated.text, page, state.input.instructions);
  const observed = {
    itemCount: page.length,
    plannedItemTokens: planned,
    completionTokens: generated.completionTokens,
  };
  if (!parsed.ok) {
    attempts.parseFailures += 1;
    attempts.parseCorrection = parsed.problems.join(" ");
    ports.observe({ kind: "page", outcome: "corrected", ...observed, ...attemptFacts(attempts) });
    return attempts.parseFailures < 2
      ? undefined
      : { kind: "refused", correction: attempts.stageCorrection };
  }
  attempts.parseCorrection = undefined;
  parsed.items.forEach((written, ref) => state.written.set(ref, written));
  return stageParsedPage(state, ports, { page, attempts, observed });
}

interface ParsedPage {
  readonly page: readonly DraftBatchEntry[];
  readonly attempts: PageAttempts;
  readonly observed: PageObservation;
}
/** Stage once from the parsed content; a transient draft-store failure retains its existing retry. */
async function stageParsedPage(
  state: BatchState,
  ports: DraftBatchPorts,
  parsed: ParsedPage,
): Promise<PageOutcome | undefined> {
  const { page, attempts, observed } = parsed;
  const staged = await stagePage(state, ports, page, attempts);
  if (staged.kind === "fatal") return stopStaging(state, staged);
  if (staged.kind === "staged") {
    recordStaged(state, page, staged);
    observeStageResult(ports, observed, attempts, staged);
    return { kind: "staged" };
  }
  const correction = stageCorrection(staged);
  observeStageResult(ports, observed, attempts, staged);
  if (attempts.stageCorrection?.digest === correction.digest) return stopUnchangedStage(state);
  if (staged.owner === "keiko")
    return page.length === 1 ? { kind: "refused" } : bisectPage(state, ports, page, correction);
  return modelStageRefusal(attempts, correction);
}

function modelStageRefusal(
  attempts: PageAttempts,
  correction: StageCorrection,
): PageOutcome | undefined {
  attempts.stageCorrection = correction;
  attempts.stageRejections += 1;
  return attempts.stageRejections < 2 ? undefined : { kind: "refused", correction };
}

function nextPage(
  state: BatchState,
  retries: DraftPage[],
  pending: DraftBatchEntry[],
): DraftPage | undefined {
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
  return { entries: pending.splice(0, Math.min(candidates.length, fits)) };
}

/** A page that could not be drafted is retried in halves; a single issue is reported as failed. */
function settleUndrafted(
  state: BatchState,
  ports: DraftBatchPorts,
  page: readonly DraftBatchEntry[],
  outcome: Extract<PageOutcome, { kind: "exhausted" | "refused" }>,
  retries: DraftPage[],
): void {
  if (outcome.kind === "exhausted") state.itemTokens = exhaustedItemTokens(state.itemTokens);
  if (page.length === 1) {
    failEntries(state, ports, page);
    return;
  }
  retries.push(...correctedHalves(page, outcome.correction).reverse());
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

function draftAll(state: BatchState, ports: DraftBatchPorts): Promise<void> {
  const pending = withoutOversized(state, ports);
  const retries: DraftPage[] = [];
  return new Promise((resolve, reject) => {
    function next(): void {
      const page = nextPage(state, retries, pending);
      if (page === undefined) {
        resolve();
        return;
      }
      if (state.stopReason === "deadline" || !fitsDeadline(state, ports)) {
        state.stopReason = "deadline";
        resolve();
        return;
      }
      const startedAt = ports.budget?.nowMs() ?? 0;
      void draftPage(state, ports, page)
        .then((outcome) => {
          if (ports.budget !== undefined)
            state.slowestPageMs = Math.max(state.slowestPageMs, ports.budget.nowMs() - startedAt);
          if (outcome.kind === "stopped") {
            resolve();
            return;
          }
          if (outcome.kind === "redo") retries.push(...[...outcome.pages].reverse());
          else if (outcome.kind !== "staged")
            settleUndrafted(state, ports, page.entries, outcome, retries);
          ports.progress(state.progress("drafting"));
          next();
        })
        .catch(reject);
    }
    next();
  });
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
