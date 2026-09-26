import { describe, expect, it } from "vitest";
import { memFs } from "./_memfs.js";
import { followSymbolTrace } from "./followSymbolTrace.js";
import { DEFAULT_SEARCH_LIMITS, type SearchScope } from "./repoSearch.js";
import type { WorkspaceInfo } from "./types.js";

const MEM_ROOT = "/ws";

function makeScope(files: Readonly<Record<string, string>>): {
  readonly scope: SearchScope;
  readonly fs: ReturnType<typeof memFs>;
} {
  const workspace: WorkspaceInfo = {
    root: MEM_ROOT,
    selectedRoot: MEM_ROOT,
    name: "trace-demo",
    version: "1.0.0",
    testFramework: "vitest",
    sourceDirs: ["packages"],
    testDirs: [],
    languages: ["typescript", "javascript"],
    ignoreLines: [],
  };
  return {
    scope: { workspace, scopeId: "scope-1", relativePaths: [] },
    fs: memFs(MEM_ROOT, files),
  };
}

describe("followSymbolTrace", () => {
  it("retrieves a three-package trace from symbol to callers through import edges", async () => {
    const { scope, fs } = makeScope({
      "packages/a/src/app.ts":
        'import { runPayment } from "../../b/src/service";\nexport function start(): void {\n  runPayment();\n}\n',
      "packages/b/src/service.ts":
        'import { settlePayment } from "../../c/src/domain";\nexport function runPayment(): string {\n  return settlePayment();\n}\n',
      "packages/c/src/domain.ts":
        'export function settlePayment(): string {\n  return "settled";\n}\n',
    });

    const trace = await followSymbolTrace(scope, DEFAULT_SEARCH_LIMITS, fs, {
      symbols: ["settlePayment"],
      maxDepth: 3,
      maxRecords: 20,
    });

    expect(trace.records.map((record) => record.scopePath)).toEqual(
      expect.arrayContaining([
        "packages/c/src/domain.ts",
        "packages/b/src/service.ts",
        "packages/a/src/app.ts",
      ]),
    );
    expect(trace.records.map((record) => record.relation)).toEqual(
      expect.arrayContaining(["definition", "call", "importer"]),
    );
    expect(trace.diagnostics.budgetExhausted).toBe(false);
  });

  it("stops deterministically at depth and record budgets with diagnostics", async () => {
    const { scope, fs } = makeScope({
      "packages/a/src/app.ts": 'import { runPayment } from "../../b/src/service";\nrunPayment();\n',
      "packages/b/src/service.ts":
        'import { settlePayment } from "../../c/src/domain";\nexport function runPayment(): string {\n  return settlePayment();\n}\n',
      "packages/c/src/domain.ts":
        'export function settlePayment(): string {\n  return "settled";\n}\n',
    });

    const depthCapped = await followSymbolTrace(scope, DEFAULT_SEARCH_LIMITS, fs, {
      symbols: ["settlePayment"],
      maxDepth: 1,
      maxRecords: 20,
    });
    expect(depthCapped.diagnostics.depthCapped).toBe(true);

    const recordCapped = await followSymbolTrace(scope, DEFAULT_SEARCH_LIMITS, fs, {
      symbols: ["settlePayment"],
      maxDepth: 3,
      maxRecords: 1,
    });
    expect(recordCapped.records).toHaveLength(1);
    expect(recordCapped.diagnostics.budgetExhausted).toBe(true);
    expect(recordCapped.diagnostics.skippedEdges).toBeGreaterThan(0);
  });

  it("marks the trace incomplete when only the import graph hits its source ceiling", async () => {
    const { scope, fs } = makeScope({
      "packages/a.ts": "export function seed(): void {}",
      "packages/b.vue": "<script>export const b = 1;</script>",
      "packages/c.vue": "<script>export const c = 1;</script>",
    });
    const cappedLimits = { ...DEFAULT_SEARCH_LIMITS, maxFilesScanned: 1 };

    const trace = await followSymbolTrace(scope, cappedLimits, fs, {
      symbols: ["seed"],
      maxDepth: 1,
      maxRecords: 20,
    });

    expect(trace.records).toEqual([
      expect.objectContaining({ relation: "definition", scopePath: "packages/a.ts" }),
    ]);
    expect(trace.diagnostics.sourceGraphTruncated).toBe(true);
  });

  it("marks the trace incomplete when graph source reads are skipped", async () => {
    const { scope, fs } = makeScope({
      "src/oversized.ts": "export function seed(): void {}",
    });

    const trace = await followSymbolTrace(
      scope,
      { ...DEFAULT_SEARCH_LIMITS, maxBytesPerFileScanned: 1 },
      fs,
      { symbols: ["seed"] },
    );

    expect(trace.records).toEqual([]);
    expect(trace.diagnostics.sourceGraphTruncated).toBe(true);
  });
});
