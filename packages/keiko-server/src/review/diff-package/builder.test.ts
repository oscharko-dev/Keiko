// The review diff package against real `git` over object-built fixture repositories (Issue #4134):
// hunk context, coverage lists, hostile names, links, gitlinks and binaries.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitProcessRunner } from "@oscharko-dev/keiko-git";
import { reviewDiffCoverageSettlement } from "@oscharko-dev/keiko-contracts/runtime/pull-request-review-rules";
import { buildReviewDiffPackage } from "./builder.js";
import { DiffFixtureRepository, realRunnerDeps } from "./diffFixtures.test-support.js";
import { build, listNames, numbered, packaged } from "./diffPackageAssertions.test-support.js";

let fixture: DiffFixtureRepository;

beforeEach(() => {
  fixture = new DiffFixtureRepository();
});

afterEach(() => {
  fixture.cleanup();
});

describe("hunk context (PR-Agent patch_extra_lines_before = 5, after = 1)", () => {
  it("carries five lines before and one after, with base and head line numbers", async () => {
    const before = numbered(30);
    const after = before.replace("line 15\n", "line fifteen\n");
    const base = fixture.commit([{ path: "src/a.txt", content: before }]);
    const head = fixture.commit([{ path: "src/a.txt", content: after }]);
    const result = await packaged(fixture, base, head);
    expect(result.files[0]?.hunks).toEqual([
      {
        oldStart: 10,
        oldLines: 7,
        newStart: 10,
        newLines: 7,
        lines: [
          " line 10",
          " line 11",
          " line 12",
          " line 13",
          " line 14",
          "-line 15",
          "+line fifteen",
          " line 16",
        ],
      },
    ]);
    expect(result.text).toContain("__new hunk__\n10  line 10\n");
    expect(result.text).toContain("15 +line fifteen\n16  line 16\n__old hunk__\n");
  });

  it("joins changes at most six unchanged lines apart and splits farther ones", async () => {
    const before = numbered(40);
    const near = before.replace("line 10\n", "ten\n").replace("line 17\n", "seventeen\n");
    const far = before.replace("line 10\n", "ten\n").replace("line 18\n", "eighteen\n");
    const base = fixture.commit([{ path: "a.txt", content: before }]);
    const joined = await packaged(
      fixture,
      base,
      fixture.commit([{ path: "a.txt", content: near }]),
    );
    expect(joined.files[0]?.hunks.map((hunk) => [hunk.newStart, hunk.newLines])).toEqual([[5, 14]]);
    const split = await packaged(fixture, base, fixture.commit([{ path: "a.txt", content: far }]));
    expect(split.files[0]?.hunks.map((hunk) => [hunk.newStart, hunk.newLines])).toEqual([
      [5, 7],
      [13, 7],
    ]);
  });

  it("extends a hunk up to its enclosing function header within ten lines", async () => {
    const body = Array.from(
      { length: 8 },
      (_, index) => `  const v${String(index)} = ${String(index)};\n`,
    );
    const source = (value: string): string =>
      `${numbered(3, "// note")}export function alpha(input: number): number {\n${body.join("")}  return input + ${value};\n}\n`;
    const base = fixture.commit([{ path: "src/alpha.ts", content: source("1") }]);
    const head = fixture.commit([{ path: "src/alpha.ts", content: source("2") }]);
    const result = await packaged(fixture, base, head);
    const [hunk] = result.files[0]?.hunks ?? [];
    expect(hunk?.newStart).toBe(4);
    expect(hunk?.lines[0]).toBe(" export function alpha(input: number): number {");
    // The same shape in a language without header detection keeps the plain five lines.
    const plainBase = fixture.commit([{ path: "src/alpha.txt", content: source("1") }]);
    const plainHead = fixture.commit([{ path: "src/alpha.txt", content: source("2") }]);
    const plain = await packaged(fixture, plainBase, plainHead);
    expect(plain.files[0]?.hunks[0]?.newStart).toBe(8);
  });

  it("keeps five lines when the enclosing header is more than ten lines above", async () => {
    const body = Array.from(
      { length: 12 },
      (_, index) => `    x${String(index)} = ${String(index)}\n`,
    );
    const source = (value: string): string =>
      `def beta(value):\n${body.join("")}    return value + ${value}\n`;
    const base = fixture.commit([{ path: "beta.py", content: source("1") }]);
    const head = fixture.commit([{ path: "beta.py", content: source("2") }]);
    const result = await packaged(fixture, base, head);
    expect(result.files[0]?.hunks[0]?.newStart).toBe(9);
  });

  it("packages an added file as one hunk numbered from line 1", async () => {
    const base = fixture.commit([{ path: "keep.txt", content: "keep\n" }]);
    const head = fixture.commit([
      { path: "keep.txt", content: "keep\n" },
      { path: "src/new.ts", content: "export const a = 1;\nexport const b = 2;" },
    ]);
    const result = await packaged(fixture, base, head);
    expect(result.files[0]?.hunks).toEqual([
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 2,
        lines: ["+export const a = 1;", "+export const b = 2;", "\\ No newline at end of file"],
      },
    ]);
    expect(result.text).toContain("## File: 'src/new.ts' (new file)\n");
  });
});

describe("coverage lists", () => {
  it("places every kind of change in exactly one list with its closed reason", async () => {
    const shared = numbered(20, "shared");
    const base = fixture.commit([
      { path: "src/mod.ts", content: numbered(10) },
      { path: "src/gone.ts", content: "gone\n" },
      { path: "src/old-name.ts", content: shared },
      { path: "src/same.ts", content: "same content\n" },
      { path: "run.sh", content: "echo hi\n" },
      { path: "link", content: "target-a", mode: "120000" },
      { path: "sub", mode: "160000", gitlink: "a".repeat(40) },
      { path: "package-lock.json", content: "{}\n" },
      { path: "dist/app.min.js", content: "a()\n" },
      { path: "src/api.generated.ts", content: "a\n" },
      { path: "vendor/lib.js", content: "a\n" },
      { path: "docs/skip.md", content: "a\n" },
      { path: "img.bin", content: Buffer.from([0, 1, 2, 3]) },
    ]);
    const head = fixture.commit([
      { path: "src/mod.ts", content: numbered(10).replace("line 5", "five") },
      { path: "src/new-name.ts", content: shared.replace("shared 20", "twenty") },
      { path: "src/moved.ts", content: "same content\n" },
      { path: "run.sh", content: "echo hi\n", mode: "100755" },
      { path: "link", content: "target-b", mode: "120000" },
      { path: "sub", mode: "160000", gitlink: "b".repeat(40) },
      { path: "package-lock.json", content: '{"a":1}\n' },
      { path: "dist/app.min.js", content: "b()\n" },
      { path: "src/api.generated.ts", content: "b\n" },
      { path: "vendor/lib.js", content: "b\n" },
      { path: "docs/skip.md", content: "b\n" },
      { path: "img.bin", content: Buffer.from([0, 1, 2, 4]) },
      { path: "src/added.ts", content: "export {};\n" },
      { path: "empty.txt", content: "" },
    ]);
    const { coverage } = await packaged(fixture, base, head, {
      budgetTokens: 100_000,
      excludedPaths: ["docs/"],
    });
    const expected: Record<string, string> = {
      "src/mod.ts": "included",
      "src/gone.ts": "deletedOnly",
      "src/new-name.ts": "included",
      "src/moved.ts": "included",
      "run.sh": "modeOnly",
      link: "symlink",
      sub: "submodule",
      "package-lock.json": "filtered",
      "dist/app.min.js": "filtered",
      "src/api.generated.ts": "filtered",
      "vendor/lib.js": "filtered",
      "docs/skip.md": "filtered",
      "img.bin": "binary",
      "src/added.ts": "included",
      "empty.txt": "included",
    };
    for (const [path, list] of Object.entries(expected)) {
      expect(listNames(coverage, path), path).toEqual([list]);
    }
    expect(coverage.summary.changedFiles).toBe(Object.keys(expected).length);
    expect(coverage.filtered.map((file) => [file.path, file.reason])).toEqual([
      ["dist/app.min.js", "minified"],
      ["docs/skip.md", "review-config-excluded"],
      ["package-lock.json", "lockfile"],
      ["src/api.generated.ts", "generated"],
      ["vendor/lib.js", "vendored"],
    ]);
    const renamed = coverage.included.find((file) => file.path === "src/new-name.ts");
    expect(renamed).toMatchObject({ status: "renamed", previousPath: "src/old-name.ts" });
    const moved = coverage.included.find((file) => file.path === "src/moved.ts");
    expect(moved).toMatchObject({ status: "renamed", hunkCount: 0, partial: false });
    expect(reviewDiffCoverageSettlement(coverage)).toEqual({ kind: "reviewable" });
  });

  it("settles a change set with nothing reviewable as no-reviewable-changes", async () => {
    const base = fixture.commit([
      { path: "yarn.lock", content: "a\n" },
      { path: "x.txt", content: "x\n" },
    ]);
    const head = fixture.commit([{ path: "yarn.lock", content: "b\n" }]);
    const { coverage } = await packaged(fixture, base, head);
    expect(coverage.included).toEqual([]);
    expect(reviewDiffCoverageSettlement(coverage)).toEqual({
      kind: "skipped",
      reason: "no-reviewable-changes",
    });
  });
});

describe("hostile file names (AC4)", () => {
  const NON_UTF8 = Buffer.from([0x62, 0xff, 0xfe, 0x2e, 0x74, 0x73]);
  const NAMES = [
    "line\nbreak.ts",
    "tab\there.ts",
    "-rf.ts",
    "--end-of-options",
    "quote\"and'apostrophe.ts",
    "back\\slash.ts",
    "café.ts",
    "café.ts",
    "dir/../escape.ts",
    "\u202eevil.ts",
    `${"long/".repeat(60)}${"n".repeat(200)}.ts`,
  ];

  it("reports every name verbatim without injection, escape or crash", async () => {
    const base = fixture.commit([{ path: "anchor.txt", content: "a\n" }]);
    const head = fixture.commit([
      { path: "anchor.txt", content: "a\n" },
      ...NAMES.map((path) => ({ path, content: `content of ${String(path.length)}\n` })),
      { path: NON_UTF8, content: "bytes\n" },
    ]);
    const { coverage, text } = await packaged(fixture, base, head);
    const included = coverage.included;
    for (const name of NAMES) {
      const matches = included.filter((file) => file.path === name);
      expect(matches, JSON.stringify(name)).toHaveLength(1);
      expect(matches[0]?.pathBytesBase64).toBeUndefined();
    }
    const nonUtf8 = included.filter((file) => file.pathBytesBase64 !== undefined);
    expect(nonUtf8).toHaveLength(1);
    expect(Buffer.from(nonUtf8[0]?.pathBytesBase64 ?? "", "base64")).toEqual(NON_UTF8);
    expect(nonUtf8[0]?.path).toBe("b\uFFFD\uFFFD.ts");
    expect(included).toHaveLength(NAMES.length + 1);
    // No name can end a header line or forge another file section in the reviewer's text.
    const headers = text.split("\n").filter((line) => line.startsWith("## File: "));
    expect(headers).toHaveLength(NAMES.length + 1);
    expect(text).not.toContain("line\nbreak");
    expect(text).toContain("## File: 'line\\nbreak.ts' (new file)\n");
    expect(text).toContain("## File: '\\u202eevil.ts' (new file)\n");
    expect(text).toContain("## File: 'quote\"and\\'apostrophe.ts' (new file)\n");
  });

  it("keeps two names that differ only in invalid bytes apart", async () => {
    const base = fixture.commit([{ path: "anchor.txt", content: "a\n" }]);
    const head = fixture.commit([
      { path: "anchor.txt", content: "a\n" },
      { path: Buffer.from([0x78, 0xfe]), content: "one\n" },
      { path: Buffer.from([0x78, 0xff]), content: "two\n" },
    ]);
    const { coverage } = await packaged(fixture, base, head);
    expect(coverage.included.map((file) => file.path)).toEqual(["x\uFFFD", "x\uFFFD"]);
    expect(new Set(coverage.included.map((file) => file.pathBytesBase64)).size).toBe(2);
  });
});

describe("links, gitlinks and binaries (AC5)", () => {
  function recording(calls: string[][]): (runner: GitProcessRunner) => GitProcessRunner {
    return (runner) => (args, options) => {
      calls.push([...args]);
      return runner(args, options);
    };
  }

  it("reports a link as symlink without following it", async () => {
    const secret = join(fixture.root, "secret.txt");
    writeFileSync(secret, "TOP-SECRET-CONTENT\n");
    const base = fixture.commit([{ path: "escape", content: "a.txt", mode: "120000" }]);
    const head = fixture.commit([{ path: "escape", content: secret, mode: "120000" }]);
    const result = await packaged(fixture, base, head);
    expect(result.coverage.symlink.map((file) => file.path)).toEqual(["escape"]);
    expect(result.text).not.toContain("TOP-SECRET");
    expect(result.text).not.toContain(secret);
  });

  it("reports a gitlink as submodule without reading the submodule", async () => {
    const calls: string[][] = [];
    const missing = "c".repeat(40);
    const base = fixture.commit([{ path: "x.txt", content: "x\n" }]);
    const head = fixture.commit([
      { path: "x.txt", content: "x\n" },
      { path: "deps/lib", mode: "160000", gitlink: missing },
    ]);
    const result = await buildReviewDiffPackage(realRunnerDeps({}, recording(calls)), {
      repositoryRoot: fixture.repo,
      baseSha: base,
      headSha: head,
      config: { budgetTokens: 1_000 },
    });
    expect(result.ok && result.package.coverage.submodule.map((file) => file.path)).toEqual([
      "deps/lib",
    ]);
    expect(calls.some((args) => args.includes(missing))).toBe(false);
  });

  it("reports binaries without diffing them and a giant text file as too-large", async () => {
    const calls: string[][] = [];
    const bigBinary = Buffer.concat([Buffer.from([0]), Buffer.alloc(64 * 1024, 7)]);
    const bigText = numbered(8_000);
    const base = fixture.commit([{ path: "keep.txt", content: "k\n" }]);
    const head = fixture.commit([
      { path: "keep.txt", content: "k\n" },
      { path: "small.dat", content: Buffer.from([0, 1, 2]) },
      { path: "big.dat", content: bigBinary },
      { path: "big.txt", content: bigText },
    ]);
    const result = await buildReviewDiffPackage(
      realRunnerDeps({ blobLimitBytes: 16 * 1024 }, recording(calls)),
      {
        repositoryRoot: fixture.repo,
        baseSha: base,
        headSha: head,
        config: { budgetTokens: 1_000 },
      },
    );
    if (!result.ok) throw new Error("packaging failed");
    const { coverage } = result.package;
    expect(coverage.binary.map((file) => file.path)).toEqual(["big.dat", "small.dat"]);
    expect(coverage.unprocessed).toMatchObject([{ path: "big.txt", reason: "too-large" }]);
    expect(reviewDiffCoverageSettlement(coverage)).toEqual({
      kind: "skipped",
      reason: "diff-too-large",
    });
    const blobs = [
      fixture.blob(bigBinary),
      fixture.blob(bigText),
      fixture.blob(Buffer.from([0, 1, 2])),
    ];
    for (const call of calls) {
      const named = blobs.filter((oid) => call.includes(oid));
      if (named.length === 0) continue;
      // Only Git's binary sniff touches a giant blob, capped at its first 8,000 bytes.
      expect(call.slice(-3, -1)).toEqual(["cat-file", "blob"]);
    }
    expect(calls.filter((args) => args.includes("diff"))).toHaveLength(0);
  });
});

describe("hunk shaping with no-newline markers and deletions", () => {
  it("keeps the end-of-file marker on its line and packages deletion-only hunks", async () => {
    const base = fixture.commit([{ path: "a.txt", content: `${numbered(10)}tail` }]);
    const head = fixture.commit([{ path: "a.txt", content: numbered(10).replace("line 3\n", "") }]);
    const result = await packaged(fixture, base, head);
    const hunks = result.files[0]?.hunks ?? [];
    expect(hunks.flatMap((hunk) => hunk.lines)).toContain("\\ No newline at end of file");
    expect(result.text).toContain("__old hunk__\n line 1\n line 2\n-line 3\n line 4\n");
    expect((await build(fixture, base, head)).ok).toBe(true);
  });
});
