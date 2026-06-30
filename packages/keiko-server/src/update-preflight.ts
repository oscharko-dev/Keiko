import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";
import { gatewayFetch, readJsonCapped } from "@oscharko-dev/keiko-model-gateway/internal/http";
import type {
  ReleaseImpactCatalog,
  ReleaseImpactBreakingException,
  ReleaseImpactEntry,
  ReleaseImpactPriority,
  ReleaseImpactPublishGate,
  ReleaseImpactRemediation,
  ReleaseImpactReview,
  ReleaseImpactStateImpact,
  UpdatePreflightBlocker,
  UpdatePreflightImpactEntry,
  UpdatePreflightImpactSummary,
  UpdatePreflightPatchNotes,
  UpdatePreflightReleaseSummary,
  UpdatePreflightReport,
  UpdatePreflightSeverity,
} from "@oscharko-dev/keiko-contracts";
import {
  RELEASE_IMPACT_CATEGORIES,
  RELEASE_IMPACT_PRIORITIES,
  RELEASE_IMPACT_PUBLISH_GATES,
  RELEASE_IMPACT_REMEDIATIONS,
} from "@oscharko-dev/keiko-contracts";
import { UPDATE_PREFLIGHT_SCHEMA_VERSION } from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import { currentGatewayEgressConfig } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";

const PACKAGE_NAME = "@oscharko-dev/keiko";
const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}`;
const RELEASE_OWNER = "oscharko-dev";
const RELEASE_REPO = "keiko";
const MAX_METADATA_BYTES = 256_000;
const UPDATE_PREFLIGHT_TIMEOUT_MS = 8_000;
const DEFAULT_RELEASE_TITLE_PREFIX = "Keiko";
const BULLET_LIMIT = 12;
const REQUIRED_PUBLISH_GATES: readonly ReleaseImpactPublishGate[] = [
  "version-consistency",
  "publish-manifests",
  "release-impact",
  "package-surface",
  "qi-supply-chain",
];
const RUNTIME_APPROVAL_REFERENCE_PATTERN = /^github-pr-review:([^#/\s]+\/[^#/\s]+)#\d+#\d+$/u;
const RELEASE_IMPACT_USER_VISIBLE_CHANGES = [
  "none",
  "observable",
  "behavioral",
  "security",
  "compatibility",
] as const;
const bundledCatalogCache = new Map<string, ReleaseImpactCatalog | undefined>();
const perDepsServices = new WeakMap<UiHandlerDeps, UpdatePreflightService>();

interface UpdatePreflightRuntimeOptions {
  readonly currentVersion?: string;
  readonly bundledCatalog?: ReleaseImpactCatalog | undefined;
  readonly clock?: (() => Date) | undefined;
}

export interface UpdatePreflightService {
  getStartupReport(deps: UiHandlerDeps): Promise<UpdatePreflightReport>;
  runManualCheck(deps: UiHandlerDeps): Promise<UpdatePreflightReport>;
}

interface StableSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: string;
}

interface RegistryOutcome {
  readonly status: "ok" | "unavailable" | "malformed";
  readonly latestVersion?: string;
  readonly warning?: string;
}

interface GitHubReleaseOutcome {
  readonly status: "live" | "unavailable" | "malformed";
  readonly release?: UpdatePreflightReleaseSummary;
  readonly warning?: string;
}

interface CatalogImpactResolution {
  readonly impact?: UpdatePreflightImpactSummary;
  readonly targetReviewed: boolean;
  readonly blockers: readonly UpdatePreflightBlocker[];
  readonly severity: UpdatePreflightSeverity;
}

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

type ReportBase = ReturnType<typeof reportBase>;

interface ValidatedGitHubRelease {
  readonly tag: string;
  readonly title: string;
  readonly summary: string;
  readonly notes: readonly string[];
  readonly url?: string;
  readonly publishedAt?: string;
}

interface NpmMetadata {
  readonly "dist-tags"?: { readonly latest?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

function isEnumValue<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is readonly T[] {
  return Array.isArray(value) && value.every((item) => isEnumValue(item, allowed));
}

function isReleaseImpactStateImpact(value: unknown): value is ReleaseImpactStateImpact {
  return (
    isRecord(value) &&
    isString(value.store) &&
    isString(value.description) &&
    isEnumValue(value.remediation, RELEASE_IMPACT_REMEDIATIONS) &&
    isBoolean(value.userActionRequired)
  );
}

function isReleaseImpactReview(value: unknown): value is ReleaseImpactReview {
  return (
    isRecord(value) &&
    isEnumValue(value.status, ["pending", "reviewed"] as const) &&
    isString(value.reviewer) &&
    isString(value.reviewedAt) &&
    isBoolean(value.humanApproved) &&
    isString(value.approvalReference) &&
    isString(value.rationale)
  );
}

function isReleaseImpactBreakingException(value: unknown): value is ReleaseImpactBreakingException {
  return (
    isRecord(value) &&
    isString(value.rationale) &&
    isString(value.warningText) &&
    isBoolean(value.verifiedCarryForward) &&
    (value.carryForwardPath === undefined || isString(value.carryForwardPath))
  );
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

function isOptionalStringArray(value: unknown): value is readonly string[] | undefined {
  return value === undefined || isStringArray(value);
}

function isOptionalBreakingException(
  value: unknown,
): value is ReleaseImpactBreakingException | undefined {
  return value === undefined || isReleaseImpactBreakingException(value);
}

function parseSemver(version: string): StableSemver | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/u.exec(version);
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] !== undefined ? { prerelease: match[4] } : {}),
  };
}

function isStableVersion(version: string): boolean {
  return parseSemver(version)?.prerelease === undefined;
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a === undefined || b === undefined) {
    return left.localeCompare(right, "en");
  }
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === undefined && b.prerelease === undefined) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en");
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized.length === 0 || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    out.push(normalized);
  }
  return out;
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

function maxSeverity(values: readonly UpdatePreflightSeverity[]): UpdatePreflightSeverity {
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

function blocker(
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

function uniqueBlockers(
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

function impactFromCatalog(
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
  const targetEntries = matching.filter((entry) => entry.packageVersion === targetVersion);
  const supportBlocker = supportedFromBlocker(targetEntries, currentVersion);
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

function extractNotes(body: string): readonly string[] {
  const bullets = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^[*-]\s+/u.test(line))
    .map((line) => normalizeText(line.replace(/^[*-]\s+/u, "")));
  if (bullets.length > 0) {
    return uniqueStrings(bullets).slice(0, BULLET_LIMIT);
  }
  const paragraphs = body
    .split(/\r?\n\r?\n/u)
    .map((paragraph) => normalizeText(paragraph))
    .filter((paragraph) => paragraph.length > 0);
  return paragraphs.slice(0, Math.min(paragraphs.length, BULLET_LIMIT));
}

function optionalGithubUrl(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("https://github.com/") ? value : undefined;
}

function optionalIsoDate(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function releaseName(raw: Record<string, unknown>, targetVersion: string): string {
  const name = typeof raw.name === "string" ? normalizeText(raw.name) : "";
  return name.length > 0 ? name : `${DEFAULT_RELEASE_TITLE_PREFIX} ${targetVersion}`;
}

function validateGitHubRelease(
  raw: unknown,
  targetVersion: string,
): ValidatedGitHubRelease | undefined {
  if (!isRecord(raw)) return undefined;
  const tag = typeof raw.tag_name === "string" ? raw.tag_name.trim() : "";
  if (tag !== `v${targetVersion}`) return undefined;
  const title = releaseName(raw, targetVersion);
  const body = typeof raw.body === "string" ? raw.body : "";
  const notes = extractNotes(body);
  const summary = notes[0] ?? title;
  if (summary.length === 0) return undefined;
  const url = optionalGithubUrl(raw.html_url);
  const publishedAt = optionalIsoDate(raw.published_at);
  return {
    tag,
    title,
    summary,
    notes,
    ...(url !== undefined ? { url } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
  };
}

function githubReleaseUnavailable(): GitHubReleaseOutcome {
  return {
    status: "unavailable",
    warning: "GitHub release metadata is unavailable; bundled release impact will be used.",
  };
}

function githubReleaseMalformed(): GitHubReleaseOutcome {
  return {
    status: "malformed",
    warning: "GitHub release metadata was malformed; bundled release impact will be used.",
  };
}

function liveGithubRelease(release: ValidatedGitHubRelease): GitHubReleaseOutcome {
  return {
    status: "live",
    release: {
      source: "github-release",
      tag: release.tag,
      title: release.title,
      summary: release.summary,
      notes: release.notes,
      ...(release.url !== undefined ? { url: release.url } : {}),
      ...(release.publishedAt !== undefined ? { publishedAt: release.publishedAt } : {}),
    },
  };
}

async function fetchRegistryLatestVersion(
  deps: UiHandlerDeps,
  currentVersion: string,
): Promise<RegistryOutcome> {
  try {
    const response = await gatewayFetch(REGISTRY_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      fetchImpl: deps.gatewayReadinessFetch,
      timeoutMs: UPDATE_PREFLIGHT_TIMEOUT_MS,
      maxResponseBytes: MAX_METADATA_BYTES,
      egress: currentGatewayEgressConfig(deps),
    });
    if (!response.ok) {
      return {
        status: "unavailable",
        warning: "The update registry did not return package metadata.",
      };
    }
    const json = (await readJsonCapped(response, MAX_METADATA_BYTES)) as NpmMetadata;
    const latest = json["dist-tags"]?.latest;
    if (typeof latest !== "string" || parseSemver(latest) === undefined) {
      return { status: "malformed", warning: "The update registry returned malformed metadata." };
    }
    if (!isStableVersion(latest)) {
      return {
        status: "ok",
        latestVersion: currentVersion,
        warning: "The registry latest dist-tag currently points to a prerelease and was ignored.",
      };
    }
    return { status: "ok", latestVersion: latest };
  } catch {
    return { status: "unavailable", warning: "The update registry could not be reached." };
  }
}

function githubReleaseUrl(targetVersion: string): string {
  return `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/tags/v${targetVersion}`;
}

async function fetchGitHubRelease(
  deps: UiHandlerDeps,
  targetVersion: string,
): Promise<GitHubReleaseOutcome> {
  try {
    const response = await gatewayFetch(githubReleaseUrl(targetVersion), {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": DEFAULT_RELEASE_TITLE_PREFIX,
      },
      fetchImpl: deps.gatewayReadinessFetch,
      timeoutMs: UPDATE_PREFLIGHT_TIMEOUT_MS,
      maxResponseBytes: MAX_METADATA_BYTES,
      egress: currentGatewayEgressConfig(deps),
    });
    if (!response.ok) {
      return githubReleaseUnavailable();
    }
    const validated = validateGitHubRelease(
      await readJsonCapped(response, MAX_METADATA_BYTES),
      targetVersion,
    );
    if (validated === undefined) {
      return githubReleaseMalformed();
    }
    return liveGithubRelease(validated);
  } catch {
    return githubReleaseUnavailable();
  }
}

function fallbackReleaseFromImpact(
  targetVersion: string,
  impact: UpdatePreflightImpactSummary | undefined,
): UpdatePreflightReleaseSummary | undefined {
  const targetEntries =
    impact?.entries.filter((entry) => entry.packageVersion === targetVersion) ?? [];
  const latest = targetEntries.at(-1);
  if (latest === undefined) return undefined;
  return {
    source: "bundled-catalog",
    tag: latest.releaseTag,
    title: `${DEFAULT_RELEASE_TITLE_PREFIX} ${targetVersion}`,
    summary: latest.summary,
    notes: uniqueStrings(targetEntries.flatMap((entry) => entry.releaseNoteBullets)),
  };
}

function bundledCatalogSearchRoots(): readonly string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const roots: string[] = [];
  let current = here;
  for (;;) {
    roots.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

function stringFields(entry: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof entry[field] === "string");
}

function booleanFields(entry: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof entry[field] === "boolean");
}

function hasBundledCatalogIdentity(entry: Record<string, unknown>): boolean {
  return (
    isString(entry.id) &&
    stringFields(entry, ["packageName", "packageVersion", "releaseTag", "userVisibleSummary"]) &&
    booleanFields(entry, [
      "internalOnly",
      "observableImpact",
      "defaultPatchNotes",
      "oneClickEligible",
      "userActionRequired",
    ]) &&
    entry.registry === "https://registry.npmjs.org/" &&
    entry.distTag === "latest"
  );
}

function hasBundledCatalogEnums(entry: Record<string, unknown>): boolean {
  return (
    isEnumValue(entry.releaseNoteCategory, RELEASE_IMPACT_CATEGORIES) &&
    isEnumValue(entry.releaseNotePriority, RELEASE_IMPACT_PRIORITIES) &&
    isEnumValue(entry.userVisibleChange, RELEASE_IMPACT_USER_VISIBLE_CHANGES) &&
    isEnumValue(entry.remediation, RELEASE_IMPACT_REMEDIATIONS)
  );
}

function hasBundledCatalogArrays(entry: Record<string, unknown>): boolean {
  return (
    isStringArray(entry.releaseNoteBullets) &&
    isStringArray(entry.affectedStateStores) &&
    isStringArray(entry.supportedFrom) &&
    isEnumArray(entry.publishGates, RELEASE_IMPACT_PUBLISH_GATES) &&
    Array.isArray(entry.stateImpact) &&
    entry.stateImpact.every(isReleaseImpactStateImpact)
  );
}

function hasBundledCatalogOptionalFields(entry: Record<string, unknown>): boolean {
  return (
    isOptionalBreakingException(entry.breakingException) &&
    isOptionalString(entry.correctionOf) &&
    isOptionalString(entry.correctionRationale) &&
    isOptionalStringArray(entry.supersedes)
  );
}

function isBundledCatalogEntry(entry: unknown): entry is ReleaseImpactEntry {
  if (!isRecord(entry)) return false;
  return (
    hasBundledCatalogIdentity(entry) &&
    hasBundledCatalogEnums(entry) &&
    hasBundledCatalogArrays(entry) &&
    isReleaseImpactReview(entry.review) &&
    hasBundledCatalogOptionalFields(entry)
  );
}

function validateBundledCatalog(raw: unknown): ReleaseImpactCatalog | undefined {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.entries)) {
    return undefined;
  }
  const entries = raw.entries.filter(isBundledCatalogEntry);
  return { schemaVersion: 1, entries };
}

function readBundledCatalogFromDisk(): ReleaseImpactCatalog | undefined {
  for (const root of bundledCatalogSearchRoots()) {
    const candidate = join(root, "release-impact.catalog.json");
    if (!existsSync(candidate)) continue;
    const cached = bundledCatalogCache.get(candidate);
    if (cached !== undefined || bundledCatalogCache.has(candidate)) {
      return cached;
    }
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as unknown;
      const validated = validateBundledCatalog(parsed);
      bundledCatalogCache.set(candidate, validated);
      return validated;
    } catch {
      bundledCatalogCache.set(candidate, undefined);
      return undefined;
    }
  }
  return undefined;
}

function warningsOf(...values: readonly (string | undefined)[]): readonly string[] {
  return uniqueStrings(values.filter((value): value is string => typeof value === "string"));
}

function reportBase(
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

function degradedRegistryReport(
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

function currentVersionReport(
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

async function updateAvailableReport(
  deps: UiHandlerDeps,
  base: ReportBase,
  currentVersion: string,
  targetVersion: string,
  registry: RegistryOutcome,
  options: UpdatePreflightRuntimeOptions,
): Promise<UpdatePreflightReport> {
  const catalog = validateBundledCatalog(options.bundledCatalog) ?? readBundledCatalogFromDisk();
  const impactResolution = impactFromCatalog(catalog, currentVersion, targetVersion);
  const github = await fetchGitHubRelease(deps, targetVersion);
  const fallbackRelease = fallbackReleaseFromImpact(targetVersion, impactResolution.impact);
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

export async function runUpdatePreflight(
  deps: UiHandlerDeps,
  options: UpdatePreflightRuntimeOptions = {},
): Promise<UpdatePreflightReport> {
  const currentVersion = options.currentVersion ?? SDK_VERSION;
  const checkedAt = (options.clock?.() ?? new Date()).toISOString();
  const registry = await fetchRegistryLatestVersion(deps, currentVersion);
  const base = reportBase(currentVersion, checkedAt);
  if (registry.status !== "ok" || registry.latestVersion === undefined) {
    return degradedRegistryReport(base, registry);
  }
  if (compareSemver(registry.latestVersion, currentVersion) <= 0) {
    return currentVersionReport(base, registry.latestVersion, registry);
  }
  return updateAvailableReport(
    deps,
    base,
    currentVersion,
    registry.latestVersion,
    registry,
    options,
  );
}

export function createUpdatePreflightService(
  options: UpdatePreflightRuntimeOptions = {},
): UpdatePreflightService {
  let startupPromise: Promise<UpdatePreflightReport> | undefined;
  return {
    getStartupReport(deps): Promise<UpdatePreflightReport> {
      startupPromise ??= runUpdatePreflight(deps, options);
      return startupPromise;
    },
    runManualCheck(deps): Promise<UpdatePreflightReport> {
      return runUpdatePreflight(deps, options);
    },
  };
}

function serviceFor(deps: UiHandlerDeps): UpdatePreflightService {
  const existing = perDepsServices.get(deps);
  if (existing !== undefined) return existing;
  const created = createUpdatePreflightService();
  perDepsServices.set(deps, created);
  return created;
}

export async function handleGetUpdatePreflight(
  _ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return { status: 200, body: await serviceFor(deps).getStartupReport(deps) };
}

export async function handlePostUpdatePreflightCheck(
  _ctx: RouteContext,
  deps: UiHandlerDeps,
): Promise<RouteResult> {
  return { status: 200, body: await serviceFor(deps).runManualCheck(deps) };
}
