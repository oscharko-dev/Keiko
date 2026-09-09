import { expect, it } from "vitest";
import { createInitialToolCatalog } from "@oscharko-dev/keiko-tool-catalog";
import { createHarnessCatalogBudget } from "./catalog-budget.js";
import { newCounters } from "./context.js";
import { DEFAULT_LIMITS } from "./types.js";
it.each([99, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
  "latches invalid clock %s after an admitted native budget reservation",
  (invalidNow) => {
    const read = createInitialToolCatalog().descriptors.find(
      (x) => x.toolRef.canonicalId === "keiko.file.read",
    );
    if (read === undefined) throw new TypeError("read descriptor missing");
    let now = 100;
    const context = { runId: "run-1", signal: new AbortController().signal };
    const budget = createHarnessCatalogBudget({
      ...context,
      counters: newCounters(),
      limits: DEFAULT_LIMITS,
      now: () => now,
      deadlineAt: 200,
    });
    const reservation = budget.port.reserve(read, context, "invocation-1");
    if (reservation === undefined) throw new TypeError("reservation missing");
    now = invalidNow;
    expect(budget.port.check(reservation, context)).toBe(false);
    now = 101;
    expect(budget.port.check(reservation, context)).toBe(false);
    expect(budget.port.available(read, context)).toBe(false);
    budget.port.release(reservation);
    expect(budget.port.reserve(read, context, "invocation-2")).toBeUndefined();
  },
);
