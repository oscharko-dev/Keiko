// Reciprocal Rank Fusion (Cormack et al. 2009, k=60) over candidates from two retrieval engines
// whose native scores are NOT comparable (folder lexical vs connector vector). Each engine's
// candidates are ranked among themselves; RRF fuses by rank; a shared budget then selects globally
// so neither engine structurally dominates. Deterministic. See ADR-0036.

export const RRF_K = 60;

export type RerankKind = "folder" | "connector";

export interface RerankInput<P> {
  readonly kind: RerankKind;
  readonly redactedText: string; // excerpt text ALREADY redacted by the caller (prompt-ready)
  readonly engineScore: number; // native within-engine relevance (used ONLY for within-engine rank)
  readonly sourceLabel: string;
  readonly tieKey: string; // stable, unique-within-kind key for deterministic tie-break
  readonly payload: P; // opaque; returned on the selected candidates for citation building
}

export interface RerankBudget {
  readonly maxCandidates: number; // hybridMaxCandidates
  readonly maxExcerptBytes: number; // hybridMaxExcerptBytes (measured on redactedText byte length)
}

export interface SelectedCandidate<P> {
  readonly kind: RerankKind;
  readonly redactedText: string;
  readonly bytes: number; // Buffer.byteLength(redactedText, "utf8")
  readonly sourceLabel: string;
  readonly engineRank: number; // 1-based within its engine
  readonly fusedScore: number; // quantized RRF score
  readonly marker: number; // 1-based GLOBAL marker assigned in final selection order
  readonly payload: P;
}

// ─── Internal ranked record ───────────────────────────────────────────────────

interface Ranked<P> {
  readonly input: RerankInput<P>;
  readonly engineRank: number;
  readonly fusedScore: number;
  readonly bytes: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function quantize(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

// Partition inputs by kind, rank within each kind, return merged ranked list.
// Tie-break order within the merged sort:
//   1. fusedScore DESC
//   2. kind: "connector" before "folder" — anti-dominance at rank parity: a connector never loses
//      a same-rank tie to a folder. This preserves equal representation when both engines produce
//      identical top-k ranks.
//   3. tieKey ASC — stable, deterministic across any input permutation.
function buildRanked<P>(inputs: readonly RerankInput<P>[]): readonly Ranked<P>[] {
  const folders = inputs.filter((i) => i.kind === "folder");
  const connectors = inputs.filter((i) => i.kind === "connector");

  function rankGroup(group: readonly RerankInput<P>[]): readonly Ranked<P>[] {
    const sorted = [...group].sort(
      (a, b) => b.engineScore - a.engineScore || a.tieKey.localeCompare(b.tieKey),
    );
    return sorted.map((input, idx) => {
      const engineRank = idx + 1;
      return {
        input,
        engineRank,
        fusedScore: quantize(1 / (RRF_K + engineRank)),
        bytes: Buffer.byteLength(input.redactedText, "utf8"),
      };
    });
  }

  const ranked = [...rankGroup(folders), ...rankGroup(connectors)];

  // Sort merged list: score DESC, then connector before folder, then tieKey ASC.
  ranked.sort((a, b) => {
    if (b.fusedScore !== a.fusedScore) return b.fusedScore - a.fusedScore;
    if (a.input.kind !== b.input.kind) {
      // "connector" < "folder" lexicographically, but we want connector FIRST.
      return a.input.kind === "connector" ? -1 : 1;
    }
    return a.input.tieKey.localeCompare(b.input.tieKey);
  });

  return ranked;
}

// ─── Public function ──────────────────────────────────────────────────────────

export function rerankAndSelect<P>(
  inputs: readonly RerankInput<P>[],
  budget: RerankBudget,
): readonly SelectedCandidate<P>[] {
  if (inputs.length === 0) return [];

  const ranked = buildRanked(inputs);
  const selected: SelectedCandidate<P>[] = [];
  let runningBytes = 0;

  for (const r of ranked) {
    if (selected.length >= budget.maxCandidates) break;

    const fits = runningBytes + r.bytes <= budget.maxExcerptBytes;
    // Floor: always keep the first candidate even if it alone exceeds the byte budget.
    if (!fits && selected.length > 0) continue;

    runningBytes += r.bytes;
    selected.push({
      kind: r.input.kind,
      redactedText: r.input.redactedText,
      bytes: r.bytes,
      sourceLabel: r.input.sourceLabel,
      engineRank: r.engineRank,
      fusedScore: r.fusedScore,
      marker: selected.length + 1,
      payload: r.input.payload,
    });
  }

  return selected;
}
