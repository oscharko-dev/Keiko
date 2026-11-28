/**
 * The workspace paths Keiko's own governed staging and unstaging changed in the Git index for a run
 * during its newest human turn (U-34b). Only RuntimeGitService records them, after a successful
 * index mutation; the undo restores a path in the index only when it is named here, so what the
 * person staged themselves in the Git window while the turn ran is never taken back.
 *
 * The record is bounded: the run least recently written is forgotten first, and a run keeps a
 * bounded number of paths (`truncated` says the cap cut some). A forgotten, cut or restarted record
 * cannot be told from a person's own staging, so the undo reports any changed path it does not name
 * as a closed outcome instead of claiming it restored everything.
 */
export const GOVERNED_INDEX_PATHS_MAX_RUNS = 256;
export const GOVERNED_INDEX_PATHS_MAX_PER_RUN = 20_000;

export interface GovernedIndexRecord {
  readonly paths: readonly string[];
  /** The per-run cap cut paths: the record is known to be incomplete. */
  readonly truncated: boolean;
}

interface Held {
  readonly paths: Set<string>;
  truncated: boolean;
}

const records = new Map<string, Held>();

/** Records the pathspecs one successful governed stage or unstage changed. */
export function noteGovernedIndexPaths(runId: string, pathspecs: readonly string[]): void {
  const held = records.get(runId) ?? { paths: new Set<string>(), truncated: false };
  records.delete(runId);
  for (const pathspec of pathspecs) {
    if (held.paths.size >= GOVERNED_INDEX_PATHS_MAX_PER_RUN) held.truncated = true;
    else held.paths.add(pathspec.replace(/\/+$/u, ""));
  }
  records.set(runId, held);
  if (records.size <= GOVERNED_INDEX_PATHS_MAX_RUNS) return;
  const oldest = records.keys().next().value;
  if (oldest !== undefined) records.delete(oldest);
}

/** What governed staging changed for the run since its newest human turn began. */
export function governedIndexRecord(runId: string): GovernedIndexRecord {
  const held = records.get(runId);
  return { paths: [...(held?.paths ?? [])], truncated: held?.truncated ?? false };
}

/** A new human turn begins: nothing staged before it counts as the turn's. */
export function resetGovernedIndexPaths(runId: string): void {
  records.delete(runId);
}

/** Whether a changed path is one the governed pathspecs name, or lies under a directory they name. */
export function isGovernedIndexPath(path: string, pathspecs: readonly string[]): boolean {
  return pathspecs.some((spec) => path === spec || path.startsWith(`${spec}/`));
}
