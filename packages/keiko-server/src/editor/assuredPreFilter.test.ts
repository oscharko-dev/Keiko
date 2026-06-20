import { describe, it, expect } from "vitest";
import {
  DEFAULT_ASSURED_PRE_FILTER_CONFIG,
  runAssuredPreFilter,
  type AssuredGateRunner,
  type CoverageOutcome,
  type GateOutcome,
  type MutationOutcome,
} from "./assuredPreFilter.js";

interface FakeRunnerSpec {
  readonly enforced?: boolean;
  readonly build?: GateOutcome;
  readonly tests?: readonly GateOutcome[]; // one entry per stability run; missing → ok
  readonly coverage?: CoverageOutcome;
  readonly mutation?: MutationOutcome;
}

function fakeRunner(spec: FakeRunnerSpec): { runner: AssuredGateRunner; testRuns: () => number } {
  let testIndex = 0;
  const runner: AssuredGateRunner = {
    enforced: spec.enforced ?? true,
    build: (): Promise<GateOutcome> => Promise.resolve(spec.build ?? { ok: true }),
    runTests: (): Promise<GateOutcome> => {
      const outcome = spec.tests?.[testIndex] ?? { ok: true };
      testIndex += 1;
      return Promise.resolve(outcome);
    },
    coverage: (): Promise<CoverageOutcome> =>
      Promise.resolve(spec.coverage ?? { ok: true, lineDelta: 3, branchDelta: 1 }),
    mutation: (): Promise<MutationOutcome> =>
      Promise.resolve(spec.mutation ?? { ok: true, killed: 4, total: 5 }),
  };
  return { runner, testRuns: () => testIndex };
}

describe("runAssuredPreFilter", () => {
  it("surfaces an assured candidate only when every gate passes", async () => {
    const { runner } = fakeRunner({});
    const result = await runAssuredPreFilter(runner);
    expect(result.assurance).toBe("assured");
    expect(result.surfaced).toBe(true);
    expect(result.rejectionReason).toBeUndefined();
    expect(result.funnel).toMatchObject({
      executionEnabled: true,
      candidatesGenerated: 1,
      candidatesSurfaced: 1,
      build: "passed",
      pass: "passed",
      stability: "passed",
      coverage: "passed",
      mutation: "passed",
      antiTautology: "passed",
      coverageLineDelta: 3,
      coverageBranchDelta: 1,
      mutantsKilled: 4,
      mutantsTotal: 5,
    });
  });

  it("runs the candidate test stabilityRuns times", async () => {
    const { runner, testRuns } = fakeRunner({});
    await runAssuredPreFilter(runner);
    expect(testRuns()).toBe(DEFAULT_ASSURED_PRE_FILTER_CONFIG.stabilityRuns);
  });

  it("refuses to execute and stays unverified when egress is not enforced (untrusted evidence only)", async () => {
    const { runner, testRuns } = fakeRunner({ enforced: false });
    const result = await runAssuredPreFilter(runner);
    expect(result.assurance).toBe("unverified");
    expect(result.surfaced).toBe(false);
    expect(result.rejectionReason).toContain("not enforced");
    expect(result.funnel.executionEnabled).toBe(true);
    expect(result.funnel.build).toBe("not-run");
    expect(testRuns()).toBe(0);
  });

  it("rejects at build and leaves later gates not-run", async () => {
    const { runner, testRuns } = fakeRunner({ build: { ok: false } });
    const result = await runAssuredPreFilter(runner);
    expect(result.surfaced).toBe(false);
    expect(result.funnel.build).toBe("failed");
    expect(result.funnel.pass).toBe("not-run");
    expect(result.funnel.coverage).toBe("not-run");
    expect(testRuns()).toBe(0);
  });

  it("rejects when the candidate test does not pass", async () => {
    const { runner } = fakeRunner({ tests: [{ ok: false }] });
    const result = await runAssuredPreFilter(runner);
    expect(result.funnel.pass).toBe("failed");
    expect(result.funnel.stability).toBe("not-run");
    expect(result.rejectionReason).toContain("does not pass");
  });

  it("rejects a flaky candidate (passes first, fails a later stability run)", async () => {
    const { runner } = fakeRunner({ tests: [{ ok: true }, { ok: true }, { ok: false }] });
    const result = await runAssuredPreFilter(runner);
    expect(result.funnel.pass).toBe("passed");
    expect(result.funnel.stability).toBe("failed");
    expect(result.funnel.coverage).toBe("not-run");
    expect(result.rejectionReason).toContain("flaky");
  });

  it("rejects when coverage does not strictly increase, recording the delta", async () => {
    const { runner } = fakeRunner({ coverage: { ok: false, lineDelta: 0, branchDelta: 0 } });
    const result = await runAssuredPreFilter(runner);
    expect(result.funnel.coverage).toBe("failed");
    expect(result.funnel.mutation).toBe("not-run");
    expect(result.funnel.coverageLineDelta).toBe(0);
    expect(result.rejectionReason).toContain("coverage");
  });

  it("rejects a weak oracle that does not kill enough mutants, recording counts", async () => {
    const { runner } = fakeRunner({ mutation: { ok: false, killed: 0, total: 6 } });
    const result = await runAssuredPreFilter(runner);
    expect(result.funnel.mutation).toBe("failed");
    expect(result.funnel.antiTautology).toBe("failed");
    expect(result.funnel.mutantsKilled).toBe(0);
    expect(result.funnel.mutantsTotal).toBe(6);
    expect(result.assurance).toBe("unverified");
    expect(result.rejectionReason).toContain("mutant");
  });
});
