import { describe, expect, it } from "vitest";

import {
  evaluateEditorEvidence,
  evaluateFreshness,
  evaluateWorkspaceEvidence,
} from "../check-perf-evidence.mjs";

function workspaceGesture(overrides = {}) {
  return {
    label: "workspace pan",
    frameGapBudgetP75Ms: 34,
    frameGapBudgetMaxMs: 120,
    frameGapSamples: 72,
    frameGapP75Ms: 8,
    frameGapMaxMs: 17,
    longTaskObserverInstalled: true,
    longTaskCount: 0,
    maxLongTaskMs: 0,
    viewWrites: 1,
    workspaceWrites: 0,
    workspacePuts: 0,
    ...overrides,
  };
}

function workspaceEvidence(gestureOverrides = {}) {
  return {
    measuredAtIso: "2026-07-03T12:00:00.000Z",
    commit: "6c3d061e",
    runs: {
      chromium: {
        project: "chromium",
        windowCount: 12,
        gestures: [workspaceGesture(gestureOverrides)],
      },
    },
  };
}

function editorEvidence(overrides = {}) {
  return {
    measuredAtIso: "2026-07-03T12:00:00.000Z",
    commit: "6c3d061e",
    b4ColdStartMs: { budgetP50: 1500, budgetP95: 2500, p50: 848, p95: 940 },
    b5KeystrokeMs: { budgetMax: 50, captured: true, maxLongTaskMs: 0 },
    b6InteractionMs: { budgetP75: 200, captured: true, p75: 16 },
    b11Memory: { supported: true, baselineBytes: 1, peakBytes: 1, residualBytes: 1, cycles: 2 },
    workerLoadCapture: {
      totalWorkerRequests: 3,
      editorWorkerLoaded: true,
      languageWorkerLoaded: false,
      tsLanguageWorkerLoaded: false,
    },
    ...overrides,
  };
}

describe("evaluateWorkspaceEvidence", () => {
  it("passes clean, within-budget evidence", () => {
    expect(evaluateWorkspaceEvidence(workspaceEvidence())).toEqual({ passed: true, failures: [] });
  });

  it("fails a frame-gap p75 budget breach", () => {
    const result = evaluateWorkspaceEvidence(workspaceEvidence({ frameGapP75Ms: 60 }));
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/p75 60ms > budget 34ms/u);
  });

  it("fails a long-task budget breach", () => {
    const result = evaluateWorkspaceEvidence(workspaceEvidence({ maxLongTaskMs: 250 }));
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/long task 250ms > 100ms/u);
  });

  it("fails write/PUT coalescing regressions", () => {
    const result = evaluateWorkspaceEvidence(
      workspaceEvidence({ viewWrites: 3, workspacePuts: 4 }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/viewWrites 3 > 1/u);
    expect(result.failures.join("\n")).toMatch(/workspacePuts 4 > 1/u);
  });

  it("rejects vacuous evidence with too few frame samples", () => {
    const result = evaluateWorkspaceEvidence(workspaceEvidence({ frameGapSamples: 2 }));
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/too few frame samples/u);
  });

  it("fails when there are no runs", () => {
    expect(evaluateWorkspaceEvidence({ runs: {} }).passed).toBe(false);
  });
});

describe("evaluateEditorEvidence", () => {
  it("passes clean editor evidence", () => {
    expect(evaluateEditorEvidence(editorEvidence())).toEqual({ passed: true, failures: [] });
  });

  it("fails a cold-start budget breach", () => {
    const result = evaluateEditorEvidence(
      editorEvidence({ b4ColdStartMs: { budgetP50: 1500, budgetP95: 2500, p50: 1800, p95: 3000 } }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/cold-start p50 1800ms > budget 1500ms/u);
  });

  it("fails when a Monaco language worker loaded (editor-only budget breach)", () => {
    const result = evaluateEditorEvidence(
      editorEvidence({
        workerLoadCapture: {
          totalWorkerRequests: 4,
          editorWorkerLoaded: true,
          languageWorkerLoaded: true,
          tsLanguageWorkerLoaded: true,
        },
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/language worker was loaded/u);
  });

  it("fails when b11 memory is not measured", () => {
    const result = evaluateEditorEvidence(editorEvidence({ b11Memory: { supported: false } }));
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/b11 memory/u);
  });
});

describe("evaluateFreshness", () => {
  const isAncestor = () => true;

  it("passes a stamped, reachable commit", () => {
    expect(evaluateFreshness(workspaceEvidence(), { isAncestor })).toEqual({
      passed: true,
      failures: [],
    });
  });

  it("fails a missing commit stamp", () => {
    const evidence = workspaceEvidence();
    delete evidence.commit;
    const result = evaluateFreshness(evidence, { isAncestor });
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/missing a valid `commit`/u);
  });

  it("fails a commit that is not reachable from HEAD", () => {
    const result = evaluateFreshness(workspaceEvidence(), { isAncestor: () => false });
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/not reachable from HEAD/u);
  });

  it("fails an unparseable measuredAtIso", () => {
    const result = evaluateFreshness(
      workspaceEvidence.call(null) && { ...workspaceEvidence(), measuredAtIso: "not-a-date" },
      { isAncestor },
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/measuredAtIso/u);
  });
});
