/**
 * The workspace paths Keiko's own governed staging and unstaging changed in the Git index for a run
 * during its newest human turn (U-34b). Only RuntimeGitService records them, after a successful
 * index mutation; the undo restores a path in the index only when it is named here, so what the
 * person staged themselves in the Git window while the turn ran is never taken back.
 *
 * The record is bounded: the run least recently written is forgotten first, and a run keeps a
 * bounded number of paths. A forgotten run restores nothing in the index, which fails closed.
 */
export const GOVERNED_INDEX_PATHS_MAX_RUNS = 256;
export const GOVERNED_INDEX_PATHS_MAX_PER_RUN = 20_000;

const records = new Map<string, Set<string>>();

/** Records the pathspecs one successful governed stage or unstage changed. */
export function noteGovernedIndexPaths(runId: string, pathspecs: readonly string[]): void {
  const held = records.get(runId) ?? new Set<string>();
  records.delete(runId);
  for (const pathspec of pathspecs) {
    if (held.size >= GOVERNED_INDEX_PATHS_MAX_PER_RUN) break;
    held.add(pathspec.replace(/\/+$/u, ""));
  }
  records.set(runId, held);
  if (records.size <= GOVERNED_INDEX_PATHS_MAX_RUNS) return;
  const oldest = records.keys().next().value;
  if (oldest !== undefined) records.delete(oldest);
}

/** What governed staging changed for the run since its newest human turn began. */
export function governedIndexPaths(runId: string): readonly string[] {
  return [...(records.get(runId) ?? [])];
}

/** A new human turn begins: nothing staged before it counts as the turn's. */
export function resetGovernedIndexPaths(runId: string): void {
  records.delete(runId);
}

/** Whether a changed path is one the governed pathspecs name, or lies under a directory they name. */
export function isGovernedIndexPath(path: string, pathspecs: readonly string[]): boolean {
  return pathspecs.some((spec) => path === spec || path.startsWith(`${spec}/`));
}
