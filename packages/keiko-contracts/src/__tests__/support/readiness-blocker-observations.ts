export function severityRankingObservation(shape: string, trace: string[]): unknown[] {
  const entries: unknown[] =
    shape === "out-of-order" ? [{ severity: "advisory" }, { severity: "blocking" }] : [];
  if (shape === "sparse") entries.length = 1;
  if (shape === "undefined") entries[0] = undefined;
  return new Proxy(entries, {
    get(target, key, receiver): unknown {
      if (key === "length" || key === "0" || key === "1") trace.push(key);
      return Reflect.get(target, key, receiver);
    },
  });
}

export function forbiddenAdvisoryObservation(
  trace: string[],
  forbiddenCode: string,
): readonly unknown[] {
  const entries: unknown[] = [
    undefined,
    {
      get severity(): string {
        trace.push("non-advisory.severity");
        return "blocking";
      },
      get code(): never {
        throw new TypeError("non-advisory code must not be inspected");
      },
    },
    {
      get severity(): string {
        trace.push("forbidden.severity");
        return "advisory";
      },
      get code(): string {
        trace.push("forbidden.code");
        return forbiddenCode;
      },
    },
  ];
  Object.defineProperty(entries, "3", {
    get: (): never => {
      throw new TypeError("entries after the forbidden advisory must not be inspected");
    },
  });
  return new Proxy(entries, {
    get(target, key, receiver): unknown {
      if (key === "length" || key === "0" || key === "1" || key === "2" || key === "3") {
        trace.push(key);
      }
      return Reflect.get(target, key, receiver);
    },
  });
}
