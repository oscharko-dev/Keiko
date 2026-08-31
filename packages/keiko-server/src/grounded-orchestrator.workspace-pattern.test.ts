// Relocated S8786 pin for workspace-pattern trailing-slash trimming (#3347).
// The former pin wrapped a full `retrieveConnectedContextPack` call in a 2000ms wall-clock
// budget, so it measured whole-pipeline latency rather than `stripTrailingSlashes` /
// `normalizeWorkspacePattern`. Those helpers are the rewrite that replaced `/\/+$/u`.

import { describe, expect, it } from "vitest";
import { normalizeWorkspacePattern, stripTrailingSlashes } from "./grounded-orchestrator.js";

describe("stripTrailingSlashes", () => {
  it("strips one or more trailing slashes and leaves a slash-free tail unchanged", () => {
    expect(stripTrailingSlashes("packages/pkg/")).toBe("packages/pkg");
    expect(stripTrailingSlashes("packages/pkg///")).toBe("packages/pkg");
    expect(stripTrailingSlashes("packages/pkg")).toBe("packages/pkg");
    expect(stripTrailingSlashes("")).toBe("");
    expect(stripTrailingSlashes("///")).toBe("");
  });

  // The adversarial shape for the OLD `/\/+$/u` regex is a long run of "/" blocked from the
  // true end by one non-"/" character. A backtracking engine retries at every position in the
  // run; a trailing-slash-only string is the happy path for that regex and would not catch a
  // regression. Relocated from the 2000ms pipeline pin (#3347); budget unchanged.
  it("stays within 2000ms for a long slash run blocked by a trailing character", () => {
    const adversarial = `${"/".repeat(100_000)}!`;
    const start = Date.now();
    const result = stripTrailingSlashes(adversarial);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(result).toBe(adversarial);
  });
});

describe("normalizeWorkspacePattern", () => {
  it("normalizes separators and prefixes, strips trailing slashes, and rejects escapes", () => {
    expect(normalizeWorkspacePattern("packages/pkg/")).toBe("packages/pkg");
    expect(normalizeWorkspacePattern("./packages/pkg///")).toBe("packages/pkg");
    expect(normalizeWorkspacePattern("packages\\pkg\\")).toBe("packages/pkg");
    expect(normalizeWorkspacePattern("../escape")).toBeUndefined();
    expect(normalizeWorkspacePattern("packages/../secret")).toBeUndefined();
    expect(normalizeWorkspacePattern("///")).toBeUndefined();
    expect(normalizeWorkspacePattern("   ")).toBeUndefined();
  });

  it("strips an adversarial trailing-slash run without wrapping the retrieval pipeline", () => {
    const pattern = `packages/pkg${"/".repeat(20_000)}`;
    const start = Date.now();
    expect(normalizeWorkspacePattern(pattern)).toBe("packages/pkg");
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
