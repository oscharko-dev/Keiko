export const RELEASE_IMPACT_SCHEMA_VERSION = 1 as const;

export const RELEASE_IMPACT_CATEGORIES = [
  "critical-security",
  "update-notes",
  "state-or-compatibility-changes",
  "new-additions",
  "improvements",
  "fixes",
  "ui-polish",
  "internal-only",
] as const;

export type ReleaseImpactCategory = (typeof RELEASE_IMPACT_CATEGORIES)[number];

export const RELEASE_IMPACT_PRIORITIES = ["critical", "high", "normal", "low", "internal"] as const;

export type ReleaseImpactPriority = (typeof RELEASE_IMPACT_PRIORITIES)[number];

export const RELEASE_IMPACT_REMEDIATIONS = [
  "no-action-required",
  "restart-required",
  "repair-required",
  "local-knowledge-reindex-required",
  "migration-required",
  "manual-review-required",
] as const;

export type ReleaseImpactRemediation = (typeof RELEASE_IMPACT_REMEDIATIONS)[number];

export const RELEASE_IMPACT_PUBLISH_GATES = [
  "version-consistency",
  "publish-manifests",
  "release-impact",
  "workspace-supply-chain",
  "package-surface",
  "qi-supply-chain",
  "install-smoke",
] as const;

export type ReleaseImpactPublishGate = (typeof RELEASE_IMPACT_PUBLISH_GATES)[number];

export type ReleaseImpactUserVisibleChange =
  "none" | "observable" | "behavioral" | "security" | "compatibility";

export interface ReleaseImpactStateImpact {
  readonly store: string;
  readonly description: string;
  readonly remediation: ReleaseImpactRemediation;
  readonly userActionRequired: boolean;
}

export interface ReleaseImpactReview {
  readonly status: "pending" | "reviewed";
  readonly reviewer: string;
  readonly reviewedAt: string;
  readonly humanApproved: boolean;
  readonly approvalReference: string;
  readonly rationale: string;
}

export interface ReleaseImpactBreakingException {
  readonly rationale: string;
  readonly warningText: string;
  readonly verifiedCarryForward: boolean;
  readonly carryForwardPath?: string;
}

export interface ReleaseImpactEntry {
  readonly id: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly distTag: "latest";
  readonly registry: "https://registry.npmjs.org/";
  readonly releaseTag: string;
  readonly releaseNoteCategory: ReleaseImpactCategory;
  readonly releaseNotePriority: ReleaseImpactPriority;
  readonly userVisibleChange: ReleaseImpactUserVisibleChange;
  readonly userVisibleSummary: string;
  readonly affectedStateStores: readonly string[];
  readonly stateImpact: readonly ReleaseImpactStateImpact[];
  readonly userActionRequired: boolean;
  readonly remediation: ReleaseImpactRemediation;
  readonly supportedFrom: readonly string[];
  readonly releaseNoteBullets: readonly string[];
  readonly internalOnly: boolean;
  readonly observableImpact: boolean;
  readonly defaultPatchNotes: boolean;
  readonly oneClickEligible: boolean;
  readonly publishGates: readonly ReleaseImpactPublishGate[];
  readonly review: ReleaseImpactReview;
  readonly breakingException?: ReleaseImpactBreakingException;
  readonly correctionOf?: string;
  readonly supersedes?: readonly string[];
  readonly correctionRationale?: string;
}

export interface ReleaseImpactCatalog {
  readonly schemaVersion: typeof RELEASE_IMPACT_SCHEMA_VERSION;
  readonly entries: readonly ReleaseImpactEntry[];
}
