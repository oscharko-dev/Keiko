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
import type { EditorAgentGovernedAuthorityReference } from "./editor-agent.js";
import { EDITOR_VERIFICATION_SCHEMA_VERSION, isVerificationKind } from "./editor-verification.js";
import type {
  VerificationFailureLocation,
  VerificationKind,
  VerificationReport,
  VerificationStatus,
} from "./verification.js";

export const EDITOR_AGENT_VERIFICATION_SESSION_ID_MAX_CHARS = 256;
export const EDITOR_AGENT_VERIFICATION_RUN_ID_MAX_CHARS = 256;
export const EDITOR_AGENT_VERIFICATION_ENVELOPE_DIGEST_MAX_CHARS = 256;

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
      readonly reason: string;
    };

// ─── Pure redaction projection (server maps the trusted producer's report through this) ───────────

function redactStep(result: VerificationReport["results"][number]): RedactedVerificationStep {
  return {
    kind: result.kind,
    status: result.status,
    durationMs: result.durationMs,
    ...(result.locations === undefined ? {} : { locations: result.locations }),
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
    counts: report.counts,
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
    isBoundedString(value.envelopeDigest, EDITOR_AGENT_VERIFICATION_ENVELOPE_DIGEST_MAX_CHARS)
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

// Parse a request at the route trust boundary. Collects all field errors in a fixed order
// (deterministic strings for tests); never throws. Mirrors parseEditorVerificationRunRequest.
export function parseEditorAgentVerificationRunRequest(
  input: unknown,
): EditorAgentVerificationRunRequestParse {
  if (!isRecord(input)) {
    return { ok: false, errors: ["request must be an object"] };
  }
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
  if (input.targetPath !== undefined && !isBoundedTargetPath(input.targetPath)) {
    errors.push("targetPath must be a bounded, workspace-contained path when present");
  }
  if (!isAuthorityRef(input.authorityRef)) {
    errors.push("authorityRef must carry a bounded runId and envelopeDigest");
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: canonicalRequest(input) };
}

function canonicalRequest(input: Record<string, unknown>): EditorAgentVerificationRunRequest {
  return {
    schemaVersion: EDITOR_VERIFICATION_SCHEMA_VERSION,
    sessionId: input.sessionId as string,
    kind: input.kind as VerificationKind,
    ...(typeof input.targetPath === "string" ? { targetPath: input.targetPath } : {}),
    authorityRef: input.authorityRef as EditorAgentGovernedAuthorityReference,
  };
}

function isRedactedStep(value: unknown): value is RedactedVerificationStep {
  return (
    isRecord(value) &&
    isVerificationKind(value.kind) &&
    typeof value.status === "string" &&
    typeof value.durationMs === "number"
  );
}

function isRedactedReport(value: unknown): value is RedactedVerificationReport {
  return (
    isRecord(value) &&
    typeof value.overallStatus === "string" &&
    typeof value.durationMs === "number" &&
    isRecord(value.counts) &&
    Array.isArray(value.steps) &&
    value.steps.every(isRedactedStep)
  );
}

// Structural guard the client uses to reject a malformed route response at its trust boundary.
export function isEditorAgentVerificationResult(
  value: unknown,
): value is EditorAgentVerificationResult {
  if (!isRecord(value)) return false;
  if (value.outcome === "completed") return isRedactedReport(value.report);
  if (value.outcome === "not-run") {
    return (
      (value.disposition === "denied" || value.disposition === "review-required") &&
      typeof value.reason === "string" &&
      value.reason.length > 0
    );
  }
  return false;
}
