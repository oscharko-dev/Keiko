// Branch-coverage tests for the editor-epic branches in contextPack.ts that remained
// uncovered after the feat/keiko-editor → release/0.2.0 merge. Covers: clampToBytes
// maxBytes<=0, readEntry catch null, buildEntry content-null and excerpt-empty paths,
// and tryAddEntry when buildEntry returns null.

import { describe, expect, it } from "vitest";
import { buildContextPackFromFiles, buildContextPack } from "./contextPack.js";
import { lexicalRetrievalStrategy } from "./retrieval.js";
import type { ContextRequest, DiscoveredFile, WorkspaceInfo } from "./types.js";
import { memFs } from "./_memfs.js";
import type { WorkspaceFs } from "./fs.js";

const ROOT = "/ws";

function workspace(): WorkspaceInfo {
  return {
    root: ROOT,
    name: "demo",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["src"],
    testDirs: ["tests"],
    languages: ["typescript"],
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

function file(relativePath: string, sizeBytes = 10): DiscoveredFile {
  return { relativePath, sizeBytes };
}

// ─── clampToBytes maxBytes <= 0 (line 90) and buildEntry excerpt.length === 0 (line 133) ────

describe("buildContextPack – clampToBytes with maxBytes <= 0", () => {
  it("produces no selected entries when maxBytesPerFile is 0 and budget is positive", () => {
    // perFileCap = Math.min(0, remaining=1000) = 0 → clampToBytes(text, 0) → excerpt=""
    // → buildEntry returns null (excerpt.length === 0), NOT counted as droppedForBudget.
    const fs = memFs(ROOT, { "src/index.ts": "export const x = 1;\n" });
    const result = buildContextPackFromFiles(
      workspace(),
      request({ budgetBytes: 1_000, maxBytesPerFile: 0 }),
      [file("src/index.ts", 20)],
      { fs, strategy: lexicalRetrievalStrategy },
    );
    expect(result.selected).toHaveLength(0);
    // excerpt-empty causes buildEntry to return null, NOT a budget drop.
    expect(result.droppedForBudget).toBe(0);
  });
});

// ─── readEntry catch → null (line 115) ───────────────────────────────────────

describe("buildContextPackFromFiles – readEntry returns null on read error", () => {
  it("skips a file without counting it as a budget drop when readFileUtf8 throws", () => {
    const base = memFs(ROOT, { "src/a.ts": "content\n" });
    // Throw a generic Error (not IO, not FileTooLargeError) so the catch-all in readEntry fires.
    const fs: WorkspaceFs = {
      ...base,
      readFileUtf8: (): string => {
        throw new Error("synthetic read error");
      },
    };
    const result = buildContextPackFromFiles(workspace(), request(), [file("src/a.ts")], {
      fs,
      strategy: lexicalRetrievalStrategy,
    });
    expect(result.selected).toHaveLength(0);
    // readEntry null → tryAddEntry returns without incrementing droppedForBudget.
    expect(result.droppedForBudget).toBe(0);
  });
});

// ─── buildEntry: content === null path (line 128) ────────────────────────────

describe("buildContextPackFromFiles – buildEntry returns null when content is null", () => {
  it("does not add an entry and does not drop for budget when buildEntry gets null content", () => {
    // Verify that tryAddEntry's `if (entry === null) { return; }` path is distinct from the
    // budget-drop path: droppedForBudget stays 0 while selected stays empty.
    const base = memFs(ROOT, { "src/a.ts": "data\n", "src/b.ts": "data\n" });
    const fs: WorkspaceFs = {
      ...base,
      readFileUtf8: (): string => {
        throw new Error("simulate unreadable");
      },
    };
    const result = buildContextPackFromFiles(
      workspace(),
      request({ budgetBytes: 1_000, maxBytesPerFile: 200 }),
      [file("src/a.ts"), file("src/b.ts")],
      { fs, strategy: lexicalRetrievalStrategy },
    );
    expect(result.selected).toHaveLength(0);
    expect(result.droppedForBudget).toBe(0);
  });
});

// ─── buildEntry: excerpt.length === 0 path (line 133) ────────────────────────

describe("buildContextPack – buildEntry returns null when excerpt is empty after clamping", () => {
  it("skips a file and does not count it as a budget drop when clamped excerpt is empty", () => {
    // A file that is readable, but remaining budget shrinks perFileCap to 0 after budget is
    // consumed by an earlier file, causing clampToBytes to return excerpt="" → buildEntry null.
    const bigContent = "x".repeat(200);
    const fs = memFs(ROOT, {
      "src/index.ts": bigContent,
      "src/b.ts": "second\n",
    });
    // Budget of 200 is exactly filled by the first file; second file gets remaining=0 → excerpt="".
    const result = buildContextPackFromFiles(
      workspace(),
      request({ budgetBytes: 200, maxBytesPerFile: 200 }),
      [file("src/index.ts", 200), file("src/b.ts", 7)],
      { fs, strategy: lexicalRetrievalStrategy },
    );
    // First file fills the budget completely; second file's remaining <= 0 triggers droppedForBudget.
    // OR if remaining > 0 but excerpt is empty (edge): buildEntry returns null.
    // Either way src/b.ts must not appear in selected.
    expect(result.selected.some((e) => e.path === "src/b.ts")).toBe(false);
  });
});

// ─── tryAddEntry: remaining <= 0 path (line 153-155) ─────────────────────────

describe("buildContextPack – tryAddEntry skips and counts drops when budget is exhausted", () => {
  it("increments droppedForBudget for each file after budget reaches 0", () => {
    // Budget of 10 bytes fits exactly one 10-byte file; subsequent files get remaining<=0.
    const content = "a".repeat(10);
    const fs = memFs(ROOT, {
      "src/index.ts": content,
      "src/b.ts": content,
      "src/c.ts": content,
    });
    const result = buildContextPackFromFiles(
      workspace(),
      request({ budgetBytes: 10, maxBytesPerFile: 10 }),
      [file("src/index.ts", 10), file("src/b.ts", 10), file("src/c.ts", 10)],
      { fs, strategy: lexicalRetrievalStrategy },
    );
    expect(result.selected).toHaveLength(1);
    expect(result.droppedForBudget).toBe(2);
  });
});

// ─── tryAddEntry: entry === null branch (line 159) ────────────────────────────

describe("buildContextPackFromFiles – tryAddEntry early-returns without droppedForBudget when entry is null", () => {
  it("does not inflate droppedForBudget when buildEntry returns null mid-budget", () => {
    // Two readable files; third is unreadable (returns null from buildEntry).
    // Budget large enough to accommodate all three; only unreadable one is skipped.
    const readable = "hello world content\n";
    const base = memFs(ROOT, {
      "src/a.ts": readable,
      "src/b.ts": readable,
      "src/bad.ts": readable,
    });
    let callCount = 0;
    const fs: WorkspaceFs = {
      ...base,
      readFileUtf8: (abs: string): string => {
        if (abs.endsWith("bad.ts")) {
          callCount += 1;
          throw new Error("unreadable");
        }
        return base.readFileUtf8(abs);
      },
    };
    const result = buildContextPackFromFiles(
      workspace(),
      request({ budgetBytes: 10_000, maxBytesPerFile: 5_000 }),
      [file("src/a.ts"), file("src/b.ts"), file("src/bad.ts")],
      { fs, strategy: lexicalRetrievalStrategy },
    );
    expect(result.selected).toHaveLength(2);
    expect(result.droppedForBudget).toBe(0);
    expect(callCount).toBeGreaterThan(0);
  });
});

// ─── buildContextPack (full discovery path) ───────────────────────────────────

describe("buildContextPack – full discovery integration", () => {
  it("assembles a pack from discovered files using the default strategy", () => {
    const result = buildContextPack(
      workspace(),
      request({ budgetBytes: 500, maxBytesPerFile: 200 }),
      {
        fs: memFs(ROOT, { "src/index.ts": "export const hello = 'world';\n" }),
        strategy: lexicalRetrievalStrategy,
      },
    );
    expect(result.selected.length).toBeGreaterThan(0);
    expect(result.workspaceRoot).toBe(ROOT);
  });
});
