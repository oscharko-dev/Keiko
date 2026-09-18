// Per-failure-class diagnostic sufficiency for `keiko support analyze` (#3532).
//
// Every registered failure class declares, in the generated registry, which operations make up its
// lifecycle (start/state/end/failure/loss) and which of them are causal. This module derives from
// those declarations — generically, never per operation — whether the evidence an artifact holds
// for each class it observed is `complete`, `degraded` or `insufficient`, with the closed reasons of
// `DIAGNOSTIC_SUFFICIENCY_REASONS` (keiko-contracts):
//
//   insufficient — required evidence or causal closure is missing, so the class cannot be
//                  reconstructed: corrupt lines, a parent-correlated operation without its parent,
//                  an end or failure without the causal start its class declares on the same
//                  correlation, or no registered evidence at all.
//   degraded     — localization and replay remain possible, but a closed warning or a bounded loss
//                  exists: truncated, unsupported or incomplete lines, a sequence anomaly other than
//                  a gap (a gap can be a write to another state directory), Activity Log evidence
//                  loss reported in the same process, a dropped line naming one of the class's
//                  operations, a failure with no known correlation, or an emitter that declared its
//                  own line partial.
//   complete     — none of the above.
//
// Loss propagation. A loss-lifecycle line records the loss of its own subject; that line IS the
// class's evidence, so it never degrades its own class. Only a loss of Activity Log evidence itself
// — a loss line of an `activity-log-*` failure class whose `loss` state is not `none` — degrades
// other classes: the classes of the operation it names (`failedOp`/`droppedOp`), or else every
// class observed in the same process lifetime. The `activity-log.loss` summary also counts
// browser-side drops (`client*` counters) that the client-diagnostic loss lines evidence on their
// own, so only its Activity Log counters propagate. A product loss fully evidenced by its own
// registered loss line (a rate-limited client report, a bounded discovery) keeps the report
// complete.

import {
  ACTIVITY_LOG_FAILURE_CLASS_COVERAGE,
  ACTIVITY_LOG_OPERATION_REGISTRY,
  ACTIVITY_LOG_UNKNOWN_CORRELATION_ID,
  DIAGNOSTIC_SUFFICIENCY_REASONS,
  diagnosticSufficiencyStatus,
  type DiagnosticSufficiencyReason,
  type DiagnosticSufficiencyStatus,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

export interface ActivityLogClassSufficiency {
  readonly failureClass: string;
  readonly status: DiagnosticSufficiencyStatus;
  readonly reasons: readonly DiagnosticSufficiencyReason[];
  readonly lineCount: number;
}

export interface ActivityLogSufficiencyCoverage {
  readonly observedClassCount: number;
  readonly completeClassCount: number;
  readonly degradedClassCount: number;
  readonly insufficientClassCount: number;
}

export interface ActivityLogSufficiency {
  readonly status: DiagnosticSufficiencyStatus;
  readonly reasons: readonly DiagnosticSufficiencyReason[];
  readonly classes: readonly ActivityLogClassSufficiency[];
  readonly coverage: ActivityLogSufficiencyCoverage;
}

/** One accepted Activity Log line as the analyzer parsed it. `fields` holds its non-envelope fields. */
export interface ActivityLogSufficiencyLine {
  readonly op: string;
  readonly correlationId?: string | undefined;
  readonly parentCorrelationId?: string | undefined;
  readonly pid?: number | undefined;
  readonly instanceId?: string | undefined;
  readonly fields?: Readonly<Record<string, unknown>> | undefined;
}

/** The artifact integrity counts `analyzeLogText` already derives (`ActivityLogEvidenceSummary`). */
export interface ActivityLogSufficiencyIntegrity {
  readonly corruptLineCount: number;
  readonly truncatedLineCount: number;
  readonly unsupportedLineCount: number;
  readonly incompleteLineCount: number;
  readonly sequenceAnomalies: readonly { readonly kind: string }[];
}

interface ClassCoverage {
  readonly failureClass: string;
  readonly lifecycleOperations: Readonly<Partial<Record<string, readonly string[]>>>;
}

interface OperationFacts {
  readonly lifecycle: string;
  readonly causal: string;
  readonly failureClasses: readonly string[];
}

const COVERAGE_BY_CLASS: ReadonlyMap<string, ClassCoverage> = new Map(
  (ACTIVITY_LOG_FAILURE_CLASS_COVERAGE.classes as readonly ClassCoverage[]).map((entry) => [
    entry.failureClass,
    entry,
  ]),
);

const OPERATION_FACTS: ReadonlyMap<string, OperationFacts> = new Map(
  (ACTIVITY_LOG_OPERATION_REGISTRY as readonly (OperationFacts & { readonly op: string })[]).map(
    (registration) => [registration.op, registration],
  ),
);

const ACTIVITY_LOG_EVIDENCE_CLASS_PREFIX = "activity-log-";
const ACTIVITY_LOG_LOSS_SUMMARY_OP = "activity-log.loss";
const CLIENT_LOSS_COUNTER_PREFIX = "client";
const DROPPED_OPERATION_FIELDS = ["failedOp", "droppedOp"] as const;

function knownCorrelation(value: string | undefined): value is string {
  return value !== undefined && value !== ACTIVITY_LOG_UNKNOWN_CORRELATION_ID;
}

function lifetimeKey(line: ActivityLogSufficiencyLine): string {
  return `${String(line.pid ?? "")}:${line.instanceId ?? ""}`;
}

function classesOf(op: string): readonly string[] {
  return OPERATION_FACTS.get(op)?.failureClasses ?? [];
}

function positiveCount(value: unknown): boolean {
  return typeof value === "number" && value > 0;
}

// The summary's Activity Log counters: every count except the total and the browser-side ones.
function summaryReportsEvidenceLoss(fields: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(fields).some(
    ([name, value]) =>
      name !== "totalLost" && !name.startsWith(CLIENT_LOSS_COUNTER_PREFIX) && positiveCount(value),
  );
}

function isEvidenceLossLine(line: ActivityLogSufficiencyLine): boolean {
  const facts = OPERATION_FACTS.get(line.op);
  if (facts?.lifecycle !== "loss") return false;
  if (!facts.failureClasses.some((name) => name.startsWith(ACTIVITY_LOG_EVIDENCE_CLASS_PREFIX))) {
    return false;
  }
  const fields = line.fields ?? {};
  if (line.op === ACTIVITY_LOG_LOSS_SUMMARY_OP) return summaryReportsEvidenceLoss(fields);
  return fields.loss !== undefined && fields.loss !== "none";
}

function droppedOperation(line: ActivityLogSufficiencyLine): string | undefined {
  for (const name of DROPPED_OPERATION_FIELDS) {
    const value = line.fields?.[name];
    if (typeof value === "string" && OPERATION_FACTS.has(value)) return value;
  }
  return undefined;
}

interface LossAttribution {
  readonly droppedClasses: ReadonlySet<string>;
  readonly lossLifetimes: ReadonlySet<string>;
}

function lossAttribution(lines: readonly ActivityLogSufficiencyLine[]): LossAttribution {
  const droppedClasses = new Set<string>();
  const lossLifetimes = new Set<string>();
  for (const line of lines) {
    if (!isEvidenceLossLine(line)) continue;
    const dropped = droppedOperation(line);
    if (dropped === undefined) lossLifetimes.add(lifetimeKey(line));
    else for (const name of classesOf(dropped)) droppedClasses.add(name);
  }
  return { droppedClasses, lossLifetimes };
}

function integrityReasons(
  integrity: ActivityLogSufficiencyIntegrity,
): readonly DiagnosticSufficiencyReason[] {
  const reasons: DiagnosticSufficiencyReason[] = [];
  if (integrity.corruptLineCount > 0) reasons.push("corrupt-evidence");
  if (integrity.truncatedLineCount > 0) reasons.push("truncated-evidence");
  if (integrity.unsupportedLineCount > 0) reasons.push("unsupported-evidence");
  if (integrity.incompleteLineCount > 0) reasons.push("incomplete-evidence");
  if (integrity.sequenceAnomalies.some((anomaly) => anomaly.kind !== "gap")) {
    reasons.push("sequence-anomaly");
  }
  return reasons;
}

function causalReasons(
  line: ActivityLogSufficiencyLine,
  facts: OperationFacts,
): readonly DiagnosticSufficiencyReason[] {
  const reasons: DiagnosticSufficiencyReason[] = [];
  if (facts.causal === "parent-correlation" && !knownCorrelation(line.parentCorrelationId)) {
    reasons.push("parent-correlation-missing");
  }
  const failure = facts.causal !== "none" && facts.lifecycle === "failure";
  if (failure && !knownCorrelation(line.correlationId)) reasons.push("correlation-unknown");
  return reasons;
}

function lineReasons(line: ActivityLogSufficiencyLine): readonly DiagnosticSufficiencyReason[] {
  const facts = OPERATION_FACTS.get(line.op);
  if (facts === undefined) return [];
  const completeness = line.fields?.completeness;
  const partial =
    facts.lifecycle !== "loss" && completeness !== undefined && completeness !== "complete";
  return partial ? [...causalReasons(line, facts), "evidence-partial"] : causalReasons(line, facts);
}

function causalStartOperations(coverage: ClassCoverage): readonly string[] {
  return (coverage.lifecycleOperations.start ?? []).filter(
    (op) => (OPERATION_FACTS.get(op)?.causal ?? "none") !== "none",
  );
}

function closesOnKnownCorrelation(line: ActivityLogSufficiencyLine): boolean {
  const facts = OPERATION_FACTS.get(line.op);
  if (facts === undefined || facts.causal === "none") return false;
  const closing = facts.lifecycle === "end" || facts.lifecycle === "failure";
  return closing && knownCorrelation(line.correlationId);
}

// An end or failure on a known correlation needs a start of the same class on that correlation,
// when the class declares a causal start. A missing start breaks the class's causal closure.
function lifecycleStartMissing(
  coverage: ClassCoverage,
  members: readonly ActivityLogSufficiencyLine[],
): boolean {
  const starts = causalStartOperations(coverage);
  if (starts.length === 0) return false;
  const started = new Set(
    members
      .filter((line) => starts.includes(line.op) && knownCorrelation(line.correlationId))
      .map((line) => line.correlationId),
  );
  return members.some((line) => closesOnKnownCorrelation(line) && !started.has(line.correlationId));
}

function orderedReasons(
  reasons: Iterable<DiagnosticSufficiencyReason>,
): readonly DiagnosticSufficiencyReason[] {
  const present = new Set(reasons);
  return DIAGNOSTIC_SUFFICIENCY_REASONS.filter((reason) => present.has(reason));
}

function classSufficiency(
  failureClass: string,
  members: readonly ActivityLogSufficiencyLine[],
  shared: readonly DiagnosticSufficiencyReason[],
  loss: LossAttribution,
): ActivityLogClassSufficiency {
  const reasons = new Set<DiagnosticSufficiencyReason>(shared);
  for (const line of members) {
    for (const reason of lineReasons(line)) reasons.add(reason);
    if (loss.lossLifetimes.has(lifetimeKey(line)) && !isEvidenceLossLine(line)) {
      reasons.add("activity-log-loss");
    }
  }
  if (loss.droppedClasses.has(failureClass)) reasons.add("events-dropped");
  const coverage = COVERAGE_BY_CLASS.get(failureClass);
  if (coverage !== undefined && lifecycleStartMissing(coverage, members)) {
    reasons.add("lifecycle-start-missing");
  }
  const ordered = orderedReasons(reasons);
  return {
    failureClass,
    status: diagnosticSufficiencyStatus(ordered),
    reasons: ordered,
    lineCount: members.length,
  };
}

function linesByClass(
  lines: readonly ActivityLogSufficiencyLine[],
): ReadonlyMap<string, ActivityLogSufficiencyLine[]> {
  const byClass = new Map<string, ActivityLogSufficiencyLine[]>();
  for (const line of lines) {
    for (const failureClass of classesOf(line.op)) {
      const members = byClass.get(failureClass);
      if (members === undefined) byClass.set(failureClass, [line]);
      else members.push(line);
    }
  }
  return byClass;
}

function coverageOf(
  classes: readonly ActivityLogClassSufficiency[],
): ActivityLogSufficiencyCoverage {
  const count = (status: DiagnosticSufficiencyStatus): number =>
    classes.filter((entry) => entry.status === status).length;
  return {
    observedClassCount: classes.length,
    completeClassCount: count("complete"),
    degradedClassCount: count("degraded"),
    insufficientClassCount: count("insufficient"),
  };
}

function summarize(
  classes: readonly ActivityLogClassSufficiency[],
  emptyReason: DiagnosticSufficiencyReason,
): ActivityLogSufficiency {
  const reasons =
    classes.length === 0
      ? [emptyReason]
      : orderedReasons(classes.flatMap((entry) => entry.reasons));
  return {
    status: diagnosticSufficiencyStatus(reasons),
    reasons,
    classes,
    coverage: coverageOf(classes),
  };
}

/**
 * Projects the sufficiency of every failure class `lines` observed, ordered by class name. The
 * report status is the worst class status; an artifact with no registered evidence is insufficient.
 */
export function projectActivityLogSufficiency(
  lines: readonly ActivityLogSufficiencyLine[],
  integrity: ActivityLogSufficiencyIntegrity,
): ActivityLogSufficiency {
  const shared = integrityReasons(integrity);
  const loss = lossAttribution(lines);
  const classes = [...linesByClass(lines)]
    .map(([failureClass, members]) => classSufficiency(failureClass, members, shared, loss))
    .sort((left, right) => (left.failureClass < right.failureClass ? -1 : 1));
  return summarize(classes, "no-registered-evidence");
}

/** The failure classes the registry assigns to `ops`, in first-occurrence order. */
export function activityLogFailureClassesOf(ops: readonly string[]): readonly string[] {
  return [...new Set(ops.flatMap((op) => classesOf(op)))];
}

/**
 * `sufficiency` narrowed to `failureClasses` (a timeline's or an incident's classes), re-summarized.
 * Classes the projection never observed are not invented; narrowing to none is insufficient with
 * `no-registered-failure`, the closed instrumentation-gap reason.
 */
export function restrictActivityLogSufficiency(
  sufficiency: ActivityLogSufficiency,
  failureClasses: readonly string[],
): ActivityLogSufficiency {
  const wanted = new Set(failureClasses);
  return summarize(
    sufficiency.classes.filter((entry) => wanted.has(entry.failureClass)),
    "no-registered-failure",
  );
}
