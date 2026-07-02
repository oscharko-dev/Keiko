import type {
  UpdatePreflightBlocker,
  UpdatePreflightImpactSummary,
  UpdatePreflightPatchNotes,
  UpdatePreflightReleaseSummary,
  UpdatePreflightReport,
  UpdatePreflightSeverity,
} from "@oscharko-dev/keiko-contracts";
import { UPDATE_PREFLIGHT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";
import { BULLET_LIMIT, uniqueStrings } from "./update-preflight-registry.js";
import type { GitHubReleaseOutcome, RegistryOutcome } from "./update-preflight-registry.js";
import { blocker, maxSeverity, uniqueBlockers } from "./update-preflight-impact.js";
import type { CatalogImpactResolution } from "./update-preflight-impact.js";

interface ReportFields {
  readonly updateAvailable: boolean;
  readonly status: UpdatePreflightReport["status"];
  readonly registryStatus: UpdatePreflightReport["registryStatus"];
  readonly releaseMetadataStatus: UpdatePreflightReport["releaseMetadataStatus"];
  readonly severity: UpdatePreflightSeverity;
  readonly targetVersion?: string;
  readonly release?: UpdatePreflightReleaseSummary;
  readonly impact?: UpdatePreflightImpactSummary;
  readonly blockers?: readonly UpdatePreflightBlocker[];
  readonly warnings?: readonly string[];
}

export type ReportBase = ReturnType<typeof reportBase>;

function warningsOf(...values: readonly (string | undefined)[]): readonly string[] {
  return uniqueStrings(values.filter((value): value is string => typeof value === "string"));
}

export function reportBase(
  currentVersion: string,
  checkedAt: string,
): Omit<
  UpdatePreflightReport,
  | "status"
  | "availabilityState"
  | "severity"
  | "registryStatus"
  | "releaseMetadataStatus"
  | "updateAvailable"
  | "userActionRequired"
  | "affectedStateStores"
  | "blockers"
  | "manualUpdateRequired"
  | "oneClickEligible"
  | "warnings"
> {
  return {
    schemaVersion: UPDATE_PREFLIGHT_SCHEMA_VERSION,
    checkedAt,
    currentVersion,
  };
}

function patchNotesFrom(
  release: UpdatePreflightReleaseSummary | undefined,
  impact: UpdatePreflightImpactSummary | undefined,
  targetVersion: string | undefined,
): UpdatePreflightPatchNotes | undefined {
  if (release === undefined && impact === undefined) return undefined;
  return {
    collapsed: true,
    summary: release?.summary ?? patchFallbackSummary(impact, targetVersion),
    bullets: patchBullets(release, impact),
    details: patchDetails(impact),
  };
}

function patchFallbackSummary(
  impact: UpdatePreflightImpactSummary | undefined,
  targetVersion: string | undefined,
): string {
  const impactSummary = impact?.entries.at(-1)?.summary;
  if (impactSummary !== undefined) return impactSummary;
  if (targetVersion === undefined) return "No update release notes are available.";
  return `Keiko ${targetVersion} update details are not available.`;
}

function patchBullets(
  release: UpdatePreflightReleaseSummary | undefined,
  impact: UpdatePreflightImpactSummary | undefined,
): readonly string[] {
  return uniqueStrings([...(release?.notes ?? []), ...(impact?.releaseNoteBullets ?? [])]).slice(
    0,
    BULLET_LIMIT,
  );
}

function patchDetails(impact: UpdatePreflightImpactSummary | undefined): readonly string[] {
  return impact?.entries.map((entry) => `${entry.packageVersion}: ${entry.summary}`) ?? [];
}

function manualRequired(blockers: readonly UpdatePreflightBlocker[]): boolean {
  return blockers.some(
    (item) =>
      item.code === "release-impact-missing" ||
      item.code === "manual-review-required" ||
      item.code === "breaking-exception-manual" ||
      item.code === "one-click-ineligible",
  );
}

function buildReport(base: ReportBase, fields: ReportFields): UpdatePreflightReport {
  const blockers = uniqueBlockers(fields.blockers ?? []);
  const affectedStateStores = fields.impact?.affectedStateStores ?? [];
  const userActionRequired = reportUserActionRequired(fields.impact, blockers);
  const patchNotes = patchNotesFrom(fields.release, fields.impact, fields.targetVersion);
  return {
    ...base,
    ...(fields.targetVersion !== undefined ? { targetVersion: fields.targetVersion } : {}),
    updateAvailable: fields.updateAvailable,
    status: fields.status,
    availabilityState: fields.status,
    severity: maxSeverity([fields.severity, ...blockers.map((item) => item.severity)]),
    registryStatus: fields.registryStatus,
    releaseMetadataStatus: fields.releaseMetadataStatus,
    userActionRequired,
    affectedStateStores,
    blockers,
    manualUpdateRequired: manualRequired(blockers),
    oneClickEligible: reportOneClickEligible(fields, blockers),
    ...(patchNotes !== undefined ? { patchNotes } : {}),
    ...(fields.release !== undefined ? { release: fields.release } : {}),
    ...(fields.impact !== undefined ? { impact: fields.impact } : {}),
    warnings: fields.warnings ?? [],
  };
}

function reportUserActionRequired(
  impact: UpdatePreflightImpactSummary | undefined,
  blockers: readonly UpdatePreflightBlocker[],
): boolean {
  return impact?.userActionRequired === true || blockers.some((item) => item.userActionRequired);
}

function reportOneClickEligible(
  fields: ReportFields,
  blockers: readonly UpdatePreflightBlocker[],
): boolean {
  return fields.updateAvailable && fields.impact !== undefined && blockers.length === 0;
}

export function degradedRegistryReport(
  base: ReportBase,
  registry: RegistryOutcome,
): UpdatePreflightReport {
  const code = registry.status === "malformed" ? "registry-malformed" : "registry-unavailable";
  return buildReport(base, {
    updateAvailable: false,
    status: "degraded",
    registryStatus: registry.status,
    releaseMetadataStatus: "not-needed",
    severity: "low",
    blockers: [
      blocker(code, registry.warning ?? "The update registry could not be used.", "low", false),
    ],
    warnings: warningsOf(registry.warning),
  });
}

export function currentVersionReport(
  base: ReportBase,
  targetVersion: string,
  registry: RegistryOutcome,
): UpdatePreflightReport {
  return buildReport(base, {
    targetVersion,
    updateAvailable: false,
    status: "current",
    registryStatus: "ok",
    releaseMetadataStatus: "not-needed",
    severity: "none",
    warnings: warningsOf(registry.warning),
  });
}

function updateAvailableWithoutReleaseReport(
  base: ReportBase,
  targetVersion: string,
  registry: RegistryOutcome,
  github: GitHubReleaseOutcome,
  impactResolution: CatalogImpactResolution,
): UpdatePreflightReport {
  return buildReport(base, {
    targetVersion,
    updateAvailable: true,
    status: "update-available",
    registryStatus: "ok",
    releaseMetadataStatus: github.status,
    severity: impactResolution.severity,
    blockers: impactResolution.blockers,
    warnings: warningsOf(registry.warning, github.warning),
  });
}

export function updateAvailableReportFromOutcomes(
  base: ReportBase,
  targetVersion: string,
  registry: RegistryOutcome,
  github: GitHubReleaseOutcome,
  fallbackRelease: UpdatePreflightReleaseSummary | undefined,
  impactResolution: CatalogImpactResolution,
): UpdatePreflightReport {
  if (github.release !== undefined) {
    return buildReport(base, {
      targetVersion,
      updateAvailable: true,
      status: "update-available",
      registryStatus: "ok",
      releaseMetadataStatus: "live",
      severity: impactResolution.severity,
      release: github.release,
      ...(impactResolution.impact !== undefined ? { impact: impactResolution.impact } : {}),
      blockers: impactResolution.blockers,
      warnings: warningsOf(registry.warning),
    });
  }
  if (fallbackRelease !== undefined) {
    return buildReport(base, {
      targetVersion,
      updateAvailable: true,
      status: "update-available",
      registryStatus: "ok",
      releaseMetadataStatus: "fallback",
      severity: impactResolution.severity,
      release: fallbackRelease,
      ...(impactResolution.impact !== undefined ? { impact: impactResolution.impact } : {}),
      blockers: impactResolution.blockers,
      warnings: warningsOf(registry.warning, github.warning),
    });
  }
  return updateAvailableWithoutReleaseReport(
    base,
    targetVersion,
    registry,
    github,
    impactResolution,
  );
}
