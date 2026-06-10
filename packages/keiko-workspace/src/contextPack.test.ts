import { describe, expect, it } from "vitest";
import { buildContextPack } from "./contextPack.js";
import { lexicalRetrievalStrategy } from "./retrieval.js";
import type { ContextPack, ContextRequest, WorkspaceInfo } from "./types.js";
import { memFs } from "./_memfs.js";

const ROOT = "/ws";

function workspace(): WorkspaceInfo {
  return {
    root: ROOT,
    name: "demo",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript", "javascript"],
    ignoreLines: [],
  };
}

function request(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    task: undefined,
    budgetBytes: 1_000,
    maxBytesPerFile: 200,
    discovery: { maxDepth: 12, maxFiles: 1_000, applyGitignore: true },
    ...overrides,
  };
}

function pack(
  files: Readonly<Record<string, string>>,
  req: ContextRequest = request(),
): ContextPack {
  return buildContextPack(workspace(), req, {
    fs: memFs(ROOT, files),
    strategy: lexicalRetrievalStrategy,
  });
}

describe("buildContextPack", () => {
  it("includes path, excerpt, size, and selection reason for each entry", () => {
    const result = pack({ "src/index.ts": "export const x = 1;\n", "README.md": "# Demo\n" });
    expect(result.selected.length).toBe(2);
    for (const entry of result.selected) {
      expect(entry.path.length).toBeGreaterThan(0);
      expect(entry.excerpt.length).toBeGreaterThan(0);
      expect(entry.sizeBytes).toBeGreaterThan(0);
      expect(entry.excerptBytes).toBeGreaterThan(0);
    }
  });

  it("ranks entrypoints before documentation before source", () => {
    const result = pack({
      "src/util.ts": "export const u = 1;\n",
      "src/index.ts": "export const i = 1;\n",
      "README.md": "# Demo\n",
    });
    const reasons = result.selected.map((e) => e.selectionReason);
    expect(reasons[0]).toBe("entrypoint");
    expect(reasons).toContain("documentation");
    expect(reasons).toContain("source");
  });

  it("uses a deterministic path tie-break within the same reason", () => {
    const files = { "src/b.ts": "b\n", "src/a.ts": "a\n", "src/c.ts": "c\n" };
    const a = pack(files);
    const b = pack(files);
    expect(a.selected.map((e) => e.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(a).toEqual(b);
  });

  it("stops adding entries once the byte budget is exhausted and counts drops", () => {
    const big = "y".repeat(150);
    const result = pack(
      { "src/index.ts": big, "src/a.ts": big, "src/b.ts": big, "src/c.ts": big },
      request({ budgetBytes: 300, maxBytesPerFile: 150 }),
    );
    expect(result.usedBytes).toBeLessThanOrEqual(300);
    expect(result.droppedForBudget).toBeGreaterThan(0);
    expect(result.totalCandidates).toBe(4);
  });

  it("truncates an excerpt that exceeds maxBytesPerFile", () => {
    const result = pack(
      { "src/index.ts": "z".repeat(500) },
      request({ maxBytesPerFile: 50, budgetBytes: 1_000 }),
    );
    const entry = result.selected[0];
    expect(entry).toBeDefined();
    expect(entry?.truncated).toBe(true);
    expect(entry?.excerptBytes).toBeLessThanOrEqual(50);
  });

  it("never packs a denied secret file", () => {
    const result = pack({ ".env": "SECRET=topsecret", "src/index.ts": "export const x=1;\n" });
    expect(result.selected.some((e) => e.path === ".env")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("topsecret");
  });

  it("redacts secrets inside packed excerpts", () => {
    const secret = ["sk-", "abcdef0123456789ABCDEF"].join("");
    const result = pack({ "src/index.ts": `const k = '${secret}';\n` });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("clamps a multibyte excerpt to the byte budget without splitting a character", () => {
    // 100 × "é" = 200 UTF-8 bytes; a 55-byte cap must land on a char boundary.
    const result = pack(
      { "src/index.ts": "é".repeat(100) },
      request({ budgetBytes: 55, maxBytesPerFile: 55 }),
    );
    const entry = result.selected[0];
    expect(entry).toBeDefined();
    expect(entry?.excerptBytes).toBeLessThanOrEqual(55);
    expect(entry?.excerpt.includes("�")).toBe(false);
    expect(entry?.truncated).toBe(true);
    expect(result.usedBytes).toBeLessThanOrEqual(55);
  });

  it("drops every remaining candidate once the budget is fully consumed", () => {
    // First file exactly fills the budget; the budget-exhausted guard must drop the rest and
    // count them. Kills a mutation that removes the `remaining <= 0` short-circuit.
    const result = pack(
      { "src/index.ts": "a".repeat(40), "src/b.ts": "b".repeat(40), "src/c.ts": "c".repeat(40) },
      request({ budgetBytes: 40, maxBytesPerFile: 40 }),
    );
    expect(result.selected.length).toBe(1);
    expect(result.usedBytes).toBe(40);
    expect(result.droppedForBudget).toBe(2);
  });

  it("reports zero candidates for an empty workspace", () => {
    const result = pack({});
    expect(result.totalCandidates).toBe(0);
    expect(result.selected.length).toBe(0);
    expect(result.usedBytes).toBe(0);
  });

  it("does not count unreadable or denied files toward droppedForBudget", () => {
    // Only budget-exhausted drops should increment droppedForBudget. A denied file (.env)
    // is silently excluded by discovery and never reaches tryAddEntry, so it must not inflate
    // the counter. Two source files fit within budget; droppedForBudget must be 0.
    const result = pack(
      { "src/index.ts": "a".repeat(10), "src/b.ts": "b".repeat(10) },
      request({ budgetBytes: 1_000, maxBytesPerFile: 200 }),
    );
    expect(result.droppedForBudget).toBe(0);
    expect(result.selected.length).toBe(2);
  });

  it("counts only budget-exhausted files in droppedForBudget, not unreadable ones", () => {
    // Three files; budget fits exactly 1. The other 2 are dropped for budget, not for read errors.
    // Ensures the fix: buildEntry returning null (e.g. due to read failure) no longer inflates
    // droppedForBudget; only the remaining<=0 path does.
    const result = pack(
      { "src/index.ts": "x".repeat(40), "src/b.ts": "y".repeat(40), "src/c.ts": "z".repeat(40) },
      request({ budgetBytes: 40, maxBytesPerFile: 40 }),
    );
    expect(result.selected.length).toBe(1);
    expect(result.droppedForBudget).toBe(2);
  });
});
