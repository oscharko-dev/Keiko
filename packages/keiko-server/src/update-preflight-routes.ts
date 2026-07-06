import { SDK_VERSION } from "@oscharko-dev/keiko-sdk";
import {
  UPDATE_PORTABLE_TARGET_ASSET_NAMES,
  type ReleaseImpactCatalog,
  type UpdateInstallMode,
  type UpdatePreflightPortableInstallability,
  type UpdatePreflightReport,
  type UpdatePortableTarget,
} from "@oscharko-dev/keiko-contracts";
import type { UiHandlerDeps } from "./deps.js";
import type { RouteContext, RouteResult } from "./routes.js";
import { detectUpdateInstallMode, productionUpdateFacts } from "./update-install-mode.js";
import { fetchPortableGitHubReleaseAssets } from "./update-preflight-portable-assets.js";
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
  portableCurrentVersionReport,
  portableInstallModeBlockedReport,
  portableReleaseUnavailableReport,
  portableUpdateAvailableReport,
  reportBase,
  updateAvailableReportFromOutcomes,
} from "./update-preflight-report.js";

interface UpdatePreflightRuntimeOptions {
  readonly currentVersion?: string;
  readonly bundledCatalog?: ReleaseImpactCatalog | undefined;
  readonly clock?: (() => Date) | undefined;
  readonly installMode?: (() => UpdateInstallMode) | undefined;
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

function processEnvFrom(deps: UiHandlerDeps): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(deps.env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function installModeForPreflight(
  deps: UiHandlerDeps,
  options: UpdatePreflightRuntimeOptions,
): UpdateInstallMode {
  if (options.installMode !== undefined) return options.installMode();
  const env = processEnvFrom(deps);
  return detectUpdateInstallMode(productionUpdateFacts(env), env);
}

function isPortableInstallMode(mode: UpdateInstallMode): boolean {
  return mode.installKind?.startsWith("portable-") === true || mode.portable !== undefined;
}

function portableInstallability(
  target: UpdatePortableTarget,
  status: UpdatePreflightPortableInstallability["status"],
): UpdatePreflightPortableInstallability {
  return {
    source: "github-release-asset",
    target,
    requiredAssetName: UPDATE_PORTABLE_TARGET_ASSET_NAMES[target],
    status,
  };
}

async function portablePreflightReport(
  deps: UiHandlerDeps,
  base: ReturnType<typeof reportBase>,
  currentVersion: string,
  target: UpdatePortableTarget,
  options: UpdatePreflightRuntimeOptions,
): Promise<UpdatePreflightReport> {
  const outcome = await fetchPortableGitHubReleaseAssets(deps, currentVersion, target);
  if (outcome.status !== "live") {
    return portableReleaseUnavailableReport(
      base,
      portableInstallability(target, outcome.status === "malformed" ? "malformed" : "unavailable"),
      outcome.status,
      outcome.blockers,
      [outcome.warning],
    );
  }
  if (compareSemver(outcome.targetVersion, currentVersion) <= 0) {
    return portableCurrentVersionReport(
      base,
      outcome.targetVersion,
      outcome.release,
      outcome.portableAsset,
      outcome.warnings,
    );
  }
  const catalog = validateBundledCatalog(options.bundledCatalog) ?? readBundledCatalogFromDisk();
  const impactResolution = impactFromCatalog(catalog, currentVersion, outcome.targetVersion);
  return portableUpdateAvailableReport(
    base,
    outcome.targetVersion,
    outcome.release,
    outcome.portableAsset,
    impactResolution,
    outcome.blockers,
    outcome.warnings,
  );
}

function portableBlockedReport(
  base: ReturnType<typeof reportBase>,
  mode: UpdateInstallMode,
): UpdatePreflightReport {
  const target = mode.portable?.target ?? "windows-x64";
  return portableInstallModeBlockedReport(
    base,
    portableInstallability(target, "install-mode-ineligible"),
    mode.manualInstructions ?? "This portable install is not eligible for in-app self-update.",
  );
}

async function portableModePreflightReport(
  deps: UiHandlerDeps,
  base: ReturnType<typeof reportBase>,
  currentVersion: string,
  mode: UpdateInstallMode,
  options: UpdatePreflightRuntimeOptions,
): Promise<UpdatePreflightReport | undefined> {
  if (mode.status === "supported" && mode.installKind === "portable-managed") {
    const target = mode.portable?.target;
    if (target !== undefined) {
      return portablePreflightReport(deps, base, currentVersion, target, options);
    }
  }
  return isPortableInstallMode(mode) ? portableBlockedReport(base, mode) : undefined;
}

async function packageManagerPreflightReport(
  deps: UiHandlerDeps,
  base: ReturnType<typeof reportBase>,
  currentVersion: string,
  options: UpdatePreflightRuntimeOptions,
): Promise<UpdatePreflightReport> {
  const registry = await fetchRegistryLatestVersion(deps, currentVersion);
  if (registry.status !== "ok" || registry.latestVersion === undefined) {
    return degradedRegistryReport(base, registry);
  }
  const versionComparison = compareSemver(registry.latestVersion, currentVersion);
  if (versionComparison <= 0) {
    const reportedVersion = versionComparison < 0 ? currentVersion : registry.latestVersion;
    const github = await fetchGitHubRelease(deps, reportedVersion);
    return currentVersionReport(base, reportedVersion, registry, github);
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

export async function runUpdatePreflight(
  deps: UiHandlerDeps,
  options: UpdatePreflightRuntimeOptions = {},
): Promise<UpdatePreflightReport> {
  const currentVersion = options.currentVersion ?? SDK_VERSION;
  const checkedAt = (options.clock?.() ?? new Date()).toISOString();
  const base = reportBase(currentVersion, checkedAt);
  const mode = installModeForPreflight(deps, options);
  const portableReport = await portableModePreflightReport(
    deps,
    base,
    currentVersion,
    mode,
    options,
  );
  return portableReport ?? packageManagerPreflightReport(deps, base, currentVersion, options);
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
