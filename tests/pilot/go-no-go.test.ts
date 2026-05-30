// Regression guard for Issue #11 pilot documentation. The evaluation harness contract depends on
// this doc naming the offline thresholds, human-reviewed live-evaluation rule, and exit semantics.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function goNoGoDoc(): string {
  return readFileSync("docs/pilot/go-no-go.md", "utf8");
}

describe("Wave 1 Go/No-Go documentation", () => {
  it("states the offline threshold dimensions", () => {
    const doc = goNoGoDoc();
    expect(doc).toContain("task-completion");
    expect(doc).toContain("patch-correctness");
    expect(doc).toContain("audit-completeness");
    expect(doc).toContain("unsafe-action-rejection");
  });

  it("keeps live-model evaluation human-reviewed", () => {
    const doc = goNoGoDoc();
    expect(doc).toMatch(/live model/i);
    expect(doc).toMatch(/human/i);
  });

  it("documents evaluation CLI exit semantics", () => {
    const doc = goNoGoDoc();
    expect(doc).toContain("### Exit codes");
    expect(doc).toContain("`0`");
    expect(doc).toContain("`1`");
    expect(doc).toContain("`2`");
  });
});
