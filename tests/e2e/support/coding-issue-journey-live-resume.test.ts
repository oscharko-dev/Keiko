import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CodingWorkbenchIssueBinding,
  CodingWorkbenchRuntimeSnapshot,
} from "@oscharko-dev/keiko-contracts";
import {
  qualificationResumeBinding,
  readQualificationWorktree,
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
  priorState: "cancelled",
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

function valueOr<T>(value: T | undefined, fallback: T): T {
  if (value === undefined) return fallback;
  return value;
}

function client(
  overrides: {
    readonly activeBefore?: ReturnType<typeof active> | null;
    readonly activeAfter?: ReturnType<typeof active> | null;
    readonly prior?: CodingWorkbenchRuntimeSnapshot;
    readonly acknowledged?: CodingWorkbenchRuntimeSnapshot;
    readonly started?: CodingWorkbenchRuntimeSnapshot;
    readonly digests?: readonly string[];
    readonly predecessorRunId?: string | undefined;
  } = {},
): {
  readonly subject: Parameters<typeof resumeExistingIssueWorkspace>[0];
  readonly bindIssue: ReturnType<typeof vi.fn>;
  readonly start: ReturnType<typeof vi.fn>;
  readonly acknowledgeRecovery: ReturnType<typeof vi.fn>;
  readonly retry: ReturnType<typeof vi.fn>;
} {
  const readActiveWorkspace = vi
    .fn<() => Promise<ReturnType<typeof active> | null>>()
    .mockResolvedValueOnce(valueOr(overrides.activeBefore, active()))
    .mockResolvedValueOnce(valueOr(overrides.activeAfter, active()));
  const readWorktree = vi
    .fn<(path: string) => Promise<{ readonly headSha: string; readonly digest: string }>>()
    .mockResolvedValueOnce({
      headSha: HEAD_SHA,
      digest: valueOr(overrides.digests?.[0], WORKTREE_DIGEST),
    })
    .mockResolvedValueOnce({
      headSha: HEAD_SHA,
      digest: valueOr(overrides.digests?.[1], WORKTREE_DIGEST),
    });
  const bindIssue = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const start = vi
    .fn<() => Promise<CodingWorkbenchRuntimeSnapshot>>()
    .mockResolvedValue(valueOr(overrides.started, snapshot("run-new", "running")));
  const acknowledgeRecovery = vi
    .fn<() => Promise<CodingWorkbenchRuntimeSnapshot>>()
    .mockResolvedValue(
      valueOr(overrides.acknowledged, {
        ...snapshot(PRIOR_RUN_ID, "recovery-required"),
        recoveryAcknowledged: true,
      }),
    );
  const retry = vi
    .fn<() => Promise<CodingWorkbenchRuntimeSnapshot>>()
    .mockResolvedValue(valueOr(overrides.started, snapshot("run-new", "running")));
  return {
    subject: {
      readActiveWorkspace,
      readPriorRun: vi
        .fn<(runId: string) => Promise<CodingWorkbenchRuntimeSnapshot>>()
        .mockResolvedValue(valueOr(overrides.prior, snapshot(PRIOR_RUN_ID, RESUME.priorState))),
      readWorktree,
      bindIssue,
      start,
      acknowledgeRecovery,
      retry,
      readPredecessorRunId: vi
        .fn<(runId: string) => string | undefined>()
        .mockReturnValue(valueOr(overrides.predecessorRunId, PRIOR_RUN_ID)),
    },
    bindIssue,
    start,
    acknowledgeRecovery,
    retry,
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
        KEIKO_QUALIFICATION_RESUME_PRIOR_STATE: RESUME.priorState,
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
        KEIKO_QUALIFICATION_RESUME_PRIOR_STATE: RESUME.priorState,
      }),
    ).toThrow("worktree digest is invalid");
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
        KEIKO_QUALIFICATION_RESUME_WORKTREE_DIGEST: RESUME.worktreeDigest,
        KEIKO_QUALIFICATION_RESUME_PRIOR_STATE: "running",
      }),
    ).toThrow("prior state is invalid");
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
        KEIKO_QUALIFICATION_RESUME_PRIOR_STATE: "recovery-required",
        KEIKO_QUALIFICATION_RESUME_CORRECTION_INSTRUCTIONS: "  Repair the overflow regression.  ",
      }),
    ).toMatchObject({
      priorState: "recovery-required",
      correctionInstructions: "Repair the overflow regression.",
    });
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
        KEIKO_QUALIFICATION_RESUME_WORKTREE_DIGEST: RESUME.worktreeDigest,
        KEIKO_QUALIFICATION_RESUME_PRIOR_STATE: "recovery-required",
        KEIKO_QUALIFICATION_RESUME_CORRECTION_INSTRUCTIONS: "x".repeat(4_097),
      }),
    ).toThrow("correction instructions are invalid");
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

  it("requires the configured terminal prior binding and a distinct equally bound run", async () => {
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

    const failedResume = { ...RESUME, priorState: "failed" as const };
    const failedPrior = client({ prior: snapshot(PRIOR_RUN_ID, "failed") });
    await expect(
      resumeExistingIssueWorkspace(failedPrior.subject, failedResume, 1, "governed-assist"),
    ).resolves.toMatchObject({ runId: "run-new" });
  });

  it("acknowledges recovery and retries the same workspace with an exact predecessor", async () => {
    const resume = { ...RESUME, priorState: "recovery-required" as const };
    const fixture = client({
      prior: snapshot(PRIOR_RUN_ID, "recovery-required"),
      predecessorRunId: PRIOR_RUN_ID,
    });

    await expect(
      resumeExistingIssueWorkspace(fixture.subject, resume, 1, "governed-assist"),
    ).resolves.toMatchObject({ runId: "run-new" });

    expect(fixture.acknowledgeRecovery).toHaveBeenCalledOnce();
    expect(fixture.retry).toHaveBeenCalledOnce();
    expect(fixture.bindIssue).not.toHaveBeenCalled();
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("refuses a recovery retry after workspace mutation or without predecessor linkage", async () => {
    const resume = { ...RESUME, priorState: "recovery-required" as const };
    const mutated = client({
      prior: snapshot(PRIOR_RUN_ID, "recovery-required"),
      digests: [WORKTREE_DIGEST, "9".repeat(64)],
    });
    await expect(
      resumeExistingIssueWorkspace(mutated.subject, resume, 1, "governed-assist"),
    ).rejects.toThrow("recovery acknowledgement changed model-authored files");
    expect(mutated.retry).not.toHaveBeenCalled();

    const unlinked = client({
      prior: snapshot(PRIOR_RUN_ID, "recovery-required"),
      predecessorRunId: "run-other",
    });
    await expect(
      resumeExistingIssueWorkspace(unlinked.subject, resume, 1, "governed-assist"),
    ).rejects.toThrow("predecessor binding is unavailable");
  });

  it("retains the acknowledged recovery after a failed successor admission", async () => {
    const resume = { ...RESUME, priorState: "recovery-required" as const };
    const fixture = client({
      prior: {
        ...snapshot(PRIOR_RUN_ID, "recovery-required"),
        recoveryAcknowledged: true,
      },
    });
    fixture.acknowledgeRecovery.mockRejectedValue(new Error("already acknowledged"));
    await expect(
      resumeExistingIssueWorkspace(fixture.subject, resume, 1, "governed-assist"),
    ).resolves.toMatchObject({ runId: "run-new" });
    expect(fixture.acknowledgeRecovery).not.toHaveBeenCalled();
    expect(fixture.retry).toHaveBeenCalledOnce();
  });
});

const temporaryRepositories: string[] = [];

function git(repository: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: repository, stdio: "ignore", timeout: 30_000 });
}

function repositoryFixture(): string {
  const repository = mkdtempSync(join(tmpdir(), "keiko-live-resume-"));
  temporaryRepositories.push(repository);
  git(repository, "init", "-q");
  git(repository, "config", "user.email", "fixture@example.invalid");
  git(repository, "config", "user.name", "Fixture");
  writeFileSync(join(repository, "index.js"), "module.exports = 1;\n");
  git(repository, "add", "index.js");
  git(repository, "commit", "-qm", "fixture");
  return repository;
}

afterEach(() => {
  for (const repository of temporaryRepositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

describe("qualification worktree identity", () => {
  it("changes when either tracked or untracked regular-file bytes change", async () => {
    const repository = repositoryFixture();
    const initial = await readQualificationWorktree(repository);
    writeFileSync(join(repository, "index.js"), "module.exports = 2;\n");
    const tracked = await readQualificationWorktree(repository);
    mkdirSync(join(repository, "lib"));
    writeFileSync(join(repository, "lib", "finite.js"), "module.exports = 3;\n");
    const untracked = await readQualificationWorktree(repository);

    expect(new Set([initial.digest, tracked.digest, untracked.digest])).toHaveLength(3);
    expect(untracked.headSha).toBe(initial.headSha);
  });

  it.each(["tracked", "untracked"])("refuses a %s symbolic link", async (kind) => {
    const repository = repositoryFixture();
    const targetName = `${kind}-target.js`;
    writeFileSync(join(repository, targetName), "module.exports = 2;\n");
    const linked = join(repository, kind === "tracked" ? "index.js" : "link.js");
    if (kind === "tracked") rmSync(linked);
    symlinkSync(targetName, linked);

    await expect(readQualificationWorktree(repository)).rejects.toThrow(
      "qualification continuation only accepts stable regular files",
    );
  });

  it("refuses a tracked file below a parent link before accepting its outside target", async () => {
    const repository = repositoryFixture();
    const outside = mkdtempSync(join(tmpdir(), "keiko-live-resume-outside-"));
    temporaryRepositories.push(outside);
    mkdirSync(join(repository, "lib"));
    writeFileSync(join(repository, "lib", "finite.js"), "module.exports = 3;\n");
    git(repository, "add", "lib/finite.js");
    rmSync(join(repository, "lib"), { recursive: true });
    writeFileSync(join(outside, "finite.js"), "module.exports = 4;\n");
    symlinkSync(outside, join(repository, "lib"));

    await expect(readQualificationWorktree(repository)).rejects.toThrow(
      "qualification continuation file is unsafe or too large",
    );
  });

  it("refuses a file that exceeds the aggregate identity byte bound", async () => {
    const repository = repositoryFixture();
    writeFileSync(join(repository, "oversized.bin"), Buffer.alloc(16 * 1024 * 1024 + 1));

    await expect(readQualificationWorktree(repository)).rejects.toThrow(
      "qualification continuation file is unsafe or too large",
    );
  });

  it.skipIf(process.platform === "win32")("binds executable mode as well as bytes", async () => {
    const repository = repositoryFixture();
    git(repository, "config", "core.filemode", "true");
    const ordinary = await readQualificationWorktree(repository);
    chmodSync(join(repository, "index.js"), 0o755);
    const executable = await readQualificationWorktree(repository);

    expect(executable.digest).not.toBe(ordinary.digest);
  });
});
