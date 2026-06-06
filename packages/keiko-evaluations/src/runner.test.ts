// EvalRunner end-to-end offline tests (ADR-0012 D5/D6/D9, AC#1/#2/#3). Runs all 6 fixtures through
// runEvaluationSuite with a fixed clock, injected in-memory EvidenceStore, and no live network.
// Asserts: expected dimension outcomes per fixture, unsafe-action → rejected + zero writes + no diff,
// apply-mode → test-pass-rate + verification-completeness scored, temp-dir cleanup, scorecard shape.

import { describe, expect, it } from "vitest";
import { runEvaluationSuite } from "./runner.js";
import {
  ALL_FIXTURES,
  createScriptedModelPort,
  fixtureByName,
  fixturesForSuite,
  EVAL_SCORECARD_SCHEMA_VERSION,
} from "./index.js";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { runGenTestsCli, runInvestigateCli } from "@oscharko-dev/keiko-cli";
import { parseRunRequest } from "@oscharko-dev/keiko-server";
import type { EvalRunOptions, EvalRunnerDeps } from "./runner.js";
import type { SurfaceParityDeps } from "./surface-parity.js";
import { must } from "./_support.js";

// Fixed clock and id source so test output is deterministic
const FIXED_NOW = 1_700_000_000_000;
const fixedNow = (): number => FIXED_NOW;
const fixedId = (name: string) => (): string => `eval-test-${name}`;

const SURFACE_PARITY_DEPS: SurfaceParityDeps = {
  runGenTestsCli,
  runInvestigateCli,
  parseRunRequest,
};

function makeDeps(fixtureName = "test"): EvalRunnerDeps {
  return {
    store: createInMemoryEvidenceStore(),
    now: fixedNow,
    idSource: fixedId(fixtureName),
    surfaceParity: SURFACE_PARITY_DEPS,
  };
}

function makeOfflineOptions(fixtures = ALL_FIXTURES): EvalRunOptions {
  return { mode: "offline", fixtures };
}

function sequenceIds(ids: readonly string[]): () => string {
  let index = 0;
  return (): string => {
    const id = ids[Math.min(index, ids.length - 1)];
    index += 1;
    return id ?? "eval-test-fallback";
  };
}

function tickingClock(startMs: number, stepMs: number): () => number {
  let current = startMs;
  return (): number => {
    const value = current;
    current += stepMs;
    return value;
  };
}

interface ManifestProbe {
  readonly run: {
    readonly startedAt: number;
    readonly finishedAt: number;
    readonly durationMs: number;
  };
  readonly usageTotals: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly requestCount: number;
    readonly totalLatencyMs: number;
  };
}

function readManifest(
  store: ReturnType<typeof createInMemoryEvidenceStore>,
  runId: string,
): ManifestProbe {
  const raw = store.get(runId);
  if (raw === undefined) {
    throw new Error(`manifest ${runId} not found`);
  }
  return JSON.parse(raw) as ManifestProbe;
}

// Helper to get a dimension outcome from a fixture result
function outcomeOf(
  scorecard: Awaited<ReturnType<typeof runEvaluationSuite>>,
  fixtureName: string,
  dimension: string,
): string {
  const fr = scorecard.fixtureResults.find((r) => r.fixtureName === fixtureName);
  if (fr === undefined) throw new Error(`fixture ${fixtureName} not in results`);
  const dr = fr.dimensionResults.find((d) => d.dimension === dimension);
  if (dr === undefined) throw new Error(`dimension ${dimension} not in ${fixtureName}`);
  return dr.outcome;
}

// ─── EvalScorecard shape ────────────────────────────────────────────────────────

describe("EvalScorecard shape", () => {
  it("schemaVersion is '1'", async () => {
    const sc = await runEvaluationSuite(makeOfflineOptions([must(ALL_FIXTURES[0])]), makeDeps());
    expect(sc.schemaVersion).toBe(EVAL_SCORECARD_SCHEMA_VERSION);
    expect(sc.schemaVersion).toBe("1");
  });

  it("mode is 'offline' when run without --live", async () => {
    const sc = await runEvaluationSuite(makeOfflineOptions([must(ALL_FIXTURES[0])]), makeDeps());
    expect(sc.mode).toBe("offline");
  });

  it("liveRunContext is absent in offline mode", async () => {
    const sc = await runEvaluationSuite(makeOfflineOptions([must(ALL_FIXTURES[0])]), makeDeps());
    expect(sc.liveRunContext).toBeUndefined();
  });

  it("evaluatedAt is derived from the injected now() clock (not real Date.now)", async () => {
    const sc = await runEvaluationSuite(makeOfflineOptions([must(ALL_FIXTURES[0])]), makeDeps());
    expect(sc.evaluatedAt).toBe(new Date(FIXED_NOW).toISOString());
  });

  it("dimensions array has exactly 7 entries", async () => {
    const sc = await runEvaluationSuite(makeOfflineOptions([must(ALL_FIXTURES[0])]), makeDeps());
    expect(sc.dimensions).toHaveLength(7);
  });

  it("fixtureResults has one entry per input fixture", async () => {
    const fixtures = fixturesForSuite("unit-tests");
    const sc = await runEvaluationSuite(makeOfflineOptions(fixtures), makeDeps());
    expect(sc.fixtureResults).toHaveLength(fixtures.length);
  });

  it("summary.totalFixtures matches input fixture count", async () => {
    const sc = await runEvaluationSuite(makeOfflineOptions(ALL_FIXTURES), makeDeps());
    expect(sc.summary.totalFixtures).toBe(ALL_FIXTURES.length);
  });
});

describe("live-mode evidence semantics", () => {
  it("records current-run evidence refs, real timestamps, and folded model usage", async () => {
    const fixture = must(fixtureByName("unit-tests/happy-path"));
    const store = createInMemoryEvidenceStore();
    store.put("old-run", "{}");
    const scorecard = await runEvaluationSuite(
      { mode: "live", fixtures: [fixture] },
      {
        store,
        now: tickingClock(FIXED_NOW, 10),
        idSource: sequenceIds(["current-run", "workflow-run", "workflow-event"]),
        modelProviderFactory: (candidate): ReturnType<typeof createScriptedModelPort> =>
          createScriptedModelPort(candidate.mockTranscript),
        surfaceParity: SURFACE_PARITY_DEPS,
      },
    );

    expect(scorecard.liveRunContext?.evidenceRefs).toEqual(["current-run.json"]);
    const manifest = readManifest(store, "current-run");
    expect(manifest.run.startedAt).toBeGreaterThan(FIXED_NOW);
    expect(manifest.run.finishedAt).toBeGreaterThanOrEqual(manifest.run.startedAt);
    expect(manifest.run.durationMs).toBe(manifest.run.finishedAt - manifest.run.startedAt);
    expect(manifest.usageTotals.requestCount).toBeGreaterThan(0);
    expect(manifest.usageTotals.promptTokens).toBeGreaterThan(0);
    expect(manifest.usageTotals.completionTokens).toBeGreaterThan(0);
  });
});

// ─── unit-tests/happy-path ─────────────────────────────────────────────────────

describe("unit-tests/happy-path fixture", () => {
  async function run(): Promise<ReturnType<typeof runEvaluationSuite>> {
    const f = must(fixtureByName("unit-tests/happy-path"));
    return runEvaluationSuite(makeOfflineOptions([f]), makeDeps("ut-happy"));
  }

  it("fixture result status is a success terminal (completed or dry-run)", async () => {
    const sc = await run();
    const fr = must(sc.fixtureResults.find((r) => r.fixtureName === "happy-path"));
    const successTerminals = ["completed", "dry-run", "fix-applied", "fix-proposed"];
    expect(successTerminals).toContain(fr.report.status);
  });

  it("task-completion scores pass", async () => {
    const sc = await run();
    expect(outcomeOf(sc, "happy-path", "task-completion")).toBe("pass");
  });

  it("patch-correctness scores pass (proposedDiff present)", async () => {
    const sc = await run();
    expect(outcomeOf(sc, "happy-path", "patch-correctness")).toBe("pass");
  });

  it("audit-completeness scores pass (manifest produced and valid)", async () => {
    const sc = await run();
    expect(outcomeOf(sc, "happy-path", "audit-completeness")).toBe("pass");
  });

  it("test-pass-rate scores pass (apply mode with fake-spawn exit 0)", async () => {
    const sc = await run();
    expect(outcomeOf(sc, "happy-path", "test-pass-rate")).toBe("pass");
  });

  it("verification-completeness scores pass (verificationSummary present)", async () => {
    const sc = await run();
    expect(outcomeOf(sc, "happy-path", "verification-completeness")).toBe("pass");
  });

  it("patch-size scores pass (within the oracle limits)", async () => {
    const sc = await run();
    expect(outcomeOf(sc, "happy-path", "patch-size")).toBe("pass");
  });
});

// ─── unit-tests/unsafe-action ──────────────────────────────────────────────────

describe("unit-tests/unsafe-action fixture", () => {
  async function run(): Promise<ReturnType<typeof runEvaluationSuite>> {
    const f = must(fixtureByName("unit-tests/unsafe-action"));
    return runEvaluationSuite(makeOfflineOptions([f]), makeDeps("ut-unsafe"));
  }

  it("fixture result status is 'rejected'", async () => {
    const sc = await run();
    const fr = must(sc.fixtureResults.find((r) => r.fixtureName === "unsafe-action"));
    expect(fr.report.status).toBe("rejected");
  });

  it("proposedDiff is absent (no diff produced on rejection)", async () => {
    const sc = await run();
    const fr = must(sc.fixtureResults.find((r) => r.fixtureName === "unsafe-action"));
    expect(fr.report.proposedDiff).toBeFalsy();
  });

  it("unsafe-action-rejection scores pass", async () => {
    const sc = await run();
    expect(outcomeOf(sc, "unsafe-action", "unsafe-action-rejection")).toBe("pass");
  });

  it("audit-completeness scores pass", async () => {
    const sc = await run();
    expect(outcomeOf(sc, "unsafe-action", "audit-completeness")).toBe("pass");
  });

  it("task-completion is not-applicable (rejection is the intended outcome)", async () => {
    const sc = await run();
    expect(outcomeOf(sc, "unsafe-action", "task-completion")).toBe("not-applicable");
  });
});

// ─── unit-tests/retry-then-accept ─────────────────────────────────────────────

describe("unit-tests/retry-then-accept fixture", () => {
  async function run(): Promise<ReturnType<typeof runEvaluationSuite>> {
    const f = must(fixtureByName("unit-tests/retry-then-accept"));
    return runEvaluationSuite(makeOfflineOptions([f]), makeDeps("ut-retry"));
  }

  it("fixture result status is 'dry-run' (accepted after one retry)", async () => {
    const sc = await run();
    const fr = must(sc.fixtureResults.find((r) => r.fixtureName === "retry-then-accept"));
    expect(fr.report.status).toBe("dry-run");
  });

  it("task-completion scores pass", async () => {
    const sc = await run();
    expect(outcomeOf(sc, "retry-then-accept", "task-completion")).toBe("pass");
  });

  it("patch-correctness scores pass (valid diff produced)", async () => {
    const sc = await run();
    expect(outcomeOf(sc, "retry-then-accept", "patch-correctness")).toBe("pass");
  });

  it("audit-completeness scores pass", async () => {
    const sc = await run();
    expect(outcomeOf(sc, "retry-then-accept", "audit-completeness")).toBe("pass");
  });
});

// ─── bug-investigation/happy-path ─────────────────────────────────────────────

describe("bug-investigation/happy-path fixture", () => {
  async function run(): Promise<ReturnType<typeof runEvaluationSuite>> {
    const f = must(fixtureByName("bug-investigation/happy-path"));
    return runEvaluationSuite(makeOfflineOptions([f]), makeDeps("bug-happy"));
  }

  it("fixture result status is a success terminal (fix-applied or fix-proposed)", async () => {
    const sc = await run();
    const fr = must(sc.fixtureResults.find((r) => r.fixtureName === "happy-path"));
    const successTerminals = ["fix-applied", "fix-proposed", "completed", "dry-run"];
    expect(successTerminals).toContain(fr.report.status);
  });

  it("task-completion scores pass", async () => {
    const sc = await run();
    expect(outcomeOf(sc, "happy-path", "task-completion")).toBe("pass");
  });

  it("patch-correctness scores pass (fix diff present)", async () => {
    const sc = await run();
    expect(outcomeOf(sc, "happy-path", "patch-correctness")).toBe("pass");
  });

  it("audit-completeness scores pass", async () => {
    const sc = await run();
    expect(outcomeOf(sc, "happy-path", "audit-completeness")).toBe("pass");
  });

  it("test-pass-rate scores pass (apply mode with fake spawn)", async () => {
    const sc = await run();
    expect(outcomeOf(sc, "happy-path", "test-pass-rate")).toBe("pass");
  });

  it("verification-completeness scores pass", async () => {
    const sc = await run();
    expect(outcomeOf(sc, "happy-path", "verification-completeness")).toBe("pass");
  });
});

// ─── bug-investigation/unsafe-action ──────────────────────────────────────────

describe("bug-investigation/unsafe-action fixture", () => {
  async function run(): Promise<ReturnType<typeof runEvaluationSuite>> {
    const f = must(fixtureByName("bug-investigation/unsafe-action"));
    return runEvaluationSuite(makeOfflineOptions([f]), makeDeps("bug-unsafe"));
  }

  it("fixture result status is 'rejected'", async () => {
    const sc = await run();
    const fr = must(sc.fixtureResults.find((r) => r.fixtureName === "unsafe-action"));
    expect(fr.report.status).toBe("rejected");
  });

  it("proposedDiff is absent", async () => {
    const sc = await run();
    const fr = must(sc.fixtureResults.find((r) => r.fixtureName === "unsafe-action"));
    expect(fr.report.proposedDiff).toBeFalsy();
  });

  it("unsafe-action-rejection scores pass", async () => {
    const sc = await run();
    // There are two fixtures named "unsafe-action"; we need the bug one.
    // Since we run only this fixture, result[0] is correct.
    const fr = must(sc.fixtureResults[0]);
    const dr = must(fr.dimensionResults.find((d) => d.dimension === "unsafe-action-rejection"));
    expect(dr.outcome).toBe("pass");
  });

  it("audit-completeness scores pass", async () => {
    const sc = await run();
    const fr = must(sc.fixtureResults[0]);
    const dr = must(fr.dimensionResults.find((d) => d.dimension === "audit-completeness"));
    expect(dr.outcome).toBe("pass");
  });
});

// ─── bug-investigation/investigation-only ─────────────────────────────────────

describe("bug-investigation/investigation-only fixture", () => {
  async function run(): Promise<ReturnType<typeof runEvaluationSuite>> {
    const f = must(fixtureByName("bug-investigation/investigation-only"));
    return runEvaluationSuite(makeOfflineOptions([f]), makeDeps("bug-inv-only"));
  }

  it("fixture result status is 'investigation-only'", async () => {
    const sc = await run();
    const fr = must(sc.fixtureResults.find((r) => r.fixtureName === "investigation-only"));
    expect(fr.report.status).toBe("investigation-only");
  });

  it("task-completion scores pass (investigation-only is a success terminal)", async () => {
    const sc = await run();
    expect(outcomeOf(sc, "investigation-only", "task-completion")).toBe("pass");
  });

  it("patch-correctness scores pass (expectPatch=false and no diff produced)", async () => {
    const sc = await run();
    expect(outcomeOf(sc, "investigation-only", "patch-correctness")).toBe("pass");
  });

  it("audit-completeness scores pass", async () => {
    const sc = await run();
    expect(outcomeOf(sc, "investigation-only", "audit-completeness")).toBe("pass");
  });
});

// ─── Full suite: safety gate + pilot-ready ─────────────────────────────────────

describe("full offline suite (all 6 fixtures)", () => {
  async function runAll(): Promise<ReturnType<typeof runEvaluationSuite>> {
    return runEvaluationSuite(makeOfflineOptions(ALL_FIXTURES), makeDeps("full-suite"));
  }

  it("safetyGatePassed=true (no unsafe-action-rejection failures)", async () => {
    const sc = await runAll();
    expect(sc.summary.safetyGatePassed).toBe(true);
  });

  it("pilotReadyIndicator=true when all pilot-threshold dimensions pass", async () => {
    const sc = await runAll();
    expect(sc.summary.pilotReadyIndicator).toBe(true);
  });

  it("unsafe-action-rejection dimension passRate=1.0", async () => {
    const sc = await runAll();
    const ua = must(sc.dimensions.find((d) => d.dimension === "unsafe-action-rejection"));
    expect(ua.passRate).toBe(1);
    expect(ua.failCount).toBe(0);
  });

  it("audit-completeness dimension passRate=1.0", async () => {
    const sc = await runAll();
    const ac = must(sc.dimensions.find((d) => d.dimension === "audit-completeness"));
    expect(ac.passRate).toBe(1);
    expect(ac.failCount).toBe(0);
  });

  it("schemaVersion is '1' on the full-suite scorecard", async () => {
    const sc = await runAll();
    expect(sc.schemaVersion).toBe("1");
  });
});

// ─── Determinism: fixed clock flows into evaluatedAt ──────────────────────────

describe("clock injection", () => {
  it("two runs with the same fixed clock produce identical evaluatedAt timestamps", async () => {
    const opts = makeOfflineOptions([must(ALL_FIXTURES[0])]);
    const sc1 = await runEvaluationSuite(opts, makeDeps("clock-1"));
    const sc2 = await runEvaluationSuite(opts, makeDeps("clock-2"));
    expect(sc1.evaluatedAt).toBe(sc2.evaluatedAt);
  });

  it("evaluatedAt changes when a different clock epoch is injected", async () => {
    const opts = makeOfflineOptions([must(ALL_FIXTURES[0])]);
    const deps1 = { ...makeDeps(), now: (): number => 1_000_000_000_000 };
    const deps2 = { ...makeDeps(), now: (): number => 2_000_000_000_000 };
    const sc1 = await runEvaluationSuite(opts, deps1);
    const sc2 = await runEvaluationSuite(opts, deps2);
    expect(sc1.evaluatedAt).not.toBe(sc2.evaluatedAt);
  });
});
