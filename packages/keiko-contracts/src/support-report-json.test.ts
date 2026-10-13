import { describe, expect, expectTypeOf, it } from "vitest";
import { canonicalSupportJson, parseCanonicalSupportJson } from "./support-report-json.js";
import {
  canonicalSupportJson as publicCanonicalSupportJson,
  parseCanonicalSupportJson as publicParseCanonicalSupportJson,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  MAX_SUPPORT_REPORT_EVENT_BYTES,
  MAX_SUPPORT_REPORT_RECORDS,
  MAX_SUPPORT_REPORT_VALUES,
} from "./support-report.js";

describe("canonical support JSON ordering", () => {
  it("uses ascending array-index keys before UTF-16-sorted ordinary object keys", () => {
    expect(
      canonicalSupportJson({ z: true, "10": "ten", "9": "nine", "01": "one", A: null, a: false }),
    ).toBe('{"9":"nine","10":"ten","01":"one","A":null,"a":false,"z":true}');
  });

  it("keeps the ECMAScript array-index boundary and nested ordering deterministic", () => {
    expect(
      canonicalSupportJson({
        z: { "10": true, "9": false },
        "4294967295": "ordinary",
        "4294967294": "index",
        "01": null,
      }),
    ).toBe('{"4294967294":"index","01":null,"4294967295":"ordinary","z":{"9":false,"10":true}}');
  });
});

const canonicalSurfaces: readonly {
  name: string;
  canonical: (value: unknown) => string;
  parse: (text: string, maxBytes: number) => unknown;
}[] = [
  { name: "source", canonical: canonicalSupportJson, parse: parseCanonicalSupportJson },
  { name: "public", canonical: publicCanonicalSupportJson, parse: publicParseCanonicalSupportJson },
];

class CallerSpeciesArray extends Array<unknown> {
  static override get [Symbol.species](): ArrayConstructor {
    throw new TypeError("caller species must not construct canonical output");
  }
}

for (const { name, canonical, parse } of canonicalSurfaces) {
  it(`${name}: canonical array output survives a caller map returning undefined`, () => {
    const value = [1];
    Object.defineProperty(value, "map", { value: (): undefined => undefined });
    expect(canonical(value)).toBe("[1]");
  });

  it(`${name}: canonical array validation cannot skip an unsafe leaf through caller map`, () => {
    const value = ["\u0000"];
    Object.defineProperty(value, "map", { value: (): string[] => ["machine-token"] });
    expect(() => canonical(value)).toThrow(expect.objectContaining({ reason: "unsafe-report" }));
  });

  it(`${name}: canonical array output does not use caller species`, () => {
    const value = new CallerSpeciesArray();
    value.push(1);
    expect(() => canonical(value)).not.toThrow();
    expect(canonical(value)).toBe("[1]");
  });

  it(`${name}: preserves ordinary array order, holes and a single member getter read`, () => {
    const value: unknown[] = new Array<unknown>(3);
    value[0] = null;
    value[2] = true;
    let reads = 0;
    Object.defineProperty(value, "0", {
      get(): string {
        reads += 1;
        return "machine-token";
      },
    });
    expect(canonical(value)).toBe('["machine-token",null,true]');
    expect(reads).toBe(1);
    expect(value).toHaveLength(3);
    expect(Object.hasOwn(value, 1)).toBe(false);
  });

  it(`${name}: preserves an ordinary member getter throw`, () => {
    const failure = new TypeError("fixture member unavailable");
    const value = [null];
    Object.defineProperty(value, "0", {
      get(): never {
        throw failure;
      },
    });
    let observed: unknown;
    try {
      canonical(value);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(failure);
  });

  it.each([Number.NaN, -1, 0.5, Number.POSITIVE_INFINITY])(
    `${name}: refuses an invalid observed array extent %s before reading members`,
    (extent) => {
      let reads = 0;
      const value = new Proxy(["machine-token"], {
        get(target, key): unknown {
          if (key === "length") return extent;
          if (key === "0") {
            reads += 1;
            return target[0];
          }
          return undefined;
        },
      });
      expect(() => canonical(value)).toThrow(
        expect.objectContaining({ reason: "report-budget-exceeded" }),
      );
      expect(reads).toBe(0);
    },
  );

  it(`${name}: admits a zero observed array extent without reading members`, () => {
    let reads = 0;
    const value = new Proxy([], {
      get(_target, key): unknown {
        if (key === "length") return 0;
        if (key === "0") reads += 1;
        return undefined;
      },
    });
    expect(canonical(value)).toBe("[]");
    expect(reads).toBe(0);
  });

  it(`${name}: bounds physical array extent before reading members`, () => {
    const value: unknown[] = new Array<unknown>(MAX_SUPPORT_REPORT_RECORDS + 1);
    let reads = 0;
    Object.defineProperty(value, "0", {
      get(): null {
        reads += 1;
        return null;
      },
    });
    expect(() => canonical(value)).toThrow(
      expect.objectContaining({ reason: "report-budget-exceeded" }),
    );
    expect(reads).toBe(0);
  });

  it(`${name}: charges sparse canonical nulls against the actual parser value ceiling`, () => {
    const value: unknown[][] = [];
    const count = Math.floor(MAX_SUPPORT_REPORT_VALUES / MAX_SUPPORT_REPORT_RECORDS) + 1;
    for (let index = 0; index < count; index += 1) {
      value[index] = new Array<unknown>(MAX_SUPPORT_REPORT_RECORDS);
    }
    let text: string | undefined;
    let failure: unknown;
    try {
      text = canonical(value);
    } catch (error) {
      failure = error;
    }
    // Original writer output must reach the existing parser refusal before the writer pin fails.
    if (text !== undefined) {
      expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
        MAX_SUPPORT_REPORT_EVENT_BYTES,
      );
      expect(() => parse(text, MAX_SUPPORT_REPORT_EVENT_BYTES)).toThrow(
        expect.objectContaining({ reason: "report-budget-exceeded" }),
      );
    }
    expect(failure).toMatchObject({ reason: "report-budget-exceeded" });
  });
}

it("keeps source and actual public canonical parser results unknown", () => {
  expectTypeOf(parseCanonicalSupportJson("null", MAX_SUPPORT_REPORT_EVENT_BYTES)).toBeUnknown();
  expectTypeOf(
    publicParseCanonicalSupportJson("null", MAX_SUPPORT_REPORT_EVENT_BYTES),
  ).toBeUnknown();
});
