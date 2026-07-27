import { describe, expect, it } from "vitest";

import { collectFailures } from "../check-grounded-retrieval-quality.mjs";

describe("grounded retrieval quality gate failures", () => {
  it("fails closed for tautological, absent, and unresolved regression probes", () => {
    expect(
      collectFailures(
        { ok: true, failures: [] },
        { ok: true, failures: [] },
        {
          probed: 0,
          tautological: ["reranker-reversed"],
          unresolved: ["embedding-flat"],
        },
      ),
    ).toEqual([
      "injected regression 'reranker-reversed' did NOT drop below floors (tautological gate)",
      "injected regressions did not run",
      "unresolved injected regressions: embedding-flat",
    ]);
  });
});
