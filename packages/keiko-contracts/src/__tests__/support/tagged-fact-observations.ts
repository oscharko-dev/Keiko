import { expect } from "vitest";

/**
 * A known tagged fact whose second own-key inspection throws: admission must propagate that exact
 * failure after reading only the outcome, never the value.
 */
export function expectKeyInspectionFailure(admit: (fact: object) => unknown, value: string): void {
  const failure = new TypeError("opaque tagged-fact key inspection");
  const trace: string[] = [];
  let inspections = 0;
  const fact = new Proxy(
    { outcome: "known", value },
    {
      ownKeys(target): (string | symbol)[] {
        inspections += 1;
        trace.push(`keys:${String(inspections)}`);
        if (inspections === 2) throw failure;
        return Reflect.ownKeys(target);
      },
      get(target, key, receiver): unknown {
        trace.push(`get:${String(key)}`);
        return Reflect.get(target, key, receiver);
      },
    },
  );
  let observed: unknown;
  try {
    admit(fact);
  } catch (error) {
    observed = error;
  }
  expect(observed).toBe(failure);
  expect(trace).toEqual(["keys:1", "get:outcome", "keys:2"]);
}
