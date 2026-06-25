// Commit-intent change summarizer for governed local Git flows (Issue #475, Epic #470).
//
// Maps the content-aware staged path list (from the read-only worktree reader) into the content-free
// `GitCommitChangeSummary` the keiko-contracts analyzer consumes. The path → top-level-area reduction
// happens HERE (in keiko-tools, which may see paths) so the contract leaf stays content-free and the
// pure `analyzeGitCommitIntent` reasons only over counts/flags/structural area tokens.

import type { GitCommitChangeSummary } from "@oscharko-dev/keiko-contracts";

// A staged path is a "test" path when it is under a __tests__ directory or carries a .test/.spec
// suffix on a js/ts source extension. Linear regex (no catastrophic backtracking).
const TEST_PATH = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

// Cap the number of distinct area tokens carried into the content-free summary; the analyzer needs
// the COUNT for mixed-scope detection and the dominant area for the scope suggestion, not an unbounded
// path inventory.
export const MAX_COMMIT_SUMMARY_AREAS = 12;

// The top-level path segment — the structural "area" a change touches (e.g. "packages", "docs"). A
// root-level file (no slash) reports the sentinel "(root)".
function topLevelArea(path: string): string {
  const normalized = path.startsWith("./") ? path.slice(2) : path;
  const slash = normalized.indexOf("/");
  return slash === -1 ? "(root)" : normalized.slice(0, slash);
}

/**
 * Reduces staged relative paths to a content-free change summary. Deterministic and pure.
 */
export function summarizeStagedChangeset(stagedPaths: readonly string[]): GitCommitChangeSummary {
  const areas = new Set<string>();
  let stagedFileCount = 0;
  let touchesTests = false;
  for (const path of stagedPaths) {
    if (path.length === 0) continue;
    stagedFileCount += 1;
    areas.add(topLevelArea(path));
    if (TEST_PATH.test(path)) touchesTests = true;
  }
  return {
    stagedFileCount,
    areaCount: areas.size,
    areas: [...areas].slice(0, MAX_COMMIT_SUMMARY_AREAS),
    touchesTests,
  };
}
