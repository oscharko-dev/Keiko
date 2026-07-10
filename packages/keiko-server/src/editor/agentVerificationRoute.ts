// Issue #2214 (Epic #2092, ADR-0126 D4/D5) — the agent-authorized verification route. A docked agent
// (M3) asks for one governed `test | targeted-test | typecheck | lint | build` run through this
// route; it reaches the SAME keiko-verification execution path (verificationRunner.runToReport) the
// human "Run tests" affordance (Issue #2212) uses — there is no separate agent-only execution engine.
//
//   POST /api/editor/verification/agent-runs   classify → compose → reserve → audit → run → redacted
//
// Because a verification run is agent-triggered but NON-mutating, it is classified under the
// "execution" effect class (Issue #2210) and gated by the Authority Envelope BEFORE any sandboxed run
// starts. This module builds its OWN small orchestration calling the exported governance primitives
// (classifyEditorAgentAction, composeEditorAgentActionPolicyDecision, the authority registry, and
// recordEditorAgentActionAudit) in the same classify → compose → reserve → audit sequence
// agentRoutes.ts's private decideActionPolicy/reserveActionAuthority/auditAction use — it does not,
// and must not, import those private functions or modify agentRoutes.ts. The combined disposition can
// only be as-or-more restrictive than either governance layer alone (the #2121 stricter-of-two rule).

import type { IncomingMessage } from "node:http";
import {
  EDITOR_AGENT_ACTION_APPROVAL_RISK,
  EDITOR_AGENT_SCHEMA_VERSION,
  EDITOR_AGENT_WORKBENCH_ACTION_CLASS,
  classifyEditorAgentAction,
  composeEditorAgentActionPolicyDecision,
  isContainedAgentPath,
  parseEditorAgentVerificationRunRequest,
  toRedactedVerificationReport,
  type CodingWorkbenchMode,
  type EditorAgentAction,
  type EditorAgentActionPolicyDecision,
  type EditorAgentActionStatus,
  type EditorAgentSessionSnapshot,
  type EditorAgentVerificationRunRequest,
} from "@oscharko-dev/keiko-contracts";
import { isDenied } from "@oscharko-dev/keiko-workspace";
import { recordEditorAgentActionAudit } from "./agentActionAudit.js";
import { editorAgentAuthorityRegistry } from "./agentAuthorityRegistry.js";
import { editorAgentRegistry } from "./agentSessionRegistry.js";
import { VerificationRunnerError } from "./verificationRunnerErrors.js";
import type { VerificationRunInput, VerificationRunnerManager } from "./verificationRunner.js";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import { readJsonObject } from "../files.js";
import type { UiHandlerDeps } from "../deps.js";

const MAX_AGENT_VERIFICATION_BODY_BYTES = 8_000;

// readJsonObject returns a RouteResult (an error response) or the parsed object; mirror the file-local
// guard used by files.ts/agentRoutes.ts (neither exports it) to narrow without a shared dependency.
function isRouteResult(value: Record<string, unknown> | RouteResult): value is RouteResult {
  return typeof (value as { status?: unknown }).status === "number";
}

function editorAgentDeploymentCeiling(deps: UiHandlerDeps): CodingWorkbenchMode {
  return deps.autonomousDeliveryDeploymentCeiling ?? "governed-assist";
}

// Mirror governedActionTarget for a verification request: the optional targetPath is denied at
// classification when it escapes the workspace, and flagged sensitive when it is contained but on the
// always-on deny-list. The leaf classifier cannot import keiko-workspace, so sensitivity is resolved here.
function verificationActionTarget(targetPath: string | undefined): {
  readonly targetPath: string | null;
  readonly targetSensitive: boolean;
} {
  if (targetPath === undefined) return { targetPath: null, targetSensitive: false };
  if (!isContainedAgentPath(targetPath)) return { targetPath, targetSensitive: false };
  return { targetPath, targetSensitive: isDenied(targetPath) };
}

// A synthetic action carrying only what classification and authority resolution read. It is NEVER
// dispatched to the browser bridge or the action queue — a verification run is a server-side sandboxed
// spawn, not a buffer mutation. actionId/idempotencyKey are deterministic identifiers for the audit
// record; they are not idempotency-replayed because this action never enters the action queue.
function syntheticVerificationAction(
  request: EditorAgentVerificationRunRequest,
): EditorAgentAction {
  const actionId = `verification:${request.sessionId}:${request.kind}`;
  return {
    schemaVersion: EDITOR_AGENT_SCHEMA_VERSION,
    actionId,
    idempotencyKey: actionId,
    sessionId: request.sessionId,
    type: "requestVerification",
    authorityRef: request.authorityRef,
    ...(request.targetPath === undefined ? {} : { target: { file: request.targetPath } }),
  };
}

function denyByAuthority(
  baseline: EditorAgentActionPolicyDecision,
  reason: "authority-invalid" | "authority-expired" | "authority-budget-exceeded",
): EditorAgentActionPolicyDecision {
  return {
    disposition: "denied",
    effectClass: baseline.effectClass,
    origin: baseline.origin,
    denyReason: reason,
  };
}

// classify → (resolve envelope) → compose, in the exact order decideActionPolicy uses. "execution" is
// non-null in EDITOR_AGENT_WORKBENCH_ACTION_CLASS, so a verification request is ALWAYS envelope-gated
// (never short-circuited like navigation/layout) — the composed result can only be as-or-more
// restrictive than either the classifier baseline or the envelope ceiling alone.
function decideVerificationPolicy(
  request: EditorAgentVerificationRunRequest,
  snapshot: EditorAgentSessionSnapshot,
  deps: UiHandlerDeps,
): EditorAgentActionPolicyDecision {
  const { targetPath, targetSensitive } = verificationActionTarget(request.targetPath);
  const baseline = classifyEditorAgentAction("requestVerification", {
    targetPath,
    targetSensitive,
    origin: "agent",
  });
  if (baseline.disposition === "denied") return baseline;
  if (EDITOR_AGENT_WORKBENCH_ACTION_CLASS[baseline.effectClass] === null) return baseline;
  const resolution = editorAgentAuthorityRegistry.resolveForAction(
    request.authorityRef,
    syntheticVerificationAction(request),
    snapshot.workspaceRoot,
    editorAgentDeploymentCeiling(deps),
    new Date().toISOString(),
  );
  if (!resolution.ok) {
    const reason =
      resolution.reason === "expired"
        ? "authority-expired"
        : resolution.reason === "budget-exceeded"
          ? "authority-budget-exceeded"
          : "authority-invalid";
    return denyByAuthority(baseline, reason);
  }
  return composeEditorAgentActionPolicyDecision(
    baseline,
    resolution.envelope,
    EDITOR_AGENT_ACTION_APPROVAL_RISK.requestVerification,
  );
}

// Charge exactly one toolCall (and zero patch bytes — verification carries no patch) against the
// envelope budget, exactly as every other admitted agent action does. Returns false when the budget is
// exhausted, which the caller surfaces as a denied, not-run outcome.
function reserveVerification(
  request: EditorAgentVerificationRunRequest,
  snapshot: EditorAgentSessionSnapshot,
  deps: UiHandlerDeps,
): boolean {
  return editorAgentAuthorityRegistry.reserveForAction(
    request.authorityRef,
    syntheticVerificationAction(request),
    snapshot.workspaceRoot,
    editorAgentDeploymentCeiling(deps),
    0,
    new Date().toISOString(),
  ).ok;
}

// One content-free audit record per request (AC5). The ledger records execution-class actions when
// admitted and any action when denied; the record carries only enums, identifiers, and the
// workspace-relative targetPath — never the verification's own pass/fail counts (those live in the
// returned report, not the ledger).
function auditVerification(
  request: EditorAgentVerificationRunRequest,
  decision: EditorAgentActionPolicyDecision,
  outcome: EditorAgentActionStatus,
): void {
  recordEditorAgentActionAudit({
    occurredAt: Date.now(),
    sessionId: request.sessionId,
    actionId: syntheticVerificationAction(request).actionId,
    actionType: "requestVerification",
    decision,
    outcome,
    ...(request.targetPath === undefined ? {} : { targetPath: request.targetPath }),
  });
}

function notRunResult(decision: EditorAgentActionPolicyDecision): RouteResult {
  const disposition = decision.disposition === "review-required" ? "review-required" : "denied";
  const reason = decision.denyReason ?? decision.reviewReason ?? "policy-denied";
  return { status: 200, body: { result: { outcome: "not-run", disposition, reason } } };
}

function verificationRunInput(request: EditorAgentVerificationRunRequest): VerificationRunInput {
  return {
    projectId: "",
    kinds: [request.kind],
    ...(request.targetPath === undefined ? {} : { targetPath: request.targetPath }),
  };
}

async function runAndRespond(
  runner: VerificationRunnerManager,
  request: EditorAgentVerificationRunRequest,
  snapshot: EditorAgentSessionSnapshot,
  decision: EditorAgentActionPolicyDecision,
  req: IncomingMessage,
): Promise<RouteResult> {
  const controller = new AbortController();
  const onClose = (): void => {
    controller.abort();
  };
  req.on("close", onClose);
  try {
    const input = { ...verificationRunInput(request), projectId: snapshot.workspaceRoot };
    const report = await runner.runToReport(input, controller.signal);
    auditVerification(request, decision, "succeeded");
    return {
      status: 200,
      body: { result: { outcome: "completed", report: toRedactedVerificationReport(report) } },
    };
  } catch (error) {
    auditVerification(request, decision, "failed");
    if (error instanceof VerificationRunnerError) {
      return { status: error.status, body: errorBody(error.code, error.message) };
    }
    throw error;
  } finally {
    req.removeListener("close", onClose);
  }
}

// POST /api/editor/verification/agent-runs — the only agent entry point into the verification route.
// Fail-closed: an unresolved session, an unmet Authority Envelope, or a review-required/denied
// disposition all prevent the sandboxed run from starting; each is audited exactly once.
export async function handleEditorAgentVerificationRun(
  ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  const runner = deps.verificationRunner;
  if (runner === undefined) {
    return {
      status: 503,
      body: errorBody(
        "VERIFICATION_RUNNER_UNAVAILABLE",
        "Editor verification runner is not configured for this BFF.",
      ),
    };
  }
  const body = await readJsonObject(ctx.req, MAX_AGENT_VERIFICATION_BODY_BYTES);
  if (isRouteResult(body)) return body;
  const parsed = parseEditorAgentVerificationRunRequest(body);
  if (!parsed.ok) {
    return { status: 400, body: errorBody("INVALID_REQUEST", parsed.errors.join("; ")) };
  }
  const request = parsed.value;
  const snapshot = editorAgentRegistry.snapshotFor(request.sessionId);
  if (snapshot === undefined) {
    return {
      status: 404,
      body: errorBody("SESSION_NOT_FOUND", "No governed editor session matches the request."),
    };
  }
  const decision = decideVerificationPolicy(request, snapshot, deps);
  if (decision.disposition !== "allowed") {
    auditVerification(request, decision, "conflict");
    return notRunResult(decision);
  }
  if (!reserveVerification(request, snapshot, deps)) {
    const denied = denyByAuthority(decision, "authority-budget-exceeded");
    auditVerification(request, denied, "conflict");
    return notRunResult(denied);
  }
  return runAndRespond(runner, request, snapshot, decision, ctx.req);
}
