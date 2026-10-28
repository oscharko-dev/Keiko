import type { ReleaseImpactCatalog } from "@oscharko-dev/keiko-contracts";
import { validateBundledCatalog } from "./update-preflight-catalog.js";
import { compareSemver, isRecord } from "./update-preflight-registry.js";

/** Future impact is authoritative only inside the already authenticated release manifest. */
export function portableReleaseImpactCatalog(
  impact: unknown,
  targetVersion: string,
  releaseTrustVerified: boolean,
): ReleaseImpactCatalog | undefined {
  if (!releaseTrustVerified || !isRecord(impact)) return undefined;
  const raw = impact.catalog;
  if (!isRecord(raw) || !Array.isArray(raw.entries)) return undefined;
  const catalog = completeCatalog(raw);
  if (catalog === undefined) return undefined;
  if (
    catalog.entries.some(({ packageVersion }) => compareSemver(packageVersion, targetVersion) > 0)
  )
    return undefined;
  const target = catalog.entries.find(({ id }) => id === impact.entryId);
  if (target?.packageVersion !== targetVersion || target.releaseTag !== `v${targetVersion}`)
    return undefined;
  return catalog;
}

function completeCatalog(raw: Record<string, unknown>): ReleaseImpactCatalog | undefined {
  if (!Array.isArray(raw.entries)) return undefined;
  const catalog = validateBundledCatalog(raw);
  if (catalog?.entries.length !== raw.entries.length) return undefined;
  const ids = new Set(catalog.entries.map(({ id }) => id));
  return ids.size === catalog.entries.length ? catalog : undefined;
}

export function portableImpactMetadataValid(
  impact: unknown,
  catalog: ReleaseImpactCatalog | undefined,
): boolean {
  return !isRecord(impact) || impact.catalog === undefined || catalog !== undefined;
}
