import {
  ActivityLogScanner,
  ensureSegmentManifests,
  listActivityLogStoreFiles,
  type ActivityLogScannerDeps,
  type SegmentManifestPassStats,
} from "./support-segment-scan.js";
import {
  runSupportQuery,
  type SupportQuerySelection,
  type SupportQueryLimits,
  type SupportQueryResult,
} from "./support-query.js";

export function executeLocalSupportQuery(
  stateDir: string,
  selection: SupportQuerySelection,
  limits: SupportQueryLimits,
  options: {
    readonly trigger: "query" | "export";
    readonly scanner?: ActivityLogScannerDeps;
    readonly persist?: boolean;
  },
): { readonly result: SupportQueryResult; readonly manifestStats: SegmentManifestPassStats } {
  const files = listActivityLogStoreFiles(stateDir);
  const scanner = new ActivityLogScanner(stateDir, options.scanner);
  const pass = ensureSegmentManifests(stateDir, files, scanner, {
    trigger: options.trigger,
    persist: options.persist ?? true,
    rebuild: false,
  });
  const result = runSupportQuery({
    files,
    manifests: pass.manifests,
    manifestStats: pass.stats,
    scanner: new ActivityLogScanner(stateDir, options.scanner),
    selection,
    limits,
  });
  return { result, manifestStats: pass.stats };
}
