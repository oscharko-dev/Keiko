import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "@oscharko-dev/keiko-workspace";
import { codingWorkbenchRemoteDigest } from "../coding-context/githubIssueResolution.js";
import type { ServerLogEvent } from "../observability/server-log.js";
import { readVerifiedCommitFacts } from "../gitDelivery/verifiedCommitFacts.js";
import {
  createRuntimeGitPreparation,
  type RuntimeGitPreparation,
} from "./productionRuntimeGitPreparation.js";
import type { CodingRuntimeTrustedContext } from "./runtimeAuthorityService.js";

let root: string;
let now: number;
let events: ServerLogEvent[];
let context: CodingRuntimeTrustedContext;
let preparation: RuntimeGitPreparation;
let workspace: WorkspaceInfo;

function git(args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}
function request(): Parameters<RuntimeGitPreparation["prepare"]>[0] {
  return {
    runId: "run-1",
    requestId: "request-1",
    taskIntent: "private task",
    requestedMode: "supervised-coding",
    workspaceId: "workspace-1",
    workspaceRoot: root,
    serverPrincipal: "operator-1",
  };
}
function trustedContext(): CodingRuntimeTrustedContext {
  return {
    runId: "run-1",
    operatorId: "operator-1",
    taskId: "task-1",
    projectId: "repository-1",
    projectDigest: "a".repeat(64),
    workspaceId: "workspace-1",
    workspaceRoot: root,
    branchRef: "codex/task",
    branchHeadDigest: "b".repeat(64),
    branch: {
      baseRef: "dev",
      headRef: "codex/task",
      allowedPrefixes: ["codex/"],
      allowDetachedHead: false,
    },
    deploymentCeiling: "supervised-coding",
    runtimeSource: "keiko-sidecar",
    actionClasses: ["workspace-read", "workspace-write", "verification"],
    connectorScopes: [],
    modelProfile: {
      profileId: "profile-1",
      source: "keiko-model-gateway",
      supportsStreaming: true,
      supportsToolCalling: true,
    },
    commandPolicy: {
      mode: "governed",
      allow: [],
      deny: [],
      maxCommandTimeoutMs: 120_000,
      requirePerCommandApproval: true,
    },
    networkPolicy: { mode: "deny-all", connectorScopes: [], allowLoopback: false },
    gates: ["human-approval"],
    budget: {
      maxRuntimeMs: 60_000,
      maxToolCalls: 256,
      maxPromptTokens: 20_000,
      maxPatchBytes: 262_144,
    },
    expiresAt: new Date(now + 60_000).toISOString(),
  };
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-runtime-origin-")));
  now = Date.parse("2026-07-15T12:00:00.000Z");
  events = [];
  git(["init", "-qb", "dev"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  ]);
  git(["switch", "-qc", "codex/task"]);
  context = trustedContext();
  workspace = {
    root,
    selectedRoot: root,
    name: "fixture",
    version: undefined,
    testFramework: "vitest",
    sourceDirs: [],
    testDirs: [],
    languages: [],
    ignoreLines: [],
  };
  preparation = createRuntimeGitPreparation({
    deps: {
      resolveWorkspace: () => workspace,
      execution: {
        activityLog: {
          write: (event): void => {
            events.push(event);
          },
        },
      },
    },
    context: () => context,
    now: () => now,
  });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("repository identity before runtime confirmation", () => {
  it("captures a canonical origin in a server-owned one-use preparation", async () => {
    git(["remote", "add", "origin", "git@github.com:Owner/Repository.git"]);
    const input = request();
    await preparation.prepare(input);
    expect(() => preparation.consume({ ...input })).toThrow("preparation-unavailable");
    expect(preparation.consume(input).repositoryIdentity).toEqual({
      kind: "github-origin",
      digest: codingWorkbenchRemoteDigest("owner/repository"),
    });
    expect(() => preparation.consume(input)).toThrow("preparation-unavailable");
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "git.runtime-identity",
        correlationId: "run-1",
        extra: { runId: "run-1", state: "consumed" },
      }),
    );
    expect(JSON.stringify(events)).not.toMatch(
      /Owner|Repository|private task|git@|fixture@example/u,
    );
    expect(JSON.stringify(events)).not.toContain(root);
  });

  it("binds explicit no-origin identity and rejects an origin added after admission", async () => {
    const input = request();
    await preparation.prepare(input);
    const accepted = preparation.consume(input).repositoryIdentity;
    if (accepted === undefined) throw new Error("identity unavailable");
    expect(accepted.kind).toBe("local");
    const runContext = {
      runId: input.runId,
      envelopeDigest: "c".repeat(64),
      runtimeAuthorityDigest: "d".repeat(64),
      workspaceDigest: accepted.digest,
      repositoryDigest: accepted.digest,
      workspace,
      baseRef: "dev",
      headRef: "codex/task",
      correlationId: input.runId,
      buffersClean: (): boolean => true,
      stillAuthorized: (): boolean => true,
    };
    expect((await readVerifiedCommitFacts(runContext, {})).repositoryDigest).toBe(accepted.digest);
    git(["remote", "add", "origin", "https://github.com/other/repository.git"]);
    await expect(readVerifiedCommitFacts(runContext, {})).rejects.toThrow("repository-drift");
  });

  it.each(["expired", "request-drift", "workspace-drift", "head-drift"] as const)(
    "rejects %s before confirmation consume",
    async (failure) => {
      const input = request();
      await preparation.prepare(input);
      if (failure === "expired") now += 5_000;
      if (failure === "request-drift") Object.assign(input, { taskIntent: "different task" });
      if (failure === "workspace-drift") context = { ...context, workspaceRoot: `${root}/other` };
      if (failure === "head-drift") context = { ...context, branchHeadDigest: "f".repeat(64) };
      expect(() => preparation.consume(input)).toThrow("preparation-unavailable");
      expect(() => preparation.consume(input)).toThrow("preparation-unavailable");
    },
  );

  it("rejects an unsupported remote with structured body-free failure evidence", async () => {
    git(["remote", "add", "origin", "https://private.example.invalid/customer/repo"]);
    const input = request();
    await expect(preparation.prepare(input)).rejects.toThrow("remote-unsupported");
    expect(() => preparation.consume(input)).toThrow("preparation-unavailable");
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "git.runtime-identity",
        errorKind: "internal",
        correlationId: "run-1",
        extra: expect.objectContaining({ state: "failed" }) as unknown,
      }),
    );
    expect(JSON.stringify(events)).not.toMatch(/private.example|customer\/repo/u);
  });
});
