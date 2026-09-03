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

import type {
  CodingWorkbenchMode,
  EditorAgentAction,
  EditorAgentActionDenyReason,
  EditorAgentActionPolicyDecision,
  EditorAgentActionStatus,
  EditorAgentSessionSnapshot,
  EditorAgentVerificationRunRequest,
  WorkspaceTrustLevel,
} from "@oscharko-dev/keiko-contracts";
import {
  EDITOR_AGENT_ACTION_APPROVAL_RISK,
  EDITOR_AGENT_WORKBENCH_ACTION_CLASS,
  classifyEditorAgentAction,
  composeEditorAgentActionPolicyDecision,
} from "@oscharko-dev/keiko-contracts/runtime/editor-agent-governance";
import {
  EDITOR_AGENT_SCHEMA_VERSION,
  isContainedAgentPath,
} from "@oscharko-dev/keiko-contracts/runtime/editor-agent";
import {
  parseEditorAgentVerificationRunRequest,
  toRedactedVerificationReport,
} from "@oscharko-dev/keiko-contracts/runtime/editor-agent-verification";
import { isDenied } from "@oscharko-dev/keiko-workspace";
import {
  editorAgentAuditRootAttribution,
  recordEditorAgentActionAudit,
} from "./agentActionAudit.js";
import {
  editorAgentAuthorityRegistry,
  type EditorAgentAuthorityFailureReason,
} from "./agentAuthorityRegistry.js";
import { editorAgentRegistry } from "./agentSessionRegistry.js";
import { VerificationRunnerError } from "./verificationRunnerErrors.js";
import { worktreeSharesRepositoryTrustBasis } from "./verificationRunner.js";
import type { VerificationRunInput, VerificationRunnerManager } from "./verificationRunner.js";
import { errorBody, type RouteContext, type RouteResult } from "../routes.js";
import { readJsonObject } from "../files.js";
import type { UiHandlerDeps } from "../deps.js";
import {
  editorAgentRootContainmentReason,
  isEditorAgentRootBoundaryDenial,
  resolveEditorAgentActionRoot,
  type EditorAgentRootBoundaryReason,
} from "./agentRootBoundary.js";
import { workspaceRootAccessOrUndefined } from "../task-workspace/workspace-root-access.js";
import { correlationIdOrUnknown, isValidCorrelationId } from "../correlation.js";
import { emitServerDiagnostic, type ServerDiagnosticSink } from "../diagnostics-log.js";
import { nodeWorkspaceFs } from "@oscharko-dev/keiko-workspace/internal/fs";

const MAX_AGENT_VERIFICATION_BODY_BYTES = 8_000;

type AuditWriter = typeof recordEditorAgentActionAudit;

export interface AgentVerificationRoutePorts {
  readonly audit?: AuditWriter | undefined;
  readonly decide?: typeof decideVerificationPolicy | undefined;
}

interface RequestLifecycle {
  readonly signal: AbortSignal;
  // The request's own correlation id (`RouteContext.correlationId`), carried here because the
  // lifecycle is the one value already built from the RouteContext and threaded to the run. It
  // becomes `VerificationRunInput.correlationId`, so the runner's lifecycle evidence, the workspace
  // resolver's `workspace.root.denied` line and this route's refusal diagnostic all join on one id.
  readonly correlationId: string | undefined;
  readonly dispose: () => void;
}

type RootedVerificationRequest =
  | { readonly ok: true; readonly request: EditorAgentVerificationRunRequest }
  | { readonly ok: false; readonly reason: EditorAgentRootBoundaryReason };

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
    ...(request.rootBinding === undefined ? {} : { rootBinding: request.rootBinding }),
    type: "requestVerification",
    authorityRef: request.authorityRef,
    ...(request.targetPath === undefined ? {} : { target: { file: request.targetPath } }),
  };
}

function denyByAuthority(
  baseline: EditorAgentActionPolicyDecision,
  reason: EditorAgentActionDenyReason,
): EditorAgentActionPolicyDecision {
  return {
    disposition: "denied",
    effectClass: baseline.effectClass,
    origin: baseline.origin,
    denyReason: reason,
  };
}

// Exported for direct regression coverage (Issue #2723): pure, no closures, otherwise only reachable
// by forcing a real authority resolution failure (expiry, revocation, or budget exhaustion) through
// the full governed verification route.
export function verificationAuthorityDenyReason(
  reason: EditorAgentAuthorityFailureReason,
): EditorAgentActionDenyReason {
  if (reason === "expired") return "authority-expired";
  if (reason === "budget-exceeded") return "authority-budget-exceeded";
  if (reason === "revoked") return "authority-revoked";
  return "authority-invalid";
}

type VerificationTrustDeps = Pick<
  UiHandlerDeps,
  "workspaceScriptTrust" | "workspaceRootAccessResolver"
>;

// A managed task worktree carries no standing script-trust grant of its own — production registers
// it as a project row (deps.ts `ensureManagedTaskWorkspaceIdentity`) but that row is not a trust
// decision — so `trustLevelForRoot` on the worktree path answers "restricted" and an
// execution-class request was denied `workspace-restricted` here BEFORE the runner's
// repository-trust lookup could ever run. The workbench facade calls
// `verificationRunner.runToReport` directly and bypasses this route, which is why the owner's
// end-to-end run could pass while `POST /api/editor/verification/agent-runs` (the sidecar /
// docked-agent entry point) stayed denied (cursor review, PR #3381).
//
// Standing script trust belongs to the repository the worktree was bound from, and applies to the
// worktree only while the worktree's own `package.json` is that same fact — asked of
// `worktreeSharesRepositoryTrustBasis` (verificationRunner.ts, ADR-0147 D3) rather than restated
// here, so this route and the runner cannot disagree about one grant.
function verificationWorkspaceTrust(
  deps: VerificationTrustDeps,
  workspaceRoot: string,
): WorkspaceTrustLevel {
  try {
    const trustRoot = verificationTrustRoot(deps, workspaceRoot);
    if (trustRoot === undefined) return "restricted";
    return deps.workspaceScriptTrust?.trustLevelForRoot(trustRoot) === "trusted"
      ? "trusted"
      : "restricted";
  } catch {
    return "restricted";
  }
}

function verificationTrustRoot(
  deps: Pick<UiHandlerDeps, "workspaceRootAccessResolver">,
  workspaceRoot: string,
): string | undefined {
  const access = workspaceRootAccessOrUndefined(deps.workspaceRootAccessResolver?.(workspaceRoot));
  if (access?.kind !== "managed-task") return workspaceRoot;
  const repositoryRoot = access.repositoryRoot;
  // A managed worktree that names no repository has no grantable basis at all: the standing
  // decision that would govern it is unknown, so it stays restricted rather than falling back to
  // its own unregistered root.
  if (repositoryRoot === undefined) return undefined;
  return worktreeSharesRepositoryTrustBasis(access, repositoryRoot, nodeWorkspaceFs)
    ? repositoryRoot
    : undefined;
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
    return denyByAuthority(baseline, verificationAuthorityDenyReason(resolution.reason));
  }
  return composeEditorAgentActionPolicyDecision(
    baseline,
    resolution.envelope,
    EDITOR_AGENT_ACTION_APPROVAL_RISK.requestVerification,
    verificationWorkspaceTrust(deps, snapshot.workspaceRoot),
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

function rollbackVerificationReservation(request: EditorAgentVerificationRunRequest): boolean {
  return editorAgentAuthorityRegistry.rollbackActionReservation(request.authorityRef, 0);
}

// Issue #2624 — a root-boundary denial resolved no root, so it must not report a target it could not
// have authorized. The sibling actions route suppresses the target fields on exactly these reasons
// (`auditTargetFields`); both routes now ask the one owning predicate so they cannot diverge again.
function verificationAuditTarget(
  request: EditorAgentVerificationRunRequest,
  decision: EditorAgentActionPolicyDecision,
): { readonly targetPath?: string | undefined } {
  if (request.targetPath === undefined) return {};
  return isEditorAgentRootBoundaryDenial(decision.denyReason)
    ? {}
    : { targetPath: request.targetPath };
}

// One content-free audit record per request (AC5). The ledger records execution-class actions when
// admitted and any action when denied; the record carries only enums, identifiers, and the
// workspace-relative targetPath — never the verification's own pass/fail counts (those live in the
// returned report, not the ledger).
function auditVerification(
  request: EditorAgentVerificationRunRequest,
  snapshot: EditorAgentSessionSnapshot,
  decision: EditorAgentActionPolicyDecision,
  outcome: EditorAgentActionStatus,
  writer: AuditWriter,
): boolean {
  return (
    writer({
      occurredAt: Date.now(),
      sessionId: request.sessionId,
      actionId: syntheticVerificationAction(request).actionId,
      actionType: "requestVerification",
      // Attribution comes from the server-held session, never from `request` — see the helper.
      ...editorAgentAuditRootAttribution(snapshot),
      decision,
      outcome,
      ...verificationAuditTarget(request, decision),
    }) !== null
  );
}

function notRunResult(decision: EditorAgentActionPolicyDecision): RouteResult {
  const disposition = decision.disposition === "review-required" ? "review-required" : "denied";
  const reason =
    disposition === "review-required"
      ? (decision.reviewReason ?? "mode-approval-required")
      : (decision.denyReason ?? "mode-policy-denied");
  return { status: 200, body: { result: { outcome: "not-run", disposition, reason } } };
}

function auditFailure(): RouteResult {
  return {
    status: 503,
    body: errorBody(
      "AGENT_VERIFICATION_AUDIT_FAILED",
      "The governed verification admission record could not be written.",
    ),
  };
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
  lifecycle: RequestLifecycle,
  deps: Pick<UiHandlerDeps, "diagnostics">,
): Promise<RouteResult> {
  const correlationId = correlationIdOrUnknown(
    lifecycle.correlationId ?? verificationCorrelationId(request),
  );
  try {
    const input: VerificationRunInput = {
      ...verificationRunInput(request),
      projectId: snapshot.workspaceRoot,
      correlationId,
    };
    const report = await runner.runToReport(input, lifecycle.signal);
    return {
      status: 200,
      body: { result: { outcome: "completed", report: toRedactedVerificationReport(report) } },
    };
  } catch (error) {
    if (error instanceof VerificationRunnerError) {
      emitVerificationRefusalDiagnostic(deps.diagnostics, correlationId, error);
      return { status: error.status, body: errorBody(error.code, error.message) };
    }
    throw error;
  }
}

// A runner refusal used to leave NOTHING behind at this layer: the route answered 403/404/422/429
// from an error body and only the coding-tool port — a different entry point — ever logged one, so
// `keiko support analyze --correlation-id <request>` showed the request and no refusal at all
// (PR #3381 review). Body-free by construction: the closed runner code as `errorClass` and a
// catalogued summary as `message`; the error's own text (which names no path, but is still free
// prose) never reaches the record.
function emitVerificationRefusalDiagnostic(
  diagnostics: ServerDiagnosticSink | undefined,
  correlationId: string,
  error: VerificationRunnerError,
): void {
  emitServerDiagnostic(diagnostics, {
    correlationId,
    timestamp: new Date().toISOString(),
    operation: "editor.verification.execute",
    source: "editor.agent-verification-route",
    errorClass: error.code,
    message: "verification-refused",
  });
}

function requestLifecycle(ctx: RouteContext): RequestLifecycle {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort("agent verification client disconnected");
  };
  const onResponseClose = (): void => {
    if (!ctx.res.writableEnded) abort();
  };
  ctx.req.on("aborted", abort);
  ctx.res.on("close", onResponseClose);
  if (ctx.req.destroyed && !ctx.req.complete) abort();
  if (ctx.res.destroyed && !ctx.res.writableEnded) abort();
  return {
    signal: controller.signal,
    correlationId: ctx.correlationId,
    dispose: (): void => {
      ctx.req.removeListener("aborted", abort);
      ctx.res.removeListener("close", onResponseClose);
    },
  };
}

async function admitAndRun(
  request: EditorAgentVerificationRunRequest,
  snapshot: EditorAgentSessionSnapshot,
  deps: UiHandlerDeps,
  runner: VerificationRunnerManager,
  lifecycle: RequestLifecycle,
  ports: AgentVerificationRoutePorts,
): Promise<RouteResult> {
  const rooted = bindVerificationRoot(request, snapshot, deps);
  const audit = ports.audit ?? recordEditorAgentActionAudit;
  if (!rooted.ok) return rejectVerificationRoot(request, snapshot, rooted.reason, audit);
  request = rooted.request;
  const decision = (ports.decide ?? decideVerificationPolicy)(request, snapshot, deps);
  if (decision.disposition !== "allowed") {
    return auditVerification(request, snapshot, decision, "conflict", audit)
      ? notRunResult(decision)
      : auditFailure();
  }
  if (!reserveVerification(request, snapshot, deps)) {
    const denied = denyByAuthority(decision, "authority-budget-exceeded");
    return auditVerification(request, snapshot, denied, "conflict", audit)
      ? notRunResult(denied)
      : auditFailure();
  }
  const finalRoot = bindVerificationRoot(request, snapshot, deps);
  if (!finalRoot.ok) {
    rollbackVerificationReservation(request);
    return rejectVerificationRoot(request, snapshot, finalRoot.reason, audit);
  }
  request = finalRoot.request;
  if (!auditVerification(request, snapshot, decision, "queued", audit)) {
    rollbackVerificationReservation(request);
    return auditFailure();
  }
  return runAndRespond(runner, request, snapshot, lifecycle, deps);
}

// The correlation the containment port's own denial line is recorded under; the synthetic action id
// carries colons, which the correlation shape rejects.
function verificationCorrelationId(request: EditorAgentVerificationRunRequest): string | undefined {
  const runId = request.authorityRef.runId;
  return isValidCorrelationId(runId) ? runId : undefined;
}

// Containment runs through the port the root's own authority resolved — the owned-root port a
// proven managed task worktree minted — via the one shared helper both editor route families now
// call (`agentRootBoundary.ts`). The former private copy of that resolution here and in
// agentRoutes.ts was a drift risk on the exact defect this PR closes (cursor review, PR #3381).
function bindVerificationRoot(
  request: EditorAgentVerificationRunRequest,
  snapshot: EditorAgentSessionSnapshot,
  deps: Pick<UiHandlerDeps, "store" | "workspaceRootAccessResolver">,
): RootedVerificationRequest {
  const root = resolveEditorAgentActionRoot(snapshot, request.rootBinding, deps.store);
  if (!root.ok) return root;
  const reason = editorAgentRootContainmentReason(
    root.root,
    request.targetPath === undefined ? [] : [request.targetPath],
    deps,
    verificationCorrelationId(request),
  );
  if (reason !== null) return { ok: false, reason };
  return {
    ok: true,
    request:
      root.root.binding === undefined ? request : { ...request, rootBinding: root.root.binding },
  };
}

function rejectVerificationRoot(
  request: EditorAgentVerificationRunRequest,
  snapshot: EditorAgentSessionSnapshot,
  reason: EditorAgentRootBoundaryReason,
  audit: AuditWriter,
): RouteResult {
  const denied = verificationRootDenial(request, reason);
  return auditVerification(request, snapshot, denied, "conflict", audit)
    ? notRunResult(denied)
    : auditFailure();
}

function verificationRootDenial(
  request: EditorAgentVerificationRunRequest,
  reason: EditorAgentRootBoundaryReason,
): EditorAgentActionPolicyDecision {
  const target = verificationActionTarget(request.targetPath);
  return denyByAuthority(
    classifyEditorAgentAction("requestVerification", { ...target, origin: "agent" }),
    reason,
  );
}

async function handleWithLifecycle(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  lifecycle: RequestLifecycle,
  ports: AgentVerificationRoutePorts,
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
  const snapshot = editorAgentRegistry.snapshotFor(parsed.value.sessionId);
  if (snapshot === undefined) {
    return {
      status: 404,
      body: errorBody("SESSION_NOT_FOUND", "No governed editor session matches the request."),
    };
  }
  return admitAndRun(parsed.value, snapshot, deps, runner, lifecycle, ports);
}

// POST /api/editor/verification/agent-runs — the only agent entry point into the verification route.
// Fail-closed: an unresolved session, an unmet Authority Envelope, or a review-required/denied
// disposition all prevent the sandboxed run from starting; each is audited exactly once.
export async function handleEditorAgentVerificationRun(
  ctx: RouteContext,
  deps: UiHandlerDeps,
  ports: AgentVerificationRoutePorts = {},
): Promise<RouteResult> {
  const lifecycle = requestLifecycle(ctx);
  try {
    return await handleWithLifecycle(ctx, deps, lifecycle, ports);
  } finally {
    lifecycle.dispose();
  }
}
