// All verification-layer interfaces and the frozen default limits. No runtime logic lives here
// beyond the frozen constant tables the type layer exposes as values, mirroring the
// ADR-0003/0004/0005/0006 `types.ts` precedent. `readonly` everywhere; optional props are
// `| undefined` because exactOptionalPropertyTypes is on. Every shape is plain JSON-serializable
// so the #10 audit ledger can persist a VerificationReport without ad-hoc parsing.

import type { NetworkPolicy } from "./tools.js";

// ─── Verification kinds & status ─────────────────────────────────────────────────

export type VerificationKind = "test" | "targeted-test" | "typecheck" | "lint" | "build";

// The outcome taxonomy classifyOutcome maps every run path to (ADR-0007 D1). `denied`,
// `timed-out`, `cancelled`, and `resource-exceeded` distinguish the failure cause so the audit
// ledger and CLI can report WHY a step did not pass, not merely that it failed.
export type VerificationStatus =
  "passed" | "failed" | "skipped" | "denied" | "timed-out" | "cancelled" | "resource-exceeded";

// ─── Resource limits (the four documented dimensions) ────────────────────────────

export type ResourceDimension = "wall-time" | "output-size" | "memory" | "network";

// One row per dimension in VerificationResult.appliedLimits. `enforced` is HONEST: it is false
// for dimensions Wave 1 documents but does not OS-enforce (network always; memory off Linux or
// without a ceiling). `breached` is set only on the dimension that actually fired for this step.
export interface ResourceLimitDecision {
  readonly dimension: ResourceDimension;
  // The numeric ceiling for time/output/memory; for network the policy string ("none"/"inherit").
  readonly limit: number | string;
  readonly enforced: boolean;
  readonly note?: string | undefined;
  readonly breached?: boolean | undefined;
}

export interface VerificationResourceLimits {
  readonly wallTimeMs: number;
  readonly maxOutputBytes: number;
  // undefined => no memory ceiling requested; the monitor returns a documented no-op.
  readonly maxMemoryBytes: number | undefined;
  readonly network: NetworkPolicy;
}

// Wave-1 defaults. maxMemoryBytes is undefined by default: memory enforcement is opt-in and
// Linux-only (ADR-0007 D2/D3). network defaults to the no-network posture, documented-not-enforced.
export const DEFAULT_VERIFICATION_LIMITS: VerificationResourceLimits = {
  wallTimeMs: 120_000,
  maxOutputBytes: 1_048_576,
  maxMemoryBytes: undefined,
  network: "none",
} as const;

// ─── Dependency bootstrap (ADR-0043 D17) ───────────────────────────────────────────
// A plan's package scripts run against the workspace's installed dependencies, and a managed task
// worktree is a clean checkout without them (Coding Workbench run 15, 2026-09-10: every build step
// failed within 200 ms on a missing binary, and the model had no governed way to install anything).
// The orchestrator installs the manifest's declared dependencies before the first script step when
// the installed tree is not current. The install runs the trusted host `npm` with lifecycle scripts
// disabled — it executes no package or project code — so it is the one verification command that
// keeps host network; the code it fetches runs only inside the sandboxed steps that follow.
export const DEPENDENCY_INSTALL_LIMITS: VerificationResourceLimits = {
  wallTimeMs: 240_000,
  maxOutputBytes: 1_048_576,
  maxMemoryBytes: undefined,
  network: "inherit",
} as const;

export type VerificationDependencyState =
  "none" | "current" | "installed" | "refused" | "failed" | "timed-out" | "cancelled";

export type VerificationLockfileState = "present" | "created" | "absent";

// The bootstrap outcomes after which no script step can be trusted to run; the report is "failed".
export const VERIFICATION_DEPENDENCY_FAILURE_STATES: ReadonlySet<VerificationDependencyState> =
  new Set<VerificationDependencyState>(["refused", "failed", "timed-out"]);

/** The dependency install's network use: counts only, never a destination or a byte. */
export interface VerificationDependencyEgress {
  // Tunnels opened to the approved registry.
  readonly allowed: number;
  // Requests refused for naming any other destination.
  readonly refused: number;
}

/** Body-free record of the dependency bootstrap on a report: never output, never a path. */
export interface VerificationDependencySummary {
  readonly state: VerificationDependencyState;
  readonly lockfile: VerificationLockfileState;
  readonly exitCode: number | null;
  readonly durationMs: number;
  // A short, redacted reason for a refused or failed bootstrap (e.g. "project npm config present").
  readonly detail?: string | undefined;
  // The install's egress through the registry proxy (ADR-0043 D17): present whenever the proxy was
  // started for the install, with zero counts when npm made no request through it (an install that
  // ended before npm spawned); absent when no proxy was started (CodeRabbit review, PR #3452).
  readonly egress?: VerificationDependencyEgress | undefined;
}

// ─── The governed verification tool's settlement budget ────────────────────────────
// Derived from the orchestrator's own enforced limits, never chosen. One governed call names exactly
// one verifier (`keiko_verification` takes one `verifierId`; the coding facade asks the runner for that
// one kind), so it may install dependencies and then run that one step, each up to its own wall-time
// ceiling. The tool catalog settles the verification tool at this budget (`keiko.verification.run`),
// the sidecar tool bridge and the generated plugin client both outlive it by their own grace, so a
// real build or test run reports its result instead of an opaque timeout (Coding Workbench runs
// 13–15).
export const VERIFICATION_TOOL_STEPS_PER_CALL = 1;
export const VERIFICATION_SETTLEMENT_GRACE_MS = 15_000;
export const VERIFICATION_TOOL_MAX_DURATION_MS =
  DEPENDENCY_INSTALL_LIMITS.wallTimeMs +
  VERIFICATION_TOOL_STEPS_PER_CALL * DEFAULT_VERIFICATION_LIMITS.wallTimeMs +
  VERIFICATION_SETTLEMENT_GRACE_MS;

// ─── The governed verification tool's wait for a human decision ────────────────────
// How long the governed verification tool may wait in place for a decision only a local human can
// make (an ADR-0147 package-script trust grant) before it hands the model the truthful refusal
// instead. It lives in the contract because two layers must agree on it: the server-side tool that
// waits, and the tool-catalog budget the verification tool is eventually settled at.
//
// It must stay strictly below every ceiling a governed verification call is settled at, or the
// caller receives an opaque `timeout`/`cancelled` instead of the tool's own closed refusal — the
// one string that tells the model what a person has to do. The binding ceiling is the
// governed-invocation registry's 30 s TTL (the catalog budget above is far larger); the server pins
// this constant against it.
export const VERIFICATION_TOOL_OPERATOR_DECISION_GRACE_MS = 25_000;

// ─── Structured failure locations (Issue #2210, ADR-0126 D3) ─────────────────────
// Bounds a later, best-effort parser (Issue #2211) may attach to VerificationResult.locations.
// The parser reads the already-redacted, byte-capped CommandResult output and clamps to these caps
// before attaching; the contract layer only defines the shape and its limits, never the parsing.
export const VERIFICATION_MAX_FAILURE_LOCATIONS = 50;
export const VERIFICATION_FAILURE_MESSAGE_MAX_CHARS = 512;

// ─── Plan ─────────────────────────────────────────────────────────────────────────

export interface VerificationStep {
  readonly kind: VerificationKind;
  // The npm script name backing this step, or undefined for a synthesised invocation
  // (targeted tests) or a skipped step.
  readonly scriptName: string | undefined;
  readonly command: string;
  readonly args: readonly string[];
  readonly limits: VerificationResourceLimits;
  // Present iff the step is pre-marked skip (no detected script for the kind, ADR-0007 D4).
  readonly skipReason?: string | undefined;
}

export interface VerificationPlan {
  readonly workspaceRoot: string;
  readonly steps: readonly VerificationStep[];
}

// ─── Result & report ───────────────────────────────────────────────────────────────

// A structured, bounded failure location extracted from a verification step's output (ADR-0126 D3).
// `file` is workspace-relative; `line`/`column` are 1-based when the underlying tool provides them.
// `ruleId` carries a lint rule or diagnostic code (e.g. "TS2345", "no-unused-vars") when available.
// `message` is a length-capped (VERIFICATION_FAILURE_MESSAGE_MAX_CHARS) excerpt of the diagnostic —
// command-derived text that reaches the UI/summary projection but NEVER the audit ledger.
export interface VerificationFailureLocation {
  readonly file: string;
  readonly line?: number | undefined;
  readonly column?: number | undefined;
  readonly message: string;
  readonly ruleId?: string | undefined;
}

export interface VerificationResult {
  readonly kind: VerificationKind;
  readonly scriptName: string | undefined;
  readonly command: string;
  readonly args: readonly string[];
  readonly status: VerificationStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly truncated: boolean;
  // Always true for a result carrying outputSummary: the digest is run through redact().
  readonly redacted: boolean;
  // Redacted, byte-capped digest of stdout+stderr. Empty for skipped/denied steps (no output).
  readonly outputSummary: string;
  readonly appliedLimits: readonly ResourceLimitDecision[];
  // A short, redacted human explanation (e.g. "no script", "denied: ...", "memory ceiling").
  readonly detail?: string | undefined;
  // Additive (Issue #2210, ADR-0126 D3): structured failure locations populated best-effort by the
  // Issue #2211 parser. Absent on existing consumers and for kinds/formats it cannot parse.
  readonly locations?: readonly VerificationFailureLocation[] | undefined;
}

export interface VerificationReport {
  readonly workspaceRoot: string;
  readonly results: readonly VerificationResult[];
  readonly overallStatus: VerificationStatus;
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly counts: Readonly<Record<VerificationStatus, number>>;
  // Present when the orchestrator decided about the workspace's dependencies before the steps
  // (ADR-0043 D17); absent for plans that ran no script step or for callers that left it off.
  readonly dependencies?: VerificationDependencySummary | undefined;
}

// ─── Deep wire guards ─────────────────────────────────────────────────────────────
// These guards are the canonical trust-boundary validation used by the editor SSE contract. They
// deliberately validate the complete nested report/result shape: a shallow terminal-event check
// would let hostile enums, unbounded arrays/text, unredacted results, or absolute failure paths cross
// the browser boundary under an otherwise plausible VerificationReport envelope.

const VERIFICATION_KINDS: readonly VerificationKind[] = [
  "test",
  "targeted-test",
  "typecheck",
  "lint",
  "build",
];
const VERIFICATION_KIND_SET: ReadonlySet<string> = new Set(VERIFICATION_KINDS);
const VERIFICATION_STATUSES: readonly VerificationStatus[] = [
  "passed",
  "failed",
  "skipped",
  "denied",
  "timed-out",
  "cancelled",
  "resource-exceeded",
];
const RESOURCE_DIMENSIONS: readonly ResourceDimension[] = [
  "wall-time",
  "output-size",
  "memory",
  "network",
];
const RESOURCE_DIMENSION_SET: ReadonlySet<string> = new Set(RESOURCE_DIMENSIONS);
const VERIFICATION_MAX_REPORT_RESULTS = VERIFICATION_KINDS.length;
const VERIFICATION_MAX_ARGS = 64;
const VERIFICATION_PATH_MAX_BYTES = 4_096;
const VERIFICATION_COMMAND_MAX_CHARS = 256;
const VERIFICATION_ARGUMENT_MAX_CHARS = 4_096;
const VERIFICATION_OUTPUT_SUMMARY_MAX_CHARS = 1_024;
export const VERIFICATION_DETAIL_MAX_CHARS = 1_024;
// The longest redacted output tail handed to the caller that repairs a failed step or install (the
// coding model behind the governed verification tool, ADR-0126 D3). keiko-verification cuts the tail
// to this many characters behind one ellipsis, and the coding facade admits exactly that shape, so the
// bound is the contract between the two rather than either side's own number.
export const VERIFICATION_OUTPUT_EXCERPT_MAX_CHARS = 4096;
const VERIFICATION_NOTE_MAX_CHARS = 1_024;
const VERIFICATION_RULE_ID_MAX_CHARS = 128;
const VERIFICATION_SIGNAL_MAX_CHARS = 128;
const VERIFICATION_COORDINATE_MAX = 2_147_483_647;
const VERIFICATION_TEXT_ENCODER = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isBoundedText(value: unknown, maxChars: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxChars &&
    (allowEmpty || value.length > 0) &&
    !value.includes("\u0000")
  );
}

function isBoundedWorkspacePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\u0000") &&
    VERIFICATION_TEXT_ENCODER.encode(value).length <= VERIFICATION_PATH_MAX_BYTES
  );
}

function isDenseArray<T>(
  value: unknown,
  maxLength: number,
  guard: (entry: unknown) => entry is T,
): value is readonly T[] {
  if (
    !Array.isArray(value) ||
    value.length > maxLength ||
    Object.keys(value).length !== value.length
  ) {
    return false;
  }
  return value.every(guard);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isIntegerWithin(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function isVerificationKindValue(value: unknown): value is VerificationKind {
  return typeof value === "string" && VERIFICATION_KIND_SET.has(value);
}

function isVerificationStatusValue(value: unknown): value is VerificationStatus {
  return typeof value === "string" && VERIFICATION_STATUSES.includes(value as VerificationStatus);
}

function isResourceDimension(value: unknown): value is ResourceDimension {
  return typeof value === "string" && RESOURCE_DIMENSION_SET.has(value);
}

function isCanonicalRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\\") || value.startsWith("/")) return false;
  if (VERIFICATION_TEXT_ENCODER.encode(value).length > VERIFICATION_PATH_MAX_BYTES) return false;
  const parts = value.split("/");
  return (
    parts.length > 0 &&
    parts.every((part) => part.length > 0 && part !== "." && part !== "..") &&
    !/^[A-Za-z]:/u.test(value) &&
    !value.includes("\u0000")
  );
}

function isOptionalCoordinate(value: unknown): boolean {
  return value === undefined || isIntegerWithin(value, 1, VERIFICATION_COORDINATE_MAX);
}

function hasValidLocationCoordinates(value: Readonly<Record<string, unknown>>): boolean {
  if (!isOptionalCoordinate(value.line) || !isOptionalCoordinate(value.column)) return false;
  return value.column === undefined || value.line !== undefined;
}

function hasValidLocationText(value: Readonly<Record<string, unknown>>): boolean {
  if (!isBoundedText(value.message, VERIFICATION_FAILURE_MESSAGE_MAX_CHARS, true)) return false;
  return value.ruleId === undefined || isBoundedText(value.ruleId, VERIFICATION_RULE_ID_MAX_CHARS);
}

export function isVerificationFailureLocation(
  value: unknown,
): value is VerificationFailureLocation {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, ["file", "line", "column", "message", "ruleId"]) &&
    isCanonicalRelativePath(value.file) &&
    hasValidLocationCoordinates(value) &&
    hasValidLocationText(value)
  );
}

function limitMatchesDimension(value: Readonly<Record<string, unknown>>): boolean {
  if (value.dimension === "network") return value.limit === "none" || value.limit === "inherit";
  return isFiniteNonNegative(value.limit);
}

function hasValidResourceOptionals(value: Readonly<Record<string, unknown>>): boolean {
  if (value.note !== undefined && !isBoundedText(value.note, VERIFICATION_NOTE_MAX_CHARS)) {
    return false;
  }
  return value.breached === undefined || typeof value.breached === "boolean";
}

function isResourceLimit(value: unknown): value is ResourceLimitDecision {
  if (!isRecord(value) || !isResourceDimension(value.dimension)) return false;
  return (
    hasOnlyKeys(value, ["dimension", "limit", "enforced", "note", "breached"]) &&
    limitMatchesDimension(value) &&
    typeof value.enforced === "boolean" &&
    hasValidResourceOptionals(value)
  );
}

function isCompleteAppliedLimits(value: unknown): value is readonly ResourceLimitDecision[] {
  if (!isDenseArray(value, RESOURCE_DIMENSIONS.length, isResourceLimit)) return false;
  const dimensions = new Set(value.map((entry) => entry.dimension));
  const breached = value.filter((entry) => entry.breached === true).length;
  return dimensions.size === RESOURCE_DIMENSIONS.length && breached <= 1;
}

function isStringArgument(value: unknown): value is string {
  return isBoundedText(value, VERIFICATION_ARGUMENT_MAX_CHARS, true);
}

function isFailureLocations(value: unknown): value is readonly VerificationFailureLocation[] {
  return isDenseArray(value, VERIFICATION_MAX_FAILURE_LOCATIONS, isVerificationFailureLocation);
}

function hasValidResultIdentity(value: Readonly<Record<string, unknown>>): boolean {
  if (!isVerificationKindValue(value.kind) || !isVerificationStatusValue(value.status))
    return false;
  if (
    value.scriptName !== undefined &&
    !isBoundedText(value.scriptName, VERIFICATION_COMMAND_MAX_CHARS)
  ) {
    return false;
  }
  return (
    isBoundedText(value.command, VERIFICATION_COMMAND_MAX_CHARS) &&
    isDenseArray(value.args, VERIFICATION_MAX_ARGS, isStringArgument)
  );
}

function hasValidResultExecution(value: Readonly<Record<string, unknown>>): boolean {
  if (value.exitCode !== null && !isIntegerWithin(value.exitCode, 0, 255)) return false;
  if (value.signal !== null && !isBoundedText(value.signal, VERIFICATION_SIGNAL_MAX_CHARS)) {
    return false;
  }
  return isFiniteNonNegative(value.durationMs) && typeof value.truncated === "boolean";
}

function hasValidResultEvidence(value: Readonly<Record<string, unknown>>): boolean {
  if (value.redacted !== true) return false;
  if (!isBoundedText(value.outputSummary, VERIFICATION_OUTPUT_SUMMARY_MAX_CHARS, true))
    return false;
  if (!isCompleteAppliedLimits(value.appliedLimits)) return false;
  if (value.detail !== undefined && !isBoundedText(value.detail, VERIFICATION_DETAIL_MAX_CHARS)) {
    return false;
  }
  return value.locations === undefined || isFailureLocations(value.locations);
}

export function isVerificationResult(value: unknown): value is VerificationResult {
  if (!isRecord(value)) return false;
  return (
    hasOnlyKeys(value, [
      "kind",
      "scriptName",
      "command",
      "args",
      "status",
      "exitCode",
      "signal",
      "durationMs",
      "truncated",
      "redacted",
      "outputSummary",
      "appliedLimits",
      "detail",
      "locations",
    ]) &&
    hasValidResultIdentity(value) &&
    hasValidResultExecution(value) &&
    hasValidResultEvidence(value)
  );
}

// Shared across the package (KEIKO-0159): counts a bounded `{ status }[]` collection by one status
// and compares against a caller-supplied count. Both isStatusCounts here and
// editor-agent-verification.ts's parseCounts enforce "count equals the number of items at this
// status" over VERIFICATION_STATUSES; each call site keeps its own, differently-shaped bound check
// (VERIFICATION_MAX_REPORT_RESULTS vs EDITOR_AGENT_VERIFICATION_MAX_STEPS) since those bounds are not
// the same invariant, but the equality rule itself is now defined exactly once.
export function countMatchesStatus(
  count: number,
  status: VerificationStatus,
  items: readonly { readonly status: VerificationStatus }[],
): boolean {
  return count === items.filter((item) => item.status === status).length;
}

function isStatusCounts(
  value: unknown,
  results: readonly VerificationResult[],
): value is Readonly<Record<VerificationStatus, number>> {
  if (!isRecord(value) || !hasOnlyKeys(value, VERIFICATION_STATUSES)) return false;
  for (const status of VERIFICATION_STATUSES) {
    const count = value[status];
    if (!isIntegerWithin(count, 0, VERIFICATION_MAX_REPORT_RESULTS)) return false;
    if (!countMatchesStatus(count, status, results)) return false;
  }
  return true;
}

// Shared across the package (KEIKO-0159): editor-agent-verification.ts re-exports no local copy of
// this rule and imports it directly instead, so a change to what counts as a passing verification
// report cannot drift between the canonical contract and the agent-facing guard. The parameter is
// deliberately the minimal projected shape (not VerificationResult) so it also accepts
// RedactedVerificationStep, the agent-facing surface's own step shape, without coupling the two
// report types together.
export function matchesOverallStatus(
  overallStatus: VerificationStatus,
  items: readonly { readonly status: VerificationStatus }[],
  dependencies?: VerificationDependencySummary,
): boolean {
  if (overallStatus === "cancelled") return true;
  if (items.some((item) => item.status === "cancelled")) {
    return false;
  }
  // A bootstrap that left the steps without their dependencies fails the report whatever the steps
  // (all skipped) would otherwise say (ADR-0043 D17).
  if (
    dependencies !== undefined &&
    VERIFICATION_DEPENDENCY_FAILURE_STATES.has(dependencies.state)
  ) {
    return overallStatus === "failed";
  }
  const allOk = items.every((item) => item.status === "passed" || item.status === "skipped");
  return overallStatus === (allOk ? "passed" : "failed");
}

const VERIFICATION_DEPENDENCY_STATES: readonly VerificationDependencyState[] = [
  "none",
  "current",
  "installed",
  "refused",
  "failed",
  "timed-out",
  "cancelled",
];
const VERIFICATION_DEPENDENCY_STATE_SET: ReadonlySet<string> = new Set(
  VERIFICATION_DEPENDENCY_STATES,
);
const VERIFICATION_LOCKFILE_STATE_SET: ReadonlySet<string> = new Set<VerificationLockfileState>([
  "present",
  "created",
  "absent",
]);

function hasDependencySummaryStates(value: Readonly<Record<string, unknown>>): boolean {
  return (
    typeof value.state === "string" &&
    VERIFICATION_DEPENDENCY_STATE_SET.has(value.state) &&
    typeof value.lockfile === "string" &&
    VERIFICATION_LOCKFILE_STATE_SET.has(value.lockfile)
  );
}

function hasDependencySummaryExecution(value: Readonly<Record<string, unknown>>): boolean {
  if (value.exitCode !== null && !isIntegerWithin(value.exitCode, 0, 255)) return false;
  if (!isFiniteNonNegative(value.durationMs)) return false;
  return value.detail === undefined || isBoundedText(value.detail, VERIFICATION_DETAIL_MAX_CHARS);
}

function isVerificationDependencyEgress(value: unknown): value is VerificationDependencyEgress {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["allowed", "refused"]) &&
    isIntegerWithin(value.allowed, 0, Number.MAX_SAFE_INTEGER) &&
    isIntegerWithin(value.refused, 0, Number.MAX_SAFE_INTEGER)
  );
}

export function isVerificationDependencySummary(
  value: unknown,
): value is VerificationDependencySummary {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["state", "lockfile", "exitCode", "durationMs", "detail", "egress"]) &&
    hasDependencySummaryStates(value) &&
    hasDependencySummaryExecution(value) &&
    (value.egress === undefined || isVerificationDependencyEgress(value.egress))
  );
}

// An absent summary is valid (a report without a bootstrap); a present one must be well formed.
function reportDependenciesOf(
  value: Readonly<Record<string, unknown>>,
): VerificationDependencySummary | undefined | false {
  if (value.dependencies === undefined) return undefined;
  return isVerificationDependencySummary(value.dependencies) ? value.dependencies : false;
}

export function isVerificationReport(value: unknown): value is VerificationReport {
  if (!isRecord(value)) return false;
  if (!isDenseArray(value.results, VERIFICATION_MAX_REPORT_RESULTS, isVerificationResult)) {
    return false;
  }
  const dependencies = reportDependenciesOf(value);
  return (
    hasOnlyKeys(value, [
      "workspaceRoot",
      "results",
      "overallStatus",
      "startedAtMs",
      "durationMs",
      "counts",
      "dependencies",
    ]) &&
    dependencies !== false &&
    isBoundedWorkspacePath(value.workspaceRoot) &&
    isVerificationStatusValue(value.overallStatus) &&
    matchesOverallStatus(value.overallStatus, value.results, dependencies) &&
    isFiniteNonNegative(value.startedAtMs) &&
    isFiniteNonNegative(value.durationMs) &&
    isStatusCounts(value.counts, value.results)
  );
}

// ─── Detection ──────────────────────────────────────────────────────────────────────

// The npm scripts detected in package.json, plus the kind→scriptName mapping the plan consumes.
export interface ScriptCatalog {
  readonly scripts: Readonly<Record<string, string>>;
  readonly mapping: ScriptMapping;
}

export interface ScriptMapping {
  readonly test: string | undefined;
  readonly typecheck: string | undefined;
  readonly lint: string | undefined;
  readonly build: string | undefined;
}
