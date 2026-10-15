import { describe, expect, it } from "vitest";
import { orderCandidatesForSearch, resolveSearchPolicy } from "./repoSearchPolicy.js";

describe("exact path scan bucket", () => {
  it.each(["src/Form/validation.ts", "Form/validation.ts"])(
    "produces the exact-path bucket for %s",
    (text) => {
      const result = orderCandidatesForSearch({
        files: [
          { relativePath: "src/Form/validation.ts", sizeBytes: 10 },
          { relativePath: "validation.ts", sizeBytes: 10 },
        ],
        query: {
          kind: "natural-language",
          text,
          caseSensitive: false,
          maxResults: 50,
          emittedAtMs: 1,
        },
        policy: resolveSearchPolicy(false, { retrievalIntent: "targeted-code-search" }),
        ignoredByDiscovery: 0,
        deniedByDiscovery: 0,
      });
      expect(
        result.diagnostics.rankedCandidates.find(
          (entry) => entry.scopePath === "src/Form/validation.ts",
        )?.bucket,
      ).toBe("exact-path");
      expect(result.files[0]?.relativePath).toBe("src/Form/validation.ts");
    },
  );
});
