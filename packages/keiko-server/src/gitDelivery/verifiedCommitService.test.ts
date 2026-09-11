import {
  admitStageSelection,
  reviewStageSelection,
  runtimeGitDiff,
  runtimeGitStatus,
} from "./runtimeGitRead.js";
import {
  readGitRawChanges,
  readGitRawWorktreeSnapshot,
} from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { readVerifiedCommitFacts } from "./verifiedCommitFacts.js";
import { LINE_DIFF_MAX_EDIT_DISTANCE } from "./lineDiff.js";
import { redactLogFields } from "../observability/log-redaction.js";
import { UNKNOWN_CORRELATION_ID } from "../correlation.js";
import { GIT_STAGE_FILE_MAX_BYTES } from "@oscharko-dev/keiko-workspace/internal/git-index";
import { RuntimeGitService } from "./runtimeGitService.js";
import { commitFacadeFixture } from "./verifiedCommitFacadeTestSupport.js";
import type { VerificationTicketOutcome } from "./verifiedCommitTypes.js";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { CODING_RUNTIME_GIT_MAX_PATHS } from "@oscharko-dev/keiko-contracts/runtime/coding-runtime-git";
import { createCodingRuntimeSnapshotStore } from "../coding-runtime/codingRuntimeSnapshotStore.js";
import { runMigrations } from "../store/schema.js";
import { createVerifiedCommitService } from "./verifiedCommitService.js";
import { createInMemoryGitDeliveryApprovalStore } from "./approvalStore.js";
import { executeGovernedMutation } from "./execution.js";
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

// The governed stage effect is the one dispatch step a test cannot make throw from the outside
// (its Git command runner is real and its inputs are validated first), so the module is wrapped
// once with the real implementation and a single test replaces one call with a rejection.
vi.mock("./execution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./execution.js")>();
  return { ...actual, executeGovernedMutation: vi.fn(actual.executeGovernedMutation) };
});
// Counted, never replaced: every test reads real Git through the originals, and the single-read pin
// below can assert how many raw reads a refusal took. Both public entry points are counted, because
// the snapshot reader performs its raw read inside keiko-tools where no mock can see it.
vi.mock("@oscharko-dev/keiko-tools/internal/git-mutation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@oscharko-dev/keiko-tools/internal/git-mutation")>();
  return {
    ...actual,
    readGitRawChanges: vi.fn(actual.readGitRawChanges),
    readGitRawWorktreeSnapshot: vi.fn(actual.readGitRawWorktreeSnapshot),
  };
});
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

function ticketOf(outcome: VerificationTicketOutcome): object | undefined {
  return outcome.kind === "ticket" ? outcome.ticket : undefined;
}

async function verifiedProposal(): Promise<string> {
  const ticket = ticketOf(await service.beginVerification());
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
      const ticket = ticketOf(await service.beginVerification());
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
    const ticket = ticketOf(await service.beginVerification());
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
      const ticket = ticketOf(await service.beginVerification());
      if (ticket === undefined) throw new Error("verification unavailable");
      const passed = report();
      const contradictory = {
        ...passed,
        results: passed.results.map((result) => ({ ...result, status })),
      };
      expect(await service.completeVerification(ticket, contradictory)).toBe(false);
      // #3390: a verification that ran and did not pass is named as such -- "verification-missing"
      // is reserved for a workspace that was never verified at all (rehearsal run-16's model read
      // "missing" right after watching a verification and abandoned the delivery).
      expect(await service.propose("feat: rejected report")).toMatchObject({
        status: "verification-failed",
        reason: "verification-failed",
      });
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
  // F80 (coding runs 26 and 27): the pre-effect write-ahead marker was logged under the "result"
  // phase, so every successful commit first read in the activity log as a recovery-required result.
  // The marker is the durable precondition reconcile() reads after a crash, not an outcome: one
  // execute() writes one write-ahead line and, after the Git effect, exactly one result line.
  it("logs the pre-effect write-ahead under its own phase, ahead of exactly one terminal result line", async () => {
    const proposalId = await verifiedProposal();
    const approval = await claim(proposalId);
    const before = events.length;
    const result = await service.execute(proposalId, approval);
    expect(result?.status, JSON.stringify(events)).toBe("succeeded");
    const lines = events.slice(before).filter((event) => event.op === "git.verified-commit");
    const phases = lines.map((event) => event.extra?.phase);
    const writeAhead = lines.filter((event) => event.extra?.phase === "write-ahead");
    const results = lines.filter((event) => event.extra?.phase === "result");
    expect(writeAhead).toHaveLength(1);
    expect(writeAhead[0]).toMatchObject({
      correlationId: "verified-commit-test",
      extra: {
        runId: "run-1",
        state: "recovery-required",
        reason: "execution-uncertain",
        proposalId,
      },
    });
    expect(writeAhead[0]).not.toHaveProperty("level");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      correlationId: "verified-commit-test",
      extra: { runId: "run-1", state: "succeeded", proposalId },
    });
    expect(phases.indexOf("write-ahead")).toBeLessThan(phases.indexOf("result"));
  });
  // F57 (runs 19–28): the pull request's check list comes from the run's verification history,
  // which the commit proof's evidence record carries. A verification of unstaged work cannot prove a
  // commit but is still a check the run ran, and beginVerification()'s own invalidate() must keep it.
  it("carries every verification of the run, unstaged ones included, in the proof's evidence", async () => {
    service.observeVerification(report());
    const proposalId = await verifiedProposal();
    const verification = events.filter((event) => event.extra?.phase === "verification").at(-1);
    expect(verification).toMatchObject({ extra: { passed: true, checkCount: 2 } });
    const stored: unknown = JSON.parse(
      evidence.get(String(verification?.extra?.verificationEvidenceId)) ?? "null",
    );
    expect(stored).toMatchObject({
      checks: {
        omitted: 0,
        records: [
          { steps: [{ kind: "typecheck", status: "passed", exitCode: 0 }] },
          {
            stagedTreeDigest: service.review(proposalId)?.binding.stagedTreeDigest,
            steps: [{ kind: "typecheck", status: "passed", exitCode: 0 }],
          },
        ],
      },
    });
    expect(stored).not.toHaveProperty(["checks", "records", 0, "stagedTreeDigest"]);
  });
  it("starts a new run's verification history empty", async () => {
    let runId = "run-1";
    service = createVerifiedCommitService({ ...options, context: () => ({ ...context(), runId }) });
    service.observeVerification(report());
    runId = "run-2";
    const ticket = ticketOf(await service.beginVerification());
    if (ticket === undefined) throw new Error("verification ticket unavailable");
    expect(await service.completeVerification(ticket, report())).toBe(true);
    expect(events.filter((event) => event.extra?.phase === "verification").at(-1)).toMatchObject({
      extra: { runId: "run-2", checkCount: 1 },
    });
  });
  it("keeps nothing for a verification observed without a live run", async () => {
    live = false;
    service.observeVerification(report());
    live = true;
    await verifiedProposal();
    expect(events.filter((event) => event.extra?.phase === "verification").at(-1)).toMatchObject({
      extra: { checkCount: 1 },
    });
  });
  it("uses Full access policy authorization without minting a local-operator approval", async () => {
    let policyAllowsWithoutApproval = true;
    service = createVerifiedCommitService({
      ...options,
      policyAllowsWithoutApproval: (): boolean => policyAllowsWithoutApproval,
    });
    const proposalId = await verifiedProposal();
    expect(service.matchesApproval(proposalId)).toBe(false);

    const result = await service.execute(proposalId, undefined, { check: () => true });

    expect(result?.status, JSON.stringify(events)).toBe("succeeded");
    expect(git(["rev-list", "--count", "dev..HEAD"])).toBe("1");
    expect(
      events.some(
        (event) =>
          event.op === "git.verified-commit" &&
          event.extra?.phase === "approval" &&
          event.extra.state === "policy-authorized",
      ),
    ).toBe(true);

    policyAllowsWithoutApproval = false;
  });
  it("fails closed when Full access policy authorization is withdrawn before commit execute", async () => {
    let policyAllowsWithoutApproval = true;
    service = createVerifiedCommitService({
      ...options,
      policyAllowsWithoutApproval: (): boolean => policyAllowsWithoutApproval,
    });
    const proposalId = await verifiedProposal();
    const before = git(["rev-parse", "HEAD"]);
    policyAllowsWithoutApproval = false;

    expect(await service.execute(proposalId, undefined, { check: () => true })).toMatchObject({
      status: "blocked",
      reason: "approval-invalid",
    });
    expect(git(["rev-parse", "HEAD"])).toBe(before);
  });
  it("requires verification and refuses forged or cross-proposal approvals without a Git effect", async () => {
    const before = git(["rev-parse", "HEAD"]);
    expect(await service.propose("feat: no verification")).toMatchObject({
      status: "verification-failed",
      reason: "verification-missing",
    });
    const id = await verifiedProposal();
    const approval = await claim(id);
    expect((await service.execute(id, { ...approval, approvalToken: "invalid" }))?.reason).toBe(
      "approval-invalid",
    );
    expect(git(["rev-parse", "HEAD"])).toBe(before);
  });
  // Coding Workbench run 16 (2026-09-10): the refusal named no path, and the model — which had
  // staged every file it wrote — could not find the lockfile the dependency install had created. The
  // outcome names the blocking paths for the model; the activity line keeps counts only.
  // Review finding on #3452: the blocking paths came from a SECOND raw read taken after the facts
  // read that produced the refusal, with no cross-check, so a tree touched in between could hand the
  // model paths that contradict the refusal they ride on. Facts and paths now come from one read.
  it("names the blocking paths from the same raw read that refused the candidate", async () => {
    writeFileSync(join(root, "code.js"), "export const value = 3;\n");
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    const rawReads = vi.mocked(readGitRawChanges);
    const snapshotReads = vi.mocked(readGitRawWorktreeSnapshot);
    rawReads.mockClear();
    snapshotReads.mockClear();

    expect(await service.beginVerification()).toEqual({
      kind: "refused",
      reason: "candidate-not-staged",
      blocking: {
        unstagedCount: 1,
        untrackedCount: 1,
        unstaged: ["code.js"],
        untracked: ["package-lock.json"],
      },
    });
    expect(rawReads.mock.calls.length + snapshotReads.mock.calls.length).toBe(1);
  });
  it("names the paths that keep an unclean candidate from commit proof and logs only their counts", async () => {
    writeFileSync(join(root, "code.js"), "export const value = 3;\n");
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    expect(await service.beginVerification()).toEqual({
      kind: "refused",
      reason: "candidate-not-staged",
      blocking: {
        unstagedCount: 1,
        untrackedCount: 1,
        unstaged: ["code.js"],
        untracked: ["package-lock.json"],
      },
    });
    const event = events.find((candidate) => candidate.extra?.phase === "verification-unavailable");
    expect(event).toMatchObject({
      op: "git.verified-commit",
      correlationId: "verified-commit-test",
      extra: {
        phase: "verification-unavailable",
        reason: "candidate-not-staged",
        unstagedCount: 1,
        untrackedCount: 1,
      },
    });
    expect(JSON.stringify(events)).not.toContain("code.js");
    expect(JSON.stringify(events)).not.toContain("package-lock.json");
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
    // eslint-disable-next-line complexity -- this is the exhaustive three-mode behavior matrix
    async (mode) => {
      service = createVerifiedCommitService({
        ...options,
        policyAllowsWithoutApproval: (): boolean => mode === "autonomous-delivery",
      });
      const {
        facade,
        bridge,
        events: runtimeEvents,
        verification,
      } = commitFacadeFixture({ service, root, mode, live: () => live, report });
      const invoke = (body: unknown): ReturnType<typeof facade.execute> =>
        facade.execute({ capability: "server-capability", body: JSON.stringify(body) });
      expect((await invoke(verification)).status).toBe("completed");
      const pendingProposal = invoke({
        action: "delivery",
        intent: "commit",
        phase: "propose",
        actionId: "propose-1",
        idempotencyKey: "propose-1",
        message: "feat: reviewed runtime commit",
      });
      if (mode !== "autonomous-delivery") {
        await vi.waitFor(() => {
          expect(runtimeEvents.at(-1)?.permissionRequest?.actionKind).toBe("commit");
        });
        const pendingId = runtimeEvents.at(-1)?.permissionRequest?.requestId;
        if (pendingId === undefined) throw new Error("commit permission missing");
        expect(bridge.issueCommit?.("run-1", pendingId)).toBeDefined();
      }
      const proposed = await pendingProposal;
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
      ).toBe(mode !== "autonomous-delivery");
      const execute = {
        action: "delivery",
        intent: "commit",
        phase: "execute",
        proposalId: id,
        actionId: "commit-1",
        idempotencyKey: "commit-1",
      };
      if (mode !== "autonomous-delivery") {
        // The operator decision above released the pending proposal response but has not executed
        // the effect. Its exact one-use approval is consumed only by this execute call.
        expect(bridge.issueCommit?.("other-run", id)).toBeUndefined();
      } else {
        expect(service.matchesApproval(id)).toBe(false);
      }
      const result = await invoke(execute);
      expect(result).toMatchObject({
        status: "completed",
        verifiedCommit: { status: "succeeded", headSha: git(["rev-parse", "HEAD"]) },
      });
      expect(
        (await invoke({ ...execute, actionId: "commit-3", idempotencyKey: "commit-3" })).status,
      ).toBe(mode === "autonomous-delivery" ? "failed" : "denied");
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
  it("stages remaining edits when the selected set also contains already-staged files", async () => {
    const stagedBlob = git(["rev-parse", ":code.js"]);
    writeFileSync(join(root, "other.js"), "export const other = 3;\n");
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
        actionId: "mixed",
        idempotencyKey: "mixed",
        operation: "stage",
        phase: "propose",
        paths: ["code.js", "other.js"],
      },
      { check: () => true },
    );
    expect(proposed).toMatchObject({ kind: "stage", status: "ready", pathCount: 2 });
    if (proposed.kind !== "stage") throw new Error("stage proposal unavailable");
    expect(gitService.review(proposed.proposalId)?.review.paths).toEqual(["code.js", "other.js"]);
    expect(
      await gitService.execute(
        {
          action: "git",
          actionId: "mixed-execute",
          idempotencyKey: "mixed-execute",
          operation: "stage",
          phase: "execute",
          proposalId: proposed.proposalId,
        },
        { check: () => true },
      ),
    ).toMatchObject({ status: "succeeded" });
    expect(git(["rev-parse", ":code.js"])).toBe(stagedBlob);
    expect(git(["show", ":other.js"])).toBe("export const other = 3;");
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "git.runtime-action",
        correlationId: "verified-commit-test",
        extra: expect.objectContaining({
          phase: "stage-propose",
          state: "ready",
          pathCount: 2,
        }) as unknown,
      }),
    );
  });

  it("does not admit missing paths as already-staged no-ops", async () => {
    const index = git(["write-tree"]);
    const gitService = new RuntimeGitService({
      ...options,
      mode: (): "supervised-coding" => "supervised-coding",
      invalidateVerification: (): void => {
        service.invalidate();
      },
    });
    expect(
      await gitService.execute(
        {
          action: "git",
          actionId: "missing",
          idempotencyKey: "missing",
          operation: "stage",
          phase: "propose",
          paths: ["code.js", "missing.js"],
        },
        { check: () => true },
      ),
    ).toMatchObject({
      kind: "stage",
      status: "blocked",
      reason: "selection-unreviewed",
      pathCount: 2,
    });
    expect(git(["write-tree"])).toBe(index);
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "git.runtime-action",
        correlationId: "verified-commit-test",
        extra: expect.objectContaining({
          phase: "stage-propose",
          state: "blocked",
          reason: "selection-unreviewed",
          pathCount: 2,
        }) as unknown,
      }),
    );
  });

  // Relocated pin (was "does not admit an already-staged path through a truncated mixed-stage
  // status"). Admission used to read the 50-entry status projection, so 51 untracked files hid the
  // staged no-op. It now reads Git's own change list, which only the raw scan's content budget can
  // cut — and a scan that could not complete proposes nothing: the facts read fails closed with its
  // own code, no path is admitted, and the failure line says why.
  it("does not admit anything through a change list the raw scan could not complete", async () => {
    writeFileSync(join(root, "other.js"), "export const other = 3;\n");
    // Eight untracked mebibyte files sort ahead of both requested paths and exhaust the raw scan's
    // 8 MiB content budget exactly, so the scan stops before it reaches them.
    for (let index = 0; index < 8; index += 1) {
      writeFileSync(join(root, `aaa-${String(index)}.bin`), Buffer.alloc(1_048_576, 0x61));
    }
    const index = git(["write-tree"]);
    const gitService = new RuntimeGitService({
      ...options,
      mode: (): "supervised-coding" => "supervised-coding",
      invalidateVerification: (): void => {
        service.invalidate();
      },
    });
    expect((await runtimeGitStatus(context(), options.execution ?? {})).truncated).toBe(true);

    expect(
      await gitService.execute(
        {
          action: "git",
          actionId: "truncated-scan",
          idempotencyKey: "truncated-scan",
          operation: "stage",
          phase: "propose",
          paths: ["code.js", "other.js"],
        },
        { check: () => true },
      ),
    ).toEqual({ kind: "refused", reason: "execution-failed" });
    expect(git(["write-tree"])).toBe(index);
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "git.runtime-action",
        level: "warn",
        errorKind: "internal",
        correlationId: "verified-commit-test",
        extra: expect.objectContaining({
          phase: "stage-propose",
          state: "failed",
          code: "git-raw-snapshot-incomplete",
        }) as unknown,
      }),
    );
  });

  // Relocated pin (was "does not admit a mixed-stage selection whose reviewed diff is truncated").
  // Admission used to reuse the model-facing diff reader and refused whenever that reader had
  // truncated — here a 62 KB line it cannot render. A truncated RENDERING was never a fact about the
  // selection: the file is a real pending change with exact bytes and line counts, and refusing it
  // reached the model as a revoked authority. A change list the scan could not complete is pinned
  // above; a path absent from a complete list is pinned by the missing-path case.
  it("admits a pending change the diff reader could only render truncated", async () => {
    writeFileSync(join(root, "other.js"), "x".repeat(62_000));
    const gitService = new RuntimeGitService({
      ...options,
      mode: (): "supervised-coding" => "supervised-coding",
      invalidateVerification: (): void => {
        service.invalidate();
      },
    });
    const diff = await runtimeGitDiff(context(), options.execution ?? {}, "unstaged", ["other.js"]);
    expect(diff.truncated).toBe(true);

    const proposed = await gitService.execute(
      {
        action: "git",
        actionId: "rendered-truncated",
        idempotencyKey: "rendered-truncated",
        operation: "stage",
        phase: "propose",
        paths: ["code.js", "other.js"],
      },
      { check: () => true },
    );
    expect(proposed).toMatchObject({ kind: "stage", status: "ready", pathCount: 2 });
    if (proposed.kind !== "stage") throw new Error("stage proposal unavailable");
    expect(gitService.review(proposed.proposalId)?.review).toMatchObject({
      fileCount: 2,
      addedLines: 1,
      deletedLines: 0,
    });
  });

  it("fails closed on a conflicted index without changing it, naming the reader's code", async () => {
    git(["commit", "-qm", "codex change"]);
    git(["checkout", "-q", "dev"]);
    writeFileSync(join(root, "code.js"), "export const value = 3;\n");
    git(["commit", "-qam", "dev change"]);
    git(["checkout", "-q", "codex/task"]);
    expect(() => git(["merge", "--no-edit", "dev"])).toThrow();
    const index = git(["ls-files", "--stage"]);
    const gitService = new RuntimeGitService({
      ...options,
      mode: (): "supervised-coding" => "supervised-coding",
      invalidateVerification: (): void => {
        service.invalidate();
      },
    });

    expect(
      await gitService.execute(
        {
          action: "git",
          actionId: "conflicted-stage",
          idempotencyKey: "conflicted-stage",
          operation: "stage",
          phase: "propose",
          paths: ["code.js"],
        },
        { check: () => true },
      ),
    ).toEqual({ kind: "refused", reason: "execution-failed" });
    expect(git(["ls-files", "--stage"])).toBe(index);
    // An unmerged index has no single identity the raw reader can snapshot, so the facts read
    // throws before any admission: the refusal is a failure, and its line names the reader's own
    // closed literal — the message of a thrown `TypeError`, which `describeError` alone would drop.
    const failed = events.find(
      (event) => event.op === "git.runtime-action" && event.extra?.state === "failed",
    );
    expect(failed).toMatchObject({ level: "warn", errorKind: "internal" });
    expect(redactLogFields(failed?.extra)).toMatchObject({
      phase: "stage-propose",
      runId: "run-1",
      state: "failed",
      errorClass: "TypeError",
      code: "git-index-identity-invalid",
    });
  });

  // Coding Workbench run 13 (2026-09-10): after a green verification the model asked to stage eight
  // ordinary files — four edited, four new — whose rendered hunks weighed 68 KB of review JSON.
  // `propose()` reused the model-facing diff reader for its admission check; that reader had cut its
  // response at the 60 KB budget, the selection was refused as unreviewable, the tool reported a
  // revoked Git authority, and the run stopped one step short of delivering. Admission now reads
  // Git's own change list and each pending path's two sides: a response budget never refuses a path.
  // The same eight files are also 125 KB of raw content together — twice the 64 KiB the stage
  // candidate digest used to refuse whole (owner review of PR #3452, 2026-09-10).
  it("admits a selection whose rendered review exceeds the diff reader's response budget", async () => {
    const body = Array.from(
      { length: 300 },
      (_value, index) => `export const value${String(index)} = "${"v".repeat(24)}";\n`,
    ).join("");
    const tracked = ["one.js", "two.js", "three.js"];
    for (const name of tracked) writeFileSync(join(root, name), "export const seed = 1;\n");
    git(["add", ...tracked]);
    git(["commit", "-qm", "seed"]);
    const paths = ["code.js", ...tracked, "four.js", "five.js", "six.js", "seven.js"];
    for (const name of paths) writeFileSync(join(root, name), body);
    const execution = options.execution ?? {};
    expect((await runtimeGitDiff(context(), execution, "unstaged", paths)).truncated).toBe(true);
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
        actionId: "wide",
        idempotencyKey: "wide",
        operation: "stage",
        phase: "propose",
        paths,
      },
      { check: () => true },
    );
    expect(proposed).toMatchObject({ kind: "stage", status: "ready", pathCount: 8 });
    if (proposed.kind !== "stage") throw new Error("stage proposal unavailable");
    expect(gitService.review(proposed.proposalId)?.review).toMatchObject({
      fileCount: 8,
      addedLines: 8 * 300,
      deletedLines: 4,
    });
    expect(
      await gitService.execute(
        {
          action: "git",
          actionId: "wide-execute",
          idempotencyKey: "wide-execute",
          operation: "stage",
          phase: "execute",
          proposalId: proposed.proposalId,
        },
        { check: () => true },
      ),
    ).toMatchObject({ status: "succeeded", pathCount: 8 });
    expect(git(["diff", "--name-only"])).toBe("");
    expect(git(["ls-files", "--others", "--exclude-standard"])).toBe("");
  });

  it("refuses a directory as a stage path with a reasoned block instead of a Git failure", async () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "value.js"), "export const nested = true;\n");
    const gitService = new RuntimeGitService({
      ...options,
      mode: (): "supervised-coding" => "supervised-coding",
      invalidateVerification: (): void => {
        service.invalidate();
      },
    });

    expect(
      await gitService.execute(
        {
          action: "git",
          actionId: "directory",
          idempotencyKey: "directory",
          operation: "stage",
          phase: "propose",
          paths: ["src"],
        },
        { check: () => true },
      ),
    ).toMatchObject({
      kind: "stage",
      status: "blocked",
      reason: "selection-unreviewed",
      pathCount: 1,
    });
  });

  // Run 13 (2026-09-10): the service answered `undefined` without a line whenever its guard, its
  // signal or its live context said no, so the log could not say why a Git call went unanswered.
  // Every refusal now names its condition on the run's own correlation id — or on the unknown id
  // when there is no live run to borrow one from.
  it("logs why a Git request is refused before it is dispatched", async () => {
    const gitService = new RuntimeGitService({
      ...options,
      mode: (): "supervised-coding" => "supervised-coding",
      invalidateVerification: (): void => {
        service.invalidate();
      },
    });
    expect(
      await gitService.execute(
        {
          action: "git",
          actionId: "guarded",
          idempotencyKey: "guarded",
          operation: "stage",
          phase: "propose",
          paths: ["code.js"],
        },
        { check: () => false },
      ),
    ).toEqual({ kind: "refused", reason: "authority-revoked" });
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "git.runtime-action",
        correlationId: "verified-commit-test",
        extra: {
          phase: "stage-propose",
          runId: "run-1",
          state: "refused",
          reason: "guard-rejected",
        },
      }),
    );

    const detached = new RuntimeGitService({
      ...options,
      context: (): undefined => undefined,
      mode: (): "supervised-coding" => "supervised-coding",
      invalidateVerification: (): void => {
        service.invalidate();
      },
    });
    expect(
      await detached.execute(
        { action: "git", actionId: "detached", idempotencyKey: "detached", operation: "status" },
        { check: () => true },
      ),
    ).toEqual({ kind: "refused", reason: "authority-revoked" });
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "git.runtime-action",
        correlationId: UNKNOWN_CORRELATION_ID,
        extra: { phase: "status", state: "refused", reason: "run-not-live" },
      }),
    );
  });

  it("names an unknown or expired proposal at redemption instead of a revoked authority", async () => {
    const gitService = new RuntimeGitService({
      ...options,
      mode: (): "supervised-coding" => "supervised-coding",
      invalidateVerification: (): void => {
        service.invalidate();
      },
    });

    expect(
      await gitService.execute(
        {
          action: "git",
          actionId: "unknown",
          idempotencyKey: "unknown",
          operation: "stage",
          phase: "execute",
          proposalId: "stage-404",
        },
        { check: () => true },
      ),
    ).toEqual({ kind: "refused", reason: "proposal-unknown" });
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "git.runtime-action",
        correlationId: "verified-commit-test",
        extra: {
          phase: "stage-execute",
          runId: "run-1",
          state: "refused",
          reason: "proposal-unknown",
        },
      }),
    );
  });

  it("reports a thrown Git failure as execution-failed on a body-free failure line", async () => {
    writeFileSync(join(root, "large.bin"), Buffer.alloc(GIT_STAGE_FILE_MAX_BYTES + 1, 0x78));
    const gitService = new RuntimeGitService({
      ...options,
      mode: (): "supervised-coding" => "supervised-coding",
      invalidateVerification: (): void => {
        service.invalidate();
      },
    });

    expect(
      await gitService.execute(
        {
          action: "git",
          actionId: "too-large",
          idempotencyKey: "too-large",
          operation: "stage",
          phase: "propose",
          paths: ["large.bin"],
        },
        { check: () => true },
      ),
    ).toEqual({ kind: "refused", reason: "execution-failed" });
    const failed = events.find(
      (event) => event.op === "git.runtime-action" && event.extra?.state === "failed",
    );
    expect(failed).toMatchObject({
      level: "warn",
      errorKind: "internal",
      correlationId: "verified-commit-test",
      extra: expect.objectContaining({ phase: "stage-propose", runId: "run-1" }) as unknown,
    });
    expect(JSON.stringify(events)).not.toContain("xxxx");
  });

  // Authority that closes UNDER a dispatch makes the facts or review read throw
  // (`verified-commit-authority-unavailable`, `git-runtime-authority-denied`); that is the authority
  // refusal, not a failed Git effect, and the model may read only `authority-revoked` as such
  // (CodeRabbit review, 2026-09-10).
  it("answers authority-revoked, not execution-failed, when authority closes during dispatch", async () => {
    const gitService = new RuntimeGitService({
      ...options,
      mode: (): "supervised-coding" => "supervised-coding",
      invalidateVerification: (): void => {
        service.invalidate();
      },
    });
    live = false;

    expect(
      await gitService.execute(
        {
          action: "git",
          actionId: "closing",
          idempotencyKey: "closing",
          operation: "stage",
          phase: "propose",
          paths: ["code.js"],
        },
        { check: () => true },
      ),
    ).toEqual({ kind: "refused", reason: "authority-revoked" });
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "git.runtime-action",
        correlationId: "verified-commit-test",
        extra: {
          phase: "stage-propose",
          runId: "run-1",
          state: "refused",
          reason: "authority-revoked",
        },
      }),
    );
    expect(
      events.some((event) => event.op === "git.runtime-action" && event.extra?.state === "failed"),
    ).toBe(false);
  });

  // A redeemed proposal leaves the redeemable map before its effect runs; a throwing effect must
  // still answer with THAT proposal's failed result, never with the generic refusal the map lookup
  // used to produce once the proposal was gone (CodeRabbit review, 2026-09-10).
  it("binds a throwing stage effect to the proposal it was redeeming", async () => {
    const gitService = new RuntimeGitService({
      ...options,
      mode: (): "supervised-coding" => "supervised-coding",
      invalidateVerification: (): void => {
        service.invalidate();
      },
    });
    writeFileSync(join(root, "other.js"), "export const other = 4;\n");
    const proposed = await gitService.execute(
      {
        action: "git",
        actionId: "effect",
        idempotencyKey: "effect",
        operation: "stage",
        phase: "propose",
        paths: ["other.js"],
      },
      { check: () => true },
    );
    if (proposed.kind !== "stage") throw new Error("stage proposal unavailable");
    vi.mocked(executeGovernedMutation).mockRejectedValueOnce(
      new Error("git-stage-effect-exploded"),
    );

    expect(
      await gitService.execute(
        {
          action: "git",
          actionId: "effect-execute",
          idempotencyKey: "effect-execute",
          operation: "stage",
          phase: "execute",
          proposalId: proposed.proposalId,
        },
        { check: () => true },
      ),
    ).toEqual({
      kind: "stage",
      proposalId: proposed.proposalId,
      status: "failed",
      reason: "execution-failed",
      pathCount: 1,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "git.runtime-action",
        level: "warn",
        errorKind: "internal",
        extra: expect.objectContaining({
          phase: "stage-execute",
          state: "failed",
          code: "git-stage-effect-exploded",
        }) as unknown,
      }),
    );
    // A redeemed proposal never becomes redeemable again, whatever its effect did.
    expect(gitService.review(proposed.proposalId)).toBeUndefined();
  });

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
    if (proposal.kind !== "stage") throw new Error("proposal unavailable");
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
  // CodeRabbit review, PR #3452: a one-line edit inside unchanged context used to count and render as
  // a whole-file replacement, both in the operator's stage review and in the model-facing diff. Both
  // now come from one line diff of the two raw sides (lineDiff.ts), never from a filtered read.
  it("counts and renders only the changed line of a file inside unchanged context", async () => {
    const lines = Array.from(
      { length: 40 },
      (_, index) => `export const line${String(index)} = ${String(index)};`,
    );
    writeFileSync(join(root, "context.js"), `${lines.join("\n")}\n`);
    git(["add", "context.js"]);
    git(["commit", "-qm", "context"]);
    lines[20] = "export const line20 = -20;";
    writeFileSync(join(root, "context.js"), `${lines.join("\n")}\n`);
    const execution = options.execution ?? {};

    const worktree = await runtimeGitDiff(context(), execution, "unstaged", ["context.js"]);
    expect(worktree.files).toEqual([
      expect.objectContaining({ path: "context.js", addedLines: 1, removedLines: 1 }),
    ]);
    expect(worktree.files[0]?.hunks).toHaveLength(1);
    const selection = await admitStageSelection(context(), execution, ["context.js"]);
    await expect(reviewStageSelection(context(), execution, selection ?? [])).resolves.toEqual({
      fileCount: 1,
      addedLines: 1,
      deletedLines: 1,
    });

    git(["add", "context.js"]);
    const staged = await runtimeGitDiff(context(), execution, "staged", ["context.js"]);
    expect(staged.files).toEqual([
      expect.objectContaining({ path: "context.js", addedLines: 1, removedLines: 1 }),
    ]);
    expect(staged.files[0]?.hunks).toHaveLength(1);
  });
  // A diff search that stops at a bound shows its region as one replaced block: correct, not minimal.
  // The log names the bound and the sides' sizes, so a whole-file hunk or count is reconstructable
  // from the log alone (AGENTS.md §8).
  it("logs a diff search that stopped at its bound, for the editor diff and the stage review", async () => {
    const count = LINE_DIFF_MAX_EDIT_DISTANCE + 100;
    const lines = Array.from(
      { length: count },
      (_, index) => `export const v${String(index)} = 1;`,
    );
    writeFileSync(join(root, "bounded.js"), `${lines.join("\n")}\n`);
    git(["add", "bounded.js"]);
    git(["commit", "-qm", "bounded"]);
    writeFileSync(
      join(root, "bounded.js"),
      `${lines.map((line) => line.replace("1;", "2;")).join("\n")}\n`,
    );
    const execution = options.execution ?? {};
    events.length = 0;

    await runtimeGitDiff(context(), execution, "unstaged", ["bounded.js"]);
    const selection = await admitStageSelection(context(), execution, ["bounded.js"]);
    await expect(reviewStageSelection(context(), execution, selection ?? [])).resolves.toEqual({
      fileCount: 1,
      addedLines: count,
      deletedLines: count,
    });

    const line = {
      category: "process",
      op: "git.runtime-diff.search-bounded",
      correlationId: "verified-commit-test",
      extra: { bound: "distance", oldLines: count, newLines: count },
    };
    expect(events.filter((event) => event.op === line.op)).toEqual([
      expect.objectContaining(line),
      expect.objectContaining(line),
    ]);
  });
  it("expands a directory diff through bounded Git-owned changed paths", async () => {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "value.js"), "export const value = 1;\n");
    git(["add", "nested/value.js"]);
    git(["commit", "-qm", "test: add nested fixture", "--", "nested/value.js"]);
    writeFileSync(join(root, "nested", "value.js"), "export const value = 2;\n");

    await expect(
      runtimeGitDiff(context(), options.execution ?? {}, "unstaged", ["nested"]),
    ).resolves.toMatchObject({
      files: [{ path: "nested/value.js", layer: "worktree", status: "modified" }],
      truncated: false,
    });
  });
  it("expands staged and untracked directories in their exact requested layer", async () => {
    mkdirSync(join(root, "staged"));
    mkdirSync(join(root, "untracked"));
    writeFileSync(join(root, "staged", "value.js"), "export const staged = true;\n");
    writeFileSync(join(root, "untracked", "value.js"), "export const untracked = true;\n");
    git(["add", "staged/value.js"]);

    await expect(
      runtimeGitDiff(context(), options.execution ?? {}, "staged", ["staged"]),
    ).resolves.toMatchObject({
      files: [{ path: "staged/value.js", layer: "staged", status: "added" }],
      totalFiles: 1,
      truncated: false,
    });
    await expect(
      runtimeGitDiff(context(), options.execution ?? {}, "unstaged", ["untracked"]),
    ).resolves.toMatchObject({
      files: [{ path: "untracked/value.js", layer: "worktree", status: "added" }],
      totalFiles: 1,
      truncated: false,
    });
  });
  it("keeps directory boundaries exact and de-duplicates exact-plus-directory requests", async () => {
    mkdirSync(join(root, "nested"));
    mkdirSync(join(root, "nested-sibling"));
    writeFileSync(join(root, "nested", "value.js"), "export const nested = true;\n");
    writeFileSync(join(root, "nested-sibling", "value.js"), "export const sibling = true;\n");

    await expect(
      runtimeGitDiff(context(), options.execution ?? {}, "unstaged", ["nested/value.js", "nested"]),
    ).resolves.toMatchObject({
      files: [{ path: "nested/value.js" }],
      totalFiles: 1,
      truncated: false,
    });
  });
  it("returns no unrelated file for an unchanged directory", async () => {
    mkdirSync(join(root, "unchanged"));
    writeFileSync(join(root, "unchanged", "value.js"), "export const unchanged = true;\n");
    git(["add", "unchanged/value.js"]);
    git(["commit", "-qm", "test: add unchanged directory", "--", "unchanged/value.js"]);

    await expect(
      runtimeGitDiff(context(), options.execution ?? {}, "unstaged", ["unchanged"]),
    ).resolves.toMatchObject({ files: [], totalFiles: 0, truncated: false });
  });
  it("propagates per-file truncation from an expanded directory result", async () => {
    mkdirSync(join(root, "large"));
    writeFileSync(
      join(root, "large", "value.js"),
      `export const value = "${"x".repeat(61_000)}";\n`,
    );

    const diff = await runtimeGitDiff(context(), options.execution ?? {}, "unstaged", ["large"]);
    expect(diff).toMatchObject({
      files: [{ path: "large/value.js", truncated: true }],
      totalFiles: 1,
      truncated: true,
    });
  });
  it("rejects more than the governed path cap before reading a directory diff", async () => {
    const paths = Array.from(
      { length: CODING_RUNTIME_GIT_MAX_PATHS + 1 },
      (_value, index) => `path-${String(index)}.js`,
    );
    await expect(
      runtimeGitDiff(context(), options.execution ?? {}, "unstaged", paths),
    ).rejects.toThrow("git-runtime-paths-invalid");
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
    if (proposed.kind !== "stage") throw new Error("proposal unavailable");
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
    if (proposal.kind !== "stage") throw new Error("missing stage proposal");
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
    ).toEqual({ kind: "refused", reason: "authority-revoked" });
    expect(git(["write-tree"])).toBe(index);
    expect(events).toContainEqual(
      expect.objectContaining({
        op: "git.runtime-action",
        correlationId: "verified-commit-test",
        extra: {
          phase: "stage-execute",
          runId: "run-1",
          state: "refused",
          reason: "signal-aborted",
        },
      }),
    );
  });

  it.each(["governed-assist", "supervised-coding", "autonomous-delivery"] as const)(
    "stages the exact selected candidate through the facade in %s",
    // eslint-disable-next-line complexity -- this is the exhaustive three-mode behavior matrix
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
      const pendingStage = invoke({ operation: "stage", phase: "propose", paths: ["code.js"] });
      if (mode === "governed-assist") {
        await vi.waitFor(() => {
          expect(fixture.events.at(-1)?.permissionRequest?.actionKind).toBe("git-stage");
        });
        const pendingId = fixture.events.at(-1)?.permissionRequest?.requestId;
        if (pendingId === undefined) throw new Error("stage permission missing");
        expect(fixture.bridge.issueStage?.("foreign-run", pendingId)).toBeUndefined();
        expect(fixture.bridge.issueStage?.("run-1", pendingId)).toBeDefined();
      }
      const proposed = await pendingStage;
      if (!("git" in proposed) || proposed.git.kind !== "stage")
        throw new Error("stage proposal missing");
      const id = proposed.git.proposalId;
      expect(proposed.git.status).toBe("ready");
      if (mode === "governed-assist") {
        expect(fixture.events.at(-1)).toMatchObject({
          kind: "permission-requested",
          permissionRequest: { actionKind: "git-stage", requestId: id },
        });
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

// Run 6 (2026-09-10): the target repository tracked `.idea/.gitignore`; the raw status reader marked
// the deny-listed path as truncation, the commit facts refused the snapshot as incomplete, and every
// verification of the run failed. Deny-listed paths are excluded, counted and recorded body-free.
describe("deny-listed paths in the run's repository", () => {
  it("keeps status and commit facts readable and records the exclusion count", async () => {
    // The fixture's staged code.js lands in this commit together with the tracked IDE metadata;
    // a fresh unstaged edit and an untracked (not git-ignored) `.idea/misc.xml` follow.
    mkdirSync(join(root, ".idea"));
    writeFileSync(join(root, ".idea", ".gitignore"), "shelf/\n");
    git(["add", ".idea/.gitignore"]);
    git(["commit", "-qm", "ide metadata"]);
    writeFileSync(join(root, ".idea", "misc.xml"), "<project/>\n");
    writeFileSync(join(root, "code.js"), "export const value = 3;\n");
    const execution = options.execution ?? {};

    const status = await runtimeGitStatus(context(), execution);
    expect(status.truncated).toBe(false);
    expect(status.changes.map((change) => change.path)).toEqual(["code.js"]);
    expect(JSON.stringify(status)).not.toContain(".idea");

    const facts = await readVerifiedCommitFacts(context(), execution);
    expect(facts.headSha).toMatch(/^[a-f0-9]{40}$/u);

    const exclusions = events.filter(
      (event) => event.op === "git.raw-status.denied-paths-excluded",
    );
    expect(exclusions).toHaveLength(2);
    expect(exclusions[0]).toMatchObject({
      category: "security",
      correlationId: "verified-commit-test",
      extra: { deniedPathCount: 2 },
    });
  });
});
