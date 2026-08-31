// Relocated S8786 pin for workspace-pattern trailing-slash trimming (#3347).
// The former pin wrapped a full `retrieveConnectedContextPack` call in a 2000ms wall-clock
// budget, so it measured whole-pipeline latency rather than `stripTrailingSlashes` /
// `normalizeWorkspacePattern`. Those helpers are the rewrite that replaced `/\/+$/u`.
// Required-path tests stay behavioral (ADR-0139 D1): they do not assert wall-clock.

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
  // regression.
  it("returns a slash run that is blocked from the true end unchanged", () => {
    const adversarial = `${"/".repeat(100_000)}!`;
    expect(stripTrailingSlashes(adversarial)).toBe(adversarial);
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

  it("runs the blocked slash-run shape through the product normalizer", () => {
    const pattern = `${"/".repeat(100_000)}!`;
    expect(normalizeWorkspacePattern(pattern)).toBe(pattern);
  });
});
