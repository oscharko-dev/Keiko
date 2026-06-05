// Exhaustiveness helper for discriminated unions across the Quality Intelligence
// contract surface (Epic #270, Issue #277). Pure; throws at runtime if the type
// system has been bypassed (e.g. via `as`). Mirrors the convention used in
// `memory-internal.ts` (`assertNeverMemoryType`) but is shared by every QI union.
export const assertQualityIntelligenceNever = (value: never): never => {
  throw new TypeError(`Unexpected Quality Intelligence discriminant: ${JSON.stringify(value)}`);
};
