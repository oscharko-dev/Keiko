import { compareIssueKeys } from "@oscharko-dev/keiko-contracts/runtime/comparators";

const ISSUE_KEY = /^([A-Z][A-Z0-9_]{0,254})-([1-9]\d{0,17})$/u;

interface Numbered {
  readonly project: string;
  readonly number: number;
}
function numbered(key: string): Numbered | undefined {
  const match = ISSUE_KEY.exec(key);
  const project = match?.[1];
  const number = Number(match?.[2]);
  return project === undefined || !Number.isSafeInteger(number) ? undefined : { project, number };
}
/** The most characters one packed entry of a result's key list holds (the result schema's bound). */
export const KEY_RANGE_ENTRY_CHARS = 600;
/** One entry of a compact result's key list: comma-separated keys and ranges, and how many keys. */
export interface PackedKeys {
  readonly text: string;
  readonly keys: number;
}
interface Run {
  readonly label: string;
  readonly keys: number;
}
function label(project: string, from: number, to: number): string {
  return from === to
    ? `${project}-${String(from)}`
    : `${project}-${String(from)}..${project}-${String(to)}`;
}

/**
 * Exact, compact spelling of a set of issue keys: consecutive keys of one project collapse to
 * `PROJ-3..PROJ-40`, anything else stays a single key. A large draft creates mostly consecutive
 * keys, so the list of everything created stays small without losing a key (#4178).
 */
export function compactIssueKeys(keys: readonly string[]): readonly string[] {
  return compactRuns(keys).map((run) => run.label);
}
function compactRuns(keys: readonly string[]): readonly Run[] {
  const grouped = new Map<string, number[]>();
  const plain = new Set<string>();
  for (const key of keys) {
    const parts = numbered(key);
    if (parts === undefined) plain.add(key);
    else {
      const held = grouped.get(parts.project) ?? [];
      held.push(parts.number);
      grouped.set(parts.project, held);
    }
  }
  const ranges = [...grouped].flatMap(([project, numbers]) =>
    runsOf(numbers).map(([from, to]) => ({ label: label(project, from, to), keys: to - from + 1 })),
  );
  return [...ranges, ...[...plain].sort(compareIssueKeys).map((key) => ({ label: key, keys: 1 }))];
}
/**
 * The same exact spelling, packed several to an entry (`SYN-1,SYN-3,SYN-5..SYN-9`) so that keys
 * which are not consecutive cannot exhaust the result's array ceiling before its byte bound: a
 * thousand scattered keys take a few entries instead of a thousand (#4175, #4178).
 */
export function packIssueKeys(keys: readonly string[]): readonly PackedKeys[] {
  const packed: { text: string; keys: number }[] = [];
  for (const run of compactRuns(keys)) {
    const last = packed.at(-1);
    if (last !== undefined && last.text.length + 1 + run.label.length <= KEY_RANGE_ENTRY_CHARS) {
      last.text += `,${run.label}`;
      last.keys += run.keys;
    } else packed.push({ text: run.label, keys: run.keys });
  }
  return packed;
}
/** Sorted, de-duplicated numbers as inclusive `[from, to]` runs of consecutive values. */
function runsOf(numbers: readonly number[]): readonly (readonly [number, number])[] {
  const runs: [number, number][] = [];
  for (const number of [...new Set(numbers)].sort((left, right) => left - right)) {
    const last = runs.at(-1);
    if (last !== undefined && number === last[1] + 1) last[1] = number;
    else runs.push([number, number]);
  }
  return runs;
}

function entryBytes(entry: PackedKeys): number {
  return Buffer.byteLength(JSON.stringify(entry.text)) + 1;
}
function listedBytes(entries: readonly PackedKeys[]): number {
  return entries.reduce((used, entry) => used + entryBytes(entry), 0);
}
function listedKeys(entries: readonly PackedKeys[]): number {
  return entries.reduce((total, entry) => total + entry.keys, 0);
}
/** The leading entries that fit the byte budget and the array ceiling. */
function leading(entries: readonly PackedKeys[], budget: number, ceiling: number): PackedKeys[] {
  const kept: PackedKeys[] = [];
  let used = 0;
  for (const entry of entries) {
    used += entryBytes(entry);
    if (used > budget || kept.length >= ceiling) break;
    kept.push(entry);
  }
  return kept;
}
export interface ListedIssueKeys {
  readonly created: readonly PackedKeys[];
  readonly existing: readonly PackedKeys[];
  /** Keys the lists could not carry; zero whenever the byte budget holds them all. */
  readonly unlisted: number;
}
/**
 * Both key lists within the remaining result bytes; neither takes more than the other's fair half.
 * Whatever still does not fit is counted in `unlisted`, never dropped without a trace.
 */
export function listIssueKeys(
  keys: { readonly created: readonly string[]; readonly existing: readonly string[] },
  budget: number,
  ceiling: number,
): ListedIssueKeys {
  const created = packIssueKeys(keys.created);
  const existing = packIssueKeys(keys.existing);
  const reserved = Math.min(listedBytes(existing), Math.floor(budget / 2));
  const keptCreated = leading(created, budget - reserved, ceiling);
  const keptExisting = leading(existing, budget - listedBytes(keptCreated), ceiling);
  const unlisted =
    listedKeys(created) -
    listedKeys(keptCreated) +
    (listedKeys(existing) - listedKeys(keptExisting));
  return { created: keptCreated, existing: keptExisting, unlisted };
}
