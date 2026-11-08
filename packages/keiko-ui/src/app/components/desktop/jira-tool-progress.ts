import {
  CHAT_TOOL_BATCH_TOOL_NAME,
  isChatToolBatchProgress,
  type ChatToolBatchProgress,
  type ChatToolExchange,
  type ChatTurnState,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import type { WidgetMessageKey } from "@/lib/optional-widget-i18n";

/** The Chat alias of the local `knowledge.requirements` read (#4179). */
export const REQUIREMENTS_TOOL_ALIAS = "knowledge_requirements";

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}
function countOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function dataOf(exchange: ChatToolExchange): Record<string, unknown> | undefined {
  return exchange.result?.status === "completed" ? plainRecord(exchange.result.data) : undefined;
}

/** Progress of a draft batch: the live record while it runs, else the counts its result settled. */
export function batchProgressOf(exchange: ChatToolExchange): ChatToolBatchProgress | undefined {
  if (exchange.call.name !== CHAT_TOOL_BATCH_TOOL_NAME) return undefined;
  if (isChatToolBatchProgress(exchange.batchProgress)) return exchange.batchProgress;
  const data = dataOf(exchange);
  const settled = {
    phase: "complete",
    draftedCount: countOf(data?.draftedCount),
    plannedCount: countOf(data?.plannedCount),
    coveredRequirementCount: countOf(data?.coveredRequirementCount),
    requirementCount: countOf(data?.requirementCount),
    failedCount: countOf(data?.failedCount),
  };
  return isChatToolBatchProgress(settled) ? settled : undefined;
}

export type ProgressTone = "info" | "success" | "warning";

interface ProgressNote {
  readonly key: WidgetMessageKey;
  readonly values: Readonly<Record<string, number>>;
}

export interface BatchProgressView {
  readonly tone: ProgressTone;
  /** Undefined while no plan exists yet: the bar is indeterminate and states its phase. */
  readonly value: number | undefined;
  readonly max: number;
  readonly text: WidgetMessageKey;
  readonly values: Readonly<Record<string, number>>;
  /** True when the exchange ended without a complete result: the bar stands still. */
  readonly stopped: boolean;
  readonly notes: readonly ProgressNote[];
}

function failedNote(
  exchange: ChatToolExchange,
  progress: ChatToolBatchProgress,
): ProgressNote | undefined {
  if (progress.failedCount === 0) return undefined;
  const refs = dataOf(exchange)?.failedRequirementRefs;
  return Array.isArray(refs) && refs.length > 0
    ? { key: "chat.batch.failedRequirements", values: { count: refs.length } }
    : { key: "chat.batch.failedIssues", values: { count: progress.failedCount } };
}

/** What a complete batch still lacks: unfinished issues and requirements without an issue. */
function completionNotes(progress: ChatToolBatchProgress): ProgressNote[] {
  const notes: ProgressNote[] = [];
  const unfinished = progress.plannedCount - progress.draftedCount - progress.failedCount;
  if (unfinished > 0) notes.push({ key: "chat.batch.unfinished", values: { count: unfinished } });
  const uncovered = progress.requirementCount - progress.coveredRequirementCount;
  if (uncovered > 0) notes.push({ key: "chat.batch.uncovered", values: { count: uncovered } });
  return notes;
}

function batchNotes(
  exchange: ChatToolExchange,
  progress: ChatToolBatchProgress,
): readonly ProgressNote[] {
  const failed = failedNote(exchange, progress);
  const rest = progress.phase === "complete" ? completionNotes(progress) : [];
  return failed === undefined ? rest : [failed, ...rest];
}

/** The ending of a stopped batch: the person stopped it, or it could not go on. */
function stoppedText(progress: ChatToolBatchProgress, turnState: ChatTurnState): WidgetMessageKey {
  const outlining = progress.phase === "outlining";
  if (turnState === "cancelled") {
    return outlining ? "chat.batch.stoppedOutlining" : "chat.batch.stopped";
  }
  return outlining ? "chat.batch.failedOutlining" : "chat.batch.failed";
}

function batchText(
  exchange: ChatToolExchange,
  progress: ChatToolBatchProgress,
  stoppedBy: ChatTurnState | undefined,
): WidgetMessageKey {
  if (progress.phase === "complete") {
    if (progress.plannedCount === 0) return "chat.batch.none";
    return dataOf(exchange)?.paused === true ? "chat.batch.paused" : "chat.batch.complete";
  }
  if (stoppedBy !== undefined) return stoppedText(progress, stoppedBy);
  return progress.phase === "outlining" ? "chat.batch.outlining" : "chat.batch.drafted";
}

function batchTone(
  progress: ChatToolBatchProgress,
  stopped: boolean,
  noteCount: number,
): ProgressTone {
  if (progress.phase !== "complete") return stopped ? "warning" : "info";
  const exact =
    progress.plannedCount > 0 &&
    progress.draftedCount + progress.failedCount === progress.plannedCount &&
    progress.coveredRequirementCount === progress.requirementCount;
  return exact && progress.failedCount === 0 && noteCount === 0 ? "success" : "warning";
}

/**
 * Blue while it runs, green only when every planned issue was drafted and every requirement is
 * covered; a batch that ended early or fell short is a warning that counts what is missing.
 */
export function batchProgressView(
  exchange: ChatToolExchange,
  progress: ChatToolBatchProgress,
  turnState: ChatTurnState | undefined,
): BatchProgressView {
  const complete = progress.phase === "complete";
  const stopped = turnState !== undefined && turnState !== "pending" && !complete;
  const notes = batchNotes(exchange, progress);
  const noIssues = complete && progress.plannedCount === 0;
  return {
    tone: batchTone(progress, stopped, notes.length),
    value: progress.phase === "outlining" || noIssues ? undefined : progress.draftedCount,
    max: Math.max(progress.plannedCount, 1),
    text: batchText(exchange, progress, stopped ? turnState : undefined),
    values: {
      drafted: progress.draftedCount,
      planned: progress.plannedCount,
      covered: progress.coveredRequirementCount,
      requirements: progress.requirementCount,
    },
    stopped,
    notes,
  };
}

/** The count a processing step appends, e.g. `24/131`, or undefined while nothing is counted. */
export function batchStepCount(exchange: ChatToolExchange): string | undefined {
  const progress = batchProgressOf(exchange);
  return progress === undefined || progress.plannedCount === 0
    ? undefined
    : `${String(progress.draftedCount)}/${String(progress.plannedCount)}`;
}

const REQUIREMENTS_CUT_KEYS = [
  ["documentsNotExtracted", "chat.requirements.cut.documentsNotExtracted"],
  ["documentsOmitted", "chat.requirements.cut.documentsOmitted"],
  ["unitsOmitted", "chat.requirements.cut.unitsOmitted"],
] as const;
const PAGING_ARGUMENTS: ReadonlySet<string> = new Set(["cursor", "limit"]);

export interface RequirementsReadView {
  readonly done: number;
  readonly total: number;
  readonly complete: boolean;
  readonly cuts: readonly { readonly key: WidgetMessageKey; readonly count: number }[];
  /** True when the card tells more than the progress step: several calls, or an unfinished read. */
  readonly informative: boolean;
  /** The number of calls (pages) the card consolidates. */
  readonly pageCount: number;
}

/** Only the units view of a settled read counts units; other views have their own meaning. */
function unitsData(exchange: ChatToolExchange): Record<string, unknown> | undefined {
  if (exchange.call.name !== REQUIREMENTS_TOOL_ALIAS) return undefined;
  const view = exchange.call.arguments.view;
  if (view !== undefined && view !== "units") return undefined;
  const data = dataOf(exchange);
  return data?.outcome === "succeeded" && Array.isArray(data.items) ? data : undefined;
}

/** One read is one filter; its pages differ only by cursor and size. */
function groupKey(exchange: ChatToolExchange): string {
  const entries = Object.entries(exchange.call.arguments)
    .filter(([name]) => !PAGING_ARGUMENTS.has(name))
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

function maxCount(group: readonly Record<string, unknown>[], name: string): number {
  return Math.max(0, ...group.map((data) => countOf(plainRecord(data.totals)?.[name]) ?? 0));
}

function readCount(group: readonly Record<string, unknown>[]): number {
  const references = new Set<string>();
  let anonymous = 0;
  for (const data of group)
    for (const item of Array.isArray(data.items) ? (data.items as unknown[]) : []) {
      const reference = plainRecord(item)?.reference;
      if (typeof reference === "string") references.add(reference);
      else anonymous += 1;
    }
  return references.size + anonymous;
}

function requirementsReadView(group: readonly Record<string, unknown>[]): RequirementsReadView {
  const cuts = REQUIREMENTS_CUT_KEYS.map(([name, key]) => ({
    key,
    count: maxCount(group, name),
  })).filter((cut) => cut.count > 0);
  // The matched count is what the filter selects; the detected count is the whole inventory.
  const matched = group.some(
    (data) => countOf(plainRecord(data.totals)?.matchedCount) !== undefined,
  );
  const total = maxCount(group, matched ? "matchedCount" : "detectedCount");
  const done = readCount(group);
  const lastPage = group.some((data) => data.nextCursor === undefined);
  const named = group.some((data) => {
    const reasons = plainRecord(data.totals)?.cutReasons;
    return Array.isArray(reasons) && reasons.length > 0;
  });
  const complete = cuts.length === 0 && !named && lastPage && done >= total;
  return {
    done,
    total: Math.max(total, done),
    complete,
    cuts: cuts.length === 0 && named ? [{ key: "chat.requirements.partial", count: 0 }] : cuts,
    informative: group.length > 1 || !complete,
    pageCount: group.length,
  };
}

export function requirementsTone(view: RequirementsReadView): ProgressTone {
  if (view.cuts.length > 0) return "warning";
  return view.complete ? "success" : "info";
}

export interface RequirementsReadGroups {
  /** The consolidated card per read, keyed by the call id of the read's first exchange. */
  readonly cards: ReadonlyMap<string, RequirementsReadView>;
  /** Every call id that belongs to a consolidated read, shown or not. */
  readonly members: ReadonlySet<string>;
  /** Later pages of a consolidated read: the first page's card already counts them. */
  readonly folded: ReadonlySet<string>;
}

/** Counts what a turn read across the pages of each filter, once per distinct unit reference. */
export function requirementsReadGroups(
  exchanges: readonly ChatToolExchange[],
): RequirementsReadGroups {
  const groups = new Map<
    string,
    { first: string; ids: string[]; data: Record<string, unknown>[] }
  >();
  const members = new Set<string>();
  for (const exchange of exchanges) {
    const data = unitsData(exchange);
    if (data === undefined) continue;
    members.add(exchange.call.id);
    const key = groupKey(exchange);
    const group = groups.get(key) ?? { first: exchange.call.id, ids: [], data: [] };
    group.ids.push(exchange.call.id);
    group.data.push(data);
    groups.set(key, group);
  }
  const cards = new Map<string, RequirementsReadView>();
  const folded = new Set<string>();
  for (const group of groups.values()) {
    const view = requirementsReadView(group.data);
    if (!view.informative) continue;
    cards.set(group.first, view);
    for (const id of group.ids) if (id !== group.first) folded.add(id);
  }
  return { cards, members, folded };
}
