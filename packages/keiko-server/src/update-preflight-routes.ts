import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";
import type { ReleaseImpactCatalog, UpdatePreflightReport } from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import {
  compareSemver,
  fallbackReleaseFromImpact,
  fetchGitHubRelease,
  fetchRegistryLatestVersion,
} from "./update-preflight-registry.js";
import { readBundledCatalogFromDisk, validateBundledCatalog } from "./update-preflight-catalog.js";
import { impactFromCatalog } from "./update-preflight-impact.js";
import {
  currentVersionReport,
  degradedRegistryReport,
  reportBase,
  updateAvailableReportFromOutcomes,
} from "./update-preflight-report.js";

interface UpdatePreflightRuntimeOptions {
  readonly currentVersion?: string;
  readonly bundledCatalog?: ReleaseImpactCatalog | undefined;
  readonly clock?: (() => Date) | undefined;
}

export interface UpdatePreflightService {
  getStartupReport(deps: UiHandlerDeps): Promise<UpdatePreflightReport>;
  runManualCheck(deps: UiHandlerDeps): Promise<UpdatePreflightReport>;
}

async function updateAvailableReport(
  deps: UiHandlerDeps,
  base: ReturnType<typeof reportBase>,
  currentVersion: string,
  targetVersion: string,
  registry: Awaited<ReturnType<typeof fetchRegistryLatestVersion>>,
  options: UpdatePreflightRuntimeOptions,
): Promise<UpdatePreflightReport> {
  const catalog = validateBundledCatalog(options.bundledCatalog) ?? readBundledCatalogFromDisk();
  const impactResolution = impactFromCatalog(catalog, currentVersion, targetVersion);
  const github = await fetchGitHubRelease(deps, targetVersion);
  const fallbackRelease = fallbackReleaseFromImpact(targetVersion, impactResolution.impact);
  return updateAvailableReportFromOutcomes(
    base,
    targetVersion,
    registry,
    github,
    fallbackRelease,
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
  const versionComparison = compareSemver(registry.latestVersion, currentVersion);
  if (versionComparison < 0) {
    return currentVersionReport(base, registry.latestVersion, registry);
  }
  if (versionComparison === 0) {
    const github = await fetchGitHubRelease(deps, currentVersion);
    return currentVersionReport(base, registry.latestVersion, registry, github);
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

// Encapsulates the deps->service cache behind a small factory boundary (rather than a bare
// module-global WeakMap) so identity-based test isolation is an explicit contract of this
// module, not an accident of file-scope state.
function createDefaultServiceRegistry(): {
  resolve(deps: UiHandlerDeps): UpdatePreflightService;
} {
  const perDepsServices = new WeakMap<UiHandlerDeps, UpdatePreflightService>();
  return {
    resolve(deps: UiHandlerDeps): UpdatePreflightService {
      const existing = perDepsServices.get(deps);
      if (existing !== undefined) return existing;
      const created = createUpdatePreflightService();
      perDepsServices.set(deps, created);
      return created;
    },
  };
}

const defaultServiceRegistry = createDefaultServiceRegistry();

function serviceFor(deps: UiHandlerDeps): UpdatePreflightService {
  if (deps.updatePreflight !== undefined) return deps.updatePreflight;
  return defaultServiceRegistry.resolve(deps);
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
