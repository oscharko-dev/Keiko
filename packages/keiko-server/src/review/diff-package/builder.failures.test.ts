// Fail-closed handling of unexpected Git results in the review diff package (Issue #4134): every
// step whose result cannot be trusted fails the whole package; a single file's own bound only makes
// that file unprocessed. Real `git` serves every call the test does not replace.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  GitProcessOptions,
  GitProcessResult,
  GitProcessRunner,
} from "@oscharko-dev/keiko-git";
import { DiffFixtureRepository, realRunnerDeps } from "./diffFixtures.test-support.js";
import { build, numbered, packaged } from "./diffPackageAssertions.test-support.js";

let fixture: DiffFixtureRepository;

beforeEach(() => {
  fixture = new DiffFixtureRepository();
});

afterEach(() => {
  fixture.cleanup();
});

type Replacement = (
  args: readonly string[],
  options: GitProcessOptions,
) => Promise<GitProcessResult> | undefined;

function replacing(replacement: Replacement): (runner: GitProcessRunner) => GitProcessRunner {
  return (runner) => (args, options) => replacement(args, options) ?? runner(args, options);
}

function result(overrides: Partial<GitProcessResult>): Promise<GitProcessResult> {
  return Promise.resolve({
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    ...overrides,
  });
}

function when(subcommand: string, value: Partial<GitProcessResult>): Replacement {
  return (args) => (args.includes(subcommand) ? result(value) : undefined);
}

function modified(): { readonly base: string; readonly head: string } {
  const base = fixture.commit([{ path: "a.ts", content: numbered(20) }]);
  const head = fixture.commit([
    { path: "a.ts", content: numbered(20).replace("line 9\n", "nine\n") },
  ]);
  return { base, head };
}

function giant(): { readonly base: string; readonly head: string } {
  const base = fixture.commit([{ path: "keep.txt", content: "k\n" }]);
  const head = fixture.commit([
    { path: "keep.txt", content: "k\n" },
    { path: "big.txt", content: numbered(4_000) },
  ]);
  return { base, head };
}

const SMALL_BLOBS = { blobLimitBytes: 1_024 };
const TOO_LARGE = { ok: false, failure: { reason: "diff-too-large", detail: "deadline" } };
const GIT_FAILED = { ok: false, failure: { reason: "git-failed" } };

describe("whole-package failures", () => {
  it("fails closed on an unreadable, duplicated or timed-out change listing", async () => {
    const { base, head } = modified();
    const garbage = realRunnerDeps({}, replacing(when("diff-tree", { stdout: "not a listing\n" })));
    expect(await build(fixture, base, head, undefined, garbage)).toEqual(GIT_FAILED);
    const raw = `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\ta.ts\n`;
    const duplicated = realRunnerDeps(
      {},
      replacing(when("diff-tree", { stdout: `${raw}${raw}1\t1\ta.ts\n1\t1\ta.ts\n` })),
    );
    expect(await build(fixture, base, head, undefined, duplicated)).toEqual(GIT_FAILED);
    const slow = realRunnerDeps(
      {},
      replacing(when("diff-tree", { exitCode: null, truncated: true, timedOut: true })),
    );
    expect(await build(fixture, base, head, undefined, slow)).toEqual(TOO_LARGE);
  });

  it("fails closed when sizes or a binary sniff cannot be read", async () => {
    const { base, head } = giant();
    const sizes = realRunnerDeps(
      SMALL_BLOBS,
      replacing(when("--batch-check=%(objectname) %(objecttype) %(objectsize)", { exitCode: 128 })),
    );
    expect(await build(fixture, base, head, undefined, sizes)).toEqual(GIT_FAILED);
    const tree = realRunnerDeps(
      SMALL_BLOBS,
      replacing((args) =>
        args.some((arg) => arg.startsWith("--batch-check"))
          ? result({ stdout: `${fixture.blob(numbered(4_000))} tree 10\n` })
          : undefined,
      ),
    );
    expect(await build(fixture, base, head, undefined, tree)).toEqual(GIT_FAILED);
    const sniff = realRunnerDeps(
      SMALL_BLOBS,
      replacing((args) =>
        args.includes("cat-file") && args.includes("blob") ? result({ exitCode: 128 }) : undefined,
      ),
    );
    expect(await build(fixture, base, head, undefined, sniff)).toEqual(GIT_FAILED);
  });

  it("fails closed on a patch that does not parse or has no hunks", async () => {
    const { base, head } = modified();
    const malformed = realRunnerDeps(
      {},
      replacing(when("diff", { stdout: "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n" })),
    );
    expect(await build(fixture, base, head, undefined, malformed)).toEqual(GIT_FAILED);
    const empty = realRunnerDeps({}, replacing(when("diff", { stdout: "" })));
    expect(await build(fixture, base, head, undefined, empty)).toEqual(GIT_FAILED);
    const failing = realRunnerDeps({}, replacing(when("diff", { exitCode: 128 })));
    expect(await build(fixture, base, head, undefined, failing)).toEqual(GIT_FAILED);
  });

  it("stops at the deadline while a file is being read", async () => {
    const { base, head } = modified();
    const hanging = realRunnerDeps(
      { deadlineMs: 50 },
      replacing((args, options) =>
        args.includes("diff")
          ? new Promise((resolve) => {
              options.abortSignal?.addEventListener("abort", () => {
                resolve({
                  exitCode: null,
                  signal: "SIGTERM",
                  stdout: "",
                  stderr: "",
                  truncated: true,
                  aborted: true,
                });
              });
            })
          : undefined,
      ),
    );
    expect(await build(fixture, base, head, undefined, hanging)).toEqual(TOO_LARGE);
  });

  it("propagates a runner defect instead of reporting it as a review outcome", async () => {
    const { base, head } = modified();
    const defect: GitProcessRunner = () => Promise.reject(new Error("runner defect"));
    const broken = realRunnerDeps({}, () => defect);
    await expect(build(fixture, base, head, undefined, broken)).rejects.toThrow("runner defect");
  });

  it("rejects mixed object formats", async () => {
    const base = fixture.commit([{ path: "a.ts", content: "a\n" }]);
    await expect(build(fixture, base, "a".repeat(64))).rejects.toThrow(TypeError);
  });
});

describe("single-file outcomes and language order", () => {
  it("marks an added file whose content exceeds the per-file cap as too-large", async () => {
    const base = fixture.commit([{ path: "keep.txt", content: "k\n" }]);
    const head = fixture.commit([
      { path: "keep.txt", content: "k\n" },
      { path: "added.ts", content: numbered(200) },
    ]);
    const result = await packaged(
      fixture,
      base,
      head,
      undefined,
      realRunnerDeps({ fileMaxPatchBytes: 128 }),
    );
    expect(result.coverage.unprocessed).toMatchObject([{ path: "added.ts", reason: "too-large" }]);
  });

  it("falls back to the canonical language order when the base tree is too large to list", async () => {
    const { base, head } = modified();
    const capped = realRunnerDeps(
      {},
      replacing(when("ls-tree", { exitCode: null, truncated: true })),
    );
    const result = await packaged(fixture, base, head, { budgetTokens: 10_000 }, capped);
    expect(result.coverage.included.map((file) => file.path)).toEqual(["a.ts"]);
    const failing = realRunnerDeps({}, replacing(when("ls-tree", { exitCode: 128 })));
    expect(await build(fixture, base, head, { budgetTokens: 10_000 }, failing)).toEqual(GIT_FAILED);
  });
});
