import { describe, expect, it } from "vitest";
import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "./_memfs.js";
import { DEFAULT_SEARCH_LIMITS, searchText, type SearchScope } from "./repoSearch.js";
import { fingerprintFor, queryIdentityFor } from "./repoSearchMatchers.js";

const query: RetrievalQuery = {
  kind: "natural-language",
  text: "Trace authorization. Cite implementation files and lines.",
  caseSensitive: false,
  maxResults: 20,
  emittedAtMs: 0,
};

function scope(): SearchScope {
  return {
    scopeId: "subject-normalization",
    relativePaths: [],
    workspace: {
      root: "/ws",
      selectedRoot: "/ws",
      name: "subject",
      version: "0.0.0",
      testFramework: "unknown",
      sourceDirs: [],
      testDirs: [],
      languages: [],
      ignoreLines: [],
    },
  };
}

describe("repository query subject diagnostics", () => {
  it.each([null, 20])(
    "observes removed clauses on streamed and bounded scans: %s",
    async (maxFilesScanned) => {
      const result = await searchText(
        scope(),
        query,
        { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned },
        {
          fs: memFs("/ws", {
            "src/authorization.ts":
              "export function authorizeRequest(policy) { return policy.allowed; }\n",
          }),
        },
      );
      expect(result.diagnostics?.citationDirectiveClauseCount).toBe(1);
    },
  );

  it("does not report normalization for trusted literal matching", async () => {
    const result = await searchText(scope(), query, DEFAULT_SEARCH_LIMITS, {
      fs: memFs("/ws", { "manual.txt": "authorizeRequest\n" }),
      queryInterpretation: { kind: "literal", terms: ["authorizeRequest"] },
    });
    expect(result.diagnostics?.citationDirectiveClauseCount).toBeUndefined();
  });

  it("invalidates prior persistent natural-language matches while preserving other identities", () => {
    const settings = { effectiveMaxMatchesReturned: 20, policyIntent: "targeted-code-search" };
    // Frozen outputs of the pre-correction compiled producer, not a reimplementation of its hash.
    expect(queryIdentityFor(query, undefined, settings)).not.toBe(
      "6652b0a39a099c340b8c360f9ba784db36d7142fa808d0ce49a62b55751d95ba",
    );
    expect(fingerprintFor(query)).toBe("4db3fdc61744f46d");
    expect(
      queryIdentityFor(
        { ...query, kind: "exact-symbol", text: "authorizeRequest" },
        undefined,
        settings,
      ),
    ).toBe("9494efdcef8aae99d9ea1d2ca51817ed4dfa74e0a5f6b6e9ec69515e98e1063a");
    expect(
      queryIdentityFor(query, { kind: "literal", terms: ["authorizeRequest"] }, settings),
    ).toBe("39d5d759e1ac266817281a6d3598d623adf41444e564323e48d76c7f3f4d80cd");
  });
});
