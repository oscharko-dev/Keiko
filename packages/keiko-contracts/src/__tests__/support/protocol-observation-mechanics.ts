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

function observeCapturedExtent(
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
