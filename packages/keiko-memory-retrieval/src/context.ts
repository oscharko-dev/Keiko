// Token-budgeted context assembler.
//
// Pure-function: takes a ranked list + the underlying records + a budget, returns an
// AssembledContext (= MemoryRetrievalResult minus `request`, which the orchestrator
// attaches). The token estimate is deliberately naive — `wordCount * 1.3` — so the score
// is reproducible across model families without a tokenizer dependency. The 1.3 multiplier
// is the rough English-text upper bound used by audit dashboards elsewhere; documented at
// the export so consumers can reproduce it.
//
// Layout of the rendered text:
//   # Relevant memories
//   - (top signal: pinned memory) the body excerpt
//   - (top signal: recent update) another body excerpt
//
// Empty ranked input -> empty text (no header, no bullet). A "no memory" prompt header
// would be hallucination — better to emit nothing and let the caller decide what to
// surface in the absence of memory.

import type { MemoryId, MemoryRecord } from "@oscharko-dev/keiko-contracts/memory";

import type {
  AssembledContext,
  IncludedMemory,
  MemoryContextBlockEntry,
  OmittedMemory,
} from "./types.js";

export const TOKEN_PER_WORD_RATIO = 1.3;

export function estimateTokens(text: string): number {
  if (text === "") return 0;
  const words = text
    .trim()
    .split(/\s+/u)
    .filter((w) => w.length > 0);
  if (words.length === 0) return 0;
  return Math.ceil(words.length * TOKEN_PER_WORD_RATIO);
}

export interface AssembleContextOptions {
  readonly budgetTokens: number;
  readonly maxIncluded: number;
}

function buildRecordIndex(records: readonly MemoryRecord[]): ReadonlyMap<MemoryId, MemoryRecord> {
  const m = new Map<MemoryId, MemoryRecord>();
  for (const r of records) m.set(r.id, r);
  return m;
}

function clipToTokenBudget(body: string, tokenBudget: number): string {
  if (tokenBudget <= 0) return "";
  // Convert tokens back to a word budget — inverse of the 1.3 ratio. floor() ensures we
  // never overshoot the per-entry token allowance.
  const wordBudget = Math.max(1, Math.floor(tokenBudget / TOKEN_PER_WORD_RATIO));
  const words = body.split(/\s+/u).filter((w) => w.length > 0);
  if (words.length <= wordBudget) return body;
  return words.slice(0, wordBudget).join(" ") + "…";
}

interface AssemblyStep {
  readonly included: readonly IncludedMemory[];
  readonly entries: readonly MemoryContextBlockEntry[];
  readonly omitted: readonly OmittedMemory[];
  readonly used: number;
}

function greedyAssemble(
  ranked: readonly IncludedMemory[],
  recordById: ReadonlyMap<MemoryId, MemoryRecord>,
  options: AssembleContextOptions,
): AssemblyStep {
  const included: IncludedMemory[] = [];
  const entries: MemoryContextBlockEntry[] = [];
  const omitted: OmittedMemory[] = [];
  let used = 0;
  // Per-entry token allowance: divide the budget evenly across the cap; a per-entry clip
  // keeps any one memory from monopolising the budget.
  const perEntry = Math.max(1, Math.floor(options.budgetTokens / Math.max(1, options.maxIncluded)));
  for (const rank of ranked) {
    if (included.length >= options.maxIncluded) {
      omitted.push({ memoryId: rank.memoryId, reason: "budget-exceeded" });
      continue;
    }
    const record = recordById.get(rank.memoryId);
    if (record === undefined) {
      omitted.push({ memoryId: rank.memoryId, reason: "out-of-scope" });
      continue;
    }
    const excerpt = clipToTokenBudget(record.body, perEntry);
    const cost = estimateTokens(excerpt);
    if (used + cost > options.budgetTokens) {
      omitted.push({ memoryId: rank.memoryId, reason: "budget-exceeded" });
      continue;
    }
    used += cost;
    included.push(rank);
    entries.push({
      memoryId: rank.memoryId,
      bodyExcerpt: excerpt,
      inclusionReason: rank.inclusionReason,
    });
  }
  return { included, entries, omitted, used };
}

function renderText(entries: readonly MemoryContextBlockEntry[]): string {
  if (entries.length === 0) return "";
  const lines = ["# Relevant memories"];
  for (const e of entries) {
    lines.push(`- (${e.inclusionReason}) ${e.bodyExcerpt}`);
  }
  return lines.join("\n");
}

/**
 * Assemble a token-budgeted context block from a pre-ranked memory list. Returns
 * `Omit<MemoryRetrievalResult, "request">` because the assembler has no need for the
 * request envelope to compose its output; the orchestrator (retrieveMemoryContext)
 * attaches `request` after calling this function.
 */
export function assembleContextBlock(
  ranked: readonly IncludedMemory[],
  memories: readonly MemoryRecord[],
  options: AssembleContextOptions,
): AssembledContext {
  const recordById = buildRecordIndex(memories);
  const step = greedyAssemble(ranked, recordById, options);
  return {
    contextBlock: {
      text: renderText(step.entries),
      memories: step.entries,
    },
    included: step.included,
    omitted: step.omitted,
    budget: { tokens: options.budgetTokens, used: step.used },
  };
}
