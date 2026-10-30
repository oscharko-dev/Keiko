// The server-owned review worktree against real `git` (Issue #4133): AC1 (hostile head, with a
// positive control proving the fixture is live), AC4 (collisions refused before checkout, large and
// binary blobs not materialized), AC5 (removal on settlement and cancellation, startup orphan sweep,
// a user's `git worktree prune` during a run, reconciliation ignoring the review root).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createGitProcessRunner, gitEnv } from "@oscharko-dev/keiko-git";
import {
  captureActivityLog,
  type ActivityLogCapture,
} from "../../activityLogCapture.test-support.js";
import { withoutReviewWorktrees } from "../../task-workspace/reconciliation.js";
import { createReviewServices, type ReviewServices } from "../services.js";
import {
  addHostileHead,
  commitFile,
  createFixtureRoot,
  git,
  initRepository,
  LFS_POINTER,
  type ReviewFixtureRoot,
} from "../reviewFixtures.test-support.js";
import { reviewRunLeaf } from "./leaf.js";

let fixture: ReviewFixtureRoot;
let repo: string;
let log: ActivityLogCapture;

function services(
  overrides: Partial<Parameters<typeof createReviewServices>[0]> = {},
): ReviewServices {
  return createReviewServices({
    reviewRoot: join(fixture.root, "state", "review-worktrees"),
    activityLog: log.sink,
    github: {
      ownerAndRepo: () => Promise.resolve(undefined),
      readerFor: () => {
        throw new Error("no provider in worktree tests");
      },
    },
    ...overrides,
  });
}

function adminEntries(): readonly string[] {
  const dir = join(repo, ".git", "worktrees");
  return existsSync(dir) ? readdirSync(dir) : [];
}

beforeEach(() => {
  fixture = createFixtureRoot("keiko-review-worktree-");
  repo = join(fixture.root, "repo");
  initRepository(repo);
  commitFile(repo, "README.md", "base\n", "base");
  log = captureActivityLog();
});

afterEach(() => {
  fixture.cleanup();
});

describe("hostile pull request head (AC1)", () => {
  it("runs the hook, filters, LFS smudge and fsmonitor through an unhardened runner (positive control)", async () => {
    const head = addHostileHead(repo, fixture.markers, fixture.root);
    const review = services({ localRunner: () => createGitProcessRunner(() => gitEnv()) });
    await review.worktrees.create({ runId: "control-run", repositoryRoot: repo, headSha: head });
    expect(readdirSync(fixture.markers).sort()).toEqual(["filter", "fsmonitor", "hook", "lfs"]);
  });

  it("materializes the exact head with no marker, the LFS pointer intact and the link a plain file", async () => {
    const head = addHostileHead(repo, fixture.markers, fixture.root);
    const review = services();
    const created = await review.worktrees.create({
      runId: "run-1",
      repositoryRoot: repo,
      headSha: head,
    });
    if (!created.ok) throw new Error(`expected a worktree, got ${created.reason}`);
    const { path } = created.worktree;
    expect(readdirSync(fixture.markers)).toEqual([]);
    expect(readFileSync(join(path, "asset.bin"), "utf8")).toBe(LFS_POINTER);
    expect(lstatSync(join(path, "escape")).isFile()).toBe(true);
    expect(readFileSync(join(path, "escape"), "utf8")).toBe("../../outside-secret");
    expect(git(path, "rev-parse", "HEAD")).toBe(head);
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(path.startsWith(review.reviewRoot)).toBe(true);
    expect(path.startsWith(repo)).toBe(false);
    expect(review.worktrees.state("run-1")).toBe("created");
    const [line] = log.withOp("review.worktree.created");
    expect(line?.extra).toMatchObject({
      materializedCount: 6,
      skippedLargeCount: 0,
      filterDriverCount: 2,
    });
    expect(JSON.stringify(log.events)).not.toContain(repo);
  });
});

describe("pre-checkout refusals and exclusions (AC4)", () => {
  it("refuses case-colliding and normalization-colliding heads before writing a file", async () => {
    git(repo, "checkout", "-q", "-b", "case");
    commitFile(repo, "Config.json", "{}\n", "upper");
    const blob = git(repo, "hash-object", "-w", "--stdin");
    git(repo, "update-index", "--add", "--cacheinfo", `100644,${blob},config.json`);
    git(repo, "commit", "-q", "-m", "lower");
    const caseHead = git(repo, "rev-parse", "HEAD");
    const review = services();
    expect(
      await review.worktrees.create({ runId: "case-run", repositoryRoot: repo, headSha: caseHead }),
    ).toEqual({
      ok: false,
      reason: "case-collision",
    });
    git(repo, "checkout", "-q", "-f", "main");
    git(repo, "checkout", "-q", "-b", "nfd");
    // macOS Git precomposes argv by default; keep both spellings byte-exact in the tree.
    const raw = ["-c", "core.precomposeunicode=false", "update-index", "--add", "--cacheinfo"];
    git(repo, ...raw, `100644,${blob},caf\u00e9.txt`);
    git(repo, ...raw, `100644,${blob},cafe\u0301.txt`);
    git(repo, "commit", "-q", "-m", "normalization");
    const nfdHead = git(repo, "rev-parse", "HEAD");
    expect(
      await review.worktrees.create({ runId: "nfd-run", repositoryRoot: repo, headSha: nfdHead }),
    ).toEqual({
      ok: false,
      reason: "normalization-collision",
    });
    expect(adminEntries()).toEqual([]);
    expect(readdirSync(review.reviewRoot).filter((name) => name.startsWith("r-"))).toEqual([]);
    expect(log.withOp("review.worktree.refused").map((line) => line.extra?.reason)).toEqual([
      "case-collision",
      "normalization-collision",
    ]);
  });

  it("does not materialize blobs above the limit or binary blobs and reports both", async () => {
    git(repo, "checkout", "-q", "-b", "sizes");
    commitFile(repo, "large.txt", "x".repeat(4096), "large");
    commitFile(repo, "-image.bin", Buffer.from([0, 1, 2, 0, 3]), "binary");
    const head = commitFile(repo, "small.txt", "small\n", "small");
    const review = services({ blobLimitBytes: 1024 });
    const created = await review.worktrees.create({
      runId: "sizes",
      repositoryRoot: repo,
      headSha: head,
    });
    if (!created.ok) throw new Error(created.reason);
    expect(created.worktree.skippedLarge).toEqual(["large.txt"]);
    expect(created.worktree.skippedBinary).toEqual(["-image.bin"]);
    expect(existsSync(join(created.worktree.path, "large.txt"))).toBe(false);
    expect(existsSync(join(created.worktree.path, "-image.bin"))).toBe(false);
    expect(readFileSync(join(created.worktree.path, "small.txt"), "utf8")).toBe("small\n");
  });
});

describe("submodules", () => {
  it("never initializes or fetches a submodule the head declares", async () => {
    git(repo, "checkout", "-q", "-b", "submodule");
    const outside = join(fixture.root, "outside-module");
    initRepository(outside);
    const moduleHead = commitFile(outside, "secret.txt", "secret\n", "module");
    commitFile(
      repo,
      ".gitmodules",
      `[submodule "vendor"]\n\tpath = vendor\n\turl = ${outside}\n`,
      "modules",
    );
    git(repo, "update-index", "--add", "--cacheinfo", `160000,${moduleHead},vendor`);
    git(repo, "commit", "-q", "-m", "gitlink");
    const head = git(repo, "rev-parse", "HEAD");
    const created = await services().worktrees.create({
      runId: "submodule",
      repositoryRoot: repo,
      headSha: head,
    });
    if (!created.ok) throw new Error(created.reason);
    expect(existsSync(join(created.worktree.path, "vendor", "secret.txt"))).toBe(false);
    expect(existsSync(join(repo, ".git", "modules"))).toBe(false);
  });
});

describe("lifecycle and cleanup (AC5)", () => {
  it("removes the worktree and its administrative entry on settlement and on cancellation", async () => {
    const head = git(repo, "rev-parse", "HEAD");
    const review = services();
    const settled = await review.worktrees.create({
      runId: "settled",
      repositoryRoot: repo,
      headSha: head,
    });
    const cancelled = await review.worktrees.create({
      runId: "cancelled",
      repositoryRoot: repo,
      headSha: head,
    });
    if (!settled.ok || !cancelled.ok) throw new Error("expected worktrees");
    review.worktrees.markInUse("settled");
    expect(review.worktrees.state("settled")).toBe("in-use");
    expect(await review.worktrees.remove("settled", "settled")).toBe(true);
    expect(await review.worktrees.remove("cancelled", "abandoned")).toBe(true);
    expect(existsSync(settled.worktree.path)).toBe(false);
    expect(existsSync(cancelled.worktree.path)).toBe(false);
    expect(adminEntries()).toEqual([]);
    expect(review.worktrees.state("settled")).toBeUndefined();
    expect(log.withOp("review.worktree.removed").map((line) => line.extra?.trigger)).toEqual([
      "settled",
      "abandoned",
    ]);
  });

  it("survives a user's `git worktree prune` during a run, even with the directory briefly gone", async () => {
    const head = git(repo, "rev-parse", "HEAD");
    const review = services();
    const created = await review.worktrees.create({
      runId: "pruned",
      repositoryRoot: repo,
      headSha: head,
    });
    if (!created.ok) throw new Error(created.reason);
    git(repo, "worktree", "prune", "--expire=now");
    expect(adminEntries()).toHaveLength(1);
    renameSync(created.worktree.path, `${created.worktree.path}.away`);
    git(repo, "worktree", "prune", "--expire=now");
    expect(adminEntries()).toHaveLength(1);
    renameSync(`${created.worktree.path}.away`, created.worktree.path);
    expect(git(created.worktree.path, "rev-parse", "HEAD")).toBe(head);
  });

  it("removes every live worktree on shutdown and every orphan at the next start", async () => {
    const head = git(repo, "rev-parse", "HEAD");
    const first = services();
    const live = await first.worktrees.create({
      runId: "live",
      repositoryRoot: repo,
      headSha: head,
    });
    await first.dispose();
    if (!live.ok) throw new Error(live.reason);
    expect(existsSync(live.worktree.path)).toBe(false);
    // A process that dies keeps nothing in memory: a second instance over the same root is the
    // next server start. Its startup sweep must remove what the first instance left behind.
    const crashed = services();
    const orphan = await crashed.worktrees.create({
      runId: "orphan",
      repositoryRoot: repo,
      headSha: head,
    });
    if (!orphan.ok) throw new Error(orphan.reason);
    const restarted = services();
    await restarted.startup();
    await restarted.dispose();
    expect(existsSync(orphan.worktree.path)).toBe(false);
    expect(adminEntries()).toEqual([]);
    expect(log.withOp("review.worktree.orphan-swept").at(-1)?.extra).toMatchObject({
      removedCount: 1,
      failedCount: 0,
    });
  });

  it("sweeps a locked review entry whose registry record was lost", async () => {
    const head = git(repo, "rev-parse", "HEAD");
    const review = services();
    const created = await review.worktrees.create({
      runId: "lost",
      repositoryRoot: repo,
      headSha: head,
    });
    if (!created.ok) throw new Error(created.reason);
    // The registry still names the repository through a private ref record only.
    rmSync(join(review.reviewRoot, "registry.json"));
    await review.resolveTarget({
      repositoryRoot: repo,
      runId: "ref-only",
      request: { kind: "local-range", baseRef: "main", headRef: "main" },
    });
    const restarted = services();
    await restarted.startup();
    await restarted.dispose();
    expect(adminEntries()).toEqual([]);
    expect(existsSync(created.worktree.path)).toBe(false);
  });

  it("is never listed or matched by task workspace reconciliation", async () => {
    const head = git(repo, "rev-parse", "HEAD");
    const review = services();
    const created = await review.worktrees.create({
      runId: "hidden",
      repositoryRoot: repo,
      headSha: head,
    });
    if (!created.ok) throw new Error(created.reason);
    const entries = [
      { path: repo, bare: false, detached: false, locked: false },
      { path: created.worktree.path, bare: false, detached: true, locked: true },
    ];
    expect(withoutReviewWorktrees(entries, review.reviewRoot)).toEqual([entries[0]]);
    expect(withoutReviewWorktrees(entries, undefined)).toEqual(entries);
    expect(created.worktree.path.endsWith(reviewRunLeaf("hidden"))).toBe(true);
  });
});
