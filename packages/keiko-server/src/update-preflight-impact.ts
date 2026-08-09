import type {
  ReleaseImpactCatalog,
  ReleaseImpactEntry,
  ReleaseImpactPriority,
  ReleaseImpactPublishGate,
  ReleaseImpactRemediation,
  ReleaseImpactStateImpact,
  UpdatePreflightBlocker,
  UpdatePreflightImpactEntry,
  UpdatePreflightImpactSummary,
  UpdatePreflightSeverity,
} from "@oscharko-dev/keiko-contracts";
import {
  PACKAGE_NAME,
  compareSemver,
  isStableVersion,
  normalizeText,
  uniqueStrings,
} from "./update-preflight-registry.js";

const REQUIRED_PUBLISH_GATES: readonly ReleaseImpactPublishGate[] = [
  "version-consistency",
  "publish-manifests",
  "release-impact",
  "package-surface",
  "qi-supply-chain",
];
// Both artifact forms the publish gate verifies live against the GitHub API before a release may
// go out (scripts/check-release-impact.mjs): a review on the release pull request, and an owner
// comment on the release epic. Accepting only the first here would make a release the gate
// approved look unapproved to the runtime, which withholds the governed one-click update and
// reports the target as missing reviewed metadata (Codex finding on #3054). The runtime checks
// shape only — the live authorship and version-binding checks stay in the publish gate.
const RUNTIME_APPROVAL_REFERENCE_PATTERN =
  /^github-(?:pr-review|issue-comment):([^#/\s]+\/[^#/\s]+)#\d+#\d+$/u;

export interface CatalogImpactResolution {
  readonly impact?: UpdatePreflightImpactSummary;
  readonly targetReviewed: boolean;
  readonly blockers: readonly UpdatePreflightBlocker[];
  readonly severity: UpdatePreflightSeverity;
}

function stateImpactKey(value: ReleaseImpactStateImpact): string {
  return [
    value.store,
    normalizeText(value.description),
    value.remediation,
    value.userActionRequired ? "1" : "0",
  ].join("\u0000");
}

function dedupeStateImpact(
  values: readonly ReleaseImpactStateImpact[],
): readonly ReleaseImpactStateImpact[] {
  const seen = new Set<string>();
  const out: ReleaseImpactStateImpact[] = [];
  for (const value of values) {
    const key = stateImpactKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function remediationsFrom(
  entries: readonly UpdatePreflightImpactEntry[],
): readonly ReleaseImpactRemediation[] {
  const out: ReleaseImpactRemediation[] = [];
  for (const entry of entries) {
    if (!out.includes(entry.remediation)) {
      out.push(entry.remediation);
    }
  }
  return out;
}

function uniqueStores(entries: readonly ReleaseImpactEntry[]): readonly string[] {
  return uniqueStrings(
    entries.flatMap((entry) => [
      ...entry.affectedStateStores,
      ...entry.stateImpact.map((impact) => impact.store),
    ]),
  );
}

function releaseNoteBullets(entry: ReleaseImpactEntry): readonly string[] {
  if (!entry.defaultPatchNotes) return [];
  if (entry.internalOnly && !entry.observableImpact) return [];
  return uniqueStrings(entry.releaseNoteBullets);
}

function releaseMetadataReviewed(entry: ReleaseImpactEntry): boolean {
  return (
    entry.releaseTag === `v${entry.packageVersion}` &&
    entry.review.status === "reviewed" &&
    entry.review.reviewer === "release-owner" &&
    entry.review.humanApproved &&
    RUNTIME_APPROVAL_REFERENCE_PATTERN.test(entry.review.approvalReference) &&
    REQUIRED_PUBLISH_GATES.every((gate) => entry.publishGates.includes(gate))
  );
}

function severityRank(severity: UpdatePreflightSeverity): number {
  return ["none", "low", "normal", "high", "critical"].indexOf(severity);
}

export function maxSeverity(values: readonly UpdatePreflightSeverity[]): UpdatePreflightSeverity {
  return values.reduce<UpdatePreflightSeverity>(
    (max, value) => (severityRank(value) > severityRank(max) ? value : max),
    "none",
  );
}

function severityFromPriority(priority: ReleaseImpactPriority): UpdatePreflightSeverity {
  if (priority === "critical") return "critical";
  if (priority === "high") return "high";
  if (priority === "normal") return "normal";
  return "low";
}

function minimumVersion(values: readonly string[]): string | undefined {
  return values.reduce<string | undefined>(
    (min, value) => (min === undefined || compareSemver(value, min) < 0 ? value : min),
    undefined,
  );
}

function highestVersion(values: readonly string[]): string | undefined {
  return values.reduce<string | undefined>(
    (max, value) => (max === undefined || compareSemver(value, max) > 0 ? value : max),
    undefined,
  );
}

function severityFromEntries(entries: readonly ReleaseImpactEntry[]): UpdatePreflightSeverity {
  return maxSeverity(
    entries.map((entry) => {
      if (
        entry.userActionRequired ||
        entry.stateImpact.some((impact) => impact.userActionRequired)
      ) {
        return maxSeverity(["normal", severityFromPriority(entry.releaseNotePriority)]);
      }
      return severityFromPriority(entry.releaseNotePriority);
    }),
  );
}

export function blocker(
  code: UpdatePreflightBlocker["code"],
  message: string,
  severity: UpdatePreflightSeverity,
  userActionRequired: boolean,
): UpdatePreflightBlocker {
  return { code, message, severity, userActionRequired };
}

function blockerKey(value: UpdatePreflightBlocker): string {
  return `${value.code}\u0000${value.message}`;
}

export function uniqueBlockers(
  values: readonly UpdatePreflightBlocker[],
): readonly UpdatePreflightBlocker[] {
  const seen = new Set<string>();
  const out: UpdatePreflightBlocker[] = [];
  for (const value of values) {
    const key = blockerKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function blockersFromEntries(
  entries: readonly ReleaseImpactEntry[],
): readonly UpdatePreflightBlocker[] {
  return uniqueBlockers(
    entries.flatMap((entry) => {
      const blockers: UpdatePreflightBlocker[] = [];
      if (!entry.oneClickEligible) {
        blockers.push(
          blocker(
            "one-click-ineligible",
            "The target release is not marked eligible for one-click update execution.",
            "normal",
            true,
          ),
        );
      }
      if (entry.remediation === "manual-review-required") {
        blockers.push(
          blocker(
            "manual-review-required",
            "The target release requires manual review before update execution.",
            "high",
            true,
          ),
        );
      }
      if (entry.breakingException !== undefined && !entry.breakingException.verifiedCarryForward) {
        blockers.push(
          blocker(
            "breaking-exception-manual",
            entry.breakingException.warningText,
            "critical",
            true,
          ),
        );
      }
      return blockers;
    }),
  );
}

function supportedFromBlocker(
  entries: readonly ReleaseImpactEntry[],
  currentVersion: string,
): UpdatePreflightBlocker | undefined {
  const floor = highestVersion(
    entries
      .map((entry) => minimumVersion(entry.supportedFrom))
      .filter((value): value is string => value !== undefined),
  );
  if (floor === undefined) {
    return blocker(
      "one-click-ineligible",
      "The target release does not include a reviewed supported forward path.",
      "normal",
      true,
    );
  }
  if (compareSemver(currentVersion, floor) < 0) {
    return blocker(
      "one-click-ineligible",
      `The target release is not eligible for one-click update execution from installed version ${currentVersion}; the reviewed supported forward path starts at ${floor}.`,
      "normal",
      true,
    );
  }
  return undefined;
}

function missingImpactResolution(targetReviewed = false): CatalogImpactResolution {
  return {
    targetReviewed,
    severity: "normal",
    blockers: [
      blocker(
        "release-impact-missing",
        "Reviewed release-impact metadata is not available for the target version.",
        "normal",
        true,
      ),
    ],
  };
}

function matchingImpactEntries(
  catalog: ReleaseImpactCatalog,
  currentVersion: string,
  targetVersion: string,
): readonly ReleaseImpactEntry[] {
  return catalog.entries
    .filter(
      (entry) =>
        releaseMetadataReviewed(entry) &&
        entry.packageName === PACKAGE_NAME &&
        isStableVersion(entry.packageVersion) &&
        compareSemver(entry.packageVersion, currentVersion) > 0 &&
        compareSemver(entry.packageVersion, targetVersion) <= 0,
    )
    .sort((left, right) => compareSemver(left.packageVersion, right.packageVersion));
}

function buildImpactEntry(entry: ReleaseImpactEntry): UpdatePreflightImpactEntry {
  return {
    packageVersion: entry.packageVersion,
    releaseTag: entry.releaseTag,
    summary: normalizeText(entry.userVisibleSummary),
    releaseNoteBullets: releaseNoteBullets(entry),
    stateImpact: dedupeStateImpact(entry.stateImpact),
    userActionRequired:
      entry.userActionRequired || entry.stateImpact.some((item) => item.userActionRequired),
    remediation: entry.remediation,
  };
}

function buildImpactSummary(entries: readonly ReleaseImpactEntry[]): UpdatePreflightImpactSummary {
  const impactEntries = entries.map(buildImpactEntry);
  return {
    entries: impactEntries,
    releaseNoteBullets: uniqueStrings(impactEntries.flatMap((entry) => entry.releaseNoteBullets)),
    stateImpact: dedupeStateImpact(impactEntries.flatMap((entry) => entry.stateImpact)),
    affectedStateStores: uniqueStores(entries),
    userActionRequired: impactEntries.some((entry) => entry.userActionRequired),
    remediations: remediationsFrom(impactEntries),
  };
}

export function impactFromCatalog(
  catalog: ReleaseImpactCatalog | undefined,
  currentVersion: string,
  targetVersion: string,
): CatalogImpactResolution {
  if (catalog === undefined) {
    return missingImpactResolution();
  }
  const matching = matchingImpactEntries(catalog, currentVersion, targetVersion);
  const targetReviewed = matching.some((entry) => entry.packageVersion === targetVersion);
  if (matching.length === 0 || !targetReviewed) {
    return missingImpactResolution(targetReviewed);
  }
  const supportBlocker = supportedFromBlocker(matching, currentVersion);
  return {
    impact: buildImpactSummary(matching),
    targetReviewed,
    severity: severityFromEntries(matching),
    blockers: uniqueBlockers([
      ...blockersFromEntries(matching),
      ...(supportBlocker !== undefined ? [supportBlocker] : []),
    ]),
  };
}
