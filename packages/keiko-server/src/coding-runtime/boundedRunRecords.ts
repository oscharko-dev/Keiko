/**
 * A bounded, per-run record of the latest fact Keiko itself established for a run
 * (governedSyncHeads.ts, governedTaskBranches.ts). Records are frozen; the run least recently
 * recorded is forgotten first once `maxRuns` runs are held, so the store stays bounded for the life
 * of the server process.
 */
export interface BoundedRunRecords<T extends { readonly runId: string }> {
  readonly record: (entry: T) => void;
  readonly latest: (runId: string) => T | undefined;
  readonly clear: (runId: string) => void;
}

export function createBoundedRunRecords<T extends { readonly runId: string }>(
  maxRuns: number,
): BoundedRunRecords<T> {
  const entries = new Map<string, T>();
  return {
    record: (entry): void => {
      entries.delete(entry.runId);
      entries.set(entry.runId, Object.freeze({ ...entry }));
      if (entries.size <= maxRuns) return;
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    },
    latest: (runId): T | undefined => entries.get(runId),
    clear: (runId): void => {
      entries.delete(runId);
    },
  };
}
