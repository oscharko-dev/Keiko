// Property test of the review diff package coverage (Issue #4134, AC2): over generated change sets
// (edits, deletions, renames, mode and type changes, links, gitlinks, binaries, filtered and
// hostile names) and budgets, every changed path appears in exactly one coverage list. The oracle
// is Git's own NUL-separated listing read as raw bytes, independent of the package's quoted-path
// parser. Generation is seeded, so a failure names a reproducible case.

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countContextTokens } from "@oscharko-dev/keiko-contracts/runtime/context-engineering";
import { DiffFixtureRepository, type FixtureEntry } from "./diffFixtures.test-support.js";
import {
  coverageLists,
  numbered,
  packaged,
  reportedPathKey,
} from "./diffPackageAssertions.test-support.js";

let fixture: DiffFixtureRepository;

beforeAll(() => {
  fixture = new DiffFixtureRepository();
});

afterAll(() => {
  fixture.cleanup();
});

/** mulberry32: a small, seeded, deterministic generator. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const LEAVES: readonly (string | Buffer)[] = [
  "a.ts",
  "b.py",
  "c.go",
  "main.java",
  "notes.txt",
  "yarn.lock",
  "app.min.js",
  "api.generated.ts",
  "line\nbreak.ts",
  "tab\tname.kt",
  "-dash.cs",
  "..",
  'quote"s.js',
  "café.ts",
  "café.ts",
  Buffer.from([0x6e, 0xff, 0x2e, 0x74, 0x73]),
  Buffer.from([0x6e, 0xfe, 0x2e, 0x74, 0x73]),
];
const DIRECTORIES: readonly string[] = ["", "src/", "vendor/", "deep/er/"];

type Kind = "text" | "exec" | "binary" | "link" | "gitlink";
const KINDS: readonly Kind[] = ["text", "text", "text", "exec", "binary", "link", "gitlink"];

function pick<T>(random: () => number, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) throw new Error("empty choice");
  return value;
}

function pathOf(random: () => number): Buffer {
  const leaf = pick(random, LEAVES);
  return Buffer.concat([
    Buffer.from(pick(random, DIRECTORIES)),
    Buffer.isBuffer(leaf) ? leaf : Buffer.from(leaf),
  ]);
}

function entry(path: Buffer, kind: Kind, random: () => number): FixtureEntry {
  const salt = String(Math.floor(random() * 1_000_000));
  switch (kind) {
    case "binary":
      return { path, content: Buffer.from([0, 1, 2, ...Buffer.from(salt)]) };
    case "link":
      return { path, content: `../target-${salt}`, mode: "120000" };
    case "gitlink":
      return { path, mode: "160000", gitlink: createHash("sha1").update(salt).digest("hex") };
    case "exec":
      return { path, content: numbered(12, `exec ${salt}`), mode: "100755" };
    default:
      return { path, content: numbered(8 + Math.floor(random() * 40), `text ${salt}`) };
  }
}

function edited(base: FixtureEntry, random: () => number): FixtureEntry | undefined {
  const roll = random();
  if (roll < 0.15) return undefined;
  if (roll < 0.35) return base;
  if (roll < 0.5) return { ...base, mode: base.mode === "100755" ? "100644" : "100755" };
  if (roll < 0.6) return entry(Buffer.from(base.path), "link", random);
  if (typeof base.content === "string") {
    return { ...base, content: base.content.replace(/text \d+ 3\n/u, "changed line\n") };
  }
  return entry(Buffer.from(base.path), pick(random, KINDS), random);
}

function uniqueEntries(random: () => number, count: number, taken: Set<string>): FixtureEntry[] {
  const entries: FixtureEntry[] = [];
  for (let attempt = 0; attempt < count * 4 && entries.length < count; attempt += 1) {
    const path = pathOf(random);
    const key = path.toString("base64");
    if (taken.has(key)) continue;
    taken.add(key);
    entries.push(entry(path, pick(random, KINDS), random));
  }
  return entries;
}

function changeSet(seed: number): { readonly base: string; readonly head: string } {
  const random = generator(seed);
  const taken = new Set<string>();
  const baseEntries = uniqueEntries(random, 2 + Math.floor(random() * 9), taken);
  const headEntries: FixtureEntry[] = [];
  for (const base of baseEntries) {
    const next = edited(base, random);
    if (next === undefined) continue;
    if (random() < 0.15) {
      const renamed = uniqueEntries(random, 1, taken)[0];
      if (renamed !== undefined) headEntries.push({ ...next, path: renamed.path });
      continue;
    }
    headEntries.push(next);
  }
  headEntries.push(...uniqueEntries(random, Math.floor(random() * 4), taken));
  return { base: fixture.commit(baseEntries), head: fixture.commit(headEntries) };
}

/** Git's own changed head paths, as base64 of their bytes, from `-z` output. */
function oracle(base: string, head: string): string[] {
  const output = fixture.gitBytes([
    "diff-tree",
    "-r",
    "-z",
    "-M",
    "-l1000",
    "--raw",
    "--no-abbrev",
    base,
    head,
  ]);
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    fields.push(output.subarray(start, index));
    start = index + 1;
  }
  const keys: string[] = [];
  for (let index = 0; index < fields.length;) {
    const status = (fields[index]?.toString("latin1") ?? "").split(" ").at(-1) ?? "";
    const names = status.startsWith("R") ? 2 : 1;
    keys.push(fields[index + names]?.toString("base64") ?? "");
    index += names + 1;
  }
  return keys;
}

const BUDGETS = [1, 40, 300, 5_000, 200_000];

describe("coverage partition (AC2)", () => {
  it("places every changed path in exactly one list for generated change sets", async () => {
    const seen = new Map<string, number>();
    for (let seed = 1; seed <= 40; seed += 1) {
      const { base, head } = changeSet(seed);
      const expected = oracle(base, head).sort();
      const budgetTokens = BUDGETS[seed % BUDGETS.length] ?? 1;
      const excludedPaths = seed % 3 === 0 ? ["src/"] : [];
      const result = await packaged(fixture, base, head, { budgetTokens, excludedPaths });
      for (const [list, entries] of Object.entries(coverageLists(result.coverage))) {
        seen.set(list, (seen.get(list) ?? 0) + entries.length);
      }
      const reported = Object.values(coverageLists(result.coverage))
        .flat()
        .map(reportedPathKey)
        .sort();
      expect(reported, `seed ${String(seed)}`).toEqual(expected);
      expect(result.coverage.summary.changedFiles, `seed ${String(seed)}`).toBe(expected.length);
      const used = result.text.length === 0 ? 0 : countContextTokens(result.text);
      expect(used, `seed ${String(seed)}`).toBeLessThanOrEqual(budgetTokens);
    }
    // The generated sets exercise every list, so the partition is not proven on a narrow slice.
    for (const list of [
      "included",
      "unprocessed",
      "deletedOnly",
      "filtered",
      "binary",
      "submodule",
      "symlink",
      "modeOnly",
    ]) {
      expect(seen.get(list) ?? 0, list).toBeGreaterThan(0);
    }
  }, 120_000);
});
