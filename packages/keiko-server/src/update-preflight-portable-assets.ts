import { gatewayFetch, readJsonCapped } from "@oscharko-dev/keiko-model-gateway/internal/http";
import {
  type UpdatePreflightBlocker,
  type UpdatePreflightPortableInstallability,
  type UpdatePreflightReleaseSummary,
  type UpdatePortableTarget,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import { currentGatewayEgressConfig } from "./deps.js";
import { resolvePortableAsset } from "./update-preflight-portable-evidence.js";
import {
  type GitHubAsset,
  type PortableRelease,
  portableBlocker,
  requiredAssetName,
} from "./update-preflight-portable-shared.js";
import {
  compareSemver,
  isRecord,
  isStableVersion,
  validateGitHubRelease,
} from "./update-preflight-registry.js";

const RELEASE_OWNER = "oscharko-dev";
const RELEASE_REPO = "keiko";
const MAX_RELEASE_METADATA_BYTES = 256_000;
const UPDATE_PREFLIGHT_TIMEOUT_MS = 8_000;

interface PortableReleaseMetadata extends PortableRelease {
  readonly release: UpdatePreflightReleaseSummary;
}

type LatestReleaseFetch =
  | {
      readonly status: "ok";
      readonly release: PortableReleaseMetadata;
    }
  | {
      readonly status: "unavailable";
    }
  | {
      readonly status: "malformed";
    };

export type PortableGitHubReleaseOutcome =
  | {
      readonly status: "unavailable" | "malformed";
      readonly warning: string;
      readonly blockers: readonly UpdatePreflightBlocker[];
    }
  | {
      readonly status: "live";
      readonly targetVersion: string;
      readonly release: UpdatePreflightReleaseSummary;
      readonly portableAsset: UpdatePreflightPortableInstallability;
      readonly blockers: readonly UpdatePreflightBlocker[];
      readonly warnings: readonly string[];
    };

function githubLatestReleaseUrl(): string {
  return `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest`;
}

function validDownloadUrl(value: unknown): value is string {
  try {
    if (typeof value !== "string" || value.length === 0) return false;
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseAsset(raw: unknown): GitHubAsset | undefined {
  if (!isRecord(raw)) return undefined;
  const id = positiveInteger(raw.id);
  const name = nonEmptyString(raw.name);
  const size = positiveInteger(raw.size);
  const downloadUrl = raw.browser_download_url;
  if (id === undefined || name === undefined || size === undefined) return undefined;
  if (!validDownloadUrl(downloadUrl)) return undefined;
  return {
    id,
    name,
    size,
    downloadUrl,
  };
}

function parseAssets(raw: unknown): readonly GitHubAsset[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const assets = raw.map(parseAsset);
  return assets.every((asset): asset is GitHubAsset => asset !== undefined) ? assets : undefined;
}

function targetVersionFromTag(tag: unknown): string | undefined {
  if (typeof tag !== "string" || !tag.startsWith("v")) return undefined;
  const version = tag.slice(1);
  return isStableVersion(version) ? version : undefined;
}

function releaseSummary(
  raw: unknown,
  targetVersion: string,
): UpdatePreflightReleaseSummary | undefined {
  const validated = validateGitHubRelease(raw, targetVersion);
  if (validated === undefined) return undefined;
  return {
    source: "github-release",
    tag: validated.tag,
    title: validated.title,
    summary: validated.summary,
    notes: validated.notes,
    ...(validated.noteSections.length > 0 ? { noteSections: validated.noteSections } : {}),
    ...(validated.url !== undefined ? { url: validated.url } : {}),
    ...(validated.publishedAt !== undefined ? { publishedAt: validated.publishedAt } : {}),
  };
}

function validateRelease(raw: unknown): PortableReleaseMetadata | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.draft === true || raw.prerelease === true) return undefined;
  const id = raw.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return undefined;
  const targetVersion = targetVersionFromTag(raw.tag_name);
  if (targetVersion === undefined) return undefined;
  const release = releaseSummary(raw, targetVersion);
  const assets = parseAssets(raw.assets);
  if (release === undefined || assets === undefined) return undefined;
  return { id, targetVersion, release, assets };
}

function unavailableOutcome(): PortableGitHubReleaseOutcome {
  return {
    status: "unavailable",
    warning: "GitHub release asset metadata is unavailable for portable updates.",
    blockers: [
      portableBlocker(
        "portable-release-unavailable",
        "GitHub release asset metadata is unavailable for portable updates.",
      ),
    ],
  };
}

function malformedOutcome(): PortableGitHubReleaseOutcome {
  return {
    status: "malformed",
    warning: "GitHub release asset metadata was malformed for portable updates.",
    blockers: [
      portableBlocker(
        "portable-release-malformed",
        "GitHub release asset metadata was malformed for portable updates.",
      ),
    ],
  };
}

async function fetchLatestRelease(deps: UiHandlerDeps): Promise<LatestReleaseFetch> {
  const response = await gatewayFetch(githubLatestReleaseUrl(), {
    method: "GET",
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Keiko" },
    fetchImpl: deps.gatewayReadinessFetch,
    timeoutMs: UPDATE_PREFLIGHT_TIMEOUT_MS,
    maxResponseBytes: MAX_RELEASE_METADATA_BYTES,
    egress: currentGatewayEgressConfig(deps),
  });
  if (!response.ok) return { status: "unavailable" };
  const release = validateRelease(await readJsonCapped(response, MAX_RELEASE_METADATA_BYTES));
  return release === undefined ? { status: "malformed" } : { status: "ok", release };
}

function notNeededOutcome(
  release: PortableReleaseMetadata,
  target: UpdatePortableTarget,
): PortableGitHubReleaseOutcome {
  return {
    status: "live",
    targetVersion: release.targetVersion,
    release: release.release,
    portableAsset: {
      source: "github-release-asset",
      target,
      requiredAssetName: requiredAssetName(target),
      status: "not-needed",
    },
    blockers: [],
    warnings: [],
  };
}

export async function fetchPortableGitHubReleaseAssets(
  deps: UiHandlerDeps,
  currentVersion: string,
  target: UpdatePortableTarget,
): Promise<PortableGitHubReleaseOutcome> {
  try {
    const result = await fetchLatestRelease(deps);
    if (result.status === "unavailable") return unavailableOutcome();
    if (result.status === "malformed") return malformedOutcome();
    if (compareSemver(result.release.targetVersion, currentVersion) <= 0) {
      return notNeededOutcome(result.release, target);
    }
    const resolution = await resolvePortableAsset(deps, result.release, target);
    return {
      status: "live",
      targetVersion: result.release.targetVersion,
      release: result.release.release,
      portableAsset: resolution.installability,
      blockers: resolution.blockers,
      warnings: resolution.warnings,
    };
  } catch {
    return unavailableOutcome();
  }
}
