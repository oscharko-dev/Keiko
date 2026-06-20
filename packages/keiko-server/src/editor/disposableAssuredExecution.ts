// Disposable-execution composition for the assured pre-filter (Issue #1202 wave-2; ADR-0043).
//
// Determines whether THIS host can enforce a deny-by-default egress boundary (keiko-sandbox) and, when
// it can, runs the assured pre-filter against a disposable execution root: a throwaway copy of the
// target project where the candidate is applied, the gates run through the enforced sandboxed command
// boundary, and which is always disposed — the user's workspace is never written. When the host cannot
// enforce egress the pre-filter fails closed: the candidate is reported as untrusted evidence only and
// is never `assured` (owner decision on #1202).
//
// The lifecycle is expressed over injectable ports so the composition (copy -> baseline -> apply ->
// gates -> dispose, with dispose guaranteed) is unit-tested with fakes; the node ports that perform the
// real filesystem copy and sandboxed command runs are assembled in assuredPreFilterRunner.ts.

import { currentPlatform, planIsolatedRun, probeBackends } from "@oscharko-dev/keiko-sandbox";
import {
  DEFAULT_ASSURED_PRE_FILTER_CONFIG,
  runAssuredPreFilter,
  type AssuredGateRunner,
  type AssuredPreFilterConfig,
  type AssuredPreFilterOutcome,
} from "./assuredPreFilter.js";
import {
  createSandboxedGateRunner,
  type SandboxedCommand,
  type SandboxedRunResult,
} from "./assuredGateRunner.js";

// Whether keiko-sandbox can enforce egress for a network:"none" run on this host (no command is run).
export function sandboxEnforcesEgress(cwd: string): boolean {
  const decision = planIsolatedRun(
    { command: "node", args: [], cwd, network: "none" },
    probeBackends(),
    currentPlatform(),
  );
  return decision.kind === "wrapped";
}

// A gate runner whose gates must never be invoked (used on the fail-closed path; runAssuredPreFilter
// returns before calling any gate when `enforced` is false).
function failClosedRunner(): AssuredGateRunner {
  const never = (): Promise<never> =>
    Promise.reject(new Error("assured pre-filter gate must not run when egress is not enforced"));
  return { enforced: false, build: never, runTests: never, coverage: never, mutation: never };
}

export interface DisposableExecutionPorts {
  // True iff `run` executes inside an enforced deny-by-default egress boundary.
  readonly enforced: boolean;
  // Materialises the disposable root (temp dir + copy of the target project) and returns its path.
  readonly makeRoot: () => Promise<string>;
  // Runs the baseline coverage pass BEFORE the candidate is applied and persists its report.
  readonly measureBaseline: (root: string) => Promise<void>;
  // Applies the candidate patch into the disposable root.
  readonly applyCandidate: (root: string) => Promise<void>;
  // Runs one untrusted command inside the disposable root through the enforced sandbox.
  readonly run: (root: string, cmd: SandboxedCommand) => Promise<SandboxedRunResult>;
  // Reads a JSON report a gate command wrote into the disposable root.
  readonly readReport: (root: string, relativePath: string) => unknown;
  // Removes the disposable root (always called, even on failure).
  readonly dispose: (root: string) => Promise<void>;
  readonly buildCommand: SandboxedCommand;
  readonly testCommand: SandboxedCommand;
  readonly coverageCommand: SandboxedCommand;
  readonly mutationCommand: SandboxedCommand;
  readonly baselineCoverageReportPath: string;
  readonly patchedCoverageReportPath: string;
  readonly mutationReportPath: string;
  readonly targetCoverageKeys: readonly string[];
}

export async function runDisposableAssuredPreFilter(
  ports: DisposableExecutionPorts,
  config: AssuredPreFilterConfig = DEFAULT_ASSURED_PRE_FILTER_CONFIG,
): Promise<AssuredPreFilterOutcome> {
  if (!ports.enforced) {
    return runAssuredPreFilter(failClosedRunner(), config);
  }
  const root = await ports.makeRoot();
  try {
    await ports.measureBaseline(root);
    await ports.applyCandidate(root);
    const runner = createSandboxedGateRunner({
      enforced: true,
      run: (cmd) => ports.run(root, cmd),
      readReport: (relativePath) => ports.readReport(root, relativePath),
      buildCommand: ports.buildCommand,
      testCommand: ports.testCommand,
      coverageCommand: ports.coverageCommand,
      mutationCommand: ports.mutationCommand,
      baselineCoverageReportPath: ports.baselineCoverageReportPath,
      patchedCoverageReportPath: ports.patchedCoverageReportPath,
      mutationReportPath: ports.mutationReportPath,
      targetCoverageKeys: ports.targetCoverageKeys,
      minMutantsKilled: config.minMutantsKilled,
    });
    return await runAssuredPreFilter(runner, config);
  } finally {
    await ports.dispose(root);
  }
}
