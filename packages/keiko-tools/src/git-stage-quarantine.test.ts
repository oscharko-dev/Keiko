// The object quarantine through the real mutation adapter: the adapter itself builds the Git
// environment (`pinnedEnv` through the sandbox policy), so the live object store staying free of a
// refused blob proves the production wiring, not a test double that sets the variables itself.
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { nodeSpawnFn } from "./exec.js";
import { createNodeGitMutationAdapter, readGitIndexTreeDigest } from "./git-mutation-node.js";
import type { GitVerifiedCommitPrecondition } from "./git-mutation-adapter.js";

let root: string;
let workspace: WorkspaceInfo;
const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (args: readonly string[]): string =>
  execFileSync("git", [...args], { cwd: root, encoding: "utf8", env }).trim();
const objectPath = (id: string): string =>
  join(root, ".git", "objects", id.slice(0, 2), id.slice(2));

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-stage-quarantine-")));
  git(["init", "-q", "-b", "dev"]);
  git(["config", "core.autocrlf", "false"]);
  git(["config", "user.name", "Keiko Test"]);
  git(["config", "user.email", "keiko@example.test"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, "code.txt"), "base\n");
  git(["add", "code.txt"]);
  git(["commit", "-qm", "base"]);
  writeFileSync(join(root, "large.json"), "x".repeat(300_000));
  workspace = {
    root,
    selectedRoot: root,
    name: "test",
    version: undefined,
    testFramework: "vitest",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function precondition(): Promise<GitVerifiedCommitPrecondition> {
  const sha = git(["rev-parse", "HEAD"]);
  return {
    head: { kind: "born", sha },
    stagedTreeDigest: await readGitIndexTreeDigest({ workspace }),
    branchName: "dev",
    baseRef: "dev",
    base: { kind: "born", sha },
  };
}

describe("a large file staged through the real mutation adapter", () => {
  it("never reaches the live object store when it changes while Git reads it", async () => {
    const seen: string[] = [];
    let changed = false;
    const adapter = createNodeGitMutationAdapter({
      workspace,
      processEnv: { PATH: process.env.PATH, HOME: root },
      spawn: (command, args, options) => {
        if (args.includes("hash-object") && args.includes("-w")) {
          seen.push(String(options.env.GIT_OBJECT_DIRECTORY));
          if (!changed) {
            changed = true;
            appendFileSync(join(root, "large.json"), "changed during the read\n");
          }
        }
        return nodeSpawnFn(command, args, options);
      },
    });
    const verified = await precondition();
    const result = await adapter.stage({ pathspecs: ["large.json"], verified });
    expect(result.outcome).toBe("failed");
    expect(seen.length).toBeGreaterThan(0);
    for (const directory of seen) expect(directory).toContain("incoming-keiko-");
    const refused = git(["hash-object", "--no-filters", "--", "large.json"]);
    expect(existsSync(objectPath(refused))).toBe(false);
    expect(
      readdirSync(join(root, ".git", "objects")).filter((n) => n.startsWith("incoming")),
    ).toEqual([]);
    expect(git(["ls-files", "--stage", "large.json"])).toBe("");
  });

  it("publishes the approved object and stages it when nothing changes", async () => {
    const adapter = createNodeGitMutationAdapter({
      workspace,
      processEnv: { PATH: process.env.PATH, HOME: root },
    });
    const approved = git(["hash-object", "--no-filters", "--", "large.json"]);
    const result = await adapter.stage({
      pathspecs: ["large.json"],
      verified: await precondition(),
    });
    expect(result.outcome).toBe("succeeded");
    expect(existsSync(objectPath(approved))).toBe(true);
    expect(git(["rev-parse", ":large.json"])).toBe(approved);
  });
});
