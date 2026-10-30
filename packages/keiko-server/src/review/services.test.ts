// Review services across a real process kill (Issue #4133, AC5): a server process that created a
// review worktree is killed with SIGKILL; the next start's sweep leaves no review worktree and no
// administrative entry behind. The child runs the built server (`npm test` builds packages first),
// so the crash is a real one rather than a dropped in-memory object.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureActivityLog } from "../activityLogCapture.test-support.js";
import { createReviewServices } from "./services.js";
import {
  commitFile,
  createFixtureRoot,
  git,
  initRepository,
  type ReviewFixtureRoot,
} from "./reviewFixtures.test-support.js";

const BUILT_SERVICES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dist",
  "review",
  "services.js",
);

const CHILD = `
const [servicesUrl, reviewRoot, repositoryRoot, headSha] = process.argv.slice(1);
const { createReviewServices } = await import(servicesUrl);
const services = createReviewServices({
  reviewRoot,
  activityLog: { write: () => undefined },
  github: { ownerAndRepo: async () => undefined, readerFor: () => { throw new Error("unused"); } },
});
const created = await services.worktrees.create({ runId: "crashed-run", repositoryRoot, headSha });
process.stdout.write(created.ok ? "created\\n" : "refused\\n");
setInterval(() => undefined, 1000);
`;

let fixture: ReviewFixtureRoot;

beforeEach(() => {
  fixture = createFixtureRoot("keiko-review-crash-");
});

afterEach(() => {
  fixture.cleanup();
});

function runAndKill(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("\n")) child.kill("SIGKILL");
    });
    child.on("error", reject);
    child.on("close", (_code, signal) => {
      resolve(`${output.trim()}:${signal ?? "exit"}`);
    });
  });
}

describe("crash recovery (AC5)", () => {
  it("removes the worktree and administrative entry of a killed server at the next start", async () => {
    expect(existsSync(BUILT_SERVICES)).toBe(true);
    const repo = join(fixture.root, "repo");
    initRepository(repo);
    const head = commitFile(repo, "README.md", "base\n", "base");
    const reviewRoot = join(fixture.root, "state", "review-worktrees");
    const outcome = await runAndKill([pathToFileURL(BUILT_SERVICES).href, reviewRoot, repo, head]);
    expect(outcome).toBe("created:SIGKILL");
    expect(readdirSync(join(repo, ".git", "worktrees"))).toHaveLength(1);
    const log = captureActivityLog();
    const restarted = createReviewServices({ reviewRoot, activityLog: log.sink });
    await restarted.startup();
    await restarted.dispose();
    expect(existsSync(join(repo, ".git", "worktrees"))).toBe(false);
    expect(readdirSync(restarted.reviewRoot).filter((name) => name.startsWith("r-"))).toEqual([]);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("locked");
    expect(log.withOp("review.worktree.orphan-swept")[0]?.extra).toMatchObject({
      removedCount: 1,
      failedCount: 0,
    });
  });
});
