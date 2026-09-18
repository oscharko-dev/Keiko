// End-to-end Activity Log scenarios (#3532): the curated fault-injection matrix.
//
// A scenario drives a production entry point of one product surface into one failure mode
// (rejection, dependency failure or timeout, crash or abort, loss or backpressure) with the real
// production file writer under a temporary `KEIKO_STATE_DIR`, and then calls
//
//   expectActivityLogScenario("<surface>.<mode>", { stateDir, startedAtMs, expectedOps })
//
// with a literal scenario id — `scripts/generate-op-catalog.mjs` resolves the inventory's scenario
// matrix from those literals, and every registered failure class maps to the scenario of its
// surface and mode. The helper reconstructs the persisted log with `keiko support analyze`'s own
// `analyzeLogText` and asserts what the scenario proves:
//
//   * every line is supported v2 evidence of this build (no corrupt, truncated or foreign line);
//   * the expected operations were persisted in causal order;
//   * the trace exercises at least one failure class the inventory maps to this scenario;
//   * the analyzer's per-failure-class sufficiency projection is `complete`;
//   * (#3533 acceptance) the local incident candidate the scenario's failure creates through the
//     production trigger pins a window whose #3531 query-engine selection contains every line of
//     that failure's own registered causal closure — see `proveIncidentWindowCoversClosure`.
//
// Failure messages name the scenario, the class and the closed reason — never a field value. The
// returned trace measurements (bytes, lines, lines per second) calibrate segment and retention
// budgets; set KEIKO_ACTIVITY_LOG_SCENARIO_METRICS to a directory to also record them there.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import {
  ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
  activityLogOperationSchema,
} from "@oscharko-dev/keiko-contracts/runtime/observability";
import {
  recordRegisteredFailureIncident,
  recordUserReportedIncident,
} from "@oscharko-dev/keiko-server";
import {
  analyzeLogText,
  type AnalyzeAllResult,
  type OpCluster,
} from "../../packages/keiko-cli/src/support-analyze.js";
import {
  DEFAULT_SUPPORT_QUERY_LIMITS,
  type SupportQueryResult,
} from "../../packages/keiko-cli/src/support-query.js";
import {
  executeSupportQuery,
  resolveSupportSelection,
} from "../../packages/keiko-cli/src/support-query-cli.js";
import { readPersistedActivityLog } from "./activity-log-proof.js";

export interface ActivityLogScenarioRun {
  /** The temporary state directory the production writer persisted the scenario into. */
  readonly stateDir: string;
  /** `Date.now()` taken immediately before the scenario drove its entry point. */
  readonly startedAtMs: number;
  /** Operations the scenario must have persisted, in causal order (other lines may interleave). */
  readonly expectedOps: readonly string[];
}

export interface ActivityLogScenarioTrace {
  readonly scenario: string;
  readonly lineCount: number;
  readonly byteCount: number;
  readonly elapsedMs: number;
  readonly linesPerSecond: number;
  readonly failureClasses: readonly string[];
}

interface FailureSurfaceInventory {
  readonly failureClassScenarios: Readonly<Record<string, readonly string[]>>;
}

function scenarioInventory(): FailureSurfaceInventory {
  const path = new URL(
    "../../docs/observability/failure-surface-inventory.generated.json",
    import.meta.url,
  );
  return JSON.parse(readFileSync(path, "utf8")) as FailureSurfaceInventory;
}

function persistedOps(text: string): readonly string[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { readonly op?: unknown }).op)
    .filter((op): op is string => typeof op === "string");
}

function expectOrderedSubsequence(
  scenario: string,
  ops: readonly string[],
  expectedOps: readonly string[],
): void {
  let cursor = 0;
  for (const expected of expectedOps) {
    const index = ops.indexOf(expected, cursor);
    expect(index, `scenario ${scenario}: ${expected} persisted in causal order`).toBeGreaterThan(
      -1,
    );
    cursor = index + 1;
  }
}

function recordTrace(trace: ActivityLogScenarioTrace): void {
  const directory = process.env.KEIKO_ACTIVITY_LOG_SCENARIO_METRICS;
  if (directory === undefined || directory === "") return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${trace.scenario}.json`), `${JSON.stringify(trace)}\n`, "utf8");
}

// ─── #3533 acceptance: the pinned window covers the complete registered causal closure ──────────
//
// Every #3532 scenario already exercises a registered failure class (asserted above). This second
// pass creates the SAME local incident candidate a real Keiko install would create for that
// failure, through the same production entry points #3533 defines
// (packages/keiko-server/src/observability/support-incident.ts's recordRegisteredFailureIncident,
// the registered-failure trigger's own recorder; recordUserReportedIncident as the fallback for a
// scenario whose only evidence is an uncorrelated state signal, never a discrete failure op — a
// heartbeat sampling process-stall/memory-pressure, never itself `lifecycle: "failure"`), then
// selects BOTH closures through the #3531 query engine (the same
// resolveSupportSelection/executeSupportQuery pair `keiko support query --incident` and
// `--correlation-id` run) and proves the incident's own selection is a superset of the failure's
// direct correlation closure — i.e. every line a direct query for that one correlation would select
// is present in what the pinned incident window resolves to. A scenario deliberately drives more
// than one independent correlation in the same test (siblings, not one chain); the acceptance
// criterion is that the incident's OWN closure is complete, not that every unrelated line the test
// happens to also emit is swept in.
function primaryFailureCluster(result: AnalyzeAllResult): OpCluster | undefined {
  return result.clusters.find(
    (cluster) => activityLogOperationSchema(cluster.op)?.lifecycle === "failure",
  );
}

// A cluster's sample carries whatever the persisted `correlationId` field held, including the
// closed `ACTIVITY_LOG_UNKNOWN_CORRELATION_ID` sentinel some diagnostic paths write when no
// request-scoped id is in context (support-query.ts's own `knownCorrelation` applies the same
// filter for the query engine's roots). Treating that shared, non-unique sentinel as a real
// correlation id would create an incident rooted on it — a false closure, not this failure's own.
function knownFailureCorrelationId(cluster: OpCluster): string | undefined {
  const id = cluster.sampleCorrelationIds[0];
  return id === undefined || id === ACTIVITY_LOG_UNKNOWN_CORRELATION_ID ? undefined : id;
}

async function queryEvents(
  stateDir: string,
  selector: Parameters<typeof resolveSupportSelection>[0],
): Promise<SupportQueryResult> {
  const selection = await resolveSupportSelection(selector, stateDir);
  return executeSupportQuery(stateDir, selection, DEFAULT_SUPPORT_QUERY_LIMITS, {
    trigger: "query",
  }).result;
}

async function proveIncidentWindowCoversClosure(
  scenario: string,
  stateDir: string,
  result: AnalyzeAllResult,
): Promise<void> {
  const failure = primaryFailureCluster(result);
  const correlationId = failure === undefined ? undefined : knownFailureCorrelationId(failure);
  const creation =
    failure === undefined
      ? recordUserReportedIncident(stateDir, {})
      : recordRegisteredFailureIncident(stateDir, {
          op: failure.op,
          errorKind: failure.errorKind ?? undefined,
          correlationId,
        });
  expect(creation, `scenario ${scenario}: records an incident candidate for its failure`).not.toBe(
    undefined,
  );
  if (creation === undefined) return;
  if (creation.status === "rejected") {
    expect.fail(`scenario ${scenario}: incident candidate was rejected (${creation.reason})`);
  }

  const incidentResult = await queryEvents(stateDir, {
    incidentId: creation.incidentId,
    filter: {},
  });
  expect(
    incidentResult.diagnosticSufficiency.reasons,
    `scenario ${scenario}: the incident's own selection is retained`,
  ).not.toContain("evidence-not-retained");

  if (correlationId === undefined) {
    // A bare diagnostic op with no correlation of its own: there is no independent closure to
    // compare against, only the pinned window itself, already proven non-empty above.
    return;
  }
  const ownResult = await queryEvents(stateDir, { correlationId, filter: {} });
  const incidentLines = new Set(incidentResult.events.map((event) => event.text));
  const missing = ownResult.events
    .map((event) => event.text)
    .filter((text) => !incidentLines.has(text));
  expect(
    missing,
    `scenario ${scenario}: the pinned window contains every line of the failure's own registered causal closure`,
  ).toEqual([]);
}

/**
 * Reconstructs the scenario's persisted Activity Log through the support analyzer and asserts a
 * complete report. `scenario` must be a string literal: the op-catalog generator resolves the
 * scenario matrix from these calls. Also proves the #3533 acceptance criterion: the local incident
 * candidate this scenario's failure creates through the production path pins a window whose #3531
 * query-engine selection contains every line of that failure's own registered causal closure (see
 * `proveIncidentWindowCoversClosure`).
 */
export async function expectActivityLogScenario(
  scenario: string,
  run: ActivityLogScenarioRun,
): Promise<ActivityLogScenarioTrace> {
  const text = readPersistedActivityLog(run.stateDir);
  const elapsedMs = Math.max(1, Date.now() - run.startedAtMs);
  const result = analyzeLogText(text);
  expect(result.evidence.classification, `scenario ${scenario}: evidence integrity`).toBe(
    "supported",
  );
  expectOrderedSubsequence(scenario, persistedOps(text), run.expectedOps);
  const failureClasses = result.sufficiency.classes.map((entry) => entry.failureClass);
  const mapped = scenarioInventory().failureClassScenarios;
  expect(
    failureClasses.some((failureClass) => mapped[failureClass]?.includes(scenario) === true),
    `scenario ${scenario}: exercises a failure class the inventory maps to it`,
  ).toBe(true);
  const incomplete = result.sufficiency.classes
    .filter((entry) => entry.status !== "complete")
    .map((entry) => `${entry.failureClass}:${entry.reasons.join("+")}`);
  expect(incomplete, `scenario ${scenario}: every observed class is complete`).toEqual([]);
  expect(result.sufficiency.status, `scenario ${scenario}: report sufficiency`).toBe("complete");
  await proveIncidentWindowCoversClosure(scenario, run.stateDir, result);
  const lineCount = persistedOps(text).length;
  const trace = {
    scenario,
    lineCount,
    byteCount: Buffer.byteLength(text, "utf8"),
    elapsedMs,
    linesPerSecond: Math.round((lineCount * 1000) / elapsedMs),
    failureClasses,
  };
  recordTrace(trace);
  return trace;
}
