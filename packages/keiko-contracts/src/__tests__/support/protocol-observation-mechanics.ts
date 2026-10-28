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
