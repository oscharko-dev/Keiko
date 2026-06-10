// Excerpt compaction and aggregate-budget checkpoint helpers for the connected-context
// assembler (Epic #177, Issue #183). Pure functions: no IO, no clock, no randomness. The
// input `rawContent` is already redacted by the #179 search facade boundary; this module
// only clamps to UTF-8 byte budgets and reports whether the next atom would fit the
// per-pack ExplorationBudget envelope.

import type {
  ContextExcerpt,
  EvidenceAtom,
  ExplorationBudget,
  ExplorationUsage,
} from "@oscharko-dev/keiko-contracts/connected-context";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CompactionInput {
  readonly atom: EvidenceAtom;
  readonly rawContent: string;
  readonly maxBytes: number;
}

export interface CompactionResult {
  readonly excerpt: ContextExcerpt;
  readonly bytesConsumed: number;
  readonly truncated: boolean;
}

export interface BudgetCheckpoint {
  readonly atoms: readonly EvidenceAtom[];
  readonly budget: ExplorationBudget;
  readonly currentUsage: ExplorationUsage;
}

export interface BudgetCheckpointResult {
  readonly fits: boolean;
  readonly violatedDim?: string;
}

// ─── UTF-8 byte clamping ──────────────────────────────────────────────────────

const TEXT_ENCODER = new TextEncoder();
// `fatal: false` so a clamp that lands inside a multi-byte sequence emits U+FFFD instead
// of throwing — we then strip the replacement char to keep the excerpt boundary clean.
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });
const REPLACEMENT_CHAR = "�";

function utf8ByteLength(value: string): number {
  return TEXT_ENCODER.encode(value).length;
}

function clampToBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  const encoded = TEXT_ENCODER.encode(value);
  if (encoded.length <= maxBytes) {
    return value;
  }
  const sliced = encoded.subarray(0, maxBytes);
  const decoded = TEXT_DECODER.decode(sliced);
  if (!decoded.endsWith(REPLACEMENT_CHAR)) {
    return decoded;
  }
  // Strip trailing replacement chars so the excerpt never exposes a partial code point.
  let trimmed = decoded;
  while (trimmed.endsWith(REPLACEMENT_CHAR)) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

// ─── compactExcerpt ───────────────────────────────────────────────────────────

export function compactExcerpt(input: CompactionInput): CompactionResult {
  if (!Number.isInteger(input.maxBytes) || input.maxBytes < 0) {
    throw new RangeError("compactExcerpt: maxBytes must be a non-negative integer");
  }
  const originalBytes = utf8ByteLength(input.rawContent);
  const clamped = clampToBytes(input.rawContent, input.maxBytes);
  const contentBytes = utf8ByteLength(clamped);
  const excerpt: ContextExcerpt = {
    atom: input.atom,
    content: clamped,
    contentBytes,
  };
  return {
    excerpt,
    bytesConsumed: contentBytes,
    truncated: contentBytes < originalBytes,
  };
}

// ─── nextAtomFitsBudget ───────────────────────────────────────────────────────

export function nextAtomFitsBudget(
  cp: BudgetCheckpoint,
  candidateAtomBytes: number,
): BudgetCheckpointResult {
  if (!Number.isFinite(candidateAtomBytes) || candidateAtomBytes < 0) {
    return { fits: false, violatedDim: "excerptBytes" };
  }
  const projectedBytes = cp.currentUsage.excerptBytes + candidateAtomBytes;
  if (projectedBytes > cp.budget.excerptBytesMax) {
    return { fits: false, violatedDim: "excerptBytes" };
  }
  const projectedFiles = cp.currentUsage.filesRead + 1;
  if (projectedFiles > cp.budget.filesReadMax) {
    return { fits: false, violatedDim: "filesRead" };
  }
  return { fits: true };
}
