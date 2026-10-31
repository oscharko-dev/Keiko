import { expect, it } from "vitest";

export function protocolEnumerationInput(trace: string[]): object {
  return new Proxy(
    {},
    {
      ownKeys(): string[] {
        trace.push("ownKeys");
        return ["unexpected", "schemaVersion"];
      },
      getOwnPropertyDescriptor(_target, key): PropertyDescriptor {
        trace.push(`descriptor:${String(key)}`);
        return { configurable: true, enumerable: true, value: undefined, writable: true };
      },
      get(_target, key): never {
        trace.push(`get:${String(key)}`);
        throw new TypeError("Protocol field inspection after key enumeration");
      },
    },
  );
}

export function installIgnoredProtocolMetadata(value: object, onRead: () => void): void {
  const inspect = (): never => {
    onRead();
    throw new TypeError("Ignored metadata was read");
  };
  Object.defineProperty(value, "ignoredMetadata", { enumerable: false, get: inspect });
  Object.defineProperty(value, Symbol("ignoredMetadata"), { enumerable: true, get: inspect });
}

interface CapturedExtentObservation {
  readonly observed: unknown[];
  readonly indexReads: number;
  readonly lengths: readonly unknown[];
}

export function observeCapturedExtent(
  values: unknown[],
  laterExtent: number,
  firstObservation: { readonly first: unknown },
  traversalBound: () => number,
): CapturedExtentObservation {
  const lengths: unknown[] = [];
  let indexReads = 0;
  let nativeVisits = 0;
  const observed = new Proxy(values, {
    get(target, key, receiver): unknown {
      if (key === "length") {
        const length =
          lengths.length === 0
            ? firstObservation.first
            : lengths.length === 1
              ? laterExtent
              : target.length;
        lengths.push(length);
        return length;
      }
      if (typeof key === "string" && /^\d+$/u.test(key)) indexReads += 1;
      const datum: unknown = Reflect.get(target, key, receiver);
      return datum;
    },
    has(target, key): boolean {
      if (typeof key === "string" && /^\d+$/u.test(key)) nativeVisits += 1;
      if (nativeVisits > traversalBound()) throw new TypeError("fixture native traversal bound");
      return Reflect.has(target, key);
    },
  });
  return {
    observed,
    get indexReads(): number {
      return indexReads;
    },
    lengths,
  };
}

export function knowledgeCapturedExtentMembers(
  values: unknown[],
  trace: string[],
  state: string,
): unknown[] {
  let lengthReads = 0;
  return new Proxy(values, {
    get(target, key): unknown {
      if (key === "length") {
        trace.push("length");
        lengthReads += 1;
        if (state === "invalid") return Number.NaN;
        if (lengthReads > 1 && state === "growth") return 2;
        if (lengthReads > 1 && state === "shrink") return 0;
        return 1;
      }
      if (key === "0") trace.push("0");
      const value: unknown = Reflect.get(target, key);
      return value;
    },
  });
}

export function knowledgeFinalExtentFailureMembers(
  values: unknown[],
  trace: string[],
  refusal: Error,
): unknown[] {
  let lengthReads = 0;
  return new Proxy(values, {
    get(target, key): unknown {
      if (key === "length") {
        trace.push("length");
        lengthReads += 1;
        if (lengthReads === 2) throw refusal;
      }
      if (key === "0") trace.push("0");
      const value: unknown = Reflect.get(target, key);
      return value;
    },
  });
}

export function knowledgeRejectedTextMembers(
  values: unknown[],
  trace: string[],
  finalExtentRefusal: string,
): unknown[] {
  let lengthReads = 0;
  return new Proxy(values, {
    get(target, key, receiver): unknown {
      trace.push(`get:${String(key)}`);
      if (key === "length" && ++lengthReads === 2) throw new TypeError(finalExtentRefusal);
      const value: unknown = Reflect.get(target, key, receiver);
      return value;
    },
    has(target, key): boolean {
      trace.push(`has:${String(key)}`);
      return Reflect.has(target, key);
    },
  });
}

export interface CapturedExtentSubject {
  /** One healthy collection member. */
  readonly member: unknown;
  /** The collection's admission limit. */
  readonly bound: number;
  /** Admits a healthy payload carrying `observed` as the bounded collection. */
  readonly admit: (observed: unknown[]) => boolean;
}

/** Registers the captured-extent cases shared by every bounded protocol collection. */
export function itPreservesCapturedExtent(subject: CapturedExtentSubject): void {
  function inspectExtent(
    laterExtent: number,
    firstObservation: { readonly first: unknown } = { first: 1 },
  ): {
    readonly result: boolean;
    readonly indexReads: number;
    readonly lengths: readonly unknown[];
  } {
    const observation = observeCapturedExtent(
      [subject.member],
      laterExtent,
      firstObservation,
      () => subject.bound + 1,
    );
    return {
      result: subject.admit(observation.observed),
      indexReads: observation.indexReads,
      lengths: observation.lengths,
    };
  }
  it("preserves a healthy actual captured extent", () => {
    const observation = inspectExtent(1);
    expect(observation.result).toBe(true);
    expect(observation.lengths.slice(0, 2)).toEqual([1, 1]);
    expect(observation.indexReads).toBeGreaterThan(0);
  });
  it.each([NaN, undefined])("preserves original first-limit refusal for %s", (first) => {
    const observation = inspectExtent(1, { first });
    expect(observation).toEqual({ result: false, indexReads: 0, lengths: [first] });
  });
  it.each([subject.bound + 1, Infinity, 0.5, -1])(
    "refuses captured extent %s before indexing",
    (extent) => {
      const observation = inspectExtent(extent);
      expect({
        accepted: observation.result,
        indexReads: observation.indexReads,
        firstTwoLengths: observation.lengths.slice(0, 2),
      }).toEqual({
        accepted: false,
        indexReads: 0,
        firstTwoLengths: [1, extent],
      });
    },
  );
}

/** A copy of `values` whose second length read reports `laterExtent`; reads are counted. */
export function observeConsumedExtent(
  values: readonly unknown[],
  laterExtent: number,
): {
  readonly array: readonly unknown[];
  readonly snapshot: () => { readonly lengthReads: number; readonly indexReads: number };
} {
  let lengthReads = 0;
  let indexReads = 0;
  const array = new Proxy([...values], {
    get(target, property, receiver): unknown {
      if (property === "length") return ++lengthReads === 2 ? laterExtent : target.length;
      if (typeof property === "string" && /^\d+$/u.test(property)) indexReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return { array, snapshot: () => ({ lengthReads, indexReads }) };
}
