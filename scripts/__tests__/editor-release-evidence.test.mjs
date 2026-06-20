import { describe, expect, it } from "vitest";

import {
  RELEASE_EVIDENCE_BUDGETS,
  classifyWorkerLabel,
  evaluateBundleBudgets,
  isEditorRuntimeChunk,
} from "../editor-release-evidence.mjs";

describe("classifyWorkerLabel", () => {
  it("classifies the TypeScript language worker by its services marker", () => {
    expect(classifyWorkerLabel("var x=ScriptElementKind.keyword;function $initialize(){}")).toBe(
      "ts",
    );
  });

  it("classifies the HTML, JSON, and CSS language workers by unique markers", () => {
    expect(classifyWorkerLabel("doTagComplete(document,position)")).toBe("html");
    expect(classifyWorkerLabel("getMatchingSchemas(uri)")).toBe("json");
    expect(classifyWorkerLabel("getSelectionRanges();getFoldingRanges();")).toBe("css");
  });

  it("classifies the editor worker by its diff/link computers", () => {
    expect(classifyWorkerLabel("class DiffComputer{};function computeLinks(){}")).toBe("editor");
  });

  it("does not treat the main-thread editor host or environment chunk as a worker", () => {
    // The main-thread chunk bundles the worker proxies (DiffComputer/computeLinks) but installs the
    // worker environment or imports the React host loader — neither is true of a worker body.
    expect(
      classifyWorkerLabel("MonacoEnvironment.getWorker;class DiffComputer{};computeLinks()"),
    ).toBeNull();
    expect(
      classifyWorkerLabel("import '@monaco-editor/react';DiffComputer;computeLinks"),
    ).toBeNull();
  });

  it("returns null for an unrelated application chunk", () => {
    expect(classifyWorkerLabel("export function App(){return null}")).toBeNull();
  });
});

describe("isEditorRuntimeChunk", () => {
  it("is true for chunks carrying a Monaco/editor runtime marker", () => {
    expect(isEditorRuntimeChunk("import * as m from 'monaco-editor'")).toBe(true);
    expect(isEditorRuntimeChunk("self.MonacoEnvironment={}")).toBe(true);
  });

  it("is true for a Monaco worker chunk even without a package marker", () => {
    expect(isEditorRuntimeChunk("ScriptElementKind.keyword")).toBe(true);
  });

  it("is false for an unrelated application chunk", () => {
    expect(isEditorRuntimeChunk("export const answer = 42")).toBe(false);
  });
});

describe("evaluateBundleBudgets", () => {
  const chunks = [
    { path: "ts.js", gzipBytes: 1_400_000, isEditorRuntime: true, workerLabel: "ts" },
    { path: "core.js", gzipBytes: 1_000_000, isEditorRuntime: true, workerLabel: null },
    { path: "editor-worker.js", gzipBytes: 110_000, isEditorRuntime: true, workerLabel: "editor" },
    { path: "css.js", gzipBytes: 140_000, isEditorRuntime: true, workerLabel: "css" },
    { path: "runtime.js", gzipBytes: 30_000, isEditorRuntime: true, workerLabel: null },
  ];

  it("enforces B2 against the shipped production runtime, not loaded-only diagnostics", () => {
    const result = evaluateBundleBudgets(chunks);
    // Loaded = core + editor worker + runtime; the ts/css/html/json language workers are not loaded.
    expect(result.b2.loadedTotalBytes).toBe(1_000_000 + 110_000 + 30_000);
    expect(result.b2.loadedOk).toBe(true);
    // Ships = every editor-runtime chunk, including the unloaded language workers.
    expect(result.b2.shipsTotalBytes).toBe(1_400_000 + 1_000_000 + 110_000 + 140_000 + 30_000);
    expect(result.b2.ok).toBe(false);
    expect(result.b2.shipsOk).toBe(false);
  });

  it("enforces B3 against the largest shipped worker", () => {
    const result = evaluateBundleBudgets(chunks);
    expect(result.b3.largestWorkerLabel).toBe("ts");
    expect(result.b3.largestWorkerBytes).toBe(1_400_000);
    expect(result.b3.largestLoadedWorkerLabel).toBe("editor");
    expect(result.b3.largestLoadedWorkerBytes).toBe(110_000);
    expect(result.b3.loadedOk).toBe(true);
    expect(result.b3.ok).toBe(false);
    expect(result.b3.shipsOk).toBe(false);
  });

  it("passes B2/B3 when the shipped runtime and largest shipped worker are within budget", () => {
    const result = evaluateBundleBudgets([
      { path: "core.js", gzipBytes: 800_000, isEditorRuntime: true, workerLabel: null },
      {
        path: "editor-worker.js",
        gzipBytes: 110_000,
        isEditorRuntime: true,
        workerLabel: "editor",
      },
      { path: "runtime.js", gzipBytes: 30_000, isEditorRuntime: true, workerLabel: null },
    ]);
    expect(result.b2.ok).toBe(true);
    expect(result.b3.ok).toBe(true);
  });

  it("flags a B3 regression when any shipped worker exceeds the budget", () => {
    const oversized = [
      {
        path: "editor-worker.js",
        gzipBytes: 800_000,
        isEditorRuntime: true,
        workerLabel: "editor",
      },
    ];
    const result = evaluateBundleBudgets(oversized);
    expect(result.b3.ok).toBe(false);
  });

  it("uses the ADR-0042 D3.6 budgets by default", () => {
    expect(RELEASE_EVIDENCE_BUDGETS.lazyEditorPlusMonacoRuntimeGzipBytesBudget).toBe(2_621_440);
    expect(RELEASE_EVIDENCE_BUDGETS.perWorkerChunkGzipBytesBudget).toBe(768_000);
  });
});
