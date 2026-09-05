// Coding Workbench automatic description-draft status (Issue #3401, Epic #3384).
//
// The Workbench-facing sibling of #3399's `PrDescriptionApplicationStatus`. Epic #3384 correction 3
// fixes ONE outcome-vocabulary table shared by both descriptions status carriers, so the closed
// state set here (`current | stale | partial | fallback | blocked | failed`) is derived from the
// SAME reason-keyed technique `PR_DESCRIPTION_APPLICATION_REASON_STATES` and
// `GIT_CI_READINESS_REASON_STATES` already use, and is checked at compile time (`satisfies`) to be
// a subset of `PrDescriptionApplicationState` rather than a second, independently drifting union.
//
// Content-free by construction (ADR-0173 D4, epic Architecture Invariants): identity digests, exact
// revision SHAs, a monotonic generation version and the closed state/reason pair only — never a
// title, body, diff, prompt or credential. Produced by the server-owned terminal-run lifecycle hook
// (codingRuntimeDescriptionJobStore.ts / codingRuntimeOrchestrator.ts) and displayed read-only by
// the Workbench UI. #3401 never applies a description (epic correction 1): remote PR-body mutation
// remains #3399's `pull-request` body-only apply lane, reached only through the existing PR preview.

import { isGitObjectId } from "./git-repository.js";
import type { PrDescriptionApplicationState } from "./pr-description-application.js";
import {
  isPrDescriptionArtifact,
  PR_DESCRIPTION_OUTCOMES,
  type PrDescriptionArtifact,
  type PrDescriptionOutcome,
} from "./pr-description.js";

export const WORKBENCH_DESCRIPTION_STATUS_SCHEMA_VERSION = "1" as const;

// `state` is DERIVED from `reason`, never set independently, so a caller can never pair a
// generation reason with the wrong status. `satisfies Record<string, PrDescriptionApplicationState>`
// is the reuse proof: every value here must already be a member of #3399's status vocabulary.
export const WORKBENCH_DESCRIPTION_REASON_STATES = {
  generated: "current",
  "partial-generated": "partial",
  "fallback-generated": "fallback",
  "stale-snapshot": "stale",
  // #3400/#3401 final-audit F1: `authority-expired` has no producer today — the description
  // authority's read port (runtimeAuthorityService.ts's `currentGitDeliveryDescriptionAuthority`)
  // deliberately collapses "no record" and "expired record" into the SAME `undefined` return (its
  // own doc comment: "a changed scope simply finds no record, which is the fail-closed default"),
  // so `admitAndGenerate` (productionCodingRuntimePorts.ts) can only ever observe
  // "model-egress-denied", never this more specific reason. Giving it a real producer needs an
  // expired-vs-absent discriminant on that read port — a change to the authority store itself, out
  // of this item's write scope and actively owned by a concurrent change in this epic. Kept
  // (unlike `pull-request-unavailable` below) because `codingRuntimeDescriptionJobStore.test.ts`
  // already persists it as a valid `WorkbenchDescriptionReason` through `recordBlocked`, ahead of
  // that discriminant landing.
  "authority-expired": "blocked",
  "model-egress-denied": "blocked",
  "budget-exhausted": "blocked",
  "generation-unavailable": "blocked",
  interrupted: "blocked",
  "provider-failed": "failed",
} as const satisfies Record<string, PrDescriptionApplicationState>;

export type WorkbenchDescriptionReason = keyof typeof WORKBENCH_DESCRIPTION_REASON_STATES;
/** Exactly #3399's `PrDescriptionApplicationStatus.state` vocabulary (epic correction 3). */
export type WorkbenchDescriptionState =
  (typeof WORKBENCH_DESCRIPTION_REASON_STATES)[WorkbenchDescriptionReason];

const REASONS = new Set(
  Object.keys(WORKBENCH_DESCRIPTION_REASON_STATES),
) as ReadonlySet<WorkbenchDescriptionReason>;

/**
 * One durable, immutable-per-revision status for the latest description-generation attempt bound
 * to an exact run and head. Never a history: a new head or a new attempt replaces this value
 * wholesale (codingRuntimeDescriptionJobStore.ts owns the CAS revision that enforces that).
 */
export interface WorkbenchDescriptionStatus {
  readonly schemaVersion: typeof WORKBENCH_DESCRIPTION_STATUS_SCHEMA_VERSION;
  readonly runId: string;
  readonly remoteDigest: string;
  readonly baseSha: string;
  readonly headSha: string;
  /** Absent only on legacy records created before execution-binding continuity was recorded. */
  readonly generationBinding?: WorkbenchDescriptionGenerationBinding;
  /** Monotonic per run; increments on every new dispatch (a fresh head or a repaired head). */
  readonly generationVersion: number;
  readonly state: WorkbenchDescriptionState;
  readonly reason: WorkbenchDescriptionReason;
  /** Present only once a #3397 snapshot was captured; null while blocked before capture. */
  readonly snapshotDigest: string | null;
  /** Present only once an artifact was rendered; null while blocked or failed pre-render. */
  readonly draftDigest: string | null;
  /** #3398's own artifact outcome for the rendered draft; null exactly when none was rendered. */
  readonly artifactOutcome: PrDescriptionOutcome | null;
  /**
   * Server-held #3399 proposal for this exact artifact. Removed when restart reconciliation proves
   * the in-memory proposal is no longer available.
   */
  readonly proposalId?: string;
  readonly observedAt: string;
}

/** Transient exact draft review; never durable status or remote-application authority. */
export interface WorkbenchDescriptionDraftReview {
  readonly schemaVersion: typeof WORKBENCH_DESCRIPTION_STATUS_SCHEMA_VERSION;
  readonly proposalId: string;
  readonly expiresAt: string;
  readonly artifact: PrDescriptionArtifact;
}

const DRAFT_REVIEW_KEYS = ["schemaVersion", "proposalId", "expiresAt", "artifact"] as const;

export function isWorkbenchDescriptionDraftReview(
  value: unknown,
): value is WorkbenchDescriptionDraftReview {
  if (!record(value) || Reflect.ownKeys(value).length !== DRAFT_REVIEW_KEYS.length) return false;
  return (
    DRAFT_REVIEW_KEYS.every((key) => Object.hasOwn(value, key)) &&
    value.schemaVersion === WORKBENCH_DESCRIPTION_STATUS_SCHEMA_VERSION &&
    typeof value.proposalId === "string" &&
    RUN_ID.test(value.proposalId) &&
    timestamp(value.expiresAt) &&
    isPrDescriptionArtifact(value.artifact)
  );
}

export interface WorkbenchDescriptionGenerationBinding {
  readonly taskDigest: string;
  readonly authorityDigest: string;
  readonly runtimeBindingDigest: string;
  readonly deliveryBindingDigest: string | null;
}

const DIGEST = /^[a-f0-9]{64}$/u;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const KEYS = [
  "schemaVersion",
  "runId",
  "remoteDigest",
  "baseSha",
  "headSha",
  "generationVersion",
  "state",
  "reason",
  "snapshotDigest",
  "draftDigest",
  "artifactOutcome",
  "observedAt",
];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>): boolean {
  const count =
    KEYS.length +
    (Object.hasOwn(value, "generationBinding") ? 1 : 0) +
    (Object.hasOwn(value, "proposalId") ? 1 : 0);
  return Reflect.ownKeys(value).length === count && KEYS.every((key) => Object.hasOwn(value, key));
}

export function isWorkbenchDescriptionGenerationBinding(
  value: unknown,
): value is WorkbenchDescriptionGenerationBinding {
  if (!record(value) || Reflect.ownKeys(value).length !== 4) return false;
  return (
    ["taskDigest", "authorityDigest", "runtimeBindingDigest"].every(
      (key) => typeof value[key] === "string" && DIGEST.test(value[key]),
    ) && nullableDigest(value.deliveryBindingDigest)
  );
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function nullableDigest(value: unknown): boolean {
  return value === null || (typeof value === "string" && DIGEST.test(value));
}

function validReasonState(value: Record<string, unknown>): boolean {
  if (typeof value.reason !== "string" || !REASONS.has(value.reason as WorkbenchDescriptionReason))
    return false;
  return (
    value.state === WORKBENCH_DESCRIPTION_REASON_STATES[value.reason as WorkbenchDescriptionReason]
  );
}

function validArtifact(value: Record<string, unknown>): boolean {
  if (value.artifactOutcome === null) return value.draftDigest === null;
  return (
    typeof value.artifactOutcome === "string" &&
    (PR_DESCRIPTION_OUTCOMES as readonly string[]).includes(value.artifactOutcome) &&
    typeof value.draftDigest === "string" &&
    DIGEST.test(value.draftDigest)
  );
}

function validProposal(value: Record<string, unknown>): boolean {
  if (!Object.hasOwn(value, "proposalId")) return true;
  return (
    typeof value.proposalId === "string" &&
    RUN_ID.test(value.proposalId) &&
    value.snapshotDigest !== null &&
    value.artifactOutcome !== null &&
    (value.state === "current" || value.state === "partial" || value.state === "fallback")
  );
}

function validIdentity(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === WORKBENCH_DESCRIPTION_STATUS_SCHEMA_VERSION &&
    typeof value.runId === "string" &&
    RUN_ID.test(value.runId) &&
    typeof value.remoteDigest === "string" &&
    DIGEST.test(value.remoteDigest) &&
    isGitObjectId(value.baseSha) &&
    isGitObjectId(value.headSha)
  );
}

function validVersioning(value: Record<string, unknown>): boolean {
  return (
    Number.isSafeInteger(value.generationVersion) &&
    Number(value.generationVersion) >= 1 &&
    nullableDigest(value.snapshotDigest) &&
    timestamp(value.observedAt)
  );
}

export function isWorkbenchDescriptionStatus(value: unknown): value is WorkbenchDescriptionStatus {
  if (!record(value) || !keys(value)) return false;
  return (
    validIdentity(value) &&
    validVersioning(value) &&
    (!Object.hasOwn(value, "generationBinding") ||
      isWorkbenchDescriptionGenerationBinding(value.generationBinding)) &&
    validReasonState(value) &&
    validArtifact(value) &&
    validProposal(value)
  );
}
