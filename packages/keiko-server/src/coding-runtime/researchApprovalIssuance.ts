// Approval-driven research grant issuance for Epic #2384 Code tasks (Issue #2387).
//
// The decided flow (see the #2387 handoff, "request-scoped grants"): the model asks for a research
// fetch of one exact URL → the egress port finds no covering grant and hands the URL to
// `requestResearchApproval`, which retains it TRANSIENTLY (in memory only, never persisted,
// evidenced, or projected) and raises a content-free `network-egress` permission request → the
// operator approves through the ordinary #2386 approval route → `registerApprovedResearchGrant`
// consumes the retained URL exactly once and mints a grant whose `queryTextDigest` binds the
// approved request line via the SAME `researchRequestLineDigest` the executor verifies, so the
// approved URL — and nothing else on that host — becomes fetchable.
//
// Everything fails closed: an unknown, expired, replayed, or run-mismatched approval mints no
// grant; a second concurrent ask per run is refused (one pending research approval at a time); a
// non-public host never enters the store. The optional `GovernedActionV1` sink receives the
// validated, content-free decision projection produced for #2388.
import {
  CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
  isCodeTaskPublicDomain,
  validateCodingWorkbenchRuntimeEvent,
  validateGovernedActionV1,
  type AuxiliaryResearchScopeV1,
  type CodingWorkbenchRuntimeEvent,
  type GovernedActionV1,
} from "@oscharko-dev/keiko-contracts";

import { researchRequestLineDigest } from "./researchEgressPort.js";
import { normalizeResearchHost, type ResearchGrantRegistry } from "./researchGrantRegistry.js";

/** How long an unanswered research ask stays consumable; mirrors the sidecar approval window. */
export const RESEARCH_APPROVAL_TTL_MS = 120_000;

export interface PendingResearchApproval {
  readonly runId: string;
  readonly requestId: string;
  readonly url: URL;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly expiresAtMs: number;
}

export interface PendingResearchApprovals {
  /**
   * Retains one URL awaiting approval and returns the minted request id, or undefined when the
   * ask is refused: a non-https URL, a non-public host, or an ask already pending for the run.
   */
  readonly request: (input: {
    readonly runId: string;
    readonly url: URL;
    readonly taskId: string;
    readonly workspaceId: string;
    readonly nowMs: number;
  }) => string | undefined;
  /** One-shot: a consumed or expired ask can never mint a second grant. */
  readonly consume: (
    runId: string,
    requestId: string,
    nowMs: number,
  ) => PendingResearchApproval | undefined;
  readonly invalidateRun: (runId: string) => void;
}

function publicResearchHost(url: URL): string | undefined {
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
    return undefined;
  }
  const host = normalizeResearchHost(url.hostname);
  return isCodeTaskPublicDomain(host) ? host : undefined;
}

class InMemoryPendingResearchApprovals implements PendingResearchApprovals {
  private readonly byRun = new Map<string, PendingResearchApproval>();
  private sequence = 0;

  public request(input: {
    readonly runId: string;
    readonly url: URL;
    readonly taskId: string;
    readonly workspaceId: string;
    readonly nowMs: number;
  }): string | undefined {
    if (publicResearchHost(input.url) === undefined) return undefined;
    const existing = this.byRun.get(input.runId);
    if (existing !== undefined && existing.expiresAtMs > input.nowMs) return undefined;
    this.sequence += 1;
    const requestId = `research-approval-${String(this.sequence)}`;
    this.byRun.set(input.runId, {
      runId: input.runId,
      requestId,
      url: input.url,
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      expiresAtMs: input.nowMs + RESEARCH_APPROVAL_TTL_MS,
    });
    return requestId;
  }

  public consume(
    runId: string,
    requestId: string,
    nowMs: number,
  ): PendingResearchApproval | undefined {
    const pending = this.byRun.get(runId);
    if (pending === undefined) return undefined;
    this.byRun.delete(runId);
    if (pending.requestId !== requestId || pending.expiresAtMs <= nowMs) return undefined;
    return pending;
  }

  public invalidateRun(runId: string): void {
    this.byRun.delete(runId);
  }
}

export function createPendingResearchApprovals(): PendingResearchApprovals {
  return new InMemoryPendingResearchApprovals();
}

/**
 * Builds the content-free `permission-requested` runtime event for a pending research ask. The
 * event carries only vocabulary facts — never the URL, host, path, or query — and validates
 * against the runtime-event contract before it may be emitted.
 */
export function buildResearchPermissionEvent(input: {
  readonly runId: string;
  readonly requestId: string;
  readonly sequence: number;
  readonly nowMs: number;
}): CodingWorkbenchRuntimeEvent | undefined {
  const event: CodingWorkbenchRuntimeEvent = {
    schemaVersion: CODING_WORKBENCH_RUNTIME_CONTRACT_VERSION,
    eventId: `event-research-approval-${String(input.sequence)}`,
    runId: input.runId,
    occurredAt: new Date(input.nowMs).toISOString(),
    kind: "permission-requested",
    permissionRequest: {
      requestId: input.requestId,
      kind: "network-egress",
      actionClass: "network-egress",
      reasonCode: "research-approval-required",
      actionKind: "research",
      risk: "medium",
      expiresAt: new Date(input.nowMs + RESEARCH_APPROVAL_TTL_MS).toISOString(),
    },
  };
  return validateCodingWorkbenchRuntimeEvent(event).ok ? event : undefined;
}

export interface ApprovedResearchIssuanceDeps {
  readonly pending: PendingResearchApprovals;
  readonly registry: ResearchGrantRegistry;
  readonly now: () => Date;
  /** Optional #2388 projection sink; receives only validated, content-free decisions. */
  readonly onGovernedAction?: ((action: GovernedActionV1) => void) | undefined;
}

/**
 * Mints the research grant for an approved `research` action. Fails closed to "no grant" when the
 * retained ask is missing, expired, or mismatched — the operator's approval then has no internet
 * effect and the next fetch attempt simply raises a fresh ask.
 */
export function registerApprovedResearchGrant(
  deps: ApprovedResearchIssuanceDeps,
  request: {
    readonly runId: string;
    readonly requestId: string;
    readonly boundRevision?: number | undefined;
  },
  approvalDigest: string,
  approvalExpiresAtMs: number,
): void {
  const nowMs = deps.now().getTime();
  const pending = deps.pending.consume(request.runId, request.requestId, nowMs);
  if (pending === undefined) return;
  const host = publicResearchHost(pending.url);
  if (host === undefined) return;
  // The ask "research-approval-<n>" mints the grant "research-grant-<n>": same sequence number,
  // so an audit can pair every grant with the exact approval that created it.
  const sequence = pending.requestId.slice("research-approval-".length);
  const scope: AuxiliaryResearchScopeV1 = {
    grantId: `research-grant-${sequence}` as AuxiliaryResearchScopeV1["grantId"],
    domains: [host],
    expiresAt: new Date(approvalExpiresAtMs).toISOString(),
    queryTextDigest: { outcome: "known", value: researchRequestLineDigest(pending.url) },
  };
  const grant = deps.registry.register(request.runId, scope, undefined, approvalDigest, nowMs);
  if (grant === undefined) return;
  emitGovernedAction(deps, request, pending, grant.grantId);
}

function emitGovernedAction(
  deps: ApprovedResearchIssuanceDeps,
  request: { readonly runId: string; readonly boundRevision?: number | undefined },
  pending: PendingResearchApproval,
  grantId: string,
): void {
  if (deps.onGovernedAction === undefined) return;
  const action = {
    kind: "governed-action",
    schemaVersion: 1,
    taskId: pending.taskId,
    runId: request.runId,
    workspaceId: pending.workspaceId,
    stateRevision: request.boundRevision ?? 0,
    actionKind: "read-only-research",
    decision: "allowed",
    grant: { outcome: "known", value: { grantId, grantScope: "once" } },
    question: { outcome: "absent" },
  };
  const validated = validateGovernedActionV1(action);
  if (validated.ok) deps.onGovernedAction(validated.value);
}
