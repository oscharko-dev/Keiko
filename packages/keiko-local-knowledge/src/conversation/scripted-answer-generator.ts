// Deterministic scripted `AnswerGenerator` (Epic #189, Issue #200). Test-only fixture
// that turns a `LocalKnowledgeGroundedContextPack` into a stable answer string. The
// production path uses `ModelGatewayAnswerGenerator`; this implementation exists so the
// runner's composition can be tested without a live model gateway.
//
// Determinism rules (load-bearing for the audit ledger's "byte-identical replay"):
//   * NO `Date.now()`, `Math.random()`, `randomUUID()`, environment reads, or any other
//     non-input-derived state. The output is a pure function of `pack.counts` and
//     `pack.scope.capsuleIds`.
//   * Capsule ids are surfaced in the order the pack assembler already sorted them
//     (lexicographic, de-duplicated) so two calls with identically-shaped packs produce
//     byte-identical strings.
//   * Inline `[n]` citation markers are emitted for every reference in the pack, in
//     order. The runner's citation-attacher matches these markers back against the
//     reference array — keeping the marker emission in this generator means the round-
//     trip (generate → attach) is provable without consulting a real model.

import type { AnswerGenerator, AnswerGeneratorInput } from "./types.js";

export class ScriptedAnswerGenerator implements AnswerGenerator {
  public async generate(input: AnswerGeneratorInput): Promise<string> {
    return Promise.resolve(buildScriptedAnswer(input));
  }
}

// Exported for direct testing — keeps the determinism contract pinnable without
// instantiating the class. Pure: no IO, no allocation beyond the returned string.
export function buildScriptedAnswer(input: AnswerGeneratorInput): string {
  const { pack } = input;
  const n = pack.counts.totalReferences;
  if (n === 0) {
    // The runner does not call the generator on no-evidence paths, but a defensive empty
    // string keeps the function total in case a future caller forgets that contract.
    return "";
  }
  const capsuleList = formatCapsuleList(pack.scope.capsuleIds);
  const markers = renderMarkerList(n);
  return `Found ${String(n)} references in ${capsuleList}. ${markers}`;
}

function formatCapsuleList(capsuleIds: readonly { toString(): string }[]): string {
  if (capsuleIds.length === 0) return "capsule(s) (unknown)";
  if (capsuleIds.length === 1) return `capsule(s) ${String(capsuleIds[0])}`;
  return `capsule(s) ${capsuleIds.map((id) => String(id)).join(", ")}`;
}

function renderMarkerList(count: number): string {
  const parts: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    parts.push(`[${String(i)}]`);
  }
  return parts.join(" ");
}
