import type { ReleaseImpactRemediation, ReleaseImpactStateImpact } from "./release-impact.js";
import type { UpdatePortableSidecarSummary, UpdatePortableTarget } from "./update-session.js";

export const UPDATE_PREFLIGHT_SCHEMA_VERSION = 1 as const;

export const UPDATE_PREFLIGHT_STATUSES = ["current", "update-available", "degraded"] as const;

export type UpdatePreflightStatus = (typeof UPDATE_PREFLIGHT_STATUSES)[number];

export const UPDATE_PREFLIGHT_SEVERITIES = ["none", "low", "normal", "high", "critical"] as const;

export type UpdatePreflightSeverity = (typeof UPDATE_PREFLIGHT_SEVERITIES)[number];

export const UPDATE_PREFLIGHT_REGISTRY_STATUSES = [
  "ok",
  "unavailable",
  "malformed",
  "not-used",
] as const;

export type UpdatePreflightRegistryStatus = (typeof UPDATE_PREFLIGHT_REGISTRY_STATUSES)[number];

export const UPDATE_PREFLIGHT_INSTALLABILITY_SOURCES = [
  "npm-registry",
  "github-release-asset",
] as const;

export type UpdatePreflightInstallabilitySource =
  (typeof UPDATE_PREFLIGHT_INSTALLABILITY_SOURCES)[number];

export const UPDATE_PREFLIGHT_PORTABLE_ASSET_STATUSES = [
  "not-needed",
  "eligible",
  "missing",
  "malformed",
  "unavailable",
  "install-mode-ineligible",
] as const;

export type UpdatePreflightPortableAssetStatus =
  (typeof UPDATE_PREFLIGHT_PORTABLE_ASSET_STATUSES)[number];

export const UPDATE_PREFLIGHT_RELEASE_METADATA_STATUSES = [
  "not-needed",
  "live",
  "fallback",
  "unavailable",
  "malformed",
] as const;

export type UpdatePreflightReleaseMetadataStatus =
  (typeof UPDATE_PREFLIGHT_RELEASE_METADATA_STATUSES)[number];

export const UPDATE_PREFLIGHT_RELEASE_SOURCES = ["github-release", "bundled-catalog"] as const;

export type UpdatePreflightReleaseSource = (typeof UPDATE_PREFLIGHT_RELEASE_SOURCES)[number];

export const UPDATE_PREFLIGHT_BLOCKER_CODES = [
  "registry-unavailable",
  "registry-malformed",
  "release-impact-missing",
  "manual-review-required",
  "breaking-exception-manual",
  "one-click-ineligible",
  "portable-install-mode-ineligible",
  "portable-install-managed-externally",
  "portable-release-unavailable",
  "portable-release-malformed",
  "portable-asset-missing",
  "portable-asset-malformed",
  "portable-manifest-missing",
  "portable-manifest-malformed",
  "portable-checksum-missing",
  "portable-checksum-mismatch",
  "portable-signing-unverified",
  "portable-sidecar-verification-failed",
] as const;

export type UpdatePreflightBlockerCode = (typeof UPDATE_PREFLIGHT_BLOCKER_CODES)[number];

export interface UpdatePreflightBlocker {
  readonly code: UpdatePreflightBlockerCode;
  readonly message: string;
  readonly severity: UpdatePreflightSeverity;
  readonly userActionRequired: boolean;
}

export interface UpdatePreflightReleaseSummary {
  readonly source: UpdatePreflightReleaseSource;
  readonly tag: string;
  readonly title: string;
  readonly summary: string;
  readonly notes: readonly string[];
  readonly noteSections?: readonly UpdatePreflightPatchNoteSection[];
  readonly url?: string;
  readonly publishedAt?: string;
}

export interface UpdatePreflightPortableAssetSummary {
  readonly target: UpdatePortableTarget;
  readonly assetName: string;
  readonly assetId: number;
  readonly releaseId: number;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly manifestAssetName: string;
  readonly manifestSha256: string;
  readonly checksumAssetName: string;
  readonly checksumVerified: boolean;
  readonly sidecarRuntimes?: readonly UpdatePortableSidecarSummary[] | undefined;
}

export interface UpdatePreflightPortableInstallability {
  readonly source: "github-release-asset";
  readonly target: UpdatePortableTarget;
  readonly requiredAssetName: string;
  readonly status: UpdatePreflightPortableAssetStatus;
  readonly asset?: UpdatePreflightPortableAssetSummary;
}

export interface UpdatePreflightPatchNoteSection {
  readonly title: string;
  readonly bullets: readonly string[];
}

export interface UpdatePreflightPatchNotes {
  readonly collapsed: true;
  readonly summary: string;
  readonly bullets: readonly string[];
  readonly sections?: readonly UpdatePreflightPatchNoteSection[];
  readonly details: readonly string[];
}

export interface UpdatePreflightImpactEntry {
  readonly packageVersion: string;
  readonly releaseTag: string;
  readonly summary: string;
  readonly releaseNoteBullets: readonly string[];
  readonly stateImpact: readonly ReleaseImpactStateImpact[];
  readonly userActionRequired: boolean;
  readonly remediation: ReleaseImpactRemediation;
}

export interface UpdatePreflightImpactSummary {
  readonly entries: readonly UpdatePreflightImpactEntry[];
  readonly releaseNoteBullets: readonly string[];
  readonly stateImpact: readonly ReleaseImpactStateImpact[];
  readonly affectedStateStores: readonly string[];
  readonly userActionRequired: boolean;
  readonly remediations: readonly ReleaseImpactRemediation[];
}

export interface UpdatePreflightReport {
  readonly schemaVersion: typeof UPDATE_PREFLIGHT_SCHEMA_VERSION;
  readonly checkedAt: string;
  readonly currentVersion: string;
  readonly targetVersion?: string;
  readonly updateAvailable: boolean;
  readonly status: UpdatePreflightStatus;
  readonly availabilityState: UpdatePreflightStatus;
  readonly severity: UpdatePreflightSeverity;
  readonly registryStatus: UpdatePreflightRegistryStatus;
  readonly releaseMetadataStatus: UpdatePreflightReleaseMetadataStatus;
  readonly installabilitySource?: UpdatePreflightInstallabilitySource;
  readonly portableAsset?: UpdatePreflightPortableInstallability;
  readonly userActionRequired: boolean;
  readonly affectedStateStores: readonly string[];
  readonly blockers: readonly UpdatePreflightBlocker[];
  readonly manualUpdateRequired: boolean;
  readonly oneClickEligible: boolean;
  readonly patchNotes?: UpdatePreflightPatchNotes;
  readonly release?: UpdatePreflightReleaseSummary;
  readonly impact?: UpdatePreflightImpactSummary;
  readonly warnings: readonly string[];
}
