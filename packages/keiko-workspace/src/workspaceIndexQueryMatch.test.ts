import { describe, expect, it } from "vitest";
import { normalizeWorkspaceIndexQueryMatch } from "./workspaceIndexQueryMatch.js";

const BASE = {
  queryIdentitySha256: "12".repeat(32),
  best: [{ line: 1, startLine: 1, endLine: 2, score: 0.5 }],
  maxScore: 0.5,
};

describe("persisted query-group identity", () => {
  it("retains only the closed source-description witness alongside an identified query", () => {
    const best = [{ ...BASE.best[0], sourceDescriptorMatch: true }];
    expect(normalizeWorkspaceIndexQueryMatch({ ...BASE, best })).toEqual({ ...BASE, best });
  });
  it.each([false, 0, "true", null])(
    "rejects a malformed source-description witness: %s",
    (sourceDescriptorMatch) => {
      expect(
        normalizeWorkspaceIndexQueryMatch({
          ...BASE,
          best: [{ ...BASE.best[0], sourceDescriptorMatch }],
        }),
      ).toBeUndefined();
    },
  );
  it("keeps a bounded group bitset and drops unknown payload fields", () => {
    const best = [{ ...BASE.best[0], queryGroupKey: "3" }];
    const result = normalizeWorkspaceIndexQueryMatch({
      ...BASE,
      best: best.map((line) => ({ ...line, untrusted: "source body must not persist" })),
    });
    expect(result).toEqual({ ...BASE, best });
  });

  it("preserves legacy records without granting a query-group identity", () => {
    expect(normalizeWorkspaceIndexQueryMatch(BASE)).toEqual(BASE);
  });

  it.each(["", "0", "1", "2", "80", "03", "C", "f".repeat(33), 5, null])(
    "rejects malformed group identity %s",
    (queryGroupKey) => {
      expect(
        normalizeWorkspaceIndexQueryMatch({
          ...BASE,
          best: [{ ...BASE.best[0], queryGroupKey }],
        }),
      ).toBeUndefined();
    },
  );
});
