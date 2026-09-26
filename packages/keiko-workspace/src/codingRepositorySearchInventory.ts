import type { RetrievalQuery } from "@oscharko-dev/keiko-contracts/connected-context";
import { CODING_REPOSITORY_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/coding-repository-search";
import { discoverCandidateInventoryAsync } from "./discovery.js";
import type { WorkspaceFs } from "./fs.js";
import type { SearchScope } from "./repoSearch.js";
import { orderCandidatesForSearch, resolveSearchPolicy } from "./repoSearchPolicy.js";
import type { CandidateSet } from "./repoSearchScan.js";
import type { StructuralExecutionControl } from "./structuralExecution.js";

export async function codingRepositoryInventory(
  scope: SearchScope,
  query: RetrievalQuery,
  fs: WorkspaceFs,
  control: StructuralExecutionControl,
): Promise<CandidateSet> {
  const policy = resolveSearchPolicy(false, { retrievalIntent: "targeted-code-search" });
  const discovered = await discoverCandidateInventoryAsync(
    scope.workspace,
    { maxDepth: 40, maxFiles: CODING_REPOSITORY_LIMITS.inventoryFiles, applyGitignore: true },
    fs,
    control,
  );
  const ordered = orderCandidatesForSearch({
    files: discovered.files,
    query,
    policy,
    ignoredByDiscovery: discovered.stats.ignored,
    deniedByDiscovery: discovered.stats.denied,
    depthPrunedByDiscovery: discovered.stats.depthPruned,
    maxFilesPrunedByDiscovery: discovered.stats.maxFilesPruned,
  });
  return {
    files: ordered.files,
    directories: discovered.directories,
    directorySnapshots: discovered.directorySnapshots,
    skippedSymbolicLinks: discovered.skippedSymbolicLinks,
    truncated: discovered.stats.depthPruned > 0 || discovered.stats.maxFilesPruned > 0,
    diagnostics: { ...ordered.diagnostics, filesDiscovered: discovered.files.length },
  };
}
