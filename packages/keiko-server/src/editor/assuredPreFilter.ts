// Assured pre-filter for editor-driven test generation (Issue #1202 wave-2; ADR-0042 D7, ADR-0043).
//
// Models Meta's "Automated Unit Test Improvement" assurance funnel: a generated candidate is surfaced
// as apply-ready ONLY if, in order, it builds → passes → is stable across N>=5 executions → strictly
// increases coverage for the target → kills enough injected mutants (oracle strength, which supersedes
// the qualitative anti-tautology rule for the first TS/JS stack). Every gate executes UNTRUSTED,
// model-generated code, so it runs through an enforced deny-by-default egress boundary (keiko-sandbox,
// ADR-0043). When the boundary is not enforced the pre-filter refuses to execute and reports the
// candidate as untrusted evidence only — never `assured` (owner decision on #1202).
//
// This module is the PURE sequencing + funnel/assurance decision over an injected AssuredGateRunner;
// the runner (which materialises a disposable execution root and runs build/vitest/Stryker through the
// sandboxed command boundary) is the effect, assembled in assuredGateRunner.ts.

import {
  EDITOR_TEST_GENERATION_STABILITY_RUNS,
  type EditorTestGenerationAssurance,
  type EditorTestGenerationFunnel,
  type EditorTestGenerationGateState,
} from "@oscharko-dev/keiko-contracts";

export interface GateOutcome {
  readonly ok: boolean;
}

export interface CoverageOutcome {
  readonly ok: boolean;
  readonly lineDelta: number;
  readonly branchDelta: number;
}

export interface MutationOutcome {
  readonly ok: boolean;
  readonly killed: number;
  readonly total: number;
}

// The effectful gate operations, each running one untrusted command inside the enforced sandbox.
export interface AssuredGateRunner {
  // True iff the runner executes inside an enforced deny-by-default egress boundary.
  readonly enforced: boolean;
  readonly build: () => Promise<GateOutcome>;
  readonly runTests: () => Promise<GateOutcome>;
  readonly coverage: () => Promise<CoverageOutcome>;
  readonly mutation: () => Promise<MutationOutcome>;
}

export interface AssuredPreFilterConfig {
  readonly stabilityRuns: number;
  readonly minMutantsKilled: number;
}

export const DEFAULT_ASSURED_PRE_FILTER_CONFIG: AssuredPreFilterConfig = {
  stabilityRuns: EDITOR_TEST_GENERATION_STABILITY_RUNS,
  minMutantsKilled: 1,
};

export interface AssuredPreFilterOutcome {
  readonly funnel: EditorTestGenerationFunnel;
  readonly assurance: EditorTestGenerationAssurance;
  readonly surfaced: boolean;
  readonly rejectionReason?: string | undefined;
}

interface GateStates {
  build: EditorTestGenerationGateState;
  pass: EditorTestGenerationGateState;
  stability: EditorTestGenerationGateState;
  coverage: EditorTestGenerationGateState;
  mutation: EditorTestGenerationGateState;
  antiTautology: EditorTestGenerationGateState;
}

interface Evidence {
  coverageLineDelta?: number;
  coverageBranchDelta?: number;
  mutantsKilled?: number;
  mutantsTotal?: number;
}

const NOT_ENFORCED_REASON =
  "The deny-by-default network-egress boundary required to execute the candidate is not enforced on " +
  "this host; the candidate is shown as untrusted evidence only and is not assured.";

function allNotRun(): GateStates {
  return {
    build: "not-run",
    pass: "not-run",
    stability: "not-run",
    coverage: "not-run",
    mutation: "not-run",
    antiTautology: "not-run",
  };
}

function toFunnel(
  states: GateStates,
  surfaced: boolean,
  config: AssuredPreFilterConfig,
  evidence: Evidence,
): EditorTestGenerationFunnel {
  return {
    executionEnabled: true,
    candidatesGenerated: 1,
    candidatesSurfaced: surfaced ? 1 : 0,
    stabilityRunsRequired: config.stabilityRuns,
    build: states.build,
    pass: states.pass,
    stability: states.stability,
    coverage: states.coverage,
    mutation: states.mutation,
    antiTautology: states.antiTautology,
    ...(evidence.coverageLineDelta === undefined
      ? {}
      : { coverageLineDelta: evidence.coverageLineDelta }),
    ...(evidence.coverageBranchDelta === undefined
      ? {}
      : { coverageBranchDelta: evidence.coverageBranchDelta }),
    ...(evidence.mutantsKilled === undefined ? {} : { mutantsKilled: evidence.mutantsKilled }),
    ...(evidence.mutantsTotal === undefined ? {} : { mutantsTotal: evidence.mutantsTotal }),
  };
}

function reject(
  states: GateStates,
  config: AssuredPreFilterConfig,
  reason: string,
  evidence: Evidence = {},
): AssuredPreFilterOutcome {
  return {
    funnel: toFunnel(states, false, config, evidence),
    assurance: "unverified",
    surfaced: false,
    rejectionReason: reason,
  };
}

// Runs the candidate test `stabilityRuns` times. The first run is the `pass` gate; all runs together
// are the `stability` gate (no flakiness across N executions).
async function runStability(
  runner: AssuredGateRunner,
  runs: number,
): Promise<{ firstOk: boolean; allOk: boolean }> {
  let firstOk = false;
  let allOk = true;
  for (let i = 0; i < runs; i += 1) {
    const outcome = await runner.runTests();
    if (i === 0) {
      firstOk = outcome.ok;
    }
    if (!outcome.ok) {
      allOk = false;
    }
  }
  return { firstOk, allOk };
}

// Each gate mutates `states`/`evidence` and returns a rejection outcome to stop the funnel, or
// undefined to continue. Splitting per gate keeps the orchestrator short and within complexity limits.

async function buildGate(
  runner: AssuredGateRunner,
  states: GateStates,
  config: AssuredPreFilterConfig,
): Promise<AssuredPreFilterOutcome | undefined> {
  const build = await runner.build();
  states.build = build.ok ? "passed" : "failed";
  return build.ok ? undefined : reject(states, config, "The generated candidate does not build.");
}

async function stabilityGate(
  runner: AssuredGateRunner,
  states: GateStates,
  config: AssuredPreFilterConfig,
): Promise<AssuredPreFilterOutcome | undefined> {
  const stability = await runStability(runner, config.stabilityRuns);
  states.pass = stability.firstOk ? "passed" : "failed";
  if (!stability.firstOk) {
    return reject(states, config, "The generated candidate test does not pass.");
  }
  states.stability = stability.allOk ? "passed" : "failed";
  return stability.allOk
    ? undefined
    : reject(states, config, "The generated candidate test is flaky across stability runs.");
}

async function coverageGate(
  runner: AssuredGateRunner,
  states: GateStates,
  config: AssuredPreFilterConfig,
  evidence: Evidence,
): Promise<AssuredPreFilterOutcome | undefined> {
  const cov = await runner.coverage();
  states.coverage = cov.ok ? "passed" : "failed";
  evidence.coverageLineDelta = cov.lineDelta;
  evidence.coverageBranchDelta = cov.branchDelta;
  return cov.ok
    ? undefined
    : reject(states, config, "The generated candidate does not increase coverage.", evidence);
}

async function mutationGate(
  runner: AssuredGateRunner,
  states: GateStates,
  config: AssuredPreFilterConfig,
  evidence: Evidence,
): Promise<AssuredPreFilterOutcome | undefined> {
  const mut = await runner.mutation();
  evidence.mutantsKilled = mut.killed;
  evidence.mutantsTotal = mut.total;
  states.mutation = mut.ok ? "passed" : "failed";
  // Mutation (oracle strength) supersedes the qualitative anti-tautology rule for the first stack.
  states.antiTautology = mut.ok ? "passed" : "failed";
  return mut.ok
    ? undefined
    : reject(
        states,
        config,
        "The generated candidate does not kill enough injected mutants (weak oracle).",
        evidence,
      );
}

export async function runAssuredPreFilter(
  runner: AssuredGateRunner,
  config: AssuredPreFilterConfig = DEFAULT_ASSURED_PRE_FILTER_CONFIG,
): Promise<AssuredPreFilterOutcome> {
  if (!runner.enforced) {
    return {
      funnel: toFunnel(allNotRun(), false, config, {}),
      assurance: "unverified",
      surfaced: false,
      rejectionReason: NOT_ENFORCED_REASON,
    };
  }
  const states = allNotRun();
  const evidence: Evidence = {};
  const rejected =
    (await buildGate(runner, states, config)) ??
    (await stabilityGate(runner, states, config)) ??
    (await coverageGate(runner, states, config, evidence)) ??
    (await mutationGate(runner, states, config, evidence));
  if (rejected !== undefined) {
    return rejected;
  }
  return { funnel: toFunnel(states, true, config, evidence), assurance: "assured", surfaced: true };
}
