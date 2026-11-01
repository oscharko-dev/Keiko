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
    runsOf(numbers).map(([from, to]) => label(project, from, to)),
  );
  return [...ranges, ...[...plain].sort(compareIssueKeys)];
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
