/**
 * The workspace paths Keiko's own governed staging and unstaging changed in the Git index for a run
 * during its newest human turn (U-34b), each with the exact index entry the mutation wrote. Only
 * RuntimeGitService records them, after a successful index mutation; the undo restores a path only
 * when it is named here AND the index still holds exactly the entry the mutation wrote. What the
 * person staged themselves in the Git window while or after the turn ran is never taken back, not
 * even for a path Keiko staged too: the person's entry for the same path differs from the recorded
 * one, and the end-of-turn index is never accepted as proof of what Keiko wrote.
 *
 * The record is bounded: the run least recently written is forgotten first, and a run keeps a
 * bounded number of paths (`truncated` says the cap cut some, or that a mutation's entries could
 * not be read). A forgotten, cut or restarted record cannot be told from a person's own staging, so
 * the undo reports any changed path it does not name as a closed outcome instead of claiming it
 * restored everything.
 *
 * Accepted loss: the record is process-global memory, so it holds at most 256 runs and is gone
 * after a server restart. An undo that follows a restart therefore reports `partial` for the
 * turn's staged paths and restores none of them; that fails closed (the person's staging is never
 * guessed away) and costs only a manual unstage, so the record is deliberately not persisted.
 */
export const GOVERNED_INDEX_PATHS_MAX_RUNS = 256;
export const GOVERNED_INDEX_PATHS_MAX_PER_RUN = 20_000;

/** The state of a path no staged change touches: its index entry is HEAD's own. */
export const AT_HEAD = "=head";

export interface GovernedIndexRecord {
  /** The exact paths governed staging changed; never a directory. */
  readonly paths: readonly string[];
  /** The index state each path held right after the governed mutation (`mode oid`, or `=head`). */
  readonly written: ReadonlyMap<string, string>;
  /**
   * The index state each path held right BEFORE the first governed mutation changed it. It is what
   * an undo puts back, so an entry a person staged earlier in the turn is restored, not replaced by
   * the turn-start entry.
   */
  readonly previous: ReadonlyMap<string, string>;
  /** The per-run cap cut paths, or a mutation's entries could not be read: the record is incomplete. */
  readonly truncated: boolean;
}

/** One path one governed mutation changed: the state it left and the state it wrote. */
export interface GovernedIndexTransition {
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

interface Held {
  readonly written: Map<string, string>;
  readonly previous: Map<string, string>;
  /** Paths a person changed between two governed mutations: never recorded again this turn. */
  readonly foreign: Set<string>;
  truncated: boolean;
}

const records = new Map<string, Held>();

function takeHeld(runId: string): Held {
  const held = records.get(runId) ?? {
    written: new Map(),
    previous: new Map(),
    foreign: new Set(),
    truncated: false,
  };
  records.delete(runId);
  return held;
}

function keepHeld(runId: string, held: Held): void {
  records.set(runId, held);
  if (records.size <= GOVERNED_INDEX_PATHS_MAX_RUNS) return;
  const oldest = records.keys().next().value;
  if (oldest !== undefined) records.delete(oldest);
}

function noteTransition(held: Held, { path, before, after }: GovernedIndexTransition): void {
  if (held.foreign.has(path)) return;
  const previous = held.written.get(path);
  if (previous !== undefined && previous !== before) {
    // Someone else changed the entry between two governed mutations: the state to put back cannot
    // be proven, so the path counts as the person's.
    held.written.delete(path);
    held.previous.delete(path);
    held.foreign.add(path);
  } else if (previous !== undefined || held.written.size < GOVERNED_INDEX_PATHS_MAX_PER_RUN) {
    held.written.set(path, after);
    if (previous === undefined) held.previous.set(path, before);
  } else {
    held.truncated = true;
  }
}

/** Records the transitions one successful governed stage or unstage made in the index. */
export function noteGovernedIndexTransitions(
  runId: string,
  transitions: readonly GovernedIndexTransition[],
): void {
  const held = takeHeld(runId);
  for (const transition of transitions) noteTransition(held, transition);
  keepHeld(runId, held);
}

/** A governed mutation succeeded but the entries it wrote could not be read: not provable. */
export function noteGovernedIndexUnproven(runId: string): void {
  const held = takeHeld(runId);
  held.truncated = true;
  keepHeld(runId, held);
}

/** What governed staging changed for the run since its newest human turn began. */
export function governedIndexRecord(runId: string): GovernedIndexRecord {
  const held = records.get(runId);
  return {
    paths: [...(held?.written.keys() ?? [])],
    written: new Map(held?.written ?? []),
    previous: new Map(held?.previous ?? []),
    truncated: held?.truncated ?? false,
  };
}

/** A new human turn begins: nothing staged before it counts as the turn's. */
export function resetGovernedIndexPaths(runId: string): void {
  records.delete(runId);
}

/** Whether a path is one the pathspecs name, or lies under a directory they name. */
export function isGovernedIndexPath(path: string, pathspecs: readonly string[]): boolean {
  return pathspecs.some((spec) => {
    const exact = withoutTrailingSlashes(spec);
    return path === exact || path.startsWith(`${exact}/`);
  });
}

function withoutTrailingSlashes(spec: string): string {
  let end = spec.length;
  while (end > 0 && spec.charAt(end - 1) === "/") end -= 1;
  return spec.slice(0, end);
}
