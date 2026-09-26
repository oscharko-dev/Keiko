// EvalRunner end-to-end offline tests (ADR-0012 D5/D6/D9, AC#1/#2/#3). Runs all 6 fixtures through
// runEvaluationSuite with a fixed clock, injected in-memory EvidenceStore, and no live network.
// Asserts: expected dimension outcomes per fixture, unsafe-action → rejected + zero writes + no diff,
// apply-mode → test-pass-rate + verification-completeness scored, temp-dir cleanup, scorecard shape.

import { describe, expect, it } from "vitest";
import { ConfigInvalidError } from "@oscharko-dev/keiko-model-gateway";
import { collapseEvaluationRunStatus, runEvaluationSuite } from "./runner.js";
import {
  ALL_FIXTURES,
  createScriptedModelPort,
  fixtureByName,
  fixturesForSuite,
  scoreFixture,
  EVAL_SCORECARD_SCHEMA_VERSION,
} from "./index.js";
import { createInMemoryEvidenceStore } from "@oscharko-dev/keiko-evidence";
import { runGenTestsCli, runInvestigateCli } from "@oscharko-dev/keiko-cli";
import { parseRunRequest } from "@oscharko-dev/keiko-server";
import type { EvalRunOptions, EvalRunnerDeps } from "./runner.js";
import type { SurfaceParityDeps } from "./surface-parity.js";
import type { EvaluationFixture, ScoringInput } from "./index.js";
import { must } from "./_support.js";

// Fixed clock and id source so test output is deterministic
const FIXED_NOW = 1_700_000_000_000;
const fixedNow = (): number => FIXED_NOW;
const fixedId = (name: string) => (): string => `eval-test-${name}`;

// KEIKO-0533 (#3310): fixtureByName now returns a FixtureLookupResult discriminated union (found /
// not-found / ambiguous) instead of EvaluationFixture | undefined, so tests use a fixed <kind>/<name>
// selector — always unambiguous — and unwrap the "found" case here.
function requireFixture(selector: string): EvaluationFixture {
  const result = fixtureByName(selector);
  if (result.status !== "found") {
    throw new Error(`expected to find fixture "${selector}" (got ${result.status})`);
  }
  return result.fixture;
}

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
    const fixture = requireFixture("unit-tests/happy-path");
    const store = createInMemoryEvidenceStore();
    store.put("old-run", "{}");
    const scorecard = await runEvaluationSuite(
      { mode: "live", fixtures: [fixture], modelIdOverride: "configured-live-model" },
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

  it("fails early when live mode starts without a resolved model selection", async () => {
    const fixture = requireFixture("unit-tests/happy-path");
    await expect(
      runEvaluationSuite(
        { mode: "live", fixtures: [fixture] },
        {
          store: createInMemoryEvidenceStore(),
          now: fixedNow,
          idSource: fixedId("live-missing-model"),
          surfaceParity: SURFACE_PARITY_DEPS,
        },
      ),
    ).rejects.toThrow(ConfigInvalidError);
  });
});

// ─── unit-tests/happy-path ─────────────────────────────────────────────────────

describe("unit-tests/happy-path fixture", () => {
  async function run(): Promise<ReturnType<typeof runEvaluationSuite>> {
    const f = requireFixture("unit-tests/happy-path");
    return runEvaluationSuite(makeOfflineOptions([f]), makeDeps("ut-happy"));
  }

  it("fixture result status is a success terminal (completed or dry-run)", async () => {
    const sc = await run();
    const fr = must(sc.fixtureResults.find((r) => r.fixtureName === "happy-path"));
    const successTerminals = ["completed", "dry-run", "fix-applied", "fix-proposed"];
    expect(successTerminals).toContain(fr.report.status);
  });

  it.each([
    { title: "task-completion scores pass", dimension: "task-completion" },
    {
      title: "patch-correctness scores pass (proposedDiff present)",
      dimension: "patch-correctness",
    },
    {
      title: "audit-completeness scores pass (manifest produced and valid)",
      dimension: "audit-completeness",
    },
    {
      title: "test-pass-rate scores pass (apply mode with fake-spawn exit 0)",
      dimension: "test-pass-rate",
    },
    {
      title: "verification-completeness scores pass (verificationSummary present)",
      dimension: "verification-completeness",
    },
    { title: "patch-size scores pass (within the oracle limits)", dimension: "patch-size" },
  ] as const)("$title", async ({ dimension }) => {
    const sc = await run();
    expect(outcomeOf(sc, "happy-path", dimension)).toBe("pass");
  });
});

// ─── unit-tests/unsafe-action ──────────────────────────────────────────────────

describe("unit-tests/unsafe-action fixture", () => {
  async function run(): Promise<ReturnType<typeof runEvaluationSuite>> {
    const f = requireFixture("unit-tests/unsafe-action");
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
    const f = requireFixture("unit-tests/retry-then-accept");
    return runEvaluationSuite(makeOfflineOptions([f]), makeDeps("ut-retry"));
  }

  it("fixture result status is 'dry-run' (accepted after one retry)", async () => {
    const sc = await run();
    const fr = must(sc.fixtureResults.find((r) => r.fixtureName === "retry-then-accept"));
    expect(fr.report.status).toBe("dry-run");
  });

  it.each([
    { title: "task-completion scores pass", dimension: "task-completion" },
    {
      title: "patch-correctness scores pass (valid diff produced)",
      dimension: "patch-correctness",
    },
    { title: "audit-completeness scores pass", dimension: "audit-completeness" },
  ] as const)("$title", async ({ dimension }) => {
    const sc = await run();
    expect(outcomeOf(sc, "retry-then-accept", dimension)).toBe("pass");
  });
});

// ─── bug-investigation/happy-path ─────────────────────────────────────────────

describe("bug-investigation/happy-path fixture", () => {
  async function run(): Promise<ReturnType<typeof runEvaluationSuite>> {
    const f = requireFixture("bug-investigation/happy-path");
    return runEvaluationSuite(makeOfflineOptions([f]), makeDeps("bug-happy"));
  }

  it("fixture result status is a success terminal (fix-applied or fix-proposed)", async () => {
    const sc = await run();
    const fr = must(sc.fixtureResults.find((r) => r.fixtureName === "happy-path"));
    const successTerminals = ["fix-applied", "fix-proposed", "completed", "dry-run"];
    expect(successTerminals).toContain(fr.report.status);
  });

  it.each([
    { title: "task-completion scores pass", dimension: "task-completion" },
    { title: "patch-correctness scores pass (fix diff present)", dimension: "patch-correctness" },
    { title: "audit-completeness scores pass", dimension: "audit-completeness" },
    {
      title: "test-pass-rate scores pass (apply mode with fake spawn)",
      dimension: "test-pass-rate",
    },
    { title: "verification-completeness scores pass", dimension: "verification-completeness" },
  ] as const)("$title", async ({ dimension }) => {
    const sc = await run();
    expect(outcomeOf(sc, "happy-path", dimension)).toBe("pass");
  });

  // KEIKO-0779: the fixture's own FIX_DIFF touches exactly one file, so its
  // maxExpectedChangedFiles ceiling must be exact (1), not loose (2) -- a patch that
  // unexpectedly touches a second file must flip patch-size to FAIL.
  it("patch-size fails a 2-file patch against the fixture's own (tightened) oracle", () => {
    const f = requireFixture("bug-investigation/happy-path");
    const twoFileInput: ScoringInput = {
      status: "fix-applied",
      proposedDiff: "--- a/src/buggy.ts\n+++ b/src/buggy.ts\n@@ -2 +2 @@\n-a\n+b\n",
      changedFileCount: 2,
      patchBytes: 100,
      verificationStatus: "passed",
      verificationPresent: true,
      manifestValid: true,
      recordedWriteCount: 2,
      mode: "offline",
    };
    const results = scoreFixture(f, twoFileInput);
    const patchSize = must(results.find((r) => r.dimension === "patch-size"));
    expect(patchSize.outcome).toBe("fail");
  });
});

// ─── bug-investigation/unsafe-action ──────────────────────────────────────────

describe("bug-investigation/unsafe-action fixture", () => {
  async function run(): Promise<ReturnType<typeof runEvaluationSuite>> {
    const f = requireFixture("bug-investigation/unsafe-action");
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
    const f = requireFixture("bug-investigation/investigation-only");
    return runEvaluationSuite(makeOfflineOptions([f]), makeDeps("bug-inv-only"));
  }

  it("fixture result status is 'investigation-only'", async () => {
    const sc = await run();
    const fr = must(sc.fixtureResults.find((r) => r.fixtureName === "investigation-only"));
    expect(fr.report.status).toBe("investigation-only");
  });

  it.each([
    {
      title: "task-completion scores pass (investigation-only is a success terminal)",
      dimension: "task-completion",
    },
    {
      title: "patch-correctness scores pass (expectPatch=false and no diff produced)",
      dimension: "patch-correctness",
    },
    { title: "audit-completeness scores pass", dimension: "audit-completeness" },
  ] as const)("$title", async ({ dimension }) => {
    const sc = await run();
    expect(outcomeOf(sc, "investigation-only", dimension)).toBe("pass");
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

// ─── KEIKO-0372: persistAndCheck preserves "cancelled" alongside "completed" / "failed" ──

describe("KEIKO-0372 collapseEvaluationRunStatus", () => {
  // Before this fix, persistAndCheck used a two-way collapse that reported any non-rejected/failed
  // status as "completed" — including "cancelled". packages/keiko-server/src/run-engine.ts's
  // statusOrFailed preserves "cancelled" as its own terminal, so the two consumers had drifted
  // (the #2643 anti-pattern). The extracted helper now handles all three targets identically.
  it.each([
    { input: "completed", expected: "completed" as const },
    { input: "dry-run", expected: "completed" as const },
    { input: "fix-applied", expected: "completed" as const },
    { input: "fix-proposed", expected: "completed" as const },
    { input: "cancelled", expected: "cancelled" as const },
    { input: "failed", expected: "failed" as const },
    { input: "rejected", expected: "failed" as const },
    // Non-string sentinel: any unrecognised value collapses to "failed" (never silently to completed).
    { input: undefined, expected: "failed" as const },
    { input: 42, expected: "failed" as const },
  ])("collapses $input -> $expected", ({ input, expected }) => {
    expect(collapseEvaluationRunStatus(input)).toBe(expected);
  });
});

// ─── KEIKO-0232: applyVerificationExitCode routes through the fake spawn ──────

describe("KEIKO-0232 apply-mode fake-spawn exit code (test-pass-rate)", () => {
  // Baseline: the shipped happy-path fixture defaults to exit 0 and scores test-pass-rate=pass.
  it("test-pass-rate scores pass when the fixture omits applyVerificationExitCode (default 0)", async () => {
    const base = requireFixture("unit-tests/happy-path");
    // Prove the default (undefined) still yields the historical exit-0 behaviour.
    expect(base.applyVerificationExitCode).toBeUndefined();
    const sc = await runEvaluationSuite(makeOfflineOptions([base]), makeDeps("keiko-0232-default"));
    expect(outcomeOf(sc, "happy-path", "test-pass-rate")).toBe("pass");
  });

  // KEIKO-0232 anti-#2643 pin: with a non-zero applyVerificationExitCode the fake spawn must
  // propagate the failure, and test-pass-rate must score fail. Before the fix the runner
  // hard-coded fakeSpawn(0, "ok") which made this outcome unreachable — any apply-mode fixture
  // reported test-pass-rate=pass regardless of what verification would have really done.
  it("test-pass-rate scores fail when applyVerificationExitCode is non-zero", async () => {
    const base = requireFixture("unit-tests/happy-path");
    const failingVerification = {
      ...base,
      name: "happy-path-failing-verification",
      applyVerificationExitCode: 1,
    };
    const sc = await runEvaluationSuite(
      makeOfflineOptions([failingVerification]),
      makeDeps("keiko-0232-fail"),
    );
    expect(outcomeOf(sc, "happy-path-failing-verification", "test-pass-rate")).toBe("fail");
    // verification-completeness is orthogonal: the summary is still present even when it fails,
    // so the dimension should keep reporting pass. This pins that the exit code affects the right
    // dimension only.
    expect(outcomeOf(sc, "happy-path-failing-verification", "verification-completeness")).toBe(
      "pass",
    );
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
