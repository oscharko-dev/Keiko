// Shared governed-action policy seam for the Atlassian connector lane (Issue #2244, Epic #2238,
// ADR-0128 D4; composition pattern of ADR-0125).
//
// Every AGENT-INITIATED connector action request resolves the validated Authority Envelope
// against the EXISTING server-side registry (`editorAgentAuthorityRegistry` — the same opaque
// run id + envelope digest reference contract, expiry/digest/budget semantics, and deployment-
// ceiling check the editor lane uses; nothing is forked), then derives the D4 disposition with
// the #2240 contract helper `decideAtlassianConnectorAction`, evaluated for the envelope's
// requestedMode, deploymentCeiling, and effectiveMode with the STRICTEST disposition winning —
// mirroring `composeEditorAgentActionPolicyDecision`'s triple-mode composition exactly.
//
// The registry's closed failure vocabulary maps 1:1 onto the existing envelope reason codes
// (`invalid → authority-invalid`, `expired → authority-expired`, `budget-exceeded →
// authority-budget-exceeded`); an authority failure is a mode-independent hard denial
// (ADR-0129 D3) carrying exactly one of those codes.
//
// Direct HUMAN-TRIGGERED BFF operations do not pass through this seam: ADR-0128 D5 fixes v1
// sync as explicitly user-triggered, and under the ADR-0129 human-control invariant the
// per-action human trigger IS the review satisfaction in every mode — such attempts record
// disposition `allowed` with the explicit `human-initiated` rationale (see syncRoutes.ts).
// The #2241 credential custody surfaces (create/list/delete/verify) are human credential
// management, not D4 connector actions — the D4 table has no row for them — so they carry no
// disposition at all.

import {
  decideAtlassianConnectorAction,
  type AtlassianConnectorActionDecision,
  type AtlassianConnectorActionType,
  type AtlassianConnectorAuthorityFailureReason,
  type CodingWorkbenchAuthorityEnvelope,
  type CodingWorkbenchMode,
} from "@oscharko-dev/keiko-contracts";
import {
  editorAgentAuthorityRegistry,
  type EditorAgentAuthorityFailureReason,
} from "../editor/agentAuthorityRegistry.js";
import type { UiHandlerDeps } from "../deps.js";

// The wire-facing authority context an agent-initiated connector request carries: the opaque
// registry reference (run id + envelope digest, exactly the editor lane's
// `EditorAgentGovernedAuthorityReference`) plus the caller's workspace root, whose digest must
// match the envelope's registered workspace identity (the same proof the editor session
// snapshot supplies for editor actions).
export interface AtlassianActionAuthorityContext {
  readonly runId: string;
  readonly envelopeDigest: string;
  readonly workspaceRoot: string;
}

const AUTHORITY_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  "runId",
  "envelopeDigest",
  "workspaceRoot",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// Strict parse of the optional `authority` request field. `undefined` means the request carries
// no authority context (allowed only where a human-initiated path exists); a malformed object is
// a validation failure, never silently treated as human-initiated.
export function parseAtlassianActionAuthorityContext(
  value: unknown,
): AtlassianActionAuthorityContext | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).every((key) => AUTHORITY_CONTEXT_KEYS.has(key))) return undefined;
  if (
    !isNonEmptyString(record.runId) ||
    !isNonEmptyString(record.envelopeDigest) ||
    !isNonEmptyString(record.workspaceRoot)
  ) {
    return undefined;
  }
  return {
    runId: record.runId,
    envelopeDigest: record.envelopeDigest,
    workspaceRoot: record.workspaceRoot,
  };
}

export const ATLASSIAN_AUTHORITY_FAILURE_REASON: Readonly<
  Record<EditorAgentAuthorityFailureReason, AtlassianConnectorAuthorityFailureReason>
> = Object.freeze({
  invalid: "authority-invalid",
  expired: "authority-expired",
  "budget-exceeded": "authority-budget-exceeded",
} as const satisfies Readonly<
  Record<EditorAgentAuthorityFailureReason, AtlassianConnectorAuthorityFailureReason>
>);

export type AtlassianGovernedActionOutcome =
  | { readonly kind: "allowed"; readonly decision: AtlassianConnectorActionDecision }
  | { readonly kind: "review-required"; readonly decision: AtlassianConnectorActionDecision }
  | {
      readonly kind: "policy-denied";
      readonly decision: AtlassianConnectorActionDecision;
    }
  | {
      readonly kind: "authority-denied";
      readonly reason: AtlassianConnectorAuthorityFailureReason;
    };

function atlassianDeploymentCeiling(deps: UiHandlerDeps): CodingWorkbenchMode {
  return deps.autonomousDeliveryDeploymentCeiling ?? "governed-assist";
}

const DISPOSITION_STRICTNESS: Readonly<
  Record<AtlassianConnectorActionDecision["disposition"], number>
> = Object.freeze({
  allowed: 0,
  "review-required": 1,
  denied: 2,
});

// Strictest-wins across the envelope's three mode facets, exactly as
// `composeEditorAgentActionPolicyDecision` evaluates requestedMode, deploymentCeiling, and
// effectiveMode and keeps the most restrictive effect. The strictest decision carries its own
// single reason (the exactly-one-reason rule holds by construction).
function strictestModeDecision(
  actionType: AtlassianConnectorActionType,
  envelope: CodingWorkbenchAuthorityEnvelope,
): AtlassianConnectorActionDecision {
  const decide = (mode: CodingWorkbenchMode): AtlassianConnectorActionDecision =>
    decideAtlassianConnectorAction(
      actionType,
      mode,
      envelope.connectorScopes,
      envelope.actionClasses,
    );
  // Strictest-wins across the three fixed mode facets. The requested-mode decision seeds the
  // reduce (an explicit initial value; the accumulator is never over an empty array), and the
  // ceiling and effective-mode decisions can only make it stricter.
  return [envelope.deploymentCeiling, envelope.effectiveMode]
    .map(decide)
    .reduce(
      (strictest, candidate) =>
        DISPOSITION_STRICTNESS[candidate.disposition] >
        DISPOSITION_STRICTNESS[strictest.disposition]
          ? candidate
          : strictest,
      decide(envelope.requestedMode),
    );
}

function outcomeOf(decision: AtlassianConnectorActionDecision): AtlassianGovernedActionOutcome {
  if (decision.disposition === "denied") return { kind: "policy-denied", decision };
  if (decision.disposition === "review-required") return { kind: "review-required", decision };
  return { kind: "allowed", decision };
}

// Resolve-and-decide WITHOUT charging budget: used at request admission (and re-used at approve
// time for revalidation). Budget is charged separately, immediately before execution, via
// `reserveGovernedAtlassianAction` — a pending approval consumes no budget while pending.
export function decideGovernedAtlassianAction(
  actionType: AtlassianConnectorActionType,
  authority: AtlassianActionAuthorityContext,
  deps: UiHandlerDeps,
): AtlassianGovernedActionOutcome {
  const resolution = editorAgentAuthorityRegistry.resolve(
    { runId: authority.runId, envelopeDigest: authority.envelopeDigest },
    authority.workspaceRoot,
    atlassianDeploymentCeiling(deps),
    new Date().toISOString(),
  );
  if (!resolution.ok) {
    return {
      kind: "authority-denied",
      reason: ATLASSIAN_AUTHORITY_FAILURE_REASON[resolution.reason],
    };
  }
  return outcomeOf(strictestModeDecision(actionType, resolution.envelope));
}

// Charge exactly one toolCall against the envelope budget immediately before execution (the
// editor lane's reserve step). Failure maps onto the same existing envelope reason codes.
export function reserveGovernedAtlassianAction(
  authority: AtlassianActionAuthorityContext,
  deps: UiHandlerDeps,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AtlassianConnectorAuthorityFailureReason } {
  const reservation = editorAgentAuthorityRegistry.reserveForConnector(
    { runId: authority.runId, envelopeDigest: authority.envelopeDigest },
    authority.workspaceRoot,
    atlassianDeploymentCeiling(deps),
    new Date().toISOString(),
  );
  if (reservation.ok) return { ok: true };
  return { ok: false, reason: ATLASSIAN_AUTHORITY_FAILURE_REASON[reservation.reason] };
}
