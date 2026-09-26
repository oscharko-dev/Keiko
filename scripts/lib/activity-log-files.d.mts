// Declarations for scripts/lib/activity-log-files.mjs, the repository tooling's one reader of a
// segmented Activity Log, so the e2e support code in the root tsconfig.json strict program can use
// it. The grammar and ordering stay owned by keiko-contracts; this file only types the reader.

export interface ActivityLogToolingFile {
  readonly name: string;
  readonly path: string;
  /** The segment id for a segment (stable across its seal), the file name for a legacy file. */
  readonly key: string;
  readonly sizeBytes: number;
}

export function activityLogDirectory(stateDir: string): string;

export function activityLogFiles(logsDir: string): readonly ActivityLogToolingFile[];

export function readActivityLogText(logsDir: string): string;

export function activityLogSnapshot(logsDir: string): ReadonlyMap<string, number>;

export function readActivityLogSince(
  logsDir: string,
  snapshot: ReadonlyMap<string, number>,
): string;
