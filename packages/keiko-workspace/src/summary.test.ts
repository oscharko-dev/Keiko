import { describe, expect, it } from "vitest";
import { buildWorkspaceSummary, summarizeForAudit } from "./summary.js";
import type { ContextPack, DiscoveryStats, WorkspaceInfo } from "./types.js";

function workspace(): WorkspaceInfo {
  return {
    root: "/ws",
    name: "demo",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript", "javascript"],
    ignoreLines: [],
  };
}

function pack(): ContextPack {
  return {
    workspaceRoot: "/ws",
    totalCandidates: 5,
    selected: [
      {
        path: "src/index.ts",
        sizeBytes: 100,
        excerptBytes: 80,
        selectionReason: "entrypoint",
        truncated: false,
        excerpt: "export const x = 1;",
      },
    ],
    usedBytes: 80,
    budgetBytes: 1_000,
    droppedForBudget: 2,
  };
}

describe("buildWorkspaceSummary", () => {
  it("returns the structured metadata without a context section when no pack is given", () => {
    const summary = buildWorkspaceSummary(workspace());
    expect(summary.root).toBe("/ws");
    expect(summary.name).toBe("demo");
    expect(summary.testFramework).toBe("vitest");
    expect(summary.context).toBeUndefined();
  });

  it("includes the context section with per-entry metadata when a pack is given", () => {
    const summary = buildWorkspaceSummary(workspace(), pack());
    expect(summary.context).toBeDefined();
    expect(summary.context?.entries.length).toBe(1);
    expect(summary.context?.entries[0]?.selectionReason).toBe("entrypoint");
    expect(summary.context?.droppedForBudget).toBe(2);
  });

  it("uses explicit discovery stats when supplied", () => {
    const stats: DiscoveryStats = { discovered: 5, denied: 3, ignored: 7 };
    expect(buildWorkspaceSummary(workspace(), pack(), stats).counts).toEqual(stats);
  });

  it("defaults denied/ignored to zero and discovered to candidates when stats absent", () => {
    const summary = buildWorkspaceSummary(workspace(), pack());
    expect(summary.counts.discovered).toBe(5);
    expect(summary.counts.denied).toBe(0);
    expect(summary.counts.ignored).toBe(0);
  });
});

describe("summarizeForAudit", () => {
  it("returns selection metadata without excerpt text", () => {
    const audit = summarizeForAudit(pack());
    expect(audit.entries[0]?.path).toBe("src/index.ts");
    expect(audit.entries[0]?.selectionReason).toBe("entrypoint");
    expect(JSON.stringify(audit)).not.toContain("export const x");
  });

  it("carries budget usage", () => {
    const audit = summarizeForAudit(pack());
    expect(audit.usedBytes).toBe(80);
    expect(audit.budgetBytes).toBe(1_000);
    expect(audit.droppedForBudget).toBe(2);
  });
});
