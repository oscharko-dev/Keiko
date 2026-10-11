import type { CandidateFile } from "@oscharko-dev/keiko-contracts/connected-context";
import { compareStrings } from "@oscharko-dev/keiko-contracts/runtime/comparators";
import type { SearchAnchor } from "@oscharko-dev/keiko-workflows";

export interface RankingSelectionObservation {
  readonly basenameCollisionGroupCount: number;
  readonly basenameDedupDemotedCount: number;
  readonly addressedBasenameDedupDemotedCount: number;
  readonly exactPathSignalPresentCount: number;
  readonly pathSegmentSignalPresentCount: number;
  readonly directoryProximityTieBreakCount: number;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).toLowerCase();
}
function parent(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}
function signal(candidate: CandidateFile, name: string): number {
  return candidate.signals.find((entry) => entry.name === name)?.value ?? 0;
}

function isAddressed(
  candidate: CandidateFile,
  anchors: readonly SearchAnchor[],
  paths: ReadonlySet<string>,
): boolean {
  if (paths.has(candidate.scopePath) || signal(candidate, "exact-path-match") > 0) return true;
  const path = candidate.scopePath.toLowerCase();
  return anchors.some(
    (anchor) =>
      anchor.kind === "path" &&
      anchor.weight >= 0.7 &&
      (path === anchor.term.toLowerCase() || path.endsWith(`/${anchor.term.toLowerCase()}`)),
  );
}

function independentUnaddressedCandidates(
  kept: readonly CandidateFile[],
  anchors: readonly SearchAnchor[],
  priorityPaths: Set<string>,
): { readonly candidates: readonly CandidateFile[]; readonly demotedCount: number } {
  const selected = new Set(kept.slice(0, 1));
  for (const anchor of anchors) {
    if (anchor.kind === "literal" || anchor.kind === "path" || anchor.weight < 0.7) continue;
    const term = anchor.term.toLowerCase();
    const candidate =
      [...selected].find((entry) => entry.scopePath.toLowerCase().includes(term)) ??
      kept.find((entry) => entry.scopePath.toLowerCase().includes(term));
    if (candidate !== undefined) {
      selected.add(candidate);
      priorityPaths.add(candidate.scopePath);
    }
  }
  const names = new Set([...selected].map((candidate) => basename(candidate.scopePath)));
  let demotedCount = 0;
  for (const candidate of kept) {
    if (selected.has(candidate)) continue;
    const name = basename(candidate.scopePath);
    if (names.has(name)) {
      demotedCount += 1;
      continue;
    }
    names.add(name);
    selected.add(candidate);
  }
  return {
    candidates: [...selected, ...kept.filter((candidate) => !selected.has(candidate))],
    demotedCount,
  };
}

function pathGroupCounts(
  kept: readonly CandidateFile[],
  group: (path: string) => string,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const candidate of kept) {
    const key = group(candidate.scopePath);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function addressedDemotionCount(
  ordered: readonly CandidateFile[],
  paths: ReadonlySet<string>,
): number {
  const first = ordered.findIndex((candidate) => !paths.has(candidate.scopePath));
  return first < 0
    ? 0
    : ordered.slice(first).filter((candidate) => paths.has(candidate.scopePath)).length;
}

export function orderDistinctEvidenceCandidates(
  kept: readonly CandidateFile[],
  anchors: readonly SearchAnchor[],
  priorityPaths: Set<string>,
  addressedPaths: ReadonlySet<string> = new Set(),
): { readonly kept: readonly CandidateFile[]; readonly observation: RankingSelectionObservation } {
  const parentCounts = pathGroupCounts(kept, parent);
  let proximityTieBreakCount = 0;
  const compare = (a: CandidateFile, b: CandidateFile): number => {
    if (a.score !== b.score) return b.score - a.score;
    const proximity =
      (parentCounts.get(parent(b.scopePath)) ?? 0) - (parentCounts.get(parent(a.scopePath)) ?? 0);
    if (proximity !== 0) {
      proximityTieBreakCount += 1;
      return proximity;
    }
    return (
      signal(b, "path-segment-affinity") - signal(a, "path-segment-affinity") ||
      compareStrings(a.scopePath, b.scopePath)
    );
  };
  const addressed = kept
    .filter((candidate) => isAddressed(candidate, anchors, addressedPaths))
    .sort(compare);
  const paths = new Set(addressed.map((candidate) => candidate.scopePath));
  for (const path of paths) priorityPaths.add(path);
  const unaddressed = independentUnaddressedCandidates(
    kept.filter((candidate) => !paths.has(candidate.scopePath)),
    anchors,
    priorityPaths,
  );
  const ordered = [...addressed, ...unaddressed.candidates];

  return {
    kept: ordered,
    observation: {
      basenameCollisionGroupCount: [...pathGroupCounts(kept, basename).values()].filter(
        (count) => count > 1,
      ).length,
      basenameDedupDemotedCount: unaddressed.demotedCount,
      addressedBasenameDedupDemotedCount: addressedDemotionCount(ordered, paths),
      exactPathSignalPresentCount: kept.filter(
        (candidate) => signal(candidate, "exact-path-match") > 0,
      ).length,
      pathSegmentSignalPresentCount: kept.filter(
        (candidate) => signal(candidate, "path-segment-affinity") > 0,
      ).length,
      directoryProximityTieBreakCount: proximityTieBreakCount,
    },
  };
}

export function orderForDistinctEvidencePaths(
  kept: readonly CandidateFile[],
  anchors: readonly SearchAnchor[],
  priorityPaths: Set<string>,
  addressedPaths: ReadonlySet<string> = new Set(),
): readonly CandidateFile[] {
  return orderDistinctEvidenceCandidates(kept, anchors, priorityPaths, addressedPaths).kept;
}
