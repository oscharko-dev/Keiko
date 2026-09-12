// Issue #2211 — typed failure modes for the editor verification runner. Mirrors
// command-runner-errors.ts's CodedHttpError pattern exactly: callers switch on `code`; messages are
// static strings that never leak filesystem paths or raw Node/OS error text into the HTTP response or
// SSE event payload.
//
// PRE-run governance failures surface as a thrown VerificationRunnerError (the route maps them to a
// 4xx/5xx envelope). Actual RUN outcomes stream over SSE as content-free lifecycle events; the
// terminal event carries the redacted VerificationReport.

import { CodedHttpError, httpStatusFor } from "@oscharko-dev/keiko-contracts/runtime/http-error";

export const VERIFICATION_RUNNER_ERROR_CODES = {
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  WORKSPACE_TRUST_REQUIRED: "WORKSPACE_TRUST_REQUIRED",
  NO_RUNNABLE_STEPS: "NO_RUNNABLE_STEPS",
  RUN_LIMIT_EXCEEDED: "RUN_LIMIT_EXCEEDED",
  RUN_NOT_FOUND: "RUN_NOT_FOUND",
  BAD_REQUEST: "BAD_REQUEST",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  VERIFICATION_RUNNER_UNAVAILABLE: "VERIFICATION_RUNNER_UNAVAILABLE",
  // Issue #2211 fix-up (Epic #2092): the audit-evidence trail could not be written. Mirrors
  // command-runner-errors.ts's EVIDENCE_WRITE_FAILED — a governed execution surface must not run
  // silently unaudited.
  EVIDENCE_WRITE_FAILED: "EVIDENCE_WRITE_FAILED",
  INTERNAL: "INTERNAL",
} as const;

export type VerificationRunnerErrorCode =
  (typeof VERIFICATION_RUNNER_ERROR_CODES)[keyof typeof VERIFICATION_RUNNER_ERROR_CODES];

const STATUS_MAP: Readonly<Record<VerificationRunnerErrorCode, number>> = {
  PROJECT_NOT_FOUND: 404,
  // Script-backed kinds (test | typecheck | lint | build) run arbitrary package.json scripts and
  // require the same server-owned workspace-trust decision the command runner applies (403).
  WORKSPACE_TRUST_REQUIRED: 403,
  NO_RUNNABLE_STEPS: 422,
  RUN_LIMIT_EXCEEDED: 429,
  RUN_NOT_FOUND: 404,
  BAD_REQUEST: 400,
  PAYLOAD_TOO_LARGE: 413,
  VERIFICATION_RUNNER_UNAVAILABLE: 503,
  EVIDENCE_WRITE_FAILED: 500,
  INTERNAL: 500,
};

export class VerificationRunnerError extends CodedHttpError {
  public readonly code: VerificationRunnerErrorCode;

  public constructor(code: VerificationRunnerErrorCode, message: string) {
    super(message, httpStatusFor(STATUS_MAP, code));
    this.code = code;
  }
}

// ADR-0147 D3 — WHY a package-script decision refused, as a closed vocabulary. The refusal used to
// reach the activity log and the model as the bare code WORKSPACE_TRUST_REQUIRED, so a governed run
// whose own edit to `package.json` had moved the worktree away from its repository's trust basis was
// indistinguishable from a repository nobody had ever trusted; the operator was then told to grant
// the repository, which cannot clear a drifted worktree (Coding Workbench run 8, 2026-09-10).
export const SCRIPT_TRUST_REFUSALS = [
  // An ordinary root with no current grant of its own.
  "root-not-trusted",
  // A managed worktree whose repository has no current grant, and no explicit grant of its own.
  "repository-not-trusted",
  // A managed worktree whose repository IS trusted, but whose own `package.json` no longer matches
  // the repository's trust basis — and which carries no explicit human grant for its rewritten bytes.
  "worktree-manifest-drift",
  // The decision itself failed (an unreadable manifest, a decider that threw): fail closed.
  "decision-failed",
] as const;
export type ScriptTrustRefusal = (typeof SCRIPT_TRUST_REFUSALS)[number];

export class WorkspaceTrustRequiredError extends VerificationRunnerError {
  public readonly trustRefusal: ScriptTrustRefusal;

  public constructor(trustRefusal: ScriptTrustRefusal) {
    super(
      "WORKSPACE_TRUST_REQUIRED",
      "Repository package scripts require server-side workspace trust before execution.",
    );
    this.trustRefusal = trustRefusal;
  }
}
