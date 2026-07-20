// Shared deterministic numeric helpers for evaluation harnesses (ADR-0152 D5). These functions
// are deliberately pure and structural so package-owned suites and layer-free gate scripts can
// reuse one implementation without importing a system under test.

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function discountedGain(relevance: readonly boolean[]): number {
  let score = 0;
  for (let index = 0; index < relevance.length; index += 1) {
    if (relevance[index] === true) score += 1 / Math.log2(index + 2);
  }
  return score;
}

export function binaryNdcgAtK<Value>(
  ranked: readonly Value[],
  relevant: readonly Value[],
  k: number,
): number {
  const limit = Math.max(0, Math.floor(k));
  const relevantSet = new Set(relevant);
  const actual = ranked.slice(0, limit).map((value) => relevantSet.has(value));
  const idealCount = Math.min(limit, relevantSet.size);
  const ideal = Array.from({ length: idealCount }, () => true);
  const idealGain = discountedGain(ideal);
  return idealGain === 0 ? 1 : discountedGain(actual) / idealGain;
}
