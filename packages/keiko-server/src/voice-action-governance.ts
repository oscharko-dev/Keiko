// Server-side spoken-action governance (Epic #491, Issue #503, ADR-0066). Voice is an UNTRUSTED input
// source: a committed spoken transcript may PROPOSE a governed workflow handoff, but it can never EXECUTE
// one or weaken any existing gate. This module is the fail-closed enforcement layer that sits IN FRONT OF
// the existing governance (`validateWorkflowHandoffRequest` + the `userApprovalToken` equality check +
// `checkPatchAgainstScope` downstream). It ADDS preconditions; it removes none.
//
// The contract leaf (`voice-action-intent`) defines the pure normalization + classification. This module
// supplies the only IO the design needs — a one-way sha256 content digest (mirroring
// `createApprovalToken` in governed-workflow.ts) — and the deterministic decision procedure. The server
// NEVER trusts a client-supplied digest: it recomputes the expected digest from the committed projection
// it received and compares the two. Every path (allow and deny) emits a content-free
// `SpokenActionAuditRecord` carrying enums / counts / a digest only — never raw transcript text or audio.

import { createHash } from "node:crypto";
import {
  buildSpokenActionAuditRecord,
  canonicalizeSpokenActionConfirmation,
  normalizeSpokenActionProposal,
  voiceCanProposeAction,
  type CommittedVoiceTranscriptProjection,
  type SpokenActionAuditRecord,
  type SpokenActionConfirmationInput,
  type SpokenActionEffectClass,
  type SpokenActionOutcome,
  type SpokenActionProposal,
  type SpokenActionState,
  type VoiceProfile,
  type VoiceTranscriptSource,
} from "@oscharko-dev/keiko-contracts";
import {
  type WorkflowHandoffRequest,
  validateWorkflowHandoffRequest,
} from "@oscharko-dev/keiko-contracts/workflow-handoff";
import { approvalTokenInputFor, createApprovalToken } from "./governed-workflow.js";

// One-way content digest of the canonical confirmation seed. Identical shape to governed-workflow's
// `createApprovalToken` (sha256 hex), so the audit's `bindingDigest` validates against the leaf's
// `/^[0-9a-f]{64}$/` pattern. The seed carries committedText transiently; the digest is content-free.
export function createSpokenActionDigest(input: SpokenActionConfirmationInput): string {
  return createHash("sha256")
    .update(canonicalizeSpokenActionConfirmation(input), "utf8")
    .digest("hex");
}

export interface SpokenActionGovernanceParams {
  readonly projection: CommittedVoiceTranscriptProjection;
  readonly profile: VoiceProfile;
  readonly turnIndex: number;
  readonly source: VoiceTranscriptSource;
  readonly request: WorkflowHandoffRequest;
  // The digest the UI captured at the explicit confirm step. Never trusted directly — compared against
  // the digest the server recomputes from the committed projection.
  readonly providedConfirmationDigest: string | undefined;
}

export type SpokenActionDenyReason =
  | "no-voice-capability"
  | "no-committed-transcript"
  | "confirmation-required"
  | "confirmation-stale"
  | "invalid-handoff-request"
  | "approval-token-mismatch";

export type SpokenActionGovernanceDecision =
  | {
      readonly allowed: true;
      readonly request: WorkflowHandoffRequest;
      readonly audit: SpokenActionAuditRecord;
    }
  | {
      readonly allowed: false;
      readonly reason: SpokenActionDenyReason;
      readonly audit: SpokenActionAuditRecord;
    };

// Content-free audit builder shared by every decision path. `state`/`outcome`/`confirmed` describe the
// disposition; no field can carry transcript text because the record type has none.
interface AuditDisposition {
  readonly state: SpokenActionState;
  readonly outcome: SpokenActionOutcome;
  readonly confirmed: boolean;
  readonly bindingDigest: string;
}

function auditFor(
  proposal: SpokenActionProposal,
  disposition: AuditDisposition,
): SpokenActionAuditRecord {
  return buildSpokenActionAuditRecord({
    effectClass: proposal.effectClass,
    state: disposition.state,
    confirmationRequired: proposal.requiresConfirmation,
    confirmed: disposition.confirmed,
    outcome: disposition.outcome,
    source: proposal.source,
    turnIndex: proposal.turnIndex,
    committedSegmentCount: proposal.committedSegmentCount,
    committedChars: proposal.committedChars,
    bindingDigest: disposition.bindingDigest,
  });
}

// Audit for the two pre-proposal denials (no capability / no committed text). There is no proposal yet,
// so the record reports the fail-closed `unknown` effect and a denied outcome with no digest.
function preProposalAudit(
  params: SpokenActionGovernanceParams,
  effectClass: SpokenActionEffectClass,
): SpokenActionAuditRecord {
  return buildSpokenActionAuditRecord({
    effectClass,
    state: "cancelled",
    confirmationRequired: true,
    confirmed: false,
    outcome: "denied",
    source: params.source,
    turnIndex: params.turnIndex,
    committedSegmentCount: params.projection.segmentCount,
    committedChars: params.projection.text.length,
    bindingDigest: "",
  });
}

function deny(
  reason: SpokenActionDenyReason,
  audit: SpokenActionAuditRecord,
): SpokenActionGovernanceDecision {
  return { allowed: false, reason, audit };
}

// Confirmation check (AC3 / AC4). Read-only actions skip confirmation. For confirmation-requiring
// actions: a missing client digest is `confirmation-required`; a present-but-mismatched digest is
// `confirmation-stale` (the committed text / turn / effect changed since the user confirmed).
function checkConfirmation(
  proposal: SpokenActionProposal,
  providedDigest: string | undefined,
  expectedDigest: string,
): SpokenActionDenyReason | undefined {
  if (!proposal.requiresConfirmation) {
    return undefined;
  }
  if (providedDigest === undefined) {
    return "confirmation-required";
  }
  if (providedDigest !== expectedDigest) {
    return "confirmation-stale";
  }
  return undefined;
}

// Deny for a missing/stale confirmation: a stale digest means the committed text / turn / effect changed
// since the user confirmed (`superseded`); a missing digest means confirmation was never given.
function denyConfirmation(
  proposal: SpokenActionProposal,
  reason: SpokenActionDenyReason,
  expectedDigest: string,
): SpokenActionGovernanceDecision {
  const state: SpokenActionState =
    reason === "confirmation-stale" ? "superseded" : "awaiting-confirmation";
  return deny(
    reason,
    auditFor(proposal, {
      state,
      outcome: "denied",
      confirmed: false,
      bindingDigest: expectedDigest,
    }),
  );
}

// Deny after a valid, fresh proposal failed an existing governance gate (invalid handoff / forged token).
// The confirmation step (if any) already passed, so the audit reports `confirmed` per the proposal.
function denyGovernance(
  proposal: SpokenActionProposal,
  reason: SpokenActionDenyReason,
  expectedDigest: string,
): SpokenActionGovernanceDecision {
  return deny(
    reason,
    auditFor(proposal, {
      state: "cancelled",
      outcome: "denied",
      confirmed: proposal.requiresConfirmation,
      bindingDigest: expectedDigest,
    }),
  );
}

// Deterministic, fail-closed decision procedure. Denies on the first failing precondition; every branch
// emits a content-free audit record. Order is normative (see ADR-0066 D4): capability → committed text →
// confirmation freshness → handoff validity → approval-token equality → allow.
export function evaluateSpokenActionGovernance(
  params: SpokenActionGovernanceParams,
): SpokenActionGovernanceDecision {
  if (!voiceCanProposeAction(params.profile)) {
    return deny("no-voice-capability", preProposalAudit(params, "unknown"));
  }
  const proposal = normalizeSpokenActionProposal(
    params.projection,
    params.profile,
    params.turnIndex,
    params.source,
  );
  if (proposal === undefined) {
    return deny("no-committed-transcript", preProposalAudit(params, "unknown"));
  }
  const expectedDigest = createSpokenActionDigest(proposal.confirmationInput);
  const confirmationDeny = checkConfirmation(
    proposal,
    params.providedConfirmationDigest,
    expectedDigest,
  );
  if (confirmationDeny !== undefined) {
    return denyConfirmation(proposal, confirmationDeny, expectedDigest);
  }
  if (!validateWorkflowHandoffRequest(params.request).ok) {
    return denyGovernance(proposal, "invalid-handoff-request", expectedDigest);
  }
  if (
    params.request.userApprovalToken !== createApprovalToken(approvalTokenInputFor(params.request))
  ) {
    return denyGovernance(proposal, "approval-token-mismatch", expectedDigest);
  }
  return {
    allowed: true,
    request: params.request,
    audit: auditFor(proposal, {
      state: "routed",
      outcome: "routed",
      confirmed: proposal.requiresConfirmation,
      bindingDigest: expectedDigest,
    }),
  };
}
