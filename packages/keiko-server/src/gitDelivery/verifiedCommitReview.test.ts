import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CodingWorkbenchRuntimePendingApprovalReview,
  VerifiedCommitResult,
} from "@oscharko-dev/keiko-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readVerifiedCommitReview, type VerifiedCommitReviewRead } from "./verifiedCommitReview.js";
import type { VerifiedCommitRunContext } from "./verifiedCommitTypes.js";

const RESULT: VerifiedCommitResult = {
  schemaVersion: "1",
  proposalId: "commit-1",
  runId: "run-1",
  envelopeDigest: "a".repeat(64),
  runtimeAuthorityDigest: "b".repeat(64),
  workspaceDigest: "c".repeat(64),
  repositoryDigest: "d".repeat(64),
  baseSha: "1".repeat(40),
  parentSha: "2".repeat(40),
  stagedTreeDigest: "e".repeat(64),
  verificationEvidenceId: "verification-1",
  messageDigest: "f".repeat(64),
  status: "approval-required",
  reason: "approval-required",
  recordedAt: "2026-09-04T10:00:00.000Z",
};

let scratch = "";

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" });
}

function reviewOf(read: VerifiedCommitReviewRead): CodingWorkbenchRuntimePendingApprovalReview {
  if (!("review" in read)) throw new Error(`review incomplete: ${read.incomplete}`);
  return read.review;
}

function contextFor(root: string): VerifiedCommitRunContext {
  return {
    runId: "run-1",
    envelopeDigest: "b".repeat(64),
    runtimeAuthorityDigest: "b".repeat(64),
    workspaceDigest: "c".repeat(64),
    repositoryDigest: "d".repeat(64),
    workspace: {
      root,
      selectedRoot: root,
      name: "test",
      version: undefined,
      testFramework: "vitest",
      sourceDirs: [],
      testDirs: [],
      languages: [],
      ignoreLines: [],
    },
    baseRef: "dev",
    headRef: "codex/task",
    correlationId: "review-test",
    buffersClean: () => true,
    stillAuthorized: () => true,
  };
}

/** A real repository whose parent path and one staged file carry hostile characters. */
function stagedRepo(parentName: string, relativePath: string): string {
  const root = join(scratch, parentName);
  mkdirSync(root, { recursive: true });
  runGit(root, ["init", "-qb", "dev"]);
  runGit(root, ["config", "user.name", "Keiko Test"]);
  runGit(root, ["config", "user.email", "keiko@example.test"]);
  runGit(root, ["config", "commit.gpgsign", "false"]);
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "a\nb\n");
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-qm", "base"]);
  writeFileSync(file, "a\nc\n");
  runGit(root, ["add", "-A"]);
  return root;
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "keiko-review-")));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("readVerifiedCommitReview with quoted Git paths", () => {
  it("reviews the G-3 fixture shape: non-ASCII, spaces, ampersand and parentheses", async () => {
    const relativePath = "src/tief/noch tiefer/größe.js";
    const root = stagedRepo("Prüfung & Tests (2026)/Ünïcödé ordner/项目 alpha", relativePath);
    const review = await readVerifiedCommitReview(contextFor(root), RESULT, "fix: size", {});
    expect(reviewOf(review).paths).toEqual([relativePath]);
    expect(reviewOf(review).addedLines).toBe(1);
    expect(reviewOf(review).deletedLines).toBe(1);
  });

  it.each([
    ["a tab", "dir/with\ttab.js"],
    ["a double quote", 'dir/say "hi".js'],
    ["a backslash", "dir/back\\slash.js"],
    ["a newline", "dir/line\nbreak.js"],
    ["a colon", "dir/time 10:30.js"],
    ["a leading space and a trailing dot", "dir/ lead.name."],
  ])("reviews a staged file whose name holds %s", async (_label, relativePath) => {
    const root = stagedRepo("quoted names", relativePath);
    const review = await readVerifiedCommitReview(contextFor(root), RESULT, "fix: size", {});
    expect(reviewOf(review).paths).toEqual([relativePath]);
    expect(reviewOf(review).addedLines).toBe(1);
  });

  it("reviews a rename between two quoted names under both names", async () => {
    const root = stagedRepo("rename repo", "dir/größe.js");
    runGit(root, ["reset", "-q"]);
    renameSync(join(root, "dir/größe.js"), join(root, "dir/größer name.js"));
    runGit(root, ["add", "-A"]);
    const review = await readVerifiedCommitReview(contextFor(root), RESULT, "fix: size", {});
    expect(review).toMatchObject({
      review: { paths: ["dir/größe.js \u2192 dir/größer name.js"], fileCount: 1 },
    });
  });

  it("refuses a review whose file name holds the rename arrow", async () => {
    const root = stagedRepo("arrow name", "dir/a \u2192 b.js");
    const read = await readVerifiedCommitReview(contextFor(root), RESULT, "fix: size", {});
    expect(read).toEqual({ incomplete: "diff-truncated" });
  });

  it("says counts are unavailable when a count passes the contract bound", async () => {
    const root = stagedRepo("huge count", "dir/many.txt");
    writeFileSync(join(root, "dir/many.txt"), "x\n".repeat(1_000_001));
    runGit(root, ["add", "-A"]);
    const read = await readVerifiedCommitReview(contextFor(root), RESULT, "fix: size", {});
    expect(reviewOf(read)).toMatchObject({ addedLines: 1_000_000, countsUnavailable: true });
  });
});

describe("readVerifiedCommitReview names its cause when the review is incomplete", () => {
  it("reviews a file whose hunk line is over-long with its exact counts", async () => {
    const root = stagedRepo("long line", "dir/big.js");
    writeFileSync(join(root, "dir/big.js"), `a\n${"x".repeat(20_000)}\n`);
    runGit(root, ["add", "-A"]);
    const read = await readVerifiedCommitReview(contextFor(root), RESULT, "fix: size", {});
    expect(reviewOf(read)).toMatchObject({ fileCount: 1, addedLines: 1, deletedLines: 1 });
  });

  it("names a diff that lists a file the review cannot place", async () => {
    // Git prints `dir/..\\up.js` as one POSIX name; its backslash would climb out on Windows.
    const root = stagedRepo("unplaceable file", "dir/..\\up.js");
    const read = await readVerifiedCommitReview(contextFor(root), RESULT, "fix: size", {});
    expect(read).toEqual({ incomplete: "diff-truncated" });
  });

  it("names a path the review payload refuses", async () => {
    const segment = "d".repeat(100);
    const root = stagedRepo(
      "long path",
      `${[segment, segment, segment, segment, segment, segment].join("/")}/f.js`,
    );
    const read = await readVerifiedCommitReview(contextFor(root), RESULT, "fix: size", {});
    expect(read).toEqual({ incomplete: "payload-invalid" });
  });
});

describe("readVerifiedCommitReview of a large legitimate change (G-4)", () => {
  it("reviews 303 pure renames and their reference edits with exact counts", async () => {
    const root = join(scratch, "bulk");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "test"), { recursive: true });
    runGit(root, ["init", "-qb", "dev"]);
    runGit(root, ["config", "user.name", "Keiko Test"]);
    runGit(root, ["config", "user.email", "keiko@example.test"]);
    runGit(root, ["config", "commit.gpgsign", "false"]);
    const count = 303;
    for (let n = 100; n < 100 + count; n += 1) {
      writeFileSync(join(root, "src", `m${String(n)}.js`), `export const n = ${String(n)};\n`);
      writeFileSync(join(root, "test", `t${String(n)}.js`), `import "../src/m${String(n)}.js";\n`);
    }
    runGit(root, ["add", "-A"]);
    runGit(root, ["commit", "-qm", "seed"]);
    for (let n = 100; n < 100 + count; n += 1) {
      renameSync(
        join(root, "src", `m${String(n)}.js`),
        join(root, "src", `module-${String(n)}.js`),
      );
      writeFileSync(
        join(root, "test", `t${String(n)}.js`),
        `import "../src/module-${String(n)}.js";\n`,
      );
    }
    runGit(root, ["add", "-A"]);
    const read = await readVerifiedCommitReview(contextFor(root), RESULT, "feat: rename", {});
    expect(read).toMatchObject({ renameCount: count });
    expect(reviewOf(read)).toMatchObject({
      fileCount: count * 2,
      pathsTruncated: true,
      addedLines: count,
      deletedLines: count,
    });
    expect(reviewOf(read).paths).toHaveLength(50);
  });
});
