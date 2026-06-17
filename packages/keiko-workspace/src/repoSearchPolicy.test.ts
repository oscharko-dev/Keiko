import { describe, expect, it } from "vitest";

import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import {
  legacyDiscoveryPolicy,
  orderCandidatesForSearch,
  resolveSearchPolicy,
  type SearchPolicy,
} from "./repoSearchPolicy.js";
import type { DiscoveredFile } from "./types.js";

const file = (relativePath: string): DiscoveredFile => ({ relativePath, sizeBytes: 10 });

const query = (text: string): RetrievalQuery => ({
  kind: "natural-language",
  text,
  caseSensitive: false,
  maxResults: 100,
  emittedAtMs: 0,
});

describe("resolveSearchPolicy", () => {
  it("applies gitignore + low-value omission only for the workspace-root default", () => {
    const rootDefault = resolveSearchPolicy(false, undefined);
    expect(rootDefault.mode).toBe("workspace-root-default");
    expect(rootDefault.applyGitignore).toBe(true);
    expect(rootDefault.omitLowValueWorkspaceFiles).toBe(true);

    const explicit = resolveSearchPolicy(true, undefined);
    expect(explicit.mode).toBe("explicit-scope");
    expect(explicit.applyGitignore).toBe(false);
    expect(explicit.omitLowValueWorkspaceFiles).toBe(false);
  });
});

describe("legacyDiscoveryPolicy", () => {
  it("never applies gitignore or low-value omission, preserving full-tree discovery for legacy callers", () => {
    for (const hasExplicit of [false, true]) {
      const policy = legacyDiscoveryPolicy(hasExplicit);
      expect(policy.applyGitignore).toBe(false);
      expect(policy.omitLowValueWorkspaceFiles).toBe(false);
      expect(policy.intent).toBe("generic");
    }
  });
});

describe("orderCandidatesForSearch", () => {
  const policy: SearchPolicy = resolveSearchPolicy(false, {
    retrievalIntent: "targeted-code-search",
  });

  it("ranks a basename-matching source file above docs that merely mention the term", () => {
    const files = [
      file("docs/payments.md"),
      file("packages/core/src/PaymentReconciler.ts"),
      file("README.md"),
    ];
    const { files: ordered } = orderCandidatesForSearch(
      files,
      query("Where is PaymentReconciler implemented"),
      policy,
      0,
      0,
    );
    expect(ordered[0]?.relativePath).toBe("packages/core/src/PaymentReconciler.ts");
  });

  it("is deterministic and locale-independent on score ties (code-point order)", () => {
    const files = [file("src/zeta.ts"), file("src/alpha.ts"), file("src/Beta.ts")];
    const run = (): readonly string[] =>
      orderCandidatesForSearch(files, query("unrelated"), policy, 0, 0).files.map(
        (f) => f.relativePath,
      );
    // Upper-case 'B' (0x42) sorts before lower-case letters in code-point order — a localeCompare
    // tiebreak would instead fold case and reorder, so this pins the deterministic contract.
    expect(run()).toEqual(["src/Beta.ts", "src/alpha.ts", "src/zeta.ts"]);
    expect(run()).toEqual(run());
  });

  it("reports discovery omission counts in diagnostics", () => {
    const { diagnostics } = orderCandidatesForSearch([file("a.ts")], query("a"), policy, 7, 3);
    expect(diagnostics.ignoredByDiscovery).toBe(7);
    expect(diagnostics.deniedByDiscovery).toBe(3);
    expect(diagnostics.filesAfterPolicy).toBe(1);
  });
});
