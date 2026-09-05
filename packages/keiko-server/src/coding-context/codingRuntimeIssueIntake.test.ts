// Epic #3384 correction 7: a run's issue-context attachment reads GitHub through the connector
// surface, and the connector-scope model gates that read to `autonomous-delivery` (the only mode
// `productionRuntimeWorkspaceAuthority.ts` grants `source-control.read`/`.write` for). Before this
// change `buildPack` hard-coded `connectorScopes: ["source-control.read"]` regardless of the run's
// actual effective mode, so a run below `autonomous-delivery` still got issue context the
// connector-scope model never granted it — the `pack.status === "blocked"` branch in
// `buildContext` was dead code.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createInMemoryUiStore } from "../store/index.js";
import { deriveRepositoryId } from "../task-workspace/naming.js";
import { createProductionCodingRuntimeIssueIntake } from "./codingRuntimeIssueIntake.js";
import type { GitHubIssueResolutionDeps } from "./githubIssueResolution.js";

let root: string;

function git(args: readonly string[]): void {
  execFileSync("git", args, { cwd: root });
}

// A real, remote-less git repository with a resolvable default branch: `buildContext` re-resolves
// the issue through the production resolver, which reads `refs/remotes/origin/HEAD` for real (only
// the GitHub port and the remote owner/repo resolver are injectable through `deps`).
function setRemoteHead(branch: string): void {
  git(["update-ref", `refs/remotes/origin/${branch}`, "HEAD"]);
  git(["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`]);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-issue-intake-")));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@keiko.example"]);
  git(["config", "user.name", "Keiko Test"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["commit", "-q", "--allow-empty", "-m", "init"]);
  setRemoteHead("main");
});

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  readonly deps: GitHubIssueResolutionDeps;
  readonly readJson: Mock<(argv: readonly string[]) => Promise<unknown>>;
}

function fixture(): Fixture {
  const store = createInMemoryUiStore();
  cleanups.push(() => {
    store.close();
  });
  store.createProject(root, "selected");
  store.updateGitHubIssueReaderAuthorization(deriveRepositoryId(root), true, 0);
  const object = {
    id: "123",
    nodeId: "I_test",
    state: "open",
    isPullRequest: false,
    title: "Issue context attachment",
    body: "Body",
    url: "https://github.com/owner/repo/issues/42",
  };
  const readJson = vi.fn((argv: readonly string[]): Promise<unknown> =>
    Promise.resolve(argv[1]?.includes("comments?") ? [] : object),
  );
  const deps: GitHubIssueResolutionDeps = {
    store,
    // The real `git rev-parse` spawn (readGitDefaultBranch) needs the actual PATH to find `git`.
    env: { PATH: process.env.PATH ?? "" },
    codingContextGitHubPort: { readJson },
    codingContextGitHubRemoteResolver: () => Promise.resolve("Owner/Repo"),
    activityLog: { write: () => undefined },
  };
  return { deps, readJson };
}

describe("production coding-runtime issue-context attachment (epic #3384 correction 7)", () => {
  it("refuses issue-context attachment with authority-denied below autonomous-delivery", async () => {
    const f = fixture();
    const intake = createProductionCodingRuntimeIssueIntake(f.deps);
    const resolved = await intake.resolve({
      repositoryRoot: root,
      issueRef: "#42",
      correlationId: "run-1",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const governedAssist = await intake.buildContext({
      runId: "run-1",
      repositoryRoot: root,
      binding: resolved.binding,
      effectiveMode: "governed-assist",
      correlationId: "run-1",
    });
    expect(governedAssist).toEqual({ ok: false, failure: "authority-denied" });

    const supervised = await intake.buildContext({
      runId: "run-1",
      repositoryRoot: root,
      binding: resolved.binding,
      effectiveMode: "supervised-coding",
      correlationId: "run-1",
    });
    expect(supervised).toEqual({ ok: false, failure: "authority-denied" });
  });

  it("attaches issue context once the run's effective mode carries source-control.read", async () => {
    const f = fixture();
    const intake = createProductionCodingRuntimeIssueIntake(f.deps);
    const resolved = await intake.resolve({
      repositoryRoot: root,
      issueRef: "#42",
      correlationId: "run-1",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const attached = await intake.buildContext({
      runId: "run-1",
      repositoryRoot: root,
      binding: resolved.binding,
      effectiveMode: "autonomous-delivery",
      correlationId: "run-1",
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(attached.attachment.issueNumber).toBe(42);
    expect(attached.attachment.itemCount).toBe(1);
  });
});
