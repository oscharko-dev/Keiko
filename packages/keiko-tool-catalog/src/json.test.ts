import { describe, expect, it } from "vitest";
import {
  GENERIC_TOOL_ARGUMENT_LIMITS,
  TOOL_CATALOG_LIMITS,
  type CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { deepFreeze } from "@oscharko-dev/keiko-contracts/runtime/deep-freeze";
import {
  catalogBytes,
  copyCatalogEnvelope,
  copyCatalogEnvelopeRetaining,
  measureCatalogFootprint,
} from "./json.js";

// The envelope copy keeps a value its issuer vouches for and charges that value's measured
// footprint instead of copying it (#4288). Each case runs the same input through the copy path
// and the kept path at a bound and one past it: the two must decide alike.
const ENVELOPE_DEPTH = TOOL_CATALOG_LIMITS.maxSchemaDepth + 6;

type Wrap = (inner: CatalogJsonValue) => CatalogJsonValue;

function nested(levels: number): CatalogJsonValue {
  let value: CatalogJsonValue = "leaf";
  for (let level = 1; level < levels; level += 1) value = { next: value };
  return deepFreeze(value);
}

function bothPaths(wrap: Wrap, inner: CatalogJsonValue): readonly (() => unknown)[] {
  const kept = (value: object): ReturnType<typeof measureCatalogFootprint> | undefined =>
    value === inner ? measureCatalogFootprint(inner) : undefined;
  return [
    (): CatalogJsonValue => copyCatalogEnvelope(wrap(inner)),
    (): CatalogJsonValue => copyCatalogEnvelopeRetaining(wrap(inner), kept),
  ];
}

function expectBothAccept(wrap: Wrap, inner: CatalogJsonValue): void {
  for (const path of bothPaths(wrap, inner)) expect(path).not.toThrow();
}

function expectBothRefuse(wrap: Wrap, inner: CatalogJsonValue): void {
  for (const path of bothPaths(wrap, inner)) expect(path).toThrow("input-bound");
}

describe("kept envelope values decide every bound like a copy", () => {
  it("measures what a copy charges", () => {
    const value = nested(4);
    expect(measureCatalogFootprint(value)).toEqual({
      bytes: catalogBytes(value),
      depth: 4,
      longestString: 4,
    });
  });

  it("keeps the vouched value itself and copies everything else", () => {
    const inner = nested(3);
    const copied = copyCatalogEnvelopeRetaining({ wrapper: inner }, (value) =>
      value === inner ? measureCatalogFootprint(inner) : undefined,
    );
    expect((copied as { readonly wrapper: CatalogJsonValue }).wrapper).toBe(inner);
    expect(
      (copyCatalogEnvelope({ wrapper: inner }) as { readonly wrapper: unknown }).wrapper,
    ).not.toBe(inner);
  });

  it("agrees at the depth bound and one level past it", () => {
    // The wrapper object is level 1 and its array level 2, so the kept value starts at level 3.
    const wrap: Wrap = (inner) => ({ wrapper: [inner] });
    expectBothAccept(wrap, nested(ENVELOPE_DEPTH - 2));
    expectBothRefuse(wrap, nested(ENVELOPE_DEPTH - 1));
  });

  it("agrees at the string bound and one byte past it", () => {
    const wrap: Wrap = (inner) => ({ wrapper: inner });
    const longest = GENERIC_TOOL_ARGUMENT_LIMITS.maxStringBytes;
    const text = (length: number): CatalogJsonValue => deepFreeze({ text: "x".repeat(length) });
    expectBothAccept(wrap, text(longest));
    expectBothRefuse(wrap, text(longest + 1));
  });

  it("agrees at the byte bound and one byte past it", () => {
    const wrap: Wrap = (inner) => ({ wrapper: inner });
    const strings = (extra: number): CatalogJsonValue =>
      deepFreeze([
        ...["a", "b", "c", "d"].map((key) => ({ [key]: "x".repeat(60_000) })),
        { e: "x".repeat(extra) },
      ]);
    const room = TOOL_CATALOG_LIMITS.maxArgumentBytes - catalogBytes(wrap(strings(0)));
    expect(catalogBytes(wrap(strings(room)))).toBe(TOOL_CATALOG_LIMITS.maxArgumentBytes);
    expectBothAccept(wrap, strings(room));
    expectBothRefuse(wrap, strings(room + 1));
  });
});
