import type {
  UpdatePreflightBlocker,
  UpdatePreflightImpactSummary,
  UpdatePreflightPatchNoteSection,
  UpdatePreflightPatchNotes,
  UpdatePreflightPortableInstallability,
  UpdatePreflightReleaseSummary,
  UpdatePreflightReport,
  UpdatePreflightSeverity,
} from "@oscharko-dev/keiko-contracts";
import { UPDATE_PREFLIGHT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";
import { BULLET_LIMIT, normalizeText, uniqueStrings } from "./update-preflight-registry.js";
import type { GitHubReleaseOutcome, RegistryOutcome } from "./update-preflight-registry.js";
import { blocker, maxSeverity, uniqueBlockers } from "./update-preflight-impact.js";
import type { CatalogImpactResolution } from "./update-preflight-impact.js";

interface ReportFields {
  readonly updateAvailable: boolean;
  readonly status: UpdatePreflightReport["status"];
  readonly registryStatus: UpdatePreflightReport["registryStatus"];
  readonly releaseMetadataStatus: UpdatePreflightReport["releaseMetadataStatus"];
  readonly installabilitySource?: UpdatePreflightReport["installabilitySource"];
  readonly portableAsset?: UpdatePreflightPortableInstallability;
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
  const summary = release?.summary ?? patchFallbackSummary(impact, targetVersion);
  const sections = patchSections(release);
  return {
    collapsed: true,
    summary,
    bullets: patchBullets(release, impact, summary),
    ...(sections !== undefined ? { sections } : {}),
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
  summary: string,
): readonly string[] {
  const summaryKey = normalizeText(summary).toLowerCase();
  return uniqueStrings([...(release?.notes ?? []), ...(impact?.releaseNoteBullets ?? [])])
    .filter((note) => normalizeText(note).toLowerCase() !== summaryKey)
    .slice(0, BULLET_LIMIT);
}

function patchSections(
  release: UpdatePreflightReleaseSummary | undefined,
): readonly UpdatePreflightPatchNoteSection[] | undefined {
  const sections = release?.noteSections
    ?.map((section) => ({
      title: normalizeText(section.title),
      bullets: uniqueStrings(section.bullets),
    }))
    .filter((section) => section.title.length > 0 && section.bullets.length > 0);
  return sections !== undefined && sections.length > 0 ? sections : undefined;
}

function patchDetails(impact: UpdatePreflightImpactSummary | undefined): readonly string[] {
  return impact?.entries.map((entry) => `${entry.packageVersion}: ${entry.summary}`) ?? [];
}

const MANUAL_BLOCKER_CODES = new Set<UpdatePreflightBlocker["code"]>([
  "release-impact-missing",
  "manual-review-required",
  "breaking-exception-manual",
  "one-click-ineligible",
  "portable-install-mode-ineligible",
  "portable-release-unavailable",
  "portable-release-malformed",
  "portable-asset-missing",
  "portable-asset-malformed",
  "portable-manifest-missing",
  "portable-manifest-malformed",
  "portable-checksum-missing",
  "portable-checksum-mismatch",
  "portable-sidecar-verification-failed",
]);

function manualRequired(blockers: readonly UpdatePreflightBlocker[]): boolean {
  return blockers.some((item) => item.userActionRequired && MANUAL_BLOCKER_CODES.has(item.code));
}

function optionalReportFields(
  fields: ReportFields,
  patchNotes: UpdatePreflightPatchNotes | undefined,
): Partial<UpdatePreflightReport> {
  return {
    ...(fields.targetVersion !== undefined ? { targetVersion: fields.targetVersion } : {}),
    ...(fields.installabilitySource !== undefined
      ? { installabilitySource: fields.installabilitySource }
      : {}),
    ...(fields.portableAsset !== undefined ? { portableAsset: fields.portableAsset } : {}),
    ...(patchNotes !== undefined ? { patchNotes } : {}),
    ...(fields.release !== undefined ? { release: fields.release } : {}),
    ...(fields.impact !== undefined ? { impact: fields.impact } : {}),
  };
}

function buildReport(base: ReportBase, fields: ReportFields): UpdatePreflightReport {
  const blockers = uniqueBlockers(fields.blockers ?? []);
  const affectedStateStores = fields.impact?.affectedStateStores ?? [];
  const userActionRequired = reportUserActionRequired(fields.impact, blockers);
  const patchNotes = patchNotesFrom(fields.release, fields.impact, fields.targetVersion);
  return {
    ...base,
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
    warnings: fields.warnings ?? [],
    ...optionalReportFields(fields, patchNotes),
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
  if (fields.installabilitySource === "github-release-asset") {
    return (
      fields.updateAvailable &&
      fields.impact !== undefined &&
      fields.portableAsset?.status === "eligible" &&
      blockers.length === 0
    );
  }
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
  github?: GitHubReleaseOutcome,
): UpdatePreflightReport {
  return buildReport(base, {
    targetVersion,
    updateAvailable: false,
    status: "current",
    registryStatus: "ok",
    releaseMetadataStatus:
      github?.release !== undefined ? "live" : (github?.status ?? "not-needed"),
    severity: "none",
    ...(github?.release !== undefined ? { release: github.release } : {}),
    warnings: warningsOf(registry.warning, currentReleaseMetadataWarning(github)),
  });
}

export function portableInstallModeBlockedReport(
  base: ReportBase,
  portableAsset: UpdatePreflightPortableInstallability,
  message: string,
): UpdatePreflightReport {
  return buildReport(base, {
    updateAvailable: false,
    status: "degraded",
    registryStatus: "not-used",
    releaseMetadataStatus: "not-needed",
    installabilitySource: "github-release-asset",
    portableAsset,
    severity: "normal",
    blockers: [blocker("portable-install-mode-ineligible", message, "normal", true)],
    warnings: [],
  });
}

function currentReleaseMetadataWarning(
  github: GitHubReleaseOutcome | undefined,
): string | undefined {
  if (github === undefined || github.release !== undefined) return undefined;
  if (github.status === "malformed") return "Current release notes were malformed.";
  if (github.status === "unavailable") return "Current release notes are unavailable.";
  return undefined;
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

export function portableReleaseUnavailableReport(
  base: ReportBase,
  portableAsset: UpdatePreflightPortableInstallability,
  releaseMetadataStatus: "unavailable" | "malformed",
  blockers: readonly UpdatePreflightBlocker[],
  warnings: readonly string[],
): UpdatePreflightReport {
  return buildReport(base, {
    updateAvailable: false,
    status: "degraded",
    registryStatus: "not-used",
    releaseMetadataStatus,
    installabilitySource: "github-release-asset",
    portableAsset,
    severity: "normal",
    blockers,
    warnings,
  });
}

export function portableCurrentVersionReport(
  base: ReportBase,
  targetVersion: string,
  release: UpdatePreflightReleaseSummary,
  portableAsset: UpdatePreflightPortableInstallability,
  warnings: readonly string[],
): UpdatePreflightReport {
  return buildReport(base, {
    targetVersion,
    updateAvailable: false,
    status: "current",
    registryStatus: "not-used",
    releaseMetadataStatus: "live",
    installabilitySource: "github-release-asset",
    portableAsset,
    severity: "none",
    release,
    warnings,
  });
}

export function portableUpdateAvailableReport(
  base: ReportBase,
  targetVersion: string,
  release: UpdatePreflightReleaseSummary,
  portableAsset: UpdatePreflightPortableInstallability,
  impactResolution: CatalogImpactResolution,
  portableBlockers: readonly UpdatePreflightBlocker[],
  warnings: readonly string[],
): UpdatePreflightReport {
  return buildReport(base, {
    targetVersion,
    updateAvailable: true,
    status: "update-available",
    registryStatus: "not-used",
    releaseMetadataStatus: "live",
    installabilitySource: "github-release-asset",
    portableAsset,
    severity: impactResolution.severity,
    release,
    ...(impactResolution.impact !== undefined ? { impact: impactResolution.impact } : {}),
    blockers: [...impactResolution.blockers, ...portableBlockers],
    warnings,
  });
}
