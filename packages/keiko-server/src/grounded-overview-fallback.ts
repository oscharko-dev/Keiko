import type { ContextCoverageDiagnostics } from "@oscharko-dev/keiko-contracts/connected-context";
import type { SearchResult } from "@oscharko-dev/keiko-workspace";

type Diagnostics = NonNullable<SearchResult["diagnostics"]>;

type UnsupportedPaths = Pick<ContextCoverageDiagnostics, "unrepresentablePathsByDiscovery">;

function combinedUnsupportedPaths(
  first: UnsupportedPaths,
  second: UnsupportedPaths,
): UnsupportedPaths {
  const count =
    (first.unrepresentablePathsByDiscovery ?? 0) + (second.unrepresentablePathsByDiscovery ?? 0);
  return count > 0 ? { unrepresentablePathsByDiscovery: count } : {};
}

function combinedExclusions(
  first: Diagnostics,
  second: Diagnostics,
): Diagnostics["fileExclusionCounts"] {
  const left = first.fileExclusionCounts ?? { binary: 0, oversized: 0, unreadable: 0 };
  const right = second.fileExclusionCounts ?? { binary: 0, oversized: 0, unreadable: 0 };
  return {
    binary: left.binary + right.binary,
    oversized: left.oversized + right.oversized,
    unreadable: left.unreadable + right.unreadable,
  };
}

function combinedCoverage(
  first: ContextCoverageDiagnostics,
  second: ContextCoverageDiagnostics,
): ContextCoverageDiagnostics {
  // These are search-work totals. A path inspected by both operations counts twice.
  return {
    ...second,
    incomplete: first.incomplete || second.incomplete,
    truncated: first.truncated || second.truncated,
    reasons: [...new Set([...first.reasons, ...second.reasons])],
    filesDiscovered: first.filesDiscovered + second.filesDiscovered,
    filesAfterPolicy: first.filesAfterPolicy + second.filesAfterPolicy,
    filesScanned: first.filesScanned + second.filesScanned,
    filesSkipped: first.filesSkipped + second.filesSkipped,
    oversizedFilesScanned: (first.oversizedFilesScanned ?? 0) + (second.oversizedFilesScanned ?? 0),
    lowValueRescueFilesDiscovered:
      (first.lowValueRescueFilesDiscovered ?? 0) + (second.lowValueRescueFilesDiscovered ?? 0),
    lowValueRescueFilesScanned:
      (first.lowValueRescueFilesScanned ?? 0) + (second.lowValueRescueFilesScanned ?? 0),
    ignoredByDiscovery: first.ignoredByDiscovery + second.ignoredByDiscovery,
    deniedByDiscovery: first.deniedByDiscovery + second.deniedByDiscovery,
    ...combinedUnsupportedPaths(first, second),
    depthPrunedByDiscovery: first.depthPrunedByDiscovery + second.depthPrunedByDiscovery,
    maxFilesPrunedByDiscovery: first.maxFilesPrunedByDiscovery + second.maxFilesPrunedByDiscovery,
    matchesReturned: first.matchesReturned + second.matchesReturned,
    elapsedMs: first.elapsedMs + second.elapsedMs,
  };
}

function combinedCandidates(
  first: Diagnostics,
  second: Diagnostics,
): Diagnostics["rankedCandidates"] {
  const ranked = new Map(first.rankedCandidates.map((entry) => [entry.scopePath, entry]));
  for (const entry of second.rankedCandidates) ranked.set(entry.scopePath, entry);
  // Both input detail lists are already bounded by the search producer.
  return [...ranked.values()].sort((left, right) => right.score - left.score);
}

function combinedDiagnostics(first: Diagnostics, second: Diagnostics): Diagnostics {
  const candidateBuckets = { ...first.candidateBuckets };
  for (const key of Object.keys(candidateBuckets) as (keyof typeof candidateBuckets)[]) {
    candidateBuckets[key] += second.candidateBuckets[key];
  }
  return {
    ...second,
    filesDiscovered: first.filesDiscovered + second.filesDiscovered,
    filesAfterPolicy: first.filesAfterPolicy + second.filesAfterPolicy,
    lowValueRescueFilesDiscovered:
      (first.lowValueRescueFilesDiscovered ?? 0) + (second.lowValueRescueFilesDiscovered ?? 0),
    lowValueRescueFilesScanned:
      (first.lowValueRescueFilesScanned ?? 0) + (second.lowValueRescueFilesScanned ?? 0),
    ignoredByDiscovery: first.ignoredByDiscovery + second.ignoredByDiscovery,
    deniedByDiscovery: first.deniedByDiscovery + second.deniedByDiscovery,
    ...combinedUnsupportedPaths(first, second),
    depthPrunedByDiscovery: first.depthPrunedByDiscovery + second.depthPrunedByDiscovery,
    maxFilesPrunedByDiscovery: first.maxFilesPrunedByDiscovery + second.maxFilesPrunedByDiscovery,
    candidateBuckets,
    rankedCandidates: combinedCandidates(first, second),
    lowValuePolicyApplied:
      first.lowValuePolicyApplied === true || second.lowValuePolicyApplied === true,
    fileExclusionCounts: combinedExclusions(first, second),
  };
}

export function mergeOverviewListing(first: SearchResult, listing: SearchResult): SearchResult {
  return {
    ...listing,
    atoms: [...first.atoms, ...listing.atoms],
    candidates: [...first.candidates, ...listing.candidates],
    filesScanned: first.filesScanned + listing.filesScanned,
    oversizedFilesScanned: first.oversizedFilesScanned + listing.oversizedFilesScanned,
    elapsedMs: first.elapsedMs + listing.elapsedMs,
    truncated: first.truncated || listing.truncated,
    workspaceIndex: first.workspaceIndex,
    coverage: combinedCoverage(first.coverage, listing.coverage),
    diagnostics:
      first.diagnostics === undefined || listing.diagnostics === undefined
        ? (first.diagnostics ?? listing.diagnostics)
        : combinedDiagnostics(first.diagnostics, listing.diagnostics),
  };
}
