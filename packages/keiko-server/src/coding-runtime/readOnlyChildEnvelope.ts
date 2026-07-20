// One-layer read-only child derivation for Epic #2384 Code-task auxiliary capabilities (Issue
// #2387, Module C). `deriveReadOnlyChildEnvelope` computes a STRICTLY NARROWER, read-only authority
// envelope for a single-layer child agent: it strips every write / delivery / authority-widening
// action class, forces the allowed classes to a subset of the parent's, and forces the network
// posture to deny-all unless the parent already grants governed egress AND the child is explicitly
// research-scoped. The derived envelope can never mint a grant and carries a one-layer marker so a
// child that itself asks for a child is rejected by `assertChildCannotSpawnChild`. Both functions
// are pure and total; a malformed or over-broad parent fails closed (an explicit error, or the
// narrowest possible envelope). Nothing here carries raw prompts, queries, scratch, or secrets.
import {
  CODING_WORKBENCH_ACTION_CLASSES,
  isCodeTaskChildRunId,
  validateCodingWorkbenchAuthorityEnvelope,
} from "@oscharko-dev/keiko-contracts";
import type {
  AuxiliaryCapabilityRequestV1,
  AuxiliaryResearchScopeV1,
  CodeTaskChildRunId,
  CodingWorkbenchActionClass,
  CodingWorkbenchAuthorityEnvelope,
  CodingWorkbenchNetworkPolicy,
} from "@oscharko-dev/keiko-contracts";

/** The child-agent variant of an auxiliary request, narrowed from the discriminated union. */
export type ChildAgentRequestV1 = Extract<
  AuxiliaryCapabilityRequestV1,
  { readonly capability: "child-agent" }
>;

/**
 * A derived, one-layer, read-only child authority. Strictly narrower than its parent: read-only
 * action classes only (a subset of the parent's), a deny-all-by-default network posture, no
 * grant-minting capability, and a fixed one-layer depth marker so no grandchild can be derived.
 */
export interface ReadOnlyChildEnvelope {
  /** Content-free binding back to the parent run whose budget every child tool call charges. */
  readonly parentRunId: string;
  readonly childRunId: CodeTaskChildRunId;
  /** Exactly one layer below the root task; a child is never derived from a child. */
  readonly childDepth: 1;
  readonly oneLayer: true;
  /** Read-only subset of the parent's action classes; never a superset. */
  readonly allowedActionClasses: readonly CodingWorkbenchActionClass[];
  readonly networkPolicy: CodingWorkbenchNetworkPolicy;
  /** A child can never mint an authority grant. */
  readonly canMintGrant: false;
}

export interface DeriveReadOnlyChildEnvelopeOptions {
  /** When present the child is explicitly research-scoped, enabling the governed-egress branch. */
  readonly research?: AuxiliaryResearchScopeV1 | undefined;
  /** Injected clock reading (epoch ms) used only for research-grant liveness; omitted ⇒ not live. */
  readonly nowMs?: number | undefined;
}

export type ReadOnlyChildDerivationReason = "parent-envelope-invalid" | "child-run-id-invalid";

export type DeriveReadOnlyChildEnvelopeResult =
  | { readonly ok: true; readonly envelope: ReadOnlyChildEnvelope }
  | { readonly ok: false; readonly reasonCode: ReadOnlyChildDerivationReason };

export type ChildSpawnAdmission =
  | { readonly ok: true; readonly request: ChildAgentRequestV1 }
  | {
      readonly ok: false;
      readonly reasonCode: "nested-child-denied" | "not-a-child-agent-request";
    };

const DENY_ALL_NETWORK_POLICY: CodingWorkbenchNetworkPolicy = {
  mode: "deny-all",
  allowLoopback: false,
  connectorScopes: [],
};

const GOVERNED_EGRESS_NETWORK_POLICY: CodingWorkbenchNetworkPolicy = {
  mode: "governed-egress",
  allowLoopback: false,
  connectorScopes: [],
};

// The always-eligible read-only class. Network egress is added only for a live research grant.
const READ_ONLY_BASE_ACTION_CLASS: CodingWorkbenchActionClass = "workspace-read";

/**
 * Derives the one-layer read-only child envelope for `childRunId` from a validated parent authority.
 * Fails closed: an invalid parent or child id yields an explicit error; an over-broad parent is
 * narrowed to the read-only subset. The network posture is deny-all unless the parent grants
 * governed egress and a live research scope is supplied.
 */
export function deriveReadOnlyChildEnvelope(
  parent: CodingWorkbenchAuthorityEnvelope,
  childRunId: CodeTaskChildRunId,
  options: DeriveReadOnlyChildEnvelopeOptions = {},
): DeriveReadOnlyChildEnvelopeResult {
  if (!validateCodingWorkbenchAuthorityEnvelope(parent).ok) {
    return { ok: false, reasonCode: "parent-envelope-invalid" };
  }
  if (!isCodeTaskChildRunId(childRunId)) {
    return { ok: false, reasonCode: "child-run-id-invalid" };
  }
  const networkPolicy = deriveChildNetworkPolicy(parent, options);
  return {
    ok: true,
    envelope: {
      parentRunId: parent.runId,
      childRunId,
      childDepth: 1,
      oneLayer: true,
      allowedActionClasses: deriveChildActionClasses(parent, networkPolicy),
      networkPolicy,
      canMintGrant: false,
    },
  };
}

function deriveChildNetworkPolicy(
  parent: CodingWorkbenchAuthorityEnvelope,
  options: DeriveReadOnlyChildEnvelopeOptions,
): CodingWorkbenchNetworkPolicy {
  const research = options.research;
  if (research === undefined) return DENY_ALL_NETWORK_POLICY;
  const parentGrantsEgress =
    parent.networkPolicy.mode === "governed-egress" &&
    parent.actionClasses.includes("network-egress");
  if (!parentGrantsEgress) return DENY_ALL_NETWORK_POLICY;
  return isResearchGrantLive(research, options.nowMs)
    ? GOVERNED_EGRESS_NETWORK_POLICY
    : DENY_ALL_NETWORK_POLICY;
}

function isResearchGrantLive(
  research: AuxiliaryResearchScopeV1,
  nowMs: number | undefined,
): boolean {
  if (nowMs === undefined || !Number.isFinite(nowMs)) return false;
  const expiry = Date.parse(research.expiresAt);
  return !Number.isNaN(expiry) && expiry > nowMs && research.domains.length > 0;
}

function deriveChildActionClasses(
  parent: CodingWorkbenchAuthorityEnvelope,
  networkPolicy: CodingWorkbenchNetworkPolicy,
): readonly CodingWorkbenchActionClass[] {
  const eligible = new Set<CodingWorkbenchActionClass>([READ_ONLY_BASE_ACTION_CLASS]);
  if (networkPolicy.mode !== "deny-all") eligible.add("network-egress");
  // Intersect with the parent (never a superset) and keep the canonical order deterministic.
  return CODING_WORKBENCH_ACTION_CLASSES.filter(
    (actionClass) => eligible.has(actionClass) && parent.actionClasses.includes(actionClass),
  );
}

/**
 * Fails closed when a child-agent request originates from a child context: a read-only child can
 * never spawn its own child (one layer only). Also rejects a non-child-agent request routed here by
 * mistake. On success the request is returned narrowed to the child-agent variant.
 */
export function assertChildCannotSpawnChild(
  request: AuxiliaryCapabilityRequestV1,
  originChildEnvelope: ReadOnlyChildEnvelope | undefined,
): ChildSpawnAdmission {
  if (request.capability !== "child-agent") {
    return { ok: false, reasonCode: "not-a-child-agent-request" };
  }
  if (originChildEnvelope !== undefined) {
    return { ok: false, reasonCode: "nested-child-denied" };
  }
  return { ok: true, request };
}
