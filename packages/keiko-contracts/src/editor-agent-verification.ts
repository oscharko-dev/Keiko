// Agent verification access contracts (Issue #2214, Epic #2092, ADR-0126 D4/D5). The producer-side
// request a docked agent sends to the governed verification route, and the redacted, content-free
// result the route returns to the agent as the tool's output. A verification run is agent-triggered
// but non-mutating; it is still classified under the "execution" effect class and gated by the
// Authority Envelope before it may consume the sandboxed execution boundary.
//
// Leaf-package rule (ADR-0019): pure types, guards, and a pure redaction projection only — no
// @oscharko-dev/keiko-* imports. The redacted report is content-free BY CONSTRUCTION: the type has no
// field for raw command output, outputSummary, argv, or file content, so the mapping layer cannot
// re-expose them (the same discipline as EditorAgentActionAuditRecord).

import { EDITOR_AGENT_TARGET_PATH_MAX_BYTES, isContainedAgentPath } from "./editor-agent-path.js";
import {
  EDITOR_AGENT_REFERENCE_ID_MAX_CHARS,
  type EditorAgentGovernedAuthorityReference,
} from "./editor-agent.js";
import {
  EDITOR_AGENT_ACTION_DENY_REASONS,
  EDITOR_AGENT_ACTION_REVIEW_REASONS,
  type EditorAgentActionDenyReason,
  type EditorAgentActionReviewReason,
} from "./editor-agent-governance.js";
import { EDITOR_VERIFICATION_SCHEMA_VERSION, isVerificationKind } from "./editor-verification.js";
import {
  VERIFICATION_FAILURE_MESSAGE_MAX_CHARS,
  VERIFICATION_MAX_FAILURE_LOCATIONS,
  type VerificationFailureLocation,
  type VerificationKind,
  type VerificationReport,
  type VerificationStatus,
} from "./verification.js";

export const EDITOR_AGENT_VERIFICATION_SESSION_ID_MAX_CHARS = 256;
export const EDITOR_AGENT_VERIFICATION_RUN_ID_MAX_CHARS = EDITOR_AGENT_REFERENCE_ID_MAX_CHARS;
export const EDITOR_AGENT_VERIFICATION_ENVELOPE_DIGEST_MAX_CHARS = 64;

const EDITOR_AGENT_VERIFICATION_MAX_STEPS = 5;
const EDITOR_AGENT_VERIFICATION_RULE_ID_MAX_CHARS = 128;
const VERIFICATION_STATUSES: readonly VerificationStatus[] = [
  "passed",
  "failed",
  "skipped",
  "denied",
  "timed-out",
  "cancelled",
  "resource-exceeded",
];

const TEXT_ENCODER = new TextEncoder();

// The tool-host attaches its constructor-validated authorityRef; the route resolves the session's
// workspace root from `sessionId`. Exactly one `kind` per call (targeted-test carries `targetPath`).
export interface EditorAgentVerificationRunRequest {
  readonly schemaVersion: typeof EDITOR_VERIFICATION_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly kind: VerificationKind;
  readonly targetPath?: string | undefined;
  readonly authorityRef: EditorAgentGovernedAuthorityReference;
}

// A redacted, content-free projection of keiko-verification's VerificationReport. Structured failure
// locations (path + optional line/column + bounded message) are the actionable payload; raw
// outputSummary/argv/command never appear because the type cannot hold them.
export interface RedactedVerificationStep {
  readonly kind: VerificationKind;
  readonly status: VerificationStatus;
  readonly durationMs: number;
  readonly locations?: readonly VerificationFailureLocation[] | undefined;
}

export interface RedactedVerificationReport {
  readonly overallStatus: VerificationStatus;
  readonly durationMs: number;
  readonly counts: Readonly<Record<VerificationStatus, number>>;
  readonly steps: readonly RedactedVerificationStep[];
}

export type EditorAgentVerificationDisposition = "denied" | "review-required";

// The route's response, mapped 1:1 into the tool's typed output. `completed` carries the redacted
// report; `not-run` carries the governance disposition that kept the sandboxed run from starting.
export type EditorAgentVerificationResult =
  | { readonly outcome: "completed"; readonly report: RedactedVerificationReport }
  | {
      readonly outcome: "not-run";
      readonly disposition: EditorAgentVerificationDisposition;
      readonly reason: EditorAgentActionDenyReason | EditorAgentActionReviewReason;
    };

// ─── Pure redaction projection (server maps the trusted producer's report through this) ───────────

function projectLocation(location: VerificationFailureLocation): VerificationFailureLocation {
  return {
    file: location.file,
    ...(location.line === undefined ? {} : { line: location.line }),
    ...(location.column === undefined ? {} : { column: location.column }),
    message: location.message,
    ...(location.ruleId === undefined ? {} : { ruleId: location.ruleId }),
  };
}

function redactStep(result: VerificationReport["results"][number]): RedactedVerificationStep {
  return {
    kind: result.kind,
    status: result.status,
    durationMs: result.durationMs,
    ...(result.locations === undefined ? {} : { locations: result.locations.map(projectLocation) }),
  };
}

function projectCounts(
  counts: VerificationReport["counts"],
): Readonly<Record<VerificationStatus, number>> {
  return {
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    denied: counts.denied,
    "timed-out": counts["timed-out"],
    cancelled: counts.cancelled,
    "resource-exceeded": counts["resource-exceeded"],
  };
}

// Map a full VerificationReport (already producer-redacted: `redacted: true`, `outputSummary` a
// digest) into the content-free wire shape. Drops outputSummary/command/args/scriptName/exitCode by
// omission, keeping only the enums, counts, durations, and structured locations an agent needs to act.
export function toRedactedVerificationReport(
  report: VerificationReport,
): RedactedVerificationReport {
  return {
    overallStatus: report.overallStatus,
    durationMs: report.durationMs,
    counts: projectCounts(report.counts),
    steps: report.results.map(redactStep),
  };
}

// ─── Guards + parser (hand-rolled, throw-free, deterministic) ──────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxChars;
}

function isVerificationStatus(value: unknown): value is VerificationStatus {
  return typeof value === "string" && (VERIFICATION_STATUSES as readonly string[]).includes(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isBoundedResultText(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxChars &&
    !value.includes("\u0000")
  );
}

function isBoundedTargetPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    TEXT_ENCODER.encode(value).length <= EDITOR_AGENT_TARGET_PATH_MAX_BYTES &&
    isContainedAgentPath(value)
  );
}

function isAuthorityRef(value: unknown): value is EditorAgentGovernedAuthorityReference {
  return (
    isRecord(value) &&
    isBoundedString(value.runId, EDITOR_AGENT_VERIFICATION_RUN_ID_MAX_CHARS) &&
    typeof value.envelopeDigest === "string" &&
    /^[a-f0-9]{64}$/u.test(value.envelopeDigest)
  );
}

export interface EditorAgentVerificationRunRequestParseOk {
  readonly ok: true;
  readonly value: EditorAgentVerificationRunRequest;
}

export interface EditorAgentVerificationRunRequestParseFail {
  readonly ok: false;
  readonly errors: readonly string[];
}

export type EditorAgentVerificationRunRequestParse =
  EditorAgentVerificationRunRequestParseOk | EditorAgentVerificationRunRequestParseFail;

function requestFieldErrors(input: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (input.schemaVersion !== EDITOR_VERIFICATION_SCHEMA_VERSION) {
    errors.push(`schemaVersion must equal "${EDITOR_VERIFICATION_SCHEMA_VERSION}"`);
  }
  if (!isBoundedString(input.sessionId, EDITOR_AGENT_VERIFICATION_SESSION_ID_MAX_CHARS)) {
    errors.push("sessionId must be a bounded, non-empty string");
  }
  if (!isVerificationKind(input.kind)) {
    errors.push("kind must be one of the supported verification kinds");
  }
  if (!isAuthorityRef(input.authorityRef)) {
    errors.push("authorityRef must carry a bounded runId and envelopeDigest");
  }
  return errors;
}

function targetFieldErrors(input: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (input.targetPath !== undefined && !isBoundedTargetPath(input.targetPath)) {
    errors.push("targetPath must be a bounded, workspace-contained path when present");
  }
  if (!isVerificationKind(input.kind)) return errors;
  if (input.kind === "targeted-test" && input.targetPath === undefined) {
    errors.push("targetPath is required for targeted-test");
  }
  if (input.kind !== "targeted-test" && input.targetPath !== undefined) {
    errors.push("targetPath is forbidden for non-targeted verification kinds");
  }
  return errors;
}

// Parse a request at the route trust boundary. Collects all field errors in a fixed order
// (deterministic strings for tests); never throws. Mirrors parseEditorVerificationRunRequest.
export function parseEditorAgentVerificationRunRequest(
  input: unknown,
): EditorAgentVerificationRunRequestParse {
  if (!isRecord(input)) {
    return { ok: false, errors: ["request must be an object"] };
  }
  const errors = [...requestFieldErrors(input), ...targetFieldErrors(input)];
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: canonicalRequest(input) };
}

function canonicalRequest(input: Record<string, unknown>): EditorAgentVerificationRunRequest {
  const authorityRef = input.authorityRef as Record<string, unknown>;
  return {
    schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
    sessionId: input.sessionId as string,
    kind: input.kind as VerificationKind,
    ...(typeof input.targetPath === "string" ? { targetPath: input.targetPath } : {}),
    authorityRef: {
      runId: authorityRef.runId as string,
      envelopeDigest: authorityRef.envelopeDigest as string,
    },
  };
}

function hasValidLocationCoordinates(
  value: Readonly<Record<string, unknown>>,
): value is Readonly<Record<string, unknown>> & { line?: number; column?: number } {
  if (value.line !== undefined && !isPositiveSafeInteger(value.line)) return false;
  return (
    value.column === undefined || (value.line !== undefined && isPositiveSafeInteger(value.column))
  );
}

function hasValidLocationText(
  value: Readonly<Record<string, unknown>>,
): value is Readonly<Record<string, unknown>> & { message: string; ruleId?: string } {
  if (!isBoundedResultText(value.message, VERIFICATION_FAILURE_MESSAGE_MAX_CHARS)) return false;
  return (
    value.ruleId === undefined ||
    isBoundedResultText(value.ruleId, EDITOR_AGENT_VERIFICATION_RULE_ID_MAX_CHARS)
  );
}

function parseLocation(value: unknown): VerificationFailureLocation | null {
  if (!isRecord(value) || !isBoundedTargetPath(value.file)) return null;
  if (!hasValidLocationCoordinates(value) || !hasValidLocationText(value)) return null;
  const line = value.line as number | undefined;
  const column = value.column as number | undefined;
  const message = value.message;
  const ruleId = value.ruleId;
  return {
    file: value.file,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
    message,
    ...(ruleId === undefined ? {} : { ruleId }),
  };
}

function parseLocations(value: unknown): readonly VerificationFailureLocation[] | null {
  if (!Array.isArray(value) || value.length > VERIFICATION_MAX_FAILURE_LOCATIONS) return null;
  const projected: VerificationFailureLocation[] = [];
  for (const candidate of value) {
    const location = parseLocation(candidate);
    if (location === null) return null;
    projected.push(location);
  }
  return projected;
}

function parseStep(value: unknown): RedactedVerificationStep | null {
  if (
    !isRecord(value) ||
    !isVerificationKind(value.kind) ||
    !isVerificationStatus(value.status) ||
    !isFiniteNonNegative(value.durationMs)
  ) {
    return null;
  }
  const locations = value.locations === undefined ? undefined : parseLocations(value.locations);
  if (locations === null) return null;
  return {
    kind: value.kind,
    status: value.status,
    durationMs: value.durationMs,
    ...(locations === undefined ? {} : { locations }),
  };
}

function parseCounts(
  value: unknown,
  steps: readonly RedactedVerificationStep[],
): Readonly<Record<VerificationStatus, number>> | null {
  if (!isRecord(value)) return null;
  for (const status of VERIFICATION_STATUSES) {
    const count = value[status];
    if (!isSafeNonNegativeInteger(count) || count > EDITOR_AGENT_VERIFICATION_MAX_STEPS)
      return null;
    if (count !== steps.filter((step) => step.status === status).length) return null;
  }
  return projectCounts(value as unknown as VerificationReport["counts"]);
}

function matchesOverallStatus(
  overallStatus: VerificationStatus,
  steps: readonly RedactedVerificationStep[],
): boolean {
  if (overallStatus === "cancelled") return true;
  if (steps.some((step) => step.status === "cancelled")) return false;
  const expected = steps.every((step) => step.status === "passed" || step.status === "skipped")
    ? "passed"
    : "failed";
  return overallStatus === expected;
}

function isReportEnvelope(value: unknown): value is Record<string, unknown> & {
  overallStatus: VerificationStatus;
  durationMs: number;
  steps: unknown[];
} {
  if (!isRecord(value)) return false;
  if (!isVerificationStatus(value.overallStatus) || !isFiniteNonNegative(value.durationMs)) {
    return false;
  }
  return (
    Array.isArray(value.steps) &&
    value.steps.length > 0 &&
    value.steps.length <= EDITOR_AGENT_VERIFICATION_MAX_STEPS
  );
}

function parseReport(value: unknown): RedactedVerificationReport | null {
  if (!isReportEnvelope(value)) return null;
  const steps: RedactedVerificationStep[] = [];
  for (const candidate of value.steps) {
    const step = parseStep(candidate);
    if (step === null) return null;
    steps.push(step);
  }
  const counts = parseCounts(value.counts, steps);
  if (counts === null || !matchesOverallStatus(value.overallStatus, steps)) return null;
  return { overallStatus: value.overallStatus, durationMs: value.durationMs, counts, steps };
}

function parseNotRun(value: Record<string, unknown>): EditorAgentVerificationResult | null {
  if (
    value.disposition === "denied" &&
    typeof value.reason === "string" &&
    (EDITOR_AGENT_ACTION_DENY_REASONS as readonly string[]).includes(value.reason)
  ) {
    return {
      outcome: "not-run",
      disposition: "denied",
      reason: value.reason as EditorAgentActionDenyReason,
    };
  }
  if (
    value.disposition === "review-required" &&
    typeof value.reason === "string" &&
    (EDITOR_AGENT_ACTION_REVIEW_REASONS as readonly string[]).includes(value.reason)
  ) {
    return {
      outcome: "not-run",
      disposition: "review-required",
      reason: value.reason as EditorAgentActionReviewReason,
    };
  }
  return null;
}

export function parseEditorAgentVerificationResult(
  value: unknown,
): EditorAgentVerificationResult | null {
  if (!isRecord(value)) return null;
  if (value.outcome === "completed") {
    const report = parseReport(value.report);
    return report === null ? null : { outcome: "completed", report };
  }
  return value.outcome === "not-run" ? parseNotRun(value) : null;
}

// Structural guard the client uses to reject a malformed route response at its trust boundary.
export function isEditorAgentVerificationResult(
  value: unknown,
): value is EditorAgentVerificationResult {
  return parseEditorAgentVerificationResult(value) !== null;
}
