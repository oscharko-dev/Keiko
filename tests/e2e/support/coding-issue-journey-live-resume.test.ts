import { describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchIssueBinding,
  CodingWorkbenchRuntimeSnapshot,
} from "@oscharko-dev/keiko-contracts";
import {
  qualificationResumeBinding,
  resumeExistingIssueWorkspace,
  type QualificationResumeBinding,
} from "./coding-issue-journey-live-resume.js";
import { createHash } from "node:crypto";

const PRIOR_RUN_ID = "run-215162337154423732873987034429728011180";
const ISSUE_BINDING_DIGEST = "a".repeat(64);
const WORKTREE_DIGEST = "b".repeat(64);
const HEAD_SHA = "c".repeat(40);

const RESUME: QualificationResumeBinding = {
  priorRunId: PRIOR_RUN_ID,
  workspaceId: "ws_e370bc97d4bd91ac42f7eeff",
  taskId: "coding-workbench-issue-1",
  repositoryId: "repo_64424dfb679a770a",
  baseBranch: "master",
  taskBranch: "keiko/task/coding-workbench-issue-1-f1e58616",
  managedWorktreePath: "/private/tmp/managed/ws_e370bc97d4bd91ac42f7eeff",
  headSha: HEAD_SHA,
  issueBindingDigest: ISSUE_BINDING_DIGEST,
  worktreeDigest: WORKTREE_DIGEST,
};

const ISSUE: CodingWorkbenchIssueBinding = {
  schemaVersion: "1",
  repositoryId: "repo_64424dfb679a770a",
  remoteDigest: "d".repeat(64),
  issueNumber: 1,
  issueIdDigest: "e".repeat(64),
  defaultBaseRef: "master",
  contentRevisionDigest: "f".repeat(64),
  bindingDigest: ISSUE_BINDING_DIGEST,
};

function snapshot(
  runId: string,
  state: CodingWorkbenchRuntimeSnapshot["state"],
  issueBinding: CodingWorkbenchIssueBinding | null = ISSUE,
): CodingWorkbenchRuntimeSnapshot {
  return {
    schemaVersion: "1",
    state,
    revision: 1,
    updatedAt: "2026-09-06T09:00:00Z",
    runId,
    requestedMode: "governed-assist",
    effectiveMode: "governed-assist",
    ...(issueBinding === null ? {} : { issueBinding }),
  };
}

function active(override: Partial<QualificationResumeBinding> = {}): {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly repositoryId: string;
  readonly baseBranch: string;
  readonly taskBranch: string;
  readonly managedWorktreePath: string;
  readonly lastVerifiedHead: string;
} {
  const value = { ...RESUME, ...override };
  return {
    workspaceId: value.workspaceId,
    taskId: value.taskId,
    repositoryId: value.repositoryId,
    baseBranch: value.baseBranch,
    taskBranch: value.taskBranch,
    managedWorktreePath: value.managedWorktreePath,
    lastVerifiedHead: value.headSha,
  };
}

function client(
  overrides: {
    readonly activeBefore?: ReturnType<typeof active> | null;
    readonly activeAfter?: ReturnType<typeof active> | null;
    readonly prior?: CodingWorkbenchRuntimeSnapshot;
    readonly started?: CodingWorkbenchRuntimeSnapshot;
    readonly digests?: readonly string[];
  } = {},
): {
  readonly subject: Parameters<typeof resumeExistingIssueWorkspace>[0];
  readonly bindIssue: ReturnType<typeof vi.fn>;
  readonly start: ReturnType<typeof vi.fn>;
} {
  const readActiveWorkspace = vi
    .fn<() => Promise<ReturnType<typeof active> | null>>()
    .mockResolvedValueOnce(overrides.activeBefore === undefined ? active() : overrides.activeBefore)
    .mockResolvedValueOnce(overrides.activeAfter === undefined ? active() : overrides.activeAfter);
  const readWorktree = vi
    .fn<(path: string) => { readonly headSha: string; readonly digest: string }>()
    .mockReturnValueOnce({ headSha: HEAD_SHA, digest: overrides.digests?.[0] ?? WORKTREE_DIGEST })
    .mockReturnValueOnce({ headSha: HEAD_SHA, digest: overrides.digests?.[1] ?? WORKTREE_DIGEST });
  const bindIssue = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const start = vi
    .fn<() => Promise<CodingWorkbenchRuntimeSnapshot>>()
    .mockResolvedValue(overrides.started ?? snapshot("run-new", "running"));
  return {
    subject: {
      readActiveWorkspace,
      readPriorRun: vi
        .fn<(runId: string) => Promise<CodingWorkbenchRuntimeSnapshot>>()
        .mockResolvedValue(overrides.prior ?? snapshot(PRIOR_RUN_ID, "failed")),
      readWorktree,
      bindIssue,
      start,
    },
    bindIssue,
    start,
  };
}

describe("live qualification continuation", () => {
  it("requires the complete exact resume binding when continuation is selected", () => {
    expect(qualificationResumeBinding({})).toBeUndefined();
    expect(() => qualificationResumeBinding({ KEIKO_QUALIFICATION_RESUME_WORKSPACE: "1" })).toThrow(
      "KEIKO_QUALIFICATION_RESUME_PRIOR_RUN_ID",
    );
    expect(
      qualificationResumeBinding({
        KEIKO_QUALIFICATION_RESUME_WORKSPACE: "1",
        KEIKO_QUALIFICATION_RESUME_PRIOR_RUN_ID: RESUME.priorRunId,
        KEIKO_QUALIFICATION_RESUME_WORKSPACE_ID: RESUME.workspaceId,
        KEIKO_QUALIFICATION_RESUME_TASK_ID: RESUME.taskId,
        KEIKO_QUALIFICATION_RESUME_REPOSITORY_ID: RESUME.repositoryId,
        KEIKO_QUALIFICATION_RESUME_BASE_BRANCH: RESUME.baseBranch,
        KEIKO_QUALIFICATION_RESUME_TASK_BRANCH: RESUME.taskBranch,
        KEIKO_QUALIFICATION_RESUME_WORKTREE_PATH: RESUME.managedWorktreePath,
        KEIKO_QUALIFICATION_RESUME_HEAD_SHA: RESUME.headSha,
        KEIKO_QUALIFICATION_RESUME_ISSUE_BINDING_DIGEST: RESUME.issueBindingDigest,
        KEIKO_QUALIFICATION_RESUME_WORKTREE_DIGEST: RESUME.worktreeDigest,
      }),
    ).toEqual(RESUME);
    expect(() =>
      qualificationResumeBinding({
        KEIKO_QUALIFICATION_RESUME_WORKSPACE: "1",
        KEIKO_QUALIFICATION_RESUME_PRIOR_RUN_ID: RESUME.priorRunId,
        KEIKO_QUALIFICATION_RESUME_WORKSPACE_ID: RESUME.workspaceId,
        KEIKO_QUALIFICATION_RESUME_TASK_ID: RESUME.taskId,
        KEIKO_QUALIFICATION_RESUME_REPOSITORY_ID: RESUME.repositoryId,
        KEIKO_QUALIFICATION_RESUME_BASE_BRANCH: RESUME.baseBranch,
        KEIKO_QUALIFICATION_RESUME_TASK_BRANCH: RESUME.taskBranch,
        KEIKO_QUALIFICATION_RESUME_WORKTREE_PATH: RESUME.managedWorktreePath,
        KEIKO_QUALIFICATION_RESUME_HEAD_SHA: RESUME.headSha,
        KEIKO_QUALIFICATION_RESUME_ISSUE_BINDING_DIGEST: RESUME.issueBindingDigest,
        KEIKO_QUALIFICATION_RESUME_WORKTREE_DIGEST: createHash("sha256").digest("hex"),
      }),
    ).toThrow("worktree digest is invalid");
  });

  it("rebinds the exact existing workspace without changing model-authored files", async () => {
    const fixture = client();

    await expect(
      resumeExistingIssueWorkspace(fixture.subject, RESUME, 1, "governed-assist"),
    ).resolves.toMatchObject({
      runId: "run-new",
      issueBinding: { issueNumber: 1, bindingDigest: ISSUE_BINDING_DIGEST },
    });

    expect(fixture.bindIssue).toHaveBeenCalledOnce();
    expect(fixture.start).toHaveBeenCalledOnce();
  });

  it("refuses workspace replacement or worktree mutation before starting", async () => {
    const replaced = client({ activeAfter: active({ workspaceId: "ws_replaced" }) });
    await expect(
      resumeExistingIssueWorkspace(replaced.subject, RESUME, 1, "governed-assist"),
    ).rejects.toThrow("issue bind replaced the active workspace");
    expect(replaced.start).not.toHaveBeenCalled();

    const mutated = client({ digests: [WORKTREE_DIGEST, "9".repeat(64)] });
    await expect(
      resumeExistingIssueWorkspace(mutated.subject, RESUME, 1, "governed-assist"),
    ).rejects.toThrow("issue bind changed model-authored files");
    expect(mutated.start).not.toHaveBeenCalled();
  });

  it("requires a failed exact prior binding and a distinct equally bound continuation run", async () => {
    const wrongPrior = client({ prior: snapshot(PRIOR_RUN_ID, "succeeded") });
    await expect(
      resumeExistingIssueWorkspace(wrongPrior.subject, RESUME, 1, "governed-assist"),
    ).rejects.toThrow("prior run binding is unavailable");
    expect(wrongPrior.bindIssue).not.toHaveBeenCalled();

    const unbound = client({ started: snapshot("run-new", "running", null) });
    await expect(
      resumeExistingIssueWorkspace(unbound.subject, RESUME, 1, "governed-assist"),
    ).rejects.toThrow("newly issue-bound run");

    const reusedId = client({ started: snapshot(PRIOR_RUN_ID, "running") });
    await expect(
      resumeExistingIssueWorkspace(reusedId.subject, RESUME, 1, "governed-assist"),
    ).rejects.toThrow("newly issue-bound run");
  });
});
