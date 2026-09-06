import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CodingWorkbenchIssueBinding } from "@oscharko-dev/keiko-contracts";
import type { DraftDeliveryRecord } from "@oscharko-dev/keiko-contracts/runtime/draft-delivery";
import type { GitPullRequestIdentity } from "@oscharko-dev/keiko-contracts/runtime/git-pull-request";
import {
  buildPushArgv,
  type GitPullRequestInspectionAdapter,
  type GitPrInspectionResult,
  type GitPrExecResult,
  type GitPublishExecResult,
  type GitPublishExecRequest,
} from "@oscharko-dev/keiko-tools";
import { gitCommitMessageDigest } from "@oscharko-dev/keiko-tools/internal/git-mutation";
import { createCodingRuntimeSnapshotStore } from "../coding-runtime/codingRuntimeSnapshotStore.js";
import {
  codingWorkbenchIssueBindingDigest,
  codingWorkbenchRemoteDigest,
} from "../coding-context/githubIssueResolution.js";
import { runMigrations } from "../store/schema.js";
import type { ServerLogEvent } from "../observability/server-log.js";
import { createInMemoryGitDeliveryApprovalStore } from "./approvalStore.js";
import { readVerifiedCommitFacts } from "./verifiedCommitFacts.js";
import { DraftDeliveryController } from "./draftDeliveryService.js";
import type { DraftDeliveryRunContext, DraftDeliveryServiceOptions } from "./draftDeliveryTypes.js";

const DIGEST = "a".repeat(64);
const REPOSITORY = "owner/repository";
const GIT_EXECUTABLE =
  process.platform === "win32" ? String.raw`C:\Program Files\Git\cmd\git.exe` : "/usr/bin/git";
export class DraftDeliveryFixture {
  public readonly root = realpathSync(mkdtempSync(join(tmpdir(), "keiko-draft-service-")));
  public readonly remote = realpathSync(mkdtempSync(join(tmpdir(), "keiko-draft-remote-")));
  public readonly db = new DatabaseSync(":memory:");
  public readonly events: ServerLogEvent[] = [];
  public readonly changes: DraftDeliveryRecord[] = [];
  public readonly evidence = new Map<string, string>();
  public readonly snapshots;
  public readonly issue: CodingWorkbenchIssueBinding;
  public readonly context: DraftDeliveryRunContext;
  public readonly options: DraftDeliveryServiceOptions;
  public readonly service: DraftDeliveryController;
  public live = true;
  public clean = true;
  public now = Date.parse("2026-09-05T00:00:00.000Z");
  public pushCount = 0;
  public createCount = 0;
  public prs: GitPullRequestIdentity[] = [];
  public failAfterPush = false;
  public failAfterCreate = false;
  public failReadAfterCreate = false;
  public failListAfterCreate = false;
  public targetReason: "issue-drift" | "remote-drift" | "provider-failed" | undefined;
  public asyncBeforeTarget: (() => Promise<void>) | undefined;
  public createBody = "";
  public readonly adapter: GitPullRequestInspectionAdapter;

  public constructor() {
    this.initializeRepository();
    runMigrations(this.db);
    this.snapshots = createCodingRuntimeSnapshotStore(this.db);
    this.issue = this.makeIssue();
    this.context = this.makeContext();
    this.createSnapshot();
    this.adapter = this.makeAdapter();
    this.options = this.makeOptions();
    this.service = new DraftDeliveryController(this.options);
  }
  public git(args: readonly string[], cwd = this.root): string {
    return execFileSync(GIT_EXECUTABLE, [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    }).trim();
  }
  private initializeRepository(): void {
    this.git(["init", "-qb", "master"]);
    this.git(["config", "user.name", "Keiko Test"]);
    this.git(["config", "user.email", "keiko@example.test"]);
    this.git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(this.root, "code.js"), "export const value = 1;\n");
    this.git(["add", "code.js"]);
    this.git(["commit", "-qm", "base"]);
    this.git(["init", "--bare", "-q", this.remote]);
    this.git(["push", "-q", this.remote, "master"]);
    this.git(["checkout", "-qb", "feature/issue-1"]);
    writeFileSync(join(this.root, "code.js"), "export const value = 2;\n");
    this.git(["add", "code.js"]);
    this.git(["commit", "-qm", "feat: bounded change"]);
    this.git(["remote", "add", "origin", `https://github.com/${REPOSITORY}.git`]);
  }
  private makeIssue(): CodingWorkbenchIssueBinding {
    const fields = {
      schemaVersion: "1",
      repositoryId: "repository-1",
      remoteDigest: codingWorkbenchRemoteDigest(REPOSITORY),
      issueNumber: 1,
      issueIdDigest: DIGEST,
      defaultBaseRef: "master",
      contentRevisionDigest: DIGEST,
    } as const;
    return { ...fields, bindingDigest: codingWorkbenchIssueBindingDigest(fields) };
  }
  private makeContext(): DraftDeliveryRunContext {
    return {
      runId: "run-1",
      taskId: "task-1",
      workspaceId: "workspace-1",
      envelopeDigest: DIGEST,
      runtimeAuthorityDigest: DIGEST,
      workspaceDigest: DIGEST,
      repositoryDigest: this.issue.remoteDigest,
      issueBindingDigest: this.issue.bindingDigest,
      issueBinding: this.issue,
      baseRef: "master",
      headRef: "feature/issue-1",
      correlationId: "draft-delivery-test",
      buffersClean: () => this.clean,
      stillAuthorized: () => this.live,
      workspace: {
        root: this.root,
        selectedRoot: this.root,
        name: "test",
        version: undefined,
        testFramework: "vitest",
        sourceDirs: [],
        testDirs: [],
        languages: [],
        ignoreLines: [],
      },
    };
  }
  private createSnapshot(): void {
    this.snapshots.create({
      schemaVersion: "1",
      runId: "run-1",
      state: "running",
      revision: 0,
      requestedMode: "governed-assist",
      runtimeSource: "keiko-sidecar",
      modelSource: "keiko-model-gateway",
      createdAt: new Date(this.now).toISOString(),
      updatedAt: new Date(this.now).toISOString(),
      taskDigest: DIGEST,
      workspaceDigest: DIGEST,
      operatorDigest: DIGEST,
      authorityDigest: DIGEST,
      bindingDigest: DIGEST,
      provenanceDigest: DIGEST,
      toolCallCount: 0,
      patchByteCount: 0,
      modelRequestCount: 0,
      issueBinding: this.issue,
    });
  }
  public async recordVerifiedCommit(proposalId = "commit-1"): Promise<void> {
    const facts = await readVerifiedCommitFacts(this.context, this.options.execution ?? {});
    this.snapshots.recordVerifiedCommit({
      schemaVersion: "1",
      runId: "run-1",
      proposalId,
      envelopeDigest: DIGEST,
      runtimeAuthorityDigest: DIGEST,
      workspaceDigest: DIGEST,
      repositoryDigest: this.issue.remoteDigest,
      issueBindingDigest: this.issue.bindingDigest,
      baseSha: facts.baseSha,
      parentSha: this.git(["rev-parse", "HEAD^"]),
      stagedTreeDigest: facts.stagedTreeDigest,
      committedTreeDigest: facts.stagedTreeDigest,
      headSha: facts.headSha,
      verificationEvidenceId: "verification-1",
      messageDigest: gitCommitMessageDigest("feat: bounded change"),
      status: "succeeded",
      reason: "completed",
      recordedAt: new Date(this.now).toISOString(),
    });
  }
  private remoteHead(branch: string): string | undefined {
    const value = this.git(
      ["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`],
      this.remote,
    );
    return value || undefined;
  }
  public identity(): GitPullRequestIdentity {
    return {
      number: 17,
      externalId: "PR_kw_fixture",
      url: `https://github.com/${REPOSITORY}/pull/17`,
      repository: REPOSITORY,
      headRepository: REPOSITORY,
      headRef: this.context.headRef,
      headSha: this.remoteHead(this.context.headRef) ?? this.git(["rev-parse", "HEAD"]),
      baseRef: this.context.baseRef,
      baseSha: this.git(["rev-parse", "master"]),
      state: "open",
      isDraft: true,
    };
  }
  private makeAdapter(): GitPullRequestInspectionAdapter {
    return {
      readBranchHead: (request): Promise<GitPrInspectionResult<string>> => {
        const value = this.remoteHead(request.headBranchName);
        return Promise.resolve(
          value === undefined ? { ok: false, reason: "not-found" } : { ok: true, value },
        );
      },
      findPullRequestsByHead: () =>
        Promise.resolve(
          this.failListAfterCreate && this.createCount > 0
            ? { ok: false, reason: "invalid-response" }
            : { ok: true, value: this.prs },
        ),
      readPullRequest: () =>
        Promise.resolve(
          this.failReadAfterCreate || this.prs[0] === undefined
            ? { ok: false, reason: "invalid-response" }
            : { ok: true, value: this.prs[0] },
        ),
      updatePullRequest: (): never => {
        throw new Error("unexpected update");
      },
      createPullRequest: (request): Promise<GitPrExecResult> => {
        this.createCount += 1;
        if (
          this.snapshots.get(this.changes.at(-1)?.binding.runId ?? "")?.draftDelivery?.phase !==
          "creating-pr"
        )
          throw new Error("effect without durable intent");
        this.createBody = request.body;
        const identity = this.identity();
        this.prs = [identity];
        return Promise.resolve(
          this.failAfterCreate
            ? { schemaVersion: "1", outcome: "failed", errorCode: "timeout", durationMs: 1 }
            : {
                schemaVersion: "1",
                outcome: "succeeded",
                durationMs: 1,
                createdPrExternalId: String(identity.number),
                createdPrIdentity: identity,
              },
        );
      },
    };
  }
  private makeOptions(): DraftDeliveryServiceOptions {
    const activityLog = {
      write: (event: ServerLogEvent): void => {
        this.events.push(event);
      },
    };
    const shared = {
      activityLog,
      now: (): number => this.now,
      branchProtectionReader: (): Promise<{ outcome: "unprotected" }> =>
        Promise.resolve({ outcome: "unprotected" }),
    };
    return {
      context: () => this.context,
      snapshots: this.snapshots,
      execution: { ...shared, approvalStore: createInMemoryGitDeliveryApprovalStore() },
      mutationDeps: {
        redactor: (value): unknown => value,
        evidenceStore: {
          put: (id, body): string => {
            this.evidence.set(id, body);
            return id;
          },
          get: (id): string | undefined => this.evidence.get(id),
          list: (): readonly string[] => [...this.evidence.keys()],
          delete: (id): void => {
            this.evidence.delete(id);
          },
        },
      },
      onChanged: (record): void => {
        this.changes.push(record);
      },
      resolveTarget: async (): ReturnType<DraftDeliveryServiceOptions["resolveTarget"]> => {
        await this.asyncBeforeTarget?.();
        return this.targetReason === undefined
          ? { ok: true, repository: REPOSITORY }
          : { ok: false, reason: this.targetReason };
      },
      inspectionAdapter: () => this.adapter,
      pullRequestSeams: () => ({ ...shared, prAdapterFactory: () => this.adapter }),
      publishSeams: () => ({
        ...shared,
        publishAdapterFactory: () => ({
          publish: (request): Promise<GitPublishExecResult> => this.publish(request),
        }),
      }),
    };
  }
  private publish(request: GitPublishExecRequest): Promise<GitPublishExecResult> {
    this.pushCount += 1;
    if (
      this.snapshots.get(this.changes.at(-1)?.binding.runId ?? "")?.draftDelivery?.phase !==
      "pushing"
    )
      throw new Error("effect without durable intent");
    const argv = [...buildPushArgv({ kind: "push", forcePush: false, ...request })];
    argv[1] = this.remote;
    this.git(argv);
    this.prs = this.prs.map((pr) => ({ ...pr, headSha: request.verifiedCommitSha ?? pr.headSha }));
    return Promise.resolve({
      schemaVersion: "1",
      outcome: this.failAfterPush ? "failed" : "succeeded",
      ...(this.failAfterPush ? { errorCode: "timeout" as const } : {}),
      durationMs: 1,
    });
  }
  public successorOptions(): DraftDeliveryServiceOptions {
    const at = new Date(this.now).toISOString();
    this.snapshots.markNonterminalRecoveryRequired(at);
    this.snapshots.acknowledgeRecovery("run-1", at);
    // Linked successor creation settles this acknowledged predecessor atomically with its insert.
    const prior = this.snapshots.get("run-1");
    if (prior === undefined) throw new Error("missing predecessor");
    const omitted = new Set([
      "draftDelivery",
      "verifiedCommitResult",
      "terminalAt",
      "recoveryAcknowledgedAt",
      "failureCode",
    ]);
    const shared = Object.fromEntries(
      Object.entries(prior).filter(([key]) => !omitted.has(key)),
    ) as typeof prior;
    const authorityDigest = "b".repeat(64);
    this.snapshots.create({
      ...shared,
      runId: "run-2",
      predecessorRunId: "run-1",
      state: "running",
      revision: 0,
      authorityDigest,
    });
    return {
      ...this.options,
      context: () => ({
        ...this.context,
        runId: "run-2",
        envelopeDigest: authorityDigest,
        runtimeAuthorityDigest: authorityDigest,
      }),
    };
  }
  public close(): void {
    this.service.invalidate();
    this.db.close();
    rmSync(this.root, { recursive: true, force: true });
    rmSync(this.remote, { recursive: true, force: true });
  }
}
