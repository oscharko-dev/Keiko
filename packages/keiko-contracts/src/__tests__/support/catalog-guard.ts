import { expect } from "vitest";

/** The guard accepts every catalog string and refuses foreign candidates without coercing them. */
export function expectCatalogGuardWithoutCoercion(
  guard: (candidate: unknown) => boolean,
  catalog: readonly string[],
): void {
  for (const legal of catalog) expect(guard(legal)).toBe(true);
  let coercions = 0;
  const coercionCandidate = {
    [Symbol.toPrimitive](): never {
      coercions += 1;
      throw new TypeError("voice catalog candidate must not be coerced");
    },
  };
  const boxed: unknown = Object(catalog[0]);
  const refused: readonly unknown[] = [
    "foreign-voice-catalog-entry",
    "",
    undefined,
    null,
    0,
    true,
    Symbol("voice-catalog-candidate"),
    boxed,
    coercionCandidate,
  ];
  for (const candidate of refused) expect(guard(candidate)).toBe(false);
  expect(coercions).toBe(0);
}
