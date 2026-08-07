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

// Above this length a whitespace-free run stops behaving like a word and starts behaving like
// dense data. An English word averages ~5 characters, so 24 leaves every ordinary prose token
// charged at exactly TOKEN_PER_WORD_RATIO and catches only the pathological runs.
const LONG_WORD_CHAR_THRESHOLD = 24;
// Chars-per-token for a run charged by length. Independent of TOKEN_PER_WORD_RATIO, which remains
// the ordinary-word unit; ~4 is the conventional dense-text rate the rest of the codebase prices
// non-prose at (see requiresDenseTokenizerFloor in keiko-contracts/context-engineering.ts).
const LONG_WORD_CHARS_PER_TOKEN = 4;

// A word count is a serviceable token proxy for prose and inverts completely for the inputs a
// memory vault captures verbatim — a URL, hash, base64 blob or minified-JSON line is ONE
// whitespace-free "word" of unbounded length. Charging by length above the threshold keeps the
// proxy honest for those without moving the price of any ordinary word.
//
// The two classes are accumulated SEPARATELY rather than summed per word, because ordinary words
// must keep the single multiplication they were always priced with: adding TOKEN_PER_WORD_RATIO
// ten times yields 13.000000000000002, whose ceil is 14, where `10 * 1.3` is exactly 13. Long
// runs are already whole tokens and simply add.
interface TokenCharge {
  readonly ordinaryWords: number;
  readonly longRunTokens: number;
}

const NO_CHARGE: TokenCharge = { ordinaryWords: 0, longRunTokens: 0 };

function chargeWord(charge: TokenCharge, word: string): TokenCharge {
  return word.length <= LONG_WORD_CHAR_THRESHOLD
    ? { ...charge, ordinaryWords: charge.ordinaryWords + 1 }
    : {
        ...charge,
        longRunTokens: charge.longRunTokens + Math.ceil(word.length / LONG_WORD_CHARS_PER_TOKEN),
      };
}

function chargeTokens(charge: TokenCharge): number {
  return charge.ordinaryWords * TOKEN_PER_WORD_RATIO + charge.longRunTokens;
}

// NOTE (GEN-DUP-SEMANTIC-002): intentionally NOT the canonical byte-based estimateTokens in
// @oscharko-dev/keiko-contracts. This word-count estimate is inverted here by clipToTokenBudget's
// exact 1.3 round-trip (token budget -> word budget), so it must stay a self-consistent local unit.
export function estimateTokens(text: string): number {
  if (text === "") return 0;
  const words = text
    .trim()
    .split(/\s+/u)
    .filter((w) => w.length > 0);
  if (words.length === 0) return 0;
  // Wrapped rather than passed directly: reduce supplies index and array as extra arguments
  // (typescript:S7727).
  return Math.ceil(
    chargeTokens(words.reduce((charge, word) => chargeWord(charge, word), NO_CHARGE)),
  );
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

// Cut a single over-budget run mid-word. Reserves one character for the ellipsis so the result
// still prices at or under `tokenBudget` under estimateTokens' own long-word rate.
function clipLongWordToBudget(word: string, tokenBudget: number): string {
  const maxChars = Math.max(1, tokenBudget * LONG_WORD_CHARS_PER_TOKEN - 1);
  let end = 0;
  for (const codePoint of word) {
    const next = end + codePoint.length;
    // Advance by whole code points so a surrogate pair is never split into a lone half. The first
    // code point is always taken: an empty excerpt is worse than one character of overshoot.
    if (end > 0 && next > maxChars) break;
    end = next;
  }
  return word.slice(0, end) + "…";
}

// Not exported on the package barrel — module-scoped so its own contract can be pinned directly.
// Contract: estimateTokens(clipToTokenBudget(body, n)) <= n, for every n.
export function clipToTokenBudget(body: string, tokenBudget: number): string {
  // Any non-empty excerpt is at least one "word" and so costs at least TOKEN_PER_WORD_RATIO, which
  // rounds up to 2 — even a lone ellipsis does. Below that floor there is no in-budget non-empty
  // answer, so an empty excerpt is the only one that honours the budget. The old word-count form
  // returned one word here regardless (Math.max(1, …)), quietly costing double the budget.
  if (tokenBudget < TOKEN_PER_WORD_RATIO) return "";
  const words = body.split(/\s+/u).filter((w) => w.length > 0);
  const kept: string[] = [];
  let charge = NO_CHARGE;
  for (const word of words) {
    const next = chargeWord(charge, word);
    if (chargeTokens(next) <= tokenBudget) {
      kept.push(word);
      charge = next;
      continue;
    }
    if (kept.length > 0) break;
    // Nothing kept yet and the first word alone blows the budget, so it has to be cut mid-word:
    // the previous word-COUNT comparison returned it whole (1 word <= any word budget), which is
    // how a 4096-char body passed a 50-token allowance untouched. Only a long run reaches here —
    // an ordinary word costs TOKEN_PER_WORD_RATIO, which the floor above guarantees room for.
    return clipLongWordToBudget(word, tokenBudget);
  }
  if (kept.length === words.length) return body;
  return clipWithEllipsis(kept, tokenBudget);
}

// The ellipsis is appended to the LAST kept word rather than standing alone, so it lengthens that
// word by one character — enough to carry a word sitting exactly on LONG_WORD_CHAR_THRESHOLD past
// it and re-price the whole excerpt at the long-run rate. Drop words until the rendered form,
// ellipsis included, is back inside the budget. The first candidate is almost always the answer;
// the loop only iterates for words at the threshold, and a memory body is length-bounded.
function clipWithEllipsis(kept: readonly string[], tokenBudget: number): string {
  for (let end = kept.length; end > 0; end -= 1) {
    const candidate = `${kept.slice(0, end).join(" ")}…`;
    if (estimateTokens(candidate) <= tokenBudget) return candidate;
  }
  return "";
}

function wordsOf(body: string): readonly string[] {
  return body.split(/\s+/u).filter((w) => w.length > 0);
}

function clippedWords(words: readonly string[], count: number): string {
  const excerpt = words.slice(0, count).join(" ");
  return count < words.length ? `${excerpt}…` : excerpt;
}

function renderText(entries: readonly MemoryContextBlockEntry[]): string {
  if (entries.length === 0) return "";
  const lines = ["# Relevant memories"];
  for (const e of entries) {
    lines.push(`- (${e.inclusionReason}) ${e.bodyExcerpt}`);
  }
  return lines.join("\n");
}

function renderedCost(entries: readonly MemoryContextBlockEntry[]): number {
  return estimateTokens(renderText(entries));
}

function entryForRank(
  rank: IncludedMemory,
  record: MemoryRecord,
  bodyExcerpt: string,
): MemoryContextBlockEntry {
  return {
    memoryId: rank.memoryId,
    bodyExcerpt,
    inclusionReason: rank.inclusionReason,
    sourceKind: record.provenance.sourceKind,
    ...(record.provenance.captureRationale !== undefined
      ? { captureRationale: record.provenance.captureRationale }
      : {}),
    sensitivity: record.provenance.sensitivity,
    confidence: record.provenance.confidence,
    status: record.status,
    capturedAt: record.provenance.capturedAt,
  };
}

function fitEntryToBudget(
  entries: readonly MemoryContextBlockEntry[],
  rank: IncludedMemory,
  record: MemoryRecord,
  budgetTokens: number,
  perEntry: number,
): MemoryContextBlockEntry | undefined {
  const words = wordsOf(record.body);
  const initialExcerpt = clipToTokenBudget(record.body, perEntry);
  // An empty excerpt from a non-empty body means the per-entry allowance could not hold a single
  // word. Admitting it would put a memory with no text into the block, so fall through to the
  // search below, which sizes the excerpt against the real budget rather than the per-entry share.
  if (initialExcerpt !== "" || words.length === 0) {
    const initialEntry = entryForRank(rank, record, initialExcerpt);
    if (renderedCost([...entries, initialEntry]) <= budgetTokens) {
      return initialEntry;
    }
  }

  let lo = 1;
  let hi = Math.min(words.length, Math.max(1, Math.floor(perEntry / TOKEN_PER_WORD_RATIO)));
  let best: MemoryContextBlockEntry | undefined;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = entryForRank(rank, record, clippedWords(words, mid));
    if (renderedCost([...entries, candidate]) <= budgetTokens) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
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
  // Per-entry token allowance: divide the budget across however many candidates can actually be
  // considered, bounded by the cap — not the configured ceiling alone. A per-entry clip still
  // keeps any one memory from monopolising the budget when candidates reach the cap, but sizing
  // the divisor off the ceiling pre-divided the budget among slots that would never be filled, so
  // the common case of fewer survivors than slots clipped every entry to a fixed 1/maxIncluded
  // share while most of the budget sat unused.
  const effectiveSlots = Math.max(1, Math.min(options.maxIncluded, ranked.length));
  const perEntry = Math.max(1, Math.floor(options.budgetTokens / effectiveSlots));
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
    const entry = fitEntryToBudget(
      entries,
      rank,
      record,
      options.budgetTokens,
      Math.max(1, Math.min(perEntry, options.budgetTokens - used)),
    );
    if (entry === undefined) {
      omitted.push({ memoryId: rank.memoryId, reason: "budget-exceeded" });
      continue;
    }
    used = renderedCost([...entries, entry]);
    included.push(rank);
    entries.push(entry);
  }
  return { included, entries, omitted, used };
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
