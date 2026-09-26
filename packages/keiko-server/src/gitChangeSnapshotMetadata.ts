import type { GitChangeSnapshotContentChange } from "@oscharko-dev/keiko-contracts";
import { GitSnapshotReadError } from "./gitChangeSnapshotReader.js";

export interface SnapshotFileMetadata {
  readonly path: string;
  readonly oldPath?: string;
  readonly change: GitChangeSnapshotContentChange;
  readonly similarity?: number;
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldObjectId: string;
  readonly newObjectId: string;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

const RAW_RECORD = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMDRCT])(\d{0,3})$/u;
type SnapshotStatisticField = "additions" | "deletions" | "binary";
const CHANGE = { A: "add", M: "modify", D: "delete", R: "rename", C: "copy", T: "modify" } as const;

function malformed(): never {
  throw new GitSnapshotReadError("malformed-output");
}

function tokens(input: string): string[] {
  if (input === "") return [];
  if (!input.endsWith("\0") || input.includes("\uFFFD")) return malformed();
  return input.slice(0, -1).split("\0");
}

function pathToken(value: string | undefined): string {
  if (value === undefined || value === "" || value.startsWith("/")) return malformed();
  if (value.split("/").some((part) => part === ".." || part === "." || part === ""))
    return malformed();
  return value;
}

function changeOf(value: string | undefined): GitChangeSnapshotContentChange {
  if (value === undefined || !(value in CHANGE)) return malformed();
  return CHANGE[value as keyof typeof CHANGE];
}

function captureToken(match: RegExpExecArray, index: number): string {
  const value = match[index];
  return value ?? malformed();
}

function rawEntry(
  record: string,
  paths: readonly string[],
): Omit<SnapshotFileMetadata, SnapshotStatisticField> {
  const match = RAW_RECORD.exec(record);
  if (match === null) return malformed();
  const change = changeOf(match[5]);
  const paired = change === "rename" || change === "copy";
  const similarity = Number(match[6]);
  if (paired && (match[6] === "" || similarity > 100)) return malformed();
  return {
    path: pathToken(paths[paired ? 1 : 0]),
    ...(paired ? { oldPath: pathToken(paths[0]), similarity } : {}),
    change,
    oldMode: captureToken(match, 1),
    newMode: captureToken(match, 2),
    oldObjectId: captureToken(match, 3),
    newObjectId: captureToken(match, 4),
  };
}

function parseRaw(
  input: string,
): readonly Omit<SnapshotFileMetadata, "additions" | "deletions" | "binary">[] {
  const parts = tokens(input);
  const entries: Omit<SnapshotFileMetadata, "additions" | "deletions" | "binary">[] = [];
  for (let index = 0; index < parts.length;) {
    const record = parts[index] ?? "";
    const entry = rawEntry(record, parts.slice(index + 1, index + 3));
    entries.push(entry);
    index += entry.oldPath === undefined ? 2 : 3;
  }
  return entries;
}

export function snapshotFileKey(path: string, oldPath?: string): string {
  return `${oldPath ?? ""}\0${path}`;
}

function lineCount(value: string): number {
  if (!/^\d+$/u.test(value)) return malformed();
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : malformed();
}

type Numstat = Pick<SnapshotFileMetadata, "additions" | "deletions" | "binary">;

function numstatEntry(
  parts: readonly string[],
  index: number,
): { readonly key: string; readonly stats: Numstat; readonly consumed: number } {
  const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/u.exec(parts[index] ?? "");
  if (match === null) return malformed();
  const binary = match[1] === "-";
  if (binary !== (match[2] === "-")) return malformed();
  const paired = match[3] === "";
  const oldPath = paired ? pathToken(parts[index + 1]) : undefined;
  const path = pathToken(paired ? parts[index + 2] : match[3]);
  return {
    key: snapshotFileKey(path, oldPath),
    consumed: paired ? 3 : 1,
    stats: {
      binary,
      additions: binary ? 0 : lineCount(captureToken(match, 1)),
      deletions: binary ? 0 : lineCount(captureToken(match, 2)),
    },
  };
}

function parseNumstat(input: string): Map<string, Numstat> {
  const parts = tokens(input);
  const values = new Map<string, Numstat>();
  for (let index = 0; index < parts.length;) {
    const entry = numstatEntry(parts, index);
    if (values.has(entry.key)) return malformed();
    values.set(entry.key, entry.stats);
    index += entry.consumed;
  }
  return values;
}

/** Identity comes only from the NUL-delimited raw lane; numstat must join it one-to-one. */
export function parseSnapshotMetadata(
  raw: string,
  numstat: string,
): readonly SnapshotFileMetadata[] {
  const entries = parseRaw(raw);
  const counts = parseNumstat(numstat);
  if (entries.length !== counts.size) return malformed();
  return entries.map((entry) => {
    const key = snapshotFileKey(entry.path, entry.oldPath);
    const stats = counts.get(key);
    if (stats === undefined) return malformed();
    counts.delete(key);
    return { ...entry, ...stats };
  });
}
