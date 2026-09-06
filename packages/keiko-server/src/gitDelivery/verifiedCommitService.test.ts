import { runtimeGitDiff } from "./runtimeGitRead.js";
import { redactLogFields } from "../observability/log-redaction.js";
import { RuntimeGitService } from "./runtimeGitService.js";
import { commitFacadeFixture } from "./verifiedCommitFacadeTestSupport.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  VerificationReport,
  GitDeliveryApprovalClaim,
  GitCommitMessageValidation,
} from "@oscharko-dev/keiko-contracts";
import { isVerifiedCommitResult } from "@oscharko-dev/keiko-contracts/runtime/verified-commit";
import { createCodingRuntimeSnapshotStore } from "../coding-runtime/codingRuntimeSnapshotStore.js";
import { runMigrations } from "../store/schema.js";
import { createVerifiedCommitService } from "./verifiedCommitService.js";
import { createInMemoryGitDeliveryApprovalStore } from "./approvalStore.js";
import type {
  VerifiedCommitRunContext,
  VerifiedCommitService,
  VerifiedCommitServiceOptions,
} from "./verifiedCommitTypes.js";
import type { ServerLogEvent } from "../observability/server-log.js";

// #3386 AC11: the interactive staged-diff review this service owns must never reach for #3397's
// immutable merge-base-to-head PR snapshot service. A throwing fake proves it structurally — if
// `readVerifiedCommitReview`'s call graph ever imported/invoked `createGitChangeSnapshotService`,
// the propose() flow below would throw instead of returning "approval-required".
const gitChangeSnapshotServiceSpy = vi.hoisted(() => vi.fn());
vi.mock("../gitChangeSnapshotService.js", () => ({
  createGitChangeSnapshotService: (...args: unknown[]): never => {
    gitChangeSnapshotServiceSpy(...args);
    throw new Error(
      "gitChangeSnapshotService must never be constructed by the verified-commit review path (#3386 AC11)",
    );
  },
}));

let root: string;
let db: DatabaseSync;
let live: boolean;
let now: number;
let service: VerifiedCommitService;
let options: VerifiedCommitServiceOptions;
let events: ServerLogEvent[];
let evidence: Map<string, string>;
const DIGEST = "a".repeat(64);
function git(args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}
function report(passed = true): VerificationReport {
  if (passed) execFileSync(process.execPath, ["--check", "code.js"], { cwd: root });
  return {
    workspaceRoot: root,
    overallStatus: passed ? "passed" : "failed",
    startedAtMs: now,
    durationMs: 1,
    counts: {
      passed: passed ? 1 : 0,
      failed: passed ? 0 : 1,
      skipped: 0,
      denied: 0,
      cancelled: 0,
      "resource-exceeded": 0,
      "timed-out": 0,
    },
    results: [
      {
        kind: "typecheck",
        scriptName: "check",
        command: "node",
        args: ["--check", "code.js"],
        status: passed ? "passed" : "failed",
        exitCode: passed ? 0 : 1,
        signal: null,
        durationMs: 1,
        truncated: false,
        redacted: true,
        outputSummary: "",
        appliedLimits: [],
      },
    ],
  };
}
function context(): VerifiedCommitRunContext {
  return {
    runId: "run-1",
    envelopeDigest: "b".repeat(64),
    runtimeAuthorityDigest: DIGEST,
    workspaceDigest: DIGEST,
    repositoryDigest: DIGEST,
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
    correlationId: "verified-commit-test",
    buffersClean: () => true,
    stillAuthorized: () => live,
  };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-commit-service-")));
  git(["init", "-qb", "dev"]);
  git(["config", "user.name", "Keiko Test"]);
  git(["config", "user.email", "keiko@example.test"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, "code.js"), "export const value = 1;\n");
  git(["add", "code.js"]);
  git(["commit", "-qm", "base"]);
  git(["checkout", "-qb", "codex/task"]);
  writeFileSync(join(root, "code.js"), "export const value = 2;\n");
  git(["add", "code.js"]);
  live = true;
  now = Date.parse("2026-09-04T10:00:00.000Z");
  events = [];
  evidence = new Map();
  db = new DatabaseSync(":memory:");
  runMigrations(db);
  const snapshots = createCodingRuntimeSnapshotStore(db);
  snapshots.create({
    schemaVersion: "1",
    runId: "run-1",
    state: "running",
    revision: 1,
    requestedMode: "governed-assist",
    runtimeSource: "keiko-sidecar",
    modelSource: "keiko-model-gateway",
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    taskDigest: DIGEST,
    workspaceDigest: DIGEST,
    operatorDigest: DIGEST,
    authorityDigest: DIGEST,
    bindingDigest: DIGEST,
    provenanceDigest: DIGEST,
    toolCallCount: 0,
    patchByteCount: 0,
    modelRequestCount: 0,
  });
  options = {
    context,
    snapshots,
    mutationDeps: {
      redactor: (value): unknown => value,
      evidenceStore: {
        put: (id, body): string => {
          evidence.set(id, body);
          return id;
        },
        get: (id): string | undefined => evidence.get(id),
        list: (): readonly string[] => [...evidence.keys()],
        delete: (id): void => {
          evidence.delete(id);
        },
      },
    },
    messageAllowed: (message): Promise<boolean> => Promise.resolve(message.startsWith("feat:")),
    execution: {
      processEnv: { PATH: process.env.PATH, HOME: root },
      now: (): number => now,
      approvalStore: createInMemoryGitDeliveryApprovalStore(),
      activityLog: {
        write: (event): void => {
          events.push(event);
        },
      },
      branchProtectionReader: (): Promise<{ readonly outcome: "unprotected" }> =>
        Promise.resolve({ outcome: "unprotected" }),
    },
  };
  service = createVerifiedCommitService(options);
});
afterEach(() => {
  service.invalidate();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function verifiedProposal(): Promise<string> {
  const ticket = await service.beginVerification();
  if (ticket === undefined) throw new Error("verification ticket unavailable");
  expect(await service.completeVerification(ticket, report())).toBe(true);
  const proposal = await service.propose("feat: approved exact candidate");
  expect(proposal?.status).toBe("approval-required");
  if (proposal === undefined) throw new Error("proposal unavailable");
  return proposal.proposalId;
}
async function claim(proposalId: string): Promise<GitDeliveryApprovalClaim> {
  const approval = await service.approve(proposalId);
  if (approval === undefined) throw new Error("approval unavailable");
  return approval;
}

describe("#3386 AC11 — readVerifiedCommitReview never consults gitChangeSnapshotService", () => {
  it("builds the interactive staged-diff review without ever constructing the PR-snapshot service", async () => {
    const proposalId = await verifiedProposal();
    expect(gitChangeSnapshotServiceSpy).not.toHaveBeenCalled();
    expect(service.review(proposalId)?.review.paths).toEqual(["code.js"]);
  });
});

describe("verified Code-task commit service", () => {
  it("revokes an already captured execution when verification authority is invalidated before mutation", async () => {
    service = createVerifiedCommitService({
      ...options,
      execution: {
        ...options.execution,
        conflictMarkerReader: (): Promise<number> => {
          service.invalidate();
          return Promise.resolve(0);
        },
      },
    });
    const id = await verifiedProposal();
    const approval = await claim(id);
    const head = git(["rev-parse", "HEAD"]);
    expect((await service.execute(id, approval))?.status).not.toBe("succeeded");
    expect(git(["rev-parse", "HEAD"])).toBe(head);
  });
  it.each(["expired", "aborted", "aborted-read"] as const)(
    "discards verification proof when the trusted guard becomes %s during the final facts read",
    async (reason) => {
      let completing = false;
      let repairLive = true;
      const abort = new AbortController();
      service = createVerifiedCommitService({
        ...options,
        context: () => ({
          ...context(),
          buffersClean: (): boolean => {
            if (completing) {
              if (reason === "expired") repairLive = false;
              else abort.abort();
              if (reason === "aborted-read") throw new Error("Verification fact read cancelled");
            }
            return true;
          },
        }),
      });
      const ticket = await service.beginVerification();
      if (ticket === undefined) throw new Error("verification unavailable");
      completing = true;
      expect(
        await service.completeVerification(ticket, report(), {
          check: () => repairLive,
          signal: abort.signal,
        }),
      ).toBe(false);
      expect(evidence.size).toBe(0);
      completing = false;
      expect(await service.propose("feat: must verify again")).toMatchObject({
        status: "verification-failed",
        reason: "verification-missing",
      });
      const discarded = events.find((event) => event.extra?.phase === "verification-discarded");
      expect(discarded).toMatchObject({
        op: "git.verified-commit",
        correlationId: "verified-commit-test",
        extra: { phase: "verification-discarded", reason: "authority-denied" },
      });
    },
  );
  it("invalidates a prior approved proposal when fresh verification starts and fails", async () => {
    const id = await verifiedProposal();
    const approval = await service.approve(id);
    if (approval === undefined) throw new Error("approval unavailable");
    const ticket = await service.beginVerification();
    if (ticket === undefined) throw new Error("verification unavailable");
    expect(await service.completeVerification(ticket, report(false))).toBe(false);
    expect(service.review(id)).toBeUndefined();
    expect(service.matchesApproval(id, approval)).toBe(false);
    expect(await service.execute(id, approval)).toBeUndefined();
    expect(git(["rev-list", "--count", "dev..HEAD"])).toBe("0");
  });

  it.each(["failed", "denied", "cancelled", "timed-out", "resource-exceeded", "skipped"] as const)(
    "rejects a contradictory passed report with a %s result",
    async (status) => {
      const ticket = await service.beginVerification();
      if (ticket === undefined) throw new Error("verification unavailable");
      const passed = report();
      const contradictory = {
        ...passed,
        results: passed.results.map((result) => ({ ...result, status })),
      };
      expect(await service.completeVerification(ticket, contradictory)).toBe(false);
      expect((await service.propose("feat: rejected report"))?.status).toBe("verification-failed");
      expect(git(["rev-list", "--count", "dev..HEAD"])).toBe("0");
    },
  );

  it("uses real verification, one-use approval, kernel execution and the existing runtime ledger", async () => {
    const proposalId = await verifiedProposal();
    const approval = await claim(proposalId);
    const result = await service.execute(proposalId, approval);
    expect(result?.status, JSON.stringify(events)).toBe("succeeded");
    expect(isVerifiedCommitResult(result)).toBe(true);
    expect(evidence.get(result?.verificationEvidenceId ?? "")).toBeDefined();
    expect(JSON.stringify([...evidence.values()])).not.toContain("code.js");
    expect(result?.headSha).toBe(git(["rev-parse", "HEAD"]));
    expect(options.snapshots.get("run-1")?.verifiedCommitResult).toEqual(result);
    expect(await service.execute(proposalId, approval)).toBeUndefined();
    expect(
      JSON.stringify(
        db.prepare("SELECT verified_commit_result FROM coding_runtime_snapshots").get(),
      ),
    ).not.toContain("approved exact candidate");
    expect(JSON.stringify(events)).not.toContain(approval.approvalToken);
    expect(
      events.some(
        (event) =>
          event.op === "git.verified-commit" &&
          event.correlationId === "verified-commit-test" &&
          event.extra?.state === "succeeded",
      ),
    ).toBe(true);
  });
  it("requires verification and refuses forged or cross-proposal approvals without a Git effect", async () => {
    const before = git(["rev-parse", "HEAD"]);
    expect((await service.propose("feat: no verification"))?.status).toBe("verification-failed");
    const id = await verifiedProposal();
    const approval = await claim(id);
    expect((await service.execute(id, { ...approval, approvalToken: "invalid" }))?.reason).toBe(
      "approval-invalid",
    );
    expect(git(["rev-parse", "HEAD"])).toBe(before);
  });
  it("logs a body-free reason when an unstaged candidate cannot receive commit proof", async () => {
    writeFileSync(join(root, "code.js"), "export const value = 3;\n");
    expect(await service.beginVerification()).toBeUndefined();
    const event = events.find((candidate) => candidate.extra?.phase === "verification-unavailable");
    expect(event).toMatchObject({
      op: "git.verified-commit",
      correlationId: "verified-commit-test",
      extra: { phase: "verification-unavailable", reason: "candidate-not-staged" },
    });
    expect(JSON.stringify(events)).not.toContain("code.js");
  });
  it("invalidates verification when staged content changes after a green command", async () => {
    const id = await verifiedProposal();
    const approval = await claim(id);
    writeFileSync(join(root, "code.js"), "export const value = 3;\n");
    git(["add", "code.js"]);
    expect((await service.execute(id, approval))?.status).toBe("drift");
    expect(git(["rev-list", "--count", "dev..HEAD"])).toBe("0");
  });
  it("rejects expiry, revocation, and restart replay without resurrecting a claim", async () => {
    const id = await verifiedProposal();
    const approval = await claim(id);
    now += 5 * 60 * 1000;
    expect(await service.execute(id, approval)).toBeUndefined();
    service = createVerifiedCommitService(options);
    expect(await service.execute(id, approval)).toBeUndefined();
    live = false;
    expect(await service.propose("feat: revoked")).toBeUndefined();
    expect(git(["rev-list", "--count", "dev..HEAD"])).toBe("0");
  });
  it("reconciles an interrupted receipt from live commit objects without replaying its approval", async () => {
    const id = await verifiedProposal();
    const approval = await claim(id);
    const completed = await service.execute(id, approval);
    if (completed === undefined) throw new Error("receipt unavailable");
    const { headSha, committedTreeDigest, ...binding } = completed;
    expect(headSha).toBe(git(["rev-parse", "HEAD"]));
    expect(committedTreeDigest).toBe(completed.stagedTreeDigest);
    options.snapshots.recordVerifiedCommit({
      ...binding,
      status: "recovery-required",
      reason: "execution-uncertain",
    });
    service = createVerifiedCommitService(options);
    expect(await service.execute(id, approval)).toBeUndefined();
    expect((await service.reconcile())?.headSha).toBe(git(["rev-parse", "HEAD"]));
    expect(git(["rev-list", "--count", "dev..HEAD"])).toBe("1");
    expect(
      events.some(
        (event) => event.extra?.phase === "reconcile" && event.extra.state === "succeeded",
      ),
    ).toBe(true);
  });
  it("keeps recovery uncertain when the live commit message does not match the approved object", async () => {
    const id = await verifiedProposal();
    const proposed = options.snapshots.get("run-1")?.verifiedCommitResult;
    if (proposed === undefined) throw new Error("receipt unavailable");
    options.snapshots.recordVerifiedCommit({
      ...proposed,
      status: "recovery-required",
      reason: "execution-uncertain",
    });
    git(["commit", "-qm", "feat: another commit"]);
    service = createVerifiedCommitService(options);
    expect((await service.reconcile())?.status).toBe("recovery-required");
    expect(service.issueApproval(id)).toBeUndefined();
  });
  it.each(["governed-assist", "supervised-coding", "autonomous-delivery"] as const)(
    "routes actual verification, review, approval and commit through the runtime facade in %s",
    async (mode) => {
      const {
        facade,
        bridge,
        events: runtimeEvents,
        verification,
      } = commitFacadeFixture({ service, root, mode, live: () => live, report });
      const invoke = (body: unknown): ReturnType<typeof facade.execute> =>
        facade.execute({ capability: "server-capability", body: JSON.stringify(body) });
      expect((await invoke(verification)).status).toBe("completed");
      const proposed = await invoke({
        action: "delivery",
        intent: "commit",
        phase: "propose",
        actionId: "propose-1",
        idempotencyKey: "propose-1",
        message: "feat: reviewed runtime commit",
      });
      expect(proposed.status).toBe("completed");
      if (!("verifiedCommit" in proposed))
        throw new Error("receipt missing from runtime observation");
      const id = proposed.verifiedCommit.proposalId;
      expect(proposed.verifiedCommit.status).toBe("approval-required");
      expect(service.review(id)?.review.verifiedCommit?.message).toBe(
        "feat: reviewed runtime commit",
      );
      expect(
        runtimeEvents.some(
          (event) =>
            event.kind === "permission-requested" && event.permissionRequest?.requestId === id,
        ),
      ).toBe(true);
      const execute = {
        action: "delivery",
        intent: "commit",
        phase: "execute",
        proposalId: id,
        actionId: "commit-1",
        idempotencyKey: "commit-1",
      };
      expect((await invoke(execute)).status).toBe("denied");
      expect(bridge.issueCommit?.("other-run", id)).toBeUndefined();
      expect(bridge.issueCommit?.("run-1", id)).toBeDefined();
      const result = await invoke({ ...execute, actionId: "commit-2", idempotencyKey: "commit-2" });
      expect(result).toMatchObject({
        status: "completed",
        verifiedCommit: { status: "succeeded", headSha: git(["rev-parse", "HEAD"]) },
      });
      expect(
        (await invoke({ ...execute, actionId: "commit-3", idempotencyKey: "commit-3" })).status,
      ).toBe("denied");
      expect(git(["rev-list", "--count", "dev..HEAD"])).toBe("1");
    },
  );
  it("does not turn a forged client proof into the server-held approved binding", async () => {
    const id = await verifiedProposal();
    service.issueApproval(id);
    expect(service.matchesApproval(id)).toBe(true);
    expect(
      service.matchesApproval(id, {
        schemaVersion: "1",
        approvalId: "forged",
        approvalToken: "0".repeat(64),
      }),
    ).toBe(false);
    const lease = service.consumeApproval(id);
    if (lease === undefined) throw new Error("execution lease unavailable");
    expect(await service.executeApproved(id, { ...lease })).toBeUndefined();
    expect((await service.executeApproved(id, lease))?.status).toBe("succeeded");
    expect(await service.executeApproved(id, lease)).toBeUndefined();
  });
  it("retains the kernel's closed policy block reason without committing", async () => {
    service = createVerifiedCommitService({
      ...options,
      execution: {
        ...options.execution,
        policyPacks: {
          repoPack: {
            schemaVersion: "1",
            repoId: "policy-1",
            rules: [],
            defaultRule: { decision: "blocked" },
          },
        },
      },
    });
    const id = await verifiedProposal();
    const result = await service.execute(id, await claim(id));
    expect(result).toMatchObject({
      status: "blocked",
      reason: "policy-block",
      blockReason: "policy-pack-blocked",
    });
    expect(isVerifiedCommitResult(result)).toBe(true);
    expect(git(["rev-list", "--count", "dev..HEAD"])).toBe("0");
  });
  it("cancels a consumed action lease before the mutation effect without restoring the approval", async () => {
    const id = await verifiedProposal();
    service.issueApproval(id);
    const lease = service.consumeApproval(id);
    if (lease === undefined) throw new Error("lease unavailable");
    await expect(service.executeApproved(id, lease, { check: () => false })).resolves.toMatchObject(
      { status: "blocked", reason: "authority-denied" },
    );
    expect(service.matchesApproval(id)).toBe(false);
    expect(git(["rev-list", "--count", "dev..HEAD"])).toBe("0");
  });
  it("rejects issue-closing message injection even after verification", async () => {
    await verifiedProposal();
    expect((await service.propose("feat: change\n\nCloses #123"))?.reason).toBe("issue-directive");
  });
  it("carries closed violation codes on a message-policy block instead of only a boolean (#3390)", async () => {
    service = createVerifiedCommitService({
      ...options,
      messageAllowed: (message): Promise<GitCommitMessageValidation> =>
        Promise.resolve(
          message.startsWith("feat:")
            ? { ok: true }
            : { ok: false, violations: ["missing-conventional-prefix", "subject-too-long"] },
        ),
    });
    await verifiedProposal();
    const result = await service.propose("rejected commit message without a prefix");
    expect(result).toMatchObject({
      status: "blocked",
      reason: "message-policy",
      violations: ["missing-conventional-prefix", "subject-too-long"],
    });
    expect(isVerifiedCommitResult(result)).toBe(true);
    const logged = events.find((event) => event.extra?.reason === "message-policy");
    expect(logged).toMatchObject({
      op: "git.verified-commit",
      extra: {
        phase: "result",
        reason: "message-policy",
        violations: ["missing-conventional-prefix", "subject-too-long"],
        violationCount: 2,
      },
    });
  });
  it("still blocks on a message-policy violation when messageAllowed returns only a boolean", async () => {
    await verifiedProposal();
    const result = await service.propose("rejected");
    expect(result).toMatchObject({ status: "blocked", reason: "message-policy" });
    expect(result?.violations).toBeUndefined();
    expect(isVerifiedCommitResult(result)).toBe(true);
  });
});

describe("productive runtime status/diff/stage lane", () => {
  it("captures stage operands before the first asynchronous admission read", async () => {
    git(["reset", "-q", "HEAD", "--", "code.js"]);
    writeFileSync(join(root, "other.js"), "unrelated bytes\n");
    const gitService = new RuntimeGitService({
      ...options,
      mode: (): "supervised-coding" => "supervised-coding",
      invalidateVerification: (): void => {
        service.invalidate();
      },
    });
    const paths = ["code.js"];
    const pending = gitService.execute(
      {
        action: "git",
        actionId: "immutable",
        idempotencyKey: "immutable",
        operation: "stage",
        phase: "propose",
        paths,
      },
      { check: () => true },
    );
    paths[0] = "other.js";
    const proposal = await pending;
    if (proposal?.kind !== "stage") throw new Error("proposal unavailable");
    expect(gitService.review(proposal.proposalId)?.review.paths).toEqual(["code.js"]);
  });
  it("preserves final-newline metadata in a newline-only diff", async () => {
    writeFileSync(join(root, "code.js"), "export const value = 2;");
    const diff = await runtimeGitDiff(context(), options.execution ?? {}, "unstaged", ["code.js"]);
    expect(diff.files[0]?.hunks[0]?.lines.at(-1)).toMatchObject({
      kind: "meta",
      text: "\\ No newline at end of file",
    });
  });
  it("reviews and stages an executable-mode-only change through the real runtime service", async () => {
    chmodSync(join(root, "code.js"), 0o755);
    const gitService = new RuntimeGitService({
      ...options,
      mode: (): "supervised-coding" => "supervised-coding",
      invalidateVerification: (): void => {
        service.invalidate();
      },
    });
    const proposed = await gitService.execute(
      {
        action: "git",
        actionId: "mode",
        idempotencyKey: "mode",
        operation: "stage",
        phase: "propose",
        paths: ["code.js"],
      },
      { check: () => true },
    );
    expect(proposed).toMatchObject({ kind: "stage", status: "ready" });
    if (proposed?.kind !== "stage") throw new Error("proposal unavailable");
    expect(
      await gitService.execute(
        {
          action: "git",
          actionId: "mode-execute",
          idempotencyKey: "mode-execute",
          operation: "stage",
          phase: "execute",
          proposalId: proposed.proposalId,
        },
        { check: () => true },
      ),
    ).toMatchObject({ status: "succeeded" });
    expect(git(["ls-files", "--stage", "--", "code.js"])).toMatch(/^100755 /u);
  });
  it("reads raw working changes and refuses active filter semantics without executing their command", async () => {
    git(["reset", "--mixed", "HEAD"]);
    writeFileSync(
      join(root, "filter.cjs"),
      'require("node:fs").writeFileSync("filter-ran", "ran");process.stdout.write("rewritten");',
    );
    writeFileSync(join(root, ".gitattributes"), "*.js filter=unsafe\n");
    git(["config", "filter.unsafe.clean", `"${process.execPath}" "${join(root, "filter.cjs")}"`]);
    const gitService = new RuntimeGitService({
      ...options,
      mode: (): "autonomous-delivery" => "autonomous-delivery",
      invalidateVerification: (): void => {
        service.invalidate();
      },
    });
    const guard = { check: (): boolean => true };
    expect(
      await gitService.execute(
        { action: "git", actionId: "status", idempotencyKey: "status", operation: "status" },
        guard,
      ),
    ).toMatchObject({ kind: "status" });
    expect(
      await gitService.execute(
        {
          action: "git",
          actionId: "diff",
          idempotencyKey: "diff",
          operation: "diff",
          scope: "working-tree",
          paths: ["code.js"],
        },
        guard,
      ),
    ).toMatchObject({ kind: "diff" });
    expect(
      await gitService.execute(
        {
          action: "git",
          actionId: "stage",
          idempotencyKey: "stage",
          operation: "stage",
          phase: "propose",
          paths: ["code.js"],
        },
        guard,
      ),
    ).toMatchObject({ kind: "stage", status: "blocked", reason: "unsupported-transformation" });
    expect(existsSync(join(root, "filter-ran"))).toBe(false);
  });
  it("refuses stale stage bytes, expired approvals and cancelled stage effects", async () => {
    git(["reset", "--mixed", "HEAD"]);
    const gitService = new RuntimeGitService({
      ...options,
      mode: (): "autonomous-delivery" => "autonomous-delivery",
      invalidateVerification: (): void => {
        service.invalidate();
      },
    });
    const guard = { check: (): boolean => true };
    const proposal = await gitService.execute(
      {
        action: "git",
        actionId: "stage",
        idempotencyKey: "stage",
        operation: "stage",
        phase: "propose",
        paths: ["code.js"],
      },
      guard,
    );
    if (proposal?.kind !== "stage") throw new Error("missing stage proposal");
    const index = git(["write-tree"]);
    writeFileSync(join(root, "code.js"), "export const value = 3;\n");
    expect(
      await gitService.execute(
        {
          action: "git",
          actionId: "execute",
          idempotencyKey: "execute",
          operation: "stage",
          phase: "execute",
          proposalId: proposal.proposalId,
        },
        guard,
      ),
    ).toMatchObject({ status: "drift" });
    expect(git(["write-tree"])).toBe(index);
    now += 300_001;
    expect(gitService.issueApproval(proposal.proposalId)).toBeUndefined();
    expect(
      await gitService.execute(
        {
          action: "git",
          actionId: "cancelled",
          idempotencyKey: "cancelled",
          operation: "stage",
          phase: "execute",
          proposalId: proposal.proposalId,
        },
        guard,
        AbortSignal.abort(),
      ),
    ).toBeUndefined();
    expect(git(["write-tree"])).toBe(index);
  });

  it.each(["governed-assist", "supervised-coding", "autonomous-delivery"] as const)(
    "stages the exact selected candidate through the facade in %s",
    async (mode) => {
      git(["reset", "--mixed", "HEAD"]);
      const gitService = new RuntimeGitService({
        ...options,
        mode: (): typeof mode => mode,
        invalidateVerification: (): void => {
          service.invalidate();
        },
      });
      const fixture = commitFacadeFixture({
        service,
        gitService,
        root,
        mode,
        live: () => live,
        report,
      });
      const invoke = (body: Record<string, unknown>): ReturnType<typeof fixture.facade.execute> =>
        fixture.facade.execute({
          capability: "test-capability",
          body: JSON.stringify({
            action: "git",
            actionId: `action-${Object.keys(body).join("-")}-${String(body.phase)}`,
            idempotencyKey: JSON.stringify(body),
            ...body,
          }),
        });
      const status = await invoke({ operation: "status" });
      expect(status).toMatchObject({
        status: "completed",
        git: { kind: "status", changes: [{ path: "code.js", unstaged: true }] },
      });
      const diff = await invoke({ operation: "diff", scope: "working-tree", paths: ["code.js"] });
      expect(diff).toMatchObject({
        status: "completed",
        git: { kind: "diff", diff: { files: [{ path: "code.js" }], truncated: false } },
      });
      const proposed = await invoke({ operation: "stage", phase: "propose", paths: ["code.js"] });
      if (!("git" in proposed) || proposed.git.kind !== "stage")
        throw new Error("stage proposal missing");
      const id = proposed.git.proposalId;
      expect(proposed.git.status).toBe(mode === "governed-assist" ? "approval-required" : "ready");
      if (mode === "governed-assist") {
        expect(fixture.events.at(-1)).toMatchObject({
          kind: "permission-requested",
          permissionRequest: { actionKind: "git-stage", requestId: id },
        });
        expect(fixture.bridge.issueStage?.("foreign-run", id)).toBeUndefined();
        expect(fixture.bridge.issueStage?.("run-1", id)).toBeDefined();
      }
      const staged = await invoke({ operation: "stage", phase: "execute", proposalId: id });
      expect(staged).toMatchObject({
        status: "completed",
        git: { kind: "stage", status: "succeeded", reason: "none" },
      });
      expect(git(["show", ":code.js"])).toBe("export const value = 2;");
      const completed = events.find(
        (event) => event.op === "git.runtime-action" && event.extra?.phase === "stage-execute",
      );
      expect(completed).toMatchObject({ correlationId: "verified-commit-test" });
      expect(redactLogFields(completed?.extra)).toMatchObject({
        phase: "stage-execute",
        runId: "run-1",
        state: "succeeded",
        reason: "none",
        pathCount: 1,
      });
      expect(JSON.stringify(events)).not.toContain("export const");
      expect(gitService.review(id)).toBeUndefined();
    },
  );

  // Owner audit batch 5, item 4 / today's security review (head 02785dbd): `executeOne` used to
  // consume the one-use commit approval BEFORE the unresolved-conflict-marker check that can
  // legitimately block the commit, so a legitimate block burned the approval and the operator had
  // to re-propose and re-approve. Mirrors commitRoutes.ts's own ordering (message policy, THEN
  // conflict markers, THEN `resolveGitDeliveryApprovalRequirement` consumes) — every pre-commit
  // validation that can block runs before the approval is spent.
  it("keeps the one-use commit approval intact when unresolved conflict markers legitimately block execute()", async () => {
    let blocking = true;
    service = createVerifiedCommitService({
      ...options,
      execution: {
        ...options.execution,
        conflictMarkerReader: (): Promise<number> => Promise.resolve(blocking ? 1 : 0),
      },
    });
    const id = await verifiedProposal();
    const approval = await claim(id);
    const blocked = await service.execute(id, approval);
    expect(blocked).toMatchObject({ status: "blocked", reason: "conflict-markers" });
    expect(git(["rev-list", "--count", "dev..HEAD"])).toBe("0");
    // The approval was never spent by the legitimate block: the SAME one-use claim still redeems
    // the SAME proposal once the conflict is resolved, with no re-propose/re-approve round trip.
    expect(service.matchesApproval(id, approval)).toBe(true);
    blocking = false;
    const result = await service.execute(id, approval);
    expect(result?.status).toBe("succeeded");
    expect(git(["rev-list", "--count", "dev..HEAD"])).toBe("1");
  });

  // #3384 F4 residual (wave-3 audit): the test above pins `execute()`'s own already-correct order,
  // but the admission-gated path actually wired through the tool facade --
  // codingToolAuthorityPort.ts's `finishAdmission` -> productionManagedWorktreeTools.ts's
  // `runCommitRequest` -- used to call `consumeCommit` (spending the one-use approval) at
  // admission time, strictly BEFORE this preflight block could run. A legitimate block on that
  // path burned the approval anyway, forcing a re-propose/re-approve round trip the direct-`execute`
  // pin above could not catch. This proves the SAME bridge-issued approval survives a
  // conflict-marker block reached through the real tool-authority admission path.
  it("keeps a bridge-issued commit approval redeemable across a conflict-marker block reached through the tool-authority admission path", async () => {
    let blocking = true;
    service = createVerifiedCommitService({
      ...options,
      execution: {
        ...options.execution,
        conflictMarkerReader: (): Promise<number> => Promise.resolve(blocking ? 1 : 0),
      },
    });
    const { facade, bridge, verification } = commitFacadeFixture({
      service,
      root,
      mode: "autonomous-delivery",
      live: () => live,
      report,
    });
    const invoke = (body: unknown): ReturnType<typeof facade.execute> =>
      facade.execute({ capability: "server-capability", body: JSON.stringify(body) });
    expect((await invoke(verification)).status).toBe("completed");
    const proposed = await invoke({
      action: "delivery",
      intent: "commit",
      phase: "propose",
      actionId: "propose-block-1",
      idempotencyKey: "propose-block-1",
      message: "feat: conflict-blocked runtime commit",
    });
    if (!("verifiedCommit" in proposed))
      throw new Error("receipt missing from runtime observation");
    const id = proposed.verifiedCommit.proposalId;
    expect(bridge.issueCommit?.("run-1", id)).toBeDefined();
    const execute = {
      action: "delivery",
      intent: "commit",
      phase: "execute",
      proposalId: id,
      actionId: "commit-block-1",
      idempotencyKey: "commit-block-1",
    };
    const blocked = await invoke(execute);
    expect(blocked).toMatchObject({
      status: "completed",
      verifiedCommit: { status: "blocked", reason: "conflict-markers" },
    });
    expect(git(["rev-list", "--count", "dev..HEAD"])).toBe("0");
    // The admission-consumed lease bug (#3384 F4) would have burned the approval on this
    // legitimate block; the SAME bridge-issued approval still matches the SAME proposal.
    expect(service.matchesApproval(id)).toBe(true);
    blocking = false;
    const result = await invoke({
      ...execute,
      actionId: "commit-block-2",
      idempotencyKey: "commit-block-2",
    });
    expect(result).toMatchObject({
      status: "completed",
      verifiedCommit: { status: "succeeded", headSha: git(["rev-parse", "HEAD"]) },
    });
    expect(git(["rev-list", "--count", "dev..HEAD"])).toBe("1");
  });

  // Owner audit batch 5, item 5 / today's security review: a frozen runtime-authority/workspace
  // binding captured at propose time can make a later persistence attempt throw for a stale
  // proposal; `record()`'s own recovery-path call was unguarded, so a persistence rejection could
  // cascade into an uncaught rejection out of execute()/executeApproved() instead of a closed
  // result. Latent today (nothing mutates the frozen binding columns post-insert), fixed proactively.
  //
  // Review finding (comment 3941793530, #3384 audit): this used to also cover a real bug, not just
  // the latent one above. `executeConsumed()` called `record()` for the pre-effect write-ahead
  // marker and discarded its return value, so a persistence failure here still fell through to
  // `mutate()` and committed anyway — a crash right after left `reconcile()` with no durable
  // recovery-required receipt to inspect. Every persist call throws for the whole test, so this is
  // the pre-effect case: the write-ahead marker itself never reaches durable storage, and the fix
  // must stop before the Git mutation ever runs. HEAD staying put is the assertion that would have
  // failed against the pre-fix code.
  it("fails closed with a recovery-required result and a body-free log line when persisting the outcome throws", async () => {
    let rejectPersist = false;
    const realSnapshots = options.snapshots;
    service = createVerifiedCommitService({
      ...options,
      snapshots: {
        ...realSnapshots,
        recordVerifiedCommit: (result): ReturnType<typeof realSnapshots.recordVerifiedCommit> => {
          if (rejectPersist) throw new Error("snapshot store unavailable");
          return realSnapshots.recordVerifiedCommit(result);
        },
      },
    });
    const id = await verifiedProposal();
    const approval = await claim(id);
    const head = git(["rev-parse", "HEAD"]);
    rejectPersist = true;
    await expect(service.execute(id, approval)).resolves.toMatchObject({
      status: "recovery-required",
      reason: "execution-uncertain",
    });
    // Pre-effect: the write-ahead marker could not be persisted, so the Git mutation must never
    // have run. Before the fix this failed: HEAD advanced even though no recovery-required receipt
    // was ever durably stored.
    expect(git(["rev-parse", "HEAD"])).toBe(head);
    const failure = events.find((event) => event.extra?.phase === "persist-failed");
    expect(failure).toMatchObject({
      op: "git.verified-commit",
      level: "warn",
      errorKind: "internal",
      correlationId: "verified-commit-test",
      extra: { effectPhase: "pre-effect" },
    });
    expect(JSON.stringify(events)).not.toContain("snapshot store unavailable");
  });

  // Same review finding, the post-effect half: the write-ahead marker persists fine (1st call), the
  // Git mutation runs, and only the terminal-result persist (2nd call) fails. Unlike the pre-effect
  // case above, the effect already happened — this must still resolve recovery-required (so a
  // caller never mistakes it for success) but HEAD has legitimately moved, and the log line must
  // say `post-effect`, not `pre-effect`, so an operator reading the activity log per AGENTS.md §8
  // knows a mutation may need reconciliation rather than assuming none was ever attempted.
  it("stays fail-closed as recovery-required, with the mutation already applied, when persistence fails AFTER the Git effect", async () => {
    let persistCalls = 0;
    const realSnapshots = options.snapshots;
    service = createVerifiedCommitService({
      ...options,
      snapshots: {
        ...realSnapshots,
        recordVerifiedCommit: (result): ReturnType<typeof realSnapshots.recordVerifiedCommit> => {
          persistCalls += 1;
          if (persistCalls === 2) throw new Error("snapshot store unavailable");
          return realSnapshots.recordVerifiedCommit(result);
        },
      },
    });
    const id = await verifiedProposal();
    const approval = await claim(id);
    const head = git(["rev-parse", "HEAD"]);
    // `propose()` already persisted the "approval-required" result once; only count persist calls
    // made from inside `execute()` itself (call 1 = pre-effect write-ahead, call 2 = post-effect
    // terminal result).
    persistCalls = 0;
    await expect(service.execute(id, approval)).resolves.toMatchObject({
      status: "recovery-required",
      reason: "execution-uncertain",
    });
    // Post-effect: the write-ahead marker persisted (call 1), so the mutation was allowed to run,
    // and it did — HEAD moved even though the terminal persist (call 2) then failed.
    expect(git(["rev-parse", "HEAD"])).not.toBe(head);
    const failures = events.filter((event) => event.extra?.phase === "persist-failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      op: "git.verified-commit",
      level: "warn",
      errorKind: "internal",
      correlationId: "verified-commit-test",
      extra: { effectPhase: "post-effect" },
    });
    expect(JSON.stringify(events)).not.toContain("snapshot store unavailable");
  });

  // Same bug class as the recovery-path fix above, at reconcile()'s own direct
  // `snapshots.recordVerifiedCommit` call (never routed through `record()`).
  it("fails closed instead of throwing when reconcile cannot persist the recovered outcome", async () => {
    const id = await verifiedProposal();
    const approval = await claim(id);
    const completed = await service.execute(id, approval);
    if (completed === undefined) throw new Error("receipt unavailable");
    const { headSha, committedTreeDigest, ...binding } = completed;
    expect(headSha).toBe(git(["rev-parse", "HEAD"]));
    expect(committedTreeDigest).toBe(completed.stagedTreeDigest);
    options.snapshots.recordVerifiedCommit({
      ...binding,
      status: "recovery-required",
      reason: "execution-uncertain",
    });
    service = createVerifiedCommitService({
      ...options,
      snapshots: {
        ...options.snapshots,
        recordVerifiedCommit: (): never => {
          throw new Error("snapshot store unavailable");
        },
      },
    });
    await expect(service.reconcile()).resolves.toMatchObject({
      status: "recovery-required",
      reason: "execution-uncertain",
    });
    const failure = events.find((event) => event.extra?.phase === "persist-failed");
    expect(failure).toMatchObject({
      op: "git.verified-commit",
      level: "warn",
      errorKind: "internal",
      correlationId: "verified-commit-test",
    });
    expect(JSON.stringify(events)).not.toContain("snapshot store unavailable");
  });
});
