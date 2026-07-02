import { gatewayFetch, readJsonCapped } from "@oscharko-dev/keiko-model-gateway/internal/http";
import type {
  UpdatePreflightImpactSummary,
  UpdatePreflightReleaseSummary,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import { currentGatewayEgressConfig } from "./deps.js";

export const PACKAGE_NAME = "@oscharko-dev/keiko";
export const REGISTRY_URL = `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}`;
export const RELEASE_OWNER = "oscharko-dev";
export const RELEASE_REPO = "keiko";
export const MAX_METADATA_BYTES = 256_000;
export const UPDATE_PREFLIGHT_TIMEOUT_MS = 8_000;
export const DEFAULT_RELEASE_TITLE_PREFIX = "Keiko";
export const BULLET_LIMIT = 12;

export interface StableSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: string;
}

export interface RegistryOutcome {
  readonly status: "ok" | "unavailable" | "malformed";
  readonly latestVersion?: string;
  readonly warning?: string;
}

export interface GitHubReleaseOutcome {
  readonly status: "live" | "unavailable" | "malformed";
  readonly release?: UpdatePreflightReleaseSummary;
  readonly warning?: string;
}

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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSemver(version: string): StableSemver | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/u.exec(version);
  if (match === null) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] !== undefined ? { prerelease: match[4] } : {}),
  };
}

export function isStableVersion(version: string): boolean {
  return parseSemver(version)?.prerelease === undefined;
}

export function isStableVersionString(value: unknown): value is string {
  return typeof value === "string" && isStableVersion(value);
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a === undefined || b === undefined) {
    throw new TypeError(`Cannot compare malformed semver values: ${left}, ${right}`);
  }
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === undefined && b.prerelease === undefined) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en");
}

export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

export function uniqueStrings(values: readonly string[]): readonly string[] {
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

export function extractNotes(body: string): readonly string[] {
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

export async function fetchRegistryLatestVersion(
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

export async function fetchGitHubRelease(
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

export function fallbackReleaseFromImpact(
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
